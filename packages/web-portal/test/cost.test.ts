/**
 * 金额展示层格式化的单测。
 *
 * ## 为什么值得单测
 *
 * 这些函数的全部风险集中在**三种「没有数」不能长得一样**：
 *
 * | 情况 | 期望显示 |
 * |---|---|
 * | 没有 `cost:read`（字段缺席） | 什么都不显示（由调用方判） |
 * | 有权限、没配价（`costs: []`） | **「未计价」**，不是 `¥0` |
 * | 有权限、有金额 | `¥1.23`（多币种用 ` + ` 连接，绝不相加） |
 *
 * 第三种与前两种一旦混淆，「漏配了价」就会看起来像「省下了钱」——
 * 那是这一期最危险的误读，而它不会报错。
 */

import { describe, expect, test } from 'bun:test'
import type { StatsCost, StatsCostTotals } from '@ai-token-report/shared'
import {
  COST_LABEL,
  UNPRICED_TEXT,
  costSeriesOf,
  costText,
  costTickFormatter,
  currencyText,
  pricingHint,
  provenanceText,
  singleCurrency,
  unpricedTargetsText,
  unpricedText,
} from '../src/utils/cost.js'

const provenance = { pricingSource: 'db', pricingSyncedAt: null } as const

function totals(over: Partial<StatsCostTotals> = {}): StatsCostTotals {
  return {
    costs: [],
    pricedTokens: 0,
    unpricedTokens: 0,
    totalTokens: 0,
    pricedRate: 0,
    unpricedRate: 0,
    pricing: provenance,
    ...over,
  }
}

describe('金额文本', () => {
  test('字段缺席（无 cost:read）→ null，由调用方决定不显示', () => {
    expect(costText(undefined)).toBeNull()
    expect(costText(null)).toBeNull()
  })

  test('★ 一个价都没配上 → null（不是 ¥0.00）', () => {
    expect(costText(totals({ unpricedTokens: 1000, totalTokens: 1000, unpricedRate: 1 }))).toBeNull()
    expect(UNPRICED_TEXT).toBe('未计价')
  })

  test('单币种：微元按 shared 的规则格式化成货币', () => {
    const cost = totals({ costs: [{ currency: 'CNY', amountMicro: 1_234_567, tokens: 100 }] })
    expect(costText(cost)).toBe('¥1.23')
  })

  test('★ 多币种用 ` + ` 连接，绝不相加（汇率是第二个口径）', () => {
    const cost = totals({
      costs: [
        { currency: 'CNY', amountMicro: 1_000_000, tokens: 10 },
        { currency: 'USD', amountMicro: 500_000, tokens: 20 },
      ],
    })
    const text = costText(cost)!
    // 两个币种各自格式化（< 1 时 4 位小数），再拼接。
    expect(text).toBe('¥1.00 + $0.5000')
    // 反面证据：相加会得到一个「两种货币加在一起」的数，而它没有意义。
    expect(text).not.toContain('1.5')
  })

  test('currencyText 用总额格式（小数位按「一笔账」定），与单价格式是两个函数', () => {
    expect(currencyText(1_234_567, 'CNY')).toBe('¥1.23')
    // ★ 同一个 50 微元：总额口径是「一笔 5e-5 的钱」，四舍五入到 4 位显示；
    //   单价口径按「元 / 百万 token」呈现（50 微元/千 = ¥0.05 / 百万），与总额是两个
    //   不同的单位，混用会差 500 倍（见 `unit-price.test.ts` 里那条「不能复用总额那个函数」）。
    //   页面上的**整数微元**（`amountMicro`）始终是精确值，格式化只影响显示。
    expect(currencyText(50, 'CNY')).toBe('¥0.0001')
    expect(currencyText(50, 'USD')).toBe('$0.0001')
    // 非 ISO 三位码原样带前缀，不假装认识它。
    expect(currencyText(1_000_000, 'RMB')).toBe('RMB 1.00')
  })

  test('singleCurrency 只在确实只有一个币种时给币种', () => {
    expect(singleCurrency([{ currency: 'CNY', amountMicro: 1, tokens: 1 }])).toBe('CNY')
    expect(singleCurrency([])).toBeNull()
    expect(
      singleCurrency([
        { currency: 'CNY', amountMicro: 1, tokens: 1 },
        { currency: 'USD', amountMicro: 1, tokens: 1 },
      ]),
    ).toBeNull()
  })
})

describe('未计价的措辞', () => {
  test('没有未计费用量时不显示这一栏（不显示一个恒为 0 的东西）', () => {
    expect(unpricedText(totals())).toBeNull()
    expect(unpricedText(undefined)).toBeNull()
  })

  test('有未计费用量时给出比例', () => {
    const cost = totals({ unpricedTokens: 1000, totalTokens: 8000, unpricedRate: 0.125 })
    expect(unpricedText(cost)).toBe('未计价 12.5%')
  })

  test('★ 未计价一定排在说明的最前面（这一屏最需要被看见的一句话）', () => {
    const hint = pricingHint(totals({ unpricedTokens: 100, totalTokens: 100, unpricedRate: 1 }))
    expect(hint.startsWith('未计价')).toBe(true)
    expect(hint).toContain('按服务端数据库中的单价现算')
  })

  test('没有未计费用量时只说明单价来源', () => {
    expect(pricingHint(totals())).toBe('按服务端数据库中的单价现算')
  })

  test('单价来源三种取值都有人话（缺字段时不许渲染成空）', () => {
    expect(provenanceText({ pricingSource: 'db', pricingSyncedAt: null })).toBe('按服务端数据库中的单价现算')
    expect(provenanceText({ pricingSource: 'snapshot', pricingSyncedAt: 1 })).toBe('按本地单价快照现算')
    // 'none' = 一条价都没有。文案必须说「没有可用的单价」，绝不写成「按 0 元算」。
    expect(provenanceText({ pricingSource: 'none', pricingSyncedAt: null })).toBe('没有可用的单价')
    expect(provenanceText(null)).toBe('按服务端数据库中的单价现算')
  })

  test('未配价清单转成一句可行动的话', () => {
    const cost: StatsCost = {
      ...totals({ unpricedTokens: 1, totalTokens: 2, unpricedRate: 0.5 }),
      unpricedTargets: ['dashscope/model-x', 'other/model-y'],
    }
    expect(unpricedTargetsText(cost)).toBe('这些模型还没配单价：dashscope/model-x、other/model-y')
    expect(unpricedTargetsText({ ...cost, unpricedTargets: [] })).toBeNull()
    // 排行行上的金额没有这个字段（它是概览专有的）——此时返回 null 而不是炸掉。
    expect(unpricedTargetsText(totals())).toBeNull()
  })

  test('未配价清单最多列 3 个，其余折成「等 N 个」（卡片说明不是清单页）', () => {
    const targets = ['p/a', 'p/b', 'p/c', 'p/d', 'p/e']
    const cost: StatsCost = {
      ...totals({ unpricedTokens: 1, totalTokens: 2, unpricedRate: 0.5 }),
      unpricedTargets: targets,
    }
    expect(unpricedTargetsText(cost)).toBe('这些模型还没配单价：p/a、p/b、p/c 等 5 个')
  })

  test('卡片说明把「未计价 → 单价来源 → 缺哪个价」串成一句，顺序固定', () => {
    const cost: StatsCost = {
      ...totals({ unpricedTokens: 1000, totalTokens: 8000, unpricedRate: 0.125 }),
      unpricedTargets: ['p/a'],
    }
    expect(pricingHint(cost)).toBe(
      '未计价 12.5% · 按服务端数据库中的单价现算 · 这些模型还没配单价：p/a',
    )
  })
})

describe('趋势图的金额序列', () => {
  const point = (cost?: StatsCostTotals) => (cost ? { cost } : {})

  test('整段没有 cost 字段（无 cost:read）→ null，页面连指标选项都不出现', () => {
    expect(costSeriesOf([point(), point()])).toBeNull()
    expect(costSeriesOf([])).toBeNull()
  })

  test('单币种：逐点取该币种的微元，顺序与点一致（缺金额的点是 0）', () => {
    const series = costSeriesOf([
      point(totals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 10 }] })),
      // 补零出来的点也带一份空金额（服务端刻意如此，见 portal.ts）
      point(totals()),
      point(totals({ costs: [{ currency: 'CNY', amountMicro: 5000, tokens: 10 }] })),
    ])!
    expect(series.currency).toBe('CNY')
    expect(series.values).toEqual([1200, 0, 5000])
    expect(series.label).toBe(COST_LABEL)
    expect(series.disabledReason).toBeNull()
  })

  test('★ 多币种：不画线、也不挑一个币种偷偷画，而是给出原因', () => {
    const series = costSeriesOf([
      point(totals({
        costs: [
          { currency: 'CNY', amountMicro: 1200, tokens: 10 },
          { currency: 'USD', amountMicro: 500, tokens: 5 },
        ],
      })),
    ])!
    expect(series.currency).toBeNull()
    expect(series.disabledReason).toContain('2 种币种')
    expect(series.disabledReason).toContain('CNY / USD')
    expect(series.disabledReason).toContain('绝不跨币种相加')
  })

  test('★ 一条价都没配上：不画一条全 0 的线（那看起来像「没花钱」）', () => {
    const series = costSeriesOf([point(totals({ unpricedTokens: 100, totalTokens: 100, unpricedRate: 1 }))])!
    expect(series.currency).toBeNull()
    expect(series.disabledReason).toContain('未计价不等于 0 元')
  })

  test('刻度格式化把微元显示成货币（数值仍是服务端原值）', () => {
    const format = costTickFormatter('CNY')
    expect(format(1_234_567)).toBe('¥1.23')
    expect(format(0)).toBe('¥0.00')
  })
})