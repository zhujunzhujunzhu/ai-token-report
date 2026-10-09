/** 宽窗口刷新节流契约，避免全年页面重新回到 5 秒聚合一次。 */
import { expect, test } from 'bun:test'
import { refreshIntervalMs, refreshIntervalLabel } from '../src/utils/refresh.js'

test('实时窗口与宽窗口分级，自定义按实际跨度判定', () => {
  expect(refreshIntervalMs('today')).toBe(5_000)
  expect(refreshIntervalMs('last7d')).toBe(30_000)
  expect(refreshIntervalMs('last30d')).toBe(60_000)
  for (const period of ['year', 'lastmonth', 'last90d'])
    expect(refreshIntervalMs(period)).toBe(300_000)
  expect(refreshIntervalMs('custom', 86_400_000)).toBe(5_000)
  expect(refreshIntervalMs('custom', 31 * 86_400_000)).toBe(300_000)
  expect(refreshIntervalMs('custom')).toBe(300_000)
  expect(refreshIntervalLabel(300_000)).toBe('每 5 分钟自动刷新')
})
