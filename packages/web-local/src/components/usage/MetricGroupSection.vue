<script setup lang="ts">
/**
 * 指标分组：可选的组标题 + 其下的图表卡片。
 *
 * 未来的分组标题用于区分「数字集团」等口径边界，目前服务端不产出分组，恒为空。
 */
import MetricChartPanel from '@/components/usage/MetricChartPanel.vue'
import type { MetricGroup } from '@/types/usage'

defineProps<{
  group: MetricGroup
}>()
</script>

<template>
  <section class="metric-group">
    <h2 v-if="group.name" class="metric-group__title">{{ group.name }}</h2>

    <div class="metric-group__cards" :class="{ 'is-split': group.cards.length > 1 }">
      <MetricChartPanel
        v-for="card in group.cards"
        :key="card.key"
        :card="card"
      />
    </div>
  </section>
</template>

<style scoped>
.metric-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.metric-group__title {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--c-text-primary);
}

.metric-group__cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}

.metric-group__cards.is-split {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 860px) {
  .metric-group__cards.is-split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>