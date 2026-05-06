<template>
  <div class="claude-terminal flex flex-col bg-slate-900 h-full min-w-0 min-h-0">
    <!-- Status Bar -->
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-3 py-1 bg-slate-800/80 border-b border-slate-700/50 flex-shrink-0 min-w-0">
      <div class="flex items-center gap-2 min-w-0 flex-shrink">
        <div class="w-2 h-2 rounded-full flex-shrink-0" :class="statusDotClass" />
        <span class="text-xs text-slate-300 font-medium truncate">{{ agentName }}</span>
        <span v-if="agentPlatform" class="text-[10px] text-slate-600 flex-shrink-0">{{ agentPlatform }}</span>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 justify-end min-w-0">
        <span v-if="agentCpu != null" class="text-[10px] text-slate-500 font-mono flex-shrink-0">CPU {{ agentCpu }}%</span>
        <span v-if="agentMem != null" class="text-[10px] text-slate-500 font-mono flex-shrink-0">MEM {{ agentMem }}%</span>
        <span v-if="hasRunning" class="text-[10px] text-slate-500 font-mono flex-shrink-0">{{ elapsed }}</span>
        <button
          v-if="timeline.length > 0"
          class="text-[10px] text-slate-500 hover:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-700/40 flex-shrink-0"
          title="清空当前 Agent 的任务历史"
          @click="onClearTasks"
        >清空</button>
        <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="statusBadgeClass">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- 时间线：Task 与 Message 按时序混排 -->
    <div ref="scrollContainer" class="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2 min-w-0 min-h-0 scroll-smooth">
      <div v-if="timeline.length === 0" class="text-slate-600 text-xs flex items-center justify-center h-full">
        等待任务...
      </div>
      <template v-for="item in timeline" :key="item.id">
        <TaskCard
          v-if="item.kind === 'task'"
          :task="item.task"
          :default-expanded="item.task.status === 'running' || item.task.id === lastTaskId"
        />
        <MessageCard
          v-else
          :message="item.msg"
          :current-agent-id="agentId"
        />
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import TaskCard from './claude/TaskCard.vue'
import MessageCard from './claude/MessageCard.vue'

const props = defineProps({
  agentId: { type: String, required: true }
})

const store = useSocketStore()
const scrollContainer = ref(null)
const elapsed = ref('00:00')

let elapsedTimer = null

const agent = computed(() => store.agents.find(a => a.id === props.agentId) || null)
const agentName = computed(() => agent.value?.name || props.agentId.slice(0, 8))
const agentPlatform = computed(() => {
  const p = agent.value?.platform
  if (!p) return ''
  return ({ win32: 'Win', darwin: 'Mac', linux: 'Linux' })[p] || p
})
const agentCpu = computed(() => agent.value?.cpuUsage != null ? Math.round(agent.value.cpuUsage) : null)
const agentMem = computed(() => agent.value?.memoryUsage != null ? Math.round(agent.value.memoryUsage) : null)

const timeline = computed(() => store.getTimelineForAgent(props.agentId))
const tasks = computed(() => timeline.value.filter(it => it.kind === 'task').map(it => it.task))
const runningTasks = computed(() => tasks.value.filter(t => t.status === 'running'))
const hasRunning = computed(() => runningTasks.value.length > 0)
const lastTaskId = computed(() => tasks.value.length > 0 ? tasks.value[tasks.value.length - 1].id : null)

const status = computed(() => {
  if (hasRunning.value) return 'running'
  const last = tasks.value[tasks.value.length - 1]
  if (last) return last.status
  return 'idle'
})

const statusDotClass = computed(() => {
  switch (status.value) {
    case 'running': return 'bg-emerald-400 animate-pulse'
    case 'success': return 'bg-emerald-500'
    case 'error': return 'bg-rose-400'
    default: return 'bg-slate-600'
  }
})

const statusBadgeClass = computed(() => {
  switch (status.value) {
    case 'running': return 'bg-emerald-500/20 text-emerald-400'
    case 'success': return 'bg-emerald-500/20 text-emerald-500'
    case 'error': return 'bg-rose-500/20 text-rose-400'
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

function updateElapsed() {
  const running = runningTasks.value[0]
  if (!running || !running.startedAt) {
    elapsed.value = '00:00'
    return
  }
  const diff = Math.floor((Date.now() - running.startedAt) / 1000)
  const m = Math.floor(diff / 60)
  const s = diff % 60
  elapsed.value = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function scrollToBottom() {
  const el = scrollContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

function onClearTasks() {
  store.clearAgentTasks(props.agentId)
}

// 时间线变化时尝试滚动到底（仅当用户已贴底）
watch(timeline, () => {
  nextTick(() => {
    const el = scrollContainer.value
    if (!el) return
    // 距底部 < 80px 视为"贴底"
    const stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (stickToBottom) scrollToBottom()
  })
}, { deep: false, flush: 'post' })

// 内部事件追加也要滚动 — 通过 store.tasksContainer 触发
watch(() => store.tasksContainer, () => {
  nextTick(() => {
    const el = scrollContainer.value
    if (!el) return
    const stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (stickToBottom) scrollToBottom()
  })
}, { deep: false, flush: 'post' })

onMounted(() => {
  elapsedTimer = setInterval(updateElapsed, 500)
  updateElapsed()
})

onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
})
</script>
