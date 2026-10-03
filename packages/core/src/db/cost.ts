/**
 * 费用聚合的公共件：**离线路径**（本地库 / 直扫日志）与上报库查询路径共用同一份口径。
 *
 * ## 两条路径的差别只在「价从哪来」，不在「怎么算」
 *
 * | 路径 | 价从哪来 | 怎么算 |
 * |---|---|---|
 * | 部门看板（`portal.ts`） | `model_price` 表，由 SQL `LEFT JOIN` 按 `price_id` 分组 | JS 侧 `costMicroOf()` |
 * | 本地页 / CLI（本文件） | `pricing.json` 快照，没有就退回内置种子价 | JS 侧逐条事件解析 |
 *
 * 本地路径**没有** `model_price` 表（员工机器上只有一份可重建的 `usage.sqlite`，
 * 而且它必须能在断网时工作），所以价只能来自一份文件；而「四类分价相乘、
 * 按币种分桶、未计价显式给出」这些算法仍然只在 `packages/shared/src/price.ts`。
 * 本文件负责的是**取价与折叠**，不是口径。
 *
 * ## ★ 为什么逐条事件解析，而不是按 `(provider, model)` 汇总后再乘
 *
 * 单价带生效区间，**换价那一刻**两侧的事件适用不同的价。按「分组 token 总量 ×
 * 一个价」算，必然把换价前后的用量全按其中一个价算 —— 而它看起来完全正常。
 * 所以这里对每条事件按**它自己的时刻**取价（`resolvePrice(prices, …, rec.time)`），
 * 再折叠。事件数在单机量级（万级），代价可接受。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BUILTIN_PRICES,
  costMicroOf,
  parsePricingSnapshot,
  resolvePrice,
  summarizeCosts,
  type CostSummary,
  type ModelPrice,
  type PricingProvenance,
  type PricingSnapshot,
} from '@ai-token-report/shared'
import { groupKey, type GroupDimension } from '../aggregate.js'
import type { UsageRecord } from '../types.js'

/**
 * 一组用量的费用汇总 + **这份钱是按哪份单价算的**。
 *
 * ★ `pricing` 不是装饰：同一次查询在「读库」与「读快照」下会给出**两个不同的
 *   金额**，而两者都「看起来正常」。任何展示金额的地方都必须能回答这个问题。
 */
export interface CostTotals extends CostSummary {
  pricing: PricingProvenance
}

/** 整体金额 + 「哪些 `(provider, model)` 一条价都没配上」。 */
export interface CostTotalsWithTargets extends CostTotals {
  /** `provider/model` 形式，已排序、已截断；给的是**可行动**的那一部分。 */
  unpricedTargets: string[]
}

/** 未配价清单最多列几个（与上报库路径同一个上限）。 */
export const MAX_UNPRICED_TARGETS = 20

/** 单价快照的文件名（放在**数据目录**里：它是配置，不进可重建的 `usage.sqlite`）。 */
export const PRICING_FILE_NAME = 'pricing.json'

/**
 * 按「事件发生时刻」取价的函数。
 *
 * 参数里带 `atMs` 而不是只给 `(provider, model)`：换价是按时间发生的，
 * 少了时刻就只能给出「当前价」，历史用量会被按今天的价重算。
 */
export type PriceResolver = (
  provider: string,
  model: string,
  atMs: number,
) => ModelPrice | null

/**
 * 为一份价表建索引并返回取价函数。
 *
 * ★ 按 `(provider, model)` 先分桶：`resolvePrice()` 自己会过滤 provider / model，
 *   所以传进去的桶越小越好 —— 逐条事件、几万条记录时这是唯一的性能杠杆。
 *   桶内保留**多条区间**（同一个模型可以有多条生效区间），由 `resolvePrice()`
 *   取「当刻生效且起点最晚」的那条。
 */
export function priceResolver(prices: readonly ModelPrice[]): PriceResolver {
  const buckets = new Map<string, ModelPrice[]>()
  for (const price of prices) {
    const key = `${price.provider}\u0000${price.model}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(price)
    else buckets.set(key, [price])
  }
  return (provider, model, atMs) =>
    resolvePrice(buckets.get(`${provider}\u0000${model}`) ?? [], provider, model, atMs)
}

/**
 * 逐条事件的计价单元（喂给 `shared` 的 `summarizeCosts()`）。
 *
 * ⚠️ `price` 为 `null` 的那一条**不会被丢掉**：它整个计入 `unpricedTokens`。
 *   把没配价的用量直接跳过，会让「漏配了价」看起来像「这段没花钱」。
 */
export function costPartsOf(
  records: readonly UsageRecord[],
  resolve: PriceResolver,
): { usage: UsageRecord['usage']; price: ModelPrice | null }[] {
  return records.map((record) => ({
    usage: record.usage,
    price: resolve(record.provider, record.model, record.time),
  }))
}

/** 汇总一组事件的金额。 */
export function costTotalsOf(
  records: readonly UsageRecord[],
  resolve: PriceResolver,
  provenance: PricingProvenance,
): CostTotals {
  return { ...summarizeCosts(costPartsOf(records, resolve)), pricing: provenance }
}

/**
 * 零用量的金额。
 *
 * ★ 给**补零出来的桶**用：那些桶没有事件，但字段仍然要在 ——
 *   页面按「字段在不在」决定要不要画这一列/这一条线，
 *   缺席会让整张图在某个窗口突然没有金额，看起来像权限或数据出了问题。
 *   ⚠️ 它是 `costs: []`（不是 `¥0.00` 的一条 0 记录），所以「没有用量」
 *   与「用量没配价」在数据形状上仍然是两件事。
 */
export function emptyCostTotals(provenance: PricingProvenance): CostTotals {
  return { ...summarizeCosts([]), pricing: provenance }
}

/**
 * 按任意维度取金额，键与 `core/aggregate.ts` 的 `groupKey()` **逐字相同**。
 *
 * ★ 复用 `groupKey()` 而不是在这里另写一套键：分组键的口径（按项目名合并、
 *   按**本地时区**分桶、会话 ID）只有一份实现。自己拼一遍的话，
 *   排行里的键与金额表里的键会在「项目」与「按天」这两维上悄悄错开，
 *   而两张表看起来都正常 —— 只是对不上。
 */
export function costByGroupOf(
  records: readonly UsageRecord[],
  dim: GroupDimension,
  resolve: PriceResolver,
  provenance: PricingProvenance,
): Map<string, CostTotals> {
  const buckets = new Map<string, { usage: UsageRecord['usage']; price: ModelPrice | null }[]>()
  for (const record of records) {
    const key = groupKey(record, dim)
    const part = {
      usage: record.usage,
      price: resolve(record.provider, record.model, record.time),
    }
    const bucket = buckets.get(key)
    if (bucket) bucket.push(part)
    else buckets.set(key, [part])
  }
  const result = new Map<string, CostTotals>()
  for (const [key, parts] of buckets) {
    result.set(key, { ...summarizeCosts(parts), pricing: provenance })
  }
  return result
}

/**
 * 单条明细的金额。
 *
 * `currency: null` = 这条事件没有配价，**不是 0 元**（与上报库契约
 * `StatsRecordCost` 同一个语义：明细页上两者必须长得不一样）。
 */
export function recordCostOf(
  record: UsageRecord,
  resolve: PriceResolver,
): { currency: string | null; amountMicro: number } {
  const price = resolve(record.provider, record.model, record.time)
  if (price === null) return { currency: null, amountMicro: 0 }
  return { currency: price.currency, amountMicro: costMicroOf(record.usage, price) }
}

/**
 * 一条价都没配上的 `(provider, model)`，已排序、已截断。
 *
 * ★ 只给比例不够：知道「有 12% 没算钱」却不知道去补哪个价，
 *   等于把一个可修的数据问题变成一条无害的提示。
 */
export function unpricedTargetsOf(
  records: readonly UsageRecord[],
  resolve: PriceResolver,
  cap = MAX_UNPRICED_TARGETS,
): string[] {
  const targets = new Set<string>()
  for (const record of records) {
    if (resolve(record.provider, record.model, record.time) !== null) continue
    targets.add(`${record.provider}/${record.model}`)
  }
  return [...targets].sort().slice(0, cap)
}

// ---------------------------------------------------------------------------
// 离线单价快照：读、写
// ---------------------------------------------------------------------------

/** 本次计价用的那份价，以及它的来源。 */
export interface LocalPricing {
  prices: readonly ModelPrice[]
  provenance: PricingProvenance
  /**
   * 非空 = **这一份价不是同步来的快照**，以及为什么。
   *
   * 🚨 必须显示给使用者：退回内置价会让金额与看板**不一致**，
   *   而两者都「看起来正常」。静默退回等于让使用者拿着两个数去对账。
   */
  note: string | null
  /** 快照文件路径；没有数据目录、也没显式给文件时为 `null`。 */
  path: string | null
}

/** 快照文件路径（`--pricing-file` 优先，否则数据目录下的 `pricing.json`）。 */
export function resolvePricingPath(opts: {
  dataDir?: string | null
  file?: string | null
}): string | null {
  if (opts.file) return opts.file
  if (opts.dataDir) return join(opts.dataDir, PRICING_FILE_NAME)
  return null
}

/**
 * 读一份价：**快照优先，没有就退回内置种子价**（并说明原因）。
 *
 * 内置价刻意保留为兜底：CLI 必须能在断网、也没同步过的机器上回答「大概花了多少」。
 * 但它的名字必须出现在 `note` 里 —— 内置价只覆盖 deepseek-official 几个模型，
 * 内部网关的模型一条都不在表里，那部分会整个落进 `unpricedTokens`。
 */
export function loadLocalPricing(opts: {
  dataDir?: string | null
  file?: string | null
}): LocalPricing {
  const path = resolvePricingPath(opts)
  const builtin = (note: string): LocalPricing => ({
    prices: BUILTIN_PRICES,
    provenance: { pricingSource: 'builtin', pricingSyncedAt: null },
    note,
    path,
  })

  if (path === null) {
    return builtin('没有数据目录，也没有指定单价快照：按内置种子价估算')
  }
  if (!existsSync(path)) {
    return builtin(`还没有同步过单价快照（${path}）：按内置种子价估算`)
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return builtin(
      `读取单价快照失败（${path}：${err instanceof Error ? err.message : String(err)}）：按内置种子价估算`,
    )
  }
  const snapshot = parsePricingSnapshot(text)
  if (snapshot === null) {
    // ★ 整份拒绝，不做部分接受：半份单价表会让费用看起来正常却按内置价算，
    //   而 `pricingSyncedAt` 还显示着同步成功 —— 那是最难排查的一种。
    return builtin(
      `单价快照解析失败（${path}）：按内置种子价估算；` +
        '请重新执行 `ai-token-report pricing sync`，否则金额会与看板不一致',
    )
  }
  return {
    prices: snapshot.prices,
    provenance: {
      pricingSource: 'snapshot',
      pricingSyncedAt: snapshot.syncedAtMs,
    },
    note: null,
    path,
  }
}

/**
 * 写入单价快照（`pricing sync` 用）。
 *
 * ★ 原子替换（先写 `.tmp` 再 `rename`）：这个文件正被本地页 / CLI 读取，
 *   直接覆写会让一次读取读到**半份 JSON** —— 而 `parsePricingSnapshot()` 对
 *   半份的处理是整份拒绝，于是使用者会看到「内置种子价」这种莫名其妙的降级，
 *   而真正的原因只是一次并发读。
 *
 * ⚠️ 排序后再写：让两次同步同一份单价得到**逐字节相同**的文件，
 *   这样 `git diff` / 手工比对才是有意义的。服务端已按
 *   `(provider, model, effective_from_ms)` 排序，这里再排一次是为了
 *   「不管来源怎么排，落到磁盘上都是同一个顺序」。
 */
export function writePricingSnapshot(path: string, snapshot: PricingSnapshot): void {
  const sorted: PricingSnapshot = {
    syncedAtMs: snapshot.syncedAtMs,
    ...(snapshot.endpoint ? { endpoint: snapshot.endpoint } : {}),
    prices: [...snapshot.prices].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        a.effectiveFromMs - b.effectiveFromMs ||
        a.currency.localeCompare(b.currency),
    ),
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    // 半写的临时文件留在那里只会让下一次排障多一个疑点，能删就删。
    try {
      unlinkSync(tmp)
    } catch {
      // 删不掉就算了：真正的错误在下面抛出。
    }
    throw err
  }
}