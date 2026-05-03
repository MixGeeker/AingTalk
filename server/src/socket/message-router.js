/**
 * MessageRouter - 消息路由与分发
 * 处理消息的定向发送、广播、BTW 旁路消息和送达确认
 */
const { agentStore } = require('../services/agent-store');

class MessageRouter {
  constructor(io) {
    this.io = io;
  }

  /**
   * 路由消息
   * @param {Object} message - 消息对象
   * @returns {Object} { success, deliveredTo[] }
   */
  routeMessage(message) {
    try {
      // 验证消息格式
      if (!message.id || !message.from || !message.type) {
        console.warn('[MessageRouter] Invalid message format:', message);
        return { success: false, deliveredTo: [], error: 'Invalid message format' };
      }

      // 补充消息字段
      const enrichedMessage = {
        ...message,
        fromName: this.getAgentName(message.from),
        delivered: false,
        deliveredAt: null,
        read: false,
        timestamp: message.timestamp || Date.now()
      };

      // 存储消息
      agentStore.addMessage(enrichedMessage);

      let deliveredTo = [];

      // 根据消息类型和 to 字段路由
      if (message.to === 'broadcast') {
        // 广播消息
        this.broadcast(enrichedMessage);
        deliveredTo = agentStore.getAllAgents()
          .filter(a => a.id !== message.from)
          .map(a => a.id);
      } else if (message.type === 'btw' || (message.metadata && message.metadata.isBtw)) {
        // BTW 旁路消息
        const success = this.sendBtwMessage(enrichedMessage);
        if (success) deliveredTo = [message.to];
      } else {
        // 定向消息
        const success = this.sendTo(message.to, enrichedMessage);
        if (success) deliveredTo = [message.to];
      }

      // 给自己发送送达确认
      this.confirmDeliveryToSender(message.from, enrichedMessage.id, message.to);

      // 向前端广播新消息
      this.io.emit('message:new', enrichedMessage);

      return { success: true, deliveredTo };
    } catch (error) {
      console.error('[MessageRouter] Route error:', error);
      return { success: false, deliveredTo: [], error: error.message };
    }
  }

  /**
   * 广播消息
   * @param {Object} message - 消息对象
   * @param {string} excludeAgentId - 排除的 Agent ID
   */
  broadcast(message, excludeAgentId = null) {
    const excludeId = excludeAgentId || message.from;

    // Socket.io 广播给所有连接
    this.io.emit('message:new', message);

    // 给每个在线 Agent 发送
    const agents = agentStore.getAllAgents();
    for (const agent of agents) {
      if (agent.id !== excludeId && agent.status !== 'offline') {
        this.deliverToSocket(agent.socketId, message);
      }
    }
  }

  /**
   * 定向发送消息
   * @param {string} agentId - 目标 Agent ID
   * @param {Object} message - 消息对象
   * @returns {boolean}
   */
  sendTo(agentId, message) {
    const agent = agentStore.getAgent(agentId);
    if (!agent) {
      console.warn(`[MessageRouter] Agent not found: ${agentId}`);
      return false;
    }

    if (agent.status === 'offline') {
      console.warn(`[MessageRouter] Agent offline: ${agentId}`);
      // 消息已存储，Agent 上线后可获取历史
      return false;
    }

    return this.deliverToSocket(agent.socketId, message);
  }

  /**
   * 发送 BTW 旁路消息
   * @param {Object} message - 消息对象
   * @returns {boolean}
   */
  sendBtwMessage(message) {
    const agent = agentStore.getAgent(message.to);
    if (!agent) {
      console.warn(`[MessageRouter] BTW target not found: ${message.to}`);
      return false;
    }

    // BTW 消息发送到目标 Agent
    if (agent.socketId) {
      this.io.to(agent.socketId).emit('message:new', {
        ...message,
        type: 'btw',
        metadata: { ...message.metadata, isBtw: true }
      });
    }

    return true;
  }

  /**
   * 处理消息送达确认
   * @param {string} messageId
   * @param {string} agentId
   */
  handleDeliveryConfirm(messageId, agentId) {
    agentStore.confirmDelivery(messageId, agentId);

    // 通知发送方消息已送达
    const message = agentStore.getMessageById(messageId);
    if (message) {
      const senderAgent = agentStore.getAgent(message.from);
      if (senderAgent && senderAgent.socketId) {
        this.io.to(senderAgent.socketId).emit('message:delivered', {
          messageId,
          to: agentId,
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * 给发送方确认消息已接收
   * @param {string} fromAgentId
   * @param {string} messageId
   * @param {string} toAgentId
   */
  confirmDeliveryToSender(fromAgentId, messageId, toAgentId) {
    const agent = agentStore.getAgent(fromAgentId);
    if (agent && agent.socketId) {
      this.io.to(agent.socketId).emit('message:delivered', {
        messageId,
        to: toAgentId,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 通过 socket ID 发送消息
   * @param {string} socketId
   * @param {Object} message
   * @returns {boolean}
   */
  deliverToSocket(socketId, message) {
    if (!socketId) return false;

    try {
      this.io.to(socketId).emit('message:new', message);
      return true;
    } catch (error) {
      console.error('[MessageRouter] Deliver to socket error:', error);
      return false;
    }
  }

  /**
   * 获取 Agent 名称
   * @param {string} agentId
   * @returns {string}
   */
  getAgentName(agentId) {
    const agent = agentStore.getAgent(agentId);
    return agent ? agent.name : agentId;
  }

  /**
   * 获取消息历史
   * @param {Object} filter
   * @returns {Message[]}
   */
  getMessages(filter = {}) {
    return agentStore.getMessages(filter);
  }
}

module.exports = { MessageRouter };
