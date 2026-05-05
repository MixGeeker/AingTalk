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
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// 加载 CJS 模块
const require = createRequire(import.meta.url);
const { SocketClient } = require('./client/socket-client.js');
const { FileTransfer } = require('./file-handler/file-transfer.js');
const { ClaudeCodeExecutor } = require('./executor/claude-code.js');
const { encodeEvent } = require('./executor/event-encoder.js');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const z = require('zod');

const FILE_CHUNK_SIZE = 64 * 1024; // 64KB

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
      case '--mode':
        parsed.mode = args[++i];
        break;
    }
  }

  return {
    serverUrl: parsed.serverUrl || process.env.AINGTALK_SERVER_URL || 'http://localhost:3000',
    agentName: parsed.name || process.env.AGENT_NAME || os.hostname(),
    mode: parsed.mode || process.env.AINGTALK_MODE || 'full'
  };
}

/**
 * 获取 mcp-server.mjs 自身的绝对路径
 */
function getOwnPath() {
  return fileURLToPath(import.meta.url);
}

/**
 * 自动发现 Claude Code Session Token
 * 搜索顺序: 环境变量 → ~/.claude/credentials.json → macOS Keychain
 */
function findSessionToken() {
  // 1. 检查环境变量
  if (process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN) {
    console.error('[MCP] Token 来源: 环境变量 CLAUDE_CODE_SESSION_ACCESS_TOKEN');
    return process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  }

  // 2. 检查 ~/.claude/credentials.json
  try {
    const credsPath = path.join(os.homedir(), '.claude', 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const token = creds.accessToken || creds.sessionToken || creds.token;
      if (token) {
        console.error('[MCP] Token 来源: ~/.claude/credentials.json');
        return token;
      }
    }
  } catch (e) {
    // 继续尝试
  }

  // 3. 搜索 ~/.claude/ 下所有 JSON 文件
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf8'));
          const token = content.accessToken || content.sessionToken || content.token ||
                        content.oauthToken || content.credentials?.accessToken;
          if (token && typeof token === 'string' && token.length > 20) {
            console.error(`[MCP] Token 来源: ~/.claude/${file}`);
            return token;
          }
        } catch {}
      }
    }
  } catch {}

  // 4. macOS Keychain
  if (process.platform === 'darwin') {
    const keychainNames = [
      'claude-code', 'Claude Code', 'claude', 'com.anthropic.claude',
      'Claude Code CLI', 'com.anthropic.claude-code', 'claude-cli'
    ];
    for (const name of keychainNames) {
      try {
        const result = require('child_process').execSync(
          `security find-generic-password -s "${name}" -w 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (result) {
          console.error(`[MCP] Token 来源: macOS Keychain (${name})`);
          return result;
        }
      } catch {}
    }
  }

  // 5. ~/Library/Application Support/Claude Code/
  if (process.platform === 'darwin') {
    const appSupportDirs = [
      path.join(os.homedir(), 'Library', 'Application Support', 'Claude Code'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Claude'),
      path.join(os.homedir(), 'Library', 'Caches', 'Claude Code'),
    ];
    for (const dir of appSupportDirs) {
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') || f === '.session');
          for (const file of files) {
            try {
              const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
              const token = content.accessToken || content.sessionToken || content.token;
              if (token && typeof token === 'string' && token.length > 20) {
                console.error(`[MCP] Token 来源: ${path.join(dir, file)}`);
                return token;
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  console.error('[MCP] 警告: 未找到 CLAUDE_CODE_SESSION_ACCESS_TOKEN，CC 执行可能会失败');
  return null;
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

  const isFullMode = config.mode === 'full';
  const ownPath = getOwnPath();
  console.error(`[MCP] Mode: ${config.mode}, Own path: ${ownPath}`);

  // 自动发现并注入 Claude Code Session Token（后续 spawn CC 时通过 process.env 继承）
  if (isFullMode) {
    const token = findSessionToken();
    if (token) {
      process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token;
      console.error('[MCP] CLAUDE_CODE_SESSION_ACCESS_TOKEN 已注入到环境变量');
    }
  }

  // 注册（根据模式选择角色）
  socketClient.register({
    name: config.agentName,
    role: isFullMode ? 'worker' : 'mcp-client',
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    workDir: process.cwd(),
    capabilities: isFullMode ? ['mcp', 'claude-code', 'file-transfer'] : ['mcp'],
    claudeVersion: '',
    ip: '',
    startedAt: new Date().toISOString()
  });

  // 等待注册确认
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Registration timeout (15s)')), 15000);
    socketClient.onRegistered((data) => {
      clearTimeout(timeout);
      console.error(`[MCP] Agent registered: ${data.agentId} (${config.mode})`);
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

  // ---- full 模式: 自动生成 .mcp.json ----
  if (isFullMode) {
    const mcpJsonPath = path.join(process.cwd(), '.mcp.json');
    const mcpConfig = {
      mcpServers: {
        aingtalk: {
          type: 'stdio',
          command: 'node',
          args: [ownPath, '--server', config.serverUrl, '--mode', 'mcp-only'],
          env: {
            AINGTALK_SERVER_URL: config.serverUrl
          }
        }
      }
    };

    if (!fs.existsSync(mcpJsonPath)) {
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      console.error(`[MCP] 已自动生成 .mcp.json: ${mcpJsonPath}`);
    } else {
      console.error(`[MCP] .mcp.json 已存在，跳过自动生成: ${mcpJsonPath}`);
    }
  }

  // ==================== Worker 角色 (仅 full 模式) ====================

  // 心跳定时器（仅 full 模式）
  let heartbeatInterval = null;
  if (isFullMode) {
    heartbeatInterval = setInterval(() => {
      if (socketClient.connected) {
        socketClient.sendHeartbeat({
          status: Object.keys(activeTasks).length > 0 ? 'busy' : 'idle',
          currentTask: Object.keys(activeTasks).length > 0 ? `${Object.keys(activeTasks).length} tasks` : '',
          cpuUsage: 0,
          memoryUsage: 0,
          diskUsage: 0,
          uptime: process.uptime()
        });
      }
    }, 30000);
  }

  // Claude Code 执行器（TUI 模式，仅流式输出，不解析文本结果）
  const claudeExecutor = isFullMode ? new ClaudeCodeExecutor({
    workDir: process.cwd(),
    defaultTimeout: 18000000 // 5 小时上限
  }) : null;

  // 收到文件的追踪: fileId → { name, originalName, savedPath, fromAgent, size, receivedAt }
  const completedFiles = new Map();

  // 活跃任务 (仅 full 模式): taskId → { ptyProcess, requestId, fromAgentId, sessionId, resolve, reject, resultFile, tempMcpJson }
  const activeTasks = {};

  // 任务结果目录（仅 full 模式）
  const taskResultsDir = isFullMode ? path.join(process.cwd(), 'task-results') : null;
  if (isFullMode && !fs.existsSync(taskResultsDir)) {
    fs.mkdirSync(taskResultsDir, { recursive: true });
    console.error(`[MCP] Task results dir: ${taskResultsDir}`);
  }

  // 待处理收件箱（供 check_inbox MCP 工具查询）
  const pendingInbox = [];

  // ==================== 工具函数 ====================

  /**
   * 启动结果文件轮询 — 当 spawned CC 写入结果文件时触发（仅 full 模式）
   */
  function watchResultFile(taskId, resultFilePath, timeout) {
    const startTime = Date.now();
    const checkInterval = 2000;

    const timer = setInterval(() => {
      if (!activeTasks[taskId]) {
        clearInterval(timer);
        return;
      }

      if (fs.existsSync(resultFilePath)) {
        try {
          const content = fs.readFileSync(resultFilePath, 'utf8').trim();
          if (content.length > 0) {
            clearInterval(timer);
            console.error(`[MCP] 结果文件已写入: ${resultFilePath} (${content.length} chars)`);
            resolveTask(taskId, content);
            return;
          }
        } catch (err) {
          console.error(`[MCP] 读取结果文件失败: ${err.message}`);
        }
      }

      if (Date.now() - startTime > timeout) {
        clearInterval(timer);
        console.error(`[MCP] 等待结果文件超时: ${taskId}`);
        resolveTask(taskId, null, new Error('等待 Claude Code 结果超时'));
      }
    }, checkInterval);

    return timer;
  }

  /**
   * 完成任务 — 由结果文件监听或 complete_task MCP 工具触发
   */
  function resolveTask(taskId, result, error) {
    const task = activeTasks[taskId];
    if (!task) return;

    const { ptyProcess, requestId, fromAgentId, sessionId, resolve, reject, tempMcpJson } = task;

    // 终止 PTY 进程
    if (ptyProcess) {
      try { ptyProcess.kill(); } catch {}
    }

    // 通过 Socket.io 发送完成通知
    if (requestId) {
      socketClient.sendClaudeComplete(
        taskId,
        error ? -1 : 0,
        0,
        result || (error ? error.message : ''),
        requestId,
        sessionId
      );
    }

    // 发送 task-result 消息给发起方
    if (fromAgentId && result) {
      socketClient.sendMessage({
        to: fromAgentId,
        type: 'task-result',
        content: result.substring(0, 500),
        metadata: {
          taskId,
          fullResult: result.length > 500 ? result : undefined,
          sessionId
        }
      });
    }

    // 恢复/清理临时 .mcp.json
    if (tempMcpJson) {
      if (tempMcpJson.backupContent) {
        fs.writeFileSync(tempMcpJson.path, tempMcpJson.backupContent);
        console.error(`[MCP] 已恢复 .mcp.json: ${tempMcpJson.path}`);
      } else {
        try { fs.unlinkSync(tempMcpJson.path); } catch {}
        console.error(`[MCP] 已清理临时 .mcp.json: ${tempMcpJson.path}`);
      }
    }

    // Resolve/reject send_task 的 Promise
    if (error) {
      reject?.(error);
    } else {
      resolve?.({ exitCode: 0, duration: 0, summary: result, sessionId, taskId });
    }

    delete activeTasks[taskId];
    console.error(`[MCP] 任务完成: ${taskId}`);
  }

  // ---- 文件接收回调 (仅 full 模式) ----

  if (isFullMode) {
    socketClient.onFileRequest((data) => {
      const { fileId, name, size, from } = data;
      console.error(`[MCP] 收到文件传输请求: ${name} (${size} bytes) 来自 ${from}`);

      const validation = fileTransfer.validateFile(name, size);
      if (!validation.valid) {
        console.error(`[MCP] 拒绝文件: ${validation.error}`);
        socketClient.sendFileResponse(fileId, false);
        return;
      }

      try {
        fileTransfer.receiveFile(fileId, name, Math.ceil(size / FILE_CHUNK_SIZE));
        socketClient.sendFileResponse(fileId, true);
        console.error(`[MCP] 已接受文件: ${name}`);
      } catch (err) {
        console.error(`[MCP] 文件接收错误: ${err.message}`);
        socketClient.sendFileResponse(fileId, false);
      }
    });

    socketClient.onFileChunk((data) => {
      const { fileId, index, total, data: chunkData } = data;
      const result = fileTransfer.handleChunk(fileId, index, chunkData);

      if (result.complete && result.fileInfo) {
        const { fileId: fid, name, path: savedPath, finalSize } = result.fileInfo;
        console.error(`[MCP] 文件接收完成: ${name} → ${savedPath} (${finalSize} bytes)`);

        completedFiles.set(fid, {
          fileId: fid,
          name: name,
          savedPath: savedPath,
          fromAgent: 'unknown',
          size: finalSize,
          receivedAt: Date.now()
        });

        socketClient.sendMessage({
          type: 'file-notice',
          content: `文件接收完成: ${name}`,
          metadata: { fileId: fid, fileName: name, savedPath: savedPath, size: finalSize }
        });
      }
    });

    socketClient.onFileComplete((data) => {
      const existing = completedFiles.get(data.fileId);
      if (existing && data.from) {
        existing.fromAgent = data.from;
      }
    });
  }

  // ---- Claude Code 执行回调 (仅 full 模式) ----

  if (isFullMode) {
    socketClient.onClaudeExecute(async (data) => {
      const { taskId, prompt, context, timeout, requestId, fromAgentId, sessionId, resume } = data;

      if (!taskId || !prompt) {
        console.error('[MCP] Invalid claude:execute payload');
        return;
      }

      console.error(`[MCP] 收到 Claude Code 执行指令: ${taskId} 来自 ${fromAgentId}`);

      if (!(await claudeExecutor.isAvailable())) {
        socketClient.sendClaudeOutput(taskId, encodeEvent('error', { message: 'Claude Code 不可用' }), 'error');
        socketClient.sendClaudeComplete(taskId, -1, 0, 'Claude Code 不可用', requestId);
        return;
      }

      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const effectiveSessionId = (resume && sessionId && UUID_RE.test(sessionId))
        ? sessionId
        : uuidv4();

      const cwd = context?.cwd || process.cwd();
      const resultFilePath = path.join(taskResultsDir, `${taskId}.md`);

      // ---- 写入临时 .mcp.json，让 spawned CC 拥有 MCP 工具 ----
      let tempMcpJson = null;
      const taskMcpJsonPath = path.join(cwd, '.mcp.json');
      const taskMcpConfig = {
        mcpServers: {
          aingtalk: {
            type: 'stdio',
            command: 'node',
            args: [ownPath, '--server', config.serverUrl, '--mode', 'mcp-only'],
            env: {
              AINGTALK_SERVER_URL: config.serverUrl,
              AINGTALK_TASK_ID: taskId,
              AINGTALK_TASK_RESULT_FILE: resultFilePath
            }
          }
        }
      };

      // 备份已有 .mcp.json
      if (fs.existsSync(taskMcpJsonPath)) {
        const backupContent = fs.readFileSync(taskMcpJsonPath, 'utf8');
        tempMcpJson = { path: taskMcpJsonPath, backupContent };
        console.error(`[MCP] 备份已有 .mcp.json: ${taskMcpJsonPath}`);
      } else {
        tempMcpJson = { path: taskMcpJsonPath, backupContent: null };
      }

      fs.writeFileSync(taskMcpJsonPath, JSON.stringify(taskMcpConfig, null, 2) + '\n');
      console.error(`[MCP] 已写入任务临时 .mcp.json: ${taskMcpJsonPath}`);

      // ---- 构建增强 prompt ----
      let enhancedPrompt = prompt;

      // 注入文件上下文
      const contextFiles = [];

      if (context?.fileIds && Array.isArray(context.fileIds)) {
        for (const fid of context.fileIds) {
          const file = completedFiles.get(fid);
          if (file) contextFiles.push(file);
        }
      }

      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [, file] of completedFiles) {
        if (file.fromAgent === fromAgentId && file.receivedAt > cutoff && !contextFiles.find(f => f.fileId === file.fileId)) {
          contextFiles.push(file);
        }
      }

      if (contextFiles.length > 0) {
        const fileList = contextFiles.map(f =>
          `- **${f.name}** → \`${f.savedPath}\` (${(f.size / 1024).toFixed(1)} KB, ${Math.round((Date.now() - f.receivedAt) / 1000)}s 前收到)`
        ).join('\n');
        enhancedPrompt = `[系统上下文] 以下文件已由 Agent 发送并保存到本地，可直接读取分析：\n${fileList}\n\n---\n\n${prompt}`;
        console.error(`[MCP] 注入 ${contextFiles.length} 个文件路径到 prompt`);
      }

      // 告知 CC 可以使用 MCP 工具 complete_task 来回报结果
      enhancedPrompt += `\n\n---\n[任务完成指令] 完成上述任务后，请调用 **complete_task** MCP 工具来回报结果。参数：task_id="${taskId}", target_agent="${fromAgentId}", result=<你的结果摘要>。也可以调用 **send_message** 在中途发送进度通知。`;

      // 注意：不使用 --file 参数传递接收到的文件
      // --file 会触发 CC 上传文件到 Anthropic 服务器，需要 session token
      // 文件路径已通过 prompt 注入，CC 可直接用 Read 工具读取本地文件
      const fileArgs = [];
      // 仅保留外部显式传入的文件（来自 send_task 的 files 参数）
      if (context?.files && Array.isArray(context.files)) {
        for (const f of context.files) {
          if (fs.existsSync(f)) fileArgs.push(f);
        }
      }

      // 创建 Promise（用于等待任务完成，rejection 由 resolveTask 安全处理）
      let taskResolve, taskReject;
      new Promise((resolve, reject) => { taskResolve = resolve; taskReject = reject; })
        .catch(() => {}); // 防止 unhandled rejection 崩溃进程

      activeTasks[taskId] = {
        ptyProcess: null,
        requestId,
        fromAgentId,
        sessionId: effectiveSessionId,
        resolve: taskResolve,
        reject: taskReject,
        resultFile: resultFilePath,
        tempMcpJson
      };

      pendingInbox.push({
        taskId,
        fromAgent: fromAgentId,
        prompt: prompt,
        contextFiles: contextFiles.map(f => ({ name: f.name, savedPath: f.savedPath })),
        receivedAt: Date.now(),
        status: 'executing'
      });

      // 启动结果文件轮询（兜底：万一 CC 没用 complete_task MCP 工具，写文件也行）
      const watchTimer = watchResultFile(taskId, resultFilePath, timeout || 300000);

      try {
        const execOptions = {
          taskId,
          cwd,
          timeout: timeout || 300000,
          files: fileArgs,
          env: context?.environment || {},
          sessionId: effectiveSessionId,
          resume: !!resume,
          cols: 120,
          rows: 30
        };

        let lastResultSummary = '';
        for await (const chunk of claudeExecutor.execute(enhancedPrompt, execOptions)) {
          const kind = chunk.kind;
          if (!kind) continue;

          if (kind === 'init' || kind === 'thinking' || kind === 'text' ||
              kind === 'tool_use' || kind === 'tool_result' ||
              kind === 'stderr') {
            socketClient.sendClaudeOutput(taskId, encodeEvent(kind, chunk.data || {}), kind);
          } else if (kind === 'error') {
            socketClient.sendClaudeOutput(taskId, encodeEvent('error', chunk.data || { message: String(chunk.data) }), 'error');
          } else if (kind === 'result') {
            socketClient.sendClaudeOutput(taskId, encodeEvent('result', chunk.data || {}), 'result');
            lastResultSummary = chunk.data?.summary || '';
          } else if (kind === 'complete') {
            if (activeTasks[taskId]) {
              if (lastResultSummary) {
                resolveTask(taskId, lastResultSummary);
              } else {
                console.error(`[MCP] CC 进程退出，等待结果文件 (10s)...`);
                await new Promise(r => setTimeout(r, 10000));
                if (activeTasks[taskId] && fs.existsSync(resultFilePath)) {
                  try {
                    const content = fs.readFileSync(resultFilePath, 'utf8').trim();
                    if (content.length > 0) {
                      resolveTask(taskId, content);
                    }
                  } catch {}
                }
                if (activeTasks[taskId]) {
                  resolveTask(taskId, `Claude Code 已完成 (退出码: ${chunk.exitCode})。`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`[MCP] Claude Code 执行失败:`, error.message);
        resolveTask(taskId, null, error);
      } finally {
        clearInterval(watchTimer);
      }
    });
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

  // 已发送文件追踪: targetAgentId → [fileId]
  const sentFiles = new Map();

  // ===== Tool: send_task =====
  mcpServer.registerTool('send_task', {
    description: '向指定的 Agent 发送任务，让该 Agent 的 Claude Code 执行指定的 prompt。目标 Agent 会在本地启动 Claude Code CLI（TUI 模式），执行完成后通过 MCP 工具将结果返回。支持附带已发送文件的 fileId，让远程 CC 知道文件位置。',
    inputSchema: {
      target_agent: z.string().describe('目标 Agent 的名称或 ID。该 Agent 必须在线且空闲（状态为 online 或 idle）。可通过 list_agents 查看。'),
      prompt: z.string().describe('传给目标 Agent 的 Claude Code 的完整 prompt。应当清晰描述需要执行的任务，包括上下文信息。'),
      task_description: z.string().optional().describe('任务的简短描述（人类可读），会在目标 Agent 的状态栏中显示。'),
      timeout: z.number().int().min(10000).max(18000000).optional().describe('超时时间（毫秒），默认 300000 (5分钟)，最大 18000000 (5小时)。若用户无指定，自行根据任务复杂度评估：简单查询/小改动 5-10 分钟，中等重构/测试 15-30 分钟，大型跨文件重构 1-2 小时，全量审计/复杂迁移 2-5 小时。预估不足会导致任务被截断。'),
      file_ids: z.array(z.string()).optional().describe('要关联到此任务的文件 ID 列表。这些 fileId 由 send_file 返回。远程 Claude Code 将被告知这些文件在 received/ 目录下的准确路径。如不指定，会自动附加最近发送到该 Agent 的文件。')
    }
  }, async (args) => {
    try {
      const { target_agent, prompt, task_description, timeout = 300000, file_ids } = args;

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

      // 收集关联文件 IDs
      let taskFileIds = file_ids || [];

      // 自动附加最近发送的文件
      if (taskFileIds.length === 0) {
        const recent = sentFiles.get(target.id) || [];
        taskFileIds = recent.slice(-10); // 最近 10 个
        if (taskFileIds.length > 0) {
          console.error(`[MCP] 自动附加 ${taskFileIds.length} 个已发送文件到任务`);
        }
      }

      // 发送 task-assign 消息通知
      socketClient.sendMessage({
        to: target.id,
        type: 'task-assign',
        content: task_description || prompt,
        metadata: { taskId, taskDescription: task_description, prompt, priority: 'high', fileIds: taskFileIds }
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
            fileIds: taskFileIds,
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
                  (taskFileIds.length > 0 ? `关联文件: ${taskFileIds.length} 个\n` : '') +
                  `结果: ${result.summary || '(无)'}`
          }],
          structuredContent: {
            taskId,
            agentName: target.name,
            exitCode: result.exitCode,
            duration: result.duration,
            summary: result.summary,
            sessionId: result.sessionId || null,
            fileIds: taskFileIds
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

      // 追踪已发送文件，用于后续 send_task 自动关联
      if (!sentFiles.has(target.id)) {
        sentFiles.set(target.id, []);
      }
      sentFiles.get(target.id).push(fileMeta.fileId);
      // 每个 Agent 最多保留 50 条发送记录
      if (sentFiles.get(target.id).length > 50) {
        sentFiles.get(target.id).shift();
      }

      return {
        content: [{
          type: 'text',
          text: `文件已成功发送到 **${target.name}**。\n` +
                `- 文件名: ${fileMeta.name}\n` +
                `- 大小: ${(fileMeta.size / 1024).toFixed(1)} KB\n` +
                `- 文件ID: \`${fileMeta.fileId}\`\n` +
                `- 分块数: ${fileMeta.totalChunks}\n` +
                `- 总耗时: ${(totalDuration / 1000).toFixed(1)}s\n` +
                `- 传输耗时: ${(chunkDuration / 1000).toFixed(1)}s\n` +
                `\n提示: 在后续 send_task 中，系统会自动将此文件路径告知远程 Agent。也可在 send_task 中显式传入 \`file_ids: ["${fileMeta.fileId}"]\`` +
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
      timeout: z.number().int().min(10000).max(18000000).optional().describe('超时时间（毫秒），默认 300000 (5分钟)，最大 18000000 (5小时)。若用户无指定，自行根据追问内容的复杂度评估。继续会话时可参考上一轮的实际执行时长。'),
      file_ids: z.array(z.string()).optional().describe('要关联到此任务的文件 ID 列表。')
    }
  }, async (args) => {
    try {
      const { session_id, target_agent, prompt, task_description, timeout = 300000, file_ids } = args;

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

      let taskFileIds = file_ids || [];
      if (taskFileIds.length === 0) {
        const recent = sentFiles.get(target.id) || [];
        taskFileIds = recent.slice(-10);
      }

      // 发送 task-assign 消息通知
      socketClient.sendMessage({
        to: target.id,
        type: 'task-assign',
        content: task_description || `[继续会话] ${prompt}`,
        metadata: { taskId, taskDescription: task_description, prompt, priority: 'high', sessionId: session_id, fileIds: taskFileIds }
      });

      try {
        const result = await socketClient.sendClaudeExecuteRequest({
          targetAgentId: target.id,
          taskId,
          prompt,
          context: {
            cwd: target.workDir || process.cwd(),
            files: [],
            fileIds: taskFileIds,
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
                  (taskFileIds.length > 0 ? `关联文件: ${taskFileIds.length} 个\n` : '') +
                  `结果: ${result.summary || '(无)'}`
          }],
          structuredContent: {
            taskId,
            agentName: target.name,
            exitCode: result.exitCode,
            duration: result.duration,
            summary: result.summary,
            sessionId: result.sessionId || session_id,
            fileIds: taskFileIds
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

  // ===== Tool: complete_task =====
  mcpServer.registerTool('complete_task', {
    description: '完成任务并将结果发回给任务发起方。由执行任务的 Claude Code 调用，将执行结果通过 AingTalk Server 路由回 Leader Agent。也同时发送一条 task-result 消息。',
    inputSchema: {
      task_id: z.string().describe('要完成的任务 ID（从 claude:execute 事件的 taskId 或增强 prompt 中的任务 ID）。'),
      result: z.string().describe('任务结果摘要。可以是 Markdown 格式，包含关键发现、文件列表、修改内容等。'),
      target_agent: z.string().describe('结果发送目标 Agent 的名称或 ID（即任务发起方）。'),
      files: z.array(z.string()).optional().describe('（可选）要附带到结果中的本地文件路径列表。')
    }
  }, async (args) => {
    try {
      const { task_id, result, target_agent, files: resultFiles } = args;

      // 查找目标 Agent
      const target = (agentCache || []).find(a =>
        a.id === target_agent || a.name === target_agent
      );

      const targetId = target ? target.id : target_agent;

      // 通过 Socket.io 发送 task-result 消息
      const sent = socketClient.sendMessage({
        to: targetId,
        type: 'task-result',
        content: result.substring(0, 500),
        metadata: {
          taskId: task_id,
          fullResult: result.length > 500 ? result : undefined,
          resultFiles: resultFiles || [],
          completedAt: Date.now()
        }
      });

      if (!sent) {
        return {
          content: [{ type: 'text', text: '发送结果失败: Socket 未连接。' }],
          isError: true
        };
      }

      // 如果设置了 AINGTALK_TASK_RESULT_FILE 环境变量，写入结果文件（供 full 模式的轮询器捕获）
      const resultFilePath = process.env.AINGTALK_TASK_RESULT_FILE;
      if (resultFilePath) {
        try {
          const dir = path.dirname(resultFilePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(resultFilePath, result, 'utf8');
          console.error(`[MCP] complete_task 写入结果文件: ${resultFilePath}`);
        } catch (err) {
          console.error(`[MCP] 写入结果文件失败: ${err.message}`);
        }
      }

      // 如果是 full 模式且有本地活跃任务，resolve 它
      if (typeof resolveTask === 'function' && activeTasks[task_id]) {
        resolveTask(task_id, result);
      }

      return {
        content: [{
          type: 'text',
          text: `任务 ${task_id} 结果已发送到 **${target?.name || target_agent}**。\n结果长度: ${result.length} 字符。`
        }],
        structuredContent: {
          success: true,
          taskId: task_id,
          targetAgent: target?.name || target_agent,
          resultLength: result.length
        }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `完成任务失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: check_inbox =====
  mcpServer.registerTool('check_inbox', {
    description: '检查是否有待处理的任务或消息。返回当前工作站在收件箱中的任务列表。用于 Machine B 上的交互式 Claude Code 主动查看有哪些来自其他 Agent 的任务。',
    inputSchema: {}
  }, async (_args) => {
    try {
      // 清理超过 30 分钟的已完成/过期条目
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (let i = pendingInbox.length - 1; i >= 0; i--) {
        if (pendingInbox[i].receivedAt < cutoff) {
          pendingInbox.splice(i, 1);
        }
      }

      if (pendingInbox.length === 0) {
        return {
          content: [{ type: 'text', text: '收件箱为空，没有待处理的任务。' }],
          structuredContent: { count: 0, tasks: [] }
        };
      }

      const tasks = pendingInbox.map(t => ({
        taskId: t.taskId,
        fromAgent: t.fromAgent,
        prompt: t.prompt.substring(0, 200),
        fileCount: t.contextFiles?.length || 0,
        filePaths: t.contextFiles?.map(f => f.savedPath) || [],
        receivedAt: new Date(t.receivedAt).toISOString(),
        status: t.status
      }));

      return {
        content: [{
          type: 'text',
          text: `收件箱中共 ${tasks.length} 个任务:\n\n` + tasks.map(t =>
            `- **${t.taskId}** — 来自 ${t.fromAgent} — ${t.status}\n` +
            `  Prompt: ${t.prompt}${t.prompt.length > 200 ? '...' : ''}\n` +
            (t.filePaths.length > 0 ? `  关联文件: ${t.filePaths.join(', ')}\n` : '')
          ).join('\n')
        }],
        structuredContent: { count: tasks.length, tasks }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `查询收件箱失败: ${err.message}` }],
        isError: true
      };
    }
  });

  // ===== Tool: get_received_files =====
  mcpServer.registerTool('get_received_files', {
    description: '查询当前 Agent 收到的文件列表及其本地路径。返回每个文件的 fileId、名称、保存路径、大小、来源 Agent、接收时间。Claude Code 可据此直接读取文件进行分析。如指定 fileId 则只返回该文件。',
    inputSchema: {
      file_id: z.string().optional().describe('（可选）指定文件 ID，只返回该文件的信息。')
    }
  }, async (args) => {
    try {
      const { file_id } = args || {};

      if (file_id) {
        const file = completedFiles.get(file_id);
        if (!file) {
          // 尝试扫描 received/ 目录
          const receivedDir = path.join(process.cwd(), 'received');
          if (fs.existsSync(receivedDir)) {
            const entries = fs.readdirSync(receivedDir);
            const match = entries.find(e => e.startsWith(file_id + '_'));
            if (match) {
              const fullPath = path.join(receivedDir, match);
              const stat = fs.statSync(fullPath);
              return {
                content: [{
                  type: 'text',
                  text: `文件已找到:\n- 名称: ${match.replace(file_id + '_', '')}\n- 路径: \`${fullPath}\`\n- 大小: ${stat.size} bytes`
                }],
                structuredContent: {
                  found: true,
                  fileId: file_id,
                  name: match.replace(file_id + '_', ''),
                  savedPath: fullPath,
                  size: stat.size
                }
              };
            }
          }
          return {
            content: [{ type: 'text', text: `未找到文件: ${file_id}` }],
            isError: true
          };
        }

        return {
          content: [{
            type: 'text',
            text: `文件 **${file.name}**:\n- 路径: \`${file.savedPath}\`\n- 大小: ${(file.size / 1024).toFixed(1)} KB\n- 来源: ${file.fromAgent}\n- 接收时间: ${new Date(file.receivedAt).toISOString()}`
          }],
          structuredContent: {
            found: true,
            fileId: file.fileId,
            name: file.name,
            savedPath: file.savedPath,
            size: file.size,
            fromAgent: file.fromAgent,
            receivedAt: file.receivedAt
          }
        };
      }

      // 返回所有文件
      const files = Array.from(completedFiles.values());
      if (files.length === 0) {
        // 扫描 received/ 目录兜底
        const receivedDir = path.join(process.cwd(), 'received');
        if (fs.existsSync(receivedDir)) {
          const entries = fs.readdirSync(receivedDir);
          if (entries.length > 0) {
            const scanned = entries.map(e => {
              const parts = e.split(/_(.+)/, 2);
              const fullPath = path.join(receivedDir, e);
              let size = 0;
              try { size = fs.statSync(fullPath).size; } catch {}
              return {
                fileId: parts[0] || e,
                name: parts[1] || e,
                savedPath: fullPath,
                size,
                receivedAt: null
              };
            });
            return {
              content: [{
                type: 'text',
                text: `received/ 目录中找到 ${scanned.length} 个文件:\n\n` + scanned.map(f =>
                  `- **${f.name}** → \`${f.savedPath}\` (${(f.size / 1024).toFixed(1)} KB) — ID: ${f.fileId}`
                ).join('\n')
              }],
              structuredContent: { count: scanned.length, files: scanned }
            };
          }
        }
        return {
          content: [{ type: 'text', text: '当前没有接收到的文件。' }],
          structuredContent: { count: 0, files: [] }
        };
      }

      return {
        content: [{
          type: 'text',
          text: `共 ${files.length} 个已接收文件:\n\n` + files.map(f =>
            `- **${f.name}** → \`${f.savedPath}\` (${(f.size / 1024).toFixed(1)} KB) — 来自 ${f.fromAgent} — ${new Date(f.receivedAt).toISOString()}`
          ).join('\n')
        }],
        structuredContent: { count: files.length, files: Array.from(completedFiles.values()) }
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `查询已接收文件失败: ${err.message}` }],
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
  const shutdown = () => {
    console.error('[MCP] Shutting down...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (claudeExecutor) claudeExecutor.cancelAll();
    socketClient.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[MCP] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
