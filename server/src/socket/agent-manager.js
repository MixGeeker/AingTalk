/**
 * AgentManager - Agent 注册与管理
 * 处理 Agent 的注册、注销、状态更新和角色分配
 */
const { agentStore } = require('../services/agent-store');

class AgentManager {
  constructor(io) {
    this.io = io;
  }

  /**
   * 注册 Agent
   * @param {Socket} socket - Socket.io socket 实例
   * @param {Object} agentInfo - Agent 注册信息
   * @returns {Object} { agentId, success, error? }
   */
  registerAgent(socket, agentInfo) {
    try {
      // 验证必要字段
      if (!agentInfo.id || !agentInfo.name) {
        return { agentId: null, success: false, error: 'Missing required fields: id, name' };
      }

      // 检查是否已存在同 ID 的 Agent
      const existingAgent = agentStore.getAgent(agentInfo.id);
      if (existingAgent) {
        // 更新：先展开 agentInfo，再覆盖服务端必须控制的字段
        agentStore.updateAgent(agentInfo.id, {
          ...agentInfo,
          socketId: socket.id,
          status: 'online',
          lastHeartbeat: Date.now()
        });
      } else {
        // 创建新 Agent
        const agent = {
          id: agentInfo.id,
          socketId: socket.id,
          name: agentInfo.name,
          role: agentInfo.role || '',
          roleDescription: '',
          hostname: agentInfo.hostname || 'unknown',
          platform: agentInfo.platform || 'unknown',
          arch: agentInfo.arch || 'unknown',
          workDir: agentInfo.workDir || '',
          capabilities: agentInfo.capabilities || [],
          claudeVersion: agentInfo.claudeVersion || '',
          ip: agentInfo.ip || socket.handshake.address || '',
          status: 'online',
          currentTask: null,
          lastHeartbeat: Date.now(),
          heartbeatLatency: 0,
          connectedAt: Date.now(),
          startedAt: (() => {
            const ts = agentInfo.startedAt ? new Date(agentInfo.startedAt).getTime() : 0;
            return Number.isNaN(ts) ? Date.now() : ts;
          })()
        };

        agentStore.addAgent(agent);
      }

      const agent = agentStore.getAgent(agentInfo.id);

      // 通知 Agent 注册成功
      socket.emit('agent:registered', {
        agentId: agentInfo.id,
        serverTime: Date.now()
      });

      // 广播新 Agent 上线
      this.io.emit('agent:connected', {
        agentId: agentInfo.id,
        name: agentInfo.name,
        role: agentInfo.role || '',
        platform: agentInfo.platform || 'unknown',
        status: 'online'
      });

      // 向前端广播 Agent 列表更新
      this.io.emit('agent:list', this.getAgents());

      return { agentId: agentInfo.id, success: true };
    } catch (error) {
      console.error('[AgentManager] Register error:', error);
      return { agentId: null, success: false, error: error.message };
    }
  }

  /**
   * 获取所有 Agent
   * @returns {Agent[]}
   */
  getAgents() {
    return agentStore.getAllAgents().map(a => this.sanitizeAgent(a));
  }

  sanitizeAgent(agent) {
    const { socketId, ip, ...safe } = agent;
    return safe;
  }

  /**
   * 获取单个 Agent
   * @param {string} agentId
   * @returns {Agent | null}
   */
  getAgent(agentId) {
    return agentStore.getAgent(agentId);
  }

  /**
   * 更新 Agent 信息
   * @param {string} agentId
   * @param {Object} updates
   * @returns {boolean}
   */
  updateAgent(agentId, updates) {
    const result = agentStore.updateAgent(agentId, updates);
    if (result) {
      const agent = agentStore.getAgent(agentId);
      this.io.emit('agent:update', agent);
      this.io.emit('agent:list', this.getAgents());
    }
    return result;
  }

  /**
   * 更新 Agent 状态
   * @param {string} agentId
   * @param {string} status - online / offline / busy / error
   * @returns {boolean}
   */
  updateAgentStatus(agentId, status) {
    const validStatuses = ['online', 'offline', 'busy', 'error'];
    if (!validStatuses.includes(status)) {
      console.warn(`[AgentManager] Invalid status: ${status}`);
      return false;
    }

    const result = agentStore.updateAgent(agentId, { status });
    if (result) {
      const agent = agentStore.getAgent(agentId);
      // 广播状态更新
      this.io.emit('agent:status-update', {
        agentId,
        status,
        timestamp: Date.now()
      });
      this.io.emit('agent:update', agent);
      this.io.emit('agent:list', this.getAgents());
    }
    return result;
  }

  /**
   * 分配角色
   * @param {string} agentId
   * @param {string} roleName
   * @param {string} roleDescription
   * @returns {boolean}
   */
  assignRole(agentId, roleName, roleDescription) {
    const result = agentStore.updateAgent(agentId, {
      role: roleName,
      roleDescription: roleDescription || ''
    });

    if (result) {
      const agent = agentStore.getAgent(agentId);
      this.io.emit('agent:update', agent);
      this.io.emit('agent:list', this.getAgents());
    }
    return result;
  }

  /**
   * 注销 Agent
   * @param {string} agentId
   * @param {string} reason
   * @returns {boolean}
   */
  unregisterAgent(agentId, reason = '') {
    const agent = agentStore.getAgent(agentId);
    if (!agent) return false;

    const agentName = agent.name;

    // 从存储中移除
    agentStore.removeAgent(agentId);

    // 广播 Agent 离线
    this.io.emit('agent:disconnected', {
      agentId,
      name: agentName,
      reason,
      timestamp: Date.now()
    });

    // 更新前端列表
    this.io.emit('agent:list', this.getAgents());

    return true;
  }

  /**
   * 检查 Agent 是否在线
   * @param {string} agentId
   * @returns {boolean}
   */
  isAgentOnline(agentId) {
    const agent = agentStore.getAgent(agentId);
    return agent !== null && agent.status !== 'offline';
  }

  /**
   * 通过 socket ID 获取 Agent
   * @param {string} socketId
   * @returns {Agent | null}
   */
  getAgentBySocketId(socketId) {
    return agentStore.getAllAgents().find(a => a.socketId === socketId) || null;
  }

  /**
   * 处理 Agent 断开连接
   * @param {Socket} socket
   */
  handleDisconnect(socket) {
    const agent = this.getAgentBySocketId(socket.id);
    if (agent) {
      console.log(`[AgentManager] Agent disconnected: ${agent.name} (${agent.id})`);
      this.unregisterAgent(agent.id, 'connection lost');
    }
  }
}

module.exports = { AgentManager };
