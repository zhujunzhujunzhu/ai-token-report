/**
 * 部门看板查询路由 —— `GET /api/v1/stats/*`（ARCHITECTURE.md §5.3 的 S7）。
 *
 * ## 端点
 *
 * | 路径 | 用途 |
 * |---|---|
 * | `/api/v1/stats/overview` | 部门总览卡片（含**未归属占比**） |
 * | `/api/v1/stats/series?bucket=day\|hour[&stack=user\|model][&stack_top=8\|20\|all]` | 部门趋势 |
 * | `/api/v1/stats/breakdown?by=user\|group\|model\|provider\|project\|…` | ★ **人员排行 / 分组排行** |
 * | `/api/v1/stats/records?limit&offset` | 明细（分页） |
 * | `/api/v1/stats/groups` | ★ **分组候选项**（筛选下拉用） |
 * | `/api/v1/stats/members` | ★ **人员候选项**（筛选下拉用；带当前分组 ID） |
 * | `/api/v1/stats/providers` | ★ **供应商候选项**（筛选下拉用；数据派生的展示名 ∪ 归一化规则里的名字） |
 * | `/api/v1/stats/diagnostics` | 覆盖率 / 未归属 / 数据边界 |
 *
 * 响应结构全部来自 `shared/src/protocol.ts`，前端与之共用 —— 字段对不上时
 * `bun run typecheck` 直接编译失败，而不是等到页面上看到空图表。
 *
 * ## 🚨 鉴权：必须是非 2xx
 *
 * `Authorization: Bearer <token>` → 凭证表。缺 token / token 不对 → `401`；
 * 服务端压根没配凭证 → `503`（管理员发完凭证再试就有用，两者分开才好排障）。
 *
 * 与 `/api/v1/identity/verify` 的 `200 + ok:false` **刻意相反**，理由与
 * 上报接口一致（见 `ingest-route.ts` 的模块注释）：这个响应体里装的是
 * **数据**，回 2xx 会让前端把「鉴权失败」当成「这段时间没人用」——
 * 一个 0 值的空看板，比一个明确的 401 危险得多。
 *
 * ⚠️ **只读**：本路由一个字节都不写库。它只回答「库里现在有什么」。
 *
 * ## 🚨 数据范围：非管理员只看得到自己
 *
 * 看板里装的是**每个人的用量**，而能登录的人不都是管理员。所以除了「认人」，
 * 还必须在**服务端**把「能看到谁的数据」定死（`applyDataScope()`）：
 *
 * | 身份 | 范围 |
 * |---|---|
 * | 内置 `admin` 角色 | 全部门 |
 * | 其它任何角色（含自定义角色） | **只有他自己** |
 *
 * ★ 判据是**角色码**，不是权限码：权限回答「能做什么操作」，而「能看到谁的
 *   数据」是另一件事 —— 现有权限码没有一个表达得了它（`stats:read` 是能不能进
 *   看板、`members:read` 是人员目录、`cost:read` 是金额）。拿它们当数据范围会把
 *   「能管名册」与「能看全员用量」绑成一件事，而那种绑定在页面上看不出来。
 *
 * 🚨 收窄**只发生在服务端**：页面隐藏人员下拉是为了不让人白点一下，
 *   而不是安全边界 —— 手拼 `?member_id=<别人>` 同样只能拿到自己的数据（或者 403）。
 *   「前端过滤 = 权限」是本项目明令禁止的那类错误。
 *
 * ## 口径
 *
 * 本文件**不出现任何公式**：`cacheHitRate` / `avgTokensPerCall` /
 * `unattributedRate` 全部调用 `shared/metrics.ts`。四项 token 由
 * `core/db` 的原始列求和取出后原样透传（铁律 3：绝不在传输层合并）。
 */

import {
  EVENT_TABLE,
  distinctCwdsQuery,
  loadProjectAliases,
  loadProviderAliases,
  openPortalStats,
  openPortalStore,
  resolvePortalTarget,
  type CostTotals,
  type PortalRecordRow,
  type PortalStackSeries,
  type PortalStatsSession,
  type PortalStore,
  type PortalTarget,
  type QueryFilter,
} from '@ai-token-report/core/db'
import { derive, registeredSources, resolveRange } from '@ai-token-report/core'
import {
  cacheHitRate,
  computeTotal,
  deriveMetrics,
  summarizeCosts,
  unattributedRate,
  SERIES_STACK_MERGED_KEY,
  UNATTRIBUTED_USER,
  type BreakdownResponse,
  type Bucket,
  type DiagnosticsResponse,
  type GroupBy,
  type HourOfDayResponse,
  type OverviewResponse,
  type RecordRow,
  type RecordsResponse,
  type SeriesResponse,
  type SeriesStackBy,
  type SeriesStackItem,
  type StatsCostTotals,
  type StatsGroupOption,
  type StatsGroupsResponse,
  type StatsMemberOption,
  type StatsMembersResponse,
  type StatsPricingResponse,
  type StatsProvidersResponse,
  type StatsProjectsResponse,
  type StatsSourcesResponse,
} from '@ai-token-report/shared'

import type { CredentialStore } from './credentials.js'
import { authorize, authorizeDatabase, type Authentication } from './http/auth.js'
import type { IdentityRepository } from './identity/index.js'
import { modelPriceFromRow } from './identity/model-price-row.js'
import { VIEWER_AUTH_MESSAGES } from './verify-route.js'

/**
 * 这个身份能不能看金额。
 *
 * ★ **全仓唯一一处把 `cost:read` 翻译成布尔的地方**：core 的取数层不认权限概念，
 *   它能收到的只是一个「要不要算金额」的开关。
 *
 * ⚠️ 兼容路径（旧的 `CredentialStore` 身份）没有 `permissions` 字段 ——
 *   此时按**没有**处理。默认给权限意味着「服务端少返回一个字段」直接变成
 *   「人人能看到全公司的钱」，与「缺 role 必须按 member 处理」是同一条安全逻辑。
 */
function hasCostRead(viewer: unknown): boolean {
  // ⚠️ 形参是 `unknown` 而不是 `{ permissions?: string[] }`：两种身份的形状
  //   （数据库 `Principal` 与旧凭证的 `UserRole`）**没有公共字段**，
  //   写成结构化类型会让整个 `viewer` 联合类型不可赋值 —— 于是这里的判空
  //   会变成调用点的类型体操，而不是一行明确的运行时判断。
  const permissions = (viewer as { permissions?: unknown } | null)?.permissions
  return Array.isArray(permissions) && permissions.includes('cost:read')
}

/**
 * 内置管理员角色码。
 *
 * ★ 数据范围只看它，不看权限码（理由见模块注释里的那张表）。
 * ⚠️ 它是 `roles.code` 的稳定标识，且内置角色**不能改名**
 *   （`assertEditableRole()` 挡住），所以这里比对字面量是安全的。
 */
const DEPARTMENT_ROLE = 'admin'

/**
 * 这个身份能不能看到**全部门**的用量。
 *
 * ⚠️ 读不到角色码时按**没有**管理员角色处理：服务端少返回一个字段不该变成
 *   「人人能看全公司用量」，与「缺 `role` 一律按 member 处理」是同一条安全逻辑。
 *   兼容路径（旧 `CredentialStore` 身份）没有角色码数组，只有 `role` 字段。
 */
function seesDepartment(viewer: unknown): boolean {
  const roleCodes = (viewer as { roleCodes?: unknown } | null)?.roleCodes
  if (Array.isArray(roleCodes)) return roleCodes.includes(DEPARTMENT_ROLE)
  return (viewer as { role?: unknown } | null)?.role === DEPARTMENT_ROLE
}

/** 「只看自己」的身份被要求看别人时的统一答复：`403` + 说清是哪一条被拒。 */
function scopeDenied(reason: string): { result: StatsRouteResult } {
  return {
    result: {
      status: 403,
      body: { ok: false, code: 'stats_self_only', reason: `当前身份只能查看本人数据：${reason}` },
    },
  }
}

/**
 * 数据范围的**唯一实现**：把「只看自己」的身份的筛选条件收窄成只查本人。
 *
 * 三条规矩，缺一条都会漏：
 *
 * 1. ★ **显式点名别人一律 403，绝不静默替换成「我」。** 调用方点名要张三的用量
 *    却拿到自己的数字，与「两个筛选条件打架查出 0 行」是同一类错误：答案看起来
 *    完全正常，但它回答的是另一个问题。`user` / `legacy_user` / `unattributed`
 *    同理 —— 后两者是**全库范围**的旧姓名子集与未署名用量，永远不可能属于某个人。
 * 2. ★ **数据库身份用稳定 `member_id`**（`identity_view=member`）：姓名可以重复，
 *    「按姓名取数」正是 v4 引入稳定 ID 要消灭的那种归属方式。
 * 3. 🚨 **兼容身份（旧凭证表）没有稳定 ID 时直接 403，绝不按姓名兜底**：
 *    两个同名的人会被并成一个人，于是「只看自己」变成「看到同名的那个人的用量」。
 *    生产启动早已不接受 `credentialsPath`，所以这条只影响显式构造凭证表的调用方。
 *
 * ⚠️ 参数非法仍然回 400（解析在前），不要把它们混进 403：那会让「参数写错了」
 *   看起来像「没权限」，排障方向整个跑偏。
 */
function applyDataScope(
  viewer: unknown,
  params: URLSearchParams,
  window: ParsedWindow,
): { filter: QueryFilter } | { result: StatsRouteResult } {
  if (seesDepartment(viewer)) return { filter: window.filter }

  const memberId = (viewer as { memberId?: unknown } | null)?.memberId
  if (typeof memberId !== 'string' || !memberId) {
    return scopeDenied('这把凭证没有稳定人员 ID，无法按个人取数，请改用后台账号登录或让管理员签发 appKey')
  }
  if (params.getAll('member_id').some((id) => id !== memberId)) return scopeDenied('不能按人员筛选其他人')
  if (params.has('user')) return scopeDenied('不能按姓名筛选')
  if (params.has('legacy_user')) return scopeDenied('不能按历史身份筛选')
  if (params.get('unattributed') === 'true') return scopeDenied('不能筛选未署名用量')

  return {
    filter: {
      ...window.filter,
      // ★ 稳定人员 ID 是唯一不会把同名两人并起来的归属键。
      memberIds: [memberId],
      identityView: 'member',
      // 其它人员选择器一律清空：留着就会与服务端注入的范围**按 OR 叠加**，
      // 于是「只看我」被悄悄放宽成全库。
      userIds: [],
      legacyUserIds: [],
      unattributedOnly: false,
    },
  }
}

/**
 * 某一行没查到金额时的兜底：一份**零用量**的金额。
 *
 * 正常情况不会走到（分组键与金额键由同一份实现产出），留着是为了让
 * 「有这一行就一定有 `cost` 字段」成立 —— 字段时有时无会让页面在
 * 「有金额」和「没金额」之间闪，而截图时它恰好是哪种完全看运气。
 */
function emptyCost(session: PortalStatsSession): StatsCostTotals {
  return { ...summarizeCosts([]), pricing: session.pricingProvenance }
}

/**
 * 可用的分组维度（协议里的 `GroupBy`）。
 *
 * ★ 是**列表而不是 switch 的兜底**：新增维度时忘记改这里会得到 400，
 *   而不是一个静默返回全部数据的接口。
 */
const GROUP_BYS: readonly GroupBy[] = [
  'provider',
  'model',
  'provider-model',
  // ★ 来源（哪个客户端写的）：受控枚举，`core/db/query.ts` 的
  //   `dimensionExpression('source')` 直接取列值（不做任何归一化 ——
  //   来源名是采集端写下的**事实**，不是可配置的展示名）。
  'source',
  'user',
  // ★ `group` 是**多对多维度**：一条事件计入它的人员所属的每个分组，
  //   所以各分组之和 > 总量是定义（见 core/db/portal.ts 的注释）。
  'group',
  'project',
  'day',
  'hour',
] as const

/** 明细分页上限。给足但不放任：单页 2000 行已远超任何人会看的量。 */
const MAX_RECORDS_LIMIT = 2000
const DEFAULT_RECORDS_LIMIT = 100

/**
 * 堆叠趋势**默认**最多画这么多层，其余的合并成「其余 N 个」。
 *
 * ★ 取舍的理由：几十个人各占一条柱子之后，每一层都细到看不见，
 *   而**合计仍然要等于总量** —— 所以尾部不是被丢掉，而是折进一项
 *   `merged: true` 的「其余」。页面据此说明「其余 12 个」，
 *   使用者既看得清主要的几层，也不会以为少了数据。
 *
 * ★ 这只是**默认值**：页面可以带 `stack_top` 覆盖它（见 `#series`）。
 *   不带参数的请求（老客户端、直接 curl、对账脚本）行为与以前完全一致。
 */
const SERIES_STACK_DEFAULT_TOP = 8

/**
 * `stack_top=all`（以及任何更大的层数请求）的**兜底上限**。
 *
 * ⚠️ 它不是「默认值的第二份实现」，而是**载荷体积的护栏**：每一层都要下发
 *   `len(points)` 个数字，几百层 × 上千个桶会变成几十 MB 的 JSON，
 *   浏览器只会卡死。被这一层折掉的层照旧进「其余 N 个」那一项 ——
 *   页面上看得见（`mergedCount` 与那句说明），不是静默丢数据。
 */
const SERIES_STACK_MAX_TOP = 200

/**
 * 解析 `stack_top`：缺省 = {@link SERIES_STACK_DEFAULT_TOP}；`all` = 全部
 * （受 {@link SERIES_STACK_MAX_TOP} 兜底）；正整数原样；其余回 400。
 *
 * ⚠️ 刻意**不接受** `0` / 负数 / 小数 / 空串：它们要么让所有层都进「其余」，
 *   要么让这一趟多算的东西一个都不下发 —— 两种都会在页面上表现成
 *   「这段时间没数据」，和「真的没数据」长得一模一样。
 *   这与 `bucket` / `stack` 是同一套规矩：未知取值不许静默退回默认。
 */
function parseStackTop(raw: string | null): number | { reason: string } {
  if (raw === null) return SERIES_STACK_DEFAULT_TOP
  if (raw === 'all') return SERIES_STACK_MAX_TOP
  if (!/^[1-9][0-9]*$/.test(raw))
    return { reason: `stack_top 只支持正整数或 all，收到 "${raw}"` }
  const value = Number(raw)
  if (!Number.isSafeInteger(value))
    return { reason: `stack_top 只支持正整数或 all，收到 "${raw}"` }
  return Math.min(value, SERIES_STACK_MAX_TOP)
}

/** 路由处理结果：状态码 + 响应体。`index.ts` 的 `fromRoute()` 直接吃这个形状。 */
export interface StatsRouteResult {
  status: number
  body: unknown
}

export interface StatsRouteOptions {
  credentials?: CredentialStore
  identityStore?: IdentityRepository
  /** **上报库**路径（全员数据，与本地库 `usage.sqlite` 是两个文件）。 */
  dbPath: string
  /**
   * 可选：配了就读 MySQL 上报库（部门集中部署）。
   *
   * ★ `dbPath` 仍必填 —— 没配 MySQL 时它就是真值，配了则是「退路配置」。
   *   这样 `index.ts`（另一个会话在改）不必先改构造函数就能继续编译。
   */
  mysqlUrl?: string
}

/**
 * 部门统计路由。
 *
 * ⚠️ 每个请求独立开关一次库连接（与 `ingest-route.ts` / `local-api.ts` 一致）：
 *   查一次库是毫秒级，而长持连接要额外处理 WAL 回收与进程退出 ——
 *   对一个「打开页面看一眼」的工具不值得。MySQL 下连接来自共享池，
 *   `close()` 是空操作，调用形状与 SQLite 一致。
 */
export class StatsRoute {
  readonly #credentials: CredentialStore | undefined
  readonly #identityStore: IdentityRepository | undefined
  readonly #target: PortalTarget

  constructor(options: StatsRouteOptions) {
    this.#credentials = options.credentials
    this.#identityStore = options.identityStore
    // ★ 配置只在这里归一成 `PortalTarget`：换后端不影响任何查询分支。
    this.#target = resolvePortalTarget({
      sqlitePath: options.dbPath,
      mysqlUrl: options.mysqlUrl,
    })
  }

  /**
   * 处理一个看板查询。
   *
   * 顺序是「先认人、再解析参数、最后查库」：未通过鉴权的请求没有任何理由
   * 被解析，也没有任何理由让它的参数影响查询计划。
   */
  async handle(
    sub: string,
    params: URLSearchParams,
    authorization: Authentication,
  ): Promise<StatsRouteResult> {
    // ── 1. 身份（★ 与上报共用同一套可信边界）───────────────────────
    // 401/503 的判定在 `http/auth.ts` 的 `authorize()` 里（全仓唯一一处）。
    const auth = this.#identityStore
      ? await authorizeDatabase(this.#identityStore, authorization, 'stats:read', VIEWER_AUTH_MESSAGES)
      : authorize(this.#credentials!, typeof authorization === 'string' ? authorization : null, VIEWER_AUTH_MESSAGES)
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, reason: auth.reason } }
    }

    if (!KNOWN_SUBS.includes(sub)) {
      return { status: 404, body: { ok: false, reason: `未找到 /api/v1/stats/${sub}` } }
    }

    // ★ 候选目录（分组 / 人员）与时间窗、用量筛选全都无关 —— 它们回答的是
    //   「库里有哪些分组、名册上有哪些人」，所以放在开统计会话之前：
    //   一个筛选下拉不该顺带开一次统计会话。
    //   鉴权已经在上面做完了，401/503 的语义与其它子路径完全一致。
    if (sub === 'groups') return await this.#groups()
    if (sub === 'members') return await this.#members()
    // ★ 供应商候选同样是**目录**，与时间窗 / 用量筛选全都无关，所以也在
    //   开统计会话之前（同分组 / 人员候选）。
    //   ⚠️ 归一化要**按查看者**解析（全局规则 + 他个人的规则），所以这里
    //   把身份里的稳定人员 ID 传进去 —— 与查询期的口径必须是同一份。
    if (sub === 'providers') {
      return await this.#providers('memberId' in auth.viewer ? auth.viewer.memberId : undefined)
    }
    // ★ 来源候选（`dsh` / `codex` / …）同样是目录：受控枚举 + 库里出现过的值。
    //   不带时间窗、不带筛选，也不含任何用量数字。
    if (sub === 'sources') return await this.#sources()
    // ★ 项目归一化配置页用的**原始目录**候选（v11）：`cwd` 是路径，让人凭记忆敲
    //   一个 `D:\Coding_agent\ai-token-report` 正是这个功能最容易出错的地方
    //   （敲错一个字符 = 规则静默不命中）。它带数据范围，见 `#projects()`。
    if (sub === 'projects') return await this.#projects(auth.viewer)
    // ★ 单价只读快照：门是 `cost:read`（不是管理接口那道 `pricing:manage`）。
    //   能看金额的人必须能看到这份金额是按哪份单价算出来的 —— 看不到单价，
    //   他就只能相信这一屏上的数字，而「自建计价 ≠ 财务账单」正是要提醒的。
    //   它不需要时间窗与筛选（单价是全局配置），所以放在解析窗口之前。
    if (sub === 'pricing') {
      if (!hasCostRead(auth.viewer)) {
        return { status: 403, body: { ok: false, reason: '当前身份没有查看计价的权限' } }
      }
      return await this.#pricing()
    }

    // ── 2. 参数（时间窗在服务端解析，前端不做日期换算）──────────────
    const window = parseWindow(params)
    if ('error' in window) return { status: 400, body: { ok: false, reason: window.error } }

    // ── 2.5 数据范围（🚨 非管理员一律只看本人，见模块注释）──────────
    // ★ 放在参数解析**之后**：非法参数照旧回 400，不要让它变成 403。
    //   收窄的结果只喂给取数层，`window`（时间窗标签）保持不变。
    const scoped = applyDataScope(auth.viewer, params, window)
    if ('result' in scoped) return scoped.result

    const filter = scoped.filter

    // ★ `openPortalStats()` 内部就是 `await openPortalStore(target)`：
    //   它决定了连 SQLite 还是 MySQL，本文件**看不到**这个差别。
    // 🚨 `session.close()` 就是 `store.close()`（MySQL 空操作 / SQLite 真关），
    //   所以 finally 里的形状与 `ingest-route.ts` 完全一致。
    let session: PortalStatsSession
    try {
      // ★ 供应商归一化按**查看者**解析（全局规则 + 他个人的规则逐条覆盖）。
      //   传加载函数而不是现成映射：规则要用同一个已过版本闸门的连接去读。
      //   ⚠️ 人员 ID 只来自**服务端解析出的身份**（`auth.viewer.memberId`），
      //   绝不从查询参数里取「以谁的身份归一化」—— 那等于让任何有
      //   `stats:read` 的人套用别人的口径，而页面上看不出任何差别。
      //   旧的 `CredentialStore` 身份（兼容路径）没有稳定人员 ID，
      //   此时退化成「只有全局规则」，这是刻意的。
      const viewerId = 'memberId' in auth.viewer ? auth.viewer.memberId : undefined
      // 🚨 权限在这里转成**一个布尔**，core 不认权限概念。
      //   没有 `cost:read` 时金额**根本没被计算过** —— 不是「算完再丢掉」。
      session = await openPortalStats(this.#target, filter, (store) => loadProviderAliases(store, viewerId), hasCostRead(auth.viewer), (store) => loadProjectAliases(store, viewerId))
    } catch (err) {
      if (isIdentityViewRequired(err)) return { status: 409, body: { ok: false, code: 'identity_view_required', reason: err.message } }
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      // 上报库打不开（含 schema 版本不符：**绝不自动重建**）→ 500。
      // 这里没有「降级直扫」这条退路：上报库是全员数据的唯一副本，
      // 拿空数据冒充「今天没人用」比报错危险得多。
      // 🚨 响应文案一个字都不许变（`stats-api.test.ts` / `http-contract.test.ts` 逐字断言）。
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      switch (sub) {
        case 'overview':
          return { status: 200, body: await buildOverview(session, window) }
        case 'series':
          return await this.#series(session, params)
        case 'breakdown':
          return await this.#breakdown(session, params)
        case 'records':
          return await this.#records(session, params)
        case 'diagnostics':
          return { status: 200, body: await buildDiagnostics(session) }
        case 'hour-of-day':
          return await this.#hourOfDay(session, params, window)
        default:
          return { status: 404, body: { ok: false, reason: `未找到 /api/v1/stats/${sub}` } }
      }
    } catch (err) {
      if (isIdentityViewRequired(err)) return { status: 409, body: { ok: false, code: 'identity_view_required', reason: err.message } }
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await session.close()
    }
  }

  /**
   * `GET /api/v1/stats/series?bucket=day|hour[&stack=user|model][&stack_top=8|20|all]`
   *
   * `stack` 是可选的：带上它才会多算一趟「每个桶 × 每个分层」的交叉值
   * （见 `buildStack()`）。不带就是原来那条单序列 —— 老客户端一个字节都不用改。
   *
   * `stack_top` 只在展开时有用：缺省仍是前 8 名 + 「其余 N 个」，`all` 则把
   * 窗口内出现过的每一层都下发（受 `SERIES_STACK_MAX_TOP` 兜底）。
   * ★ 页面上的「前 8 / 前 20 / 全部」开关就是这一个参数 ——
   *   层数是**看的人自己的取舍**：人多时全画出来会糊成一片，而只想核对
   *   「每个人各用了多少」时，「其余 7 人」恰恰是他唯一看不到的东西。
   */
  async #series(session: PortalStatsSession, params: URLSearchParams): Promise<StatsRouteResult> {
    const raw = params.get('bucket') ?? 'day'
    if (raw !== 'day' && raw !== 'hour') {
      // 不许静默兜底成 day：那样「按小时看」的页面会拿着天级数据画图，
      // 而图上没有任何迹象说明它换了粒度。
      return { status: 400, body: { ok: false, reason: `bucket 只支持 day 或 hour，收到 "${raw}"` } }
    }
    const bucket: Bucket = raw

    // ⚠️ 与 `by` / `bucket` 同一套规矩：未知取值必须 400，不许静默退回单序列 ——
    //   那样「按用户展开」的页面会画出一条合计线，而图上没有任何迹象说明它没展开。
    const rawStack = params.get('stack')
    if (rawStack !== null && rawStack !== 'user' && rawStack !== 'model') {
      return { status: 400, body: { ok: false, reason: `stack 只支持 user 或 model，收到 "${rawStack}"` } }
    }
    const stackBy: SeriesStackBy | null = rawStack

    const top = parseStackTop(params.get('stack_top'))
    if (typeof top !== 'number')
      return { status: 400, body: { ok: false, reason: top.reason } }

    const points = (await session.series(bucket, true)).map((p) => ({
      bucket: p.bucket,
      totalTokens: p.counts.total,
      inputTokens: p.counts.input,
      outputTokens: p.counts.output,
      cacheReadTokens: p.counts.cacheRead,
      calls: p.counts.calls,
      cacheHitRate: cacheHitRate({ input: p.counts.input, cacheRead: p.counts.cacheRead }),
      // ★ 每个点各自带金额：横跨换价的一段窗口里，不同点的同一模型单价是不同的，
      //   所以趋势上的金额**不能**用「总量 × 当前价」重算一遍。
      ...(p.cost ? { cost: p.cost } : {}),
    }))

    const body: SeriesResponse = {
      bucket,
      points,
      ...(stackBy ? { stack: await buildStack(session, stackBy, bucket, points, top) } : {}),
    }
    return { status: 200, body }
  }

  /** `GET /api/v1/stats/breakdown?by=...` */
  async #breakdown(session: PortalStatsSession, params: URLSearchParams): Promise<StatsRouteResult> {
    const by = (params.get('by') ?? 'user') as GroupBy
    if (!GROUP_BYS.includes(by)) {
      return {
        status: 400,
        body: { ok: false, reason: `未知维度 "${by}"。可选: ${GROUP_BYS.join(' | ')}` },
      }
    }

    // ★ 金额按**同一套分组键**另取一趟，然后在这里合并。
    //   键的口径（归一化后的 provider、稳定人员 ID、按项目名合并、按本地时区分桶）
    //   只有 `core/db/portal.ts` 一份实现 —— 让本文件自己去对键，就会多出
    //   第二份「什么算同一组」的判断，而它与分组的判断一定会分叉。
    //
    // ★ 两趟聚合**互不依赖**，并发发出去：它们是两次各自独立的全窗口扫描
    //   （线上实测 30 天窗口 by=user 约 0.3s + 0.6s，全年约 0.5s + 1.9s），
    //   串行等于把延迟相加，而页面上等的是两者都到。SQLite 后端由
    //   `SqlitePortalStore` 的 `queued()` 自己串行化，所以那边既不提速也不改语义。
    const [costs, groupRows] = await Promise.all([
      session.costByGroup(by),
      session.groups(by),
    ])

    const rows = groupRows.map((row) => ({
      key: row.key,
      ...(row.attributionStatus ? {
        label: row.label,
        member_id: row.memberId ?? null,
        // ★ 人员排行里带上他**当前**所属的全部分组名（多对多，未分组 = 空数组）。
        //   只有人员维度有此字段：`by=group` 的行本身就是分组，不需要再列一遍。
        ...(row.groupNames ? { group_names: row.groupNames } : {}),
        attribution_status: row.attributionStatus,
      } : {}),
      totalTokens: row.counts.total,
      inputTokens: row.counts.input,
      outputTokens: row.counts.output,
      cacheReadTokens: row.counts.cacheRead,
      cacheWriteTokens: row.counts.cacheWrite,
      calls: row.counts.calls,
      cacheHitRate: cacheHitRate({ input: row.counts.input, cacheRead: row.counts.cacheRead }),
      // 无 `cost:read` 时 `costs` 是空表 → 字段不下发（不是 0）。
      ...(costs.size === 0 ? {} : { cost: costs.get(row.key) ?? emptyCost(session) }),
    }))

    const body: BreakdownResponse = { by, rows }
    return { status: 200, body }
  }

  /** `GET /api/v1/stats/records?limit&offset` */
  async #records(session: PortalStatsSession, params: URLSearchParams): Promise<StatsRouteResult> {
    const rawLimit = intParam(params, 'limit')
    const rawOffset = intParam(params, 'offset')
    if (rawLimit === 'invalid') {
      return { status: 400, body: { ok: false, reason: 'limit 需要是整数' } }
    }
    if (rawOffset === 'invalid') {
      return { status: 400, body: { ok: false, reason: 'offset 需要是整数' } }
    }

    const limit = rawLimit ?? DEFAULT_RECORDS_LIMIT
    const offset = rawOffset ?? 0

    if (limit < 1 || limit > MAX_RECORDS_LIMIT) {
      return {
        status: 400,
        body: { ok: false, reason: `limit 需要在 1~${MAX_RECORDS_LIMIT} 之间，收到 ${limit}` },
      }
    }
    if (offset < 0) {
      return { status: 400, body: { ok: false, reason: `offset 不能为负，收到 ${offset}` } }
    }

    const page = await session.records(limit, offset)
    const body: RecordsResponse = {
      total: page.total,
      limit,
      offset,
      rows: page.rows.map(toRecordRow),
    }
    return { status: 200, body }
  }

  /**
   * `GET /api/v1/stats/hour-of-day?day_kind=all|workday|weekend` —— **工作时段分布**。
   *
   * ## 为什么不复用 `breakdown?by=hour`
   *
   * `by=hour` 的分组键是 `2026-10-01T14`（哪一天的哪一小时），而本接口要的是
   * **一天中的第几小时**（`14`）—— 把所有日期的同一时刻折叠。
   * 那是**另一个分桶键**，不是同一个维度的更细粒度：`by=hour` 在 30 天窗口下会给
   * 700 多个点，而这里永远只有 24 个。两者的消费方式（热力图 vs 折线）也不同。
   *
   * ★ 取数走 `session.hourOfDay()`，它内部按「全历史折叠表 → 保留窗口小时表 →
   *   原始表」三条路择一，并且由 `rollup.test.ts` 钉住**三条路结果逐位相同**。
   *
   * ⚠️ 载荷里**没有 `sessions`**：去重会话数不可加，只能走原始表，
   *   而本接口刻意走汇总表。要会话数请用 `overview`（见协议注释）。
   */
  async #hourOfDay(session: PortalStatsSession, params: URLSearchParams, window: ParsedWindow): Promise<StatsRouteResult> {
    const raw = params.get('day_kind') ?? 'all'
    if (raw !== 'all' && raw !== 'workday' && raw !== 'weekend') {
      // 与 `bucket` / `by` 同一套规矩：未知取值必须 400，不许静默退回 all ——
      // 那会让「只看工作日」的页面拿到含周末的数字，而图上没有任何迹象。
      return { status: 400, body: { ok: false, reason: `day_kind 只支持 all / workday / weekend，收到 "${raw}"` } }
    }
    const rows = await session.hourOfDay(raw)
    const body: HourOfDayResponse = {
      day_kind: raw,
      points: rows.map((row) => ({
        hour: row.hour,
        calls: row.counts.calls,
        totalTokens: row.counts.total,
        inputTokens: row.counts.input,
        outputTokens: row.counts.output,
        cacheReadTokens: row.counts.cacheRead,
        cacheWriteTokens: row.counts.cacheWrite,
        // 口径只经 shared 计算（铁律 1）：这里不写公式。
        cacheHitRate: cacheHitRate({ input: row.counts.input, cacheRead: row.counts.cacheRead }),
      })),
      range: { from: window.sinceMs ?? null, to: window.untilMs ?? null, label: window.label },
    }
    return { status: 200, body }
  }

  /**
   * `GET /api/v1/stats/groups` —— 看板的分组候选项。
   *
   * ★ 权限是 `stats:read`（与其它看板接口同一道门，见 `handle()` 的鉴权），
   *   而不是管理接口的 `groups:read` / `groups:manage`。
   *   理由：页面上的筛选下拉只需要知道「有哪些分组」，让一个下拉列表
   *   具备分组管理权限等于把分组目录变成看板的副作用。
   *
   * 🚨 **只读**，而且只碰 `member_groups` + `member_group_assignments` 两张表：
   *   `usage_event.group_name` 是客户端**自称**的文本快照（可以随便填），
   *   拿它当候选项等于让页面按错别字筛选 —— 候选必须来自权威的分组目录。
   *
   * ⚠️ `member_count` 是**当前**关联人数，与时间窗无关（窗口只在查用量时才用）。
   *   因此本方法**刻意不收 `ParsedWindow`**：那样会让人以为这个数是按窗口算的。
   */
  async #groups(): Promise<StatsRouteResult> {
    let store: PortalStore
    try {
      store = await openPortalStore(this.#target)
    } catch (err) {
      // 与其它子路径同一套错误风格：数据库身份形态下回 503，其它形态回 500。
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      // ⚠️ 关联计数写成相关子查询而不是 LEFT JOIN + GROUP BY：
      //   两个后端上都不会因为「一个分组多人」而产生重复行，
      //   也不需要 `COUNT(DISTINCT ...)`（MySQL 下 `SUM`/`COUNT` 的返回类型还不一样）。
      const rows = await store.all<{ group_id: string; name: string; status: string; member_count: unknown }>(
        `SELECT g.group_id, g.name, g.status,
           (SELECT COUNT(*) FROM member_group_assignments a WHERE a.group_id = g.group_id) AS member_count
         FROM member_groups g ORDER BY g.name, g.group_id`,
      )
      const groups: StatsGroupOption[] = rows.map((row) => ({
        group_id: String(row.group_id),
        name: String(row.name),
        status: String(row.status) as StatsGroupOption['status'],
        // ⚠️ MySQL 下 COUNT 经驱动可能是字符串，`Number()` 在口径边界上归一（同 portal.ts 的 num()）。
        member_count: Number(row.member_count),
      }))
      const body: StatsGroupsResponse = { groups }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }

  /**
   * `GET /api/v1/stats/members` —— 看板的人员候选项。
   *
   * ★ 权限是 `stats:read`（与其它看板接口同一道门），**不是** `members:read`：
   *   页面上一个筛选下拉需要的只是「名册上有谁、他在哪个分组」，
   *   让它顺带具备人员目录的管理权限，等于把名册变成看板的副作用。
   *
   * 🚨 它是人员下拉里**唯一**能列出「当前时间窗内没有用量的人」的来源。
   *   从用量行里取候选的老做法在选中分组之后会整个空掉（见协议注释）——
   *   那是这一条接口存在的全部理由，别为了省一次查询把它删掉。
   *
   * ⚠️ 只回筛选要用的三样（稳定 ID / 显示名 / 当前分组 ID）。角色、权限、
   *   登录账号一律不下发：它们属于管理面，`/api/v1/admin/members` 才是那份答案。
   * ⚠️ 已停用人员照样列出（同分组候选）：停用只影响「以后还能不能选他」。
   *
   * ★ 它**不跟着数据范围收窄**（`applyDataScope()` 只管用量）：这是一份**目录**，
   *   里面一个用量数字都没有，而分组下拉的联动（见 `memberFilterOptions()`）
   *   要靠它才能工作。页面在「只看自己」时不渲染人员下拉，也就不需要它 ——
   *   但那属于页面的呈现决定，不是这条接口的授权边界。
   */
  async #members(): Promise<StatsRouteResult> {
    let store: PortalStore
    try {
      store = await openPortalStore(this.#target)
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      // ★ 两条查询 + 内存归并，既不是 JOIN 也不是 `GROUP_CONCAT`：
      //   与关联表 JOIN 会让每个人员按分组数复制成多行（同 `#groups` 的注释），
      //   而 `GROUP_CONCAT` 在两个后端上的写法与分隔符并不一致。
      //   排序交给 SQL，页面按名册顺序展示。
      const members = await store.all<{ member_id: string; display_name: string; status: string }>(
        'SELECT member_id, display_name, status FROM members ORDER BY display_name, member_id',
      )
      const assignments = await store.all<{ member_id: string; group_id: string }>(
        'SELECT member_id, group_id FROM member_group_assignments ORDER BY group_id',
      )
      const groupIds = new Map<string, string[]>()
      for (const row of assignments) {
        const memberId = String(row.member_id)
        const list = groupIds.get(memberId) ?? []
        list.push(String(row.group_id))
        groupIds.set(memberId, list)
      }
      const body: StatsMembersResponse = {
        members: members.map((row) => ({
          member_id: String(row.member_id),
          name: String(row.display_name),
          status: String(row.status) as StatsMemberOption['status'],
          group_ids: groupIds.get(String(row.member_id)) ?? [],
        })),
      }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }

  /**
   * `GET /api/v1/stats/sources` —— 看板的**来源**候选项。
   *
   * ★ 与 `/providers` 的唯一区别：来源是**受控枚举**，所以候选项 =
   *   `registeredSources()`（本进程认识的全部来源）**∪** 库里实际出现过的值。
   *   前者让「本机还没跑过 Codex」的人也能筛出 0 行（这是**如实**的答案，
   *   而不是下拉里没有这一项、让人以为平台不支持）；后者兜住
   *   「更新版客户端上报了一个本进程还不认识的来源」—— 只在库里取候选的话，
   *   那种行在页面上**看得到却筛不出来**。
   *
   * ⚠️ 与 `/providers` 同样：不带时间窗、不带任何筛选、只回名字，
   *   也**不按数据范围收窄**（来源名不属于任何一个人）。
   * 🚨 顺序固定（`dsh` 在最前，其余字典序）：下拉的项序不该随库里的数据变化。
   */
  async #sources(): Promise<StatsRouteResult> {
    let store: PortalStore
    try {
      store = await openPortalStore(this.#target)
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      const rows = await store.all<{ source: unknown }>(
        `SELECT DISTINCT source FROM ${EVENT_TABLE} ORDER BY source`,
      )
      const names = new Set<string>(registeredSources().map((adapter) => adapter.id))
      for (const row of rows) {
        const value = String(row.source ?? '').trim()
        if (value) names.add(value)
      }
      // `dsh` 恒在第一位（面板主体永远是 DSH），其余按字典序。
      const body: StatsSourcesResponse = {
        sources: [...names].sort((a, b) => (a === 'dsh' ? -1 : b === 'dsh' ? 1 : a.localeCompare(b))),
      }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }

  /**
   * `GET /api/v1/stats/providers` —— 看板的供应商候选项。
   *
   * ★ 权限是 `stats:read`（与其它看板接口同一道门），**不是** `providers:read`：
   *   筛选下拉只需要知道「库里出现过哪些供应商名」，让一个下拉顺带具备
   *   供应商归一化的读权限，等于把配置面变成看板的副作用（同分组 / 人员候选）。
   *
   * ★ 名字按**查看者**的归一化规则（全局 + 他个人的规则逐条覆盖）映射成
   *   **展示名**，与查询期的筛选口径是同一份映射 —— 否则使用者会「按页面上
   *   看到的名字筛，却一行都筛不出来」。多条规则指向同一个名字时去重在 JS 侧做，
   *   因为那是**规则**的结果，不是库里的列。
   *
   * ⚠️ 刻意**不带时间窗、不带任何筛选**：候选必须始终是完整集合，
   *   否则「上个月用过的供应商」会从下拉里消失 —— 那看起来像数据丢了，
   *   而不像「这段时间没人用」。
   *
   * ★ 候选有**两个来源**（缺一个都是「下拉里没有那个名字」）：
   *   1. `usage_event.provider` 里出现过的原值（经上面的映射后的展示名）；
   *   2. 归一化规则里配的**归一化名**（`aliases`）—— 只从用量取候选时，
   *      一条规则配好了、对应原值却还没有用量时，那个规范化名字**根本不会出现**，
   *      而它正是使用者在 `/providers` 页配出来、想在看板上筛的那个名字。
   *      代价是它可能筛出 0 行，那是**如实的答案**（与来源候选里
   *      「本机还没跑过 Codex」同一件事），不是「数据丢了」。
   *
   * ⚠️ 只回名字、不回任何用量数字，所以**不按数据范围收窄**（同分组 / 人员候选）。
   *   供应商名不属于任何一个人，`usage_event.provider` 上也没有人。
   *
   * 🚨 只读，且不出现任何公式 / 金额：本接口回答的是「有哪些名字」。
   */
  async #providers(viewerId: string | null | undefined): Promise<StatsRouteResult> {
    let store: PortalStore
    try {
      store = await openPortalStore(this.#target)
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      // ★ 归一化必须走与查询同一条路（`loadProviderAliases`）：页面上的
      //   下拉项与筛选匹配的名字只能是同一个，否则筛选会静默筛空。
      const aliases = await loadProviderAliases(store, viewerId)
      // `DISTINCT` 交给 SQL（两个后端写法一致），去重后的映射在 JS 侧做 ——
      // 多条规则可能把不同的原值折叠成同一个展示名。
      const rows = await store.all<{ provider: string }>(
        `SELECT DISTINCT provider FROM ${EVENT_TABLE} ORDER BY provider`,
      )
      const names = new Set<string>()
      for (const row of rows) {
        const raw = String(row.provider ?? '')
        if (!raw) continue
        names.add(aliases.providers.get(raw) ?? raw)
      }
      // ★ 归一化规则里配的**归一化名**（配置面，与用量无关）：一条规则配好了、
      //   对应原值却还没有用量时，那个名字在上面的循环里**根本不会出现** ——
      //   而它正是看板上要用的那个名字（使用者在 `/providers` 页配的就是它）。
      //   ⚠️ 只读**启用中**的规则：`loadProviderAliases()` 已经按 `enabled = 1`
      //   过滤，停用一条规则 = 该名字不再参与归一化，也就不是候选了。
      //   ⚠️ 刻意不与 `providers` 去重：两份候选是**两个事实**
      //   （数据里出现过的 / 配置里定义的），同名怎么取舍由页面的
      //   `providerFilterOptions()` 一处决定（数据派生的优先）。
      const aliasNames = new Set<string>()
      for (const target of aliases.providers.values()) {
        const value = String(target ?? '')
        if (value) aliasNames.add(value)
      }
      const body: StatsProvidersResponse = {
        providers: [...names].sort(),
        aliases: [...aliasNames].sort(),
      }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }

  /**
   * `GET /api/v1/stats/projects` —— 项目归一化配置页要用的**原始目录**候选项。
   *
   * ## 为什么它必须存在
   *
   * 项目规则填的是**目录前缀**，而让人凭记忆敲一个
   * `D:\Coding_agent\ai-token-report` 正是这个功能最容易出错的地方：
   * 敲错一个字符 = 规则**静默不命中**，页面上完全看不出来。
   * 所以候选项来自**真实上报值**，让使用者去选而不是去写。
   *
   * ## 🚨 与 `/stats/providers` 的关键差别：它**跟着数据范围收窄**
   *
   * 供应商名不属于任何一个人，所以那份候选刻意不收窄。而 `cwd` 会带出
   * 使用者路径（`C:\Users\alice\…`）—— 一份**没有用量**的全量路径清单
   * 等于给「非管理员只看本人」开了一个侧门：他看不到别人的 token 数，
   * 却能看到别人的目录名。所以这里必须走 `applyDataScope()`。
   *
   * ## 权限与形状
   *
   * - 权限是 `stats:read`（与其它看板接口同一道门），**不是** `projects:read`：
   *   配置页只有在调用方本来就有 `stats:read` 时才去取它，取不到就退回手填
   *   （与配置页读人员名册同一取舍）。
   * - ⚠️ 只回**原始 cwd 字符串**，不回任何用量数字（没有条数、没有 token）：
   *   这是一个名称目录，不是一份统计。要看某个目录用了多少，
   *   去看板的「项目」分布表（那里已经是归一化后的口径）。
   * - ⚠️ 刻意**不带时间窗**：候选必须是完整集合，否则「上个月用过的目录」
   *   会从下拉里消失，那看起来像数据丢了。
   */
  async #projects(viewer: unknown): Promise<StatsRouteResult> {
    /**
     * ★ **时间窗为空**、只借 `applyDataScope()` 求数据范围。
     *
     * 复用那一个函数而不是在这里手写「非管理员 → memberIds:[自己]」：
     * 范围口径只能有一份实现，否则「看板收窄了、候选没收窄」这种分叉
     * 不会有任何测试能发现（它两次请求各自都是「对的」）。
     * 参数传空 `URLSearchParams` —— 这条接口本来就不接受任何筛选参数。
     *
     * ⚠️ 它同样会对「没有稳定人员 ID 的凭证」回 403（`scopeDenied`），
     *   与看板一致：给不出身份就取不到需要按人收窄的数据。
     */
    const scope = applyDataScope(viewer, new URLSearchParams(), { label: '全部时间', filter: {} })
    if ('result' in scope) return scope.result

    let store: PortalStore
    try {
      // ★ 与 `/stats/providers` / `/stats/sources` 同款：**开裸连接跑一条 SELECT**，
      //   不走 `openPortalStats()`。
      //   🚨 走统计会话会撞上 `assertLegacyIdentityView()` —— 那一关在「部门视角
      //   （没有 `identity_view=member`）且库里存在『有 member_id 但没有旧姓名』的事件」
      //   时回 409。那扇门是给**按人排行**用的（同名 / 改名无法表达时必须拒绝），
      //   而一份目录候选与归属毫无关系 —— 让配置页因为归属形状打不开是错的方向，
      //   而它表现成「归一化配置页在正式库上永远取不到候选」。
      store = await openPortalStore(this.#target)
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      // 取数 SQL 仍然只有一处实现（`distinctCwdsQuery`）—— 这里只负责执行它。
      const q = distinctCwdsQuery(scope.filter)
      const rows = await store.all<{ cwd: unknown }>(q.sql, q.params)
      const body: StatsProjectsResponse = {
        projects: rows.map(row => String(row.cwd)).filter(value => value.length > 0),
      }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }

  /**
   * `GET /api/v1/stats/pricing` —— 单价只读快照。
   *
   * ★ 与 `/api/v1/admin/pricing` 是**两条接口、两道门**：
   *
   * | | `/api/v1/admin/pricing` | 本条 |
   * |---|---|---|
   * | 性质 | **配置**（可改的那份目录） | 看数据时的**解释材料** |
   * | 权限 | `pricing:manage` | `cost:read` |
   *
   * 分开的理由是它们回答两个不同的问题：「这台服务器上的价是怎么配的」
   * 与「我刚看到的那个金额是按哪份价算的」。后者是任何能看到金额的人
   * **必须**能回答的 —— 看不到单价，他只能选择相信屏幕上的数字，
   * 而「自建计价 ≠ 财务账单」这件事就没法自查了。
   *
   * 🚨 **只读**，而且只读 `model_price` 一张表：这里绝不出现任何用量数据，
   *   也绝不写一个字节（与 `/api/v1/stats/*` 的其它子路径同一约束）。
   */
  async #pricing(): Promise<StatsRouteResult> {
    let store: PortalStore
    try {
      store = await openPortalStore(this.#target)
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `上报库不可用: ${msg(err)}` } }
    }

    try {
      // ★ 排序与管理员目录**逐字相同**（`provider, model, effective_from_ms, price_id`）：
      //   两处的「同一模型的历史价」顺序一旦不同，使用者会以为自己在看两份不同的配置。
      const rows = await store.all<Record<string, unknown>>(
        'SELECT * FROM model_price ORDER BY provider, model, effective_from_ms, price_id',
      )
      const body: StatsPricingResponse = {
        prices: rows.map(modelPriceFromRow),
        // 服务端读的是数据库表，所以没有「快照同步时刻」这回事。
        pricing: { pricingSource: 'db', pricingSyncedAt: null },
      }
      return { status: 200, body }
    } catch (err) {
      if (this.#identityStore) return { status: 503, body: { ok: false, reason: '统计数据库暂时不可用，请稍后重试' } }
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await store.close()
    }
  }
}

/**
 * 堆叠趋势的载荷：把「每个桶 × 每个分层」的交叉值对齐到 `points` 的下标。
 *
 * ## 四条不许破的性质
 *
 * 1. ★ **各层之和 ≡ `points[].totalTokens`**（`calls` 同理）。尾部超出的层
 *    不是被丢掉，而是折进一项 `merged: true` 的「其余 N 个」——
 *    少了这一项，堆叠柱的总高就会低于趋势总量，而图上没有任何迹象说明为什么。
 * 2. ★ **对齐只按桶键做**。补零之后的桶序由 `series()` 决定，分层只提供
 *    「这个桶有多少」，缺桶就是 0。让分层自己再补一次零，早晚会出现
 *    「图上有这个桶、某一层里没有」。
 * 3. **排序用窗口总量降序**，与人员排行的名次同源；键名升序只作稳定兜底
 *    （总量相同的两层之间不许每次刷新换位置）。
 * 4. ★ **金额只在一个币种时才逐层下发**。多币种时整块 `cost` 缺席 ——
 *    页面上那条「金额绝不跨币种相加」的规则已经会让金额指标不可选，
 *    这里再挑一个币种画出来，等于在堆叠柱上偷偷做一次换算。
 *
 * @param top 最多保留多少层（由 `stack_top` 解析而来）。少了的那部分照旧
 *   折进「其余 N 个」—— `top` 只决定**折在哪里**，不决定「要不要折」。
 */
async function buildStack(
  session: PortalStatsSession,
  by: SeriesStackBy,
  bucket: Bucket,
  points: SeriesResponse['points'],
  top: number,
): Promise<NonNullable<SeriesResponse['stack']>> {
  const stacks = await session.stackSeries(by, bucket)
  const ranked = [...stacks].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key),
  )
  const kept = ranked.slice(0, top)
  const rest = ranked.slice(top)

  const align = (map: Map<string, number>): number[] =>
    points.map((point) => map.get(point.bucket) ?? 0)

  // ★ 币种必须由**全部层**共同决定：某一层只有 CNY 而另一层只有 USD 时，
  //   逐层各自「只有一个币种」，加起来却是两个币种 —— 那正是要拦住的情况。
  const currencies = new Set<string>()
  for (const row of stacks) {
    for (const totals of row.costByBucket?.values() ?? []) {
      for (const entry of totals.costs) currencies.add(entry.currency)
    }
  }
  const currency = currencies.size === 1 ? [...currencies][0]! : null
  /**
   * 某一层在某个桶上的金额（微元）。
   *
   * ⚠️ 币种由**调用方**给出，这里找不到就返回 0 —— 但那条路根本走不到：
   *   `currency` 非空时它来自上面那份**全部层**的币种并集，
   *   所以每一层在这个币种上要么有钱、要么是未计价（0）。
   */
  const microIn = (totals: CostTotals | undefined, unit: string): number =>
    totals?.costs.find((entry) => entry.currency === unit)?.amountMicro ?? 0
  const alignCost = (row: PortalStackSeries): number[] | null =>
    currency === null
      ? null
      : points.map((point) => microIn(row.costByBucket?.get(point.bucket), currency))

  const items: SeriesStackItem[] = kept.map((row) => {
    const cost = alignCost(row)
    return {
      key: row.key,
      label: row.label,
      ...(by === 'user' ? { member_id: row.memberId ?? null } : {}),
      ...(row.groupNames ? { group_names: row.groupNames } : {}),
      ...(row.attributionStatus ? { attribution_status: row.attributionStatus } : {}),
      values: align(row.tokensByBucket),
      calls: align(row.callsByBucket),
      ...(cost ? { cost } : {}),
    }
  })

  if (rest.length > 0) {
    const tokens = new Map<string, number>()
    const calls = new Map<string, number>()
    for (const row of rest) {
      for (const [key, value] of row.tokensByBucket) tokens.set(key, (tokens.get(key) ?? 0) + value)
      for (const [key, value] of row.callsByBucket) calls.set(key, (calls.get(key) ?? 0) + value)
    }
    // ★ 「其余」的金额必须**逐桶相加**，而不是在其中取一个：
    //   同币种内相加是合法的（币种由上面那份并集保证唯一），
    //   直接 `set()` 会让合并项的金额等于最后一层的金额，而图上看起来完全正常。
    const cost =
      currency === null
        ? null
        : points.map((point) =>
            rest.reduce(
              (sum, row) => sum + microIn(row.costByBucket?.get(point.bucket), currency),
              0,
            ),
          )
    items.push({
      key: SERIES_STACK_MERGED_KEY,
      label: by === 'user' ? `其余 ${rest.length} 人` : `其余 ${rest.length} 个模型`,
      merged: true,
      values: align(tokens),
      calls: align(calls),
      ...(cost ? { cost } : {}),
    })
  }

  return { by, items, mergedCount: rest.length }
}

/** 已实现的子路径。写成常量而不是散落的 if，便于一处看清「有哪些接口」。 */
const KNOWN_SUBS: readonly string[] = [
  'overview',
  'series',
  'breakdown',
  'records',
  'groups',
  'members',
  // ★ 供应商候选项（筛选下拉用）。与分组 / 人员候选同类：它是一份**目录**，
  //   不带时间窗、不带筛选，也不含任何用量数字。
  'providers',
  // ★ 来源候选项（`dsh` / `codex` / …）。与供应商候选同类，差别只有一条：
  //   来源是**受控枚举**（由 `registeredSources()` 给出），所以候选项 =
  //   注册表 ∪ 库里出现过的值 —— 后者兜住「更新版客户端上报了一个本进程还不认识的来源」。
  'sources',
  // ★ 项目归一化配置页的**原始目录**候选（v11）。与供应商候选同类（一份目录、
  //   不带时间窗与筛选、不含任何用量数字），但回的是**原始 cwd**，
  //   而且**跟着数据范围收窄**（`cwd` 会带出使用者路径，见 `#projects()`）。
  'projects',
  'diagnostics',
  // ★ 工作时段分布：按「一天中的第几小时」折叠（不是 `by=hour` 那种带日期的分桶）。
  'hour-of-day',
  // ★ 单价只读快照（`cost:read`）。与管理的 `/api/v1/admin/pricing` 是两件事：
  //   那条是**配置**（读也要求 `pricing:manage`），这条是**看数据时的解释材料** ——
  //   能看金额的人必须能看到这份金额是按哪份单价算出来的，否则他无法核对。
  'pricing',
] as const

/**
 * 总览卡片。
 *
 * ★ 未归属占比的分子分母打的是**同一组筛选条件**（同一个 `session`），
 *   否则会出现「占比 120%」这种没人看得懂的数字。
 */
async function buildOverview(
  session: PortalStatsSession,
  window: ParsedWindow,
): Promise<OverviewResponse> {
  // ★ 用量、去重会话、未归属计数一次扫描；金额仍按独立价格桶计算。
  // 两次取数并行，派生指标继续交给 shared，接口字段与筛选口径保持一致。
  const [counts, cost] = await Promise.all([
    session.overviewCounts(),
    // 没有 `cost:read` 时 `costTotals()` 直接返回 null —— **整个字段不下发**。
    // 回 0 会让「你没权限」与「这个月没花钱」长得一模一样。
    session.costTotals(),
  ])
  const { total, sessions: sessionCount, unattributed } = counts
  // 口径来自 core 的 derive() + shared/metrics.ts，本文件不写公式
  const metrics = derive(total)

  return {
    range: {
      from: window.sinceMs ?? null,
      to: window.untilMs ?? null,
      label: window.label,
    },
    totalTokens: total.total,
    inputTokens: total.input,
    outputTokens: total.output,
    cacheReadTokens: total.cacheRead,
    cacheWriteTokens: total.cacheWrite,
    calls: total.calls,
    sessions: sessionCount,
    cacheHitRate: cacheHitRate({ input: total.input, cacheRead: total.cacheRead }),
    avgTokensPerCall: metrics.avgTokensPerCall,
    unattributedRate: unattributedRate(unattributed, total.calls),
    ...(cost === null ? {} : { cost }),
  }
}

/**
 * 采集诊断。
 *
 * ⚠️ `identityViolations` 恒为 0，这不是「没检查」，而是**结构上不可能不成立**：
 *   上报库不存 `total_tokens` 列（铁律 2 —— 库里只存四个原始列），
 *   展示用的总量一律由四项相加得出。客户端在 body 里带的 `total_tokens`
 *   被服务端明确忽略（见 `ingest-route.ts` 的字段表），因此「总数与四项不符」
 *   这种数据根本进不了库。四个 token 缺失或非法的行在入库前就被拒（`rejected`）。
 *
 *   这里保留该字段是为了不改动前端契约；页面据此显示「恒等式校验」一栏时，
 *   文案要说的是「结构上恒成立」，而不是「扫了 N 条都没问题」。
 *
 * ## 派生指标一律走 `shared/metrics.ts`
 *
 * 🚨 本函数**不写任何比率公式**。命中率、杠杆、平均每次调用全部由
 *   `deriveMetrics()` 算好后透传 —— 在这里再除一遍就是第二个口径实现，
 *   而它不会报错，只会让「诊断页说 94% 命中、看板说 88% 命中」长期共存。
 */
async function buildDiagnostics(session: PortalStatsSession): Promise<DiagnosticsResponse> {
  // ★ 这些聚合**互不依赖**，并发发出去（同 `buildOverview`）：诊断页等的是全部到齐，
  //   串行只是把它们各自的耗时相加。SQLite 后端仍由 `queued()` 串行化，语义不变。
  const [bounds, total, unattributed, sessions, distinctUsers, lastIngestAt, sources, reporters] = await Promise.all([
    session.timeBounds(),
    session.totals(),
    session.unattributedCalls(),
    session.sessions(),
    session.distinctUsers(),
    session.lastIngestAt(),
    session.sourceCoverage(),
    session.reporterCoverage(),
  ])
  const metrics = deriveMetrics(total, total.calls)
  // ★ 新鲜度以**服务端本次取数时刻**为基准：上报时刻来自服务端，
  //   拿浏览器时钟去减会把一个健康链路显示成「-3 分钟前」（见
  //   `formatTimeGap` 的注释）。这里算毫秒差，措辞交给页面。
  const now = Date.now()
  const silenceOf = (ts: number | null): number | null => (ts === null ? null : Math.max(0, now - ts))

  return {
    totalEvents: total.calls,
    unattributedEvents: unattributed,
    unattributedRate: unattributedRate(unattributed, total.calls),
    identityViolations: 0,
    distinctUsers,
    earliestTs: bounds.earliest,
    latestTs: bounds.latest,
    lastIngestAt,

    totalTokens: total.total,
    sessions,
    cacheHitRate: metrics.cacheHitRate,
    avgTokensPerCall: metrics.avgTokensPerCall,
    // ⚠️ 跨度 = 「最晚 − 最早」，**不是**窗口长度：客户端补报历史数据时
    //   事件时间可以远早于筛选窗口，而跨度要如实反映这批数据真实有多宽。
    spanMs: bounds.earliest !== null && bounds.latest !== null
      ? bounds.latest - bounds.earliest
      : null,
    // ⚠️ 会话数不可加（跨天会话会被算两次），所以这里不做「按天求和」。
    eventsPerSession: sessions === 0 ? null : total.calls / sessions,
    sources: sources.map((row) => ({ ...row, silentForMs: silenceOf(row.latestEventTs) })),
    reporters: reporters.map((row) => ({ ...row, silentForMs: silenceOf(row.latestEventTs) })),
  }
}

/** 明细行 → 线上契约字段（snake_case 只在边界出现，这里全 camelCase）。 */
function toRecordRow(row: PortalRecordRow): RecordRow {
  return {
    eventId: row.eventId,
    sessionId: row.sessionId,
    seq: row.seq,
    ts: row.ts,
    // ★ 未归属统一成协议里的 UNATTRIBUTED_USER，而不是 null：
    //   前端只需处理一种「未知」，且它与 breakdown by=user 的分组键同值。
    userId: row.userId ?? UNATTRIBUTED_USER,
    ...(row.attributionStatus ? {
      member_id: row.memberId ?? null,
      user_name_snapshot: row.userNameSnapshot ?? null,
      // ★ 两个不同的东西，别混：`group_ids` 是这个人**当前**所属的分组（关联表），
      //   `group_name_snapshot` 是上报当时客户端自己填的文本（只是线索，不参与归属）。
      group_ids: row.groupIds ?? [],
      group_name_snapshot: row.groupNameSnapshot ?? null,
      attribution_status: row.attributionStatus,
    } : {}),
    provider: row.provider,
    // ★ 原值只在**与展示名不同**时才发：它存在的意义是核对规则，
    //   而绝大多数行（没配规则的 provider）两者逐字相同，
    //   多发一个字段只是让每页 JSON 白胖一圈。
    ...(row.providerRaw && row.providerRaw !== row.provider ? { providerRaw: row.providerRaw } : {}),
    model: row.model,
    // ★ 与 `providerRaw` 同款：只在**与展示名不同**时才发。模型原值同时是
    //   计价用的键，但既然两者相同就没有信息可丢 —— 而「配了模型规则」的那些行
    //   一定不同，页面据此就能把原值显示出来供核对。
    ...(row.modelRaw && row.modelRaw !== row.model ? { modelRaw: row.modelRaw } : {}),
    // ★ v9 来源：原值原样透传（**不做归一化** —— 来源是受控枚举，
    //   `trae` 与 `trae-cn` 是两个来源，归一化会把它们混成一个）。
    //   页面据此显示「这条用量是谁写的」，与看板的来源筛选是同一个值。
    source: row.source,
    // 口径只经 shared 计算；四项原始用量完整透传。
    totalTokens: computeTotal({ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, reasoning: 0 }),
    inputTokens: row.input,
    outputTokens: row.output,
    cacheReadTokens: row.cacheRead,
    cacheWriteTokens: row.cacheWrite,
    cwd: row.cwd,
    // 逐条的金额：`currency: null` = 这一条没配上价（**不是 0 元**）。
    // 有权限时字段恒在（哪怕未计价），所以页面可以「按这个字段是否存在」决定
    // 要不要显示金额列 —— 不需要自己也去判一次权限。
    ...(row.cost ? { cost: row.cost } : {}),
  }
}

function isIdentityViewRequired(error: unknown): error is Error & { code: 'identity_view_required' } {
  return error instanceof Error && 'code' in error && error.code === 'identity_view_required'
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

interface ParsedWindow {
  sinceMs?: number
  untilMs?: number
  label: string
  filter: QueryFilter
}

/**
 * 解析时间窗与筛选条件。
 *
 * ★ 时间窗**直接复用 `core/range.ts` 的 `resolveRange()`** —— 与 CLI 的
 *   `--period`、本地页的 `period` 是同一个函数。这是「页面数字 == 命令行数字」
 *   的机制保证，而不是靠两边小心地写一样的代码。
 *
 * 显式的 `from` / `to`（epoch ms）优先于 `period`，与 CLI 的
 * `--since/--until` 覆盖 `--period` 是同一套语义。
 */
function parseWindow(params: URLSearchParams): ParsedWindow | { error: string } {
  const period = params.get('period') ?? undefined

  let range
  try {
    range = resolveRange(period ? { period } : {})
  } catch (err) {
    // 未知周期必须 400。静默兜底成「全部时间」会让页面显示一个巨大的数，
    // 而用户以为自己在看「今天」。
    return { error: err instanceof Error ? err.message : String(err) }
  }

  const from = intParam(params, 'from')
  const to = intParam(params, 'to')
  if (from === 'invalid') return { error: 'from 需要是 epoch 毫秒整数' }
  if (to === 'invalid') return { error: 'to 需要是 epoch 毫秒整数' }

  const sinceMs = from ?? range.sinceMs
  const untilMs = to ?? range.untilMs

  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    return { error: '起始时间晚于结束时间' }
  }

  const users = splitList(params.get('user'))
  // ★ 供应商筛选：多选（OR）。同时接受重复的同名参数
  //   （`?provider=a&provider=b`）与逗号分隔（`?provider=a,b`）——
  //   两种写法在真实前端里都会出现，而「只认其中一种」的表现是
  //   「筛了一个供应商却像没筛」。与 `group_id` 同款。
  //   ⚠️ 匹配仍是**子串**（`core/db/query.ts` 的 LIKE）：这是 CLI `--provider`
  //   的既有语义，改成精确匹配会让「页面筛 dashscope 得到 0 条、命令行却有一堆」。
  const providers = [...new Set(splitList(params.getAll('provider').join(',')))]
  const models = splitList(params.get('model'))
  /**
   * ★ **来源筛选**：多选（OR）+ **精确匹配**（与 `provider` 的子串语义刻意相反）。
   *
   * 来源是受控枚举，子串匹配会让 `code` 命中 `codex`、`trae` 命中 `trae-cn`
   * （两个独立安装、独立账号的来源，见 `sources/trae.ts`）。
   * 同时接受重复同名参数与逗号分隔 —— 两种写法在前端都会出现，
   * 「只认其中一种」的表现是「筛了一个来源却像没筛」。
   *
   * ⚠️ **只校验形状，不按注册表做白名单**：值域的真源是**库里的数据**
   *   （`/api/v1/stats/sources` = 注册表 ∪ 库里出现过的值）。按注册表拒收会让
   *   「更新版客户端上报了一个本进程还不认识的来源」在页面上**看得到却筛不出来**
   *   （候选接口列了它、筛选却回 400）。拼错的值（`codx`）得到 0 行 —— 与
   *   `?provider=zzz` 同一套既有语义：**它不是非法参数，只是没有数据**。
   *   形状校验仍然保留：超长 / 大写 / 空格会让 `source = ?` 永远匹配不上，
   *   与其让使用者对着 0 行猜，不如直接告诉他这个值不可能是来源名。
   */
  const requestedSources = [...new Set(splitList(params.getAll('source').join(',')))]
  const malformedSource = requestedSources.find((id) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
  if (malformedSource !== undefined) {
    return { error: `来源名只允许小写字母、数字与连字符（最长 32），收到 "${malformedSource}"` }
  }
  const sources = requestedSources
  // ★ 分组筛选：`group_id` 是多选（逗号分隔），与人员一样是**精确匹配**。
  //   同时接受重复的同名参数（`?group_id=a&group_id=b`）—— 两种写法在
  //   真实前端里都会出现，而「只认其中一种」的表现是「筛了一个分组却像没筛」。
  //   ⚠️ 它筛的是**归属关联**（谁属于哪些分组），不是 `group_name` 快照文本。
  const groupIds = [...new Set(splitList(params.getAll('group_id').join(',')))]
  const identityView = params.get('identity_view') ?? 'legacy'
  if (identityView !== 'member' && identityView !== 'legacy') return { error: 'identity_view 只支持 member 或 legacy' }
  const hasSelectors = ['member_id', 'legacy_user', 'unattributed'].some(key => params.has(key))
  if (params.has('user') && hasSelectors) return { error: 'user 不能与新的人员筛选参数同时使用' }
  if (identityView === 'member' && params.has('user')) return { error: 'user 仅支持 identity_view=legacy' }
  if (identityView === 'legacy' && hasSelectors) return { error: '新的人员筛选参数需要 identity_view=member' }
  const memberIds = [...new Set(params.getAll('member_id'))]
  if (memberIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) return { error: 'member_id 需要有效的人员 ID' }
  const legacyUserIds: string[] = []
  for (const key of new Set(params.getAll('legacy_user'))) {
    if (!/^legacy:[A-Za-z0-9_-]+$/.test(key)) return { error: 'legacy_user 需要有效的历史人员键' }
    const encoded = key.slice(7)
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return { error: 'legacy_user 需要有效的历史人员键' }
    legacyUserIds.push(decoded)
  }
  const unattributed = params.get('unattributed')
  if (unattributed !== null && unattributed !== 'true' && unattributed !== 'false') return { error: 'unattributed 只支持 true 或 false' }

  return {
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    ...(untilMs !== undefined ? { untilMs } : {}),
    // 显式给了 from/to 时，具名周期的标签已经不准确了，改成描述绝对区间
    label: from !== undefined || to !== undefined ? describeAbs(from, to) : range.label,
    filter: {
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(untilMs !== undefined ? { untilMs } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(models.length > 0 ? { models } : {}),
      // ★ 来源是**精确匹配**的列表（`core/db/query.ts` 的 `buildWhere` 用 `source = ?`）。
      ...(sources.length > 0 ? { sources } : {}),
      ...(users.length > 0 ? { userIds: users } : {}),
      ...(groupIds.length > 0 ? { groupIds } : {}),
      identityView,
      ...(memberIds.length ? { memberIds } : {}),
      ...(legacyUserIds.length ? { legacyUserIds } : {}),
      ...(unattributed === 'true' ? { unattributedOnly: true } : {}),
    },
  }
}

function describeAbs(from: number | undefined, to: number | undefined): string {
  const fmt = (ms: number): string => {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return `${from !== undefined ? fmt(from) : '最早'} ~ ${to !== undefined ? fmt(to) : '现在'}`
}

/**
 * 逗号分隔的列表参数。
 *
 * 空串过滤掉而不是当成「筛空值」：`?provider=` 这种请求是前端拼参数时
 * 留下的噪声，按「不筛」处理才符合直觉。
 */
function splitList(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 解析整数查询参数。
 *
 * 缺省 → `undefined`（用默认值）；非法 → `'invalid'`，**由调用方回 400**。
 *
 * ⚠️ 刻意不把非法值静默当成「没给」：`?from=abc` 若被忽略，
 *   页面会显示一个「看起来筛过了」的全量数字 —— 与未知 period
 *   静默兜底成全部时间是同一类陷阱。
 */
function intParam(params: URLSearchParams, name: string): number | undefined | 'invalid' {
  const raw = params.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) ? n : 'invalid'
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
