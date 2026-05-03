/**
 * Agent Store - 内存数据存储
 * 管理 Agent Map、Message 数组和 FileTransfer Map
 */
class AgentStore {
  constructor() {
    // Agent 存储: Map<agentId, Agent>
    this.agents = new Map();

    // 消息存储: 数组，保留最近 1000 条
    this.messages = [];
    this.maxMessages = 1000;

    // 文件传输存储: Map<fileId, FileTransfer>
    this.fileTransfers = new Map();

    // 消息送达确认: Map<messageId, Set<agentId>>
    this.deliveryConfirms = new Map();

    // 统计数据
    this.stats = {
      totalConnections: 0,
      totalMessages: 0,
      totalFileTransfers: 0,
      startTime: Date.now()
    };
  }

  // ========== Agent 操作 ==========

  addAgent(agent) {
    this.agents.set(agent.id, agent);
    this.stats.totalConnections++;
  }

  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  removeAgent(agentId) {
    return this.agents.delete(agentId);
  }

  updateAgent(agentId, updates) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    for (const [key, value] of Object.entries(updates)) {
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        agent[key] = value;
      }
    }
    return true;
  }

  // ========== Message 操作 ==========

  addMessage(message) {
    this.messages.push(message);
    this.stats.totalMessages++;

    // 保留最近 1000 条，同步清理对应的送达确认记录
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.maxMessages);
      this.messages = this.messages.slice(-this.maxMessages);
      for (const msg of removed) {
        this.deliveryConfirms.delete(msg.id);
      }
    }

    return message;
  }

  getMessages(filter = {}) {
    let result = [...this.messages];

    if (filter.agentId) {
      result = result.filter(
        m => m.from === filter.agentId || m.to === filter.agentId || m.to === 'broadcast'
      );
    }

    if (filter.type) {
      result = result.filter(m => m.type === filter.type);
    }

    if (filter.limit) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  getMessageById(messageId) {
    return this.messages.find(m => m.id === messageId) || null;
  }

  // ========== 送达确认操作 ==========

  confirmDelivery(messageId, agentId) {
    if (!this.deliveryConfirms.has(messageId)) {
      this.deliveryConfirms.set(messageId, new Set());
    }
    this.deliveryConfirms.get(messageId).add(agentId);

    const message = this.getMessageById(messageId);
    if (message) {
      message.deliveredTo = [...(this.deliveryConfirms.get(messageId) || [])];
      message.deliveredAt = Date.now();
    }
  }

  getDeliveryConfirms(messageId) {
    return this.deliveryConfirms.get(messageId) || new Set();
  }

  // ========== FileTransfer 操作 ==========

  addFileTransfer(transfer) {
    this.fileTransfers.set(transfer.id, transfer);
    this.stats.totalFileTransfers++;
    return transfer;
  }

  getFileTransfer(fileId) {
    return this.fileTransfers.get(fileId) || null;
  }

  getAllFileTransfers() {
    return Array.from(this.fileTransfers.values());
  }

  updateFileTransfer(fileId, updates) {
    const transfer = this.fileTransfers.get(fileId);
    if (!transfer) return false;
    for (const [key, value] of Object.entries(updates)) {
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        transfer[key] = value;
      }
    }

    // 终端状态 1 小时后自动清理
    if (updates.status === 'completed' || updates.status === 'failed' || updates.status === 'rejected') {
      const now = Date.now();
      setTimeout(() => {
        const t = this.fileTransfers.get(fileId);
        if (t && (t.status === 'completed' || t.status === 'failed' || t.status === 'rejected')) {
          this.fileTransfers.delete(fileId);
        }
      }, 3600000);
    }

    return true;
  }

  cleanupStaleTransfers(maxAge = 3600000) {
    const now = Date.now();
    for (const [id, transfer] of this.fileTransfers.entries()) {
      if (
        (transfer.status === 'completed' || transfer.status === 'failed' || transfer.status === 'rejected') &&
        now - (transfer.completedAt || transfer.createdAt) > maxAge
      ) {
        this.fileTransfers.delete(id);
      }
    }
  }

  // ========== 统计信息 ==========

  getStats() {
    const onlineAgents = this.getAllAgents().filter(a => a.status === 'online').length;
    const busyAgents = this.getAllAgents().filter(a => a.status === 'busy').length;
    const errorAgents = this.getAllAgents().filter(a => a.status === 'error').length;

    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      agentCount: this.agents.size,
      onlineAgents,
      busyAgents,
      errorAgents,
      messageCount: this.messages.length,
      fileTransferCount: this.fileTransfers.size
    };
  }

  // ========== 清理操作 ==========

  clear() {
    this.agents.clear();
    this.messages = [];
    this.fileTransfers.clear();
    this.deliveryConfirms.clear();
    this.stats = {
      totalConnections: 0,
      totalMessages: 0,
      totalFileTransfers: 0,
      startTime: Date.now()
    };
  }
}

// 单例模式
const agentStore = new AgentStore();

module.exports = { AgentStore, agentStore };
