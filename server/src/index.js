/**
 * Agent Collaboration Server - 入口文件
 * Express 服务器 + Socket.io 初始化
 * 负责 Agent 管理、消息分发、心跳检测、文件传输协调
 */
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const apiRoutes = require('./routes/api');
const { SocketHandler } = require('./socket/handler');
const { setupStaticMiddleware } = require('./middleware/static');

// ========== 配置 ==========

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ========== 创建应用 ==========

const app = express();
const httpServer = createServer(app);

// ========== Socket.io 初始化 ==========

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // 心跳由应用层处理，禁用 Socket.io 内置心跳
  pingTimeout: 60000,
  pingInterval: 25000,
  // 传输配置
  transports: ['websocket', 'polling']
});

// 将 io 实例存储在 app 上，供路由使用
app.set('io', io);

// ========== 中间件 ==========

// CORS
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));

// JSON 解析
app.use(express.json({ limit: '10mb' }));

// URL 编码解析
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 压缩
app.use(compression());

// 请求日志
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[HTTP] ${timestamp} ${req.method} ${req.path}`);
  next();
});

// ========== API 路由 ==========

app.use('/api', apiRoutes);

// ========== Socket.io 处理器 ==========

const socketHandler = new SocketHandler(io);
socketHandler.initialize();

// 将 heartbeatMonitor 存储在 app 上，供路由使用
app.set('heartbeatMonitor', socketHandler.heartbeatMonitor);

// ========== 静态文件服务 (SPA 回退) ==========

// 根据环境确定前端构建目录
const publicPath = NODE_ENV === 'production'
  ? path.join(__dirname, '../public')
  : path.join(__dirname, '../../frontend/dist');

setupStaticMiddleware(app, publicPath);

// ========== 错误处理 ==========

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
    stack: NODE_ENV === 'production' ? undefined : err.stack
  });
});

// ========== 启动服务器 ==========

httpServer.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('Agent Collaboration Server');
  console.log('='.repeat(50));
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Port:        ${PORT}`);
  console.log(`CORS:        ${CORS_ORIGIN}`);
  console.log(`API:         http://localhost:${PORT}/api`);
  console.log(`Health:      http://localhost:${PORT}/api/health`);
  console.log('='.repeat(50));
});

// ========== 优雅关闭 ==========

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');
  socketHandler.heartbeatMonitor.stopMonitoring();
  io.close(() => {
    httpServer.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down gracefully...');
  socketHandler.heartbeatMonitor.stopMonitoring();
  io.close(() => {
    httpServer.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });
  });
});

// 未捕获的异常处理 — 记录后优雅关闭，让进程管理器重启
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception, shutting down:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection, shutting down:', reason);
  gracefulShutdown('unhandledRejection');
});

function gracefulShutdown(signal) {
  console.log(`[Server] Graceful shutdown initiated (${signal})`);
  socketHandler.heartbeatMonitor.stopMonitoring();

  // 强制保护：5 秒后仍未退出则强制终止
  const forceExit = setTimeout(() => {
    console.error('[Server] Forced shutdown after 5s grace period');
    process.exit(1);
  }, 5000);
  forceExit.unref();

  io.close(() => {
    httpServer.close(() => {
      clearTimeout(forceExit);
      console.log('[Server] Server closed');
      process.exit(1);
    });
  });
}

// ========== 周期性清理 ==========

// 每小时清理完成的文件传输记录
setInterval(() => {
  try {
    const { agentStore } = require('./services/agent-store');
    agentStore.cleanupStaleTransfers();
  } catch (e) {
    // ignore cleanup errors
  }
}, 3600000).unref();

module.exports = { app, io, httpServer };
