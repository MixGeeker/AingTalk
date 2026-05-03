import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

dayjs.locale('zh-cn')

/**
 * Format timestamp to readable time string
 */
export function formatTime(timestamp) {
  if (!timestamp) return '--'
  return dayjs(timestamp).format('HH:mm:ss')
}

/**
 * Format timestamp to full datetime string
 */
export function formatDateTime(timestamp) {
  if (!timestamp) return '--'
  return dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')
}

/**
 * Format file size from bytes to human readable
 */
export function formatFileSize(bytes) {
  if (bytes === 0 || bytes == null) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * Format duration from milliseconds to human readable
 */
export function formatDuration(ms) {
  if (!ms || ms < 0) return '0秒'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}天${hours % 24}小时`
  if (hours > 0) return `${hours}小时${minutes % 60}分`
  if (minutes > 0) return `${minutes}分${seconds % 60}秒`
  return `${seconds}秒`
}

/**
 * Get platform icon (emoji or text representation)
 */
export function getPlatformIcon(platform) {
  const icons = {
    darwin: '🍎',
    win32: '🪟',
    linux: '🐧',
    unknown: '❓'
  }
  return icons[platform] || icons.unknown
}

/**
 * Get platform display name
 */
export function getPlatformName(platform) {
  const names = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux',
    unknown: 'Unknown'
  }
  return names[platform] || names.unknown
}

/**
 * Get status color class for Tailwind
 */
export function getStatusColor(status) {
  const colors = {
    online: 'text-green-400',
    idle: 'text-green-400',
    busy: 'text-yellow-400',
    error: 'text-red-400',
    offline: 'text-gray-500',
    disconnected: 'text-gray-500'
  }
  return colors[status] || colors.offline
}

export function getStatusDotClass(status) {
  const map = {
    online: 'bg-green-400',
    idle: 'bg-green-400',
    busy: 'bg-yellow-400',
    error: 'bg-red-400',
    offline: 'bg-gray-600',
    disconnected: 'bg-gray-600'
  }
  return map[status] || 'bg-gray-600'
}

/**
 * Get status label
 */
export function getStatusLabel(status) {
  const labels = {
    online: '在线',
    idle: '空闲',
    busy: '忙碌',
    error: '错误',
    offline: '离线',
    disconnected: '已断开'
  }
  return labels[status] || status
}

/**
 * Get message type label
 */
export function getMessageTypeLabel(type) {
  const labels = {
    text: '文本',
    'role-assign': '角色分配',
    'task-assign': '任务分配',
    'status-query': '状态查询',
    response: '回复',
    'file-notice': '文件',
    btw: 'BTW'
  }
  return labels[type] || type
}

/**
 * Get message type color
 */
export function getMessageTypeColor(type) {
  const colors = {
    text: 'border-slate-600',
    'role-assign': 'border-blue-500',
    'task-assign': 'border-orange-500',
    'status-query': 'border-purple-500',
    response: 'border-slate-500',
    'file-notice': 'border-green-500',
    btw: 'border-amber-500'
  }
  return colors[type] || colors.text
}
