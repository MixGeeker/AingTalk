# REQ-001: MCP 端文件交换增强

## 背景

当前 AingTalk 的 MCP 模式只支持 4 个工具：`list_agents`、`send_message`、`send_task`、`get_agent_info`。加上刚实现的 `send_file`，MCP 端可以将本地文件推送给其他 Agent。

但实际协作场景中，还需要：

1. **Push 收文件**：Worker 端 Agent 完成任务后，需要主动将产物（日志、截图、构建输出等）发送给 MCP 端分析
2. **Pull 浏览/拉取**：MCP 端主动查看远程 Agent 的目录结构，选择性拉取需要的文件

当前 MCP 端无法接收文件，也无法浏览或拉取远程文件。

## 目标

为 MCP 模式新增 **4 个 Pull 工具 + 1 个 Push 收件工具**，实现 MCP ↔ Worker 双向文件交换的闭环。

### 新增 MCP 工具

| 工具 | 类型 | 描述 |
|------|------|------|
| `list_received_files` | Push 收件 | 查看已接收的文件列表（由其他 Agent 发来的文件） |
| `list_remote_dir` | Pull 浏览 | 列出远程 Agent 指定目录下的文件和子目录 |
| `get_remote_tree` | Pull 浏览 | 获取远程 Agent 指定目录的树形结构 |
| `pull_file` | Pull 拉取 | 从远程 Agent 拉取单个文件（≤100MB） |
| `pull_folder` | Pull 拉取 | 从远程 Agent 拉取整个文件夹（自动 zip 压缩，≤100MB） |

### 协议层新增

| 事件 | 方向 | 描述 |
|------|------|------|
| `command:execute:request` | MCP → Server → Worker | 请求远程 Worker 执行 shell 命令 |
| `command:execute:result` | Worker → Server → MCP | 返回命令执行结果（stdout/stderr/exitCode） |
| `file:incoming` 自动处理 | Server → MCP | MCP 端自动接受并保存入站文件 |

## 范围

### 在范围内

- MCP 端自动接受来自其他 Agent 的文件推送
- MCP 端查看已接收文件列表
- MCP 端列出远程目录内容（文件 + 子目录）
- MCP 端获取远程目录树形结构
- MCP 端拉取远程单个文件（走文件传输协议）
- MCP 端拉取远程文件夹（远程 zip → 文件传输协议）
- 文件大小限制 100MB（与现有 Worker 一致）
- 安全约束：远程命令白名单（只允许 `ls`/`dir`/`tree`/`find`/`zip`/`tar` 等只读/打包命令）

### 不在范围内

- MCP 端主动推送通知（MCP 协议限制，无法实现）
- 超过 100MB 的文件传输
- 实时文件同步/监控
- 删除/移动远程文件（写操作）
- 跨 Agent 的流式文件传输进度

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP 端 (Claude Code)                     │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │send_file │  │list_recv │  │list_dir  │  │pull_file     │   │
│  │(push)    │  │_files    │  │/ tree    │  │/ pull_folder │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       │              │              │               │            │
│       ▼              ▼              ▼               ▼            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              mcp-server.mjs (MCP + SocketClient)          │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐   │   │
│  │  │ FileTransfer│  │file:incoming│  │command:execute   │   │   │
│  │  │ (send only) │  │ auto-accept │  │ .request/.result │   │   │
│  │  └────────────┘  └────────────┘  └──────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │ Socket.io
                    ┌──────────┴──────────┐
                    │   AingTalk Server   │
                    │   (消息路由 + 转发)   │
                    └──────────┬──────────┘
                               │ Socket.io
                    ┌──────────┴──────────┐
                    │      Worker         │
                    │  ┌──────────────┐   │
                    │  │ CommandRunner │   │ ← ls / tree / zip
                    │  │ FileTransfer  │   │ ← send file back
                    │  └──────────────┘   │
                    └─────────────────────┘
```

## 非功能需求

- 命令执行超时：`ls`/`dir` ≤ 10s, `tree`/`find` ≤ 30s, `zip`/`tar` ≤ 120s
- 命令白名单：`ls`, `dir`, `tree`, `find`, `du`, `zip`, `tar`, `gzip`
- 禁止的命令：任何包含 `&&`, `;`, `|`, `>`, `<`, `$()`, `` ` `` 的命令（防注入）
- 远程路径验证：禁止 `..` 路径遍历、禁止访问系统敏感目录
