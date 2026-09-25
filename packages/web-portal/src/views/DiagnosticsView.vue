<script setup lang="ts">
/** 诊断页展示数据完整性信号，不推断尚未上报的人员数量。 */
import { useDashboardStore } from '../stores/dashboard.js'
import DiagnosticsPanel from '../components/DiagnosticsPanel.vue'
const dashboard = useDashboardStore()
</script>
<template>
  <DiagnosticsPanel
    :diagnostics="dashboard.diagnostics"
    :fetched-at="dashboard.fetchedAt"
  />
</template>
