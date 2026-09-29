/**
 * 数据新鲜度措辞：诊断页把「最新事件 / 最近一次上报」换算成一句相对时间。
 *
 * 钉住的是两个**只能靠约定记住**的点：
 * 1. 基准由调用方给（诊断页传本次取数时刻），不是 `Date.now()` ——
 *    否则浏览器时钟比服务端慢时会显示成未来数据；
 * 2. 缺值（`null` / `0`）返回空串，**不能**退化成「刚刚」：
 *    那会让「从未上报」看起来像「刚刚上报过」。
 */
import { describe, expect, test } from 'bun:test'
import { formatTimeGap } from '../src/utils/format.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('数据新鲜度', () => {
  const now = 1_700_000_000_000

  test('一分钟以内算刚刚', () => {
    expect(formatTimeGap(now, now)).toBe('刚刚')
    expect(formatTimeGap(now - 59 * 1000, now)).toBe('刚刚')
  })
  test('分钟、小时、天各自取整', () => {
    expect(formatTimeGap(now - 3 * MINUTE, now)).toBe('3 分钟前')
    expect(formatTimeGap(now - 119 * MINUTE, now)).toBe('1 小时前')
    expect(formatTimeGap(now - 3 * DAY, now)).toBe('3 天前')
  })
  test('缺值不伪装成刚上报', () => {
    expect(formatTimeGap(null, now)).toBe('')
    expect(formatTimeGap(now, null)).toBe('')
    expect(formatTimeGap(0, now)).toBe('')
  })
})