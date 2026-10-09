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
  ANY_PROVIDER,
  MAX_MICRO_PER_KTOK,
  MAX_SAFE_BILLABLE_TOKENS,
  cacheSavingMicro,
  costMicroForTokens,
  costMicroOf,
  costMicroOfDistribution,
  findPriceConflicts,
  findPriceSchedule,
  formatCostMicro,
  formatCostSummary,
  formatUnitPriceMicro,
  isPriceEffective,
  isValidPriceRates,
  modelPriceFromWire,
  normalizeCurrency,
  offpeakConfigError,
  parsePricingSnapshot,
  priceRangesOverlap,
  priceRatesAt,
  priceSlotAt,
  resolvePrice,
  summarizeCosts,
  unpricedRate,
  type BillableUsage,
  type ModelPrice,
  type PriceRates,
} from '../src/price.js'
/** 命名空间导入：用来钉「本仓不得再有内置价目表」这条（见文件末尾的 ★ 断言）。 */
import * as priceModule from '../src/price.js'

test('余数分布逐位保留每事件的微元舍入；整批乘价会得到不同结果', () => {
  const rates = { inputMicroPerKtok: 7, outputMicroPerKtok: 19, cacheReadMicroPerKtok: 3, cacheWriteMicroPerKtok: 11 }
  const rows = Array.from({ length: 4000 }, (_, i) => ({ input: i * 37 % 3001, output: i * 17 % 2039, cacheRead: i * 997 % 8101, cacheWrite: i % 89 }))
  const sums: BillableUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const hist = Array.from({ length: 4 }, () => new Map<number, number>())
  for (const row of rows) (['input', 'output', 'cacheRead', 'cacheWrite'] as const).forEach((key, i) => {
    sums[key] += row[key]
    const rest = row[key] % 1000
    if (rest) hist[i]!.set(rest, (hist[i]!.get(rest) ?? 0) + 1)
  })
  const expected = rows.reduce((sum, row) => sum + costMicroOf(row, rates), 0)
  expect(costMicroOfDistribution(sums, rates, hist.map(column => [...column]))).toBe(expected)
  expect(costMicroOf(sums, rates)).not.toBe(expected)
  // 补价以后仍能重算，无需存金额或重建汇总。
  for (const inputMicroPerKtok of [0, 1, 500, 1001, 33333]) {
    const price = { ...rates, inputMicroPerKtok }
    expect(costMicroOfDistribution(sums, price, hist.map(column => [...column])))
      .toBe(rows.reduce((sum, row) => sum + costMicroOf(row, price), 0))
  }
  expect(() => costMicroOfDistribution(sums, rates, [[], [], [], []])).toThrow('余数')
})

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
 *
 * ⚠️ 这里刻意留 USD：夹具里**必须不止一个币种**，否则「多币种各自累加、绝不相加」
 *   那条口径验不出来 —— 拿 CNY 当这个夹具会让那几条断言退化成同币种自比。
 *   人民币那侧的实测金额由下面 `CNY_FLASH` 提供（同一条官方价的人民币档）。
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

/**
 * 同一条官方价的人民币高峰档：cache hit ¥0.04 / cache miss ¥2 / output ¥8
 * → 40 / 2000 / 8000 微元每千（= 「元 / 百万 token」× 1000）。
 */
const CNY_FLASH: ModelPrice = { ...FLASH, currency: 'CNY', inputMicroPerKtok: 2_000, outputMicroPerKtok: 8_000, cacheReadMicroPerKtok: 40 }

describe('单价单位换算（微元/千 token）', () => {
  test('$0.3 / 1M tokens 就是 300 微元/千，¥2 / 1M tokens 就是 2000 微元/千', () => {
    // 1M token × 300 微元/千 = 1000 千 × 300 = 300,000 微元 = $0.3
    expect(costMicroForTokens(1_000_000, 300)).toBe(300_000)
    // 1M token × 2000 微元/千 = 2,000,000 微元 = ¥2
    expect(costMicroForTokens(1_000_000, 2_000)).toBe(2_000_000)
  })

  test('官方 Flash 三档换算与定价页一致（元 / 百万 token ÷ 1000 = 微元 / 千 token）', () => {
    expect(FLASH.inputMicroPerKtok / 1000).toBe(0.3) // $0.3 / 1M
    expect(FLASH.outputMicroPerKtok / 1000).toBe(1.2) // $1.2 / 1M
    expect(FLASH.cacheReadMicroPerKtok / 1000).toBe(0.006) // $0.006 / 1M
    expect(CNY_FLASH.inputMicroPerKtok / 1000).toBe(2) // ¥2 / 1M
    expect(CNY_FLASH.outputMicroPerKtok / 1000).toBe(8) // ¥8 / 1M
    expect(CNY_FLASH.cacheReadMicroPerKtok / 1000).toBe(0.04) // ¥0.04 / 1M
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
    // 最贵单价不再来自内置价目表（已删），而是**录入路径的上限** ——
    // 这才是「真实录入」能碰到的最坏情况，比任何一份具体价目表都严格。
    expect(2_392_609_771).toBeLessThan(MAX_SAFE_BILLABLE_TOKENS)
    expect(Number.isSafeInteger(costMicroForTokens(2_392_609_771, MAX_MICRO_PER_KTOK))).toBe(true)
  })

  test('★ 越过安全量级时抛错，而不是返回一个已经丢精度的钱数', () => {
    expect(() => costMicroForTokens(1_000_000_000_000, MAX_MICRO_PER_KTOK)).toThrow(RangeError)
    expect(() => costMicroForTokens(MAX_SAFE_BILLABLE_TOKENS * 10, MAX_MICRO_PER_KTOK)).toThrow(RangeError)
  })
})

describe('四类分价（★ 不可合并）', () => {
  // 逐项手算（美元档：300 / 1200 / 6 微元每千）：
  //   input   11,561,323 @300  → 11561×300 + round(323×300/1000) = 3,468,300 + 97
  //   output   1,815,109 @1200 → 1815×1200 + round(109×1200/1000) = 2,178,000 + 131
  //   cacheRead 222,614,912 @6 → 222614×6 + round(912×6/1000)     = 1,335,684 + 5
  test('实测样本逐项求和 = 6,982,217 微元（$6.98）', () => {
    expect(costMicroForTokens(DASHSCOPE_USAGE.input, 300)).toBe(3_468_397)
    expect(costMicroForTokens(DASHSCOPE_USAGE.output, 1200)).toBe(2_178_131)
    expect(costMicroForTokens(DASHSCOPE_USAGE.cacheRead, 6)).toBe(1_335_689)
    expect(costMicroOf(DASHSCOPE_USAGE, FLASH)).toBe(6_982_217)
  })

  test('同一条用量按人民币档算 = 46,548,114 微元（¥46.55）', () => {
    // 人民币档贵约 6.67 倍（¥2/百万 ≈ $0.28/百万），正是「同一份用量、两个币种两个数」的实证。
    expect(costMicroOf(DASHSCOPE_USAGE, CNY_FLASH)).toBe(46_548_114)
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
    // 人民币档的输入价是 2000 微元/千，缓存读必须贵过它才会出现「缓存反而更贵」。
    const odd = { ...FLASH, cacheReadMicroPerKtok: 2_500 }
    expect(cacheSavingMicro(DASHSCOPE_USAGE, odd)).toBeLessThan(0)
  })

  test('同一份用量在人民币档下的节省额（¥436.33）', () => {
    // 222,614,912 × 2000/1000 = 445,229,824；减去按缓存价的 8,904,596 = 436,325,228 微元。
    expect(cacheSavingMicro(DASHSCOPE_USAGE, CNY_FLASH)).toBe(436_325_228)
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

  test('★ 基础价与同名模型的专属价**可以共存**（专属优先，两者不算冲突）', () => {
    const base: ModelPrice = { ...FLASH, provider: ANY_PROVIDER }
    expect(findPriceConflicts([base], { ...FLASH, provider: 'dashscope' })).toHaveLength(0)
    expect(findPriceConflicts([{ ...FLASH, provider: 'dashscope' }], base)).toHaveLength(0)
  })

  test('★ 两条基础价覆盖同一时刻是冲突（否则一条事件会匹配两行、token 翻倍）', () => {
    const base: ModelPrice = { ...FLASH, provider: ANY_PROVIDER }
    expect(findPriceConflicts([base], { ...base, currency: 'CNY' })).toHaveLength(1)
    // 不同模型的两条基础价互不影响
    expect(findPriceConflicts([base], { ...base, model: 'other' })).toHaveLength(0)
  })
})

describe('基础价（不限供应商）★ v10：专属优先、基础兜底', () => {
  const base: ModelPrice = { ...FLASH, provider: ANY_PROVIDER, inputMicroPerKtok: 111 }
  const exact: ModelPrice = { ...FLASH, provider: 'dashscope', inputMicroPerKtok: 222 }

  test('没有专属价时用基础价（这正是「不选供应商」的语义）', () => {
    expect(resolvePrice([base], 'dashscope', FLASH.model, 0)).toBe(base)
    expect(resolvePrice([base], 'deepseek-official', FLASH.model, 0)).toBe(base)
  })

  test('★ 专属价优先', () => {
    expect(resolvePrice([base, exact], 'dashscope', FLASH.model, 0)).toBe(exact)
    // 另一个供应商仍然落到基础价
    expect(resolvePrice([base, exact], 'bailian-tpp', FLASH.model, 0)).toBe(base)
  })

  test('基础价也受生效区间约束（补历史价时不改写更早的用量）', () => {
    const bounded: ModelPrice = { ...base, effectiveFromMs: 100 }
    expect(resolvePrice([bounded], 'dashscope', FLASH.model, 99)).toBeNull()
    expect(resolvePrice([bounded], 'dashscope', FLASH.model, 100)).toBe(bounded)
  })

  test('基础价**不做子串匹配**：模型名仍要逐字一致', () => {
    expect(resolvePrice([base], 'dashscope', `${FLASH.model}-preview`, 0)).toBeNull()
  })

  test('两条候选基础价时取生效起点更晚的那条（行为可预测，不看库返回顺序）', () => {
    const early: ModelPrice = { ...base, effectiveFromMs: 0, effectiveToMs: 500 }
    const late: ModelPrice = { ...base, effectiveFromMs: 400, effectiveToMs: null }
    // 这个组合本该被写入路径拒掉（重叠），真出现时也要给出确定的结果
    expect(resolvePrice([early, late], 'dashscope', FLASH.model, 450)).toBe(late)
    expect(resolvePrice([early, late], 'dashscope', FLASH.model, 100)).toBe(early)
  })
})

/**
 * 闲时（低谷）时段 —— v10 的核心口径。
 *
 * ★ 这里的每个时点都写清了「北京时间的哪一天几点」，并对应用例名里的星期几：
 *   时段表是**固定偏移 + 星期几 + 分钟**，任何一处改错都会落到这几条断言上。
 */
describe('闲时（低谷）时段 ★ v10（与 SQL 里的镜像表达式同一份时段表）', () => {
  /** 北京时间 → epoch 毫秒（固定 UTC+8，中国没有夏令时）。 */
  const bj = (year: number, month: number, day: number, hour: number, minute = 0): number =>
    Date.UTC(year, month - 1, day, hour - 8, minute)

  const OFFPEAK_RATES: PriceRates = { inputMicroPerKtok: 1_000, outputMicroPerKtok: 4_000, cacheReadMicroPerKtok: 20, cacheWriteMicroPerKtok: 0 }
  const PRICE: ModelPrice = { ...FLASH, offpeakRates: OFFPEAK_RATES, offpeakSchedule: 'deepseek-cn' }

  test('北京时间工作日 09:00–12:00、14:00–18:00 是高峰（2026-03-02 周一）', () => {
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 9, 0))).toBe('peak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 11, 59))).toBe('peak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 14, 0))).toBe('peak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 17, 59))).toBe('peak')
  })

  test('★ 窗口是半开区间：12:00 整与 18:00 整已经是闲时，08:59 与 13:59 也是', () => {
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 8, 59))).toBe('offpeak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 12, 0))).toBe('offpeak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 13, 59))).toBe('offpeak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 18, 0))).toBe('offpeak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 2, 0, 29))).toBe('offpeak')
  })

  test('★ 周末全天闲时（2026-03-07 周六、2026-03-08 周日）', () => {
    expect(priceSlotAt(PRICE, bj(2026, 3, 7, 10, 0))).toBe('offpeak')
    expect(priceSlotAt(PRICE, bj(2026, 3, 8, 15, 0))).toBe('offpeak')
  })

  test('★ 法定节假日整天闲时 —— 即使落在工作日的高峰窗里（2026-02-17 周二，春节假期）', () => {
    expect(priceSlotAt(PRICE, bj(2026, 2, 17, 10, 0))).toBe('offpeak')
    // 同一天的同一时刻、假期之外（2026-03-03 周二）则是高峰
    expect(priceSlotAt(PRICE, bj(2026, 3, 3, 10, 0))).toBe('peak')
    // 国庆假期里的工作日（2026-10-01 周四 起 7 天）
    expect(priceSlotAt(PRICE, bj(2026, 10, 6, 15, 0))).toBe('offpeak')
  })

  test('没有闲时档 / 时段表未知 ⇒ 恒为高峰（那四个数一个都用不上）', () => {
    expect(priceSlotAt({ ...FLASH, offpeakRates: OFFPEAK_RATES }, bj(2026, 3, 2, 10, 0))).toBe('peak')
    expect(priceSlotAt({ ...FLASH, offpeakRates: OFFPEAK_RATES, offpeakSchedule: '不存在' }, bj(2026, 3, 2, 10, 0))).toBe('peak')
    expect(priceSlotAt({ ...FLASH, offpeakSchedule: 'deepseek-cn' }, bj(2026, 3, 2, 3, 0))).toBe('peak')
  })

  test('★ priceRatesAt 换的是**整组四类价**，不是乘一个折扣系数', () => {
    // 高峰档给的就是这条价自己的四类数（返回的是同一个对象，不拷贝）
    expect(priceRatesAt(PRICE, bj(2026, 3, 2, 10, 0))).toBe(PRICE)
    expect(priceRatesAt(PRICE, bj(2026, 3, 2, 10, 0)).inputMicroPerKtok).toBe(FLASH.inputMicroPerKtok)
    // 闲时档换成另一组四类数（不是「在高峰价上打折」）
    expect(priceRatesAt(PRICE, bj(2026, 3, 2, 3, 0))).toBe(OFFPEAK_RATES)
    // 四类各自独立：闲时价里缓存读也减半，而不是「只有输入打折」
    expect(costMicroOf({ input: 1_000, output: 1_000, cacheRead: 1_000, cacheWrite: 0 }, priceRatesAt(PRICE, bj(2026, 3, 2, 3, 0))))
      .toBe(1_000 + 4_000 + 20)
  })

  test('★ 汇总路径按 SQL 判好的时段取价（rate 覆盖 price 的四类数）', () => {
    const summary = summarizeCosts([
      { usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }, price: PRICE, rates: OFFPEAK_RATES },
    ])
    expect(summary.costs).toEqual([{ currency: 'USD', amountMicro: 1_000, tokens: 1_000 }])
  })
})

describe('闲时配置校验（半套配置必须被拒）', () => {
  const RATES: PriceRates = { inputMicroPerKtok: 1, outputMicroPerKtok: 1, cacheReadMicroPerKtok: 1, cacheWriteMicroPerKtok: 1 }

  test('全空 = 合法（这条价不分时段）', () => {
    expect(offpeakConfigError({ offpeakRates: null, offpeakSchedule: null })).toBeNull()
    expect(offpeakConfigError({})).toBeNull()
  })

  test('四类价 + 已知时段表 = 合法', () => {
    expect(offpeakConfigError({ offpeakRates: RATES, offpeakSchedule: 'deepseek-cn' })).toBeNull()
  })

  test('★ 只有一半（缺时段表或缺价）必须给出原因，绝不放行', () => {
    expect(offpeakConfigError({ offpeakRates: RATES, offpeakSchedule: null })).toContain('闲时时段')
    expect(offpeakConfigError({ offpeakRates: null, offpeakSchedule: 'deepseek-cn' })).toContain('闲时四类单价')
    expect(offpeakConfigError({ offpeakRates: RATES, offpeakSchedule: '未知表' })).toContain('未知的闲时时段')
    expect(offpeakConfigError({ offpeakRates: { ...RATES, inputMicroPerKtok: 1.5 }, offpeakSchedule: 'deepseek-cn' })).toContain('整数微元')
  })
})

describe('闲时时段表（deepseek-cn）', () => {
  test('★ 时段的节假日表覆盖到期日必须写出来（过期会静默按高峰计）', () => {
    const schedule = findPriceSchedule('deepseek-cn')
    expect(schedule).not.toBeNull()
    expect(schedule!.holidaysThrough).toBe('2026-12-31')
    // 表里的节假日必须都落在覆盖区间内，且都是合法日期（顺序无关）
    for (const date of schedule!.holidays) {
      expect(date >= schedule!.holidaysFrom && date <= schedule!.holidaysThrough, date).toBe(true)
    }
    // 2026 年春节 / 国庆的头一天必须在表里（抽样，防止整段被误删）
    expect(schedule!.holidays).toContain('2026-02-17')
    expect(schedule!.holidays).toContain('2026-10-01')
    // 空闲档的时段表 id 必须在注册表里（否则那四类价永远不生效）
    expect(findPriceSchedule('deepseek-cn')!.utcOffsetMinutes).toBe(480)
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

describe('单价格式化（每百万 token，与价目表同单位）', () => {
  test('★ 呈现的是「元 / 百万 token」原值，库里那个整数除以 1000', () => {
    // 官方 Flash 高峰价：2000 微元/千 = ¥2 / 百万 token（人可以直接照着价目表核对）。
    expect(formatUnitPriceMicro(2_000, 'CNY')).toBe('¥2 / 百万 token')
    expect(formatUnitPriceMicro(200, 'CNY')).toBe('¥0.2 / 百万 token')
    expect(formatUnitPriceMicro(40, 'CNY')).toBe('¥0.04 / 百万 token')
    expect(formatUnitPriceMicro(27_000, 'CNY')).toBe('¥27 / 百万 token')
  })

  test('★ 不能用总额那个函数：50 微元/千 token 是 ¥0.05/百万，不是 0.0001', () => {
    // 把单价交给 `formatCostMicro()` 会得到 `¥0.0001` —— 一个**差 500 倍**、
    // 且看起来完全正常的数字。这就是两个格式化函数必须分开的原因。
    expect(formatUnitPriceMicro(50, 'CNY')).toBe('¥0.05 / 百万 token')
    expect(formatCostMicro(50, 'CNY')).toBe('¥0.0001')
  })

  test('整数微元能被精确写出，末尾的 0 裁掉', () => {
    expect(formatUnitPriceMicro(1, 'CNY')).toBe('¥0.001 / 百万 token')
    expect(formatUnitPriceMicro(1, 'USD')).toBe('$0.001 / 百万 token')
    expect(formatUnitPriceMicro(25_000, 'USD')).toBe('$25 / 百万 token')
    expect(formatUnitPriceMicro(10_000_000, 'USD')).toBe('$10000 / 百万 token')
  })

  test('零价显示成 0（免费），不是空字符串', () => {
    expect(formatUnitPriceMicro(0, 'CNY')).toBe('¥0 / 百万 token')
  })

  test('未知币种回退成代码前缀', () => {
    expect(formatUnitPriceMicro(2_000, 'SGD')).toBe('SGD 2 / 百万 token')
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
    // 快照走的是 `ModelPrice` 的 camelCase 形状：没有闲时档就是两个 `null`
    // （写盘时也照原样落 `null`，读回来仍是「不分时段」）。
    expect(parsed?.prices[0]).toEqual({ ...FLASH, offpeakRates: null, offpeakSchedule: null })
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

describe('线上单价 → 内存形态（映射只有一份）', () => {
  /**
   * 这个函数是**唯一**的 snake_case → camelCase 映射：服务端从数据库行取价
   * （先经 `modelPriceFromRow()` 归一驱动返回值）与 CLI `pricing sync`
   * 从 HTTP 取价都走它。各写一份的结果不会报错 —— 只会让「NULL 表示至今有效」
   * 在其中一处变成 `0`（一个合法的、早已过去的终点），那条价从此匹配不上任何事件，
   * 而金额看起来只是「少算了点」。
   */
  const wire = {
    provider: 'dashscope',
    model: 'm-1',
    currency: 'CNY',
    input_micro_per_ktok: 1000,
    output_micro_per_ktok: 2000,
    cache_read_micro_per_ktok: 100,
    cache_write_micro_per_ktok: 0,
    effective_from_ms: 500,
    effective_to_ms: null,
  }

  test('字段逐项改名，值原样搬运', () => {
    expect(modelPriceFromWire(wire)).toEqual({
      provider: 'dashscope',
      model: 'm-1',
      currency: 'CNY',
      inputMicroPerKtok: 1000,
      outputMicroPerKtok: 2000,
      cacheReadMicroPerKtok: 100,
      cacheWriteMicroPerKtok: 0,
      effectiveFromMs: 500,
      effectiveToMs: null,
      // ★ v10 闲时档：老服务端的响应里**根本没有这几个字段**，
      //   归一成 `null` = 「这条价不分时段」，而不是「闲时四类价都是 0 元」。
      offpeakRates: null,
      offpeakSchedule: null,
    })
  })

  test('★ effective_to_ms = null 必须保持 null（绝不当成 0）', () => {
    const open = modelPriceFromWire(wire)
    expect(open.effectiveToMs).toBeNull()
    // `0` 是「早就结束了」：这条价在 1 之后就不再生效 —— 与「至今有效」完全相反。
    expect(isPriceEffective(open, 10_000)).toBe(true)

    // 显式给了终点就照原样，且到点即失效
    const bounded = modelPriceFromWire({ ...wire, effective_to_ms: 900 })
    expect(bounded.effectiveToMs).toBe(900)
    expect(isPriceEffective(bounded, 900)).toBe(true)
    expect(isPriceEffective(bounded, 901)).toBe(false)
  })

  test('货币不在这里归一（那是快照文件的事）', () => {
    // 线上字段来自 `model_price.currency`（有 `^[A-Z]{3}$` 的 CHECK），
    // 而归一化只该发生在「磁盘上的快照」这条不受数据库约束的入口。
    expect(modelPriceFromWire({ ...wire, currency: 'usd' }).currency).toBe('usd')
  })
})

describe('★ 本仓不得再有内置价目表', () => {
  test('`BUILTIN_PRICES` 已删除，且不得换个名字加回来', () => {
    // 它只覆盖 `deepseek-official` 的三个模型名，算出来的金额「看起来正常」，
    // 却既不是看板的数也不是账单的数 —— 2026-10 删除。
    // 要价目表请走 `model_price` 表（`db`）或 `pricing.json` 快照（`snapshot`）；
    // 两者都没有就是 `pricingSource === 'none'`，展示层一位金额都不渲染。
    expect('BUILTIN_PRICES' in priceModule).toBe(false)
    expect(Object.keys(priceModule).filter((key) => /PRICES$|^SEED/i.test(key))).toEqual([])
  })
})
