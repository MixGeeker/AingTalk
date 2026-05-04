<template>
  <div class="terminal-grid flex-1 min-h-0 flex flex-col">
    <!-- Empty state -->
    <div v-if="onlineAgents.length === 0" class="flex-1 flex items-center justify-center text-slate-600 text-sm">
      <div class="text-center">
        <div class="text-2xl mb-2">⎕</div>
        <div>没有在线的 Agent</div>
      </div>
    </div>

    <!-- Terminal grid -->
    <div
      v-else
      class="grid gap-px bg-slate-800/50 flex-1 min-h-0"
      :style="gridStyle"
    >
      <div
        v-for="agent in onlineAgents"
        :key="agent.id"
        class="flex flex-col min-h-0 bg-slate-900"
      >
        <ClaudeTerminal :agent-id="agent.id" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useSocketStore } from '@/stores/socket.js'
import ClaudeTerminal from './ClaudeTerminal.vue'

const store = useSocketStore()

const onlineAgents = computed(() => store.onlineAgents)

const gridStyle = computed(() => {
  const count = onlineAgents.value.length
  if (count <= 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
  if (count === 2) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' }
  if (count <= 4) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' }
  return { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: 'repeat(auto-fill, minmax(200px, 1fr))' }
})
</script>
