import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'

export const useSocketStore = defineStore('socket', () => {
  // ========== State ==========
  const socket = ref(null)
  const agents = ref([])
  const messages = ref([])
  const transfers = ref([])
  const systemStats = ref({
    totalAgents: 0,
    onlineAgents: 0,
    totalMessages: 0,
    avgLatency: 0,
    uptime: 0
  })
  const connected = ref(false)
  const currentAgentId = ref(null)
  const latency = ref(0)
  const connectionError = ref(null)
  const claudeTasks = ref({})

  // Claude output callbacks (component-level, not reactive)
  let _claudeOutputCallbacks = []
  let _claudeCompleteCallbacks = []

  // ========== Getters ==========
  const onlineAgents = computed(() => agents.value.filter(a => a.status === 'online' || a.status === 'idle'))
  const busyAgents = computed(() => agents.value.filter(a => a.status === 'busy'))
  const offlineAgents = computed(() => agents.value.filter(a => a.status === 'offline' || a.status === 'disconnected' || a.status === 'error'))
  const selectedAgent = computed(() => agents.value.find(a => a.id === currentAgentId.value) || null)

  const currentMessages = computed(() => {
    if (!currentAgentId.value) return []
    return messages.value.filter(m =>
      m.from === currentAgentId.value ||
      m.to === currentAgentId.value ||
      m.to === 'broadcast'
    ).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
  })

  const currentTransfers = computed(() => {
    if (!currentAgentId.value) return []
    return transfers.value.filter(t =>
      t.from === currentAgentId.value || t.to === currentAgentId.value
    )
  })

  // ========== Actions ==========

  function connect(serverUrl = '') {
    if (socket.value?.connected) return

    connectionError.value = null

    const ioUrl = serverUrl || window.location.origin
    socket.value = io(ioUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    })

    socket.value.on('connect', () => {
      connected.value = true
      connectionError.value = null
      console.log('[Socket] Connected:', socket.value.id)
      joinDashboard()
    })

    socket.value.on('disconnect', (reason) => {
      connected.value = false
      console.log('[Socket] Disconnected:', reason)
    })

    socket.value.on('connect_error', (err) => {
      connected.value = false
      connectionError.value = err.message
      console.error('[Socket] Connection error:', err.message)
    })

    // Agent list
    socket.value.on('agent:list', (data) => {
      if (Array.isArray(data)) {
        agents.value = data
      } else if (data?.agents) {
        agents.value = data.agents
      }
      updateStats()
    })

    // New agent connected
    socket.value.on('agent:connected', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx], ...data, status: 'online' }
      } else {
        agents.value.push({
          ...data,
          id: data.agentId,
          name: data.name,
          role: data.role || '',
          platform: data.platform,
          status: 'online'
        })
      }
      updateStats()
      addSystemMessage(`Agent "${data.name}" 上线`, 'success')
    })

    // Agent disconnected
    socket.value.on('agent:disconnected', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = {
          ...agents.value[idx],
          status: 'offline',
          lastSeen: data.timestamp || Date.now()
        }
      }
      updateStats()
      addSystemMessage(`Agent "${data.name}" 离线`, 'warning')
    })

    // Agent updated
    socket.value.on('agent:update', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx], ...data }
      }
      updateStats()
    })

    // New message - merge server version over optimistic local
    socket.value.on('message:new', (data) => {
      const message = data.message || data
      if (!message || !message.id) return
      const idx = messages.value.findIndex(m => m.id === message.id)
      if (idx >= 0) {
        messages.value[idx] = { ...messages.value[idx], ...message }
      } else {
        messages.value.push(message)
        systemStats.value.totalMessages++
      }
    })

    // Message delivered confirmation
    socket.value.on('message:delivered', (data) => {
      const msg = messages.value.find(m => m.id === data.messageId)
      if (msg) {
        msg.delivered = true
        msg.deliveredAt = data.timestamp
      }
    })

    // Heartbeat update
    socket.value.on('heartbeat:update', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = {
          ...agents.value[idx],
          status: data.status || agents.value[idx].status,
          cpuUsage: data.cpuUsage,
          memoryUsage: data.memoryUsage,
          uptime: data.uptime,
          currentTask: data.currentTask,
          lastHeartbeat: data.timestamp,
          latency: data.latency
        }
        if (data.latency) {
          latency.value = data.latency
        }
      }
    })

    // Transfer update
    socket.value.on('transfer:update', (data) => {
      const idx = transfers.value.findIndex(t => t.id === data.id)
      if (idx >= 0) {
        transfers.value[idx] = { ...transfers.value[idx], ...data }
      } else {
        transfers.value.push(data)
      }
    })

    // Transfer progress
    socket.value.on('transfer:progress', (data) => {
      const idx = transfers.value.findIndex(t => t.id === data.fileId)
      if (idx >= 0) {
        transfers.value[idx].progress = data.progress
        transfers.value[idx].status = data.status
      }
    })

    // System stats
    socket.value.on('system:stats', (data) => {
      systemStats.value = { ...systemStats.value, ...data }
    })

    // Heartbeat ack (RTT latency calculation using echoed client time)
    socket.value.on('heartbeat:ack', (data) => {
      if (data.clientTime) {
        latency.value = Date.now() - data.clientTime
      }
    })

    // Claude Code streaming output
    socket.value.on('claude:output', (data) => {
      if (data?.taskId) {
        if (!claudeTasks.value[data.taskId]) {
          claudeTasks.value[data.taskId] = {
            status: 'running',
            startedAt: Date.now()
          }
        }
        claudeTasks.value[data.taskId].lastChunkAt = Date.now()
      }
      _claudeOutputCallbacks.forEach(cb => {
        try { cb(data) } catch (e) { /* don't break sibling callbacks */ }
      })
    })

    socket.value.on('claude:complete', (data) => {
      if (data?.taskId && claudeTasks.value[data.taskId]) {
        claudeTasks.value[data.taskId].status = data.exitCode === 0 ? 'success' : 'error'
        claudeTasks.value[data.taskId].duration = data.duration
        claudeTasks.value[data.taskId].exitCode = data.exitCode
      }
      _claudeCompleteCallbacks.forEach(cb => {
        try { cb(data) } catch (e) {}
      })
    })
  }

  function disconnect() {
    if (socket.value) {
      socket.value.removeAllListeners()
      socket.value.disconnect()
      socket.value = null
    }
    connected.value = false
    agents.value = []
    messages.value = []
    transfers.value = []
  }

  function sendMessage(message) {
    if (!socket.value?.connected) {
      console.error('[Socket] Not connected, cannot send message')
      return false
    }
    const payload = {
      id: generateId(),
      timestamp: Date.now(),
      ...message
    }
    socket.value.emit('message', payload)

    // Optimistically add to local messages
    if (!messages.value.find(m => m.id === payload.id)) {
      messages.value.push(payload)
      systemStats.value.totalMessages++
    }
    return true
  }

  function sendBtwMessage(target, content, options = {}) {
    return sendMessage({
      to: target,
      type: 'btw',
      content,
      metadata: {
        isBtw: true,
        urgency: options.urgency || 'normal',
        replyTo: options.replyTo || null
      }
    })
  }

  function assignRole(agentId, role, description) {
    if (!socket.value?.connected) return false

    sendMessage({
      to: agentId,
      type: 'role-assign',
      content: `你被分配为 "${role}" 角色`,
      metadata: {
        roleName: role,
        roleDescription: description
      }
    })

    // Update local agent
    const idx = agents.value.findIndex(a => a.id === agentId)
    if (idx >= 0) {
      agents.value[idx].role = role
    }
    return true
  }

  function requestStatus(agentId) {
    if (!socket.value?.connected) return false

    sendMessage({
      to: agentId,
      type: 'status-query',
      content: '请报告你当前的工作状态',
      metadata: { queryType: 'full-status' }
    })
    return true
  }

  function joinDashboard() {
    if (!socket.value?.connected) return
    socket.value.emit('dashboard:join', { timestamp: Date.now() })
  }

  function selectAgent(agentId) {
    currentAgentId.value = agentId
  }

  function sendFile(fileRequest) {
    if (!socket.value?.connected) return false
    socket.value.emit('file:request', fileRequest)

    transfers.value.push({
      id: fileRequest.id,
      name: fileRequest.name,
      size: fileRequest.size,
      from: 'dashboard',
      to: fileRequest.to,
      status: 'pending',
      progress: 0,
      timestamp: Date.now()
    })
    return true
  }

  function respondToFile(fileId, accepted) {
    if (!socket.value?.connected) return false
    socket.value.emit('file:response', { fileId, accepted })
    return true
  }

  function onClaudeOutput(fn) {
    _claudeOutputCallbacks.push(fn)
    return () => {
      _claudeOutputCallbacks = _claudeOutputCallbacks.filter(c => c !== fn)
    }
  }

  function onClaudeComplete(fn) {
    _claudeCompleteCallbacks.push(fn)
    return () => {
      _claudeCompleteCallbacks = _claudeCompleteCallbacks.filter(c => c !== fn)
    }
  }

  // ========== Helpers ==========

  function updateStats() {
    systemStats.value.totalAgents = agents.value.length
    systemStats.value.onlineAgents = onlineAgents.value.length
  }

  function addSystemMessage(text, type = 'info') {
    messages.value.push({
      id: 'sys-' + Date.now(),
      from: 'system',
      to: 'broadcast',
      type: 'system',
      content: text,
      metadata: { systemType: type },
      timestamp: Date.now()
    })
  }

  function generateId() {
    return 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9)
  }

  return {
    // State
    socket,
    agents,
    messages,
    transfers,
    systemStats,
    connected,
    currentAgentId,
    latency,
    connectionError,
    // Getters
    onlineAgents,
    busyAgents,
    offlineAgents,
    selectedAgent,
    currentMessages,
    currentTransfers,
    // Actions
    connect,
    disconnect,
    sendMessage,
    sendBtwMessage,
    assignRole,
    requestStatus,
    joinDashboard,
    selectAgent,
    sendFile,
    respondToFile,
    claudeTasks,
    onClaudeOutput,
    onClaudeComplete
  }
})
