/**
 * 上报库查询门面 —— 部门看板（`/api/v1/stats/*`）的**唯一取数入口**。
 *
 * ## 与 `stats.ts`（本地统计门面）的关系
 *
 * 两者产出的都是同一套 `TokenCounts`，派生指标同样交给
 * `derive()` / `shared/metrics.ts`。差别只在数据源与「有没有第二条路径」：
 *
 * | | `openStats()`（本机） | `openPortalStats()`（部门） |
 * |---|---|---|
 * | 库文件 | `usage.sqlite`（日志的派生物） | `portal.sqlite` **或 MySQL**（唯一副本） |
 * | 写库 | 每次取数前先增量 ingest | **只读**，一个字节都不写 |
 * | 降级路径 | 库坏了回退直扫日志 | **没有降级** —— 上报库没有可重扫的真值 |
 * | 归属 | 不存在（三列恒为 NULL） | ★ 核心维度（`user` 分组） |
 *
 * ★ **这里没有「降级直扫」**，也不该有：上报数据的真值只有这一个库，
 *   日志早已不在服务端机器上。所以库打不开就如实报错（`openPortalStore`
 *   在 schema 版本不符时抛错而**不重建**），让管理员看到原因，
 *   而不是拿一份空数据冒充「今天没人用」。
 *
 * ## ★ 为什么整个门面是异步的
 *
 * MySQL 驱动（`Bun.sql`）只有异步 API，而 SQLite 驱动是同步的。
 * 统一成异步之后上层只有一套写法；SQLite 那侧只是把同步调用包成已解决的
 * Promise，代价可以忽略（本地库路径根本不走这里）。
 * 于是本文件的所有方法都返回 Promise —— **没有 getter**，因为
 * `get sessions()` 没法表达「这是个 I/O」。
 *
 * ## 🚨 口径约束（与 `query.ts` 完全一致）
 *
 * SQL 层只做**原始列求和**，本文件同样**不写任何公式**：
 * 四项 token 分列取出，`cacheHitRate` / `avgTokensPerCall` / `unattributedRate`
 * 一律由调用方用 `shared/metrics.ts` 计算。SQL 里出现公式 = 第二个口径实现，
 * 它不会报错，只会让某个数字悄悄不对。
 *
 * ## 🚨 唯一的口径边界：`num()`
 *
 * 两种后端的驱动返回类型不同，其中一处**猜错就静默出错**：
 *
 * | 表达式 | SQLite | MySQL |
 * |---|---|---|
 * | `COUNT(*)` | 数字 | 数字 |
 * | **`SUM(BIGINT)`** | 数字 | **字符串 `"60"`**（SUM 结果是 DECIMAL，驱动按精度优先给字符串） |
 *
 * 实测确认。若把 `"60"` 直接当 token 数用，`shared/metrics.ts` 的除法会得到
 * `NaN`，或者更糟 —— 字符串拼接（`"60" + 1` === `"601"`）。
 * ⇒ **所有数值字段（四项 token / calls / sessions / lo / hi / last_ingest_ms）
 * 一律在这里过一遍 `num()`**，绝不把驱动的原始类型放出去。
 */

import type { PortalBackendKind, PortalDialect, PortalStore, PortalTarget } from './portal-db.js'
import { openPortalStore, portalDialect } from './portal-db.js'
import { aggregateFlight, readAggregate } from './aggregate-flight.js'
import { cubeAvailable, cubeQuery, cubeRemainders } from './cube.js'
import type { SqlQuery } from './query.js'

import type { TokenCounts } from '../types.js'
import { renderSeriesGaps, type SeriesPointCounts } from './stats.js'
import {
  buildWhere,
  costByCwdQuery,
  costByDimensionQuery,
  costTotalsQuery,
  distinctUsersQuery,
  groupsQuery,
  groupRowsFromProject,
  groupRowsFromTime,
  ingestMomentQuery,
  mapCostRows,
  mapGroupRows,
  mapRecordNames,
  projectGroupsQuery,
  projectSessionsQuery,
  recordProjection,
  seriesFromRows,
  sessionCountQuery,
  sortGroupRows,
  stackRowsQuery,
  timeBoundsQuery,
  timeBucketRowsQuery,
  toNumber,
  toNumberOrNull,
  totalsQuery,
  overviewCountsQuery,
  unattributedCallsQuery,
  type ProjectGroupRow,
  type ProjectSessionPair,
  type QueryDimension,
  type QueryFilter,
  type QueryGroupRow,
  type RawCostRow,
  type CostQueryPrice,
  type RawGroupRow,
  type StackRow,
  type TimeBucketRow,
} from './query.js'
import { EMPTY_ALIAS_RULES, providerNormalizer, type AliasRules, type ProviderNormalizer } from './provider-alias.js'
import { projectNormalizer, type ProjectAliasMap, type ProjectNormalizer } from './project-alias.js'
import { EVENT_TABLE } from './schema.js'
import { PRICE_TABLE } from './query.js'
// ★ 费用类型与「未计价清单上限」的唯一来源：离线路径（本地页 / CLI）用同一份，
//   见 `./cost.js` 的模块注释。
import { MAX_UNPRICED_TARGETS } from './cost.js'
import type { CostTotals, CostTotalsWithTargets } from './cost.js'
import {
  costMicroOf,
  modelPriceFromWire,
  priceRatesAt,
  priceRatesForSlot,
  resolvePrice,
  summarizeCosts,
  UNATTRIBUTED_USER,
  type BillableUsage,
  type CostPart,
  type TokenRemainders,
  type CostSummary,
  type ModelPrice,
  type PriceSlot,
  type PricingProvenance,
} from '@ai-token-report/shared'
// ⚠️ `toDayKey()` / `toHourKey()` / `projectName()` 是**内核**的（`aggregate.ts`），
//   不是 shared 的：它们定义的是「怎么分桶 / 怎么切项目名」。
//   这里复用同一份实现 —— 与 `groups()` 用同一套键，金额才能按组对上号。
import { projectName, toDayKey, dayKindOf, toHourKey, toHourOfDay } from '../aggregate.js'
import { Buffer } from 'node:buffer'
import { emptyCounts } from '../types.js'

/**
 * 这组筛选条件是不是**纯时间窗**（只带 `sinceMs` / `untilMs`）。
 *
 * ★ 汇总表快路径只接纯时间窗。原因不是懒，而是**汇总表按天存**：
 * `usage_rollup_day` 的列是 `(day_key, member_id, provider, model)`，
 * 拿 `WHERE provider LIKE '%dash%'` 去筛它当然可以，但人员 / 分组 /
 * 归一化后的展示名这些维度都要在 **JS 侧**再折一次 —— 那等于把
 * 「聚合」从 SQL 搬到 JS，收益消失、还多一条容易分叉的路径。
 *
 * 所以带任何维度筛选的请求一律走原始表（它已经正确、也已经有索引）。
 *
 * ⚠️ **`source` 是后来才有的维度**（v9 给事实表加了这一列，汇总表**没加**）：
 *   它不在这张「能不能走汇总表」的判定里的话，按来源取数会带着
 *   `source = ?` 去查汇总表 —— 那是 `no such column`，也是本仓最不想要的那种
 *   「靠异常兜底」的路径（见下面那句的注释）。
 */
function isTimeWindowOnly(filter: QueryFilter): boolean {
  const hasDimension = (filter.providers?.length ?? 0) > 0 || (filter.models?.length ?? 0) > 0
    || (filter.userIds?.length ?? 0) > 0 || (filter.memberIds?.length ?? 0) > 0
    || (filter.legacyUserIds?.length ?? 0) > 0 || (filter.groupIds?.length ?? 0) > 0
    // 🚨 **来源（v9）必须算进来**：`usage_rollup_*` 的键里**没有来源列**，
    //   带着 `source = ?` 去查它必然报「no such column」。而这一句的语义是
    //   「这批筛选条件能不能用汇总表」——漏掉来源的后果不是「慢一点」，
    //   而是每次按来源取数都先撞一次 SQL 错误（或被 `try/catch` 吞掉后静默退原始表）。
    //   本仓宁可显式判掉，也不靠异常路径兜底：异常路径会让「汇总表坏了」
    //   与「这个筛选不支持汇总表」变成同一个现象。
    || (filter.sources?.length ?? 0) > 0
    || filter.unattributedOnly === true
  return !hasDimension
}

/**
 * 带金额的一档汇总（线上契约 `StatsCostTotals` 的内核形状）。
 *
 * ⚠️ `pricing` **不是装饰**：同一批用量在「服务端读库里的价」与
 *   「离线端读快照的价」下会给出**两个不同的金额**，所以任何展示金额的地方
 *   都必须能回答「这是按哪份单价、什么时候算的」。缺它就不许渲染金额。
 *
 * ★ 类型与常量**定义在 `./cost.js`**（离线路径也用同一份），这里只是转出 ——
 *   各写一份的话，给 `CostTotals` 加一个字段时只会改到其中一处，
 *   而另一处仍然编译通过（结构类型下多一个字段不算错），分叉就此开始。
 */
export type { CostTotals, CostTotalsWithTargets } from './cost.js'

/** 单价目录一次读入后的两份索引。 */
interface PriceIndex {
  list: readonly CostQueryPrice[]
  byId: Map<string, ModelPrice>
}

/**
 * 逐事件计价单元：**专用价优先、基础价兜底** + **按事件时刻选时段**。
 *
 * 🚨 逐事件路径（`day` / `hour` 分组、趋势、堆叠、明细）必须走这里，不要自己
 *   `costMicroOf(usage, resolvePrice(...))`：那样会把闲时用量按高峰价算，
 *   费用虚高整整一倍，而页面上完全看不出区别。
 *   聚合路径对应的是 `partOf()`（时段由 SQL 判好）。
 */
function eventCostPart(
  prices: readonly ModelPrice[],
  provider: string,
  model: string,
  atMs: number,
  usage: BillableUsage,
  remainders?: TokenRemainders,
): CostPart {
  const price = resolvePrice(prices, provider, model, atMs)
  if (price === null) return { usage, price: null }
  return { usage, price, rates: priceRatesAt(price, atMs), ...(remainders ? { remainders } : {}) }
}

/** 单价表的取数行（snake_case 只活在这一层）。 */
interface PortalPriceSqlRow {
  price_id: unknown
  provider: unknown
  model: unknown
  currency: unknown
  input_micro_per_ktok: unknown
  output_micro_per_ktok: unknown
  cache_read_micro_per_ktok: unknown
  cache_write_micro_per_ktok: unknown
  /** v10 的闲时四类单价与时段表（可为 NULL = 这条价不分时段）。 */
  offpeak_input_micro_per_ktok: unknown
  offpeak_output_micro_per_ktok: unknown
  offpeak_cache_read_micro_per_ktok: unknown
  offpeak_cache_write_micro_per_ktok: unknown
  offpeak_schedule: unknown
  effective_from_ms: unknown
  effective_to_ms: unknown
}

/**
 * 未计价目标最多列这么多条：多到几十条时「去补价」这件事本身就该换个做法了。
 *
 * ★ 常量本体在 `./cost.js`（离线路径用同一个上限）—— 两处各写一个数字的话，
 *   同一次用量在看板上是 20 条、在 CLI 上是 30 条，而两边都不会报错。
 */
export { MAX_UNPRICED_TARGETS } from './cost.js'

/**
 * 数值归一 —— ★ **本仓唯一的口径边界**。
 *
 * 🚨 理由见文件头的对照表：MySQL 的 `SUM(BIGINT)` 返回**字符串**。
 *   `null`（空表的 SUM、没查到的行）按 0 处理，让调用方拿到的永远是可运算的数字。
 *
 * ⚠️ 实现刻意只有一份（`query.ts` 的 `toNumber`）：分组/序列那几条路径在
 *   `query.ts` 的共享映射里归一，本文件负责标量字段。若两边各写一遍取整规则，
 *   它们会慢慢分叉，而分叉的表现只是「某些接口的数字是字符串」。
 */
const num = toNumber

/**
 * 同 {@link num}，但**保留 NULL**。
 *
 * ⚠️ 时间边界与「最近落库时刻」上，NULL 的语义是「一条数据都没有」而不是 0：
 *   折成 0 会让页面显示「最早数据来自 1970 年」，或者把「从未上报」
 *   显示成「1970 年上报过」。
 */
const numOrNull = toNumberOrNull

/** 明细表的一行（上报库比本机库多一列归属）。 */
/** 趋势点 + 该点的金额（只在 `withCost` 时带上 `cost`）。 */
export interface PortalSeriesPoint extends SeriesPointCounts {
  cost?: CostTotals
}

/**
 * 堆叠趋势里的一层（一个用户 / 一个模型）—— {@link PortalStatsSession.stackSeries} 的产出。
 *
 * ★ `tokensByBucket` / `callsByBucket` **缺桶就是 0**：补零是调用方按 `points`
 *   对齐时的事（与 `series()` 用同一份 `renderSeriesGaps()`），
 *   两层各补一次零早晚会出现「图上有这个桶、分层里没有」。
 */
export interface PortalStackSeries {
  /** 归属键：人员 UUID / `legacy:…` / `unknown` / 模型名。 */
  key: string
  /** 展示名（成员视图与人员排行同源）。 */
  label: string
  memberId?: string | null
  groupNames?: string[]
  attributionStatus?: 'member' | 'legacy' | 'unattributed'
  /** 窗口内的计费总量，供调用方排序取前 N。 */
  totalTokens: number
  calls: number
  tokensByBucket: Map<string, number>
  callsByBucket: Map<string, number>
  /**
   * 逐桶金额（只在会话带 `withCost` 时才有）。
   *
   * ⚠️ 缺桶 = 这一层在这个桶上**未计价**（不是 0 元），但页面看到的仍是一个
   *   数字数组 —— 真正回答「未计价多少」的是 `points[].cost.unpricedRate`，
   *   它才是必须与金额同时可见的那句话。
   */
  costByBucket?: Map<string, CostTotals>
}

/** 明细行的金额：`currency` 为 `null` = **未计价**（不是 0 元）。 */
export interface PortalRecordCost {
  currency: string | null
  amountMicro: number
}

export interface PortalRecordRow {
  memberId?: string | null
  userNameSnapshot?: string | null
  /** 该人员**当前**所属的分组 ID（不是上报时的值，那个在 `groupNameSnapshot`）。 */
  groupIds?: string[]
  /** 上报当时客户端自己填的分组文本快照。 */
  groupNameSnapshot?: string | null
  attributionStatus?: 'member' | 'legacy' | 'unattributed'
  eventId: string
  sessionId: string
  seq: number
  ts: number
  /** 归属键。未归属时为 `null` —— 由调用方映射成协议里的 `unknown`。 */
  userId: string | null
  /** ★ 展示用的供应商名（已按规则归一化；未配规则时等于 `providerRaw`）。 */
  provider: string
  /** 上报当时的供应商原值。明细要能核对规则，所以两个都留着。 */
  providerRaw: string
  /** ★ 展示用的模型名（已按规则归一化；未配规则时等于 `modelRaw`）。 */
  model: string
  /**
   * 上报当时的模型原值。
   *
   * 🚨 它同时是**计价用的那一份**：`model_price` 是按原值 `(provider, model)`
   *   匹配的，金额必须用原值算 —— 见 `recordProjection()` 的注释。
   */
  modelRaw: string
  cwd: string | null
  /**
   * ★ v9：这条用量是哪个客户端写的（`dsh` / `codex` / `claude-code` / …）。
   *
   * ⚠️ 它是**上报当时的原值**，查询期不做任何归一化（与 provider 的展示名刻意不同）：
   *   来源是受控枚举，`trae` 与 `trae-cn` 是两个独立来源，归一化会把它们混起来。
   */
  source: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /**
   * 这一条事件的费用。
   *
   * ⚠️ 三种状态要分清（页面上对应三件不同的事）：
   *   - 字段**整个缺席** = 调用方没有 `cost:read`（这一趟根本没算过）；
   *   - `cost.currency === null` = 算了，这一条**没配上价**；
   *   - 有币种 + 金额 = 算出来了。
   *   第二种**绝不能**折成 0 元 —— 那会让「漏配价」看起来像「这条不要钱」。
   */
  cost?: PortalRecordCost
}

/** 明细 SQL 的原始行（数值列在 MySQL 下可能是字符串，必须经 `num()`）。 */
interface PortalRecordSqlRow {
  member_id: string | null
  user_name: string | null
  group_name: string | null
  event_id: string
  session_id: string
  seq: unknown
  ts: unknown
  user_id: string | null
  provider: string
  /** 供应商归一化表达式的结果；没配规则时该列与 `provider` 同值。 */
  provider_norm?: unknown
  /** **原值**模型名。计价用的就是它（`model_price` 按上报原值匹配）。 */
  model: string
  /** 模型归一化表达式的结果；没配规则时该列与 `model` 同值。 */
  model_norm?: unknown
  cwd: string | null
  /** v9：这条用量是哪个客户端写的（受控枚举原值，查询期不做任何归一化）。 */
  source: string
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  cache_write_tokens: unknown
}

/** 一个采集来源在当前范围内的覆盖与新鲜度（诊断页）。 */
export interface PortalSourceCoverageRow {
  /** 受控枚举原值；库里为 NULL 的历史行折成 `''`。 */
  source: string
  calls: number
  /** 四项之和（库里不存 total 列）。 */
  totalTokens: number
  sessions: number
  earliestEventTs: number | null
  latestEventTs: number | null
}

/** 一个署名键（人员 / 待确认历史身份 / 未归属）在当前范围内的覆盖与新鲜度。 */
export interface PortalReporterCoverageRow {
  /** 与 `by=user` 的分组键同形（`member_id` / `legacy:…` / `unknown`）。 */
  key: string
  label: string
  attributionStatus: 'member' | 'legacy' | 'unattributed'
  calls: number
  totalTokens: number
  groupNames: string[]
  latestEventTs: number | null
}

/**
 * 一个已就绪的上报库统计会话。
 *
 * ⚠️ 持有 `PortalStore`（**不是 `Database`**），**用完必须 `await close()`**：
 *   SQLite 下这是真的关连接（否则 WAL 不回收），MySQL 下是空操作
 *   （连接来自进程内共享池，见 `portal-db.ts`）。两边调用形状一致。
 *   与 `StatsSession` 一样，构造逻辑收敛在 `openPortalStats()` 里。
 */
export class PortalStatsSession {
  /** 上报库的人类可读描述（已脱敏；MySQL 下是「库名 @ 主机:端口」）。 */
  readonly label: string
  /** SQLite 路径。配了 MySQL 时它只是「退路配置」，不代表当前连的是它。 */
  readonly dbPath: string
  readonly kind: PortalBackendKind
  /** 打开时刻，供页面显示「数据多新」。 */
  readonly openedAt: number

  #cubeState: Promise<boolean> | undefined
  readonly #disableCube: boolean
  readonly #store: PortalStore
  readonly #target: PortalTarget
  /** ★ 与 `store.kind` 绑定的方言：`provider-model` 的拼接表达式靠它。 */
  readonly #dialect: PortalDialect
  readonly #filter: QueryFilter
  /**
   * 供应商归一化（可选）。`undefined` = 一条规则都没有 ——
   * 此时所有 SQL 与迁移前**逐字相同**，本机库路径也走这一支。
   */
  readonly #normalize: ProviderNormalizer | undefined
  /**
   * 项目归一化（可选）。`undefined` = 一条规则都没有 ——
   * 此时项目维度回落 `projectName()`，与迁移前**逐字节相同**。
   *
   * ⚠️ 它只作用于 **`project` 维度**的两条路径（`groups('project')` 与
   *   `costByGroup('project')`）。两个地方必须同时套用它，否则分布表与
   *   金额列会按两个不同的项目名分组 —— 页面上表现为「有几行金额是空的」。
   */
  readonly #projects: ProjectNormalizer | undefined
  /**
   * 是否连**金额**一起算。
   *
   * 🚨 由调用方按 `cost:read` 决定，而且这里是**真不查、真不算** ——
   *   不是「算完再决定要不要发出去」。理由与「缺字段必须按 member 处理」同源：
   *   只要金额曾经存在于某个中间对象里，就迟早会有一条日志、一个错误响应
   *   或一次页面状态把它带出去。没算过的东西泄不出去。
   */
  readonly #withCost: boolean
  /**
   * 汇总表快路径的**一次性判定结果**（每次开一个统计会话只判一次）。
   *
   * `undefined` = 还没判过；`false` = 判定为「不可用 / 不适用」；
   * `true` = 可以走汇总表。见 `#rollupUsable()`。
   */
  #rollupState: boolean | undefined
  /** 单价目录（v7）。**惰性读一次**：一次查询里三种金额都要用同一份价。 */
  #prices: PriceIndex | null = null
  #closed = false

  constructor(init: {
    store: PortalStore
    target: PortalTarget
    filter?: QueryFilter
    aliases?: AliasRules
    /**
     * 项目归一化映射（`project_alias`，v11）。
     *
     * ⚠️ 与 `aliases` 不同，它**不生成任何 SQL**：项目维度的分组本来就在 JS 侧
     *   （见 `groupRowsFromProject()`），所以这里只留一个解析器。
     */
    projectAliases?: ProjectAliasMap
    withCost?: boolean
    /** 验证 / 基准使用同一事实快照直接对照原始查询。 */
    disableCube?: boolean
  }) {
    this.#store = init.store
    this.#target = init.target
    this.#dialect = portalDialect(init.store.kind)
    this.label = init.store.label
    this.dbPath = init.target.sqlitePath
    this.kind = init.store.kind
    this.#filter = init.filter ?? {}
    // ⚠️ 空规则必须折成 `undefined`：空 `CASE` 在 MySQL 上是语法错误，
    //   而在 SQLite 上只是「恒为 NULL」—— 后者更危险，它不会报错。
    //   ★ 两类规则**任何一个非空**都要留着：只配了模型规则时，供应商那一段
    //   表达式会退回裸列名（`hasNormalization` 逐类判定），但模型那一段必须生效。
    this.#normalize = init.aliases && (init.aliases.providers.size > 0 || init.aliases.models.length > 0)
      ? providerNormalizer(init.aliases, this.#dialect)
      : undefined
    // ⚠️ 同样折成 `undefined`，理由不同：零条规则时走 `projectName()` 那条路
    //   与迁移前**逐字节相同**，留着空 normalizer 只是白扫一遍规则表。
    this.#projects = init.projectAliases && init.projectAliases.size > 0
      ? projectNormalizer(init.projectAliases)
      : undefined
    this.openedAt = Date.now()
    this.#withCost = init.withCost === true
    this.#disableCube = init.disableCube === true
  }

  private cubeReady(): Promise<boolean> {
    return this.#cubeState ??= this.#disableCube ? Promise.resolve(false) : cubeAvailable(this.#store)
  }

  #priceTask: Promise<PriceIndex> | undefined

  private async sourceQuery(q: SqlQuery, filter = this.#filter): Promise<SqlQuery> {
    // 明细、接收新鲜度不能从压缩后的行还原。
    if (!/FROM usage_event\b/.test(q.sql) || /\bevent_id\b|MAX\(received_at_ms\)/.test(q.sql) || !await this.cubeReady()) return q
    const rows = /^SELECT ts,/.test(q.sql)
    const prices = this.#withCost && (rows || /\bprice_id\b/.test(q.sql)) ? (await this.prices()).list : []
    return cubeQuery(q, this.kind, filter, prices, { rows, withRemainders: this.#withCost })
  }

  private async readRows<T>(sql: string, params?: SqlQuery['params'], filter = this.#filter): Promise<T[]> {
    const q = await this.sourceQuery({ sql, params: params ?? {} }, filter)
    type WeightedRow = T & { copies?: unknown; remainders?: unknown }
    const fetched = q.sql.startsWith('WITH cube_meta') && /^SELECT ts,/.test(sql)
      ? await readAggregate<WeightedRow>(this.#target, this.#store, q)
      : await this.#store.all<WeightedRow>(q.sql, q.params)
    // 合并飞行中的查询会共享结果，权重展开必须写入自己的行副本。
    const rows = fetched.map(row => row.copies === undefined ? row : { ...row })
    for (const row of rows) {
      if (row.copies === undefined) continue
      const copies = num(row.copies)
      const values = row as Record<string, unknown>
      if (copies > 1 && this.#withCost) {
        const histogram = cubeRemainders(row.remainders) ?? ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(name => {
          const rest = num(values[name]) % 1000
          return rest ? [[rest, 1] as const] : []
        })
        row.remainders = JSON.stringify(histogram.map(column => column.map(([rest, count]) => [rest, count * copies])))
      }
      for (const name of ['calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']) {
        if (values[name] !== undefined) values[name] = num(values[name]) * copies
      }
    }
    return rows
  }

  private async readRow<T>(sql: string, params?: SqlQuery['params']): Promise<T | undefined> {
    return (await this.readRows<T>(sql, params))[0]
  }

  private async aggregate<T>(query: SqlQuery): Promise<T[]> {
    return readAggregate<T>(this.#target, this.#store, await this.sourceQuery(query))
  }

  // -------------------------------------------------------------------------
  // 费用（v7 模型单价）
  // -------------------------------------------------------------------------

  /** 这批金额是按哪份单价算的。服务端读的是数据库表，所以是 `db` + `null`。 */
  get pricingProvenance(): PricingProvenance {
    return { pricingSource: 'db', pricingSyncedAt: null }
  }

  /**
   * 单价目录（惰性、只读一次）。
   *
   * ⚠️ 表不存在时不能让它炸掉整个看板：v7 之前的库由 `openPortalDb()` 挡在
   *   启动那一步（版本不符直接抛错），所以走到这里表一定在。真查失败时如实抛出 ——
   *   把「读价失败」降级成「未计价」会让整个看板的金额静默变成 0，
   *   那正是这一期最想避免的误读。
   */
  private prices(): Promise<PriceIndex> {
    // 同一请求内并发的查询共享同一份价表，不让中途改价产生两套边界。
    return this.#priceTask ??= this.loadPrices()
  }

  private async loadPrices(): Promise<PriceIndex> {
    if (this.#prices === null) {
      const rows = await this.readRows<PortalPriceSqlRow>(
        `SELECT price_id, provider, model, currency,
                input_micro_per_ktok, output_micro_per_ktok,
                cache_read_micro_per_ktok, cache_write_micro_per_ktok,
                offpeak_input_micro_per_ktok, offpeak_output_micro_per_ktok,
                offpeak_cache_read_micro_per_ktok, offpeak_cache_write_micro_per_ktok,
                offpeak_schedule,
                effective_from_ms, effective_to_ms
         FROM ${PRICE_TABLE}`,
      )
      // ★ 行 → 内存形状走 `shared/price.ts` 的 `modelPriceFromWire()`（服务端与 CLI 也用它）：
      //   「四个闲时价缺一个怎么处理」「effective_to_ms 的 NULL 怎么处理」在这里
      //   再写一遍，就等于把「什么时候算不分时段」变成两处判断 —— 分叉不会报错，
      //   只会让某段时间的金额按错的档算。
      const list: CostQueryPrice[] = rows.map((row) => ({ priceId: String(row.price_id), ...modelPriceFromWire({
        provider: String(row.provider ?? ''),
        model: String(row.model ?? ''),
        currency: String(row.currency ?? ''),
        input_micro_per_ktok: num(row.input_micro_per_ktok),
        output_micro_per_ktok: num(row.output_micro_per_ktok),
        cache_read_micro_per_ktok: num(row.cache_read_micro_per_ktok),
        cache_write_micro_per_ktok: num(row.cache_write_micro_per_ktok),
        offpeak_input_micro_per_ktok: toNumberOrNull(row.offpeak_input_micro_per_ktok),
        offpeak_output_micro_per_ktok: toNumberOrNull(row.offpeak_output_micro_per_ktok),
        offpeak_cache_read_micro_per_ktok: toNumberOrNull(row.offpeak_cache_read_micro_per_ktok),
        offpeak_cache_write_micro_per_ktok: toNumberOrNull(row.offpeak_cache_write_micro_per_ktok),
        offpeak_schedule: row.offpeak_schedule === null || row.offpeak_schedule === undefined
          ? null
          : String(row.offpeak_schedule),
        effective_from_ms: num(row.effective_from_ms),
        effective_to_ms: toNumberOrNull(row.effective_to_ms),
      }) }))
      const byId = new Map<string, ModelPrice>()
      rows.forEach((row, index) => byId.set(String(row.price_id), list[index]!))
      this.#prices = { list, byId }
    }
    return this.#prices
  }

  /** 单个分组键下的一撮计价单元。 */
  private static push(parts: Map<string, CostPart[]>, key: string, part: CostPart): void {
    const list = parts.get(key)
    if (list) list.push(part)
    else parts.set(key, [part])
  }

  /** 把一撮计价单元汇总成带来源的金额。 */
  private summarize(parts: readonly CostPart[]): CostTotals {
    return { ...summarizeCosts(parts), pricing: this.pricingProvenance }
  }

  /**
   * 整体金额 + 未配价的目标清单。
   *
   * ★ 有 `cost:read` 之外的情况返回 `null`（而不是 0 元）：
   *   **「没权限看金额」与「这段时间没花钱」是两件事**，后者会让一个有权限的人
   *   以为自己上个月一分钱没花。
   */
  async costTotals(): Promise<CostTotalsWithTargets | null> {
    if (!this.#withCost) return null
    const { list, byId } = await this.prices()
    const q = costTotalsQuery(this.#filter, this.#normalize, this.#dialect, list)
    const rows = mapCostRows(await this.aggregate<RawCostRow>(q))
    const targets = new Set<string>()
    for (const row of rows) {
      // 未计价的行才进清单；`price_id` 非空说明这条用量已经有价了。
      if (row.priceId === null && row.provider !== null) targets.add(`${row.provider}/${row.model ?? ''}`)
    }
    return {
      ...this.summarize(rows.map((row) => this.partOf(row.priceId, row.slot, row.usage, byId))),
      unpricedTargets: [...targets].sort().slice(0, MAX_UNPRICED_TARGETS),
    }
  }

  /**
   * 取一条价行。
   *
   * ★ 按 `price_id` 取；取不到就按**未计价**处理（宁可少算，不可按 0 元算）——
   *   那说明这条价在两次查询之间被删了，或者直接改库留下了一条坏引用。
   */
  private priceOf(priceId: string | null, byId: Map<string, ModelPrice>): ModelPrice | null {
    if (priceId === null) return null
    return byId.get(priceId) ?? null
  }

  /**
   * 聚合取数行 → 计价单元：**时段由 SQL 判好**（`row.slot`），这里只按它取那四类单价。
   *
   * ⚠️ 少了 `rates` 就会把闲时用量按高峰价算 —— 费用虚高一倍，
   *   而页面上完全看不出区别（这就是 `slot` 必须一路带到这里的原因）。
   */
  private partOf(
    priceId: string | null,
    slot: PriceSlot,
    usage: BillableUsage,
    byId: Map<string, ModelPrice>,
  ): CostPart {
    const price = this.priceOf(priceId, byId)
    if (price === null) return { usage, price: null }
    return { usage, price, rates: priceRatesForSlot(price, slot) }
  }

  /**
   * 按任意分组维度取金额，键与 `groups(dim)` 的 `key` **逐字相同**。
   *
   * ★ 这正是它必须留在本文件的原因：分组键的口径（归一化后的 provider、
   *   稳定人员 ID、按项目名合并、按本地时区分桶）只有一份实现，
   *   让路由层自己去对键，就会多出第二份「什么算同一组」的判断。
   *
   * 三个分支对应 `dimensionExpression` 的三种归宿：
   *   - SQL 侧可分组（provider / model / provider-model / user / group）→ 一次带 JOIN 的聚合；
   *   - `project` → 先按 `cwd` 取金额，再按项目名合并（与分组路径同样的合并规则）；
   *   - `day` / `hour` → 取原始行、在 JS 侧分桶（**分桶必须在 JS 侧**，见 `query.ts`）。
   */
  async costByGroup(dim: QueryDimension): Promise<Map<string, CostTotals>> {
    const result = new Map<string, CostTotals>()
    if (!this.#withCost) return result
    const { list, byId } = await this.prices()
    const parts = new Map<string, CostPart[]>()

    if (dim === 'day' || dim === 'hour') {
      // ⚠️ 逐行的价必须按**每条事件自己的时刻**解析（`resolvePrice`），
      //   不能拿分桶后的总量去乘一个价：一个桶里可能横跨一次换价，
      //   也可能横跨高峰与闲时（同一行价的两套数）。
      const q = timeBucketRowsQuery(this.#filter, false, this.#normalize, true)
      const rows = await this.readRows<TimeBucketRow & { provider?: unknown; model?: unknown }>(q.sql, q.params)
      for (const row of rows) {
        const ts = num(row.ts)
        PortalStatsSession.push(
          parts,
          dim === 'day' ? toDayKey(ts) : toHourKey(ts),
          eventCostPart(list, String(row.provider ?? ''), String(row.model ?? ''), ts, this.usageOf(row), cubeRemainders(row.remainders)),
        )
      }
    } else if (dim === 'project') {
      const q = costByCwdQuery(this.#filter, this.#normalize, this.#dialect, list)
      for (const row of mapCostRows(await this.aggregate<RawCostRow>(q))) {
        PortalStatsSession.push(
          parts,
          // 🚨 必须与 `groups('project')` 用**同一个**解析器：一条路径按归一化名、
          //   另一条按 `projectName()` 的话，分布表与金额列会对不上号 ——
          //   表现是「某些项目的费用列是空的」，而两边的数字各自都是「对的」。
          this.#projectOf(row.key),
          this.partOf(row.priceId, row.slot, row.usage, byId),
        )
      }
    } else {
      const q = costByDimensionQuery(dim, this.#filter, this.#dialect, this.#normalize, list)
      if (!q) return result
      for (const row of mapCostRows(await this.aggregate<RawCostRow>(q))) {
        PortalStatsSession.push(parts, row.key ?? '', this.partOf(row.priceId, row.slot, row.usage, byId))
      }
    }

    for (const [key, list2] of parts) result.set(key, this.summarize(list2))
    return result
  }

  /** 四类 token 的读取（逐行路径与聚合路径共用一处转换）。 */
  private usageOf(row: { input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown }): BillableUsage {
    return {
      input: num(row.input_tokens),
      output: num(row.output_tokens),
      cacheRead: num(row.cache_read_tokens),
      cacheWrite: num(row.cache_write_tokens),
    }
  }

  /**
   * 一条 cwd → 项目名的**唯一**入口（`project` 维度的两条路径共用）。
   *
   * ★ 没有规则时就是 `projectName()` —— 这正是「未配置的 cwd 保持自身」的实现：
   *   不是空串、也不是 `other`，而是与迁移前逐字节相同的旧口径。
   */
  #projectOf(cwd: string | null): string {
    return this.#projects ? this.#projects.resolve(cwd) : projectName(cwd)
  }

  // ---------------------------------------------------------------------------
  // 汇总表快路径（v8）—— 见 `rollup.ts` 的模块注释
  // ---------------------------------------------------------------------------

  /**
   * 汇总表现在能不能用。
   *
   * ## 🚨 为什么必须比「调用条数」，而不是只看表在不在
   *
   * 汇总表**落后于事实表**是正常状态（水位按接收时刻推进，新到的事件还没被折进去）。
   * 那时若拿它出数，页面就会**静默少算** —— 而「少算」在图上和「这段时间用得少」
   * 长得一模一样。
   *
   * 所以这里用一个**廉价的不变量**：同一窗口下
   * `SUM(汇总.calls) == COUNT(原始行)`。两者相等才认为汇总是最新的。
   * 代价是一条走 `idx_usage_event_ts` 的 `COUNT(*)`（实测 300 万行 17ms），
   * 换掉的是「整窗口聚合 + 把几十万行搬回 Node」（实测 330~490ms）。
   *
   * ⚠️ 任何异常（表不存在 / 手工删了 / 权限不足）**一律返回 false 退原始表**：
   *   汇总表是性能设施，不是正确性依赖，绝不让它把看板打成 5xx。
   */
  async #rollupUsable(): Promise<boolean> {
    if (await this.cubeReady()) return false
    if (this.#rollupState !== undefined) return this.#rollupState
    this.#rollupState = false
    // 🚨 **按来源筛选/分组时必须退原始表**：`usage_rollup_*` 的键是
    //   `(day_key, hour_of_day, member_id, provider, model)` —— **没有来源列**。
    //   带着 `source = ?` 去查汇总表会撞「no such column」（在 SQLite / MySQL 上
    //   都一样），而下面那个 try 会把它吞成「汇总表不可用」⇒ 静默退原始表：
    //   结果**恰好正确**，但每一次来源查询都会先白跑一条注定失败的 SQL。
    //   所以这里显式判掉，并留下这条注释 —— 否则下一个人会把汇总表当成
    //   「反正会自动回退」而继续依赖异常路径。
    //   ⚠️ 这不是缺陷而是取舍：给汇总表加来源维要重建全部汇总行（v9 不做），
    //   而来源筛选是**少数派查询**，退原始表的代价可以接受（与本地库同一取舍）。
    if ((this.#filter.sources?.length ?? 0) > 0) return this.#rollupState
    try {
      const { sql, params } = buildWhere(this.#filter, undefined)
      const source = await this.readRow<{ c: unknown }>(
        `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${sql}`, params,
      )
      const rolled = await this.readRow<{ c: unknown }>(
        `SELECT SUM(calls) AS c FROM usage_rollup_day${sql}`, params,
      )
      this.#rollupState = num(source?.c) > 0 && num(rolled?.c) === num(source?.c)
    } catch {
      // 表不存在（v8 之前的库）/ 查询失败 → 就当没有汇总表。
      this.#rollupState = false
    }
    return this.#rollupState
  }

  /**
   * 从 `usage_rollup_day` / `usage_rollup_hour` 出时间序列。
   *
   * ⚠️ **分桶键在 JS 侧算**（`toDayKey` / `toHourKey`），与原始表路径同一份实现。
   *   汇总是汇总表自己的 `day_key` / `hour_of_day` 两列（落库时已按本地时区算好），
   *   但**小时点仍必须由 JS 拼**，不能在 SQL 里 `CONCAT` ——
   *   那是第二个时间键实现，且两个后端的拼接写法还不一样。
   *
   * 返回 `null` 表示「这批筛选条件不是纯时间窗」（带了 provider / 人员等），
   * 此时**不接**这条快路径（`usage_rollup_day` 只按天聚合，没有那些维度的过滤能力）。
   */
  async #rollupSeries(granularity: 'day' | 'hour'): Promise<{ bucket: string; counts: TokenCounts }[] | null> {
    if (!isTimeWindowOnly(this.#filter)) return null
    const table = granularity === 'day' ? 'usage_rollup_day' : 'usage_rollup_hour'
    const { sql, params } = buildWhere(this.#filter, undefined)
    const rows = await this.readRows<{
      day_key: unknown; hour_of_day?: unknown
      input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown
      reasoning_tokens: unknown; calls: unknown
    }>(`SELECT * FROM ${table}${sql}`, params)
    const buckets = new Map<string, TokenCounts>()
    for (const row of rows) {
      const day = String(row.day_key ?? '')
      if (day.length === 0) continue
      const bucket = granularity === 'day' ? day : `${day}T${String(num(row.hour_of_day)).padStart(2, '0')}`
      let counts = buckets.get(bucket)
      if (!counts) {
        counts = emptyCounts()
        buckets.set(bucket, counts)
      }
      counts.input += num(row.input_tokens)
      counts.output += num(row.output_tokens)
      counts.cacheRead += num(row.cache_read_tokens)
      counts.cacheWrite += num(row.cache_write_tokens)
      counts.reasoning += num(row.reasoning_tokens)
      counts.calls += num(row.calls)
      counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, counts]) => ({ bucket, counts }))
  }

  /**
   * 「一天中的第几小时」的消耗分布 —— **需求 ②** 的取数口。
   *
   * ## 为什么它必须单独有一个入口
   *
   * `series('hour')` 给的是「哪一天的哪一小时」（`2026-10-01T14`），
   * 而「工作时段分布」要的是**把所有日期的同一时刻折叠**（`14`）。
   * 两者不是粒度差异，是**不同的分桶键**：
   * 按天的汇总表服务不了它（一天的 24 小时被合并成 1 行），
   * 按小时带日期的汇总表**也不直接服务它**（要跨日期再折一次）。
   *
   * 所以有三条路，按代价从低到高：
   * 1. `usage_rollup_hod`（全历史折叠，行数上界 `24 × 2 × 人数 × 组合数`）—— 最快；
   * 2. `usage_rollup_hour`（仅覆盖保留窗口）；
   * 3. 原始表 —— 永远正确，用于上面两条都不可用时。
   *
   * ⚠️ 这三条路都必须给出**逐位相同**的结果（`rollup.test.ts` 钉住了这一点）。
   *
   * @param dayKind `'all'` 不筛；`'workday'` 只算周一~周五；`'weekend'` 只算周末。
   */
  async hourOfDay(dayKind: 'all' | 'workday' | 'weekend' = 'all'): Promise<{ hour: number; counts: TokenCounts }[]> {
    const wantKind = dayKind === 'all' ? null : dayKind === 'workday' ? 0 : 1
    if (await this.#rollupUsable()) {
      /**
       * ① / ② 两条汇总表路径。
       *
       * 🚨 **折叠一律在 JS 侧做，SQL 只把行取回来。**
       *   两个理由，都是踩出来的：
       *
       *   1. **SQL 里的多列聚合必须有 `GROUP BY`。** 我第一版写成
       *      `SELECT hour_of_day, SUM(calls) … FROM usage_rollup_hod`（漏了 `GROUP BY`），
       *      MySQL/SQLite 会把它当成**整表一行**的聚合 —— `hour_of_day` 取到某一行的值
       *      再配全表 `SUM`。表现是「所有小时被折成一个点」（实测 `[[18, 12]]`
       *      而正确是 `[[18,4],[19,4],[20,4]]`）**且完全不报错**。
       *   2. **`day_kind` 的筛选必须在 JS 侧做。** 若写成 `WHERE day_kind = ?`，
       *      而恰好没有工作日的行，SQL 就会返回 0 行 —— 于是流程「退到 ②」，
       *      把**周末的行当成结果返回**。那是「筛工作日却拿到周末」，比少算更糟。
       *
       *   这两张表都只有几千到几十万行，取回来在 JS 里折的代价可以忽略；
       *   而口径与 `toHourOfDay()` / `dayKindOf()` 同源，不会再有一条 SQL 侧的实现。
       */
      const foldRows = (
        rows: readonly { hour_of_day: unknown; day_kind?: unknown; calls: unknown; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown; reasoning_tokens: unknown }[],
      ): { hour: number; counts: TokenCounts }[] => {
        const buckets = new Map<number, TokenCounts>()
        for (const row of rows) {
          if (wantKind !== null && num(row.day_kind) !== wantKind) continue
          const hour = num(row.hour_of_day)
          let counts = buckets.get(hour)
          if (!counts) { counts = emptyCounts(); buckets.set(hour, counts) }
          counts.input += num(row.input_tokens)
          counts.output += num(row.output_tokens)
          counts.cacheRead += num(row.cache_read_tokens)
          counts.cacheWrite += num(row.cache_write_tokens)
          counts.reasoning += num(row.reasoning_tokens)
          counts.calls += num(row.calls)
          counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
        }
        return [...buckets.entries()].sort(([a], [b]) => a - b).map(([hour, counts]) => ({ hour, counts }))
      }
      if (isTimeWindowOnly(this.#filter)) {
        // ① 全历史折叠表（不带日期）—— 只在**没有时间窗**时用得到
        try {
          const { sql } = buildWhere(this.#filter, undefined)
          if (!sql) {
            const rows = await this.readRows<{ hour_of_day: unknown; day_kind: unknown; calls: unknown; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown; reasoning_tokens: unknown }>(
              'SELECT hour_of_day, day_kind, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_rollup_hod',
            )
            const folded = foldRows(rows)
            if (folded.length > 0) return folded
          }
        } catch { /* 退 ② / ③ */ }
        // ② 保留窗口内的小时表（带日期）
        try {
          const { sql, params } = buildWhere(this.#filter, undefined)
          const rows = await this.readRows<{ hour_of_day: unknown; calls: unknown; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown; reasoning_tokens: unknown }>(
            `SELECT hour_of_day, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_rollup_hour${sql}`,
            params,
          )
          const folded = foldRows(rows)
          if (folded.length > 0) return folded
        } catch { /* 退 ③ */ }
      }
    }
    // ③ 原始表：永远正确的兜底。分桶在 JS 侧做（`toHourOfDay`），不用 SQL 的 HOUR()。
    const filter = { ...this.#filter, sinceMs: undefined, untilMs: undefined }
    const q = timeBucketRowsQuery(filter)
    const rows = await this.readRows<TimeBucketRow>(q.sql, q.params, filter)
    const buckets = new Map<number, TokenCounts>()
    for (const row of rows) {
      const ts = num(row.ts)
      if (wantKind !== null && dayKindOf(ts) !== wantKind) continue
      const hour = toHourOfDay(ts)
      let counts = buckets.get(hour)
      if (!counts) { counts = emptyCounts(); buckets.set(hour, counts) }
      counts.input += num(row.input_tokens)
      counts.output += num(row.output_tokens)
      counts.cacheRead += num(row.cache_read_tokens)
      counts.cacheWrite += num(row.cache_write_tokens)
      counts.reasoning += num(row.reasoning_tokens)
      counts.calls += row.calls === undefined ? 1 : num(row.calls)
      counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([hour, counts]) => ({ hour, counts }))
  }

  /** 概览三项素材来自同一次扫描，也避免上报恰逢三次查询时互相对不上。 */
  async overviewCounts(): Promise<{ total: TokenCounts; sessions: number; unattributed: number }> {
    const q = overviewCountsQuery(this.#filter, this.#normalize)
    const [row] = await this.aggregate<{
      calls: unknown; input: unknown; output: unknown; cache_read: unknown;
      cache_write: unknown; reasoning: unknown; sessions: unknown; unattributed: unknown;
    }>(q)
    const input = num(row?.input)
    const output = num(row?.output)
    const cacheRead = num(row?.cache_read)
    const cacheWrite = num(row?.cache_write)
    return {
      total: {
        input, output, cacheRead, cacheWrite, reasoning: num(row?.reasoning),
        total: input + output + cacheRead + cacheWrite, calls: num(row?.calls),
      },
      sessions: num(row?.sessions), unattributed: num(row?.unattributed),
    }
  }

  /** 总计（四项独立 + calls）。派生指标请用 `derive()` / `shared/metrics.ts`。 */
  async totals(): Promise<TokenCounts> {
    const q = totalsQuery(this.#filter, this.#normalize)
    const row = await this.readRow<{
      calls: unknown
      input: unknown
      output: unknown
      cache_read: unknown
      cache_write: unknown
      reasoning: unknown
    }>(q.sql, q.params)

    const calls = num(row?.calls)
    if (calls === 0) {
      // 空结果：四项与 total 全 0（与本地 `queryTotals` 的短路语义一致）
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
        calls: 0,
      }
    }

    const input = num(row?.input)
    const output = num(row?.output)
    const cacheRead = num(row?.cache_read)
    const cacheWrite = num(row?.cache_write)
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: num(row?.reasoning),
      // 用恒等式重算 total（与 addCounts 的语义一致：不信任外部 total）
      total: input + output + cacheRead + cacheWrite,
      calls,
    }
  }

  /** 涉及的会话数（按筛选去重）。 */
  async sessions(): Promise<number> {
    const q = sessionCountQuery(this.#filter, this.#normalize)
    const row = await this.readRow<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 未归属的调用条数（`user_id IS NULL`）。 */
  async unattributedCalls(): Promise<number> {
    const q = unattributedCallsQuery(this.#filter, this.#normalize)
    const row = await this.readRow<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 非空归属分组数；成员视图按稳定人员与历史身份分别计数，旧视图按 `user_id` 去重。 */
  async distinctUsers(): Promise<number> {
    if (this.#filter.identityView === 'member') {
      const { sql, params } = buildWhere(this.#filter, this.#normalize)
      const row = await this.readRow<{ c: unknown }>(`SELECT COUNT(*) AS c FROM (
        SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id
        FROM ${EVENT_TABLE}${sql}${sql ? ' AND' : ' WHERE'} (member_id IS NOT NULL OR user_id IS NOT NULL)
        GROUP BY member_id, legacy_id) AS identities`, params)
      return num(row?.c)
    }
    const q = distinctUsersQuery(this.#filter, this.#normalize)
    const row = await this.readRow<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 数据的时间边界。NULL 必须保持 null（见 `numOrNull`）。 */
  async timeBounds(): Promise<{ earliest: number | null; latest: number | null }> {    const q = timeBoundsQuery(this.#filter, this.#normalize)
    const row = await this.readRow<{ lo: unknown; hi: unknown }>(q.sql, q.params)
    return { earliest: numOrNull(row?.lo), latest: numOrNull(row?.hi) }
  }

  /** 最近一次成功落库的时刻。 */
  async lastIngestAt(): Promise<number | null> {
    const q = ingestMomentQuery()
    const row = await this.readRow<{ last_ingest_ms: unknown }>(q.sql, q.params)
    return numOrNull(row?.last_ingest_ms)
  }

  /**
   * 按 `source` 的覆盖与新鲜度（诊断页用）。
   *
   * ⚠️ **来源不做归一化**：`trae` 与 `trae-cn` 是两个独立来源，折叠它们
   *   就会把「一台机器装了新版客户端」显示成「某个来源还在跑」——
   *   而来源是**受控枚举**（`registeredSources()`），不是可配的展示名。
   *
   * ⚠️ **不补零**：注册表里在窗口内没有数据的来源根本不出现。补一排 0
   *   会让「没人用了这个客户端」与「这个客户端的数据没进来」在页面上
   *   长得一模一样 —— 而后者才是诊断页要抓的东西。
   */
  async sourceCoverage(): Promise<PortalSourceCoverageRow[]> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.readRows<{
      source: string | null
      input: unknown
      output: unknown
      cache_read: unknown
      cache_write: unknown
      calls: unknown
      sessions: unknown
      lo: unknown
      hi: unknown
    }>(
      `SELECT source,
              SUM(input_tokens)       AS input,
              SUM(output_tokens)      AS output,
              SUM(cache_read_tokens)  AS cache_read,
              SUM(cache_write_tokens) AS cache_write,
              COUNT(*)                AS calls,
              COUNT(DISTINCT session_id) AS sessions,
              MIN(ts)                 AS lo,
              MAX(ts)                 AS hi
       FROM ${EVENT_TABLE}${sql}
       GROUP BY source
       ORDER BY calls DESC`,
      params,
    )
    return rows.map((row) => {
      const input = num(row.input)
      const output = num(row.output)
      const cacheRead = num(row.cache_read)
      const cacheWrite = num(row.cache_write)
      return {
        // 🚨 NULL 必须折成 ''（**不能**留成 null）：来源是 GROUP BY 的键，
        //   而分组键在整个契约里都是字符串（`key: string`）。
        source: row.source ?? '',
        calls: num(row.calls),
        // ★ 总量在这里派生：库里不存 total 列（铁律 3）。
        totalTokens: input + output + cacheRead + cacheWrite,
        sessions: num(row.sessions),
        earliestEventTs: numOrNull(row.lo),
        latestEventTs: numOrNull(row.hi),
      }
    })
  }

  /**
   * 按署名键的覆盖与新鲜度（诊断页用），按调用条数降序。
   *
   * ⚠️ 与 {@link distinctUsers} 的分组口径**必须逐字一致**
   *   （`member_id` 与「`member_id` 为空时退回 `user_id`」两两分组）：
   *   卡片上的「署名键组数」与这张表的行数必须是同一个数，
   *   否则同一个页面里两处数字对不上，而且谁都说不清哪个对。
   *
   * ⚠️ 这里的 `legacy:` / `unknown` 键形**逐字复制** {@link memberGroups}：
   *   人员排行里的「张三」与诊断表里的「张三」必须是同一个键。
   */
  async reporterCoverage(limit = 10): Promise<PortalReporterCoverageRow[]> {
    if (this.#filter.identityView !== 'member') {
      // 旧视图下只有 `user_id` 一列，键与展示名都退化成它本身。
      const { sql, params } = buildWhere(this.#filter, this.#normalize)
      const rows = await this.readRows<{
        user_id: string | null
        user_name: string | null
        calls: unknown
        input: unknown
        output: unknown
        cache_read: unknown
        cache_write: unknown
        hi: unknown
      }>(
        `SELECT user_id, MIN(user_name) AS user_name,
                COUNT(*) AS calls,
                SUM(input_tokens)       AS input,
                SUM(output_tokens)      AS output,
                SUM(cache_read_tokens)  AS cache_read,
                SUM(cache_write_tokens) AS cache_write,
                MAX(ts)                 AS hi
         FROM ${EVENT_TABLE}${sql}
         GROUP BY user_id
         ORDER BY calls DESC`,
        params,
      )
      return rows.slice(0, limit).map((row) => {
        const input = num(row.input)
        const output = num(row.output)
        const cacheRead = num(row.cache_read)
        const cacheWrite = num(row.cache_write)
        return {
          key: row.user_id ?? UNATTRIBUTED_USER,
          label: row.user_id ?? '未归属',
          attributionStatus: row.user_id ? 'member' : 'unattributed',
          calls: num(row.calls),
          totalTokens: input + output + cacheRead + cacheWrite,
          groupNames: [],
          latestEventTs: numOrNull(row.hi),
        }
      })
    }

    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.readRows<{
      member_id: string | null
      legacy_id: string | null
      snapshot_name: string | null
      display_name: string | null
      calls: unknown
      input: unknown
      output: unknown
      cache_read: unknown
      cache_write: unknown
      hi: unknown
    }>(
      // 🚨 那条 `(member_id IS NOT NULL OR user_id IS NOT NULL)` 与
      //   {@link distinctUsers} 的成员分支**逐字相同**，不是顺手加的：
      //   少了它，未归属行会凑成一条「两列都为 NULL」的假身份，于是这张表的
      //   行数会比卡片上的「署名键组数」多 1 —— 同一个页面上两个数字对不上，
      //   而两边看起来都「很合理」。
      //   ⚠️ 它**不适用于**上面的旧视图分支：那里未归属本就该作为
      //   `unknown` 那一行出现（与 `groups('user')` 同款），否则
      //   「有多少数据没署名」在表里就彻底看不见了。
      `SELECT g.member_id, g.legacy_id, g.snapshot_name, m.display_name,
              g.calls, g.input, g.output, g.cache_read, g.cache_write, g.hi
       FROM (
         SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id,
                MIN(user_name) AS snapshot_name,
                SUM(input_tokens)       AS input,
                SUM(output_tokens)      AS output,
                SUM(cache_read_tokens)  AS cache_read,
                SUM(cache_write_tokens) AS cache_write,
                COUNT(*)                AS calls,
                MAX(ts)                 AS hi
         FROM ${EVENT_TABLE}${sql}${sql ? ' AND' : ' WHERE'} (member_id IS NOT NULL OR user_id IS NOT NULL)
         GROUP BY member_id, legacy_id
       ) AS g LEFT JOIN members m ON m.member_id = g.member_id
       ORDER BY g.calls DESC`,
      params,
    )
    const page = rows.slice(0, limit)
    const groups = await this.groupsOf(page.map((row) => row.member_id))
    return page.map((row) => {
      const input = num(row.input)
      const output = num(row.output)
      const cacheRead = num(row.cache_read)
      const cacheWrite = num(row.cache_write)
      const attributionStatus = row.member_id ? 'member' : row.legacy_id !== null ? 'legacy' : 'unattributed'
      return {
        key: row.member_id
          ?? (row.legacy_id !== null ? `legacy:${Buffer.from(row.legacy_id, 'utf8').toString('base64url')}` : UNATTRIBUTED_USER),
        label: row.member_id
          ? row.display_name ?? row.snapshot_name ?? '已停用人员'
          : row.legacy_id !== null ? `历史人员：${row.snapshot_name ?? row.legacy_id}（待确认）` : '未归属',
        attributionStatus,
        calls: num(row.calls),
        totalTokens: input + output + cacheRead + cacheWrite,
        groupNames: (row.member_id ? groups.get(row.member_id) ?? [] : []).map((group) => group.name),
        latestEventTs: numOrNull(row.hi),
      }
    })
  }

  /**
   * 分组聚合。排序规则与内核 `aggregate()` 一致
   * （时间维度升序，其余按用量降序）—— 否则「人员排行」的行序在
   * 两条路径下会不同，看起来像数据变了。
   *
   * ★ SQL 与归并逻辑都来自 `query.ts`（与本地路径**同一份**）：
   *   这里只负责「用哪种方言执行」和「异步 await」。
   */
  async groups(dim: QueryDimension): Promise<QueryGroupRow[]> {
    if (dim === 'user' && this.#filter.identityView === 'member') return this.memberGroups()
    if (dim === 'group') return this.groupGroups()
    const q = groupsQuery(dim, this.#filter, this.#dialect, this.#normalize)
    if (q) {
      const rows = await this.aggregate<RawGroupRow>(q)
      return sortGroupRows(mapGroupRows(rows), dim)
    }

    // `project`：先按 cwd 聚合，再按项目名在 JS 侧合并
    if (dim === 'project') {
      const groups = projectGroupsQuery(this.#filter)
      const pairs = projectSessionsQuery(this.#filter)
      const rows = await this.readRows<ProjectGroupRow>(groups.sql, groups.params)
      const sessionPairs = await this.readRows<ProjectSessionPair>(pairs.sql, pairs.params)
      // ★ 项目归一化（v11）就在这里生效：先按 cwd 聚合、再按项目名合并的
      //   两段都走 `#projectOf`，所以「同一项目名下的多个 cwd」会正确合并，
      //   而 sessions 去重也按**合并后的项目名**做（见 groupRowsFromProject 的注释）。
      return groupRowsFromProject(rows, sessionPairs, cwd => this.#projectOf(cwd))
    }

    // day / hour：时间键必须在 JS 侧算（见 `dimensionExpression` 的注释）
    if (dim === 'day' || dim === 'hour') {
      const rowsQuery = timeBucketRowsQuery(this.#filter, true, this.#normalize)
      const rows = await this.readRows<TimeBucketRow>(rowsQuery.sql, rowsQuery.params)
      return groupRowsFromTime(rows, dim)
    }

    return []
  }

  /**
   * 把一批稳定人员 ID 映射成「他当前属于哪些分组」。
   *
   * 🚨 **刻意单独查一次，而不是在主聚合里 LEFT JOIN 关联表**：多对多的 JOIN
   *   会让每个事件行按所属分组数复制，`SUM()` 随之成倍放大 ——
   *   那是一个静默的数据错误，页面上只是数字变大，没有任何报错。
   *
   * ⚠️ 分批查询：一次绑定几千个 UUID 会撞上 SQLite 的参数个数上限。
   */
  private async groupsOf(members: readonly (string | null)[]): Promise<Map<string, { groupId: string; name: string }[]>> {
    const unique = [...new Set(members.filter((id): id is string => !!id))]
    const map = new Map<string, { groupId: string; name: string }[]>()
    for (let start = 0; start < unique.length; start += 200) {
      const chunk = unique.slice(start, start + 200)
      const params: Record<string, string> = {}
      chunk.forEach((id, i) => { params[`$m${i}`] = id })
      const rows = await this.readRows<{ member_id: string; group_id: string; name: string }>(
        `SELECT a.member_id AS member_id, g.group_id AS group_id, g.name AS name
         FROM member_group_assignments a JOIN member_groups g ON g.group_id = a.group_id
         WHERE a.member_id IN (${chunk.map((_, i) => `$m${i}`).join(',')})
         ORDER BY g.name, g.group_id`, params)
      for (const row of rows) {
        const list = map.get(row.member_id) ?? []
        list.push({ groupId: row.group_id, name: row.name })
        map.set(row.member_id, list)
      }
    }
    return map
  }

  /** 按固定人员 ID 聚合；未确认历史的 key 与当前人员、真正未归属互不混淆。 */
  private async memberGroups(): Promise<QueryGroupRow[]> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.aggregate<RawGroupRow & {
      member_id: string | null; legacy_id: string | null; snapshot_name: string | null
      display_name: string | null
    } >({ sql: `SELECT g.*, m.display_name FROM (
      SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id,
        MIN(user_name) AS snapshot_name, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
        SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi,
        COUNT(DISTINCT session_id) AS sessions
      FROM ${EVENT_TABLE}${sql} GROUP BY member_id, legacy_id
      ) AS g LEFT JOIN members m ON m.member_id = g.member_id`, params })
    const groups = await this.groupsOf(rows.map((row) => row.member_id))
    return sortGroupRows(rows.map((row) => {
      const attributionStatus = row.member_id ? 'member' : row.legacy_id !== null ? 'legacy' : 'unattributed'
      const key = row.member_id ?? (row.legacy_id !== null ? `legacy:${Buffer.from(row.legacy_id, 'utf8').toString('base64url')}` : 'unknown')
      const mapped = mapGroupRows([{ ...row, grp_key: key }])[0]!
      return { ...mapped, memberId: row.member_id,
        groupNames: (row.member_id ? groups.get(row.member_id) ?? [] : []).map((group) => group.name),
        attributionStatus, label: row.member_id ? row.display_name ?? row.snapshot_name ?? '已停用人员'
          : row.legacy_id !== null ? `历史人员：${row.snapshot_name ?? row.legacy_id}（待确认）` : '未归属' }
    }), 'user')
  }

  /**
   * 按分组聚合（`by=group`）—— 「分组排行」的数据来源。
   *
   * ★ 这里 JOIN 关联表是**刻意的**：一个事件要同时计入它的人员所属的每个分组。
   *   因此各分组行的合计会大于总量，这不是重复计数，而是多对多分组的定义。
   * ⚠️ 没有关联行的人员（未分组）不进任何分组行，所以本维度看不见他们 ——
   *   「总量对不上分组之和」的差额正是这部分人，页面必须说清楚。
   * ⚠️ 事实表先按筛选收进子查询，再与关联表 JOIN：`buildWhere()` 产出的是
   *   不带表别名的裸列名（它要同时服务本地库路径），直接用在 JOIN 上会歧义。
   */
  private async groupGroups(): Promise<QueryGroupRow[]> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.aggregate<RawGroupRow & { grp_name: string } >({
      sql: `SELECT g.group_id AS grp_key, g.name AS grp_name,
              SUM(x.input_tokens) AS input, SUM(x.output_tokens) AS output,
              SUM(x.cache_read_tokens) AS cache_read, SUM(x.cache_write_tokens) AS cache_write,
              SUM(x.reasoning_tokens) AS reasoning, COUNT(*) AS calls,
              MIN(x.ts) AS lo, MAX(x.ts) AS hi, COUNT(DISTINCT x.session_id) AS sessions
       FROM (SELECT member_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    reasoning_tokens, ts, session_id
             FROM ${EVENT_TABLE}${sql}) AS x
       JOIN member_group_assignments a ON a.member_id = x.member_id
       JOIN member_groups g ON g.group_id = a.group_id
       GROUP BY g.group_id, g.name`, params })
    return sortGroupRows(rows.map((row) => ({ ...mapGroupRows([row])[0]!, label: row.grp_name })), 'group')
  }

  /** 旧页面无法表达同名/改名关系时明确拒绝，不能输出看似合理的合并排行。 */
  async assertLegacyIdentityView(): Promise<void> {
    if (this.#filter.identityView === 'member') return
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const pairs = await this.readRows<{ member_id: string | null; user_id: string | null }>(
      `SELECT DISTINCT member_id, user_id FROM ${EVENT_TABLE}${sql}`, params,
    )
    const byLegacy = new Map<string, Set<string>>(), byMember = new Map<string, Set<string>>()
    for (const row of pairs) {
      if (row.member_id && row.user_id === null) throw new IdentityViewRequiredError()
      if (row.user_id === null) continue
      const identities = byLegacy.get(row.user_id) ?? new Set<string>()
      identities.add(row.member_id ?? 'legacy'); byLegacy.set(row.user_id, identities)
      if (row.member_id) {
        const names = byMember.get(row.member_id) ?? new Set<string>()
        names.add(row.user_id); byMember.set(row.member_id, names)
      }
    }
    if ([...byLegacy.values(), ...byMember.values()].some((ids) => ids.size > 1)) throw new IdentityViewRequiredError()
  }

  /**
   * 时间序列。
   *
   * ⚠️ 补零复用 `stats.ts` 的 `renderSeriesGaps()` —— 与本地页/CLI 是
   *   同一份实现。自己再写一遍补零，会让「命令行 30 个点、页面 4 个点」
   *   这种差异出现，而且没有任何报错。
   */
  async series(granularity: 'day' | 'hour', fillGaps = true): Promise<PortalSeriesPoint[]> {
    /**
     * ★ **汇总表快路径**（v8）。命中则完全不碰 `usage_event`。
     *
     * ⚠️ 条件里的两条都是**安全阀，不是可选项**：
     *   ① `!this.#withCost` —— 金额必须按**每条事件当时的价**算（价按
     *      `(provider, model)` 定，且带生效区间）。汇总表按
     *      `(day, member, provider, model)` 求和之后，**同一天里换过价就再也分不开**，
     *      只能拿一个价乘一份混合用量 —— 那是错的。所以有金额权限时走原始表。
     *   ② `await this.#rollupUsable()` —— 汇总表空着 / 水位落后 / 时区不匹配时
     *      必须退原始表，否则会**静默少算**（比慢危险得多）。
     */
    if (!this.#withCost && await this.#rollupUsable()) {
      const rolled = await this.#rollupSeries(granularity)
      if (rolled) return fillGaps ? renderSeriesGaps(rolled, granularity) : rolled
    }
    // ⚠️ `withCost` 时连 provider / model 一起取：每个点的金额必须按**该点里
    //   每条事件当时的价**算，而价是按 (provider, model) 定的。
    //   拿「这个点一共多少 token」× 某个价 = 用一个平均单价算账，那是错的。
    const q = timeBucketRowsQuery(this.#filter, false, this.#normalize, this.#withCost)
    const source = await this.sourceQuery(q)
    const prices = this.#withCost ? (await this.prices()).list : null
    return aggregateFlight(this.#target, this.kind,
      ['series', source.sql, Object.entries(source.params).sort(([a], [b]) => a.localeCompare(b)), granularity, fillGaps, prices],
      () => this.computeSeries(q, granularity, fillGaps))
  }

  private async computeSeries(q: SqlQuery, granularity: 'day' | 'hour', fillGaps: boolean): Promise<PortalSeriesPoint[]> {
    const rows = await this.readRows<TimeBucketRow & { provider?: unknown; model?: unknown }>(q.sql, q.params)
    const points = seriesFromRows(rows, granularity)
    const filled = fillGaps ? renderSeriesGaps(points, granularity) : points
    if (!this.#withCost) return filled

    const { list } = await this.prices()
    const parts = new Map<string, CostPart[]>()
    for (const row of rows) {
      const ts = num(row.ts)
      PortalStatsSession.push(
        parts,
        granularity === 'day' ? toDayKey(ts) : toHourKey(ts),
        eventCostPart(list, String(row.provider ?? ''), String(row.model ?? ''), ts, this.usageOf(row), cubeRemainders(row.remainders)),
      )
    }
    // 补零出来的点没有用量 —— 给一份全 0 的金额（币种列表为空），
    // 而不是让 `cost` 时有时无：后者会让页面在「有金额」和「没金额」之间闪。
    return filled.map((point) => ({ ...point, cost: this.summarize(parts.get(point.bucket) ?? []) }))
  }

  /**
   * 堆叠趋势：按**人 / 模型**把每个时间桶拆开。
   *
   * ## 为什么不是把 `groups()` 按桶跑一遍
   *
   * 需要的是「每个桶 × 每个分层」的交叉值，而 `groups(dim)` 只有窗口总量。
   * 于是这里退回到**原始行**：时间桶无论如何都要在 JS 侧算
   * （见 `query.ts` 的 `dimensionExpression` 注释），行反正要过一遍 JS。
   *
   * ## 🚨 键必须与 `groups('user')` 逐字相同
   *
   * 成员视图下的归属键有三种形态（稳定 `member_id` / `legacy:…` / `unknown`），
   * 展示名也有三种拼法。这里**刻意复制 `memberGroups()` 的那套判定**：
   * 两者一旦分叉，图上「张三」这一层与人员排行里的「张三」就不是同一个键，
   * 而图与表各自看起来都很正常。
   *
   * ⚠️ 本方法**不截断**：前 N 名与「其余」的合并发生在路由层
   *   （`stats-route.ts`），因为那是**展示取舍**，不是取数口径。
   *   这里给出全部层与它们的窗口总量，路由才排得出名次。
   *
   * ★ 有 `cost:read` 时**顺带按 (桶, 层) 算金额**（逐条事件按当时的价）。
   *   与趋势线同一条规矩：价按 `(provider, model)` 定，
   *   所以金额**不能**由「这一层的总量 × 某个价」重算。
   *   一元钱也没有的层照样有 `costs: []`（= 未计价），不是缺席。
   */
  async stackSeries(
    dim: 'user' | 'model',
    granularity: 'day' | 'hour',
  ): Promise<PortalStackSeries[]> {
    const q = stackRowsQuery(dim, this.#filter, this.#normalize, this.#withCost)
    const rows = await this.readRows<StackRow>(q.sql, q.params)
    /**
     * 只有 `user` 维度才有归属可言。
     *
     * 🚨 少了这个开关，模型维度会走进人员那套标签判定：模型行既没有
     *   `member_id` 也没有 `user_id`，于是每一层都被标成「未归属」——
     *   实测在图例上表现为**所有模型都叫「未归属」**，而数字全对。
     */
    const userDim = dim === 'user'
    const memberView = userDim && this.#filter.identityView === 'member'
    const priceList = this.#withCost ? (await this.prices()).list : []

    interface Pending {
      label: string
      memberId: string | null
      attributionStatus: 'member' | 'legacy' | 'unattributed' | undefined
      /** 历史身份的快照名，取 `MIN(user_name)`（与 `memberGroups()` 同一判定）。 */
      snapshot: string | null
      totalTokens: number
      calls: number
      tokensByBucket: Map<string, number>
      callsByBucket: Map<string, number>
      costParts: Map<string, CostPart[]>
    }
    const merged = new Map<string, Pending>()

    for (const row of rows) {
      const ts = num(row.ts)
      const bucket = granularity === 'day' ? toDayKey(ts) : toHourKey(ts)
      const key = dim === 'model' ? String(row.stack_key ?? '') : this.identityKeyOf(row, memberView)
      let entry = merged.get(key)
      if (!entry) {
        entry = {
          // 标签先占位，等人员名册 / 分组名查回来再补（见下面的两趟查询）。
          label: key,
          memberId: memberView ? this.memberIdOf(row) : null,
          attributionStatus: memberView ? this.attributionOf(row) : undefined,
          snapshot: null,
          totalTokens: 0,
          calls: 0,
          tokensByBucket: new Map(),
          callsByBucket: new Map(),
          costParts: new Map(),
        }
        merged.set(key, entry)
      }
      // ★ `MIN(user_name)` 在 JS 侧同样按字典序取最小 —— 直接取「第一条」会让
      //   图上的历史人员名与人员排行里的名字不一致（同一批数据、两个名字）。
      if (memberView && typeof row.user_name === 'string') {
        if (entry.snapshot === null || row.user_name < entry.snapshot) entry.snapshot = row.user_name
      }
      const usage = this.usageOf(row)
      const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
      entry.totalTokens += tokens
      entry.calls += row.calls === undefined ? 1 : num(row.calls)
      entry.tokensByBucket.set(bucket, (entry.tokensByBucket.get(bucket) ?? 0) + tokens)
      entry.callsByBucket.set(bucket, (entry.callsByBucket.get(bucket) ?? 0) + (row.calls === undefined ? 1 : num(row.calls)))
      if (this.#withCost) {
        PortalStatsSession.push(
          entry.costParts,
          bucket,
          // ★ 逐条按**它自己的时刻**取价：一个桶里可能横跨一次换价，
          //   也可能横跨高峰与闲时（同一行价的两套数）。
          eventCostPart(priceList, String(row.provider ?? ''), String(row.model ?? ''), ts, usage, cubeRemainders(row.remainders)),
        )
      }
    }

    const memberIds = [...merged.values()].map((entry) => entry.memberId)
    // ⚠️ 两趟查询都只在**成员视图的人员维度**才有意义：模型维度没有归属可言，
    //   而旧视图的键就是 `user_id` 本身（没有稳定人员 ID，也就没有名册可查）。
    const names = memberView ? await this.displayNamesOf(memberIds) : new Map<string, string>()
    const groups = memberView ? await this.groupsOf(memberIds) : new Map<string, { groupId: string; name: string }[]>()

    return [...merged.entries()].map(([key, entry]) => ({
      key,
      // ★ 三个分支：模型维度直接用键（模型名）；人员维度再分成员视图与旧视图。
      label: !userDim
        ? key
        : memberView
          ? this.stackLabelOf(entry, names)
          : key === UNATTRIBUTED_USER ? '未署名' : key,
      ...(userDim ? { memberId: entry.memberId } : {}),
      ...(memberView && entry.memberId
        ? { groupNames: (groups.get(entry.memberId) ?? []).map((group) => group.name) }
        : {}),
      ...(entry.attributionStatus ? { attributionStatus: entry.attributionStatus } : {}),
      totalTokens: entry.totalTokens,
      calls: entry.calls,
      tokensByBucket: entry.tokensByBucket,
      callsByBucket: entry.callsByBucket,
      ...(this.#withCost ? { costByBucket: this.costsOf(entry.costParts) } : {}),
    }))
  }

  /** 一个分层的逐桶金额（只在 `withCost` 时被调用）。 */
  private costsOf(parts: Map<string, CostPart[]>): Map<string, CostTotals> {
    const result = new Map<string, CostTotals>()
    for (const [bucket, list] of parts) result.set(bucket, this.summarize(list))
    return result
  }

  /** 成员视图下的归属键；与 `memberGroups()` 的三分支**逐字相同**。 */
  private identityKeyOf(row: StackRow, memberView: boolean): string {
    if (!memberView) return typeof row.user_id === 'string' ? row.user_id : UNATTRIBUTED_USER
    const memberId = this.memberIdOf(row)
    if (memberId) return memberId
    const legacy = typeof row.user_id === 'string' ? row.user_id : null
    return legacy === null ? UNATTRIBUTED_USER : `legacy:${Buffer.from(legacy, 'utf8').toString('base64url')}`
  }

  private memberIdOf(row: StackRow): string | null {
    return typeof row.member_id === 'string' && row.member_id.length > 0 ? row.member_id : null
  }

  private attributionOf(row: StackRow): 'member' | 'legacy' | 'unattributed' {
    if (this.memberIdOf(row)) return 'member'
    return typeof row.user_id === 'string' ? 'legacy' : 'unattributed'
  }

  /** 分层展示名；三分支与 `memberGroups()` 的 `label` 拼法相同。 */
  private stackLabelOf(
    entry: { memberId: string | null; snapshot: string | null },
    names: Map<string, string>,
  ): string {
    if (entry.memberId) return names.get(entry.memberId) ?? '已停用人员'
    if (entry.snapshot !== null) return `历史人员：${entry.snapshot}（待确认）`
    return '未归属'
  }

  /**
   * 稳定人员 ID → 显示名（分批查询，理由同 `groupsOf()`）。
   *
   * ⚠️ 查不到的 ID 留在 `members` 表之外（人员被物理删除只可能来自直接改库），
   *   由调用方回落成「已停用人员」，与 `memberGroups()` 的 `LEFT JOIN` 同义。
   */
  private async displayNamesOf(members: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(members.filter((id): id is string => !!id))]
    const map = new Map<string, string>()
    for (let start = 0; start < unique.length; start += 200) {
      const chunk = unique.slice(start, start + 200)
      const params: Record<string, string> = {}
      chunk.forEach((id, i) => { params[`$n${i}`] = id })
      const rows = await this.readRows<{ member_id: string; display_name: string }>(
        `SELECT member_id, display_name FROM members
         WHERE member_id IN (${chunk.map((_, i) => `$n${i}`).join(',')})`, params)
      for (const row of rows) map.set(String(row.member_id), String(row.display_name))
    }
    return map
  }

  /** 明细分页（最新在前）。返回总行数供页面算分页。 */
  async records(limit: number, offset: number): Promise<{ total: number; rows: PortalRecordRow[] }> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)

    // ⚠️ 这条 SQL 刻意留在本文件：它带 `user_id`（**上报库专有**的列，
    //   本地库那三列恒为 NULL），因此不与本地路径共用。
    //   但参数仍是 `$named`，MySQL 侧由 `toPositional()` 翻成 `?`。
    const totalRow = await this.readRow<{ c: unknown }>(
      `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${sql}`,
      params,
    )

    // ★ provider 的归一化表达式来自 `query.ts` 的 `recordProjection()`
    //   （与分组维度同一份实现），这里只负责把两份参数合起来。
    const projection = recordProjection(this.#normalize)
    const rows = await this.readRows<PortalRecordSqlRow>(
      // ⚠️ ORDER BY 用 (ts, seq) 而不是 ts：同一毫秒内的多条记录需要有
      //   稳定的次序，否则翻页时会出现「第 2 页重复了第 1 页的最后一行」。
      `SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, source,
              ${projection.columns},
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM ${EVENT_TABLE}${sql}
       ORDER BY ts DESC, seq DESC, event_id DESC
       LIMIT $limit OFFSET $offset`,
      { ...projection.params, ...params, $limit: limit, $offset: offset },
    )
    const groups = await this.groupsOf(rows.map((row) => row.member_id))
    // ★ 明细是**唯一**能逐条核对金额的地方：一行一条事件，它的价按它自己的
    //   `(provider, model, ts)` 解析 —— 同一页里两行同一个模型却不同价，
    //   正是「换价那一刻」的证据，页面必须能显示这个。
    const priceIndex = this.#withCost ? await this.prices() : null

    return {
      total: num(totalRow?.c),
      rows: rows.map((r) => {
        const usage: BillableUsage = {
          input: num(r.input_tokens),
          output: num(r.output_tokens),
          cacheRead: num(r.cache_read_tokens),
          cacheWrite: num(r.cache_write_tokens),
        }
        const price = priceIndex === null
          ? null
          : resolvePrice(priceIndex.list, r.provider, r.model, num(r.ts))
        return {
          eventId: r.event_id,
          sessionId: r.session_id,
          seq: num(r.seq),
          ts: num(r.ts),
          userId: r.user_id,
          ...(this.#filter.identityView === 'member' ? {
            memberId: r.member_id, userNameSnapshot: r.user_name,
            groupIds: (r.member_id ? groups.get(r.member_id) ?? [] : []).map((group) => group.groupId),
            groupNameSnapshot: r.group_name, attributionStatus: r.member_id ? 'member' as const : r.user_id !== null ? 'legacy' as const : 'unattributed' as const,
          } : {}),
          ...mapRecordNames(r),
          cwd: r.cwd,
          // ★ v9 来源：明细也要带它 —— 「这条用量是谁写的」在逐条核对时同样要能看见
          //   （例如「看板上筛了 Codex，但这一行其实是 DSH 的」这种问题只在这里看得出来）。
          source: r.source,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          // `currency: null` = 没配上价。**绝不写 0 元**：那会让「漏配价」
          // 在明细里看起来像「这条不要钱」。
          // ⚠️ 计价必须过 `priceRatesAt()`：闲时那几条明细要用闲时价，
          //    直接 `costMicroOf(usage, price)` 会把它们按高峰价算。
          ...(priceIndex === null ? {} : {
            cost: {
              currency: price?.currency ?? null,
              amountMicro: price === null ? 0 : costMicroOf(usage, priceRatesAt(price, num(r.ts))),
            },
          }),
        }
      }),
    }
  }

  /** 关闭底层连接。可重复调用。MySQL 下是空操作（见文件头）。 */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#store.close()
  }
}

/**
 * 打开一个**只读**的上报库统计会话。
 *
 * 🚨 用 `openPortalStore()`（→ `openPortalSqlite()` 或 MySQL 后端）而不是
 *   `openDatabaseForIngest()`：前者在 schema 版本不符时**抛错**
 *   （上报库是唯一副本，绝不自动重建），后者会「丢了重建」。
 *   两者搞反 = 一次版本升级静默清空全部门历史用量。
 *   两种后端遵守同一条铁律。
 *
 * `aliases` 是**已经按查看者解析完毕**的归一化规则（供应商映射 + 模型规则，
 * 全局 + 人员逐条覆盖），由 `stats-route.ts` 从 `provider_alias` 表读出来传进去 ——
 * 查询层不认识那张表，也不该认识：它只认「原始名 → 展示名」这一件事。
 *
 * `loadProjectAliases`（第 5 个参数，v11）同款：项目归一化规则也按查看者解析，
 * 只是它**不生成任何 SQL**（项目分组在 JS 侧），所以下游只拿到一个解析器。
 *
 * ⚠️ 传的是**加载函数**而不是现成的映射表：加载要用同一个已打开、且已过版本闸门的
 *   连接（`provider_alias` / `project_alias` 表的存在性由闸门保证）。让调用方自己先开
 *   一次连接去读规则、再开一次查数据，等于每次看板请求握两次库句柄，
 *   而 SQLite 上的代价是真金白银的。
 */
export async function openPortalStats(
  target: PortalTarget,
  filter: QueryFilter = {},
  loadAliases?: (store: PortalStore) => Promise<AliasRules>,
  /**
   * 是否连金额一起算。由**路由层按 `cost:read` 决定**，core 不认权限概念。
   *
   * ⚠️ 默认 `false`：金额是「另算一趟」的东西（多了 JOIN 与单价表读取），
   *   而绝大多数请求只是想看看 token 数。默认开会让每一次看板刷新都替
   *   没有金额权限的人白算一遍。
   */
  withCost = false,
  /**
   * 项目归一化映射的加载函数（v11）。
   *
   * ⚠️ **刻意排在第 5 位**（而不是插在 `withCost` 前面）：它是后来才加的一层口径，
   *   而 `withCost` 是布尔、位置一变就会让既有的
   *   `openPortalStats(target, filter, loadAliases, true)` 静默把 `true`
   *   当成加载函数（typecheck 会拦，但没必要制造这次改动面）。
   *   追加在末尾让所有既有调用点一个字节都不用改。
   */
  loadProjectAliases?: (store: PortalStore) => Promise<ProjectAliasMap>,
): Promise<PortalStatsSession> {
  const store = await openPortalStore(target)
  try {
    const aliases = loadAliases ? await loadAliases(store) : EMPTY_ALIAS_RULES
    const projectAliases = loadProjectAliases ? await loadProjectAliases(store) : undefined
    const session = new PortalStatsSession({
      store, target, filter, withCost,
      ...(aliases.providers.size > 0 || aliases.models.length > 0 ? { aliases } : {}),
      ...(projectAliases && projectAliases.size > 0 ? { projectAliases } : {}),
    })
    await session.assertLegacyIdentityView()
    return session
  } catch (error) { await store.close(); throw error }
}

/** HTTP 层将它映射为 409，数据库故障仍保持 503。 */
export class IdentityViewRequiredError extends Error {
  readonly code = 'identity_view_required'
  constructor() { super('当前归属无法用旧版人员视图准确表达，请使用 identity_view=member') }
}
