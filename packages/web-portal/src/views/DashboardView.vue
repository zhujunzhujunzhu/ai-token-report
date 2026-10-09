<script setup lang="ts">
/**
 * 总览只组织关键指标、趋势、人员排行与分组排行，其余业务有独立路由。
 *
 * ★ 趋势图的几个开关（指标 / 分层维度 / 保留层数 / 时间粒度）全部读 store：
 *   总览与分析是同一个问题的两种看法，在一边选了「按用户 + 全部 + 元」，
 *   跳到另一边不该被重置。页面只负责渲染，不做任何口径换算。
 */
import { ElCard, ElRadioButton, ElRadioGroup, ElTag } from 'element-plus'
import type { BreakdownRow } from '@ai-token-report/shared'
import { computed } from 'vue'
import { useDashboardStore, type TrendMetric, type TrendStack } from '../stores/dashboard.js'
import MetricCardGrid from '../components/MetricCardGrid.vue'
import RankingTable from '../components/RankingTable.vue'
import BreakdownTable from '../components/BreakdownTable.vue'
import TrendChart from '../components/TrendChart.vue'
import { formatBucket, formatCount } from '../utils/format.js'
import { COST_LABEL, costText, costTickFormatter } from '../utils/cost.js'
import { TREND_DEPTH_OPTIONS, type TrendDepth } from '../utils/trendDepth.js'
import { groupLabelOf } from '../types/portal.js'
const dashboard = useDashboardStore()
/**
 * 分组行的显示名。
 *
 * ★ `by=group` 的 `key` 是稳定 `group_id`，页面用**看板接口**给的分组候选
 *   把它翻成名字（`/api/v1/stats/groups`，`stats:read`），不去读管理接口。
 *   这里只做展示映射，不参与任何数值计算。
 */
const groupName = (row: BreakdownRow): string =>
  groupLabelOf(row, dashboard.groupOptions)
/** 趋势点（同一份数组同时喂给标签与数值，保证两个序列**按下标对齐**）。 */
const seriesPoints = computed(() => dashboard.series?.points ?? [])
const chartLabels = computed(() =>
  seriesPoints.value.map((p) => formatBucket(p.bucket, dashboard.granularity)),
)
/**
 * 图上「合计」那一列的数值。
 *
 * ⚠️ 三个指标的值**全部来自服务端**：金额取 `costSeries.values` 的同一批
 *   整数微元（下标与 `seriesPoints` 一一对应），画图层不做任何口径换算。
 *   展开成按用户 / 按模型时，这一列同时是提示框尾行的合计值。
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
  // ⚠️ 金额合计用 `costText`（多币种 ` + ` 拼接），**不是**千分位。
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
)
/**
 * 图表标题行兼无障碍名。
 *
 * ★ 展开时必须把「展开到第几名 + 其余合并」说清楚：少了这句，使用者会以为
 *   图上那几层就是全部，而堆叠柱的总高其实仍然等于总量。
 * ★ 这句话只在 store 里拼一次（`stackDepthNote`）：总览与分析是同一张图。
 */
const chartHint = computed(() => {
  const grain = dashboard.granularity === 'hour' ? '按小时统计' : '按天统计'
  if (dashboard.stackBy === 'none') {
    return dashboard.activeMetric === 'cost'
      ? `${grain} · 按每笔事件发生时刻的单价估算 · 币种 ${dashboard.costSeries?.currency ?? 'CNY'}`
      : grain
  }
  const who = dashboard.stackBy === 'user' ? '按用户展开' : '按模型展开'
  return `${grain} · ${who}${dashboard.stackDepthNote}`
})
/** 金额曲线的刻度与悬浮值都显示成货币；其它指标用缺省的「万 / 亿」与千分位。 */
const chartFormatter = computed(() =>
  dashboard.activeMetric === 'cost'
    ? costTickFormatter(dashboard.costSeries?.currency ?? 'CNY')
    : undefined,
)
const onMetric = (value: string | number | boolean | undefined): void =>
  dashboard.setTrendMetric(value as TrendMetric)
const onStack = (value: string | number | boolean | undefined): void =>
  void dashboard.setStack(value as TrendStack)
const onDepth = (value: string | number | boolean | undefined): void =>
  void dashboard.setTrendDepth(value as TrendDepth)
</script>
<template>
  <MetricCardGrid :overview="dashboard.overview" />
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>用量趋势</h2>
          <p>团队 Token 使用情况</p>
        </div>
        <div class="trend-controls">
          <el-radio-group
            :model-value="dashboard.trendMetric"
            size="small"
            @update:model-value="onMetric"
            ><el-radio-button value="totalTokens">Token 用量</el-radio-button>
            <!--
              ★ 金额这个选项**只在服务端给了 `cost` 字段时**才出现（没有 `cost:read`
                时连按钮都不该有）；多币种 / 一条价都没配时按钮在、但**禁用并给出原因**。
            -->
            <el-radio-button
              v-if="dashboard.costSeries"
              value="cost"
              :disabled="!!dashboard.costSeries.disabledReason"
              :title="
                dashboard.costSeries.disabledReason ??
                '按每笔事件发生时刻的单价估算'
              "
              >{{ COST_LABEL }}</el-radio-button
            ></el-radio-group
          >
          <!--
            ★ 分层维度与指标是两个**独立**的开关：柱状图堆叠、折线图多条，
              鼠标落在任意横坐标上都会把这一槽的每一层一起列出来。
          -->
          <el-radio-group
            :model-value="dashboard.stackBy"
            size="small"
            @update:model-value="onStack"
            ><el-radio-button value="none">合计</el-radio-button
            ><el-radio-button value="user">按用户</el-radio-button
            ><el-radio-button value="model">按模型</el-radio-button></el-radio-group
          >
          <!--
            ★ 展开后才有「保留多少层」这个问题：截断发生在**服务端**，
              前 8 名那趟响应里根本没有第 9 名以后的数据，页面上拆不开
              「其余 N 人」。所以这个开关切换的是**下一次请求**，选择记在本机。
            ⚠️ 只在展开时出现：合计模式下服务端连分层都不算。
          -->
          <el-radio-group
            v-if="dashboard.stackBy !== 'none'"
            :model-value="dashboard.trendDepth"
            size="small"
            @update:model-value="onDepth"
            ><el-radio-button
              v-for="option in TREND_DEPTH_OPTIONS"
              :key="option.value"
              :value="option.value"
              >{{ option.label }}</el-radio-button
            ></el-radio-group
          >
          <router-link to="/analysis" class="text-link">查看分析 →</router-link>
        </div></div></template
      >
    <p v-if="dashboard.costSeries?.disabledReason" class="cost-trend-note muted">
      {{ dashboard.costSeries.disabledReason }}
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
      :values="chartValues"
      :series="dashboard.trendSeries"
      :total="chartTotal"
      :metric-label="chartMetricLabel"
      :hint="chartHint"
      :value-formatter="chartFormatter"
      :tick-formatter="chartFormatter"
    />
  </el-card>
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>人员排行</h2>
          <p>点击成员，查看个人趋势与模型分布</p>
        </div>
        <el-tag type="info" effect="plain">按计费总量排序</el-tag>
      </div></template
    ><RankingTable :rows="dashboard.ranking" @select="dashboard.openUser"
  /></el-card>
  <el-card shadow="never"
    ><template #header
      ><div class="panel-heading">
        <div>
          <h2>分组排行</h2>
          <p>按成员所属分组展开统计，数值全部来自服务端</p>
        </div>
        <el-tag type="info" effect="plain">按计费总量排序</el-tag>
      </div></template
    ><BreakdownTable
      :rows="dashboard.groupRanking"
      :label-of="groupName"
      dimension-label="分组"
  />
    <!--
      ⚠️ 这段口径说明是**必需**的，不是装饰：多对多下一条用量会同时计入它的人员
      所属的每个分组，所以「各分组之和 > 总量」是定义而非重复计数的 bug，
      而未分组的人根本不进任何分组行 —— 差额就是他们。少了这句话，
      使用者看到求和不等就会去查一个并不存在的 bug。
    -->
    <p class="muted group-note">
      一名成员可属于多个分组，同一笔用量会同时计入其所属的每个分组，因此各分组之和可能大于总量；未分组的成员不计入任何分组行。
    </p>
  </el-card>
</template>
