/**
 * 核心逻辑测试：解码、计费恒等式、聚合、时间分桶。
 *
 * 直接 import TypeScript 源码（bun 原生支持），无需先构建。
 *
 *   bun test
 */

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'

import {
  addCounts,
  aggregate,
  crossTabRanked,
  decodeFramedZstdSync,
  derive,
  emptyCounts,
  findFrameOffsets,
  isCompleteZstdFrame,
  mergeCounts,
  parseJsonl,
  parseTimePoint,
  resolvePeriod,
  resolveRange,
  timeSeries,
  toDayKey,
  toHourKey,
  totalOf,
  type UsageRecord,
} from '@ai-token-report/core'

/** 数组取值并断言存在——避免 noUncheckedIndexedAccess 下的 `rows[0]!` 噪音。 */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`期望索引 ${i} 存在，但数组长度为 ${arr.length}`)
  return v
}

/** Map/可选/null 取值并断言存在。 */
function must<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) {
    throw new Error(`期望 ${what} 存在，但为 ${v === null ? 'null' : 'undefined'}`)
  }
  return v
}

/** 构造分帧 zstd buffer（模拟 DSH 的 append 写入方式）。 */
function frame(lines: string[]): Buffer {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
}
function concatFrames(...frames: Buffer[]): Buffer {
  return Buffer.concat(frames)
}

/** 测试用的 UsageRecord 构造器。 */
interface RecordOverrides {
  eventId?: string
  sessionId?: string
  seq?: number
  time?: number
  provider?: string
  model?: string
  cwd?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

function makeRecord(overrides: RecordOverrides = {}): UsageRecord {
  const counts = emptyCounts()
  addCounts(counts, {
    inputTokens: overrides.input ?? 0,
    outputTokens: overrides.output ?? 0,
    cacheReadTokens: overrides.cacheRead ?? 0,
    cacheWriteTokens: overrides.cacheWrite ?? 0,
    reasoningTokens: overrides.reasoning ?? 0,
  })
  return {
    eventId: overrides.eventId ?? 'sess:1',
    sessionId: overrides.sessionId ?? 'sess',
    seq: overrides.seq ?? 1,
    time: overrides.time ?? Date.parse('2026-09-18T10:00:00Z'),
    provider: overrides.provider ?? 'dashscope',
    model: overrides.model ?? 'm1',
    cwd: overrides.cwd ?? 'D:\\Coding\\demo',
    turn: 1,
    step: 1,
    usage: counts,
  }
}

// ---------------------------------------------------------------- 解码

test('分帧 zstd：多帧全部解出', () => {
  const buf = concatFrames(
    frame(['{"type":"session"}']),
    frame(['{"type":"step/start"}']),
    frame(['{"type":"assistant/message"}']),
  )
  const { text, framesOk, framesFailed } = decodeFramedZstdSync(buf)
  assert.equal(framesOk, 3)
  assert.equal(framesFailed, 0)
  const lines = text.split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(must(lines[2])).type, 'assistant/message')
})

test('分帧 zstd：尾部截断帧被判定为失败帧（跨 Node/Bun 一致）', () => {
  const good = frame(['{"type":"session"}'])
  // 截断成只剩 magic + 部分帧头
  const truncated = frame(['{"type":"step/end"}']).subarray(0, 8)
  const { framesOk, framesFailed } = decodeFramedZstdSync(
    Buffer.concat([good, truncated]),
  )
  assert.equal(framesOk, 1, '完整帧应解出')
  assert.equal(
    framesFailed,
    1,
    '截断帧必须计为失败——Bun 会静默返回空串，不能只靠 try/catch',
  )
})

test('分帧 zstd：只有 magic 的片段判定为不完整', () => {
  const magicOnly = frame(['{"type":"x"}']).subarray(0, 4)
  assert.equal(isCompleteZstdFrame(magicOnly), false)
  const { framesOk, framesFailed } = decodeFramedZstdSync(magicOnly)
  assert.equal(framesOk, 0)
  assert.equal(framesFailed, 1)
})

test('isCompleteZstdFrame：完整帧判为完整', () => {
  assert.equal(isCompleteZstdFrame(frame(['{"type":"session"}'])), true)
  assert.equal(isCompleteZstdFrame(frame(['hello world'])), true)
})

test('findFrameOffsets：定位每帧起始偏移', () => {
  const f1 = frame(['{"a":1}'])
  const f2 = frame(['{"b":2}'])
  const offsets = findFrameOffsets(Buffer.concat([f1, f2]))
  assert.equal(offsets.length, 2)
  assert.equal(at(offsets,0), 0)
  assert.equal(at(offsets,1), f1.length)
})

test('parseJsonl：跳过空行与坏行', () => {
  const out = [...parseJsonl('{"a":1}\n\n  \nnot-json\n{"b":2}\n{"trunc"')]
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }])
})

// ------------------------------------------------------- 计费口径

test('计费恒等式：total = input + output + cacheRead + cacheWrite', () => {
  const c = emptyCounts()
  addCounts(c, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 3000,
    cacheWriteTokens: 5,
  })
  assert.equal(c.total, 3125)
  assert.equal(c.calls, 1)
})

test('cacheRead 不计入 input（口径回归保护）', () => {
  const c = emptyCounts()
  addCounts(c, { inputTokens: 100, cacheReadTokens: 900 })
  assert.equal(c.input, 100, 'input 必须是未命中缓存的部分')
  assert.equal(c.cacheRead, 900)
  assert.equal(derive(c).cacheHitRate, 0.9)
  assert.equal(derive(c).cacheLeverage, 10)
})

test('缺失的可选字段按 0 处理', () => {
  const c = emptyCounts()
  addCounts(c, { inputTokens: 10 })
  assert.equal(c.output, 0)
  assert.equal(c.cacheRead, 0)
  assert.equal(c.reasoning, 0)
  assert.equal(c.total, 10)
})

test('reasoning 不进入计费总量（可能与 output 重叠）', () => {
  const c = emptyCounts()
  addCounts(c, { inputTokens: 10, outputTokens: 5, reasoningTokens: 999 })
  assert.equal(c.reasoning, 999)
  assert.equal(c.total, 15, 'reasoning 单列，不叠加到 total')
})

test('mergeCounts：累加所有字段', () => {
  const a = emptyCounts(); addCounts(a, { inputTokens: 1, outputTokens: 2 })
  const b = emptyCounts(); addCounts(b, { inputTokens: 10, cacheReadTokens: 100 })
  mergeCounts(a, b)
  assert.equal(a.input, 11)
  assert.equal(a.output, 2)
  assert.equal(a.cacheRead, 100)
  assert.equal(a.total, 113)
  assert.equal(a.calls, 2)
})

test('derive：零数据不产生 NaN', () => {
  const m = derive(emptyCounts())
  assert.equal(m.cacheHitRate, 0)
  assert.equal(m.avgTokensPerCall, 0)
  assert.equal(m.cacheLeverage, 0)
})

// ---------------------------------------------------------------- 聚合

test('aggregate：按 provider 分组并按用量降序', () => {
  const rows = aggregate(
    [
      makeRecord({ provider: 'small', input: 10 }),
      makeRecord({ provider: 'big', input: 1000 }),
      makeRecord({ provider: 'big', input: 500 }),
    ],
    'provider',
  )
  assert.equal(rows.length, 2)
  assert.equal(at(rows,0).key, 'big')
  assert.equal(at(rows,0).counts.total, 1500)
  assert.equal(at(rows,1).key, 'small')
})

test('aggregate：时间维度按时间升序而非用量', () => {
  const rows = aggregate(
    [
      makeRecord({ time: Date.parse('2026-09-20T10:00:00'), input: 999999 }),
      makeRecord({ time: Date.parse('2026-09-18T10:00:00'), input: 1 }),
    ],
    'day',
  )
  assert.equal(at(rows,0).key, '2026-09-18')
  assert.equal(at(rows,1).key, '2026-09-20')
})

test('aggregate：会话数按去重统计', () => {
  const rows = aggregate(
    [
      makeRecord({ provider: 'p', sessionId: 's1' }),
      makeRecord({ provider: 'p', sessionId: 's1' }),
      makeRecord({ provider: 'p', sessionId: 's2' }),
    ],
    'provider',
  )
  assert.equal(at(rows,0).counts.calls, 3)
  assert.equal(at(rows,0).sessions, 2)
})

test('crossTabRanked：次要维度按用量降序（--top 截断不丢大头）', () => {
  const recs = [
    makeRecord({ provider: 'a', model: 'zebra', input: 999999 }),
    makeRecord({ provider: 'a', model: 'aardvark', input: 1 }),
    makeRecord({ provider: 'b', model: 'aardvark', input: 500000 }),
  ]
  const { primaryKeys, secondaryKeys, cells } = crossTabRanked(recs, 'provider', 'model')
  assert.equal(at(secondaryKeys,0), 'zebra', '用量最大的模型必须排第一')
  assert.equal(at(primaryKeys,0), 'a')
  assert.equal(must(cells.get('a\u0000zebra')).total, 999999)
})

test('totalOf：总和等于各分组之和', () => {
  const recs = [makeRecord({ input: 10 }), makeRecord({ input: 20, cacheRead: 30 })]
  const total = totalOf(recs)
  const sum = aggregate(recs, 'provider').reduce((a, r) => a + r.counts.total, 0)
  assert.equal(total.total, 60)
  assert.equal(total.total, sum)
})

// ------------------------------------------------------------ 时间序列

test('timeSeries：按天补零保证连续', () => {
  const points = timeSeries(
    [
      makeRecord({ time: Date.parse('2026-09-18T10:00:00'), input: 100 }),
      makeRecord({ time: Date.parse('2026-09-20T10:00:00'), input: 300 }),
    ],
    'day',
    true,
  )
  assert.equal(points.length, 3, '中间缺失的 09-19 应补零')
  assert.equal(at(points,0).counts.total, 100)
  assert.equal(at(points,1).counts.total, 0)
  assert.equal(at(points,2).counts.total, 300)
})

test('timeSeries：不补零时只保留有数据的桶', () => {
  const points = timeSeries(
    [
      makeRecord({ time: Date.parse('2026-09-18T10:00:00') }),
      makeRecord({ time: Date.parse('2026-09-20T10:00:00') }),
    ],
    'day',
    false,
  )
  assert.equal(points.length, 2)
})

test('timeSeries：按 provider 细分', () => {
  const points = timeSeries(
    [
      makeRecord({ provider: 'x', input: 100 }),
      makeRecord({ provider: 'y', input: 200 }),
    ],
    'day',
    false,
  )
  assert.equal(must(at(points,0).byProvider.get('x')).total, 100)
  assert.equal(must(at(points,0).byProvider.get('y')).total, 200)
})

test('toDayKey / toHourKey：本地时区分桶', () => {
  const t = new Date(2026, 8, 18, 14, 30).getTime()
  assert.equal(toDayKey(t), '2026-09-18')
  assert.equal(toHourKey(t), '2026-09-18T14')
})

// ------------------------------------------------------------ 时间解析

test('parseTimePoint：纯日期', () => {
  const t = parseTimePoint('2026-09-18')
  const d = new Date(t)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 8)
  assert.equal(d.getDate(), 18)
  assert.equal(d.getHours(), 0, '起始为当天 00:00')
})

test('parseTimePoint：纯日期 endOfDay', () => {
  const d = new Date(parseTimePoint('2026-09-18', true))
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
})

test('parseTimePoint：带时间', () => {
  const d = new Date(parseTimePoint('2026-09-18T14:30'))
  assert.equal(d.getHours(), 14)
  assert.equal(d.getMinutes(), 30)
})

test('parseTimePoint：相对时间 7d', () => {
  const t = parseTimePoint('7d')
  const diff = Date.now() - t
  assert.ok(Math.abs(diff - 7 * 86400000) < 5000)
})

test('parseTimePoint：非法输入抛错', () => {
  assert.throws(() => parseTimePoint('not-a-date'), /无法解析/)
})

test('resolveRange：--last 与 --since 组合', () => {
  const r = resolveRange({ last: '30d' })
  assert.ok(r.sinceMs !== undefined)
  assert.ok(r.label.includes('30d'))
})

test('resolveRange：起止颠倒抛错', () => {
  assert.throws(
    () => resolveRange({ since: '2026-09-20', until: '2026-09-18' }),
    /起始时间晚于结束时间/,
  )
})

test('resolveRange：today 覆盖当天 00:00 起', () => {
  const r = resolveRange({ since: 'today' })
  const d = new Date(must(r.sinceMs, 'sinceMs'))
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 0)
})

// -------------------------------------------------------- 具名周期

/** 固定「现在」= 2026-09-21（周一）14:30，让边界断言稳定。 */
const NOW = new Date(2026, 8, 21, 14, 30, 0)
const day = (ms: number | undefined): string =>
  ms === undefined ? 'undefined' : new Date(ms).toLocaleDateString('sv-SE')
const hhmm = (ms: number | undefined): string =>
  ms === undefined ? 'undefined' : new Date(ms).toTimeString().slice(0, 5)

test('resolvePeriod：today = 今天 00:00 起，无结束边界', () => {
  const p = must(resolvePeriod('today', NOW))
  assert.equal(day(p.sinceMs), '2026-09-21')
  assert.equal(hhmm(p.sinceMs), '00:00')
  assert.equal(p.untilMs, undefined)
})

test('resolvePeriod：yesterday = 完整的一天', () => {
  const p = must(resolvePeriod('yesterday', NOW))
  assert.equal(day(p.sinceMs), '2026-09-20')
  assert.equal(hhmm(p.sinceMs), '00:00')
  assert.equal(day(p.untilMs), '2026-09-20')
  assert.equal(hhmm(p.untilMs), '23:59')
})

test('resolvePeriod：week 从周一开始（关键边界）', () => {
  // 2026-09-21 是周一，所以本周起点就是当天
  assert.equal(day(must(resolvePeriod('week', NOW)).sinceMs), '2026-09-21')
  // 周二到周日都应回退到同一个周一
  for (const d of [22, 23, 24, 25, 26]) {
    const p = must(resolvePeriod('week', new Date(2026, 8, d, 12)))
    assert.equal(day(p.sinceMs), '2026-09-21', `9/${d} 应回退到 9/21 周一`)
  }
})

test('resolvePeriod：周日属于「上一个周一」开始的那一周', () => {
  // 2026-09-27 是周日 —— 不能算作下周起点
  const p = must(resolvePeriod('week', new Date(2026, 8, 27, 12)))
  assert.equal(day(p.sinceMs), '2026-09-21')
  assert.equal(new Date(p.sinceMs).getDay(), 1, '起点必须是周一')
})

test('resolvePeriod：lastweek = 上周一 ~ 上周日', () => {
  const p = must(resolvePeriod('lastweek', NOW))
  assert.equal(day(p.sinceMs), '2026-09-14')
  assert.equal(day(p.untilMs), '2026-09-20')
  assert.equal(new Date(p.sinceMs).getDay(), 1)
  assert.equal(new Date(must(p.untilMs)).getDay(), 0, '结束是周日')
})

test('resolvePeriod：month = 本月 1 号起', () => {
  const p = must(resolvePeriod('month', NOW))
  assert.equal(day(p.sinceMs), '2026-09-01')
  assert.equal(p.untilMs, undefined)
})

test('resolvePeriod：lastmonth 覆盖完整上月', () => {
  const p = must(resolvePeriod('lastmonth', NOW))
  assert.equal(day(p.sinceMs), '2026-08-01')
  assert.equal(day(p.untilMs), '2026-08-31')
})

test('resolvePeriod：lastmonth 跨年正确', () => {
  const p = must(resolvePeriod('lastmonth', new Date(2026, 0, 20, 12)))
  assert.equal(day(p.sinceMs), '2025-12-01')
  assert.equal(day(p.untilMs), '2025-12-31')
})

test('resolvePeriod：lastmonth 遇 2 月不溢出', () => {
  const p = must(resolvePeriod('lastmonth', new Date(2026, 2, 15, 12)))
  assert.equal(day(p.sinceMs), '2026-02-01')
  assert.equal(day(p.untilMs), '2026-02-28')
})

test('resolvePeriod：last7d = 含今天的 7 个自然日', () => {
  const p = must(resolvePeriod('last7d', NOW))
  assert.equal(day(p.sinceMs), '2026-09-15', '今天 9/21 往前 6 天')
  assert.equal(p.untilMs, undefined)
})

test('resolvePeriod：last30d / last90d 起点正确', () => {
  assert.equal(day(must(resolvePeriod('last30d', NOW)).sinceMs), '2026-08-23')
  assert.equal(day(must(resolvePeriod('last90d', NOW)).sinceMs), '2026-06-24')
})

test('resolvePeriod：中文别名可用', () => {
  assert.equal(day(must(resolvePeriod('今天', NOW)).sinceMs), '2026-09-21')
  assert.equal(day(must(resolvePeriod('昨天', NOW)).sinceMs), '2026-09-20')
  assert.equal(day(must(resolvePeriod('本周', NOW)).sinceMs), '2026-09-21')
  assert.equal(day(must(resolvePeriod('本月', NOW)).sinceMs), '2026-09-01')
  assert.equal(day(must(resolvePeriod('上月', NOW)).sinceMs), '2026-08-01')
})

test('resolvePeriod：大小写与分隔符不敏感', () => {
  assert.ok(resolvePeriod('TODAY', NOW))
  assert.ok(resolvePeriod('Last-7D', NOW))
  assert.ok(resolvePeriod('this_week', NOW))
})

test('resolvePeriod：未知周期返回 null', () => {
  assert.equal(resolvePeriod('nonsense', NOW), null)
})

test('resolveRange：--period 与 --last 语义不同', () => {
  // --period last7d 是自然日（含今天，从 00:00 起）
  const byPeriod = resolveRange({ period: 'last7d' })
  const pd = new Date(must(byPeriod.sinceMs))
  assert.equal(pd.getHours(), 0, 'period 从自然日 00:00 起')
  assert.equal(pd.getMinutes(), 0)

  // --last 7d 是滚动 168 小时 —— 起点保留当前时刻，而非对齐到 00:00
  const byLast = resolveRange({ last: '7d' })
  const ld = new Date(must(byLast.sinceMs))
  const expect = new Date(Date.now() - 7 * 86400000)
  assert.ok(
    Math.abs(ld.getTime() - expect.getTime()) < 5000,
    '滚动窗口应精确回推 168 小时',
  )
  assert.ok(byLast.label.includes('滚动'))

  // 两者相差不足一天（都覆盖 7 天，但起点对齐方式不同）
  const diffDays =
    Math.abs(must(byPeriod.sinceMs) - must(byLast.sinceMs)) / 86400000
  assert.ok(diffDays < 1, `两种口径起点的差异应小于 1 天，实测 ${diffDays.toFixed(2)} 天`)
})

test('resolveRange：--period 未知时抛错', () => {
  assert.throws(() => resolveRange({ period: 'nonsense' }), /未知周期/)
})

test('resolveRange：--until today 覆盖到当天末刻（开区间周期修复）', () => {
  const r = resolveRange({ since: '2026-09-01', until: 'today' })
  assert.equal(hhmm(r.untilMs), '23:59', 'today 作为 until 必须到当天末刻')
})

test('parseTimePoint：周期作为 since/until 行为正确', () => {
  assert.equal(hhmm(parseTimePoint('yesterday', false)), '00:00')
  assert.equal(hhmm(parseTimePoint('yesterday', true)), '23:59')
  // today 没有结束边界，作为 until 应取今天末刻而非 00:00
  assert.equal(hhmm(parseTimePoint('today', true)), '23:59')
})