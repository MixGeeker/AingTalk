/**
 * Socket Handler - Socket.io 主处理器
 * 处理所有 Socket.io 连接事件，分发到各个子处理器
 */
const { AgentManager } = require('./agent-manager');
const { MessageRouter } = require('./message-router');
const { HeartbeatMonitor } = require('./heartbeat');
const { FileHandler } = require('./file-handler');
const { agentStore } = require('../services/agent-store');

class SocketHandler {
  constructor(io) {
    this.io = io;
    this.agentManager = new AgentManager(io);
    this.messageRouter = new MessageRouter(io);
    this.heartbeatMonitor = new HeartbeatMonitor(io, this.agentManager);
    this.fileHandler = new FileHandler(io);

    // 启动心跳监控
    this.heartbeatMonitor.startMonitoring();
  }

  /**
   * 初始化 Socket.io 连接处理
   */
  initialize() {
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    console.log('[SocketHandler] Socket.io initialized');
  }

  /**
   * 处理新连接
   * @param {Socket} socket
   */
  handleConnection(socket) {
    console.log(`[Socket] Client connected: ${socket.id} (${socket.handshake.address})`);

    // ========== Agent 生命周期事件 ==========

    // Agent 注册
    socket.on('agent:register', (agentInfo) => {
      console.log(`[Socket] Agent register from ${socket.id}:`, agentInfo.name);
      const result = this.agentManager.registerAgent(socket, agentInfo);
      if (!result.success) {
        socket.emit('agent:register:failed', { error: result.error });
      }
    });

    // Agent 主动断开
    socket.on('agent:disconnecting', (data) => {
      console.log(`[Socket] Agent disconnecting: ${data.agentId}, reason: ${data.reason}`);
      this.agentManager.unregisterAgent(data.agentId, data.reason);
      this.heartbeatMonitor.removeAgent(data.agentId);
    });

    // ========== 心跳事件 ==========

    socket.on('heartbeat', (heartbeat) => {
      this.heartbeatMonitor.handleHeartbeat(heartbeat.agentId, heartbeat);
    });

    // ========== 消息事件 ==========

    socket.on('message', (message) => {
      console.log(`[Socket] Message from ${message.from} to ${message.to}, type: ${message.type}`);
      this.messageRouter.routeMessage(message);
    });

    // 消息送达确认
    socket.on('message:confirm', (data) => {
      this.messageRouter.handleDeliveryConfirm(data.messageId, data.agentId);
    });

    // ========== 文件传输事件 ==========

    socket.on('file:request', (fileInfo) => {
      // 补充 from 字段
      const agent = this.agentManager.getAgentBySocketId(socket.id);
      if (agent) {
        fileInfo.from = agent.id;
      }
      this.fileHandler.handleFileRequest(socket, fileInfo);
    });

    socket.on('file:response', (response) => {
      this.fileHandler.handleFileResponse(socket, response);
    });

    socket.on('file:chunk', (chunk) => {
      this.fileHandler.handleFileChunk(socket, chunk);
    });

    // ========== Claude Code 事件 ==========

    socket.on('claude:output', (data) => {
      console.log(`[Socket] Claude output for task ${data.taskId}: ${data.type}`);
      // 转发 Claude Code 输出到前端
      this.io.emit('claude:output', data);
    });

    socket.on('claude:complete', (data) => {
      console.log(`[Socket] Claude complete for task ${data.taskId}, exitCode: ${data.exitCode}`);
      // 转发 Claude Code 完成事件到前端
      this.io.emit('claude:complete', data);
    });

    // ========== Agent 状态报告 ==========

    socket.on('agent:status-report', (report) => {
      const agent = agentStore.getAgent(report.agentId);
      if (agent) {
        // 更新 Agent 状态
        const updates = {
          lastHeartbeat: Date.now()
        };

        if (report.status) {
          updates.status = report.status === 'idle' ? 'online' : report.status;
        }

        if (report.currentTask) {
          updates.currentTask = report.currentTask;
        }

        agentStore.updateAgent(report.agentId, updates);

        // 广播状态更新
        this.io.emit('agent:update', agentStore.getAgent(report.agentId));
        this.io.emit('agent:list', this.agentManager.getAgents());
      }
    });

    // ========== 前端事件 ==========

    // 前端加入监控面板
    socket.on('join-dashboard', () => {
      console.log(`[Socket] Dashboard joined: ${socket.id}`);
      // 发送当前 Agent 列表
      socket.emit('agent:list', this.agentManager.getAgents());
      // 发送消息历史
      socket.emit('message:history', this.messageRouter.getMessages({ limit: 100 }));
      // 发送系统统计
      socket.emit('system:stats', agentStore.getStats());
    });

    // 前端发送消息
    socket.on('send-message', (message) => {
      console.log(`[Socket] Send message from frontend:`, message);
      // 补充消息 ID 和时间戳
      if (!message.id) {
        message.id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
      if (!message.timestamp) {
        message.timestamp = Date.now();
      }
      this.messageRouter.routeMessage(message);
    });

    // 前端请求 Agent 状态
    socket.on('request-status', (agentId) => {
      const agent = this.agentManager.getAgent(agentId);
      const health = this.heartbeatMonitor.getAgentHealth(agentId);
      socket.emit('agent:status-response', {
        agentId,
        agent,
        health
      });
    });

    // 前端分配角色
    socket.on('assign-role', (data) => {
      console.log(`[Socket] Assign role to ${data.agentId}: ${data.role}`);
      const result = this.agentManager.assignRole(
        data.agentId,
        data.role,
        data.description || ''
      );
      socket.emit('assign-role:result', {
        agentId: data.agentId,
        success: result,
        role: data.role
      });
    });

    // ========== 断开连接 ==========

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id}, reason: ${reason}`);
      this.agentManager.handleDisconnect(socket);
      this.heartbeatMonitor.removeAgent(
        this.agentManager.getAgentBySocketId(socket.id)?.id
      );
    });
  }
}

module.exports = { SocketHandler };
