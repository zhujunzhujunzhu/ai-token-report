/**
 * UI 数据通道（宿主半）—— 把本机用量喂给插件的浏览器半。
 *
 * ## 数据怎么走到页面里
 *
 * ```
 * 浏览器半  fetch('/api/tokenReport.stats?period=today')
 *                  ↓   （同源，自带宿主签发的浏览器会话 cookie）
 * DSH /api 前缀路由 —— 先过 Host/Origin 栅栏 + 浏览器鉴权，再分发
 *                  ↓
 * 本文件的精确 Fetch 路由（ctx.connection.fetch.register）
 *                  ↓
 * queryUsage()  ← 与 CLI / token_usage 工具**同一个函数**
 * ```
 *
 * ## 为什么走 `ctx.connection.fetch` 而不是自己 `ctx.webServer.register`
 *
 * DSH 的 web 服务器**不做任何鉴权**（`dsh-host-webserver` 的文档明写
 * 「No server-wide TLS, authentication, or origin policy」）。而
 * `dsh-client-connection` 把整个 `/api` 前缀包了一层：
 * Host/Origin 栅栏 + 浏览器会话 cookie 校验，**分发之前**就拒绝未鉴权请求。
 *
 * 本仓的铁律是「服务端默认只监听 127.0.0.1」，但监听地址是**可配置的** ——
 * 一旦有人绑到 `0.0.0.0`，一条裸的用量路由就是**向整个内网公开本机用量**。
 * 挂在 `/api` 下等于免费拿到那两道栅栏，所以这不是「多绕一层」，
 * 而是「不要把已经有的锁拆掉」。
 *
 * ## 🚨 三条不能破的约束
 *
 * 1. **不新增口径**：只调 `queryUsage()`，四个 token 列原样透传，
 *    派生指标直接用 `result.metrics`（`shared/metrics.ts` 算的）。
 * 2. **降级不抛错**：扫描失败返回 `200 + { error }`，让面板就地显示原因。
 *    `packages/server` 的身份接口也是这个思路（见 `本仓工程约定.md` §6.4）。
 * 3. **不能拖垮 headless**：`connection` 只在 web profile 里有，
 *    拿不到就安静地不注册，绝不 `inject` 成硬依赖。
 */

import { queryUsage, type StatsContext, type UsageQuery, type UsageResult } from './stats.js'
import {
  UI_CONFIG_PATH,
  UI_DEFAULT_POSITION,
  UI_STATS_PATH,
  UI_SETTINGS_PATH,
  UI_SERIES_POINTS,
  coercePeriod,
  validDateRange,
  type UiConfigPayload,
  type UiDateRange,
  type UiErrorPayload,
  type UiGroupRow,
  type UiPayload,
  type UiPeriod,
  type UiPosition,
  type UiResponse,
  type UiRouteInstall,
  type UiSeriesPoint,
  type UiSource,
} from './client/protocol.js'

/** 多标签页共享短期缓存；SQL 降级直扫时仍合并并发，避免重复解压。 */
const DEFAULT_TTL_MS = 30_000

/**
 * 趋势粒度：看「今天」要看小时，「近 30 天」要看天。
 *
 * 给今天配日粒度只会得到一个点，趋势图会退化成一根柱子。
 */
export function seriesFor(period: UiPeriod): 'day' | 'hour' {
  return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
}

/**
 * `UsageResult` → 浏览器载荷。
 *
 * ★ 这是本文件唯一做「搬运」的地方，而搬运的原则是**只裁剪、不改写**：
 *   - 四个 token 列 + `reasoning` 原样抄，
 *   - `metrics` 整块照搬（**绝不在这里重算缓存命中率**），
 *   - 明细保留全部行供浏览器分页，序列点只做 `slice`，不动里面的数。
 *
 * 明细不能截断，否则浏览器翻页后无法看到后面的会话。
 */
export function toUiPayload(result: UsageResult, period: UiPeriod): UiPayload {
  const groups = result.groups.map((group) => ({
    by: group.by,
    rows: group.rows.map(
      (row): UiGroupRow => ({
        key: row.key,
        total: row.total,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        calls: row.calls,
        sessions: row.sessions,
        cacheHitRate: row.cacheHitRate,
      }),
    ),
  }))

  // 全年与自定义范围保留完整序列，不能被短周期的 31 点上限截断。
  const series = (period === 'custom' || period === 'year' ? result.series : result.series?.slice(-UI_SERIES_POINTS))?.map(
    (point): UiSeriesPoint => ({
      bucket: point.bucket,
      total: point.total,
      calls: point.calls,
      cacheHitRate: point.cacheHitRate,
    }),
  )

  return {
    period,
    rangeLabel: result.rangeLabel,
    source: result.source as UiSource,
    ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    totals: {
      total: result.totals.total,
      input: result.totals.input,
      output: result.totals.output,
      cacheRead: result.totals.cacheRead,
      cacheWrite: result.totals.cacheWrite,
      reasoning: result.totals.reasoning,
      calls: result.totals.calls,
    },
    metrics: {
      cacheHitRate: result.metrics.cacheHitRate,
      cacheLeverage: result.metrics.cacheLeverage,
      avgTokensPerCall: result.metrics.avgTokensPerCall,
    },
    groups,
    ...(series ? { series } : {}),
    sessions: result.sessions,
    elapsedMs: result.elapsedMs,
    scannedAt: result.scannedAt,
  }
}

/** 取数入口。抽成接口是为了让「缓存 / 合并并发」这层能被单测直接驱动。 */
export interface UiStatsProvider {
  /**
   * 取一个周期的用量。
   *
   * @param period - 已收窄的周期。
   * @param force - 绕过缓存（用户点了「刷新」）。仍然会与在途请求合并。
   */
  get(period: UiPeriod, force?: boolean, dateRange?: UiDateRange): Promise<UiResponse>
}

/**
 * 造一个带「TTL 缓存 + 在途合并」的取数器。
 *
 * 两件事各解决一个真实问题：
 * - **TTL 缓存**：面板轮询不该等于「每轮扫一遍日志」。
 * - **在途合并**：两个面板（输入框上方的条 + 标题栏的徽章）同时挂载时
 *   会各发一次请求，而扫描是 CPU 密集型 —— 合并后只扫一次。
 *
 * ⚠️ 失败也进缓存：反正是同一个周期的同一次失败，
 *   不缓存只会让坏掉的环境被反复重扫（那才是最坏的情况）。
 */
export function createUiStatsProvider(options: {
  /**
   * 实际的统计实现。
   *
   * ⚠️ 刻意做成参数而不是在这里直接调 `queryUsage()`：
   *   单测要能断言「TTL 命中时到底有没有真的查询」，
   *   而真查询会去扫真实会话日志 —— 那是十几秒的 IO。
   *   `installUiRoute()` 传进来的是 `queryUsage`，与 CLI / 工具**同一个函数**。
   */
  run: (query: UsageQuery) => Promise<UsageResult>
  /** 注入时钟，便于单测断言 TTL。 */
  now?: () => number
  ttlMs?: number
}): UiStatsProvider {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS

  const cache = new Map<string, { at: number; body: UiResponse }>()
  const inflight = new Map<string, Promise<UiResponse>>()

  const load = async (period: UiPeriod, dateRange?: UiDateRange): Promise<UiResponse> => {
    try {
      const result = await options.run({
        ...(period === 'custom' ? dateRange : { period }),
        by: ['provider-model', 'provider', 'project', 'session'],
        top: Number.MAX_SAFE_INTEGER,
        series: period === 'custom' && dateRange?.since === dateRange?.until ? 'hour' : seriesFor(period),
      })
      return toUiPayload(result, period)
    } catch (err) {
      // ★ 扫描失败不抛给浏览器：面板要能就地显示「为什么没数」
      const body: UiErrorPayload = {
        period,
        error: err instanceof Error ? err.message : String(err),
      }
      return body
    }
  }

  return {
    async get(period, force = false, dateRange) {
      if (period === 'custom' && !validDateRange(dateRange)) {
        return { period, error: '请选择有效的开始和结束日期，开始日期不能晚于结束日期' }
      }
      const key = period === 'custom' ? `${period}:${dateRange!.since}:${dateRange!.until}` : period
      const hit = cache.get(key)
      if (!force && hit !== undefined && now() - hit.at < ttlMs) return hit.body

      const running = inflight.get(key)
      if (running !== undefined) return running

      const task = load(period, dateRange)
        .then((body) => {
          if (cache.size >= 64) cache.delete(cache.keys().next().value!)
          cache.set(key, { at: now(), body })
          return body
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, task)
      return task
    },
  }
}

/** 响应统一带上 `no-store`：面板自己管缓存，中间层别插一脚。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 把「界面呈现配置」包成一条 Fetch 路由处理器。
 *
 * ★ 这是宿主半**唯一需要主动告诉**浏览器半的部署事实。DSH 的客户端插件条目
 *   拿不到插件的 `config`（`WebBootEntry` 里没有 config 字段，壳层组装条目时
 *   只传 `name`），所以 `config.ui.position` 到不了页面，只能走这条 HTTP。
 *
 * 它不查库、不读文件 —— 响应就是一个常量对象，因此**不会给面板启动加任何延迟**。
 * 把位置塞进 `/api/tokenReport.stats` 是行不通的：那个载荷首次返回要等冷建库
 * （可能十几秒），面板会先在错的位置出现、再跳一下。
 */
export function makeConfigFetch(position: UiPosition): (request: Request) => Promise<Response> {
  return async () => jsonResponse({ position } satisfies UiConfigPayload)
}

/**
 * 把取数器包成一个 Fetch 路由处理器。
 *
 * 查询参数：
 * - `period` —— 具名周期，不合法回落到默认值。
 * - `refresh=1` —— 绕过宿主缓存（面板上的「刷新」按钮）。
 */
export function makeStatsFetch(provider: UiStatsProvider): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    const period = coercePeriod(url.searchParams.get('period'))
    const force = url.searchParams.get('refresh') === '1'
    return jsonResponse(await provider.get(period, force, period === 'custom' ? {
      since: url.searchParams.get('since') ?? '', until: url.searchParams.get('until') ?? '',
    } : undefined))
  }
}

/**
 * 宿主半真正需要的那一小块 `connection` 能力。
 *
 * ⚠️ 刻意写成结构化的窄接口而不是 import `@deepseek-ai/dsh-client-connection`：
 *   那会把一个只在 web profile 里存在的包变成编译期依赖，
 *   而本插件还要能在 headless 里跑（那里没有 connection）。
 */
interface ConnectionFetchLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly ('GET' | 'HEAD' | 'POST')[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => void | Promise<void>
  }
}

/** 注册 UI 路由所需的最小宿主能力。 */
export interface UiHostContext {
  logger: { info(message: string): void; warn(message: string): void }
  effect(callback: () => (() => void) | void): void
  /** 可选：按名字取一个服务。headless 下 `connection` 不存在。 */
  get?(name: string): unknown
  /** 可选：等某个服务出现再回调（web 启动顺序里 connection 可能后到）。 */
  inject?(deps: string[], callback: (ctx: UiHostContext) => void): void
}

/**
 * 把用量路由挂到宿主的 `/api` 通道上。
 *
 * 三种结果如实返回，便于启动日志讲清楚「面板会不会有数」：
 * - `registered` —— 已挂上。
 * - `pending` —— 宿主还没有 `connection`，已挂「等它出现」。
 * - `unavailable` —— 宿主不提供（headless / 非 web profile），面板不会出现。
 *
 * ⚠️ **绝不把 `connection` 写进插件 `inject`**：`inject` 的语义是「等它就绪」，
 *   而 headless profile 永远不会提供它 —— 写进去等于**上报功能在 headless 下
 *   直接不激活**。这里用「先试一次，不行再等」的可选注入。
 */
export function installUiRoute(
  ctx: UiHostContext,
  stats: StatsContext,
  options: {
    ttlMs?: number
    settingsFetch?: (request: Request) => Promise<Response>
    /**
     * 面板落点，随 `/api/tokenReport.config` 交给浏览器半。
     *
     * 缺省用 `UI_DEFAULT_POSITION` —— 与浏览器半在取不到配置时的回退值**同一个常量**，
     * 两边不会各跑各的。
     */
    position?: UiPosition
  } = {},
): UiRouteInstall {
  const provider = createUiStatsProvider({
    // ★ 与 CLI `dsh-token` / `token_usage` 工具调用的是**同一个函数**，
    //   所以面板上的数与终端、与 Agent 报的数必然一致。
    run: (query) => queryUsage(stats, query),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  })
  const fetchStats = makeStatsFetch(provider)
  const position = options.position ?? UI_DEFAULT_POSITION
  const fetchConfig = makeConfigFetch(position)

  // 只会真正注册一次：ctx.inject 的回调在依赖出现时机上可能被调用多次，
  // 而 webServer/connection 的路由表对重复路径是**直接抛错**的。
  let registered = false

  const attach = (host: UiHostContext): boolean => {
    if (registered) return true
    const connection = host.get?.('connection') as ConnectionFetchLike | undefined
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return false

    host.effect(() => {
      const dispose = connection.fetch.register({
        path: UI_STATS_PATH,
        methods: ['GET'],
        // 只读的小 JSON：不需要流式，也吃不到 maxRequestBodyBytes 的上限
        requestBody: 'buffered',
        fetch: fetchStats,
      })
      // ★ 位置必须走这条独立路由：客户端插件条目拿不到插件 config（见文件头注释）
      const disposeConfig = connection.fetch.register({
        path: UI_CONFIG_PATH, methods: ['GET'], requestBody: 'buffered', fetch: fetchConfig,
      })
      const disposeSettings = options.settingsFetch ? connection.fetch.register({
        path: UI_SETTINGS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: options.settingsFetch,
      }) : undefined
      host.logger.info(
        `token-report: UI 用量面板数据通道已挂载 → GET ${UI_STATS_PATH}（面板位置：${position}）`,
      )
      return () => {
        void dispose()
        void disposeConfig()
        void disposeSettings?.()
      }
    })
    registered = true
    return true
  }

  if (attach(ctx)) return 'registered'
  if (typeof ctx.inject === 'function') {
    // web profile 里 connection 由 dsh-client-connection 提供，可能晚于本插件激活
    ctx.inject(['connection'], (injected) => {
      attach(injected)
    })
    return 'pending'
  }
  return 'unavailable'
}
