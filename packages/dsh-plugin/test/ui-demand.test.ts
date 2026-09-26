/** 大会话数量下，取数开销应随一页大小增长，而不是随着所有历史明细一起传输。 */
import { describe, expect, test } from 'bun:test'
import { createUiStatsProvider, makeStatsFetch, toUiPayload } from '../src/ui-bridge.js'
import type { UsageQuery, UsageResult } from '../src/stats.js'
import type { UiPayload } from '../src/client/protocol.js'

function result(query: UsageQuery = {}): UsageResult {
  const allRows = Array.from({ length: 103 }, (_, i) => ({ key: `session-${i}`, total: 103 - i,
    input: 0, output: 0, cacheRead: 103 - i, cacheWrite: 0, calls: 1, sessions: 1, cacheHitRate: 1 }))
  const dims: NonNullable<UsageQuery['by']> = query.by ?? ['provider-model']
  return {
    source: 'local-db', range: { since: 1, until: 2 }, rangeLabel: '今天',
    totals: { input: 0, output: 0, cacheRead: 10_000_000_000, cacheWrite: 0,
      reasoning: 0, calls: 103, total: 10_000_000_000 },
    metrics: { total: 10_000_000_000, cacheHitRate: 1, cacheLeverage: 0, avgTokensPerCall: 0 },
    groups: query.summaryOnly ? [] : dims.map(by => ({ by, rowCount: allRows.length,
      rows: allRows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.top ?? allRows.length)) })),
    ...(query.series ? { series: [{ bucket: '2026-09-26', total: 10_000_000_000, input: 0,
      output: 0, cacheRead: 10_000_000_000, calls: 103, cacheHitRate: 1 }] } : {}),
    sessions: 103, elapsedMs: 0, scannedAt: 0,
  }
}

describe('摘要与按需明细', () => {
  test('摘要不查分组/趋势；明细只查询当前维度的一页并保留总行数', async () => {
    const queries: UsageQuery[] = []
    const route = makeStatsFetch(createUiStatsProvider({ run: async q => { queries.push(q); return result(q) } }))
    const get = async (params: string) => (await (await route(new Request(`http://host/api/tokenReport.stats?${params}`))).json()) as UiPayload
    const summary = await get('view=summary&period=year')
    expect(queries[0]).toEqual({ period: 'year', summaryOnly: true })
    expect(summary.view).toBe('summary')
    expect(summary.groups).toEqual([])
    expect(summary.series).toBeUndefined()
    expect(summary.totals.total).toBe(10_000_000_000)

    const detail = await get('view=detail&period=year&by=session&page=3&pageSize=10')
    expect(queries[1]).toMatchObject({ by: ['session'], top: 10, offset: 20, series: 'day' })
    expect(detail.groups).toHaveLength(1)
    expect(detail.groups[0]?.rows).toHaveLength(10)
    expect(detail.groups[0]?.rows[0]?.key).toBe('session-20')
    expect(detail.pagination).toEqual({ by: 'session', page: 3, pageSize: 10, totalRows: 103 })
    expect(detail.series).toHaveLength(1)
    expect(detail.totals).toEqual(summary.totals)

    await get('view=detail&period=year&by=project&page=3&pageSize=10')
    await get('view=detail&period=year&by=session&page=4&pageSize=10')
    await get('view=detail&period=year&by=session&page=3&pageSize=20')
    expect(queries).toHaveLength(5)
    await get('view=detail&period=year&by=session&page=3&pageSize=10')
    expect(queries).toHaveLength(5)
    await get('view=detail&period=year&by=session&page=3&pageSize=10&refresh=1')
    expect(queries[5]?.refresh).toBe(true)
    await get('view=summary&period=year')
    expect(queries).toHaveLength(7)
  })

  test('旧客户端仍拿完整四维；页码超出数据末尾时返回最后一页', async () => {
    const provider = createUiStatsProvider({ run: async q => result(q) })
    const legacy = await provider.get('today') as UiPayload
    expect(legacy.view).toBeUndefined()
    expect(legacy.groups).toHaveLength(4)
    expect(legacy.groups[0]?.rows).toHaveLength(103)
    const last = await provider.get('today', false, undefined, { view: 'detail', by: 'session', page: 99 }) as UiPayload
    expect(last.pagination).toEqual({ by: 'session', page: 11, pageSize: 10, totalRows: 103 })
    expect(last.groups[0]?.rows.map(row => row.key)).toEqual(['session-100', 'session-101', 'session-102'])
  })

  test('非法分页拒绝查询；自定义日期按原有校验失败', async () => {
    let queries = 0
    const route = makeStatsFetch(createUiStatsProvider({ run: async q => { queries++; return result(q) } }))
    for (const params of ['view=nope', 'view=detail&by=nope', 'view=detail&page=0',
      'view=detail&page=1.5', 'view=detail&pageSize=1000', 'view=detail&page=9007199254740991',
      'view=detail&period=custom&since=2026-02-30&until=2026-03-01']) {
      const response = await route(new Request(`http://host/api/tokenReport.stats?${params}`))
      expect((await response.json() as { error?: string }).error).toBeString()
    }
    expect(queries).toBe(0)
  })
})

describe('有界缓存与无载荷探针', () => {
  test('采集已有新代次但 TTL 内快照未更新：每次探针都回无载荷 204', async () => {
    let gen = 1, clock = 1000, queries = 0
    const route = makeStatsFetch(createUiStatsProvider({ generation: () => gen, now: () => clock,
      run: async q => { queries++; return result(q) } }))
    const request = (params: string) => route(new Request(`http://host/api/tokenReport.stats?view=summary&${params}`))
    expect((await request('')).status).toBe(200)
    gen = 2
    for (let i = 0; i < 5; i++) {
      const response = await request('gen=1')
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
    }
    expect(queries).toBe(1)
    clock += 31_000
    const fresh = await request('gen=1')
    expect(fresh.status).toBe(200)
    expect((await fresh.json() as UiPayload).gen).toBe(2)
    expect(queries).toBe(2)
  })

  test('字节预算按最近使用淘汰；超预算单条响应不长期缓存', async () => {
    const sample = result({ summaryOnly: true })
    const weight = new TextEncoder().encode(JSON.stringify(toUiPayload(sample, 'today'))).byteLength
    let queries = 0
    const provider = createUiStatsProvider({ maxCacheBytes: weight * 2 + 32,
      run: async () => { queries++; return sample } })
    await provider.get('today')
    await provider.get('week')
    await provider.get('today')
    await provider.get('year')
    await provider.get('today')
    expect(queries).toBe(3)
    await provider.get('week')
    expect(queries).toBe(4)

    const uncached = createUiStatsProvider({ maxCacheBytes: 1, run: async () => { queries++; return sample } })
    expect((await uncached.get('today') as UiPayload).totals.total).toBe(10_000_000_000)
    await uncached.get('today')
    expect(queries).toBe(6)
  })
})
