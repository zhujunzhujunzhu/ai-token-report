/**
 * 口径公式的固化测试。
 *
 * ★ 这些断言不是「测试代码覆盖率」，而是**把实测结论钉死**。
 *   任何人未来改动 metrics.ts 的公式，这里会立刻失败。
 *
 * 基准数字全部来自 `docs/口径实测结论.md` §2 对 156 个真实会话的实测。
 */

import { describe, expect, test } from 'bun:test'

import {
  addUsage,
  cacheHitRate,
  cacheLeverage,
  computeTotal,
  deriveMetrics,
  emptyUsage,
  unattributedRate,
  verifyIdentity,
  type TokenUsage,
} from '../src/metrics.js'

/** 实测样本：单条 assistant/message（docs/口径实测结论.md §1.3） */
const SAMPLE: TokenUsage = {
  input: 7772,
  output: 186,
  cacheRead: 1024,
  cacheWrite: 0,
  reasoning: 0,
  total: 8982,
}

/** 实测样本：dashscope 全量汇总（docs/口径实测结论.md §2.2） */
const DASHSCOPE_TOTAL: TokenUsage = {
  input: 11_561_323,
  output: 1_815_109,
  cacheRead: 222_614_912,
  cacheWrite: 0,
  reasoning: 0,
  total: 235_991_344,
}

describe('计费恒等式', () => {
  test('单条样本满足 total = input + output + cacheRead + cacheWrite', () => {
    expect(computeTotal(SAMPLE)).toBe(8982)
    expect(verifyIdentity(SAMPLE)).toBe(true)
  })

  test('全量汇总也满足恒等式', () => {
    expect(computeTotal(DASHSCOPE_TOTAL)).toBe(235_991_344)
    expect(verifyIdentity(DASHSCOPE_TOTAL)).toBe(true)
  })

  test('恒等式不成立时 verifyIdentity 返回 false', () => {
    expect(verifyIdentity({ ...SAMPLE, total: 9999 })).toBe(false)
  })

  test('reasoning 不计入恒等式（它是 output 的子集）', () => {
    // 若错误地把 reasoning 加进去，结果会偏大
    const withReasoning: TokenUsage = { ...SAMPLE, reasoning: 500 }
    expect(computeTotal(withReasoning)).toBe(8982)
    expect(verifyIdentity(withReasoning)).toBe(true)
  })
})

describe('缓存命中率', () => {
  // ⚠️ 设计文档里同一时期有两次取样，数字略有差异：
  //   §2.2 → input 11,561,323 / cacheRead 222,614,912 → 94.3%
  //   §4.1 → input 11,544,221 / cacheRead 221,936,640 → 95.1%
  //   两组都是实测值，差异来自取样时点不同。这里用 §2.2 的样本，
  //   断言必须与**本文件使用的数字**自洽，而不是抄文档里的百分比。
  test('与所用样本自洽，落在实测区间 94% ~ 96%', () => {
    const rate = cacheHitRate(DASHSCOPE_TOTAL)
    expect(rate).toBeGreaterThan(0.94)
    expect(rate).toBeLessThan(0.96)
  })

  test('精确值 = cacheRead / (cacheRead + input)', () => {
    const { cacheRead, input } = DASHSCOPE_TOTAL
    expect(cacheHitRate(DASHSCOPE_TOTAL)).toBeCloseTo(cacheRead / (cacheRead + input), 12)
  })

  test('分母是 cacheRead + input，不是 input', () => {
    // 若误用 input 作分母，这条会得到 1024/7772 = 0.13，明显错误
    expect(cacheHitRate(SAMPLE)).toBeCloseTo(1024 / (1024 + 7772), 10)
  })

  test('无调用时返回 0 而不是 NaN（否则前端图表出现空点）', () => {
    const rate = cacheHitRate({ input: 0, cacheRead: 0 })
    expect(rate).toBe(0)
    expect(Number.isNaN(rate)).toBe(false)
  })

  test('全部命中时为 1', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 500 })).toBe(1)
  })
})

describe('缓存杠杆', () => {
  test('实测约 19.3 倍（cacheRead 远大于 input）', () => {
    expect(cacheLeverage(DASHSCOPE_TOTAL)).toBeCloseTo(19.25, 1)
  })

  test('input 为 0 时返回 0 而不是 Infinity', () => {
    expect(cacheLeverage({ input: 0, cacheRead: 500 })).toBe(0)
  })
})

describe('朴素口径的陷阱', () => {
  test('只报 input + output 会漏掉 94.3% 的真实用量', () => {
    const naive = DASHSCOPE_TOTAL.input + DASHSCOPE_TOTAL.output
    const real = DASHSCOPE_TOTAL.total
    // 朴素口径只占真实用量的 5.7%
    expect(naive / real).toBeLessThan(0.06)
    // 即漏掉 94% 以上
    expect(1 - naive / real).toBeGreaterThan(0.94)
  })

  test('误把 cacheRead 加回 input 会虚增约 20 倍', () => {
    const wrong = DASHSCOPE_TOTAL.input + DASHSCOPE_TOTAL.cacheRead
    const right = DASHSCOPE_TOTAL.input
    expect(wrong / right).toBeCloseTo(20.25, 1)
  })
})

describe('累加', () => {
  test('addUsage 逐字段相加', () => {
    const sum = addUsage(SAMPLE, SAMPLE)
    expect(sum.input).toBe(15_544)
    expect(sum.output).toBe(372)
    expect(sum.cacheRead).toBe(2048)
    expect(sum.total).toBe(17_964)
  })

  test('emptyUsage 是加法单位元', () => {
    expect(addUsage(emptyUsage(), SAMPLE)).toEqual(SAMPLE)
  })
})

describe('派生指标', () => {
  test('avgTokensPerCall 与卡口径一致', () => {
    const m = deriveMetrics(DASHSCOPE_TOTAL, 2162)
    expect(m.avgTokensPerCall).toBeCloseTo(235_991_344 / 2162, 0)
    expect(m.total).toBe(235_991_344)
  })

  test('calls 为 0 时 avg 为 0 而不是 NaN', () => {
    expect(deriveMetrics(emptyUsage(), 0).avgTokensPerCall).toBe(0)
  })
})

describe('未归属占比（部门看板的覆盖率监控）', () => {
  test('未归属调用 / 总调用', () => {
    // 100 次调用里 3 次没署名 → 3%
    expect(unattributedRate(3, 100)).toBeCloseTo(0.03, 6)
  })

  test('无调用时返回 0 而不是 NaN', () => {
    // NaN 会让「未归属占比」卡片显示成 NaN%，比 0 更糟
    expect(unattributedRate(0, 0)).toBe(0)
  })

  test('全部未署名时为 1', () => {
    expect(unattributedRate(7, 7)).toBe(1)
  })
})