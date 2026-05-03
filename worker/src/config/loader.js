/**
 * ConfigLoader - 配置加载器
 * 优先级：命令行参数 > 环境变量 > config.json > 默认值
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 默认配置
const DEFAULT_CONFIG = {
  serverUrl: 'http://localhost:3000',
  name: '',  // 默认使用 hostname
  workDir: process.cwd(),
  heartbeatInterval: 30000,
  autoReconnect: true,
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
  claudeCodePath: 'claude',
  maxFileSize: 104857600,  // 100MB
  allowedFileTypes: ['.zip', '.tar.gz', '.tgz', '.js', '.ts', '.py', '.json', '.md', '.txt', '.log', '.yaml', '.yml']
};

// 环境变量到配置键的映射
const ENV_MAPPING = {
  AGENT_SERVER_URL: 'serverUrl',
  AGENT_NAME: 'name',
  AGENT_WORK_DIR: 'workDir',
  AGENT_HEARTBEAT_INTERVAL: 'heartbeatInterval',
  AGENT_AUTO_RECONNECT: 'autoReconnect',
  AGENT_RECONNECT_INTERVAL: 'reconnectInterval',
  AGENT_MAX_RECONNECT_ATTEMPTS: 'maxReconnectAttempts',
  AGENT_CLAUDE_CODE_PATH: 'claudeCodePath',
  AGENT_MAX_FILE_SIZE: 'maxFileSize',
  AGENT_ALLOWED_FILE_TYPES: 'allowedFileTypes'
};

class ConfigLoader {
  constructor(options = {}) {
    this.configPath = options.configPath || this.#findConfigFile();
    this.cliArgs = options.cliArgs || {};
  }

  /**
   * 加载配置（按优先级合并）
   * @returns {Object} 合并后的配置
   */
  load() {
    // 1. 从默认值开始
    let config = { ...DEFAULT_CONFIG };

    // 2. 从配置文件加载（如果存在）
    const fileConfig = this.#loadFromFile();
    if (fileConfig) {
      config = { ...config, ...fileConfig };
    }

    // 3. 从环境变量加载
    const envConfig = this.#loadFromEnv();
    config = { ...config, ...envConfig };

    // 4. 从命令行参数加载（最高优先级）
    // 只传递有效的运行时配置键，过滤 CLI 机械键
    const runtimeCliArgs = {};
    const validConfigKeys = new Set(Object.keys(DEFAULT_CONFIG));
    for (const [key, value] of Object.entries(this.cliArgs)) {
      if (validConfigKeys.has(key)) {
        runtimeCliArgs[key] = value;
      }
    }
    config = { ...config, ...runtimeCliArgs };

    // 处理特殊值（NaN 守卫）
    config.name = config.name ?? os.hostname();
    if (!config.name) config.name = os.hostname();
    config.heartbeatInterval = parseInt(config.heartbeatInterval, 10);
    if (Number.isNaN(config.heartbeatInterval) || config.heartbeatInterval < 1000) config.heartbeatInterval = DEFAULT_CONFIG.heartbeatInterval;
    config.reconnectInterval = parseInt(config.reconnectInterval, 10);
    if (Number.isNaN(config.reconnectInterval) || config.reconnectInterval < 1000) config.reconnectInterval = DEFAULT_CONFIG.reconnectInterval;
    config.maxReconnectAttempts = parseInt(config.maxReconnectAttempts, 10);
    if (Number.isNaN(config.maxReconnectAttempts) || config.maxReconnectAttempts < 0) config.maxReconnectAttempts = DEFAULT_CONFIG.maxReconnectAttempts;
    config.maxFileSize = parseInt(config.maxFileSize, 10);
    if (Number.isNaN(config.maxFileSize) || config.maxFileSize <= 0) config.maxFileSize = DEFAULT_CONFIG.maxFileSize;
    config.autoReconnect = this.#parseBoolean(config.autoReconnect);

    // 处理 allowedFileTypes（支持字符串数组或逗号分隔字符串）
    if (typeof config.allowedFileTypes === 'string') {
      config.allowedFileTypes = config.allowedFileTypes.split(',').map(s => s.trim());
    }

    // 确保 workDir 是绝对路径
    if (!path.isAbsolute(config.workDir)) {
      config.workDir = path.resolve(process.cwd(), config.workDir);
    }

    // 统一路径分隔符
    config.workDir = path.normalize(config.workDir);

    return config;
  }

  /**
   * 保存配置到文件
   * @param {Object} config - 要保存的配置
   * @param {string} [filePath] - 可选自定义路径
   */
  save(config, filePath) {
    const targetPath = filePath || this.configPath;
    try {
      // 确保目录存在
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error(`[ConfigLoader] 保存配置失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 从配置文件加载
   * @private
   */
  #loadFromFile() {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[ConfigLoader] 读取配置文件失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 从环境变量加载
   * @private
   */
  #loadFromEnv() {
    const envConfig = {};
    for (const [envKey, configKey] of Object.entries(ENV_MAPPING)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        envConfig[configKey] = value;
      }
    }
    return envConfig;
  }

  /**
   * 查找配置文件
   * @private
   */
  #findConfigFile() {
    // 按优先级查找配置文件
    const candidates = [
      path.join(process.cwd(), 'config.json'),
      path.join(__dirname, '..', 'config.json'),
      path.join(os.homedir(), '.agent-collab', 'config.json')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return path.join(__dirname, '..', 'config.json');
  }

  /**
   * 解析布尔值
   * @private
   */
  #parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    return Boolean(value);
  }
}

module.exports = { ConfigLoader, DEFAULT_CONFIG };
