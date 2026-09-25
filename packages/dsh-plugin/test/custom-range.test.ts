/** 自定义日期必须在缓存与 SQL 过滤中保留完整边界，不能静默退回今天。 */
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { validDateRange } from '../src/client/protocol.js'
import { createUiStatsProvider, makeStatsFetch } from '../src/ui-bridge.js'
import { queryUsage, type UsageQuery } from '../src/stats.js'
import { resolveConfig } from '../src/config.js'

test('日历校验拒绝不存在的日期、缺项与倒序，接受闰日', () => {
  expect(validDateRange({ since: '2026-02-30', until: '2026-03-01' })).toBe(false)
  expect(validDateRange({ since: '', until: '2026-03-01' })).toBe(false)
  expect(validDateRange({ since: '2026-03-02', until: '2026-03-01' })).toBe(false)
  expect(validDateRange({ since: '2024-02-29', until: '2024-02-29' })).toBe(true)
})

test('SQL 自定义范围包含首日零点与末日末刻，排除两侧事件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atr-custom-range-'))
  try {
    const sessionsRoot = join(home, 'sessions')
    const dir = join(sessionsRoot, 'project', 'session-test')
    mkdirSync(dir, { recursive: true })
    const start = new Date(2026, 8, 1).getTime()
    const end = new Date(2026, 8, 3).getTime() - 1
    const records = [start - 1, start, end, end + 1].map((time, seq) => ({
      type: 'assistant/message', seq: seq + 1, time,
      data: { message: { source: { provider: 'test', model: 'test' } },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 4, totalTokens: 46 } },
    }))
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n')))
    const ctx = { config: resolveConfig({}), sessionsRoot, dbPath: join(home, 'usage.sqlite') }
    const queries: UsageQuery[] = []
    const provider = createUiStatsProvider({ run: async (query) => { queries.push(query); return queryUsage(ctx, query) } })
    const route = makeStatsFetch(provider)
    const request = (since: string, until: string) => new Request(`http://localhost/api/tokenReport.stats?period=custom&since=${since}&until=${until}`)
    const range = { since: '2026-09-01', until: '2026-09-02' }
    const sql = await queryUsage(ctx, range)
    expect(sql.source).toBe('local-db')
    expect(sql.totals.calls).toBe(2)
    expect(sql.range).toEqual({ since: start, until: end })
    const scan = await queryUsage({ ...ctx, config: { ...ctx.config, localDb: false } }, range)
    expect(sql.totals).toEqual(scan.totals)
    const first = await (await route(request(range.since, range.until))).json()
    expect(first).toMatchObject({ period: 'custom', totals: { calls: 2 } })
    await route(request(range.since, range.until))
    expect(queries).toHaveLength(1)
    const single = await (await route(request('2026-09-02', '2026-09-02'))).json()
    expect(single).toMatchObject({ totals: { calls: 1 } })
    expect(queries).toHaveLength(2)
    expect(queries[1]?.series).toBe('hour')
    const invalid = await (await route(request('2026-09-03', '2026-09-01'))).json()
    expect(invalid).toHaveProperty('error')
    expect(queries).toHaveLength(2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
