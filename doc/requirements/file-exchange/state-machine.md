# REQ-001 状态机

## 1. 文件 Push 接收状态机 (Worker → MCP)

远程 Worker 主动发文件，MCP 端自动接收。

```
                        ┌──────────┐
                        │   IDLE   │
                        └────┬─────┘
                             │ file:incoming (Server 通知有新文件)
                             ▼
                    ┌────────────────┐
                    │   VALIDATING   │
                    │ 检查类型、大小  │
                    └───┬────────┬───┘
                        │        │
           验证通过     │        │  验证失败 (类型不支持/超限)
                        │        ▼
                        │  ┌─────────────┐
                        │  │   REJECTED   │ ──► IDLE
                        │  │ 发送拒绝响应  │
                        │  └─────────────┘
                        ▼
                 ┌──────────────┐
                 │  ACCEPTING   │
                 │ 发送接受响应   │
                 │ 创建空文件     │
                 └──────┬───────┘
                        │ file:chunk (每个块 64KB)
                        ▼
                 ┌──────────────┐
                 │  RECEIVING   │◄──────────────┐
                 │ 缓存块数据     │               │
                 │ 按 index 存储  │─── chunk:ack ─┘
                 └──────┬───────┘    (继续接收)
                        │
           全部块到齐？  │
        ┌───────────────┼──────────────┐
        │ 否            │              │ 是
        ▼               │              ▼
   (继续 RECEIVING)     │     ┌──────────────┐
                        │     │  COMPLETING  │
                        │     │ 按序拼接写入   │
                        │     │ 清理缓存      │
                        │     └──────┬───────┘
                        │            │
                        │            ▼
                        │     ┌──────────────┐
                        │     │     DONE     │
                        │     │ 发送完成确认   │
                        │     │ 记录到列表    │
                        │     └──────┬───────┘
                        │            │
                        │            ▼
                        │        (IDLE)
                        │
                        │  传输中错误 (断连/超时)
                        ▼
                 ┌──────────────┐
                 │    ERROR     │
                 │ 清理部分文件   │
                 │ 记录错误日志   │
                 └──────┬───────┘
                        │
                        ▼
                      (IDLE)
```

---

## 2. 文件 Pull 拉取状态机 (MCP → Worker)

MCP 主动从远程 Worker 拉取文件或文件夹。

```
                        ┌──────────┐
                        │   IDLE   │
                        └────┬─────┘
                             │ MCP 调用 pull_file / pull_folder
                             ▼
                    ┌────────────────┐
                    │   REQUESTING   │
                    │ 查找目标 Agent   │
                    │ 验证参数合法性   │
                    └───┬────────┬───┘
                        │        │
           目标在线     │        │  目标离线 / 找不到
                        │        ▼
                        │  ┌─────────────┐
                        │  │    ERROR    │ ──► IDLE
                        │  │ (Agent 离线) │
                        │  └─────────────┘
                        ▼
                 ┌──────────────────┐
                 │  COMMAND_SENDING │
                 │ 发送命令到 Worker  │
                 │ pull_file: 读文件  │
                 │ pull_folder: zip  │
                 └──────┬───────────┘
                        │ command:execute:request
                        ▼
                 ┌──────────────────┐
                 │  AWAITING_RESULT │
                 │ 等待 Worker 响应   │
                 └───┬──────────┬───┘
                     │          │
        Worker 成功  │          │  Worker 失败 (文件不存在/zip 失败/超时)
                     │          ▼
                     │   ┌─────────────┐
                     │   │    ERROR    │ ──► IDLE
                     │   │ 返回错误详情  │
                     │   └─────────────┘
                     ▼
              ┌──────────────────┐
              │ FILE_TRANSFERRING│
              │ Worker 发送文件    │
              │ (复用 Push 流程)  │
              └──────┬───────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
    传输成功    传输失败      文件超限
         │           │           │
         ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │  DONE   │ │  ERROR  │ │  ERROR  │
   │ 文件入   │ │ 清理    │ │ 超限提示 │
   │ received│ │         │ │         │
   └────┬────┘ └────┬────┘ └────┬────┘
        │           │           │
        ▼           ▼           ▼
      (IDLE)      (IDLE)      (IDLE)
```

---

## 3. 远程命令执行状态机 (Worker 端)

Worker 收到 MCP 发来的命令执行请求。

```
                        ┌──────────┐
                        │   IDLE   │
                        │ 等待指令  │
                        └────┬─────┘
                             │ command:execute:request (from Server)
                             ▼
                    ┌────────────────┐
                    │  AUTH_CHECKING │
                    │ 检查命令白名单   │
                    │ 检查路径合法性   │
                    │ 检查元字符注入   │
                    └───┬────────┬───┘
                        │        │
           检查通过     │        │  检查不通过
                        │        ▼
                        │  ┌──────────────────┐
                        │  │     REJECTED     │
                        │  │ 返回拒绝原因       │
                        │  │ (命令/路径不安全)  │
                        │  └──────────────────┘
                        │        │
                        ▼        ▼
                 ┌──────────────┐  (IDLE)
                 │  EXECUTING   │
                 │ CommandRunner │
                 │ 启动子进程     │
                 └──────┬───────┘
                        │
              ┌─────────┼─────────┐
              │         │         │
         正常退出   非零退出   超时/异常
              │         │         │
              ▼         ▼         ▼
        ┌─────────┐┌─────────┐┌─────────┐
        │ SUCCESS ││ FAILURE ││ TIMEOUT │
        │ stdout  ││ stderr  ││ SIGTERM │
        │ +exit=0 ││ +exit≠0 ││ +SIGKILL│
        └────┬────┘└────┬────┘└────┬────┘
             │          │          │
             └──────────┼──────────┘
                        │ 发送 command:execute:result
                        │ { exitCode, stdout, stderr, duration }
                        ▼
                      (IDLE)
```

---

## 4. MCP 端接收文件生命周期

```
┌──────────────────────────────────────────────────┐
│                received/ 目录                     │
│                                                  │
│  文件状态:  .receiving/  (接收中的临时目录)       │
│             .tmp/<fileId> (未完成的文件)          │
│             <fileId>_<safeName> (已完成的文件)     │
│                                                  │
│  ┌────────────┐    ┌────────────┐   ┌─────────┐ │
│  │ PENDING    │───►│ RECEIVING  │──►│ ACTIVE  │ │
│  │ (已接受)    │    │ (收块中)    │   │ (已完成) │ │
│  └────────────┘    └────────────┘   └────┬────┘ │
│                                          │      │
│                                  30 分钟后 │      │
│                                          ▼      │
│                                    ┌─────────┐ │
│                                    │ CLEANED │ │
│                                    │ (自动清理)│ │
│                                    └─────────┘ │
└──────────────────────────────────────────────────┘
```

## 5. 状态转换触发事件汇总

| 状态转换 | 触发事件 | 来源 |
|----------|---------|------|
| IDLE → VALIDATING | `file:incoming` | Server (由远程 Worker 发起) |
| VALIDATING → ACCEPTING | 验证通过 | 本地 |
| VALIDATING → REJECTED | 验证失败 | 本地 |
| ACCEPTING → RECEIVING | `file:chunk` | Server (转发自远程 Worker) |
| RECEIVING → COMPLETING | 所有块到齐 | 本地 |
| COMPLETING → DONE | 文件写入成功 | 本地 |
| IDLE → REQUESTING | MCP 工具调用 `pull_file` / `pull_folder` | Claude Code |
| REQUESTING → COMMAND_SENDING | 目标在线 + 参数合法 | 本地 |
| AWAITING_RESULT → FILE_TRANSFERRING | Worker 命令执行成功 | Worker |
| IDLE → AUTH_CHECKING | `command:execute:request` | Server |
| AUTH_CHECKING → EXECUTING | 安全检查通过 | Worker |
| AUTH_CHECKING → REJECTED | 安全风险 | Worker |
