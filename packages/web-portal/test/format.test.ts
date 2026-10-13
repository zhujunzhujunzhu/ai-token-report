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
import { bucketGranularityOf, formatBucket, formatBucketFull, formatTimeGap } from '../src/utils/format.js'

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

/**
 * 分桶键的显示写法。
 *
 * 服务端给的是 `2026-09-21T14`（`aggregate.ts` 的 `toHourKey()`）—— 轴刻度上放不下
 * 完整日期，提示框标题上又必须说清是哪一天哪一小时，所以是**两种**写法。
 * ⚠️ 这里同时钉住「不是分桶的文本一位都不能动」：展示层会碰到模型名 / 厂商名，
 *   把 `qwen-max` 当日期切一刀，图上会出现一年前的时间。
 */
describe('时间分桶的显示写法', () => {
  test('小时桶：轴上短写、提示框标题写全', () => {
    expect(formatBucket('2026-10-13T11', 'hour')).toBe('11:00')
    expect(formatBucketFull('2026-10-13T11')).toBe('2026-10-13 11:00')
    expect(formatBucketFull('2026-10-13T00')).toBe('2026-10-13 00:00')
  })
  test('日桶：完整写法就是它自己（日桶本来就完整）', () => {
    expect(formatBucket('2026-10-13', 'day')).toBe('10-13')
    expect(formatBucketFull('2026-10-13')).toBe('2026-10-13')
  })
  test('★ 非分桶文本一位都不能动', () => {
    for (const text of ['qwen-max', 'deepseek-v3.2', '2026-10-13T11:30', '2026-10', '未署名', ''])
      expect(formatBucketFull(text)).toBe(text)
  })
  test('粒度只从值上认；两代键混在一列时以小时为准', () => {
    expect(bucketGranularityOf(['2026-10-13T09', '2026-10-13T10'])).toBe('hour')
    expect(bucketGranularityOf(['2026-10-12', '2026-10-13'])).toBe('day')
    expect(bucketGranularityOf(['2026-10-13', '2026-10-13T10'])).toBe('hour')
    // 非字符串（历史快照里可能有 null 空洞）不参与判定
    expect(bucketGranularityOf([null, 7, 'qwen-max'])).toBeNull()
    expect(bucketGranularityOf([])).toBeNull()
  })
})