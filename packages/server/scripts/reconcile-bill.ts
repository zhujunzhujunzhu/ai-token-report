/**
 * 月度账单对账（S8）—— 把「我们自己估的钱」和「财务给的钱」摆到同一张表上。
 *
 * ```bash
 * bun run reconcile:bill -- --portal-db data/portal.sqlite --bill 2026-01.csv --period 2026-01
 * bun run reconcile:bill -- --portal-db "$ATR_MYSQL_URL" --bill 2026-01.csv --period 2026-01 --json
 * ```
 *
 * ## 这个脚本存在的唯一理由
 *
 * **自建计价 ≠ 财务账单。** 单价表里只有 token 的四类单价，折扣、预付、赠送额度、
 * 阶梯返点都不在里面 —— 所以两边的数字**本来就不该完全相等**。对账脚本的价值不是
 * 「证明我们算对了」，而是**量出差多少、并且指出差在哪**（未配价的目标、某个模型
 * 两侧差距最大、某个币种只在一边出现）。
 *
 * 🚨 **账单金额（财务给的数）只允许出现在本脚本的 stdout。** 它绝不进数据库、
 * 不进任何页面 / 接口 / CLI 的其它输出 —— 财务口径与我们的估算口径混在一起之后，
 * 两者都再也说不清。本脚本因此**全程只读**：不写上报库、不写任何文件。
 *
 * ## 口径边界（都不是在这里定义的）
 *
 * - 四类分价相乘、按币种分桶、未计价比例 → 一律来自 `packages/shared/src/price.ts`，
 *   由上一步 `costTotals()` / `costByGroup()` 算好。**本文件不出现任何单价乘法**。
 * - 概览金额来自 `costTotals()`，它内部已经**先按 `(provider, model)` 分组算完再求和**
 *   —— 不是「总量 × 均价」（世上没有平均单价）。
 * - 多币种**各自累加、绝不换算、绝不相加**，所以下面的比较也是**逐币种**进行的。
 * - 唯一的减法在 `sameCurrencyDiff()` 一处：**同币种内**「估算 − 账单」。那是对账，
 *   不是计价 —— 计价永远不该写在这里。
 *
 * ## 时间窗
 *
 * 账单按**自然月**出，所以窗口由 `--period YYYY-MM` 显式给出、两端都含
 * （`[1 号 00:00:00.000, 次月 1 号 00:00:00.000 - 1ms]`），并**打印出来**：
 * 对账最怕的是「比的是两个不同的窗口」，而那种错误从数字上完全看不出来。
 * 刻意**不**用 `--period last-month` 这类相对口径 —— 「本月的第一天」是一个会
 * 随时间漂移的定义，而账单上的月份不会。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { formatPoint } from '@ai-token-report/core'
import {
  closeAllMysqlBackends,
  describePortalTarget,
  openPortalStats,
  type CostTotals,
  type CostTotalsWithTargets,
  type PortalTarget,
} from '@ai-token-report/core/db'
import { formatCostMicro, type PricingProvenance, type PricingSource } from '@ai-token-report/shared'

// ---------------------------------------------------------------------------
// 退出码（三个码各有一个**明确**含义，不允许互相借用）
// ---------------------------------------------------------------------------

/** 完全一致，或差额在阈值内。 */
const EXIT_CONSISTENT = 0
/** ★ 存在差额 —— 这是**对账结果**，不是脚本失败。 */
const EXIT_DIFFERS = 1
/** 用法 / 输入 / 环境错误。所有异常都落到这里，**保证 1 永远只表示「有差额」**。 */
const EXIT_INPUT_ERROR = 2

/** 逐目标清单最多列几条（列表的价值在于指向，不在于穷举）。 */
const MAX_TARGET_LINES = 5

/** 输入错误：与「对账发现差额」必须严格区分，所以单独一个类型。 */
export class ReconcileInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconcileInputError'
  }
}

// ---------------------------------------------------------------------------
// 自然月窗口
// ---------------------------------------------------------------------------

export interface MonthWindow {
  /** 归一化后的 `YYYY-MM`。 */
  period: string
  sinceMs: number
  untilMs: number
}

/**
 * `YYYY-MM` → 本地自然月窗口，**两端都含**。
 *
 * ⚠️ 这里用本地时间构造日期，与 `core/range.ts` 的 `startOfDay()` / `endOfDay()`
 * 同一个约定（那边是**私有**函数，本脚本不能 import）。刻意复制的只有「本地零点」
 * 这一条算术，而且它服务的是**对账窗口**这个绝对输入，不是任何指标口径。
 *
 * 「次月 1 号 00:00 减 1 毫秒」而不是「本月最后一天的 23:59:59.999」：
 * 前者自动处理大小月与闰年，后者要把天数算对 —— 算错时表现是**少比了一天**，
 * 而那看起来就像「对上了」。
 */
export function monthWindow(period: string): MonthWindow {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period.trim())
  if (!match) {
    throw new ReconcileInputError(`--period 必须是 YYYY-MM（例如 2026-01），收到：${JSON.stringify(period)}`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  return {
    period: `${match[1]}-${match[2]}`,
    sinceMs: new Date(year, month - 1, 1).getTime(),
    // 次月 1 号零点减 1ms = 本月最后一刻；`ts <= untilMs` 是包含语义（见 query.ts）。
    untilMs: new Date(year, month, 1).getTime() - 1,
  }
}

// ---------------------------------------------------------------------------
// 账单 CSV
// ---------------------------------------------------------------------------

/** 表头**顺序固定**；前三个必须出现，后三个按序可缺席。 */
export const BILL_REQUIRED_COLUMNS = ['period', 'currency', 'amount'] as const
export const BILL_OPTIONAL_COLUMNS = ['provider', 'model', 'note'] as const

/** 一行账单。金额已经折成**整数微元**，与估算侧同一个单位。 */
export interface BillRow {
  /** 文件里的物理行号（1 起，含表头），错误信息里指得到具体哪一行。 */
  line: number
  period: string
  currency: string
  amountMicro: number
  /** 逐目标行的供应商标识；`null` = 这一行是「按月按币种」的总额行。 */
  provider: string | null
  model: string | null
  note: string | null
}

/**
 * 一行 CSV 切成字段。
 *
 * 引号包裹与 `""` 转义必须支持：备注里出现英文逗号时，朴素 `split(',')` 会把
 * 一行切成两截，而**字段数不匹配才会报错** —— 若备注恰好落在最后一列，
 * 表现就是「备注被截断」，数字照常正确，没人会发现。
 *
 * ⚠️ 刻意**不**支持「引号内含真实换行」的字段：那需要跨行状态机，而它换来的
 * 唯一好处是备注能写多行。真遇到时表现为字段数不匹配（明确报错），不会静默错位。
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/**
 * 表头是否合法；返回 `null` 表示合法。
 *
 * 规则：前三个逐字相符，其余必须是可选列的**前缀**（顺序固定、不许跳跃、不许重复）。
 * 重复列名也要拦：后一列会覆盖前一列的值，而两列都「在合法顺序上」——
 * 表现是「金额少了一半」，没有任何报错。
 */
function headerShapeError(header: readonly string[]): string | null {
  if (header.length < BILL_REQUIRED_COLUMNS.length) {
    return `表头只有 ${header.length} 列，至少要 ${BILL_REQUIRED_COLUMNS.join(',')}`
  }
  for (let i = 0; i < BILL_REQUIRED_COLUMNS.length; i += 1) {
    if (header[i] !== BILL_REQUIRED_COLUMNS[i]) {
      return `第 ${i + 1} 列必须是 ${BILL_REQUIRED_COLUMNS[i]}，实际是 ${JSON.stringify(header[i] ?? '')}`
    }
  }
  const extra = header.slice(BILL_REQUIRED_COLUMNS.length)
  // 重复列名要**先于**下面的「可选列前缀」判断：重复必然同时违反前缀规则，
  // 而「出现了两次」比「不在前缀里」可行动得多（后者会让人去改列顺序）。
  const seen = new Set<string>()
  for (const name of header) {
    if (seen.has(name)) return `表头里 ${JSON.stringify(name)} 出现了两次（后一列会覆盖前一列）`
    seen.add(name)
  }
  const expected = BILL_OPTIONAL_COLUMNS.slice(0, extra.length)
  if (extra.length > BILL_OPTIONAL_COLUMNS.length || extra.some((name, i) => name !== expected[i])) {
    return `可选列必须按序为 ${BILL_OPTIONAL_COLUMNS.join(',')} 的前缀，实际是 ${extra.map((name) => JSON.stringify(name)).join(',') || '（无）'}`
  }
  return null
}

/**
 * 解析账单 CSV。
 *
 * 🚨 **绝不猜、绝不跳过坏行。** 跳过一个坏行会让「少比了一行」看起来像
 * 「完全一致」—— 那正是对账脚本最不能给出的结论。所有问题都以
 * {@link ReconcileInputError} 抛出，由调用方映射成退出码 2。
 */
export function parseBillCsv(text: string): BillRow[] {
  // Excel 导出的 CSV 通常带 UTF-8 BOM。不去掉它会让第一列表头变成
  // `\uFEFFperiod`，于是「表头不匹配」直接拒掉一份完全正常的文件。
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rawLines = clean.split(/\r?\n/)

  let header: string[] | null = null
  const rows: BillRow[] = []

  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNo = index + 1
    const raw = rawLines[index]!
    // 整行空白（含文件末尾的空行）跳过：它不是数据，也不是坏行。
    if (raw.trim() === '') continue

    const cells = splitCsvLine(raw).map((cell) => cell.trim())
    if (header === null) {
      header = cells
      const problem = headerShapeError(cells)
      if (problem) {
        throw new ReconcileInputError(
          `账单表头不匹配：${problem}。\n`
          + `要求：${[...BILL_REQUIRED_COLUMNS, ...BILL_OPTIONAL_COLUMNS].join(',')}`
          + `（前 ${BILL_REQUIRED_COLUMNS.length} 列必须有，${BILL_OPTIONAL_COLUMNS.join('/')} 按序可缺席）`,
        )
      }
      continue
    }

    if (cells.length !== header.length) {
      throw new ReconcileInputError(
        `账单第 ${lineNo} 行有 ${cells.length} 个字段，表头是 ${header.length} 个（少了或多了一个逗号都会落到这里）`,
      )
    }

    const cell = (name: (typeof BILL_OPTIONAL_COLUMNS)[number] | (typeof BILL_REQUIRED_COLUMNS)[number]): string => {
      const at = header!.indexOf(name)
      return at < 0 ? '' : cells[at]!
    }

    const period = cell('period')
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new ReconcileInputError(`账单第 ${lineNo} 行的 period 必须是 YYYY-MM，实际是 ${JSON.stringify(period)}`)
    }

    const currency = cell('currency')
    // 严格三位大写：估算是按 `normalizeCurrency()` 分桶的，账单侧也必须是同一个写法。
    // 在这里替使用者把 `usd` 改成 `USD` 属于猜测 —— 猜错的表现是「这个币种只在账单里有」。
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ReconcileInputError(`账单第 ${lineNo} 行的 currency 必须是三位大写字母（如 USD / CNY），实际是 ${JSON.stringify(currency)}`)
    }

    const amountText = cell('amount')
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(amountText)) {
      throw new ReconcileInputError(`账单第 ${lineNo} 行的 amount 不是数字，实际是 ${JSON.stringify(amountText)}`)
    }
    // 折成整数微元：与估算侧同一个单位，逐币种相减才有意义。
    // 允许负数（退款 / 冲销），所以不做「必须为正」的判断。
    const amountMicro = Math.round(Number(amountText) * 1_000_000)
    if (!Number.isSafeInteger(amountMicro)) {
      throw new ReconcileInputError(`账单第 ${lineNo} 行的 amount 超出可安全表示的微元范围，实际是 ${JSON.stringify(amountText)}`)
    }

    const provider = cell('provider')
    const model = cell('model')
    // 逐目标行必须两个都给：只有 provider 的行无法定位到任何一条价
    // （单价粒度是 `(provider, model)`），而它会被当成「某个供应商的总账」，
    // 与逐目标清单里的 `provider/model` 键永远配不上 —— 静默地比了个空。
    if ((provider === '') !== (model === '')) {
      throw new ReconcileInputError(
        `账单第 ${lineNo} 行只给了 ${provider === '' ? 'model' : 'provider'}：逐目标行必须同时给出 provider 与 model（单价粒度就是这两者）`,
      )
    }

    const note = cell('note')
    rows.push({
      line: lineNo,
      period,
      currency,
      amountMicro,
      provider: provider === '' ? null : provider,
      model: model === '' ? null : model,
      note: note === '' ? null : note,
    })
  }

  if (header === null) throw new ReconcileInputError('账单文件是空的：连表头都没有')
  return rows
}

/** 从 `--period` 里筛出要对的那些行；筛不到必须报错（不是安静地什么都不比）。 */
export function selectBillRows(rows: readonly BillRow[], period: string): {
  matched: BillRow[]
  monthRows: BillRow[]
  targetRows: BillRow[]
} {
  const matched = rows.filter((row) => row.period === period)
  if (matched.length === 0) {
    const seen = [...new Set(rows.map((row) => row.period))].sort()
    throw new ReconcileInputError(
      `账单文件里没有任何 period=${period} 的行。`
      + `文件里出现过的月份：${seen.length > 0 ? seen.join(', ') : '（没有数据行）'}`,
    )
  }
  return {
    matched,
    monthRows: matched.filter((row) => row.provider === null),
    targetRows: matched.filter((row) => row.provider !== null),
  }
}

// ---------------------------------------------------------------------------
// 比较
// ---------------------------------------------------------------------------

/** 估算侧（已由上报库只读查询算好，本脚本不再碰任何单价）。 */
export interface EstimateSide {
  totals: CostTotalsWithTargets
  /** `provider/model` → 该目标的金额；键与上报库分组路径逐字相同。 */
  byTarget: Map<string, CostTotals>
}

export interface CurrencyLine {
  currency: string
  estimatedMicro: number
  estimatedText: string
  /** `null` = 账单里根本没有这个币种（不是 0）。 */
  billMicro: number | null
  billText: string | null
  diffMicro: number | null
  diffText: string | null
  diffRatio: number | null
  ratioText: string
  status: 'consistent' | 'differs' | 'bill-missing'
}

export interface TargetLine {
  target: string
  currency: string
  estimatedMicro: number
  billMicro: number
  diffMicro: number
  estimatedText: string
  billText: string
  diffText: string
  ratioText: string
}

export interface ReconcileReport {
  period: string
  windowSinceMs: number
  windowUntilMs: number
  windowFromText: string
  windowToText: string
  source: string
  billPath: string
  pricing: PricingProvenance
  pricingText: string
  /** 账单侧的币种总额是按哪一类行算出来的（只有逐目标行时按它们求和）。 */
  billTotalBasis: 'month-rows' | 'target-rows'
  currencies: CurrencyLine[]
  onlyInEstimate: string[]
  onlyInBill: string[]
  targets: TargetLine[]
  unpriced: {
    pricedTokens: number
    unpricedTokens: number
    totalTokens: number
    unpricedRate: number
    /** 未配单价的 `provider/model`（已排序、已截断）。 */
    targets: string[]
  }
  /** 账单文件自身不自洽：逐目标行之和 ≠ 该币种的总额行。 */
  breakdownMismatch: { currency: string; monthMicro: number; targetSumMicro: number }[]
  /** 同一目标出现多行时的求和提示（明示，不静默）。 */
  duplicateNotes: string[]
  /** 估算侧在这个窗口里一条用量都没有 —— 与「路径指错了」不可区分，必须说出来。 */
  estimateEmpty: boolean
  tolerancePercent: number
  hasDifference: boolean
}

/**
 * ★ **唯一一处金额减法**：同币种内「估算 − 账单」。
 *
 * 这是**对账**，不是计价 —— 计价（四类分价相乘）永远只属于
 * `packages/shared/src/price.ts`。这里能做的只有同一币种内的相减，
 * **绝不跨币种**：没有任何汇率口径在本仓是合法的。
 */
function sameCurrencyDiff(estimatedMicro: number, billMicro: number): number {
  return estimatedMicro - billMicro
}

function describePricing(source: PricingSource, syncedAt: number | null): string {
  if (source === 'db') return '上报库 model_price 表'
  if (source === 'snapshot') return `pricing.json 快照（同步于 ${syncedAt === null ? '未知时刻' : formatPoint(syncedAt)}）`
  return '内置种子价'
}

/** 把一个币种桶的数组折成 `币种 → 微元`。**同币种求和是对的，跨币种从不发生。** */
function microByCurrency(costs: readonly { currency: string; amountMicro: number }[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const cost of costs) map.set(cost.currency, (map.get(cost.currency) ?? 0) + cost.amountMicro)
  return map
}

/**
 * 组装对账报告（纯函数：不碰数据库、不读文件，所以可以直接单测）。
 */
export function buildReport(params: {
  period: string
  window: MonthWindow
  source: string
  billPath: string
  estimate: EstimateSide
  billRows: readonly BillRow[]
  tolerancePercent: number
}): ReconcileReport {
  const { period, window, estimate, tolerancePercent } = params
  const { monthRows, targetRows } = selectBillRows(params.billRows, period)

  // ── 账单侧：逐目标行按「同目标同币种」求和 ────────────────────────────────
  // 同一个目标出现多行（财务把一笔拆成两行）时**求和**，但下面会把这件事明示出来：
  // 静默求和与静默忽略都会让「文件里到底有几行」不可知。
  const billTargets = new Map<string, number>()
  const targetHits = new Map<string, number[]>()
  for (const row of targetRows) {
    const key = `${row.provider}/${row.model}\u0000${row.currency}`
    billTargets.set(key, (billTargets.get(key) ?? 0) + row.amountMicro)
    const hits = targetHits.get(key)
    if (hits) hits.push(row.line)
    else targetHits.set(key, [row.line])
  }
  const duplicateNotes: string[] = []
  for (const [key, lines] of targetHits) {
    if (lines.length > 1) {
      const [target, currency] = key.split('\u0000')
      duplicateNotes.push(`${target}（${currency}）在账单里有 ${lines.length} 行（第 ${lines.join(' / ')} 行），已按同币种求和`)
    }
  }

  // 币种总额：优先用「按月按币种」的总额行（财务给的权威数）；只有逐目标行时
  // 才拿它们求和 —— 而**用了哪一种必须打印出来**，否则「总额比明细小」会被当成差额。
  const billTotalBasis: ReconcileReport['billTotalBasis'] = monthRows.length > 0 ? 'month-rows' : 'target-rows'
  const billByCurrency = new Map<string, number>()
  const totalRows = billTotalBasis === 'month-rows' ? monthRows : targetRows
  for (const row of totalRows) billByCurrency.set(row.currency, (billByCurrency.get(row.currency) ?? 0) + row.amountMicro)

  // ── 估算侧 ────────────────────────────────────────────────────────────────
  const estimatedByCurrency = microByCurrency(estimate.totals.costs)

  // ── 逐币种比较 ────────────────────────────────────────────────────────────
  const allCurrencies = [...new Set([...estimatedByCurrency.keys(), ...billByCurrency.keys()])].sort()
  const currencies: CurrencyLine[] = allCurrencies.map((currency) => {
    const estimatedMicro = estimatedByCurrency.get(currency) ?? 0
    const billMicro = billByCurrency.get(currency) ?? null
    if (billMicro === null) {
      return {
        currency,
        estimatedMicro,
        estimatedText: formatCostMicro(estimatedMicro, currency),
        billMicro: null,
        billText: null,
        diffMicro: null,
        diffText: null,
        diffRatio: null,
        ratioText: '账单里没有这个币种',
        status: 'bill-missing',
      }
    }
    const diffMicro = sameCurrencyDiff(estimatedMicro, billMicro)
    // 占比的分母是**账单**：账单为 0 时占比数学上不存在。
    // 🚨 这里绝不能回落成「0% ⇒ 在阈值内」：账单为 0 而我们有估算，是**最大的差额**。
    const diffRatio = billMicro === 0 ? null : diffMicro / billMicro
    const withinTolerance = diffRatio !== null && Math.abs(diffRatio) <= tolerancePercent / 100
    const consistent = diffMicro === 0 || withinTolerance
    return {
      currency,
      estimatedMicro,
      estimatedText: formatCostMicro(estimatedMicro, currency),
      billMicro,
      billText: formatCostMicro(billMicro, currency),
      diffMicro,
      diffText: formatCostMicro(diffMicro, currency),
      diffRatio,
      ratioText: diffRatio === null ? '账单为 0，无法算占比' : `${(diffRatio * 100).toFixed(2)}%`,
      status: consistent ? 'consistent' : 'differs',
    }
  })

  // ── 逐目标比较（只列差异最大的几条） ──────────────────────────────────────
  const targets: TargetLine[] = []
  for (const [key, billMicro] of billTargets) {
    const [target, currency] = key.split('\u0000') as [string, string]
    const targetTotals = estimate.byTarget.get(target)
    const estimatedMicro = targetTotals ? (microByCurrency(targetTotals.costs).get(currency) ?? 0) : 0
    const diffMicro = sameCurrencyDiff(estimatedMicro, billMicro)
    targets.push({
      target,
      currency,
      estimatedMicro,
      billMicro,
      diffMicro,
      estimatedText: formatCostMicro(estimatedMicro, currency),
      billText: formatCostMicro(billMicro, currency),
      diffText: formatCostMicro(diffMicro, currency),
      ratioText: billMicro === 0 ? '账单为 0，无法算占比' : `${((diffMicro / billMicro) * 100).toFixed(2)}%`,
    })
  }
  targets.sort((a, b) => Math.abs(b.diffMicro) - Math.abs(a.diffMicro))
  const topTargets = targets.slice(0, MAX_TARGET_LINES)

  // ── 账单文件自身是否自洽 ──────────────────────────────────────────────────
  const breakdownMismatch: ReconcileReport['breakdownMismatch'] = []
  if (monthRows.length > 0 && targetRows.length > 0) {
    const targetSum = microByCurrency(targetRows)
    for (const [currency, monthMicro] of billByCurrency) {
      const targetSumMicro = targetSum.get(currency) ?? 0
      if (targetSumMicro !== monthMicro) breakdownMismatch.push({ currency, monthMicro, targetSumMicro })
    }
  }

  const hasDifference =
    currencies.some((line) => line.status !== 'consistent') || breakdownMismatch.length > 0

  return {
    period,
    windowSinceMs: window.sinceMs,
    windowUntilMs: window.untilMs,
    windowFromText: formatPoint(window.sinceMs),
    windowToText: formatPoint(window.untilMs),
    source: params.source,
    billPath: params.billPath,
    pricing: estimate.totals.pricing,
    pricingText: describePricing(estimate.totals.pricing.pricingSource, estimate.totals.pricing.pricingSyncedAt),
    billTotalBasis,
    currencies,
    onlyInEstimate: [...estimatedByCurrency.keys()].filter((c) => !billByCurrency.has(c)).sort(),
    onlyInBill: [...billByCurrency.keys()].filter((c) => !estimatedByCurrency.has(c)).sort(),
    targets: topTargets,
    unpriced: {
      pricedTokens: estimate.totals.pricedTokens,
      unpricedTokens: estimate.totals.unpricedTokens,
      totalTokens: estimate.totals.totalTokens,
      unpricedRate: estimate.totals.unpricedRate,
      targets: estimate.totals.unpricedTargets,
    },
    breakdownMismatch,
    duplicateNotes,
    estimateEmpty: estimate.totals.totalTokens === 0,
    tolerancePercent,
    hasDifference,
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 等宽终端里东亚宽字符占两列；不纠正的话中文表头与数字列永远对不齐。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f)
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** 按显示宽度对齐的极简表格。 */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((cell, index) =>
    Math.max(displayWidth(cell), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  )
  const render = (row: readonly string[]): string =>
    '  ' + row.map((cell, index) => pad(cell, widths[index]!)).join('  ').trimEnd()
  return [render(header), '  ' + widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(render)]
}

/** 人类可读的终端报告。 */
export function renderReport(report: ReconcileReport): string {
  const out: string[] = []
  out.push(`月度账单对账 · ${report.period}`)
  out.push('')
  // 窗口必须打印：对账最怕「比的是两个不同的窗口」，而那种错误从数字上看不出来。
  out.push(`  估算来源：${report.source}`)
  out.push(`  账单文件：${report.billPath}`)
  out.push(`  统计窗口：${report.windowFromText} ~ ${report.windowToText}（本地自然月，两端都含）`)
  out.push(`              epoch ms [${report.windowSinceMs}, ${report.windowUntilMs}]`)
  out.push(`  单价来源：${report.pricingText}`)
  out.push(`  容差阈值：±${report.tolerancePercent}%（差额占比按账单金额算）`)
  out.push('')

  out.push('【按币种对账】估算 vs 账单（同币种内相减，绝不换算）')
  out.push(
    ...table(
      ['币种', '估算', '账单', '差额（估算−账单）', '差额占比'],
      report.currencies.map((line) => [
        line.currency,
        line.estimatedText,
        line.billText ?? '—',
        line.diffText ?? '—',
        line.ratioText,
      ]),
    ),
  )
  if (report.billTotalBasis === 'target-rows') {
    out.push('  ⚠️ 账单里没有「按月按币种」的总额行，上面的账单金额是**逐目标行求和**得出的。')
  } else {
    out.push('  账单金额取自「按月按币种」的总额行（逐目标行只用于下面的逐目标对账）。')
  }
  out.push('')

  out.push('【用量与覆盖】')
  const unpricedPercent = (report.unpriced.unpricedRate * 100).toFixed(2)
  out.push(
    `  有单价 token：${report.unpriced.pricedTokens}，未计价 token：${report.unpriced.unpricedTokens}，`
    + `合计：${report.unpriced.totalTokens}，未计价占比：${unpricedPercent}%`,
  )
  out.push('')

  const hints: string[] = []
  // 「估算侧一条用量都没有」与「库指错了」在数字上完全一样，所以先说这件事：
  // 否则「差额 −100%」会被读成「这个月用量暴涨/暴跌」。
  if (report.estimateEmpty) {
    hints.push(
      '这个窗口里估算侧一条用量都没有（总计 0 token）。先确认 --portal-db 指的是真的上报库、'
      + '--period 是不含时区的那个自然月，再看是不是这个月真的没有任何上报 —— '
      + '「库指错了」与「没用量」在数字上完全一样。',
    )
  }
  // ★ 未计价是差额**最常见**的成因，所以它是第一条线索。
  if (report.unpriced.unpricedTokens > 0) {
    hints.push(
      `有 ${unpricedPercent}% 的用量没配上单价（${report.unpriced.unpricedTokens} token）。`
      + '这部分估算必然偏低 —— 先补价再对账，否则差额里混着一个「我们没算」的量。',
    )
    if (report.unpriced.targets.length > 0) {
      hints.push(`未配单价的目标（最多列 ${report.unpriced.targets.length} 条）：${report.unpriced.targets.join('、')}`)
    }
  }
  for (const currency of report.onlyInBill) {
    hints.push(`账单里有 ${currency}，但我们这个月一条 ${currency} 的用量都没有（单价币种配错了？）`)
  }
  for (const currency of report.onlyInEstimate) {
    hints.push(`我们估算里有 ${currency}，但账单文件里一行 ${currency} 都没有`)
  }
  for (const item of report.breakdownMismatch) {
    hints.push(
      `账单文件自身不自洽：${item.currency} 的总额行是 ${formatCostMicro(item.monthMicro, item.currency)}，`
      + `而逐目标行之和是 ${formatCostMicro(item.targetSumMicro, item.currency)}（相差 `
      + `${formatCostMicro(item.monthMicro - item.targetSumMicro, item.currency)}）`,
    )
  }
  for (const note of report.duplicateNotes) hints.push(note)

  if (hints.length > 0) {
    out.push('【可行动的线索】')
    for (const hint of hints) out.push(`  · ${hint}`)
    out.push('')
  }

  if (report.targets.length > 0) {
    out.push(`【逐目标差异最大的 ${report.targets.length} 条】`)
    out.push(
      ...table(
        ['目标', '币种', '估算', '账单', '差额'],
        report.targets.map((line) => [
          line.target,
          line.currency,
          line.estimatedText,
          line.billText,
          `${line.diffText}（${line.ratioText}）`,
        ]),
      ),
    )
    out.push('')
  }

  out.push('【结论】')
  if (!report.hasDifference) {
    out.push('  各币种差额都在阈值内。')
  } else {
    const differing = report.currencies.filter((line) => line.status !== 'consistent').map((line) => line.currency)
    out.push(`  有差额：${differing.length > 0 ? differing.join('、') : '（账单文件自身不自洽）'}`)
  }
  out.push('  差额**不是**「我们算错了」：折扣、预付、赠送额度都不在单价里，自建计价 ≠ 财务账单。')
  out.push('')
  out.push(
    '说明：本脚本全程只读（不写上报库、不写任何文件）；'
    + '账单数字只出现在这里，绝不进页面 / 接口 / CLI 的其它输出。',
  )
  if (report.hasDifference) {
    out.push('说明：退出码 1 = 存在差额，不是崩溃；用法或输入错误才是退出码 2。')
  }
  return out.join('\n')
}

/** 机器可读形状（`--json`）。字段名与线上契约的 snake_case 保持一致的口径。 */
export function reportToJson(report: ReconcileReport): Record<string, unknown> {
  return {
    period: report.period,
    window: {
      since_ms: report.windowSinceMs,
      until_ms: report.windowUntilMs,
      from_text: report.windowFromText,
      to_text: report.windowToText,
    },
    estimate_source: report.source,
    bill_path: report.billPath,
    pricing: report.pricing,
    bill_total_basis: report.billTotalBasis,
    currency_lines: report.currencies.map((line) => ({
      currency: line.currency,
      estimated_micro: line.estimatedMicro,
      bill_micro: line.billMicro,
      diff_micro: line.diffMicro,
      diff_ratio: line.diffRatio,
      status: line.status,
      ratio_text: line.ratioText,
    })),
    only_in_estimate: report.onlyInEstimate,
    only_in_bill: report.onlyInBill,
    targets: report.targets.map((line) => ({
      target: line.target,
      currency: line.currency,
      estimated_micro: line.estimatedMicro,
      bill_micro: line.billMicro,
      diff_micro: line.diffMicro,
    })),
    unpriced: report.unpriced,
    breakdown_mismatch: report.breakdownMismatch,
    duplicate_notes: report.duplicateNotes,
    estimate_empty: report.estimateEmpty,
    tolerance_percent: report.tolerancePercent,
    has_difference: report.hasDifference,
    exit_code: report.hasDifference ? EXIT_DIFFERS : EXIT_CONSISTENT,
    read_only: true,
    note: '账单数字只出现在本脚本的输出里，绝不进页面 / 接口 / CLI 的其它输出。',
  }
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const USAGE = `月度账单对账（只读）。

用法：
  bun run reconcile:bill -- --portal-db <路径或连接串> --bill <账单.csv> --period YYYY-MM [选项]

参数：
  --portal-db <值>         上报库：SQLite 文件路径，或以 mysql:// 开头的连接串（必填）
  --bill <path>            账单 CSV（必填）
  --period <YYYY-MM>       要对的自然月（必填；账单按自然月出，两端都含）
  --tolerance-percent <n>  差额占比在 ±n% 内算一致（默认 0.5）
  --json                   输出机器可读 JSON（只打 JSON，不打表格）
  -h, --help               显示本帮助

账单 CSV 表头（顺序固定；前 3 列必须有，provider/model/note 按序可缺席）：
  period,currency,amount[,provider,model,note]
  · period    YYYY-MM
  · currency  三位大写字母（USD / CNY）
  · amount    货币单位金额，允许负数（退款 / 冲销）
  · provider/model  同时给出表示「逐目标」行；都不给表示「按月按币种」的总额行

示例（注意：表头有 provider/model 时，总额行也要把这两格**留空占位**，
不能少写逗号 —— 字段数与表头不符会被拒，那正是「少比了一行」的防线）：

  period,currency,amount,provider,model,note
  2026-01,CNY,0.0153,,,财务一月总额
  2026-01,CNY,0.0091,dashscope,qwen-max,
  2026-01,USD,0.0042,other,gpt-x,海外

退出码：
  0 = 一致或差额在阈值内    1 = 存在差额（不是崩溃）    2 = 用法 / 输入 / 环境错误`

interface CliOptions {
  portalDb: string
  billPath: string
  period: string
  tolerancePercent: number
  json: boolean
}

/** `--portal-db` 同时接受 SQLite 路径与 MySQL 连接串（与 `migrate-db.ts` 的两种目标同形）。 */
export function portalTargetFrom(input: string): PortalTarget {
  const value = input.trim()
  if (value === '') throw new ReconcileInputError('--portal-db 不能为空')
  if (/^mysql:\/\//i.test(value)) return { sqlitePath: '', mysqlUrl: value }
  return { sqlitePath: resolve(value) }
}

/**
 * 🚨 SQLite 上报库**必须已经存在**，否则拒绝往下走。
 *
 * 实测（本机 1.4.2）：给 `openPortalStats()` 一个不存在的 SQLite 路径，
 * 底座**不会报错**，而是当场新建一个空的 v7 上报库（393KB）并返回
 * 「零用量」—— 于是 `--portal-db` 写错一个字符的表现是
 * **一份看起来完全正常的对账报告（估算 0、差额 −100%）**，外加磁盘上多出一个
 * 冒牌空库。两件事都不可接受：
 *
 * 1. 本脚本承诺**只读**，而「打错路径」会写盘；
 * 2. 「少比了一个库」与「这个月真没用量」在数字上完全一样 —— 而对账最不能
 *    给出的结论就是「看起来对上了」。
 *
 * MySQL 侧无法在不连接的前提下判断，所以那条路由下面的「零用量告警」兜住。
 */
export function assertPortalTargetExists(target: PortalTarget): void {
  if (target.mysqlUrl) return
  if (!existsSync(target.sqlitePath)) {
    throw new ReconcileInputError(
      `上报库不存在：${target.sqlitePath}\n`
      + '（刻意不新建：给不存在的路径开库会安静地造出一个空库，'
      + '于是「路径写错」看起来就像「这个月没有用量」。请确认路径，或用 mysql:// 连接串。）',
    )
  }
}

export function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  // `bun run <script> -- --period x` 会把这个分隔符一起带进来，两种调用形式都认。
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const readOption = (name: string): string | undefined => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ReconcileInputError(`${name} 缺少值`)
    return value
  }

  if (args.includes('-h') || args.includes('--help')) return 'help'

  const portalDb = readOption('--portal-db')
  const billPath = readOption('--bill')
  const period = readOption('--period')
  const missing = [
    portalDb === undefined ? '--portal-db' : null,
    billPath === undefined ? '--bill' : null,
    // 刻意没有默认值：默认成「上个月」就是一个随日期漂移的窗口，而账单不会漂。
    period === undefined ? '--period' : null,
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) throw new ReconcileInputError(`缺少必填参数：${missing.join('、')}\n\n${USAGE}`)

  const toleranceText = readOption('--tolerance-percent') ?? '0.5'
  if (!/^\d+(?:\.\d+)?$/.test(toleranceText)) {
    throw new ReconcileInputError(`--tolerance-percent 必须是非负数字，实际是 ${JSON.stringify(toleranceText)}`)
  }

  return {
    portalDb: portalDb!,
    billPath: billPath!,
    period: period!,
    tolerancePercent: Number(toleranceText),
    json: args.includes('--json'),
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    console.log(USAGE)
    return EXIT_CONSISTENT
  }

  const window = monthWindow(parsed.period)
  const billFile = resolve(parsed.billPath)
  let csvText: string
  try {
    csvText = readFileSync(billFile, 'utf8')
  } catch (error) {
    throw new ReconcileInputError(`读不到账单文件 ${billFile}：${error instanceof Error ? error.message : String(error)}`)
  }
  const billRows = parseBillCsv(csvText)
  // 先校验账单（尤其是 `--period` 匹配），再去开库：参数错的时候不该已经连上生产库。
  const matched = selectBillRows(billRows, window.period).matched.length

  const target = portalTargetFrom(parsed.portalDb)
  // 必须在开库**之前**：给不存在的 SQLite 路径开库会新建一个空库（见函数注释）。
  assertPortalTargetExists(target)
  const session = await openPortalStats(
    target,
    // 显式两侧边界（含端），不用具名周期：账单上的月份是一个绝对区间。
    { sinceMs: window.sinceMs, untilMs: window.untilMs },
    // ⚠️ 刻意**不**加载供应商归一化规则：单价是按**上报原值**的 `(provider, model)` 匹配的
    //    （归一化只是查询期的展示口径），所以对账也必须按原值比。带上规则会让
    //    「按供应商看金额」的键变名字，而账单里的名字永远是财务/供应商的原名。
    undefined,
    // 本脚本是运维离线工具，等价于调用方有 `cost:read`；没有金额就无从对账。
    true,
  )
  let report: ReconcileReport
  try {
    const totals = await session.costTotals()
    if (totals === null) throw new ReconcileInputError('上报库没有返回金额（withCost 未生效？）—— 没有估算金额就无法对账')
    report = buildReport({
      period: window.period,
      window,
      source: describePortalTarget(target),
      billPath: billFile,
      estimate: { totals, byTarget: await session.costByGroup('provider-model') },
      billRows,
      tolerancePercent: parsed.tolerancePercent,
    })
  } finally {
    await session.close()
  }

  if (parsed.json) console.log(JSON.stringify(reportToJson(report), null, 2))
  else {
    console.log(renderReport(report))
    console.log(`（账单 ${matched} 行参与本次对账）`)
  }
  return report.hasDifference ? EXIT_DIFFERS : EXIT_CONSISTENT
}

// ⚠️ 只在**直接执行**时跑 CLI：`bun test` 会 import 本文件来单测那些纯函数，
//   那时 `import.meta.main` 是 false，绝不能顺带把 main() 跑起来。
if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    // 所有异常都落到 2 —— **保证退出码 1 永远只表示「存在差额」**。
    // 反过来说：把崩溃也报成 1，会让人以为「对完账了，就差一点」。
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT_INPUT_ERROR
  } finally {
    await closeAllMysqlBackends()
  }
}