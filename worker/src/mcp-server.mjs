#!/usr/bin/env node
/**
 * AingTalk MCP Server
 *
 * Claude Code 通过 stdio (JSON-RPC) 连接此进程。
 * 此进程通过 SocketClient 与 AingTalk Server 通信，
 * 将 MCP Tool 调用转换为 Agent 间的消息/任务传递。
 *
 * ## 关键约束
 * STDOUT 归 MCP SDK 独占，用于 JSON-RPC 协议通信。
 * 所有应用日志必须输出到 STDERR。
 */

// ===== 在所有操作之前，重定向 console 到 stderr =====
// MCP 协议通过 process.stdout.write() 直接操作，不受 console 影响
console.log = (...args) => process.stderr.write('[MCP] ' + args.join(' ') + '\n');
console.info = (...args) => process.stderr.write('[MCP:INFO] ' + args.join(' ') + '\n');
console.debug = (...args) => process.stderr.write('[MCP:DEBUG] ' + args.join(' ') + '\n');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import os from 'node:os';

// 加载 CJS 模块
const require = createRequire(import.meta.url);
const { SocketClient } = require('./client/socket-client.js');
const { FileTransfer } = require('./file-handler/file-transfer.js');
const { v4: uuidv4 } = require('uuid');
const z = require('zod');

// ==================== 配置加载 ====================

function loadConfig() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--server':
      case '-s':
        parsed.serverUrl = args[++i];
        break;
      case '--name':
      case '-n':
        parsed.name = args[++i];
        break;
    }
  }

  return {
    serverUrl: parsed.serverUrl || process.env.AINGTALK_SERVER_URL || 'http://localhost:3000',
    agentName: parsed.name || process.env.AGENT_NAME || os.hostname()
  };
}

// ==================== 主流程 ====================

async function main() {
  const config = loadConfig();
  console.error(`[MCP] Starting AingTalk MCP Server`);
  console.error(`[MCP] Server: ${config.serverUrl}, Agent: ${config.agentName}`);

  // ---- Step 1: 连接 AingTalk Server ----
  const agentId = uuidv4();
  console.error(`[MCP] Agent ID: ${agentId}`);

  const socketClient = new SocketClient({
    serverUrl: config.serverUrl,
    agentId,
    autoReconnect: true,
    reconnectInterval: 5000,
    maxReconnectAttempts: 20
  });

  // 维护本地 Agent 列表缓存
  let agentCache = [];
  socketClient.onAgentList((agents) => {
    agentCache = agents || [];
    console.error(`[MCP] Agent list updated: ${agentCache.length} agents`);
  });

  // 初始化文件传输（仅用于发送）
  const fileTransfer = new FileTransfer({
    workDir: process.cwd(),
    maxFileSize: 100 * 1024 * 1024  // 100MB
  });

  await socketClient.connect();
  console.error('[MCP] Connected to AingTalk Server');

  // 注册为 MCP 类型 Agent
  socketClient.register({
    name: config.agentName,
    role: 'mcp-client',
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    workDir: process.cwd(),
    capabilities: ['mcp', 'claude-code'],
    claudeVersion: '',
    ip: '',
    startedAt: new Date().toISOString()
  });

  // 等待注册确认
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Registration timeout (15s)')), 15000);
    socketClient.onRegistered((data) => {
      clearTimeout(timeout);
      console.error(`[MCP] Agent registered: ${data.agentId}`);
      resolve();
    });
  });

  // 获取初始 Agent 列表
  try {
    agentCache = await socketClient.requestAgentList();
    console.error(`[MCP] Initial agent list: ${agentCache.length} agents`);
  } catch (e) {
    console.error(`[MCP] Failed to get initial agent list: ${e.message}`);
  }

  // ---- Step 2: 创建 MCP Server ----
  const mcpServer = new McpServer({
    name: 'aingtalk',
    version: '1.0.0'
  });

  // ===== Tool: list_agents =====
  mcpServer.registerTool('list_agents', {
    description: '获取所有在线 Agent 的列表。返回每个 Agent 的名称、ID、状态（online/offline/busy）、平台、架构、能力等信息。用于了解当前有哪些 Agent 可用。'
    // 无 inputSchema，表示无需参数
  }, async (_extra) => {
    try {
      // 尝试主动拉取最新列表
      try {
        agentCache = await socketClient.requestAgentList();
      } catch (_) {
        // 使用缓存
      }

      const agents = (agentCache || []).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status || 'unknown',
        platform: a.platform || '',
        arch: a.arch || '',
        capabilities: a.capabilities || [],
        role: a.role || '',
        hostname: a.hostname || '',
        lastHeartbeat: a.lastHeartbeat || null
      }));

      return {
        content: [{
          type: 'text',
          text: agents.length === 0
            ? '当前没有在线 Agent。'
            : `当前共 ${agents.length} 个 Agent:\n\n` + agents.map(a =>
                `- **${a.name}** (${a.id}) — ${a.status} — ${a.platform}/${a.arch} — 角色: ${a.role || '未分配'}`
              ).join('\n')
        }],
        structuredContent: { count: agents.length, agents }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取 Agent 列表失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: send_message =====
  mcpServer.registerTool('send_message', {
    description: '向指定的 Agent 发送文本消息。可以用于询问状态、传递指令、或请求帮助。消息会通过 Server 路由到目标 Agent。目标 Agent 可以是名称（name 字段）或 ID。',
    inputSchema: {
      target_agent: z.string().describe('目标 Agent 的名称（name 字段）或 ID。可通过 list_agents 获取可用 Agent 列表。'),
      message: z.string().describe('要发送的消息内容。可以是任意的自然语言文本。'),
      type: z.string().optional().describe('消息类型: "text"=普通消息（默认）, "btw"=旁路询问（低优先级，不打断对方工作）')
    }
  }, async (args) => {
    try {
      const { target_agent, message, type = 'text' } = args;

      // 查找目标 Agent（支持按名称或 ID 匹配）
      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      if (!target && type !== 'btw') {
        return {
          content: [{ type: 'text', text: `错误: 未找到 Agent "${target_agent}"。请使用 list_agents 查看可用的 Agent 列表。` }],
          isError: true
        };
      }

      const targetId = target ? target.id : 'broadcast';

      const success = socketClient.sendMessage({
        to: targetId,
        type,
        content: message,
        metadata: type === 'btw' ? { isBtw: true, urgency: 'normal' } : {}
      });

      if (!success) {
        return {
          content: [{ type: 'text', text: '消息发送失败: Socket 未连接。' }],
          isError: true
        };
      }

      return {
        content: [{
          type: 'text',
          text: `消息已发送到 **${target ? target.name : 'broadcast'}** (${targetId})。类型: ${type}。`
        }],
        structuredContent: {
          success: true,
          targetAgentId: targetId,
          targetAgentName: target?.name || 'broadcast',
          messageType: type
        }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `发送消息失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: send_task =====
  mcpServer.registerTool('send_task', {
    description: '向指定的 Agent 发送任务，让该 Agent 的 Claude Code 执行指定的 prompt。目标 Agent 会在本地启动 Claude Code CLI，流式执行后将结果返回给调用方。适用于让其他机器上的 Claude Code 帮忙分析代码、运行测试、调试问题等跨机器协作场景。',
    inputSchema: {
      target_agent: z.string().describe('目标 Agent 的名称或 ID。该 Agent 必须在线且空闲（状态为 online 或 idle）。可通过 list_agents 查看。'),
      prompt: z.string().describe('传给目标 Agent 的 Claude Code 的完整 prompt。应当清晰描述需要执行的任务，包括上下文信息。'),
      task_description: z.string().optional().describe('任务的简短描述（人类可读），会在目标 Agent 的状态栏中显示。'),
      timeout: z.number().int().min(10000).max(18000000).optional().describe('超时时间（毫秒），默认 300000 (5分钟)，最大 18000000 (5小时)。若用户无指定，自行根据任务复杂度评估：简单查询/小改动 5-10 分钟，中等重构/测试 15-30 分钟，大型跨文件重构 1-2 小时，全量审计/复杂迁移 2-5 小时。预估不足会导致任务被截断。')
    }
  }, async (args) => {
    try {
      const { target_agent, prompt, task_description, timeout = 300000 } = args;

      // 查找目标
      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      if (!target) {
        return {
          content: [{ type: 'text', text: `错误: 未找到 Agent "${target_agent}"。请使用 list_agents 查看可用 Agent。` }],
          isError: true
        };
      }

      if (target.status !== 'online' && target.status !== 'idle') {
        return {
          content: [{ type: 'text', text: `错误: Agent "${target.name}" 当前离线或正忙 (状态: ${target.status})。请选择在线且空闲的 Agent。` }],
          isError: true
        };
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      console.error(`[MCP] Sending task ${taskId} to ${target.name} (${target.id})`);

      // 发送 task-assign 消息通知
      socketClient.sendMessage({
        to: target.id,
        type: 'task-assign',
        content: task_description || prompt,
        metadata: { taskId, taskDescription: task_description, prompt, priority: 'high' }
      });

      // 发起 Claude Code 执行请求并等待结果
      try {
        const result = await socketClient.sendClaudeExecuteRequest({
          targetAgentId: target.id,
          taskId,
          prompt,
          context: {
            cwd: target.workDir || process.cwd(),
            files: [],
            environment: {}
          },
          timeout
        });

        if (result.error) {
          return {
            content: [{ type: 'text', text: `任务在 **${target.name}** 上执行失败: ${result.error}` }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: `任务在 **${target.name}** 上执行完成。\n` +
                  `退出码: ${result.exitCode}\n` +
                  `耗时: ${((result.duration || 0) / 1000).toFixed(1)}s\n` +
                  `会话ID: ${result.sessionId || '(无)'}\n` +
                  `摘要: ${result.summary || '(无)'}`
          }],
          structuredContent: {
            taskId,
            agentName: target.name,
            exitCode: result.exitCode,
            duration: result.duration,
            summary: result.summary,
            sessionId: result.sessionId || null
          }
        };
      } catch (execErr) {
        return {
          content: [{ type: 'text', text: `任务发送到 **${target.name}** 失败: ${execErr.message}` }],
          isError: true
        };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `发送任务失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: send_file =====
  mcpServer.registerTool('send_file', {
    description: '向指定的 Agent 发送本地文件。会通过 AingTalk Server 将文件分块传输到目标 Agent，文件保存在目标的 received/ 目录下。支持 .zip, .tar.gz, .js, .ts, .py, .json, .md, .txt, .log, .yaml, .yml 等类型，最大 100MB。',
    inputSchema: {
      file_path: z.string().describe('要发送的本地文件路径（绝对路径或相对于当前工作目录的路径）。'),
      target_agent: z.string().describe('目标 Agent 的名称或 ID。该 Agent 必须在线。可通过 list_agents 查看可用 Agent。'),
      description: z.string().optional().describe('文件描述（可选），会随文件传输通知一起发送给目标。')
    }
  }, async (args) => {
    const startTime = Date.now();
    try {
      const { file_path, target_agent, description } = args;

      // 1. 查找目标 Agent
      try {
        agentCache = await socketClient.requestAgentList();
      } catch (_) { /* 使用缓存 */ }

      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      if (!target) {
        return {
          content: [{ type: 'text', text: `错误: 未找到 Agent "${target_agent}"。请使用 list_agents 查看可用的 Agent 列表。` }],
          isError: true
        };
      }

      if (target.status === 'offline') {
        return {
          content: [{ type: 'text', text: `错误: Agent "${target.name}" 当前离线，无法发送文件。` }],
          isError: true
        };
      }

      // 2. 解析文件路径（相对 → 绝对）
      const path = require('path');
      const filePath = path.isAbsolute(file_path) ? file_path : path.resolve(process.cwd(), file_path);

      // 3. 验证文件
      const validation = fileTransfer.validateFile(filePath);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: `文件验证失败: ${validation.error}` }],
          isError: true
        };
      }

      // 4. 获取文件元数据
      let fileMeta;
      try {
        fileMeta = await fileTransfer.sendFile(filePath, target.id);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `准备文件失败: ${err.message}` }],
          isError: true
        };
      }

      console.error(`[MCP] Sending file: ${fileMeta.name} (${fileMeta.size} bytes, ${fileMeta.totalChunks} chunks) to ${target.name}`);

      // 超时：每个 chunk 100ms 往返 + 最少 30s
      const totalTimeout = Math.max(30000, fileMeta.totalChunks * 100);

      // 5. 发送文件请求并等待接收方接受
      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`文件传输超时: 等待接收方响应超过 ${totalTimeout / 1000}s`));
        }, totalTimeout);

        const onReady = (data) => {
          if (data.fileId === fileMeta.fileId) {
            clearTimeout(timeout);
            socketClient.onFileReady(null);
            socketClient.onFileRejected(null);
            socketClient.onFileError(null);
            resolve(data);
          }
        };

        const onRejected = (data) => {
          if (data.fileId === fileMeta.fileId) {
            clearTimeout(timeout);
            socketClient.onFileReady(null);
            socketClient.onFileRejected(null);
            socketClient.onFileError(null);
            reject(new Error(`接收方拒绝了文件: ${data.reason || '未知原因'}`));
          }
        };

        const onError = (data) => {
          if (data.fileId === fileMeta.fileId) {
            clearTimeout(timeout);
            socketClient.onFileReady(null);
            socketClient.onFileRejected(null);
            socketClient.onFileError(null);
            reject(new Error(`文件传输错误: ${data.error}`));
          }
        };

        socketClient.onFileReady(onReady);
        socketClient.onFileRejected(onRejected);
        socketClient.onFileError(onError);
      });

      const sent = socketClient.sendFileRequest({
        id: fileMeta.fileId,
        name: fileMeta.name,
        size: fileMeta.size,
        mimeType: fileMeta.mimeType,
        to: target.id
      });

      if (!sent) {
        return {
          content: [{ type: 'text', text: '文件发送失败: Socket 未连接。' }],
          isError: true
        };
      }

      // 等待 ready
      try {
        await readyPromise;
      } catch (err) {
        return {
          content: [{ type: 'text', text: `文件传输失败: ${err.message}` }],
          isError: true
        };
      }

      // 6. 发送所有块
      const chunkStartTime = Date.now();
      let chunkErrors = 0;

      for (let i = 0; i < fileMeta.totalChunks; i++) {
        try {
          const chunk = fileTransfer.readChunk(fileMeta.fileId, i);
          if (!chunk) break;

          const ackPromise = new Promise((resolve, reject) => {
            const ackTimeout = setTimeout(() => {
              chunkErrors++;
              if (chunkErrors > 3) {
                reject(new Error(`文件块传输失败: 连续 ${chunkErrors} 个块未确认`));
              } else {
                resolve(); // 容忍偶发超时
              }
            }, 5000);

            socketClient.onFileChunkAck((ackData) => {
              if (ackData.fileId === fileMeta.fileId && ackData.index === i) {
                clearTimeout(ackTimeout);
                resolve();
              }
            });
          });

          socketClient.sendFileChunk(fileMeta.fileId, chunk.index, chunk.total, chunk.data);
          await ackPromise;

          if (chunkErrors > 3) {
            throw new Error(`文件块传输失败: 超过 ${chunkErrors} 个块未确认`);
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `文件传输失败 (块 ${i}/${fileMeta.totalChunks}): ${err.message}` }],
            isError: true
          };
        }
      }

      // 7. 等待传输完成确认
      const completePromise = new Promise((resolve, reject) => {
        const completeTimeout = setTimeout(() => {
          reject(new Error('等待传输完成确认超时'));
        }, 15000);

        socketClient.onFileComplete((data) => {
          if (data.fileId === fileMeta.fileId) {
            clearTimeout(completeTimeout);
            resolve(data);
          }
        });
      });

      try {
        await completePromise;
      } catch (err) {
        return {
          content: [{ type: 'text', text: `文件传输完成但确认超时: ${err.message}。文件可能已部分送达。` }],
          isError: true
        };
      }

      const totalDuration = Date.now() - startTime;
      const chunkDuration = Date.now() - chunkStartTime;

      console.error(`[MCP] File sent: ${fileMeta.name} in ${totalDuration}ms (chunks: ${chunkDuration}ms)`);

      return {
        content: [{
          type: 'text',
          text: `文件已成功发送到 **${target.name}**。\n` +
                `- 文件名: ${fileMeta.name}\n` +
                `- 大小: ${(fileMeta.size / 1024).toFixed(1)} KB\n` +
                `- 分块数: ${fileMeta.totalChunks}\n` +
                `- 总耗时: ${(totalDuration / 1000).toFixed(1)}s\n` +
                `- 传输耗时: ${(chunkDuration / 1000).toFixed(1)}s` +
                (description ? `\n- 描述: ${description}` : '')
        }],
        structuredContent: {
          success: true,
          fileId: fileMeta.fileId,
          fileName: fileMeta.name,
          fileSize: fileMeta.size,
          targetAgent: target.name,
          duration: totalDuration
        }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `发送文件失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: cancel_task =====
  mcpServer.registerTool('cancel_task', {
    description: '取消远程 Agent 上正在执行的 Claude Code 任务。',
    inputSchema: {
      task_id: z.string().describe('要取消的任务 ID。'),
      target_agent: z.string().describe('运行该任务的 Agent 名称或 ID。')
    }
  }, async (args) => {
    try {
      const { task_id, target_agent } = args;

      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      if (!target) {
        return {
          content: [{ type: 'text', text: `错误: 未找到 Agent "${target_agent}"。` }],
          isError: true
        };
      }

      // 发送取消请求（通过 socket 直接发送，不等待响应）
      socketClient._sendCancel(task_id, target.id);

      return {
        content: [{
          type: 'text',
          text: `已向 **${target.name}** 发送取消任务 ${task_id} 的请求。`
        }],
        structuredContent: { success: true, taskId: task_id, targetAgent: target.name }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `取消任务失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: continue_task =====
  mcpServer.registerTool('continue_task', {
    description: '在已有会话中继续对话。通过 session_id 恢复之前的 Claude Code 会话并发送新的 prompt，实现多轮对话。需要提供 send_task 返回的 session_id。',
    inputSchema: {
      session_id: z.string().describe('要继续的会话 ID（由 send_task 返回的 sessionId 字段）。'),
      target_agent: z.string().describe('目标 Agent 的名称或 ID，该 Agent 必须在线且空闲。'),
      prompt: z.string().describe('追问内容或新的指令。会在之前会话的上下文中继续执行。'),
      task_description: z.string().optional().describe('任务的简短描述。'),
      timeout: z.number().int().min(10000).max(18000000).optional().describe('超时时间（毫秒），默认 300000 (5分钟)，最大 18000000 (5小时)。若用户无指定，自行根据追问内容的复杂度评估。继续会话时可参考上一轮的实际执行时长。')
    }
  }, async (args) => {
    try {
      const { session_id, target_agent, prompt, task_description, timeout = 300000 } = args;

      // 查找目标
      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      if (!target) {
        return {
          content: [{ type: 'text', text: `错误: 未找到 Agent "${target_agent}"。请使用 list_agents 查看可用 Agent。` }],
          isError: true
        };
      }

      if (target.status !== 'online' && target.status !== 'idle') {
        return {
          content: [{ type: 'text', text: `错误: Agent "${target.name}" 当前离线或正忙 (状态: ${target.status})。` }],
          isError: true
        };
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      console.error(`[MCP] Continuing session ${session_id} with task ${taskId} to ${target.name}`);

      // 发送 task-assign 消息通知
      socketClient.sendMessage({
        to: target.id,
        type: 'task-assign',
        content: task_description || `[继续会话] ${prompt}`,
        metadata: { taskId, taskDescription: task_description, prompt, priority: 'high', sessionId: session_id }
      });

      try {
        const result = await socketClient.sendClaudeExecuteRequest({
          targetAgentId: target.id,
          taskId,
          prompt,
          context: {
            cwd: target.workDir || process.cwd(),
            files: [],
            environment: {}
          },
          timeout,
          sessionId: session_id,
          resume: true
        });

        if (result.error) {
          return {
            content: [{ type: 'text', text: `会话继续在 **${target.name}** 上执行失败: ${result.error}` }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: `会话继续在 **${target.name}** 上执行完成。\n` +
                  `退出码: ${result.exitCode}\n` +
                  `耗时: ${((result.duration || 0) / 1000).toFixed(1)}s\n` +
                  `会话ID: ${result.sessionId || session_id}\n` +
                  `摘要: ${result.summary || '(无)'}`
          }],
          structuredContent: {
            taskId,
            agentName: target.name,
            exitCode: result.exitCode,
            duration: result.duration,
            summary: result.summary,
            sessionId: result.sessionId || session_id
          }
        };
      } catch (execErr) {
        return {
          content: [{ type: 'text', text: `会话继续发送到 **${target.name}** 失败: ${execErr.message}` }],
          isError: true
        };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `继续任务失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: get_agent_info =====
  mcpServer.registerTool('get_agent_info', {
    description: '获取指定 Agent 的详细信息，包括运行状态、系统指标、当前任务等。',
    inputSchema: {
      agent_name: z.string().describe('目标 Agent 的名称或 ID。')
    }
  }, async (args) => {
    try {
      const { agent_name } = args;

      try {
        agentCache = await socketClient.requestAgentList();
      } catch (_) { /* 使用缓存 */ }

      const target = (agentCache || []).find(a =>
        a.id === agent_name || a.name === agent_name
      );

      if (!target) {
        return {
          content: [{ type: 'text', text: `未找到 Agent "${agent_name}"。` }],
          isError: true
        };
      }

      const info = {
        name: target.name,
        id: target.id,
        status: target.status || 'unknown',
        platform: target.platform,
        arch: target.arch,
        hostname: target.hostname,
        role: target.role || '未分配',
        capabilities: target.capabilities || [],
        workDir: target.workDir || '',
        currentTask: target.currentTask || null,
        lastHeartbeat: target.lastHeartbeat || null,
        heartbeatLatency: target.heartbeatLatency || null
      };

      return {
        content: [{
          type: 'text',
          text: `**${info.name}** 详情:\n` +
                `- ID: ${info.id}\n` +
                `- 状态: ${info.status}\n` +
                `- 平台: ${info.platform}/${info.arch}\n` +
                `- 主机: ${info.hostname}\n` +
                `- 角色: ${info.role}\n` +
                `- 能力: ${info.capabilities.join(', ')}\n` +
                `- 当前任务: ${info.currentTask?.description || '无'}`
        }],
        structuredContent: info
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `获取 Agent 信息失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ---- Step 3: 连接 Stdio 传输 ----
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('[MCP] AingTalk MCP Server ready (stdio)');
  console.error('[MCP] Registered tools: list_agents, send_message, send_task, cancel_task, continue_task, send_file, get_agent_info');

  // ---- 优雅退出 ----
  process.on('SIGINT', () => {
    console.error('[MCP] Shutting down...');
    socketClient.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[MCP] Shutting down...');
    socketClient.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[MCP] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
