/**
 * ClaudeCodeExecutor - Claude Code CLI 执行器
 * 使用 node-pty 创建伪终端，完整镜像 Claude Code TUI
 * 版本检查等简单命令仍用 cross-spawn
 */

const pty = require('node-pty');
const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const commandExists = require('command-exists');

// ANSI_RE 已删除 — 不再从 PTY 输出提取纯文本摘要

/**
 * 解析命令的完整路径（node-pty 不自动解析 PATH）
 * 在进程内搜索 PATH，不 spawn shell，避免 macOS 上 shell 环境与 Node 进程 PATH 不一致
 */
function resolveCommand(cmd) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`where ${cmd}`, { encoding: 'utf8', timeout: 5000 }).trim();
      return result.split('\n')[0].trim();
    }

    // Unix: 进程内搜索 PATH 目录，不依赖 /bin/sh
    const pathDirs = (process.env.PATH || '').split(path.delimiter);

    // macOS: 补充 Homebrew 路径（可能不在 GUI 进程 / launchd 的 PATH 中）
    if (process.platform === 'darwin') {
      const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
      for (const p of extra) {
        if (!pathDirs.includes(p)) pathDirs.push(p);
      }
    }

    for (const dir of pathDirs) {
      if (!dir) continue;
      const fullPath = path.join(dir, cmd);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      } catch {}
    }

    return cmd;
  } catch {
    return cmd;
  }
}

class ClaudeCodeExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.claudePath = options.claudeCodePath || 'claude';
    this._resolvedPath = null; // 缓存解析后的路径
    this.workDir = options.workDir || process.cwd();
    this.defaultTimeout = options.defaultTimeout || 300000;
    this.version = null;
    this._available = null;
    this.activeTasks = new Map(); // taskId -> IPty
  }

  async isAvailable() {
    if (this._available !== null) {
      return this._available;
    }

    try {
      await commandExists(this.claudePath);
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async getVersion() {
    if (this.version) {
      return this.version;
    }

    if (!(await this.isAvailable())) {
      throw new Error('Claude Code 不可用');
    }

    try {
      const versionFlags = ['--version', '-v', 'version'];
      for (const flag of versionFlags) {
        try {
          const result = await this.#runCommand([flag], { timeout: 10000 });
          if (result.stdout) {
            this.version = result.stdout.trim();
            return this.version;
          }
        } catch {
          continue;
        }
      }
      this.version = 'unknown';
      return this.version;
    } catch (error) {
      this.version = 'unknown';
      return this.version;
    }
  }

  /**
   * 执行 Claude Code 命令（PTY 模式，完整 TUI 镜像）
   * @param {string} prompt - 提示词/指令
   * @param {Object} options - 执行选项
   * @param {string} [options.cwd] - 工作目录
   * @param {number} [options.timeout] - 超时时间(ms)
   * @param {string[]} [options.files] - 相关文件列表
   * @param {Object} [options.env] - 额外环境变量
   * @param {string} [options.taskId] - 任务 ID
   * @param {string} [options.sessionId] - Claude Code 会话 ID
   * @param {boolean} [options.resume] - 是否恢复已有会话
   * @param {number} [options.cols] - PTY 列数
   * @param {number} [options.rows] - PTY 行数
   * @returns {AsyncGenerator}
   */
  async* execute(prompt, options = {}) {
    const {
      cwd = this.workDir,
      timeout = this.defaultTimeout,
      files = [],
      env = {},
      taskId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId = null,
      resume = false,
      cols = 120,
      rows = 30
    } = options;

    if (!(await this.isAvailable())) {
      yield { type: 'error', data: 'Claude Code 不可用，请确保已安装 claude 命令' };
      yield { type: 'complete', data: '', exitCode: -1, duration: 0 };
      return;
    }

    if (!fs.existsSync(cwd)) {
      yield { type: 'error', data: `工作目录不存在: ${cwd}` };
      yield { type: 'complete', data: '', exitCode: -1, duration: 0 };
      return;
    }

    const startTime = Date.now();
    const outputChunks = [];

    try {
      const args = this.#buildArgs(prompt, files, { sessionId, resume });

      // 解析 claude 的完整路径（node-pty 不自动解析 PATH）
      if (!this._resolvedPath) {
        this._resolvedPath = resolveCommand(this.claudePath);
        console.log(`[ClaudeCodeExecutor] claude 解析路径: ${this._resolvedPath}`);
      }

      console.log(`[ClaudeCodeExecutor] PTY 执行任务 ${taskId}: ${prompt.substring(0, 100)}...`);
      console.log(`[ClaudeCodeExecutor] 工作目录: ${cwd}, PTY: ${cols}x${rows}`);

      // 创建 PTY 伪终端
      const ptyProcess = pty.spawn(this._resolvedPath, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          ...env,
          TERM: 'xterm-256color'
        }
      });

      this.activeTasks.set(taskId, ptyProcess);
      this.emit('task:start', { taskId, prompt, cwd });

      // 超时处理
      let timeoutTimer = null;
      let timedOut = false;

      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.warn(`[ClaudeCodeExecutor] 任务 ${taskId} 超时，正在终止...`);
          try { ptyProcess.kill(); } catch {}
        }, timeout);
      }

      // 收集 PTY 输出
      const iterator = this.#collectPtyOutput(ptyProcess, taskId, timeoutTimer);

      for await (const chunk of iterator) {
        outputChunks.push(chunk);
        yield chunk;
      }

      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      if (timedOut) {
        this.emit('task:timeout', { taskId, duration });
        yield {
          type: 'complete',
          data: '',
          exitCode: -1,
          duration,
          error: '执行超时'
        };
      } else {
        const exitChunk = outputChunks.find(c => c.type === 'exit');
        const exitCode = exitChunk?.exitCode ?? 0;
        this.emit('task:complete', { taskId, duration, exitCode });
        yield {
          type: 'complete',
          data: '',
          exitCode,
          duration
        };
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      console.error(`[ClaudeCodeExecutor] 任务 ${taskId} 执行失败:`, error.message);
      this.emit('task:error', { taskId, error: error.message, duration });

      yield { type: 'error', data: error.message };
      yield {
        type: 'complete',
        data: '',
        exitCode: -1,
        duration,
        error: error.message
      };
    }
  }

  /**
   * 取消正在执行的任务
   */
  cancel(taskId) {
    const ptyProcess = this.activeTasks.get(taskId);
    if (ptyProcess) {
      console.log(`[ClaudeCodeExecutor] 取消任务 ${taskId}`);
      try { ptyProcess.kill(); } catch {}
      this.activeTasks.delete(taskId);
      this.emit('task:cancelled', { taskId });
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const [taskId] of this.activeTasks) {
      this.cancel(taskId);
    }
  }

  getActiveTasks() {
    return Array.from(this.activeTasks.keys());
  }

  // ==================== 私有方法 ====================

  #buildArgs(prompt, files, sessionOpts = {}) {
    const args = [];
    const { sessionId, resume } = sessionOpts;

    // TUI 模式，跳过权限确认。结果由 MCP 工具回报，不解析 PTY 输出
    args.push('--dangerously-skip-permissions');

    if (resume && sessionId) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }

    if (files && files.length > 0) {
      for (const file of files) {
        if (fs.existsSync(file)) {
          args.push('--file', file);
        }
      }
    }

    if (prompt) {
      args.push(prompt);
    }

    return args;
  }

  /**
   * 收集 PTY 输出（async generator）
   * PTY 只有单一数据流，不区分 stdout/stderr
   * 仅在进程退出时判定完成，不做空闲检测
   * @private
   */
  #collectPtyOutput(ptyProcess, taskId, timeoutTimer) {
    return {
      [Symbol.asyncIterator]() {
        let closed = false;
        let buffer = [];
        let resolveNext = null;

        const pushChunk = (chunk) => {
          if (resolveNext) {
            resolveNext({ value: chunk, done: false });
            resolveNext = null;
          } else {
            buffer.push(chunk);
          }
        };

        const checkDone = () => {
          if (closed && buffer.length === 0 && resolveNext) {
            resolveNext({ value: undefined, done: true });
            resolveNext = null;
          }
        };

        // PTY 数据事件 — raw terminal bytes
        ptyProcess.onData((data) => {
          pushChunk({ type: 'pty', data, taskId });
        });

        // PTY 退出事件
        ptyProcess.onExit(({ exitCode }) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          closed = true;
          pushChunk({ type: 'exit', exitCode, taskId });
          checkDone();
        });

        return {
          next() {
            return new Promise((resolve) => {
              if (buffer.length > 0) {
                resolve({ value: buffer.shift(), done: false });
              } else if (closed) {
                resolve({ value: undefined, done: true });
              } else {
                resolveNext = resolve;
              }
            });
          }
        };
      }
    };
  }

  /**
   * 运行简单命令（非 PTY，用于版本检查等）
   * @private
   */
  #runCommand(args, options = {}) {
    return new Promise((resolve, reject) => {
      const { timeout = 30000, cwd = this.workDir } = options;
      let stdout = '';
      let stderr = '';

      // 解析完整路径，确保 macOS 上不使用 posix_spawnp 搜索 PATH
      if (!this._resolvedPath) {
        this._resolvedPath = resolveCommand(this.claudePath);
      }

      const child = spawn(this._resolvedPath, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        windowsHide: true
      });

      const timeoutTimer = timeout > 0 ? setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      }, timeout) : null;

      child.stdout?.on('data', (data) => {
        stdout += data.toString('utf8');
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString('utf8');
      });

      child.on('close', (exitCode) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve({ exitCode, stdout, stderr });
      });

      child.on('error', (error) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(error);
      });
    });
  }

  // #generateSummary 已删除 — 结果由 MCP 工具（complete_task / send_message）传递，不再从 PTY 文本提取
}

module.exports = { ClaudeCodeExecutor };
