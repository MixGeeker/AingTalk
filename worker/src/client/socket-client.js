/**
 * SocketClient - Socket.io 客户端连接管理
 * 负责连接 Server、发送/接收消息、自动重连
 */

const { io } = require('socket.io-client');
const { v4: uuidv4 } = require('uuid');

class SocketClient {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'http://localhost:3000';
    this.agentId = options.agentId || uuidv4();
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectInterval = options.reconnectInterval || 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;

    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;

    // 回调函数
    this.messageCallback = null;
    this.claudeExecuteCallback = null;
    this.fileRequestCallback = null;
    this.fileChunkCallback = null;
    this.fileCompleteCallback = null;
    this.roleAssignCallback = null;
    this.taskAssignCallback = null;
    this.statusQueryCallback = null;
    this.connectedCallback = null;
    this.disconnectedCallback = null;
    this.registeredCallback = null;
    this.heartbeatAckCallback = null;
    this.claudeCancelCallback = null;

    // 用于流式输出控制
    this.activeClaudeTask = null;

    // 文件传输发送方回调
    this.fileRequestAckCallback = null;
    this.fileReadyCallback = null;
    this.fileChunkAckCallback = null;
    this.fileRejectedCallback = null;
    this.fileErrorCallback = null;

    // Agent 列表缓存和待处理请求
    this._agentCache = null;
    this._pendingRequests = new Map();
    this.agentListCallback = null;
  }

  /**
   * 连接 Server
   * @param {string} [serverUrl] - 可选的服务器地址
   * @returns {Promise<boolean>}
   */
  connect(serverUrl) {
    const url = serverUrl || this.serverUrl;

    return new Promise((resolve, reject) => {
      // 清理旧连接
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }

      this.connected = false;

      try {
        this.socket = io(url, {
          transports: ['websocket', 'polling'],
          timeout: 10000,
          reconnection: false, // 我们手动处理重连
          query: {
            agentId: this.agentId,
            type: 'worker'
          }
        });

        this.#setupEventHandlers(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 设置事件处理器
   * @private
   */
  #setupEventHandlers(connectResolve, connectReject) {
    let connectResolved = false;

    let connTimeout = null;

    // 连接超时保护
    connTimeout = setTimeout(() => {
      if (!connectResolved) {
        connectResolved = true;
        connectReject(new Error('Connection timeout (30s)'));
      }
    }, 30000);

    // 连接成功
    this.socket.on('connect', () => {
      clearTimeout(connTimeout);
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log(`[SocketClient] 已连接到 Server: ${this.serverUrl}`);

      if (!connectResolved) {
        connectResolved = true;
        connectResolve(true);
      }

      if (this.connectedCallback) {
        this.connectedCallback();
      }
    });

    // 连接错误
    this.socket.on('connect_error', (error) => {
      console.error(`[SocketClient] 连接错误: ${error.message}`);

      if (!connectResolved) {
        connectResolved = true;
        connectReject(error);
      }

      if (this.autoReconnect) {
        this.#scheduleReconnect();
      }
    });

    // 断开连接
    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.registered = false;
      console.log(`[SocketClient] 与 Server 断开连接: ${reason}`);

      if (this.disconnectedCallback) {
        this.disconnectedCallback(reason);
      }

      if (this.autoReconnect && reason !== 'io client disconnect') {
        this.#scheduleReconnect();
      }
    });

    // 注册确认
    this.socket.on('agent:registered', (data) => {
      this.registered = true;
      console.log(`[SocketClient] Agent 注册成功: ${data.agentId}`);

      if (this.registeredCallback) {
        this.registeredCallback(data);
      }
    });

    // 心跳确认
    this.socket.on('heartbeat:ack', (data) => {
      if (this.heartbeatAckCallback) {
        this.heartbeatAckCallback(data);
      }
    });

    // 消息事件
    this.socket.on('message', (message) => {
      console.log(`[SocketClient] 收到消息 [${message.type}]: ${message.content?.substring(0, 100)}`);

      if (this.messageCallback) {
        this.messageCallback(message);
      }

      this.#handleTypedMessage(message);
    });

    this.socket.on('message:new', (data) => {
      if (data?.message) {
        console.log(`[SocketClient] 新消息通知 [${data.message.type}]: ${data.message.content?.substring(0, 100)}`);

        if (this.messageCallback) {
          this.messageCallback(data.message);
        }

        this.#handleTypedMessage(data.message);
      }
    });

    // Claude Code 执行指令
    this.socket.on('claude:execute', (data) => {
      console.log(`[SocketClient] 收到 Claude Code 执行指令: ${data.taskId}`);
      this.activeClaudeTask = data.taskId;

      if (this.claudeExecuteCallback) {
        this.claudeExecuteCallback(data);
      }
    });

    // Claude Code 取消指令
    this.socket.on('claude:cancel', (data) => {
      console.log(`[SocketClient] 收到 Claude Code 取消指令: ${data.taskId}`);

      if (this.claudeCancelCallback) {
        this.claudeCancelCallback(data.taskId);
      }
    });

    // 文件传输请求
    this.socket.on('file:incoming', (data) => {
      console.log(`[SocketClient] 收到文件传输请求: ${data.name} (${data.fileId})`);

      if (this.fileRequestCallback) {
        this.fileRequestCallback(data);
      }
    });

    // 文件块
    this.socket.on('file:chunk', (data) => {
      if (this.fileChunkCallback) {
        this.fileChunkCallback(data);
      }
    });

    // 文件传输完成
    this.socket.on('file:complete', (data) => {
      console.log(`[SocketClient] 文件传输完成: ${data.fileId}`);

      if (this.fileCompleteCallback) {
        this.fileCompleteCallback(data);
      }
    });

    // 文件请求确认（发送方收到 Server 已处理请求）
    this.socket.on('file:request:ack', (data) => {
      if (this.fileRequestAckCallback) {
        this.fileRequestAckCallback(data);
      }
    });

    // 文件就绪（接收方已接受，发送方可以开始传块）
    this.socket.on('file:ready', (data) => {
      if (data.accepted && this.fileReadyCallback) {
        this.fileReadyCallback(data);
      }
    });

    // 文件块确认（Server 收到块后回执）
    this.socket.on('file:chunk:ack', (data) => {
      if (this.fileChunkAckCallback) {
        this.fileChunkAckCallback(data);
      }
    });

    // 文件被拒绝
    this.socket.on('file:rejected', (data) => {
      console.log(`[SocketClient] 文件被拒绝: ${data.fileId}, 原因: ${data.reason}`);

      if (this.fileRejectedCallback) {
        this.fileRejectedCallback(data);
      }
    });

    // 文件传输错误
    this.socket.on('file:error', (data) => {
      console.error(`[SocketClient] 文件传输错误: ${data.fileId}, ${data.error}`);

      if (this.fileErrorCallback) {
        this.fileErrorCallback(data);
      }
    });

    // Agent 列表事件
    this.socket.on('agent:list', (agents) => {
      this._agentCache = agents;
      if (this.agentListCallback) {
        this.agentListCallback(agents);
      }
    });

    // Agent 连接/断开通知
    this.socket.on('agent:connected', (data) => {
      console.log(`[SocketClient] Agent 上线: ${data.name} (${data.agentId})`);
    });

    this.socket.on('agent:disconnected', (data) => {
      console.log(`[SocketClient] Agent 离线: ${data.name || data.agentId} (${data.agentId})`);
    });

    // Claude Code 执行响应（从目标 Agent 返回给请求方）
    this.socket.on('claude:execute:result', (data) => {
      const resolver = this._pendingRequests?.get(data.requestId);
      if (resolver) {
        this._pendingRequests.delete(data.requestId);
        resolver(data);
      }
    });

    this.socket.on('claude:execute:error', (data) => {
      const resolver = this._pendingRequests?.get(data.requestId);
      if (resolver) {
        this._pendingRequests.delete(data.requestId);
        resolver({ error: data.error, taskId: data.taskId });
      }
    });

    // 错误
    this.socket.on('error', (error) => {
      console.error(`[SocketClient] Socket 错误:`, error);
    });
  }

  /**
   * 处理特定类型的消息
   * @private
   */
  #handleTypedMessage(message) {
    if (!message) return;

    switch (message.type) {
      case 'role-assign':
        if (this.roleAssignCallback && message.metadata?.roleName) {
          this.roleAssignCallback(message.metadata.roleName, message.metadata.roleDescription);
        }
        break;
      case 'task-assign':
        if (this.taskAssignCallback && message.metadata?.taskId) {
          this.taskAssignCallback(message.metadata.taskId, message.metadata);
        }
        break;
      case 'status-query':
        if (this.statusQueryCallback) {
          this.statusQueryCallback(message.metadata?.queryType || 'full-status');
        }
        break;
      default:
        break;
    }
  }

  /**
   * 调度重连（指数退避）
   * @private
   */
  #scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[SocketClient] 达到最大重连次数 (${this.maxReconnectAttempts})，停止重连`);
      return;
    }

    const delay = this.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    const jitter = Math.random() * 1000;
    const finalDelay = Math.min(delay + jitter, 60000); // 最多 60 秒

    this.reconnectAttempts++;
    console.log(`[SocketClient] 将在 ${Math.round(finalDelay / 1000)} 秒后尝试第 ${this.reconnectAttempts} 次重连...`);

    this.reconnectTimer = setTimeout(() => {
      if (!this.connected) {
        this.connect().catch(() => {
          // 重连失败，继续调度
        });
      }
    }, finalDelay);
  }

  /**
   * 发送 Agent 注册信息
   * @param {Object} agentInfo - Agent 信息
   */
  register(agentInfo) {
    if (!this.socket || !this.connected) {
      throw new Error('Socket 未连接，无法注册');
    }

    const registerData = {
      id: this.agentId,
      name: agentInfo.name,
      role: agentInfo.role || '',
      hostname: agentInfo.hostname,
      platform: agentInfo.platform,
      arch: agentInfo.arch,
      workDir: agentInfo.workDir,
      capabilities: agentInfo.capabilities || [],
      claudeVersion: agentInfo.claudeVersion || '',
      ip: agentInfo.ip || '',
      startedAt: agentInfo.startedAt || new Date().toISOString()
    };

    this.socket.emit('agent:register', registerData);
    console.log(`[SocketClient] 发送注册信息: ${agentInfo.name} (${this.agentId})`);
  }

  /**
   * 发送消息
   * @param {Object} message - 消息对象
   */
  sendMessage(message) {
    if (!this.socket || !this.connected) {
      console.warn('[SocketClient] Socket 未连接，无法发送消息');
      return false;
    }

    const msg = {
      id: message.id || uuidv4(),
      from: this.agentId,
      to: message.to || 'broadcast',
      type: message.type || 'text',
      content: message.content || '',
      metadata: message.metadata || {},
      timestamp: Date.now()
    };

    this.socket.emit('message', msg);
    return true;
  }

  /**
   * 发送心跳
   * @param {Object} heartbeat - 心跳数据
   */
  sendHeartbeat(heartbeat) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('heartbeat', {
      agentId: this.agentId,
      timestamp: Date.now(),
      status: heartbeat.status || 'idle',
      currentTask: heartbeat.currentTask || '',
      cpuUsage: heartbeat.cpuUsage || 0,
      memoryUsage: heartbeat.memoryUsage || 0,
      diskUsage: heartbeat.diskUsage || 0,
      uptime: heartbeat.uptime || 0
    });
    return true;
  }

  /**
   * 发送文件传输请求
   * @param {Object} fileRequest - 文件请求
   */
  sendFileRequest(fileRequest) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('file:request', {
      id: fileRequest.id || uuidv4(),
      name: fileRequest.name,
      size: fileRequest.size,
      mimeType: fileRequest.mimeType || 'application/octet-stream',
      from: this.agentId,
      to: fileRequest.to
    });
    return true;
  }

  /**
   * 发送文件传输响应
   * @param {string} fileId - 文件 ID
   * @param {boolean} accepted - 是否接受
   */
  sendFileResponse(fileId, accepted) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('file:response', { fileId, accepted });
    return true;
  }

  /**
   * 发送文件块
   * @param {string} fileId - 文件 ID
   * @param {number} index - 块索引
   * @param {number} total - 总块数
   * @param {string} data - Base64 编码的数据
   */
  sendFileChunk(fileId, index, total, data) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('file:chunk', { fileId, index, total, data });
    return true;
  }

  /**
   * 发送 Claude Code 流式输出
   * @param {string} taskId - 任务 ID
   * @param {string} chunk - 输出块
   * @param {string} type - 输出类型 (stdout/stderr/error)
   */
  sendClaudeOutput(taskId, chunk, type = 'stdout') {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('claude:output', {
      taskId,
      chunk: chunk.toString(),
      type,
      agentId: this.agentId
    });
    return true;
  }

  /**
   * 发送 Claude Code 执行完成
   * @param {string} taskId - 任务 ID
   * @param {number} exitCode - 退出码
   * @param {number} duration - 执行时长(ms)
   * @param {string} summary - 摘要
   */
  sendClaudeComplete(taskId, exitCode, duration, summary = '', requestId = null, sessionId = null) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('claude:complete', {
      taskId,
      exitCode,
      duration,
      summary,
      requestId,
      sessionId
    });
    this.activeClaudeTask = null;
    return true;
  }

  /**
   * 发送 Agent 状态报告
   * @param {Object} status - 状态信息
   */
  sendStatusReport(status) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('agent:status-report', {
      agentId: this.agentId,
      status: status.status || 'idle',
      currentTask: status.currentTask || null,
      recentLogs: status.recentLogs || [],
      timestamp: Date.now()
    });
    return true;
  }

  // ==================== 事件监听设置 ====================

  onMessage(callback) {
    this.messageCallback = callback;
  }

  onClaudeExecute(callback) {
    this.claudeExecuteCallback = callback;
  }

  onClaudeCancel(callback) {
    this.claudeCancelCallback = callback;
  }

  onFileRequest(callback) {
    this.fileRequestCallback = callback;
  }

  onFileChunk(callback) {
    this.fileChunkCallback = callback;
  }

  onFileComplete(callback) {
    this.fileCompleteCallback = callback;
  }

  onFileRequestAck(callback) {
    this.fileRequestAckCallback = callback;
  }

  onFileReady(callback) {
    this.fileReadyCallback = callback;
  }

  onFileChunkAck(callback) {
    this.fileChunkAckCallback = callback;
  }

  onFileRejected(callback) {
    this.fileRejectedCallback = callback;
  }

  onFileError(callback) {
    this.fileErrorCallback = callback;
  }

  onRoleAssign(callback) {
    this.roleAssignCallback = callback;
  }

  onTaskAssign(callback) {
    this.taskAssignCallback = callback;
  }

  onStatusQuery(callback) {
    this.statusQueryCallback = callback;
  }

  onConnected(callback) {
    this.connectedCallback = callback;
  }

  onDisconnected(callback) {
    this.disconnectedCallback = callback;
  }

  onRegistered(callback) {
    this.registeredCallback = callback;
  }

  onHeartbeatAck(callback) {
    this.heartbeatAckCallback = callback;
  }

  onAgentList(callback) {
    this.agentListCallback = callback;
  }

  // ==================== 请求/响应模式方法 ====================

  /**
   * 请求 Agent 列表
   * @returns {Promise<Array>}
   */
  requestAgentList() {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Socket 未连接'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Request agent list timeout'));
      }, 10000);

      const handler = (agents) => {
        clearTimeout(timeout);
        this.socket.off('agent:list', handler);
        resolve(agents);
      };

      this.socket.on('agent:list', handler);
      this.socket.emit('agent:list:request');
    });
  }

  /**
   * 请求目标 Agent 执行 Claude Code
   * @param {Object} params
   * @param {string} params.targetAgentId - 目标 Agent ID
   * @param {string} params.taskId - 任务 ID
   * @param {string} params.prompt - Claude Code prompt
   * @param {Object} [params.context] - 上下文
   * @param {number} [params.timeout] - 超时时间
   * @returns {Promise<Object>} 执行结果
   */
  sendClaudeExecuteRequest({ targetAgentId, taskId, prompt, context = {}, timeout = 300000, sessionId = null, resume = false }) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Socket 未连接'));
        return;
      }

      const requestId = uuidv4();
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`Claude execute request timeout for agent ${targetAgentId}`));
      }, timeout + 30000); // 比任务超时多 30 秒

      this._pendingRequests.set(requestId, (result) => {
        clearTimeout(timer);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });

      this.socket.emit('claude:execute:request', {
        requestId,
        targetAgentId,
        taskId,
        prompt,
        context,
        timeout,
        fromAgentId: this.agentId,
        sessionId,
        resume
      });
    });
  }

  /**
   * 发送 Claude Code 取消请求（直接发送，不等待响应）
   * @param {string} taskId - 任务 ID
   * @param {string} targetAgentId - 目标 Agent ID
   */
  _sendCancel(taskId, targetAgentId) {
    if (!this.socket || !this.connected) {
      return false;
    }

    this.socket.emit('claude:cancel', { taskId, targetAgentId });
    return true;
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      // 发送断开通知
      if (this.connected) {
        this.socket.emit('agent:disconnecting', {
          agentId: this.agentId,
          reason: 'manual_disconnect'
        });
      }

      this.socket.disconnect();
      this.socket = null;
    }

    this.connected = false;
    this.registered = false;
  }

  /**
   * 获取 Agent ID
   */
  getAgentId() {
    return this.agentId;
  }
}

module.exports = { SocketClient };
