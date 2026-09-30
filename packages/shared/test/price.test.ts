/**
 * 计价口径的固化测试。
 *
 * ★ 与 `metrics.test.ts` 同一个目的：把**实测与官方价目**钉死，
 *   而不是「测覆盖率」。任何人改 `price.ts` 的公式，这里会立刻失败。
 *
 * 基准数字来自：
 * - `docs/口径实测结论.md` §2.2 的 dashscope 全量汇总（token 侧）
 * - DeepSeek 官方定价页的高峰档报价（单价侧，见 `price.ts` 的注释）
 */

import { describe, expect, test } from 'bun:test'

import {
  BUILTIN_PRICES,
  MAX_MICRO_PER_KTOK,
  MAX_SAFE_BILLABLE_TOKENS,
  cacheSavingMicro,
  costMicroForTokens,
  costMicroOf,
  findPriceConflicts,
  formatCostMicro,
  formatCostSummary,
  isPriceEffective,
  isValidPriceRates,
  normalizeCurrency,
  parsePricingSnapshot,
  priceRangesOverlap,
  resolvePrice,
  summarizeCosts,
  unpricedRate,
  type BillableUsage,
  type ModelPrice,
} from '../src/price.js'

/** 实测样本：dashscope 全量汇总（`docs/口径实测结论.md` §2.2）。 */
const DASHSCOPE_USAGE: BillableUsage = {
  input: 11_561_323,
  output: 1_815_109,
  cacheRead: 222_614_912,
  cacheWrite: 0,
}

/**
 * DeepSeek Flash 高峰档单价，直接由官方「每 1M token 美元价」换算：
 * cache hit $0.006 / cache miss $0.3 / output $1.2 → 6 / 300 / 1200 微元每千。
 */
const FLASH: ModelPrice = {
  provider: 'deepseek-official',
  model: 'deepseek-v4.1-flash',
  currency: 'USD',
  inputMicroPerKtok: 300,
  outputMicroPerKtok: 1200,
  cacheReadMicroPerKtok: 6,
  cacheWriteMicroPerKtok: 0,
  effectiveFromMs: 0,
  effectiveToMs: null,
}

describe('单价单位换算（微元/千 token）', () => {
  test('$0.3 / 1M tokens 就是 300 微元/千', () => {
    // 1M token × 300 微元/千 = 1000 千 × 300 = 300,000 微元 = $0.3
    expect(costMicroForTokens(1_000_000, 300)).toBe(300_000)
  })

  test('官方 Flash 三档换算与定价页一致', () => {
    expect(FLASH.inputMicroPerKtok / 1000).toBe(0.3) // $0.3 / 1M
    expect(FLASH.outputMicroPerKtok / 1000).toBe(1.2) // $1.2 / 1M
    expect(FLASH.cacheReadMicroPerKtok / 1000).toBe(0.006) // $0.006 / 1M
  })
})

describe('单类 token 计价', () => {
  test('结果永远是整数（金额不容许浮点累加）', () => {
    for (const tokens of [1, 999, 1000, 1001, 123_456_789]) {
      expect(Number.isInteger(costMicroForTokens(tokens, 300))).toBe(true)
    }
  })

  test('余数按四舍五入，不丢也不多算', () => {
    expect(costMicroForTokens(500, 300)).toBe(150) // 500×300/1000 = 150
    expect(costMicroForTokens(999, 300)).toBe(300) // 299.7 → 300
    expect(costMicroForTokens(1, 300)).toBe(0) // 0.3 → 0
  })

  test('0 token / 0 单价 / 负数 一律为 0', () => {
    expect(costMicroForTokens(0, 300)).toBe(0)
    expect(costMicroForTokens(1000, 0)).toBe(0)
    expect(costMicroForTokens(-5000, 300)).toBe(0)
  })

  test('★ 在允许的单价与 token 量级内永不越 MAX_SAFE_INTEGER', () => {
    const result = costMicroForTokens(MAX_SAFE_BILLABLE_TOKENS, MAX_MICRO_PER_KTOK)
    expect(Number.isSafeInteger(result)).toBe(true)
    expect(result).toBe((MAX_SAFE_BILLABLE_TOKENS / 1000) * MAX_MICRO_PER_KTOK)
  })

  test('★ 本部门真实量级（23.9 亿 token × 最贵单价）离边界很远', () => {
    const maxBuiltin = Math.max(...BUILTIN_PRICES.map((p) => p.outputMicroPerKtok))
    expect(2_392_609_771).toBeLessThan(MAX_SAFE_BILLABLE_TOKENS)
    expect(Number.isSafeInteger(costMicroForTokens(2_392_609_771, maxBuiltin))).toBe(true)
  })

  test('★ 越过安全量级时抛错，而不是返回一个已经丢精度的钱数', () => {
    expect(() => costMicroForTokens(1_000_000_000_000, MAX_MICRO_PER_KTOK)).toThrow(RangeError)
    expect(() => costMicroForTokens(MAX_SAFE_BILLABLE_TOKENS * 10, MAX_MICRO_PER_KTOK)).toThrow(RangeError)
  })
})

describe('四类分价（★ 不可合并）', () => {
  // 逐项手算：
  //   input   11,561,323 @300  → 11561×300 + round(323×300/1000) = 3,468,300 + 97
  //   output   1,815,109 @1200 → 1815×1200 + round(109×1200/1000) = 2,178,000 + 131
  //   cacheRead 222,614,912 @6 → 222614×6 + round(912×6/1000)     = 1,335,684 + 5
  test('实测样本逐项求和 = 6,982,217 微元（$6.98）', () => {
    expect(costMicroForTokens(DASHSCOPE_USAGE.input, 300)).toBe(3_468_397)
    expect(costMicroForTokens(DASHSCOPE_USAGE.output, 1200)).toBe(2_178_131)
    expect(costMicroForTokens(DASHSCOPE_USAGE.cacheRead, 6)).toBe(1_335_689)
    expect(costMicroOf(DASHSCOPE_USAGE, FLASH)).toBe(6_982_217)
  })

  test('★ 用「单一价」计费会虚增约 10 倍', () => {
    const correct = costMicroOf(DASHSCOPE_USAGE, FLASH)
    // 错误做法：把四类 token 都按未命中输入价（最贵的档之一）算
    const flat: ModelPrice = {
      ...FLASH,
      cacheReadMicroPerKtok: FLASH.inputMicroPerKtok,
      outputMicroPerKtok: FLASH.inputMicroPerKtok,
    }
    const wrong = costMicroOf(DASHSCOPE_USAGE, flat)
    expect(wrong / correct).toBeGreaterThan(9)
  })

  test('cacheWrite 单独计价（本 provider 恒为 0，但字段必须独立参与）', () => {
    const usage: BillableUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000 }
    expect(costMicroOf(usage, { ...FLASH, cacheWriteMicroPerKtok: 500 })).toBe(500)
  })
})

describe('缓存省下的钱', () => {
  test('等于「按未命中输入价」与「按缓存价」之差', () => {
    // 66,784,474 − 1,335,689 = 65,448,785 微元 ≈ $65.45
    expect(cacheSavingMicro(DASHSCOPE_USAGE, FLASH)).toBe(65_448_785)
  })

  test('缓存比输入更贵时返回负数，不截断', () => {
    const odd = { ...FLASH, cacheReadMicroPerKtok: 900 }
    expect(cacheSavingMicro(DASHSCOPE_USAGE, odd)).toBeLessThan(0)
  })
})

describe('未定价占比（★ 最重要的护栏）', () => {
  test('未定价 token / 总 token', () => {
    expect(unpricedRate(3, 100)).toBeCloseTo(0.03, 6)
  })

  test('无数据时返回 0 而不是 NaN', () => {
    expect(unpricedRate(0, 0)).toBe(0)
  })

  test('全部未定价时为 1', () => {
    expect(unpricedRate(7, 7)).toBe(1)
  })
})

describe('单价解析：精确匹配 + 生效区间', () => {
  const at = 1_000

  test('精确命中 provider + model', () => {
    expect(resolvePrice([FLASH], 'deepseek-official', 'deepseek-v4.1-flash', at)).toBe(FLASH)
  })

  test('★ 不做子串匹配（否则 preview 模型会被套上正式版价格）', () => {
    expect(resolvePrice([FLASH], 'deepseek-official', 'deepseek-v4.1', at)).toBeNull()
    expect(resolvePrice([FLASH], 'deepseek-official', 'deepseek-v4.1-flash-preview', at)).toBeNull()
    expect(resolvePrice([FLASH], 'deepseek-official-x', 'deepseek-v4.1-flash', at)).toBeNull()
  })

  test('生效区间两端都含', () => {
    const bounded: ModelPrice = { ...FLASH, effectiveFromMs: 100, effectiveToMs: 200 }
    expect(isPriceEffective(bounded, 100)).toBe(true)
    expect(isPriceEffective(bounded, 200)).toBe(true)
    expect(isPriceEffective(bounded, 99)).toBe(false)
    expect(isPriceEffective(bounded, 201)).toBe(false)
  })

  test('区间外解析不到单价（历史费用按当时价算，不按今天价）', () => {
    const bounded: ModelPrice = { ...FLASH, effectiveFromMs: 100, effectiveToMs: 200 }
    expect(resolvePrice([bounded], FLASH.provider, FLASH.model, 50)).toBeNull()
    expect(resolvePrice([bounded], FLASH.provider, FLASH.model, 500)).toBeNull()
  })

  test('调价后同一模型按事件时间取对应那一档', () => {
    const old = { ...FLASH, inputMicroPerKtok: 300, effectiveFromMs: 0, effectiveToMs: 999 }
    const fresh = { ...FLASH, inputMicroPerKtok: 150, effectiveFromMs: 1000, effectiveToMs: null }
    expect(resolvePrice([old, fresh], FLASH.provider, FLASH.model, 500)?.inputMicroPerKtok).toBe(300)
    expect(resolvePrice([old, fresh], FLASH.provider, FLASH.model, 1000)?.inputMicroPerKtok).toBe(150)
  })
})

describe('单价冲突（写入前唯一校验，页面与接口共用）', () => {
  test('区间相交才冲突', () => {
    const a = { effectiveFromMs: 0, effectiveToMs: 100 }
    expect(priceRangesOverlap(a, { effectiveFromMs: 50, effectiveToMs: 150 })).toBe(true)
    expect(priceRangesOverlap(a, { effectiveFromMs: 101, effectiveToMs: 150 })).toBe(false)
  })

  test('★ 恰好共用端点也算冲突（该时点会同时命中两行）', () => {
    expect(priceRangesOverlap({ effectiveFromMs: 0, effectiveToMs: 100 }, { effectiveFromMs: 100, effectiveToMs: 200 })).toBe(true)
  })

  test('null（至今）与任何后续区间都冲突', () => {
    const open: ModelPrice = { ...FLASH, effectiveFromMs: 0, effectiveToMs: null }
    expect(findPriceConflicts([open], { ...FLASH, effectiveFromMs: 5_000, effectiveToMs: null })).toHaveLength(1)
  })

  test('不同 model / provider 不冲突', () => {
    expect(findPriceConflicts([FLASH], { ...FLASH, model: 'other-model' })).toHaveLength(0)
    expect(findPriceConflicts([FLASH], { ...FLASH, provider: 'other-provider' })).toHaveLength(0)
  })

  test('★ 同模型同区间但币种不同是冲突（否则取哪一行取决于兜底顺序）', () => {
    expect(findPriceConflicts([FLASH], { ...FLASH, currency: 'CNY' })).toHaveLength(1)
  })

  test('★ 同模型改价必须切区间，不能并列', () => {
    const repriced = { ...FLASH, inputMicroPerKtok: 150 }
    expect(findPriceConflicts([FLASH], repriced)).toHaveLength(1)
    // 切成「旧的到今天为止、新的从今天开始」——
    // 共用端点仍算冲突，所以必须真的错开 1 毫秒
    expect(findPriceConflicts([{ ...FLASH, effectiveToMs: 1_000 }], { ...repriced, effectiveFromMs: 1_001 })).toHaveLength(0)
  })
})

describe('汇总：绝不跨币种相加', () => {
  test('有价 + 无价 → 覆盖率可解释', () => {
    const summary = summarizeCosts([
      { usage: DASHSCOPE_USAGE, price: FLASH },
      { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000 }, price: null },
    ])
    expect(summary.costs).toHaveLength(1)
    expect(summary.costs[0]).toEqual({ currency: 'USD', amountMicro: 6_982_217, tokens: 235_991_344 })
    expect(summary.pricedTokens).toBe(235_991_344)
    expect(summary.unpricedTokens).toBe(1_000)
    expect(summary.totalTokens).toBe(235_992_344)
    expect(summary.pricedRate + summary.unpricedRate).toBeCloseTo(1, 12)
  })

  test('★ 两种币种各自成项，不相加也不换算', () => {
    const cny = { ...FLASH, currency: 'CNY', inputMicroPerKtok: 2_000, outputMicroPerKtok: 8_000, cacheReadMicroPerKtok: 40 }
    const summary = summarizeCosts([
      { usage: DASHSCOPE_USAGE, price: FLASH },
      { usage: DASHSCOPE_USAGE, price: cny },
    ])
    expect(summary.costs.map((c) => c.currency)).toEqual(['CNY', 'USD'])
    expect(summary.costs[0]!.amountMicro).not.toBe(summary.costs[1]!.amountMicro)
    // 两个币种的 token 各自统计，总量是两份
    expect(summary.totalTokens).toBe(235_991_344 * 2)
  })

  test('币种顺序确定（双后端逐位对账要逐字比对 JSON）', () => {
    const usd = FLASH
    const cny = { ...FLASH, currency: 'CNY' }
    const eur = { ...FLASH, currency: 'EUR' }
    const forward = summarizeCosts([{ usage: DASHSCOPE_USAGE, price: usd }, { usage: DASHSCOPE_USAGE, price: eur }, { usage: DASHSCOPE_USAGE, price: cny }])
    const backward = summarizeCosts([{ usage: DASHSCOPE_USAGE, price: cny }, { usage: DASHSCOPE_USAGE, price: eur }, { usage: DASHSCOPE_USAGE, price: usd }])
    expect(forward).toEqual(backward)
    expect(forward.costs.map((c) => c.currency)).toEqual(['CNY', 'EUR', 'USD'])
  })

  test('全部未定价 → 没有任何币种，而不是 $0.00', () => {
    const summary = summarizeCosts([{ usage: DASHSCOPE_USAGE, price: null }])
    expect(summary.costs).toEqual([])
    expect(summary.pricedRate).toBe(0)
    expect(summary.unpricedRate).toBe(1)
    expect(formatCostSummary(summary.costs)).toBeNull()
  })

  test('空输入不产生 NaN', () => {
    const summary = summarizeCosts([])
    expect(summary.totalTokens).toBe(0)
    expect(summary.pricedRate).toBe(0)
    expect(summary.unpricedRate).toBe(0)
  })
})

describe('金额格式化（四个形态共用一份）', () => {
  test('大于 1 用两位小数', () => {
    expect(formatCostMicro(6_982_217, 'USD')).toBe('$6.98')
  })

  test('★ 小于 1 用四位小数（两位会把 $0.0032 显示成 $0.00）', () => {
    expect(formatCostMicro(3_200, 'USD')).toBe('$0.0032')
  })

  test('零值仍是两位小数（有价但极小，与「无金额」不同）', () => {
    expect(formatCostMicro(0, 'USD')).toBe('$0.00')
  })

  test('币种符号与未知币种回退', () => {
    expect(formatCostMicro(1_500_000, 'CNY')).toBe('¥1.50')
    expect(formatCostMicro(1_500_000, 'SGD')).toBe('SGD 1.50')
  })

  test('多币种用 + 连接（不相加）', () => {
    expect(formatCostSummary([
      { currency: 'CNY', amountMicro: 2_000_000, tokens: 1 },
      { currency: 'USD', amountMicro: 6_982_217, tokens: 1 },
    ])).toBe('¥2.00 + $6.98')
  })
})

describe('币种归一化', () => {
  test('小写与空白被归一化，非法格式拒绝', () => {
    expect(normalizeCurrency(' usd ')).toBe('USD')
    expect(normalizeCurrency('Cny')).toBe('CNY')
    expect(normalizeCurrency('US')).toBeNull()
    expect(normalizeCurrency('USDD')).toBeNull()
    expect(normalizeCurrency(1)).toBeNull()
  })
})

describe('单价合法性', () => {
  test('非负整数且在范围内', () => {
    expect(isValidPriceRates(FLASH)).toBe(true)
    expect(isValidPriceRates({ ...FLASH, inputMicroPerKtok: -1 })).toBe(false)
    expect(isValidPriceRates({ ...FLASH, inputMicroPerKtok: 1.5 })).toBe(false)
    expect(isValidPriceRates({ ...FLASH, inputMicroPerKtok: MAX_MICRO_PER_KTOK + 1 })).toBe(false)
    expect(isValidPriceRates({ ...FLASH, outputMicroPerKtok: Number.NaN })).toBe(false)
  })
})

describe('离线单价快照解析', () => {
  const snapshotText = JSON.stringify({ syncedAtMs: 1_700_000_000_000, endpoint: 'https://p.example.com', prices: [FLASH] })

  test('合法快照往返一致', () => {
    const parsed = parsePricingSnapshot(snapshotText)
    expect(parsed?.syncedAtMs).toBe(1_700_000_000_000)
    expect(parsed?.endpoint).toBe('https://p.example.com')
    expect(parsed?.prices).toHaveLength(1)
    expect(parsed?.prices[0]).toEqual(FLASH)
  })

  test('币种小写被归一化', () => {
    const text = JSON.stringify({ syncedAtMs: 1, prices: [{ ...FLASH, currency: 'usd' }] })
    expect(parsePricingSnapshot(text)?.prices[0]?.currency).toBe('USD')
  })

  test('★ 一行非法则整份拒绝（不做部分接受）', () => {
    const text = JSON.stringify({ syncedAtMs: 1, prices: [FLASH, { ...FLASH, inputMicroPerKtok: 'x' }] })
    expect(parsePricingSnapshot(text)).toBeNull()
  })

  test('坏 JSON / 缺字段 / 类型错 一律 null', () => {
    expect(parsePricingSnapshot('{')).toBeNull()
    expect(parsePricingSnapshot('[]')).toBeNull()
    expect(parsePricingSnapshot(JSON.stringify({ prices: [] }))).toBeNull()
    expect(parsePricingSnapshot(JSON.stringify({ syncedAtMs: 1, prices: 'x' }))).toBeNull()
    expect(parsePricingSnapshot(JSON.stringify({ syncedAtMs: 1, prices: [{ ...FLASH, currency: 'US' }] }))).toBeNull()
  })
})

describe('内置种子价', () => {
  test('每一条都是合法单价与合法币种', () => {
    for (const price of BUILTIN_PRICES) {
      expect(isValidPriceRates(price)).toBe(true)
      expect(normalizeCurrency(price.currency)).toBe(price.currency)
      expect(price.provider).not.toBe('')
      expect(price.model).not.toBe('')
    }
  })

  test('暂无相互冲突的行', () => {
    for (const [index, price] of BUILTIN_PRICES.entries()) {
      expect(findPriceConflicts(BUILTIN_PRICES.slice(0, index), price)).toHaveLength(0)
    }
  })

  test('★ 刻意不收录 dashscope：没有可核对的 CNY 报价，留空好过编造', () => {
    expect(BUILTIN_PRICES.some((p) => p.provider === 'dashscope')).toBe(false)
  })
})