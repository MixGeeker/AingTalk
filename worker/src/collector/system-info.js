/**
 * SystemInfoCollector - 系统信息收集器
 * 收集平台信息、硬件信息、动态指标、Claude Code 信息等
 * 支持 Windows / MacOS / Linux
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const commandExists = require('command-exists');

// 可选依赖：os-utils 和 node-disk-info
let osUtils = null;
let nodeDiskInfo = null;

try { osUtils = require('os-utils'); } catch (e) { /* optional */ }
try { nodeDiskInfo = require('node-disk-info'); } catch (e) { /* optional */ }

class SystemInfoCollector {
  constructor(options = {}) {
    this.claudeCodePath = options.claudeCodePath || 'claude';
  }

  /**
   * 收集完整的静态系统信息
   * @returns {Object} 系统信息对象
   */
  async collect() {
    const platform = os.platform();
    const arch = os.arch();

    return {
      hostname: os.hostname(),
      platform,
      platformName: this.#getPlatformName(platform),
      arch,
      nodeVersion: process.version,
      cpu: this.#getCpuInfo(),
      memory: this.#getMemoryInfo(),
      os: {
        type: os.type(),
        release: os.release(),
        uptime: os.uptime()
      },
      network: this.#getNetworkInfo(),
      workDir: process.cwd(),
      capabilities: await this.getCapabilities(),
      claudeCode: await this.getClaudeCodeInfo()
    };
  }

  /**
   * 收集动态指标（CPU使用率、内存使用、磁盘使用）
   * @returns {Promise<Object>} 动态指标
   */
  async collectMetrics() {
    const cpuUsage = await this.#getCpuUsageAsync();
    const memoryUsage = this.#getMemoryUsage();
    const diskUsage = await this.#getDiskUsage();
    const uptime = process.uptime();

    return {
      timestamp: Date.now(),
      cpuUsage: Math.round(cpuUsage * 100) / 100,
      memoryUsage: Math.round(memoryUsage.used / 1024 / 1024 * 100) / 100, // MB
      memoryPercent: Math.round(memoryUsage.percent * 100) / 100,
      diskUsage: diskUsage.percent,
      diskFree: diskUsage.free,
      diskTotal: diskUsage.total,
      uptime: Math.floor(uptime)
    };
  }

  /**
   * 获取工作目录文件列表和大小
   * @param {string} workDir - 工作目录路径
   * @returns {Object} 目录信息
   */
  getWorkDirInfo(workDir) {
    const targetDir = workDir || process.cwd();
    try {
      const items = fs.readdirSync(targetDir, { withFileTypes: true });
      const files = [];
      const directories = [];
      let totalSize = 0;

      for (const item of items) {
        const itemPath = path.join(targetDir, item.name);
        try {
          if (item.isDirectory()) {
            directories.push({
              name: item.name,
              path: itemPath
            });
          } else if (item.isFile()) {
            const stats = fs.statSync(itemPath);
            const size = stats.size;
            totalSize += size;
            files.push({
              name: item.name,
              path: itemPath,
              size,
              sizeFormatted: this.#formatBytes(size),
              modifiedAt: stats.mtime.toISOString()
            });
          }
        } catch (err) {
          // 跳过无法访问的文件
        }
      }

      return {
        path: targetDir,
        fileCount: files.length,
        dirCount: directories.length,
        totalSize,
        totalSizeFormatted: this.#formatBytes(totalSize),
        files: files.slice(0, 100), // 限制返回数量
        directories: directories.slice(0, 50)
      };
    } catch (error) {
      return {
        path: targetDir,
        error: error.message,
        fileCount: 0,
        dirCount: 0,
        totalSize: 0,
        files: [],
        directories: []
      };
    }
  }

  /**
   * 获取 Claude Code 安装信息
   * @returns {Promise<Object>} Claude Code 信息
   */
  async getClaudeCodeInfo() {
    const info = {
      available: false,
      version: '',
      path: '',
      error: null
    };

    try {
      // 检查 claude 命令是否存在
      const claudePath = await this.#resolveCommand(this.claudeCodePath);
      if (!claudePath) {
        info.error = 'Claude Code 命令未找到';
        return info;
      }

      info.available = true;
      info.path = claudePath;

      // 获取版本
      try {
        const versionOutput = execSync(`"${claudePath}" --version`, {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true
        }).trim();
        info.version = versionOutput;
      } catch (versionErr) {
        // 某些版本可能不支持 --version
        info.version = 'unknown';
      }
    } catch (error) {
      info.error = error.message;
    }

    return info;
  }

  /**
   * 获取本机能力列表
   * 检测 git, node, docker, python 等工具
   * @returns {Promise<string[]>} 能力列表
   */
  async getCapabilities() {
    const capabilities = [];
    const tools = [
      { name: 'claude-code', cmd: this.claudeCodePath },
      { name: 'node', cmd: 'node' },
      { name: 'git', cmd: 'git' },
      { name: 'docker', cmd: 'docker' },
      { name: 'python', cmd: 'python' },
      { name: 'python3', cmd: 'python3' },
      { name: 'npm', cmd: 'npm' },
      { name: 'yarn', cmd: 'yarn' },
      { name: 'pnpm', cmd: 'pnpm' },
      { name: 'java', cmd: 'java' },
      { name: 'go', cmd: 'go' },
      { name: 'rustc', cmd: 'rustc' }
    ];

    for (const tool of tools) {
      try {
        await commandExists(tool.cmd);
        capabilities.push(tool.name);
      } catch (e) {
        // 命令不存在，跳过
      }
    }

    // 平台特定能力
    const platform = os.platform();
    if (platform === 'darwin') {
      capabilities.push('macos');
    } else if (platform === 'win32') {
      capabilities.push('windows');
    } else if (platform === 'linux') {
      capabilities.push('linux');
    }

    // 架构能力
    const arch = os.arch();
    if (arch === 'arm64' || arch === 'aarch64') {
      capabilities.push('arm64');
    } else if (arch === 'x64') {
      capabilities.push('x64');
    }

    return [...new Set(capabilities)];
  }

  // ==================== 私有方法 ====================

  /**
   * 获取 CPU 信息
   * @private
   */
  #getCpuInfo() {
    const cpus = os.cpus();
    return {
      model: cpus.length > 0 ? cpus[0].model : 'Unknown',
      cores: cpus.length,
      physicalCores: this.#getPhysicalCores(),
      speed: cpus.length > 0 ? cpus[0].speed : 0
    };
  }

  /**
   * 获取物理核心数
   * @private
   */
  #getPhysicalCores() {
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        return parseInt(execSync('sysctl -n hw.physicalcpu', {
          encoding: 'utf8',
          timeout: 5000
        }).trim(), 10);
      } else if (platform === 'linux') {
        const output = execSync('lscpu -p | grep -v "#" | sort -u -t, -k 2,2 | wc -l', {
          encoding: 'utf8',
          timeout: 5000,
          shell: true
        }).trim();
        return parseInt(output, 10) || os.cpus().length;
      } else if (platform === 'win32') {
        const output = execSync('wmic cpu get NumberOfCores /value', {
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        const match = output.match(/NumberOfCores=(\d+)/);
        return match ? parseInt(match[1], 10) : os.cpus().length;
      }
    } catch (e) {
      // 回退到逻辑核心数
    }
    return os.cpus().length;
  }

  /**
   * 获取内存信息
   * @private
   */
  #getMemoryInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      total,
      free,
      used: total - free,
      totalFormatted: this.#formatBytes(total),
      freeFormatted: this.#formatBytes(free),
      usedFormatted: this.#formatBytes(total - free)
    };
  }

  /**
   * 获取内存使用（百分比）
   * @private
   */
  #getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      total,
      used,
      free,
      percent: (used / total) * 100
    };
  }

  /**
   * 异步获取 CPU 使用率
   * @private
   */
  #getCpuUsageAsync() {
    return new Promise((resolve) => {
      if (osUtils && typeof osUtils.cpuUsage === 'function') {
        osUtils.cpuUsage((value) => {
          resolve(value * 100); // 转为百分比
        });
      } else {
        // 回退：使用 Node.js 内置方法估算
        const startUsage = process.cpuUsage();
        setTimeout(() => {
          const endUsage = process.cpuUsage(startUsage);
          const totalUsage = (endUsage.user + endUsage.system) / 1000000; // 转为秒
          const percent = (totalUsage / 0.1) * 100; // 0.1秒采样
          resolve(Math.min(percent, 100));
        }, 100);
      }
    });
  }

  /**
   * 获取磁盘使用率
   * @private
   */
  async #getDiskUsage() {
    try {
      if (nodeDiskInfo) {
        const disks = await nodeDiskInfo.getDiskInfo();
        // 找到系统盘
        const platform = os.platform();
        let systemDisk;

        if (platform === 'win32') {
          systemDisk = disks.find(d => d.mounted === 'C:') || disks[0];
        } else {
          systemDisk = disks.find(d => d.mounted === '/') || disks[0];
        }

        if (systemDisk) {
          const used = systemDisk.blocks - systemDisk.available;
          const percent = (used / systemDisk.blocks) * 100;
          return {
            total: systemDisk.blocks,
            free: systemDisk.available,
            used,
            percent: Math.round(percent * 100) / 100
          };
        }
      }
    } catch (e) {
      // 回退到手动计算
    }

    // 回退方案：使用 workDir 所在路径的磁盘信息
    try {
      const stats = fs.statSync(process.cwd());
      // 使用 df/ dir 命令获取（跨平台）
      return await this.#getDiskUsageFallback();
    } catch (e) {
      return { total: 0, free: 0, used: 0, percent: 0 };
    }
  }

  /**
   * 磁盘使用率回退方案
   * @private
   */
  async #getDiskUsageFallback() {
    const platform = os.platform();
    try {
      if (platform === 'win32') {
        const output = execSync('wmic logicaldisk get Size,FreeSpace,DeviceID /value', {
          encoding: 'utf8',
          timeout: 5000
        });
        const lines = output.split('\n');
        let deviceId = '', size = 0, freeSpace = 0;
        for (const line of lines) {
          if (line.startsWith('DeviceID=')) deviceId = line.split('=')[1]?.trim();
          if (line.startsWith('Size=')) size = parseInt(line.split('=')[1]?.trim(), 10) || 0;
          if (line.startsWith('FreeSpace=')) freeSpace = parseInt(line.split('=')[1]?.trim(), 10) || 0;
          if (deviceId && size && freeSpace) {
            const used = size - freeSpace;
            return {
              total: size,
              free: freeSpace,
              used,
              percent: (used / size) * 100
            };
          }
        }
      } else {
        const output = execSync('df -k "$(pwd)" | tail -1', {
          encoding: 'utf8',
          timeout: 5000,
          shell: true
        }).trim();
        const parts = output.split(/\s+/);
        if (parts.length >= 4) {
          const total = parseInt(parts[1], 10) * 1024;
          const used = parseInt(parts[2], 10) * 1024;
          const free = parseInt(parts[3], 10) * 1024;
          return {
            total,
            free,
            used,
            percent: (used / total) * 100
          };
        }
      }
    } catch (e) {
      // 最终回退
    }
    return { total: 0, free: 0, used: 0, percent: 0 };
  }

  /**
   * 获取网络信息
   * @private
   */
  #getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      // 跳过虚拟和内部接口
      if (name.startsWith('lo') || name.startsWith('docker') ||
          name.startsWith('veth') || name.startsWith('br-')) {
        continue;
      }
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push({
            interface: name,
            address: addr.address,
            mac: addr.mac
          });
        }
      }
    }

    return {
      primaryIp: addresses.length > 0 ? addresses[0].address : '127.0.0.1',
      interfaces: addresses
    };
  }

  /**
   * 获取平台友好名称
   * @private
   */
  #getPlatformName(platform) {
    const names = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
      freebsd: 'FreeBSD',
      openbsd: 'OpenBSD'
    };
    return names[platform] || platform;
  }

  /**
   * 解析命令路径
   * @private
   */
  async #resolveCommand(cmd) {
    try {
      return await commandExists(cmd);
    } catch (e) {
      return null;
    }
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

module.exports = { SystemInfoCollector };
