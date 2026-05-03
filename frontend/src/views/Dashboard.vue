<template>
  <div class="dashboard h-full flex flex-col">
    <!-- Top Navigation Bar -->
    <header class="flex-shrink-0 h-14 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
          <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div>
          <h1 class="text-sm font-bold text-white leading-tight">Agent 联调测试平台</h1>
          <p class="text-[10px] text-slate-500 leading-tight">Multi-Agent Collaboration</p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <!-- Connection Status -->
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700">
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
            placeholder="ws://localhost:3000"
            class="bg-slate-900 text-xs text-white px-3 py-1.5 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 w-48 placeholder-slate-600"
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

    <!-- Main Content Area -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left Sidebar: Agent List -->
      <aside class="w-[280px] flex-shrink-0 h-full">
        <AgentList />
      </aside>

      <!-- Right Main Area -->
      <main class="flex-1 flex flex-col min-w-0 h-full">
        <!-- Chat Room (main area) -->
        <div class="flex-1 min-h-0">
          <ChatRoom />
        </div>

        <!-- Status Monitor (collapsible bottom panel) -->
        <StatusMonitor />
      </main>
    </div>

    <!-- Bottom Status Bar -->
    <footer class="flex-shrink-0 h-10 bg-slate-800 border-t border-slate-700 flex items-center justify-between px-4">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-1.5">
          <div
            class="w-1.5 h-1.5 rounded-full"
            :class="store.connected ? 'bg-green-400' : 'bg-red-400'"
          />
          <span class="text-[11px] text-slate-400">
            {{ store.connected ? '服务器在线' : '服务器离线' }}
          </span>
        </div>

        <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          <span class="text-slate-400 font-medium">{{ store.systemStats.onlineAgents }}</span>
          <span>/ {{ store.systemStats.totalAgents }} Agent 在线</span>
        </div>
      </div>

      <div class="flex items-center gap-4">
        <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <span>延迟:</span>
          <span :class="['font-mono font-medium', store.latency > 200 ? 'text-red-400' : store.latency > 100 ? 'text-yellow-400' : 'text-green-400']">
            {{ store.latency }}ms
          </span>
        </div>

        <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span>消息:</span>
          <span class="text-slate-400 font-medium">{{ store.systemStats.totalMessages }}</span>
        </div>

        <div v-if="store.connectionError" class="text-[11px] text-red-400 truncate max-w-[200px]">
          {{ store.connectionError }}
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import AgentList from '@/components/AgentList.vue'
import ChatRoom from '@/components/ChatRoom.vue'
import StatusMonitor from '@/components/StatusMonitor.vue'

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
