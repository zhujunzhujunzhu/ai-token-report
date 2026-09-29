/**
 * 上报实录（环形缓冲）的边界。
 *
 * 它是设置页「上报调试」的数据来源，而它自己跑在**投递链路上**
 * （`Reporter.#post` 的 `finally`）—— 所以这里要钉住三件事：
 *
 * 1. **绝不抛错**：记不下来也不能把一次成功的上报判成失败。
 * 2. **有硬上限**：条数、单条载荷、总量三层都要封（否则通宵就能吃几百 MB）。
 * 3. **新的在前 + 截断如实说**：用户看的是「刚才那次」，
 *    而且不能让他以为看到的就是全部。
 */
import { expect, test } from 'bun:test'
import { ReportLog, REPORT_LOG_LIMITS, type ReportAttempt } from '../src/report-log.js'

function attempt(over: Partial<ReportAttempt> = {}): Omit<ReportAttempt, 'payload' | 'truncated'> & { payload: string } {
  return {
    at: 1_700_000_000_000,
    ok: true,
    source: 'queue',
    records: 1,
    bytes: 2,
    accepted: 1,
    duplicates: 0,
    rejected: 0,
    httpStatus: 200,
    error: null,
    payload: '{}',
    ...over,
  }
}

test('新的在前，并保留全部回执字段', () => {
  const log = new ReportLog()
  log.record(attempt({ at: 1, payload: '{"i":1}' }))
  log.record(attempt({ at: 2, payload: '{"i":2}' }))
  const list = log.list()
  expect(list.map((entry) => entry.at)).toEqual([2, 1])
  expect(list[0]).toMatchObject({ ok: true, httpStatus: 200, accepted: 1, records: 1, truncated: false })
})

test('★ 超过条数上限时淘汰最旧的，且至少留一条', () => {
  const log = new ReportLog({ maxEntries: 3 })
  for (let i = 1; i <= 5; i += 1) log.record(attempt({ at: i }))
  expect(log.list().map((entry) => entry.at)).toEqual([5, 4, 3])
  log.clear()
  expect(log.list()).toEqual([])
})

test('★ 总量上限：条数没满也要按字节淘汰（20 × 96 KiB 近 2 MB 常驻）', () => {
  const log = new ReportLog({ maxEntries: 20, maxPayloadBytes: 1024, maxTotalBytes: 2 * 1024 })
  for (let i = 1; i <= 10; i += 1) log.record(attempt({ at: i, payload: 'x'.repeat(1024) }))
  const list = log.list()
  // 总量封在 2 KiB ⇒ 最多留 2 条（外加最后那条）
  expect(list.length).toBeLessThanOrEqual(3)
  expect(list[0]?.at).toBe(10)
})

test('★ 超大请求体被截断，并如实标出来（不能让人以为看到的就是全部）', () => {
  const log = new ReportLog({ maxPayloadBytes: 32 })
  log.record(attempt({ payload: 'a'.repeat(500), bytes: 500 }))
  const entry = log.list()[0]!
  expect(entry.truncated).toBe(true)
  expect(Buffer.byteLength(entry.payload)).toBeLessThan(200)
  expect(entry.payload).toContain('已截断')
  // 未截断前的字节数必须保留 —— 页面显示的是「实际发了多少」
  expect(entry.bytes).toBe(500)
})

test('★ 截断必须收在 UTF-8 字符边界上：中文模型名不许变成乱码', () => {
  const log = new ReportLog({ maxPayloadBytes: 24 })
  log.record(attempt({ payload: '{"model":"深度求索-v4.1-闪速"}' }))
  const text = log.list()[0]!.payload
  expect(text).not.toContain('\uFFFD')
})

test('maxPayloadBytes = 0 时不炸：载荷清空并标记已截断', () => {
  const log = new ReportLog({ maxPayloadBytes: 0 })
  log.record(attempt({ payload: 'x' }))
  expect(log.list()[0]).toMatchObject({ payload: '', truncated: true })
})

test('list() 返回浅拷贝：调用方改不动内部状态', () => {
  const log = new ReportLog()
  log.record(attempt())
  const list = log.list()
  list.length = 0
  expect(log.list()).toHaveLength(1)
})

test('记不下来也绝不抛错（它跑在投递链路上）', () => {
  const log = new ReportLog({ maxEntries: 1 })
  // 传一个连 Buffer.byteLength 都会炸的载荷（number 而非 string）
  expect(() => log.record({ ...attempt(), payload: 123 as unknown as string })).not.toThrow()
  expect(() => log.record(attempt())).not.toThrow()
})

test('默认上限是刻意的小数字（改大之前先想清楚常驻内存）', () => {
  expect(REPORT_LOG_LIMITS.maxEntries).toBeLessThanOrEqual(50)
  expect(REPORT_LOG_LIMITS.maxTotalBytes).toBeLessThanOrEqual(1024 * 1024)
})