<script setup lang="ts">
/** 总览只组织关键指标、趋势和人员排行，其余业务有独立路由。 */
import { ElCard, ElTag } from 'element-plus'
import { useDashboardStore } from '../stores/dashboard.js'
import MetricCardGrid from '../components/MetricCardGrid.vue'
import RankingTable from '../components/RankingTable.vue'
import TrendChart from '../components/TrendChart.vue'
import { formatBucket, formatCount } from '../utils/format.js'
const dashboard = useDashboardStore()
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
        <router-link to="/analysis" class="text-link">查看分析 →</router-link>
      </div></template
    >
    <TrendChart
      :labels="
        (dashboard.series?.points ?? []).map((p) =>
          formatBucket(p.bucket, dashboard.granularity),
        )
      "
      :values="(dashboard.series?.points ?? []).map((p) => p.totalTokens)"
      :total="
        dashboard.overview ? formatCount(dashboard.overview.totalTokens) : '—'
      "
      :hint="dashboard.granularity === 'hour' ? '按小时统计' : '按天统计'"
      metric-label="计费总量"
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
</template>
