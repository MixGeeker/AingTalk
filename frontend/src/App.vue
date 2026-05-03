<template>
  <div class="app h-screen w-screen overflow-hidden bg-slate-900 text-white">
    <Dashboard />
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import Dashboard from '@/views/Dashboard.vue'

const store = useSocketStore()

onMounted(() => {
  // Auto-connect to server on mount
  if (!store.connected && !store.socket) {
    store.connect()
  }
})
</script>

<style>
/* Global styles scoped to App */
.app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>
