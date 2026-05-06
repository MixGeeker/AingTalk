<template>
  <div class="task-card border border-slate-700/50 rounded bg-slate-900/50 mb-2 min-w-0 overflow-hidden">
    <!-- 卡片头 -->
    <div
      class="task-card-header flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 bg-slate-800/40 border-b border-slate-700/40 cursor-pointer select-none min-w-0"
      :class="headerStatusClass"
      @click="bodyExpanded = !bodyExpanded"
    >
      <span class="text-[10px] flex-shrink-0">{{ bodyExpanded ? '▼' : '▶' }}</span>
      <span class="flex-shrink-0 text-[10px] font-mono">{{ statusGlyph }}</span>
      <span class="flex-shrink-0 text-[11px] font-medium">任务 {{ shortTaskId }}</span>

      <span v-if="task.model" class="text-[10px] text-slate-400 flex-shrink-0 truncate min-w-0">· {{ task.model }}</span>
      <span v-if="task.numTurns > 0" class="text-[10px] text-slate-500 flex-shrink-0">· {{ task.numTurns }} turns</span>
      <span v-if="durationLabel" class="text-[10px] text-slate-500 flex-shrink-0">· {{ durationLabel }}</span>
      <span v-if="costLabel" class="text-[10px] text-amber-500 flex-shrink-0">· ${{ costLabel }}</span>
      <span class="text-[10px] flex-shrink-0" :class="statusBadgeClass">· {{ statusLabel }}</span>

      <span v-if="!bodyExpanded && previewText" class="text-[10px] text-slate-500 italic truncate min-w-0 ml-1">
        — {{ previewText }}
      </span>

      <div class="ml-auto flex items-center gap-1 flex-shrink-0">
        <button
          class="text-[10px] text-slate-500 hover:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-700/40"
          :title="allRawOpen ? '隐藏原始数据' : '展开全部原始'"
          @click.stop="allRawOpen = !allRawOpen"
        >{{ '</>' }}</button>
        <span class="text-[9px] text-slate-600 font-mono">{{ task.events.length }}/{{ task.rawLines.length }}</span>
      </div>
    </div>

    <!-- 卡片体：事件时间线 -->
    <div v-if="bodyExpanded" class="task-card-body px-2 py-1.5 min-w-0">
      <!-- 全部原始 JSON 模式 -->
      <div v-if="allRawOpen" class="min-w-0">
        <div class="text-[10px] text-slate-500 mb-1">原始 chunk 流（{{ task.rawLines.length }} 行）</div>
        <pre class="text-[10px] text-slate-400 whitespace-pre-wrap break-all bg-slate-950/80 border border-slate-700/40 rounded px-2 py-1 max-h-96 overflow-y-auto">{{ rawDump }}</pre>
      </div>

      <!-- 语义化事件流 -->
      <div v-else class="space-y-0.5 min-w-0">
        <div v-if="visibleEvents.length === 0" class="text-[10px] text-slate-600 italic py-1">
          等待输出...
        </div>
        <EventRow
          v-for="ev in visibleEvents"
          :key="ev.id"
          :event="ev"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import EventRow from './EventRow.vue'

const props = defineProps({
  task: { type: Object, required: true },
  defaultExpanded: { type: Boolean, default: true }
})

const bodyExpanded = ref(props.defaultExpanded)
const allRawOpen = ref(false)

const shortTaskId = computed(() => {
  const id = String(props.task.id || '')
  return id.length > 10 ? '#' + id.slice(-8) : '#' + id
})

const statusGlyph = computed(() => {
  switch (props.task.status) {
    case 'running': return '●'
    case 'success': return '✓'
    case 'error': return '✗'
    default: return '·'
  }
})

const statusLabel = computed(() => {
  switch (props.task.status) {
    case 'running': return '执行中'
    case 'success': return '完成'
    case 'error': return '失败'
    default: return '空闲'
  }
})

const headerStatusClass = computed(() => {
  switch (props.task.status) {
    case 'running': return 'text-emerald-400'
    case 'success': return 'text-emerald-500'
    case 'error': return 'text-rose-400'
    default: return 'text-slate-500'
  }
})

const statusBadgeClass = computed(() => {
  switch (props.task.status) {
    case 'running': return 'text-emerald-400'
    case 'success': return 'text-emerald-500'
    case 'error': return 'text-rose-400'
    default: return 'text-slate-500'
  }
})

const durationLabel = computed(() => {
  const ms = props.task.durationMs || (props.task.endedAt ? props.task.endedAt - props.task.startedAt : 0)
  if (!ms || ms <= 0) {
    if (props.task.status === 'running') {
      const live = Date.now() - (props.task.startedAt || Date.now())
      return formatDuration(live)
    }
    return ''
  }
  return formatDuration(ms)
})

const costLabel = computed(() => {
  const cost = props.task.totalCostUsd || 0
  if (!cost) return ''
  if (cost < 0.01) return '<0.01'
  return cost.toFixed(2)
})

const previewText = computed(() => {
  // 优先级：report 内容 > 最近 text > 最近 tool_use > dispatch prompt
  if (props.task.report?.content) return clip(props.task.report.content, 80)
  if (props.task.summary) return clip(props.task.summary, 80)
  const events = props.task.events
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind === 'text' && ev.data?.text) {
      return clip(ev.data.text, 80)
    }
    if (ev.kind === 'tool_use') {
      return `调用 ${ev.data?.name || 'tool'}`
    }
  }
  if (props.task.dispatch?.prompt) return '← ' + clip(props.task.dispatch.prompt, 80)
  return ''
})

const visibleEvents = computed(() => {
  const items = []

  // 头部虚拟事件：来源任务派发
  if (props.task.dispatch) {
    items.push({
      id: `__dispatch_${props.task.id}`,
      kind: 'task_dispatch',
      data: props.task.dispatch,
      ts: props.task.dispatch.ts,
      raw: ''
    })
  }

  // 中段：执行流（已配对的 tool_result 不单独渲染）
  for (const e of props.task.events) {
    if (e.kind === 'tool_result' && e.pairedWith) continue
    items.push(e)
  }

  // 尾部虚拟事件：任务回报（report 优先，其次 summary）
  if (props.task.report) {
    items.push({
      id: `__report_${props.task.id}`,
      kind: 'task_report',
      data: props.task.report,
      ts: props.task.report.ts,
      raw: ''
    })
  } else if (props.task.summary) {
    items.push({
      id: `__report_${props.task.id}`,
      kind: 'task_report',
      data: { content: props.task.summary, toAgent: null, fromAgent: null, ts: props.task.endedAt || Date.now() },
      ts: props.task.endedAt || Date.now(),
      raw: ''
    })
  }

  return items
})

const rawDump = computed(() => {
  return props.task.rawLines.join('\n')
})

function clip(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim()
  return str.length > n ? str.slice(0, n) + '…' : str
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
</script>
