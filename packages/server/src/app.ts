/**
 * `@ai-token-report/server` 的路由与中间件装配 —— **唯一**的「什么路径返回什么」。
 *
 * ## 一个 server，两副面孔
 *
 * | 路径 | 使用者 | 数据源 | 鉴权 |
 * |---|---|---|---|
 * | `/api/local/identity` | 本地页面引导页 | 身份文件 | 无（仅 127.0.0.1） |
 * | `/api/local/stats/*` | 本地页面（`dsh-token --web`） | **本地 SQLite 增量库**（降级直扫日志） | 无（仅 127.0.0.1） |
 * | `/api/local/refresh` | 本地页面「刷新」按钮 | 触发下一次增量 ingest | 无（仅 127.0.0.1） |
 * | `/api/v1/identity/verify` | 本地服务代用户校验 | 凭证表 | Bearer |
 * | `/api/v1/token-usage` | 插件 & CLI 上报 | 写入**上报库**（`portal.sqlite`） | Bearer |
 * | `/api/v1/stats/*` | 部门看板页面 | 读上报库（只读） | Bearer |
 * | `/api/v1/admin/*` | 部门看板管理页 | 数据库人员、部门、账号、凭证 | Principal + 当前权限 |
 * | `/api/health` | 运维探活 | 无 | 无 |
 *
 * ⚠️ **`/api/v1/token-usage` 在两个形态下都注册**（不管 `enableLocalApi`）：
 *   插件的默认上报地址就是 `http://127.0.0.1:8787/api/v1/token-usage`，
 *   也就是「单机自建一个只收自己的小服务端」是受支持的用法。
 *
 * ## 为什么换成 Hono（原先是 185 行顺序 `if` 链）
 *
 * 1. **它不改变运行时约束**：Hono 的入口形状**就是**
 *    `(req: Request) => Response`，与本仓原有的处理器逐字相同 ——
 *    所以「不给 Node 另写一套路由」这条约束零妥协。
 * 2. **405 / 404 / 中间件不再手写**：`hono/method-not-allowed` 读 Hono
 *    **自己的路由表**反查「路径存在但方法不对」，因此不存在第二份
 *    「什么路径允许什么方法」的实现。
 * 3. **跨切面的事有地方放**：请求日志、request-id、安全响应头、
 *    请求体上限都是 `app.use`，而不是散在 8 个分支里各写一遍。
 *
 * ## ★ 业务护栏**不**交给库
 *
 * 401/403/503 的语义、上报必须非 2xx、凭证唯一真值、最后管理员护栏……
 * 全部留在身份仓储。中间件只做 HTTP 分发与 Cookie/Origin 校验。
 * 逐条红线见 `docs/server架构重构方案.md` §5。
 *
 * ## ⚠️ 为什么不把 6 个 handler 拆成 `routes/*.ts`
 *
 * 它们合计约 180 行，且共享同一个 `AppDeps`。拆成 6 个文件只会把依赖
 * 传来传去、把「端点清单」打散到 6 个地方 —— 那不是解耦，是搬字。
 * 等到某个 handler 自身超过 ~100 行再拆。
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { compress } from 'hono/compress'
import { etag } from 'hono/etag'
import { logger } from 'hono/logger'
import { methodNotAllowed } from 'hono/method-not-allowed'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { PortalAuth, viewerOf, SESSION_SECONDS, CAPTCHA_SECONDS } from './auth/portal-auth.js'

import type { AdminRoute, DatabaseAdminRoute } from './admin-route.js'
import { IdentityError, type IdentityRepository, type Principal } from './identity/index.js'
import type { Credential } from './credentials.js'
import type { Authentication } from './http/auth.js'
import type { CredentialStore } from './credentials.js'
import { readJsonBodyLenient, readJsonBodyStrict, requestBodyLimit } from './http/body.js'
import { fail, json, methodNotAllowed as methodNotAllowedBody, msg, respond } from './http/envelope.js'
import { serveIndexHtml, serveStatic } from './http/static.js'
import type { IdentityRoute } from './identity-route.js'
import type { IngestRoute } from './ingest-route.js'
import type { LocalStatsRouter } from './local-api.js'
import type { StatsRoute } from './stats-route.js'
import { verifyDatabaseToken, verifyToken } from './verify-route.js'

/** 服务端版本（`/api/health` 会回报它，便于确认线上到底是哪一版）。 */
export const SERVER_VERSION = '0.1.0'

export interface AppDeps {
  /** HTTPS 反向代理部署时显式配置公开地址，不信任客户端转发头。 */
  portalOrigin?: string
  portalAuth?: PortalAuth
  identityStore?: IdentityRepository
  databaseAdminRoute?: DatabaseAdminRoute
  captchaHmacKey?: string
  credentials: CredentialStore
  identityRoute: IdentityRoute
  ingestRoute: IngestRoute
  statsRoute: StatsRoute
  adminRoute?: AdminRoute
  /** 本地直查路由。`enableLocalApi` 为 false 时是 null。 */
  localStats: LocalStatsRouter | null
  enableLocalApi: boolean
  staticDir?: string
  /**
   * 请求日志（默认开）。
   *
   * ⚠️ 默认**开**：重构前请求路径上一条日志都没有，出问题时只能靠猜。
   *   测试里会传 false —— 几百行访问日志会把真正的失败信息淹掉。
   */
  requestLog?: boolean
}

/** 构造应用（不起监听）。 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  const portalAuth = deps.portalAuth ?? (deps.identityStore
    ? new PortalAuth(deps.identityStore, { hmacKey: deps.captchaHmacKey })
    : new PortalAuth(deps.credentials))
  const sessionCookie = 'atr_portal_session'
  const captchaCookie = 'atr_portal_captcha'
  const publicOrigin = deps.portalOrigin ? new URL(deps.portalOrigin).origin : null
  const cookieOptions = (c: Context, maxAge: number) => ({
    httpOnly: true, sameSite: 'Strict' as const, path: '/api/v1',
    secure: new URL(publicOrigin ?? c.req.url).protocol === 'https:', maxAge,
  })
  // ★ Cookie 直接产生 Principal，生产路径不保存也不还原上报 Token。
  const portalAuthorization = async (c: Context): Promise<Authentication> => {
    if (authOf(c)) return authOf(c)
    const identity = await portalAuth.resolve(getCookie(c, sessionCookie))
    if (deps.identityStore) return identity as Principal | null
    // 仅旧领域测试显式传 CredentialStore 时使用旧适配，生产 index 不会走这里。
    return identity ? `Bearer ${(identity as Credential).token}` : null
  }

  // ── 中间件：顺序即语义 ──────────────────────────────────────────
  // 1) request-id 最先：后面所有日志与错误都带上它
  app.use('*', requestId())
  // 2) 访问日志必须包住 405 中间件：它在返回时把 404 改成 405，
  //    日志放在内层会提前把实际的 405 请求误记成 404。
  //    只记方法 / 路径 / 状态 / 耗时，Authorization 里的 token 绝不写进日志。
  if (deps.requestLog !== false) app.use('*', logger())
  // 3) 405 + Allow：读 Hono 自己的路由表，晚一步注册也没关系（首次 404 时才建索引）
  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: (_c, methods) => methodNotAllowedBody(allowHeader(methods)),
    }),
  )
  // 4) 安全响应头（默认不含 CSP，见 `secureHeaders()` 的默认值：
  //    它是一个静态 SPA，加上默认 CSP 会把内联样式/脚本挡住）
  app.use('*', secureHeaders())
  // 5) 请求体上限：解析**之前**拦下，避免 32 MiB 的 body 先被读进内存
  app.use('*', requestBodyLimit())
  // 6) 压缩与协商缓存（S12.3）。★ 只对**非** `/api/*` 生效，理由见 `staticOnly()`。
  //    ⚠️ 顺序不是随意的：先注册的是**外层**，而后置动作要等 `await next()`
  //    返回才跑 —— 所以 compress 在外、etag 在内时，etag 先判定 304、
  //    compress 再看到的就是那个没有 body、也没有 `Content-Type` 的 304，
  //    它的 `shouldCompress()` 直接为假 → **304 不会被压缩/改写**。
  //    反过来写（etag 在外）也能得到正确的 304，代价是每次命中 304 都要先把
  //    body 压一遍再丢掉；304 恰恰是最热的路径，这笔浪费不划算。
  //    取舍的另一面：这样组出来的 304 不带 `Vary: Accept-Encoding`
  //    （`hono/etag` 只保留 cache-control/etag/date/vary 等头，而此刻 compress
  //    还没来得及补 Vary）。⚠️ 这不影响正确性：缓存里存的是 200 的 Vary，
  //    RFC 9111 §4.3.4 只要求用 304 的头**更新**已存响应，不要求重复声明。
  app.use('*', staticOnly(compress()))
  app.use('*', staticOnly(etag()))

  // Cookie 写操作要求同源与自定义头；Bearer 客户端保留原有 HTTP 契约。
  app.use('/api/v1/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/admin/')) c.header('Cache-Control', 'no-store')
    if (c.req.method === 'POST' && (path.startsWith('/api/v1/auth/') || (path.startsWith('/api/v1/admin/') && !authOf(c) && getCookie(c, sessionCookie)))) {
      const origin = c.req.header('origin')
      if (c.req.header('x-portal-request') !== '1' || (origin && origin !== (publicOrigin ?? new URL(c.req.url).origin)) || c.req.header('sec-fetch-site') === 'cross-site') {
        return fail('请从本站页面提交操作', 403)
      }
    }
    await next()
  })

  app.get('/api/v1/auth/captcha', async (c) => {
    const result = await portalAuth.challenge(getCookie(c, captchaCookie))
    if (!result.ok) return fail(result.reason, result.status)
    setCookie(c, captchaCookie, result.binding, cookieOptions(c, CAPTCHA_SECONDS))
    return c.json(result.data)
  })
  app.post('/api/v1/auth/login', async (c) => {
    const parsed = await readJsonBodyStrict(c)
    if ('error' in parsed) return fail(parsed.error, 400)
    const result = await portalAuth.login(parsed.value, getCookie(c, captchaCookie))
    deleteCookie(c, captchaCookie, { path: '/api/v1' })
    if (!result.ok) return fail(result.reason, result.status)
    await portalAuth.logout(getCookie(c, sessionCookie))
    setCookie(c, sessionCookie, result.sessionId, cookieOptions(c, SESSION_SECONDS))
    return c.json({ ok: true, viewer: result.viewer })
  })
  app.get('/api/v1/auth/session', async (c) => {
    const identity = await portalAuth.resolve(getCookie(c, sessionCookie))
    if (!identity) return fail('登录已失效，请重新登录', 401)
    return c.json({ ok: true, viewer: deps.identityStore
      ? await deps.identityStore.getViewer(identity as Principal)
      : viewerOf(identity as Credential) })
  })
  app.post('/api/v1/auth/logout', async (c) => {
    await portalAuth.logout(getCookie(c, sessionCookie))
    deleteCookie(c, sessionCookie, { path: '/api/v1' })
    return c.json({ ok: true })
  })

  // ── 健康检查 ──────────────────────────────────────────────────
  // ⚠️ 刻意不校验方法：探活工具常发 HEAD/POST，回 405 会让监控误判服务已死。
  app.all('/api/health', async () => {
    if (deps.identityStore) return json({
      ok: true, version: SERVER_VERSION, localApi: deps.enableLocalApi,
      schema_version: 4, initialized: await deps.identityStore.isRegistered(),
      identity_storage: 'database',
    })
    return json({
      ok: true,
      version: SERVER_VERSION,
      credentialsRegistered: deps.credentials.registered,
      credentialCount: deps.credentials.size,
      // 管理员数量的意义是「还有没有人能发 token」：
      // 它是 0 时管理页谁都进不去（只能靠 ATR_ADMIN_TOKEN 或改文件）。
      adminCount: deps.credentials.adminCount,
      localApi: deps.enableLocalApi,
    })
  })

  // ── 用量上报（插件 & CLI）────────────────────────────────────
  // ★ 两个形态都注册：插件的默认 endpoint 就是 127.0.0.1:8787 的这个路径。
  //   鉴权失败必须是 401/503（见 `ingest-route.ts`）：客户端把 2xx 当作
  //   「已投递」并清掉 pending，回 200 会让那批用量被永久丢掉。
  app.post('/api/v1/token-usage', async (c) => {
    const parsed = await readJsonBodyStrict(c)
    if ('error' in parsed) return fail(parsed.error, 400)
    return respond(await deps.ingestRoute.submit(parsed.value, authOf(c)))
  })

  // ── 身份校验（部门服务端）────────────────────────────────────
  app.post('/api/v1/identity/verify', async (c) => {
    // 兼容路径：body 里也允许带 token（老客户端/代理对 Authorization 头处理不一致）。
    // ⚠️ 非法 JSON **静默忽略**并改看 Authorization 头：这不是偷懒 ——
    //    把它当 400 会让「token 明明填对了却验证不了」变成一个假故障。
    let bodyToken: string | null = null
    try {
      const body = (await c.req.json()) as { token?: unknown }
      if (typeof body?.token === 'string') bodyToken = body.token
    } catch {
      /* 无 body 或非法 JSON 都允许，改看 Authorization 头 */
    }

    // ★ 永远 200 + ok:false 表达业务失败：用 401 会让前端把
    //   「token 填错了」和「网络坏了」混为一谈（见契约测试）。
    return json(deps.identityStore
      ? await verifyDatabaseToken(deps.identityStore, { authorization: authOf(c), bodyToken })
      : verifyToken(deps.credentials, { authorization: authOf(c), bodyToken }))
  })

  // ── 部门看板查询（web-portal 用）────────────────────────────
  // ★ 读**上报库**（与 `/api/local/*` 的本地库是两个文件）。
  //   鉴权失败回 401/503 而不是 200 + ok:false —— 这个响应体里装的是
  //   数据，回 2xx 会让前端把「token 不对」显示成「这段时间没人用」。
  app.get('/api/v1/stats/*', async (c) => {
    const url = new URL(c.req.url)
    const sub = url.pathname.slice('/api/v1/stats/'.length)
    c.header('Cache-Control', 'no-store')
    return respond(await deps.statsRoute.handle(sub, url.searchParams, await portalAuthorization(c)))
  })

  // ── 人员管理与 token 发放（web-portal 的管理页）──────────────
  // ★ 唯一会写凭证文件的通路。鉴权失败回 401 / 403 / 503 三者之一，
  //   含义各不相同（见 `admin-route.ts` 的表）—— 绝不能是 200 + ok:false。
  if (deps.databaseAdminRoute) {
    const route = deps.databaseAdminRoute
    const dispatch = async (c: Context, action: string): Promise<Response> => {
      const parsed = c.req.method === 'POST' ? await readJsonBodyLenient(c) : { value: undefined }
      if ('error' in parsed) return fail(parsed.error, 400)
      return respond(await route.handle(c.req.method, action, await portalAuthorization(c), parsed.value, new URL(c.req.url).searchParams))
    }
    for (const path of ['members', 'members/tokens', 'roles', 'audit', 'storage', 'legacy-attributions']) {
      app.get(`/api/v1/admin/${path}`, c => dispatch(c, path))
    }
    app.get('/api/v1/departments', c => dispatch(c, 'departments'))
    for (const path of [
      'members', 'members/update', 'members/roles', 'members/status', 'members/login',
      'members/login/status', 'members/tokens', 'members/tokens/rotate', 'members/tokens/revoke',
      'members/tokens/scopes', 'departments', 'departments/update', 'departments/status',
      'legacy-attributions/confirm',
    ]) app.post(`/api/v1/admin/${path}`, c => dispatch(c, path))
  } else if (deps.adminRoute) {
  const legacyAdmin = deps.adminRoute
  const legacyAuthorization = async (c: Context): Promise<string | null> => {
    const value = await portalAuthorization(c)
    return typeof value === 'string' ? value : null
  }
  app.get('/api/v1/admin/members', async (c) => respond(legacyAdmin.list(await legacyAuthorization(c))))
  app.post('/api/v1/admin/members', async (c) => {
    const parsed = await readJsonBodyLenient(c)
    if ('error' in parsed) return fail(parsed.error, 400)
    return respond(legacyAdmin.issue(await legacyAuthorization(c), parsed.value))
  })
  app.post('/api/v1/admin/members/*', async (c) => {
    const pathname = new URL(c.req.url).pathname
    const action = pathname.slice('/api/v1/admin/members/'.length)

    // 子路径写成显式白名单而不是动态调用：接口清单一眼可见，
    // 新增动作时也不会出现「拼错一个字母就变成 404」之外的可能。
    if (action !== 'issue' && action !== 'update' && action !== 'rotate' && action !== 'revoke' && action !== 'login') {
      return fail(`未找到 ${pathname}`, 404)
    }

    const parsed = await readJsonBodyLenient(c)
    if ('error' in parsed) return fail(parsed.error, 400)

    switch (action) {
      case 'login':
        return respond(await legacyAdmin.setLogin(await legacyAuthorization(c), parsed.value))
      case 'update':
        return respond(legacyAdmin.update(await legacyAuthorization(c), parsed.value))
      case 'rotate':
        return respond(legacyAdmin.rotate(await legacyAuthorization(c), parsed.value))
      case 'revoke':
        return respond(legacyAdmin.revoke(await legacyAuthorization(c), parsed.value))
      default:
        // `issue` 挂在 `/api/v1/admin/members` 上（见上），这里只可能是拼错
        return fail('签发 token 请 POST /api/v1/admin/members（不带子路径）', 404)
    }
  })
  }

  // ── 本地身份读写（本地页面用；仅 `--web` 形态）──────────────
  if (deps.enableLocalApi) {
    app.get('/api/local/identity', () => json(deps.identityRoute.get()))
    app.post('/api/local/identity', async (c) => {
      const parsed = await readJsonBodyStrict(c)
      if ('error' in parsed) return fail(parsed.error, 400)
      // 形状校验在 `IdentityRoute.submit` 内部（那里才有完整的业务上下文）
      const result = await deps.identityRoute.submit(
        parsed.value as { name: string; token: string; dept?: string },
      )
      // 同样用 200 表达业务失败：这是「填的 token 不对」，不是 HTTP 错误
      return json(result)
    })
    app.delete('/api/local/identity', () => json(deps.identityRoute.clear()))
  }

  // ── 本地统计直查 / 刷新（本地页面用）────────────────────────
  // ★ 只扫本机日志与本地库，不碰部门上报库 —— 这是「本地」名副其实的前提。
  const localStats = deps.localStats
  if (deps.enableLocalApi && localStats) {
    app.get('/api/local/stats/*', async (c) => {
      const url = new URL(c.req.url)
      const sub = url.pathname.slice('/api/local/stats/'.length)

      switch (sub) {
        case 'overview':
          return respond(await localStats.overview(url.searchParams))
        case 'series':
          return respond(await localStats.series(url.searchParams))
        case 'breakdown':
          return respond(await localStats.breakdown(url.searchParams))
        case 'diagnostics':
          return respond(await localStats.diagnostics(url.searchParams))
        default:
          return fail(`未找到 ${url.pathname}`, 404)
      }
    })

    app.post('/api/local/refresh', () => respond(localStats.refresh()))
  }

  // ── 兜底：静态资源 / SPA 回落 / JSON 404 ────────────────────
  // 🚨 必须用 `app.use('*')`（方法 ALL）而**不是** `app.get('*')`：
  //   `hono/method-not-allowed` 是从 `app.routes` 反查「这个路径允许哪些方法」的，
  //   而 `get('*')` 会作为一条 **GET 路由**登记进去 —— 于是**任何**路径都
  //   「允许 GET」，两个后果同时出现：
  //     1. `GET /api/v1/token-usage`（只收 POST）保住 404，405 永远不触发；
  //     2. 未注册的路径（如未启用时的 `/api/local/refresh`）被算成允许 GET，
  //        一个 POST 上去得到 405 + `Allow: GET` —— 比 404 更误导。
  //   `use('*')` 是 ALL 方法，索引阶段会被跳过，只作为「前面都没应答」的兜底。
  //   实测见 `test/http-contract.test.ts` 的 405/Allow 断言。
  app.use('*', (c) => fallback(c, deps))
  // 双保险：`use('*')` 理论上接得住所有请求，notFound 与它**共用同一个实现**，
  // 免得 405/404 的判定分叉（那正是重构前 `404` 有 6 个来源的成因）。
  app.notFound((c) => fallback(c, deps))

  app.onError((err, c) => {
    if (err instanceof IdentityError) return json({ ok: false, reason: err.message, ...(err.code ? { code: err.code } : {}) }, err.status)
    if (deps.identityStore) return fail('数据库服务暂时不可用，请稍后重试', 503)
    // 兜底：任何未捕获异常都返回 JSON，而不是让连接挂断。
    // 前端拿到结构化错误才能展示有意义的信息。
    // ⚠️ 不回显堆栈：它可能带上文件路径与内部结构，日志里有 request-id 可追。
    return fail(`服务内部错误: ${msg(err)}`, 500)
  })

  return app
}

/** 取 Authorization 头（`null` 与「没带」在鉴权层是同一件事）。 */
function authOf(c: Context): string | null {
  return c.req.header('authorization') ?? null
}

/**
 * `Allow` 头的取值。
 *
 * ⚠️ `hono/method-not-allowed` 会把 HEAD 并进 GET 的允许集合（HTTP 语义上没错），
 *   但本仓的对外契约是「**Allow 恰好列出真实处理器**」——
 *   `e2e-ingest.ts:222` 与契约测试都逐字断言。
 *   多出来的 HEAD 会让客户端的重试/探测逻辑判断错方向，所以在这里滤掉。
 */
function allowHeader(methods: string[]): string {
  return methods.filter((m) => m !== 'HEAD').join(', ')
}

/**
 * 是否属于 `/api` 命名空间（`/api` 本身与 `/api/...` 都算）。
 *
 * ★ 只此一处：它同时是「未命中必须回 JSON 404」与「不走静态中间件」的判据，
 *   两处若各写一遍，改了一处就会出现「压缩中间件把 API 响应也处理了，
 *   但 404 判定还认为它是静态路径」这类错位。
 */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

/**
 * 让中间件只对**非 `/api/*`** 的请求生效（Hono 没有「排除某前缀」的匹配器）。
 *
 * ★ 为什么要把 `/api/*` 排除在 compress/etag 之外：
 * 1. 那两件事的收益全在静态产物上（看板每次刷新都在重复下载 JS/CSS）；
 *    `/api/*` 的响应体是每次都可能不同的动态数据，协商缓存没有意义；
 * 2. 🚨 本任务的红线是 `/api/*` 的状态码与信封**一个字都不许动**。
 *    压缩会加 `Content-Encoding`、ETag 会引入 304 —— 给一条已被 41 项断言
 *    钉死的契约加这两个变量，收益为零、风险不为零。
 *    （尤其：`GET /api/...?` 的 304 会让前端 fetch 拿到空 body，而它只判断
 *    「响应体是不是 JSON」，那正是 `usage-store.test.ts:137` 踩过的坑。）
 */
function staticOnly(mw: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (isApiPath(new URL(c.req.url).pathname)) return next()
    return mw(c, next)
  }
}

/**
 * 未命中任何路由时的兜底。
 *
 * 它同时挂在 `app.use('*')` 与 `app.notFound` 上：前者接住「路径对不上但方法
 * 也不对」的请求，后者接住其余方法 —— 两处**共用同一个实现**，
 * 免得 405/404 的判定分叉（那正是重构前 `404` 有 6 个来源的成因）。
 */
async function fallback(c: Context, deps: AppDeps): Promise<Response> {
  const pathname = new URL(c.req.url).pathname

  // 🚨 `/api/*` 未命中一律 JSON 404，**绝不允许**落到 SPA 回落。
  //   静态兜底对所有 GET 生效时，`GET /api/不存在的路径` 会返回 200 + text/html，
  //   而前端已经踩过这个坑：
  //     packages/dsh-plugin/test/client/usage-store.test.ts:137
  //       「200 但响应体不是 JSON（SPA 兜底返回了 HTML）」
  //   —— 一个「数据通道没装上」因此被渲染成「加载失败」，排障方向完全被带偏。
  if (isApiPath(pathname)) {
    return fail(`未找到 ${pathname}`, 404)
  }

  // ★ `HEAD` 与 `GET` 走**同一条**路：以前只认 GET，于是 `HEAD /app.js`
  //   会落进下面的 JSON 404 —— 「文件明明在，HEAD 说没有」会让探活脚本、
  //   CDN 预热、`curl -I` 全部给出错误结论。返回的响应由 `staticResponse()`
  //   统一构造：头与 GET 逐字相同，只是不带 body。
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && deps.staticDir) {
    const served = await serveStatic(deps.staticDir, pathname, c.req.method)
    if (served) return served

    // 未命中文件 → 回落到 index.html，交给前端路由
    const html = await serveIndexHtml(deps.staticDir, c.req.method)
    if (html) return html
  }

  return fail(`未找到 ${pathname}`, 404)
}
