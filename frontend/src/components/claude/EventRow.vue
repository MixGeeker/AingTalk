<template>
  <div class="event-row min-w-0 group" :class="rowClass">
    <!-- INIT -->
    <template v-if="event.kind === 'init'">
      <div class="flex items-baseline gap-2 text-[10px] text-slate-500 leading-4 min-w-0">
        <span class="text-slate-600 flex-shrink-0">⚙</span>
        <span class="truncate">
          会话初始化
          <span v-if="event.data?.model" class="text-slate-400">· {{ event.data.model }}</span>
          <span v-if="shortSessionId" class="text-slate-600">· session {{ shortSessionId }}</span>
          <span v-if="event.data?.cwd" class="text-slate-600 ml-1">· cwd {{ shortCwd }}</span>
        </span>
        <button class="raw-btn" @click="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
      </div>
    </template>

    <!-- THINKING -->
    <template v-else-if="event.kind === 'thinking'">
      <div class="text-slate-500 text-[11px] leading-4 min-w-0">
        <button
          class="inline-flex items-center gap-1 hover:text-slate-300 transition-colors"
          @click="expanded = !expanded"
        >
          <span class="text-[9px]">{{ expanded ? '▼' : '▶' }}</span>
          <span>💭 思考 ({{ thinkingLen }} 字)</span>
          <button class="raw-btn ml-1" @click.stop="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </button>
        <div v-if="expanded" class="mt-1 ml-4 italic text-slate-500 whitespace-pre-wrap break-words text-[11px] leading-5 max-h-64 overflow-y-auto bg-slate-800/30 rounded px-2 py-1">
          {{ event.data?.text || '' }}
        </div>
      </div>
    </template>

    <!-- TEXT (assistant 主文本，markdown 渲染) -->
    <template v-else-if="event.kind === 'text'">
      <div class="relative min-w-0 text-slate-200 text-[12px] leading-5">
        <div class="markdown-body break-words" v-html="renderedText"></div>
        <button class="raw-btn-floating" @click="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
      </div>
    </template>

    <!-- TOOL_USE （配对的 tool_result 渲染在右侧 / 下方） -->
    <template v-else-if="event.kind === 'tool_use'">
      <div class="min-w-0">
        <div class="flex items-baseline gap-1.5 min-w-0">
          <button
            class="inline-flex items-baseline gap-1 hover:text-cyan-300 transition-colors text-cyan-400 min-w-0"
            @click="expanded = !expanded"
          >
            <span class="text-[9px] flex-shrink-0">{{ expanded ? '▼' : '▶' }}</span>
            <span class="text-[11px] flex-shrink-0">{{ toolSummary.icon }}</span>
            <span class="text-[11px] font-medium flex-shrink-0">{{ toolSummary.title }}</span>
            <span v-if="toolSummary.subtitle" class="text-[11px] text-slate-400 truncate min-w-0">
              · {{ toolSummary.subtitle }}
            </span>
          </button>

          <span v-if="resultBadge" class="text-[10px] flex-shrink-0" :class="resultBadge.cls">
            {{ resultBadge.label }}
          </span>

          <button class="raw-btn" @click.stop="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </div>

        <!-- 展开：input + result -->
        <div v-if="expanded" class="ml-4 mt-1 space-y-1 min-w-0">
          <div class="text-[10px] text-slate-500">输入参数</div>
          <pre class="text-[10px] text-slate-400 whitespace-pre-wrap break-all bg-slate-800/40 rounded px-2 py-1 max-h-64 overflow-y-auto">{{ formattedInput }}</pre>

          <div v-if="event.result" class="text-[10px] mt-2" :class="event.result.data?.isError ? 'text-rose-400' : 'text-emerald-400'">
            执行结果 {{ resultStats }}
          </div>
          <pre v-if="event.result" class="text-[10px] whitespace-pre-wrap break-all rounded px-2 py-1 max-h-64 overflow-y-auto"
               :class="event.result.data?.isError ? 'bg-rose-950/30 text-rose-200' : 'bg-slate-800/40 text-slate-300'">{{ event.result.data?.output || '(空输出)' }}</pre>
        </div>
      </div>
    </template>

    <!-- 独立的 TOOL_RESULT（未配对到 tool_use 的，例如老 worker 顺序错乱） -->
    <template v-else-if="event.kind === 'tool_result' && !event.pairedWith">
      <div class="min-w-0">
        <div class="flex items-baseline gap-1.5 min-w-0">
          <button
            class="inline-flex items-baseline gap-1 hover:text-emerald-300 transition-colors min-w-0"
            :class="event.data?.isError ? 'text-rose-400' : 'text-emerald-500/80'"
            @click="expanded = !expanded"
          >
            <span class="text-[9px] flex-shrink-0">{{ expanded ? '▼' : '▶' }}</span>
            <span class="text-[10px] flex-shrink-0">{{ event.data?.isError ? '✗' : '✓' }} 工具结果</span>
            <span class="text-[10px] text-slate-500 truncate min-w-0">{{ resultStats }}</span>
          </button>
          <button class="raw-btn" @click.stop="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </div>
        <pre v-if="expanded" class="ml-4 mt-1 text-[10px] whitespace-pre-wrap break-all rounded px-2 py-1 max-h-64 overflow-y-auto"
             :class="event.data?.isError ? 'bg-rose-950/30 text-rose-200' : 'bg-slate-800/40 text-slate-300'">{{ event.data?.output || '(空输出)' }}</pre>
      </div>
    </template>

    <!-- TOOL_RESULT 已配对：不单独渲染（在对应 tool_use 展开里显示） -->
    <template v-else-if="event.kind === 'tool_result' && event.pairedWith">
      <!-- noop -->
    </template>

    <!-- RESULT —— 任务最终摘要文本（卡片头已显示 metric，这里只贴 summary 文本） -->
    <template v-else-if="event.kind === 'result'">
      <div v-if="event.data?.summary" class="min-w-0 mt-2 border-t border-slate-700/50 pt-2">
        <div class="flex items-center gap-2 text-[10px] text-amber-400 mb-1">
          <span>★ 任务结果</span>
          <button class="raw-btn" @click="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </div>
        <div class="markdown-body text-[12px] text-slate-200 leading-5 break-words" v-html="renderedSummary"></div>
      </div>
    </template>

    <!-- ERROR -->
    <template v-else-if="event.kind === 'error'">
      <div class="min-w-0 border border-rose-700/50 bg-rose-950/30 rounded px-2 py-1.5 text-rose-300 text-[11px] leading-4">
        <div class="flex items-baseline gap-1.5">
          <span class="flex-shrink-0">⚠</span>
          <span class="font-medium flex-shrink-0">错误</span>
          <button class="raw-btn ml-auto" @click="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </div>
        <div class="mt-0.5 whitespace-pre-wrap break-words">{{ event.data?.message || '(无错误信息)' }}</div>
      </div>
    </template>

    <!-- STDERR -->
    <template v-else-if="event.kind === 'stderr'">
      <div class="min-w-0 text-[10px] text-amber-500/80 leading-4">
        <button
          class="inline-flex items-center gap-1 hover:text-amber-300 transition-colors"
          @click="expanded = !expanded"
        >
          <span class="text-[9px]">{{ expanded ? '▼' : '▶' }}</span>
          <span>⌥ stderr ({{ stderrLen }} 字符)</span>
          <button class="raw-btn ml-1" @click.stop="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
        </button>
        <pre v-if="expanded" class="mt-1 ml-4 text-[10px] whitespace-pre-wrap break-all bg-slate-800/40 rounded px-2 py-1 max-h-64 overflow-y-auto text-slate-400">{{ event.data?.text || '' }}</pre>
      </div>
    </template>

    <!-- TASK_DISPATCH（任务来源 — 由 message:new task-assign 注入） -->
    <template v-else-if="event.kind === 'task_dispatch'">
      <div class="min-w-0 border border-sky-700/40 bg-sky-950/20 rounded px-2 py-1.5 mb-1">
        <button
          class="w-full flex items-baseline gap-1.5 text-sky-300 hover:text-sky-200 min-w-0 text-[11px]"
          @click="expanded = !expanded"
        >
          <span class="text-[9px] flex-shrink-0">{{ expanded ? '▼' : '▶' }}</span>
          <span class="flex-shrink-0">←</span>
          <span class="font-medium flex-shrink-0">来源</span>
          <span v-if="event.data?.fromName" class="text-sky-200/80 flex-shrink-0">{{ event.data.fromName }}</span>
          <span class="text-slate-400 truncate min-w-0">{{ dispatchPreview }}</span>
        </button>
        <div v-if="expanded" class="markdown-body text-[12px] text-slate-200 leading-5 mt-1 break-words" v-html="renderedDispatch"></div>
      </div>
    </template>

    <!-- TASK_REPORT（任务回报 — 由 task-result 消息或 result.summary 注入） -->
    <template v-else-if="event.kind === 'task_report'">
      <div class="min-w-0 border border-amber-700/40 bg-amber-950/15 rounded px-2 py-1.5 mt-1">
        <button
          class="w-full flex items-baseline gap-1.5 text-amber-400 hover:text-amber-300 min-w-0 text-[11px]"
          @click="expanded = !expanded"
        >
          <span class="text-[9px] flex-shrink-0">{{ expanded ? '▼' : '▶' }}</span>
          <span class="flex-shrink-0">→</span>
          <span class="font-medium flex-shrink-0">回报</span>
          <span v-if="event.data?.toAgent" class="text-amber-300/80 flex-shrink-0">{{ shortAgentId(event.data.toAgent) }}</span>
          <span class="text-slate-400 truncate min-w-0">{{ reportPreview }}</span>
        </button>
        <div v-if="expanded" class="markdown-body text-[12px] text-slate-200 leading-5 mt-1 break-words" v-html="renderedReport"></div>
      </div>
    </template>

    <!-- 兜底：未知 kind -->
    <template v-else>
      <div class="text-[10px] text-slate-500">
        ? {{ event.kind }}
        <button class="raw-btn ml-1" @click="toggleRaw" title="原始 JSON">{{ '</>' }}</button>
      </div>
    </template>

    <!-- 原始 JSON 浮层（同行展开） -->
    <pre v-if="rawOpen" class="ml-4 mt-1 text-[10px] text-slate-500 bg-slate-950/80 border border-slate-700/50 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{{ formattedRaw }}</pre>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { summarizeTool } from '@/utils/claude-stream-parser.js'
import { renderMarkdown } from '@/utils/markdown.js'

const props = defineProps({
  event: { type: Object, required: true },
  defaultExpanded: { type: Boolean, default: false }
})

const expanded = ref(props.defaultExpanded)
const rawOpen = ref(false)

function toggleRaw() {
  rawOpen.value = !rawOpen.value
}

const rowClass = computed(() => {
  switch (props.event.kind) {
    case 'init': return 'py-0.5'
    case 'thinking': return 'py-0.5'
    case 'text': return 'py-1'
    case 'tool_use': return 'py-0.5'
    case 'tool_result': return 'py-0.5'
    case 'result': return 'py-1'
    case 'error': return 'py-1'
    case 'stderr': return 'py-0.5'
    default: return 'py-0.5'
  }
})

const shortSessionId = computed(() => {
  const sid = props.event.data?.sessionId
  return sid ? String(sid).slice(0, 8) : ''
})

const shortCwd = computed(() => {
  const cwd = props.event.data?.cwd
  if (!cwd) return ''
  const str = String(cwd)
  if (str.length <= 40) return str
  return '…' + str.slice(-40)
})

const thinkingLen = computed(() => {
  return (props.event.data?.text || '').length
})

const stderrLen = computed(() => {
  return (props.event.data?.text || '').length
})

const renderedText = computed(() => {
  return renderMarkdown(props.event.data?.text || '')
})

const renderedSummary = computed(() => {
  return renderMarkdown(props.event.data?.summary || '')
})

const toolSummary = computed(() => {
  return summarizeTool(props.event.data?.name, props.event.data?.input)
})

const formattedInput = computed(() => {
  const input = props.event.data?.input
  if (input == null) return '(无参数)'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
})

const formattedRaw = computed(() => {
  const raw = props.event.raw
  if (!raw) return '(无原始数据)'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
})

const resultBadge = computed(() => {
  if (!props.event.result) return null
  const isErr = !!props.event.result.data?.isError
  return {
    label: isErr ? '✗ 失败' : '✓ 完成',
    cls: isErr ? 'text-rose-400' : 'text-emerald-500/80'
  }
})

const resultStats = computed(() => {
  const ev = props.event.kind === 'tool_use' ? props.event.result : props.event
  const out = ev?.data?.output || ''
  if (!out) return ''
  const bytes = out.length
  const lines = out.split('\n').length
  return `(${lines} 行 · ${formatBytes(bytes)})`
})

// task_dispatch / task_report 渲染辅助
const dispatchPreview = computed(() => {
  const txt = props.event.data?.prompt || ''
  return clipText(stripMarkdown(txt), 80)
})

const reportPreview = computed(() => {
  const txt = props.event.data?.content || ''
  return clipText(stripMarkdown(txt), 80)
})

const renderedDispatch = computed(() => {
  return renderMarkdown(props.event.data?.prompt || '')
})

const renderedReport = computed(() => {
  return renderMarkdown(props.event.data?.content || '')
})

function shortAgentId(id) {
  if (!id) return ''
  const s = String(id)
  return s.length > 8 ? s.slice(0, 8) : s
}

function stripMarkdown(s) {
  return String(s)
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipText(s, n) {
  if (!s) return ''
  return s.length <= n ? s : s.slice(0, n) + '…'
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<style scoped>
.raw-btn {
  font-size: 9px;
  color: rgb(71 85 105);
  padding: 0 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 150ms, color 150ms, background-color 150ms;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.raw-btn:hover {
  color: rgb(148 163 184);
  background-color: rgb(30 41 59 / 0.6);
}
.event-row.group:hover .raw-btn,
.event-row .raw-btn:focus {
  opacity: 1;
}

.raw-btn-floating {
  position: absolute;
  top: 0;
  right: 0;
  font-size: 9px;
  color: rgb(71 85 105);
  padding: 0 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 150ms, color 150ms, background-color 150ms;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.raw-btn-floating:hover {
  color: rgb(148 163 184);
  background-color: rgb(30 41 59 / 0.6);
}
.event-row.group:hover .raw-btn-floating {
  opacity: 1;
}

/* Markdown 样式（cssed 下需要 :deep 才能命中 v-html 内容） */
:deep(.markdown-body) {
  word-break: break-word;
}
:deep(.markdown-body p) {
  margin: 0 0 0.4em 0;
}
:deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}
:deep(.markdown-body strong) {
  color: rgb(248 250 252);
  font-weight: 600;
}
:deep(.markdown-body em) {
  font-style: italic;
}
:deep(.markdown-body code) {
  background: rgb(15 23 42 / 0.7);
  color: rgb(110 231 183);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.92em;
  word-break: break-all;
}
:deep(.markdown-body pre) {
  background: rgb(15 23 42 / 0.7);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 0.4em 0;
  overflow-x: auto;
}
:deep(.markdown-body pre code) {
  background: transparent;
  padding: 0;
  color: rgb(226 232 240);
  white-space: pre-wrap;
  word-break: break-all;
}
:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-left: 1.4em;
  margin: 0.3em 0;
}
:deep(.markdown-body li) {
  margin: 0.15em 0;
}
:deep(.markdown-body a) {
  color: rgb(96 165 250);
  text-decoration: underline;
}
:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4) {
  font-weight: 600;
  color: rgb(248 250 252);
  margin: 0.5em 0 0.25em;
  font-size: 1em;
}
:deep(.markdown-body blockquote) {
  border-left: 2px solid rgb(71 85 105);
  padding-left: 0.6em;
  color: rgb(148 163 184);
  margin: 0.4em 0;
}
:deep(.markdown-body hr) {
  border: none;
  border-top: 1px solid rgb(51 65 85);
  margin: 0.6em 0;
}
</style>
