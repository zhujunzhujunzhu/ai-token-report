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
  /**
   * 首屏骨架：还没有任何数据可显示（只在第一轮请求结束前为真）。
   *
   * ⚠️ 与 `busy` 是两件事：切换分组维度时 `loading` 是假、`busy` 是真 ——
   * 那时**旧行仍然有效，必须留在原地**，清空重画会让表格从 8 行塌成 1 行占位，
   * 页面高度跟着一收一放（「点一下就闪」的根源）。
   */
  loading?: boolean
  /** 用户发起的一轮在飞（保留旧行 + 淡化 + 表头「更新中…」）。 */
  busy?: boolean
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

/**
 * 表体占位：**这一轮筛选的结果还没到**时用（首屏，或上一次的结果本来就是空的）。
 *
 * ★ 判的是 `rows.length === 0` 而不是只看 `loading`：只要表格里已经有行，
 *   换一批行的过程中就要把它们留住（配合 `busy` 淡化），绝不塌成一行占位。
 * ★ `busy` 也要算进来：上一维度是空的、刚又点了另一个维度时，说「暂无用量数据」
 *   是把「还没查完」说成了结论。
 */
const showPlaceholder = computed(
  () => props.rows.length === 0 && (props.loading === true || props.busy === true),
)

/** 是否在「保留旧行等新行」的状态下（淡化 + 表头提示）。 */
const isRefreshing = computed(() => props.busy === true && props.rows.length > 0)
</script>

<template>
  <div class="usage-table">
    <header class="usage-table__head">
      <h2 class="usage-table__title">
        按{{ dimLabel }}分组
        <span class="usage-table__amount tabular">
          合计 {{ totalTokens.toLocaleString('en-US') }} tokens
        </span>
        <!--
          换维度 / 换时间窗时，旧行留在原地而合计还是旧的 —— 这一小行说明它们正在被替换。
          没有它，使用者分不清「已经是新维度的数」与「还在等新数」。
        -->
        <span v-if="isRefreshing" class="usage-table__busy" role="status">更新中…</span>
      </h2>
    </header>

    <div class="usage-table__scroll" :class="{ 'is-refreshing': isRefreshing }">
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
          <tr v-if="showPlaceholder">
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

/*
  换一批行时的状态提示。刻意做成**表头里的一个词**而不是整表覆盖层 / 骨架：
  行还留着，页面高度不变，使用者能读到「正在替换」而不会被闪一下。
*/
.usage-table__busy {
  font-size: 12px;
  font-weight: 400;
  color: var(--c-text-tertiary);
}

.usage-table__scroll {
  overflow-x: auto;
  transition: opacity 0.15s var(--ease);
}

/*
  淡化而不是清空：旧行在位、可读，颜色略淡表示它正在被替换。
  与 `.usage-table__busy` 同一个条件（`busy && rows.length > 0`）——
  首屏那轮不淡化（占位行本来就说明在扫描），后台每 3 秒的轮询也不淡化
  （否则数字会一直「呼吸」）。
*/
.usage-table__scroll.is-refreshing {
  opacity: 0.55;
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
