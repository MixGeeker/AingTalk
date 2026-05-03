<template>
  <div class="file-transfer bg-slate-800/80 border-b border-slate-700 p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-white flex items-center gap-2">
        <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        文件传输
        <span class="text-xs font-normal text-slate-400">{{ allowedTypesLabel }}</span>
      </h3>
      <button
        @click="$emit('close')"
        class="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Upload Area -->
    <div
      ref="dropZone"
      :class="[
        'border-2 border-dashed rounded-xl p-6 text-center transition-all',
        isDragOver
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-slate-700 bg-slate-900/50 hover:border-slate-600 hover:bg-slate-900'
      ]"
      @dragover.prevent="isDragOver = true"
      @dragleave.prevent="isDragOver = false"
      @drop.prevent="handleFileDrop"
      @click="triggerFileSelect"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        :accept="acceptTypes"
        @change="handleFileSelect"
      />
      <svg class="w-10 h-10 text-slate-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
      <p class="text-sm text-slate-400">
        <span class="text-blue-400 font-medium">点击选择</span> 或拖拽文件到此处
      </p>
      <p class="text-xs text-slate-600 mt-1">支持 ZIP, TAR, JS, TS, PY, JAVA, GO, RS, C, CPP, H 等</p>
    </div>

    <!-- Transfer List -->
    <div v-if="transferList.length > 0" class="mt-4 space-y-2 max-h-[200px] overflow-y-auto">
      <div
        v-for="transfer in transferList"
        :key="transfer.id"
        class="bg-slate-900/80 rounded-lg p-3 border border-slate-700"
      >
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2 min-w-0">
            <!-- File Icon -->
            <div class="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
              <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div class="min-w-0">
              <p class="text-xs text-white font-medium truncate">{{ transfer.name }}</p>
              <p class="text-[10px] text-slate-500">{{ formatFileSize(transfer.size) }}</p>
            </div>
          </div>

          <!-- Status Actions -->
          <div class="flex items-center gap-1 flex-shrink-0">
            <span :class="['text-[10px] px-1.5 py-0.5 rounded-full font-medium', statusBadgeClass(transfer.status)]">
              {{ statusLabel(transfer.status) }}
            </span>
            <button
              v-if="transfer.status === 'pending' || transfer.status === 'transferring'"
              @click="cancelTransfer(transfer.id)"
              class="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              title="取消"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <button
              v-if="transfer.status === 'completed'"
              class="p-1 rounded text-slate-500 hover:text-green-400 hover:bg-green-400/10 transition-colors"
              title="完成"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Progress Bar -->
        <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all duration-300"
            :class="progressBarClass(transfer.status)"
            :style="{ width: (transfer.progress || 0) + '%' }"
          />
        </div>
        <div class="flex justify-between mt-1">
          <span class="text-[10px] text-slate-500">{{ transfer.progress || 0 }}%</span>
          <span v-if="transfer.speed" class="text-[10px] text-slate-500">{{ formatFileSize(transfer.speed) }}/s</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import { formatFileSize } from '@/utils/format.js'

const props = defineProps({
  agentId: {
    type: String,
    required: true
  }
})

defineEmits(['close'])

const store = useSocketStore()
const fileInput = ref(null)
const dropZone = ref(null)
const isDragOver = ref(false)
const localTransfers = ref([])

const allowedExtensions = ['.zip', '.tar', '.gz', '.rar', '.7z', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.sh', '.bat', '.ps1', '.sql', '.md', '.txt']
const allowedMimeTypes = ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-rar', 'application/x-7z-compressed', 'text/plain', 'application/json', 'application/xml']

const acceptTypes = allowedExtensions.join(',') + ',' + allowedMimeTypes.join(',')
const allowedTypesLabel = '压缩包 + 代码文件'

const transferList = computed(() => {
  const remote = store.currentTransfers.filter(t => t.agentId === props.agentId || t.to === props.agentId || t.from === props.agentId)
  return [...localTransfers.value, ...remote]
})

function triggerFileSelect() {
  fileInput.value?.click()
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files || [])
  if (files.length) {
    files.forEach(file => processFile(file))
  }
  e.target.value = ''
}

function handleFileDrop(e) {
  isDragOver.value = false
  const files = Array.from(e.dataTransfer.files || [])
  files.forEach(file => processFile(file))
}

function isAllowedFile(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase()
  if (allowedExtensions.includes(ext)) return true
  if (allowedMimeTypes.includes(file.type)) return true
  if (file.type.startsWith('text/')) return true
  return false
}

function processFile(file) {
  if (!isAllowedFile(file)) {
    alert(`不支持的文件类型: ${file.name}\n仅支持压缩包和代码文件`)
    return
  }

  const transfer = {
    id: 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    name: file.name,
    size: file.size,
    type: file.type,
    progress: 0,
    status: 'pending',
    timestamp: Date.now(),
    to: props.agentId,
    from: 'dashboard',
    file: file
  }

  localTransfers.value.push(transfer)

  // Send file request via socket
  store.sendFile({
    id: transfer.id,
    name: transfer.name,
    size: transfer.size,
    mimeType: transfer.type,
    from: 'dashboard',
    to: props.agentId
  })

  // Simulate progress (in real app, this comes from socket events)
  simulateProgress(transfer.id)
}

function simulateProgress(fileId) {
  let progress = 0
  const interval = setInterval(() => {
    const t = localTransfers.value.find(x => x.id === fileId)
    if (!t) { clearInterval(interval); return }
    if (t.status === 'cancelled' || t.status === 'error') { clearInterval(interval); return }

    progress += Math.random() * 20
    if (progress >= 100) {
      progress = 100
      t.progress = 100
      t.status = 'completed'
      clearInterval(interval)
    } else {
      t.progress = Math.round(progress)
      t.status = 'transferring'
    }
  }, 500)
}

function cancelTransfer(fileId) {
  const t = localTransfers.value.find(x => x.id === fileId)
  if (t) t.status = 'cancelled'
  store.respondToFile(fileId, false)
}

function statusLabel(status) {
  const labels = {
    pending: '等待中',
    transferring: '传输中',
    completed: '完成',
    cancelled: '已取消',
    error: '失败',
    rejected: '已拒绝'
  }
  return labels[status] || status
}

function statusBadgeClass(status) {
  const classes = {
    pending: 'bg-yellow-500/20 text-yellow-400',
    transferring: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-green-500/20 text-green-400',
    cancelled: 'bg-gray-500/20 text-gray-400',
    error: 'bg-red-500/20 text-red-400',
    rejected: 'bg-red-500/20 text-red-400'
  }
  return classes[status] || 'bg-gray-500/20 text-gray-400'
}

function progressBarClass(status) {
  const classes = {
    pending: 'bg-yellow-500',
    transferring: 'bg-blue-500',
    completed: 'bg-green-500',
    cancelled: 'bg-gray-600',
    error: 'bg-red-500',
    rejected: 'bg-red-500'
  }
  return classes[status] || 'bg-blue-500'
}
</script>
