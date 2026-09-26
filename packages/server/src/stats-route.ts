/**
 * 部门看板查询路由 —— `GET /api/v1/stats/*`（ARCHITECTURE.md §5.3 的 S7）。
 *
 * ## 端点
 *
 * | 路径 | 用途 |
 * |---|---|
 * | `/api/v1/stats/overview` | 部门总览卡片（含**未归属占比**） |
 * | `/api/v1/stats/series?bucket=day\|hour` | 部门趋势 |
 * | `/api/v1/stats/breakdown?by=user\|model\|provider\|project\|…` | ★ **人员排行** |
 * | `/api/v1/stats/records?limit&offset` | 明细（分页） |
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
 * ## 口径
 *
 * 本文件**不出现任何公式**：`cacheHitRate` / `avgTokensPerCall` /
 * `unattributedRate` 全部调用 `shared/metrics.ts`。四项 token 由
 * `core/db` 的原始列求和取出后原样透传（铁律 3：绝不在传输层合并）。
 */

import {
  openPortalStats,
  resolvePortalTarget,
  type PortalRecordRow,
  type PortalStatsSession,
  type PortalTarget,
  type QueryFilter,
} from '@ai-token-report/core/db'
import { derive, resolveRange } from '@ai-token-report/core'
import {
  cacheHitRate,
  computeTotal,
  unattributedRate,
  UNATTRIBUTED_USER,
  type BreakdownResponse,
  type Bucket,
  type DiagnosticsResponse,
  type GroupBy,
  type OverviewResponse,
  type RecordRow,
  type RecordsResponse,
  type SeriesResponse,
} from '@ai-token-report/shared'

import type { CredentialStore } from './credentials.js'
import { authorize } from './http/auth.js'
import { VIEWER_AUTH_MESSAGES } from './verify-route.js'

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
  'user',
  'project',
  'day',
  'hour',
] as const

/** 明细分页上限。给足但不放任：单页 2000 行已远超任何人会看的量。 */
const MAX_RECORDS_LIMIT = 2000
const DEFAULT_RECORDS_LIMIT = 100

/** 路由处理结果：状态码 + 响应体。`index.ts` 的 `fromRoute()` 直接吃这个形状。 */
export interface StatsRouteResult {
  status: number
  body: unknown
}

export interface StatsRouteOptions {
  credentials: CredentialStore
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
  readonly #credentials: CredentialStore
  readonly #target: PortalTarget

  constructor(options: StatsRouteOptions) {
    this.#credentials = options.credentials
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
    authorization: string | null,
  ): Promise<StatsRouteResult> {
    // ── 1. 身份（★ 与上报共用同一套可信边界）───────────────────────
    // 401/503 的判定在 `http/auth.ts` 的 `authorize()` 里（全仓唯一一处）。
    const auth = authorize(this.#credentials, authorization, VIEWER_AUTH_MESSAGES)
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, reason: auth.reason } }
    }

    if (!KNOWN_SUBS.includes(sub)) {
      return { status: 404, body: { ok: false, reason: `未找到 /api/v1/stats/${sub}` } }
    }

    // ── 2. 参数（时间窗在服务端解析，前端不做日期换算）──────────────
    const window = parseWindow(params)
    if ('error' in window) return { status: 400, body: { ok: false, reason: window.error } }

    const filter = window.filter

    // ★ `openPortalStats()` 内部就是 `await openPortalStore(target)`：
    //   它决定了连 SQLite 还是 MySQL，本文件**看不到**这个差别。
    // 🚨 `session.close()` 就是 `store.close()`（MySQL 空操作 / SQLite 真关），
    //   所以 finally 里的形状与 `ingest-route.ts` 完全一致。
    let session: PortalStatsSession
    try {
      session = await openPortalStats(this.#target, filter)
    } catch (err) {
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
        default:
          return { status: 404, body: { ok: false, reason: `未找到 /api/v1/stats/${sub}` } }
      }
    } catch (err) {
      return { status: 500, body: { ok: false, reason: `查询失败: ${msg(err)}` } }
    } finally {
      await session.close()
    }
  }

  /** `GET /api/v1/stats/series?bucket=day|hour` */
  async #series(session: PortalStatsSession, params: URLSearchParams): Promise<StatsRouteResult> {
    const raw = params.get('bucket') ?? 'day'
    if (raw !== 'day' && raw !== 'hour') {
      // 不许静默兜底成 day：那样「按小时看」的页面会拿着天级数据画图，
      // 而图上没有任何迹象说明它换了粒度。
      return { status: 400, body: { ok: false, reason: `bucket 只支持 day 或 hour，收到 "${raw}"` } }
    }
    const bucket: Bucket = raw

    const points = (await session.series(bucket, true)).map((p) => ({
      bucket: p.bucket,
      totalTokens: p.counts.total,
      inputTokens: p.counts.input,
      outputTokens: p.counts.output,
      cacheReadTokens: p.counts.cacheRead,
      calls: p.counts.calls,
      cacheHitRate: cacheHitRate({ input: p.counts.input, cacheRead: p.counts.cacheRead }),
    }))

    const body: SeriesResponse = { bucket, points }
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

    const rows = (await session.groups(by)).map((row) => ({
      key: row.key,
      totalTokens: row.counts.total,
      inputTokens: row.counts.input,
      outputTokens: row.counts.output,
      cacheReadTokens: row.counts.cacheRead,
      cacheWriteTokens: row.counts.cacheWrite,
      calls: row.counts.calls,
      cacheHitRate: cacheHitRate({ input: row.counts.input, cacheRead: row.counts.cacheRead }),
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
}

/** 已实现的子路径。写成常量而不是散落的 if，便于一处看清「有哪些接口」。 */
const KNOWN_SUBS: readonly string[] = [
  'overview',
  'series',
  'breakdown',
  'records',
  'diagnostics',
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
  const total = await session.totals()
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
    sessions: await session.sessions(),
    cacheHitRate: cacheHitRate({ input: total.input, cacheRead: total.cacheRead }),
    avgTokensPerCall: metrics.avgTokensPerCall,
    unattributedRate: unattributedRate(await session.unattributedCalls(), total.calls),
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
 */
async function buildDiagnostics(session: PortalStatsSession): Promise<DiagnosticsResponse> {
  const bounds = await session.timeBounds()
  const total = await session.totals()
  const unattributed = await session.unattributedCalls()

  return {
    totalEvents: total.calls,
    unattributedEvents: unattributed,
    unattributedRate: unattributedRate(unattributed, total.calls),
    identityViolations: 0,
    distinctUsers: await session.distinctUsers(),
    earliestTs: bounds.earliest,
    latestTs: bounds.latest,
    lastIngestAt: await session.lastIngestAt(),
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
    provider: row.provider,
    model: row.model,
    // 口径只经 shared 计算；四项原始用量完整透传。
    totalTokens: computeTotal({ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, reasoning: 0 }),
    inputTokens: row.input,
    outputTokens: row.output,
    cacheReadTokens: row.cacheRead,
    cacheWriteTokens: row.cacheWrite,
    cwd: row.cwd,
  }
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
  const providers = splitList(params.get('provider'))
  const models = splitList(params.get('model'))

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
      ...(users.length > 0 ? { userIds: users } : {}),
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