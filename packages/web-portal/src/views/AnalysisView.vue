<script setup lang="ts">
/** 用量分析按既有维度切换，不复制服务端的聚合公式。 */
import {
  ElCard,
  ElRadioButton,
  ElRadioGroup,
  ElTabPane,
  ElTabs,
} from 'element-plus'
import { ref } from 'vue'
import { useDashboardStore } from '../stores/dashboard.js'
import { BREAKDOWN_TABS } from '../types/portal.js'
import { formatBucket, formatCount } from '../utils/format.js'
import TrendChart from '../components/TrendChart.vue'
import BreakdownTable from '../components/BreakdownTable.vue'
const dashboard = useDashboardStore()
const metric = ref('totalTokens')
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
          ></el-radio-group
        >
      </div></template
    >
    <TrendChart
      :key="metric"
      :labels="
        (dashboard.series?.points ?? []).map((p) =>
          formatBucket(p.bucket, dashboard.granularity),
        )
      "
      :values="
        (dashboard.series?.points ?? []).map((p) =>
          metric === 'calls' ? p.calls : p.totalTokens,
        )
      "
      :total="
        dashboard.overview
          ? formatCount(
              metric === 'calls'
                ? dashboard.overview.calls
                : dashboard.overview.totalTokens,
            )
          : '—'
      "
      :metric-label="metric === 'calls' ? '调用次数' : '计费总量'"
      :hint="dashboard.granularity === 'hour' ? '按小时统计' : '按天统计'"
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
