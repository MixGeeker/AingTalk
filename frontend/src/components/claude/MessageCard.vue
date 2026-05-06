<template>
  <div
    class="message-card border rounded mb-2 min-w-0 overflow-hidden bg-slate-900/40"
    :class="cardBorderClass"
  >
    <!-- 卡片头：方向 + 对方 + 类型 + 时间 -->
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 cursor-pointer select-none min-w-0"
      :class="headerBgClass"
      @click="expanded = !expanded"
    >
      <span class="text-[10px] flex-shrink-0">{{ expanded ? '▼' : '▶' }}</span>
      <span class="flex-shrink-0 text-[12px]" :class="arrowClass">{{ arrowGlyph }}</span>
      <span class="flex-shrink-0 text-[11px] font-medium text-slate-200">{{ counterpartLabel }}</span>
      <span class="flex-shrink-0 text-[10px] px-1 rounded" :class="typeBadgeClass">{{ typeLabel }}</span>
      <span v-if="message.metadata?.isBtw" class="flex-shrink-0 text-[10px] text-amber-400">BTW</span>
      <span class="flex-shrink-0 text-[10px] text-slate-500 ml-auto">{{ timeLabel }}</span>
    </div>

    <!-- 折叠：单行 preview -->
    <div v-if="!expanded && previewText" class="px-2 py-1 text-[11px] text-slate-400 truncate min-w-0">
      {{ previewText }}
    </div>

    <!-- 展开：完整 markdown -->
    <div v-if="expanded" class="px-2 py-1.5 min-w-0">
      <div class="markdown-body text-[12px] text-slate-200 leading-5 break-words" v-html="renderedContent"></div>

      <!-- metadata 折叠区（如有） -->
      <details v-if="hasExtraMetadata" class="mt-2">
        <summary class="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">metadata</summary>
        <pre class="mt-1 text-[10px] text-slate-500 bg-slate-950/60 border border-slate-700/40 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ formattedMetadata }}</pre>
      </details>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown.js'

const props = defineProps({
  message: { type: Object, required: true },
  // 当前 ClaudeTerminal 所属 Agent ID（用于判断 in/out 方向）
  currentAgentId: { type: String, default: null },
  defaultExpanded: { type: Boolean, default: false }
})

const expanded = ref(props.defaultExpanded)

// 方向：相对当前 agent
//   to == null    → broadcast
//   from === me   → out
//   to === me     → in
//   else          → unknown（仍渲染，方向用 ↔）
const direction = computed(() => {
  const me = props.currentAgentId
  const m = props.message
  if (m.to == null) return 'broadcast'
  if (me && m.from === me) return 'out'
  if (me && m.to === me) return 'in'
  return 'other'
})

const arrowGlyph = computed(() => {
  switch (direction.value) {
    case 'in': return '←'
    case 'out': return '→'
    case 'broadcast': return '⤳'
    default: return '↔'
  }
})

const arrowClass = computed(() => {
  switch (direction.value) {
    case 'in': return 'text-sky-400'
    case 'out': return 'text-emerald-400'
    case 'broadcast': return 'text-purple-400'
    default: return 'text-slate-400'
  }
})

const counterpartLabel = computed(() => {
  const m = props.message
  if (direction.value === 'in') return m.fromName || shortId(m.from) || '未知'
  if (direction.value === 'out') return shortId(m.to) || '未知目标'
  if (direction.value === 'broadcast') return '广播'
  return `${m.fromName || shortId(m.from)} → ${shortId(m.to) || '?'}`
})

const typeLabel = computed(() => {
  const t = props.message.type || 'text'
  switch (t) {
    case 'text': return '聊天'
    case 'btw': return 'BTW'
    case 'status-query': return '状态查询'
    case 'response': return '回复'
    case 'role-assign': return '角色分配'
    case 'file-notice': return '文件'
    case 'task-assign': return '任务分配'
    case 'task-result': return '任务回报'
    default: return t
  }
})

const typeBadgeClass = computed(() => {
  const t = props.message.type || 'text'
  switch (t) {
    case 'btw': return 'bg-amber-900/40 text-amber-300'
    case 'status-query': return 'bg-blue-900/40 text-blue-300'
    case 'response': return 'bg-emerald-900/40 text-emerald-300'
    case 'role-assign': return 'bg-purple-900/40 text-purple-300'
    case 'file-notice': return 'bg-slate-800 text-slate-300'
    case 'task-assign': return 'bg-sky-900/40 text-sky-300'
    case 'task-result': return 'bg-amber-900/30 text-amber-300'
    default: return 'bg-slate-800 text-slate-400'
  }
})

const cardBorderClass = computed(() => {
  if (props.message.metadata?.isBtw) return 'border-amber-700/40'
  switch (direction.value) {
    case 'in': return 'border-sky-700/30'
    case 'out': return 'border-emerald-700/30'
    case 'broadcast': return 'border-purple-700/30'
    default: return 'border-slate-700/40'
  }
})

const headerBgClass = computed(() => {
  if (props.message.metadata?.isBtw) return 'bg-amber-950/20'
  return 'bg-slate-800/30'
})

const previewText = computed(() => {
  const t = String(props.message.content || '')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  return t.length > 100 ? t.slice(0, 100) + '…' : t
})

const renderedContent = computed(() => {
  return renderMarkdown(props.message.content || '')
})

const timeLabel = computed(() => {
  const ts = props.message.timestamp
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
})

const hasExtraMetadata = computed(() => {
  const md = props.message.metadata
  if (!md || typeof md !== 'object') return false
  return Object.keys(md).length > 0
})

const formattedMetadata = computed(() => {
  try {
    return JSON.stringify(props.message.metadata, null, 2)
  } catch {
    return String(props.message.metadata)
  }
})

function shortId(id) {
  if (!id) return ''
  const s = String(id)
  return s.length > 10 ? s.slice(0, 8) : s
}
</script>

<style scoped>
.markdown-body :deep(p) { margin: 0.25rem 0; }
.markdown-body :deep(pre) {
  background: rgb(2 6 23 / 0.7);
  border: 1px solid rgb(51 65 85 / 0.5);
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  margin: 0.4rem 0;
  font-size: 11px;
  overflow-x: auto;
}
.markdown-body :deep(code) {
  font-size: 11px;
  background: rgb(15 23 42 / 0.7);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
.markdown-body :deep(pre code) { background: transparent; padding: 0; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) { padding-left: 1.25rem; margin: 0.25rem 0; }
.markdown-body :deep(li) { margin: 0.1rem 0; }
.markdown-body :deep(a) { color: rgb(56 189 248); text-decoration: underline; }
.markdown-body :deep(blockquote) {
  border-left: 2px solid rgb(71 85 105);
  padding-left: 0.6rem;
  color: rgb(148 163 184);
  margin: 0.4rem 0;
}
</style>
