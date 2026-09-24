/** 数值格式化工具。 */

/**
 * 千分位分割整数，用于调用次数、Tokens 等计数字段。
 * @example formatCount(80642909) // '80,642,909'
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * 把 0~1 的比率格式化成百分比。
 *
 * ★ 只做格式化，**不重算口径** —— 比率一律由服务端按
 *   `shared/src/metrics.ts` 的公式算好再返回。
 * @example formatPercent(0.9503) // '95.0%'
 */
export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

/**
 * 紧凑格式化，用于图表 Y 轴刻度：超过一万折算为「万」，超过一亿为「亿」。
 *
 * 用中文单位而不是 `M` / `B`：这个页面的用户读「1.2亿」比读「120M」快得多。
 * @example formatCompact(80642909) // '8064.3万'
 * @example formatCompact(522261815) // '5.2亿'
 */
export function formatCompact(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}