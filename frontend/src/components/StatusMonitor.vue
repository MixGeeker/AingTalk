<template>
  <div class="status-monitor bg-slate-800/80 border-t border-slate-700">
    <!-- Toggle Header -->
    <button
      @click="isExpanded = !isExpanded"
      class="w-full px-4 py-2 flex items-center justify-between text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
    >
      <div class="flex items-center gap-2">
        <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <span class="text-xs font-semibold">状态监控</span>
        <span class="text-[10px] text-slate-500">实时</span>
      </div>
      <svg
        :class="['w-4 h-4 transition-transform', isExpanded ? 'rotate-180' : '']"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- Monitor Content -->
    <div
      v-show="isExpanded"
      class="px-4 pb-4 border-t border-slate-700/50 pt-3"
    >
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- Heartbeat Chart -->
        <div class="bg-slate-900/50 rounded-xl p-3 border border-slate-700/50">
          <h4 class="text-[11px] font-medium text-slate-400 mb-2 flex items-center gap-1.5">
            <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            心跳延迟
            <span class="ml-auto text-slate-500">{{ currentLatency }}ms</span>
          </h4>
          <div class="h-16 flex items-end gap-0.5">
            <div
              v-for="(point, i) in heartbeatHistory"
              :key="i"
              class="flex-1 rounded-t-sm transition-all duration-300"
              :class="point > 200 ? 'bg-red-500/60' : point > 100 ? 'bg-yellow-500/60' : 'bg-green-500/60'"
              :style="{ height: Math.min((point / 300) * 100, 100) + '%' }"
              :title="point + 'ms'"
            />
          </div>
          <div class="flex justify-between mt-1">
            <span class="text-[9px] text-slate-600">10s ago</span>
            <span class="text-[9px] text-slate-600">now</span>
          </div>
        </div>

        <!-- CPU Usage -->
        <div class="bg-slate-900/50 rounded-xl p-3 border border-slate-700/50">
          <h4 class="text-[11px] font-medium text-slate-400 mb-2 flex items-center gap-1.5">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            CPU 使用率
          </h4>
          <div v-if="selectedAgentCpu != null" class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-lg font-bold text-white">{{ selectedAgentCpu.toFixed(1) }}%</span>
              <span :class="cpuStatusClass">{{ cpuStatusLabel }}</span>
            </div>
            <div class="h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="cpuBarClass"
                :style="{ width: Math.min(selectedAgentCpu, 100) + '%' }"
              />
            </div>
          </div>
          <div v-else class="text-xs text-slate-600 py-4 text-center">
            选择 Agent 查看
          </div>
        </div>

        <!-- Memory Usage -->
        <div class="bg-slate-900/50 rounded-xl p-3 border border-slate-700/50">
          <h4 class="text-[11px] font-medium text-slate-400 mb-2 flex items-center gap-1.5">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            内存使用率
          </h4>
          <div v-if="selectedAgentMemory != null" class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-lg font-bold text-white">{{ selectedAgentMemory.toFixed(1) }}%</span>
              <span :class="memoryStatusClass">{{ memoryStatusLabel }}</span>
            </div>
            <div class="h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="memoryBarClass"
                :style="{ width: Math.min(selectedAgentMemory, 100) + '%' }"
              />
            </div>
          </div>
          <div v-else class="text-xs text-slate-600 py-4 text-center">
            选择 Agent 查看
          </div>
        </div>

        <!-- Message Stats -->
        <div class="bg-slate-900/50 rounded-xl p-3 border border-slate-700/50">
          <h4 class="text-[11px] font-medium text-slate-400 mb-2 flex items-center gap-1.5">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            消息统计
          </h4>
          <div class="grid grid-cols-2 gap-2">
            <div class="text-center p-2 bg-slate-800/50 rounded-lg">
              <div class="text-lg font-bold text-blue-400">{{ messageCount }}</div>
              <div class="text-[10px] text-slate-500">当前对话</div>
            </div>
            <div class="text-center p-2 bg-slate-800/50 rounded-lg">
              <div class="text-lg font-bold text-green-400">{{ store.systemStats.totalMessages }}</div>
              <div class="text-[10px] text-slate-500">总消息数</div>
            </div>
            <div class="text-center p-2 bg-slate-800/50 rounded-lg">
              <div class="text-lg font-bold text-purple-400">{{ store.systemStats.totalAgents }}</div>
              <div class="text-[10px] text-slate-500">Agent 总数</div>
            </div>
            <div class="text-center p-2 bg-slate-800/50 rounded-lg">
              <div class="text-lg font-bold text-green-400">{{ store.systemStats.onlineAgents }}</div>
              <div class="text-[10px] text-slate-500">在线</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Uptime & Extra Info -->
      <div v-if="store.selectedAgent" class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <div class="bg-slate-900/30 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <div class="text-[10px] text-slate-500">运行时长</div>
            <div class="text-xs text-white font-mono">{{ formatDuration(store.selectedAgent.uptime * 1000) }}</div>
          </div>
        </div>
        <div class="bg-slate-900/30 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <div>
            <div class="text-[10px] text-slate-500">平台</div>
            <div class="text-xs text-white">{{ getPlatformName(store.selectedAgent.platform) }}</div>
          </div>
        </div>
        <div class="bg-slate-900/30 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <div>
            <div class="text-[10px] text-slate-500">状态</div>
            <div :class="['text-xs font-medium', getStatusColor(store.selectedAgent.status)]">
              {{ getStatusLabel(store.selectedAgent.status) }}
            </div>
          </div>
        </div>
        <div class="bg-slate-900/30 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
          </svg>
          <div>
            <div class="text-[10px] text-slate-500">角色</div>
            <div class="text-xs text-white truncate max-w-[120px]">{{ store.selectedAgent.role || '未分配' }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import { getPlatformName, getStatusColor, getStatusLabel, formatDuration } from '@/utils/format.js'

const store = useSocketStore()
const isExpanded = ref(false)
const heartbeatHistory = ref([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

const currentLatency = computed(() => store.latency)

const selectedAgentCpu = computed(() => {
  if (!store.selectedAgent) return null
  return store.selectedAgent.cpuUsage ?? null
})

const selectedAgentMemory = computed(() => {
  if (!store.selectedAgent) return null
  return store.selectedAgent.memoryUsage ?? null
})

const messageCount = computed(() => store.currentMessages.length)

// CPU status
const cpuStatusClass = computed(() => {
  const cpu = selectedAgentCpu.value
  if (cpu > 80) return 'text-[10px] px-1.5 rounded bg-red-500/20 text-red-400'
  if (cpu > 50) return 'text-[10px] px-1.5 rounded bg-yellow-500/20 text-yellow-400'
  return 'text-[10px] px-1.5 rounded bg-green-500/20 text-green-400'
})

const cpuStatusLabel = computed(() => {
  const cpu = selectedAgentCpu.value
  if (cpu > 80) return '高负载'
  if (cpu > 50) return '中等'
  return '正常'
})

const cpuBarClass = computed(() => {
  const cpu = selectedAgentCpu.value
  if (cpu > 80) return 'bg-red-500'
  if (cpu > 50) return 'bg-yellow-500'
  return 'bg-green-500'
})

// Memory status
const memoryStatusClass = computed(() => {
  const mem = selectedAgentMemory.value
  if (mem > 80) return 'text-[10px] px-1.5 rounded bg-red-500/20 text-red-400'
  if (mem > 60) return 'text-[10px] px-1.5 rounded bg-yellow-500/20 text-yellow-400'
  return 'text-[10px] px-1.5 rounded bg-green-500/20 text-green-400'
})

const memoryStatusLabel = computed(() => {
  const mem = selectedAgentMemory.value
  if (mem > 80) return '紧张'
  if (mem > 60) return '较高'
  return '正常'
})

const memoryBarClass = computed(() => {
  const mem = selectedAgentMemory.value
  if (mem > 80) return 'bg-red-500'
  if (mem > 60) return 'bg-yellow-500'
  return 'bg-blue-500'
})

// Update heartbeat chart
let heartbeatInterval = null

onMounted(() => {
  heartbeatInterval = setInterval(() => {
    heartbeatHistory.value.shift()
    heartbeatHistory.value.push(store.latency ?? 0)
  }, 2000)
})

onUnmounted(() => {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
})
</script>
