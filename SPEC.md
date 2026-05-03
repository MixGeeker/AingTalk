# Multi-Agent 联调测试基建系统 - SPEC.md

## 1. 项目概述

基于 Socket.io 的多 Agent 联调测试聊天室系统。支持本地 Claude Code 联动调试、开发和反馈。

## 2. 技术栈

- **通讯基座**: Socket.io v4
- **Server**: Node.js 20 + Express 4
- **Worker**: Node.js 20 + Socket.io-client
- **前端**: Vue.js 3 + Vite + Socket.io-client
- **部署**: Docker (Server), 跨平台脚本 (Worker)
- **AI 集成**: Claude Code CLI (`claude` 命令)

## 3. 架构设计

```
+------------------+        Socket.io         +------------------+
|   Vue Frontend   | <--------------------->  |     Server       |
| (监控 & 聊天UI)   |                          | (消息路由中心)    |
+------------------+                          +--------+---------+
                                                       |
                              Socket.io                |
                    +----------------------------------+--------------------------------+
                    |                                  |                                |
           +--------+---------+            +-----------+-----------+        +-----------+-----------+
           | Worker (MacOS)   |            | Worker (Windows 11)   |        | Worker (Linux)        |
           | - Claude Code    |            | - Claude Code         |        | - Claude Code         |
           | - 状态收集        |            | - 状态收集            |        | - 状态收集            |
           | - 命令执行        |            | - 命令执行            |        | - 命令执行            |
           +------------------+            +-----------------------+        +-----------------------+
```

## 4. 目录结构

```
/mnt/agents/output/project/
├── server/
│   ├── src/
│   │   ├── index.js              # Express + Socket.io 入口
│   │   ├── socket/
│   │   │   ├── handler.js        # Socket.io 事件处理器
│   │   │   ├── agent-manager.js  # Agent 注册/管理
│   │   │   ├── message-router.js # 消息路由/分发
│   │   │   ├── heartbeat.js      # 心跳检测
│   │   │   └── file-handler.js   # 文件传输处理
│   │   ├── routes/
│   │   │   └── api.js            # REST API 路由
│   │   ├── services/
│   │   │   └── agent-store.js    # Agent 数据存储
│   │   └── middleware/
│   │       └── static.js         # 静态文件中间件
│   ├── package.json
│   └── Dockerfile
├── worker/
│   ├── src/
│   │   ├── index.js              # Worker 入口
│   │   ├── client/
│   │   │   └── socket-client.js  # Socket.io 客户端连接
│   │   ├── executor/
│   │   │   ├── claude-code.js    # Claude Code CLI 调用
│   │   │   └── command-runner.js # 系统命令执行
│   │   ├── collector/
│   │   │   └── system-info.js    # 系统状态收集
│   │   ├── file-handler/
│   │   │   └── file-transfer.js  # 文件收发处理
│   │   └── config/
│   │       └── loader.js         # 配置加载
│   ├── package.json
│   └── scripts/
│       ├── start.bat             # Windows 启动脚本
│       └── start.sh              # Mac/Linux 启动脚本
├── frontend/
│   ├── src/
│   │   ├── main.js               # Vue 入口
│   │   ├── App.vue               # 根组件
│   │   ├── components/
│   │   │   ├── AgentList.vue     # Agent 列表
│   │   │   ├── ChatRoom.vue      # 聊天室
│   │   │   ├── MessagePanel.vue  # 消息面板
│   │   │   ├── FileTransfer.vue  # 文件传输
│   │   │   └── StatusMonitor.vue # 状态监控
│   │   ├── views/
│   │   │   └── Dashboard.vue     # 主面板
│   │   ├── stores/
│   │   │   └── socket.js         # Socket.io Store
│   │   └── utils/
│   │       └── format.js         # 格式化工具
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── package.json                  # 根 package.json (scripts)
└── docker-compose.yml
```

## 5. Socket.io 消息协议

### 5.1 命名空间
- 默认命名空间 `/` - 所有 Agent 通讯

### 5.2 事件定义

#### 5.2.1 Agent 生命周期
```javascript
// Worker -> Server: 注册 Agent
socket.emit('agent:register', {
  id: 'uuid-v4',                    // Worker 生成
  name: '调试用机器',                // 用户配置
  role: '',                        // 初始为空，由其他 Agent 分配
  hostname: 'macbook-pro-m1',
  platform: 'darwin',              // darwin / win32 / linux
  arch: 'arm64',
  workDir: '/Users/dev/projects',  // 本机工作路径
  capabilities: ['claude-code', 'node', 'git'],
  claudeVersion: '1.x.x',          // Claude Code 版本
  ip: '192.168.1.100',
  startedAt: '2024-01-15T10:00:00Z'
});

// Server -> All: 广播新 Agent 上线
socket.emit('agent:connected', { agentId, name, role, platform, status: 'online' });

// Server -> Worker: 注册确认
socket.emit('agent:registered', { agentId, serverTime: Date.now() });

// Worker -> Server: 断开连接前通知
socket.emit('agent:disconnecting', { agentId, reason });

// Server -> All: Agent 离线通知
socket.emit('agent:disconnected', { agentId, name, timestamp });
```

#### 5.2.2 心跳机制
```javascript
// Worker -> Server: 心跳 (每 30 秒)
socket.emit('heartbeat', {
  agentId: 'uuid',
  timestamp: Date.now(),
  status: 'idle',           // idle / busy / error
  currentTask: '',          // 当前执行的任务描述
  cpuUsage: 45.2,           // CPU 使用率
  memoryUsage: 67.8,        // 内存使用率 MB
  diskUsage: 82.1,          // 磁盘使用率
  uptime: 3600              // 进程运行秒数
});

// Server -> Worker: 心跳确认
socket.emit('heartbeat:ack', { serverTime: Date.now() });
```

#### 5.2.3 消息通讯
```javascript
// Agent -> Server -> Agent: 普通消息
socket.emit('message', {
  id: 'msg-uuid',
  from: 'agent-id-1',         // 发送方 Agent ID
  to: 'agent-id-2',           // 接收方 Agent ID ('broadcast' = 广播)
  type: 'text',               // text / role-assign / task-assign / status-query / response / file-notice / btw
  content: '你好，请介绍一下你的环境',
  metadata: {                 // 扩展字段
    roleDescription: '',      // 角色描述 (type=role-assign)
    taskDescription: '',      // 任务描述 (type=task-assign)
    queryType: '',           // 查询类型 (type=status-query)
    replyTo: '',             // 回复哪条消息
    fileId: '',              // 关联文件 ID
    isBtw: false             // 是否为旁路消息
  },
  timestamp: Date.now()
});

// Server -> Sender: 消息送达确认
socket.emit('message:delivered', { messageId, to, timestamp });

// Server -> Receiver: 新消息通知
socket.emit('message:new', { message });
```

#### 5.2.4 BTW 旁路询问
```javascript
// BTW 消息本质上也是 message 事件，但 type='btw' 且 metadata.isBtw=true
socket.emit('message', {
  id: 'msg-uuid',
  from: 'leader-agent',
  to: 'worker-agent',
  type: 'btw',                // btw = by the way 旁路询问
  content: '你目前调试进度到哪里了？',
  metadata: {
    isBtw: true,
    urgency: 'low',          // low / normal / high
    replyTo: 'original-task-id'
  },
  timestamp: Date.now()
});
```

#### 5.2.5 文件传输
```javascript
// Sender -> Server: 文件传输请求
socket.emit('file:request', {
  id: 'file-uuid',
  name: 'project.zip',
  size: 1024567,
  mimeType: 'application/zip',
  from: 'agent-id-1',
  to: 'agent-id-2'
});

// Server -> Receiver: 文件传输询问
socket.emit('file:incoming', { fileId, name, size, from });

// Receiver -> Server: 接受/拒绝
socket.emit('file:response', { fileId, accepted: true });

// Sender -> Server: 文件分块发送
socket.emit('file:chunk', {
  fileId: 'file-uuid',
  index: 0,                   // 块索引
  total: 10,                  // 总块数
  data: Buffer                // Base64 编码的二进制数据
});

// Server -> Sender: 块确认
socket.emit('file:chunk:ack', { fileId, index });

// Server -> Receiver: 块转发
socket.emit('file:chunk', { fileId, index, total, data });

// Server -> All: 传输完成
socket.emit('file:complete', { fileId, success: true, savedPath: '/path/to/file' });
```

#### 5.2.6 Agent 角色/任务管理
```javascript
// Agent -> Agent: 角色分配
socket.emit('message', {
  type: 'role-assign',
  content: '你现在被分配为 "API调试专家" 角色',
  metadata: {
    roleName: 'API调试专家',
    roleDescription: '负责调试后端API接口，验证请求响应...'
  }
});

// Agent -> Agent: 任务分配
socket.emit('message', {
  type: 'task-assign',
  content: '请帮我调试 /api/users 接口',
  metadata: {
    taskId: 'task-uuid',
    taskDescription: '调试用户API',
    priority: 'high',
    deadline: ''
  }
});

// Agent -> Agent: 状态查询
socket.emit('message', {
  type: 'status-query',
  content: '请报告你当前的工作状态',
  metadata: { queryType: 'full-status' }
});

// Worker -> Server: 状态报告 (主动)
socket.emit('agent:status-report', {
  agentId: 'uuid',
  status: 'busy',
  currentTask: { id: '', description: '', progress: 45 },
  recentLogs: ['正在执行测试...', '发现一处错误'],
  timestamp: Date.now()
});
```

### 5.3 Claude Code 集成协议
```javascript
// Server -> Worker: 执行 Claude Code 命令
socket.emit('claude:execute', {
  taskId: 'task-uuid',
  prompt: '请分析这个错误日志并提供修复建议',
  context: {                    // 上下文信息
    cwd: '/project/path',
    files: ['src/index.js'],
    environment: { NODE_ENV: 'development' }
  },
  timeout: 300000              // 最大执行时间 5 分钟
});

// Worker -> Server: Claude Code 输出 (流式)
socket.emit('claude:output', {
  taskId: 'task-uuid',
  chunk: '分析中...',          // 增量输出
  type: 'stdout'               // stdout / stderr / error
});

// Worker -> Server: Claude Code 执行完成
socket.emit('claude:complete', {
  taskId: 'task-uuid',
  exitCode: 0,
  duration: 45000,
  summary: '已分析完成，建议修改第 23 行'
});
```

## 6. 核心模块接口

### 6.1 AgentManager (server/src/socket/agent-manager.js)
```javascript
class AgentManager {
  // 注册 Agent
  registerAgent(socket, agentInfo) -> { agentId, success, error? }
  
  // 获取 Agent 列表
  getAgents() -> Agent[]
  
  // 获取单个 Agent
  getAgent(agentId) -> Agent | null
  
  // 更新 Agent 信息
  updateAgent(agentId, updates) -> boolean
  
  // 更新 Agent 状态
  updateAgentStatus(agentId, status) -> boolean
  
  // 分配角色
  assignRole(agentId, roleName, roleDescription) -> boolean
  
  // 注销 Agent
  unregisterAgent(agentId) -> boolean
  
  // 检查 Agent 是否在线
  isAgentOnline(agentId) -> boolean
}
```

### 6.2 MessageRouter (server/src/socket/message-router.js)
```javascript
class MessageRouter {
  // 路由消息
  routeMessage(message) -> { success, deliveredTo[] }
  
  // 发送广播消息
  broadcast(message, excludeAgentId?) -> void
  
  // 发送定向消息
  sendTo(agentId, message) -> boolean
  
  // 发送 BTW 消息
  sendBtwMessage(message) -> boolean
  
  // 处理消息确认
  handleDeliveryConfirm(messageId, agentId) -> void
}
```

### 6.3 HeartbeatMonitor (server/src/socket/heartbeat.js)
```javascript
class HeartbeatMonitor {
  // 开始监控
  startMonitoring()
  
  // 处理心跳
  handleHeartbeat(agentId, heartbeat) -> void
  
  // 检查超时 Agent
  checkTimeoutAgents() -> string[]  // 返回超时 Agent ID 列表
  
  // 设置超时阈值（毫秒）
  setTimeoutThreshold(ms)
  
  // 获取 Agent 健康状态
  getAgentHealth(agentId) -> { lastHeartbeat, latency, status }
}
```

### 6.4 ClaudeCodeExecutor (worker/src/executor/claude-code.js)
```javascript
class ClaudeCodeExecutor {
  // 执行 Claude Code 命令
  execute(prompt, options) -> AsyncGenerator<{ type, chunk }>
  
  // 取消执行
  cancel(taskId) -> boolean
  
  // 检查 Claude Code 是否可用
  isAvailable() -> boolean
  
  // 获取 Claude Code 版本
  getVersion() -> string
}
```

### 6.5 SystemInfoCollector (worker/src/collector/system-info.js)
```javascript
class SystemInfoCollector {
  // 收集系统信息（一次性）
  collect() -> { platform, arch, hostname, cpuCount, totalMemory, ... }
  
  // 收集动态指标
  collectMetrics() -> { cpuUsage, memoryUsage, diskUsage, uptime }
  
  // 获取工作目录信息
  getWorkDirInfo(path) -> { files, size, lastModified }
  
  // 获取 Claude Code 信息
  getClaudeCodeInfo() -> { installed, version, path }
}
```

## 7. 数据模型

### 7.1 Agent
```typescript
interface Agent {
  id: string;                    // UUID
  socketId: string;              // Socket.io socket id
  name: string;                  // 显示名称
  role: string;                  // 角色名称
  roleDescription: string;       // 角色描述
  hostname: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  workDir: string;
  capabilities: string[];
  claudeVersion: string;
  ip: string;
  status: 'online' | 'offline' | 'busy' | 'error';
  currentTask: Task | null;
  lastHeartbeat: number;         // 时间戳
  heartbeatLatency: number;      // 心跳延迟 ms
  connectedAt: number;
  startedAt: number;
}
```

### 7.2 Message
```typescript
interface Message {
  id: string;
  from: string;                  // Agent ID
  fromName: string;              // Agent 名称（冗余，方便查询）
  to: string;                    // Agent ID 或 'broadcast'
  type: 'text' | 'role-assign' | 'task-assign' | 'status-query' | 'response' | 'file-notice' | 'btw';
  content: string;
  metadata: Record<string, any>;
  delivered: boolean;
  deliveredAt: number | null;
  read: boolean;
  timestamp: number;
}
```

### 7.3 FileTransfer
```typescript
interface FileTransfer {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  from: string;
  to: string;
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'rejected';
  chunksReceived: number;
  totalChunks: number;
  savedPath: string;
  createdAt: number;
  completedAt: number | null;
}
```

### 7.4 Task
```typescript
interface Task {
  id: string;
  agentId: string;
  description: string;
  type: 'claude-execute' | 'command' | 'debug';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;              // 0-100
  result: string;
  startedAt: number;
  completedAt: number | null;
}
```

## 8. Worker 配置

### 8.1 配置文件 (`worker/config.json`)
```json
{
  "serverUrl": "http://localhost:3000",
  "name": "调试用机器",
  "workDir": "/Users/dev/projects",
  "heartbeatInterval": 30000,
  "autoReconnect": true,
  "reconnectInterval": 5000,
  "maxReconnectAttempts": 10,
  "capabilities": ["claude-code", "node", "git", "docker"],
  "claudeCodePath": "claude",
  "maxFileSize": 104857600,
  "allowedFileTypes": [".zip", ".tar.gz", ".js", ".ts", ".py", ".json", ".md", ".txt", ".log"]
}
```

### 8.2 环境变量配置
```bash
# Worker 启动时可通过环境变量覆盖配置
AGENT_SERVER_URL=http://server:3000
AGENT_NAME="调试用机器"
AGENT_WORK_DIR=/Users/dev/projects
AGENT_HEARTBEAT_INTERVAL=30000
```

## 9. Server API

### 9.1 REST API
```
GET  /api/agents              # 获取所有 Agent 列表
GET  /api/agents/:id          # 获取单个 Agent
GET  /api/agents/:id/messages # 获取 Agent 消息历史
GET  /api/agents/:id/status   # 获取 Agent 状态
POST /api/agents/:id/message  # 发送消息给 Agent
GET  /api/messages            # 获取消息历史
GET  /api/transfers           # 获取文件传输记录
GET  /api/health              # Server 健康检查
```

### 9.2 WebSocket 事件 (前端 <-> Server)
```javascript
// 前端 -> Server
socket.emit('join-dashboard');           // 加入监控面板
socket.emit('send-message', message);    // 发送消息
socket.emit('request-status', agentId);  // 请求 Agent 状态
socket.emit('assign-role', { agentId, role, description });

// Server -> 前端
socket.on('agent:list', agents => {});           // Agent 列表更新
socket.on('agent:update', agent => {});          // Agent 状态更新
socket.on('message:new', message => {});         // 新消息
socket.on('transfer:update', transfer => {});    // 传输进度更新
socket.on('heartbeat:update', data => {});       // 心跳数据更新
socket.on('system:stats', stats => {});          // 系统统计
```

## 10. 心跳机制详情

### 10.1 流程
1. Worker 每 30 秒发送 `heartbeat` 事件
2. Server 收到后回复 `heartbeat:ack`
3. Server 记录最后一次心跳时间
4. HeartbeatMonitor 每 15 秒检查一次超时
5. 超过 90 秒未收到心跳的 Agent 标记为 `offline`
6. Server 广播 `agent:status-update` 事件

### 10.2 配置参数
```javascript
const HEARTBEAT_CONFIG = {
  interval: 30000,        // Worker 发送间隔
  checkInterval: 15000,   // Server 检查间隔
  timeoutThreshold: 90000,// 超时阈值
  maxMissedBeats: 3       // 最大允许丢失心跳数
};
```

## 11. BTW (旁路询问) 机制

### 11.1 设计说明
- BTW 消息优先级低于普通消息
- 被询问的 Agent 可以在当前任务不中断的情况下回复
- BTW 消息有特殊的视觉标识
- 支持 `urgency` 字段控制响应优先级

### 11.2 处理流程
1. Leader Agent 发送 `type: 'btw'` 消息
2. Server 路由到目标 Agent
3. 目标 Worker 收到后，如当前正忙，会在任务间隙回复
4. 回复也是 `type: 'btw'` 消息
5. 前端用特殊样式（如侧边气泡、不同颜色）展示 BTW 消息

## 12. 文件传输安全规则

### 12.1 允许的文件类型
- 压缩包: `.zip`, `.tar.gz`, `.tgz`, `.bz2`, `.7z`
- 代码文件: `.js`, `.ts`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`, `.h`
- 数据文件: `.json`, `.xml`, `.yaml`, `.yml`, `.csv`, `.sql`
- 文档: `.md`, `.txt`, `.log`

### 12.2 限制
- 最大文件大小: 100MB
- 禁止: `.exe`, `.dll`, `.so`, `.dylib`, `.sh`, `.bat` (可执行文件)
- 传输前检查 MIME 类型

## 13. Docker 配置 (Server)

### 13.1 Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/
COPY frontend/dist/ ./public/
EXPOSE 3000
CMD ["node", "src/index.js"]
```

### 13.2 docker-compose.yml
```yaml
version: '3.8'
services:
  agent-server:
    build: ./server
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - HEARTBEAT_TIMEOUT=90000
    volumes:
      - ./uploads:/app/uploads
    restart: unless-stopped
```

## 14. Worker 跨平台支持

### 14.1 Windows 11
- 启动脚本: `scripts/start.bat`
- 配置文件: `config.json`
- 依赖: Node.js 20+, `claude` CLI 在 PATH 中

### 14.2 Mac OS
- 启动脚本: `scripts/start.sh`
- 配置文件: `config.json`
- 依赖: Node.js 20+, `claude` CLI 在 PATH 中

### 14.3 部署流程
1. 解压 Worker 包到目标机器
2. 编辑 `config.json` 填写 Server 地址、名称、工作路径
3. 双击 `start.bat` (Win) 或 `./start.sh` (Mac)
4. Worker 自动连接 Server 并注册

## 15. 前端界面设计

### 15.1 布局
```
+----------------------------------------------------------+
|  Logo    Agent联调测试平台                    [系统状态]  |
+----------+-----------------------------------------------+
|          |                                               |
| Agent    |  聊天区域                                       |
| 列表      |  +-----------------------------------------+  |
|          |  | AgentA: 你好，请介绍你的环境               |  |
| [在线]   |  | AgentB: 我是调试机，运行在MacOS...        |  |
| AgentA   |  | [BTW] Leader: 进度到哪了？               |  |
| [忙碌]   |  | AgentB: 正在调试API接口，进度80%...       |  |
| AgentB   |  |                                           |  |
| [离线]   |  |                                           |  |
| AgentC   |  +-----------------------------------------+  |
|          |  [输入消息...] [发送] [文件] [BTW询问]         |
+----------+-----------------------------------------------+
| 底部状态栏: Server运行中 | 在线Agent: 2 | 心跳: 30ms       |
+----------------------------------------------------------+
```

### 15.2 页面路由
- `/` - Dashboard (主面板)
- 无需多页面，所有功能在单页面完成

## 16. 实现优先级

### P0 - 核心功能
1. Server Socket.io 连接管理
2. Agent 注册/管理
3. 消息路由与分发
4. Worker 连接与基础命令执行
5. 前端基础 UI

### P1 - 重要功能
6. 心跳机制
7. 文件传输
8. Claude Code 集成
9. BTW 旁路询问
10. Agent 角色分配

### P2 - 增强功能
11. Docker 部署
12. 消息历史持久化
13. 前端美化与交互优化
14. 系统监控统计
