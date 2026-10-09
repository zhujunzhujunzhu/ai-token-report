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
 *
 * ## 搜索与分页（v12 追加）
 *
 * 这一屏的行数随维度走：`厂商 / 模型` 在 90 天窗口下能到几百行，而它以前是
 * 一整条长列表铺到页面底部 —— 想找其中一行只能靠浏览器自带的页内查找。
 * 现在表头下方有一个搜索框、右下角有页码条，纯逻辑（匹配范围 / 页长 /
 * 工具条何时出现）全部在 `utils/breakdownView.ts`，这里只负责接线。
 *
 * ★ **不加开关 prop**：同一个组件在分析页（用量分布）、总览页（分组排行）与
 *   人员详情抽屉三处使用，行为由「这一屏装不装得下」自己决定 —— 抽屉里
 *   通常只有几个模型，那时连搜索框都不出现，不需要调用方各自记得传一个参数。
 * ⚠️ 关键词与页码是**临时视图状态**，筛选条件（服务端那一路）与它无关：
 *   关掉这一屏（切维度页签 / 换筛选）时数据本身会变，页码由 `paginate` 夹回
 *   有效范围，关键词**刻意留着** —— 它就写在搜索框里看得见，静默清掉使用者
 *   刚敲进去的字才是更糟的那种意外。
 */
import { ElInput, ElPagination, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { computed, ref, watch } from 'vue'
import type { BreakdownRow } from '@ai-token-report/shared'
import { formatCount, formatPercent } from '../utils/format.js'
import { UNPRICED_TEXT, costText, unpricedText } from '../utils/cost.js'
import { BREAKDOWN_PAGE_SIZE, breakdownViewOf } from '../utils/breakdownView.js'
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
   * ★ 搜索框的占位语也读它：搜「来源」与搜「维度」是使用者在页面上看得见的
   *   区别，这里不另起一套说法。
   */
  dimensionLabel?: string
}>()
const showCost = computed(() => props.rows.some((row) => row.cost))
/**
 * 关键词与页码（1 起）。
 *
 * ⚠️ 页码只是视图状态，**不进任何请求** —— 分布数据一次取全（见
 *   `utils/breakdownView.ts` 的文件头），筛选与它无关。
 */
const keyword = ref('')
const page = ref(1)
/** 这一屏的全部状态（命中行 / 当前页 / 工具条可见性）出自同一次计算。 */
const view = computed(() =>
  breakdownViewOf(props.rows, keyword.value, page.value, props.labelOf),
)
/**
 * 换了个关键词就回到第 1 页。
 *
 * ⚠️ 不复用上一次的页码：停在「第 3 页」上看一个只有 2 行的搜索结果，
 *   使用者会以为搜索没生效，而实际上他只是被留在了越界的那一页上。
 */
watch(keyword, () => { page.value = 1 })
/**
 * 命中条数变少（换时间窗 / 换维度 / 改筛选）时把页码夹回有效范围。
 *
 * ★ `paginate` 内部也会夹，这里回写原始状态是为了**让状态与画面一致**：
 *   否则清掉关键词之后，页码会突然跳回上一次那个早已越界的值。
 * ⚠️ 只在**长度**上触发：看板每 5 秒轮询一次，每次都换一份新的行数组，
 *   盯着数组本身会让使用者每 5 秒被弹回第 1 页。
 */
watch(() => view.value.matched.length, () => { page.value = view.value.paged.page })
/**
 * 分页条翻页。
 *
 * ⚠️ 这里不做范围判断：页面上传给分页条的是 `paged.page`（已经是有效页码），
 *   而任何越界值都会在下一次 `paginate` 里被夹回来 —— 再写一遍判断就是第二个实现。
 */
function setPage(value: number): void { page.value = value }
/**
 * 空态文案。
 *
 * 🚨 有关键词时**不能**沿用「这段时间没有分布数据」：那会把「你搜的词没命中」
 *   说成「这段时间没有数据」，而这两件事的下一步动作完全不同
 *   （改关键词 vs 换时间窗）。
 */
const emptyText = computed(() =>
  view.value.keyword
    ? `没有匹配「${view.value.keyword}」的${props.dimensionLabel ?? '维度'}`
    : '这段时间没有分布数据',
)
/**
 * 表格插槽给的 `row` 是 Element Plus 自己的 `DefaultRow`（`Record<PropertyKey, any>`），
 * 不是本组件的契约类型，而模板里做不了类型断言 —— 所以入口收 `unknown`、
 * 在这里收窄一次。行的真实形状由 `/api/v1/stats/breakdown` 决定。
 */
const rowBreakdown = (row: unknown): BreakdownRow => row as BreakdownRow
</script>
<template>
  <!--
    ★ 工具条的可见性由 `showToolbar` 一个判据决定（搜索框与页码条同进同退）：
      装得下一屏且没有关键词时，它们解释不了任何事情，只会把表头挤下去。
    ⚠️ 复用全局的 `.member-filters` 只是要那一行筛选框的排版（左输入框 + 右侧
      计数），与「人员」无关 —— 本仓的样式刻意不写 `scoped`，见 `base.css` 里
      关于分布表单元格 HTML 逐字断言的说明。
  -->
  <div v-if="view.showToolbar" class="member-filters">
    <el-input
      v-model="keyword"
      :prefix-icon="Search"
      clearable
      :placeholder="`搜索${dimensionLabel ?? '维度'}`"
      :aria-label="`搜索${dimensionLabel ?? '维度'}`"
    />
    <!-- 计数说的是**命中数与总数**：只给一个数字，分页之后没人知道筛掉了多少。 -->
    <span v-if="view.keyword" class="muted"
      >匹配 {{ view.matched.length }} / 共 {{ rows.length }} 行</span
    >
    <span v-else class="muted">共 {{ rows.length }} 行</span>
  </div>
  <el-table
    :data="view.paged.rows"
    row-key="key"
    :empty-text="emptyText"
  >
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
  <!--
    ★ 只有一页时不画页码条（搜索框可能还在：关键词命中数装得下一屏时，
      留着它是为了让人能清掉关键词）。页码与表里的行同出 `view.paged`。
  -->
  <div v-if="view.showToolbar && view.paged.pageCount > 1" class="table-footer">
    <span>第 {{ view.paged.page }} / {{ view.paged.pageCount }} 页 · 每页 {{ BREAKDOWN_PAGE_SIZE }} 行</span>
    <el-pagination
      :current-page="view.paged.page"
      :page-size="BREAKDOWN_PAGE_SIZE"
      :total="view.matched.length"
      background
      layout="prev, pager, next"
      @current-change="setPage"
    />
  </div>
</template>