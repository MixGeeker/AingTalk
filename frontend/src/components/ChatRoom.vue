<template>
  <div class="chat-room h-full flex flex-col bg-slate-900">
    <!-- Chat Header -->
    <div class="flex-shrink-0 px-4 py-3 border-b border-slate-700 bg-slate-800/50 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div v-if="store.selectedAgent" class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-base">
            {{ getPlatformIcon(store.selectedAgent.platform) }}
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-white">{{ store.selectedAgent.name || '未命名' }}</h3>
              <span
                class="w-2 h-2 rounded-full"
                :class="getStatusDotClass(store.selectedAgent.status)"
              />
            </div>
            <p class="text-xs text-slate-400">{{ store.selectedAgent.role || '暂无角色' }}</p>
          </div>
        </div>
        <div v-else class="flex items-center gap-2 text-slate-500">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span class="text-sm">选择一个 Agent 开始聊天</span>
        </div>
      </div>

      <!-- Header Actions -->
      <div v-if="store.selectedAgent" class="flex items-center gap-1">
        <button
          @click="showBtwInput = !showBtwInput"
          :class="[
            'px-3 py-1.5 text-xs rounded-lg font-medium transition-colors flex items-center gap-1.5',
            showBtwInput
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'
          ]"
        >
          <span class="font-bold">BTW</span>
          旁路询问
        </button>
        <button
          @click="showFilePanel = !showFilePanel"
          class="p-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-colors"
          title="文件传输"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <button
          @click="store.requestStatus(store.selectedAgent.id)"
          class="p-1.5 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-colors"
          title="查询状态"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- BTW Input Panel -->
    <div
      v-if="showBtwInput && store.selectedAgent"
      class="flex-shrink-0 px-4 py-3 bg-amber-900/20 border-b border-amber-500/20"
    >
      <div class="flex items-center gap-2 mb-2">
        <span class="text-xs font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">BTW</span>
        <span class="text-xs text-amber-400/70">旁路询问将直接发送，不受当前任务阻塞</span>
      </div>
      <div class="flex gap-2">
        <select
          v-model="btwUrgency"
          class="bg-slate-900 text-xs text-slate-300 px-2 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-amber-500"
        >
          <option value="low">低优先级</option>
          <option value="normal">普通</option>
          <option value="high">高优先级</option>
        </select>
        <input
          v-model="btwMessage"
          type="text"
          placeholder="输入旁路询问内容..."
          class="flex-1 bg-slate-900 text-sm text-white px-3 py-2 rounded-lg border border-slate-700 focus:outline-none focus:border-amber-500 placeholder-slate-500"
          @keydown.enter.prevent="sendBtw"
        />
        <button
          @click="sendBtw"
          :disabled="!btwMessage.trim()"
          class="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          发送
        </button>
      </div>
    </div>

    <!-- File Transfer Panel -->
    <div
      v-if="showFilePanel && store.selectedAgent"
      class="flex-shrink-0 border-b border-slate-700"
    >
      <FileTransfer :agent-id="store.selectedAgent.id" @close="showFilePanel = false" />
    </div>

    <!-- Messages Area -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto px-4 py-4 space-y-1"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDrop"
      :class="isDragging ? 'bg-blue-500/10 border-2 border-dashed border-blue-500/30' : ''"
    >
      <!-- Drag Overlay -->
      <div v-if="isDragging" class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div class="bg-slate-800/90 backdrop-blur-sm px-8 py-6 rounded-2xl border border-blue-500/30 shadow-2xl text-center">
          <svg class="w-12 h-12 text-blue-400 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p class="text-lg font-semibold text-white">释放以发送文件</p>
          <p class="text-sm text-slate-400 mt-1">支持压缩包和代码文件</p>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="!store.selectedAgent" class="h-full flex flex-col items-center justify-center text-slate-600">
        <svg class="w-20 h-20 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <p class="text-lg font-medium">从左侧选择一个 Agent</p>
        <p class="text-sm mt-1">开始实时协作调试</p>
      </div>

      <div v-else-if="store.currentMessages.length === 0" class="h-full flex flex-col items-center justify-center text-slate-600">
        <svg class="w-16 h-16 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <p class="text-sm">暂无消息</p>
        <p class="text-xs mt-1">发送第一条消息开始对话</p>
      </div>

      <!-- Message List -->
      <template v-else>
        <MessagePanel
          v-for="msg in store.currentMessages"
          :key="msg.id"
          :message="msg"
        />
      </template>

      <div ref="messagesEnd" />
    </div>

    <!-- Input Area -->
    <div v-if="store.selectedAgent" class="flex-shrink-0 px-4 py-3 border-t border-slate-700 bg-slate-800/50">
      <!-- @ Mention Dropdown -->
      <div
        v-if="showMentionDropdown"
        class="absolute bottom-20 left-4 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl py-1 min-w-[160px] max-h-[200px] overflow-y-auto z-20"
      >
        <div class="px-3 py-1.5 text-[10px] text-slate-500 font-medium border-b border-slate-700 mb-1">
          选择要提及的 Agent
        </div>
        <button
          v-for="agent in mentionableAgents"
          :key="agent.id"
          @click="insertMention(agent)"
          class="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 hover:text-white flex items-center gap-2"
        >
          <span class="text-base">{{ getPlatformIcon(agent.platform) }}</span>
          <span class="truncate">{{ agent.name }}</span>
          <span class="text-[10px] text-slate-500 ml-auto">{{ agent.role || '无角色' }}</span>
        </button>
      </div>

      <div class="flex items-end gap-2">
        <!-- Attach Button -->
        <button
          @click="showFilePanel = !showFilePanel"
          class="p-2.5 rounded-xl bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white transition-colors flex-shrink-0"
          title="发送文件"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        <!-- Text Input -->
        <div class="flex-1 relative">
          <textarea
            v-model="inputMessage"
            ref="messageInput"
            rows="1"
            placeholder="输入消息... (Shift+Enter 换行, Enter 发送)"
            class="w-full bg-slate-900 text-sm text-white px-4 py-2.5 pr-10 rounded-xl border border-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-500 resize-none overflow-hidden"
            :style="{ height: inputHeight + 'px' }"
            @input="handleInput"
            @keydown="handleKeydown"
          />
          <div class="absolute right-3 bottom-2.5 text-[10px] text-slate-600">
            {{ inputMessage.length }}/2000
          </div>
        </div>

        <!-- Send Button -->
        <button
          @click="sendMessage"
          :disabled="!inputMessage.trim() || !store.connected"
          :class="[
            'p-2.5 rounded-xl transition-all flex-shrink-0',
            inputMessage.trim() && store.connected
              ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/25'
              : 'bg-slate-700 text-slate-500 cursor-not-allowed'
          ]"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import { getPlatformIcon, getStatusDotClass } from '@/utils/format.js'
import MessagePanel from './MessagePanel.vue'
import FileTransfer from './FileTransfer.vue'

const store = useSocketStore()

// Input state
const inputMessage = ref('')
const inputHeight = ref(40)
const showBtwInput = ref(false)
const showFilePanel = ref(false)
const btwMessage = ref('')
const btwUrgency = ref('normal')
const showMentionDropdown = ref(false)
const mentionSearch = ref('')
const messagesContainer = ref(null)
const messagesEnd = ref(null)
const messageInput = ref(null)
const isDragging = ref(false)
const dragCounter = ref(0)

const mentionableAgents = computed(() => {
  return store.agents.filter(a => a.id !== store.selectedAgent?.id)
})

// Auto scroll
watch(() => store.currentMessages.length, async () => {
  await nextTick()
  scrollToBottom()
})

// Reset BTW state when switching agents
watch(() => store.currentAgentId, () => {
  btwMessage.value = ''
  btwUrgency.value = 'normal'
  showBtwInput.value = false
  inputMessage.value = ''
})

onMounted(() => {
  scrollToBottom()
})

function scrollToBottom() {
  if (messagesEnd.value) {
    messagesEnd.value.scrollIntoView({ behavior: 'smooth' })
  }
}

// Input handling
function handleInput(e) {
  inputHeight.value = Math.min(e.target.scrollHeight, 120)

  // Check for @ mention
  const cursorPos = el.selectionStart
  const textBeforeCursor = inputMessage.value.slice(0, cursorPos)
  const match = textBeforeCursor.match(/@([^\s]*)$/)
  if (match) {
    mentionSearch.value = match[1] || ''
    showMentionDropdown.value = true
  } else {
    showMentionDropdown.value = false
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (showMentionDropdown.value && mentionableAgents.value.length > 0) {
      insertMention(mentionableAgents.value[0])
    } else {
      sendMessage()
    }
  } else if (e.key === 'Escape') {
    showMentionDropdown.value = false
    showBtwInput.value = false
  }
}

function insertMention(agent) {
  const cursorPos = messageInput.value.selectionStart
  const textBeforeCursor = inputMessage.value.slice(0, cursorPos)
  const textAfterCursor = inputMessage.value.slice(cursorPos)
  const newTextBefore = textBeforeCursor.replace(/@[^\s]*$/, `@${agent.name} `)
  inputMessage.value = newTextBefore + textAfterCursor
  showMentionDropdown.value = false
  messageInput.value.focus()
}

function sendMessage() {
  const content = inputMessage.value.trim()
  if (!content || !store.selectedAgent || !store.connected) return

  // Check if @ mention is used
  const to = store.selectedAgent.id

  store.sendMessage({
    to,
    type: 'text',
    content,
    from: 'dashboard'
  })

  inputMessage.value = ''
  inputHeight.value = 40
}

function sendBtw() {
  const content = btwMessage.value.trim()
  if (!content || !store.selectedAgent) return

  store.sendBtwMessage(store.selectedAgent.id, content, {
    urgency: btwUrgency.value
  })

  btwMessage.value = ''
  showBtwInput.value = false
}

// Drag & drop
function handleDragOver() {
  dragCounter.value++
  isDragging.value = true
}

function handleDragLeave(e) {
  // 仅在真正离开容器时重置
  if (!messagesContainer.value || e.relatedTarget === null || !messagesContainer.value.contains(e.relatedTarget)) {
    isDragging.value = false
    dragCounter.value = 0
  }
}

function handleDrop(e) {
  isDragging.value = false
  dragCounter.value = 0
  if (e.dataTransfer.items) {
    e.dataTransfer.items.clear()
  }
  const files = e.dataTransfer.files
  if (files.length > 0 && store.selectedAgent) {
    // Trigger file transfer with dropped files
    showFilePanel.value = true
    // Files will be handled by FileTransfer component
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('chat:files-dropped', { detail: files }))
    }, 100)
  }
}

</script>
