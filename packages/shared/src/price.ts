/**
 * 费用口径 —— 全平台唯一的计价公式与单价解析来源。
 *
 * ★ 与 `metrics.ts` 同一条铁律：任何地方要算费用，**必须调用这里**。
 *   在 SQL 里写除法、在前端写一遍乘法，都会产生第二个口径 ——
 *   它不会报错，只会让看板与 CLI 显示两个不同的金额。
 *
 * ## 费用 ≠ 账单
 *
 * 这里算的是 `token × 单价` 的**理论成本**，不是**实际付款**。
 * 真实账单含折扣、预付、赠送额度与阶梯价，自建计价永远不会等于财务账单。
 * 外部账单只用于月度对账（`packages/server/scripts/reconcile-bill.ts`），
 * **绝不参与这里的计算**。
 *
 * ## 四条设计约束（改本文件前必读）
 *
 * 1. **四类分价**：`cacheRead` 与 `input` 单价差约一个数量级，`output` 最贵。
 *    不存在「一个模型的单价」这种东西，单价永远是四元组。
 * 2. **绝不落 `cost` 列**：查询时按「事件时间 + 单价生效区间」重算。
 *    落库等于把口径固化进事实表，单价一错就永久错。
 * 3. **未定价绝不当 0**：那会让「费用偏低」看起来像「省钱了」。
 *    未定价 token 一律汇总进 `unpricedTokens`，由页面显式展示。
 * 4. **整数微元**：金额一律用「微元」整数累加，只在展示时除到元。
 *    几十万条 × 小数累加，浮点必然出现分位误差。
 */

import { computeTotal, type TokenUsage } from './metrics.js'

/** 参与计价的四类 token。`reasoning` 不在其中 —— 它是 `output` 的子集。 */
export type BillableUsage = Pick<TokenUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>

/**
 * 单价：**微元 / 千 token** 的整数。
 *
 * 1 微元 = 1e-6 个货币单位。例如 `¥2 / 1M tokens = ¥0.002 / 1K = 2000 微元/千`。
 * ★ 顺带一个好用的换算：**1 微元/千 token ≡ 1 货币单位/百万 token**，
 *   所以库里那个整数除以 1000 就是「元 / 百万 token」原值 —— 页面上显示的就是它。
 *
 * 为什么用整数微元而不是小数：金额要跨几十万条事件、跨模型累加，
 * 小数累加必然出现分位误差，而「金额对不上」是最难说服人的 bug。
 */
export type MicroPerKtok = number

/**
 * 单价上限：1e7 微元/千 token = 10 个货币单位/千 token = 10,000 个货币单位/百万 token。
 *
 * 现实中最贵的模型约 `$15 / 1M`（= 15,000 微元/千），这里留了约 600 倍余量。
 * 超过这个量级只可能是录入错误，应当拒绝而不是算出一个天文数字。
 *
 * ★ 这个上限**同时是溢出边界的依据**：见 {@link MAX_SAFE_BILLABLE_TOKENS}。
 */
export const MAX_MICRO_PER_KTOK = 10_000_000

/**
 * 在本单价上限下，整数微元累加仍然精确的 token 总量上限（约 9,007 亿）。
 *
 * 推导：`cost = (tokens / 1000) × price`，要 `tokens/1000 × price ≤ MAX_SAFE_INTEGER`，
 * 取 `price = MAX_MICRO_PER_KTOK` 即得。
 *
 * 本部门实测全体用量是 **23.9 亿**（`packages/dsh-plugin/README.md`），
 * 距此上限还有约 380 倍余量。超出时 {@link costMicroForTokens} **抛错而不是返回错数**。
 */
export const MAX_SAFE_BILLABLE_TOKENS = Math.floor(Number.MAX_SAFE_INTEGER / MAX_MICRO_PER_KTOK) * 1000

/** 单价表的一行。`provider` + `model` 精确匹配，生效区间不得重叠。 */
export interface ModelPrice extends PriceRates {
  provider: string
  model: string
  /** ISO 4217 三位代码，大写（`USD` / `CNY`）。 */
  currency: string
  /** epoch 毫秒，含。 */
  effectiveFromMs: number
  /** epoch 毫秒，含；`null` = 至今。 */
  effectiveToMs: number | null
}

/** 四类 token 各自的单价。 */
export interface PriceRates {
  inputMicroPerKtok: MicroPerKtok
  outputMicroPerKtok: MicroPerKtok
  cacheReadMicroPerKtok: MicroPerKtok
  cacheWriteMicroPerKtok: MicroPerKtok
}

/** 单价的来源，必须随费用一起展示 —— 见 §「单价来源」下方注释。 */
export type PricingSource = 'db' | 'snapshot' | 'builtin'

/**
 * 单价来源元信息。
 *
 * ★ 离线端用快照、服务端用数据库表，**两者一旦不同就会给出两个不同的费用**。
 *   因此任何展示费用的地方都必须能回答「这份费用是按哪份单价、什么时候算的」。
 *   **缺这些字段时不得渲染金额**（与「缺字段必须按 member 处理」同一条安全逻辑）。
 */
export interface PricingProvenance {
  pricingSource: PricingSource
  /** 快照同步时刻；`db` / `builtin` 为 `null`。 */
  pricingSyncedAt: number | null
}

// ---------------------------------------------------------------------------
// 单价解析
// ---------------------------------------------------------------------------

/** 归一化币种代码：去空白转大写。非法格式返回 `null`。 */
export function normalizeCurrency(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const upper = code.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(upper) ? upper : null
}

/** 单价各字段是否为合法的非负整数且在 {@link MAX_MICRO_PER_KTOK} 之内。 */
export function isValidPriceRates(rates: Partial<PriceRates>): boolean {
  return (['inputMicroPerKtok', 'outputMicroPerKtok', 'cacheReadMicroPerKtok', 'cacheWriteMicroPerKtok'] as const)
    .every((key) => {
      const value = rates[key]
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MICRO_PER_KTOK
    })
}

/** 一个单价在 `atMs` 时点是否生效。区间两端都含。 */
export function isPriceEffective(price: Pick<ModelPrice, 'effectiveFromMs' | 'effectiveToMs'>, atMs: number): boolean {
  if (!Number.isFinite(atMs)) return false
  if (atMs < price.effectiveFromMs) return false
  return price.effectiveToMs === null || atMs <= price.effectiveToMs
}

/**
 * 解析出某个 `(provider, model)` 在 `atMs` 时点适用的单价。找不到返回 `null`。
 *
 * ★ **精确匹配**，不做子串。子串会把 `deepseek-v4.1-flash` 与
 *   `deepseek-v4.1-flash-preview` 串成同一个价 —— 那是数据错误，不是便利。
 *   （与「人员筛选是精确匹配」同理。）
 *
 * 生效区间本应在写入时保证不重叠；真出现重叠时取 `effectiveFromMs` 最大的一行，
 * 让行为可预测而不是「看数据库返回顺序」。
 */
export function resolvePrice(
  prices: readonly ModelPrice[],
  provider: string,
  model: string,
  atMs: number,
): ModelPrice | null {
  let best: ModelPrice | null = null
  for (const price of prices) {
    if (price.provider !== provider || price.model !== model) continue
    if (!isPriceEffective(price, atMs)) continue
    if (best === null || price.effectiveFromMs > best.effectiveFromMs) best = price
  }
  return best
}

/**
 * 两行的 `(provider, model)` 是否相同。
 *
 * ⚠️ **币种不同不构成豁免**：{@link resolvePrice} 只按 `(provider, model, 时点)` 返回
 *   **一行**，若同一区间下同时存在 USD 与 CNY 两行，取哪一行就取决于兜底顺序 ——
 *   那是「费用取决于数据库返回顺序」，必须由写入时的冲突校验挡掉。
 */
function sameTarget(a: ModelPrice, b: ModelPrice): boolean {
  return a.provider === b.provider && a.model === b.model
}

/**
 * 两个生效区间是否相交。
 *
 * ★ 区间两端都含（与 {@link isPriceEffective} 一致），所以 `[0,100]` 与 `[100,200]`
 *   **算相交** —— 时点 100 会同时命中两行。若这里按半开区间判断，写入时放行、
 *   解析时却有两行可选，费用就会取决于 `resolvePrice` 的兜底顺序。
 */
export function priceRangesOverlap(
  a: Pick<ModelPrice, 'effectiveFromMs' | 'effectiveToMs'>,
  b: Pick<ModelPrice, 'effectiveFromMs' | 'effectiveToMs'>,
): boolean {
  const aTo = a.effectiveToMs ?? Number.POSITIVE_INFINITY
  const bTo = b.effectiveToMs ?? Number.POSITIVE_INFINITY
  return a.effectiveFromMs <= bTo && b.effectiveFromMs <= aTo
}

/**
 * 在既有单价表里找出与候选行冲突的行（同一 `provider` + `model` 且区间重叠）。
 *
 * ★ 这条规则**只有这一份实现**：管理页的即时校验与服务端写入前的校验都调它，
 *   否则「页面允许但接口拒绝」这类不一致会长期存在。
 */
export function findPriceConflicts(existing: readonly ModelPrice[], candidate: ModelPrice): ModelPrice[] {
  return existing.filter((row) => sameTarget(row, candidate) && priceRangesOverlap(row, candidate))
}

// ---------------------------------------------------------------------------
// 计价
// ---------------------------------------------------------------------------

/**
 * `tokens` 按 `microPerKtok` 计价，返回整数微元。
 *
 * ★ 这是全平台唯一的取整点：任何一处直接写 `tokens / 1000 * price`
 *   都会引入浮点误差，而「金额对不上」是最难说服人的 bug。
 *
 * ★ 整数域内先算整千、再补不足一千的余数（两者都是纯整数运算），
 *   避免 `tokens × price` 这个更大的中间量；
 *   超出 {@link MAX_SAFE_BILLABLE_TOKENS} 时**抛错**，绝不返回一个已经丢精度的钱数
 *   —— 金额这种数字上，静默不准比明确失败糟得多。
 */
export function costMicroForTokens(tokens: number, microPerKtok: MicroPerKtok): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  if (!Number.isFinite(microPerKtok) || microPerKtok <= 0) return 0
  const whole = Math.floor(tokens / 1000)
  const rest = tokens - whole * 1000
  const result = whole * microPerKtok + Math.round((rest * microPerKtok) / 1000)
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(
      `计价超出安全整数范围（tokens=${tokens}，单价=${microPerKtok} 微元/千 token）：` +
        '请检查单价是否录错，或该聚合量级是否已超出 MAX_SAFE_BILLABLE_TOKENS。',
    )
  }
  return result
}

/** 四类 token 按四类单价计价后的合计（整数微元）。 */
export function costMicroOf(usage: BillableUsage, price: PriceRates): number {
  return (
    costMicroForTokens(usage.input, price.inputMicroPerKtok) +
    costMicroForTokens(usage.output, price.outputMicroPerKtok) +
    costMicroForTokens(usage.cacheRead, price.cacheReadMicroPerKtok) +
    costMicroForTokens(usage.cacheWrite, price.cacheWriteMicroPerKtok)
  )
}

/**
 * 缓存读相对「按未命中输入价计费」省下的微元。
 *
 * 比「19.3 倍杠杆」更有说服力，且不引入新口径（同属 cost 族）。
 * 当 `cacheRead` 单价高于 `input` 时结果为**负数**（缓存反而更贵），
 * 这里**不做截断** —— 截断会让「缓存策略选错了」这类事实消失。
 */
export function cacheSavingMicro(usage: Pick<BillableUsage, 'cacheRead'>, price: PriceRates): number {
  return (
    costMicroForTokens(usage.cacheRead, price.inputMicroPerKtok) -
    costMicroForTokens(usage.cacheRead, price.cacheReadMicroPerKtok)
  )
}

/**
 * 未定价占比 = 无单价 token 数 / 总 token 数。
 *
 * ★ **这是本模块最重要的护栏。**
 *   把未定价当 0 会让「费用偏低」看起来像「省钱了」——
 *   与「不能把待确认历史当匿名」是同一类错误。
 *
 * 无数据时返回 0 而非 NaN（与 `cacheHitRate` 同一条约定）。
 */
export function unpricedRate(unpricedTokens: number, totalTokens: number): number {
  return totalTokens === 0 ? 0 : unpricedTokens / totalTokens
}

// ---------------------------------------------------------------------------
// 汇总（服务端与离线端共用，避免各自实现一遍分组累加）
// ---------------------------------------------------------------------------

/** 一个计价单元：通常来自一个 `(provider, model)` 分组的汇总。 */
export interface CostPart {
  usage: BillableUsage
  /** 该单元适用的单价；`null` = 未定价，整个单元计入 `unpricedTokens`。 */
  price: ModelPrice | null
}

/** 某个币种下的费用小计。 */
export interface CostByCurrency {
  currency: string
  /** 整数微元。 */
  amountMicro: number
  /** 计入该币种的 token 数。 */
  tokens: number
}

/** 一组用量的费用汇总。 */
export interface CostSummary {
  /**
   * 按币种分别累加，**绝不跨币种相加**（汇率是第二个口径的典型来源）。
   * 按 `currency` 升序排列，保证同一份数据永远给出同一个顺序
   * —— 双后端逐位对账会直接比对响应体 JSON。
   */
  costs: CostByCurrency[]
  /** 有单价的 token 数。 */
  pricedTokens: number
  /** 无单价的 token 数。 */
  unpricedTokens: number
  /** 总 token 数（= 四类之和）。 */
  totalTokens: number
  /** 有单价 token / 总 token；无数据时 0。 */
  pricedRate: number
  /** 未定价 token / 总 token；无数据时 0。 */
  unpricedRate: number
}

function totalOf(usage: BillableUsage): number {
  // ★ 复用计费恒等式，不在这里重写加法（铁律 1）。
  return computeTotal({ ...usage, reasoning: 0 })
}

/**
 * 把若干计价单元汇总成费用结果。
 *
 * `pricedRate + unpricedRate === 1`（无数据时两者都是 0），
 * 所以页面永远能说清「这笔钱覆盖了多少用量」。
 */
export function summarizeCosts(parts: readonly CostPart[]): CostSummary {
  const byCurrency = new Map<string, CostByCurrency>()
  let pricedTokens = 0
  let unpricedTokens = 0
  let totalTokens = 0

  for (const part of parts) {
    const tokens = totalOf(part.usage)
    totalTokens += tokens
    if (part.price === null) {
      unpricedTokens += tokens
      continue
    }
    const currency = normalizeCurrency(part.price.currency) ?? part.price.currency
    const amountMicro = costMicroOf(part.usage, part.price)
    const bucket = byCurrency.get(currency)
    if (bucket) {
      bucket.amountMicro += amountMicro
      bucket.tokens += tokens
    } else {
      byCurrency.set(currency, { currency, amountMicro, tokens })
    }
    pricedTokens += tokens
  }

  return {
    costs: [...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
    pricedTokens,
    unpricedTokens,
    totalTokens,
    pricedRate: totalTokens === 0 ? 0 : pricedTokens / totalTokens,
    unpricedRate: unpricedRate(unpricedTokens, totalTokens),
  }
}

// ---------------------------------------------------------------------------
// 展示（四个形态共用一份格式化，否则同一笔钱会显示成四种样子）
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', JPY: '¥', GBP: '£' }

/**
 * 微元 → 展示字符串。
 *
 * 小数位固定规则（确定性优先：同一金额在任何界面都一样）：
 * 绝对值 < 1 用 4 位小数（费用常常很小，2 位会把 `$0.0032` 显示成 `$0.00`），
 * 否则用 2 位。
 */
export function formatCostMicro(amountMicro: number, currency: string): string {
  const code = normalizeCurrency(currency) ?? currency
  const value = amountMicro / 1_000_000
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 1 ? 4 : 2
  const text = value.toFixed(digits)
  const symbol = CURRENCY_SYMBOLS[code]
  return symbol ? `${symbol}${text}` : `${code} ${text}`
}

/**
 * 单价 → 展示字符串（**每百万 token** 的价钱）。
 *
 * 界面上一律按「货币单位 / 百万 token」呈现 —— 那是各家供应商价目表的原生单位
 * （DeepSeek 官方页就是「元 / 百万 tokens」），也是人**能直接照着核对**的写法：
 * 店里写 `¥2 / 百万`，框里就填 `2`。
 *
 * ★ 库里存的仍是「整数微元 / 千 token」，两者差 1000：
 *   `microPerKtok / 1000` 就是「元 / 百万 token」原值。
 * ★ 位数按**百万级**定：最小可表达增量是 1 微元/千 token = `1e-6` 元/百万，
 *   即 6 位小数恰好精确（`0.2`、`0.00004`），末尾的 0 裁掉。
 *   `microPerKtok / 1000` 是整数除 1000，浮点误差远在 6 位小数之外，不会显错。
 */
export function formatUnitPriceMicro(microPerKtok: number, currency: string): string {
  const code = normalizeCurrency(currency) ?? currency
  const text = (microPerKtok / 1000).toFixed(6).replace(/\.?0+$/, '')
  const symbol = CURRENCY_SYMBOLS[code]
  return `${symbol ? `${symbol}${text}` : `${code} ${text}`} / 百万 token`
}

/**
 * 汇总成一行可展示文本；多币种时用 ` + ` 连接（**不相加**）。
 * 没有任何币种（全部未定价）时返回 `null` —— 让调用方显式处理「无金额」，
 * 而不是渲染成 `$0.00`。
 */
export function formatCostSummary(costs: readonly CostByCurrency[]): string | null {
  if (costs.length === 0) return null
  return costs.map((cost) => formatCostMicro(cost.amountMicro, cost.currency)).join(' + ')
}

// ---------------------------------------------------------------------------
// 线上契约 → 内存形态
// ---------------------------------------------------------------------------

/**
 * 线上契约里的单价字段（snake_case）。
 *
 * ★ 刻意写成结构类型而**不** import `PortalModelPrice`：那个接口定义在同级的
 *   `portal-identity.ts`，让它反过来依赖本模块会形成循环 import。
 *   结构类型在这里是同构的 —— `PortalModelPrice` 原样满足它。
 */
export interface WireModelPriceFields {
  provider: string
  model: string
  currency: string
  input_micro_per_ktok: number
  output_micro_per_ktok: number
  cache_read_micro_per_ktok: number
  cache_write_micro_per_ktok: number
  effective_from_ms: number
  /** `null` = 至今有效。**绝不允许归一成 0** —— 0 是一个合法的、早已过去的终点。 */
  effective_to_ms: number | null
}

/**
 * 线上单价 → `shared/price.ts` 的内存形态。
 *
 * ## 为什么这个转换必须只有一份
 *
 * 「NULL 怎么处理」与「字段叫什么」这两件事一旦有两份实现，它们分叉时
 * **不会报错**：一边把 `effective_to_ms = NULL` 读成 `0`，那条价在页面上
 * 就显示成「1970 年就结束了」，而且从此再也匹配不上任何事件 ——
 * 金额看起来只是「少算了点」。
 *
 * 服务端从数据库行取值、CLI 从 HTTP 响应取值、都走这里（前者先经
 * `modelPriceFromRow()` 把驱动返回值归一成数字）。
 *
 * ⚠️ 这里**不做** `normalizeCurrency()`：`model_price.currency` 有
 *   `^[A-Z]{3}$` 的 CHECK，而 `PortalModelPrice` 是同一行数据的线上投影，
 *   在这里归一会让「管理页显示 `RMB`、金额按 `RMB` 记账、快照里又变成别的」
 *   这种不一致有了滋生的地方。只有**磁盘上的快照**才需要归一 ——
 *   文件不经过数据库约束（见 `parsePricingSnapshot()`）。
 */
export function modelPriceFromWire(wire: WireModelPriceFields): ModelPrice {
  return {
    provider: wire.provider,
    model: wire.model,
    currency: wire.currency,
    inputMicroPerKtok: wire.input_micro_per_ktok,
    outputMicroPerKtok: wire.output_micro_per_ktok,
    cacheReadMicroPerKtok: wire.cache_read_micro_per_ktok,
    cacheWriteMicroPerKtok: wire.cache_write_micro_per_ktok,
    effectiveFromMs: wire.effective_from_ms,
    effectiveToMs: wire.effective_to_ms === null ? null : wire.effective_to_ms,
  }
}

// ---------------------------------------------------------------------------
// 离线单价快照（CLI / 本地页 / 插件宿主共用解析）
// ---------------------------------------------------------------------------

/** `pricing.json` 的内容。是**配置**，不进可重建的 `usage.sqlite`。 */
export interface PricingSnapshot {
  syncedAtMs: number
  /** 同步来源地址，仅用于展示与排障。 */
  endpoint?: string
  prices: ModelPrice[]
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析快照文本。任何不合法的行都**整份拒绝**（返回 `null`），不做部分接受。
 *
 * 理由：部分接受会让「半份单价表」悄悄生效，费用看起来正常但实际按内置价算，
 * 而页面上的 `pricingSyncedAt` 还显示着同步成功 —— 这是最难排查的一种。
 *
 * 手写校验而不是用 zod：`zod` 只能从 `@ai-token-report/shared/schemas` 进，
 * 根入口一旦 re-export 就会进浏览器产物（只会变大，不会报错）。
 */
export function parsePricingSnapshot(text: string): PricingSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const syncedAtMs = asNumber(record.syncedAtMs)
  if (syncedAtMs === null) return null
  if (!Array.isArray(record.prices)) return null

  const prices: ModelPrice[] = []
  for (const entry of record.prices) {
    if (typeof entry !== 'object' || entry === null) return null
    const row = entry as Record<string, unknown>
    const provider = row.provider
    const model = row.model
    const currency = normalizeCurrency(row.currency)
    const effectiveFromMs = asNumber(row.effectiveFromMs)
    const effectiveToMs = row.effectiveToMs === null ? null : asNumber(row.effectiveToMs)
    if (typeof provider !== 'string' || provider === '') return null
    if (typeof model !== 'string' || model === '') return null
    if (currency === null) return null
    if (effectiveFromMs === null) return null
    if (effectiveToMs === null && row.effectiveToMs !== null) return null
    if (!isValidPriceRates(row as Partial<PriceRates>)) return null
    prices.push({
      provider,
      model,
      currency,
      effectiveFromMs,
      effectiveToMs,
      inputMicroPerKtok: row.inputMicroPerKtok as number,
      outputMicroPerKtok: row.outputMicroPerKtok as number,
      cacheReadMicroPerKtok: row.cacheReadMicroPerKtok as number,
      cacheWriteMicroPerKtok: row.cacheWriteMicroPerKtok as number,
    })
  }
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint : undefined
  return { syncedAtMs, ...(endpoint ? { endpoint } : {}), prices }
}

// ---------------------------------------------------------------------------
// 内置种子价
// ---------------------------------------------------------------------------

/**
 * 内置种子价 —— **只是首次部署的起点，不是权威**。权威是数据库 `model_price` 表。
 *
 * ## 来源与快照说明
 *
 * 取自 DeepSeek 官方定价页（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）的
 * **高峰档**人民币报价 —— 官方原页的单位就是「元 / 百万 tokens」，
 * 与库里的「整数微元/千 token」正好差 1000 倍（见 {@link MicroPerKtok}）。
 * 官方原价目只有「cache hit / cache miss / output」三档，与这里的四类分价同构。
 *
 * | 模型 | 缓存命中 | 缓存未命中 | 输出 |
 * |---|---|---|---|
 * | `deepseek-flash` / `deepseek-v4.1-flash` | ¥0.04 | ¥2 | ¥8 |
 * | `deepseek-v4-pro` | ¥0.30 | ¥9 | ¥27 |
 *
 * ## ⚠️ 两处刻意的口径简化，管理员必须知道
 *
 * 1. **只取高峰价。** 官方空闲档是高峰的一半，而高峰窗（北京时间周一至周五
 *    09:00-12:00 与 14:00-18:00）正是国内工作时段，所以对本部门而言高峰价就是实际价。
 *    按峰谷精确分类必须逐事件判定，会把时间口径复制进 SQL，
 *    与「时间分桶必须在 JS 侧做」的铁律冲突，故首版不做。
 *    界面上必须标注「未区分高峰/低谷」。
 * 2. **`effectiveFromMs = 0`（视作自始生效）。** 内置种子只是让首次部署立刻有数；
 *    管理员应在单价管理页按**真实生效日**修正，否则历史费用会按今天的价重算。
 *
 * ## 刻意不收录的
 *
 * `dashscope`（数字集团网关）与各内部网关的模型**不在此表**：
 * 这些网关的结算价是另一套口径（转售、折扣、汇总账单），拿官方零售价套上去
 * 会给出一个「看起来像官方价、其实不是自己付的钱」的数字 —— 那比留空更糟。
 * 留空会进 `unpricedTokens`，由页面显式告诉使用者「这部分没算钱」。
 */
export const BUILTIN_PRICES: readonly ModelPrice[] = [
  {
    provider: 'deepseek-official',
    // ⚠️ `deepseek-flash` 与 `deepseek-v4.1-flash` 是**两条价**：官方明说旧模型名
    //    `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调用并按 Flash 价计费，
    //    而单价必须在**上报原值**上精确匹配（不做子串），所以别名要各配一行。
    model: 'deepseek-v4.1-flash',
    currency: 'CNY',
    // 缓存命中 ¥0.04/百万、缓存未命中 ¥2/百万、输出 ¥8/百万（高峰档）
    cacheReadMicroPerKtok: 40,
    inputMicroPerKtok: 2000,
    outputMicroPerKtok: 8000,
    // DeepSeek 不单列缓存写入价：写入按 cache miss 输入计价。
    cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0,
    effectiveToMs: null,
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    cacheReadMicroPerKtok: 40,
    inputMicroPerKtok: 2000,
    outputMicroPerKtok: 8000,
    cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0,
    effectiveToMs: null,
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'CNY',
    // 缓存命中 ¥0.30/百万、缓存未命中 ¥9/百万、输出 ¥27/百万（高峰档）
    cacheReadMicroPerKtok: 300,
    inputMicroPerKtok: 9000,
    outputMicroPerKtok: 27000,
    cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0,
    effectiveToMs: null,
  },
]