# REQ-001 用户故事

## 角色定义

| 角色 | 说明 |
|------|------|
| **MCP 用户** | 通过 Claude Code MCP 工具与 AingTalk 网络交互的用户，即"Agent A" |
| **远程 Worker** | 运行在开发机上的 Worker Agent，如"Agent B"，可执行 Claude Code 和 shell 命令 |
| **远程 Worker 用户** | 在 Worker 机器上工作的开发者 |

---

## US-01: MCP 端被动接收文件 (Push)

**作为** MCP 用户
**我想要** 在远程 Worker 完成调试后，能收到对方发来的日志文件和产物
**以便** 我能直接在本地分析报错原因，无需让对方手动复制粘贴日志内容

### 验收标准

1. WHEN 远程 Worker 通过 `send_file` 或前端向 MCP Agent 发送文件 THEN MCP 端自动接受并保存到 `received/` 目录
2. WHEN 文件接收完成 THEN MCP 端记录文件的名称、大小、来源、接收时间
3. WHEN MCP 用户调用 `list_received_files` THEN 返回所有已接收文件的信息列表
4. GIVEN 文件大小超过 100MB WHEN 远程 Worker 发起传输 THEN MCP 端应拒绝并返回明确错误
5. GIVEN 文件类型不在允许列表 WHEN 远程 Worker 发起传输 THEN MCP 端应拒绝

### 优先级

P0 — 这是双向文件交换的基石

---

## US-02: 浏览远程目录

**作为** MCP 用户
**我想要** 查看远程 Worker 机器上某个目录的内容
**以便** 我能了解对方的项目结构，定位需要拉取的文件

### 验收标准

1. WHEN 调用 `list_remote_dir` 并指定目标 Agent 和路径 THEN 返回该目录下的文件和子目录列表（含名称、大小、类型、修改时间）
2. GIVEN 路径不存在 WHEN 调用 `list_remote_dir` THEN 返回明确的错误消息
3. GIVEN 路径是文件而非目录 WHEN 调用 `list_remote_dir` THEN 返回该文件的详细信息
4. WHEN 不指定路径 THEN 默认使用远程 Agent 的工作目录 (`workDir`)
5. GIVEN 目标 Agent 离线 WHEN 调用 `list_remote_dir` THEN 返回错误提示 Agent 不在线

### 优先级

P1 — 浏览是拉取的先决条件

---

## US-03: 获取远程目录树

**作为** MCP 用户
**我想要** 查看远程 Worker 机器上某个目录的完整树形结构
**以便** 我能快速了解项目的整体布局，而不必逐层进入子目录

### 验收标准

1. WHEN 调用 `get_remote_tree` 并指定目录路径 THEN 返回树形结构文本（类似 `tree` 命令输出）
2. WHEN 指定 `depth` 参数 THEN 限制树的展开深度
3. GIVEN 目录包含大量文件 WHEN `depth` 较浅 THEN 结果仍应在 30 秒内返回
4. GIVEN 目标 Agent 离线 WHEN 调用 `get_remote_tree` THEN 返回错误

### 优先级

P1

---

## US-04: 拉取单个文件

**作为** MCP 用户
**我想要** 从远程 Worker 机器上拉取指定的单个文件
**以便** 我能直接分析对方的日志、配置、或代码，无需对方主动发送

### 验收标准

1. WHEN 调用 `pull_file` 指定目标 Agent 和文件路径 THEN 文件通过传输协议传回 MCP 端，保存到 `received/` 目录
2. GIVEN 文件大小 ≤ 100MB WHEN 调用 `pull_file` THEN 传输应成功完成
3. GIVEN 文件大小 > 100MB WHEN 调用 `pull_file` THEN 返回明确的大小超限错误
4. GIVEN 文件不存在 WHEN 调用 `pull_file` THEN 返回文件不存在错误
5. GIVEN 路径包含 `..` 或指向系统敏感目录 WHEN 调用 `pull_file` THEN 拒绝并返回安全错误
6. WHEN 传输过程中 Socket 断开 THEN 返回传输中断错误，部分文件被清理

### 优先级

P0 — 最核心的拉取场景

---

## US-05: 拉取文件夹（自动压缩）

**作为** MCP 用户
**我想要** 从远程 Worker 机器上拉取整个文件夹（自动压缩后传输）
**以便** 我能一次性获取对方项目的整个子目录，而不是逐个文件拉取

### 验收标准

1. WHEN 调用 `pull_folder` 指定目标 Agent 和文件夹路径 THEN 远程自动 zip 压缩，压缩包传回 MCP 端
2. GIVEN 压缩后大小 ≤ 100MB WHEN 调用 `pull_folder` THEN 传输应成功
3. GIVEN 压缩后大小 > 100MB WHEN 调用 `pull_folder` THEN 返回大小超限错误（在压缩完成后、传输前检查）
4. WHEN 文件夹为空 THEN 返回空压缩包
5. GIVEN 路径是文件而非文件夹 WHEN 调用 `pull_folder` THEN 返回错误，建议使用 `pull_file`
6. WHEN 传输完成后 THEN MCP 端保留压缩包，不解压（用户可自行解压分析）

### 优先级

P1

---

## US-06: 远程命令安全约束

**作为** 系统管理员
**我想要** MCP 端只能执行安全的只读/打包命令
**以便** 防止恶意 MCP 调用对远程 Worker 机器造成破坏

### 验收标准

1. WHEN 命令包含 shell 元字符（`&&`, `;`, `|`, `>`, `<`, `$()`, `` ` ``）THEN Worker 端应拒绝执行
2. WHEN 命令不在白名单内 THEN Worker 端应拒绝执行
3. WHEN 路径参数包含 `..` 或指向 `/etc`, `/sys`, `/proc`, `C:\Windows` 等敏感目录 THEN 拒绝执行
4. Worker 端应记录所有命令执行日志

### 优先级

P0 — 安全是必选项

---

## 故事优先级汇总

| 编号 | 标题 | 优先级 |
|------|------|--------|
| US-01 | MCP 端被动接收文件 | P0 |
| US-02 | 浏览远程目录 | P1 |
| US-03 | 获取远程目录树 | P1 |
| US-04 | 拉取单个文件 | P0 |
| US-05 | 拉取文件夹 | P1 |
| US-06 | 远程命令安全约束 | P0 |
