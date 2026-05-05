/**
 * ClaudeCodeExecutor - Claude Code CLI 执行器
 * 使用 cross-spawn 运行 CC 的 -p --output-format stream-json 模式
 * 解析 NDJSON 事件流，yield 统一的 wire format 事件 { kind, data, taskId }
 *
 * yield 出的事件 kind ∈ {init, thinking, text, tool_use, tool_result, result,
 *                        error, stderr, complete}
 *   - 前 8 种与 event-encoder 的 wire format 一一对应（直接 encodeEvent 转发）
 *   - complete 是执行器内部进程退出标记，不在 wire format 内，调用方自行处理
 */

const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const commandExists = require('command-exists');
const { mapRawCcEvent } = require('./event-encoder');

class ClaudeCodeExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.claudePath = options.claudeCodePath || 'claude';
    this.workDir = options.workDir || process.cwd();
    this.defaultTimeout = options.defaultTimeout || 300000;
    this.version = null;
    this._available = null;
    this.activeTasks = new Map(); // taskId -> ChildProcess
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
      const result = await this.#runCommand(['--version'], { timeout: 10000 });
      if (result.stdout) {
        this.version = result.stdout.trim();
        return this.version;
      }
      this.version = 'unknown';
      return this.version;
    } catch {
      this.version = 'unknown';
      return this.version;
    }
  }

  /**
   * 执行 Claude Code 命令（stream-json 模式）
   * @param {string} prompt - 提示词/指令
   * @param {Object} options - 执行选项
   * @param {string} [options.cwd] - 工作目录
   * @param {number} [options.timeout] - 超时时间(ms)
   * @param {string[]} [options.files] - 相关文件列表
   * @param {Object} [options.env] - 额外环境变量
   * @param {string} [options.taskId] - 任务 ID
   * @param {string} [options.sessionId] - Claude Code 会话 ID
   * @param {boolean} [options.resume] - 是否恢复已有会话
   * @param {number} [options.maxTurns] - 最大 agentic turns
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
      maxTurns = 30
    } = options;

    if (!(await this.isAvailable())) {
      yield { kind: 'error', data: { message: 'Claude Code 不可用，请确保已安装 claude 命令' }, taskId };
      yield { kind: 'complete', data: null, exitCode: -1, duration: 0, taskId };
      return;
    }

    if (!fs.existsSync(cwd)) {
      yield { kind: 'error', data: { message: `工作目录不存在: ${cwd}` }, taskId };
      yield { kind: 'complete', data: null, exitCode: -1, duration: 0, taskId };
      return;
    }

    const startTime = Date.now();

    try {
      const args = this.#buildArgs(prompt, files, { sessionId, resume, maxTurns });

      console.log(`[ClaudeCodeExecutor] 执行任务 ${taskId}: ${prompt.substring(0, 100)}...`);
      console.log(`[ClaudeCodeExecutor] 工作目录: ${cwd}`);

      const child = spawn(this.claudePath, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.activeTasks.set(taskId, child);
      this.emit('task:start', { taskId, prompt, cwd });

      // 超时处理
      let timeoutTimer = null;
      let timedOut = false;

      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.warn(`[ClaudeCodeExecutor] 任务 ${taskId} 超时，正在终止...`);
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, 5000);
        }, timeout);
      }

      // NDJSON 逐行解析 + yield 结构化事件
      const iterator = this.#parseNDJSON(child, taskId, timeoutTimer);
      let finalResult = null;

      for await (const event of iterator) {
        if (event.kind === 'result') {
          finalResult = event;
        }
        yield event;
      }

      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      if (timedOut) {
        this.emit('task:timeout', { taskId, duration });
        yield { kind: 'complete', data: null, exitCode: -1, duration, error: '执行超时', taskId };
      } else {
        const exitCode = finalResult?.data?.isError ? 1 : 0;
        const resultData = finalResult?.data || null;
        this.emit('task:complete', { taskId, duration, exitCode });
        yield { kind: 'complete', data: resultData, exitCode, duration, taskId };
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      console.error(`[ClaudeCodeExecutor] 任务 ${taskId} 执行失败:`, error.message);
      this.emit('task:error', { taskId, error: error.message, duration });

      yield { kind: 'error', data: { message: error.message }, taskId };
      yield { kind: 'complete', data: null, exitCode: -1, duration, error: error.message, taskId };
    }
  }

  cancel(taskId) {
    const child = this.activeTasks.get(taskId);
    if (child) {
      console.log(`[ClaudeCodeExecutor] 取消任务 ${taskId}`);
      try { child.kill('SIGTERM'); } catch {}
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

  #buildArgs(prompt, files, opts = {}) {
    const args = [];
    const { sessionId, resume, maxTurns } = opts;

    // 无头模式 + stream-json 输出
    args.push('-p', '--output-format', 'stream-json', '--verbose');

    // 跳过权限确认
    args.push('--dangerously-skip-permissions');

    // 最大 turns
    if (maxTurns) {
      args.push('--max-turns', String(maxTurns));
    }

    // 会话
    if (resume && sessionId) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }

    // 文件
    if (files && files.length > 0) {
      for (const file of files) {
        if (fs.existsSync(file)) {
          args.push('--file', file);
        }
      }
    }

    // prompt 作为最后一个参数
    if (prompt) {
      args.push(prompt);
    }

    return args;
  }

  /**
   * 解析 NDJSON 流（async generator）
   * CC 的 stream-json 每行输出一个 JSON 事件
   * 输出统一为 { kind, data, taskId } 形式
   * @private
   */
  #parseNDJSON(child, taskId, timeoutTimer) {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        let buffer = '';
        let closed = false;
        let resolveNext = null;
        const queue = [];

        const pushEvent = (event) => {
          if (resolveNext) {
            resolveNext({ value: event, done: false });
            resolveNext = null;
          } else {
            queue.push(event);
          }
        };

        const checkDone = () => {
          if (closed && queue.length === 0 && resolveNext) {
            resolveNext({ value: undefined, done: true });
            resolveNext = null;
          }
        };

        // 解析一行 JSON 并转换为结构化事件
        const parseLine = (line) => {
          if (!line.trim()) return;

          try {
            const raw = JSON.parse(line);
            const events = self.#mapEvent(raw, taskId);
            for (const event of events) {
              pushEvent(event);
            }
          } catch {
            // 非 JSON 行 → stderr 通道（避免和真正的 assistant text 混淆）
            pushEvent({ kind: 'stderr', data: { text: line }, taskId });
          }
        };

        // stdout — NDJSON 流
        child.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留最后一个不完整的行
          for (const line of lines) {
            parseLine(line);
          }
        });

        // stderr — CC 的调试日志，作为 stderr 事件转发（前端可折叠）
        child.stderr.on('data', (data) => {
          const text = data.toString();
          if (text.trim()) {
            pushEvent({ kind: 'stderr', data: { text: text.replace(/\r?\n$/, '') }, taskId });
            console.error(`[CC stderr] ${text.trim()}`);
          }
        });

        // 进程退出
        child.on('close', () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);

          // 处理 buffer 中剩余的数据
          if (buffer.trim()) {
            parseLine(buffer);
            buffer = '';
          }

          closed = true;
          checkDone();
        });

        child.on('error', (err) => {
          pushEvent({ kind: 'error', data: { message: err.message }, taskId });
          closed = true;
          checkDone();
        });

        return {
          next() {
            return new Promise((resolve) => {
              if (queue.length > 0) {
                resolve({ value: queue.shift(), done: false });
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
   * 将 CC 的 stream-json 事件映射为 wire format 事件 { kind, data, taskId }
   * 委托给 event-encoder.mapRawCcEvent，仅追加 taskId 字段
   * @private
   */
  #mapEvent(raw, taskId) {
    const events = mapRawCcEvent(raw);
    return events.map(e => ({ ...e, taskId }));
  }

  /**
   * 运行简单命令（非 stream-json，用于版本检查等）
   * @private
   */
  #runCommand(args, options = {}) {
    return new Promise((resolve, reject) => {
      const { timeout = 30000, cwd = this.workDir } = options;
      let stdout = '';
      let stderr = '';

      const child = spawn(this.claudePath, args, {
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
}

module.exports = { ClaudeCodeExecutor };
