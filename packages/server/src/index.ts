/**
 * `@ai-token-report/server` —— 后端服务的**组装入口**。
 *
 * ## 这个文件现在只做三件事
 *
 * 1. 把选项（`ServerOptions`）变成一条完整的依赖链：数据库身份 → 路由 → 应用
 * 2. 起监听（两个运行时二选一，见 `runtime/listen.ts`）
 * 3. 回报启动横幅需要的那点元信息
 *
 * 「什么路径返回什么」在 `app.ts`；鉴权裁决在 `http/auth.ts`；
 * 上报 / 看板 / 管理 / 本地查的业务与护栏在各自的 `*-route.ts`。
 * **本文件里不该再出现任何 `if (path === ...)`** —— 重构前它有 185 行这样的分支。
 *
 * ## ★ 运行时无关：Bun 与 Node 都能起
 *
 * 请求处理器（{@link createHandlerFor} 返回的 `handler`）是 Web 标准的
 * （入参 `Request`、返回 `Response`），所以 Bun 专有的只有最外面那层 server。
 * npm 发布出去的那份 CLI 靠的就是这条性质跑在 Node 上。
 *
 * 🚨 **静态资源一律走 `node:fs/promises`，绝不用 `Bun.file()`**。
 *
 * ## 端口占用
 *
 * 默认 8787，被占用时自动 +1 重试（最多 10 次，见 `runtime/listen.ts`）。
 * 这让「再开一个」不会因为端口冲突直接失败，也让多实例调试变得容易。
 * ⚠️ 但部署时应当用 `--port` 固定端口：静默自增会让反代指向一个没人听的端口，
 *   而启动日志里那行「已改用 8788」很容易被忽略。
 */

import { resolvePaths } from '@ai-token-report/core'
import { describePortalTarget, portalDbFileName, resolvePortalTarget, preparePortalDatabase } from '@ai-token-report/core/db'
import { join } from 'node:path'

import { DatabaseAdminRoute } from './admin-route.js'
import { createApp } from './app.js'
import { CredentialStore } from './credentials.js'
import { IdentityRepository } from './identity/index.js'
import { IdentityRoute } from './identity-route.js'
import { IngestRoute } from './ingest-route.js'
import { CoreStatsProvider, LocalStatsRouter } from './local-api.js'
import { serveWithPortRetry, type RequestHandler } from './runtime/listen.js'
import { StatsRoute } from './stats-route.js'

export { DEFAULT_PORT, IDLE_TIMEOUT_SECONDS } from './runtime/listen.js'
export { SERVER_VERSION } from './app.js'

export interface ServerOptions {
  /** 后台公开源（HTTPS 反向代理时用于同源校验与 Secure Cookie）。 */
  portalOrigin?: string
  /** 首次部署的后台登录账号；密码只以哈希写入数据库。 */
  adminUsername?: string
  adminPassword?: string
  /** 多实例共用的验证码 HMAC 密钥。缺省时仍可上报，但后台登录不可用。 */
  captchaHmacKey?: string
  /** 监听端口。默认 8787；被占用时自动 +1；0 表示由系统分配空闲端口。 */
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
  /**
   * **上报库**（服务端）的 SQLite 文件路径。
   *
   * 默认 `<dshHome>/token-report/portal.sqlite`。
   * ⚠️ 与本地库 `usage.sqlite` 是两个不同的文件 —— 混用会让全员数据与本机数据
   * 相互污染且无法事后拆开（见 `core/db` 的 `portalDbFileName()`）。
   *
   * 🚨 这个库是全员上报数据的**唯一副本**，因此 schema 版本不符时
   * `openPortalDb()` 会抛错而**不会**像本地库那样自动重建。
   */
  dbPath?: string
  /**
   * **上报库改用 MySQL**（可选）。设置后 `dbPath` 不再被使用（两者只该有一个）。
   *
   * 取值形如 `mysql://user:pass@host:3306/ai_token_report`；未显式给时读环境变量
   * `ATR_MYSQL_URL`（与 `portalOrigin` 同一套「选项优先、其次环境变量」的顺序）。
   *
   * ★ **只有部门服务端需要它**。本机库 `usage.sqlite` 恒为 SQLite ——
   *   员工机器上跑 CLI 不需要任何数据库服务，这条边界由类型保证
   *   （本地路径只收同步 SQLite `Database`）。
   *
   * 🚨 **两个运行时都能用，但走的是不同驱动**：Bun 用内建 `Bun.sql`；
   *   Node 用**可选依赖** `mysql2`（`packages/server` 里声明）。
   *   两者都**不进 npm 发布产物** —— `mysql2` 是动态 import 且**说明符构建期不可静态分析**
   *   （用变量拼），否则 core 被内联进 `packages/cli/dist/cli.js` 时会把它一起带进去，
   *   而本仓有「发布产物零运行时依赖」的断言。没装 `mysql2` 时**明确报错并给出安装命令**。
   *   详见 `docs/mysql上报库.md`。
   *
   * 🚨 启动横幅会打印它，**必须脱敏**（`describePortalTarget()` 负责抹掉密码）。
   */
  mysqlUrl?: string
  /** @deprecated 凭证文件只能作为显式迁移输入；运行时指定将拒绝启动。 */
  credentialsPath?: string
  /**
   * 首次初始化管理员 Token（默认 `ATR_ADMIN_TOKEN`），仅摘要写入数据库。
   * 数据库初始化后不再重新导入环境变量，防止重启复活已停用身份。
   */
  adminToken?: string
  /** 环境变量管理员的显示名（默认「管理员」）。 */
  adminName?: string
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
  /**
   * 请求日志（默认**开**）。
   *
   * ⚠️ 默认开是因为重构前请求路径上一条日志都没有，出问题只能靠猜；
   *   测试里关掉，免得几百行访问日志淹没真正的失败信息。
   */
  requestLog?: boolean
}

export interface ServerHandle {
  /** 实际监听的地址（端口可能与请求的不同，若发生过 +1 重试） */
  url: string
  port: number
  host: string
  /** 是否因端口被占用而改用其他端口 */
  portShifted: boolean
  /** 有效凭证数（启动横幅用）。 */
  credentialCount: number
  /**
   * 管理员数量。
   *
   * 按具有永久管理入口的不同人员计数；为空时启动横幅必须提示，
   *   否则管理员会在「管理页进不去」上浪费很久。
   */
  adminCount: number
  /** @deprecated 仅保留旧调用方形状，数据库模式恒为空串。 */
  credentialsPath: string
  /**
   * 上报库的**可读描述**（启动横幅打印它）。
   *
   * 🚨 已经过 `describePortalTarget()` 脱敏 —— 绝不能把 `ATR_MYSQL_URL` 原样打出来，
   *   那里面带密码，而启动日志经常被贴进工单与聊天记录。
   */
  portalTargetLabel: string
  schemaVersion: number
  initialized: boolean
  /** 优雅停机 */
  stop(): Promise<void>
}

/** 组装结果：`createServer` 与测试共用的「不起监听」那一半。 */
export interface HandlerBundle {
  /** Web 标准的请求处理器 —— 两个运行时的公共入口。 */
  handler: RequestHandler
  /** @deprecated 空兼容适配器，生产鉴权由 identityStore 完成。 */
  credentials: CredentialStore
  credentialsPath: string
  identityStore?: IdentityRepository
  /** 上报库路径（全员数据的唯一副本）。⚠️ 配了 MySQL 时它只是**退路**，不是实际目标。 */
  dbPath: string
  /** 实际上报库的可读描述（已脱敏；SQLite 是路径，MySQL 是「库名 @ 主机:端口」）。 */
  portalTargetLabel: string
  /** 静态资源目录；未构建/未指定时为 undefined。 */
  staticDir?: string
}

/**
 * 组装请求处理器 —— **不起监听**。
 *
 * ★ 单独抽出来的理由：让「分发面」能在 `bun test` 里被直接断言。
 *   真 HTTP（套接字、端口重试、`idleTimeout`）由 `test/e2e-*.ts` 覆盖，
 *   但那些脚本是 `bun run` 执行的、抢固定端口，按本仓约定**不适合**放进
 *   `bun test`（会被并发跑起来、随机失败）。而「路径 × 方法 → 状态码」
 *   这张表用 `new Request(...)` 直接喂进处理器即可钉住 ——
 *   见 `test/http-contract.test.ts`。
 */
export async function createHandlerFor(options: ServerOptions = {}): Promise<HandlerBundle> {
  const paths = resolvePaths(options.dshHome)
  const localOnly = options.enableLocalApi === true && !options.dbPath && !options.mysqlUrl && !options.adminToken && !options.adminUsername && !options.adminPassword
  if (!localOnly && options.credentialsPath) throw new Error('credentialsPath 已不再是运行时身份源，请先通过显式数据库迁移导入旧凭证文件')
  // 身份、会话、上报和统计共享唯一数据库目标；连接失败不能回落文件或其他库。
  const dbPath = options.dbPath ?? defaultPortalDbPath(paths.dshHome)
  const mysqlUrl = localOnly ? undefined : options.mysqlUrl ?? process.env.ATR_MYSQL_URL
  const target = resolvePortalTarget({ sqlitePath: dbPath, mysqlUrl })
  const identityStore = localOnly ? undefined : new IdentityRepository(target)
  if (identityStore) {
    await preparePortalDatabase(target)
    await identityStore.initialize({
      adminToken: options.adminToken ?? process.env.ATR_ADMIN_TOKEN,
      adminName: options.adminName ?? process.env.ATR_ADMIN_NAME,
      adminUsername: options.adminUsername ?? process.env.ATR_ADMIN_USERNAME,
      adminPassword: options.adminPassword ?? process.env.ATR_ADMIN_PASSWORD,
    })
  }
  // 仅保留旧调用方的类型形状；生产鉴权不读取或填充这份空的适配器。
  const credentials = CredentialStore.empty()

  const identityRoute = new IdentityRoute({
    dshHome: paths.dshHome,
    ...(options.portalUrl ? { portalUrl: options.portalUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  // 上报接收：写**上报库**（默认 portal.sqlite）。它与 `/api/local/*` 用的
  // 本地库是两个文件 —— 见 ServerOptions.dbPath 的注释。
  // ★ 上报库的目标在这里归一一次：显式选项优先，其次环境变量。
  //   路由内部因此**不再出现任何 `if (mysql)`** —— 换后端不影响任何查询分支。
  //   两者同时配置不报错：`openPortalStore()` 的语义是「有 mysqlUrl 就用它」。
  const mysqlOption = mysqlUrl ? { mysqlUrl } : {}
  const ingestRoute = new IngestRoute({ identityStore, credentials, dbPath, ...mysqlOption })

  // 部门看板查询：读**同一个上报库**（只读，一个字节都不写）。
  // ⚠️ 与上报接口一样在两种形态下都注册 —— 单机自建一个只收自己的小服务端时，
  //   看板同样要能打开（只是里面只有一个人）。
  // ★ 与上报路由**必须拿到同一个目标**：一个写 MySQL、另一个读 SQLite 会让
  //   「上报成功但看板永远是 0」—— 这类分叉不会报错，只会让人以为没人用。
  const statsRoute = new StatsRoute({ identityStore, credentials, dbPath, ...mysqlOption })

  // 人员管理与上报共用同一个身份仓储和数据库事务边界。
  const databaseAdminRoute = identityStore ? new DatabaseAdminRoute(identityStore) : undefined

  // 本地直查：只有启用 `/api/local/*` 时才构造，避免部门服务端
  // 白白持有一条指向本机日志/本地库的通路。
  // 数据源是本地 SQLite 增量库（`core/db`），库不可用时自动降级直扫日志。
  const localStats = options.enableLocalApi
    ? new LocalStatsRouter(new CoreStatsProvider(paths.sessionsRoot, paths.dbPath))
    : null

  const app = createApp({
    portalOrigin: options.portalOrigin ?? process.env.ATR_PORTAL_ORIGIN,
    credentials,
    identityStore,
    captchaHmacKey: options.captchaHmacKey ?? process.env.ATR_CAPTCHA_HMAC_KEY,
    identityRoute,
    ingestRoute,
    statsRoute,
    databaseAdminRoute,
    localStats,
    enableLocalApi: options.enableLocalApi ?? false,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    ...(options.requestLog !== undefined ? { requestLog: options.requestLog } : {}),
  })

  return {
    // ★ 交给最外层服务器的就是这一个函数：Bun 与 Node 共用它
    //   （`Bun.serve({ fetch })` / `serve-node.ts` 的 node:http 桥接）。
    handler: (req: Request) => app.fetch(req),
    credentials,
    credentialsPath: '',
    identityStore,
    dbPath,
    // ★ 实际目标的可读描述（MySQL 时是「库名 @ 主机:端口」，**不含密码**）
    portalTargetLabel: describePortalTarget(resolvePortalTarget({ sqlitePath: dbPath, mysqlUrl })),
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  }
}

/** 创建一个已启动的服务。 */
export async function createServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 8787

  const bundle = await createHandlerFor(options)
  const health = await bundle.identityStore?.health()
  const { handle, port, shifted } = await serveWithPortRetry(host, requestedPort, bundle.handler)

  return {
    url: `http://${host}:${port}`,
    port,
    host,
    portShifted: shifted,
    credentialCount: health?.token_count ?? 0,
    adminCount: health?.admin_count ?? 0,
    credentialsPath: bundle.credentialsPath,
    portalTargetLabel: bundle.portalTargetLabel,
    schemaVersion: bundle.identityStore ? 4 : 0,
    initialized: health?.initialized ?? false,
    stop: () => handle.stop(),
  }
}

/**
 * 上报库的默认路径。
 *
 * ⚠️ 与本地库 `usage.sqlite` **同目录但不同文件**：混用会让全员数据与本机数据
 * 相互污染，且事后无法拆开（库里没有「数据来源」列）。
 */
export function defaultPortalDbPath(dshHome: string): string {
  return join(dshHome, 'token-report', portalDbFileName())
}
