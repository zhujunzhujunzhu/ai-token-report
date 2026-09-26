/**
 * 部门看板的展示层类型与选项常量。
 *
 * ★ 所有数据字段的类型**直接来自 `@ai-token-report/shared`**，
 *   这里只补充「页面自己的排版概念」（选项列表、格式化后的视图模型）。
 *   早期本地页曾用 mock 时代的字段（`apiKey` / `cost` / `requests`），
 *   与后端完全对不上，接上真数据后就是一片空图表 —— 不再重演。
 */

import { UNATTRIBUTED_USER, type GroupBy, type BreakdownRow } from '@ai-token-report/shared'

/** 时间窗选项（value 是服务端认识的具名周期）。 */
export interface TimeRangeOption {
  value: string
  label: string
}

/** 通用下拉 / 页签选项。 */
export interface SelectOption {
  value: string
  label: string
}

/**
 * 「自定义区间」的哨兵值。
 *
 * ⚠️ 它**不是**服务端认识的周期：选中它时前端发的是 `from` / `to`
 *   （epoch 毫秒），而不是 `period`。两者绝不能同时发 ——
 *   服务端的语义是「显式 from/to 覆盖 period」，同时发会让
 *   `period=custom` 先被当成未知周期而 400。
 *
 * ⚠️ 必须定义在 `TIME_RANGES` **之前**：常量在模块求值时初始化，
 *   写在使用点之后会踩 TDZ（`Cannot access before initialization`），
 *   而这个错误只在页面加载时出现，看起来像「整个页面白屏」。
 */
export const CUSTOM_PERIOD = 'custom'

/**
 * 顶部时间窗选项。
 *
 * ★ 每一项（除「自定义区间」）都是**服务端认识的具名周期**，页面只把它原样传出去，
 *   由 `core/range.ts` 解析成绝对时间 —— 前端不做任何日期换算。
 *
 * ⚠️ 「自定义区间」是**唯一**的例外：它对应的是用户在输入框里明确选定的
 *   两个绝对时刻（`from` / `to`），那不是口径，而是输入本身。
 */
export const TIME_RANGES: TimeRangeOption[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'week', label: '本周' },
  { value: 'lastweek', label: '上周' },
  { value: 'last7d', label: '最近 7 天' },
  { value: 'last14d', label: '最近 14 天' },
  { value: 'month', label: '本月' },
  { value: 'lastmonth', label: '上月' },
  { value: 'last30d', label: '最近 30 天' },
  { value: 'last90d', label: '最近 90 天' },
  { value: 'year', label: '今年' },
  { value: CUSTOM_PERIOD, label: '自定义区间…' },
]

/** 分布页签（人员排行单独一栏，见 `RankingTable`）。 */
export const BREAKDOWN_TABS: { value: GroupBy; label: string }[] = [
  { value: 'provider-model', label: '厂商 / 模型' },
  { value: 'model', label: '模型' },
  { value: 'provider', label: '厂商' },
  { value: 'project', label: '项目' },
]

/** 明细表的列定义。 */
export interface DetailColumn {
  key: string
  title: string
  /** 是否右对齐（数值列）。 */
  numeric: boolean
}

export const RECORD_COLUMNS: DetailColumn[] = [
  { key: 'ts', title: '时间', numeric: false },
  { key: 'userId', title: '署名', numeric: false },
  { key: 'provider', title: '厂商', numeric: false },
  { key: 'model', title: '模型', numeric: false },
  { key: 'calls', title: '调用', numeric: true },
  { key: 'inputTokens', title: '未缓存输入', numeric: true },
  { key: 'outputTokens', title: '输出', numeric: true },
  { key: 'cacheReadTokens', title: '缓存读', numeric: true },
  { key: 'totalTokens', title: '计费总量', numeric: true },
]

/**
 * 趋势用哪个分桶：当天/昨天看小时，更长窗口看天。
 *
 * ★ 这里只决定「向服务端要哪种粒度」，**不涉及任何时间换算** ——
 *   窗口边界仍然由服务端解析（具名周期）或由用户显式给定（自定义区间）。
 *
 * @param spanMs 自定义区间的跨度。跨过 2 天的窗口按小时画会得到一屏挤在一起的
 *   柱子（`last90d` 按小时 = 2160 个点），因此按跨度选粒度。
 */
export function bucketFor(period: string, spanMs?: number): 'day' | 'hour' {
  if (period === CUSTOM_PERIOD) {
    // 自定义区间没有「今天/昨天」这种语义，只能看跨度
    return spanMs !== undefined && spanMs <= 2 * 86_400_000 ? 'hour' : 'day'
  }
  return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
}

/**
 * 归属键的展示文案。
 *
 * `unknown` 是协议里的未归属键（`UNATTRIBUTED_USER`），直接显示成
 * 「unknown」没人看得懂，显示成「未署名」才指出了动作（去本地页填一下）。
 */
export function userLabel(key: string): string {
  return key === UNATTRIBUTED_USER ? '未署名' : key
}

/** 同名人员用部门与短 ID 辅助区分；旧响应仍可显示旧人名。 */
export function identityLabel(row: BreakdownRow): string {
  const name = row.label ?? userLabel(row.key)
  return row.member_id ? `${name} · ${row.department_name ? row.department_name + ' · ' : ''}${row.member_id.slice(0, 8)}` : name
}

/** 未归属行的展示标记（用于给那一行加醒目的底色）。 */
export function isUnattributed(key: string): boolean {
  return key === UNATTRIBUTED_USER
}
