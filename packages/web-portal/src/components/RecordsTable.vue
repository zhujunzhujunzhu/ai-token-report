<script setup lang="ts">
/** 调用明细使用服务端分页，不在客户端截断或聚合事件。 */
import {
  ElDescriptions,
  ElDescriptionsItem,
  ElPagination,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import type { RecordRow, StatsGroupOption } from '@ai-token-report/shared'
import { formatCount, formatDateTime } from '../utils/format.js'
import { recordGroupNames, userLabel } from '../types/portal.js'
defineProps<{
  rows: RecordRow[]
  total: number
  page: number
  pageSize: number
  loading?: boolean
  /** 分组候选目录（看板接口给的），把 `group_ids` 翻成名字供人读。 */
  groups: StatsGroupOption[]
}>()
defineEmits<{ page: [value: number] }>()
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本页的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `/api/v1/stats/records` 决定。
 */
const rowRecord = (row: unknown): RecordRow => row as RecordRow
</script>
<template>
  <el-table
    :data="rows"
    row-key="eventId"
    empty-text="这段时间没有明细记录"
    stripe
  >
    <el-table-column type="expand"
      ><template #default="{ row }"
        ><el-descriptions :column="1" border class="record-details"
          ><el-descriptions-item label="事件 ID">{{
            row.eventId
          }}</el-descriptions-item
          ><el-descriptions-item label="会话 ID">{{
            row.sessionId
          }}</el-descriptions-item
          ><el-descriptions-item label="项目目录">{{
            row.cwd || '未提供'
          }}</el-descriptions-item
          ><el-descriptions-item label="人员 ID">{{
            row.member_id || '待确认历史或未归属'
          }}</el-descriptions-item
          ><el-descriptions-item label="上报时部门">{{
            row.dept_snapshot || '未提供'
          }}</el-descriptions-item
          ><el-descriptions-item label="缓存写入">{{
            formatCount(row.cacheWriteTokens)
          }}</el-descriptions-item></el-descriptions
        ></template
      ></el-table-column
    >
    <el-table-column label="时间" width="135"
      ><template #default="{ row }">{{
        formatDateTime(row.ts)
      }}</template></el-table-column
    >
    <el-table-column label="署名" min-width="105"
      ><template #default="{ row }">{{
        row.user_name_snapshot ?? userLabel(row.userId)
      }}</template></el-table-column
    >
    <!--
      当前分组与「上报时分组」（展开区）**不是一回事**：
      这一列由 `group_ids`（关联表）经分组候选目录翻名，是**此刻**的归属；
      展开区的 `group_name_snapshot` 只是上报当时客户端自己填的文本快照。
      多对多下这里可能列出多个分组；没有归属时显式写「未分组」。
    -->
    <el-table-column label="当前分组" min-width="140"
      ><template #default="{ row }">{{
        recordGroupNames(rowRecord(row), groups)
      }}</template></el-table-column
    >
    <el-table-column
      prop="provider"
      label="厂商"
      min-width="115"
      show-overflow-tooltip
    />
    <el-table-column
      prop="model"
      label="模型"
      min-width="180"
      show-overflow-tooltip
    />
    <el-table-column label="未缓存输入" min-width="130" align="right"
      ><template #default="{ row }">{{
        formatCount(row.inputTokens)
      }}</template></el-table-column
    >
    <el-table-column label="输出" min-width="100" align="right"
      ><template #default="{ row }">{{
        formatCount(row.outputTokens)
      }}</template></el-table-column
    >
    <el-table-column label="缓存读" min-width="125" align="right"
      ><template #default="{ row }">{{
        formatCount(row.cacheReadTokens)
      }}</template></el-table-column
    >
    <el-table-column label="计费总量" min-width="135" align="right"
      ><template #default="{ row }"
        ><strong>{{ formatCount(row.totalTokens) }}</strong></template
      ></el-table-column
    >
  </el-table>
  <div class="table-footer">
    <span>共 {{ formatCount(total) }} 条调用记录</span
    ><el-pagination
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      :disabled="loading"
      background
      layout="prev, pager, next"
      @current-change="$emit('page', $event)"
    />
  </div>
</template>
