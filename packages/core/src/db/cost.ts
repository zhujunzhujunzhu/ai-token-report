/**
 * 费用聚合的公共件：**离线路径**（本地库 / 直扫日志）与上报库查询路径共用同一份口径。
 *
 * ## 两条路径的差别只在「价从哪来」，不在「怎么算」
 *
 * | 路径 | 价从哪来 | 怎么算 |
 * |---|---|---|
 * | 部门看板（`portal.ts`） | `model_price` 表，由 SQL `LEFT JOIN` 按 `price_id` 分组 | JS 侧 `costMicroOf()` |
 * | 本地页 / CLI / 插件（本文件） | `pricing.json` 快照；没有就是**没有价**（`'none'`） | JS 侧逐条事件解析 |
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
  ANY_PROVIDER,
  costMicroOf,
  isAnyProvider,
  parsePricingSnapshot,
  priceRatesAt,
  resolvePrice,
  summarizeCosts,
  type CostPart,
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
 *
 * ★ **基础价（`'*'`）单独按模型分桶**，在专属桶没命中时查第二个桶 ——
 *   这与 `resolvePrice()` 的「专属优先、基础兜底」是同一条语义。
 *   🚨 少了这一步，基础价在离线路径上**永远不会生效**（专属桶里查不到 `'*'`），
 *   而金额看起来只是「没配价」——那是这套机制最隐蔽的一种失效。
 */
export function priceResolver(prices: readonly ModelPrice[]): PriceResolver {
  const buckets = new Map<string, ModelPrice[]>()
  const anyBuckets = new Map<string, ModelPrice[]>()
  for (const price of prices) {
    if (isAnyProvider(price.provider)) {
      const base = anyBuckets.get(price.model)
      if (base) base.push(price)
      else anyBuckets.set(price.model, [price])
      continue
    }
    const key = `${price.provider}\u0000${price.model}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(price)
    else buckets.set(key, [price])
  }
  return (provider, model, atMs) => {
    const exact = buckets.get(`${provider}\u0000${model}`)
    const hit = exact ? resolvePrice(exact, provider, model, atMs) : null
    if (hit !== null) return hit
    const base = anyBuckets.get(model)
    return base ? resolvePrice(base, ANY_PROVIDER, model, atMs) : null
  }
}

/**
 * 逐条事件的计价单元（喂给 `shared` 的 `summarizeCosts()`）。
 *
 * ⚠️ `price` 为 `null` 的那一条**不会被丢掉**：它整个计入 `unpricedTokens`。
 *   把没配价的用量直接跳过，会让「漏配了价」看起来像「这段没花钱」。
 *
 * 🚨 `rates` 必须一起带上：闲时（低谷）用量要用同一条价行里的**另一套四个数**。
 *   少了它就是按高峰价算闲时 —— 费用虚高一倍，且不会有任何报错。
 */
export function costPartsOf(
  records: readonly UsageRecord[],
  resolve: PriceResolver,
): CostPart[] {
  return records.map((record) => costPartOf(record, resolve))
}

/** 单条事件的计价单元（`price` + 该时刻适用的 `rates`）。 */
export function costPartOf(record: UsageRecord, resolve: PriceResolver): CostPart {
  const price = resolve(record.provider, record.model, record.time)
  if (price === null) return { usage: record.usage, price: null }
  return { usage: record.usage, price, rates: priceRatesAt(price, record.time) }
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
  const buckets = new Map<string, CostPart[]>()
  for (const record of records) {
    const key = groupKey(record, dim)
    const part = costPartOf(record, resolve)
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
 * ★ 价按**这条事件自己的时刻**选时段（闲时价 / 高峰价）。
 */
export function recordCostOf(
  record: UsageRecord,
  resolve: PriceResolver,
): { currency: string | null; amountMicro: number } {
  const price = resolve(record.provider, record.model, record.time)
  if (price === null) return { currency: null, amountMicro: 0 }
  return { currency: price.currency, amountMicro: costMicroOf(record.usage, priceRatesAt(price, record.time)) }
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
   * 🚨 必须显示给使用者：来源不同的两份价会给出两个**都「看起来正常」**的金额，
   *   静默降级等于让使用者拿着两个数去对账。
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
 * 读一份价：**只有快照这一条路**，读不到就是「没有价」。
 *
 * ★ 2026-10 起**不再有内置种子价兜底**（理由写在 `shared/price.ts` 文件尾）：
 *   兜底那一步会把「一条价都没配」伪装成一个看起来正常的金额，而它既不是看板的数、
 *   也不是账单的数。现在读不到就给**空价表** + `pricingSource: 'none'` + 一句原因，
 *   由展示层决定**整块不出现**（空价表算出来的全是「未计价」，渲染出去就是「没花钱」）。
 */
export function loadLocalPricing(opts: {
  dataDir?: string | null
  file?: string | null
}): LocalPricing {
  const path = resolvePricingPath(opts)
  const absent = (note: string): LocalPricing => ({
    prices: [],
    provenance: { pricingSource: 'none', pricingSyncedAt: null, pricingOrigin: null },
    note,
    path,
  })

  if (path === null) {
    return absent('没有数据目录，也没有指定单价快照：没有可用的单价，不显示金额')
  }
  if (!existsSync(path)) {
    return absent(`还没有同步过单价快照（${path}）：没有可用的单价，不显示金额`)
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return absent(
      `读取单价快照失败（${path}：${err instanceof Error ? err.message : String(err)}）：没有可用的单价，不显示金额`,
    )
  }
  const snapshot = parsePricingSnapshot(text)
  if (snapshot === null) {
    // ★ 整份拒绝，不做部分接受：半份单价表会让费用看起来正常却只算了一部分，
    //   而 `pricingSyncedAt` 还显示着同步成功 —— 那是最难排查的一种。
    return absent(
      `单价快照解析失败（${path}）：没有可用的单价，不显示金额；` +
        '请重新执行 `ai-token-report pricing sync`',
    )
  }
  // ★ 空快照与「没有快照」在展示上是**同一件事**：一条价都没有 = 没有金额。
  //   区分它们只会让每个消费方各写一遍「这算不算没有价」，而漏掉一处就是
  //   把一份空价表渲染成「没花钱」。
  if (snapshot.prices.length === 0) {
    return absent(`单价快照里一条价都没有（${path}）：没有可用的单价，不显示金额`)
  }
  return {
    prices: snapshot.prices,
    provenance: {
      pricingSource: 'snapshot',
      pricingSyncedAt: snapshot.syncedAtMs,
      pricingOrigin: snapshot.endpoint ?? null,
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
 *   半份的处理是整份拒绝，于是使用者会看到「没有可用的单价」这种莫名其妙的降级，
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
