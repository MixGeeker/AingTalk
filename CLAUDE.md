# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AingTalk is a Socket.io-based multi-agent collaboration platform for joint debugging with Claude Code. Three components: a central **Server** (message routing), cross-platform **Workers** (run on dev machines, execute Claude Code CLI commands), and a **Frontend** (Vue.js monitoring dashboard).

## Common Commands

```bash
# Install all dependencies (root)
npm run install:all

# Server (port 3000)
npm run dev:server          # nodemon auto-restart
cd server && npm start      # direct start

# Worker (connects to server)
cd worker && npm start
cd worker && node src/index.js --server http://localhost:3000 --name "MyMachine" --workDir /path/to/projects

# Frontend dev server (port 5173, proxies /api and /socket.io to :3000)
npm run dev:frontend
cd frontend && npm run build   # outputs to frontend/dist/

# Docker
npm run docker:up
docker-compose up -d
```

## Architecture

### Server (`server/`)

Entry: `server/src/index.js` — creates Express + Socket.io on a shared HTTP server. The `SocketHandler` class (`server/src/socket/handler.js`) is the central event hub, delegating to:

- **AgentManager** — agent registration, status updates, role assignment. Calls `agentStore` (in-memory singleton) and broadcasts `agent:list` / `agent:update` events.
- **MessageRouter** — routes messages (direct, broadcast, BTW). Stores messages in `agentStore` (max 1000 in-memory). Emits `message:new` to targets and `message:delivered` back to senders.
- **HeartbeatMonitor** — workers send heartbeat every 30s; server checks every 15s; marks offline after 90s / 3 missed beats. Configurable via `HEARTBEAT_TIMEOUT` env var.
- **FileHandler** — mediates file transfers between agents. Validates file types (whitelist + forbidden list), relays chunks (64KB), tracks transfer state.

`agentStore` (`server/src/services/agent-store.js`) is the single in-memory data store (singleton), holding agents Map, messages array, file transfers Map. No database — all state is ephemeral.

REST API (`server/src/routes/api.js`): `GET /api/agents`, `GET /api/agents/:id`, `GET /api/agents/:id/messages`, `POST /api/agents/:id/message`, `GET /api/health`, `GET /api/stats`.

Static middleware (`server/src/middleware/static.js`) serves `frontend/dist/` in production, with SPA fallback to `index.html` (skipping `/api/` and `/socket.io/` paths).

### Worker (`worker/`)

Entry: `worker/src/index.js` — the `Worker` class orchestrates initialization: parse CLI args → load config (priority: CLI > env > config.json > defaults) → collect system info → connect to server → register agent → start heartbeat.

Key modules:
- **SocketClient** (`worker/src/client/socket-client.js`) — wraps socket.io-client with manual exponential-backoff reconnection (Socket.io's built-in reconnection disabled). Exposes callback-based API (`onMessage`, `onClaudeExecute`, etc.).
- **ClaudeCodeExecutor** (`worker/src/executor/claude-code.js`) — spawns `claude` CLI via `cross-spawn`. Returns an `AsyncGenerator` for streaming stdout/stderr. Supports timeout (SIGTERM → SIGKILL after 5s) and per-task cancellation via `activeTasks` Map. Arguments: `claude <prompt>` with optional `--file` flags.
- **CommandRunner** (`worker/src/executor/command-runner.js`) — generic command execution via `cross-spawn`. Auto-detects shell need (cmd on Windows, sh on Unix). Returns Promise with stdout/stderr.
- **SystemInfoCollector** (`worker/src/collector/system-info.js`) — collects static info (CPU, memory, network, Claude Code version, capabilities) and dynamic metrics (CPU%, memory%, disk%). Has graceful fallbacks when optional deps (`os-utils`, `node-disk-info`) are missing.
- **FileTransfer** (`worker/src/file-handler/file-transfer.js`) — handles sending (chunked reads from disk) and receiving (chunked writes via `appendFileSync`). Stores received files in `workDir/received/`.
- **ConfigLoader** (`worker/src/config/loader.js`) — merges config from CLI args > env vars (prefixed `AGENT_`) > `config.json` > hardcoded defaults.

### Frontend (`frontend/`)

Entry: `frontend/src/main.js` — Vue 3 + Pinia + Tailwind CSS. Vite dev server proxies `/api` and `/socket.io` to `localhost:3000`.

Single page app with one view: `Dashboard.vue`. The layout is: top nav bar → sidebar (AgentList) → main area (ChatRoom + collapsible StatusMonitor) → bottom status bar.

Pinia store (`frontend/src/stores/socket.js`) is the single source of truth: manages socket connection, agents array, messages array, transfers array, and system stats. All socket events update the store; components are purely reactive.

Component tree:
- `AgentList.vue` — search/filter agents, context menu for role assignment, status indicators with CPU/memory bars
- `ChatRoom.vue` — message list (rendered via `MessagePanel.vue`), text input with @mention support, BTW toggle, file drop zone, drag-and-drop file upload
- `MessagePanel.vue` — renders different message types (text, role-assign, task-assign, status-query, response, file-notice, system) with distinct styling. BTW messages get amber highlighting
- `FileTransfer.vue` — file selection (click or drag), transfer list with progress bars, uses simulated progress (real progress would come from socket events)
- `StatusMonitor.vue` — expandable bottom panel with heartbeat latency chart, CPU/memory gauges for selected agent, message statistics

Utilities (`frontend/src/utils/format.js`): date formatting (dayjs with zh-cn locale), file size, duration, platform icons (emoji), status labels (Chinese).

### Socket.io Protocol

All communication goes through the default namespace `/`. Key event flows:

1. **Registration**: Worker → `agent:register` → Server stores in agentStore → replies `agent:registered` → broadcasts `agent:connected` + `agent:list`
2. **Heartbeat**: Worker → `heartbeat` (every 30s) → Server replies `heartbeat:ack` → broadcasts `heartbeat:update` to frontend
3. **Messaging**: Sender → `message` event → MessageRouter stores + routes → delivers `message:new` to target socket → confirms `message:delivered` to sender
4. **BTW**: Same as messaging but `type: 'btw'` with `metadata.isBtw: true` — amber-styled in UI, intended as non-blocking side queries
5. **Claude Code**: Server → `claude:execute` → Worker spawns `claude` CLI → streams output via `claude:output` → sends `claude:complete` on finish. Cancel via `claude:cancel`.
6. **File transfer**: Sender → `file:request` → Server asks receiver via `file:incoming` → receiver replies `file:response` → sender streams `file:chunk` (64KB base64) → Server relays to receiver + acks sender → `file:complete` on all chunks received
7. **Frontend** sends `join-dashboard` on connect to get initial state. Uses `send-message` to send chat messages.
