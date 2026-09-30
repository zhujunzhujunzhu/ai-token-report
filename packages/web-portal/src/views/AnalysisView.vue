<script setup lang="ts">
/**
 * 用量分析按既有维度切换，不复制服务端的聚合公式。
 *
 * ★ 指标与分层维度都读 store（总览页共用同一对开关）：切换指标**不重新取数**，
 *   三种值本来就在同一份 `series` 载荷里；切换分层才要重取（载荷里
 *   `stack` 的有无本身就是状态）。
 */
import {
  ElCard,
  ElRadioButton,
  ElRadioGroup,
  ElTabPane,
  ElTabs,
} from 'element-plus'
import { computed } from 'vue'
import { useDashboardStore, type TrendMetric, type TrendStack } from '../stores/dashboard.js'
import { BREAKDOWN_TABS } from '../types/portal.js'
import { formatBucket, formatCount } from '../utils/format.js'
import { COST_LABEL, costText, costTickFormatter } from '../utils/cost.js'
import TrendChart from '../components/TrendChart.vue'
import BreakdownTable from '../components/BreakdownTable.vue'
const dashboard = useDashboardStore()
/** 趋势点（同一份数组同时喂给标签与数值，保证两个序列**按下标对齐**）。 */
const seriesPoints = computed(() => dashboard.series?.points ?? [])
const chartLabels = computed(() =>
  seriesPoints.value.map((p) => formatBucket(p.bucket, dashboard.granularity)),
)
/**
 * 图上的数值。
 *
 * ⚠️ 三个指标的数值**全部来自服务端**：金额取 `costSeries.values` 的同一批
 *   展开成按用户 / 按模型时取分层载荷（`utils/trend.ts` 是唯一的取列实现）。
 *   整数微元（下标与 `seriesPoints` 一一对应），画图层不做任何口径换算。
 */
const chartValues = computed(() =>
  seriesPoints.value.map((p, index) => {
    if (dashboard.activeMetric === 'calls') return p.calls
    if (dashboard.activeMetric === 'cost')
      return dashboard.costSeries?.values[index] ?? 0
    return p.totalTokens
  }),
)
const chartTotal = computed(() => {
  if (!dashboard.overview) return '—'
  if (dashboard.activeMetric === 'calls') return formatCount(dashboard.overview.calls)
  // ⚠️ 金额合计用 `costText`（多币种 ` + ` 拼接），**不是**千分位：合计的币种
  //   可能与当前曲线的币种不同（曲线只画一个币种），而合计要如实反映全部。
  if (dashboard.activeMetric === 'cost')
    return costText(dashboard.overview.cost) ?? '未计价'
  return formatCount(dashboard.overview.totalTokens)
})
const chartMetricLabel = computed(() =>
  dashboard.activeMetric === 'calls'
    ? '调用次数'
    : dashboard.activeMetric === 'cost'
      ? COST_LABEL
      : '计费总量',
/**
 * 图表标题行兼无障碍名，把「前 N 名 + 其余合并」说清楚。
 *
 * ★ 少了这句，使用者会把图上那几层当成全部 —— 而堆叠柱的总高其实仍等于总量，
 *   两者对不上时他只会去查一个并不存在的 bug。
 */
)
const chartHint = computed(() => {
  const grain = dashboard.granularity === 'hour' ? '按小时统计' : '按天统计'
  if (dashboard.stackBy === 'none') {
    return dashboard.activeMetric === 'cost'
      ? `${grain} · 按每笔事件发生时刻的单价估算 · 币种 ${dashboard.costSeries?.currency ?? 'CNY'}`
      : grain
  }
  const who = dashboard.stackBy === 'user' ? '按用户展开' : '按模型展开'
  return `${grain} · ${who}${
    dashboard.stackMergedCount > 0 ? '（按用量取前 8 名，其余合并）' : ''
  }`
})
/** 金额曲线的刻度与悬浮值都显示成货币；其它指标用缺省的「万 / 亿」与千分位。 */
const chartFormatter = computed(() =>
  dashboard.activeMetric === 'cost'
    ? costTickFormatter(dashboard.costSeries?.currency ?? 'CNY')
    : undefined,
/**
 * 金额指标**现在能不能点**。
 *
 * ★ 多币种 / 一条价都没配时按钮在、但禁用并给出原因：把跨币种求和画出来
 *   看起来像「花得很少」，那是把一个口径错误伪装成结论。
 */
const costDisabledReason = computed(() => dashboard.costSeries?.disabledReason ?? null)
const onMetric = (value: string | number | boolean | undefined): void =>
  dashboard.setTrendMetric(value as TrendMetric)
const onStack = (value: string | number | boolean | undefined): void =>
  void dashboard.setStack(value as TrendStack)
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
        <div class="trend-controls">
          <el-radio-group
            :model-value="dashboard.trendMetric"
            size="small"
            @update:model-value="onMetric"
            ><el-radio-button value="totalTokens">Token 用量</el-radio-button
            ><el-radio-button value="calls">调用次数</el-radio-button>
            <!--
              ★ 金额这个选项**只在服务端给了 `cost` 字段时**才出现（没有 `cost:read`
                时连按钮都不该有）；多币种 / 一条价都没配时按钮在、但**禁用并给出原因**。
            -->
            <el-radio-button
              v-if="dashboard.costSeries"
              value="cost"
              :disabled="!!costDisabledReason"
              :title="costDisabledReason ?? '按每笔事件发生时刻的单价估算'"
              >{{ COST_LABEL }}</el-radio-button
            ></el-radio-group
          >
          <!--
            ★ 分层维度与指标是两个**独立**的开关：折线图不堆叠（堆叠折线只有
              最上面那条的高度可读），但鼠标落在任意横坐标上会把这一槽的
              每一层一起列出来。
          -->
          <el-radio-group
            :model-value="dashboard.stackBy"
            size="small"
            @update:model-value="onStack"
            ><el-radio-button value="none">合计</el-radio-button
            ><el-radio-button value="user">按用户</el-radio-button
            ><el-radio-button value="model">按模型</el-radio-button></el-radio-group
          >
        </div></div></template
      >
    <p v-if="costDisabledReason" class="cost-trend-note muted">
      {{ costDisabledReason }}
    </p>
    <!--
      ★ 服务端没给 `stack` 字段时（旧版接口）必须说出来：静默画一条合计线会让人
        以为自己看到的就是「按用户展开」。
    -->
    <p v-if="dashboard.stackUnavailable" class="cost-trend-note muted">
      服务端这次没有返回分层数据（接口版本较旧），当前显示的是合计。
    </p>
    <TrendChart
      :labels="chartLabels"
      :series="dashboard.trendSeries"
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

