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
        <span class="text-[10px] px-1.5 py-0.5 rounded" :class="statusBadgeClass">{{ statusLabel }}</span>
      </div>
    </div>

    <!-- xterm.js Container -->
    <div ref="terminalContainer" class="flex-1 min-h-0" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSocketStore } from '@/stores/socket.js'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  agentId: { type: String, required: true }
})

const store = useSocketStore()
const terminalContainer = ref(null)
const status = ref('idle')
const duration = ref(0)
const startTime = ref(null)
const elapsed = ref('00:00')

let terminal = null
let fitAddon = null
let unsubOutput = null
let unsubComplete = null
let elapsedTimer = null
let currentTaskId = null

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

onMounted(() => {
  terminal = new Terminal({
    disableStdin: true,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace',
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      cursor: '#38bdf8',
      black: '#1e293b',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#cbd5e1',
      brightBlack: '#475569',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#f8fafc'
    },
    allowProposedApi: true,
    scrollback: 10000
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalContainer.value)

  requestAnimationFrame(() => fitAddon.fit())

  // Only process output for THIS agent
  unsubOutput = store.onClaudeOutput((data) => {
    if (!data?.chunk) return
    if (data.agentId && data.agentId !== props.agentId) return

    // New task starting — write separator
    if (data.taskId && data.taskId !== currentTaskId) {
      if (currentTaskId) {
        terminal.writeln('')
      }
      currentTaskId = data.taskId
      status.value = 'running'
      startTime.value = Date.now()
      if (elapsedTimer) clearInterval(elapsedTimer)
      elapsedTimer = setInterval(updateElapsed, 250)

      terminal.writeln(`\x1b[33m─── 任务 ${data.taskId.slice(-8)} 开始 (${fmtTime(Date.now())}) ───\x1b[0m`)
    }

    terminal.write(data.chunk)
  })

  unsubComplete = store.onClaudeComplete((data) => {
    if (!data) return
    // Only handle completions for this agent's tasks
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
    terminal.writeln('')
    terminal.writeln(`\x1b[90m─── ${label} (exit: ${exitCode}, ${fmtDuration(duration.value)}) ───\x1b[0m`)

    currentTaskId = null
  })

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      requestAnimationFrame(() => fitAddon.fit())
    }
  })
  resizeObserver.observe(terminalContainer.value)
  terminal._resizeObserver = resizeObserver
})

onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
  if (unsubOutput) unsubOutput()
  if (unsubComplete) unsubComplete()
  if (terminal) {
    if (terminal._resizeObserver) terminal._resizeObserver.disconnect()
    terminal.dispose()
  }
})
</script>
