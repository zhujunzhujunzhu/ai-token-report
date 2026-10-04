/**
 * 离线计价（本地页 / CLI）的取价、折叠与快照读写。
 *
 * ## 这些用例各自在防哪一种误读
 *
 * | 用例 | 防的错误 |
 * |---|---|
 * | 按**事件时刻**取价 | 用「当前价」重算历史用量 —— 换价前后的数都被算错，而看起来正常 |
 * | 未配价的用量进 `unpricedTokens` | 直接跳过 → 「漏配了价」看起来像「省下了钱」 |
 * | 快照坏掉**整份拒绝**并说明原因 | 半份单价表悄悄生效，而 `pricingSyncedAt` 还显示着同步成功 |
 * | 两级 `(provider, model)` 精确匹配 | 一个供应商一个价 → 同供应商下另一半模型必然算错 |
 * | 分组键复用 `groupKey()` | 金额表的键与排行表的键在「项目 / 按天」两维上悄悄错开 |
 *
 * 数据集全部**手算**：单价的整数微元让「正确答案」可以逐位对出来。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelPrice } from '@ai-token-report/shared'
import {
  MAX_UNPRICED_TARGETS,
  PRICING_FILE_NAME,
  costByGroupOf,
  costTotalsOf,
  loadLocalPricing,
  priceResolver,
  recordCostOf,
  unpricedTargetsOf,
  writePricingSnapshot,
} from '../src/db/cost.js'
import type { UsageRecord } from '../src/types.js'

/** 一个 1200 token 的事件：1000 未缓存输入 + 200 输出。 */
function record(over: Partial<UsageRecord> & { time: number }): UsageRecord {
  return {
    source: 'dsh',
    eventId: `s:${over.time}`,
    sessionId: 's',
    seq: 0,
    provider: 'dashscope',
    model: 'model-a',
    cwd: null,
    turn: null,
    step: null,
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1200, calls: 1 },
    ...over,
  }
}

/** `dashscope/model-a`：CNY 1000 微/千（输入）、2000 微/千（输出）。 */
const PRICE_A: ModelPrice = {
  provider: 'dashscope',
  model: 'model-a',
  currency: 'CNY',
  inputMicroPerKtok: 1000,
  outputMicroPerKtok: 2000,
  cacheReadMicroPerKtok: 100,
  cacheWriteMicroPerKtok: 0,
  effectiveFromMs: 0,
  effectiveToMs: null,
}

/** 同一个模型的后半段：输入涨到 5000 微/千。 */
const PRICE_A2: ModelPrice = { ...PRICE_A, inputMicroPerKtok: 5000, effectiveFromMs: 1_000 }

/** 另一家的价：USD。 */
const PRICE_USD: ModelPrice = {
  provider: 'other',
  model: 'model-usd',
  currency: 'USD',
  inputMicroPerKtok: 500,
  outputMicroPerKtok: 1000,
  cacheReadMicroPerKtok: 50,
  cacheWriteMicroPerKtok: 0,
  effectiveFromMs: 0,
  effectiveToMs: null,
}

const DB = {
  pricingSource: 'snapshot',
  pricingSyncedAt: 1_700_000_000_000,
  pricingOrigin: 'http://portal:8787/api/v1/stats/pricing',
} as const

describe('按事件时刻取价', () => {
  test('同一模型的两段区间各取各的价（不是拿一个价算所有历史）', () => {
    const resolve = priceResolver([PRICE_A, PRICE_A2])
    // 1000 微 × 1 千 + 200 微 × … 逐位手算：
    // 输入 1000 token、单价 1000 微/千 = 1000 微；输出 200 token、单价 2000 微/千 = 400 微。
    expect(recordCostOf(record({ time: 500 }), resolve)).toEqual({ currency: 'CNY', amountMicro: 1400 })
    // 换价后：输入 5000 微/千 = 5000 微（其余不变）。
    expect(recordCostOf(record({ time: 1_500 }), resolve)).toEqual({ currency: 'CNY', amountMicro: 5400 })
  })

  test('没配价的 (provider, model) 返回 currency=null（不是 0 元）', () => {
    const resolve = priceResolver([PRICE_A])
    expect(recordCostOf(record({ time: 0, model: 'unpriced-model' }), resolve)).toEqual({
      currency: null,
      amountMicro: 0,
    })
  })

  test('粒度是 (provider, model) 精确匹配：换供应商不命中', () => {
    const resolve = priceResolver([PRICE_A])
    // 同名模型、不同供应商 —— 不命中，而不是「按名字猜一个」。
    expect(resolve('other', 'model-a', 0)).toBeNull()
    // 大小写不同也不命中（上报原值精确匹配）。
    expect(resolve('DashScope', 'model-a', 0)).toBeNull()
  })
})

describe('折叠成 CostTotals', () => {
  const records = [
    record({ time: 500 }), // 1400 微 CNY
    record({ time: 1_500 }), // 5400 微 CNY
    record({ time: 0, provider: 'other', model: 'model-usd', usage: { input: 2000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2000, calls: 1 } }),
    record({ time: 0, model: 'unpriced-model' }), // 1200 token 未计价
  ]

  test('多币种各自累加、绝不换算也绝不相加', () => {
    const totals = costTotalsOf(records, priceResolver([PRICE_A, PRICE_A2, PRICE_USD]), DB)
    expect(totals.costs).toEqual([
      { currency: 'CNY', amountMicro: 6800, tokens: 2400 },
      // other/model-usd：输入 2000 token × 500 微/千 = 1000 微
      { currency: 'USD', amountMicro: 1000, tokens: 2000 },
    ])
    expect(totals.pricedTokens).toBe(4400)
    expect(totals.unpricedTokens).toBe(1200)
    expect(totals.totalTokens).toBe(5600)
    expect(totals.unpricedRate).toBeCloseTo(1200 / 5600, 10)
  })

  test('★ 一条价都没配上的用量计入 unpricedTokens，而不是被丢掉', () => {
    const totals = costTotalsOf(
      [record({ time: 0, model: 'unpriced-model' })],
      priceResolver([PRICE_A]),
      DB,
    )
    expect(totals.costs).toEqual([])
    expect(totals.unpricedTokens).toBe(1200)
    expect(totals.unpricedRate).toBe(1)
  })

  test('金额带上「按哪份单价算的」（换来源会让金额变，必须能分辨）', () => {
    const totals = costTotalsOf(records, priceResolver([PRICE_A, PRICE_A2, PRICE_USD]), DB)
    expect(totals.pricing).toEqual(DB)
  })
})

describe('按维度取金额', () => {
  test('键与 core 的分组键逐字相同（provider / model / day）', () => {
    const resolve = priceResolver([PRICE_A, PRICE_USD])
    const records = [
      record({ time: Date.UTC(2026, 0, 2, 4) }),
      record({ time: Date.UTC(2026, 0, 3, 4) }),
      record({ time: Date.UTC(2026, 0, 3, 5), provider: 'other', model: 'model-usd' }),
    ]
    const byProvider = costByGroupOf(records, 'provider', resolve, DB)
    expect([...byProvider.keys()].sort()).toEqual(['dashscope', 'other'])
    expect(byProvider.get('dashscope')!.costs).toEqual([
      { currency: 'CNY', amountMicro: 2800, tokens: 2400 },
    ])

    const byModel = costByGroupOf(records, 'model', resolve, DB)
    expect([...byModel.keys()].sort()).toEqual(['model-a', 'model-usd'])

    // 按天：两天的键与 `aggregate.ts` 的 `toDayKey()` 一致（本地时区），
    // 所以这里只断言「两个不同的桶、且合计等于总量」。
    const byDay = costByGroupOf(records, 'day', resolve, DB)
    expect(byDay.size).toBe(2)
    const cny = [...byDay.values()].reduce(
      (sum, entry) => sum + (entry.costs[0]?.amountMicro ?? 0),
      0,
    )
    expect(cny).toBe(2800)
  })

  test('未配价的组照样出现（只是金额为空、未计价为满）', () => {
    const byModel = costByGroupOf(
      [record({ time: 0, model: 'unpriced-model' })],
      'model',
      priceResolver([PRICE_A]),
      DB,
    )
    expect(byModel.get('unpriced-model')!.costs).toEqual([])
    expect(byModel.get('unpriced-model')!.unpricedRate).toBe(1)
  })
})

describe('未配价清单', () => {
  test('去重、排序、可截断，且只列真的一条价都没配上的目标', () => {
    const records = [
      record({ time: 0, model: 'b' }),
      record({ time: 1, model: 'a' }),
      record({ time: 2, model: 'b' }),
      record({ time: 3 }), // 有价
      record({ time: 4, provider: 'other', model: 'c' }),
    ]
    const targets = unpricedTargetsOf(records, priceResolver([PRICE_A]))
    // 字典序（`dashscope/a` < `dashscope/b` < `other/c`），不是出现顺序。
    expect(targets).toEqual(['dashscope/a', 'dashscope/b', 'other/c'])
    expect(unpricedTargetsOf(records, priceResolver([PRICE_A]), 1)).toEqual(['dashscope/a'])
    expect(MAX_UNPRICED_TARGETS).toBe(20)
  })
})

describe('离线单价快照', () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'atr-pricing-'))
  }

  test('★ 没有数据目录：就是「没有价」（`none`），不给任何兜底价', () => {
    const pricing = loadLocalPricing({})
    expect(pricing.provenance).toEqual({
      pricingSource: 'none',
      pricingSyncedAt: null,
      pricingOrigin: null,
    })
    // 🚨 空价表是**刻意的**：2026-10 起本仓不再内置任何价目表（`BUILTIN_PRICES` 已删），
    //   所以这里绝不能再冒出一份「看起来正常」的价 —— 那正是被删掉的那个东西。
    expect(pricing.prices).toEqual([])
    expect(pricing.note).toContain('没有可用的单价')
    expect(pricing.path).toBeNull()
  })

  test('快照不存在：没有价，且 note 里给出要同步的文件路径', () => {
    const dir = scratch()
    try {
      const pricing = loadLocalPricing({ dataDir: dir })
      expect(pricing.provenance.pricingSource).toBe('none')
      expect(pricing.prices).toEqual([])
      expect(pricing.note).toContain(join(dir, PRICING_FILE_NAME))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('★ 快照坏掉：整份拒绝 + 明确给出「重新 pricing sync」这个动作', () => {
    const dir = scratch()
    try {
      writeFileSync(join(dir, PRICING_FILE_NAME), '{ 这不是 JSON', 'utf8')
      const pricing = loadLocalPricing({ dataDir: dir })
      expect(pricing.provenance.pricingSource).toBe('none')
      expect(pricing.prices).toEqual([])
      expect(pricing.note).toContain('解析失败')
      expect(pricing.note).toContain('pricing sync')
      expect(pricing.note).toContain('不显示金额')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('半份合法的快照也被拒（不做部分接受）', () => {
    const dir = scratch()
    try {
      // 第二条价缺 `effectiveFromMs` —— 只有整份拒绝才不会让「半份表」生效。
      writeFileSync(
        join(dir, PRICING_FILE_NAME),
        JSON.stringify({
          syncedAtMs: 1,
          prices: [
            { ...PRICE_A, inputMicroPerKtok: 1000 },
            { provider: 'x', model: 'y', currency: 'CNY' },
          ],
        }),
        'utf8',
      )
      const pricing = loadLocalPricing({ dataDir: dir })
      expect(pricing.provenance.pricingSource).toBe('none')
      expect(pricing.prices).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('写入 → 读回：来源是 snapshot，带上同步时刻与端点', () => {
    const dir = scratch()
    try {
      writePricingSnapshot(join(dir, PRICING_FILE_NAME), {
        syncedAtMs: 1_700_000_000_000,
        endpoint: 'http://portal:8787/api/v1/stats/pricing',
        prices: [PRICE_A2, PRICE_USD, PRICE_A],
      })
      const pricing = loadLocalPricing({ dataDir: dir })
      expect(pricing.provenance).toEqual({
        pricingSource: 'snapshot',
        pricingSyncedAt: 1_700_000_000_000,
        pricingOrigin: 'http://portal:8787/api/v1/stats/pricing',
      })
      expect(pricing.note).toBeNull()
      expect(pricing.prices.map((p) => `${p.provider}/${p.model}@${p.effectiveFromMs}`)).toEqual([
        'dashscope/model-a@0',
        'dashscope/model-a@1000',
        'other/model-usd@0',
      ])
      // 原子替换：不留临时文件（留下的 `.tmp` 会让下一次排障多一个疑点）。
      expect(readdirSync(dir)).toEqual([PRICING_FILE_NAME])
      // 落盘排序稳定：同一份价写两次得到逐字节相同的文件。
      const first = readFileSync(join(dir, PRICING_FILE_NAME), 'utf8')
      writePricingSnapshot(join(dir, PRICING_FILE_NAME), {
        syncedAtMs: 1_700_000_000_000,
        endpoint: 'http://portal:8787/api/v1/stats/pricing',
        prices: [PRICE_USD, PRICE_A, PRICE_A2],
      })
      expect(readFileSync(join(dir, PRICING_FILE_NAME), 'utf8')).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('显式给出文件时优先于数据目录（手工拷来的快照）', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'custom-prices.json')
      writePricingSnapshot(file, { syncedAtMs: 42, prices: [PRICE_A] })
      const pricing = loadLocalPricing({ dataDir: join(dir, '不存在的数据目录'), file })
      expect(pricing.provenance.pricingSyncedAt).toBe(42)
      expect(pricing.path).toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
