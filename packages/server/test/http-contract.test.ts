/**
 * HTTP 分发面契约测试 —— 「路径 × 方法 → 状态码 + 响应体」的唯一断言。
 *
 * ## 为什么需要这个文件
 *
 * 重构前，`bun test` 里的 9 个测试文件**全部直接实例化路由类**
 * （`new StatsRoute(...)` / `new IngestRoute(...)` …），**没有一个走请求处理器**。
 * 于是「什么路径返回什么」这张表只被三个 `bun run` 的 e2e 脚本覆盖 ——
 * 而那些脚本抢固定端口，按本仓约定不能放进 `bun test`（会被并发跑、随机失败）。
 *
 * 结果是：路由分发是唯一**没有单元级断言**的地方，而它恰恰是最容易被
 * 「看起来等价」的重写改坏的地方（某个方法静默变成 404、`Allow` 头丢了、
 * 静态兜底把 API 的 404 变成 200 HTML……这些都不会报错）。
 *
 * ## 怎么做到不起监听
 *
 * `createHandlerFor()` 是 `createServer()` 里「组装」的那一半，返回 Web 标准的
 * 请求处理器。本文件用 `new Request(...)` 直接喂给它：不需要端口、
 * 不参与端口重试、与并发无关。真 HTTP（套接字 / `idleTimeout` / 端口自增）
 * 仍由 `test/e2e-*.ts` 覆盖 —— 两者是**互补**的，不是替代。
 *
 * ## ⚠️ 两个 describe 的区别
 *
 * - `现状契约`：重构前后**都必须绿**。任何一条红了都说明行为漂移了。
 * - `刻意变更`：`/api/*` 未命中时由「静态兜底 → 200 HTML」改成「JSON 404」。
 *   理由见「刻意变更」块内注释 —— 前端已经踩过「把 HTML 当 JSON 解析」这个坑。
 *
 * ## ★ `S12.3 静态托管` 那一块与生产代码的绑定关系
 *
 * 它验的是 `http/static.ts` 的协商缓存语义 **加上** `app.ts` 里那两行接线
 * （`staticOnly(compress())` / `staticOnly(etag())`）：只留前者、删掉后者时
 * 304 / HEAD / gzip 会一起失效，这一块必须跟着变红 —— 这正是它存在的理由。
 * 反过来说，**改 `app.ts` 的中间件顺序或 `staticOnly()` 的范围前先读它**。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { PORTAL_SCHEMA_VERSION } from '@ai-token-report/core/db'
import { createHandlerFor, type HandlerBundle } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'

// ── 临时环境 ──────────────────────────────────────────────────
// 全部落在系统临时目录下：不碰真实的 $DSH_HOME，也不写仓内任何文件。
const roots: string[] = []

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `atr-http-${tag}-`))
  roots.push(dir)
  return dir
}

const CREDENTIALS = JSON.stringify(
  [
    { token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' },
    { token: 'atr-admin-0001', name: '李经理', role: 'admin' },
  ],
  null,
  2,
)

/**
 * dist **之外**的一个文件：目录穿越与符号链接穿越都断言「请求它拿不到它」。
 * ⚠️ 内容要够独特，否则「没泄露」可能只是因为响应体里恰好是别的东西。
 */
const OUTSIDE_SECRET = 'ATR-OUTSIDE-DIST-SECRET'

/**
 * ≥ 1 KiB 的文本资源。
 *
 * ★ 它存在的唯一理由是 `hono/compress` 的默认阈值就是 1024 字节，而且它读的是
 *   `Content-Length` —— 没有这样一个大文件，「压缩压根没接线」会被
 *   「小文件本来就不压」掩盖过去，测试照样全绿。
 */
const BIG_JS = 'export const padding = 1 // 重复到 1 KiB 以上，用来触发压缩阈值\n'.repeat(48)

/**
 * 本机能不能创建符号链接。
 *
 * ⚠️ Windows 上需要开发者模式或管理员权限；创建不了时对应那条断言用
 *   `test.skipIf` **显式跳过**（而不是静默通过）—— 静默通过会让人以为
 *   「符号链接这条已经验过了」。真跳过时 `bun test` 的输出里会看到它。
 */
let symlinkAvailable = true

/** 建一个含凭证文件与静态产物的临时 home。 */
function makeHome(tag: string): { home: string; staticDir: string } {
  const home = tempRoot(tag)
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(join(home, 'token-report', 'credentials.json'), CREDENTIALS)
  writeFileSync(join(home, 'outside-secret.txt'), OUTSIDE_SECRET)

  const staticDir = join(home, 'dist')
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<html><body>ATR-PORTAL-INDEX</body></html>')
  writeFileSync(join(staticDir, 'app.js'), 'console.log(1)')
  writeFileSync(join(staticDir, 'big.js'), BIG_JS)

  // ★ S12.3 的两个 fixture 成对存在，钉的是「immutable 的判据刻意收窄」：
  //   `index-abc12345.js` 带 **8 位** hash（Vite 实测就是 8 位，如真实产物里的
  //   `index-4bSwXGj-.js`）→ 必须判成 immutable；
  //   `index-abc123.js` 只有 6 位 → 必须判成 no-cache。
  //   ⚠️ 如果把判据放宽成「assets/ 下全部永久缓存」，手工放进去的
  //   `assets/logo-final.png` 之类就会变成「永远不更新且无法察觉」。
  writeFileSync(join(staticDir, 'assets', 'index-abc12345.js'), 'console.log("hashed")')
  writeFileSync(join(staticDir, 'assets', 'index-abc123.js'), 'console.log("short-hash")')

  // 符号链接穿越：`resolve()` 只做字符串归一、看不见 inode，所以必须靠 realpath 兜住。
  if (symlinkAvailable) {
    try {
      symlinkSync(join(home, 'outside-secret.txt'), join(staticDir, 'link.txt'), 'file')
    } catch {
      symlinkAvailable = false
    }
  }

  return { home, staticDir }
}

const deptHome = makeHome('dept')
/** 本地形态的临时 home。两种形态必须各有自己的 home / 数据目录，不能共用。 */
const localHome = makeHome('local')
/**
 * 数据目录：显式指定，**不再跟随 `dshHome`**。
 *
 * ⚠️ 缺省值在家目录下（`~/.ai-token-report`），不给的话这个文件会去开
 *   **真实的上报库**（`openPortalStore` 对空路径会初始化一个空库 ——
 *   而它正是历史用量的唯一副本）。夹具里的凭证 / 上报库都在这一层。
 */
const deptData = join(deptHome.home, 'token-report')
const localData = join(localHome.home, 'token-report')
await seedDatabaseIdentity({ sqlitePath: join(deptData, 'portal.sqlite') }, JSON.parse(CREDENTIALS))

/** 部门形态：开静态托管，**关** `/api/local/*`。 */
const dept: HandlerBundle = await createHandlerFor({
  dshHome: deptHome.home,
  dataDir: deptData,
  staticDir: deptHome.staticDir,
  enableLocalApi: false,
  // ⚠️ 关掉访问日志：本文件有 60+ 个用例，日志会把断言输出淹掉
  //   （文件头的「测试里会传 false」说的就是这一行）。
  requestLog: false,
})

/** 本地形态：开 `/api/local/*`，不托管静态。 */
const local: HandlerBundle = await createHandlerFor({
  dshHome: localHome.home,
  dataDir: localData,
  enableLocalApi: true,
  requestLog: false,
})

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

// ── 请求小工具 ────────────────────────────────────────────────

interface Reply {
  status: number
  allow: string | null
  contentType: string | null
  text: string
  body: unknown
  /** 原始字节 —— 压缩响应只有它能验（`text` 会把 gzip 字节解成乱码）。 */
  bytes: Uint8Array
  etag: string | null
  cacheControl: string | null
  contentEncoding: string | null
  vary: string | null
  contentLength: string | null
}

const BASE = 'http://127.0.0.1:8787'

async function call(
  bundle: HandlerBundle,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const res = await bundle.handler(
    new Request(BASE + path, {
      method,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  )
  // ⚠️ 读 `arrayBuffer()` 而不是 `text()`：gzip 响应必须看**原始字节**才能解压，
  //    `text()` 会把 gzip 字节按 UTF-8 解成乱码。未压缩时两者结果逐字相同，
  //    所以既有的断言不受影响。
  const bytes = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return {
    status: res.status,
    allow: res.headers.get('allow'),
    contentType: res.headers.get('content-type'),
    text,
    body,
    bytes,
    etag: res.headers.get('etag'),
    cacheControl: res.headers.get('cache-control'),
    contentEncoding: res.headers.get('content-encoding'),
    vary: res.headers.get('vary'),
    contentLength: res.headers.get('content-length'),
  }
}

/** 取 `{ ok:false, reason }` 里的 reason。 */
function reason(reply: Reply): string {
  const b = reply.body as { reason?: unknown } | null
  return typeof b?.reason === 'string' ? b.reason : ''
}

const MEMBER = { Authorization: 'Bearer atr-zhangsan-9f3c' }
const ADMIN = { Authorization: 'Bearer atr-admin-0001' }
const JSON_HEADERS = { 'Content-Type': 'application/json' }

// ─────────────────────────────────────────────────────────────
describe('现状契约：静态托管', () => {
  test('命中真实文件 → 200 + 正确 Content-Type', async () => {
    const r = await call(dept, 'GET', '/app.js')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('text/javascript')
    expect(r.text).toContain('console.log')
  })

  test('index.html → 200 + text/html', async () => {
    const r = await call(dept, 'GET', '/index.html')
    expect(r.status).toBe(200)
    expect(r.contentType).toContain('text/html')
  })

  test('未知前端路由 → 回落 index.html（SPA 需要它）', async () => {
    const r = await call(dept, 'GET', '/members/ranking')
    expect(r.status).toBe(200)
    expect(r.text).toContain('ATR-PORTAL-INDEX')
  })

  test('★ 非法 URL 编码 → 400，不是 500', async () => {
    const r = await call(dept, 'GET', '/%zz')
    expect(r.status).toBe(400)
    expect(reason(r)).toContain('URL 编码')
  })

  test('★ 编码过的目录穿越不泄露 dist 之外的文件', async () => {
    const r = await call(dept, 'GET', '/%2e%2e/package.json')
    expect(r.text).not.toContain('@ai-token-report')
  })

  test('未配置 staticDir 时不托管（本地形态）', async () => {
    const r = await call(local, 'GET', '/anything')
    expect(r.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：健康检查', () => {
  test('GET /api/health → 200 + 四个字段', async () => {
    const r = await call(dept, 'GET', '/api/health')
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.initialized).toBe(true)
    // ★ 跟常量走：`scripts/deploy-server.mjs` 正是拿这个字段和本地代码期望的版本比对，
//   写死成旧数字会让每次部署都误报「上报库 schema 版本不一致」。
    expect(b.schema_version).toBe(PORTAL_SCHEMA_VERSION)
    expect(b.identity_storage).toBe('database')
    expect(b.localApi).toBe(false)
  })

  test('★ 健康检查不校验方法（探活工具常发 HEAD/POST）', async () => {
    expect((await call(dept, 'POST', '/api/health')).status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：POST /api/v1/token-usage', () => {
  test('缺 Authorization → 401（不是 200+ok:false）', async () => {
    const r = await call(dept, 'POST', '/api/v1/token-usage', {
      headers: JSON_HEADERS,
      body: '{"schemaVersion":1,"client":{},"records":[]}',
    })
    expect(r.status).toBe(401)
    expect(reason(r)).toContain('Authorization')
  })

  test('错误 token → 401', async () => {
    const r = await call(dept, 'POST', '/api/v1/token-usage', {
      headers: { ...JSON_HEADERS, Authorization: 'Bearer nope' },
      body: '{"schemaVersion":1,"client":{},"records":[]}',
    })
    expect(r.status).toBe(401)
  })

  test('★ GET → 405 且 Allow 头恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/token-usage')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
    expect(reason(r)).toBe('方法不允许')
  })

  test('非法 JSON → 400', async () => {
    const r = await call(dept, 'POST', '/api/v1/token-usage', {
      headers: { ...JSON_HEADERS, ...MEMBER },
      body: '{oops',
    })
    expect(r.status).toBe(400)
    expect(reason(r)).toContain('JSON')
  })

  test('★ Content-Length 超上限 → 413（在解析之前拦下）', async () => {
    const r = await call(dept, 'POST', '/api/v1/token-usage', {
      headers: { ...JSON_HEADERS, ...MEMBER, 'Content-Length': String(33 * 1024 * 1024) },
      body: '{}',
    })
    expect(r.status).toBe(413)
    expect(reason(r)).toContain('过大')
  })

  test('空批次 → 200 + 三个计数（归属服务端）', async () => {
    const r = await call(dept, 'POST', '/api/v1/token-usage', {
      headers: { ...JSON_HEADERS, ...MEMBER },
      body: '{"schemaVersion":1,"client":{"userName":"冒充者"},"generatedAt":"2026-01-01T00:00:00Z","records":[]}',
    })
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.accepted).toBe(0)
    expect(b.duplicates).toBe(0)
    expect(b.rejected).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：POST /api/v1/identity/verify', () => {
  test('★ 无 token 也回 200 + ok:false（业务结果，不是 HTTP 错误）', async () => {
    const r = await call(dept, 'POST', '/api/v1/identity/verify', {
      headers: JSON_HEADERS,
      body: '{}',
    })
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(false)
    expect(b.registered).toBe(true)
  })

  test('★ 非法 JSON 静默忽略 body，改看 Authorization 头', async () => {
    const r = await call(dept, 'POST', '/api/v1/identity/verify', {
      headers: { ...JSON_HEADERS, ...MEMBER },
      body: '{oops',
    })
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.name).toBe('张三')
  })

  test('GET → 405 且 Allow 恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/identity/verify')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：GET /api/v1/stats/*', () => {
  test('缺 Authorization → 401（响应体里是数据，不能是 200）', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/overview')
    expect(r.status).toBe(401)
  })

  test('POST → 405 且 Allow 恰好是 GET', async () => {
    const r = await call(dept, 'POST', '/api/v1/stats/overview')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('GET')
  })

  test('已知子路径 + 有效 token → 200', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/overview?period=today', { headers: MEMBER })
    expect(r.status).toBe(200)
  })

  test('未知子路径 → 404 且带上路径（便于排错）', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/nope', { headers: MEMBER })
    expect(r.status).toBe(404)
    expect(reason(r)).toBe('未找到 /api/v1/stats/nope')
  })

  test('多段子路径也走 404（与旧的前缀匹配一致）', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/a/b', { headers: MEMBER })
    expect(r.status).toBe(404)
    expect(reason(r)).toBe('未找到 /api/v1/stats/a/b')
  })

  test('★ 人员候选目录是看板接口：缺 Authorization → 401，带 token → 200', async () => {
    // 它喂的是筛选下拉，权限必须与其它看板接口同一道门（`stats:read`），
    // 而不是人员管理接口的 `members:read`。
    expect((await call(dept, 'GET', '/api/v1/stats/members')).status).toBe(401)
    const r = await call(dept, 'GET', '/api/v1/stats/members', { headers: MEMBER })
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('members')
  })

  /**
   * ★ 供应商候选目录同款：`stats:read` 一道门，且**不是** `providers:read`。
   *
   * 筛选下拉只需要「库里出现过哪些供应商名」；把供应商归一化的读权限
   * 绑到看板上，等于让一个下拉具备配置面的权限。
   */
  test('★ 供应商候选目录是看板接口：缺 Authorization → 401，带 token → 200', async () => {
    expect((await call(dept, 'GET', '/api/v1/stats/providers')).status).toBe(401)
    const r = await call(dept, 'GET', '/api/v1/stats/providers', { headers: MEMBER })
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('providers')
  })

  /**
   * ★ 数据范围的分发面契约：**非内置管理员只能查自己**。
   *
   * 这条与「页面隐藏人员下拉」是两件事 —— 手拼查询串同样拿不到别人的数据，
   * 否则任何人都能把看板换成「全公司」。
   */
  test('★ 非管理员点名别人 → 403；点自己与不带筛选 → 200；管理员不受限', async () => {
    const roster = (
      await call(dept, 'GET', '/api/v1/stats/members', { headers: MEMBER })
    ).body as { members: { member_id: string; name: string }[] }
    const zhang = roster.members.find((member) => member.name === '张三')!.member_id
    const manager = roster.members.find((member) => member.name === '李经理')!.member_id
    const overview = (query: string): Promise<Reply> =>
      call(dept, 'GET', `/api/v1/stats/overview?period=today&identity_view=member${query}`, { headers: MEMBER })

    // 不带人员筛选 = 「全部人员」：服务端**收窄成本人**，所以仍是 200 而不是 403
    expect((await overview('')).status).toBe(200)
    // 点自己允许 —— 人员详情抽屉发的就是它
    expect((await overview(`&member_id=${zhang}`)).status).toBe(200)
    // 🚨 点名别人：403，绝不静默替换成「我」（那会给出一个看起来正常的错答案）
    const denied = await overview(`&member_id=${manager}`)
    expect(denied.status).toBe(403)
    expect(reason(denied)).toContain('只能查看本人数据')
    // 未署名用量不属于任何个人，同样被拒（不是「查出 0 行」）
    expect((await overview('&unattributed=true')).status).toBe(403)
    // 管理员不受这条限制
    const allowed = await call(
      dept,
      'GET',
      `/api/v1/stats/overview?period=today&identity_view=member&member_id=${zhang}`,
      { headers: ADMIN },
    )
    expect(allowed.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：看板金额与单价快照（v7 / cost:read）', () => {
  /**
   * 🚨 这一组断言的核心只有一句话：**「没有权限」与「金额是 0」必须长得不一样**。
   *
   * 所以两边的判据都不是数值，而是**字段在不在**：
   *   - 无 `cost:read` → 响应体里**一个 `cost` 都不许出现**（连 `0` 都不许有）；
   *   - 有 `cost:read` → 字段恒在，哪怕这段时间一条用量都没有。
   *
   * ⚠️ 用的是共享的一个服务端与一个库（本文件的其它用例也在往里写数据），
   *   所以断言一律不依赖「有几行数据」。
   */
  test('★ 无 cost:read（member）：整个 cost 字段不下发，不是 0', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/overview?period=today', { headers: MEMBER })
    expect(r.status).toBe(200)
    expect(r.body).not.toHaveProperty('cost')
    expect(r.text).not.toContain('"cost"')
  })

  test('★ 有 cost:read（admin）：字段恒在，并带上单价来源', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/overview?period=today', { headers: ADMIN })
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('cost')
    const cost = r.body.cost as Record<string, unknown>
    // 未计价比例必须显式给出 —— 只给金额会让「没配价」看起来像「省了钱」。
    expect(cost).toHaveProperty('unpricedRate')
    expect(cost).toHaveProperty('unpricedTokens')
    expect(cost).toHaveProperty('costs')
    expect(cost).toHaveProperty('unpricedTargets')
    // 缺了来源就没法回答「这一屏是按哪份单价算的」，因此它与金额同进同出。
    expect(cost.pricing).toEqual({ pricingSource: 'db', pricingSyncedAt: null })
  })

  test('排行 / 趋势 / 明细：金额字段的存在性跟着权限走', async () => {
    for (const path of [
      '/api/v1/stats/breakdown?by=model&period=today',
      '/api/v1/stats/series?bucket=day&period=today',
      '/api/v1/stats/records?limit=5',
    ]) {
      const denied = await call(dept, 'GET', path, { headers: MEMBER })
      expect(denied.status).toBe(200)
      expect(denied.text).not.toContain('"cost"')

      const allowed = await call(dept, 'GET', path, { headers: ADMIN })
      expect(allowed.status).toBe(200)
      const rows = (allowed.body.rows ?? allowed.body.points ?? []) as Record<string, unknown>[]
      for (const row of rows) expect('cost' in row).toBe(true)
    }
  })

  test('★ 单价只读快照：member → 403（能看 token 不等于能看钱）', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/pricing', { headers: MEMBER })
    expect(r.status).toBe(403)
    expect(r.text).not.toContain('micro')
  })

  test('★ 单价只读快照：缺 Authorization → 401', async () => {
    expect((await call(dept, 'GET', '/api/v1/stats/pricing')).status).toBe(401)
  })

  test('★ 单价只读快照：admin → 200，且只含单价、不含任何用量', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/pricing', { headers: ADMIN })
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('prices')
    expect(r.body.pricing).toEqual({ pricingSource: 'db', pricingSyncedAt: null })
    const prices = r.body.prices as Record<string, unknown>[]
    for (const price of prices) {
      // 快照是**解释材料**：它必须能说清一条价的全部定义。
      for (const field of ['price_id', 'provider', 'model', 'currency', 'effective_from_ms', 'effective_to_ms']) {
        expect(price).toHaveProperty(field)
      }
    }
    // 它绝不该顺带把用量发出来 —— 这是它与其它 stats 子路径的边界。
    expect(r.text).not.toContain('totalTokens')
    expect(r.text).not.toContain('calls')
  })

  test('单价快照是 GET，POST → 405 且 Allow 恰好是 GET', async () => {
    const r = await call(dept, 'POST', '/api/v1/stats/pricing')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('GET')
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：/api/v1/admin/members*', () => {
  test('缺 Authorization → 401', async () => {
    expect((await call(dept, 'GET', '/api/v1/admin/members')).status).toBe(401)
  })

  test('★ member token → 403，且响应体里没有名单与 token', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/members', { headers: MEMBER })
    expect(r.status).toBe(403)
    expect(r.text).not.toContain('atr-')
    expect(r.text).not.toContain('李经理')
  })

  test('admin token → 200 且带名单', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/members', { headers: ADMIN })
    expect(r.status).toBe(200)
    expect(r.text).toContain('张三')
  })

  test('DELETE /members → 405 且 Allow 恰好是「GET, POST」', async () => {
    const r = await call(dept, 'DELETE', '/api/v1/admin/members')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('GET, POST')
  })

  test('GET /members/tokens/revoke → 405 且 Allow 恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/members/tokens/revoke')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
  })

  // ★ 与上一条同款：`app.ts` 的 POST 子路径是**枚举**注册的，漏写一条的表现是
  //   404（而不是打到下一个处理器），所以「删凭证」这条也要有一条契约钉住它。
  test('GET /members/tokens/delete → 405 且 Allow 恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/members/tokens/delete')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
  })

  test('★ POST /members/issue → 404 并指路（签发挂在 /members 上）', async () => {
    const r = await call(dept, 'POST', '/api/v1/admin/members/issue', {
      headers: { ...JSON_HEADERS, ...ADMIN },
      body: '{}',
    })
    expect(r.status).toBe(404)
    expect(reason(r)).toContain('/api/v1/admin/members')
  })

  test('拼错的子动作 → 404 带上路径', async () => {
    const r = await call(dept, 'POST', '/api/v1/admin/members/rotote', {
      headers: { ...JSON_HEADERS, ...ADMIN },
      body: '{}',
    })
    expect(r.status).toBe(404)
    expect(reason(r)).toBe('未找到 /api/v1/admin/members/rotote')
  })

  test('同名人员通过稳定 ID 独立创建', async () => {
    const r = await call(dept, 'POST', '/api/v1/admin/members', {
      headers: { ...JSON_HEADERS, ...ADMIN },
      body: JSON.stringify({ name: '张三', role_ids: ['00000000-0000-4000-8000-000000000002'] }),
    })
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect((b.member as { member_id: string }).member_id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：/api/v1/groups 与 /api/v1/admin/groups*', () => {
  test('缺 Authorization → 401（读目录与写目录都要身份）', async () => {
    expect((await call(dept, 'GET', '/api/v1/groups')).status).toBe(401)
    expect((await call(dept, 'POST', '/api/v1/admin/groups', { headers: JSON_HEADERS, body: '{}' })).status).toBe(401)
  })

  test('★ member token 读分组目录 → 200，但响应里只有目录（不含凭证或名单）', async () => {
    // 闸门是「权限码 ∩ Token scope」两把锁（见 http/auth.ts）：离线导入的普通
    // 成员凭证带着 `groups:read`（页面上的分组筛选要用），所以这里读得到。
    // ⚠️ 缺这一条 scope 的凭证（例如 appKey）会拿到 403 —— 那一条在
    //   `identity-database.test.ts` 里用 appKey 钉着。
    const r = await call(dept, 'GET', '/api/v1/groups', { headers: MEMBER })
    expect(r.status).toBe(200)
    expect(r.text).not.toContain('atr-')
  })

  test('admin token → 200，返回分组目录与稳定 ID', async () => {
    const r = await call(dept, 'GET', '/api/v1/groups', { headers: ADMIN })
    expect(r.status).toBe(200)
    const groups = (r.body as { groups: { group_id: string; name: string }[] }).groups
    expect(groups.map((g) => g.name)).toEqual(['研发一部'])
    expect(groups[0]!.group_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('★ 旧路径 /api/v1/departments 不再存在（改名没有留第二套路径）', async () => {
    // 留一个「旧路径也还能用」的后门，等于让页面同时依赖两套路径名，
    // 而这两套名字迟早会漂移；本接口的消费方只有本仓的页面，改名必须一次到位。
    expect((await call(dept, 'GET', '/api/v1/departments', { headers: ADMIN })).status).toBe(404)
  })

  test('POST /admin/groups 建组：重名 409、缺 name 400', async () => {
    const body = JSON.stringify({ name: '平台组' })
    const created = await call(dept, 'POST', '/api/v1/admin/groups', { headers: { ...JSON_HEADERS, ...ADMIN }, body })
    expect(created.status).toBe(200)
    expect((created.body as { group: { name: string } }).group.name).toBe('平台组')

    const duplicate = await call(dept, 'POST', '/api/v1/admin/groups', { headers: { ...JSON_HEADERS, ...ADMIN }, body })
    expect(duplicate.status).toBe(409)

    const missing = await call(dept, 'POST', '/api/v1/admin/groups', { headers: { ...JSON_HEADERS, ...ADMIN }, body: '{}' })
    expect(missing.status).toBe(400)
  })

  test('GET /admin/groups/status → 405 且 Allow 恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/groups/status')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
  })

  test('★ GET /api/v1/stats/groups 是看板接口（stats:read），不属于分组管理权限', async () => {
    const r = await call(dept, 'GET', '/api/v1/stats/groups', { headers: ADMIN })
    expect(r.status).toBe(200)
    const groups = (r.body as { groups: { name: string; status: string; member_count: number }[] }).groups
    expect(groups.map((g) => g.name)).toContain('研发一部')
    // member_count 是「当前关联人数」，不是事件数：下拉列表要能解释「这个组里有几个人」
    expect(groups.find((g) => g.name === '研发一部')!.member_count).toBeGreaterThan(0)
    expect(groups.find((g) => g.name === '研发一部')!.status).toBe('active')
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：/api/v1/admin/provider-aliases*（供应商归一化规则）', () => {
  test('缺 Authorization → 401（读目录与写规则都要身份）', async () => {
    expect((await call(dept, 'GET', '/api/v1/admin/provider-aliases')).status).toBe(401)
    expect((await call(dept, 'POST', '/api/v1/admin/provider-aliases', { headers: JSON_HEADERS, body: '{}' })).status).toBe(401)
  })

  test('admin 建规则 → 200，列表能读回；重复设置是 upsert 而不是新增', async () => {
    const body = JSON.stringify({ scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const created = await call(dept, 'POST', '/api/v1/admin/provider-aliases', { headers: { ...JSON_HEADERS, ...ADMIN }, body })
    expect(created.status).toBe(200)
    expect((created.body as { alias: { provider: string; alias: string } }).alias).toMatchObject({ provider: 'dashscope', alias: 'bailian-tpp' })

    const again = await call(dept, 'POST', '/api/v1/admin/provider-aliases', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify({ scope: 'global', provider: 'dashscope', alias: 'bailian' }) })
    expect(again.status).toBe(200)
    const list = await call(dept, 'GET', '/api/v1/admin/provider-aliases', { headers: ADMIN })
    expect(list.status).toBe(200)
    const aliases = (list.body as { aliases: { provider: string; alias: string }[] }).aliases
    expect(aliases.length).toBe(1)
    expect(aliases[0]!.alias).toBe('bailian')
  })

  test('非法形状 400：首尾空格的原始名、带 / 的归一化名、未知作用域', async () => {
    for (const payload of [
      { scope: 'global', provider: ' dashscope', alias: 'ok' },
      { scope: 'global', provider: 'dashscope', alias: 'a/b' },
      { scope: 'team', provider: 'dashscope', alias: 'ok' },
      { scope: 'global', provider: 'dashscope' },
    ]) {
      const r = await call(dept, 'POST', '/api/v1/admin/provider-aliases', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify(payload) })
      expect(r.status).toBe(400)
    }
  })

  test('★ 归一化名允许中文（展示名是给人看的）', async () => {
    const r = await call(dept, 'POST', '/api/v1/admin/provider-aliases', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify({ scope: 'global', provider: 'openai', alias: '开放人工智能' }) })
    expect(r.status).toBe(200)
    expect((r.body as { alias: { alias: string } }).alias.alias).toBe('开放人工智能')
  })

  test('普通成员（无 providers:read）读规则目录 → 403', async () => {
    // ★ 看板查询**不经过这个接口**：它用 stats:read 自己读规则表。
    //   所以「能看数据」的人不会因为缺这个权限就看到未归一化的名字，
    //   而「能改口径」这件事仍然只管在管理员手里。
    const r = await call(dept, 'GET', '/api/v1/admin/provider-aliases', { headers: MEMBER })
    expect(r.status).toBe(403)
  })

  test('GET /admin/provider-aliases/delete → 405 且 Allow 恰好是 POST', async () => {
    const r = await call(dept, 'GET', '/api/v1/admin/provider-aliases/delete')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('POST')
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：/api/v1/admin/pricing*（模型单价 / v7）', () => {
  /**
   * 一条合法的单价请求体；传 `over` 只改其中一两个字段。
   *
   * ⚠️ 这个文件里的用例**共用同一个服务端与同一个库**，所以每个用例都要用**自己的模型名**
   *（`priceBody({ model: '...' })`）并把断言限定在自己的那些行上 ——
   * 断言「列表长度是 1」会在别的用例先写过价时变成一个假失败。
   */
  const priceBody = (over: Record<string, unknown> = {}) => JSON.stringify({
    provider: 'deepseek-official', model: 'deepseek-v4.1-flash', currency: 'CNY',
    input_micro_per_ktok: 2_000, output_micro_per_ktok: 8_000,
    cache_read_micro_per_ktok: 200, cache_write_micro_per_ktok: 2_000,
    effective_from_ms: 0, ...over,
  })
  const write = (body: string, headers = ADMIN) => call(dept, 'POST', '/api/v1/admin/pricing', { headers: { ...JSON_HEADERS, ...headers }, body })
  /** 读回单价目录，按模型过滤成「本用例自己的行」。 */
  const rowsOf = async (model: string) => {
    const r = await call(dept, 'GET', '/api/v1/admin/pricing', { headers: ADMIN })
    expect(r.status).toBe(200)
    return (r.body as { prices: { model: string; input_micro_per_ktok: number }[] }).prices.filter((p) => p.model === model)
  }

  test('缺 Authorization → 401（读目录与写单价都要身份）', async () => {
    expect((await call(dept, 'GET', '/api/v1/admin/pricing')).status).toBe(401)
    expect((await call(dept, 'POST', '/api/v1/admin/pricing', { headers: JSON_HEADERS, body: '{}' })).status).toBe(401)
  })

  test('admin 写单价 → 200，列表能读回；同一 (provider, model, 起点) 是 upsert 而不是新增', async () => {
    const created = await write(priceBody({ model: 'contract-upsert' }))
    expect(created.status).toBe(200)
    const price = (created.body as { price: { model: string; input_micro_per_ktok: number } }).price
    expect(price).toMatchObject({ model: 'contract-upsert', input_micro_per_ktok: 2_000 })

    expect((await write(priceBody({ model: 'contract-upsert', input_micro_per_ktok: 2_500 }))).status).toBe(200)
    const rows = await rowsOf('contract-upsert')
    // upsert 没有多出行 —— 页面上「改一条价」与「加一条价」必须是两个不同的动作。
    expect(rows.length).toBe(1)
    expect(rows[0]!.input_micro_per_ktok).toBe(2_500)
  })

  test('★ 同一供应商下另一个模型各配各的价（粒度是 provider+model，不是一个供应商一个价）', async () => {
    expect((await write(priceBody({ model: 'contract-flash' }))).status).toBe(200)
    expect((await write(priceBody({ model: 'contract-pro', input_micro_per_ktok: 40_000 }))).status).toBe(200)
    expect((await rowsOf('contract-flash')).map((p) => p.input_micro_per_ktok)).toEqual([2_000])
    expect((await rowsOf('contract-pro')).map((p) => p.input_micro_per_ktok)).toEqual([40_000])
  })

  test('🚨 生效区间重叠 → 409（重叠会让金额取决于读取顺序，不能只靠数据库的 UNIQUE 索引）', async () => {
    expect((await write(priceBody({ model: 'contract-overlap', effective_from_ms: 1_000, effective_to_ms: 5_000 }))).status).toBe(200)
    // 右端交叉、完全被包含：数据库的 UNIQUE 只拦「起点完全相同」，这两种它拦不住。
    expect((await write(priceBody({ model: 'contract-overlap', effective_from_ms: 4_000, effective_to_ms: 9_000 }))).status).toBe(409)
    expect((await write(priceBody({ model: 'contract-overlap', effective_from_ms: 2_000, effective_to_ms: 3_000 }))).status).toBe(409)
    // 端点相接是合法的（区间两端都含），所以必须从已有终点的下一毫秒起。
    expect((await write(priceBody({ model: 'contract-overlap', effective_from_ms: 5_001, effective_to_ms: null }))).status).toBe(200)
    expect((await rowsOf('contract-overlap')).length).toBe(2)
  })

  test('非法形状 400：负单价、超过上限、非三位币种、终点早于起点、模型名带空格', async () => {
    for (const payload of [
      { input_micro_per_ktok: -1 },
      { input_micro_per_ktok: 10_000_001 },
      { input_micro_per_ktok: 1.5 },
      { currency: '人民币' },
      { effective_from_ms: 5_000, effective_to_ms: 1_000 },
      { model: ' contract-bad' },
    ]) {
      expect((await write(priceBody(payload))).status).toBe(400)
    }
    // 一条都没落库。
    expect((await rowsOf('deepseek-v4.1-flash')).length).toBe(0)
    expect((await rowsOf('contract-bad')).length).toBe(0)
  })

  test('种子初始化：缺 confirm → 400；单价表非空 → 409', async () => {
    await write(priceBody({ model: 'contract-seed' }))
    const noConfirm = await call(dept, 'POST', '/api/v1/admin/pricing/seed', { headers: { ...JSON_HEADERS, ...ADMIN }, body: '{}' })
    expect(noConfirm.status).toBe(400)
    const nonEmpty = await call(dept, 'POST', '/api/v1/admin/pricing/seed', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify({ confirm: true }) })
    expect(nonEmpty.status).toBe(409)
  })

  test('删除：200 后这一条就没了，再删一次 404（不静默成功）', async () => {
    const priceId = ((await write(priceBody({ model: 'contract-delete' }))).body as { price: { price_id: string } }).price.price_id
    expect((await rowsOf('contract-delete')).length).toBe(1)
    const del = await call(dept, 'POST', '/api/v1/admin/pricing/delete', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify({ price_id: priceId }) })
    expect(del.status).toBe(200)
    expect((await rowsOf('contract-delete')).length).toBe(0)
    const again = await call(dept, 'POST', '/api/v1/admin/pricing/delete', { headers: { ...JSON_HEADERS, ...ADMIN }, body: JSON.stringify({ price_id: priceId }) })
    expect(again.status).toBe(404)
  })

  test('🚨 普通成员读单价目录也是 403（单价是配置，不是「看一眼的数字」）', async () => {
    // ★ 与供应商归一化**刻意不同**：那边 `providers:read` 就能读，
    //   因为规则只影响名字怎么显示；单价决定每一笔费用怎么算，读也归 `pricing:manage`。
    await write(priceBody({ model: 'contract-member' }))
    expect((await call(dept, 'GET', '/api/v1/admin/pricing', { headers: MEMBER })).status).toBe(403)
    expect((await write(priceBody({ model: 'contract-member-2' }), MEMBER)).status).toBe(403)
    expect((await call(dept, 'POST', '/api/v1/admin/pricing/seed', { headers: { ...JSON_HEADERS, ...MEMBER }, body: JSON.stringify({ confirm: true }) })).status).toBe(403)
  })

  test('GET /admin/pricing/delete 与 /seed → 405 且 Allow 恰好是 POST', async () => {
    for (const path of ['/api/v1/admin/pricing/delete', '/api/v1/admin/pricing/seed']) {
      const r = await call(dept, 'GET', path)
      expect(r.status).toBe(405)
      expect(r.allow).toBe('POST')
    }
  })
})

// ─────────────────────────────────────────────────────────────
describe('现状契约：/api/local/*（本地形态启用时）', () => {
  test('GET /api/local/identity → 200 + signed:false', async () => {
    const r = await call(local, 'GET', '/api/local/identity')
    expect(r.status).toBe(200)
    const b = r.body as Record<string, unknown>
    expect(b.signed).toBe(false)
    expect(typeof b.hint).toBe('string')
  })

  test('★ GET 响应里绝不含 token', async () => {
    const r = await call(local, 'GET', '/api/local/identity')
    expect(r.text).not.toContain('atr-')
  })

  test('POST 非法 JSON → 400', async () => {
    const r = await call(local, 'POST', '/api/local/identity', {
      headers: JSON_HEADERS,
      body: '{oops',
    })
    expect(r.status).toBe(400)
  })

  test('DELETE → 200', async () => {
    expect((await call(local, 'DELETE', '/api/local/identity')).status).toBe(200)
  })

  test('PATCH → 405 且 Allow 是「GET, POST, DELETE」', async () => {
    const r = await call(local, 'PATCH', '/api/local/identity')
    expect(r.status).toBe(405)
    expect(r.allow).toBe('GET, POST, DELETE')
  })

  test('GET /api/local/stats/overview → 200', async () => {
    const r = await call(local, 'GET', '/api/local/stats/overview?period=today')
    expect(r.status).toBe(200)
  })

  test('POST /api/local/refresh → 200', async () => {
    expect((await call(local, 'POST', '/api/local/refresh')).status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────
describe('刻意变更：/api/* 未命中一律 JSON 404（不再是 200 HTML）', () => {
  /*
   * 旧行为：静态兜底对**所有 GET** 生效，排在 `/api/*` 判断之后，
   * 于是 `GET /api/不存在的路径` 会命中 index.html → **200 + text/html**。
   *
   * 为什么必须改：前端已经踩过这个坑 ——
   *
   *   packages/dsh-plugin/test/client/usage-store.test.ts:137
   *     test('200 但响应体不是 JSON（SPA 兜底返回了 HTML）', …)
   *
   * 一个「数据通道没装上」因此被渲染成「加载失败」，排障方向完全被带偏。
   * 改成 JSON 404 之后，「路径写错」与「服务没起来」在页面上就能区分开。
   */
  test('未知 API 路径 → 404 + JSON（部门形态）', async () => {
    const r = await call(dept, 'GET', '/api/nope')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
    expect(r.body).toEqual({ ok: false, reason: '未找到 /api/nope' })
  })

  test('未启用的 /api/local/* → 404 + JSON，而不是落进静态兜底', async () => {
    const r = await call(dept, 'GET', '/api/local/identity')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
  })

  test('未启用的 /api/local/refresh → 404 + JSON', async () => {
    const r = await call(dept, 'POST', '/api/local/refresh')
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
  })

  test('真正的静态路径仍然回落 index.html（只排除 /api/*）', async () => {
    const r = await call(dept, 'GET', '/members/ranking')
    expect(r.status).toBe(200)
    expect(r.text).toContain('ATR-PORTAL-INDEX')
  })
})

// ─────────────────────────────────────────────────────────────
describe('S12.3 静态托管：ETag / 304 / Cache-Control / HEAD / 压缩', () => {
  /*
   * 这一块钉的是 `http/static.ts` 的协商缓存语义，以及 `app.ts` 里
   * `staticOnly(compress())` / `staticOnly(etag())` 这两行接线。
   *
   * ⚠️ 仍然走 `createHandlerFor()` 的处理器（`new Request(...)` 直接喂进去），
   *   **不起真套接字**：「HEAD 在真连接上会不会挂起」「线上字节是不是 1f 8b」
   *   这类只有真 HTTP 才看得见的事，仍归 `test/e2e-*.ts` 与人工脚本。
   *
   * ★ 五条「重构时顺手就会改掉」的语义，各自由断言钉住：
   *   1. ETag 是**弱** ETag（同一 URL 在 gzip 与明文下字节不同，强 ETag
   *      按定义不能跨编码复用；`hono/compress` 也会把强 ETag 降级）；
   *   2. `immutable` 只给 `assets/` 下带 **8 位** hash 的 Vite 产物；
   *   3. 304 没有 body，但必须**保留** ETag 与 Cache-Control；
   *   4. HEAD 与 GET 的头逐字相同、只是没有 body；
   *   5. compress/etag 对 `/api/*` 一个头都不许改（那条契约由上面的
   *      「刻意变更」块与 e2e 钉着，这里只是从另一个方向再确认一次）。
   */
  const IMMUTABLE = 'public, max-age=31536000, immutable'

  test('★ 静态资源带弱 ETag（W/ 前缀）、由 size+mtime 派生', async () => {
    const r = await call(dept, 'GET', '/app.js')
    expect(r.status).toBe(200)
    expect(r.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
  })

  test('文件没变时 ETag 稳定（两次请求拿到同一个值）', async () => {
    const a = await call(dept, 'GET', '/app.js')
    const b = await call(dept, 'GET', '/app.js')
    expect(a.etag).not.toBeNull()
    expect(a.etag).toBe(b.etag)
  })

  test('★ hashed Vite 产物 → public, max-age=31536000, immutable', async () => {
    const r = await call(dept, 'GET', '/assets/index-abc12345.js')
    expect(r.status).toBe(200)
    expect(r.cacheControl).toBe(IMMUTABLE)
  })

  test('index.html → no-cache（每次刷新都要回源确认有没有新版）', async () => {
    const r = await call(dept, 'GET', '/index.html')
    expect(r.cacheControl).toBe('no-cache')
  })

  test('dist 根目录的普通文件 → no-cache', async () => {
    const r = await call(dept, 'GET', '/big.js')
    expect(r.cacheControl).toBe('no-cache')
  })

  test('★ assets/ 下**没有** 8 位 hash 的文件也是 no-cache（immutable 判据刻意收窄）', async () => {
    const r = await call(dept, 'GET', '/assets/index-abc123.js')
    expect(r.status).toBe(200)
    expect(r.cacheControl).toBe('no-cache')
  })

  test('★ SPA 回落的 index.html 也带 ETag + no-cache（否则每次刷新都在下载整份 HTML）', async () => {
    const r = await call(dept, 'GET', '/members/ranking')
    expect(r.status).toBe(200)
    expect(r.text).toContain('ATR-PORTAL-INDEX')
    expect(r.cacheControl).toBe('no-cache')
    expect(r.etag).toMatch(/^W\//)
  })

  test('★ If-None-Match 命中 → 304 且不带 body', async () => {
    const first = await call(dept, 'GET', '/app.js')
    const r = await call(dept, 'GET', '/app.js', { headers: { 'If-None-Match': first.etag ?? '' } })
    expect(r.status).toBe(304)
    expect(r.bytes.byteLength).toBe(0)
  })

  test('★ 304 仍保留 ETag 与 Cache-Control（下一次协商还得靠它们）', async () => {
    const first = await call(dept, 'GET', '/app.js')
    const r = await call(dept, 'GET', '/app.js', { headers: { 'If-None-Match': first.etag ?? '' } })
    expect(r.etag).toBe(first.etag)
    expect(r.cacheControl).toBe('no-cache')
  })

  test('If-None-Match 不匹配 → 200 + 完整 body（不能一律回 304）', async () => {
    const r = await call(dept, 'GET', '/app.js', { headers: { 'If-None-Match': 'W/"dead-beef"' } })
    expect(r.status).toBe(200)
    expect(r.text).toContain('console.log')
  })

  test('If-None-Match: * → 304', async () => {
    const r = await call(dept, 'GET', '/app.js', { headers: { 'If-None-Match': '*' } })
    expect(r.status).toBe(304)
  })

  test('★ SPA 回落同样能 304', async () => {
    const first = await call(dept, 'GET', '/members/ranking')
    const r = await call(dept, 'GET', '/members/ranking', {
      headers: { 'If-None-Match': first.etag ?? '' },
    })
    expect(r.status).toBe(304)
    expect(r.bytes.byteLength).toBe(0)
  })

  test('★ HEAD 命中静态资源 → 200（以前只认 GET，HEAD 会落进 JSON 404）', async () => {
    const r = await call(dept, 'HEAD', '/app.js')
    expect(r.status).toBe(200)
    expect(r.bytes.byteLength).toBe(0)
  })

  test('★ HEAD 与 GET 的头逐字一致，只是没有 body', async () => {
    const get = await call(dept, 'GET', '/app.js')
    const head = await call(dept, 'HEAD', '/app.js')
    expect(head.contentType).toBe(get.contentType)
    expect(head.etag).toBe(get.etag)
    expect(head.cacheControl).toBe(get.cacheControl)
    expect(head.contentLength).toBe(get.contentLength)
    expect(head.bytes.byteLength).toBe(0)
    expect(get.bytes.byteLength).toBeGreaterThan(0)
  })

  test('HEAD 未命中 → 走 SPA 回落，头与 GET 一致且无 body', async () => {
    const get = await call(dept, 'GET', '/members/ranking')
    const head = await call(dept, 'HEAD', '/members/ranking')
    expect(head.status).toBe(200)
    expect(head.contentType).toBe(get.contentType)
    expect(head.etag).toBe(get.etag)
    expect(head.bytes.byteLength).toBe(0)
  })

  test('HEAD + If-None-Match → 304 且无 body', async () => {
    const first = await call(dept, 'HEAD', '/app.js')
    const r = await call(dept, 'HEAD', '/app.js', { headers: { 'If-None-Match': first.etag ?? '' } })
    expect(r.status).toBe(304)
    expect(r.bytes.byteLength).toBe(0)
  })

  test('★ HEAD /%zz → 400（状态码与 GET 同源，不能只有 GET 特殊）', async () => {
    const r = await call(dept, 'HEAD', '/%zz')
    expect(r.status).toBe(400)
  })

  test('★ Accept-Encoding: gzip → 静态文本资源被压缩，且能解回原文', async () => {
    const plain = await call(dept, 'GET', '/big.js')
    const gz = await call(dept, 'GET', '/big.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.status).toBe(200)
    expect(gz.contentEncoding).toBe('gzip')
    expect(gunzipSync(gz.bytes).toString('utf8')).toBe(BIG_JS)
    expect(gz.bytes.byteLength).toBeLessThan(plain.bytes.byteLength)
  })

  test('压缩后加 Vary: Accept-Encoding、删掉 Content-Length（长度已被编码改变）', async () => {
    const gz = await call(dept, 'GET', '/big.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.vary).toBe('Accept-Encoding')
    expect(gz.contentLength).toBeNull()
  })

  test('小于 1024 字节的资源不压缩（阈值读的就是 Content-Length）', async () => {
    const r = await call(dept, 'GET', '/app.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(r.status).toBe(200)
    expect(r.contentEncoding).toBeNull()
    expect(r.text).toContain('console.log')
  })

  test('★ 压缩 + If-None-Match 命中 → 304，且 304 不带 Content-Encoding、无 body', async () => {
    const gz = await call(dept, 'GET', '/big.js', { headers: { 'Accept-Encoding': 'gzip' } })
    const r = await call(dept, 'GET', '/big.js', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.etag ?? '' },
    })
    expect(r.status).toBe(304)
    expect(r.bytes.byteLength).toBe(0)
    expect(r.contentEncoding).toBeNull()
  })

  test('★ 压缩前后的 ETag 一致（弱 ETag 才能这样跨编码复用）', async () => {
    const plain = await call(dept, 'GET', '/big.js')
    const gz = await call(dept, 'GET', '/big.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.etag).toBe(plain.etag)
  })

  test('🚨 /api/* 未命中仍是 JSON 404（压缩/ETag 中间件不许把它接走）', async () => {
    const r = await call(dept, 'GET', '/api/nope', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(r.status).toBe(404)
    expect(r.contentType).toContain('application/json')
    expect(r.body).toEqual({ ok: false, reason: '未找到 /api/nope' })
  })

  test('🚨 /api/* 的响应不带 Content-Encoding / ETag / Vary（一个头都不许改）', async () => {
    const missing = await call(dept, 'GET', '/api/nope', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(missing.contentEncoding).toBeNull()
    expect(missing.etag).toBeNull()
    expect(missing.vary).toBeNull()

    const health = await call(dept, 'GET', '/api/health', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(health.status).toBe(200)
    expect(health.contentEncoding).toBeNull()
    expect(health.etag).toBeNull()
  })

  test('🚨 编码穿越的 5 种写法都拿不到 dist 之外的文件', async () => {
    const paths = [
      '/%2e%2e/outside-secret.txt',
      '/..%2f..%2foutside-secret.txt',
      '/%2e%2e%2f%2e%2e%2foutside-secret.txt',
      '/..%5coutside-secret.txt',
      '/%2e%2e%5coutside-secret.txt',
    ]
    // 逐个请求、把**泄露的路径**收集起来再一次断言：失败时能直接看到是哪种写法漏了
    const leaks: string[] = []
    for (const p of paths) {
      const r = await call(dept, 'GET', p)
      if (r.text.includes(OUTSIDE_SECRET)) leaks.push(p)
    }
    expect(leaks).toEqual([])
  })

  test.skipIf(!symlinkAvailable)(
    '★ dist 里的符号链接指向外面 → 也拿不到（resolve() 只做字符串归一，拦不住它）',
    async () => {
      const r = await call(dept, 'GET', '/link.txt')
      expect(r.text).not.toContain(OUTSIDE_SECRET)
    },
  )
})
