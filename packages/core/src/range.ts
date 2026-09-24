/**
 * 时间范围解析。
 *
 * 支持三类写法，全部按**本地时区**解释（符合用户直觉）：
 *
 * 1. 具名周期：today / yesterday / week / month / lastweek / lastmonth / last7d / last30d ...
 * 2. 绝对时间：2026-09-18 / 2026-09-18T14:30
 * 3. 相对回推：7d / 24h / 90m
 *
 * ⚠️ 语义区分（容易混淆，特此明确）：
 *
 *   --last 7d       滚动 7×24 小时（从此刻往回 168 小时）
 *   --period last7d 最近 7 个**自然日**（含今天），即今天 00:00 往前 6 天
 *   --period week   本周（周一 00:00 至今）
 *   --period month  本月（1 号 00:00 至今）
 *
 * 「滚动 7 天」与「最近 7 个自然日」结果不同，看板口径通常用后者。
 */

export interface ResolvedRange {
  sinceMs?: number
  untilMs?: number
  label: string
}

export class RangeError extends Error {}

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/** 本地当天 00:00:00.000 */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 本地当天 23:59:59.999 */
function endOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

/**
 * 本地「本周」起点。
 * 按**周一开始**（中国习惯），而非周日。
 */
function startOfWeek(d: Date): number {
  // getDay(): 0=周日, 1=周一 ... 6=周六
  const dow = d.getDay()
  // 周日应回退 6 天到本周一；其余回退 dow-1 天
  const back = dow === 0 ? 6 : dow - 1
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
}

/** 本地「本月」起点（1 号 00:00）。 */
function startOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** 本地「今年」起点（1 月 1 日 00:00）。 */
function startOfYear(d: Date): number {
  return new Date(d.getFullYear(), 0, 1).getTime()
}

/** 在给定日期上加减天数。 */
function shiftDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

/** 在给定日期上加减月份（落到 1 号，避免月末溢出）。 */
function shiftMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1)
}

export interface PeriodResolution {
  sinceMs: number
  untilMs?: number
  label: string
}

/**
 * 解析具名周期。
 * 返回 null 表示不是具名周期，调用方应回退到其他解析方式。
 */
export function resolvePeriod(name: string, now = new Date()): PeriodResolution | null {
  const key = name.trim().toLowerCase().replace(/[\s_-]/g, '')

  switch (key) {
    // ---------------------------------------------------------- 单日
    case 'today':
    case '今天':
      return { sinceMs: startOfDay(now), label: '今天' }

    case 'yesterday':
    case '昨天':
      return {
        sinceMs: startOfDay(shiftDays(now, -1)),
        untilMs: endOfDay(shiftDays(now, -1)),
        label: '昨天',
      }

    case 'daybeforeyesterday':
    case '前天':
      return {
        sinceMs: startOfDay(shiftDays(now, -2)),
        untilMs: endOfDay(shiftDays(now, -2)),
        label: '前天',
      }

    // ---------------------------------------------------------- 周
    case 'week':
    case 'thisweek':
    case '本周':
      return { sinceMs: startOfWeek(now), label: '本周（周一起）' }

    case 'lastweek':
    case '上周': {
      const thisWeekStart = new Date(startOfWeek(now))
      const lastWeekStart = shiftDays(thisWeekStart, -7)
      return {
        sinceMs: startOfDay(lastWeekStart),
        untilMs: endOfDay(shiftDays(thisWeekStart, -1)),
        label: '上周',
      }
    }

    // ---------------------------------------------------------- 月
    case 'month':
    case 'thismonth':
    case '本月':
      return { sinceMs: startOfMonth(now), label: '本月' }

    case 'lastmonth':
    case '上月': {
      const thisMonthStart = new Date(startOfMonth(now))
      const lastMonthStart = shiftMonths(thisMonthStart, -1)
      return {
        sinceMs: startOfDay(lastMonthStart),
        untilMs: endOfDay(shiftDays(thisMonthStart, -1)),
        label: '上月',
      }
    }

    // ---------------------------------------------------------- 年
    case 'year':
    case 'thisyear':
    case '今年':
      return { sinceMs: startOfYear(now), label: '今年' }

    // -------------------------------------------------- 最近 N 个自然日
    // last7d / last30d 语义 = 含今天的最近 N 个自然日
    case 'last7d':
    case 'last7days':
    case '最近7天':
      return {
        sinceMs: startOfDay(shiftDays(now, -6)),
        label: '最近 7 天（自然日）',
      }

    case 'last14d':
    case 'last14days':
    case '最近14天':
      return {
        sinceMs: startOfDay(shiftDays(now, -13)),
        label: '最近 14 天（自然日）',
      }

    case 'last30d':
    case 'last30days':
    case '最近30天':
      return {
        sinceMs: startOfDay(shiftDays(now, -29)),
        label: '最近 30 天（自然日）',
      }

    case 'last90d':
    case 'last90days':
    case '最近90天':
      return {
        sinceMs: startOfDay(shiftDays(now, -89)),
        label: '最近 90 天（自然日）',
      }
  }

  return null
}

/** 所有可用的具名周期（用于 --help 与报错提示）。 */
export const PERIOD_NAMES = [
  'today（今天）',
  'yesterday（昨天）',
  'week（本周，周一起）',
  'lastweek（上周）',
  'month（本月）',
  'lastmonth（上月）',
  'year（今年）',
  'last7d / last14d / last30d / last90d（最近 N 个自然日）',
] as const

/**
 * 解析单个时间点（用于 --since / --until）。
 * `endOfDay_` 用于把纯日期推进到当天 23:59:59.999。
 *
 * 会优先尝试具名周期：
 *   --since today   → 今天 00:00
 *   --until today   → 今天 23:59:59.999
 *
 * 对没有结束边界的开区间周期（today / week / month / year），
 * 作为 --until 使用时取其**所在自然日的末刻**，符合「统计到今天为止」的直觉。
 */
export function parseTimePoint(input: string, endOfDay_ = false): number {
  const s = input.trim()
  if (!s) throw new RangeError('空的时间值')

  // 具名周期
  const period = resolvePeriod(s)
  if (period) {
    if (!endOfDay_) return period.sinceMs
    // 有明确结束边界（yesterday / lastweek / lastmonth）直接用
    if (period.untilMs !== undefined) return period.untilMs
    // 开区间周期（today / week / month ...）：取「今天」的末刻
    return endOfDay(new Date())
  }

  // 相对回推：7d / 12h / 30m
  const rel = /^(\d+)\s*(d|h|m)$/i.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]!.toLowerCase()
    const ms = unit === 'd' ? DAY : unit === 'h' ? HOUR : MINUTE
    return Date.now() - n * ms
  }

  // 纯日期 YYYY-MM-DD
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (dateOnly) {
    const [, y, mo, d] = dateOnly
    return endOfDay_
      ? new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999).getTime()
      : new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime()
  }

  // YYYY-MM-DDTHH:mm[:ss]
  const withTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (withTime) {
    const [, y, mo, d, h, mi, sec] = withTime
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec ?? 0),
      0,
    ).getTime()
  }

  const parsed = Date.parse(s)
  if (!Number.isNaN(parsed)) return parsed

  throw new RangeError(
    `无法解析的时间: "${input}"。\n` +
      `  绝对时间: 2026-09-18 / 2026-09-18T14:30\n` +
      `  相对回推: 7d / 24h / 90m\n` +
      `  具名周期: ${PERIOD_NAMES.join(' / ')}`,
  )
}

export interface ParseRangeOptions {
  since?: string
  until?: string
  /** `--last 7d`：滚动窗口（N×24h）。 */
  last?: string
  /** `--period today`：具名周期。 */
  period?: string
}

/** 把 CLI 选项解析为绝对时间窗口。 */
export function resolveRange(opts: ParseRangeOptions): ResolvedRange {
  let sinceMs: number | undefined
  let untilMs: number | undefined
  let label: string | undefined

  // 具名周期
  if (opts.period) {
    const p = resolvePeriod(opts.period)
    if (!p) {
      throw new RangeError(
        `未知周期 "${opts.period}"。\n可选: ${PERIOD_NAMES.join(' / ')}`,
      )
    }
    sinceMs = p.sinceMs
    untilMs = p.untilMs
    label = p.label
  }

  if (opts.last) {
    // 滚动窗口：--last 7d = 从此刻往回 168 小时
    sinceMs = Date.now() - parseRelative(opts.last)
    untilMs = undefined
    label = `最近 ${opts.last}（滚动）`
  }

  if (opts.since) {
    sinceMs = parseTimePoint(opts.since, false)
    label = undefined
  }

  if (opts.until) {
    untilMs = parseTimePoint(opts.until, true)
    label = undefined
  }

  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new RangeError('起始时间晚于结束时间')
  }

  return {
    sinceMs,
    untilMs,
    label: label ?? describeRange({ sinceMs, untilMs }),
  }
}

/** 解析 N[d|h|m] 为毫秒。 */
function parseRelative(s: string): number {
  const rel = /^(\d+)\s*(d|h|m)$/i.exec(s.trim())
  if (!rel) {
    throw new RangeError(`--last 需要形如 7d / 24h / 90m 的值，收到 "${s}"`)
  }
  const n = Number(rel[1])
  const unit = rel[2]!.toLowerCase()
  return n * (unit === 'd' ? DAY : unit === 'h' ? HOUR : MINUTE)
}

/** 简短时间标签。 */
export function formatPoint(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = d.getHours()
  const mi = d.getMinutes()
  // 恰好零点时只显示日期，读起来更干净
  if (h === 0 && mi === 0) return `${y}-${m}-${day}`
  return `${y}-${m}-${day} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

export function fmtTime(ms: number | undefined): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${mi}`
}

/**
 * 生成人类可读的时间窗口描述，用于报告头部。
 * 形如 `2026-09-15 ~ 2026-09-21`。
 */
export function describeRange(r: {
  sinceMs?: number
  untilMs?: number
}): string {
  if (r.sinceMs === undefined && r.untilMs === undefined) return '全部时间'
  const since = r.sinceMs !== undefined ? formatPoint(r.sinceMs) : '最早'
  const until = r.untilMs !== undefined ? formatPoint(r.untilMs) : '现在'
  return `${since} ~ ${until}`
}

/** 报告头部的完整描述：`今天（2026-09-21 00:00 ~ 现在）`。 */
export function describeRangeFull(r: ResolvedRange): string {
  if (r.sinceMs === undefined && r.untilMs === undefined) return '全部时间'
  const window = describeRange(r)
  return r.label === window ? window : `${r.label}（${window}）`
}