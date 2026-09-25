/**
 * 宿主侧 UI 数据通道的测试。
 *
 * 这里钉住三件事，它们各自对应一类真实事故：
 *
 * 1. **载荷只裁剪不改写** —— 四个 token 列与 `metrics` 必须原样透传。
 *    一旦这里顺手「合并一下 input+cacheRead」，面板上的数就与终端分叉，
 *    而且两边都不报错（铁律 1、3）。
 * 2. **TTL 缓存与在途合并真的生效** —— 面板是常驻的，缓存失效等于
 *    「每个轮询周期把全量日志重扫一遍」，在 Node 宿主上这是十几秒的 CPU。
 * 3. **headless 下不注册、也不抛错** —— 拿不到 `connection` 必须安静跳过，
 *    因为同一个插件还要在 headless profile 里做上报。
 */

import { describe, expect, test } from 'bun:test'

import { UI_STATS_PATH, type UiPayload, type UiResponse } from '../src/client/protocol.js'
import {
  coercePeriod,
  createUiStatsProvider,
  installUiRoute,
  makeStatsFetch,
  seriesFor,
  toUiPayload,
  type UiHostContext,
} from '../src/index.js'
import type { UsageResult } from '../src/stats.js'

/** 造一份最小可用的 `UsageResult`（字段值与 stats.ts 的产出一致）。 */
function sampleResult(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    source: 'scan',
    rangeLabel: '今天',
    range: { since: 1, until: 2 },
    totals: {
      input: 70_379_895,
      output: 9_754_881,
      cacheRead: 2_312_474_995,
      cacheWrite: 0,
      reasoning: 0,
      total: 2_392_609_771,
      calls: 16_437,
    },
    metrics: { total: 2_392_609_771, cacheHitRate: 0.9705, cacheLeverage: 32.85, avgTokensPerCall: 145_560 },
    groups: [
      {
        by: 'provider-model',
        rows: Array.from({ length: 35 }, (_, i) => ({
          key: `dashscope/deepseek-v4.1-flash-${i}`,
          total: 100 - i,
          input: 10,
          output: 1,
          cacheRead: 89,
          cacheWrite: 0,
          calls: 3,
          sessions: 1,
          cacheHitRate: 0.899,
        })),
      },
    ],
    series: Array.from({ length: 40 }, (_, i) => ({
      bucket: `2026-09-${String(i + 1).padStart(2, '0')}`,
      total: i,
      input: i,
      output: 0,
      cacheRead: 0,
      calls: 1,
      cacheHitRate: 0,
    })),
    sessions: 42,
    elapsedMs: 11_196,
    scannedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('★ 载荷只裁剪不改写（口径的唯一真源仍在 shared）', () => {
  test('四个 token 列分列透传，不合并成「总输入」', () => {
    const payload = toUiPayload(sampleResult(), 'today')
    expect(payload.totals.input).toBe(70_379_895)
    expect(payload.totals.cacheRead).toBe(2_312_474_995)
    expect(payload.totals.cacheWrite).toBe(0)
    // 恒等式在载荷上仍然成立：total = input + output + cacheRead + cacheWrite
    expect(payload.totals.total).toBe(
      payload.totals.input + payload.totals.output + payload.totals.cacheRead + payload.totals.cacheWrite,
    )
  })

  test('metrics 整块照搬：命中率 = cacheRead/(cacheRead+input)，不是本地重算的别的口径', () => {
    const result = sampleResult()
    const payload = toUiPayload(result, 'today')
    expect(payload.metrics.cacheHitRate).toBe(result.metrics.cacheHitRate)
    expect(payload.metrics.cacheLeverage).toBe(result.metrics.cacheLeverage)
    expect(payload.metrics.avgTokensPerCall).toBe(result.metrics.avgTokensPerCall)
    expect(payload.metrics.cacheHitRate).toBeCloseTo(0.9705, 4)
    // 载荷里的指标刻意**没有** total 这一项：总量只在 totals 里出现一次，
    // 两个地方各放一份，早晚会有一个忘了同步。
    expect('total' in payload.metrics).toBe(false)
  })

  test('明细完整保留供分页，序列点截断，行内的数一个不动', () => {
    const payload = toUiPayload(sampleResult(), 'last30d')
    expect(payload.groups[0]?.rows.length).toBe(35)
    expect(payload.groups[0]?.rows[34]?.key).toBe('dashscope/deepseek-v4.1-flash-34')
    expect(payload.series?.length).toBe(31) // UI_SERIES_POINTS
    expect(payload.groups[0]?.rows[0]?.total).toBe(100)
    // 截断取的是**最近**的点，不是最早的
    expect(payload.series?.[payload.series.length - 1]?.bucket).toBe('2026-09-40')
  })

  test('降级原因如实带出去（不允许假装数据来自库）', () => {
    const payload = toUiPayload(
      sampleResult({ source: 'scan', degradedReason: '本地库不可用（SQLITE_CORRUPT），已降级为直扫日志' }),
      'today',
    )
    expect(payload.source).toBe('scan')
    expect(payload.degradedReason).toContain('SQLITE_CORRUPT')
  })

  test('今年保留超过 31 天的完整趋势与原始点值', () => {
    const result = sampleResult()
    const payload = toUiPayload(result, 'year')
    expect(payload.series?.length).toBe(result.series?.length)
    expect(payload.series?.length).toBeGreaterThan(31)
    expect(payload.series?.[0]?.bucket).toBe(result.series?.[0]?.bucket)
    expect(payload.series?.[0]?.total).toBe(result.series?.[0]?.total)
  })
})

describe('周期与趋势粒度', () => {
  test('非法周期回落到默认值，不抛错（URL 参数是外部输入）', () => {
    expect(coercePeriod('today')).toBe('today')
    expect(coercePeriod('last7d')).toBe('last7d')
    expect(coercePeriod('year')).toBe('year')
    expect(coercePeriod('本周')).toBe('today') // 只认 id，不认中文别名
    expect(coercePeriod(null)).toBe('today')
    expect(coercePeriod(123)).toBe('today')
  })

  test('今天/昨天看小时，更长窗口看天', () => {
    expect(seriesFor('today')).toBe('hour')
    expect(seriesFor('yesterday')).toBe('hour')
    expect(seriesFor('week')).toBe('day')
    expect(seriesFor('last30d')).toBe('day')
    expect(seriesFor('last7d')).toBe('day')
    expect(seriesFor('year')).toBe('day')
  })
})

describe('★ TTL 缓存 + 在途合并（面板常驻，不能每个周期重扫日志）', () => {
  test('TTL 内重复取数只查一次', async () => {
    let calls = 0
    let clock = 1_000
    const provider = createUiStatsProvider({
      run: async () => {
        calls++
        return sampleResult()
      },
      now: () => clock,
      ttlMs: 30_000,
    })

    await provider.get('today')
    clock += 10_000
    await provider.get('today')
    expect(calls).toBe(1)

    clock += 25_000 // 超过 TTL
    await provider.get('today')
    expect(calls).toBe(2)
  })

  test('refresh=1 绕过缓存（用户点了「刷新」就该看到新数）', async () => {
    let calls = 0
    const provider = createUiStatsProvider({
      run: async () => {
        calls++
        return sampleResult()
      },
      now: () => 1_000,
    })
    await provider.get('today')
    await provider.get('today', true)
    expect(calls).toBe(2)
  })

  test('两个面板同时取同一周期 → 只扫一次（在途合并）', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = createUiStatsProvider({
      run: async () => {
        calls++
        await gate
        return sampleResult()
      },
    })

    const both = Promise.all([provider.get('today'), provider.get('today')])
    release?.()
    const [a, b] = await both
    expect(calls).toBe(1)
    expect(a).toEqual(b)
  })

  test('不同周期各自成键，互不串味', async () => {
    const seen: string[] = []
    const provider = createUiStatsProvider({
      run: async (query) => {
        seen.push(String(query.period))
        return sampleResult()
      },
    })
    await provider.get('today')
    await provider.get('month')
    expect(seen).toEqual(['today', 'month'])
  })

  test('失败也进缓存，且返回 200 形状的错误体（面板要能就地显示原因）', async () => {
    let calls = 0
    const clock = 1_000
    const provider = createUiStatsProvider({
      run: async () => {
        calls++
        throw new Error('会话目录不存在')
      },
      now: () => clock,
    })
    const first = await provider.get('today')
    const second = await provider.get('today')
    expect(calls).toBe(1)
    expect(first).toEqual({ period: 'today', error: '会话目录不存在' })
    expect(second).toEqual(first)
  })
})

describe('Fetch 处理器', () => {
  test('解析 period 与 refresh 查询参数', async () => {
    const seen: { period?: string; refresh: boolean }[] = []
    const fetchStats = makeStatsFetch({
      get: async (period, force) => {
        seen.push({ period, refresh: force === true })
        return toUiPayload(sampleResult(), period)
      },
    })

    await fetchStats(new Request(`http://127.0.0.1${UI_STATS_PATH}?period=month&refresh=1`))
    await fetchStats(new Request(`http://127.0.0.1${UI_STATS_PATH}?period=bogus`))
    await fetchStats(new Request(`http://127.0.0.1${UI_STATS_PATH}`))

    expect(seen).toEqual([
      { period: 'month', refresh: true },
      { period: 'today', refresh: false },
      { period: 'today', refresh: false },
    ])
  })

  test('响应是 200 + JSON，且带 no-store（面板自己管缓存）', async () => {
    const provider = createUiStatsProvider({ run: async () => sampleResult() })
    const res = await makeStatsFetch(provider)(new Request(`http://127.0.0.1${UI_STATS_PATH}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as UiResponse
    expect((body as UiPayload).totals.total).toBe(2_392_609_771)
  })
})

describe('★ 路由安装：拿不到 connection 必须安静跳过', () => {
  const stats = { config: {} as never, sessionsRoot: '/tmp/sessions', dbPath: '/tmp/db.sqlite' }

  /** 会记录 `register` 调用的假 connection。 */
  function fakeConnection(registered: unknown[]): unknown {
    return {
      fetch: {
        register: (route: unknown) => {
          registered.push(route)
          return () => {}
        },
      },
    }
  }

  /** 最小假宿主。`connection` 为 undefined 表示宿主还没有这个服务。 */
  function fakeHost(options: { connection?: unknown; canInject?: boolean } = {}): {
    ctx: UiHostContext
    logs: string[]
    injected: string[][]
  } {
    const logs: string[] = []
    const injected: string[][] = []
    const ctx = {
      logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      effect: (cb: () => (() => void) | void) => {
        cb()
      },
      get: (name: string) => (name === 'connection' ? options.connection : undefined),
      ...(options.canInject === false
        ? {}
        : {
            inject: (deps: string[], cb: (c: UiHostContext) => void) => {
              injected.push(deps)
              // 模拟「依赖稍后就绪」
              if (options.connection !== undefined) cb(ctx)
            },
          }),
    } as unknown as UiHostContext
    return { ctx, logs, injected }
  }

  test('有 connection → 注册到 /api/tokenReport.stats 的 GET，并记一条 info', () => {
    const registered: unknown[] = []
    const hosts = fakeHost({ connection: fakeConnection(registered) })
    expect(installUiRoute(hosts.ctx, stats)).toBe('registered')
    expect(registered.length).toBe(1)
    const route = registered[0] as { path: string; methods: string[]; requestBody: string }
    expect(route.path).toBe(UI_STATS_PATH)
    // ★ 必须挂在 /api 下：那层前缀由 dsh-client-connection 加了鉴权栅栏，
    //   裸挂在别的路径上等于把本机用量公开给能访问该端口的人。
    expect(route.path.startsWith('/api/')).toBe(true)
    expect(route.methods).toEqual(['GET'])
    expect(route.requestBody).toBe('buffered')
    expect(hosts.logs.some((l) => l.includes('UI 用量面板数据通道已挂载'))).toBe(true)
  })

  test('没有 connection 但宿主可注入 → pending，且挂上了等待', () => {
    const hosts = fakeHost({ connection: undefined })
    expect(installUiRoute(hosts.ctx, stats)).toBe('pending')
    expect(hosts.injected).toEqual([['connection']])
  })

  test('延迟出现的 connection 最终会注册，且只注册一次（重复路径会抛错）', () => {
    const registered: unknown[] = []
    let injectCb: ((c: UiHostContext) => void) | undefined
    const base = {
      logger: { info: () => {}, warn: () => {} },
      effect: (cb: () => (() => void) | void) => {
        cb()
      },
      get: () => undefined,
      inject: (_deps: string[], cb: (c: UiHostContext) => void) => {
        injectCb = cb
      },
    } as unknown as UiHostContext

    expect(installUiRoute(base, stats)).toBe('pending')

    // 依赖就绪：现在 get('connection') 能拿到
    const ready = { ...base, get: () => fakeConnection(registered) } as unknown as UiHostContext
    injectCb?.(ready)
    injectCb?.(ready) // 回调再来一次也不能重复注册
    expect(registered.length).toBe(1)
  })

  test('headless（没有 inject，也没有 connection）→ unavailable，且不抛错', () => {
    const hosts = fakeHost({ connection: undefined, canInject: false })
    expect(installUiRoute(hosts.ctx, stats)).toBe('unavailable')
  })
})
