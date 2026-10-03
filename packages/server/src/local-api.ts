/**
 * 本地直查路由 —— 本地页（`ai-token --web`）的数据源。
 *
 * ## 数据源：本地 SQLite 增量库（`core/db`）
 *
 * 早期版本每次请求都**直扫日志**。实测（196 文件 / 80.8 MB）单次冷扫描
 * **15.7 秒**，其中 zstd 解压占 76.9%、JSON 解析占 19.5%，磁盘 IO 只占 3.7%
 * —— 瓶颈是「把历史反复解压解析」，不是读文件。
 *
 * 现在改为「先增量 ingest、再查库」：
 *
 * | 场景 | 直扫日志 | 本地库 |
 * |---|---|---|
 * | today 总计 | ~15,700 ms | **0.26 ms** |
 * | today 分组 | ~15,700 ms | **9 ms** |
 * | 全量分组 | ~15,700 ms | **20 ms** |
 * | 热态 ingest（L1 全跳过） | — | **~10 ms** |
 *
 * ## 新鲜度：ingest 前置
 *
 * 每次取数前先跑一次增量 `ingest()`。热态下 L1 水位线让所有文件零解压跳过
 * （只需 196 次 `stat`，实测 ~9 ms），因此「库比日志旧」的窗口被压到
 * 一次请求之内 —— 直扫路径最被称道的「天然最新」得以保留。
 *
 * ## 降级：库不可用时回退直扫；**库被占用时只读旧数据**
 *
 * 库是日志的派生物，不是真值（磁盘满、权限变更、`SQLITE_CORRUPT` 都可能发生）。
 * `openStats()` 内部在**库真的不可用**时自动回退直扫并带上 `degradedReason`，
 * 所以本层的 `try/catch` 只是最后一道兜底 —— 绝不把异常抛给浏览器。
 *
 * ⚠️ 但 `database is locked`（别的写入者正在写）**刻意不降级**：库仍然可读，
 *   而一次直扫是 20~30 秒。那种情况下本次读的是上一次入库的结果，
 *   `degradedReason` 会说明这一点，页面把它显示在「数据来源」旁边。
 *   详见 `core/db/stats.ts` 的 `openStats`。
 *
 * ## 口径同源
 *
 * 所有指标都调用 `core` 的 `derive()` 与共享的 `cacheHitRate()`，
 * **本文件不出现任何公式**。时间窗解析直接用 `core/range.ts` 的
 * `resolveRange()` —— 与 CLI 的 `--period` 是同一个函数，
 * 所以「页面上看到的数」与「命令行看到的数」必然相等。
 * SQL 层同样只做原始列求和（见 `core/db/query.ts` 的约束说明）。
 */

import {
  derive,
  resolveRange,
  type GroupDimension,
  type SessionsRootInput,
} from '@ai-token-report/core'
import { openStats, type StatsSession } from '@ai-token-report/core/db'
import type { SourceRoot } from '@ai-token-report/core'
// ★ 费用聚合与离线单价快照：本地路径的价只能来自 `pricing.json`（或内置种子价），
//   因为员工机器上没有 `model_price` 表，而且必须断网可用。
//   折叠与格式化全部复用这些函数，本文件**不写任何金额算术**。
import {
  costByGroupOf,
  costTotalsOf,
  emptyCostTotals,
  loadLocalPricing,
  priceResolver,
  type CostTotals,
  type LocalPricing,
} from '@ai-token-report/core/db'
import { cacheHitRate, cacheLeverage } from '@ai-token-report/shared'
import type {
  LocalBreakdownResponse,
  LocalDiagnosticsResponse,
  LocalGroupBy,
  LocalOverviewResponse,
  LocalRefreshResponse,
  LocalSeriesResponse,
  LocalStatsSources,
} from '@ai-token-report/shared'

/** 本地页可用的分组维度。`user` 不在其中 —— 本机数据只有我一个人。 */
const LOCAL_DIMS: readonly LocalGroupBy[] = [
  'provider',
  'model',
  'provider-model',
  'project',
  'day',
  'hour',
] as const

/**
 * 本文件用的维度全部是 `core` 的 `GroupDimension` 子集。
 * 这个断言式转换让类型系统确认「没有引入 core 不认识的维度」。
 */
function toCoreDim(dim: LocalGroupBy): GroupDimension {
  return dim as GroupDimension
}

/** 路由处理结果：状态码 + 响应体。 */
export interface RouteResult {
  status: number
  body: unknown
}

/**
 * 统计会话提供者 —— 把「如何拿到数据」与「如何渲染响应」解耦。
 *
 * 之所以抽象成一个接口而不是直接调 `openStats()`：测试需要注入
 * 固定的快照（不依赖真实文件系统），而生产用真实的库/日志。
 * 默认实现就是 `CoreStatsProvider`。
 */
export interface StatsProvider {
  /**
   * 打开一个统计会话。
   *
   * @param opts 时间窗与过滤条件（`period` 由本层解析成绝对时间后传入）
   */
  open(opts: {
    period?: string
    providers: string[]
    models: string[]
  }): Promise<StatsSession>
}

/**
 * 默认提供者：走 `core/db` 的 `openStats()`（SQL 优先，失败降级直扫）。
 */
export class CoreStatsProvider implements StatsProvider {
  /**
   * ★ **一组**会话日志根（同一台机器上并存多套 DSH）。
   *
   * 与 CLI 的 `--dsh-home`（可重复）走的是**同一个** `openStats()`，
   * 所以页面的数、命令行的数、`--no-db` 直扫的数三者必然一致。
   */
  readonly #sessionsRoot: SessionsRootInput
  readonly #dbPath: string

  constructor(
    sessionsRoot: SessionsRootInput,
    dbPath: string,
    /**
     * 带来源的根（多客户端）。缺省 = 只按 `sessionsRoot`（老调用方 / 测试）。
     * `missing` 也要传进来：它只含**存在**的根，缺失的那部分不在 `roots` 里，
     * 不报出来就会变成「加了 --codex-home 页面没变化」而查不出原因。
     */
    sourceRoots?: { roots: readonly SourceRoot[]; missing: readonly SourceRoot[] },
  ) {
    this.#sessionsRoot = sessionsRoot
    this.#dbPath = dbPath
    this.#sourceRoots = sourceRoots
  }

  readonly #sourceRoots?: { roots: readonly SourceRoot[]; missing: readonly SourceRoot[] }

  async open(opts: {
    period?: string
    providers: string[]
    models: string[]
  }): Promise<StatsSession> {
    return openStats({
      sessionsRoot: this.#sessionsRoot,
      dbPath: this.#dbPath,
      ...(this.#sourceRoots !== undefined && this.#sourceRoots.roots.length > 0
        ? {
          sourceRoots: this.#sourceRoots.roots,
          ...(this.#sourceRoots.missing.length > 0
            ? { missingRoots: this.#sourceRoots.missing.map((root) => root.path) }
            : {}),
        }
        : {}),
      ...(opts.period ? { period: opts.period } : {}),
      providers: opts.providers,
      models: opts.models,
    })
  }
}

/**
 * 本地统计路由。所有方法都是纯函数式的
 * 「解析参数 → 打开会话 → 查询 → 组装响应」，不持有请求状态。
 *
 * ⚠️ 每个请求都**独立开关**一个 `StatsSession`（内部复用连接池式的
 *   进程内 DB 连接无必要：打开一个 SQLite 连接实测是亚毫秒级）。
 *   这消除了早期版本里 `StatsCache` 那套「in-flight 合并 + mtime 失效」
 *   的复杂度 —— 那套机制是为「15 秒的扫描」而生的，现在一次查询 20ms，
 *   为它维护一致性反而成了风险源（见 `local-api.test.ts` 里那条
 *   `await null` 的 ECONNRESET 回归测试）。
 */
export class LocalStatsRouter {
  readonly #provider: StatsProvider
  /**
   * token-report 自己的**数据目录**（身份 / 本地库 / outbox / 补报水位）。
   *
   * 只用于**展示来源**（页面上的「数据目录」那一行）与**离线单价快照**
   * （`pricing.json`：它是配置，必须和身份 / 本地库放在一起，不跟着会话日志根走），
   * 不参与「用量从哪来」—— 取数只认 provider 手里的会话日志根与本地库路径。
   * `null` = 调用方没给（测试注入常见）：此时计价退回内置种子价，并在响应里说明。
   */
  readonly #dataDir: string | null
  /** 上次强制失效的时刻（`refresh` 用；现在只是给页面一个回执）。 */
  #lastInvalidatedAt: number | null = null

  constructor(provider: StatsProvider, options: { dataDir?: string | null } = {}) {
    this.#provider = provider
    this.#dataDir = options.dataDir ?? null
  }

  /**
   * 本次请求的计价上下文：**价 + 逐条事件的取价函数 + 全量记录**。
   *
   * ## ★ 为什么这里的价来自数据目录，而 `#dataDir` 的注释说它「不参与取数」
   *
   * `pricing.json` 是**配置**，它必须和身份 / 本地库放在一起（数据目录），
   * 而不是跟着会话日志根走 —— 换个 home 不该换掉计价口径。
   * 所以本文件是数据目录的**第二个**用途（第一个是页面上那行「数据目录」）。
   * 除此之外它仍然不参与「用量从哪来」。
   *
   * ## ★ 为什么逐条事件取价，而不是按分组汇总后再乘
   *
   * 单价带生效区间，**换价那一刻**两侧的事件适用不同的价。按「分组 token 总量 ×
   * 一个价」算，会把换价前后的用量全按其中一个价算 —— 而它看起来完全正常。
   * 代价是每次请求物化全量记录：**本机实测 2.37 万条记录 56ms**（分组查询 31ms），
   * 也就是热态请求从 ~50ms 变成 ~110ms。这是**刻意付的代价**：
   * 唯一能省掉它的办法是「按 (provider, model) 汇总后再乘一个价」，
   * 而那正是上面这条错误。单机量级下 110ms 仍然是「点一下就出来」。
   */
  #costContext(session: StatsSession): {
    pricing: LocalPricing
    totals: CostTotals
    byGroup: (dim: GroupDimension) => Map<string, CostTotals>
  } {
    const pricing = loadLocalPricing({ dataDir: this.#dataDir })
    const resolve = priceResolver(pricing.prices)
    const records = session.records()
    return {
      pricing,
      totals: costTotalsOf(records, resolve, pricing.provenance),
      byGroup: (dim) => costByGroupOf(records, dim, resolve, pricing.provenance),
    }
  }

  /**
   * ★ 组装「数据来源」。
   *
   * 两组根都来自 `StatsSession`（`core/db/stats.ts`）—— 它同时拿着**存在的**
   * 与**缺失的**两组，所以这里不做任何判断，只搬运。
   * 注入式 `StatsProvider`（测试）可能不提供这两个字段，缺省成空数组而不是崩。
   */
  #sources(session: StatsSession): LocalStatsSources {
    // ★ 按来源分组（多客户端）：扁平的那组根答不出「这些数字是谁的」。
    //   未提供 `sourceRoots` 的会话（老注入式 provider）**不带** `bySource`
    //   —— 消费方缺字段时退化成旧文案，而不是显示一个空的来源列表。
    const typed = session.sourceRoots ?? []
    const bySource = typed.length === 0
      ? undefined
      : [...new Set(typed.map((root) => root.source))].sort().map((source) => ({
        source,
        // ⚠️ **次要副本也要列**（活动 + 归档）：滤掉它们会让这里的根数与扁平的
        //   `sessionsRoots` 对不上（一个说 2、另一个说 3），页面上两行自相矛盾。
        //   「哪些是次要副本」由 `sourceRoots[].secondary` 表达，不靠这里省略。
        roots: typed.filter((root) => root.source === source).map((root) => root.path),
        missingRoots: session.missingRoots.filter((path) =>
          typed.some((root) => root.source === source && root.path === path)),
      }))
    return {
      // readonly → 可变数组：跨进程契约里必须是普通数组（两侧都能改，不共享引用）
      sessionsRoots: [...(session.sessionsRoots ?? [])],
      missingRoots: [...(session.missingRoots ?? [])],
      dataDir: this.#dataDir,
      ...(bySource !== undefined ? { bySource } : {}),
    }
  }

  /** `GET /api/local/stats/overview` */
  async overview(params: URLSearchParams): Promise<RouteResult> {
    const parsed = parseQuery(params)
    if ('error' in parsed) return badRequest(parsed.error)

    const { session, error } = await this.#open(parsed)
    if (error) return error

    try {
      const total = session.totals()
      // ★ 口径来自 core 的 derive()，本文件不写公式
      const metrics = derive(total)

      const body: LocalOverviewResponse = {
        range: { from: parsed.sinceMs ?? null, to: parsed.untilMs ?? null, label: parsed.label },
        // ★ 「这个数是从哪几处日志算出来的」—— 多套 DSH 并存时是并集，不给出处就分不清
        //   「镜像去重」与「那个根根本没读到」
        sources: this.#sources(session),
        totalTokens: total.total,
        inputTokens: total.input,
        outputTokens: total.output,
        cacheReadTokens: total.cacheRead,
        cacheWriteTokens: total.cacheWrite,
        reasoningTokens: total.reasoning,
        calls: total.calls,
        // 会话数按过滤后的记录去重，而不是用扫描到的文件数 ——
        // 后者包含了「有文件但这段时间没调用」的会话，会让卡片虚高。
        sessions: session.sessions,
        cacheHitRate: cacheHitRate({ input: total.input, cacheRead: total.cacheRead }),
        cacheLeverage: cacheLeverage({ input: total.input, cacheRead: total.cacheRead }),
        avgTokensPerCall: metrics.avgTokensPerCall,
        scannedAt: session.scannedAt,
        // 早期这个字段表示「是否命中进程内日志缓存」。现在数据来自库，
        // 每次请求都会先做增量 ingest 保证新鲜，因此恒为 false ——
        // 保留字段是为了不改动前端契约（页面靠它显示"刚刚更新"）。
        cached: false,
        // ★ 降级说明（库被占用时读了旧数据 / 库坏了改直扫）。
        //   不发这个字段的话，「这一轮没刷成」与「日志里就是这些」在页面上完全一样；
        //   三个接口共用同一次刷新（`openStats` 的单飞），所以只在 overview 上带就够 ——
        //   页面把这一行显示在「数据来源」旁边。
        ...(session.degradedReason !== undefined ? { degradedReason: session.degradedReason } : {}),
        // ★ 金额总在下发（本地页没有权限模型，它只读本机数据），
        //   但「按哪份单价算的」跟着一起来 —— 离线端读快照、看板读库，
        //   两者会给出不同的金额，而都「看起来正常」。
        cost: this.#costContext(session).totals,
      }

      return { status: 200, body }
    } finally {
      session.close()
    }
  }

  /** `GET /api/local/stats/series?bucket=day|hour` */
  async series(params: URLSearchParams): Promise<RouteResult> {
    const parsed = parseQuery(params)
    if ('error' in parsed) return badRequest(parsed.error)

    const bucket = params.get('bucket') ?? 'day'
    if (bucket !== 'day' && bucket !== 'hour') {
      return badRequest(`bucket 只支持 day 或 hour，收到 "${bucket}"`)
    }

    const { session, error } = await this.#open(parsed)
    if (error) return error

    try {
      // 补零让趋势连续；core 的 series() 内部复用 timeSeries 的补零逻辑，
      // 因此 SQL 路径与直扫路径的桶集合必然一致。
      const cost = this.#costContext(session)
      const costByBucket = cost.byGroup(bucket)
      const points = session.series(bucket, true).map((p) => ({
        bucket: p.bucket,
        totalTokens: p.counts.total,
        inputTokens: p.counts.input,
        outputTokens: p.counts.output,
        cacheReadTokens: p.counts.cacheRead,
        cacheWriteTokens: p.counts.cacheWrite,
        calls: p.counts.calls,
        cacheHitRate: cacheHitRate({ input: p.counts.input, cacheRead: p.counts.cacheRead }),
        // ⚠️ 键与 `session.series()` 的桶**逐字相同**（两边都用 `toDayKey()` /
        //   `toHourKey()`），所以这里必然对得上；补零出来的桶没有事件，
        //   给一份 `costs: []` 的空金额（不是 0 元的一条记录）。
        cost: costByBucket.get(p.bucket) ?? emptyCostTotals(cost.pricing.provenance),
      }))

      const body: LocalSeriesResponse = {
        bucket,
        points,
        cached: false,
        scannedAt: session.scannedAt,
      }
      return { status: 200, body }
    } finally {
      session.close()
    }
  }

  /** `GET /api/local/stats/breakdown?by=provider|model|...` */
  async breakdown(params: URLSearchParams): Promise<RouteResult> {
    const parsed = parseQuery(params)
    if ('error' in parsed) return badRequest(parsed.error)

    const by = (params.get('by') ?? 'provider-model') as LocalGroupBy
    if (!LOCAL_DIMS.includes(by)) {
      return badRequest(`未知维度 "${by}"。可选: ${LOCAL_DIMS.join(' | ')}`)
    }

    const { session, error } = await this.#open(parsed)
    if (error) return error

    try {
      const cost = this.#costContext(session)
      const costByKey = cost.byGroup(toCoreDim(by))
      const rows = session.groups(toCoreDim(by)).map((row) => ({
        key: row.key,
        totalTokens: row.counts.total,
        inputTokens: row.counts.input,
        outputTokens: row.counts.output,
        cacheReadTokens: row.counts.cacheRead,
        cacheWriteTokens: row.counts.cacheWrite,
        calls: row.counts.calls,
        cacheHitRate: cacheHitRate({ input: row.counts.input, cacheRead: row.counts.cacheRead }),
        // 键复用 `groupKey()`，与排行里那一行逐字相同（金额与用量必然对得上）。
        cost: costByKey.get(row.key) ?? emptyCostTotals(cost.pricing.provenance),
      }))

      const body: LocalBreakdownResponse = {
        by,
        rows,
        cached: false,
        scannedAt: session.scannedAt,
      }
      return { status: 200, body }
    } finally {
      session.close()
    }
  }

  /**
   * `GET /api/local/stats/diagnostics`
   *
   * ★ **解析诊断从库里读回**（`ingest_run` 表），而不是只看本轮扫描。
   *   热态请求下所有文件都被 L1 水位线跳过（零解压），本轮诊断必然全为 0；
   *   若直接用它，页面上的「事件类型分布」「恒等式校验失败数」会永久空白 ——
   *   而这些恰恰是判断「采集是否健康」的关键信号。
   */
  async diagnostics(params: URLSearchParams): Promise<RouteResult> {
    const parsed = parseQuery(params)
    if ('error' in parsed) return badRequest(parsed.error)

    const { session, error } = await this.#open(parsed)
    if (error) return error

    try {
      // 优先用库中持久化的诊断（sql 路径），否则用本轮的扫描诊断
      const persisted = session.scanDiagnostics()
      const d = session.diagnostics

      const body: LocalDiagnosticsResponse = {
        filesScanned: persisted?.filesScanned ?? d?.filesScanned ?? 0,
        filesFailed: persisted?.filesFailed ?? d?.filesFailed ?? 0,
        framesOk: persisted?.framesOk ?? d?.framesOk ?? 0,
        framesFailed: persisted?.framesFailed ?? d?.framesFailed ?? 0,
        totalEvents: persisted?.totalEvents ?? d?.totalEvents ?? 0,
        usageEvents: persisted?.usageEvents ?? d?.usageEvents ?? 0,
        assistantMessagesWithoutUsage:
          persisted?.assistantMessagesWithoutUsage ?? d?.assistantMessagesWithoutUsage ?? 0,
        totalTokenMismatches: persisted?.totalTokenMismatches ?? d?.totalTokenMismatches ?? 0,
        retryStarted: persisted?.retryStarted ?? d?.retryStarted ?? 0,
        retry: persisted?.retry ?? d?.retry ?? 0,
        attempts: persisted?.attempts ?? d?.attempts ?? 0,
        missingProvider: persisted?.missingProvider ?? d?.missingProvider ?? 0,
        // ★ Map/Set 必须显式转换：JSON.stringify(new Map()) 得到的是 "{}"
        eventTypes: persisted
          ? Object.fromEntries(Object.entries(persisted.eventTypes).sort((a, b) => b[1] - a[1]))
          : d
            ? Object.fromEntries([...d.eventTypes].sort((a, b) => b[1] - a[1]))
            : {},
        providersSeen: persisted?.providersSeen ?? (d ? [...d.providersSeen].sort() : []),
        // 与 overview 同一组根：诊断页对照「数字来自哪几处」时不必再去别处找
        sources: this.#sources(session),
        scannedAt: session.scannedAt,
        cached: false,
      }

      return { status: 200, body }
    } finally {
      session.close()
    }
  }

  /**
   * `POST /api/local/refresh`
   *
   * 早期用于「强制失效日志扫描缓存」。现在每次请求本来就会先做增量
   * ingest，缓存已不存在，因此这里只返回回执，让页面按钮仍然可用。
   */
  refresh(): RouteResult {
    const invalidatedAt = this.#lastInvalidatedAt
    this.#lastInvalidatedAt = Date.now()
    const body: LocalRefreshResponse = { ok: true, invalidatedAt }
    return { status: 200, body }
  }

  /** 打开统计会话，把异常转成 500 响应（绝不把异常抛给浏览器）。 */
  async #open(parsed: ParsedQuery): Promise<{ session: StatsSession; error?: RouteResult }> {
    try {
      const session = await this.#provider.open({
        ...(parsed.period ? { period: parsed.period } : {}),
        providers: parsed.providers,
        models: parsed.models,
      })
      return { session }
    } catch (err) {
      // 走到这里说明连降级直扫都失败了（如会话目录不可读）。
      // 返回结构化错误而不是让连接挂断 —— 前端能展示有意义的信息。
      return {
        session: null as unknown as StatsSession,
        error: {
          status: 500,
          body: { ok: false, reason: `取数失败: ${err instanceof Error ? err.message : String(err)}` },
        },
      }
    }
  }
}

// ── 参数解析与过滤 ──────────────────────────────────────────────────────────

interface ParsedQuery {
  /** 具名周期（原样传给 core，由它解析成绝对时间）。 */
  period?: string
  sinceMs?: number
  untilMs?: number
  label: string
  providers: string[]
  models: string[]
}

/**
 * 解析查询参数。
 *
 * 时间窗**直接复用 `core/range.ts`** —— 与 CLI 的 `--period` 是同一个函数。
 * 这是「页面数字 == 命令行数字」的机制保证，而不是靠两边小心地写一样的代码。
 */
function parseQuery(params: URLSearchParams): ParsedQuery | { error: string } {
  const period = params.get('period') ?? undefined

  let range
  try {
    range = resolveRange(period ? { period } : {})
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  return {
    ...(period ? { period } : {}),
    ...(range.sinceMs !== undefined ? { sinceMs: range.sinceMs } : {}),
    ...(range.untilMs !== undefined ? { untilMs: range.untilMs } : {}),
    label: range.label,
    providers: splitList(params.get('provider')),
    models: splitList(params.get('model')),
  }
}

function splitList(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function badRequest(reason: string): RouteResult {
  return { status: 400, body: { ok: false, reason } }
}