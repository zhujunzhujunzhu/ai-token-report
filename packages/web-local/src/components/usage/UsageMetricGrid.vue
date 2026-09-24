<script setup lang="ts">
/** 指标卡片横向排列，窄屏自动折行为单列。 */
import UsageMetricCard from '@/components/usage/UsageMetricCard.vue'
import { METRIC_HINTS } from '@/composables/usage-view-model'
import type { MetricCard } from '@/types/usage'

defineProps<{ metrics: MetricCard[]; loading?: boolean }>()
</script>

<template>
  <div class="metric-grid">
    <UsageMetricCard
      v-for="metric in metrics"
      :key="metric.key"
      :metric="metric"
      :hint="METRIC_HINTS[metric.key]"
      :loading="loading"
    />
  </div>
</template>

<style scoped>
.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 1100px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>