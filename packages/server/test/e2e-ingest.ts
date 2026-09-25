/**
 * 端到端验证：真实 HTTP 走通「上报」全链路。
 *
 * 与 `ingest.test.ts` 的区别：那个直接调路由类，这里**真的起一个 HTTP 服务**，
 * 用真实的 `fetch` 打 `POST /api/v1/token-usage`，再回到库里核对落了什么。
 *
 * ```
 * bun run packages/server/test/e2e-ingest.ts
 * ```
 *
 * 覆盖的都是「只有跨进程才暴露」的性质：路由挂载、方法限制、
 * 状态码（401/400/405/413）、响应体里的三个计数、以及落库后的归属与分列。
 *
 * 载荷刻意用了**两种客户端的真实形状**：
 *   - CLI（`cli/src/deliver.ts` 的 `toWireRecord`，`client.name = dsh-token-stats`）
 *   - 插件（`dsh-plugin/src/fold.ts` 的 `toWireRecord`，`client.name = dsh-token-report`）
 * 两者字段必须被同一个服务端原样接受 —— 这是「幂等键让多个上报方共存」的前提。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EVENT_TABLE, openDb } from '@ai-token-report/core/db'
import type { IngestPayload, IngestResponse } from '@ai-token-report/shared'

import { createServer } from '../src/index.js'

const home = mkdtempSync(join(tmpdir(), 'atr-e2e-ingest-'))
const PORT = 18801

mkdirSync(join(home, 'token-report'), { recursive: true })
const credPath = join(home, 'token-report', 'credentials.json')
const dbPath = join(home, 'token-report', 'portal.sqlite')
writeFileSync(
  credPath,
  JSON.stringify([
    { token: 'atr-zhangsan-9f3c', name: '张三', dept: '研发一部' },
    { token: 'atr-lisi-a17b', name: '李四', dept: '研发二部' },
  ]),
  'utf8',
)

let passed = 0
let failed = 0

function check(label: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

/** 一条线上记录（下划线字段，四个 token 分列）。 */
function record(eventId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: eventId,
    session_id: 'session-63fe9359',
    seq: 17,
    ts: 1_790_245_427_069,
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    input_tokens: 10_882,
    output_tokens: 1,
    cache_read_tokens: 1024,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 11_907,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** CLI 形状的载荷。 */
function cliPayload(records: unknown[]): IngestPayload {
  return {
    schemaVersion: 1,
    // ⚠️ client 里的名字是**客户端自称**，服务端必须忽略它
    client: { name: 'dsh-token-stats', userId: 'zhangsan', userName: '张三', dept: '研发一部' },
    generatedAt: new Date().toISOString(),
    records: records as IngestPayload['records'],
  }
}

/** 插件形状的载荷（`client.name` 不同，字段相同）。 */
function pluginPayload(records: unknown[]): IngestPayload {
  return {
    schemaVersion: 1,
    client: { name: 'dsh-token-report', userId: '张三', userName: '张三', dept: '研发一部' },
    generatedAt: new Date().toISOString(),
    records: records as IngestPayload['records'],
  }
}

const endpoint = (): string => `http://127.0.0.1:${PORT}/api/v1/token-usage`

async function post(
  body: unknown,
  token?: string,
  raw = false,
): Promise<{ status: number; body: IngestResponse & { ok?: boolean; reason?: string } }> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? (body as string) : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 非 JSON 响应也照原样返回，让断言能看到 status */
  }
  return { status: res.status, body: parsed as IngestResponse }
}

/** 库里某人的行数。 */
function countByUser(userName: string): number {
  const db = openDb(dbPath)
  try {
    return (
      db
        .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE} WHERE user_name = ?`)
        .get([userName])?.c ?? 0
    )
  } finally {
    db.close()
  }
}

/** 库里总行数。 */
function totalRows(): number {
  const db = openDb(dbPath)
  try {
    return db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`).get()?.c ?? 0
  } finally {
    db.close()
  }
}

// ── 1. 起服务 ───────────────────────────────────────────────────────────────
console.log('\n【1】启动部门服务端')
const portal = await createServer({
  port: PORT,
  host: '127.0.0.1',
  dshHome: home,
  dbPath,
  credentialsPath: credPath,
  enableLocalApi: false,
})
console.log(`  服务端: ${portal.url}`)

const health = await (await fetch(`${portal.url}/api/health`)).json()
check('健康检查：凭证已登记', health.credentialsRegistered === true)
check('健康检查：凭证数量 2', health.credentialCount === 2)
check('健康检查：未启用本地 API（部门形态）', health.localApi === false)

// ── 2. 正常上报（CLI 形态）──────────────────────────────────────────────────
console.log('\n【2】CLI 形态上报 3 条')
const first = await post(cliPayload([record('session-a:1'), record('session-a:2'), record('session-b:1')]), 'atr-zhangsan-9f3c')
check('HTTP 200', first.status === 200, String(first.status))
check('accepted=3', first.body.accepted === 3, JSON.stringify(first.body))
check('duplicates=0', first.body.duplicates === 0)
check('rejected=0', first.body.rejected === 0)
check('库里 3 行', totalRows() === 3)
check('★ 归属落在 token 对应的人身上（张三）', countByUser('张三') === 3)

// ── 3. 幂等：同一批重发 ─────────────────────────────────────────────────────
console.log('\n【3】同一批重发（插件与 CLI 会同时上报，重发是常态）')
const second = await post(cliPayload([record('session-a:1'), record('session-a:2'), record('session-b:1')]), 'atr-zhangsan-9f3c')
check('HTTP 200（重复不是错误）', second.status === 200)
check('accepted=0', second.body.accepted === 0, JSON.stringify(second.body))
check('duplicates=3', second.body.duplicates === 3)
check('库里仍是 3 行（没有重复计费）', totalRows() === 3)

// ── 4. 插件形态 + 混合批次 ──────────────────────────────────────────────────
console.log('\n【4】插件形态上报：1 条新增 + 1 条重复 + 1 条坏行')
const mixed = await post(
  pluginPayload([
    record('session-c:17'),
    record('session-a:1'), // 重复
    record('session-d:1', { input_tokens: -5 }), // 坏行
  ]),
  'atr-lisi-a17b',
)
check('accepted=1', mixed.body.accepted === 1, JSON.stringify(mixed.body))
check('duplicates=1', mixed.body.duplicates === 1)
check('rejected=1（只有坏行被拒）', mixed.body.rejected === 1)
check('★ 新行归属到李四（不是请求体里自称的张三）', countByUser('李四') === 1)

// ── 5. 鉴权失败 ─────────────────────────────────────────────────────────────
console.log('\n【5】鉴权失败必须是非 2xx')
const before = totalRows()
const wrongToken = await post(cliPayload([record('session-e:1')]), 'wrong-token')
check('★ 错误 token → 401', wrongToken.status === 401, String(wrongToken.status))
check('响应体带可读原因', typeof wrongToken.body.reason === 'string')
check('★ 未落库（一条都没多）', totalRows() === before)

const noAuth = await post(cliPayload([record('session-e:1')]))
check('★ 缺 Authorization → 401', noAuth.status === 401, String(noAuth.status))
check('未落库', totalRows() === before)

// ── 6. 协议与请求格式 ───────────────────────────────────────────────────────
console.log('\n【6】协议与请求格式')
const higher = await post({ ...cliPayload([record('session-e:1')]), schemaVersion: 99 }, 'atr-zhangsan-9f3c')
check('协议版本高于服务端 → 400', higher.status === 400, String(higher.status))
check('原因里带上版本号，便于定位', String(higher.body.reason).includes('99'))

const badJson = await post('{ 这不是 JSON', 'atr-zhangsan-9f3c', true)
check('非法 JSON → 400', badJson.status === 400, String(badJson.status))

const getRes = await fetch(endpoint())
check('GET → 405（只收 POST）', getRes.status === 405, String(getRes.status))
check('405 带 Allow 头', getRes.headers.get('allow') === 'POST')

// ── 7. 落库内容核对 ─────────────────────────────────────────────────────────
console.log('\n【7】回到库里核对落了什么')
const db = openDb(dbPath)
try {
  const cols = db
    .query<{ name: string }, []>(`PRAGMA table_info(${EVENT_TABLE})`)
    .all()
    .map((c) => c.name)
  check('★ 四个 token 是四个独立列', ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].every((c) => cols.includes(c)))
  check('★ 库里没有 total 列（派生口径不落库）', !cols.includes('total_tokens'))
  check('归属三列存在', ['user_id', 'user_name', 'dept'].every((c) => cols.includes(c)))

  const row = db
    .query<
      {
        user_id: string
        user_name: string
        dept: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        cwd: string
      },
      [string]
    >(
      `SELECT user_id, user_name, dept, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cwd
       FROM ${EVENT_TABLE} WHERE event_id = ?`,
    )
    .get(['session-a:1'])
  check('归属 = 张三 / 研发一部', row?.user_name === '张三' && row?.dept === '研发一部', JSON.stringify(row))
  check(
    '四项 token 与上报值逐位一致',
    row?.input_tokens === 10_882 && row?.output_tokens === 1 && row?.cache_read_tokens === 1024 && row?.cache_write_tokens === 0,
    JSON.stringify(row),
  )
  check('cwd 保留（项目归属）', row?.cwd === 'D:\\Coding\\ai-token-report')
} finally {
  db.close()
}

// 两个上报方各写各的：插件与 CLI 都不需要知道对方存在
check('两条通路各自入库（张三 3 条 + 李四 1 条）', countByUser('张三') === 3 && countByUser('李四') === 1)

// ── 8. 本地形态同样收上报 ───────────────────────────────────────────────────
console.log('\n【8】单机形态（enableLocalApi）也注册上报接口')
const local = await createServer({
  port: PORT + 1,
  host: '127.0.0.1',
  dshHome: home,
  dbPath: join(home, 'token-report', 'portal-local.sqlite'),
  credentialsPath: credPath,
  enableLocalApi: true,
})
const localRes = await fetch(`${local.url}/api/v1/token-usage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer atr-zhangsan-9f3c' },
  body: JSON.stringify(cliPayload([record('session-f:1')])),
})
const localBody = (await localRes.json()) as IngestResponse
check('本地形态也接受上报（插件默认指向 127.0.0.1:8787）', localRes.status === 200 && localBody.accepted === 1)
await local.stop()

// ── 清理 ────────────────────────────────────────────────────────────────────
await portal.stop()
rmSync(home, { recursive: true, force: true })

console.log(`\n${'─'.repeat(50)}`)
console.log(`结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)