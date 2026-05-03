/**
 * Static Middleware - 静态文件服务
 * 提供前端构建文件服务和 SPA 路由回退
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

/**
 * 配置静态文件中间件
 * @param {Express} app - Express 应用实例
 * @param {string} publicPath - 静态文件目录路径
 */
function setupStaticMiddleware(app, publicPath) {
  // 确定前端构建目录
  // 优先使用传入的 publicPath，否则使用默认路径
  const staticRoot = publicPath || path.join(__dirname, '../../public');

  // 检查目录是否存在
  if (!fs.existsSync(staticRoot)) {
    console.warn(`[Static] Public directory not found: ${staticRoot}`);
    // 创建目录防止后续错误
    try {
      fs.mkdirSync(staticRoot, { recursive: true });
    } catch (e) {
      // ignore
    }
  }

  // 静态文件服务
  app.use(express.static(staticRoot, {
    maxAge: '1d', // 缓存 1 天
    etag: true,
    lastModified: true,
    // 忽略 API 路由
    index: false
  }));

  // API 路由不应该被 SPA 回退捕获
  // 其余所有路由回退到 index.html (SPA 支持)
  app.get('*', (req, res, next) => {
    // 跳过 API 路由
    if (req.path.startsWith('/api/')) {
      return next();
    }

    // 跳过 Socket.io 路由
    if (req.path.startsWith('/socket.io/')) {
      return next();
    }

    const indexPath = path.join(staticRoot, 'index.html');

    // 如果 index.html 存在，发送它
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }

    // 如果没有 index.html，返回服务状态信息
    res.json({
      service: 'Agent Collaboration Server',
      status: 'running',
      api: '/api',
      socketio: '/socket.io/',
      hint: 'Frontend build files not found. Please build the frontend first.'
    });
  });

  console.log(`[Static] Static files served from: ${staticRoot}`);
}

module.exports = { setupStaticMiddleware };
