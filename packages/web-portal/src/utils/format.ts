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

/**
 * 两个时刻之间的相对间隔，用于展示「数据新鲜度」。
 *
 * ★ 基准刻意由调用方给（诊断页传**本次取数时刻**），不用 `Date.now()`：
 *   上报时间来自服务端，浏览器时钟慢几分钟就会算出负数（「-3 分钟前」），
 *   把一个健康的上报链路显示成未来数据。只做减法与措辞，不构成任何口径。
 * @example formatTimeGap(earlier, later) // '3 分钟前'
 */
export function formatTimeGap(from: number | null, to: number | null): string {
  if (from === null || from === 0 || to === null) return ''
  const gap = to - from
  if (gap < 60_000) return '刚刚'
  if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} 分钟前`
  if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} 小时前`
  return `${Math.floor(gap / 86_400_000)} 天前`
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

/**
 * 服务端的两种分桶键，逐字对应 `aggregate.ts` 的 `toDayKey()` / `toHourKey()`。
 *
 * ★ 必须校验形状而不是「看着像日期就格式化」：展示层同时会碰到模型名、厂商名、
 *   项目路径，把 `qwen-max` 这类文本当日期切一刀，图上会出现一年前的时间。
 */
const DAY_BUCKET = /^\d{4}-\d{2}-\d{2}$/
const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T\d{2}$/

/**
 * 从一列单元格值里认出时间分桶的粒度，认不出返回 `null`。
 *
 * 助手图表拿到的只有展示快照，**没有** `bucket=day|hour` 这个参数（它留在查询串里），
 * 所以粒度只能从值本身认。认不出来时调用方一律原样显示。
 *
 * ⚠️ 混了两代键时以小时为准：日桶列里不可能出现小时键，反过来才会（窗口跨界）。
 */
export function bucketGranularityOf(
  values: readonly unknown[],
): 'day' | 'hour' | null {
  let day = false
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (HOUR_BUCKET.test(value)) return 'hour'
    if (DAY_BUCKET.test(value)) day = true
  }
  return day ? 'day' : null
}

/**
 * 分桶键的**完整**写法：`2026-09-21T14` → `2026-09-21 14:00`。
 *
 * ★ 用在悬浮提示框的标题上（那里有位置写全）：`T14` 是机器格式，人读不出来。
 *   日桶 `2026-09-21` 本来就完整，原样返回；其余文本（模型名 / 厂商名）一律不动。
 *
 * 🚨 不要改成 `new Date(bucket)` 再 `toLocaleString`：分桶键是**服务端本地时区**的
 *   「哪一天的哪一小时」，浏览器时区不同（出差、客户在别的时区）时会整体位移，
 *   而位移出来的图看起来完全正常，查起来极难。
 */
export function formatBucketFull(bucket: string): string {
  return HOUR_BUCKET.test(bucket)
    ? `${bucket.slice(0, 10)} ${bucket.slice(11)}:00`
    : bucket
}
