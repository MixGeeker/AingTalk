# Multi-Agent 联调测试基建系统 - 实施计划

## 项目概述
构建一个基于 Socket.io 的多 Agent 联调测试聊天室系统，支持本地 Claude Code 联动调试、开发和反馈。

## 技术栈
- **通讯**: Socket.io
- **后端**: Node.js + Express
- **前端**: Vue.js 3
- **部署**: Docker (Server), 跨平台 Worker (Win11 + MacOS)
- **AI集成**: Claude Code CLI

## 架构组件
1. **Server** - 消息接收/分发、状态检测、前端监控、心跳管理
2. **Worker** - 运行在工作机器上，执行命令、收集状态、与Claude Code交互
3. **Frontend** - Vue.js 监控界面

## 核心功能
- 实时消息通讯（Agent间对话）
- 文件传输（仅压缩包/单文件）
- Agent身份/角色管理
- 心跳机制
- BTW旁路询问
- Claude Code集成调用
- 跨平台Worker支持

## 实施阶段

### Stage 1 - 项目架构与初始化
- 初始化项目结构
- 配置 package.json、Dockerfile
- 配置 Vue 前端项目

### Stage 2 - Server 核心实现
- Express + Socket.io 服务器
- 消息路由与分发逻辑
- Agent 注册/身份管理
- 心跳检测机制
- 文件传输处理
- BTW旁路消息处理
- 前端静态文件服务

### Stage 3 - Worker 核心实现
- Socket.io 客户端连接
- Agent 信息配置与注册
- Claude Code 调用集成
- 心跳发送
- 文件接收/发送
- 跨平台兼容处理
- 状态收集与上报

### Stage 4 - 前端界面 (Vue.js)
- Agent 列表与状态监控
- 聊天室界面
- 文件传输UI
- 消息路由可视化
- BTW提问交互

### Stage 5 - 部署配置
- Server Docker 配置
- Worker 跨平台启动脚本
- 配置文件模板
- README 使用说明

### Stage 6 - 集成测试与验证
- 全流程联调
- 检查心跳、文件传输、BTW功能
- 确保代码可运行
