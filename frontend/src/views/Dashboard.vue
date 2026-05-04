<template>
  <div class="dashboard h-full flex flex-col">
    <!-- Header -->
    <header class="flex-shrink-0 h-12 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <div class="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
          <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          </svg>
        </div>
        <h1 class="text-sm font-bold text-white">AingTalk Terminal</h1>
      </div>

      <div class="flex items-center gap-3">
        <!-- Connection Status -->
        <div class="flex items-center gap-2 px-3 py-1 rounded-lg bg-slate-900 border border-slate-700">
          <div
            class="w-2 h-2 rounded-full"
            :class="store.connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'"
          />
          <span class="text-xs text-slate-400">
            {{ store.connected ? '已连接' : '未连接' }}
          </span>
        </div>

        <!-- Server URL Input (when disconnected) -->
        <div v-if="!store.connected" class="flex items-center gap-2">
          <input
            v-model="serverUrl"
            type="text"
            placeholder="http://localhost:3000"
            class="bg-slate-900 text-xs text-white px-3 py-1.5 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 w-48 placeholder-slate-600"
            @keyup.enter="connect"
          />
          <button
            @click="connect"
            :disabled="isConnecting"
            class="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {{ isConnecting ? '连接中...' : '连接' }}
          </button>
        </div>

        <button
          v-else
          @click="disconnect"
          class="px-3 py-1.5 text-xs font-medium bg-slate-700 text-slate-300 rounded-lg hover:bg-red-600 hover:text-white transition-colors"
        >
          断开
        </button>
      </div>
    </header>

    <!-- Main Content -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left Sidebar: Agent List -->
      <aside class="w-[200px] flex-shrink-0 h-full">
        <AgentList />
      </aside>

      <!-- Right: Terminal Grid -->
      <main class="flex-1 flex flex-col min-w-0 h-full p-1">
        <TerminalGrid />
      </main>
    </div>

    <!-- Footer -->
    <footer class="flex-shrink-0 h-8 bg-slate-800 border-t border-slate-700 flex items-center justify-between px-4">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-1.5">
          <div
            class="w-1.5 h-1.5 rounded-full"
            :class="store.connected ? 'bg-green-400' : 'bg-red-400'"
          />
          <span class="text-[11px] text-slate-400">
            {{ store.connected ? '在线' : '离线' }}
          </span>
        </div>
        <span class="text-[11px] text-slate-500">
          <span class="text-slate-400 font-medium">{{ store.systemStats.onlineAgents }}</span>/{{ store.systemStats.totalAgents }} Agents
        </span>
      </div>

      <div class="flex items-center gap-4">
        <span class="text-[11px] text-slate-500">
          延迟: <span :class="['font-mono font-medium', store.latency > 200 ? 'text-red-400' : store.latency > 100 ? 'text-yellow-400' : 'text-green-400']">{{ store.latency }}ms</span>
        </span>
        <span v-if="store.connectionError" class="text-[11px] text-red-400 truncate max-w-[200px]">
          {{ store.connectionError }}
        </span>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import AgentList from '@/components/AgentList.vue'
import TerminalGrid from '@/components/TerminalGrid.vue'

const store = useSocketStore()
const serverUrl = ref('')
const isConnecting = ref(false)

function connect() {
  isConnecting.value = true
  store.connect(serverUrl.value || undefined)
  setTimeout(() => { isConnecting.value = false }, 2000)
}

function disconnect() {
  store.disconnect()
}
</script>
