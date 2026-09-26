/**
 * 日期选择器的**纯文本逻辑**：解析、格式化、提示。
 *
 * ## 为什么单独一个文件
 *
 * 这些函数是「使用者敲进来的字」与「发给宿主的区间」之间唯一的翻译层，
 * 也是这个浮层里最容易出错的地方（`2026-9-1`、`2026/09/01`、`2026年9月1日`
 * 都得认；`2026-02-31` 必须不认）。它们不碰 React，所以能被单测逐条钉住 ——
 * 组件里的同类逻辑只能靠人眼看。
 *
 * ⚠️ **这里不重算任何时间窗口径**：所有日期都只是本地日历上的一个日期，
 *   真正的零点/末刻边界由宿主的 `core/range.ts` 统一算（自定义区间传
 *   显式 `since`/`until` 是本仓唯一允许的前端「区间」）。
 */

import { validDateRange, type UiDateRange } from './protocol.js'

/** 本地日历日 → `YYYY-MM-DD`。**不要**用 `toISOString()`：那是 UTC，会整体错一天。 */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 使用者敲进来的日期文本 → 规范化的 `YYYY-MM-DD`；认不出来返回 `undefined`。
 *
 * 接受 `2026-09-21` / `2026/9/21` / `2026.9.21` / `2026年9月21日` / `20260921`。
 * 合法性判据复用 `validDateRange`（唯一一份「这是个真日期」的实现）——
 * 于是 `2026-02-31` 这种「格式对但不存在」的日期同样被挡下。
 */
export function parseDayText(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const separated = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(trimmed)
  const compact = separated === null ? /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed) : null
  const parts = separated ?? compact
  if (parts === null) return undefined
  const normalized = `${parts[1]}-${parts[2]!.padStart(2, '0')}-${parts[3]!.padStart(2, '0')}`
  return validDateRange({ since: normalized, until: normalized }) ? normalized : undefined
}

/** 含头含尾的天数（`until` 当天也算一天，与宿主口径一致）。 */
export function inclusiveDays(since: string, until: string): number {
  // 用 UTC 正午做差：本地午夜在夏令时切换日会差 23/25 小时。
  const from = Date.parse(`${since}T12:00:00Z`)
  const to = Date.parse(`${until}T12:00:00Z`)
  return Math.round((to - from) / 86_400_000) + 1
}

/** 触发器上的短标签：同年省掉年份，跨年保留，免得「12-30 – 01-04」看不出方向。 */
export function shortDay(day: string, withYear: boolean): string {
  return withYear ? day : day.slice(5)
}

/**
 * 「自定义」按钮的文案。
 *
 * ★ 只有**当前生效**的就是自定义区间时才显示区间：面板停在「今天」时
 *   显示上次用过的旧区间，会让人以为统计范围变了（面板上那行 `rangeLabel`
 *   说的却是「今天」）。
 */
export function triggerLabel(range: UiDateRange | undefined, active: boolean, today: Date = new Date()): string {
  if (!active || !validDateRange(range)) return '自定义'
  const year = `${today.getFullYear()}-`
  const sameYear = range.since.startsWith(year) && range.until.startsWith(year)
  return `${shortDay(range.since, !sameYear)} – ${shortDay(range.until, !sameYear)}`
}

/** 按钮 `title`：完整区间，配合被截断的短标签。 */
export function triggerTitle(range: UiDateRange | undefined, active: boolean): string {
  if (!active || !validDateRange(range)) return '自定义日期范围'
  return `自定义范围：${range.since} 至 ${range.until}`
}

/**
 * 选择区下方那句提示，也是「应用范围为什么是灰的」的答案。
 *
 * ⚠️ 非法时**必须**说出来。之前只有一个 disabled 的按钮，使用者只能猜。
 */
export function selectionHint(fields: { since: string; until: string }): { text: string; error: boolean } {
  const sinceRaw = fields.since.trim()
  const untilRaw = fields.until.trim()
  const since = parseDayText(sinceRaw)
  const until = parseDayText(untilRaw)
  if (sinceRaw !== '' && since === undefined) return { text: '开始日期格式应为 2026-09-21', error: true }
  if (untilRaw !== '' && until === undefined) return { text: '结束日期格式应为 2026-09-21', error: true }
  if (since === undefined) return { text: until === undefined ? '先选开始，再选结束' : '还需要开始日期', error: false }
  if (until === undefined) return { text: '还需要结束日期', error: false }
  if (since > until) return { text: '开始日期不能晚于结束日期', error: true }
  return { text: `共 ${inclusiveDays(since, until)} 天`, error: false }
}

/** 把两个文本框收敛成能发给宿主的区间；还不能用就返回 `undefined`。 */
export function fieldsToRange(fields: { since: string; until: string }): UiDateRange | undefined {
  const since = parseDayText(fields.since)
  const until = parseDayText(fields.until)
  if (since === undefined || until === undefined) return undefined
  const range = { since, until }
  return validDateRange(range) ? range : undefined
}