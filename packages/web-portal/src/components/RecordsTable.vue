<script setup lang="ts">
/** 调用明细使用服务端分页，不在客户端截断或聚合事件。 */
import {
  ElDescriptions,
  ElDescriptionsItem,
  ElPagination,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import type { RecordRow } from '@ai-token-report/shared'
import { formatCount, formatDateTime } from '../utils/format.js'
import { userLabel } from '../types/portal.js'
defineProps<{
  rows: RecordRow[]
  total: number
  page: number
  pageSize: number
  loading?: boolean
}>()
defineEmits<{ page: [value: number] }>()
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
        userLabel(row.userId)
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
