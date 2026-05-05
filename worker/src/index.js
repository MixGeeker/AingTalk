#!/usr/bin/env node
/**
 * Agent Collab Worker - 入口文件
 * 
 * 启动流程:
 * 1. 解析命令行参数和环境变量
 * 2. 加载配置文件
 * 3. 收集系统信息（平台、能力、Claude Code 版本）
 * 4. 连接 Server Socket.io
 * 5. 发送 agent:register 事件
 * 6. 收到确认后启动心跳定时器
 * 7. 监听各类事件并处理
 */

const os = require('os');
const path = require('path');

// 各模块
const { ConfigLoader } = require('./config/loader');
const { SystemInfoCollector } = require('./collector/system-info');
const { SocketClient } = require('./client/socket-client');
const { ClaudeCodeExecutor } = require('./executor/claude-code');
const { encodeEvent } = require('./executor/event-encoder');
const { CommandRunner } = require('./executor/command-runner');
const { FileTransfer, CHUNK_SIZE } = require('./file-handler/file-transfer');
const { v4: uuidv4 } = require('uuid');

// 从 FileTransfer 复用常量
const FILE_CHUNK_SIZE = CHUNK_SIZE;

// ==================== 命令行参数解析 ====================

function parseCliArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--server':
      case '-s':
        parsed.serverUrl = args[++i];
        break;
      case '--name':
      case '-n':
        parsed.name = args[++i];
        break;
      case '--workDir':
      case '-w':
        parsed.workDir = args[++i];
        break;
      case '--config':
      case '-c':
        parsed.configPath = args[++i];
        break;
      case '--claudePath':
        parsed.claudeCodePath = args[++i];
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        console.log('agent-collab-worker v1.0.0');
        process.exit(0);
        break;
    }
  }

  return parsed;
}

function showHelp() {
  console.log(`
Agent Collab Worker - 多 Agent 联调测试平台 Worker

用法: node src/index.js [选项]

选项:
  -s, --server <url>      Server 地址 (默认: http://localhost:3000)
  -n, --name <name>       Agent 名称 (默认: hostname)
  -w, --workDir <path>    工作目录 (默认: 当前目录)
  -c, --config <path>     配置文件路径
      --claudePath <path> Claude Code 命令路径
  -h, --help              显示帮助
  -v, --version           显示版本

环境变量:
  AGENT_SERVER_URL        Server 地址
  AGENT_NAME              Agent 名称
  AGENT_WORK_DIR          工作目录
  AGENT_HEARTBEAT_INTERVAL 心跳间隔(ms)
  AGENT_AUTO_RECONNECT    自动重连 (true/false)
  AGENT_CLAUDE_CODE_PATH  Claude Code 路径

示例:
  node src/index.js --server http://192.168.1.100:3000 --name "Mac-Dev"
  node src/index.js -s http://localhost:3000 -w /Users/dev/projects
`);
}

// ==================== Worker 类 ====================

class Worker {
  constructor() {
    this.config = null;
    this.agentId = uuidv4();
    this.systemInfo = null;
    this.socketClient = null;
    this.systemCollector = null;
    this.claudeExecutor = null;
    this.commandRunner = null;
    this.fileTransfer = null;
    this.heartbeatTimer = null;
    this.status = 'idle';
    this.currentTask = null;
    this.recentLogs = [];
    this.role = '';
    this.connected = false;
    this.taskSessions = new Map(); // taskId → sessionId
  }

  /**
   * 初始化 Worker
   */
  async init() {
    console.log('========================================');
    console.log('  Agent Collab Worker v1.0.0');
    console.log('========================================');
    console.log();

    // 1. 解析命令行参数
    const cliArgs = parseCliArgs();
    console.log('[Worker] 命令行参数:', cliArgs);

    // 2. 加载配置
    const configLoader = new ConfigLoader({ cliArgs });
    this.config = configLoader.load();
    console.log('[Worker] 配置加载完成');
    console.log(`  Server: ${this.config.serverUrl}`);
    console.log(`  Name: ${this.config.name}`);
    console.log(`  WorkDir: ${this.config.workDir}`);

    // 2.5 初始化 Claude Code 运行环境（确保 bypassPermissions）
    this.#setupClaudeCodeEnvironment();

    // 3. 初始化各模块
    this.systemCollector = new SystemInfoCollector({
      claudeCodePath: this.config.claudeCodePath
    });

    this.claudeExecutor = new ClaudeCodeExecutor({
      claudeCodePath: this.config.claudeCodePath,
      workDir: this.config.workDir,
      defaultTimeout: 300000
    });

    this.commandRunner = new CommandRunner({
      workDir: this.config.workDir,
      defaultTimeout: 60000
    });

    this.fileTransfer = new FileTransfer({
      workDir: this.config.workDir,
      maxFileSize: this.config.maxFileSize,
      allowedFileTypes: this.config.allowedFileTypes
    });

    this.socketClient = new SocketClient({
      serverUrl: this.config.serverUrl,
      agentId: this.agentId,
      autoReconnect: this.config.autoReconnect,
      reconnectInterval: this.config.reconnectInterval,
      maxReconnectAttempts: this.config.maxReconnectAttempts
    });

    // 4. 收集系统信息
    console.log('[Worker] 正在收集系统信息...');
    this.systemInfo = await this.systemCollector.collect();
    console.log(`  Platform: ${this.systemInfo.platformName} (${this.systemInfo.arch})`);
    console.log(`  Hostname: ${this.systemInfo.hostname}`);
    console.log(`  CPU: ${this.systemInfo.cpu.model} (${this.systemInfo.cpu.cores} cores)`);
    console.log(`  Memory: ${this.systemInfo.memory.totalFormatted}`);
    console.log(`  Claude Code: ${this.systemInfo.claudeCode.available ? this.systemInfo.claudeCode.version : '不可用'}`);
    console.log(`  Capabilities: ${this.systemInfo.capabilities.join(', ')}`);

    // 5. 设置 Socket.io 事件监听
    this.#setupSocketListeners();

    // 6. 设置信号处理
    this.#setupSignalHandlers();

    console.log('[Worker] 初始化完成');
    console.log();
  }

  /**
   * 启动 Worker（连接 Server 并注册）
   */
  async start() {
    try {
      // 连接 Server
      console.log(`[Worker] 正在连接 Server: ${this.config.serverUrl}`);
      await this.socketClient.connect();
      this.connected = true;

      // 发送注册信息
      const agentInfo = {
        id: this.agentId,
        name: this.config.name,
        role: this.role,
        hostname: this.systemInfo.hostname,
        platform: this.systemInfo.platform,
        arch: this.systemInfo.arch,
        workDir: this.config.workDir,
        capabilities: this.systemInfo.capabilities,
        claudeVersion: this.systemInfo.claudeCode.version || '',
        ip: this.systemInfo.network.primaryIp,
        startedAt: new Date().toISOString()
      };

      this.socketClient.register(agentInfo);

      // 等待注册确认后再启动心跳
      // （在 onRegistered 回调中处理）

    } catch (error) {
      console.error('[Worker] 启动失败:', error.message);

      if (this.config.autoReconnect) {
        this.retryCount = this.retryCount || 0;
        if (this.retryCount >= 5) {
          console.error('[Worker] 达到最大重试次数 (5)，停止重试');
          process.exit(1);
        }
        this.retryCount++;
        const delay = 5000 * Math.pow(2, this.retryCount - 1); // 指数退避
        console.log(`[Worker] 将在 ${Math.round(delay / 1000)} 秒后第 ${this.retryCount} 次重试...`);
        setTimeout(() => this.start(), delay);
      } else {
        process.exit(1);
      }
    }
  }

  /**
   * 初始化 Claude Code 运行环境
   * 在 workDir 下写入 .claude/settings.local.json，确保 Claude Code 以 bypassPermissions 模式运行
   * @private
   */
  #setupClaudeCodeEnvironment() {
    const claudeDir = path.join(this.config.workDir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');

    try {
      if (!require('fs').existsSync(claudeDir)) {
        require('fs').mkdirSync(claudeDir, { recursive: true });
        console.log(`[Worker] 创建 .claude 目录: ${claudeDir}`);
      }

      const settings = {
        permissions: {
          allow: [
            'Bash(*)',
            'Read(*)',
            'Write(*)',
            'Edit(*)',
            'WebFetch(*)',
            'WebSearch(*)'
          ],
          defaultMode: 'bypassPermissions'
        }
      };

      require('fs').writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[Worker] Claude Code 环境已配置 (bypassPermissions): ${settingsPath}`);
    } catch (err) {
      console.error(`[Worker] 配置 Claude Code 环境失败: ${err.message}`);
    }
  }

  /**
   * 设置 Socket.io 事件监听
   * @private
   */
  #setupSocketListeners() {
    // 连接成功
    this.socketClient.onConnected(() => {
      this.connected = true;
      this.log('已连接到 Server');
    });

    // 断开连接
    this.socketClient.onDisconnected((reason) => {
      this.connected = false;
      this.log(`与 Server 断开连接: ${reason}`);
      this.#stopHeartbeat();
    });

    // 注册确认
    this.socketClient.onRegistered((data) => {
      console.log(`[Worker] Agent 注册成功: ${data.agentId}`);
      this.log('Agent 注册成功');

      // 启动心跳
      this.#startHeartbeat();

      // 发送状态报告
      this.#sendStatusReport();
    });

    // 消息监听
    this.socketClient.onMessage((message) => {
      this.#handleMessage(message);
    });

    // Claude Code 执行指令
    this.socketClient.onClaudeExecute((data) => {
      this.#handleClaudeExecute(data);
    });

    // Claude Code 取消指令
    this.socketClient.onClaudeCancel((taskId) => {
      this.claudeExecutor.cancel(taskId);
      this.status = 'idle';
      this.currentTask = null;
      this.log(`任务已取消: ${taskId}`);
    });

    // 文件传输请求
    this.socketClient.onFileRequest((data) => {
      this.#handleFileIncoming(data);
    });

    // 文件块
    this.socketClient.onFileChunk((data) => {
      this.#handleFileChunk(data);
    });

    // 文件传输完成
    this.socketClient.onFileComplete((data) => {
      this.log(`文件传输完成: ${data.fileId}`);
    });

    // 角色分配
    this.socketClient.onRoleAssign((roleName, roleDescription) => {
      this.role = roleName;
      this.log(`角色已分配: ${roleName} - ${roleDescription || ''}`);

      // 回复确认
      this.socketClient.sendMessage({
        type: 'response',
        content: `角色 "${roleName}" 已接受`,
        metadata: { replyType: 'role-assign-ack', roleName }
      });
    });

    // 任务分配
    this.socketClient.onTaskAssign((taskId, metadata) => {
      this.log(`收到任务: ${metadata.taskDescription || taskId} (优先级: ${metadata.priority || 'normal'})`);

      // 回复确认
      this.socketClient.sendMessage({
        type: 'response',
        content: `任务 "${metadata.taskDescription || taskId}" 已接受`,
        metadata: { replyType: 'task-assign-ack', taskId, ...metadata }
      });
    });

    // 状态查询
    this.socketClient.onStatusQuery((queryType) => {
      this.#sendStatusReport();
    });

    // 心跳确认
    this.socketClient.onHeartbeatAck((data) => {
      // 心跳确认，可用于检测连接质量
    });
  }

  /**
   * 处理消息
   * @private
   */
  #handleMessage(message) {
    // 只处理发给本 Agent 或广播的消息
    if (message.to !== 'broadcast' && message.to !== this.agentId) {
      return;
    }

    this.log(`收到消息 [${message.type}]: ${message.content?.substring(0, 80)}...`);

    switch (message.type) {
      case 'text':
        // 文本消息，记录即可
        break;

      case 'status-query':
        this.#sendStatusReport();
        break;

      case 'btw':
        // 旁路消息，记录并可能回复
        this.log(`[BTW] ${message.content}`);
        break;

      case 'file-notice':
        this.log(`文件通知: ${message.metadata?.fileId || ''}`);
        break;

      default:
        // 其他类型已在专门的回调中处理
        break;
    }
  }

  /**
   * 处理 Claude Code 执行
   * @private
   */
  async #handleClaudeExecute(data) {
    if (!data || !data.taskId || !data.prompt) {
      console.error('[Worker] Invalid claude:execute payload - missing taskId or prompt');
      return;
    }

    const { taskId, prompt, context, timeout, requestId, fromAgentId, sessionId, resume } = data;

    // 防止并发执行
    if (this.status === 'busy') {
      console.warn(`[Worker] Already busy, rejecting task ${taskId}`);
      this.socketClient.sendClaudeOutput(taskId, encodeEvent('error', { message: 'Agent 正忙，请稍后再试' }), 'error');
      this.socketClient.sendClaudeComplete(taskId, -1, 0, 'Agent busy', requestId);
      return;
    }

    // 检查 Claude Code 是否可用
    if (!(await this.claudeExecutor.isAvailable())) {
      this.socketClient.sendClaudeOutput(taskId, encodeEvent('error', { message: 'Claude Code 不可用' }), 'error');
      this.socketClient.sendClaudeComplete(taskId, -1, 0, 'Claude Code 不可用', requestId);
      return;
    }

    // 确定会话 ID：必须是有效 UUID，否则生成新的
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const effectiveSessionId = (resume && sessionId && UUID_RE.test(sessionId))
      ? sessionId
      : uuidv4();

    // 设置状态
    this.status = 'busy';
    this.currentTask = { id: taskId, description: prompt.substring(0, 100) };
    this.log(`开始执行 Claude Code 任务: ${taskId} (session: ${effectiveSessionId}, resume: ${!!resume})`);

    const startTime = Date.now();
    let outputBuffer = '';
    let hasError = false;

    try {
      const options = {
        taskId,
        cwd: context?.cwd || this.config.workDir,
        timeout: timeout || 300000,
        files: context?.files || [],
        env: context?.environment || {},
        sessionId: effectiveSessionId,
        resume: !!resume
      };

      // 流式执行 — 统一通过 wire format 转发结构化事件
      let lastResultSummary = '';
      for await (const chunk of this.claudeExecutor.execute(prompt, options)) {
        const kind = chunk.kind;
        if (!kind) continue;

        // wire format 事件直接编码转发
        if (kind === 'init' || kind === 'thinking' || kind === 'text' ||
            kind === 'tool_use' || kind === 'tool_result' ||
            kind === 'result' || kind === 'stderr') {
          this.socketClient.sendClaudeOutput(taskId, encodeEvent(kind, chunk.data || {}), kind);
          if (kind === 'result') {
            lastResultSummary = chunk.data?.summary || '';
            if (chunk.data?.isError) hasError = true;
          }
        } else if (kind === 'error') {
          this.socketClient.sendClaudeOutput(taskId, encodeEvent('error', chunk.data || { message: String(chunk.data) }), 'error');
          hasError = true;
        } else if (kind === 'complete') {
          const duration = Date.now() - startTime;
          this.taskSessions.set(taskId, effectiveSessionId);
          this.socketClient.sendClaudeComplete(
            taskId,
            chunk.exitCode ?? (hasError ? 1 : 0),
            duration,
            lastResultSummary,
            requestId,
            effectiveSessionId
          );
        }
      }

      this.log(`Claude Code 任务完成: ${taskId}`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[Worker] Claude Code 执行失败:`, error.message);

      this.socketClient.sendClaudeOutput(taskId, encodeEvent('error', { message: `执行错误: ${error.message}` }), 'error');
      this.socketClient.sendClaudeComplete(taskId, -1, duration, error.message, requestId, effectiveSessionId);
    } finally {
      this.status = 'idle';
      this.currentTask = null;
    }
  }

  /**
   * 处理文件传入请求
   * @private
   */
  async #handleFileIncoming(data) {
    const { fileId, name, size, from } = data;

    this.log(`收到文件传输请求: ${name} (${this.#formatBytes(size)}) 来自 ${from}`);

    try {
      // 验证文件
      const validation = this.fileTransfer.validateFile(name, size);
      if (!validation.valid) {
        this.log(`拒绝文件: ${validation.error}`);
        this.socketClient.sendFileResponse(fileId, false);
        return;
      }

      // 接受文件
      const fileInfo = this.fileTransfer.receiveFile(fileId, name, Math.ceil(size / FILE_CHUNK_SIZE));
      this.socketClient.sendFileResponse(fileId, true);
      this.log(`已接受文件传输: ${name}`);
    } catch (error) {
      this.log(`文件接收错误: ${error.message}`);
      this.socketClient.sendFileResponse(fileId, false);
    }
  }

  /**
   * 处理文件块
   * @private
   */
  #handleFileChunk(data) {
    const { fileId, index, total, data: chunkData } = data;

    const result = this.fileTransfer.handleChunk(fileId, index, chunkData);

    if (result.complete) {
      this.log(`文件接收完成: ${result.fileInfo?.name || fileId}`);

      // 发送确认
      this.socketClient.sendMessage({
        type: 'file-notice',
        content: `文件接收完成: ${result.fileInfo?.name || fileId}`,
        metadata: {
          fileId,
          fileName: result.fileInfo?.name,
          savedPath: result.fileInfo?.path,
          size: result.fileInfo?.finalSize
        }
      });
    }
  }

  /**
   * 启动心跳定时器
   * @private
   */
  #startHeartbeat() {
    // 先停止已有定时器
    this.#stopHeartbeat();

    const interval = this.config.heartbeatInterval;
    console.log(`[Worker] 启动心跳定时器 (间隔: ${interval}ms)`);

    this.heartbeatTimer = setInterval(() => {
      this.#sendHeartbeat();
    }, interval);

    // 立即发送一次
    this.#sendHeartbeat();
  }

  /**
   * 停止心跳定时器
   * @private
   */
  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[Worker] 心跳定时器已停止');
    }
  }

  /**
   * 发送心跳
   * @private
   */
  async #sendHeartbeat() {
    if (!this.connected || !this.socketClient) return;

    try {
      const metrics = await this.systemCollector.collectMetrics();

      this.socketClient.sendHeartbeat({
        status: this.status,
        currentTask: this.currentTask ? this.currentTask.description : '',
        cpuUsage: metrics.cpuUsage,
        memoryUsage: metrics.memoryPercent,
        diskUsage: metrics.diskUsage,
        uptime: metrics.uptime
      });
    } catch (error) {
      console.error('[Worker] 心跳发送失败:', error.message);
    }
  }

  /**
   * 发送状态报告
   * @private
   */
  #sendStatusReport() {
    if (!this.connected || !this.socketClient) return;

    this.socketClient.sendStatusReport({
      status: this.status,
      currentTask: this.currentTask,
      recentLogs: this.recentLogs.slice(-20) // 最近 20 条日志
    });
  }

  /**
   * 记录日志
   * @private
   */
  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    this.recentLogs.push(logEntry);

    // 限制日志数量 (保留最近 100 条)
    if (this.recentLogs.length > 200) {
      this.recentLogs = this.recentLogs.slice(-100);
    }

    console.log(`[Worker] ${message}`);
  }

  /**
   * 设置信号处理（优雅关闭）
   * @private
   */
  #setupSignalHandlers() {
    const gracefulShutdown = async (signal) => {
      console.log(`\n[Worker] 收到信号 ${signal}，正在优雅关闭...`);

      this.#stopHeartbeat();

      // 取消所有正在执行的任务并等待子进程退出
      this.claudeExecutor?.cancelAll();
      this.commandRunner?.cancelAll();

      // 短暂等待子进程清理（cancel 已发 SIGTERM，给 3 秒缓冲）
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 清理文件传输
      this.fileTransfer?.cleanup();

      // 断开连接
      this.socketClient?.disconnect();

      console.log('[Worker] 已安全关闭');
      process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Windows 不支持 SIGINT/SIGTERM，使用 readline
    if (process.platform === 'win32') {
      const readline = require('readline');
      readline.createInterface({
        input: process.stdin,
        output: process.stdout
      }).on('SIGINT', () => gracefulShutdown('SIGINT'));
    }

    // 未捕获的异常 — 记录后退出，让进程管理器重启
    process.on('uncaughtException', (error) => {
      console.error('[Worker] 未捕获的异常:', error);
      this.log(`未捕获的异常: ${error.message}`);
      this.#stopHeartbeat();
      this.claudeExecutor?.cancelAll();
      this.commandRunner?.cancelAll();
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Worker] 未处理的 Promise 拒绝:', reason);
      this.log(`未处理的 Promise 拒绝: ${reason}`);
      this.#stopHeartbeat();
      this.claudeExecutor?.cancelAll();
      this.commandRunner?.cancelAll();
      process.exit(1);
    });
  }

  /**
   * 格式化字节大小
   * @private
   */
  #formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
  }
}

// ==================== 启动 ====================

async function main() {
  const worker = new Worker();
  await worker.init();
  await worker.start();
}

// 启动
main().catch((error) => {
  console.error('[Worker] 致命错误:', error);
  process.exit(1);
});

module.exports = { Worker };
