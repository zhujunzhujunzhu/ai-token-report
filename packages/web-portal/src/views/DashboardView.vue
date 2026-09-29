<script setup lang="ts">
/** 总览只组织关键指标、趋势、人员排行与分组排行，其余业务有独立路由。 */
import { ElCard, ElTag } from 'element-plus'
import type { BreakdownRow } from '@ai-token-report/shared'
import { useDashboardStore } from '../stores/dashboard.js'
import MetricCardGrid from '../components/MetricCardGrid.vue'
import RankingTable from '../components/RankingTable.vue'
import BreakdownTable from '../components/BreakdownTable.vue'
import TrendChart from '../components/TrendChart.vue'
import { formatBucket, formatCount } from '../utils/format.js'
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