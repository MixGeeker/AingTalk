# Agent 联调测试平台

基于 Socket.io 的多 Agent 联调测试基建系统，支持本地 Claude Code 联动调试、开发、反馈。

## 系统架构

```
+-----------------------------------------+
|              Vue.js 前端                  |
|         (监控面板 & 聊天界面)               |
+-----------------------------------------+
                    |
                    | Socket.io
                    v
+-----------------------------------------+
|           Node.js Server                |
|    (消息路由 / Agent管理 / 心跳检测)       |
+-----------------------------------------+
                    |
        +-----------+-----------+
        |                       |
   Socket.io               Socket.io
        |                       |
   +----v-----+           +-----v----+
   | Worker   |           |  Worker  |
   | (MacOS)  |           |(Windows) |
   |Claude Code|          |Claude Code|
   +----------+           +----------+
```

## 快速开始

### 1. 部署 Server (Docker)

```bash
# 方式一: Docker Compose (推荐)
docker-compose up -d

# 方式二: 手动构建
cd server
docker build -t agent-collab-server .
docker run -d -p 3000:3000 agent-collab-server
```

### 2. 部署 Worker

#### Mac OS

```bash
cd worker
cp config.example.json config.json
# 编辑 config.json 填写 serverUrl、name、workDir
npm install
chmod +x scripts/start.sh
./scripts/start.sh
```

#### Windows 11

```cmd
cd worker
copy config.example.json config.json
:: 编辑 config.json 填写 serverUrl、name、workDir
npm install
scripts\start.bat
```

#### 命令行参数方式 (无需配置文件)

```bash
# Mac/Linux
node src/index.js --server http://192.168.1.100:3000 --name "调试用机器" --workDir /Users/dev/projects

# Windows
node src/index.js --server http://192.168.1.100:3000 --name "调试机-Win" --workDir C:\Users\dev\projects
```

### 3. 环境变量配置

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `AGENT_SERVER_URL` | Server 地址 | `http://localhost:3000` |
| `AGENT_NAME` | Agent 名称 | `调试用机器` |
| `AGENT_WORK_DIR` | 工作目录 | `/Users/dev/projects` |
| `AGENT_HEARTBEAT_INTERVAL` | 心跳间隔(ms) | `30000` |
| `AGENT_CLAUDE_CODE_PATH` | Claude Code 路径 | `claude` |

### 4. 开发前端

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 生产构建 (输出到 dist/)
```

## 核心功能

### Agent 间通讯

- **定向消息**: Agent A -> Agent B 的私密消息
- **广播消息**: 发送给所有在线 Agent
- **角色分配**: 给 Agent 分配角色和职责
- **任务分配**: 给 Agent 指派具体任务
- **状态查询**: 查询 Agent 当前工作状态

### BTW 旁路询问

一种特殊的低优先级消息类型，用于在不打断当前任务的情况下进行询问。

```javascript
// Leader Agent 发送 BTW
socket.emit('message', {
  type: 'btw',
  to: 'worker-agent-id',
  content: '你目前调试进度到哪里了？',
  metadata: { isBtw: true, urgency: 'normal' }
});
```

### 心跳机制

- Worker 每 30 秒发送心跳
- Server 每 15 秒检查超时
- 超过 90 秒无心跳标记为离线
- 前端实时显示心跳延迟

### 文件传输

- 支持压缩包: `.zip`, `.tar.gz`, `.tgz`, `.7z`, `.rar`
- 支持代码文件: `.js`, `.ts`, `.py`, `.java`, `.go`, `.rs`, `.c`, `.cpp`
- 支持数据文件: `.json`, `.xml`, `.yaml`, `.csv`, `.md`, `.txt`, `.log`
- 单文件最大 100MB
- 分块传输 (64KB/块)

## 部署场景示例

### 场景：跨机器联调调试

**机器 A (MacBook - 开发机)**
```bash
# 部署 Worker
node worker/src/index.js -s http://server-ip:3000 -n "Leader开发机" -w ~/my-project
# 然后告诉 Claude Code: "你是开发负责人，协调其他机器进行调试"
```

**机器 B (Windows - 测试机)**
```bash
# 部署 Worker
node worker/src/index.js -s http://server-ip:3000 -n "调试用机器" -w C:\test-project
# Leader Agent 可以发消息给它: "你是API调试专家，负责验证接口"
```

**机器 C (Mac Mini - 构建机)**
```bash
node worker/src/index.js -s http://server-ip:3000 -n "构建机器" -w ~/build
# Leader Agent: "你是构建专家，负责编译和打包"
```

## Worker 配置示例

```json
{
  "serverUrl": "http://192.168.1.100:3000",
  "name": "调试用机器",
  "workDir": "/Users/dev/projects",
  "heartbeatInterval": 30000,
  "autoReconnect": true,
  "reconnectInterval": 5000,
  "maxReconnectAttempts": 10,
  "capabilities": ["claude-code", "node", "git", "docker"],
  "claudeCodePath": "claude",
  "maxFileSize": 104857600,
  "allowedFileTypes": [".zip", ".tar.gz", ".js", ".ts", ".py", ".json", ".md", ".txt"]
}
```

## Socket.io 消息协议

### Agent 注册
```javascript
socket.emit('agent:register', {
  id: 'uuid-v4',
  name: '调试用机器',
  role: '',
  hostname: 'macbook-pro',
  platform: 'darwin',
  arch: 'arm64',
  workDir: '/Users/dev/projects',
  capabilities: ['claude-code', 'node', 'git'],
  claudeVersion: '1.x.x',
  ip: '192.168.1.100',
  startedAt: '2024-01-15T10:00:00Z'
});
```

### 发送消息
```javascript
// 普通消息
socket.emit('message', {
  from: 'agent-id-1',
  to: 'agent-id-2',
  type: 'text',
  content: '你好，请介绍一下你的环境',
  timestamp: Date.now()
});

// 角色分配
socket.emit('message', {
  from: 'leader-agent',
  to: 'worker-agent',
  type: 'role-assign',
  content: '你被分配为 API调试专家',
  metadata: { roleName: 'API调试专家', roleDescription: '负责调试API...' }
});

// BTW 旁路询问
socket.emit('message', {
  from: 'leader-agent',
  to: 'worker-agent',
  type: 'btw',
  content: '进度到哪了？',
  metadata: { isBtw: true, urgency: 'low' }
});
```

### 心跳
```javascript
// Worker -> Server (每 30 秒)
socket.emit('heartbeat', {
  agentId: 'uuid',
  timestamp: Date.now(),
  status: 'idle',
  currentTask: '',
  cpuUsage: 45.2,
  memoryUsage: 67.8,
  diskUsage: 82.1,
  uptime: 3600
});

// Server -> Worker
socket.on('heartbeat:ack', (data) => {});
```

### 文件传输
```javascript
// 发送文件请求
socket.emit('file:request', { id, name, size, mimeType, from, to });

// 响应
socket.emit('file:response', { fileId, accepted: true });

// 发送块
socket.emit('file:chunk', { fileId, index, total, data });
```

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents` | Agent 列表 |
| GET | `/api/agents/:id` | 单个 Agent |
| GET | `/api/agents/:id/messages` | Agent 消息历史 |
| GET | `/api/agents/:id/status` | Agent 状态 |
| POST | `/api/agents/:id/message` | 发送消息 |
| GET | `/api/messages` | 所有消息 |
| GET | `/api/transfers` | 传输记录 |
| GET | `/api/health` | 健康检查 |
| GET | `/api/stats` | 系统统计 |

## 项目结构

```
agent-collab-platform/
├── server/                    # Server 端
│   ├── src/
│   │   ├── index.js           # 入口
│   │   ├── socket/            # Socket.io 处理器
│   │   │   ├── handler.js     # 主处理器
│   │   │   ├── agent-manager.js
│   │   │   ├── message-router.js
│   │   │   ├── heartbeat.js
│   │   │   └── file-handler.js
│   │   ├── routes/api.js      # REST API
│   │   ├── services/          # 数据存储
│   │   └── middleware/        # 中间件
│   ├── package.json
│   └── Dockerfile
├── worker/                    # Worker 端
│   ├── src/
│   │   ├── index.js           # 入口
│   │   ├── client/            # Socket.io 客户端
│   │   ├── executor/          # Claude Code 执行器
│   │   ├── collector/         # 系统状态收集
│   │   ├── file-handler/      # 文件传输
│   │   └── config/            # 配置加载
│   ├── scripts/               # 启动脚本
│   │   ├── start.bat          # Windows
│   │   └── start.sh           # Mac/Linux
│   ├── config.example.json
│   └── package.json
├── frontend/                  # Vue.js 前端
│   ├── src/
│   │   ├── components/        # UI 组件
│   │   ├── views/             # 页面视图
│   │   ├── stores/            # Pinia 状态管理
│   │   └── utils/             # 工具函数
│   ├── package.json
│   └── vite.config.js
├── docker-compose.yml
└── README.md
```

## 技术栈

- **通讯**: Socket.io v4
- **Server**: Node.js 20 + Express 4
- **Worker**: Node.js 20 + Socket.io-client
- **前端**: Vue.js 3 + Vite + Tailwind CSS + Pinia
- **部署**: Docker (Server), 跨平台脚本 (Worker)
- **AI 集成**: Claude Code CLI

## License

MIT
