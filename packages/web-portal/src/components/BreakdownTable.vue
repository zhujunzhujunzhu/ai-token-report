<script setup lang="ts">
/**
 * 模型与项目分布复用同一表格，数值均为服务端聚合结果。
 *
 * ★ 第一列显示什么由 `labelOf` 决定：`by=group` 的行里 `key` 是稳定 `group_id`，
 *   要经分组候选目录翻成名字才看得懂。默认直接显示 `key`（provider / model /
 *   project 维度的 `key` 本来就是可读的）。
 * ★ 人员维度的行带 `group_names`（多对多），原样渲染成标签 —— 页面不重算归属。
 * ★ 费用列同样**按「服务端有没有下发 `cost`」决定出不出现**（理由见
 *   `RankingTable.vue`）：字段缺席 = 没权限，`costs` 为空 = 没配价，两者措辞不同。
 */
import { ElTable, ElTableColumn, ElTag } from 'element-plus'
import { computed } from 'vue'
import type { BreakdownRow } from '@ai-token-report/shared'
import { formatCount, formatPercent } from '../utils/format.js'
import { UNPRICED_TEXT, costText, unpricedText } from '../utils/cost.js'
const props = defineProps<{
  rows: BreakdownRow[]
  /** 行显示名；缺省显示 `row.key`。 */
  labelOf?: (row: BreakdownRow) => string
  /**
   * 第一列标题，缺省「维度」。
   *
   * ⚠️ 默认值刻意不是「分组」：本表同时服务 provider / model / project 这些
   *   **等值维度**与 `by=group`（分组实体）两种用途，用实体名当通用列头
   *   会让人把这个表和分组维度混为一谈。分组排行那边显式传「分组」。
   */
  dimensionLabel?: string
}>()
const showCost = computed(() => props.rows.some((row) => row.cost))
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本组件的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `/api/v1/stats/breakdown` 决定。
 */
const rowBreakdown = (row: unknown): BreakdownRow => row as BreakdownRow
</script>
<template>
  <el-table :data="rows" row-key="key" empty-text="这段时间没有分布数据">
    <el-table-column :label="dimensionLabel ?? '维度'" min-width="220" show-overflow-tooltip>
      <template #default="{ row }">
        <span>{{ labelOf ? labelOf(rowBreakdown(row)) : row.key }}</span>
        <el-tag
          v-for="name in row.group_names ?? []"
          :key="name"
          size="small"
          type="info"
          effect="plain"
          class="row-group-tag"
          >{{ name }}</el-tag
        >
      </template>
    </el-table-column>
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
    <el-table-column
      v-if="showCost"
      label="费用（估算）"
      min-width="150"
      align="right"
    >
      <template #default="{ row }">
        <span class="tabular">{{ costText(row.cost) ?? UNPRICED_TEXT }}</span>
        <div v-if="unpricedText(row.cost)" class="muted cost-unpriced">
          {{ unpricedText(row.cost) }}
        </div>
      </template>
    </el-table-column>
    <el-table-column label="缓存命中率" min-width="110" align="right"
      ><template #default="{ row }">{{
        formatPercent(row.cacheHitRate)
      }}</template></el-table-column
    >
  </el-table>
</template>
