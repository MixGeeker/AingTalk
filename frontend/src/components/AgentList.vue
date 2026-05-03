<template>
  <div class="agent-list h-full flex flex-col bg-slate-800 border-r border-slate-700">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-slate-700">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-bold text-white flex items-center gap-2">
          <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          Agent 列表
          <span class="text-xs font-normal text-slate-400">({{ filteredAgents.length }})</span>
        </h2>
        <button
          @click="refreshList"
          :class="[
            'p-1.5 rounded-lg transition-colors',
            isRefreshing ? 'text-blue-400 animate-spin' : 'text-slate-400 hover:text-white hover:bg-slate-700'
          ]"
          title="刷新列表"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <!-- Search -->
      <div class="relative">
        <svg class="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索 Agent..."
          class="w-full bg-slate-900 text-sm text-white pl-9 pr-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-500"
        />
      </div>

      <!-- Status Filter -->
      <div class="flex gap-1 mt-2">
        <button
          v-for="filter in statusFilters"
          :key="filter.value"
          @click="activeFilter = filter.value"
          :class="[
            'px-2 py-0.5 text-[11px] rounded-md font-medium transition-colors',
            activeFilter === filter.value
              ? 'bg-blue-600 text-white'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white'
          ]"
        >
          {{ filter.label }}
          <span class="ml-0.5 opacity-70">{{ filter.count }}</span>
        </button>
      </div>
    </div>

    <!-- Agent Cards -->
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <div
        v-for="agent in filteredAgents"
        :key="agent.id"
        @click="selectAgent(agent.id)"
        @contextmenu.prevent="showContextMenu($event, agent)"
        :class="[
          'agent-card relative p-3 rounded-xl cursor-pointer transition-all duration-200 border',
          store.currentAgentId === agent.id
            ? 'bg-slate-700 border-blue-500/50 shadow-lg shadow-blue-500/10'
            : 'bg-slate-800/50 border-transparent hover:bg-slate-700/80 hover:border-slate-600'
        ]"
      >
        <div class="flex items-start gap-3">
          <!-- Platform Icon -->
          <div class="flex-shrink-0 mt-0.5">
            <div class="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-lg border border-slate-700">
              {{ getPlatformIcon(agent.platform) }}
            </div>
          </div>

          <!-- Agent Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-white truncate">{{ agent.name || '未命名 Agent' }}</h3>
              <div
                class="w-2 h-2 rounded-full flex-shrink-0"
                :class="getStatusDotClass(agent.status)"
                :title="getStatusLabel(agent.status)"
              />
            </div>

            <p class="text-xs text-slate-400 mt-0.5 truncate">
              {{ agent.role || '暂无角色' }}
            </p>

            <!-- Meta Info -->
            <div class="flex items-center gap-2 mt-1.5 flex-wrap">
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-500 border border-slate-700">
                {{ getPlatformName(agent.platform) }}
              </span>
              <span v-if="agent.latency" class="text-[10px] text-slate-500">
                {{ agent.latency }}ms
              </span>
              <span v-if="agent.cpuUsage != null" class="text-[10px] text-slate-500">
                CPU {{ agent.cpuUsage.toFixed(0) }}%
              </span>
            </div>

            <!-- Current Task -->
            <div v-if="agent.currentTask" class="mt-1.5 text-[11px] text-yellow-400/80 truncate bg-yellow-400/5 px-1.5 py-0.5 rounded">
              {{ typeof agent.currentTask === 'string' ? agent.currentTask : agent.currentTask.description }}
            </div>
          </div>

          <!-- Hover Actions -->
          <div class="agent-actions absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition-opacity duration-150">
            <button
              @click.stop="openRoleDialog(agent)"
              class="p-1 rounded-md bg-slate-900 text-blue-400 hover:bg-blue-600 hover:text-white transition-colors"
              title="分配角色"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </button>
            <button
              @click.stop="requestStatus(agent.id)"
              class="p-1 rounded-md bg-slate-900 text-purple-400 hover:bg-purple-600 hover:text-white transition-colors"
              title="查询状态"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Status Bar -->
        <div v-if="agent.memoryUsage != null || agent.uptime" class="mt-2 pt-2 border-t border-slate-700/50 flex gap-2">
          <div v-if="agent.memoryUsage" class="flex-1">
            <div class="flex justify-between text-[10px] text-slate-500 mb-0.5">
              <span>内存</span>
              <span>{{ agent.memoryUsage.toFixed(0) }}%</span>
            </div>
            <div class="h-1 bg-slate-900 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                :class="agent.memoryUsage > 80 ? 'bg-red-500' : agent.memoryUsage > 60 ? 'bg-yellow-500' : 'bg-green-500'"
                :style="{ width: agent.memoryUsage + '%' }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="filteredAgents.length === 0" class="text-center py-12">
        <svg class="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <p class="text-sm text-slate-500">暂无 Agent</p>
        <p class="text-xs text-slate-600 mt-1">等待 Agent 连接到服务器...</p>
      </div>
    </div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="contextMenu.show"
        class="fixed z-50 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 min-w-[140px]"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        v-click-outside="hideContextMenu"
      >
        <button
          @click="openRoleDialog(contextMenu.agent); hideContextMenu()"
          class="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
        >
          <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          分配角色
        </button>
        <button
          @click="requestStatus(contextMenu.agent?.id); hideContextMenu()"
          class="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
        >
          <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          查询状态
        </button>
        <div class="border-t border-slate-700 my-1" />
        <button
          @click="disconnectAgent(contextMenu.agent?.id); hideContextMenu()"
          class="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          断开连接
        </button>
      </div>
    </Teleport>

    <!-- Role Assignment Dialog -->
    <Teleport to="body">
      <div v-if="roleDialog.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div class="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
          <h3 class="text-lg font-bold text-white mb-1">分配角色</h3>
          <p class="text-sm text-slate-400 mb-4">为 "{{ roleDialog.agent?.name }}" 分配角色</p>

          <div class="space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-400 mb-1.5">角色名称</label>
              <input
                v-model="roleDialog.roleName"
                type="text"
                placeholder="例如：API调试专家"
                class="w-full bg-slate-900 text-sm text-white px-3 py-2.5 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-400 mb-1.5">角色描述</label>
              <textarea
                v-model="roleDialog.roleDescription"
                rows="3"
                placeholder="描述该角色的职责..."
                class="w-full bg-slate-900 text-sm text-white px-3 py-2.5 rounded-lg border border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-600 resize-none"
              />
            </div>
          </div>

          <div class="flex gap-2 mt-6">
            <button
              @click="closeRoleDialog"
              class="flex-1 px-4 py-2.5 text-sm text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              @click="confirmRole"
              class="flex-1 px-4 py-2.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors font-medium"
            >
              确认分配
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import { getPlatformIcon, getPlatformName, getStatusLabel } from '@/utils/format.js'

const store = useSocketStore()
const searchQuery = ref('')
const activeFilter = ref('all')
const isRefreshing = ref(false)

const statusFilters = computed(() => [
  { value: 'all', label: '全部', count: store.agents.length },
  { value: 'online', label: '在线', count: store.onlineAgents.length },
  { value: 'busy', label: '忙碌', count: store.busyAgents.length },
  { value: 'offline', label: '离线', count: store.offlineAgents.length }
])

const filteredAgents = computed(() => {
  let agents = store.agents

  // Search filter
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    agents = agents.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.role || '').toLowerCase().includes(q) ||
      (a.hostname || '').toLowerCase().includes(q)
    )
  }

  // Status filter
  if (activeFilter.value !== 'all') {
    if (activeFilter.value === 'online') {
      agents = agents.filter(a => a.status === 'online' || a.status === 'idle')
    } else {
      agents = agents.filter(a => a.status === activeFilter.value)
    }
  }

  return agents
})

function selectAgent(agentId) {
  store.selectAgent(agentId)
}

function requestStatus(agentId) {
  store.requestStatus(agentId)
}

function disconnectAgent(agentId) {
  if (confirm('确定要断开此 Agent 的连接吗？')) {
    store.sendMessage({
      to: agentId,
      type: 'command',
      content: '/disconnect',
      metadata: { command: 'disconnect' }
    })
  }
}

function refreshList() {
  isRefreshing.value = true
  store.joinDashboard()
  setTimeout(() => { isRefreshing.value = false }, 800)
}

// Status dot
function getStatusDotClass(status) {
  const map = {
    online: 'bg-green-400 shadow-green-400/50 shadow-sm',
    idle: 'bg-green-400 shadow-green-400/50 shadow-sm',
    busy: 'bg-yellow-400 shadow-yellow-400/50 shadow-sm',
    error: 'bg-red-400 shadow-red-400/50 shadow-sm',
    offline: 'bg-gray-600',
    disconnected: 'bg-gray-600'
  }
  return map[status] || 'bg-gray-600'
}

// Context menu
const contextMenu = ref({ show: false, x: 0, y: 0, agent: null })

function showContextMenu(e, agent) {
  contextMenu.value = { show: true, x: e.clientX, y: e.clientY, agent }
}

function hideContextMenu() {
  contextMenu.value.show = false
}

// Role dialog
const roleDialog = ref({ show: false, agent: null, roleName: '', roleDescription: '' })

function openRoleDialog(agent) {
  roleDialog.value = {
    show: true,
    agent,
    roleName: agent.role || '',
    roleDescription: agent.roleDescription || ''
  }
}

function closeRoleDialog() {
  roleDialog.value.show = false
}

function confirmRole() {
  if (!roleDialog.value.roleName.trim()) return
  store.assignRole(
    roleDialog.value.agent.id,
    roleDialog.value.roleName.trim(),
    roleDialog.value.roleDescription.trim()
  )
  closeRoleDialog()
}

// Click outside directive (inline)
const vClickOutside = {
  mounted(el, binding) {
    el._clickOutside = (e) => { if (!el.contains(e.target)) binding.value() }
    document.addEventListener('click', el._clickOutside)
  },
  unmounted(el) {
    document.removeEventListener('click', el._clickOutside)
  }
}
</script>

<style scoped>
.agent-card:hover .agent-actions {
  opacity: 1;
}
</style>
