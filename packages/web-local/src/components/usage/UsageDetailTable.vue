<script setup lang="ts">
/**
 * 明细表格：按选中的维度分组，展示四项 token、命中率与**费用（估算）**。
 *
 * ★ 费用列**只在服务端下发了 `cost` 时才出现**（判字段不判数值）：
 *   一列恒为 `¥0.00` 会让「拿不到金额」看起来像「这段没花钱」。
 *   本地页的价来自数据目录下的 `pricing.json` 快照（没有就退回内置种子价），
 *   与部门看板读库里的 `model_price` 不是同一份价 —— 口径那一行在页面顶部。
 * ★ 四项 token 分列而不是只给一个「输入」，是因为 `cacheRead` 实测占
 *   总用量的 94.3%，把它并进 input 或干脆不显示，都会让这张表彻底失真。
 */
import { computed } from 'vue'

import {
  COST_COLUMN,
  DETAIL_COLUMNS,
  detailCell,
  showCostColumn,
} from '@/composables/usage-view-model'
import type { LocalBreakdownRow } from '@ai-token-report/shared'

const props = defineProps<{
  rows: LocalBreakdownRow[]
  groupBy: string
  /** 当前分组维度下合计的计费总量，供标题复用 */
  totalTokens: number
  loading?: boolean
}>()

/** 分组维度的中文名，用于标题行。 */
const DIM_LABELS: Record<string, string> = {
  provider: '厂商',
  model: '模型',
  'provider-model': '厂商 / 模型',
  project: '项目',
  session: '会话',
  day: '天',
  hour: '小时',
}

const dimLabel = computed(() => DIM_LABELS[props.groupBy] ?? props.groupBy)

/** 第一列标题随维度变化 */
const firstColumnTitle = computed(() => dimLabel.value)

/** 实际渲染的列：费用列按「服务端有没有下发 `cost`」加上去。 */
const columns = computed(() =>
  showCostColumn(props.rows) ? [...DETAIL_COLUMNS, COST_COLUMN] : DETAIL_COLUMNS,
)
</script>

<template>
  <div class="usage-table">
    <header class="usage-table__head">
      <h2 class="usage-table__title">
        按{{ dimLabel }}分组
        <span class="usage-table__amount tabular">
          合计 {{ totalTokens.toLocaleString('en-US') }} tokens
        </span>
      </h2>
    </header>

    <div class="usage-table__scroll">
      <table>
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :class="{ 'is-text': !col.numeric }"
            >
              {{ col.key === 'key' ? firstColumnTitle : col.title }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td class="usage-table__empty" :colspan="columns.length">
              正在扫描本机日志…
            </td>
          </tr>
          <tr v-else-if="rows.length === 0">
            <td class="usage-table__empty" :colspan="columns.length">
              当前筛选条件下暂无用量数据
            </td>
          </tr>
          <tr v-for="row in rows" v-else :key="row.key">
            <td
              v-for="col in columns"
              :key="col.key"
              :class="{ 'is-text': !col.numeric, tabular: col.numeric }"
            >
              {{ detailCell(row, col.key) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.usage-table {
  padding: 18px 20px 4px;
  background-color: var(--c-bg-subtle);
  border-radius: var(--radius-lg);
}

.usage-table__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--c-divider);
}

.usage-table__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--c-text-primary);
}

.usage-table__amount {
  font-size: 14px;
  color: var(--c-text-secondary);
}

.usage-table__scroll {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  padding: 14px 12px;
  text-align: right;
  white-space: nowrap;
}

th.is-text,
td.is-text {
  text-align: left;
}

th {
  font-weight: 400;
  color: var(--c-text-tertiary);
  border-bottom: 1px solid var(--c-divider);
}

tbody tr {
  border-bottom: 1px solid var(--c-divider);
}

tbody tr:last-child {
  border-bottom: none;
}

tbody tr:hover {
  background-color: rgba(0, 0, 0, 0.015);
}

.usage-table__empty {
  padding: 40px 0;
  text-align: center;
  color: var(--c-text-tertiary);
}
</style>
