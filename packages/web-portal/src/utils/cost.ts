/**
 * 金额的**展示层**格式化（部门看板）。
 *
 * ★ 与 `utils/format.ts` 同一条规矩：这里**只格式化，绝不重算任何口径**。
 *   金额的全部算法（四类分开乘、按币种分桶、未计价比例）都在
 *   `packages/shared/src/price.ts` 里由服务端算好；本文件负责的只有
 *   「`14200` 微元 → `¥0.01`」与「两个币种 → `¥0.01 + $0.0005`」这两步。
 *
 * 🚨 页面上**绝不能**出现 `amountMicro / 1000` 这类算式：微元是整数存储单位，
 *   一旦前端自己换算，就等于多了一个「1 微是多少」的口径实现，而它不会报错 ——
 *   只会让看板与 CLI 差一个数量级。
 *
 * ## 三种状态必须长得不一样
 *
 * | 情况 | 数据形状 | 页面显示 |
 * |---|---|---|
 * | 没有 `cost:read` | 字段整个缺席 | 不显示任何金额（列/卡片都不出现） |
 * | 有权限、这段用量没配价 | `costs: []`、`unpricedRate: 1` | **「未计价」**（不是 `¥0`） |
 * | 有权限、配了价 | `costs: [{currency, amountMicro}]` | `¥1.23`，另附未计价比例 |
 *
 * 中间那一行是这一期最危险的误读：显示成 `¥0` 会让「漏配了价」看起来像
 * 「这段时间省下了钱」。
 */

import {
  formatCostMicro,
  formatCostSummary,
  type CostByCurrency,
  type PricingProvenance,
  type StatsCost,
  type StatsCostTotals,
} from '@ai-token-report/shared'

/** 没有配价时的统一措辞。**不要写 `¥0`**。 */
export const UNPRICED_TEXT = '未计价'

/**
 * 金额文本；一个价都没配上时返回 `null`（由调用方决定显示
 * {@link UNPRICED_TEXT} 还是别的）。
 *
 * ★ 多币种用 ` + ` 连接、**绝不相加**：汇率是第二个口径的典型来源，
 *   而「¥1.23 + $0.45」本身就是个没有意义的数。
 */
export function costText(cost: StatsCostTotals | undefined | null): string | null {
  if (!cost) return null
  // `formatCostSummary()` 是 shared 里唯一的多币种拼接实现（CLI / 插件也用它）。
  return formatCostSummary(cost.costs)
}

/** 单个币种的金额文本。 */
export function currencyText(amountMicro: number, currency: string): string {
  return formatCostMicro(amountMicro, currency)
}

/** 「未计价 12.3%」；没有未计费用量时返回 `null`（不显示一栏恒为 0 的东西）。 */
export function unpricedText(cost: StatsCostTotals | undefined | null): string | null {
  if (!cost || cost.unpricedTokens <= 0) return null
  return `未计价 ${(cost.unpricedRate * 100).toFixed(1)}%`
}

/**
 * 卡片 / 列的附加说明：**未计价有多少 + 这份钱按哪份单价算的 + 缺哪个价**。
 *
 * 🚨 「按哪份单价」不是装饰：服务端读库里的价、离线端读快照的价，
 *   两者会给出**两个不同的金额**。任何展示金额的地方都得能回答这个问题。
 *
 * ⚠️ 未计价一定排在**最前面**：它是这一屏最需要被看见的一句话，
 *   也是唯一能让「金额偏小」这件事不被误读成「省了钱」的东西。
 */
export function pricingHint(
  cost: StatsCostTotals | undefined | null,
  provenance?: PricingProvenance | null,
): string {
  const source = provenanceText(provenance ?? cost?.pricing ?? null)
  return [unpricedText(cost), source, unpricedTargetsText(cost)].filter(Boolean).join(' · ')
}

/** 单价来源的人话。 */
export function provenanceText(provenance: PricingProvenance | null | undefined): string {
  if (!provenance) return '按服务端数据库中的单价现算'
  switch (provenance.pricingSource) {
    case 'snapshot':
      return '按本地单价快照现算'
    case 'builtin':
      return '按内置种子价现算'
    default:
      return '按服务端数据库中的单价现算'
  }
}

/**
 * 未配价的目标清单 → 一句可行动的话。
 *
 * ★ 只给比例是不够的：知道「有 12% 没算钱」却不知道去补哪个价，
 *   等于把一个可修的数据问题变成一条无害的提示。
 *
 * ⚠️ **最多列 3 个**：这是一行卡片说明，不是清单页。全部列出来会把
 *   说明挤成一团，而「有 40 个模型没配价」这件事本身的结论是
 *   「该去计价页成批配」，不是逐条读出来。
 */
export function unpricedTargetsText(cost: StatsCostTotals | undefined | null): string | null {
  if (!cost || !('unpricedTargets' in cost)) return null
  const targets = (cost as StatsCost).unpricedTargets
  if (!targets || targets.length === 0) return null
  const shown = targets.slice(0, MAX_TARGETS_IN_HINT)
  const rest = targets.length - shown.length
  return `这些模型还没配单价：${shown.join('、')}${rest > 0 ? ` 等 ${targets.length} 个` : ''}`
}

/** 卡片说明里最多列出几个未配价目标（其余折成「等 N 个」）。 */
export const MAX_TARGETS_IN_HINT = 3

/** 某个币种列表里是否只有一个币种（用于决定要不要显示币种标签）。 */
export function singleCurrency(costs: readonly CostByCurrency[]): string | null {
  return costs.length === 1 ? (costs[0]?.currency ?? null) : null
}

/** 趋势图上金额那条线的指标名（与卡片、列头同一套措辞）。 */
export const COST_LABEL = '费用（估算）'

/** 趋势图上的金额序列（值仍是**服务端原值的整数微元**）。 */
export interface CostSeries {
  /** 每个点的金额（微元）。点的顺序与传入的点一致，缺金额的点是 0。 */
  values: number[]
  /** 这段区间里唯一的币种；`null` = 一条价都没配上。 */
  currency: string | null
  label: string
  /** 非空表示这个指标**现在不能画**，原因是它（页面据此禁用而不是静默换算）。 */
  disabledReason: string | null
}

/**
 * 把趋势点上的金额组装成一条可画的序列。
 *
 * ## ★ 为什么要返回「为什么不能画」而不是硬画一条
 *
 * 一个区间里可能同时出现多种币种（`currency: 'rmb'` 与 `'USD'` 就是两桶）。
 * 单轴折线**只能画一个币种**，而两种情况都不可接受：
 *   - 把它们相加 → 造出一个「两种货币加在一起」的数（口径错误）；
 *   - 只画其中一个 → 另一个币种的钱在图上**看不见**，而图上没有任何迹象。
 * 所以多币种时如实说「有 N 种币种，不叠加」，让人去看分布表的费用列
 * —— 那里是按币种分开列的。
 *
 * 返回 `null` 表示**整段连 `cost` 字段都没有**（没有 `cost:read`）：
 * 此时页面上连这个指标选项都不该出现。
 */
export function costSeriesOf(
  points: readonly { cost?: StatsCostTotals }[],
): CostSeries | null {
  const withCost = points.filter((point) => point.cost)
  if (withCost.length === 0) return null

  const currencies = new Set<string>()
  for (const point of withCost) {
    for (const entry of point.cost!.costs) currencies.add(entry.currency)
  }

  if (currencies.size > 1) {
    const sorted = [...currencies].sort()
    return {
      values: points.map(() => 0),
      currency: null,
      label: COST_LABEL,
      disabledReason:
        `本次区间内有 ${sorted.length} 种币种（${sorted.join(' / ')}）：` +
        '金额绝不跨币种相加，所以趋势图不叠加它们，请看下方分布表的费用列',
    }
  }

  const currency = [...currencies][0] ?? null
  return {
    values: points.map(
      (point) =>
        point.cost?.costs.find((entry) => entry.currency === currency)
          ?.amountMicro ?? 0,
    ),
    currency,
    label: COST_LABEL,
    // 有权限但一条价都没配：画一条全 0 的线会看起来像「这段没花钱」。
    disabledReason:
      currency === null
        ? '这段时间的用量一条单价都没配上：未计价不等于 0 元，画不出金额趋势'
        : null,
  }
}

/**
 * 金额坐标轴的刻度文本。
 *
 * ⚠️ 刻度值仍是**微元**，只是显示成货币：曲线的数据从不做单位换算。
 */
export function costTickFormatter(currency: string): (value: number) => string {
  return (value) => formatCostMicro(Math.round(value), currency)
}