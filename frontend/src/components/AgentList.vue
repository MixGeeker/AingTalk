<template>
  <div class="agent-list h-full flex flex-col bg-slate-800 border-r border-slate-700">
    <!-- Header -->
    <div class="px-3 py-3 border-b border-slate-700">
      <h2 class="text-sm font-bold text-white flex items-center gap-2">
        <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
        </svg>
        Agents
        <span class="text-xs font-normal text-slate-500">({{ store.agents.length }})</span>
      </h2>
    </div>

    <!-- Agent Cards -->
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <div
        v-for="agent in store.agents"
        :key="agent.id"
        class="p-2.5 rounded-lg border transition-colors"
        :class="isOnline(agent) ? 'bg-slate-800/50 border-slate-700/50' : 'bg-slate-900/50 border-transparent opacity-50'"
      >
        <div class="flex items-center gap-2.5">
          <!-- Status dot -->
          <div
            class="w-2 h-2 rounded-full flex-shrink-0"
            :class="statusDotClass(agent)"
          />

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium text-slate-200 truncate">{{ agent.name }}</div>
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-[10px] text-slate-500">{{ getPlatformIcon(agent.platform) }} {{ agent.arch }}</span>
              <span v-if="agent.latency" class="text-[10px] text-slate-600">{{ agent.latency }}ms</span>
            </div>
          </div>

          <!-- Metrics -->
          <div v-if="isOnline(agent) && agent.cpuUsage != null" class="text-right flex-shrink-0">
            <div class="text-[10px] text-slate-500 font-mono">CPU {{ Math.round(agent.cpuUsage) }}%</div>
            <div v-if="agent.memoryUsage" class="text-[10px] text-slate-500 font-mono">MEM {{ Math.round(agent.memoryUsage) }}%</div>
          </div>
        </div>

        <!-- Current task -->
        <div v-if="agent.currentTask" class="mt-1.5 text-[10px] text-amber-400/80 truncate pl-4">
          {{ typeof agent.currentTask === 'string' ? agent.currentTask : agent.currentTask.description }}
        </div>

        <!-- Status label for offline -->
        <div v-if="!isOnline(agent)" class="mt-1 text-[10px] text-slate-600 pl-4">
          {{ getStatusLabel(agent.status) }}
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="store.agents.length === 0" class="text-center py-8">
        <p class="text-xs text-slate-600">等待 Agent 连接...</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useSocketStore } from '@/stores/socket.js'
import { getPlatformIcon, getStatusLabel } from '@/utils/format.js'

const store = useSocketStore()

function isOnline(agent) {
  return agent.status === 'online' || agent.status === 'idle' || agent.status === 'busy'
}

function statusDotClass(agent) {
  if (agent.status === 'busy') return 'bg-yellow-400 shadow-yellow-400/50 shadow-sm animate-pulse'
  if (isOnline(agent)) return 'bg-green-400 shadow-green-400/50 shadow-sm'
  return 'bg-slate-600'
}
</script>
