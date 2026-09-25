/**
 * 浏览器半的**纯展示格式**。
 *
 * ## 为什么这里可以重复写「紧凑数字」这类函数
 *
 * `packages/core/src/format.ts` 里有一份 `fmtCompact` / `fmtPct`。这里没有
 * import 它，原因是**包不能进浏览器**：`core` 的主入口会拉到 `node:zlib`
 * 一族内建模块，一旦进浏览器包，DSH 的模块表（只预置 9 个模块）会在
 * 物化阶段直接抛错。为一个 8 行的数字格式化函数把整个内核拖进前端不划算。
 *
 * ⚠️ **但口径不在此列**：本文件只做「把数字变成字符串」，
 *   任何比率、倍数、均值都必须来自宿主算好的 `metrics`（铁律 1）。
 *   这里出现除法，就是第二个口径实现。
 *
 * 全部是纯函数，因此可以直接用 `bun test` 钉住输出（见 `test/client/format.test.ts`）。
 */

/**
 * 紧凑数字：`12.35M` / `1.2K`。
 *
 * 面板是常驻的一行，放不下 `12,345,678` 这样的全量数字；
 * 需要精确值时把鼠标停在上面看 `title`（那里给的是 `fmtInt`）。
 */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

/** 千分位全量数字。 */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 百分比。入参是 0~1 的比率。 */
export function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`
}

/** 缓存杠杆倍数。 */
export function fmtLeverage(x: number): string {
  return `${x.toFixed(1)}x`
}

/** 相对时间。 */
export function fmtAge(now: number, then: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** 本地时钟（只到秒）。 */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/**
 * 数据来源的中文标签。
 *
 * ★ 与宿主 `stats.ts` 的 `sourceLabel()` 保持一致 —— 降级时**必须**看得出来
 *   「这次为什么慢 30 倍」，所以这个标签不允许含糊。
 */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'local-db':
      return '本机 SQLite 库'
    case 'scan':
      return '直扫会话日志'
    case 'none':
      return '未找到会话日志'
    default:
      return source
  }
}

/**
 * 趋势点的时间轴标签。
 *
 * `bucket` 由 `core/aggregate.ts` 产出：天粒度是 `2026-09-24`，
 * 小时粒度是 `2026-09-24T14`。面板上只画横轴的**首尾**两个标签，
 * 所以这里只取最有信息量的那一段。
 */
export function shortBucket(bucket: string): string {
  const hourSplit = bucket.split('T')
  if (hourSplit.length === 2) return `${Number(hourSplit[1])}时`
  const parts = bucket.split('-')
  if (parts.length === 3) return `${Number(parts[1])}-${Number(parts[2])}`
  return bucket
}
