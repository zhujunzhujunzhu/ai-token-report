<script setup lang="ts">
/** 用量分析按既有维度切换，不复制服务端的聚合公式。 */
import {
  ElCard,
  ElRadioButton,
  ElRadioGroup,
  ElTabPane,
  ElTabs,
} from 'element-plus'
import { ref, computed } from 'vue'
import { useDashboardStore } from '../stores/dashboard.js'
import { BREAKDOWN_TABS } from '../types/portal.js'
import { formatBucket, formatCount } from '../utils/format.js'
import {
  COST_LABEL,
  costSeriesOf,
  costText,
  costTickFormatter,
} from '../utils/cost.js'
import TrendChart from '../components/TrendChart.vue'
import BreakdownTable from '../components/BreakdownTable.vue'
const dashboard = useDashboardStore()
const metric = ref('totalTokens')
/**
 * ★ 金额指标**只在服务端下发了 `cost` 时才存在**（判字段，不判数值）。
 *   多币种 / 一条价都没配时它是「存在但不可用」，并给出原因 ——
 *   硬画一条线会造出「两种货币相加」或以 0 冒充「没花钱」。
 */
const costSeries = computed(() =>
  costSeriesOf(dashboard.series?.points ?? []),
)
/** 金额指标不可用时不允许停留在它上面（数据刷新成多币种时会走到这里）。 */
const activeMetric = computed(() =>
  metric.value === 'cost' && costSeries.value?.disabledReason
    ? 'totalTokens'
    : metric.value,
)
const costCurrency = computed(() => costSeries.value?.currency ?? 'CNY')
/** 趋势点（同一份数组同时喂给标签与数值，保证两个序列**按下标对齐**）。 */
const seriesPoints = computed(() => dashboard.series?.points ?? [])
const chartLabels = computed(() =>
  seriesPoints.value.map((p) => formatBucket(p.bucket, dashboard.granularity)),
)
/**
 * 图上的数值。
 *
 * ⚠️ 三个指标的数值**全部来自服务端**：金额取 `costSeries.values` 的同一批
 *   整数微元（下标与 `seriesPoints` 一一对应），画图层不做任何口径换算。
 */
const chartValues = computed(() =>
  seriesPoints.value.map((p, index) => {
    if (activeMetric.value === 'calls') return p.calls
    if (activeMetric.value === 'cost') return costSeries.value?.values[index] ?? 0
    return p.totalTokens
  }),
)
const chartTotal = computed(() => {
  if (!dashboard.overview) return '—'
  if (activeMetric.value === 'calls') return formatCount(dashboard.overview.calls)
  // ⚠️ 金额合计用 `costText`（多币种 ` + ` 拼接），**不是**千分位：合计的币种
  //   可能与当前曲线的币种不同（曲线只画一个币种），而合计要如实反映全部。
  if (activeMetric.value === 'cost') return costText(dashboard.overview.cost) ?? '未计价'
  return formatCount(dashboard.overview.totalTokens)
})
const chartMetricLabel = computed(() =>
  activeMetric.value === 'calls'
    ? '调用次数'
    : activeMetric.value === 'cost'
      ? COST_LABEL
      : '计费总量',
)
const chartHint = computed(() => {
  if (activeMetric.value === 'cost') {
    return `按每笔事件发生时刻的单价估算 · 币种 ${costCurrency.value}`
  }
  return dashboard.granularity === 'hour' ? '按小时统计' : '按天统计'
})
/** 金额曲线的刻度与悬浮值都显示成货币；其它指标用缺省的「万 / 亿」与千分位。 */
const chartFormatter = computed(() =>
  activeMetric.value === 'cost'
    ? costTickFormatter(costCurrency.value)
    : undefined,
)
</script>
<template>
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>趋势分析</h2>
          <p>查看计费总量与调用频率的变化</p>
        </div>
        <el-radio-group v-model="metric" size="small"
          ><el-radio-button value="totalTokens">Token 用量</el-radio-button
          ><el-radio-button value="calls"
            >调用次数</el-radio-button
          >
          <!--
            ★ 金额这个选项**只在服务端给了 `cost` 字段时**才出现（没有 `cost:read`
              时连按钮都不该有）；多币种 / 一条价都没配时按钮在、但**禁用并给出原因**。
          -->
          <el-radio-button
            v-if="costSeries"
            value="cost"
            :disabled="!!costSeries.disabledReason"
            :title="costSeries.disabledReason ?? '按每笔事件发生时刻的单价估算'"
            >{{ COST_LABEL }}</el-radio-button
          ></el-radio-group
        >
      </div></template
    >
    <p v-if="costSeries?.disabledReason" class="cost-trend-note muted">
      {{ costSeries.disabledReason }}
    </p>
    <TrendChart
      :key="activeMetric"
      :labels="chartLabels"
      :values="chartValues"
      :total="chartTotal"
      :metric-label="chartMetricLabel"
      :hint="chartHint"
      :value-formatter="chartFormatter"
      :tick-formatter="chartFormatter"
      kind="area"
    />
  </el-card>
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>用量分布</h2>
          <p>从不同维度了解团队的使用情况</p>
        </div>
      </div></template
    >
    <el-tabs
      :model-value="dashboard.breakdownBy"
      @update:model-value="
        (value) => dashboard.setBreakdown(value as typeof dashboard.breakdownBy)
      "
      ><el-tab-pane
        v-for="tab in BREAKDOWN_TABS"
        :key="tab.value"
        :name="tab.value"
        :label="tab.label"
    /></el-tabs>
    <BreakdownTable :rows="dashboard.breakdown?.rows ?? []" />
  </el-card>
</template>
