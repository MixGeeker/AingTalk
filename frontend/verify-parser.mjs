// 临时验证脚本：直接 node 运行，不引 Vue / 不需要构建
// 覆盖：
//   1. ChunkParser 基本正确性（wire v1 / 原生 CC / 拼接 / 残片 / 非 JSON 兜底 stderr）
//   2. TaskAggregator._commit：每次 ingest 后 task / events 引用变化（响应式前置条件）
//   3. text / thinking 合并：同 messageId 用「替换最后一个 event」实现
//   4. tool_use / tool_result 配对挂载（且 useEvent 引用替换）
//   5. ingestComplete summary 写入 task.summary
//   6. ingestMessage 三路由：task-assign（pending → 关联）/ task-result / 独立消息
//
// 用法：node frontend/verify-parser.mjs

import { ChunkParser, TaskAggregator, summarizeTool, _internals } from './src/utils/claude-stream-parser.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    failures.push(name + (extra ? ' — ' + extra : ''))
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''))
  }
}

function group(name, fn) {
  console.log('\n[' + name + ']')
  fn()
}

// ---------------------------------------------------------------------------
group('ChunkParser', () => {
  const p = new ChunkParser()

  // wire v1
  const wire = JSON.stringify({ v: 1, kind: 'text', ts: 0, data: { text: 'hi', messageId: 'm1' } })
  let evs = p.parseChunk(wire + '\n')
  ok('wire v1 单行 → 1 事件', evs.length === 1 && evs[0].kind === 'text', JSON.stringify(evs))

  // 原生 CC assistant text
  const cc = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg1', content: [{ type: 'text', text: 'hello' }] }
  })
  evs = p.parseChunk(cc + '\n')
  ok('原生 CC assistant.text → 1 text', evs.length === 1 && evs[0].kind === 'text' && evs[0].data.text === 'hello')

  // 拼接（两个对象同一行，无分隔）
  const concat = cc + cc
  evs = p.parseChunk(concat)
  ok('拼接两个对象 → 2 事件', evs.length === 2, 'got=' + evs.length)

  // 跨 chunk 残片
  const half = cc.slice(0, 30)
  const rest = cc.slice(30)
  evs = p.parseChunk(half)
  ok('残片头 → 0 事件', evs.length === 0)
  evs = p.parseChunk(rest)
  ok('残片尾 → 1 事件', evs.length === 1 && evs[0].kind === 'text')

  // 非 JSON 行 → stderr
  const p2 = new ChunkParser()
  evs = p2.parseChunk('this is not json\nmore garbage\n')
  ok('多行非 JSON → 2 stderr', evs.length === 2 && evs.every(e => e.kind === 'stderr'),
    'got=' + JSON.stringify(evs.map(e => e.kind)))
})

// ---------------------------------------------------------------------------
group('TaskAggregator 响应式', () => {
  const agg = new TaskAggregator()

  const wire = (kind, data) => JSON.stringify({ v: 1, kind, ts: 0, data })

  // 初次 ingest 创建 task
  const t1 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: wire('init', { model: 'glm-5.1' }) + '\n' })
  ok('首次 ingest 返回 task', !!t1 && t1.id === 'T1' && t1.model === 'glm-5.1')
  const eventsRef1 = t1.events

  // 二次 ingest：task / events 引用必须变化
  const t2 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: wire('text', { text: 'hi', messageId: 'm1' }) + '\n' })
  ok('_commit：task 引用变化', t1 !== t2)
  ok('_commit：events 数组引用变化', eventsRef1 !== t2.events)
  ok('_commit：events 长度 = 2 (init + text)', t2.events.length === 2)

  // text 合并：同 messageId 第二条 → 不增加 event 数，但「最后一个 event 引用必须变化」
  const lastBefore = t2.events[t2.events.length - 1]
  const t3 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: wire('text', { text: ' world', messageId: 'm1' }) + '\n' })
  const lastAfter = t3.events[t3.events.length - 1]
  ok('text 合并：events 长度仍为 2', t3.events.length === 2)
  ok('text 合并：最后一个 event 引用变化', lastBefore !== lastAfter)
  ok('text 合并：text 拼接正确', lastAfter.data.text === 'hi world')

  // thinking 合并
  const t4 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: wire('thinking', { text: 'think A' }) + '\n' })
  ok('thinking 追加：events 长度 3', t4.events.length === 3)
  const thinkBefore = t4.events[t4.events.length - 1]
  const t5 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: wire('thinking', { text: ' B' }) + '\n' })
  const thinkAfter = t5.events[t5.events.length - 1]
  ok('thinking 合并：长度仍为 3', t5.events.length === 3)
  ok('thinking 合并：引用变化', thinkBefore !== thinkAfter)
  ok('thinking 合并：text 拼接', thinkAfter.data.text === 'think A B')

  // tool_use + tool_result 配对（useEvent 也应被替换为新引用）
  const useChunk = wire('tool_use', { id: 'tu1', name: 'Bash', input: { command: 'ls' } }) + '\n'
  const t6 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: useChunk })
  const useIdx = t6.events.findIndex(e => e.kind === 'tool_use' && e.data.id === 'tu1')
  const useBefore = t6.events[useIdx]
  ok('tool_use 入流', useIdx >= 0 && !useBefore.result)

  const resChunk = wire('tool_result', { toolUseId: 'tu1', isError: false, output: 'a\nb\n' }) + '\n'
  const t7 = agg.ingestOutput({ taskId: 'T1', agentId: 'A1', chunk: resChunk })
  const useAfter = t7.events[useIdx]
  ok('tool_use 引用替换', useAfter !== useBefore)
  ok('tool_use.result 已挂载', !!useAfter.result && useAfter.result.data.output === 'a\nb\n')
  const tailEvent = t7.events[t7.events.length - 1]
  ok('tool_result 入流并标记 pairedWith', tailEvent.kind === 'tool_result' && tailEvent.pairedWith === 'tu1')
})

// ---------------------------------------------------------------------------
group('ingestComplete summary', () => {
  const agg = new TaskAggregator()
  agg.ingestOutput({ taskId: 'T2', agentId: 'A1', chunk: JSON.stringify({ v: 1, kind: 'init', ts: 0, data: {} }) + '\n' })
  const t = agg.ingestComplete({ taskId: 'T2', exitCode: 0, duration: 1234, sessionId: 'sess', summary: '总结内容' })
  ok('summary 写入 task', !!t && t.summary === '总结内容')
  ok('status → success', t.status === 'success')
  ok('durationMs', t.durationMs === 1234)
})

// ---------------------------------------------------------------------------
group('ingestMessage 路由', () => {
  const agg = new TaskAggregator()

  // 1. task-assign 先到，task 后创建 → pending 路径
  const r1 = agg.ingestMessage({
    type: 'task-assign',
    from: 'AgentA',
    fromName: 'Alice',
    to: 'AgentB',
    metadata: { taskId: 'TX1', prompt: '请执行任务' },
    timestamp: 1000
  })
  ok('task-assign（task 不存在）→ pending，无 task/message 返回', !r1.task && !r1.message)
  // 创建 task → dispatch 自动绑定
  const created = agg.ingestOutput({ taskId: 'TX1', agentId: 'AgentB', chunk: JSON.stringify({ v: 1, kind: 'init', ts: 0, data: {} }) + '\n' })
  ok('pending dispatch 在 _ensureTask 时合并', !!created.dispatch && created.dispatch.fromName === 'Alice')

  // 2. task-result 后到，task 已存在 → 直接绑定
  const r2 = agg.ingestMessage({
    type: 'task-result',
    from: 'AgentB',
    to: 'AgentA',
    metadata: { taskId: 'TX1', fullResult: '完整结果' },
    timestamp: 2000
  })
  ok('task-result → task.report 已挂载', !!r2.task && r2.task.report?.content === '完整结果')

  // 3. 独立消息（text）
  const r3 = agg.ingestMessage({
    type: 'text',
    from: 'AgentA',
    to: 'AgentB',
    fromName: 'Alice',
    content: '你好',
    timestamp: 3000
  })
  ok('text 消息 → 独立 message', !!r3.message && r3.message.content === '你好')

  // 4. 独立消息（btw 广播）
  const r4 = agg.ingestMessage({
    type: 'btw',
    from: 'AgentA',
    to: null,
    content: '注意',
    metadata: { isBtw: true },
    timestamp: 4000
  })
  ok('btw 广播 → 独立 message', !!r4.message && r4.message.to === null)

  // getMessagesForAgent
  const msgsA = agg.getMessagesForAgent('AgentA')
  const msgsB = agg.getMessagesForAgent('AgentB')
  ok('AgentA 收到 2 条消息（text + 广播）', msgsA.length === 2, 'got=' + msgsA.length)
  ok('AgentB 收到 2 条消息（text + 广播）', msgsB.length === 2, 'got=' + msgsB.length)

  // 5. task-result 先到（pending report），task 后创建
  agg.ingestMessage({
    type: 'task-result',
    from: 'X',
    to: 'Y',
    metadata: { taskId: 'TX2', fullResult: 'pending result' },
    timestamp: 5000
  })
  const t2 = agg.ingestOutput({ taskId: 'TX2', agentId: 'Y', chunk: JSON.stringify({ v: 1, kind: 'init', ts: 0, data: {} }) + '\n' })
  ok('pending report 合并', !!t2.report && t2.report.content === 'pending result')
})

// ---------------------------------------------------------------------------
group('summarizeTool', () => {
  const r = summarizeTool('Bash', { command: 'ls -la' })
  ok('Bash 摘要包含 command', r.subtitle.includes('ls'))
  const r2 = summarizeTool('mcp__aingtalk__send_task', { target_agent: 'X', prompt: 'do it' })
  ok('mcp send_task 摘要', r2.title.toLowerCase().includes('send_task') || r2.title.includes('任务') || r2.subtitle.length > 0)
})

console.log('\n────────────────────────────────────')
console.log(`通过 ${pass}，失败 ${fail}`)
if (fail > 0) {
  console.log('失败列表：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
