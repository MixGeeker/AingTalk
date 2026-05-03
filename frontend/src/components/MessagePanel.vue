<template>
  <div
    :class="[
      'message-panel flex gap-3 mb-4',
      isOwn ? 'flex-row-reverse' : 'flex-row'
    ]"
  >
    <!-- Avatar -->
    <div class="flex-shrink-0">
      <div
        :class="[
          'w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold',
          avatarBgClass
        ]"
      >
        {{ senderInitial }}
      </div>
    </div>

    <!-- Message Content -->
    <div :class="['flex-1 max-w-[80%]', isOwn ? 'items-end' : 'items-start']" class="flex flex-col">
      <!-- Sender Info -->
      <div class="flex items-center gap-2 mb-1" :class="isOwn ? 'flex-row-reverse' : 'flex-row'">
        <span class="text-xs text-slate-400 font-medium">{{ senderName }}</span>
        <span class="text-[10px] text-slate-500">{{ formatTime(message.timestamp) }}</span>
        <span
          v-if="typeLabel"
          :class="['text-[10px] px-1.5 py-0.5 rounded-full font-medium', typeBadgeClass]"
        >
          {{ typeLabel }}
        </span>
      </div>

      <!-- Message Bubble -->
      <div :class="bubbleClass">
        <!-- BTW Label -->
        <div v-if="message.type === 'btw'" class="flex items-center gap-1 mb-1.5">
          <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
            BTW
          </span>
          <span v-if="message.metadata?.urgency" :class="urgencyClass">
            {{ message.metadata.urgency }}
          </span>
        </div>

        <!-- Role Assign Content -->
        <div v-if="message.type === 'role-assign'" class="space-y-2">
          <div class="flex items-center gap-2 text-blue-400 font-medium text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>{{ message.metadata?.roleName || '角色分配' }}</span>
          </div>
          <p class="text-sm text-slate-200">{{ message.content }}</p>
          <p v-if="message.metadata?.roleDescription" class="text-xs text-slate-400 bg-slate-900/50 p-2 rounded">
            {{ message.metadata.roleDescription }}
          </p>
        </div>

        <!-- Task Assign Content -->
        <div v-else-if="message.type === 'task-assign'" class="space-y-2">
          <div class="flex items-center gap-2 text-orange-400 font-medium text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <span>任务分配</span>
          </div>
          <p class="text-sm text-slate-200">{{ message.content }}</p>
          <div v-if="message.metadata?.taskDescription" class="text-xs text-slate-400 bg-slate-900/50 p-2 rounded flex items-center justify-between">
            <span>{{ message.metadata.taskDescription }}</span>
            <span v-if="message.metadata?.priority" :class="priorityClass">
              {{ message.metadata.priority }}
            </span>
          </div>
        </div>

        <!-- Status Query Content -->
        <div v-else-if="message.type === 'status-query'" class="space-y-2">
          <div class="flex items-center gap-2 text-purple-400 font-medium text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>状态查询</span>
          </div>
          <p class="text-sm text-slate-200">{{ message.content }}</p>
        </div>

        <!-- Response / Reply Content -->
        <div v-else-if="message.type === 'response'" class="space-y-2">
          <div v-if="message.metadata?.replyTo" class="text-xs text-slate-500 bg-slate-900/50 p-2 rounded border-l-2 border-slate-500 mb-2">
            <span class="italic">回复消息</span>
          </div>
          <p class="text-sm text-slate-200 whitespace-pre-wrap">{{ message.content }}</p>
        </div>

        <!-- File Notice Content -->
        <div v-else-if="message.type === 'file-notice'" class="space-y-2">
          <div class="flex items-center gap-2 text-green-400 font-medium text-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>文件传输</span>
          </div>
          <p class="text-sm text-slate-200">{{ message.content }}</p>
        </div>

        <!-- System Message -->
        <div v-else-if="message.type === 'system'" class="text-center">
          <span :class="['text-xs px-3 py-1 rounded-full', systemBadgeClass]">
            {{ message.content }}
          </span>
        </div>

        <!-- Regular Text Content -->
        <p v-else class="text-sm text-slate-100 whitespace-pre-wrap break-words leading-relaxed">
          {{ message.content }}
        </p>

        <!-- Delivery Status -->
        <div v-if="isOwn && message.type !== 'system'" class="flex items-center justify-end gap-1 mt-1">
          <span v-if="message.delivered" class="text-[10px] text-blue-400 flex items-center gap-0.5">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            已送达
          </span>
          <span v-else class="text-[10px] text-slate-500">发送中...</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import { formatTime, getMessageTypeLabel } from '@/utils/format.js'

const props = defineProps({
  message: {
    type: Object,
    required: true
  }
})

const store = useSocketStore()

const isOwn = computed(() => {
  return props.message.from === 'dashboard' || props.message.from === store.socket?.id
})

const senderName = computed(() => {
  if (props.message.from === 'system') return '系统'
  if (props.message.from === 'dashboard') return '我'
  const agent = store.agents.find(a => a.id === props.message.from)
  return agent?.name || props.message.from?.slice(0, 8) || 'Unknown'
})

const senderInitial = computed(() => {
  if (props.message.from === 'system') return 'S'
  if (props.message.from === 'dashboard') return '我'
  return senderName.value.charAt(0).toUpperCase()
})

const typeLabel = computed(() => {
  const type = props.message.type
  if (type === 'text' || type === 'system' || type === 'response') return ''
  return getMessageTypeLabel(type)
})

const avatarBgClass = computed(() => {
  if (props.message.from === 'system') return 'bg-slate-600 text-slate-200'
  if (props.message.from === 'dashboard') return 'bg-blue-600 text-white'
  if (props.message.type === 'btw') return 'bg-amber-600 text-white'
  if (props.message.type === 'role-assign') return 'bg-blue-500/20 text-blue-400'
  if (props.message.type === 'task-assign') return 'bg-orange-500/20 text-orange-400'
  return 'bg-slate-700 text-slate-300'
})

const bubbleClass = computed(() => {
  const base = 'rounded-2xl px-4 py-2.5 max-w-full'
  if (props.message.type === 'system') {
    return base + ' bg-transparent'
  }
  if (props.message.type === 'btw') {
    return base + ' bg-amber-900/30 border border-amber-500/30 text-amber-50'
  }
  if (isOwn.value) {
    return base + ' bg-blue-600 text-white rounded-tr-sm'
  }
  return base + ' bg-slate-800 text-slate-100 rounded-tl-sm border border-slate-700'
})

const typeBadgeClass = computed(() => {
  const colors = {
    'role-assign': 'bg-blue-500/20 text-blue-400',
    'task-assign': 'bg-orange-500/20 text-orange-400',
    'status-query': 'bg-purple-500/20 text-purple-400',
    'file-notice': 'bg-green-500/20 text-green-400',
    'btw': 'bg-amber-500/20 text-amber-400'
  }
  return colors[props.message.type] || 'bg-slate-600 text-slate-300'
})

const urgencyClass = computed(() => {
  const u = props.message.metadata?.urgency
  if (u === 'high') return 'text-[10px] px-1.5 rounded bg-red-500/20 text-red-400'
  if (u === 'normal') return 'text-[10px] px-1.5 rounded bg-blue-500/20 text-blue-400'
  return 'text-[10px] px-1.5 rounded bg-green-500/20 text-green-400'
})

const priorityClass = computed(() => {
  const p = props.message.metadata?.priority
  if (p === 'high') return 'text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium'
  if (p === 'normal') return 'text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium'
  return 'text-[10px] px-1.5 py-0.5 rounded bg-slate-600 text-slate-400 font-medium'
})

const systemBadgeClass = computed(() => {
  const type = props.message.metadata?.systemType || 'info'
  const colors = {
    success: 'bg-green-500/20 text-green-400',
    warning: 'bg-yellow-500/20 text-yellow-400',
    error: 'bg-red-500/20 text-red-400',
    info: 'bg-blue-500/20 text-blue-400'
  }
  return colors[type] || colors.info
})
</script>
