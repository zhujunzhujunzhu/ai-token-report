/**
 * 取数状态机的测试。
 *
 * 这个文件守的是「面板在那儿、数字全是 0」这一类**静默故障**：
 * 载荷解析、失败分诊、迟到响应、轮询生命周期，每一处失败在页面上
 * 都长得差不多，只有在这里才能区分开。
 */

import { describe, expect, test } from 'bun:test'

import { UI_STATS_PATH, readUiResponse } from '../../src/client/protocol.js'
import { createUsageStore, describeFetchFailure, type UsageStoreDeps, type VisibilitySource } from '../../src/client/store.js'

/** 一份合法的响应体。 */
function payloadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    period: 'today',
    rangeLabel: '今天',
    source: 'scan',
    // 数据代次：浏览器半拿它做探针。真宿主每个载荷都会带上。
    gen: 1,
    totals: {
      total: 2_392_609_771,
      input: 70_379_895,
      output: 9_754_881,
      cacheRead: 2_312_474_995,
      cacheWrite: 0,
      reasoning: 0,
      calls: 16_437,
    },
    metrics: { cacheHitRate: 0.9705, cacheLeverage: 32.85, avgTokensPerCall: 145_560 },
    groups: [{ by: 'provider-model', rows: [] }],
    sessions: 42,
    elapsedMs: 11_196,
    scannedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** 记录调用的假 fetch。 */
function fakeFetch(
  respond: (url: string) => { status?: number; ok?: boolean; body?: unknown; throw?: Error },
): { impl: UsageStoreDeps['fetch']; urls: string[] } {
  const urls: string[] = []
  const impl: UsageStoreDeps['fetch'] = async (input) => {
    urls.push(input)
    const r = respond(input)
    if (r.throw !== undefined) throw r.throw
    const status = r.status ?? 200
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('not json')
        return r.body
      },
    }
  }
  return { impl, urls }
}

/** 等 store 稳定下来（若干轮微/宏任务）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(1)
}

describe('取数：成功路径', () => {
  test('首次订阅触发取数，状态从 loading 变 ready', async () => {
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl })

    expect(store.getSnapshot().loading).toBe(true)
    const unsubscribe = store.subscribe(() => {})
    await settle()

    const state = store.getSnapshot()
    expect(state.loading).toBe(false)
    expect(state.error).toBeUndefined()
    expect(state.data?.totals.total).toBe(2_392_609_771)
    expect(state.fetchedAt).toBeGreaterThan(0)
    expect(urls.length).toBe(1)
    expect(urls[0]).toContain(`${UI_STATS_PATH}?period=today`)
    unsubscribe()
    store.dispose()
  })

  test('★ getSnapshot 必须返回稳定引用（否则 useSyncExternalStore 会死循环）', async () => {
    const { impl } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    expect(store.getSnapshot()).toBe(store.getSnapshot())
    unsubscribe()
    store.dispose()
  })

  test('refresh 带上 refresh=1（绕过宿主缓存）', async () => {
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    store.refresh()
    await settle()
    expect(urls[1]).toContain('refresh=1')
    unsubscribe()
    store.dispose()
  })

  test('切周期会重新取数，且 period 立刻反映在快照上', async () => {
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    store.setPeriod('month')
    expect(store.getSnapshot().period).toBe('month')
    await settle()
    expect(urls[urls.length - 1]).toContain('period=month')
    unsubscribe()
    store.dispose()
  })
})

describe('★ 失败分诊：三条路各给一条能指着动作的提示', () => {
  test('404 —— 路由根本没装上（宿主不是 web profile / 没启用 UI 通道）', () => {
    const message = describeFetchFailure(404, undefined)
    expect(message).toContain('404')
    expect(message).toContain(UI_STATS_PATH)
    expect(message).toContain('web profile')
  })

  test('401/403 —— 没带宿主鉴权的 token', () => {
    expect(describeFetchFailure(401, undefined)).toContain('鉴权')
    expect(describeFetchFailure(403, undefined)).toContain('鉴权')
  })

  test('200 但响应体不是 JSON（SPA 兜底返回了 HTML）', () => {
    expect(describeFetchFailure(200, undefined)).toBe('响应不是合法 JSON')
  })

  test('404 走完整链路：面板拿到的是「数据通道没装上」而不是「加载失败」', async () => {
    const { impl } = fakeFetch(() => ({ status: 404, ok: false }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    const state = store.getSnapshot()
    expect(state.data).toBeUndefined()
    expect(state.error).toContain('404')
    unsubscribe()
    store.dispose()
  })

  test('200 但返回 HTML → 提示「不是合法 JSON」', async () => {
    const { impl } = fakeFetch(() => ({ body: undefined }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    expect(store.getSnapshot().error).toBe('响应不是合法 JSON')
    unsubscribe()
    store.dispose()
  })

  test('宿主自己报了错（200 + error 字段）→ 原样透出宿主的原因', async () => {
    const { impl } = fakeFetch(() => ({ body: { period: 'today', error: '会话目录不存在' } }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    expect(store.getSnapshot().error).toBe('会话目录不存在')
    unsubscribe()
    store.dispose()
  })

  test('网络异常 → 提示「请求失败」且带上原因', async () => {
    const { impl } = fakeFetch(() => ({ throw: new Error('Failed to fetch') }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    expect(store.getSnapshot().error).toContain('请求失败')
    expect(store.getSnapshot().error).toContain('Failed to fetch')
    unsubscribe()
    store.dispose()
  })

  test('刷新失败时旧数据仍然保留（不把已有数字擦掉）', async () => {
    let fail = false
    const { impl } = fakeFetch(() => (fail ? { status: 500, ok: false } : { body: payloadBody() }))
    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    fail = true
    store.refresh()
    await settle()

    const state = store.getSnapshot()
    expect(state.data?.totals.total).toBe(2_392_609_771)
    expect(state.error).toContain('500')
    unsubscribe()
    store.dispose()
  })
})

test('切换预设和自定义期间保留成功内容，失败不冒充新范围', async () => {
  let release: ((body: unknown) => void) | undefined
  const store = createUsageStore({ fetch: async input => {
    const body = input.includes('period=today') ? payloadBody() : await new Promise(resolve => { release = resolve })
    return { ok: true, status: 200, json: async () => body }
  } })
  const unsubscribe = store.subscribe(() => {})
  try {
    await settle()
    const today = store.getSnapshot().data
    store.setPeriod('year')
    expect(store.getSnapshot().data).toBe(today)
    expect(store.getSnapshot().data?.rangeLabel).toBe('今天')
    expect(store.getSnapshot().loading).toBe(false)
    expect(store.getSnapshot().refreshing).toBe(true)
    release?.(payloadBody({ period: 'year', rangeLabel: '今年' }))
    await settle()
    const year = store.getSnapshot().data
    expect(year?.rangeLabel).toBe('今年')
    store.setCustomRange({ since: '2026-01-01', until: '2026-02-01' })
    expect(store.getSnapshot().data).toBe(year)
    expect(store.getSnapshot().loading).toBe(false)
    release?.({ error: '暂时无法读取' })
    await settle()
    expect(store.getSnapshot().data).toBe(year)
    expect(store.getSnapshot().refreshing).toBe(false)
    expect(store.getSnapshot().error).toBe('暂时无法读取')
  } finally { unsubscribe(); store.dispose() }
})

describe('★ 迟到的响应必须丢掉', () => {
  test('切周期后旧周期的响应返回 → 不覆盖新周期的状态', async () => {
    const gates = new Map<string, () => void>()
    const bodies = new Map<string, unknown>()

    const impl: UsageStoreDeps['fetch'] = async (input) => {
      const period = new URL(`http://x${input}`).searchParams.get('period') ?? ''
      await new Promise<void>((resolve) => gates.set(period, resolve))
      return { ok: true, status: 200, json: async () => bodies.get(period) }
    }

    bodies.set('today', payloadBody({ rangeLabel: '今天' }))
    bodies.set('month', payloadBody({ period: 'month', rangeLabel: '本月' }))

    const store = createUsageStore({ fetch: impl })
    const unsubscribe = store.subscribe(() => {})
    // today 的请求先发出去，但先不放行
    await Bun.sleep(1)

    store.setPeriod('month')
    await Bun.sleep(1)

    // 先放行**后发**的 month，再放行**先发**的 today
    gates.get('month')?.()
    await settle()
    gates.get('today')?.()
    await settle()

    const state = store.getSnapshot()
    expect(state.period).toBe('month')
    expect(state.data?.rangeLabel).toBe('本月')
    unsubscribe()
    store.dispose()
  })
})

/** 等两三个轮询周期（间隔 5ms）。 */
async function shelterPoll(): Promise<void> {
  await Bun.sleep(20)
}

describe('★ 轮询生命周期：卸载后不该还在解码日志', () => {
  test('第二个订阅者共享同一份状态，不额外取数', async () => {
    // 间隔取大值：这一段只验证「订阅者数量」不影响取数次数
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl, intervalMs: 60_000 })

    const a = store.subscribe(() => {})
    await settle()
    expect(urls.length).toBe(1)

    const b = store.subscribe(() => {})
    await settle()
    expect(urls.length).toBe(1)

    a()
    await settle()
    expect(urls.length).toBe(1)

    b()
    store.dispose()
  })

  test('还有订阅者时继续轮询，最后一个取消后停止', async () => {
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl, intervalMs: 5 })

    const a = store.subscribe(() => {})
    await shelterPoll()
    expect(urls.length).toBeGreaterThan(1)

    const b = store.subscribe(() => {})
    a()
    const whileOneLeft = urls.length
    await shelterPoll()
    expect(urls.length).toBeGreaterThan(whileOneLeft)

    b()
    const afterAllGone = urls.length
    await Bun.sleep(30)
    expect(urls.length).toBe(afterAllGone)
    store.dispose()
  })

  test('dispose 之后不再发请求', async () => {
    const { impl, urls } = fakeFetch(() => ({ body: payloadBody() }))
    const store = createUsageStore({ fetch: impl, intervalMs: 5 })
    store.subscribe(() => {})
    await settle()

    store.dispose()
    const settled = urls.length
    await Bun.sleep(20)
    expect(urls.length).toBe(settled)
  })
})

/** 可手动切换的假可见性来源（后台标签页 / 切回前台）。 */
function fakeVisibility(hidden: boolean): { source: VisibilitySource; set(hidden: boolean): void } {
  let current = hidden
  const listeners = new Set<() => void>()
  return {
    source: {
      isHidden: () => current,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * ★ 刷新模型：3 秒探针 + 120 秒兜底 + 后台暂停。
 *
 * 这一组守的是「既不让面板每 3 秒重扫一次日志，又不让它看起来死了」——
 * 两个极端都是事故：前者卡住 agent，后者让人以为数据没在动。
 */
describe('★ 刷新模型：代次探针 / 兜底全量 / 后台暂停', () => {
  /** 假宿主：代次与手上那份一样就回 204，否则返回带新代次的载荷。 */
  function hostWithGen(initial: { gen: number; total: number }) {
    const host = { ...initial }
    const urls: string[] = []
    const impl: UsageStoreDeps['fetch'] = async (input) => {
      urls.push(input)
      const asked = new URL(`http://x${input}`).searchParams.get('gen')
      if (asked !== null && Number(asked) === host.gen) {
        return { ok: true, status: 204, json: async () => { throw new SyntaxError('204 没有 body') } }
      }
      return {
        ok: true,
        status: 200,
        json: async () => payloadBody({
          gen: host.gen,
          totals: { total: host.total, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 },
        }),
      }
    }
    return { host, urls, impl }
  }

  test('★ 代次没变 → 204 不产生任何新快照（否则每 3 秒白重渲染一次）', async () => {
    const { urls, impl } = hostWithGen({ gen: 1, total: 100 })
    const store = createUsageStore({ fetch: impl, intervalMs: 5, fullIntervalMs: 10_000_000, now: () => 1_000 })

    let renders = 0
    const unsubscribe = store.subscribe(() => { renders++ })
    await settle()
    const rendersAfterLoad = renders

    await Bun.sleep(30) // 若干个 tick
    const probes = urls.slice(1) // urls[0] 是首次全量取数
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((u) => u.includes('gen=1'))).toBe(true) // 探针带上了手上的代次
    expect(probes.every((u) => !u.includes('refresh=1'))).toBe(true) // 探针不是「刷新」
    expect(renders).toBe(rendersAfterLoad) // ★ 零重渲染
    expect(store.getSnapshot().refreshing).toBe(false) // ★ 也不该闪「正在更新」
    unsubscribe()
    store.dispose()
  })

  test('★ 代次变了 → 新载荷被采纳，随后又回到 204（不会反复取）', async () => {
    const { host, urls, impl } = hostWithGen({ gen: 1, total: 100 })
    const store = createUsageStore({ fetch: impl, intervalMs: 5, fullIntervalMs: 10_000_000, now: () => 1_000 })
    const unsubscribe = store.subscribe(() => {})
    await settle()
    expect(store.getSnapshot().data?.totals.total).toBe(100)

    host.gen = 2
    host.total = 200
    await Bun.sleep(30)
    expect(store.getSnapshot().data?.totals.total).toBe(200)
    expect(store.getSnapshot().data?.gen).toBe(2)

    const afterUpdate = urls.length
    await Bun.sleep(30)
    // 后续探针都带 gen=2 并拿到 204：不再有新的**载荷**请求，但探针本身照发
    expect(urls.slice(afterUpdate).every((u) => u.includes('gen=2'))).toBe(true)
    unsubscribe()
    store.dispose()
  })

  test('★ 后台标签页一个请求都不发，切回前台立刻补一次全量', async () => {
    const vis = fakeVisibility(true)
    const { urls, impl } = hostWithGen({ gen: 1, total: 100 })
    const store = createUsageStore({
      fetch: impl, intervalMs: 5, fullIntervalMs: 10_000_000, now: () => 1_000, visibility: vis.source,
    })
    const unsubscribe = store.subscribe(() => {})
    await settle()
    // 挂载时的首次取数照常发生：面板就在眼前，可见性还没被问过
    const afterMount = urls.length
    expect(afterMount).toBe(1)

    await Bun.sleep(30)
    expect(urls.length).toBe(afterMount) // 后台什么都不做

    vis.set(false)
    await settle()
    // ★ 回前台立刻补一次**全量**取数（随后 intervalMs=5 的探针会紧随其后）
    expect(urls.length).toBeGreaterThan(afterMount)
    expect(urls[afterMount]).not.toContain('gen=')
    unsubscribe()
    store.dispose()
  })

  test('★ 兜底：到了全量周期就真查一次（代次没变也一样）', async () => {
    const { urls, impl } = hostWithGen({ gen: 1, total: 100 })
    let clock = 1_000
    const store = createUsageStore({
      fetch: impl, intervalMs: 5, fullIntervalMs: 50, now: () => clock,
    })
    const unsubscribe = store.subscribe(() => {})
    await settle()

    clock += 100 // 走完一个兜底周期
    await Bun.sleep(20)
    const fullLoads = urls.filter((u) => !u.includes('gen='))
    expect(fullLoads.length).toBe(2) // 首次 + 兜底
    unsubscribe()
    store.dispose()
  })

  test('★ 载荷没有 gen（老宿主）→ 退回兜底周期，绝不 3 秒一次全量', async () => {
    const body = payloadBody()
    delete body['gen']
    const urls: string[] = []
    const store = createUsageStore({
      fetch: async (input) => {
        urls.push(input)
        return { ok: true, status: 200, json: async () => body }
      },
      intervalMs: 5,
      fullIntervalMs: 10_000_000,
      now: () => 1_000,
    })
    const unsubscribe = store.subscribe(() => {})
    await settle()
    await Bun.sleep(30)
    expect(urls.length).toBe(1) // 一个探针都没发
    unsubscribe()
    store.dispose()
  })

  test('探针失败静默：后台检查坏了也不该把面板变红', async () => {
    let first = true
    const urls: string[] = []
    const store = createUsageStore({
      fetch: async (input) => {
        urls.push(input)
        if (first) {
          first = false
          return { ok: true, status: 200, json: async () => payloadBody() }
        }
        return { ok: false, status: 500, json: async () => undefined }
      },
      intervalMs: 5,
      fullIntervalMs: 10_000_000,
      now: () => 1_000,
    })
    const unsubscribe = store.subscribe(() => {})
    await settle()
    await Bun.sleep(30)
    expect(urls.length).toBeGreaterThan(1)
    const state = store.getSnapshot()
    expect(state.error).toBeUndefined() // 探针失败不冒泡
    expect(state.data?.totals.total).toBe(2_392_609_771) // 也没有把已有数字擦掉
    unsubscribe()
    store.dispose()
  })
})

describe('readUiResponse：不可信输入的边界', () => {
  test('缺 totals 一律判失败（宁可报格式错，也不要渲染成一片 0）', () => {
    const result = readUiResponse({ period: 'today', rangeLabel: '今天' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('totals')
  })

  test('非对象 / null 不抛错，返回可读原因', () => {
    expect(readUiResponse(null).ok).toBe(false)
    expect(readUiResponse('nope').ok).toBe(false)
    expect(readUiResponse(42).ok).toBe(false)
  })

  test('字段类型不对时降级成 0，而不是 NaN（NaN 会让页面显示 NaN）', () => {
    const result = readUiResponse(payloadBody({ totals: { total: 'not a number', input: null, output: 5 } }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.totals.total).toBe(0)
      expect(result.payload.totals.input).toBe(0)
      expect(result.payload.totals.output).toBe(5)
    }
  })

  test('缺失的 metrics 降级成全 0，不炸', () => {
    const body = payloadBody()
    delete body['metrics']
    const result = readUiResponse(body)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.metrics.cacheHitRate).toBe(0)
  })

  test('未知 period 回落到默认值', () => {
    const result = readUiResponse(payloadBody({ period: 'this-is-not-a-period' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.period).toBe('today')
  })

  test('未知 source 收敛成 none（不把脏值塞进 UI）', () => {
    const result = readUiResponse(payloadBody({ source: 'wat' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.source).toBe('none')
  })

  test('★ gen：认数字，缺字段/脏值就当没有（浏览器半据此决定要不要发探针）', () => {
    const ok = readUiResponse(payloadBody({ gen: 7 }))
    expect(ok.ok && ok.payload.gen).toBe(7)

    // 0 是**合法**代次（进程刚起来、还没采集到任何用量），不能与「没有」混为一谈
    const zero = readUiResponse(payloadBody({ gen: 0 }))
    expect(zero.ok && zero.payload.gen).toBe(0)

    const missing = payloadBody()
    delete missing['gen']
    const none = readUiResponse(missing)
    expect(none.ok && none.payload.gen).toBeUndefined()

    const dirty = readUiResponse(payloadBody({ gen: 'nan' }))
    expect(dirty.ok && dirty.payload.gen).toBeUndefined()
  })

  test('ok 载荷原样还原四个 token 列', () => {
    const result = readUiResponse(payloadBody())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.totals).toEqual({
        total: 2_392_609_771,
        input: 70_379_895,
        output: 9_754_881,
        cacheRead: 2_312_474_995,
        cacheWrite: 0,
        reasoning: 0,
        calls: 16_437,
      })
    }
  })
})


test('自定义日期在刷新后保留，切预设后不携带旧范围', async () => {
  const urls: string[] = []
  const store = createUsageStore({ fetch: async (url) => {
    urls.push(url)
    return { ok: true, status: 200, json: async () => ({ period: 'custom', totals: {}, metrics: {} }) }
  } })
  store.setCustomRange({ since: '2026-09-01', until: '2026-09-12' })
  await Bun.sleep(5)
  expect(store.getSnapshot().dateRange).toEqual({ since: '2026-09-01', until: '2026-09-12' })
  store.refresh()
  await Bun.sleep(5)
  expect(urls[1]).toContain('since=2026-09-01')
  expect(urls[1]).toContain('until=2026-09-12')
  expect(urls[1]).toContain('refresh=1')
  store.setPeriod('today')
  await Bun.sleep(5)
  expect(urls[2]).not.toContain('since=')
  expect(urls[2]).toContain('period=today')
  const count = urls.length
  store.setCustomRange({ since: '2026-02-30', until: '2026-03-01' })
  expect(urls).toHaveLength(count)
  store.dispose()
})
