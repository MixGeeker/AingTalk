/**
 * HeartbeatMonitor - 心跳检测
 * 处理 Agent 心跳、超时检测和健康状态监控
 */
const { agentStore } = require('../services/agent-store');

const DEFAULT_CONFIG = {
  interval: 30000,        // Worker 发送心跳间隔
  checkInterval: 15000,   // Server 检查间隔
  timeoutThreshold: 90000,// 超时阈值 (90秒)
  maxMissedBeats: 3       // 最大允许丢失心跳数
};

class HeartbeatMonitor {
  constructor(io, agentManager, config = {}) {
    this.io = io;
    this.agentManager = agentManager;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 心跳记录: Map<agentId, { lastHeartbeat, latency, missedBeats }>
    this.heartbeatRecords = new Map();

    // 检查定时器
    this.checkTimer = null;
    this.isRunning = false;
  }

  /**
   * 启动监控
   */
  startMonitoring() {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log(`[Heartbeat] Monitoring started (checkInterval: ${this.config.checkInterval}ms, timeout: ${this.config.timeoutThreshold}ms)`);

    this.checkTimer = setInterval(() => {
      this.checkTimeoutAgents();
    }, this.config.checkInterval);
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.isRunning = false;
    console.log('[Heartbeat] Monitoring stopped');
  }

  /**
   * 处理心跳
   * @param {string} agentId
   * @param {Object} heartbeat - 心跳数据
   */
  handleHeartbeat(agentId, heartbeat) {
    const agent = agentStore.getAgent(agentId);
    if (!agent) {
      console.warn(`[Heartbeat] Heartbeat from unknown agent: ${agentId}`);
      return;
    }

    const now = Date.now();
    const latency = now - (heartbeat.timestamp || now);

    // 更新心跳记录
    this.heartbeatRecords.set(agentId, {
      lastHeartbeat: now,
      latency,
      missedBeats: 0,
      status: heartbeat.status || 'idle',
      currentTask: heartbeat.currentTask || '',
      cpuUsage: heartbeat.cpuUsage || 0,
      memoryUsage: heartbeat.memoryUsage || 0,
      diskUsage: heartbeat.diskUsage || 0,
      uptime: heartbeat.uptime || 0
    });

    // 更新 Agent 状态
    const updates = {
      lastHeartbeat: now,
      heartbeatLatency: latency
    };

    // 如果 Agent 报告了状态，同步更新
    if (heartbeat.status && ['idle', 'busy', 'error'].includes(heartbeat.status)) {
      updates.status = heartbeat.status === 'idle' ? 'online' : heartbeat.status;
    }

    if (heartbeat.currentTask) {
      updates.currentTask = {
        description: heartbeat.currentTask,
        startedAt: now
      };
    }

    agentStore.updateAgent(agentId, updates);

    // 发送心跳确认
    const agentSocket = this.io.sockets.sockets.get(agent.socketId);
    if (agentSocket) {
      agentSocket.emit('heartbeat:ack', { serverTime: now });
    }

    // 向前端广播心跳更新
    this.io.emit('heartbeat:update', {
      agentId,
      latency,
      status: heartbeat.status || 'idle',
      cpuUsage: heartbeat.cpuUsage || 0,
      memoryUsage: heartbeat.memoryUsage || 0,
      timestamp: now
    });
  }

  /**
   * 检查超时 Agent
   * @returns {string[]} 超时 Agent ID 列表
   */
  checkTimeoutAgents() {
    const now = Date.now();
    const timedOutAgents = [];

    for (const [agentId, record] of this.heartbeatRecords.entries()) {
      const elapsed = now - record.lastHeartbeat;

      if (elapsed > this.config.timeoutThreshold) {
        record.missedBeats++;

        if (record.missedBeats >= this.config.maxMissedBeats) {
          console.warn(`[Heartbeat] Agent timed out: ${agentId} (last heartbeat: ${elapsed}ms ago)`);
          timedOutAgents.push(agentId);

          // 标记 Agent 为离线
          this.agentManager.updateAgentStatus(agentId, 'offline');

          // 移除心跳记录
          this.heartbeatRecords.delete(agentId);

          // 广播超时通知
          this.io.emit('agent:status-update', {
            agentId,
            status: 'offline',
            reason: 'heartbeat_timeout',
            timestamp: now
          });
        }
      }
    }

    // 同时检查 agents 存储中还没有心跳记录的 Agent
    //（新注册但从未发送过心跳的 Agent 不需要检查）

    return timedOutAgents;
  }

  /**
   * 设置超时阈值
   * @param {number} ms - 毫秒
   */
  setTimeoutThreshold(ms) {
    if (typeof ms !== 'number' || ms < 1000) {
      throw new Error('Timeout threshold must be at least 1000ms');
    }
    this.config.timeoutThreshold = ms;
    console.log(`[Heartbeat] Timeout threshold updated: ${ms}ms`);
  }

  /**
   * 获取 Agent 健康状态
   * @param {string} agentId
   * @returns {Object | null} { lastHeartbeat, latency, status }
   */
  getAgentHealth(agentId) {
    const record = this.heartbeatRecords.get(agentId);
    if (!record) {
      const agent = agentStore.getAgent(agentId);
      if (!agent) return null;

      return {
        lastHeartbeat: agent.lastHeartbeat || 0,
        latency: agent.heartbeatLatency || 0,
        status: agent.status,
        missedBeats: 0,
        healthy: false
      };
    }

    const now = Date.now();
    const elapsed = now - record.lastHeartbeat;

    return {
      lastHeartbeat: record.lastHeartbeat,
      latency: record.latency,
      status: record.status,
      missedBeats: record.missedBeats,
      healthy: elapsed < this.config.timeoutThreshold,
      cpuUsage: record.cpuUsage,
      memoryUsage: record.memoryUsage,
      diskUsage: record.diskUsage,
      uptime: record.uptime
    };
  }

  /**
   * 获取所有 Agent 健康状态
   * @returns {Object[]}
   */
  getAllHealth() {
    const results = [];
    for (const agentId of this.heartbeatRecords.keys()) {
      const health = this.getAgentHealth(agentId);
      if (health) {
        results.push({ agentId, ...health });
      }
    }
    return results;
  }

  /**
   * 移除 Agent 的心跳记录
   * @param {string} agentId
   */
  removeAgent(agentId) {
    this.heartbeatRecords.delete(agentId);
  }
}

module.exports = { HeartbeatMonitor, DEFAULT_CONFIG };
