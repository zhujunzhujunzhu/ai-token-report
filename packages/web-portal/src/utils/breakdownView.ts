/**
 * 「用量分布」表的搜索 + 分页 —— 视图层唯一的实现
 * （表本身是 `components/BreakdownTable.vue`，总览的「分组排行」与分析页的
 * 「用量分布」共用它）。
 *
 * ## 为什么是**客户端**搜索 + 分页
 *
 * `GET /api/v1/stats/breakdown` 一次返回窗口内的**全部**分组行（十几个到几百个），
 * 协议里既没有 `limit` 也没有 `total`。为它加服务端分页要同时动契约、路由、
 * e2e 与页面两侧，换来的只是省下几 KB JSON —— 与 appKey 列表是同一笔账
 * （理由写在 `pagination.ts` 的文件头）。
 *
 * ⚠️ 与调用明细（`RecordsTable`）**刻意不同**：那里一次查询可能是几十万条事件，
 *   必须由服务端分页；在客户端截断会让「共 N 条」这句真话变成一句谎话。
 *   两种做法不是同一个问题的两种口味，而是由「一次能取回多少」决定的。
 *
 * ## 搜索匹配什么
 *
 * ★ **第一列真的画出来的东西都参与匹配**：原始键、展示名（`labelOf`）与分组标签。
 *   只认其中一半就会出现「明明有这一行却搜不到」：
 *   `by=source` 的展示名是翻译过的（`trae-cn` → `Trae CN`），而使用者可能记得
 *   原值也可能记得展示名；分组标签是人员维度下我们希望他能直接搜到的东西。
 *   ⚠️ 大小写不敏感、前后空白忽略 —— 与仓库里其它搜索框（人员 / appKey / 规则）
 *     同一副手感。
 * 🚨 **数值列一律不参与**：搜「1」会命中几乎所有行，那不是搜索，是把每一行都
 *   变成一次正则试跑。要按用量排序看的是「按计费总量排序」这件事本身。
 *
 * ## 工具条（搜索框 / 行数 / 页码条）什么时候出现
 *
 * 与「只有一页时不画分页条」同一条纪律（见 `AppKeyView.vue`）：**行数装得下
 * 一屏、且没有关键词**时，搜索框与页码条都不出现 —— 它们在那时解释不了任何
 * 事情，却会把唯一值得看的表头挤下去。
 * ⚠️ 有关键词时**必须**继续出现：否则使用者没有地方清掉它，表会一直空着。
 */

import type { BreakdownRow } from '@ai-token-report/shared'
import { paginate, type Paged } from './pagination.js'

/**
 * 分布表每页行数。
 *
 * ★ 与页长挨着写的理由同 `APP_KEY_PAGE_SIZE`：取 10 是因为这一屏的行高
 *   （费用列偶尔还带一行「未计价 xx%」小字）正好十行看得满而不用滚动。
 * ⚠️ `verify/verify-render.ts` 按这个常量生成夹具（不写死条数），
 *   所以改这里不会留下一堆假失败 —— 但会真的改变一屏能看几行。
 */
export const BREAKDOWN_PAGE_SIZE = 10

export interface BreakdownView {
  /** 命中关键词的**全部**行（分页前）：「共 N 行 / 匹配 M 行」这句真话对着它说。 */
  matched: BreakdownRow[]
  /**
   * 当前页的行与页码。
   *
   * ⚠️ 切片与页码**同出这一份**（越界修正在 `paginate` 里）：表里画的行与页码条
   *   上高亮的页一旦各算一次，就会出现「写着第 3 页、表里却是第 1 页的行」。
   */
  paged: Paged<BreakdownRow>
  /** 搜索框与页码条是否该出现（见文件头「工具条什么时候出现」）。 */
  showToolbar: boolean
  /** 归一化后的关键词（去掉前后空白）；空串 = 没有在搜索。 */
  keyword: string
}

/**
 * 一行参与搜索的文本（小写）。
 *
 * ★ 展示名与原始键**都**进：`by=source` 下 `trae-cn` 与 `Trae CN` 是同一个来源的
 *   两种写法，使用者记得哪个都不该搜不到。
 * ★ 分组标签也进：它在第一列是**渲染出来的标签**，看得见的东西就该搜得到。
 */
export function breakdownSearchText(
  row: BreakdownRow,
  labelOf?: (row: BreakdownRow) => string,
): string {
  const parts = [row.key]
  const label = labelOf?.(row)
  // 展示名与键相同时不重复拼一遍（大部分维度都是这样）。
  if (label && label !== row.key) parts.push(label)
  for (const name of row.group_names ?? []) parts.push(name)
  return parts.join(' ').toLowerCase()
}

/**
 * 关键词命中的行（**先匹配、后分页**）。
 *
 * 🚨 顺序不能反：在切片之后再 filter，搜索框会静默变成「只搜当前页」——
 *   表现是「明明有这一行，翻到第 2 页才有」，而页面上没有任何迹象。
 * ⚠️ 空关键词返回**全部行**（不是空）：没有搜索时这一屏就是全部分布。
 */
export function matchBreakdownRows(
  rows: readonly BreakdownRow[],
  keyword: string,
  labelOf?: (row: BreakdownRow) => string,
): BreakdownRow[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => breakdownSearchText(row, labelOf).includes(needle))
}

/** 一整屏所需的全部状态：命中行、当前页、工具条可见性（三者出自同一次计算）。 */
export function breakdownViewOf(
  rows: readonly BreakdownRow[],
  keyword: string,
  page: number,
  labelOf?: (row: BreakdownRow) => string,
): BreakdownView {
  const trimmed = keyword.trim()
  const matched = matchBreakdownRows(rows, trimmed, labelOf)
  return {
    matched,
    paged: paginate(matched, page, BREAKDOWN_PAGE_SIZE),
    // ⚠️ 判据里的行数是**原始行数**（不是命中数）：12 行装不下一屏，所以即使
    //   关键词一个都没命中，也要留着搜索框给使用者清掉它。
    showToolbar: rows.length > BREAKDOWN_PAGE_SIZE || trimmed !== '',
    keyword: trimmed,
  }
}