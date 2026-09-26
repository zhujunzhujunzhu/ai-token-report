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
    { token: 'atr-zhangsan-9f3c', name: '张三', dept: '研发一部' },
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
const localHome = makeHome('local')
await seedDatabaseIdentity({ sqlitePath: join(deptHome.home, 'token-report', 'portal.sqlite') }, JSON.parse(CREDENTIALS))

/** 部门形态：开静态托管，**关** `/api/local/*`。 */
const dept: HandlerBundle = await createHandlerFor({
  dshHome: deptHome.home,
  staticDir: deptHome.staticDir,
  enableLocalApi: false,
  // ⚠️ 关掉访问日志：本文件有 60+ 个用例，日志会把断言输出淹掉
  //   （文件头的「测试里会传 false」说的就是这一行）。
  requestLog: false,
})

/** 本地形态：开 `/api/local/*`，不托管静态。 */
const local: HandlerBundle = await createHandlerFor({
  dshHome: localHome.home,
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
    expect(b.schema_version).toBe(4)
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
