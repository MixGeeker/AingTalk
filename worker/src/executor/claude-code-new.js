/**
 * ClaudeCodeExecutor - Claude Code CLI 执行器
 * 使用 cross-spawn 运行 CC 的 -p --output-format stream-json 模式
 * 解析 NDJSON 事件流，yield 结构化事件
 */

const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const commandExists = require('command-exists');

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
      yield { type: 'error', data: 'Claude Code 不可用，请确保已安装 claude 命令' };
      yield { type: 'complete', data: null, exitCode: -1, duration: 0 };
      return;
    }

    if (!fs.existsSync(cwd)) {
      yield { type: 'error', data: `工作目录不存在: ${cwd}` };
      yield { type: 'complete', data: null, exitCode: -1, duration: 0 };
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
        if (event.type === 'result') {
          finalResult = event;
        }
        yield event;
      }

      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      if (timedOut) {
        this.emit('task:timeout', { taskId, duration });
        yield { type: 'complete', data: null, exitCode: -1, duration, error: '执行超时' };
      } else {
        const exitCode = finalResult?.exitCode ?? 0;
        const resultData = finalResult?.data || null;
        this.emit('task:complete', { taskId, duration, exitCode });
        yield { type: 'complete', data: resultData, exitCode, duration };
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      this.activeTasks.delete(taskId);

      console.error(`[ClaudeCodeExecutor] 任务 ${taskId} 执行失败:`, error.message);
      this.emit('task:error', { taskId, error: error.message, duration });

      yield { type: 'error', data: error.message };
      yield { type: 'complete', data: null, exitCode: -1, duration, error: error.message };
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
   * @private
   */
  #parseNDJSON(child, taskId, timeoutTimer) {
    return {
      [Symbol.asyncIterator]() {
        let buffer = '';
        let closed = false;
        let exitCode = 0;
        let resolveNext = null;
        let queue = [];

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
            const event = this.#mapEvent(raw, taskId);
            if (event) pushEvent(event);
          } catch {
            // 非 JSON 行，作为原始文本
            pushEvent({ type: 'text', data: line, taskId });
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

        // stderr — CC 的调试日志，直接转发
        child.stderr.on('data', (data) => {
          const text = data.toString();
          // 只在调试时输出，不作为事件转发
          console.error(`[CC stderr] ${text.trim()}`);
        });

        // 进程退出
        child.on('close', (code) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);

          // 处理 buffer 中剩余的数据
          if (buffer.trim()) {
            parseLine(buffer);
            buffer = '';
          }

          exitCode = code ?? 0;
          closed = true;
          checkDone();
        });

        child.on('error', (err) => {
          pushEvent({ type: 'error', data: err.message, taskId });
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
   * 将 CC 的 stream-json 事件映射为内部事件格式
   * @private
   */
  #mapEvent(raw, taskId) {
    const type = raw.type;

    // system/init — 会话初始化
    if (type === 'system') {
      if (raw.subtype === 'init') {
        return { type: 'init', data: { model: raw.model, tools: raw.tools }, taskId };
      }
      return null;
    }

    // assistant — 完整助手消息
    if (type === 'assistant') {
      const msg = raw.message || raw;
      // 提取工具调用和文本
      const content = msg.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            data: { name: block.name, id: block.id },
            toolName: block.name,
            input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2),
            taskId
          };
        }
      }
      return null; // 纯 assistant 消息由 stream_event 的 text_delta 处理
    }

    // tool_result — 工具执行结果
    if (type === 'tool_result') {
      const content = raw.content;
      const output = Array.isArray(content)
        ? content.map(c => c.text || JSON.stringify(c)).join('\n')
        : String(content || '');
      return {
        type: 'tool_result',
        data: { id: raw.tool_use_id },
        toolName: raw.toolName || '',
        output: output.substring(0, 5000),
        taskId
      };
    }

    // result — 最终结果
    if (type === 'result') {
      return {
        type: 'result',
        data: {
          result: raw.result || '',
          sessionId: raw.session_id,
          totalCostUsd: raw.total_cost_usd || 0,
          durationMs: raw.duration_ms || 0,
          numTurns: raw.num_turns || 0
        },
        exitCode: raw.subtype === 'error' ? 1 : 0,
        taskId
      };
    }

    // stream_event — 实时流（文本、工具调用等）
    if (type === 'stream_event') {
      const event = raw.event;
      if (!event) return null;

      // 文本增量
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return { type: 'text', data: event.delta.text, taskId };
      }

      // 工具调用开始
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        return {
          type: 'tool_use',
          data: { name: event.content_block.name, id: event.content_block.id },
          toolName: event.content_block.name,
          input: '',
          taskId
        };
      }

      // 工具调用增量（累积 input JSON）
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        return { type: 'tool_input_delta', data: event.delta.partial_json, taskId };
      }

      return null;
    }

    // 忽略其他事件类型
    return null;
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
