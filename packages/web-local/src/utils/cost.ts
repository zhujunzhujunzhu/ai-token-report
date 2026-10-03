/**
 * 金额的**展示层**格式化（本地页）。
 *
 * ★ 与 `utils/format.ts` 同一条规矩：这里**只格式化，绝不重算口径**。
 *   四类分价相乘、按币种分桶、未计价比例全部在
 *   `packages/shared/src/price.ts` 由服务端算好；本文件负责的只有
 *   「`14200` 微元 → `¥0.01`」与「两个币种 → `¥0.01 + $0.0005`」这两步。
 *
 * ⚠️ 页面上**绝不能**出现 `amountMicro / 1e6` 这类算式：微元是整数存储单位，
 *   前端自己换算就等于多一个「1 微是多少」的实现，而它不会报错 ——
 *   只会让页面与 CLI 差一个数量级。
 *
 * ## 本地页与部门看板的关键差别
 *
 * 看板读库里的 `model_price`，本地页读数据目录下的 `pricing.json` 快照
 * （没有就退回内置种子价）。**两者会给出不同的金额，而都「看起来正常」** ——
 * 所以本地页上「按哪份单价算的」这一行比看板还重要。
 */

import {
  formatCostMicro,
  formatCostSummary,
  type PricingProvenance,
  type StatsCostTotals,
} from '@ai-token-report/shared'

/** 没有配价时的统一措辞。**不要写 `¥0`**。 */
export const UNPRICED_TEXT = '未计价'

/** 金额文本；一个价都没配上时返回 `null`（由调用方决定显示什么）。 */
export function costText(cost: StatsCostTotals | undefined | null): string | null {
  if (!cost) return null
  // `formatCostSummary()` 是 shared 里唯一的多币种拼接实现（CLI / 看板 / 插件也用它）。
  return formatCostSummary(cost.costs)
}

/** 单个币种的金额文本。 */
export function currencyText(amountMicro: number, currency: string): string {
  return formatCostMicro(amountMicro, currency)
}

/** 单价来源的人话（缺字段时不许渲染成空）。 */
export function provenanceText(provenance: PricingProvenance | null | undefined): string {
  if (!provenance) return '按本机单价快照估算'
  const origin = provenance.pricingOrigin ? `（来源：${provenance.pricingOrigin}）` : ''
  switch (provenance.pricingSource) {
    case 'builtin':
      return `按内置种子价估算${origin}`
    case 'snapshot':
      return `按本机单价快照估算${provenance.pricingSyncedAt ? `（同步于 ${formatSyncTime(provenance.pricingSyncedAt)}）` : ''}${origin}`
    default:
      return '按服务端数据库中的单价估算'
  }
}

/** 快照同步时刻（本地时间，精确到分钟）。 */
function formatSyncTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 页面顶部那一行费用口径说明。
 *
 * 🚨 顺序是刻意的：**未计价 → 单价来源 → 缺哪个价**。
 *   「这部分没算钱」是这一行最需要被看见的一句话 ——
 *   少了它，一个偏小的金额会被读成「这个月省了不少」。
 */
export function describeCost(cost: StatsCostTotals | undefined | null): string | null {
  if (!cost) return null
  const parts: string[] = []
  if (cost.unpricedTokens > 0) {
    parts.push(
      `未计价 ${(cost.unpricedRate * 100).toFixed(1)}%（${cost.unpricedTokens.toLocaleString('en-US')} Token 没算钱）`,
    )
  }
  parts.push(provenanceText(cost.pricing))
  const targets = 'unpricedTargets' in cost ? (cost as { unpricedTargets?: string[] }).unpricedTargets : undefined
  if (targets && targets.length > 0) {
    const shown = targets.slice(0, 3)
    const rest = targets.length - shown.length
    parts.push(`还没配单价：${shown.join('、')}${rest > 0 ? ` 等 ${targets.length} 个` : ''}`)
  }
  return parts.join(' · ')
}
