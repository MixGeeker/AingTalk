/**
 * Wire format v1 编码器 — 统一 worker → 前端的 claude:output chunk 契约
 *
 * 每个 chunk 是一行 JSON：
 *   { "v": 1, "kind": "...", "ts": 1730000000000, "data": { ... } }
 *
 * kind 枚举：
 *   - init:        { model, sessionId?, cwd?, tools?, mcpServers? }
 *   - thinking:    { text }
 *   - text:        { text, messageId? }
 *   - tool_use:    { id, name, input }                   // input 保持原对象/字符串
 *   - tool_result: { toolUseId, isError, output }        // output 字符串
 *   - result:      { subtype, isError, durationMs, durationApiMs, numTurns,
 *                    totalCostUsd, sessionId, summary }
 *   - error:       { message }                           // 执行器/进程级错误
 *   - stderr:      { text }                              // CC stderr 透传
 *
 * 注：
 *   - 所有 chunk 必须是单行，禁止内嵌未转义换行（socket-client 处加断言）。
 *   - tool_result.output 的截断阈值由调用方自行控制；编码器不截断。
 */

const WIRE_VERSION = 1;

const VALID_KINDS = new Set([
  'init',
  'thinking',
  'text',
  'tool_use',
  'tool_result',
  'result',
  'error',
  'stderr'
]);

/**
 * 编码单个事件为 wire format 字符串（单行 JSON）
 * @param {string} kind
 * @param {Object} data
 * @returns {string}
 */
function encodeEvent(kind, data) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`[event-encoder] 未知 kind: ${kind}`);
  }
  const payload = {
    v: WIRE_VERSION,
    kind,
    ts: Date.now(),
    data: data || {}
  };
  return JSON.stringify(payload);
}

/**
 * 把 ClaudeCodeExecutor 内部 yield 出的 { kind, data } 事件编码为 wire format
 * @param {{ kind: string, data: any }} event
 * @returns {string}
 */
function encodeFromYield(event) {
  if (!event || typeof event !== 'object') return null;
  if (!VALID_KINDS.has(event.kind)) return null;
  return encodeEvent(event.kind, event.data);
}

/**
 * 把 CC 原始 stream-json 行（如 { type: 'assistant', message: { content: [...] }, ... }）
 * 映射为 0~N 个 wire format 事件对象（{ kind, data }）。
 *
 * 同时被 worker 的 ClaudeCodeExecutor 和前端的容错解析器复用，保证两端语义一致。
 *
 * @param {Object} raw - CC 原始事件
 * @returns {Array<{ kind: string, data: any }>}
 */
function mapRawCcEvent(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const events = [];
  const type = raw.type;

  // system/init — 会话初始化
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
    });
    return events;
  }

  // assistant — 完整助手消息，content 含 thinking / text / tool_use blocks
  if (type === 'assistant') {
    const msg = raw.message || raw;
    const content = msg.content || [];
    const messageId = msg.id || null;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' && block.thinking) {
        events.push({ kind: 'thinking', data: { text: block.thinking } });
      } else if (block.type === 'text' && block.text) {
        events.push({ kind: 'text', data: { text: block.text, messageId } });
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          data: {
            id: block.id || null,
            name: block.name || 'unknown',
            input: block.input != null ? block.input : {}
          }
        });
      }
    }
    return events;
  }

  // user — 工具执行结果（tool_result 在 user 消息的 content 里）
  if (type === 'user') {
    const msg = raw.message || raw;
    const content = msg.content || [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        const output = stringifyToolResultContent(block.content);
        events.push({
          kind: 'tool_result',
          data: {
            toolUseId: block.tool_use_id || block.toolUseId || null,
            isError: !!block.is_error,
            output
          }
        });
      }
    }
    return events;
  }

  // result — 最终结果摘要
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
    });
    return events;
  }

  return events;
}

/**
 * tool_result.content 可能是字符串、对象数组、或单个对象，归一化为字符串
 * @param {*} content
 * @returns {string}
 */
function stringifyToolResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (c == null) return '';
        if (typeof c === 'string') return c;
        if (typeof c.text === 'string') return c.text;
        try {
          return JSON.stringify(c);
        } catch {
          return String(c);
        }
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

module.exports = {
  WIRE_VERSION,
  VALID_KINDS,
  encodeEvent,
  encodeFromYield,
  mapRawCcEvent,
  stringifyToolResultContent
};
