<script setup lang="ts">
/** 模型与项目分布复用同一表格，数值均为服务端聚合结果。 */
import { ElTable, ElTableColumn } from 'element-plus'
import type { BreakdownRow } from '@ai-token-report/shared'
import { formatCount, formatPercent } from '../utils/format.js'
defineProps<{ rows: BreakdownRow[] }>()
</script>
<template>
  <el-table :data="rows" row-key="key" empty-text="这段时间没有分布数据">
    <el-table-column
      prop="key"
      label="分组"
      min-width="220"
      show-overflow-tooltip
    />
    <el-table-column label="计费总量" min-width="140" align="right"
      ><template #default="{ row }"
        ><strong>{{ formatCount(row.totalTokens) }}</strong></template
      ></el-table-column
    >
    <el-table-column label="未缓存输入" min-width="130" align="right"
      ><template #default="{ row }">{{
        formatCount(row.inputTokens)
      }}</template></el-table-column
    >
    <el-table-column label="输出" min-width="110" align="right"
      ><template #default="{ row }">{{
        formatCount(row.outputTokens)
      }}</template></el-table-column
    >
    <el-table-column label="缓存读" min-width="130" align="right"
      ><template #default="{ row }">{{
        formatCount(row.cacheReadTokens)
      }}</template></el-table-column
    >
    <el-table-column label="缓存写入" min-width="130" align="right"
      ><template #default="{ row }">{{
        formatCount(row.cacheWriteTokens)
      }}</template></el-table-column
    >
    <el-table-column label="调用次数" min-width="100" align="right"
      ><template #default="{ row }">{{
        formatCount(row.calls)
      }}</template></el-table-column
    >
    <el-table-column label="缓存命中率" min-width="110" align="right"
      ><template #default="{ row }">{{
        formatPercent(row.cacheHitRate)
      }}</template></el-table-column
    >
  </el-table>
</template>
