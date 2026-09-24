/**
 * 本地直查接口测试（`/api/local/stats/*`）。
 *
 * ## 这些断言在守什么
 *
 * 1. **口径不漂移** —— 服务端返回的 `cacheHitRate` / `totalTokens` 必须与
 *    `core` 的公式逐位相等。一旦服务端开始自己重写公式，这里立刻失败。
 * 2. **四个 token 分列** —— 铁律 3：绝不允许在采集/传输端合并，
 *    否则后续任何拆分都无法还原。
 * 3. **数据新鲜** —— 日志追加后必须能查到新数据。数据源从「直扫日志」
 *    换成「本地增量库」后，这条依然要成立（靠每请求前置的增量 ingest）。
 * 4. **并发安全** —— 页面首屏会同时发 3~4 个请求。
 *    ⚠️ 这里锁死一个真实踩过的坑：旧的 `StatsCache` 用
 *    `await this.#inflight` 合并并发扫描，在扫描完成的微任务空隙里
 *    会变成 `await null`，下游访问属性直接抛错、连接被重置
 *    （浏览器侧表现为 `ECONNRESET`，服务端毫无日志）。
 *    新实现改为每个请求独立开关会话，这个坑从结构上消失了 ——
 *    但回归测试保留，防止有人「优化」回共享状态。
 * 5. **参数校验** —— 非法 period/by/bucket 必须 400，不许静默兜底成「全部时间」。
 * 6. **降级不崩** —— 库不可用时必须回退直扫并正常返回数据，而不是 500。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { cacheHitRate } from '@ai-token-report/shared'
import type { StatsSession } from '@ai-token-report/core/db'

import { CoreStatsProvider, LocalStatsRouter, type StatsProvider } from '../src/local-api.js'

let home: string
let sessionsRoot: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-local-api-'))
  sessionsRoot = join(home, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  dbPath = join(home, 'token-report', 'usage.sqlite')
})

afterEach(() => {
  // Windows 下若还有打开的 SQLite 连接，rmSync 会抛 EBUSY。
  // 测试自身已在 finally 里 close，这里兜住断言失败路径。
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/**
 * 写一个会话日志文件。
 *
 * 结构对齐真实 DSH 日志：`session` 首行带 cwd，之后是 `assistant/message`
 * 事件（只有这种事件带 provider 真实上报的 `data.usage`）。
 */
function writeSession(
  project: string,
  sessionId: string,
  events: {
    seq: number
    ts: number
    provider: string
    model: string
    input: number
    output: number
    cacheRead: number
    cacheWrite?: number
    cwd?: string
  }[],
): string {
  const dir = join(sessionsRoot, project, sessionId)
  mkdirSync(dir, { recursive: true })

  const lines: string[] = []
  const cwd = events[0]?.cwd ?? `D:\\Coding\\${project}`
  lines.push(JSON.stringify({ type: 'session', time: events[0]?.ts ?? 0, data: { cwd } }))

  for (const e of events) {
    const cacheWrite = e.cacheWrite ?? 0
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: e.seq,
        time: e.ts,
        data: {
          message: { source: { provider: e.provider, model: e.model } },
          usage: {
            inputTokens: e.input,
            outputTokens: e.output,
            cacheReadTokens: e.cacheRead,
            cacheWriteTokens: cacheWrite,
            // 恒等式：total 必须等于四项之和，否则会被诊断计为 mismatch
            totalTokens: e.input + e.output + e.cacheRead + cacheWrite,
          },
        },
      }),
    )
  }

  const path = join(dir, 'session.v3.jsonl.zstd')
  // 分帧追加：每行一个独立 zstd frame
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(line + '\n', 'utf8')))
  writeFileSync(path, Buffer.concat(frames))
  return path
}

/** 今天某个时刻的时间戳（保证落在 `period=today` 窗口内）。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

function router(): LocalStatsRouter {
  return new LocalStatsRouter(new CoreStatsProvider(sessionsRoot, dbPath))
}

/** 直扫日志的 router（`--no-db` 等价的对照路径）。 */
function scanRouter(): LocalStatsRouter {
  const provider: StatsProvider = {
    open: async (opts) => {
      const { openStats } = await import('@ai-token-report/core/db')
      return openStats({
        sessionsRoot,
        dbPath,
        ...(opts.period ? { period: opts.period } : {}),
        providers: opts.providers,
        models: opts.models,
        forceScan: true,
      })
    },
  }
  return new LocalStatsRouter(provider)
}

function params(init: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(init)
}

describe('本地统计直查', () => {
  test('四项 token 分列返回，且与恒等式一致', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm-1', input: 100, output: 20, cacheRead: 900 },
      { seq: 2, ts: todayAt(11), provider: 'dashscope', model: 'm-1', input: 300, output: 40, cacheRead: 700 },
    ])

    const res = await router().overview(params({ period: 'today' }))
    expect(res.status).toBe(200)
    const b = res.body as Record<string, number>

    expect(b['inputTokens']).toBe(400)
    expect(b['outputTokens']).toBe(60)
    expect(b['cacheReadTokens']).toBe(1600)
    expect(b['cacheWriteTokens']).toBe(0)
    expect(b['calls']).toBe(2)
    // ★ 铁律：total = input + output + cacheRead + cacheWrite
    expect(b['totalTokens']).toBe(400 + 60 + 1600 + 0)
    // ★ cacheRead 绝不能被并进 input（那样会漏掉 94% 的用量）
    expect(b['inputTokens']).not.toBe(2000)
  })

  test('cacheHitRate 与 shared 的公式逐位相等（口径不漂移）', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 7777, output: 186, cacheRead: 1024 },
      { seq: 2, ts: todayAt(11), provider: 'p', model: 'm', input: 2223, output: 14, cacheRead: 98976 },
    ])

    const res = await router().overview(params({ period: 'today' }))
    const b = res.body as Record<string, number>

    // 唯一真源：shared/src/metrics.ts 的 cacheHitRate()
    const expected = cacheHitRate({ input: 7777 + 2223, cacheRead: 1024 + 98976 })
    expect(b['cacheHitRate']).toBe(expected)
    // 分母是 cacheRead + input，不是 input：
    //   100000 / (100000 + 10000) = 0.9091
    // 若错用 input 当分母会是 10（>1 的荒谬值），这个断言就是为了钉死分母
    expect(b['cacheHitRate']).toBeCloseTo(100000 / 110000, 6)
    expect(b['cacheHitRate']).toBeLessThanOrEqual(1)
  })

  test('sessions 按过滤后的记录去重，不含「有文件但无调用」的会话', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    // 第二个会话只有 session 首行，没有任何 usage 事件
    writeSession('proj-a', 'sess-empty', [])

    const res = await router().overview(params({ period: 'today' }))
    const b = res.body as Record<string, number>
    expect(b['sessions']).toBe(1)
  })

  test('时间窗外的记录不计入', async () => {
    writeSession('proj-a', 'sess-old', [
      // 30 天前 —— 落在 today 窗口外
      { seq: 1, ts: Date.now() - 30 * 86_400_000, provider: 'p', model: 'm', input: 5000, output: 5000, cacheRead: 5000 },
    ])

    const today = await router().overview(params({ period: 'today' }))
    expect((today.body as Record<string, number>)['calls']).toBe(0)

    const all = await router().overview(params())
    expect((all.body as Record<string, number>)['calls']).toBe(1)
  })

  test('provider / model 子串过滤与 CLI 语义一致', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'deepseek-v4.1-flash', input: 10, output: 1, cacheRead: 100 },
      { seq: 2, ts: todayAt(11), provider: 'openai', model: 'gpt-4o', input: 20, output: 2, cacheRead: 200 },
    ])

    const byProv = await router().overview(params({ period: 'today', provider: 'dash' }))
    expect((byProv.body as Record<string, number>)['calls']).toBe(1)
    expect((byProv.body as Record<string, number>)['inputTokens']).toBe(10)

    // 大小写不敏感
    const upper = await router().overview(params({ period: 'today', provider: 'DASHSCOPE' }))
    expect((upper.body as Record<string, number>)['calls']).toBe(1)

    const byModel = await router().overview(params({ period: 'today', model: 'gpt-4o' }))
    expect((byModel.body as Record<string, number>)['calls']).toBe(1)
  })

  test('breakdown 按用量降序，且每行四项分列', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'small', model: 'm', input: 1, output: 1, cacheRead: 1 },
      { seq: 2, ts: todayAt(11), provider: 'big', model: 'm', input: 1000, output: 1000, cacheRead: 1000 },
    ])

    const res = await router().breakdown(params({ period: 'today', by: 'provider' }))
    expect(res.status).toBe(200)
    const rows = (res.body as { rows: Record<string, number | string>[] }).rows

    expect(rows.length).toBe(2)
    expect(rows[0]!['key']).toBe('big')
    expect(rows[0]!['totalTokens']).toBe(3000)
    expect(rows[0]!['inputTokens']).toBe(1000)
    expect(rows[0]!['cacheReadTokens']).toBe(1000)
    expect(rows[1]!['key']).toBe('small')
  })

  test('series 补零让趋势连续', async () => {
    // 昨天与前天各一条，中间那天缺失
    const day = 86_400_000
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: Date.now() - 3 * day, provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
      { seq: 2, ts: Date.now() - 1 * day, provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])

    const res = await router().series(params({ bucket: 'day' }))
    const points = (res.body as { points: { totalTokens: number }[] }).points
    // 跨度 3 天 → 补零后应有 3 个点，其中一个为 0
    expect(points.length).toBe(3)
    expect(points.filter((p) => p.totalTokens === 0).length).toBe(1)
  })

  test('diagnostics 把 Map/Set 转成可 JSON 序列化的结构', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])

    const res = await router().diagnostics(params({ period: 'today' }))
    const b = res.body as Record<string, unknown>

    // ★ 直接 JSON.stringify(new Map()) 会得到 "{}" —— 必须显式转换
    expect(Array.isArray(b['providersSeen'])).toBe(true)
    expect(b['providersSeen']).toEqual(['dashscope'])
    expect(typeof b['eventTypes']).toBe('object')
    expect((b['eventTypes'] as Record<string, number>)['assistant/message']).toBe(1)

    // 整包必须能无损序列化（页面要靠它渲染）
    const round = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>
    expect(round['providersSeen']).toEqual(['dashscope'])
  })

  test('恒等式校验失败会被诊断计入（正常数据应为 0）', async () => {
    const dir = join(sessionsRoot, 'proj-a', 'sess-bad')
    mkdirSync(dir, { recursive: true })
    const bad = {
      type: 'assistant/message',
      seq: 1,
      time: todayAt(10),
      data: {
        message: { source: { provider: 'p', model: 'm' } },
        // totalTokens 与四项之和不符 —— 模拟 provider 口径变化或解析出错
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, totalTokens: 999 },
      },
    }
    writeFileSync(
      join(dir, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(JSON.stringify(bad) + '\n', 'utf8')),
    )

    const res = await router().diagnostics(params({ period: 'today' }))
    expect((res.body as Record<string, number>)['totalTokenMismatches']).toBe(1)
  })
})

describe('本地统计数据新鲜度与并发', () => {
  test('日志追加后立刻可见（每请求前置增量 ingest）', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    const r = router()

    const first = await r.overview(params({ period: 'today' }))
    expect((first.body as Record<string, number>)['calls']).toBe(1)

    // 追加一条新记录（模拟会话正在进行）
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
      { seq: 2, ts: todayAt(11), provider: 'p', model: 'm', input: 5, output: 5, cacheRead: 5 },
    ])

    const second = await r.overview(params({ period: 'today' }))
    // ★ 数据源换成库之后，这条依然必须成立：库不能变成「过期的快照」。
    //   机制是每次请求前先跑增量 ingest（热态 L1 零解压，约 10ms）。
    expect((second.body as Record<string, number>)['calls']).toBe(2)
  })

  test('全新会话文件出现后立刻可见', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    const r = router()
    expect(((await r.overview(params({ period: 'today' }))).body as Record<string, number>)['calls']).toBe(1)

    // 新增一个会话目录（不是追加，是全新文件）
    writeSession('proj-b', 'sess-2', [
      { seq: 1, ts: todayAt(12), provider: 'p', model: 'm', input: 2, output: 2, cacheRead: 2 },
    ])

    const after = await r.overview(params({ period: 'today' }))
    expect((after.body as Record<string, number>)['calls']).toBe(2)
  })

  test('refresh 返回 200 且不抛错', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    const r = router()

    await r.overview(params({ period: 'today' }))
    const refreshed = r.refresh()
    expect(refreshed.status).toBe(200)
    expect((refreshed.body as { ok: boolean }).ok).toBe(true)

    const after = await r.overview(params({ period: 'today' }))
    expect(after.status).toBe(200)
    expect((after.body as Record<string, number>)['calls']).toBe(1)
  })

  test('并发请求互不干扰（回归：曾因共享 in-flight 触发 ECONNRESET）', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 100, output: 10, cacheRead: 900 },
    ])
    const r = router()

    // 页面首屏形态：4 个请求同时打进来
    const results = await Promise.all([
      r.overview(params({ period: 'today' })),
      r.series(params({ period: 'today', bucket: 'hour' })),
      r.breakdown(params({ period: 'today', by: 'provider-model' })),
      r.diagnostics(params({ period: 'today' })),
    ])

    // 每一个都必须真正拿到数据 —— 曾经这里会有请求拿到 undefined 而抛错
    for (const res of results) {
      expect(res.status).toBe(200)
      expect(res.body).toBeDefined()
      expect(res.body).not.toBeNull()
    }

    const overview = results[0]!.body as Record<string, number>
    expect(overview['totalTokens']).toBe(1010)
    expect((results[1]!.body as { points: unknown[] }).points.length).toBeGreaterThan(0)
    expect((results[2]!.body as { rows: unknown[] }).rows.length).toBe(1)
  })

  test('SQL 路径与直扫路径返回相同的数字（接口级口径一致）', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm-1', input: 100, output: 20, cacheRead: 900 },
      { seq: 2, ts: todayAt(11), provider: 'openai', model: 'gpt-4o', input: 300, output: 40, cacheRead: 700 },
    ])

    const viaSql = (await router().overview(params({ period: 'today' }))).body as Record<string, unknown>
    const viaScan = (await scanRouter().overview(params({ period: 'today' }))).body as Record<string, unknown>

    for (const k of [
      'totalTokens',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
      'calls',
      'sessions',
      'cacheHitRate',
      'cacheLeverage',
      'avgTokensPerCall',
    ]) {
      expect(viaSql[k]).toBe(viaScan[k])
    }

    // breakdown / series 也要一致
    const bSql = (await router().breakdown(params({ period: 'today', by: 'provider' }))).body as { rows: unknown[] }
    const bScan = (await scanRouter().breakdown(params({ period: 'today', by: 'provider' }))).body as { rows: unknown[] }
    expect(JSON.stringify(bSql.rows)).toBe(JSON.stringify(bScan.rows))

    const sSql = (await router().series(params({ period: 'today', bucket: 'day' }))).body as { points: unknown[] }
    const sScan = (await scanRouter().series(params({ period: 'today', bucket: 'day' }))).body as { points: unknown[] }
    expect(JSON.stringify(sSql.points)).toBe(JSON.stringify(sScan.points))
  })

  test('库不可用时降级直扫，接口仍返回数据而不是 500', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 7, output: 3, cacheRead: 90 },
    ])

    // 用一个必然建不出来的库路径（父路径是文件）
    const blocker = join(home, 'blocker')
    writeFileSync(blocker, 'not a dir')
    const r = new LocalStatsRouter(new CoreStatsProvider(sessionsRoot, join(blocker, 'x', 'usage.sqlite')))

    const res = await r.overview(params({ period: 'today' }))
    expect(res.status).toBe(200)
    expect((res.body as Record<string, number>)['calls']).toBe(1)
    expect((res.body as Record<string, number>)['totalTokens']).toBe(100)
  })

  test('refresh 与并发读同时发生时不会抛错', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    const r = router()

    const results = await Promise.all([
      r.overview(params({ period: 'today' })),
      Promise.resolve(r.refresh()),
      r.overview(params({ period: 'today' })),
      r.series(params({ period: 'today', bucket: 'day' })),
    ])

    for (const res of results) {
      expect(res.status).toBe(200)
    }
  })
})

describe('本地统计参数校验', () => {
  test('未知 period 返回 400 而不是静默全部时间', async () => {
    const res = await router().overview(params({ period: 'bogus' }))
    expect(res.status).toBe(400)
    expect(String((res.body as { reason: string }).reason)).toContain('bogus')
  })

  test('未知分组维度返回 400', async () => {
    const res = await router().breakdown(params({ by: 'nope' }))
    expect(res.status).toBe(400)
    expect(String((res.body as { reason: string }).reason)).toContain('nope')
  })

  test('未知 bucket 返回 400', async () => {
    const res = await router().series(params({ bucket: 'week' }))
    expect(res.status).toBe(400)
  })

  test('series 与 breakdown 都带上数据新鲜度字段', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 1 },
    ])
    const r = router()

    const series = (await r.series(params({ bucket: 'day' }))).body as Record<string, unknown>
    const breakdown = (await r.breakdown(params({ by: 'provider' }))).body as Record<string, unknown>

    // 页面靠这两个字段显示「数据 重扫 · HH:MM:SS」，缺失会显示空白
    for (const b of [series, breakdown]) {
      expect(typeof b['scannedAt']).toBe('number')
      expect(typeof b['cached']).toBe('boolean')
    }
    expect(series['bucket']).toBe('day')
    expect(breakdown['by']).toBe('provider')
  })
})

describe('本地统计空目录', () => {
  test('没有会话文件时返回全 0 而不是抛错', async () => {
    const res = await router().overview(params({ period: 'today' }))
    expect(res.status).toBe(200)
    const b = res.body as Record<string, number>
    expect(b['totalTokens']).toBe(0)
    expect(b['calls']).toBe(0)
    expect(b['sessions']).toBe(0)
    // 无调用时命中率应为 0 而不是 NaN
    expect(b['cacheHitRate']).toBe(0)
  })
})