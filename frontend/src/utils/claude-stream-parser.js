/**
 * Claude Stream Parser — 前端容错解析器 + 任务聚合器
 *
 * 设计目标：
 *   1. 兼容 worker 端 wire format v1：`{ v: 1, kind, ts, data }`（理想格式）
 *   2. 兼容 CC 原始 stream-json 行：`{ type: 'assistant'|'user'|'system'|'result', ... }`
 *   3. 兼容多 JSON 拼接 / 半截 JSON：内部 buffer 累积 + NDJSON 切分
 *   4. 把事件聚合为 Task 模型，供 UI 直接消费
 *
 * 与 worker 端 event-encoder.js 的 mapRawCcEvent 保持语义一致（独立实现以避免跨端依赖）
 */

// ============================================================================
// 1. CC 原始 stream-json → wire format 事件 的兜底映射
// ============================================================================

/**
 * 把 CC 原始 stream-json 行映射为 0~N 个 wire format 事件
 * @param {Object} raw
 * @returns {Array<{ kind: string, data: any }>}
 */
function mapRawCcEvent(raw) {
  if (!raw || typeof raw !== 'object') return []
  const events = []
  const type = raw.type

  if (type === 'system' && raw.subtype === 'init') {
    events.push({
      kind: 'init',
      data: {
        model: raw.model || null,
        sessionId: raw.session_id || null,
        cwd: raw.cwd || null,
        tools: Array.isArray(raw.tools) ? raw.tools : undefined,
        mcpServers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers : undefined
      }
    })
    return events
  }

  if (type === 'assistant') {
    const msg = raw.message || raw
    const content = msg.content || []
    const messageId = msg.id || null
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'thinking' && block.thinking) {
        events.push({ kind: 'thinking', data: { text: block.thinking } })
      } else if (block.type === 'text' && block.text) {
        events.push({ kind: 'text', data: { text: block.text, messageId } })
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          data: {
            id: block.id || null,
            name: block.name || 'unknown',
            input: block.input != null ? block.input : {}
          }
        })
      }
    }
    return events
  }

  if (type === 'user') {
    const msg = raw.message || raw
    const content = msg.content || []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') {
        const output = stringifyToolResultContent(block.content)
        events.push({
          kind: 'tool_result',
          data: {
            toolUseId: block.tool_use_id || block.toolUseId || null,
            isError: !!block.is_error,
            output
          }
        })
      }
    }
    return events
  }

  if (type === 'result') {
    events.push({
      kind: 'result',
      data: {
        subtype: raw.subtype || 'success',
        isError: !!raw.is_error,
        durationMs: raw.duration_ms || 0,
        durationApiMs: raw.duration_api_ms || 0,
        numTurns: raw.num_turns || 0,
        totalCostUsd: raw.total_cost_usd || 0,
        sessionId: raw.session_id || null,
        summary: typeof raw.result === 'string' ? raw.result : ''
      }
    })
    return events
  }

  return events
}

function stringifyToolResultContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (c == null) return ''
        if (typeof c === 'string') return c
        if (typeof c.text === 'string') return c.text
        try { return JSON.stringify(c) } catch { return String(c) }
      })
      .join('\n')
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  return String(content)
}

// ============================================================================
// 2. NDJSON splitter — 多 JSON 拼接 / 半截 JSON 的兜底
// ============================================================================

/**
 * 把可能含多个拼接 JSON 对象的字符串切分为单个对象数组。
 * 支持顶层 `}{` 直连、被换行隔开、以及无效尾部。
 *
 * @param {string} input
 * @returns {{ objects: string[], remainder: string }}
 *   - objects: 已成功提取的完整 JSON 子串
 *   - remainder: 无法判定结束的尾部（可能是半截 JSON，等待下一次 chunk 拼接）
 */
function splitJsonObjects(input) {
  const objects = []
  let i = 0
  const n = input.length
  let remainder = ''

  while (i < n) {
    // 跳过空白
    while (i < n && (input[i] === ' ' || input[i] === '\t' || input[i] === '\n' || input[i] === '\r')) {
      i++
    }
    if (i >= n) break

    if (input[i] !== '{' && input[i] !== '[') {
      // 顶层非 JSON 字符 — 视为剩余无效输入，整段挂回 remainder（避免无限循环）
      remainder = input.slice(i)
      break
    }

    const start = i
    let depth = 0
    let inStr = false
    let escape = false
    let closed = false
    for (; i < n; i++) {
      const ch = input[i]
      if (inStr) {
        if (escape) {
          escape = false
        } else if (ch === '\\') {
          escape = true
        } else if (ch === '"') {
          inStr = false
        }
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) {
          objects.push(input.slice(start, i + 1))
          i++
          closed = true
          break
        }
      }
    }
    if (!closed) {
      // 半截对象：挂入 remainder 等下次拼接
      remainder = input.slice(start)
      break
    }
  }

  return { objects, remainder }
}

// ============================================================================
// 3. parseChunk — 单个 chunk → 0~N 个标准事件
// ============================================================================

/**
 * 把 raw 对象归一化为 wire format 事件
 *   - 已经是 { v:1, kind, data } → 直接接受
 *   - CC 原始 stream-json 行 → 走 mapRawCcEvent
 *   - 其他 → 包成 stderr / 忽略
 * @param {Object} raw
 * @returns {Array<{ kind, data, ts? }>}
 */
function normalizeRawObject(raw) {
  if (!raw || typeof raw !== 'object') return []

  // wire format v1
  if (raw.v === 1 && typeof raw.kind === 'string') {
    return [{ kind: raw.kind, data: raw.data || {}, ts: raw.ts }]
  }

  // CC 原始 stream-json
  if (typeof raw.type === 'string') {
    return mapRawCcEvent(raw)
  }

  return []
}

/**
 * 流式解析器（有内部 buffer，支持半截 JSON 跨 chunk 拼接）
 */
export class ChunkParser {
  constructor() {
    this._buffer = ''
  }

  /**
   * 解析一个 chunk，返回事件数组
   * @param {string} chunk
   * @returns {Array<{ kind, data, ts?, raw: string }>}
   */
  parseChunk(chunk) {
    if (chunk == null) return []
    const text = String(chunk)
    if (!text) return []

    const results = []

    // 单行快速路径：buffer 空 + 无换行 + 整体能 JSON.parse
    if (this._buffer === '' && text.indexOf('\n') === -1 && text.indexOf('\r') === -1) {
      const trimmed = text.trim()
      if (!trimmed) return []
      try {
        const raw = JSON.parse(trimmed)
        for (const ev of normalizeRawObject(raw)) {
          results.push({ ...ev, raw: trimmed })
        }
        return results
      } catch {
        // 落到通用路径
      }
    }

    // 通用路径：累积到 buffer，按 splitJsonObjects 在顶层 JSON 边界切分
    this._buffer += text

    // 先消费 buffer 里能切出的所有完整 JSON
    const split = splitJsonObjects(this._buffer)
    for (const obj of split.objects) {
      this._tryDecodeAndPush(obj, results)
    }
    this._buffer = split.remainder

    // 处理 remainder：
    //   - 以 `{` 或 `[` 开头且未闭合 → 半截 JSON，保留到下次拼接
    //   - 以其他字符开头 → 永远不可能成为合法 JSON，立即作为 stderr 释放
    if (this._buffer) {
      const trimmedStart = this._buffer.replace(/^\s+/, '')
      if (trimmedStart && trimmedStart[0] !== '{' && trimmedStart[0] !== '[') {
        const lines = this._buffer.split(/\r?\n/)
        for (const line of lines) {
          if (line.trim()) {
            results.push({
              kind: 'stderr',
              data: { text: line },
              raw: line
            })
          }
        }
        this._buffer = ''
      }
    }

    return results
  }

  /**
   * 尝试 JSON.parse 一个片段，成功则归一化推入结果，失败则尝试 splitJsonObjects 兜底，
   * 仍失败则作为 stderr 推入。
   * @private
   */
  _tryDecodeAndPush(seg, results) {
    const trimmed = seg.trim()
    if (!trimmed) return
    try {
      const raw = JSON.parse(trimmed)
      for (const ev of normalizeRawObject(raw)) {
        results.push({ ...ev, raw: trimmed })
      }
      return
    } catch {
      // fallthrough
    }

    const sub = splitJsonObjects(trimmed)
    for (const obj of sub.objects) {
      try {
        const raw = JSON.parse(obj)
        for (const ev of normalizeRawObject(raw)) {
          results.push({ ...ev, raw: obj })
        }
      } catch {
        results.push({ kind: 'stderr', data: { text: obj }, raw: obj })
      }
    }
    if (sub.objects.length === 0) {
      results.push({ kind: 'stderr', data: { text: trimmed }, raw: trimmed })
    }
  }

  reset() {
    this._buffer = ''
  }
}

// ============================================================================
// 4. summarizeTool — 工具调用语义化
// ============================================================================

const KNOWN_TOOL_ICONS = {
  Bash: '$',
  Read: '📄',
  Edit: '✎',
  Write: '✎',
  Glob: '🔍',
  Grep: '🔍',
  Task: '🤖',
  TodoWrite: '☑',
  WebSearch: '🌐',
  WebFetch: '🌐',
  NotebookEdit: '📓'
}

const MCP_TOOL_LABELS = {
  send_message: '发消息',
  send_task: '派发任务',
  send_file: '发送文件',
  list_agents: '查询 Agent 列表',
  get_agent_info: '查询 Agent 信息',
  check_inbox: '检查收件箱',
  complete_task: '回报任务结果',
  continue_task: '继续任务',
  cancel_task: '取消任务',
  get_received_files: '查看已收文件'
}

/**
 * 截断字符串到指定长度，超出加省略号
 */
function clip(s, n = 80) {
  if (s == null) return ''
  const str = String(s).replace(/\s+/g, ' ').trim()
  return str.length > n ? str.slice(0, n) + '…' : str
}

/**
 * 工具语义摘要
 * @param {string} name
 * @param {*} input
 * @returns {{ icon: string, title: string, subtitle: string }}
 */
export function summarizeTool(name, input) {
  const safeName = name || 'unknown'
  const obj = (input && typeof input === 'object') ? input : {}

  // 内置工具
  if (safeName === 'Bash') {
    return { icon: '$', title: 'Bash', subtitle: clip(obj.command || obj.cmd) }
  }
  if (safeName === 'Read') {
    return { icon: '📄', title: 'Read', subtitle: clip(obj.file_path || obj.path) }
  }
  if (safeName === 'Edit') {
    return { icon: '✎', title: 'Edit', subtitle: clip(obj.file_path || obj.path) }
  }
  if (safeName === 'Write') {
    return { icon: '✎', title: 'Write', subtitle: clip(obj.file_path || obj.path) }
  }
  if (safeName === 'Glob') {
    return { icon: '🔍', title: 'Glob', subtitle: clip(obj.pattern || obj.glob) }
  }
  if (safeName === 'Grep') {
    const pat = obj.pattern || ''
    const path = obj.path || obj.glob ? ` · ${obj.path || obj.glob}` : ''
    return { icon: '🔍', title: 'Grep', subtitle: clip(`${pat}${path}`) }
  }
  if (safeName === 'Task') {
    return { icon: '🤖', title: 'Task', subtitle: clip(obj.description || obj.prompt) }
  }
  if (safeName === 'TodoWrite') {
    const n = Array.isArray(obj.todos) ? obj.todos.length : 0
    return { icon: '☑', title: 'TodoWrite', subtitle: `${n} 项 todo` }
  }
  if (safeName === 'WebSearch') {
    return { icon: '🌐', title: 'WebSearch', subtitle: clip(obj.query) }
  }
  if (safeName === 'WebFetch') {
    return { icon: '🌐', title: 'WebFetch', subtitle: clip(obj.url) }
  }

  // MCP 工具：mcp__<server>__<tool>
  const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(safeName)
  if (mcpMatch) {
    const server = mcpMatch[1]
    const tool = mcpMatch[2]
    const label = MCP_TOOL_LABELS[tool] || tool
    let subtitle = ''
    if (tool === 'send_message' || tool === 'send_task') {
      subtitle = clip(obj.target_agent || obj.targetAgent || obj.agent || '')
      if (obj.message || obj.task || obj.prompt) {
        subtitle += subtitle ? ' · ' : ''
        subtitle += clip(obj.message || obj.task || obj.prompt, 60)
      }
    } else if (tool === 'complete_task' || tool === 'continue_task' || tool === 'cancel_task') {
      subtitle = clip(obj.task_id || obj.taskId || '')
    } else if (tool === 'send_file') {
      subtitle = clip(obj.file_path || obj.path || obj.target_agent || '')
    } else {
      subtitle = clip(safeJsonStringify(obj), 80)
    }
    return { icon: '🔌', title: `${server}/${label}`, subtitle }
  }

  // 未知工具
  const icon = KNOWN_TOOL_ICONS[safeName] || '🔧'
  return {
    icon,
    title: safeName,
    subtitle: clip(safeJsonStringify(obj), 80)
  }
}

function safeJsonStringify(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// ============================================================================
// 5. TaskAggregator — 把流式事件聚合为 Task 模型
// ============================================================================

/**
 * 任务聚合器：维护 taskId → Task 的映射
 *
 * 事件入口：
 *   - ingestOutput({ taskId, agentId, chunk })
 *   - ingestComplete({ taskId, exitCode, duration, sessionId })
 *
 * Task 形状：
 *   {
 *     id, agentId, status: 'running'|'success'|'error',
 *     startedAt, endedAt,
 *     model, sessionId, totalCostUsd, durationMs, numTurns,
 *     events: [{ id, kind, data, ts, raw }],
 *     rawLines: [string]
 *   }
 *
 * 事件后处理：
 *   - 同 messageId 的连续 text 在拉取 Task.events 时合并
 *   - tool_use 与 tool_result 通过 toolUseId 在 events 中互相挂钩
 */
export class TaskAggregator {
  constructor({ maxTasks = 50, maxRawLinesPerTask = 5000 } = {}) {
    this._tasks = new Map() // taskId -> Task
    this._order = []        // 插入顺序的 taskId 数组
    this._parsers = new Map() // taskId -> ChunkParser
    this._eventCounter = 0
    this.maxTasks = maxTasks
    this.maxRawLinesPerTask = maxRawLinesPerTask
  }

  /**
   * 处理一个 claude:output 事件
   * @returns {Task | null} 受影响的 Task（用于触发响应式更新），不存在则 null
   */
  ingestOutput({ taskId, agentId, chunk }) {
    if (!taskId) return null
    const task = this._ensureTask(taskId, agentId)

    // 保留原始 chunk（用于"全展开原始"按钮）
    if (task.rawLines.length < this.maxRawLinesPerTask) {
      task.rawLines.push(typeof chunk === 'string' ? chunk : String(chunk))
    }

    let parser = this._parsers.get(taskId)
    if (!parser) {
      parser = new ChunkParser()
      this._parsers.set(taskId, parser)
    }

    const events = parser.parseChunk(chunk)
    for (const ev of events) {
      this._appendEvent(task, ev)
    }
    task.lastChunkAt = Date.now()
    return task
  }

  /**
   * 处理一个 claude:complete 事件
   */
  ingestComplete({ taskId, exitCode, duration, sessionId }) {
    if (!taskId) return null
    const task = this._tasks.get(taskId)
    if (!task) return null
    task.status = exitCode === 0 ? 'success' : 'error'
    task.exitCode = exitCode ?? -1
    task.endedAt = Date.now()
    if (duration != null) task.durationMs = duration
    if (sessionId && !task.sessionId) task.sessionId = sessionId
    this._parsers.delete(taskId)
    return task
  }

  /**
   * 获取某个 agent 的任务列表（按 startedAt 升序）
   */
  getTasksForAgent(agentId) {
    const list = []
    for (const id of this._order) {
      const t = this._tasks.get(id)
      if (t && t.agentId === agentId) list.push(t)
    }
    return list
  }

  getTask(taskId) {
    return this._tasks.get(taskId) || null
  }

  removeTask(taskId) {
    if (!this._tasks.has(taskId)) return
    this._tasks.delete(taskId)
    this._order = this._order.filter(id => id !== taskId)
    this._parsers.delete(taskId)
  }

  clearAgent(agentId) {
    const toRemove = this._order.filter(id => this._tasks.get(id)?.agentId === agentId)
    for (const id of toRemove) this.removeTask(id)
  }

  // ---- 内部 ----

  _ensureTask(taskId, agentId) {
    let task = this._tasks.get(taskId)
    if (!task) {
      task = {
        id: taskId,
        agentId: agentId || null,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        lastChunkAt: Date.now(),
        exitCode: null,
        model: null,
        sessionId: null,
        totalCostUsd: 0,
        durationMs: 0,
        numTurns: 0,
        cwd: null,
        events: [],
        toolUseIndex: new Map(), // toolUseId -> events 数组下标
        rawLines: []
      }
      this._tasks.set(taskId, task)
      this._order.push(taskId)
      // LRU 淘汰
      while (this._order.length > this.maxTasks) {
        const oldId = this._order.shift()
        this._tasks.delete(oldId)
        this._parsers.delete(oldId)
      }
    } else if (agentId && !task.agentId) {
      task.agentId = agentId
    }
    return task
  }

  _appendEvent(task, ev) {
    const id = ++this._eventCounter
    const ts = ev.ts || Date.now()

    // 元数据收集
    if (ev.kind === 'init') {
      task.model = ev.data?.model || task.model
      task.sessionId = ev.data?.sessionId || task.sessionId
      task.cwd = ev.data?.cwd || task.cwd
    } else if (ev.kind === 'result') {
      task.totalCostUsd = ev.data?.totalCostUsd ?? task.totalCostUsd
      task.durationMs = ev.data?.durationMs ?? task.durationMs
      task.numTurns = ev.data?.numTurns ?? task.numTurns
      task.sessionId = ev.data?.sessionId || task.sessionId
      if (ev.data?.isError) task.status = 'error'
    }

    // text 合并：同 messageId 的连续 text 直接追加到上一条
    if (ev.kind === 'text') {
      const last = task.events[task.events.length - 1]
      const sameMsg = last && last.kind === 'text' &&
        (last.data?.messageId || null) === (ev.data?.messageId || null)
      if (sameMsg) {
        last.data.text = (last.data.text || '') + (ev.data?.text || '')
        last.raw = ev.raw  // 保留最新一条原始 JSON 行（用于查看）
        return
      }
    }

    // thinking 合并：相邻 thinking 也合并（CC 通常会拆分多个 chunk）
    if (ev.kind === 'thinking') {
      const last = task.events[task.events.length - 1]
      if (last && last.kind === 'thinking') {
        last.data.text = (last.data.text || '') + (ev.data?.text || '')
        last.raw = ev.raw
        return
      }
    }

    const entry = {
      id,
      kind: ev.kind,
      data: ev.data || {},
      ts,
      raw: ev.raw || ''
    }

    if (ev.kind === 'tool_use') {
      const toolUseId = ev.data?.id
      if (toolUseId) {
        task.toolUseIndex.set(toolUseId, task.events.length)
      }
    } else if (ev.kind === 'tool_result') {
      const toolUseId = ev.data?.toolUseId
      if (toolUseId && task.toolUseIndex.has(toolUseId)) {
        const useIdx = task.toolUseIndex.get(toolUseId)
        const useEvent = task.events[useIdx]
        if (useEvent) {
          useEvent.result = entry  // 把 result 挂在对应 tool_use 上（UI 渲染时一起展示）
          // 同时仍然 push 到 events 末尾用于"严格时序"展示，但带上 paired 标记
          entry.pairedWith = toolUseId
        }
      }
    }

    task.events.push(entry)
  }
}

// 导出底层工具，便于单测/调试
export const _internals = {
  mapRawCcEvent,
  splitJsonObjects,
  normalizeRawObject,
  stringifyToolResultContent
}
