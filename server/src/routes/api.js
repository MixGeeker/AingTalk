/**
 * API Routes - REST API 路由
 * 提供 Agent 管理、消息查询、文件传输和健康检查的 HTTP 接口
 */
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { agentStore } = require('../services/agent-store');
const router = express.Router();

// ========== Agent API ==========

/**
 * GET /api/agents - 获取所有 Agent 列表
 */
router.get('/agents', (req, res) => {
  try {
    const agents = agentStore.getAllAgents();
    res.json({
      success: true,
      count: agents.length,
      agents
    });
  } catch (error) {
    console.error('[API] Get agents error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:id - 获取单个 Agent
 */
router.get('/agents/:id', (req, res) => {
  try {
    const agent = agentStore.getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    res.json({ success: true, agent });
  } catch (error) {
    console.error('[API] Get agent error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:id/messages - 获取 Agent 消息历史
 */
router.get('/agents/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const safeLimit = (!Number.isNaN(limit) && limit > 0) ? limit : 100;

    const messages = agentStore.getMessages({ agentId: id, limit: safeLimit });
    res.json({
      success: true,
      agentId: id,
      count: messages.length,
      messages
    });
  } catch (error) {
    console.error('[API] Get agent messages error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/agents/:id/status - 获取 Agent 状态
 */
router.get('/agents/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const agent = agentStore.getAgent(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    // 获取心跳健康信息
    const heartbeatModule = req.app.get('heartbeatMonitor');
    const health = heartbeatModule ? heartbeatModule.getAgentHealth(id) : null;

    res.json({
      success: true,
      agentId: id,
      status: {
        ...agent,
        health
      }
    });
  } catch (error) {
    console.error('[API] Get agent status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/agents/:id/message - 发送消息给 Agent
 */
router.post('/agents/:id/message', (req, res) => {
  try {
    const { id } = req.params;
    const { content, type = 'text', from = 'server', metadata = {} } = req.body;

    if (!content) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    const agent = agentStore.getAgent(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const message = {
      id: `msg-${uuidv4()}`,
      from,
      fromName: 'Server',
      to: id,
      type,
      content,
      metadata,
      delivered: false,
      deliveredAt: null,
      read: false,
      timestamp: Date.now()
    };

    agentStore.addMessage(message);

    // 通过 Socket.io 发送
    const io = req.app.get('io');
    if (io && agent.socketId) {
      io.to(agent.socketId).emit('message:new', message);
    }

    res.json({ success: true, message });
  } catch (error) {
    console.error('[API] Send message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== Message API ==========

/**
 * GET /api/messages - 获取消息历史
 */
router.get('/messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const safeLimit = (!Number.isNaN(limit) && limit > 0) ? limit : 100;
    const type = req.query.type || null;

    const messages = agentStore.getMessages({ limit: safeLimit, type });
    res.json({
      success: true,
      count: messages.length,
      messages
    });
  } catch (error) {
    console.error('[API] Get messages error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== File Transfer API ==========

/**
 * GET /api/transfers - 获取文件传输记录
 */
router.get('/transfers', (req, res) => {
  try {
    const transfers = agentStore.getAllFileTransfers();
    res.json({
      success: true,
      count: transfers.length,
      transfers
    });
  } catch (error) {
    console.error('[API] Get transfers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== Health API ==========

/**
 * GET /api/health - 健康检查
 */
router.get('/health', (req, res) => {
  try {
    const stats = agentStore.getStats();
    const uptime = Date.now() - stats.startTime;

    res.json({
      success: true,
      status: 'healthy',
      uptime,
      uptimeHuman: formatUptime(uptime),
      timestamp: Date.now(),
      agents: {
        total: stats.agentCount,
        online: stats.onlineAgents,
        busy: stats.busyAgents,
        error: stats.errorAgents
      },
      messages: stats.messageCount,
      fileTransfers: stats.fileTransferCount,
      version: require('../../package.json').version
    });
  } catch (error) {
    console.error('[API] Health check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/stats - 系统统计
 */
router.get('/stats', (req, res) => {
  try {
    const stats = agentStore.getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[API] Get stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 辅助函数 ==========

/**
 * 格式化运行时间
 * @param {number} ms - 毫秒
 * @returns {string}
 */
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

module.exports = router;
