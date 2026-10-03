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
import { describeSourcePaths, describeSources } from '@/composables/usage-view-model'
import UiButton from '@/components/ui/UiButton.vue'
import { computed } from 'vue'

defineEmits<{ (e: 'configure'): void }>()

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

// ★ 数据来源：多套 DSH 并存时页面上的数是**并集**，必须能自证「读了哪几处」。
//   文案在视图模型里生成，组件只负责排版（与「前端不重算口径」同一条约束）。
const sourceText = computed(() => describeSources(summary.value.sources))
const sourcePaths = computed(() => describeSourcePaths(summary.value.sources))
// 🚨 这里**刻意不渲染** `sources.missingRoots`（「以下会话日志根不存在，已跳过」那一行）。
//
//   原因：来源缺省是**全部已注册来源**（`resolveSourceRoots()`），于是「没装 Trae CN /
//   没装 Codex」这类**本来就没有**的根每次都会命中，页面只剩噪音 —— 而使用者对它们
//   什么也做不了（要关掉得改环境变量）。事实本身没丢：`/api/local/*` 照旧逐项下发
//   `missingRoots`，CLI 每次统计都会在 stderr 逐项打印，`--format json` / `--discover`
//   也带着它 —— 「配了但读不到」仍然查得出，只是不在**本地页**上喊。
//
//   ⚠️ 这条是**刻意的产品决策，不要当成漏渲染补回去**：把整页来源事实压成一行文本，
//   收益是「一眼看出读了哪几处」，代价就是上面那种每次必现的假警报。
/**
 * 费用口径那一行（未计价比例 + 单价来源 + 缺哪个价）。
 *
 * ★ 与「数据来源」同类：它回答的是「这个数是怎么来的」。
 *   本地页读的是数据目录下的 `pricing.json` 快照，看板读的是库里的单价表 ——
 *   两者会给出不同的金额，而都「看起来正常」，所以这一行必须与金额同时在场。
 */
const costNote = computed(() => summary.value.costNote)
</script>

<template>
  <div class="usage-page">
    <header class="usage-page__header">
      <h1>我的用量</h1>
      <UiButton @click="$emit('configure')">配置</UiButton>
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

    <p class="usage-page__sources" :title="sourcePaths">{{ sourceText }}</p>
    <!--
      费用口径：与「数据来源」同一类信息 —— 它回答「这个金额是按哪份价、有多少没算钱」。
      本地页读数据目录下的 pricing.json 快照，看板读库里的 model_price，
      两者会给不同的金额而都「看起来正常」，所以这一行必须与金额同时在场。
    -->
    <p v-if="costNote" class="usage-page__sources is-cost">{{ costNote }}</p>

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

.usage-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.usage-page__header h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
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

.usage-page__sources {
  margin: -8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--c-text-muted, #667085);
  word-break: break-all;
}

/*
  费用口径那一行的左边框是个提示：金额是**估算**，且这一行里可能写着
  「多少 Token 没算钱」。它不该像报错那样红，但也不该和「数据来源」完全一样。
*/
.usage-page__sources.is-cost {
  padding-left: 8px;
  border-left: 2px solid var(--c-divider, #e4e7ec);
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
