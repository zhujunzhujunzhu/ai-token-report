<script setup lang="ts">
/**
 * 图表卡片：标题行（指标名 + 合计值 + 口径提示）+ 内嵌图表。
 */
import MetricChartCard from '@/components/usage/MetricChartCard.vue'
import { CHART_HINTS } from '@/composables/usage-view-model'
import type { ChartCard } from '@/types/usage'

defineProps<{
  card: ChartCard
}>()
</script>

<template>
  <section class="chart-card">
    <header class="chart-card__head">
      <h3 class="chart-card__title">
        {{ card.title }}
        <span class="chart-card__total tabular">{{ card.total }}</span>
      </h3>
      <span v-if="CHART_HINTS[card.key]" class="chart-card__hint">
        {{ CHART_HINTS[card.key] }}
      </span>
    </header>

    <MetricChartCard :series="card.chart" :ticks="card.ticks" />
  </section>
</template>

<style scoped>
.chart-card {
  padding: 16px 18px 12px;
  background-color: var(--c-chart-card-bg);
  border-radius: var(--radius-lg);
}

.chart-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.chart-card__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--c-text-primary);
}

.chart-card__total {
  font-size: 13px;
  font-weight: 400;
  color: var(--c-text-secondary);
}

.chart-card__hint {
  font-size: 12px;
  color: var(--c-text-tertiary);
}
</style>