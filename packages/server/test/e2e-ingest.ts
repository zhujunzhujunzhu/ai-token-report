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
 *   - CLI（`cli/src/deliver.ts` 的 `toWireRecord`，用 `client.group`）
 *   - 插件（`dsh-plugin/src/fold.ts` 的 `toWireRecord`，用旧字段名 `client.dept`）
 * 两者字段必须被同一个服务端原样接受 —— 这是「幂等键让多个上报方共存」的前提。
 * ⚠️ `client.name` 两边现在报**同一个值**（`ai-token-report`）：它只是诊断字段，
 *   服务端不落库、也不参与归属，所以这里刻意**不**靠它区分两种形状。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EVENT_TABLE, openDb, PORTAL_SCHEMA_VERSION } from '@ai-token-report/core/db'
import type { IngestPayload, IngestResponse } from '@ai-token-report/shared'

import { createServer } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const home = mkdtempSync(join(tmpdir(), 'atr-e2e-ingest-'))
// ★ 数据目录**不跟随 DSH_HOME**：缺省在家目录下（~/.ai-token-report）。
//   不显式指定的话，服务端会去开使用者真实的上报库 / 身份文件（还会把署名写进去）。
const DATA_DIR = join(home, 'token-report')
const PORT = 18801

mkdirSync(DATA_DIR, { recursive: true })
const credPath = join(DATA_DIR, 'credentials.json')
const dbPath = join(DATA_DIR, 'portal.sqlite')
writeFileSync(
  credPath,
  JSON.stringify([
    { token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' },
    { token: 'atr-lisi-a17b', name: '李四', group: '研发二部' },
  ]),
  'utf8',
)
await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' },
  { token: 'atr-lisi-a17b', name: '李四', group: '研发二部' },
])

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
    client: { name: 'ai-token-report', userId: 'zhangsan', userName: '张三', group: '研发一部' },
    generatedAt: new Date().toISOString(),
    records: records as IngestPayload['records'],
  }
}

/** 插件形状的载荷（与 CLI 只差分组字段名：`dept` 而非 `group`）。 */
function pluginPayload(records: unknown[]): IngestPayload {
  return {
    schemaVersion: 1,
    // ⚠️ 这里刻意沿用**旧字段名 `dept`**：已部署的旧插件发的就是它。
    //   服务端按 `client.group ?? client.dept` 落进 `usage_event.group_name`，
    //   丢掉这条兼容不会有任何报错，只会让这些机器的分组快照永久变成 NULL。
    client: { name: 'ai-token-report', userId: '张三', userName: '张三', dept: '研发一部' },
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
  dataDir: DATA_DIR,
  dbPath,
  mysqlUrl: '',
  enableLocalApi: false,
})
console.log(`  服务端: ${portal.url}`)

const health = await (await fetch(`${portal.url}/api/health`)).json()
check('健康检查：身份已入库', health.initialized === true)
// ★ 跟常量走：写死版本号会在上报库升版后一直「通过」，而这个字段正是部署脚本
  //   用来判断「服务器上的库和本地代码是不是同一版」的依据 —— 断言错了等于护栏失灵。
  check(`健康检查：schema v${PORTAL_SCHEMA_VERSION}`, health.schema_version === PORTAL_SCHEMA_VERSION)
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
  check('归属列存在（分组列是文本快照 group_name）', ['user_id', 'user_name', 'group_name'].every((c) => cols.includes(c)))
  // v5 删掉了事件上的分组 ID 列：一个事件属于哪些分组，由它的 member_id 从关联表展开 ——
  // 单值列在结构上表达不了「同时属于两个分组」。
  check('★ 事件里不再存分组 ID（归属由 member_group_assignments 展开）', !cols.includes('department_id'))

  const row = db
    .query<
      {
        user_id: string
        user_name: string
        group_name: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        cwd: string
      },
      [string]
    >(
      `SELECT user_id, user_name, group_name, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cwd
       FROM ${EVENT_TABLE} WHERE event_id = ?`,
    )
    .get(['session-a:1'])
  check('归属 = 张三 / 研发一部', row?.user_name === '张三' && row?.group_name === '研发一部', JSON.stringify(row))
  check(
    '四项 token 与上报值逐位一致',
    row?.input_tokens === 10_882 && row?.output_tokens === 1 && row?.cache_read_tokens === 1024 && row?.cache_write_tokens === 0,
    JSON.stringify(row),
  )
  check('cwd 保留（项目归属）', row?.cwd === 'D:\\Coding\\ai-token-report')
  // ★ 这一行来自**插件形状**的载荷（它发的还是旧字段 `dept`）：
  //   兼容路径必须真的把值写进新列名 group_name，而不是静默丢成 NULL。
  const legacy = db
    .query<{ user_name: string; group_name: string | null }, [string]>(
      `SELECT user_name, group_name FROM ${EVENT_TABLE} WHERE event_id = ?`,
    )
    .get(['session-c:17'])
  check(
    '★ 旧客户端的 client.dept 仍落进 group_name（刻意保留的兼容）',
    legacy?.user_name === '李四' && legacy?.group_name === '研发一部',
    JSON.stringify(legacy),
  )
} finally {
  db.close()
}

// 两个上报方各写各的：插件与 CLI 都不需要知道对方存在
check('两条通路各自入库（张三 3 条 + 李四 1 条）', countByUser('张三') === 3 && countByUser('李四') === 1)

// ── 8. 本地形态同样收上报 ───────────────────────────────────────────────────
console.log('\n【8】单机形态（enableLocalApi）也注册上报接口')
await seedDatabaseIdentity({ sqlitePath: join(DATA_DIR, 'portal-local.sqlite') }, [
  { token: 'atr-zhangsan-9f3c', name: '张三', group: '研发一部' },
])
const local = await createServer({
  port: PORT + 1,
  host: '127.0.0.1',
  dshHome: home,
  dataDir: DATA_DIR,
  dbPath: join(DATA_DIR, 'portal-local.sqlite'),
  mysqlUrl: '',
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
