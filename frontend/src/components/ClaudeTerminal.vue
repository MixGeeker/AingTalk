<template>
  <div class="claude-terminal flex flex-col bg-slate-900">
    <!-- Status Bar -->
    <div class="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700 flex-shrink-0">
      <div class="flex items-center gap-2">
        <div
          class="w-2 h-2 rounded-full"
          :class="statusDotClass"
        />
        <span class="text-xs text-slate-300 font-medium">
          Claude Code · {{ agentName }}
        </span>
        <span class="text-[10px] text-slate-600">
          {{ taskIdShort }}
        </span>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-[10px] text-slate-500 font-mono">{{ elapsed }}</span>
        <span
          class="text-[10px] px-1.5 py-0.5 rounded"
          :class="statusBadgeClass"
        >{{ statusLabel }}</span>
      </div>
    </div>

    <!-- xterm.js Container -->
    <div ref="terminalContainer" class="flex-1 min-h-0 px-1" />

    <!-- Completion Footer -->
    <div
      v-if="status === 'success' || status === 'error'"
      class="flex items-center gap-3 px-3 py-1.5 border-t flex-shrink-0"
      :class="status === 'success' ? 'bg-emerald-900/30 border-emerald-800/50' : 'bg-red-900/30 border-red-800/50'"
    >
      <span
        class="text-[11px] font-medium"
        :class="status === 'success' ? 'text-emerald-400' : 'text-red-400'"
      >
        {{ status === 'success' ? '完成' : '失败' }}
      </span>
      <span class="text-[10px] text-slate-500">
        exitCode: {{ exitCode }}
      </span>
      <span class="text-[10px] text-slate-500">
        耗时: {{ formatDuration(duration) }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSocketStore } from '@/stores/socket.js'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  agentId: { type: String, required: true }
})

const store = useSocketStore()
const terminalContainer = ref(null)
const taskId = ref('')
const status = ref('idle') // idle | running | success | error
const duration = ref(0)
const exitCode = ref(null)
const startTime = ref(null)
const elapsed = ref('00:00')

let terminal = null
let fitAddon = null
let unsubOutput = null
let unsubComplete = null
let elapsedTimer = null

const agentName = computed(() => {
  const agent = store.agents.find(a => a.id === props.agentId)
  return agent?.name || props.agentId
})

const taskIdShort = computed(() => {
  if (!taskId.value) return ''
  return taskId.value.length > 12 ? taskId.value.slice(0, 12) + '...' : taskId.value
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

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
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
    scrollback: 5000
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalContainer.value)

  // Fit after a tick to let the container render
  requestAnimationFrame(() => {
    fitAddon.fit()
  })

  // Register claude event callbacks
  unsubOutput = store.onClaudeOutput((data) => {
    if (!data?.chunk) return

    if (status.value === 'idle') {
      status.value = 'running'
      taskId.value = data.taskId || ''
      startTime.value = Date.now()
      elapsedTimer = setInterval(updateElapsed, 250)
    }

    terminal.write(data.chunk)
  })

  unsubComplete = store.onClaudeComplete((data) => {
    if (!data) return
    taskId.value = data.taskId || taskId.value
    duration.value = data.duration || 0
    exitCode.value = data.exitCode ?? null
    status.value = data.exitCode === 0 ? 'success' : 'error'

    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    updateElapsed()

    terminal.writeln('')
    terminal.writeln(`\x1b[90m── ${status.value === 'success' ? '完成' : '失败'} (exit: ${exitCode.value}, ${formatDuration(duration.value)})\x1b[0m`)
  })

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      requestAnimationFrame(() => fitAddon.fit())
    }
  })
  resizeObserver.observe(terminalContainer.value)

  // Store resizeObserver for cleanup
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
