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
import { writePricingSnapshot } from '@ai-token-report/core/db'
import { writeIdentity } from '@ai-token-report/core'

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

/**
 * 带来源字段的响应体。
 *
 * 用局部结构类型而不是 import 共享类型：这里要断言的是**线上字段确实存在**，
 * 而不是「类型系统认为它存在」—— 服务端漏填时它会是 `undefined`，两者必须能区分开。
 */
type SourcedBody = {
  sources: { sessionsRoots: string[]; missingRoots: string[]; dataDir: string | null }
  [key: string]: unknown
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

  test('★ 来源可见性：overview 报出读了哪几个会话日志根与数据目录', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm-1', input: 100, output: 20, cacheRead: 900 },
    ])

    const r = new LocalStatsRouter(new CoreStatsProvider(sessionsRoot, dbPath), {
      dataDir: '/tmp/atr-data-dir',
    })
    const overview = (await r.overview(params({ period: 'today' }))).body as SourcedBody
    expect(overview.sources.sessionsRoots).toEqual([sessionsRoot])
    expect(overview.sources.missingRoots).toEqual([])
    expect(overview.sources.dataDir).toBe('/tmp/atr-data-dir')

    // 诊断页给出**同一组**根：两处不一致的话页面会自相矛盾
    const diagnostics = (await r.diagnostics(params({ period: 'today' }))).body as SourcedBody
    expect(diagnostics.sources).toEqual(overview.sources)
  })

  test('★ 多根：全部根都报出，缺失的根逐项报出（绝不静默），未给 dataDir 时是 null', async () => {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm-1', input: 100, output: 20, cacheRead: 900 },
    ])
    const missing = join(home, 'no-such-home', 'sessions')

    const r = new LocalStatsRouter(new CoreStatsProvider([sessionsRoot, missing], dbPath))
    const body = (await r.overview(params({ period: 'today' }))).body as SourcedBody

    // 存在的根照常统计（缺失的那个被跳过，但**必须报出来**）
    expect(body.sources.sessionsRoots).toEqual([sessionsRoot])
    expect(body.sources.missingRoots).toEqual([missing])
    expect(body.sources.dataDir).toBeNull()
    // 单根 + 一帧 100+20+900 = 1020：跳过缺失根不影响结果
    expect(body['totalTokens']).toBe(1020)
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

/**
 * 本地金额（v7 起本地页也显示费用）。
 *
 * ## 这些断言在守什么
 *
 * 1. **价从哪来必须说清楚**：本地路径没有 `model_price` 表，价只能来自数据目录下的
 *    `pricing.json` 快照 —— 没有就退回内置种子价，并在 `pricing.pricingSource` 里
 *    如实标成 `builtin`。两个来源给出的金额**不一样**，而都「看起来正常」。
 * 2. **未计价绝不算成 0**：没配上单价的用量必须落进 `unpricedTokens`，
 *    而不是让 `costs` 里出现一条 0 元。
 * 3. **分组键与用量分组逐字相同**：分布表的某个键、趋势的某个桶，
 *    两者相加必须等于概览 —— 键各拼一套的话，它们在「项目 / 按天」两维会悄悄错开。
 * 4. **两条取数路径金额一致**：SQL 路径与直扫路径必须给出同一个整数微元。
 */
describe('本地金额（估算）', () => {
  /** 一段用量：input 400 / output 60 / cacheRead 1600。 */
  function writeCostSession(): void {
    writeSession('proj-a', 'sess-1', [
      { seq: 1, ts: todayAt(10), provider: 'dashscope', model: 'm-1', input: 100, output: 20, cacheRead: 900 },
      { seq: 2, ts: todayAt(11), provider: 'dashscope', model: 'm-1', input: 300, output: 40, cacheRead: 700 },
    ])
  }

  /** 把一份单价写进 `<home>/token-report/pricing.json`（`pricing sync` 的落点）。 */
  function writeLocalPrices(): void {
    writePricingSnapshot(join(home, 'token-report', 'pricing.json'), {
      syncedAtMs: 1_700_000_000_000,
      endpoint: 'http://portal.example/api/v1/stats/pricing',
      prices: [
        {
          provider: 'dashscope',
          model: 'm-1',
          currency: 'CNY',
          // 输入 1000 / 输出 2000 / 缓存读 100（微元每千 token）
          inputMicroPerKtok: 1000,
          outputMicroPerKtok: 2000,
          cacheReadMicroPerKtok: 100,
          cacheWriteMicroPerKtok: 0,
          effectiveFromMs: 0,
          effectiveToMs: null,
        },
      ],
    })
  }

  function costRouter(): LocalStatsRouter {
    // ★ 金额只在**配置过上报**时才下发（见用例组末尾那几条），所以这里先署名 ——
    //   不署名量到的是「字段整块缺席」，而不是「价算得对不对」。
    signIn()
    return new LocalStatsRouter(new CoreStatsProvider(sessionsRoot, dbPath), {
      dataDir: join(home, 'token-report'),
    })
  }

  /**
   * 署名 = 「配置过上报」。
   *
   * 本地页的「配置」弹框与插件面板在 appKey 校验通过后写的正是这份
   * `identity.json`（连接配置先落地、身份写失败就回滚），而 `/api/local/identity`
   * 回答 `signed` 读的也是它 —— 两处同一个事实。
   */
  function signIn(): void {
    const written = writeIdentity(join(home, 'token-report', 'identity.json'), {
      name: '张三',
      token: 'atr-local-api-test',
    })
    if (!written.ok) throw new Error(`署名夹具写入失败: ${written.reason}`)
  }

  type CostBody = {
    cost: {
      costs: { currency: string; amountMicro: number; tokens: number }[]
      pricedTokens: number
      unpricedTokens: number
      totalTokens: number
      pricedRate: number
      unpricedRate: number
      pricing: { pricingSource: string; pricingSyncedAt: number | null }
    }
  }

  test('没有单价快照时退回内置种子价，并如实标注来源（绝不假装是按快照算的）', async () => {
    writeCostSession()
    const res = await costRouter().overview(params({ period: 'today' }))
    expect(res.status).toBe(200)
    const cost = (res.body as unknown as CostBody).cost

    expect(cost.pricing).toEqual({
      pricingSource: 'builtin',
      pricingSyncedAt: null,
      // 价目出处：内置价就是 DeepSeek 官方定价页 —— 它与来源一起下发，人才能去核对这份价。
      pricingOrigin: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    })
    // 内置价只覆盖 deepseek-official 的几个模型，dashscope/m-1 一条都不在表里
    // → 全部用量都是「未计价」，而不是 0 元。
    expect(cost.costs).toEqual([])
    expect(cost.unpricedTokens).toBe(2060)
    expect(cost.pricedTokens).toBe(0)
    expect(cost.unpricedRate).toBe(1)
    expect(cost.totalTokens).toBe(2060)
  })

  test('★ 四类分价各自相乘：input 400×1000 + output 60×2000 + cacheRead 1600×100（微元/千）', async () => {
    writeCostSession()
    writeLocalPrices()
    const res = await costRouter().overview(params({ period: 'today' }))
    const cost = (res.body as unknown as CostBody).cost

    expect(cost.pricing).toEqual({
      pricingSource: 'snapshot',
      pricingSyncedAt: 1_700_000_000_000,
      // 快照的来源地址 = 这份价是从哪拉下来的（同步时写进 `pricing.json` 的 `endpoint`）。
      pricingOrigin: 'http://portal.example/api/v1/stats/pricing',
    })
    // 400 + 120 + 160 = 680 微元（整数，逐位可对）
    expect(cost.costs).toEqual([{ currency: 'CNY', amountMicro: 680, tokens: 2060 }])
    expect(cost.unpricedTokens).toBe(0)
    expect(cost.pricedRate).toBe(1)
  })

  test('分布表每一行的金额与该行的用量对得上（键复用同一份 groupKey）', async () => {
    writeCostSession()
    writeLocalPrices()
    const res = await costRouter().breakdown(params({ by: 'provider-model' }))
    const rows = (
      res.body as unknown as { rows: ({ key: string; totalTokens: number } & CostBody)[] }
    ).rows

    expect(rows.length).toBe(1)
    expect(rows[0]!.key).toBe('dashscope/m-1')
    expect(rows[0]!.totalTokens).toBe(2060)
    expect(rows[0]!.cost.costs).toEqual([{ currency: 'CNY', amountMicro: 680, tokens: 2060 }])
  })

  test('趋势各桶金额之和等于概览金额（补零出来的桶给空金额，不是 0 元的一条）', async () => {
    writeCostSession()
    writeLocalPrices()
    const r = costRouter()

    const overview = (await r.overview(params({ period: 'today' }))).body as unknown as CostBody
    const series = (await r.series(params({ bucket: 'hour' }))).body as unknown as {
      points: ({ bucket: string } & CostBody)[]
    }

    const sum = series.points.reduce((acc, p) => acc + (p.cost.costs[0]?.amountMicro ?? 0), 0)
    expect(sum).toBe(overview.cost.costs[0]!.amountMicro)
    // 今天的补零桶：有金额的只有 10 点与 11 点两个桶
    const priced = series.points.filter((p) => p.cost.costs.length > 0)
    expect(priced.map((p) => p.bucket.slice(-2))).toEqual(['10', '11'])
    // 每个点都带 cost 字段（缺字段会让页面在某个窗口突然没有金额列）
    expect(series.points.every((p) => p.cost.pricing !== undefined)).toBe(true)
  })

  test('未配单价的模型落在 unpricedTokens，且金额数组为空（不是 0 元）', async () => {
    writeSession('proj-a', 'sess-2', [
      { seq: 1, ts: todayAt(12), provider: 'dashscope', model: 'm-未知', input: 500, output: 0, cacheRead: 0 },
    ])
    writeLocalPrices()

    const breakdown = (await costRouter().breakdown(params({ by: 'model' }))).body as unknown as {
      rows: ({ key: string } & CostBody)[]
    }
    const row = breakdown.rows.find((r) => r.key === 'm-未知')!
    expect(row.cost.costs).toEqual([])
    expect(row.cost.unpricedTokens).toBe(500)
    expect(row.cost.unpricedRate).toBe(1)
  })

  // ── 「没配置上报 → 整块费用不出现」──────────────────────────────────────
  //
  // ★ 判据是**本机已署名**（`<dataDir>/identity.json`），与 `/api/local/identity`
  //   的 `signed` 读同一份文件。三条断言分别守：字段整块缺席（不是 0）、
  //   连算都不算、以及它是**活取值**（在页面里配完就出现，不必重启服务）。

  /** 数据目录给全、价快照也在，但**这台机器没署过名**。 */
  function unconfiguredRouter(): LocalStatsRouter {
    return new LocalStatsRouter(new CoreStatsProvider(sessionsRoot, dbPath), {
      dataDir: join(home, 'token-report'),
    })
  }

  test('★ 未配置上报 → 概览 / 趋势 / 明细里一个 cost 字段都没有（不是 0）', async () => {
    writeCostSession()
    writeLocalPrices()
    const r = unconfiguredRouter()

    const results = [
      await r.overview(params({ period: 'today' })),
      await r.series(params({ bucket: 'hour' })),
      await r.breakdown(params({ by: 'provider-model' })),
    ]

    for (const res of results) {
      expect(res.status).toBe(200)
      // 判据同样是**字段在不在**：写成 `cost: 0` 会让「没配置」看起来像「没花钱」
      expect(JSON.stringify(res.body)).not.toContain('"cost"')
    }

    // 去掉的只是费用那一块，用量照常下发（未署名 ≠ 页面没数据）
    expect((results[0]!.body as unknown as { totalTokens: number }).totalTokens).toBe(2060)
  })

  test('★ 未配置上报时连算都不算：`records()` 一次都没被碰过', async () => {
    writeCostSession()
    writeLocalPrices()

    let recordsCalls = 0
    const provider: StatsProvider = {
      open: async (opts) => {
        const { openStats } = await import('@ai-token-report/core/db')
        const session = await openStats({
          sessionsRoot,
          dbPath,
          ...(opts.period ? { period: opts.period } : {}),
          providers: opts.providers,
          models: opts.models,
        })
        // 影子方法只记账：逐条事件取价必须物化全量记录，所以金额真算了就一定会走它。
        const real = session.records.bind(session)
        session.records = () => {
          recordsCalls += 1
          return real()
        }
        return session
      },
    }

    const body = (
      await new LocalStatsRouter(provider, { dataDir: join(home, 'token-report') }).overview(
        params({ period: 'today' }),
      )
    ).body as Record<string, unknown>

    expect(body['cost']).toBeUndefined()
    expect(recordsCalls).toBe(0)
  })

  test('★ 配置上报是活取值：署名前没有金额，署名后立刻出现（本地服务不必重启）', async () => {
    writeCostSession()
    writeLocalPrices()
    // ⚠️ 同一个 router 实例连着请求两次：本地服务是长驻进程，而配置是页面里填的
    const r = unconfiguredRouter()

    const before = (await r.overview(params({ period: 'today' }))).body as Record<string, unknown>
    expect(before['cost']).toBeUndefined()

    signIn()

    const after = (await r.overview(params({ period: 'today' }))).body as Record<string, unknown>
    expect(after['cost']).toBeDefined()
  })

  test('SQL 路径与直扫路径给出同一笔金额（接口级口径一致）', async () => {
    writeCostSession()
    writeLocalPrices()

    const sql = (await costRouter().overview(params({ period: 'today' }))).body as unknown as CostBody
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
    const scan = (
      await new LocalStatsRouter(provider, { dataDir: join(home, 'token-report') }).overview(
        params({ period: 'today' }),
      )
    ).body as unknown as CostBody

    expect(scan.cost).toEqual(sql.cost)
    expect(scan.cost.costs[0]!.amountMicro).toBe(680)
  })
})