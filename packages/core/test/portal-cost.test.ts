/**
 * 上报库金额取数（v7 `model_price`）—— **这一期最需要钉死的几条口径**。
 *
 * ## 为什么单独一个文件
 *
 * 金额这套东西的错误**全都不会报错**：少算一类 token、把未计价当 0、
 * 用「总量 × 均价」代替逐组求和、跨换价时点用一个价 —— 每一种都能给出一个
 * 看起来完全正常的数字。所以这里的用例都是「手算得出来的数」，
 * 而且刻意造出「用错做法也会得到一个数、且与正确值不同」的数据。
 *
 * ## 数据集（全部落在今天，`period=today` 才筛得到）
 *
 * 单价（微元 / 千 token，1 微 = 1e-6 货币单位）：
 *
 * | (provider, model) | 币种 | in | out | cr | cw | 生效区间 |
 * |---|---|---|---|---|---|---|
 * | `dashscope/model-a` | CNY | 1000 | 2000 | 100 | 0 | 自始 → 至今 |
 * | `dashscope/model-b` | CNY | 3000 | 6000 | 300 | 0 | 自始 → 至今 |
 * | `other/model-usd` | **USD** | 500 | 1000 | 50 | 0 | 自始 → 至今 |
 * | `dashscope/model-shift` | CNY | 1000 | 0 | 0 | 0 | 自始 → **12:00 前** |
 * | `dashscope/model-shift` | CNY | **5000** | 0 | 0 | 0 | **12:00** → 至今 |
 *
 * 事件与它**自己时刻**该用的价：
 *
 * | 事件 | (provider, model) | 时刻 | input | output | 金额 |
 * |---|---|---|---|---|---|
 * | `e1` | dashscope/model-a | 09:00 | 1000 | 100 | 1000 + 200 = **1200** 微 |
 * | `e2` | dashscope/model-b | 09:00 | 2000 | 0 | **6000** 微 |
 * | `e3` | other/model-usd | 09:00 | 1000 | 0 | **500** 微（USD） |
 * | `e4` | dashscope/model-shift | 09:00 | 2000 | 0 | **2000** 微（旧价） |
 * | `e5` | dashscope/model-shift | 15:00 | 1000 | 0 | **5000** 微（新价） |
 * | `e6` | dashscope/**unpriced-model** | 09:00 | 700 | 300 | **未计价**（1000 token） |
 *
 * ⇒ CNY = 1200 + 6000 + 2000 + 5000 = **14200**（覆盖 6100 token）
 *   USD = **500**（覆盖 1000 token）；未计价 = **1000** token；总计 8100 token。
 *
 * ★ 特别注意 `model-shift`：同一个 `(provider, model)` 在一个查询窗口里横跨一次换价。
 *   它的正确金额是 **7000**（2000 + 5000）。
 *   - 只用旧价 = 3000 × 1 = 3000；
 *   - 只用新价 = 3000 × 5 = 15000。
 *   三个数互不相同，所以「按事件时刻定价」这件事**是被断言钉住的**，
 *   而不是靠注释承诺的。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { costMicroOf, modelPriceFromWire } from '@ai-token-report/shared'

import { insertAttributedRecords, openPortalStore, type IngestRecord } from '../src/db/index.js'
import { openPortalStats, type PortalStatsSession } from '../src/db/portal.js'
import type { QueryFilter } from '../src/db/query.js'
import { costTotalsQuery, costByDimensionQuery, costByCwdQuery, mapCostRows, type RawCostRow } from '../src/db/query.js'

test('预聚合与原逐事件连接逐列一致：换价边界、未计价、四列与所有 SQL 维度', async () => {
  await seed()
  const store = await openPortalStore({ sqlitePath: dbPath })
  try {
    const prices = PRICES.map((p) => ({ priceId: p.id, ...modelPriceFromWire({
      provider: p.provider, model: p.model, currency: p.currency,
      input_micro_per_ktok: p.input, output_micro_per_ktok: p.output,
      cache_read_micro_per_ktok: p.cacheRead, cache_write_micro_per_ktok: p.cacheWrite,
      effective_from_ms: p.from, effective_to_ms: p.to,
    }) }))
    // 精确边界前、边界上、边界后都必须各自落在正确价格桶。
    await insertAttributedRecords(store, [-1, 0, 1].map((offset, i) => event(`edge-${i}`, {
      seq: 10 + i, ts: NOON + offset, model: 'model-shift',
      input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
    })), { userId: '张三', userName: '张三', groupName: '研发一部' })
    const pairs = [
      [costTotalsQuery(), costTotalsQuery({}, undefined, undefined, prices)],
      [costByCwdQuery(), costByCwdQuery({}, undefined, undefined, prices)],
      ...(['user', 'provider', 'model', 'provider-model', 'source', 'session'] as const)
        .map((dim) => [costByDimensionQuery(dim)!, costByDimensionQuery(dim, {}, undefined, undefined, prices)!]),
    ]
    const ordered = (rows: RawCostRow[]) => mapCostRows(rows).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    for (const [oldQuery, nextQuery] of pairs) {
      expect(ordered(await store.all<RawCostRow>(nextQuery!.sql, nextQuery!.params)))
        .toEqual(ordered(await store.all<RawCostRow>(oldQuery!.sql, oldQuery!.params)))
    }
    const snapshot = costTotalsQuery({}, undefined, undefined, prices)
    const before = ordered(await store.all<RawCostRow>(snapshot.sql, snapshot.params))
    await store.run('DELETE FROM model_price')
    expect(ordered(await store.all<RawCostRow>(snapshot.sql, snapshot.params))).toEqual(before)
    const empty = costTotalsQuery({}, undefined, undefined, [])
    expect(mapCostRows(await store.all<RawCostRow>(empty.sql, empty.params)).every((r) => r.priceId === null)).toBe(true)
  } finally { await store.close() }
})

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-portal-cost-'))
  dbPath = join(home, 'token-report', 'portal.sqlite')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 今天某个时刻（保证落在 `period=today` 窗口内）。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

const T9 = () => todayAt(9)
const T12 = () => todayAt(12)
const T15 = () => todayAt(15)

/** 时间基准只算一次：跨零点会让「今天的 15:00」在测试中途变成过去。 */
const MORNING = T9()
const NOON = T12()
const AFTERNOON = T15()

interface PriceRow {
  id: string
  provider: string
  model: string
  currency: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  from: number
  to: number | null
  note?: string
}

const PRICES: readonly PriceRow[] = [
  { id: '11111111-1111-1111-1111-111111111111', provider: 'dashscope', model: 'model-a', currency: 'CNY', input: 1000, output: 2000, cacheRead: 100, cacheWrite: 0, from: 0, to: null },
  { id: '22222222-2222-2222-2222-222222222222', provider: 'dashscope', model: 'model-b', currency: 'CNY', input: 3000, output: 6000, cacheRead: 300, cacheWrite: 0, from: 0, to: null },
  { id: '33333333-3333-3333-3333-333333333333', provider: 'other', model: 'model-usd', currency: 'USD', input: 500, output: 1000, cacheRead: 50, cacheWrite: 0, from: 0, to: null },
  // 同一个模型的历任价格：区间两端都含，所以第二段从 12:00 整开始、
  // 第一段到 11:59:59.999 结束 —— 相邻区间不留缝也不重叠。
  { id: '44444444-4444-4444-4444-444444444444', provider: 'dashscope', model: 'model-shift', currency: 'CNY', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, from: 0, to: NOON - 1, note: '旧价' },
  { id: '55555555-5555-5555-5555-555555555555', provider: 'dashscope', model: 'model-shift', currency: 'CNY', input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, from: NOON, to: null, note: '新价' },
]

function event(eventId: string, over: Partial<IngestRecord> = {}): IngestRecord {
  return {
    event_id: eventId,
    session_id: 'sess-cost',
    seq: 1,
    ts: MORNING,
    provider: 'dashscope',
    model: 'model-a',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** 造数：5 条单价 + 6 条带归属的事件（都是同一个人，好断言 `by=user`）。 */
async function seed(): Promise<void> {
  const store = await openPortalStore({ sqlitePath: dbPath })
  try {
    const now = MORNING
    for (const price of PRICES) {
      await store.run(
        `INSERT INTO model_price (
           price_id, provider, model, currency,
           input_micro_per_ktok, output_micro_per_ktok,
           cache_read_micro_per_ktok, cache_write_micro_per_ktok,
           effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms
         ) VALUES ($id, $provider, $model, $currency, $input, $output, $cr, $cw, $from, $to, $note, $now, $now)`,
        {
          $id: price.id,
          $provider: price.provider,
          $model: price.model,
          $currency: price.currency,
          $input: price.input,
          $output: price.output,
          $cr: price.cacheRead,
          $cw: price.cacheWrite,
          $from: price.from,
          $to: price.to,
          $note: price.note ?? null,
          $now: now,
        },
      )
    }

    await insertAttributedRecords(
      store,
      [
        event('e1', { seq: 1, input_tokens: 1000, output_tokens: 100 }),
        event('e2', { seq: 2, model: 'model-b', input_tokens: 2000 }),
        event('e3', { seq: 3, provider: 'other', model: 'model-usd', input_tokens: 1000 }),
        event('e4', { seq: 4, model: 'model-shift', input_tokens: 2000 }),
        event('e5', { seq: 5, model: 'model-shift', input_tokens: 1000, ts: AFTERNOON }),
        // 一条价都没配的模型：它必须进 unpriced，**绝不能**被当成 0 元。
        event('e6', { seq: 6, model: 'unpriced-model', input_tokens: 700, output_tokens: 300 }),
      ],
      { userId: '张三', userName: '张三', groupName: '研发一部' },
    )
  } finally {
    await store.close()
  }
}

/** 打开一个**带金额**的会话（等价于调用方有 `cost:read`）。 */
async function withCost<T>(
  fn: (s: PortalStatsSession) => Promise<T> | T,
  filter: QueryFilter = {},
): Promise<T> {
  const session = await openPortalStats({ sqlitePath: dbPath }, filter, undefined, true)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

/** 打开一个**不带金额**的会话（等价于调用方没有 `cost:read`）。 */
async function withoutCost<T>(
  fn: (s: PortalStatsSession) => Promise<T> | T,
  filter: QueryFilter = {},
): Promise<T> {
  const session = await openPortalStats({ sqlitePath: dbPath }, filter)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

describe('金额取数：整体汇总', () => {
  test('★ 先按 (provider, model) 分组算完再求和，不是「总量 × 均价」', async () => {
    await seed()
    const cost = await withCost((s) => s.costTotals())
    expect(cost).not.toBeNull()

    // 按币种分别累加、**绝不跨币种相加**；顺序按币种升序固定。
    expect(cost!.costs).toEqual([
      { currency: 'CNY', amountMicro: 14200, tokens: 6100 },
      { currency: 'USD', amountMicro: 500, tokens: 1000 },
    ])

    // 反面证据：拿总量乘某一个模型的单价**必须不等于** 14200。
    // （任何一个「用均价/某个价乘总量」的实现都会落在这里。）
    const wrong = costMicroOf(
      { input: 8100, output: 0, cacheRead: 0, cacheWrite: 0 },
      { inputMicroPerKtok: 1000, outputMicroPerKtok: 2000, cacheReadMicroPerKtok: 100, cacheWriteMicroPerKtok: 0 },
    )
    expect(wrong).not.toBe(14200)
  })

  test('未计价 token 显式计数、显式给比例，绝不落 0', async () => {
    await seed()
    const cost = await withCost((s) => s.costTotals())

    expect(cost!.totalTokens).toBe(8100)
    expect(cost!.pricedTokens).toBe(7100)
    expect(cost!.unpricedTokens).toBe(1000)
    expect(cost!.pricedRate).toBeCloseTo(7100 / 8100, 10)
    expect(cost!.unpricedRate).toBeCloseTo(1000 / 8100, 10)
    // 两个比例必须能拼回 1：页面上「这笔钱覆盖了多少用量」就靠它。
    expect(cost!.pricedRate + cost!.unpricedRate).toBeCloseTo(1, 10)
  })

  test('未配价的目标清单是可行动的（给出去补哪个价）', async () => {
    await seed()
    const cost = await withCost((s) => s.costTotals())
    expect(cost!.unpricedTargets).toEqual(['dashscope/unpriced-model'])
  })

  test('金额来源随金额一起给出（否则页面上无法说清这份钱按哪份单价算的）', async () => {
    await seed()
    const cost = await withCost((s) => s.costTotals())
    expect(cost!.pricing).toEqual({ pricingSource: 'db', pricingSyncedAt: null })
  })

  test('★ 没有 cost:read 时返回 null —— 「没权限」与「没花钱」必须可区分', async () => {
    await seed()
    const cost = await withoutCost((s) => s.costTotals())
    expect(cost).toBeNull()
  })
})

describe('金额取数：分组维度', () => {
  test('★ 一个分组里横跨换价时，按每条事件自己的时刻定价', async () => {
    await seed()
    const costs = await withCost((s) => s.costByGroup('model'))

    // 正确值 2000（旧价）+ 5000（新价）= 7000。
    // 只用旧价 = 3000、只用新价 = 15000，都与它不同。
    expect(costs.get('model-shift')!.costs).toEqual([{ currency: 'CNY', amountMicro: 7000, tokens: 3000 }])
    expect(costs.get('model-a')!.costs).toEqual([{ currency: 'CNY', amountMicro: 1200, tokens: 1100 }])
    expect(costs.get('model-b')!.costs).toEqual([{ currency: 'CNY', amountMicro: 6000, tokens: 2000 }])
  })

  test('未配价的组给出空币种列表 + 全部未计价（不是 0 元）', async () => {
    await seed()
    const costs = await withCost((s) => s.costByGroup('model'))
    const unpriced = costs.get('unpriced-model')!

    expect(unpriced.costs).toEqual([])
    expect(unpriced.unpricedTokens).toBe(1000)
    expect(unpriced.unpricedRate).toBe(1)
    expect(unpriced.pricedRate).toBe(0)
  })

  test('★ 分组键与 groups(dim) 的 key 逐字相同（金额才能挂到行上）', async () => {
    await seed()
    for (const dim of ['provider', 'model', 'provider-model', 'user', 'group', 'project', 'day'] as const) {
      const keys = await withCost(async (s) => (await s.groups(dim)).map((row) => row.key))
      const costs = await withCost((s) => s.costByGroup(dim))

      if (dim === 'group') {
        // 本数据集**没有造分组目录**（没有 `member_group_assignments`）——
        // 于是「各分组之和 = 0、差额全是未分组人员」：两边都空是**正确**结果，
        // 而不是金额漏算。未分组人员不进任何分组行是定义。
        expect(keys).toEqual([])
        expect(costs.size).toBe(0)
        continue
      }

      expect(keys.length).toBeGreaterThan(0)
      // 每一个有数据的行都必须能取到金额；金额里也不许出现多余的键。
      for (const key of keys) expect(costs.has(key)).toBe(true)
      expect([...costs.keys()].sort()).toEqual([...keys].sort())
    }
  })

  test('by=provider-model 与 by=user 也照同样口径算', async () => {
    await seed()
    const byTarget = await withCost((s) => s.costByGroup('provider-model'))
    expect(byTarget.get('dashscope/model-shift')!.costs).toEqual([
      { currency: 'CNY', amountMicro: 7000, tokens: 3000 },
    ])

    // 全部事件都属于同一个人 → 他那一行的金额就是整体金额。
    const byUser = await withCost(async (s) => {
      const rows = await s.groups('user')
      const costs = await s.costByGroup('user')
      return costs.get(rows[0]!.key)!
    })
    expect(byUser.costs).toEqual([
      { currency: 'CNY', amountMicro: 14200, tokens: 6100 },
      { currency: 'USD', amountMicro: 500, tokens: 1000 },
    ])
  })

  test('by=project 先按 cwd 取金额再按项目名合并', async () => {
    await seed()
    const costs = await withCost((s) => s.costByGroup('project'))
    const rows = await withCost((s) => s.groups('project'))
    const key = rows[0]!.key
    expect(key).toBe('ai-token-report')
    expect(costs.get(key)!.costs).toEqual([
      { currency: 'CNY', amountMicro: 14200, tokens: 6100 },
      { currency: 'USD', amountMicro: 500, tokens: 1000 },
    ])
  })

  test('没有 cost:read 时分组金额是空表（不是一堆 0）', async () => {
    await seed()
    const costs = await withoutCost((s) => s.costByGroup('model'))
    expect(costs.size).toBe(0)
  })
})

describe('金额取数：趋势与明细', () => {
  test('趋势点各自带金额（补零出来的点给全 0，而不是没有字段）', async () => {
    await seed()
    const points = await withCost((s) => s.series('hour', true))

    const withUsage = points.filter((p) => p.counts.calls > 0)
    expect(withUsage.length).toBe(2)
    // 09:00 那一点：e1 1200 + e2 6000 + e3 500(USD) + e4 2000 + e6 未计价
    const nine = withUsage.find((p) => p.counts.input === 6700)!
    expect(nine.cost!.costs).toEqual([
      { currency: 'CNY', amountMicro: 9200, tokens: 5100 },
      { currency: 'USD', amountMicro: 500, tokens: 1000 },
    ])
    expect(nine.cost!.unpricedTokens).toBe(1000)
    // 15:00 那一点只有 e5：新价 5000。
    const fifteen = withUsage.find((p) => p.counts.input === 1000)!
    expect(fifteen.cost!.costs).toEqual([{ currency: 'CNY', amountMicro: 5000, tokens: 1000 }])

    // 补零出来的点：一份「零用量」的金额（币种列表为空），不是 `cost` 缺席。
    for (const point of points) {
      expect(point.cost).toBeDefined()
      if (point.counts.calls === 0) expect(point.cost!.costs).toEqual([])
    }
  })

  test('明细逐条金额：同页同一个模型的两行可以给出不同单价', async () => {
    await seed()
    const page = await withCost((s) => s.records(100, 0))
    const byId = new Map(page.rows.map((row) => [row.eventId, row]))

    expect(byId.get('e1')!.cost).toEqual({ currency: 'CNY', amountMicro: 1200 })
    // 同一个 `(provider, model)`，因为时刻不同用了不同的价。
    expect(byId.get('e4')!.cost).toEqual({ currency: 'CNY', amountMicro: 2000 })
    expect(byId.get('e5')!.cost).toEqual({ currency: 'CNY', amountMicro: 5000 })
    expect(byId.get('e3')!.cost).toEqual({ currency: 'USD', amountMicro: 500 })
    // 未配价：字段在、币种是 null、金额 0 —— 页面据此显示「未计价」而不是「¥0」。
    expect(byId.get('e6')!.cost).toEqual({ currency: null, amountMicro: 0 })
  })

  test('没有 cost:read 时明细行**根本没有** cost 字段（不是 null 也不是 0）', async () => {
    await seed()
    const page = await withoutCost((s) => s.records(100, 0))
    expect(page.rows.length).toBeGreaterThan(0)
    for (const row of page.rows) expect('cost' in row).toBe(false)
  })

  test('没有 cost:read 时趋势点也没有 cost 字段', async () => {
    await seed()
    const points = await withoutCost((s) => s.series('day', true))
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) expect('cost' in point).toBe(false)
  })
})
