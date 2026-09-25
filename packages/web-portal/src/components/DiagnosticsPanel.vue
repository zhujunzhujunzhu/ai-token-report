<script setup lang="ts">
/** 采集诊断展示已有记录的归属与时间边界，不把结构恒真值伪装成扫描检查。 */
import {
  ElAlert,
  ElCard,
  ElDescriptions,
  ElDescriptionsItem,
} from 'element-plus'
import type { DiagnosticsResponse } from '@ai-token-report/shared'
import {
  formatCount,
  formatFullDateTime,
  formatPercent,
} from '../utils/format.js'
defineProps<{
  diagnostics: DiagnosticsResponse | null
  fetchedAt: number | null
}>()
</script>
<template>
  <template v-if="diagnostics">
    <div class="diagnostic-cards">
      <el-card shadow="never"
        ><span>已署名人数</span
        ><strong
          >{{ formatCount(diagnostics.distinctUsers) }}<small>人</small></strong
        ></el-card
      >
      <el-card shadow="never"
        ><span>落库事件数</span
        ><strong
          >{{ formatCount(diagnostics.totalEvents) }}<small>条</small></strong
        ></el-card
      >
      <el-card shadow="never"
        ><span>未署名事件</span
        ><strong
          >{{ formatCount(diagnostics.unattributedEvents)
          }}<small>条</small></strong
        ></el-card
      >
      <el-card shadow="never"
        ><span>未署名占比</span
        ><strong>{{
          formatPercent(diagnostics.unattributedRate)
        }}</strong></el-card
      >
    </div>
    <el-alert
      :type="diagnostics.unattributedEvents ? 'warning' : 'info'"
      :title="
        diagnostics.unattributedEvents
          ? '存在未归属记录，建议核查历史上报来源'
          : '当前范围内未发现未归属记录'
      "
      description="未署名不采集也不上报。这里仅反映已经入库的记录，不能据此判断尚未上报的人员或设备。"
      :closable="false"
      show-icon
    />
    <el-card shadow="never"
      ><template #header
        ><div class="panel-heading">
          <h2>数据时间边界</h2>
          <span>用于判断上报数据的新鲜度</span>
        </div></template
      >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="最早事件">{{
          formatFullDateTime(diagnostics.earliestTs)
        }}</el-descriptions-item>
        <el-descriptions-item label="最新事件">{{
          formatFullDateTime(diagnostics.latestTs)
        }}</el-descriptions-item>
        <el-descriptions-item label="最近一次上报">{{
          formatFullDateTime(diagnostics.lastIngestAt)
        }}</el-descriptions-item>
        <el-descriptions-item label="本次取数时刻">{{
          formatFullDateTime(fetchedAt)
        }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
    <el-card shadow="never"
      ><h2>指标口径说明</h2>
      <p class="muted">
        计费总量包含未缓存输入、输出、缓存读与缓存写。推理 Token
        属于输出的子集，不重复计入。
      </p>
      <p class="muted">
        恒等式校验失败值为
        {{ diagnostics.identityViolations }}：上报库不存储独立 total
        列，总量由四项原始值派生，因此该值结构性恒为 0，并非一次扫描检查结果。
      </p></el-card
    >
  </template>
</template>
