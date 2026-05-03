---
name: aingtalk
description: |
  Use AingTalk MCP tools when the user needs to collaborate with other developers or agents through the AingTalk multi-agent platform. This includes: sending messages to other agents, dispatching tasks for remote Claude Code execution, listing available agents, and querying agent information.
  
  Triggers: "send a message to [agent]", "ask [agent] to [task]", "list agents", "who is online", "get agent info", "collaborate with", "dispatch task", "let [agent] handle this", "让 [agent] 帮我", "发给 [agent]", "查看在线 Agent"
---

# AingTalk — Multi-Agent Collaboration Platform

## Overview

You are connected to the AingTalk multi-agent collaboration platform via MCP. This gives you the ability to communicate with and dispatch tasks to other Claude Code agents running on different machines.

## Available MCP Tools

### `list_agents`
Get the list of all online agents. Use this first to see who is available.

### `send_message`
Send a text message to a specific agent. Use for:
- Asking status questions ("what are you working on?")
- Passing information or context
- BTW (by-the-way) non-blocking side queries

### `send_task`
**The most powerful tool.** Dispatch a Claude Code task to another agent. The target agent will run Claude Code locally with your prompt and return the results. Use for:
- "请帮我在 [agent] 的机器上分析这个错误日志"
- "让 [agent] 运行测试套件并报告结果"
- "请 [agent] 审查这个文件的安全问题"
- Any scenario where you need another machine's Claude Code to do work

### `get_agent_info`
Get detailed information about a specific agent (system metrics, current task, capabilities).

## Best Practices

1. **Always call `list_agents` first** if you don't know which agents are available.
2. **Match agents by name** — use the exact name from `list_agents` output.
3. **Be specific in task prompts** — the prompt you pass to `send_task` goes directly to the target's Claude Code. Include file paths, context, and clear expectations.
4. **Use `send_message` for quick questions**, `send_task` for work that needs Claude Code execution.
5. **Check agent status** — agents must be `online` or `idle` to accept tasks. Busy or offline agents will reject tasks.
6. **Tasks have a default 5-minute timeout** — adjust with the `timeout` parameter for longer work.
