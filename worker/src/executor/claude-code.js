/**
 * ClaudeCodeExecutor - Claude Code CLI 执行器
 * 执行 Claude Code 命令，支持流式输出、超时控制、取消操作
 * 使用 cross-spawn 实现跨平台兼容
 */

const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const commandExists = require('command-exists');

class ClaudeCodeExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.claudePath = options.claudeCodePath || 'claude';
    this.workDir = options.workDir || process.cwd();
    this.defaultTimeout = options.defaultTimeout || 300000; // 默认 5 分钟
    this.version = null;
    this._available = null;
    this.activeTasks = new Map(); // taskId -> child process
  }

  /**
   * 检查 Claude Code 是否可用
   * @returns {Promise<boolean>}
   */
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

  /**
   * 获取 Claude Code 版本
   * @returns {Promise<string>}
   */
  async getVersion() {
    if (this.version) {
      return this.version;
    }

    if (!(await this.isAvailable())) {
      throw new Error('Claude Code 不可用');
    }

    try {
      // 尝试各种方式获取版本
      const versionFlags = ['--version', '-v', 'version'];
      for (const flag of versionFlags) {
        try {
          const result = await this.#runCommand([flag], { timeout: 10000, streaming: false });
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
   * 执行 Claude Code 命令（流式输出）
   * 返回 AsyncGenerator，支持 for await...of 遍历
   * @param {string} prompt - 提示词/指令
   * @param {Object} options - 执行选项
   * @param {string} [options.cwd] - 工作目录
   * @param {number} [options.timeout] - 超时时间(ms)
   * @param {string[]} [options.files] - 相关文件列表
   * @param {Object} [options.env] - 额外环境变量
   * @param {string} [options.taskId] - 任务 ID
   * @returns {AsyncGenerator<{type: string, data: string, done?: boolean}>}
   */
  async* execute(prompt, options = {}) {
    const {
      cwd = this.workDir,
      timeout = this.defaultTimeout,
      files = [],
      env = {},
      taskId = `claude_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    } = options;

    // 验证可用性
    if (!(await this.isAvailable())) {
      yield { type: 'error', data: 'Claude Code 不可用，请确保已安装 claude 命令' };
      yield { type: 'complete', data: '', exitCode: -1, duration: 0 };
      return;
    }

    // 验证工作目录
    if (!fs.existsSync(cwd)) {
      yield { type: 'error', data: `工作目录不存在: ${cwd}` };
      yield { type: 'complete', data: '', exitCode: -1, duration: 0 };
      return;
    }

    const startTime = Date.now();
    const outputBuffer = [];

    try {
      // 构建命令参数
      const args = this.#buildArgs(prompt, files);

      console.log(`[ClaudeCodeExecutor] 执行任务 ${taskId}: ${prompt.substring(0, 100)}...`);
      console.log(`[ClaudeCodeExecutor] 工作目录: ${cwd}`);

      // 创建子进程
      const child = spawn(this.claudePath, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: '1',
          CLAUDE_CODE_DEBUG: '1',
          TERM: 'xterm-256color'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      // 记录活动任务
      this.activeTasks.set(taskId, child);
      this.emit('task:start', { taskId, prompt, cwd });

      // 超时处理
      let timeoutTimer = null;
      let timedOut = false;

      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.warn(`[ClaudeCodeExecutor] 任务 ${taskId} 超时，正在终止...`);
          child.kill('SIGTERM');

          // 5秒后强制终止
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }, timeout);
      }

      // 使用 Promise 包装以便在 generator 中使用
      const outputPromise = this.#collectOutput(child, taskId, timeoutTimer);

      // 发送输入（如果需要）
      if (child.stdin && child.stdin.writable) {
        // Claude Code 通常通过命令行参数接收输入
        child.stdin.end();
      }

      // 流式输出
      for await (const chunk of outputPromise) {
        outputBuffer.push(chunk);
        yield chunk;
      }

      const duration = Date.now() - startTime;

      // 任务完成
      this.activeTasks.delete(taskId);

      if (timedOut) {
        this.emit('task:timeout', { taskId, duration });
        yield {
          type: 'complete',
          data: outputBuffer.filter(c => c.type === 'stdout').map(c => c.data).join(''),
          exitCode: -1,
          duration,
          error: '执行超时'
        };
      } else {
        const lastChunk = outputBuffer[outputBuffer.length - 1];
        this.emit('task:complete', { taskId, duration, exitCode: lastChunk?.exitCode ?? 0 });
        yield {
          type: 'complete',
          data: outputBuffer.filter(c => c.type === 'stdout').map(c => c.data).join(''),
          exitCode: lastChunk?.exitCode ?? 0,
          duration,
          summary: this.#generateSummary(outputBuffer)
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
        data: outputBuffer.filter(c => c.type === 'stdout').map(c => c.data).join(''),
        exitCode: -1,
        duration,
        error: error.message
      };
    }
  }

  /**
   * 取消正在执行的任务
   * @param {string} taskId - 任务 ID
   * @returns {boolean}
   */
  cancel(taskId) {
    const child = this.activeTasks.get(taskId);
    if (child) {
      console.log(`[ClaudeCodeExecutor] 取消任务 ${taskId}`);
      child.kill('SIGTERM');

      // 5秒后强制终止
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);

      this.activeTasks.delete(taskId);
      this.emit('task:cancelled', { taskId });
      return true;
    }
    return false;
  }

  /**
   * 取消所有任务
   */
  cancelAll() {
    for (const [taskId] of this.activeTasks) {
      this.cancel(taskId);
    }
  }

  /**
   * 获取活动任务列表
   * @returns {string[]}
   */
  getActiveTasks() {
    return Array.from(this.activeTasks.keys());
  }

  // ==================== 私有方法 ====================

  /**
   * 构建 Claude Code 命令参数
   * @private
   */
  #buildArgs(prompt, files) {
    const args = [];

    // 添加文件参数
    if (files && files.length > 0) {
      for (const file of files) {
        if (fs.existsSync(file)) {
          args.push('--file', file);
        }
      }
    }

    // 添加提示词 - 作为位置参数
    // Claude Code 支持: claude "prompt text"
    // 也支持通过 stdin 输入
    if (prompt) {
      args.push(prompt);
    }

    return args;
  }

  /**
   * 收集子进程输出（async generator 辅助方法）
   * @private
   */
  #collectOutput(child, taskId, timeoutTimer) {
    const chunks = [];

    return {
      [Symbol.asyncIterator]() {
        let stdoutEnded = false;
        let stderrEnded = false;
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

        child.stdout?.on('data', (data) => {
          const text = data.toString('utf8');
          const chunk = { type: 'stdout', data: text, taskId };
          chunks.push(chunk);
          pushChunk(chunk);
        });

        child.stderr?.on('data', (data) => {
          const text = data.toString('utf8');
          const chunk = { type: 'stderr', data: text, taskId };
          chunks.push(chunk);
          pushChunk(chunk);
        });

        child.stdout?.on('end', () => {
          stdoutEnded = true;
          if (stderrEnded || !child.stderr) {
            // 可能还需要等一下 close 事件获取 exitCode
          }
        });

        child.stderr?.on('end', () => {
          stderrEnded = true;
        });

        child.on('close', (exitCode) => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
          }
          closed = true;
          if (resolveNext) {
            resolveNext({
              value: { type: 'exit', exitCode, taskId },
              done: false
            });
            resolveNext = null;
          } else {
            buffer.push({ type: 'exit', exitCode, taskId });
          }
          checkDone();
        });

        child.on('error', (error) => {
          closed = true;
          const chunk = { type: 'error', data: error.message, taskId };
          chunks.push(chunk);
          pushChunk(chunk);
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
   * 运行简单命令（非流式）
   * @private
   */
  #runCommand(args, options = {}) {
    return new Promise((resolve, reject) => {
      const { timeout = 30000, cwd = this.workDir, streaming = true } = options;
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

  /**
   * 生成执行摘要
   * @private
   */
  #generateSummary(chunks) {
    const stdout = chunks
      .filter(c => c.type === 'stdout')
      .map(c => c.data)
      .join('');

    // 取最后 200 字符作为摘要
    const trimmed = stdout.trim();
    if (trimmed.length > 200) {
      return trimmed.substring(trimmed.length - 200);
    }
    return trimmed;
  }
}

module.exports = { ClaudeCodeExecutor };
