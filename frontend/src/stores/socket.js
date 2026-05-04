import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'

export const useSocketStore = defineStore('socket', () => {
  // ========== State ==========
  const socket = ref(null)
  const agents = ref([])
  const systemStats = ref({
    totalAgents: 0,
    onlineAgents: 0,
    uptime: 0
  })
  const connected = ref(false)
  const latency = ref(0)
  const connectionError = ref(null)
  const claudeTasks = ref({})

  // Agent terminal sessions: agentId -> { taskId, status, startedAt }
  const agentSessions = ref({})

  // Claude output callbacks (component-level, not reactive)
  let _claudeOutputCallbacks = []
  let _claudeCompleteCallbacks = []

  // ========== Getters ==========
  const onlineAgents = computed(() => agents.value.filter(a =>
    a.status === 'online' || a.status === 'idle' || a.status === 'busy'
  ))

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
    })

    // Agent updated
    socket.value.on('agent:update', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = { ...agents.value[idx], ...data }
      }
      updateStats()
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

    // System stats
    socket.value.on('system:stats', (data) => {
      systemStats.value = { ...systemStats.value, ...data }
    })

    // Agent status update
    socket.value.on('agent:status-update', (data) => {
      const idx = agents.value.findIndex(a => a.id === data.agentId)
      if (idx >= 0) {
        agents.value[idx] = {
          ...agents.value[idx],
          status: data.status,
          lastSeen: data.timestamp || Date.now()
        }
        updateStats()
      }
    })

    // Heartbeat ack
    socket.value.on('heartbeat:ack', (data) => {
      if (data.clientTime) {
        latency.value = Date.now() - data.clientTime
      }
    })

    // Claude Code streaming output — route by agentId
    socket.value.on('claude:output', (data) => {
      if (data?.taskId) {
        if (!claudeTasks.value[data.taskId]) {
          claudeTasks.value[data.taskId] = {
            status: 'running',
            startedAt: Date.now(),
            agentId: data.agentId || null
          }
        }
        claudeTasks.value[data.taskId].lastChunkAt = Date.now()
      }

      // Track agent session
      if (data?.agentId) {
        if (!agentSessions.value[data.agentId]) {
          agentSessions.value[data.agentId] = { taskId: null, status: 'idle', startedAt: null }
        }
        agentSessions.value[data.agentId].status = 'running'
        agentSessions.value[data.agentId].taskId = data.taskId
      }

      _claudeOutputCallbacks.forEach(cb => {
        try { cb(data) } catch (e) {}
      })
    })

    socket.value.on('claude:complete', (data) => {
      if (data?.taskId && claudeTasks.value[data.taskId]) {
        claudeTasks.value[data.taskId].status = data.exitCode === 0 ? 'success' : 'error'
        claudeTasks.value[data.taskId].duration = data.duration
        claudeTasks.value[data.taskId].exitCode = data.exitCode
      }

      // Update agent session
      if (data?.agentId && agentSessions.value[data.agentId]) {
        agentSessions.value[data.agentId].status = 'idle'
        agentSessions.value[data.agentId].lastExitCode = data.exitCode
        agentSessions.value[data.agentId].lastDuration = data.duration
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
    agentSessions.value = {}
  }

  function joinDashboard() {
    if (!socket.value?.connected) return
    socket.value.emit('dashboard:join', { timestamp: Date.now() })
  }

  function cancelClaudeTask(taskId, agentId) {
    if (!socket.value?.connected) return false
    socket.value.emit('claude:cancel', { taskId, targetAgentId: agentId })
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

  return {
    // State
    socket,
    agents,
    systemStats,
    connected,
    latency,
    connectionError,
    claudeTasks,
    agentSessions,
    // Getters
    onlineAgents,
    // Actions
    connect,
    disconnect,
    joinDashboard,
    cancelClaudeTask,
    onClaudeOutput,
    onClaudeComplete
  }
})
