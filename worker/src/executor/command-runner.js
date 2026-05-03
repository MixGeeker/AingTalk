/**
 * CommandRunner - 系统命令执行器
 * 使用 cross-spawn 实现跨平台命令执行
 * 支持流式输出、超时控制、错误处理
 */

const spawn = require('cross-spawn');
const { EventEmitter } = require('events');

class CommandRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workDir = options.workDir || process.cwd();
    this.defaultTimeout = options.defaultTimeout || 60000; // 默认 60 秒
    this.defaultShell = options.defaultShell || this.#detectDefaultShell();
    this.activeProcesses = new Map(); // 正在运行的进程
  }

  /**
   * 执行系统命令
   * @param {string} command - 命令字符串或命令名
   * @param {Object} options - 执行选项
   * @param {string[]} [options.args] - 命令参数
   * @param {string} [options.cwd] - 工作目录
   * @param {number} [options.timeout] - 超时时间(ms)
   * @param {Object} [options.env] - 环境变量
   * @param {boolean} [options.streaming] - 是否流式输出
   * @returns {Promise<Object>} 执行结果
   */
  async run(command, options = {}) {
    const {
      args = [],
      cwd = this.workDir,
      timeout = this.defaultTimeout,
      env = process.env,
      streaming = true
    } = options;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let killed = false;

      // 解析命令（支持空格分隔的命令字符串）
      const { cmd, cmdArgs } = this.#parseCommand(command, args);

      console.log(`[CommandRunner] 执行命令: ${cmd} ${cmdArgs.join(' ')} (cwd: ${cwd})`);

      // 创建子进程
      const child = spawn(cmd, cmdArgs, {
        cwd,
        env: { ...env, FORCE_COLOR: '1', COLORTERM: 'truecolor' },
        stdio: streaming ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // Windows 下隐藏窗口
        shell: this.#shouldUseShell(cmd) // 判断是否需要 shell
      });

      const processId = `${cmd}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.activeProcesses.set(processId, child);

      // 超时处理
      let timeoutTimer = null;
      if (timeout > 0) {
        timeoutTimer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          // 给进程 5 秒优雅退出时间
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }, timeout);
      }

      // 收集 stdout
      child.stdout?.on('data', (data) => {
        const chunk = data.toString('utf8');
        stdout += chunk;

        if (streaming) {
          this.emit('stdout', chunk, processId);
        }
      });

      // 收集 stderr
      child.stderr?.on('data', (data) => {
        const chunk = data.toString('utf8');
        stderr += chunk;

        if (streaming) {
          this.emit('stderr', chunk, processId);
        }
      });

      // 进程关闭
      child.on('close', (code, signal) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        this.activeProcesses.delete(processId);

        const duration = Date.now() - startTime;

        const result = {
          exitCode: code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          duration,
          killed,
          processId,
          command: `${cmd} ${cmdArgs.join(' ')}`
        };

        if (code === 0) {
          console.log(`[CommandRunner] 命令执行完成 (${duration}ms): ${cmd}`);
          resolve(result);
        } else if (killed) {
          console.warn(`[CommandRunner] 命令超时被杀 (${duration}ms): ${cmd}`);
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        } else {
          console.error(`[CommandRunner] 命令执行失败 (exit=${code}, ${duration}ms): ${cmd}`);
          const error = new Error(`命令执行失败 (exit=${code}): ${stderr || stdout}`);
          error.exitCode = code;
          error.stdout = stdout;
          error.stderr = stderr;
          error.duration = duration;
          reject(error);
        }
      });

      // 进程错误
      child.on('error', (error) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        this.activeProcesses.delete(processId);

        if (error.code === 'ENOENT') {
          reject(new Error(`命令未找到: ${cmd}`));
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * 在工作目录执行命令
   * @param {string} command - 命令
   * @param {Object} [options] - 额外选项
   * @returns {Promise<Object>}
   */
  async runInWorkDir(command, options = {}) {
    return this.run(command, {
      ...options,
      cwd: this.workDir
    });
  }

  /**
   * 取消正在执行的命令
   * @param {string} processId - 进程 ID
   * @param {string} [signal] - 信号类型
   */
  cancel(processId, signal = 'SIGTERM') {
    const child = this.activeProcesses.get(processId);
    if (child) {
      child.kill(signal);
      this.activeProcesses.delete(processId);
      return true;
    }
    return false;
  }

  /**
   * 取消所有正在执行的命令
   * @param {string} [signal] - 信号类型
   */
  cancelAll(signal = 'SIGTERM') {
    for (const [processId, child] of this.activeProcesses) {
      child.kill(signal);
      this.activeProcesses.delete(processId);
    }
  }

  /**
   * 检查命令是否存在
   * @param {string} command - 命令名
   * @returns {Promise<boolean>}
   */
  async exists(command) {
    try {
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      await this.run(checkCmd, { args: [command], timeout: 5000, streaming: false });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取正在运行的进程列表
   * @returns {string[]}
   */
  getActiveProcesses() {
    return Array.from(this.activeProcesses.keys());
  }

  /**
   * 获取命令版本
   * @param {string} command - 命令名
   * @param {string} [versionFlag] - 版本标志，默认 --version
   * @returns {Promise<string>}
   */
  async getVersion(command, versionFlag = '--version') {
    try {
      const result = await this.run(command, {
        args: [versionFlag],
        timeout: 10000,
        streaming: false
      });
      return result.stdout.trim();
    } catch (error) {
      if (error.stdout) return error.stdout.trim();
      throw new Error(`无法获取 ${command} 版本: ${error.message}`);
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 解析命令
   * @private
   */
  #parseCommand(command, extraArgs) {
    let cmd, cmdArgs;

    // 如果命令包含空格，尝试解析
    const trimmed = command.trim();

    if (trimmed.includes(' ') && extraArgs.length === 0) {
      // 将整个字符串作为 shell 命令执行
      const platform = process.platform;
      if (platform === 'win32') {
        cmd = 'cmd';
        cmdArgs = ['/c', trimmed, ...extraArgs];
      } else {
        cmd = 'sh';
        cmdArgs = ['-c', trimmed, ...extraArgs];
      }
    } else {
      cmd = trimmed;
      cmdArgs = extraArgs;
    }

    return { cmd, cmdArgs };
  }

  /**
   * 检测默认 shell
   * @private
   */
  #detectDefaultShell() {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/sh';
  }

  /**
   * 判断是否需要使用 shell 执行
   * @private
   */
  #shouldUseShell(cmd) {
    // 对于跨平台命令，不使用 shell 以让 cross-spawn 处理
    if (cmd === 'sh' || cmd === 'cmd' || cmd === 'bash' || cmd === 'powershell' || cmd === 'pwsh') {
      return true;
    }
    return false;
  }
}

module.exports = { CommandRunner };
