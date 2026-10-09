/** 看板自动刷新周期：宽窗口查询成本更高，手动刷新与筛选切换仍立即取数。 */
export function refreshIntervalMs(period: string, span?: number): number {
  if (period === 'today') return 5_000
  if (period === 'last7d' || period === 'week') return 30_000
  if (period === 'last30d' || period === 'month') return 60_000
  if (period === 'custom' && span !== undefined) {
    if (span <= 86_400_000) return 5_000
    if (span <= 7 * 86_400_000) return 30_000
    if (span <= 30 * 86_400_000) return 60_000
  }
  return 300_000
}

export function refreshIntervalLabel(interval: number): string {
  return interval < 60_000 ? `每 ${interval / 1000} 秒自动刷新` : `每 ${interval / 60_000} 分钟自动刷新`
}
