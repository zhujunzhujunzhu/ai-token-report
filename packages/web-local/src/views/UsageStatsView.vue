<script setup lang="ts">
/**
 * 用量统计页。
 *
 * 数据全部来自本地服务的 `/api/local/*`（本地 SQLite 增量库）。
 * **不展示金额** —— 无单价来源，只展示 token 数。
 */
import MetricGroupSection from '@/components/usage/MetricGroupSection.vue'
import UsageDetailTable from '@/components/usage/UsageDetailTable.vue'
import UsageFilterBar from '@/components/usage/UsageFilterBar.vue'
import UsageMetricGrid from '@/components/usage/UsageMetricGrid.vue'
import { useUsageStats } from '@/composables/useUsageStats'

const {
  loading,
  error,
  summary,
  rows,
  timeRange,
  groupBy,
  groupTabs,
  timeRanges,
  dirty,
  hardRefresh,
  clearFilters,
  exportCsv,
} = useUsageStats()

/** 明细表标题用的合计值：当前分组下所有行相加。 */
function totalOfRows(): number {
  return rows.value.reduce((sum, row) => sum + row.totalTokens, 0)
}
</script>

<template>
  <div class="usage-page">
    <header class="usage-page__header">
      <h1>我的用量</h1>
      <p>
        直接读取本机会话日志，展示计费总量、缓存命中率与调用次数明细。
        不经过任何服务端，也不采集对话内容。
      </p>
      <p class="usage-page__freshness">
        数据 {{ summary.freshness }}
      </p>
    </header>

    <UsageFilterBar
      v-model:time-range="timeRange"
      :time-ranges="timeRanges"
      :dirty="dirty"
      :loading="loading"
      @clear="clearFilters"
      @export="exportCsv"
      @refresh="hardRefresh"
    />

    <p v-if="error" class="usage-page__error" role="alert">
      {{ error }}
    </p>

    <UsageMetricGrid :metrics="summary.metrics" :loading="loading" />

    <MetricGroupSection
      v-for="(group, index) in summary.metricGroups"
      :key="group.name || `group-${index}`"
      :group="group"
    />

    <div class="usage-page__tabs" role="tablist">
      <button
        v-for="tab in groupTabs"
        :key="tab.value"
        type="button"
        role="tab"
        class="usage-page__tab"
        :class="{ 'is-active': tab.value === groupBy }"
        :aria-selected="tab.value === groupBy"
        @click="groupBy = tab.value as typeof groupBy"
      >
        {{ tab.label }}
      </button>
    </div>

    <UsageDetailTable
      :rows="rows"
      :group-by="groupBy"
      :total-tokens="totalOfRows()"
      :loading="loading"
    />
  </div>
</template>

<style scoped>
.usage-page {
  max-width: var(--page-max-width);
  margin: 0 auto;
  padding: 32px 24px 64px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.usage-page__header h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.usage-page__header p {
  margin: 0;
  font-size: 13px;
  color: var(--c-text-tertiary);
}

.usage-page__freshness {
  margin-top: 6px !important;
  font-size: 12px !important;
}

.usage-page__error {
  margin: 0;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: #b42318;
  background-color: #fef3f2;
  border-radius: var(--radius-md);
}

.usage-page__tabs {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 2px;
  background-color: var(--c-bg-hover);
  border-radius: var(--radius-pill);
}

.usage-page__tab {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--c-text-secondary);
  background: none;
  border: none;
  border-radius: var(--radius-pill);
  transition: background-color 0.15s var(--ease), color 0.15s var(--ease);
}

.usage-page__tab.is-active {
  color: var(--c-text-primary);
  background-color: #fff;
  box-shadow: var(--shadow-sm);
}
</style>