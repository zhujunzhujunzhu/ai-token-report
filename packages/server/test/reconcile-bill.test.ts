/**
 * 月度账单对账脚本的单测（S8）。
 *
 * ## 这个文件在防什么
 *
 * 对账脚本的错误**全都不会报错**，而且每一种的表现都是「一份看起来很正常的报告」：
 *
 * | 写错的地方 | 看起来像 |
 * |---|---|
 * | 窗口少算一天 | 「差额很小，基本对上了」 |
 * | 跳过坏行 | 「完全一致」 |
 * | 未计价当 0 | 「我们花的比账单少，省了钱」 |
 * | 账单为 0 时占比回落成 0 | 「在阈值内」 |
 * | 跨币种相加 | 一个**任何汇率都不成立**的数 |
 *
 * 所以这里的用例大多是「手算得出来的数」，并且刻意让**错误做法也会得到一个数**、
 * 且与正确值不同。
 *
 * ## 两类用例
 *
 * 1. **纯函数**：CSV 解析 / 自然月窗口 / 报告组装。不碰数据库，跑得快。
 * 2. **真底座**：造一个真的 v7 SQLite 上报库（`preparePortalDatabase` +
 *    `insertAttributedRecords` + `model_price`），走 `openPortalStats(..., true)`
 *    取金额，再交给 `buildReport()`。否则「脚本里的数字是不是从真底座来的」
 *    完全没被验证 —— 而它恰恰是这个脚本唯一的数据来源。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  insertAttributedRecords,
  openPortalStats,
  openPortalStore,
  preparePortalDatabase,
  type CostTotals,
  type CostTotalsWithTargets,
  type IngestRecord,
} from '@ai-token-report/core/db'

import {
  assertPortalTargetExists,
  buildReport,
  displayWidth,
  monthWindow,
  parseArgs,
  parseBillCsv,
  portalTargetFrom,
  ReconcileInputError,
  selectBillRows,
  type EstimateSide,
  type MonthWindow,
} from '../scripts/reconcile-bill.js'

// ---------------------------------------------------------------------------
// 纯函数用的构造器
// ---------------------------------------------------------------------------

/** 一份「一月」的窗口：账单是按自然月出的，所以所有用例都钉在同一个固定月份上。 */
const JAN = monthWindow('2026-01')

function makeTotals(over: Partial<CostTotalsWithTargets> = {}): CostTotalsWithTargets {
  return {
    costs: [],
    pricedTokens: 0,
    unpricedTokens: 0,
    totalTokens: 0,
    pricedRate: 0,
    unpricedRate: 0,
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
    unpricedTargets: [],
    ...over,
  }
}

function makeTarget(currency: string, amountMicro: number, tokens = 1000): CostTotals {
  return {
    costs: [{ currency, amountMicro, tokens }],
    pricedTokens: tokens,
    unpricedTokens: 0,
    totalTokens: tokens,
    pricedRate: 1,
    unpricedRate: 0,
    pricing: { pricingSource: 'db', pricingSyncedAt: null },
  }
}

function reportOf(
  estimate: EstimateSide,
  csv: string,
  options: { tolerancePercent?: number; window?: MonthWindow } = {},
) {
  const window = options.window ?? JAN
  return buildReport({
    period: window.period,
    window,
    source: '测试用上报库',
    billPath: '/tmp/bill.csv',
    estimate,
    billRows: parseBillCsv(csv),
    tolerancePercent: options.tolerancePercent ?? 0.5,
  })
}

/** 从报告里取某个币种那一行（取不到直接失败，避免「undefined 断言通过」）。 */
function lineOf(report: ReturnType<typeof buildReport>, currency: string) {
  const line = report.currencies.find((item) => item.currency === currency)
  if (!line) throw new Error(`报告里没有 ${currency} 这一行`)
  return line
}

// ---------------------------------------------------------------------------
// 1. 账单 CSV
// ---------------------------------------------------------------------------

describe('账单 CSV：表头顺序固定，可选列按序可缺席', () => {
  test('三列（只有总额行）→ 全部是 monthRows', () => {
    const rows = parseBillCsv('period,currency,amount\n2026-01,CNY,0.0012\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ period: '2026-01', currency: 'CNY', amountMicro: 1200, provider: null, model: null })
  })

  test('六列（逐目标行）→ provider/model 都带上，note 可空', () => {
    const rows = parseBillCsv('period,currency,amount,provider,model,note\n2026-01,CNY,0.0012,dashscope,model-a,一月\n')
    expect(rows[0]).toMatchObject({ provider: 'dashscope', model: 'model-a', note: '一月' })
  })

  test('★ Excel 导出的 BOM + CRLF 必须能用（不去 BOM 会把首列表头变成 "\\uFEFFperiod"）', () => {
    const rows = parseBillCsv('\uFEFFperiod,currency,amount\r\n2026-01,CNY,0.0012\r\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.currency).toBe('CNY')
  })

  test('★ 引号里的逗号不能被当成分隔符（备注里写「含逗号,的备注」）', () => {
    const rows = parseBillCsv('period,currency,amount,provider,model,note\n2026-01,CNY,0.0012,a,b,"含逗号,的备注"\n')
    expect(rows[0]!.note).toBe('含逗号,的备注')
    expect(rows[0]!.provider).toBe('a')
  })

  test('负数是合法的（退款 / 冲销）', () => {
    const rows = parseBillCsv('period,currency,amount\n2026-01,CNY,-0.0012\n')
    expect(rows[0]!.amountMicro).toBe(-1200)
  })

  test('空行跳过，不算坏行', () => {
    const rows = parseBillCsv('period,currency,amount\n\n2026-01,CNY,0.0012\n\n')
    expect(rows).toHaveLength(1)
  })
})

describe('账单 CSV：坏输入必须报错，绝不跳过坏行', () => {
  const cases: [string, string, RegExp][] = [
    ['列顺序颠倒', 'period,amount,currency\n2026-01,0.0012,CNY\n', /第 2 列必须是 currency/],
    ['缺 amount', 'period,currency\n2026-01,CNY\n', /至少要 period,currency,amount/],
    ['可选列跳跃（只给 note）', 'period,currency,amount,note\n2026-01,CNY,0.0012,x\n', /前缀/],
    ['表头重复列名', 'period,currency,amount,amount\n2026-01,CNY,0.0012,0.0012\n', /出现了两次/],
    ['字段数不符', 'period,currency,amount\n2026-01,CNY,0.0012,多余\n', /第 2 行有 4 个字段/],
    ['amount 不是数字', 'period,currency,amount\n2026-01,CNY,abc\n', /amount 不是数字/],
    ['currency 不是三位大写', 'period,currency,amount\n2026-01,usd,0.0012\n', /三位大写/],
    ['currency 不是字母', 'period,currency,amount\n2026-01,12,0.0012\n', /三位大写/],
    ['period 不是 YYYY-MM', 'period,currency,amount\n2026-1,CNY,0.0012\n', /period 必须是 YYYY-MM/],
    ['period 月份越界', 'period,currency,amount\n2026-13,CNY,0.0012\n', /period 必须是 YYYY-MM/],
    ['逐目标行只给 provider', 'period,currency,amount,provider,model\n2026-01,CNY,0.0012,a,\n', /只给了 provider/],
    ['逐目标行只给 model', 'period,currency,amount,provider,model\n2026-01,CNY,0.0012,,b\n', /只给了 model/],
    ['空文件（连表头都没有）', '', /连表头都没有/],
  ]

  for (const [name, csv, pattern] of cases) {
    test(`${name} → ReconcileInputError`, () => {
      expect(() => parseBillCsv(csv)).toThrow(ReconcileInputError)
      expect(() => parseBillCsv(csv)).toThrow(pattern)
    })
  }

  test('★ 报错信息带行号（指得到具体哪一行）', () => {
    expect(() => parseBillCsv('period,currency,amount\n2026-01,CNY,0.0012\n2026-01,CNY,abc\n')).toThrow(/第 3 行/)
  })

  test('只有表头、没有数据行：解析成功但 0 行（随后的月份筛选会报错，不在这里）', () => {
    expect(parseBillCsv('period,currency,amount\n')).toEqual([])
    expect(() => selectBillRows([], '2026-01')).toThrow(/没有任何 period=2026-01 的行/)
  })
})

// ---------------------------------------------------------------------------
// 2. 自然月窗口
// ---------------------------------------------------------------------------

describe('自然月窗口：两端都含，且自动处理大小月', () => {
  test('2026-01（31 天）→ 末刻是 1 月 31 日 23:59:59.999', () => {
    const window = monthWindow('2026-01')
    expect(window.sinceMs).toBe(new Date(2026, 0, 1).getTime())
    expect(window.untilMs).toBe(new Date(2026, 1, 1).getTime() - 1)
    expect(new Date(window.untilMs).getDate()).toBe(31)
    expect(new Date(window.untilMs).getHours()).toBe(23)
    expect(new Date(window.untilMs).getSeconds()).toBe(59)
    expect(new Date(window.untilMs).getMilliseconds()).toBe(999)
  })

  test('2026-02（平年 28 天）与 2024-02（闰年 29 天）分别落到 28 / 29 日', () => {
    expect(new Date(monthWindow('2026-02').untilMs).getDate()).toBe(28)
    // ★ 闰年那条：把「末刻」写成「本月最后一天的 23:59:59.999」时最容易在这里错一天。
    expect(new Date(monthWindow('2024-02').untilMs).getDate()).toBe(29)
  })

  test('窗口是半开的相邻关系：1 月的 untilMs + 1 === 2 月的 sinceMs（不留缝、不重叠）', () => {
    expect(monthWindow('2026-01').untilMs + 1).toBe(monthWindow('2026-02').sinceMs)
  })

  test('非法月份明确报错', () => {
    for (const bad of ['2026-1', '2026-13', '2026-00', '2026', '2026-01-01', '']) {
      expect(() => monthWindow(bad)).toThrow(ReconcileInputError)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 筛选参与对账的行
// ---------------------------------------------------------------------------

describe('只取与 --period 匹配的行；一行都匹配不到必须报错', () => {
  const rows = parseBillCsv(
    'period,currency,amount,provider,model\n'
    + '2025-12,CNY,0.0010,,\n'
    + '2026-01,CNY,0.0012,,\n'
    + '2026-01,USD,0.0005,other,model-usd\n',
  )

  test('只留匹配月份，并分成「总额行」与「逐目标行」', () => {
    const selected = selectBillRows(rows, '2026-01')
    expect(selected.matched).toHaveLength(2)
    expect(selected.monthRows.map((row) => row.currency)).toEqual(['CNY'])
    expect(selected.targetRows.map((row) => row.provider)).toEqual(['other'])
  })

  test('★ 匹配 0 行报错，并把文件里出现过的月份说出来（否则「少比了一行」看起来像「一致」）', () => {
    expect(() => selectBillRows(rows, '2026-03')).toThrow(ReconcileInputError)
    expect(() => selectBillRows(rows, '2026-03')).toThrow(/2025-12, 2026-01/)
  })
})

// ---------------------------------------------------------------------------
// 4. 对账报告（纯函数）
// ---------------------------------------------------------------------------

describe('按币种对账：差额 = 估算 − 账单（同币种内）', () => {
  test('★ 差额与占比都是手算得出来的数', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 1100 }], totalTokens: 1100 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.0013\n',
    )
    const line = lineOf(report, 'CNY')
    expect(line.estimatedMicro).toBe(1200)
    expect(line.billMicro).toBe(1300)
    expect(line.diffMicro).toBe(-100)
    expect(line.diffRatio).toBeCloseTo(-100 / 1300, 12)
    expect(line.ratioText).toBe('-7.69%')
    expect(line.status).toBe('differs')
    expect(report.hasDifference).toBe(true)
  })

  test('阈值内算一致（0.5% 默认值）', () => {
    // 1000 → 1002 微：占比 0.2%，在 ±0.5% 内。
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1000, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.001002\n',
    )
    expect(lineOf(report, 'CNY').status).toBe('consistent')
    expect(report.hasDifference).toBe(false)
  })

  test('恰好卡在阈值边界上算一致（<= 而不是 <）', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1005, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.001\n',
      { tolerancePercent: 0.5 },
    )
    expect(lineOf(report, 'CNY').diffRatio).toBeCloseTo(0.005, 12)
    expect(lineOf(report, 'CNY').status).toBe('consistent')
  })

  test('阈值可配', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1075, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.001\n',
      { tolerancePercent: 10 },
    )
    expect(lineOf(report, 'CNY').status).toBe('consistent')
  })

  test('★ 账单为 0：占比不可算，而且**绝不能**被当成「在阈值内」', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0\n',
    )
    const line = lineOf(report, 'CNY')
    expect(line.diffRatio).toBeNull()
    expect(line.ratioText).toBe('账单为 0，无法算占比')
    expect(line.diffMicro).toBe(1200)
    expect(line.status).toBe('differs')
    expect(report.hasDifference).toBe(true)
    // 极端情形：容差开到很大也不该把「账单为 0」算成一致。
    const loose = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0\n',
      { tolerancePercent: 100 },
    )
    expect(lineOf(loose, 'CNY').status).toBe('differs')
  })

  test('两侧都是 0 → 差额 0，算一致（真的没花钱 vs 账单一分没有）', () => {
    const report = reportOf({ totals: makeTotals(), byTarget: new Map() }, 'period,currency,amount\n2026-01,CNY,0\n')
    const line = lineOf(report, 'CNY')
    expect(line.diffMicro).toBe(0)
    expect(line.status).toBe('consistent')
  })

  test('★ 绝不跨币种相加：两种币种各自一行，差额各自算', () => {
    const report = reportOf(
      {
        totals: makeTotals({
          costs: [
            { currency: 'CNY', amountMicro: 1200, tokens: 1100 },
            { currency: 'USD', amountMicro: 500, tokens: 1000 },
          ],
          totalTokens: 2100,
        }),
        byTarget: new Map(),
      },
      'period,currency,amount\n2026-01,CNY,0.0013\n2026-01,USD,0.0005\n',
    )
    expect(report.currencies.map((line) => line.currency)).toEqual(['CNY', 'USD'])
    expect(lineOf(report, 'CNY').diffMicro).toBe(-100)
    expect(lineOf(report, 'USD').diffMicro).toBe(0)
    // 若把它俩相加，差额会变成 -100 + 0 —— 而 USD 那 0 根本没有「加上去」的资格。
    expect(report.currencies).toHaveLength(2)
  })
})

describe('币种只在一边出现时明说（不静默）', () => {
  test('账单有、估算没有 → onlyInBill，且账单金额照常参与比较', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 100, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.0001\n2026-01,USD,0.0005\n',
    )
    expect(report.onlyInBill).toEqual(['USD'])
    const usd = lineOf(report, 'USD')
    expect(usd.estimatedMicro).toBe(0)
    expect(usd.billMicro).toBe(500)
    expect(usd.diffMicro).toBe(-500)
    expect(usd.status).toBe('differs')
  })

  test('估算有、账单没有 → onlyInEstimate，账单侧是「没有」而不是 0', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'USD', amountMicro: 500, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount\n2026-01,CNY,0.0001\n',
    )
    expect(report.onlyInEstimate).toEqual(['USD'])
    const usd = lineOf(report, 'USD')
    expect(usd.billMicro).toBeNull()
    expect(usd.billText).toBeNull()
    expect(usd.ratioText).toBe('账单里没有这个币种')
    expect(usd.status).toBe('bill-missing')
    expect(report.hasDifference).toBe(true)
  })
})

describe('未计价用量：显式给出，绝不当 0', () => {
  test('unpricedRate 与未配价目标原样进入报告（差额最常见的成因）', () => {
    const report = reportOf(
      {
        totals: makeTotals({
          costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 1100 }],
          pricedTokens: 1100,
          unpricedTokens: 2000,
          totalTokens: 3100,
          pricedRate: 1100 / 3100,
          unpricedRate: 2000 / 3100,
          unpricedTargets: ['dashscope/unpriced-model'],
        }),
        byTarget: new Map(),
      },
      'period,currency,amount\n2026-01,CNY,0.0012\n',
    )
    expect(report.unpriced.unpricedTokens).toBe(2000)
    expect(report.unpriced.unpricedRate).toBeCloseTo(2000 / 3100, 12)
    expect(report.unpriced.targets).toEqual(['dashscope/unpriced-model'])
    // ★ 未计价**不改**退出码：它不是差额，而是「差额可能来自这里」的线索。
    expect(report.hasDifference).toBe(false)
  })
})

describe('逐目标对账', () => {
  const estimate: EstimateSide = {
    totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 1100 }], totalTokens: 1100 }),
    byTarget: new Map([
      ['dashscope/model-a', makeTarget('CNY', 1200)],
      ['dashscope/model-b', makeTarget('CNY', 3000)],
    ]),
  }

  test('按 |差额| 从大到小排，只列前 5 条', () => {
    const report = reportOf(
      estimate,
      'period,currency,amount,provider,model\n'
      + '2026-01,CNY,0.0010,dashscope,model-a\n'
      + '2026-01,CNY,0.0010,dashscope,model-b\n',
    )
    expect(report.targets.map((line) => line.target)).toEqual(['dashscope/model-b', 'dashscope/model-a'])
    expect(report.targets[0]).toMatchObject({ estimatedMicro: 3000, billMicro: 1000, diffMicro: 2000 })
  })

  test('★ 目标键是「上报原值 provider/model」，与账单里的写法逐字匹配', () => {
    const report = reportOf(estimate, 'period,currency,amount,provider,model\n2026-01,CNY,0.0012,dashscope,model-a\n')
    expect(report.targets.map((line) => line.target)).toEqual(['dashscope/model-a'])
    expect(report.targets[0]!.diffMicro).toBe(0)
  })

  test('同一目标多行 → 同币种求和，并**明示**按几行求的（不静默）', () => {
    const report = reportOf(
      estimate,
      'period,currency,amount,provider,model\n'
      + '2026-01,CNY,0.0006,dashscope,model-a\n'
      + '2026-01,CNY,0.0006,dashscope,model-a\n',
    )
    expect(report.targets[0]!.billMicro).toBe(1200)
    expect(report.duplicateNotes).toHaveLength(1)
    expect(report.duplicateNotes[0]).toMatch(/dashscope\/model-a（CNY）在账单里有 2 行/)
  })

  test('估算侧没有这个目标时按 0 算（不是按未计价算）', () => {
    const report = reportOf(estimate, 'period,currency,amount,provider,model\n2026-01,CNY,0.0012,unknown,model-z\n')
    expect(report.targets[0]).toMatchObject({ target: 'unknown/model-z', estimatedMicro: 0, billMicro: 1200 })
  })
})

describe('账单文件自身是否自洽（总额行 vs 逐目标行之和）', () => {
  test('只有逐目标行时按它们求和，并说明用了哪一种', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount,provider,model\n2026-01,CNY,0.0012,dashscope,model-a\n',
    )
    expect(report.billTotalBasis).toBe('target-rows')
    expect(lineOf(report, 'CNY').billMicro).toBe(1200)
    expect(report.breakdownMismatch).toEqual([])
  })

  test('两种行都有时用总额行，且不一致要说出来', () => {
    const report = reportOf(
      { totals: makeTotals({ costs: [{ currency: 'CNY', amountMicro: 1200, tokens: 10 }], totalTokens: 10 }), byTarget: new Map() },
      'period,currency,amount,provider,model,note\n'
      + '2026-01,CNY,0.0013,,,一月总额\n'
      + '2026-01,CNY,0.0010,dashscope,model-a,\n',
    )
    expect(report.billTotalBasis).toBe('month-rows')
    expect(lineOf(report, 'CNY').billMicro).toBe(1300)
    expect(report.breakdownMismatch).toEqual([{ currency: 'CNY', monthMicro: 1300, targetSumMicro: 1000 }])
    // 账单自身不自洽也计入「有差额」：它同样需要人去处理。
    expect(report.hasDifference).toBe(true)
  })
})

describe('估算侧空窗口要明说（与「库指错了」不可区分）', () => {
  test('totalTokens 为 0 → estimateEmpty', () => {
    const report = reportOf({ totals: makeTotals(), byTarget: new Map() }, 'period,currency,amount\n2026-01,CNY,0\n')
    expect(report.estimateEmpty).toBe(true)
  })

  test('窗口是 2026-01 时报告里的 epoch ms 与 monthWindow 一致（打印的窗口就是查询用的窗口）', () => {
    const report = reportOf({ totals: makeTotals(), byTarget: new Map() }, 'period,currency,amount\n2026-01,CNY,0\n')
    expect(report.windowSinceMs).toBe(JAN.sinceMs)
    expect(report.windowUntilMs).toBe(JAN.untilMs)
  })
})

// ---------------------------------------------------------------------------
// 5. 命令行参数
// ---------------------------------------------------------------------------

describe('命令行参数与上报库目标', () => {
  test('缺必填参数报错，且要点出缺的是哪一个', () => {
    expect(() => parseArgs([])).toThrow(/--portal-db、--bill、--period/)
    expect(() => parseArgs(['--portal-db', 'x.sqlite', '--bill', 'b.csv'])).toThrow(/缺少必填参数：--period/)
  })

  test('--help 走帮助分支（不报缺参数）', () => {
    expect(parseArgs(['--help'])).toBe('help')
    expect(parseArgs(['-h'])).toBe('help')
  })

  test('★ `bun run <script> -- ...` 会带进一个 "--"，两种调用形式都要认', () => {
    const options = parseArgs(['--', '--portal-db', 'x.sqlite', '--bill', 'b.csv', '--period', '2026-01'])
    expect(options).not.toBe('help')
    expect(options).toMatchObject({ period: '2026-01', tolerancePercent: 0.5, json: false })
  })

  test('容差必须是非负数字；缺省 0.5', () => {
    expect(() => parseArgs(['--portal-db', 'x', '--bill', 'b', '--period', '2026-01', '--tolerance-percent', 'abc'])).toThrow(
      /必须是非负数字/,
    )
    const options = parseArgs(['--portal-db', 'x', '--bill', 'b', '--period', '2026-01', '--tolerance-percent', '2.5', '--json'])
    expect(options).not.toBe('help')
    expect(options).toMatchObject({ tolerancePercent: 2.5, json: true })
  })

  test('选项缺值时报错（而不是把下一个选项名当成值）', () => {
    expect(() => parseArgs(['--portal-db', '--bill', 'b.csv'])).toThrow(/--portal-db 缺少值/)
  })

  test('--portal-db 接受 mysql:// 连接串，其余按 SQLite 路径绝对化', () => {
    expect(portalTargetFrom('mysql://u:p@127.0.0.1:3306/db')).toEqual({ sqlitePath: '', mysqlUrl: 'mysql://u:p@127.0.0.1:3306/db' })
    expect(portalTargetFrom('data/portal.sqlite').sqlitePath.endsWith(join('data', 'portal.sqlite'))).toBe(true)
    expect(() => portalTargetFrom('   ')).toThrow(ReconcileInputError)
  })

  test('★ 不存在的 SQLite 上报库被拒绝：给不存在的路径开库会安静地造出一个空库', () => {
    expect(() => assertPortalTargetExists({ sqlitePath: join(tmpdir(), 'atr-绝对不存在的库.sqlite') })).toThrow(
      /上报库不存在/,
    )
    // MySQL 侧无法在不连接的前提下判断，交给「零用量告警」兜住，所以这里不抛。
    expect(() => assertPortalTargetExists({ sqlitePath: '', mysqlUrl: 'mysql://u:p@h/db' })).not.toThrow()
  })
})

describe('表格对齐', () => {
  test('中文按两列宽算，否则数字列永远对不齐', () => {
    expect(displayWidth('币种')).toBe(4)
    expect(displayWidth('CNY')).toBe(3)
    expect(displayWidth('币种CNY')).toBe(7)
    // 7 个字符：全角括号各 2 列、三个汉字各 2 列，`−`（U+2212）只有 1 列。
    expect(displayWidth('（估算−账单）')).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// 6. 真底座：估算侧来自真的 v7 上报库
// ---------------------------------------------------------------------------

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-reconcile-bill-'))
  dbPath = join(home, 'portal.sqlite')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 2026 年 1 月的某个本地时刻。 */
function janAt(day: number, hour = 9, minute = 0, second = 0, ms = 0): number {
  return new Date(2026, 0, day, hour, minute, second, ms).getTime()
}

interface PriceSpec {
  id: string
  provider: string
  model: string
  currency: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const PRICES: readonly PriceSpec[] = [
  { id: '11111111-1111-1111-1111-111111111111', provider: 'dashscope', model: 'model-a', currency: 'CNY', input: 1000, output: 2000, cacheRead: 100, cacheWrite: 0 },
  { id: '22222222-2222-2222-2222-222222222222', provider: 'other', model: 'model-usd', currency: 'USD', input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
]

function event(eventId: string, seq: number, ts: number, over: Partial<IngestRecord> = {}): IngestRecord {
  return {
    event_id: eventId,
    session_id: 'sess-reconcile',
    seq,
    ts,
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

/** 造一个真的 v7 上报库：3 条单价 + 5 条事件（含**两个窗口边界**与一条未计价）。 */
async function seedPortal(): Promise<void> {
  await preparePortalDatabase({ sqlitePath: dbPath })
  const store = await openPortalStore({ sqlitePath: dbPath })
  try {
    const now = janAt(15)
    for (const price of PRICES) {
      await store.run(
        `INSERT INTO model_price (
           price_id, provider, model, currency,
           input_micro_per_ktok, output_micro_per_ktok,
           cache_read_micro_per_ktok, cache_write_micro_per_ktok,
           effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms
         ) VALUES ($id, $provider, $model, $currency, $input, $output, $cr, $cw, 0, NULL, NULL, $now, $now)`,
        {
          $id: price.id,
          $provider: price.provider,
          $model: price.model,
          $currency: price.currency,
          $input: price.input,
          $output: price.output,
          $cr: price.cacheRead,
          $cw: price.cacheWrite,
          $now: now,
        },
      )
    }

    await insertAttributedRecords(
      store,
      [
        // 窗口**起点那一毫秒**：必须计入（`ts >= sinceMs`）。
        event('b-start', 1, janAt(1, 0, 0, 0, 0), { input_tokens: 100, provider: 'boundary', model: 'edge' }),
        // 窗口**终点那一毫秒**：必须计入（`ts <= untilMs`）。
        event('b-end', 2, janAt(31, 23, 59, 59, 999), { input_tokens: 200, provider: 'boundary', model: 'edge' }),
        // 窗口之外一天：必须**不**计入。漏掉它会让「对账窗口」多算一天。
        event('b-out', 3, new Date(2026, 1, 1, 0, 0, 0, 0).getTime(), { input_tokens: 400, provider: 'boundary', model: 'edge' }),
        event('e1', 4, janAt(15), { input_tokens: 1000, output_tokens: 100 }),
        event('e3', 5, janAt(15), { provider: 'other', model: 'model-usd', input_tokens: 1000 }),
        // 一条价都没配的模型：整条计入 unpriced，**绝不当 0 元**。
        event('e6', 6, janAt(15), { model: 'unpriced-model', input_tokens: 2000 }),
      ],
      { userId: '张三', userName: '张三', groupName: '研发一部' },
    )
  } finally {
    await store.close()
  }
}

/** 走与脚本完全相同的取数路径（只读 + withCost=true + 不加载归一化规则）。 */
async function estimateSide(): Promise<EstimateSide> {
  const session = await openPortalStats(
    { sqlitePath: dbPath },
    { sinceMs: JAN.sinceMs, untilMs: JAN.untilMs },
    undefined,
    true,
  )
  try {
    const totals = await session.costTotals()
    if (totals === null) throw new Error('真底座没有返回金额')
    return { totals, byTarget: await session.costByGroup('provider-model') }
  } finally {
    await session.close()
  }
}

/** `boundary/edge` 的单价：四类里只配了 input = 1000 微/千 token，所以金额 = input token 数。 */
const BOUNDARY_PRICE: PriceSpec = { id: '99999999-9999-9999-9999-999999999999', provider: 'boundary', model: 'edge', currency: 'CNY', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('估算侧来自真上报库（v7 + 金额 JOIN + 窗口边界）', () => {
  test('★ 窗口两端都含：起点与终点那一毫秒计入，窗口外的一天不计入', async () => {
    await seedPortal()
    // 单独再插一条 boundary/edge 的价，好把「边界事件」的金额与其它事件分开看。
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await store.run(
        `INSERT INTO model_price (
           price_id, provider, model, currency,
           input_micro_per_ktok, output_micro_per_ktok,
           cache_read_micro_per_ktok, cache_write_micro_per_ktok,
           effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms
         ) VALUES ($id, $provider, $model, $currency, $input, 0, 0, 0, 0, NULL, NULL, $now, $now)`,
        { $id: BOUNDARY_PRICE.id, $provider: 'boundary', $model: 'edge', $currency: 'CNY', $input: 1000, $now: janAt(15) },
      )
    } finally {
      await store.close()
    }

    const estimate = await estimateSide()
    const boundary = estimate.byTarget.get('boundary/edge')
    expect(boundary).toBeDefined()
    // 100（起点）+ 200（终点）= 300 微；那 400（2 月 1 日）**必须不在**。
    expect(boundary!.costs).toEqual([{ currency: 'CNY', amountMicro: 300, tokens: 300 }])
  })

  test('★ 金额四类分价相乘 + 未计价显式计数（手算值）', async () => {
    await seedPortal()
    const estimate = await estimateSide()
    const totals = estimate.totals

    // CNY 1200 = model-a（1000×1000/1000 + 100×2000/1000）；USD 500 = 1000×500/1000。
    // boundary/edge 没有价（种子里没有它），所以它整个进 unpriced。
    const cny = totals.costs.find((cost) => cost.currency === 'CNY')
    const usd = totals.costs.find((cost) => cost.currency === 'USD')
    expect(cny).toEqual({ currency: 'CNY', amountMicro: 1200, tokens: 1100 })
    expect(usd).toEqual({ currency: 'USD', amountMicro: 500, tokens: 1000 })
    expect(totals.pricedTokens).toBe(2100)
    // 未计价 = 2000（unpriced-model）+ 100 + 200（boundary/edge 的起点与终点两条）；
    // 窗口外那条 400 **必须不在**里面 —— 它若在，说明窗口多算了一天。
    expect(totals.unpricedTokens).toBe(2300)
    expect(totals.totalTokens).toBe(4400)
    // 未配价的目标清单里必须有它 —— 这正是差额最常见的成因。
    expect(totals.unpricedTargets).toEqual(['boundary/edge', 'dashscope/unpriced-model'])
    expect(totals.pricing).toEqual({ pricingSource: 'db', pricingSyncedAt: null })
  })

  test('★ 逐目标金额与整体金额能对上（`costByGroup` 与 `costTotals` 同源）', async () => {
    await seedPortal()
    const estimate = await estimateSide()
    const byTargetCny = [...estimate.byTarget.values()]
      .flatMap((totals) => totals.costs)
      .filter((cost) => cost.currency === 'CNY')
      .reduce((sum, cost) => sum + cost.amountMicro, 0)
    const totalsCny = estimate.totals.costs.find((cost) => cost.currency === 'CNY')!.amountMicro
    expect(byTargetCny).toBe(totalsCny)
  })

  test('★ 端到端：真库 + 真账单 → 差额、占比、线索都对得上', async () => {
    await seedPortal()
    const estimate = await estimateSide()
    const report = reportOf(
      estimate,
      'period,currency,amount,provider,model,note\n'
      + '2026-01,CNY,0.0013,,,一月总额\n'
      + '2026-01,USD,0.0005,,,一月总额\n'
      + '2026-01,CNY,0.0010,dashscope,model-a,\n'
      + '2026-01,USD,0.0005,other,model-usd,\n',
    )

    const cny = lineOf(report, 'CNY')
    expect(cny).toMatchObject({ estimatedMicro: 1200, billMicro: 1300, diffMicro: -100, status: 'differs' })
    expect(lineOf(report, 'USD').status).toBe('consistent')

    // 逐目标：model-a 的 1200 vs 1000 → 差 200（20%），是差异最大的那条。
    expect(report.targets[0]).toMatchObject({ target: 'dashscope/model-a', diffMicro: 200 })

    // 账单自身不自洽（总额 1300 vs 逐目标之和 1000）也要报出来。
    expect(report.breakdownMismatch).toEqual([{ currency: 'CNY', monthMicro: 1300, targetSumMicro: 1000 }])

    // 未计价 2300 / 4400 —— 这就是「估算必然偏低」的量化依据。
    expect(report.unpriced.unpricedTokens).toBe(2300)
    expect(report.unpriced.targets).toContain('dashscope/unpriced-model')
    expect(report.hasDifference).toBe(true)
  })

  test('同一份真数据在窗口外的月份里是空窗口（estimateEmpty）', async () => {
    await seedPortal()
    const march = monthWindow('2026-03')
    const session = await openPortalStats(
      { sqlitePath: dbPath },
      { sinceMs: march.sinceMs, untilMs: march.untilMs },
      undefined,
      true,
    )
    try {
      const totals = await session.costTotals()
      expect(totals!.totalTokens).toBe(0)
      expect(totals!.costs).toEqual([])
    } finally {
      await session.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. 命令行退出码（真子进程）
// ---------------------------------------------------------------------------

const SCRIPT = new URL('../scripts/reconcile-bill.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runCli(args: readonly string[]): RunResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', SCRIPT, '--', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('命令行退出码：0 一致 / 1 有差额（不是崩溃）/ 2 输入错误', () => {
  function writeCsv(name: string, text: string): string {
    const path = join(home, name)
    writeFileSync(path, text, 'utf8')
    return path
  }

  test('★ 0 / 1 / 2 三个码各就各位', async () => {
    await seedPortal()
    const exact = writeCsv('exact.csv', 'period,currency,amount\n2026-01,CNY,0.0012\n2026-01,USD,0.0005\n')
    const differs = writeCsv('differs.csv', 'period,currency,amount\n2026-01,CNY,0.0015\n2026-01,USD,0.0005\n')

    const consistent = runCli(['--portal-db', dbPath, '--bill', exact, '--period', '2026-01'])
    expect(consistent.exitCode).toBe(0)
    expect(consistent.stdout).toContain('统计窗口')
    expect(consistent.stdout).toContain('本脚本全程只读')

    const difference = runCli(['--portal-db', dbPath, '--bill', differs, '--period', '2026-01'])
    expect(difference.exitCode).toBe(1)
    // 退出码 1 的含义必须写在最后一行，否则它会被读成「脚本崩了」。
    expect(difference.stdout).toContain('退出码 1 = 存在差额，不是崩溃')

    const badHeader = writeCsv('bad.csv', 'period,amount,currency\n2026-01,0.0012,CNY\n')
    const usageError = runCli(['--portal-db', dbPath, '--bill', badHeader, '--period', '2026-01'])
    expect(usageError.exitCode).toBe(2)
    expect(usageError.stderr).toContain('账单表头不匹配')

    const noRows = runCli(['--portal-db', dbPath, '--bill', exact, '--period', '2026-05'])
    expect(noRows.exitCode).toBe(2)
    expect(noRows.stderr).toContain('没有任何 period=2026-05 的行')
  })

  test('★ 不存在的上报库 → 2，而且**绝不在磁盘上新建库**', () => {
    const ghost = join(home, 'ghost.sqlite')
    const csv = writeCsv('one.csv', 'period,currency,amount\n2026-01,CNY,0.0012\n')
    const result = runCli(['--portal-db', ghost, '--bill', csv, '--period', '2026-01'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('上报库不存在')
    expect(existsSync(ghost)).toBe(false)
  })

  test('--json 只打 JSON（可管道解析），账单数字只在这里', async () => {
    await seedPortal()
    const csv = writeCsv('json.csv', 'period,currency,amount\n2026-01,CNY,0.0012\n2026-01,USD,0.0005\n')
    const result = runCli(['--portal-db', dbPath, '--bill', csv, '--period', '2026-01', '--json'])
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout) as { read_only: boolean; currency_lines: { currency: string }[] }
    expect(payload.read_only).toBe(true)
    expect(payload.currency_lines.map((line) => line.currency)).toEqual(['CNY', 'USD'])
  })
})