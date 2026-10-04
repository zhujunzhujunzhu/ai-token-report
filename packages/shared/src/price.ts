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

/**
 * 保留供应商名：**不限供应商的「基础价」**。
 *
 * ## 为什么用一个保留值，而不是把 `provider` 允许成空
 *
 * `model_price.provider` 有 `length(provider) BETWEEN 1 AND 255` 的 CHECK，
 * 把它放开成「可以为空」意味着在 SQLite 上**重建整张表**（CHECK 不可 ALTER）、
 * 在 MySQL 上摘挂引用该列的 CHECK 约束 —— 那是 v5 那一类高风险迁移，
 * 换来的只是一个更好看的字面量。所以基础价写成 `'*'`，
 * 由 {@link isAnyProvider} / 页面统一渲染成「不限供应商（基础价）」。
 *
 * ## 语义（★ 三条，改这里之前先读）
 *
 * 1. **专属价优先**：`(provider, model)` 命中就用它，命不中才用基础价（`'*'`, `model`）。
 *    ⚠️ 这是**两层**匹配，不是「把 `'*'` 当成一个供应商」——
 *    取数 SQL 因此 join 两次（专属一次、基础一次，且基础那次带 `mp_e.price_id IS NULL`），
 *    基础价与专属价**可以共存**，不会互相把对方的 token 算进去。
 * 2. 🚨 **两条基础价覆盖同一时刻仍然是冲突**：那时「用哪一条」没有别的判据，
 *    一条事件会匹配两行、被算两遍（token 翻倍、两个价都算一份）。
 *    这条不变量由写入路径的 {@link findPriceConflicts} 兜住（回 409）。
 * 3. `'*'` **不是**合法的上报供应商名：它永远不会出现在 `usage_event.provider` 里，
 *    所以不会与真实网关重名。
 */
export const ANY_PROVIDER = '*'

/** 是否为「不限供应商」的基础价行。 */
export function isAnyProvider(provider: string): boolean {
  return provider === ANY_PROVIDER
}

/**
 * 计价时段。
 *
 * ★ 只有两档：高峰（`peak`，价行自身那四个数）与闲时 / 低谷（`offpeak`，
 *   价行的 `offpeakRates`）。**没有第三档** —— 再多一档就该建时段表，
 *   而不是在这里加一个枚举值。
 */
export type PriceSlot = 'peak' | 'offpeak'

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
  /**
   * 闲时（低谷）四类单价；**缺席与 `null` 同义 = 这条价不分时段**（全天一个价）。
   *
   * ⚠️ 两种「没填」在这里没有区别 —— 与 `effective_to_ms` 的 `null` 完全不同
   *   （那里 `null` = 至今、`0` = 早已失效，混了就是一条再也匹配不上的价）。
   *   所以这里刻意允许省略：几十处测试夹具不必逐个补字段。
   */
  offpeakRates?: PriceRates | null
  /**
   * 闲时时段表 id（见 {@link PRICE_SCHEDULES}）；与 `offpeakRates` **同生共死**。
   *
   * 🚨 有 `offpeakRates` 却没有时段表 = 那四个数永远不会生效（闲时判定
   *   必须先知道「哪段时间算闲时」），写入路径会直接拒绝这种行。
   */
  offpeakSchedule?: string | null
}

/** 四类 token 各自的单价。 */
export interface PriceRates {
  inputMicroPerKtok: MicroPerKtok
  outputMicroPerKtok: MicroPerKtok
  cacheReadMicroPerKtok: MicroPerKtok
  cacheWriteMicroPerKtok: MicroPerKtok
}

/**
 * 单价的来源，必须随费用一起展示 —— 见 §「单价来源」下方注释。
 *
 * ★ **没有 `'builtin'`**：本仓不再有任何内置 / 种子价目表（2026-10 去掉）。
 *   一条价都没有时是 `'none'`，此时**一位金额都不渲染** ——
 *   空价表照样能「算出」一个数（全是未计价），而它在屏幕上与「花得很少」长得一样。
 */
export type PricingSource = 'db' | 'snapshot' | 'none'

/**
 * 单价来源元信息。
 *
 * ★ 离线端用快照、服务端用数据库表，**两者一旦不同就会给出两个不同的费用**。
 *   因此任何展示费用的地方都必须能回答「这份费用是按哪份单价、什么时候算的」。
 *   **缺这些字段时不得渲染金额**（与「缺字段必须按 member 处理」同一条安全逻辑）。
 */
export interface PricingProvenance {
  pricingSource: PricingSource
  /** 快照同步时刻；`db` / `none` 为 `null`。 */
  pricingSyncedAt: number | null
  /**
   * 这份单价的人可核对来源。
   *
   * - `snapshot`：通常是同步快照时的部门服务端地址；
   * - `none`：`null`（一条价都没有，谈不上来源）；
   * - `db`：`null`（来源就是服务端数据库本身）。
   *
   * ★ 这是给展示层回答「这份钱按哪来的价算」用的，不参与任何匹配或计价逻辑。
   */
  pricingOrigin?: string | null
}

// ---------------------------------------------------------------------------
// 闲时（低谷）时段表 —— ★ 全平台唯一的「哪段时间算高峰」的定义
// ---------------------------------------------------------------------------

/** 高峰时段：`[startMinute, endMinute)`，从时段表的偏移零点起算的分钟数。 */
export interface PriceScheduleWindow {
  readonly startMinute: number
  readonly endMinute: number
}

/**
 * 一个闲时时段表 = 「一天里哪些时刻算高峰」。
 *
 * ## 为什么用固定偏移（`utcOffsetMinutes`）而不是时区名
 *
 * 🚨 时区名会把 `Intl` / 操作系统时区 / 夏令时拖进来，而**取数 SQL 里也要算出同一个判定**
 *   （见 {@link isOffpeakAt} 与 `core/src/db/query.ts` 的时段表达式）。
 *   固定偏移是**纯整数算术**，两种后端与 JS 逐位一致；中国没有夏令时，
 *   所以「北京时间 = UTC+8」用固定偏移表达是精确的，不是近似。
 *
 * ## 为什么节假日是常量表而不是配置
 *
 * 高峰窗只落在工作日的 09:00–12:00 / 14:00–18:00（北京），
 * 其余时间（含**全部周末**，包括调休上班的周末 —— 官方明确把调休周末算空闲时段）
 * 本来就是闲时。所以「节假日」只影响**落在工作日的高峰窗**，
 * 一年最多十几个工作日。它的权威来源是国务院办公厅每年 11 月的通知，
 * 没有任何接口能查 —— 只能逐年补表（{@link PriceSchedule.holidaysThrough} 明确写覆盖到哪天，
 * 页面会把它显示出来，绝不让「表过期」变成静默低估）。
 */
export interface PriceSchedule {
  readonly id: string
  /** 页面上给人看的名字。 */
  readonly label: string
  /** 出处（人能照着核对）。 */
  readonly source: string
  /** 固定 UTC 偏移，分钟（北京 = `480`）。 */
  readonly utcOffsetMinutes: number
  /** 高峰落在星期几：`0` = 周日 … `6` = 周六。 */
  readonly weekdays: readonly number[]
  /** 高峰时段（可多段），按偏移后的一天内的分钟数。 */
  readonly windows: readonly PriceScheduleWindow[]
  /** 法定节假日（`YYYY-MM-DD`，按同一个固定偏移记日）—— 全天都算闲时。 */
  readonly holidays: readonly string[]
  /** 节假日表覆盖的年份下界（含）。更早的日子按「不豁免」处理。 */
  readonly holidaysFrom: string
  /** 节假日表覆盖到哪一天（含）。**超出这个日期必须补表**，否则工作日节假日会被按高峰计。 */
  readonly holidaysThrough: string
}

/**
 * DeepSeek 官方时段（`deepseek-official` 的人民币价目表）。
 *
 * | 档 | 时段（北京时间） |
 * |---|---|
 * | 高峰 | 周一至周五（不含法定节假日）09:00–12:00、14:00–18:00 |
 * | 闲时 | 其余全部时间，**含周末与法定节假日全天** |
 *
 * 出处：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
 * （「空闲时段价格为高峰时段价格的一半」）。
 * 英文页把同一时段写成 UTC 的 `01:00-04:00` 与 `06:00-10:00`，周一至周五 —— 与这里等价。
 */
const DEEPSEEK_CN: PriceSchedule = {
  id: 'deepseek-cn',
  label: 'DeepSeek 官方（北京时间工作日高峰）',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  utcOffsetMinutes: 480,
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { startMinute: 9 * 60, endMinute: 12 * 60 },
    { startMinute: 14 * 60, endMinute: 18 * 60 },
  ],
  // 国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号）与
  // 《关于 2025 年部分节假日安排的通知》（国办发明电〔2024〕12 号）里的**全部放假日期**。
  // 周末本来就在闲时，列进来是为了让这份表与通知逐条对得上（人核对时不用自己补周末）。
  holidays: [
    // 2025
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
    '2025-04-04', '2025-04-05', '2025-04-06',
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
    '2025-05-31', '2025-06-01', '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
    // 2026
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  ],
  holidaysFrom: '2025-01-01',
  holidaysThrough: '2026-12-31',
}

/** 全部时段表。**按 id 引用**，价行只存 id（`offpeak_schedule`）。 */
export const PRICE_SCHEDULES: readonly PriceSchedule[] = [DEEPSEEK_CN]

/** 按 id 取时段表；未知 id 返回 `null`（**绝不兜底成某一个时段表**）。 */
export function findPriceSchedule(id: string | null | undefined): PriceSchedule | null {
  if (id === null || id === undefined || id === '') return null
  return PRICE_SCHEDULES.find((schedule) => schedule.id === id) ?? null
}

/**
 * `YYYY-MM-DD` → 「偏移后的一天」的序号（= `Math.floor(偏移后的 epoch ms / 86400000)`）。
 *
 * ⚠️ 用 `Date.UTC` 而不是 `new Date('2026-10-01')`：后者按**进程时区**解析，
 *   在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下会得到相差一天的结果，
 *   而这条判定同时被 SQL 用整数算术复现 —— 差一天就是「某天的价算错」，且不报错。
 */
function dayIndexOfDate(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(utc) ? utc / 86_400_000 : null
}

/**
 * 每个时段表的节假日「天序号」集合（惰性、只建一次）。
 *
 * 常量表里有非法日期就直接抛错：那是代码错误，宁可 import 时就炸，
 * 也不要静默少一天 —— 少一天等于某个节假日的用量按高峰计价。
 */
const holidayDayIndexCache = new Map<string, ReadonlySet<number>>()

/** 把状态里的节假日表落成天序号集合（也供 `query.ts` 内联进 SQL）。 */
export function scheduleHolidayDayIndices(schedule: PriceSchedule): readonly number[] {
  const cached = holidayDayIndexCache.get(schedule.id)
  if (cached) return [...cached]
  const days: number[] = []
  for (const date of schedule.holidays) {
    const day = dayIndexOfDate(date)
    if (day === null) throw new Error(`时段表 ${schedule.id} 的节假日 ${date} 不是合法的 YYYY-MM-DD`)
    days.push(day)
  }
  const unique = [...new Set(days)].sort((a, b) => a - b)
  holidayDayIndexCache.set(schedule.id, new Set(unique))
  return unique
}

/** 偏移后的一天里的第几分钟（`0`–`1439`）。 */
function shiftedMinuteOfDay(schedule: PriceSchedule, atMs: number): number {
  const shifted = atMs + schedule.utcOffsetMinutes * 60_000
  return ((Math.floor(shifted / 60_000) % 1440) + 1440) % 1440
}

/** 偏移后的一天序号。 */
function shiftedDayIndex(schedule: PriceSchedule, atMs: number): number {
  return Math.floor((atMs + schedule.utcOffsetMinutes * 60_000) / 86_400_000)
}

/**
 * `atMs` 在这个时段表下是否**高峰**。
 *
 * 🚨 这个函数与 `core/src/db/query.ts` 里由同一份时段表**生成的 SQL 表达式**
 *   必须逐位一致 —— 前者管逐事件 / 离线路径，后者管聚合取数。
 *   两边漂移的表现是「总览与明细的金额对不上」，而**两边都不报错**；
 *   所以 `core/test/portal-cost.test.ts` 用一整天的逐分钟网格把这两条路对了一遍。
 *   ⚠️ 那边**绝不允许**用 `strftime(..., 'localtime')` / `FROM_UNIXTIME()` / `DAYOFWEEK()`：
 *   它们按 OS 或 SQL 会话时区算，而这里是固定偏移的整数算术。
 */
export function isPeakAt(schedule: PriceSchedule, atMs: number): boolean {
  if (!Number.isFinite(atMs)) return false
  const day = shiftedDayIndex(schedule, atMs)
  // 0 = 周日；1970-01-01（第 0 天）是周四 = 4。
  const weekday = ((day + 4) % 7 + 7) % 7
  if (!schedule.weekdays.includes(weekday)) return false
  const minute = shiftedMinuteOfDay(schedule, atMs)
  if (!schedule.windows.some((w) => minute >= w.startMinute && minute < w.endMinute)) return false
  // ★ 节假日**只在这时**才起作用：它们只把「工作日的高峰窗」翻成闲时，
  //   落在周末的节假日本来就已经是闲时（不查表结果一样）。
  return !scheduleHolidayDayIndices(schedule).includes(day)
}

/** `atMs` 是否闲时（低谷）= 不是高峰。没有时段表时**恒为 `false`**（不分时段）。 */
export function isOffpeakAt(schedule: PriceSchedule | null, atMs: number): boolean {
  if (schedule === null) return false
  return !isPeakAt(schedule, atMs)
}

/**
 * 这条价在 `atMs` 时刻落在哪个时段。
 *
 * ★ 没有闲时档（或缺时段表）时**恒为 `peak`**：那四个 `offpeak*` 数一个都用不上，
 *   错误地报成 `offpeak` 会让一条没有闲时价的用量按**不存在**的价算。
 */
export function priceSlotAt(price: ModelPrice, atMs: number): PriceSlot {
  const schedule = findPriceSchedule(price.offpeakSchedule)
  if (price.offpeakRates == null || schedule === null) return 'peak'
  return isOffpeakAt(schedule, atMs) ? 'offpeak' : 'peak'
}

/**
 * 这条价在 `atMs` 时刻**实际适用**的四类单价。
 *
 * 🚨 凡是「逐事件算钱」的地方都必须过这里（看板逐事件路径、离线折叠、明细行、插件宿主）：
 *   直接 `costMicroOf(usage, price)` 会把闲时用量按高峰价算 —— 费用虚高一倍。
 */
export function priceRatesAt(price: ModelPrice, atMs: number): PriceRates {
  if (priceSlotAt(price, atMs) === 'offpeak') return price.offpeakRates as PriceRates
  return price
}

/**
 * 按 `slot` 取这条价该用的四类单价（聚合路径用：时段由 SQL 判好）。
 *
 * ⚠️ `slot === 'offpeak'` 却没有闲时档时**退回高峰价**而不是抛错：
 *   那种行只可能来自直接改库，抛错会让整个看板挂掉；退回高峰价至少能显示出来。
 */
export function priceRatesForSlot(price: ModelPrice, slot: PriceSlot): PriceRates {
  if (slot === 'offpeak') return price.offpeakRates ?? price
  return price
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
 * ★ **专属价优先，基础价兜底**：先找 `(provider, model)`，找不到再找
 *   `({@link ANY_PROVIDER}, model)`。两条都找不到才算未计价。
 *   ⚠️ 这里**不做**「模糊匹配」（例如拿 `deepseek-flash` 去配 `deepseek-v4.1-flash`）：
 *   模型改名时宁可让它进「未计价」清单被人看见，也不要静默套一个别的模型的价。
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
  return bestEffectivePrice(prices, provider, model, atMs) ?? bestEffectivePrice(prices, ANY_PROVIDER, model, atMs)
}

/** 在价表里找「`provider` + `model` 且当刻生效」的那一行（起点最晚者优先）。 */
function bestEffectivePrice(
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
 * 两行的 `(provider, model)` 是否落在同一个「计价槽」里（= 同一时刻会同时命中）。
 *
 * ★ **基础价（`'*'`）与同名的专属价不算同一个槽**：专属优先、基础兜底是
 *   **两层**匹配，取数 SQL 也是这么写的（先 join 一次专属价，再在
 *   `mp_e.price_id IS NULL` 的前提下 join 一次基础价）。
 *   所以「基础价 + 某个供应商的专属价」是合法的组合 —— 明细里同一模型、
 *   同一时刻两行给出不同金额，那正是「这个供应商另有协议价」的证据。
 *
 * 🚨 两条**基础价**覆盖同一时刻仍然是冲突（也由 `findPriceConflicts` 拒掉）：
 *   那时「用哪一条」没有别的判据，一条事件会匹配两行、token 被算两遍。
 *
 * ⚠️ **币种不同不构成豁免**：同一槽里的两行会让费用的币种取决于读取顺序，
 *   必须由写入时的冲突校验挡掉。
 */
function sameTarget(a: ModelPrice, b: ModelPrice): boolean {
  return a.model === b.model && a.provider === b.provider
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
 * 在既有单价表里找出与候选行冲突的行。
 *
 * ## 两类冲突
 *
 * 1. **同一个计价槽 + 区间重叠**：同一个 `(provider, model)` —— 注意基础价
 *    （`'*'`）与同名的**专属价**刻意**不算**同一个槽（专属优先、基础兜底，
 *    见 {@link sameTarget}），所以它们可以共存。
 * 2. 区间重叠的判定两端都含，见 {@link priceRangesOverlap}。
 *
 * ★ 这条规则**只有这一份实现**：管理页的即时校验与服务端写入前的校验都调它，
 *   否则「页面允许但接口拒绝」这类不一致会长期存在。
 *
 * ⚠️ 数据库的 UNIQUE 索引**只拦「`(provider, model, effective_from_ms)` 完全相同」**
 *   那一类，`[1,100]` vs `[50,200]` 与「两条基础价」它一概拦不住 ——
 *   这两条只有应用层兜着（同 `AGENTS.md` 的 MySQL 坑 5）。
 */
export function findPriceConflicts(existing: readonly ModelPrice[], candidate: ModelPrice): ModelPrice[] {
  return existing.filter((row) => sameTarget(row, candidate) && priceRangesOverlap(row, candidate))
}

/**
 * 一条价行的「闲时档」是否自洽：**四个数全有 + 时段表已知**，或者**全都不要**。
 *
 * 返回 `null` = 合法，否则返回一句可直接展示的中文原因。
 *
 * ★ 放在 `shared` 里是因为它有**两个**消费者：服务端写入前的校验、
 *   管理页提交前的即时校验。两边各写一份的话，「页面放行、接口拒绝」
 *   或者更糟的「两边都放行、库里存了一行永远不生效的闲时价」都会出现。
 */
export function offpeakConfigError(price: Pick<ModelPrice, 'offpeakRates' | 'offpeakSchedule'>): string | null {
  const rates = price.offpeakRates ?? null
  const schedule = price.offpeakSchedule ?? null
  if (rates === null && schedule === null) return null
  if (rates === null) return '选了闲时时段就必须填闲时四类单价（否则这四个数没有对应的时段）'
  if (!isValidPriceRates(rates)) return '闲时四类单价必须都是 0 到 10000000 之间的整数微元'
  if (schedule === null) return '填了闲时单价就必须选择闲时时段（否则不知道哪段时间算闲时）'
  if (findPriceSchedule(schedule) === null) {
    return `未知的闲时时段「${schedule}」：时段表只有 ${PRICE_SCHEDULES.map((s) => s.id).join(' / ')}`
  }
  return null
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
  /** 该单元适用的单价行；`null` = 未定价，整个单元计入 `unpricedTokens`。 */
  price: ModelPrice | null
  /**
   * 这一单元该用哪四类单价；缺席 = 用 `price` 自己的四类（高峰价）。
   *
   * ★ 聚合取数路径用它：时段由 SQL 判好（`price_slot`），JS 侧只需按时段取价。
   *   逐事件路径不需要它 —— 那边直接 `priceRatesAt(price, ts)`。
   * ⚠️ 它与 `price` 是**同一个币种**：时段只换四个数，不换币种。
   */
  rates?: PriceRates | null
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
 *
 * ⚠️ 计价用的是 `part.rates ?? part.price`：聚合路径会把「这一撮用量落在哪个时段」
 *   一起带进来（闲时价与高峰价是同一行的两套数），**不是**再乘一个折扣系数 ——
 *   四类分价各自独立，任何「乘个比例」的写法都会在缓存那一档上算错。
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
    const amountMicro = costMicroOf(part.usage, part.rates ?? part.price)
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
  /**
   * v10 的四类闲时单价；`null`（或旧服务端**整个字段缺席**）= 这条价不分时段。
   *
   * ⚠️ 四个字段必须**同进同出**：只来两个的话，那两档会按 0 元算
   *   （0 元是合法单价，`costMicroForTokens()` 不会报错）。
   *   所以下面一律「四个都是数字才认」，否则整条按「无闲时档」处理。
   */
  offpeak_input_micro_per_ktok?: number | null
  offpeak_output_micro_per_ktok?: number | null
  offpeak_cache_read_micro_per_ktok?: number | null
  offpeak_cache_write_micro_per_ktok?: number | null
  /** v10 的闲时时段表 id（见 {@link PRICE_SCHEDULES}）；缺席 = 不分时段。 */
  offpeak_schedule?: string | null
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
  const offpeakRates = offpeakRatesFromWire(wire)
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
    offpeakRates,
    offpeakSchedule: offpeakRates === null ? null : (wire.offpeak_schedule ?? null),
  }
}

/**
 * 四个闲时单价**齐了才算**（见 {@link WireModelPriceFields} 里那条注释）。
 *
 * ⚠️ 缺一个就整条当「不分时段」，绝不把缺的那个当 0 元：0 是合法单价，
 *   于是那个时段会被算成免费 —— 而页面上只看得出「这个月花得少」。
 */
function offpeakRatesFromWire(wire: WireModelPriceFields): PriceRates | null {
  const rates: PriceRates = {
    inputMicroPerKtok: wire.offpeak_input_micro_per_ktok as number,
    outputMicroPerKtok: wire.offpeak_output_micro_per_ktok as number,
    cacheReadMicroPerKtok: wire.offpeak_cache_read_micro_per_ktok as number,
    cacheWriteMicroPerKtok: wire.offpeak_cache_write_micro_per_ktok as number,
  }
  if (Object.values(rates).some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null
  return isValidPriceRates(rates) ? rates : null
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
    // ★ 闲时档（v10）：要么四个数齐全且时段表已知，要么两个字段都缺席。
    //   半个闲时档**整份拒绝**（与其他不合法行同一条纪律）：按 0 元算的那两档
    //   会让费用静默偏低，而文件里的 `syncedAtMs` 还显示同步成功。
    const offpeakRates = row.offpeakRates === undefined || row.offpeakRates === null
      ? null
      : (typeof row.offpeakRates === 'object' && isValidPriceRates(row.offpeakRates as Partial<PriceRates>)
        ? {
            inputMicroPerKtok: (row.offpeakRates as PriceRates).inputMicroPerKtok,
            outputMicroPerKtok: (row.offpeakRates as PriceRates).outputMicroPerKtok,
            cacheReadMicroPerKtok: (row.offpeakRates as PriceRates).cacheReadMicroPerKtok,
            cacheWriteMicroPerKtok: (row.offpeakRates as PriceRates).cacheWriteMicroPerKtok,
          }
        : undefined)
    if (offpeakRates === undefined) return null
    const offpeakSchedule = row.offpeakSchedule === undefined || row.offpeakSchedule === null
      ? null
      : (typeof row.offpeakSchedule === 'string' ? row.offpeakSchedule : undefined)
    if (offpeakSchedule === undefined) return null
    if (offpeakConfigError({ offpeakRates, offpeakSchedule }) !== null) return null
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
      offpeakRates,
      offpeakSchedule,
    })
  }
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint : undefined
  return { syncedAtMs, ...(endpoint ? { endpoint } : {}), prices }
}

// ---------------------------------------------------------------------------
// 单价从哪来（★ 这里曾经是「内置种子价」—— 已删除，不要加回来）
// ---------------------------------------------------------------------------

/**
 * 本文件只定义**怎么算**与**怎么解析价**，不提供任何价目表。
 *
 * ★ **内置种子价（`BUILTIN_PRICES`）2026-10 已删除**，三条理由：
 *
 * 1. 它只覆盖 `deepseek-official` 的三个模型名，而真实用量大多落在 `dashscope` /
 *    内部网关上 —— 于是它给出一个「看起来正常」的金额（本机实测未计价 82%），
 *    使用者会拿它去对账。
 * 2. 单价是**管理员的决定**，不是本仓的默认值：官方零售价 ≠ 本部门的结算价
 *    （转售 / 折扣 / 汇总账单都不在单价里）。
 * 3. 「一条价都没配」必须是**看得见**的：现在的语义是 `pricingSource === 'none'`
 *    + 空价表，展示层一位金额都不渲染（见 `PricingSource` 的注释）。
 *
 * ⇒ 价的唯一真源有两个：服务端 `model_price` 表（`db`），以及从它同步下来的
 *   `pricing.json` 快照（`snapshot`）。两者都没有就是 `none`。
 *   补价走单价管理页，或 `scripts/online-pricing.mjs`（线上操作台）。
 */
