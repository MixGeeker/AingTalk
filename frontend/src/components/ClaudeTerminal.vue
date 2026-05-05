<template>
  <div class="claude-terminal flex flex-col bg-slate-900 h-full">
    <!-- Status Bar -->
    <div class="flex items-center justify-between px-3 py-1 bg-slate-800/80 border-b border-slate-700/50 flex-shrink-0">
      <div class="flex items-center gap-2">
        <div class="w-2 h-2 rounded-full" :class="statusDotClass" />
        <span class="text-xs text-slate-300 font-medium">{{ agentName }}</span>
        <span v-if="agentPlatform" class="text-[10px] text-slate-600">{{ agentPlatform }}</span>
      </div>
      <div class="flex items-center gap-3">
        <span v-if="agentCpu != null" class="text-[10px] text-slate-500 font-mono">CPU {{ agentCpu }}%</span>
        <span v-if="agentMem != null" class="text-[10px] text-slate-500 font-mono">MEM {{ agentMem }}%</span>
        <span v-if="status === 'running'" class="text-[10px] text-slate-500 font-mono">{{ elapsed }}</span>
        <span v-if="costDisplay" class="text-[10px] text-yellow-500 font-mono">${{ costDisplay }}</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded" :class="statusBadgeClass">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- 事件流区域 -->
    <div ref="scrollContainer" class="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5 scroll-smooth">
      <!-- 空状态 -->
      <div v-if="events.length === 0" class="text-slate-600 text-xs flex items-center justify-center h-full">
        等待任务...
      </div>

      <!-- 事件列表 -->
      <div v-for="event in events" :key="event.id">
        <!-- 文本事件 -->
        <div v-if="event.type === 'text'" class="text-slate-200 whitespace-pre-wrap break-words">{{ event.content }}</div>

        <!-- 工具调用事件 -->
        <div v-else-if="event.type === 'tool_use'" class="text-cyan-400/80 leading-4">
          <span class="cursor-pointer hover:text-cyan-300 select-none inline-flex items-center gap-0.5" @click="event.expanded = !event.expanded">
            <span class="text-[9px]">{{ event.expanded ? '▼' : '▶' }}</span>
            <span class="text-[11px]">{{ event.toolName }}</span>
          </span>
          <div v-if="event.expanded && event.input" class="text-slate-500 text-[10px] ml-2 mt-0.5 whitespace-pre-wrap max-h-32 overflow-y-auto bg-slate-800/50 rounded px-1.5 py-1">
            {{ event.input }}
          </div>
        </div>

        <!-- 工具结果事件 -->
        <div v-else-if="event.type === 'tool_result'" class="text-emerald-500/70 leading-4">
          <span class="cursor-pointer hover:text-emerald-300 select-none inline-flex items-center gap-0.5" @click="event.expanded = !event.expanded">
            <span class="text-[9px]">✓</span>
            <span class="text-[10px]">{{ event.toolName || 'result' }}</span>
          </span>
          <div v-if="event.expanded && event.output" class="text-slate-500 text-[10px] ml-2 mt-0.5 whitespace-pre-wrap max-h-32 overflow-y-auto bg-slate-800/50 rounded px-1.5 py-1">
            {{ event.output }}
          </div>
        </div>

        <!-- 系统事件 -->
        <div v-else-if="event.type === 'system'" class="text-slate-600 text-[10px] leading-4">
          {{ event.content }}
        </div>

        <!-- 错误事件 -->
        <div v-else-if="event.type === 'error'" class="text-red-400 text-[10px] whitespace-pre-wrap leading-4">
          {{ event.content }}
        </div>

        <!-- 任务分隔线 -->
        <div v-else-if="event.type === 'separator'" class="text-slate-700 text-[10px] leading-4">
          {{ event.content }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useSocketStore } from '@/stores/socket.js'

const props = defineProps({
  agentId: { type: String, required: true }
})

const store = useSocketStore()
const scrollContainer = ref(null)
const status = ref('idle')
const duration = ref(0)
const startTime = ref(null)
const elapsed = ref('00:00')
const totalCost = ref(0)
const events = ref([])

let unsubOutput = null
let unsubComplete = null
let elapsedTimer = null
let currentTaskId = null
let eventCounter = 0

const agentName = computed(() => {
  const agent = store.agents.find(a => a.id === props.agentId)
  return agent?.name || props.agentId.slice(0, 8)
})

const agentPlatform = computed(() => {
  const agent = store.agents.find(a => a.id === props.agentId)
  if (!agent) return ''
  const icons = { win32: 'Win', darwin: 'Mac', linux: 'Linux' }
  return icons[agent.platform] || agent.platform
})

const agentCpu = computed(() => {
  const agent = store.agents.find(a => a.id === props.agentId)
  return agent?.cpuUsage != null ? Math.round(agent.cpuUsage) : null
})

const agentMem = computed(() => {
  const agent = store.agents.find(a => a.id === props.agentId)
  return agent?.memoryUsage != null ? Math.round(agent.memoryUsage) : null
})

const costDisplay = computed(() => {
  if (totalCost.value <= 0) return ''
  return totalCost.value < 0.01 ? '<0.01' : totalCost.value.toFixed(2)
})

const statusDotClass = computed(() => {
  switch (status.value) {
    case 'running': return 'bg-green-400 animate-pulse'
    case 'success': return 'bg-emerald-400'
    case 'error': return 'bg-red-400'
    default: return 'bg-slate-600'
  }
})

const statusBadgeClass = computed(() => {
  switch (status.value) {
    case 'running': return 'bg-green-500/20 text-green-400'
    case 'success': return 'bg-emerald-500/20 text-emerald-400'
    case 'error': return 'bg-red-500/20 text-red-400'
    default: return 'bg-slate-500/20 text-slate-400'
  }
})

const statusLabel = computed(() => {
  switch (status.value) {
    case 'running': return '执行中'
    case 'success': return '完成'
    case 'error': return '失败'
    default: return '空闲'
  }
})

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function updateElapsed() {
  if (!startTime.value) return
  const diff = Math.floor((Date.now() - startTime.value) / 1000)
  const m = Math.floor(diff / 60)
  const s = diff % 60
  elapsed.value = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function scrollToBottom() {
  const el = scrollContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

function pushEvent(event) {
  events.value.push({ ...event, id: eventCounter++, expanded: false, timestamp: Date.now() })
  // 限制事件数量，避免内存溢出
  if (events.value.length > 5000) {
    events.value = events.value.slice(-3000)
  }
  nextTick(scrollToBottom)
}

onMounted(() => {
  unsubOutput = store.onClaudeOutput((data) => {
    if (!data?.chunk) return
    if (data.agentId && data.agentId !== props.agentId) return

    // 新任务开始
    if (data.taskId && data.taskId !== currentTaskId) {
      if (currentTaskId) {
        pushEvent({ type: 'separator', content: '─'.repeat(40) })
      }
      currentTaskId = data.taskId
      status.value = 'running'
      startTime.value = Date.now()
      totalCost.value = 0
      if (elapsedTimer) clearInterval(elapsedTimer)
      elapsedTimer = setInterval(updateElapsed, 250)

      pushEvent({ type: 'separator', content: `─── 任务 ${data.taskId.slice(-8)} 开始 (${fmtTime(Date.now())}) ───` })
    }

    // 解析结构化事件
    try {
      const event = JSON.parse(data.chunk)
      switch (event.type) {
        case 'text':
          // 合并连续的文本事件
          const last = events.value[events.value.length - 1]
          if (last && last.type === 'text' && !last.sealed) {
            last.content += event.data || ''
          } else {
            if (last && last.type === 'text') last.sealed = true
            pushEvent({ type: 'text', content: event.data || '' })
          }
          break

        case 'init':
          pushEvent({ type: 'system', content: `会话初始化: ${event.data?.model || 'unknown'}` })
          break

        case 'tool_use':
          // 封印上一个文本事件（工具调用前文本已结束）
          const prevText = events.value[events.value.length - 1]
          if (prevText && prevText.type === 'text') prevText.sealed = true
          pushEvent({
            type: 'tool_use',
            toolName: event.toolName || event.data?.name || 'unknown',
            input: event.input || ''
          })
          break

        case 'tool_result':
          pushEvent({
            type: 'tool_result',
            toolName: event.toolName || '',
            output: event.output || ''
          })
          break

        case 'error':
          pushEvent({ type: 'error', content: event.data || '未知错误' })
          break

        default:
          // 忽略其他类型
          break
      }
    } catch {
      // 降级：纯文本显示
      pushEvent({ type: 'text', content: data.chunk, sealed: true })
    }
  })

  unsubComplete = store.onClaudeComplete((data) => {
    if (!data) return
    if (data.agentId && data.agentId !== props.agentId) return
    if (data.taskId !== currentTaskId) return

    duration.value = data.duration || 0
    const exitCode = data.exitCode ?? -1
    status.value = exitCode === 0 ? 'success' : 'error'

    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    updateElapsed()

    const label = status.value === 'success' ? '完成' : '失败'
    pushEvent({ type: 'separator', content: `─── ${label} (exit: ${exitCode}, ${fmtDuration(duration.value)}) ───` })

    currentTaskId = null
  })
})

onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
  if (unsubOutput) unsubOutput()
  if (unsubComplete) unsubComplete()
})
</script>
