<script setup lang="ts">
/**
 * 单个统计卡片：上方指标名 + 问号提示，下方大号数值 + 单位。
 */
import UiCard from '@/components/ui/UiCard.vue'
import UiHint from '@/components/ui/UiHint.vue'
import type { MetricCard } from '@/types/usage'

defineProps<{ metric: MetricCard; hint?: string; loading?: boolean }>()
</script>

<template>
  <UiCard class="metric-card">
    <div class="metric-card__head">
      <span class="metric-card__label">{{ metric.label }}</span>
      <UiHint v-if="hint" :text="hint" />
    </div>

    <div class="metric-card__body">
      <span v-if="loading" class="metric-card__skeleton" aria-label="加载中" />
      <template v-else>
        <span class="metric-card__value tabular">{{ metric.value }}</span>
        <span v-if="metric.unit" class="metric-card__unit">{{ metric.unit }}</span>
      </template>
    </div>
  </UiCard>
</template>

<style scoped>
.metric-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 104px;
}

.metric-card__head {
  display: flex;
  align-items: center;
  gap: 5px;
}

.metric-card__label {
  font-size: 13px;
  color: var(--c-text-secondary);
}

.metric-card__body {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 14px;
}

.metric-card__value {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--c-text-primary);
}

.metric-card__unit {
  font-size: 14px;
  font-weight: 500;
  color: var(--c-text-tertiary);
  letter-spacing: 0.02em;
}

.metric-card__skeleton {
  display: inline-block;
  width: 120px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, #ededed 25%, #f5f5f5 37%, #ededed 63%);
  background-size: 400% 100%;
  animation: shimmer 1.2s ease-in-out infinite;
}

@keyframes shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}
</style>