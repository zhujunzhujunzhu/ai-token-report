/**
 * 本地直查路由 —— 本地页（`dsh-token --web`）的数据源。
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
 * ## 降级：库不可用时回退直扫
 *
 * 库是日志的派生物，不是真值（磁盘满、权限变更、`SQLITE_CORRUPT`、
 * 多进程 `SQLITE_BUSY` 都可能发生）。`openStats()` 内部会在任何失败时
 * 自动回退直扫并带上 `degradedReason`，所以本层的 `try/catch` 只是
 * 最后一道兜底 —— 绝不把异常抛给浏览器。
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
} from '@ai-token-report/core'
import { openStats, type StatsSession } from '@ai-token-report/core/db'
import { cacheHitRate, cacheLeverage } from '@ai-token-report/shared'
import type {
  LocalBreakdownResponse,
  LocalDiagnosticsResponse,
  LocalGroupBy,
  LocalOverviewResponse,
  LocalRefreshResponse,
  LocalSeriesResponse,
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
  readonly #sessionsRoot: string
  readonly #dbPath: string

  constructor(sessionsRoot: string, dbPath: string) {
    this.#sessionsRoot = sessionsRoot
    this.#dbPath = dbPath
  }

  async open(opts: {
    period?: string
    providers: string[]
    models: string[]
  }): Promise<StatsSession> {
    return openStats({
      sessionsRoot: this.#sessionsRoot,
      dbPath: this.#dbPath,
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
  /** 上次强制失效的时刻（`refresh` 用；现在只是给页面一个回执）。 */
  #lastInvalidatedAt: number | null = null

  constructor(provider: StatsProvider) {
    this.#provider = provider
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
      const points = session.series(bucket, true).map((p) => ({
        bucket: p.bucket,
        totalTokens: p.counts.total,
        inputTokens: p.counts.input,
        outputTokens: p.counts.output,
        cacheReadTokens: p.counts.cacheRead,
        cacheWriteTokens: p.counts.cacheWrite,
        calls: p.counts.calls,
        cacheHitRate: cacheHitRate({ input: p.counts.input, cacheRead: p.counts.cacheRead }),
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
      const rows = session.groups(toCoreDim(by)).map((row) => ({
        key: row.key,
        totalTokens: row.counts.total,
        inputTokens: row.counts.input,
        outputTokens: row.counts.output,
        cacheReadTokens: row.counts.cacheRead,
        cacheWriteTokens: row.counts.cacheWrite,
        calls: row.counts.calls,
        cacheHitRate: cacheHitRate({ input: row.counts.input, cacheRead: row.counts.cacheRead }),
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