# AingTalk

基于 Socket.io 的多 Agent 协作平台，支持 Claude Code 跨机器协同调试、远程任务分发与实时终端监控。

## 系统架构

```
+-----------------------------------------------------------+
|                    Vue.js 前端                              |
|          (Agent 监控 & 终端网格 & 状态面板)                    |
+-----------------------------------------------------------+
                          |
                          | Socket.io
                          v
+-----------------------------------------------------------+
|                    Node.js Server                          |
|       (消息路由 / Agent管理 / 心跳检测 / MCP中继)             |
+-----------------------------------------------------------+
                          |
              +-----------+-----------+
              |                       |
         Socket.io               Socket.io (MCP)
              |                       |
         +----v-----+           +-----v-----+
         |  Worker  |           |  Worker   |
         | (Agent)  |           | (Agent)   |
         |Claude Code|          | Claude Code|
         | PTY 执行器 |         | PTY 执行器  |
         | MCP Server|          | MCP Server |
         +----------+           +-----------+
```

## 核心特性

- **MCP Server 集成** — Worker 内置 MCP Server，Claude Code 可直接通过 MCP 工具调用远程 Agent 能力
- **远程任务分发** — 向任意在线 Agent 派发 Claude Code 执行任务，支持会话续接（continue_task）
- **终端网格监控** — 前端以网格布局实时展示每个 Agent 的 Claude Code 终端输出（xterm.js）
- **跨机器文件传输** — Agent 间分块传输文件，支持压缩包、代码、数据等常见类型
- **BTW 旁路询问** — 低优先级消息，不打断 Agent 当前工作
- **心跳与健康监测** — 实时追踪 Agent 在线状态、CPU/内存/磁盘使用率

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 部署 Server

```bash
# 开发模式 (nodemon 热重载)
pnpm dev:server

# 生产模式
cd server && pnpm start

# Docker
pnpm docker:up
# 或
docker-compose up -d
```

Server 默认监听端口 `3000`，可通过环境变量 `PORT` 修改。

### 3. 部署 Worker

```bash
cd worker
cp config.example.json config.json
# 编辑 config.json 填写 serverUrl、name、workDir
pnpm start
```

或通过命令行参数启动：

```bash
# Mac/Linux
node src/index.js --server http://192.168.1.100:3000 --name "MacBook-Pro" --workDir ~/projects

# Windows
node src/index.js --server http://192.168.1.100:3000 --name "Win-Dev" --workDir C:\Users\dev\projects
```

### 4. 开发前端

```bash
pnpm dev:frontend      # 开发服务器 http://localhost:5173，自动代理到 :3000
cd frontend && pnpm build  # 生产构建
```

## MCP Server

Worker 内置 MCP (Model Context Protocol) Server，Claude Code 通过 stdio 连接后可使用以下工具：

| 工具 | 说明 | 参数 |
|------|------|------|
| `list_agents` | 获取所有在线 Agent 列表 | — |
| `get_agent_info` | 获取指定 Agent 详细信息 | `agent_name` |
| `send_message` | 向 Agent 发送消息 | `target_agent`, `message`, `type?` (text/btw) |
| `send_task` | 向远程 Agent 派发 Claude Code 任务 | `target_agent`, `prompt`, `task_description?`, `timeout?` (10s-5h) |
| `continue_task` | 续接已有会话 | `session_id`, `target_agent`, `prompt`, `timeout?` |
| `cancel_task` | 取消正在执行的任务 | `task_id`, `target_agent` |
| `send_file` | 向远程 Agent 发送文件 | `file_path`, `target_agent`, `description?` |

### 使用示例

在 Claude Code 中配置 MCP Server 后，即可通过自然语言调用：

```
"查看当前有哪些 Agent 在线"
"让 Macbook-Pro 帮我分析一下 server/src/index.js 的代码质量"
"发送本地的 config.json 给 Win-Dev"
```

## 环境变量

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| **Server** | | |
| `PORT` | 服务端口 | `3000` |
| `NODE_ENV` | 运行环境 | `development` |
| `CORS_ORIGIN` | CORS 源 | `*` |
| `HEARTBEAT_TIMEOUT` | 心跳超时(ms) | `90000` |
| **Worker** | | |
| `AGENT_SERVER_URL` | Server 地址 | — |
| `AGENT_NAME` | Agent 名称 | — |
| `AGENT_WORK_DIR` | 工作目录 | — |
| `AGENT_HEARTBEAT_INTERVAL` | 心跳间隔(ms) | `30000` |
| `AGENT_AUTO_RECONNECT` | 自动重连 | `true` |
| `AGENT_CLAUDE_CODE_PATH` | Claude Code 路径 | `claude` |

## 部署场景示例

**机器 A (MacBook — 开发机 / Leader)**
```bash
node worker/src/index.js -s http://server-ip:3000 -n "Leader" -w ~/my-project
# Claude Code 通过 MCP 工具协调其他机器
```

**机器 B (Windows — 测试机)**
```bash
node worker/src/index.js -s http://server-ip:3000 -n "Win-Test" -w C:\test-project
# 接受 Leader 派发的任务，执行 Claude Code 分析
```

**机器 C (Linux — 构建机)**
```bash
node worker/src/index.js -s http://server-ip:3000 -n "Build-Bot" -w ~/build
# 专注构建和打包任务
```

## Socket.io 协议

### Agent 注册

```
Worker → agent:register → Server 存储 → agent:registered (回复)
                                    → agent:connected + agent:list (广播)
```

### 心跳

```
Worker → heartbeat (每30s) → heartbeat:ack (回复)
                           → heartbeat:update (广播至前端)
Server 每15s 检查，90s 无心跳标记离线
```

### 消息路由

```
发送方 → message → MessageRouter → message:new (送达目标)
                                → message:delivered (确认回发送方)
BTW 消息: type='btw', metadata.isBtw=true
```

### Claude Code 任务执行

```
MCP/Server → claude:execute:request → Worker (PTY模式启动claude CLI)
                                     → claude:output (流式输出)
                                     → claude:complete (完成，含exitCode/时长/summary)
                                     → claude:execute:result (回传结果)
取消: claude:cancel → Worker 终止进程
```

### 文件传输

```
发送方 → file:request → Server → file:incoming (转发至接收方)
接收方 → file:response → Server → 发送方开始流式传输
发送方 → file:chunk (64KB base64) → Server 中继至接收方
全部传输完成 → file:complete
```

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents` | Agent 列表 |
| GET | `/api/agents/:id` | 单个 Agent 详情 |
| GET | `/api/agents/:id/messages` | Agent 消息历史 |
| GET | `/api/agents/:id/status` | Agent 状态与健康信息 |
| POST | `/api/agents/:id/message` | 发送消息 |
| GET | `/api/messages` | 全部消息历史 |
| GET | `/api/transfers` | 文件传输记录 |
| GET | `/api/health` | 健康检查 |
| GET | `/api/stats` | 系统统计 |

## 项目结构

```
AingTalk/
├── server/                        # Server 端
│   ├── src/
│   │   ├── index.js               # Express + Socket.io 入口
│   │   ├── socket/                # Socket.io 处理器
│   │   │   ├── handler.js         # 主事件分发器
│   │   │   ├── agent-manager.js   # Agent 管理
│   │   │   ├── message-router.js  # 消息路由
│   │   │   ├── heartbeat.js       # 心跳监控
│   │   │   └── file-handler.js    # 文件传输
│   │   ├── routes/api.js          # REST API
│   │   ├── services/
│   │   │   └── agent-store.js     # 内存数据存储
│   │   └── middleware/
│   │       └── static.js          # 静态文件 / SPA 回退
│   ├── package.json
│   └── Dockerfile
├── worker/                        # Worker 端
│   ├── src/
│   │   ├── index.js               # Worker 入口
│   │   ├── mcp-server.mjs         # MCP Server (7个工具)
│   │   ├── client/
│   │   │   └── socket-client.js   # Socket.io 客户端
│   │   ├── executor/
│   │   │   ├── claude-code.js     # PTY 模式 Claude Code 执行器
│   │   │   └── command-runner.js  # 通用命令执行器
│   │   ├── collector/
│   │   │   └── system-info.js     # 系统信息采集
│   │   ├── file-handler/
│   │   │   └── file-transfer.js   # 分块文件传输
│   │   └── config/
│   │       └── loader.js          # 配置加载 (CLI > ENV > JSON > 默认值)
│   ├── scripts/
│   │   ├── start.bat              # Windows 启动脚本
│   │   └── start.sh               # Mac/Linux 启动脚本
│   ├── config.example.json
│   └── package.json
├── frontend/                      # Vue.js 前端
│   ├── src/
│   │   ├── components/
│   │   │   ├── AgentList.vue      # Agent 列表与状态
│   │   │   ├── ClaudeTerminal.vue # xterm.js 终端面板
│   │   │   └── TerminalGrid.vue   # 自适应终端网格布局
│   │   ├── views/
│   │   │   └── Dashboard.vue      # 主面板
│   │   ├── stores/
│   │   │   └── socket.js          # Pinia 状态管理
│   │   └── utils/
│   │       └── format.js          # 格式化工具
│   ├── package.json
│   └── vite.config.js
├── docker-compose.yml
├── CLAUDE.md
└── README.md
```

## 技术栈

- **通信**: Socket.io v4
- **Server**: Node.js 20 + Express 4
- **Worker**: Node.js 20 + node-pty + @modelcontextprotocol/sdk
- **前端**: Vue.js 3 + Vite + Tailwind CSS + Pinia + xterm.js
- **AI 集成**: Claude Code CLI (PTY 模式) + MCP Protocol
- **部署**: Docker (Server)，跨平台脚本 (Worker)

## License

MIT
