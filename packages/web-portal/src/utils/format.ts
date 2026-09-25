/**
 * 数值与时间的格式化工具（部门看板）。
 *
 * ★ 这里**只做格式化**，绝不重算任何口径。
 *   比率（`cacheHitRate` / `unattributedRate`）由服务端按
 *   `shared/src/metrics.ts` 算好后返回，前端负责的只有
 *   `0.9503` → `'95.0%'` 这一步。前端一旦自己算一遍，
 *   就是第二个口径来源 —— 而它不会报错，只会让两个页面的数字对不上。
 */

/**
 * 千分位分割整数。
 * @example formatCount(80642909) // '80,642,909'
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * 把 0~1 的比率格式化成百分比。
 * @example formatPercent(0.9503) // '95.0%'
 */
export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

/**
 * 紧凑格式化，用于图表刻度与排行条上的数值：超过一万折算为「万」，超过一亿为「亿」。
 *
 * 用中文单位而不是 `M` / `B`：这个页面的用户读「1.2亿」比读「120M」快得多。
 * @example formatCompact(80642909) // '8064.3万'
 */
export function formatCompact(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}

/** `09-21 14:05` —— 明细表与诊断用（省年份，窗口最长也就一年）。 */
export function formatDateTime(ms: number | null): string {
  if (ms === null || ms === 0) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `2026-09-21 14:05` —— 需要完整日期的场合（数据边界）。 */
export function formatFullDateTime(ms: number | null): string {
  if (ms === null || ms === 0) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `2026-09-21` —— 时间窗边界。 */
export function formatDate(ms: number | null): string {
  if (ms === null) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 趋势图 X 轴标签。
 *
 * `2026-09-21` → `09-21`；`2026-09-21T14` → `14:00`。
 * 省略年份是因为窗口最长也就一年，X 轴放完整日期一定挤成一团。
 */
export function formatBucket(
  bucket: string,
  granularity: 'day' | 'hour',
): string {
  if (granularity === 'hour') {
    const hour = bucket.split('T')[1] ?? '00'
    return `${hour}:00`
  }
  const [, month, day] = bucket.split('-')
  return month && day ? `${month}-${day}` : bucket
}
