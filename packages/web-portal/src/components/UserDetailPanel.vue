<script setup lang="ts">
/** 人员详情抽屉使用独立请求序号，关窗或切换成员后不接受旧响应。 */
import { ElAlert, ElDrawer, ElSkeleton } from 'element-plus'
import { computed } from 'vue'
import { useDashboardStore } from '../stores/dashboard.js'
import { userLabel } from '../types/portal.js'
import { formatBucket, formatCount } from '../utils/format.js'
import MetricCardGrid from './MetricCardGrid.vue'
import TrendChart from './TrendChart.vue'
import BreakdownTable from './BreakdownTable.vue'
const dashboard = useDashboardStore()
const detail = computed(() => dashboard.detail)
</script>
<template>
  <el-drawer
    :model-value="!!detail"
    :title="detail ? userLabel(detail.userId) + ' · 用量详情' : '用量详情'"
    size="min(920px, 100vw)"
    destroy-on-close
    @close="dashboard.closeUser()"
  >
    <div v-if="detail" class="page-stack">
      <el-skeleton v-if="dashboard.detailLoading" :rows="8" animated />
      <el-alert
        v-else-if="dashboard.detailError"
        :title="dashboard.detailError"
        type="error"
        :closable="false"
        show-icon
      />
      <template v-else>
        <p class="muted">
          {{ detail.overview?.range.label }} · 继承当前时间、厂商与模型筛选
        </p>
        <MetricCardGrid :overview="detail.overview" />
        <TrendChart
          :labels="
            (detail.series?.points ?? []).map((p) =>
              formatBucket(p.bucket, detail.series!.bucket),
            )
          "
          :values="(detail.series?.points ?? []).map((p) => p.totalTokens)"
          :total="
            detail.overview ? formatCount(detail.overview.totalTokens) : '—'
          "
          hint="计费总量趋势"
          metric-label="计费总量"
        />
        <h2>厂商 / 模型分布</h2>
        <BreakdownTable :rows="detail.models" />
      </template>
    </div>
  </el-drawer>
</template>
