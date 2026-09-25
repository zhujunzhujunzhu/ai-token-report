/**
 * `@ai-token-report/server` —— 后端服务实现。
 *
 * ## 一个 server，两副面孔
 *
 * | 路径 | 使用者 | 数据源 | 鉴权 |
 * |---|---|---|---|
 * | `/api/local/identity` | 本地页面引导页 | 身份文件 | 无（仅 127.0.0.1） |
 * | `/api/local/stats/*` | 本地页面（`dsh-token --web`） | **本地 SQLite 增量库**（降级直扫日志） | 无（仅 127.0.0.1） |
 * | `/api/local/refresh` | 本地页面「刷新」按钮 | 触发下一次增量 ingest | 无（仅 127.0.0.1） |
 * | `/api/v1/identity/verify` | 本地服务代用户校验 | 凭证表 | Bearer |
 * | `/api/v1/token-usage` | 插件 & CLI 上报 | 写入 SQLite | Bearer |
 * | `/api/v1/stats/*` | 部门看板页面 | 读 SQLite | Bearer |
 *
 * ★ **`/api/local/*` 用的是「本地自己的库」**（`$DSH_HOME/token-report/usage.sqlite`），
 *   与部门服务端的库（`dbPath`）是两个不同的文件，不要混淆。
 *   本地库只装本机数据，因此仍然「断网可用、服务端挂掉不影响看自己的数据」。
 *
 * ## 端口占用
 *
 * 默认 8787，被占用时自动 +1 重试（最多 10 次）。这让「再开一个」
 * 不会因为端口冲突直接失败，也让多实例调试变得容易。
 *
 * ## ★ 运行时无关：Bun 与 Node 都能起
 *
 * 请求处理器（{@link createHandler}）**本来就写成 Web 标准的**
 * （入参 `Request`、返回 `Response`），所以 Bun 专有的只有最外面那层 server。
 * {@link tryListen} 按运行期二选一：
 *
 * | 运行时 | 实现 | 端口占用的表现 |
 * |---|---|---|
 * | Bun | `Bun.serve` | **同步抛错** |
 * | Node | `node:http`（`serve-node.ts` 桥接） | **异步 reject** |
 *
 * 两者的差异被 `tryListen` 收敛成同一个 async 形状，重试循环只有一份。
 * 🚨 静态资源一律用 `node:fs/promises` 读取，**不要用 `Bun.file()`** ——
 *   那是 Bun 专有的，会让 npm 发布出去、跑在 Node 上的 CLI 直接崩。
 */

import { resolvePaths } from '@ai-token-report/core'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { CredentialStore } from './credentials.js'
import { IdentityRoute } from './identity-route.js'
import { CoreStatsProvider, LocalStatsRouter } from './local-api.js'
import { serveWithNodeHttp, type ServeHandle } from './serve-node.js'
import { verifyToken } from './verify-route.js'

export const SERVER_VERSION = '0.1.0'

/** 默认端口。 */
export const DEFAULT_PORT = 8787
/** 端口被占用时的最大重试次数。 */
const MAX_PORT_ATTEMPTS = 10

/**
 * `Bun.serve` 的空闲超时（秒）。
 *
 * ⚠️ **必须显式设置，否则默认值是 10 秒**。
 *
 * 历史背景：早期本地页**直扫日志**，冷扫描要 10~13 秒（185 文件 / 61 MB），
 * 默认 10 秒会直接掐断连接 —— 客户端看到 `ECONNRESET`，
 * 而**服务端一条日志都没有**，表现为「本地页偶尔连不上」这种
 * 极难复现、极难定位的故障。
 *
 * 现在数据源换成了本地 SQLite 增量库，热态查询只要 20ms 左右，
 * 这个超时已经不再是正确性瓶颈。但**仍然必须设大**，因为还有两个
 * 真实的长请求场景：
 *
 * 1. **首次冷启动建库**：库不存在时要全量解析历史日志，实测约 15 秒
 * 2. **`--reset-db` 之后的第一请求**：同上
 *
 * 设为 120 秒：给冷建库留一个数量级的余量。扫描期间连接是活跃的
 * （请求尚未返回），所以真正被这个值兜住的是「客户端已断开但任务还在跑」，
 * 那种情况等久一点只是浪费一个协程，远好过误杀一个正常的长请求。
 */
const IDLE_TIMEOUT_SECONDS = 120

export interface ServerOptions {
  /** 监听端口。默认 8787；被占用时自动 +1。 */
  port?: number
  /**
   * 监听地址。
   *
   * ⚠️ 默认 `127.0.0.1` —— **只允许本机访问**。
   * 改成 `0.0.0.0` 前必须确保凭证已配置，否则等于把全员数据公开在内网。
   */
  host?: string
  /** DSH home，用于本地日志扫描与身份文件。 */
  dshHome?: string
  /** SQLite 文件路径。仅上报与部门统计需要。 */
  dbPath?: string
  /** 凭证文件路径。默认 `<dshHome>/token-report/credentials.json`。 */
  credentialsPath?: string
  /**
   * 部门服务端地址（本地模式用）。
   *
   * 配置后，本地引导页提交署名时会向它校验 token。
   */
  portalUrl?: string
  /** 静态资源目录（web 构建产物）。 */
  staticDir?: string
  /** 是否启用 `/api/local/*`。`--web` 时为 true。 */
  enableLocalApi?: boolean
  /** 注入用，便于测试。 */
  fetchImpl?: typeof fetch
}

export interface ServerHandle {
  /** 实际监听的地址（端口可能与请求的不同，若发生过 +1 重试） */
  url: string
  port: number
  host: string
  /** 是否因端口被占用而改用其他端口 */
  portShifted: boolean
  /** 优雅停机 */
  stop(): Promise<void>
}

/** 创建一个已启动的服务。 */
export async function createServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? DEFAULT_PORT

  const paths = resolvePaths(options.dshHome)
  const credentialsPath =
    options.credentialsPath ?? join(paths.dshHome, 'token-report', 'credentials.json')

  const { store: credentials, error: credError } = CredentialStore.load(credentialsPath)
  if (credError) {
    process.stderr.write(`⚠ 凭证文件加载失败：${credError}\n`)
  }

  const identityRoute = new IdentityRoute({
    dshHome: paths.dshHome,
    ...(options.portalUrl ? { portalUrl: options.portalUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  // 本地直查：只有启用 `/api/local/*` 时才构造，避免部门服务端
  // 白白持有一条指向本机日志/本地库的通路。
  // 数据源是本地 SQLite 增量库（`core/db`），库不可用时自动降级直扫日志。
  const localStats = options.enableLocalApi
    ? new LocalStatsRouter(new CoreStatsProvider(paths.sessionsRoot, paths.dbPath))
    : null

  const handler = createHandler({
    credentials,
    identityRoute,
    localStats,
    enableLocalApi: options.enableLocalApi ?? false,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  })

  const { handle, port, shifted } = await serveWithPortRetry(host, requestedPort, handler)

  return {
    url: `http://${host}:${port}`,
    port,
    host,
    portShifted: shifted,
    stop: () => handle.stop(),
  }
}

/** 是否跑在 Bun 上。决定用 `Bun.serve` 还是 `node:http`。 */
function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * 在指定端口起服务；端口被占用时抛出（由调用方重试）。
 *
 * ★ 两个运行时的差异**只收敛在这里**：Bun 的 `Bun.serve` 端口占用是
 *   **同步抛错**，而 `node:http` 是 **异步 reject**。把它包成 async 之后，
 *   上面的重试循环对两者就是同一套写法。
 */
async function tryListen(
  host: string,
  port: number,
  handler: (req: Request) => Response | Promise<Response>,
): Promise<ServeHandle> {
  if (isBunRuntime()) {
    const server = Bun.serve({
      hostname: host,
      port,
      fetch: handler,
      // 见 IDLE_TIMEOUT_SECONDS 的注释：不设这个值，冷扫描必被掐断
      idleTimeout: IDLE_TIMEOUT_SECONDS,
    })
    return {
      port,
      stop: async () => {
        await server.stop(true)
      },
    }
  }

  // Node 运行时：请求处理器本身是 Web 标准的，这里只换最外面那层 server。
  return serveWithNodeHttp({
    host,
    port,
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    handler,
  })
}

/** 依次尝试端口，直到绑定成功。 */
async function serveWithPortRetry(
  host: string,
  startPort: number,
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ handle: ServeHandle; port: number; shifted: boolean }> {
  let lastErr: unknown

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i
    try {
      const handle = await tryListen(host, port, handler)
      return { handle, port, shifted: i > 0 }
    } catch (err) {
      lastErr = err
      // 只有「端口占用」才重试；其他错误（如权限）应立即失败
      if (!isPortInUse(err)) {
        throw err
      }
    }
  }

  throw new Error(
    `端口 ${startPort}~${startPort + MAX_PORT_ATTEMPTS - 1} 都被占用，无法启动服务。` +
      `请用 --port 指定其他端口。原始错误：${msg(lastErr)}`,
  )
}

function isPortInUse(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === 'EADDRINUSE') return true
  const text = msg(err).toLowerCase()
  return text.includes('eaddrinuse') || text.includes('address already in use')
}

interface HandlerDeps {
  credentials: CredentialStore
  identityRoute: IdentityRoute
  /** 本地直查路由。`enableLocalApi` 为 false 时是 null。 */
  localStats: LocalStatsRouter | null
  enableLocalApi: boolean
  staticDir?: string
}

/** 构造请求处理器。 */
function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const { credentials, identityRoute, localStats, enableLocalApi, staticDir } = deps
  const indexHtml = staticDir ? join(staticDir, 'index.html') : null

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const p = url.pathname

    try {
      // ── 身份校验（部门服务端）────────────────────────────────
      if (p === '/api/v1/identity/verify') {
        if (req.method !== 'POST') return methodNotAllowed('POST')

        let bodyToken: string | null = null
        try {
          const body = (await req.json()) as { token?: unknown }
          if (typeof body?.token === 'string') bodyToken = body.token
        } catch {
          /* 无 body 或非法 JSON 都允许，改看 Authorization 头 */
        }

        const result = verifyToken(credentials, {
          authorization: req.headers.get('authorization'),
          bodyToken,
        })
        // 校验失败返回 200 + ok:false —— 这是业务结果，不是 HTTP 错误。
        // 用 401 会让前端把「token 填错了」和「网络坏了」混为一谈。
        return json(result)
      }

      // ── 本地身份读写（本地页面用）────────────────────────────
      if (enableLocalApi && p === '/api/local/identity') {
        if (req.method === 'GET') {
          return json(identityRoute.get())
        }
        if (req.method === 'POST') {
          let payload: unknown
          try {
            payload = await req.json()
          } catch {
            return json({ ok: false, reason: '请求体不是合法 JSON' }, 400)
          }
          const result = await identityRoute.submit(
            payload as { name: string; token: string; dept?: string },
          )
          // 同样用 200 表达业务失败，理由同上
          return json(result)
        }
        if (req.method === 'DELETE') {
          return json(identityRoute.clear())
        }
        return methodNotAllowed('GET, POST, DELETE')
      }

      // ── 本地统计直查（本地页面用）──────────────────────────────
      // ★ 只扫本机日志，不碰数据库 —— 这是「本地」名副其实的前提。
      if (enableLocalApi && localStats && p.startsWith('/api/local/stats/')) {
        if (req.method !== 'GET') return methodNotAllowed('GET')

        const params = url.searchParams
        const sub = p.slice('/api/local/stats/'.length)

        switch (sub) {
          case 'overview':
            return fromRoute(await localStats.overview(params))
          case 'series':
            return fromRoute(await localStats.series(params))
          case 'breakdown':
            return fromRoute(await localStats.breakdown(params))
          case 'diagnostics':
            return fromRoute(await localStats.diagnostics(params))
          default:
            return json({ ok: false, reason: `未找到 ${p}` }, 404)
        }
      }

      // ── 强制失效缓存重扫（本地页面用）──────────────────────────
      if (enableLocalApi && localStats && p === '/api/local/refresh') {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        return fromRoute(localStats.refresh())
      }

      // ── 健康检查 ────────────────────────────────────────────
      if (p === '/api/health') {
        return json({
          ok: true,
          version: SERVER_VERSION,
          credentialsRegistered: credentials.registered,
          credentialCount: credentials.size,
          localApi: enableLocalApi,
        })
      }

      // ── 静态资源（前端页面）──────────────────────────────────
      if (staticDir && req.method === 'GET') {
        const served = await serveStatic(staticDir, p)
        if (served) return served
        // 未命中文件 → 回落到 index.html，交给前端路由
        if (indexHtml) {
          const html = await readFileOrNull(indexHtml)
          if (html) {
            return new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
          }
        }
      }

      return json({ ok: false, reason: `未找到 ${p}` }, 404)
    } catch (err) {
      // 兜底：任何未捕获异常都返回 JSON，而不是让连接挂断。
      // 前端拿到结构化错误才能展示有意义的信息。
      return json({ ok: false, reason: `服务内部错误: ${msg(err)}` }, 500)
    }
  }
}

/**
 * 读取一个文件；不存在或不是普通文件时返回 null。
 *
 * ★ 用 `node:fs/promises` 而不是 `Bun.file()`：后者是 Bun 专有的，
 *   而本服务要同时跑在 Bun 与 Node 上（npm 发布的 CLI 就是这么用的）。
 */
async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return await readFile(path)
  } catch {
    return null
  }
}

/** 尝试提供静态文件；未命中返回 null。 */
async function serveStatic(dir: string, pathname: string): Promise<Response | null> {
  // decodeURIComponent 会对非法百分号编码（如 `/%zz`）抛 URIError。
  // 这是客户端请求格式错误，不是服务缺陷 —— 直接回 400，
  // 否则会被外层兜底 catch 转成 500，排障时误以为是服务出 bug。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return json({ ok: false, reason: '请求路径包含非法的 URL 编码' }, 400)
  }

  // 去掉前导 /，并拒绝 .. 穿越
  const rel = decoded.replace(/^\/+/, '')
  if (!rel || rel.includes('..')) return null

  const data = await readFileOrNull(join(dir, rel))
  if (!data) return null

  return new Response(data, { headers: { 'Content-Type': contentTypeOf(rel) } })
}

function contentTypeOf(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** 把路由结果转成 Response。 */
function fromRoute(result: { status: number; body: unknown }): Response {
  return json(result.body, result.status)
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ ok: false, reason: '方法不允许' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: allow },
  })
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}