/**
 * 模型单价的**输入 / 展示边界**（部门看板）。
 *
 * ★ 这里只做「库里存的整数微元」与「人在输入框里写的十进制」之间的换算，
 *   **不参与任何计费算术** —— `cost = 四类 token 各乘各自的价` 是
 *   `packages/shared/src/price.ts` 的口径，页面自己算一遍就是第二个口径实现，
 *   而它不会报错，只会让两个界面的金额对不上。
 *
 * ## 单位是「元 / 百万 token」，不是「元 / 千 token」
 *
 * 供应商价目表的原生单位就是百万（DeepSeek 官方页写「元 / 百万 tokens」），
 * 所以**表格与输入框都按百万呈现** —— 店里写 `¥2 / 百万`，框里就填 `2`。
 * 库里仍是「整数微元 / 千 token」，两者差 1000：
 *
 * ```
 * 2 元/百万  →  2000 微元/千    （× 1000）
 * 0.2 元/百万 →  200 微元/千
 * ```
 *
 * 🚨 为什么换算必须单独有测试：单价的量级小，小数位错一位就是 10 倍误差，
 *   而页面上只显示一个看起来很正常的数字。**总额的格式化器也不能拿来显示单价**
 *   —— `formatCostMicro(50, 'CNY')` 是 `0.0001`，而 50 微元/千 是 `¥0.05 / 百万 token`，
 *   混用就是差 2 倍（见 `shared/price.ts` 的 `formatUnitPriceMicro()`）。
 */
import { MAX_MICRO_PER_KTOK } from '@ai-token-report/shared'
import type { PortalModelPrice } from '@ai-token-report/shared'
import { isPriceEffective } from '@ai-token-report/shared'

/** 一微 = 1e-6 货币单位；库里单价按**千 token** 计，界面按**百万 token** 呈现。 */
export const MICRO_PER_UNIT = 1_000_000

/**
 * 界面单位（百万 token）与库里单位（千 token）之间的倍数。
 *
 * ★ 因为 1 微元/千 token 恰好 = 1 货币单位/百万 token，所以这一步是**整数倍**，
 *   两边互转都是精确的整数运算（`× 1000` / `÷ 1000`），没有浮点误差。
 */
export const KTOK_PER_MTOK = 1_000

/**
 * 输入框接受的最大小数位。
 *
 * 库里是**整数**微元（= 万亿分之一货币单位/百万 token），所以第 7 位起无法表示
 * —— 收下来就必然要悄悄四舍五入，而使用者会以为自己填进去了。宁可明确拒绝。
 */
export const MAX_RATE_DECIMALS = 6
const RATE_PATTERN = /^\d+(?:\.\d{1,6})?$/

/**
 * 十进制文本（货币单位 / 百万 token）→ 库里的整数微元 / 千 token；
 * 非法（负数、超过 6 位小数、超上限、非数字）返回 `null`。
 *
 * ⚠️ 返回 `null` 而不是抛错或夹到 0：调用方要能把「这一格没填对」指出来，
 *   而夹到 0 会让一个填错的价变成「免费」，那正是最危险的静默错误。
 */
export function rateTextToMicro(text: string, maxMicro: number = MAX_MICRO_PER_KTOK): number | null {
  const value = text.trim()
  if (!RATE_PATTERN.test(value)) return null
  const micro = Math.round(Number(value) * MICRO_PER_UNIT / KTOK_PER_MTOK)
  if (!Number.isSafeInteger(micro) || micro < 0 || micro > maxMicro) return null
  return micro
}

/** 整数微元 / 千 token → 输入框里预填的十进制文本（编辑已有单价时用）。 */
export function microToRateText(micro: number): string {
  return String(micro / KTOK_PER_MTOK)
}

/** 单价按**供应商**分组后的一节；模型是节内的行。 */
export interface PriceProviderGroup {
  provider: string
  rows: PortalModelPrice[]
  /** 节内不同的模型数（与行数不同：一个模型可以有多条生效区间）。 */
  models: number
}

export interface PriceGroupOptions {
  /** 子串匹配供应商 / 模型 / 备注（大小写不敏感）。 */
  search?: string
  /** 只留这个币种；空表示全部。 */
  currency?: string
  /** 只留**当前生效**的那些。 */
  onlyEffective?: boolean
  /** 「当前」的基准时刻；由调用方在**取数时**取一次，不要在这里读 `Date.now()`。 */
  nowMs: number
}

/**
 * 按供应商分组 —— 这就是「每个供应商下的不同模型各自定价」的落点。
 *
 * ★ 分组键用**归一化前**的原始 `provider`：单价必须与上报原值对上，
 *   而供应商归一化是**查询期**的展示口径（`provider_alias`）。若按归一化后的名字存价，
 *   改一条归一化规则就会让一批价突然对不上，而页面看起来毫无变化。
 *
 * 「当前生效」的判定走 `shared/price.ts` 的 `isPriceEffective`，
 * **不在这里重写一遍区间比较** —— 区间两端是含的（`[a, b]`），
 * 手写 `<` / `<=` 差一个边界就会让换价当天算错。
 */
export function groupPricesByProvider(
  prices: readonly PortalModelPrice[],
  options: PriceGroupOptions,
): PriceProviderGroup[] {
  const keyword = (options.search ?? '').trim().toLowerCase()
  const currency = options.currency ?? ''
  const byProvider = new Map<string, PortalModelPrice[]>()
  for (const row of prices) {
    if (currency && row.currency !== currency) continue
    if (options.onlyEffective && !priceIsEffective(row, options.nowMs)) continue
    if (keyword && !`${row.provider} ${row.model} ${row.note ?? ''}`.toLowerCase().includes(keyword)) continue
    const list = byProvider.get(row.provider)
    if (list) list.push(row)
    else byProvider.set(row.provider, [row])
  }
  return [...byProvider.entries()]
    .map(([provider, rows]) => ({ provider, rows, models: new Set(rows.map((row) => row.model)).size }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
}

/**
 * 生效区间的展示文本。
 *
 * ⚠️ `effective_from_ms === 0` 是「**自始有效**」，不是缺失值 —— 内置种子价就是这么标的。
 *   直接交给 `formatFullDateTime()` 会渲染成 `—`，看起来像「这条价没填起点」。
 */
export function priceSpanText(
  row: Pick<PortalModelPrice, 'effective_from_ms' | 'effective_to_ms'>,
  formatDateTime: (ms: number | null) => string,
): string {
  const from = row.effective_from_ms === 0 ? '自始' : formatDateTime(row.effective_from_ms)
  const to = row.effective_to_ms === null ? '至今' : formatDateTime(row.effective_to_ms)
  return `${from} → ${to}`
}

/** 区间字段的两种命名之间的唯一转换点（Portal 行 snake_case → 共享口径 camelCase）。 */
type PriceSpan = Pick<PortalModelPrice, 'effective_from_ms' | 'effective_to_ms'>

/**
 * 🚨 共享的 `isPriceEffective()` 收的是 **camelCase 的 `ModelPrice`**
 * （`effectiveFromMs` / `effectiveToMs`），而 Portal 行是 **snake_case**
 * （`effective_from_ms` / `effective_to_ms`）。
 *
 * 直接把 Portal 行递进去**不会报错**：两个字段都是 `undefined`，
 * `undefined < x` 与 `x <= undefined` 全为 false —— 于是**每一条价都被判成「没生效」**，
 * 页面表现是「只看当前生效」把整个目录清空、状态列全显示成「已结束」。
 * 类型上本该拦住，但这一层是展示层工具，值来自 HTTP 响应体，运行时没人替我们检查。
 * 所以转换只此一处，且被 `test/unit-price.test.ts` 的边界值断言钉住。
 */
function priceIsEffective(row: PriceSpan, nowMs: number): boolean {
  return isPriceEffective({ effectiveFromMs: row.effective_from_ms, effectiveToMs: row.effective_to_ms }, nowMs)
}

/** 一条价相对某个时刻的状态。 */
export function priceStatusOf(row: PriceSpan, nowMs: number): 'active' | 'future' | 'past' {
  if (priceIsEffective(row, nowMs)) return 'active'
  return row.effective_from_ms > nowMs ? 'future' : 'past'
}

export const PRICE_STATUS_TEXT: Record<'active' | 'future' | 'past', string> = {
  active: '生效中',
  future: '未开始',
  past: '已结束',
}