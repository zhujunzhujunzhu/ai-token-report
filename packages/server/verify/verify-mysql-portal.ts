/**
 * 部门上报库接 MySQL 的**活体验证**（真 HTTP + 真 MySQL），不进 `bun test`。
 *
 * ```bash
 * bun run packages/server/verify/verify-mysql-portal.ts
 * # 或指定连接串：ATR_MYSQL_URL='mysql://user:pass@127.0.0.1:3307/ai_token_report'
 * ```
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ★ **换后端不该改变任何一个数字。**
 *
 * 因此它用**同一个临时 home、同一份凭证、同一批上报数据**分别起两个服务端
 * （一个写 SQLite 上报库，一个写 MySQL），然后把两边 `/api/v1/stats/*` 的
 * 响应**逐位比对**（`overview` / `series` / `breakdown` 各维度 / `records`）。
 *
 * 这是唯一能发现「方言/驱动漂移」的检查。MySQL 侧有三处实测坑，
 * 它们的共性都是**不报错、只是数字变错**（详见 `core/src/db/dialect.ts`）：
 *
 * | 坑 | 猜错的表现 | 本脚本怎么钉住 |
 * |---|---|---|
 * | `provider \|\| '/' \|\| model` 是**逻辑或** | 分组键静默变成 `0`/`1` | 断言 `provider-model` 的键是 `a/b` 拼接结果 |
 * | `SUM(BIGINT)` 返回**字符串** | 看板数字变 `NaN` 或字符串拼接 | 逐位比对两侧数字（字符串拼接必然对不上） |
 * | `key` 是**保留字** | 语法错误（会报错，好抓） | 分组查询能跑通即证明 |
 *
 * ## 为什么现在走 `createServer()`
 *
 * 早期版本是手工装配路由的（当时 `index.ts` 还没有 `mysqlUrl` 选项，那处在另一个
 * 会话的改动里）。现在 `index.ts` 已接上，本脚本改用**生产入口**：
 * `createServer({ dshHome, dbPath, mysqlUrl })` —— 于是它顺带覆盖了
 * 「配置怎么走到路由」这一段，以及启动横幅的**脱敏**（`ATR_MYSQL_URL` 里带密码，
 * 而启动日志经常被贴进工单）。手工装配会绕过这两处，正是「脚本全绿但线上配不上」
 * 的经典盲区。
 *
 * 每次创建随机 atr_http_v4_* 隔离库，显式导入夹具身份；结束后删除该隔离库。
 * 管理连接取 ATR_V4_TEST_MYSQL_URL 或本机开发容器，不打开现有业务库。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeAllMysqlBackends,
  openPortalStore,
  type PortalStore,
} from '@ai-token-report/core/db'

// ★ 用**生产入口** `createServer()` 而不是手工装配路由：这样脚本顺带覆盖
//   了「`mysqlUrl` 怎么从配置走到路由」这一段（`index.ts` 的接线 + 脱敏横幅），
//   而手工装配会绕过它 —— 那正是「脚本全绿但线上配不上」的经典盲区。
import { createServer } from '../src/index.js'
import { seedDatabaseIdentity } from '../test/database-fixture.js'
import { createIsolatedMysql } from './mysql-isolation.js'

// ── 配置 ────────────────────────────────────────────────────────────────────

/**
 * 使用本次专属隔离库；管理连接和密码不打印。
 */
const isolation = await createIsolatedMysql()
const MYSQL_URL = isolation.url

/**
 * 从连接串里取出密码 —— 只用于断言「启动横幅里绝不出现它」。
 *
 * ⚠️ 别把它打印出来（包括断言失败时的 `extra`）。
 */
const PASSWORD = /\/\/[^:/?#]+:([^@]*)@/.exec(MYSQL_URL)?.[1] ?? ''

/** 本脚本造的行统一带这个前缀，清理时按它精确删（不扫全表删除）。 */
const SESSION_PREFIX = 'verify-mysql-portal'

const SQLITE_PORT = 18901
const MYSQL_PORT = 18902

const TOKENS = {
  zhang: 'atr-verify-zhang-0001',
  li: 'atr-verify-li-0002',
}

// ── 断言脚手架 ──────────────────────────────────────────────────────────────

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

/** 逐位比对两侧的载荷（JSON 全等，含键序无关的数字与字符串）。 */
function same(label: string, a: unknown, b: unknown): void {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  check(label, sa === sb, sa === sb ? '' : `\n     SQLite: ${sa}\n     MySQL : ${sb}`)
}

// ── 临时环境 ────────────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'atr-verify-mysql-'))
const credPath = join(home, 'token-report', 'credentials.json')
mkdirSync(join(home, 'token-report'), { recursive: true })
writeFileSync(
  credPath,
  JSON.stringify(
    [
      { token: TOKENS.zhang, name: '张三', dept: '研发一部' },
      { token: TOKENS.li, name: '李四', dept: '研发二部' },
    ],
    null,
    2,
  ),
  'utf8',
)

/** SQLite 服务端的库文件（MySQL 侧刻意也传一个路径，用来验证它**没被创建**）。 */
const sqliteDbPath = join(home, 'sqlite-side', 'portal.sqlite')
const mysqlSideDbPath = join(home, 'mysql-side', 'portal.sqlite')

// ── 造数：同一批上报数据 ────────────────────────────────────────────────────

/** 今天某个时刻（保证落在 `period=today` 窗口内，两侧窗口必然相同）。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

interface WireRecord {
  event_id: string
  session_id: string
  seq: number
  ts: number
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  total_tokens: number
  cwd: string
  turn: number
  step: number
}

function rec(
  sessionId: string,
  seq: number,
  ts: number,
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cwd: string,
  cacheWrite = 0,
): WireRecord {
  return {
    event_id: `${sessionId}:${seq}`,
    session_id: `${SESSION_PREFIX}-${sessionId}`,
    seq,
    ts,
    provider,
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: 0,
    // ⚠️ 故意给一个**错**的 total：库里没有这一列（铁律 2），两侧都必须忽略它。
    total_tokens: input + output + cacheRead + 999_999,
    cwd,
    turn: 1,
    step: seq,
  }
}

/**
 * 五个事件，覆盖 2 个人 / 4 个会话 / 2 个厂商 / 3 个模型 / 2 个项目。
 *
 * ⚠️ ts 刻意各不相同：`records` 的定序是 `(ts DESC, seq DESC)`，
 *   ts 相同就要靠 seq 决出次序 —— 两侧必须给出**同一个顺序**。
 */
const BATCH_ZHANG: WireRecord[] = [
  rec('s1', 1, todayAt(9), 'dashscope', 'deepseek-v4.1-flash', 10_882, 1, 1_024, 'D:\\Coding\\proj-a', 130),
  rec('s1', 2, todayAt(10), 'dashscope', 'deepseek-v4.1-flash', 120, 30, 98_976, 'D:\\Coding\\proj-a'),
  rec('s2', 1, todayAt(11), 'openai', 'gpt-4o', 500, 60, 3_000, 'D:\\Coding\\proj-b'),
]
const BATCH_LI: WireRecord[] = [
  rec('s3', 1, todayAt(13), 'dashscope', 'qwen-max', 777, 88, 4_321, 'D:\\Coding\\proj-b'),
  rec('s4', 1, todayAt(14), 'dashscope', 'deepseek-v4.1-flash', 1, 2, 3, 'D:\\Coding\\proj-b'),
]

/** 脚本自己算出的期望值：用来证明「两边相等」不是「两边都空/都错」。 */
const ALL = [...BATCH_ZHANG, ...BATCH_LI]
const EXPECTED_INPUT = ALL.reduce((n, r) => n + r.input_tokens, 0)
const EXPECTED_OUTPUT = ALL.reduce((n, r) => n + r.output_tokens, 0)
const EXPECTED_CACHE_READ = ALL.reduce((n, r) => n + r.cache_read_tokens, 0)
const EXPECTED_CACHE_WRITE = ALL.reduce((n, r) => n + r.cache_write_tokens, 0)
const EXPECTED = {
  events: ALL.length,
  calls: ALL.length,
  sessions: new Set(ALL.map((r) => r.session_id)).size,
  users: 2,
  input: EXPECTED_INPUT,
  output: EXPECTED_OUTPUT,
  cacheRead: EXPECTED_CACHE_READ,
  cacheWrite: EXPECTED_CACHE_WRITE,
  // 非零缓存写入必须独立返回，不能只藏在总量里。
  total: EXPECTED_INPUT + EXPECTED_OUTPUT + EXPECTED_CACHE_READ + EXPECTED_CACHE_WRITE,
}

function payload(records: WireRecord[], userName: string): unknown {
  return {
    schemaVersion: 1,
    // ⚠️ 客户端自称的名字必须被服务端忽略（归属只信 token）
    client: { name: 'dsh-token-report', userId: 'someone-else', userName, dept: '研发九部' },
    generatedAt: new Date().toISOString(),
    records,
  }
}

// ── 起服务（两个后端，同一套真实组件）──────────────────────────────────────

interface RunningServer {
  label: string
  url: string
  /** 启动横幅里那段上报库描述（`createServer` 已脱敏）。 */
  portalTargetLabel: string
  stop(): Promise<void>
}

async function startServer(opts: {
  label: string
  port: number
  dbPath: string
  mysqlUrl?: string
}): Promise<RunningServer> {
  await seedDatabaseIdentity({ sqlitePath: opts.dbPath, ...(opts.mysqlUrl ? { mysqlUrl: opts.mysqlUrl } : {}) }, [
    { token: TOKENS.zhang, name: '张三', dept: '研发一部' },
    { token: TOKENS.li, name: '李四', dept: '研发二部' },
  ])
  // ★ 生产入口：凭证表、三条路由、应用装配、端口重试全在里面。
  //   `credentialsPath` 由 `dshHome` 推导（`<home>/token-report/credentials.json`），
  //   与 fixture 写下的位置一致。
  //   ⚠️ `requestLog: false`：脚本会打几十个请求，访问日志会把断言淹掉。
  const handle = await createServer({
    port: opts.port,
    host: '127.0.0.1',
    dshHome: home,
    dbPath: opts.dbPath,
    // SQLite 对照组必须显式屏蔽环境变量，否则 ATR_MYSQL_URL 会让两端写进同一个库。
    mysqlUrl: opts.mysqlUrl ?? '',
    requestLog: false,
  })
  return {
    label: opts.label,
    url: handle.url,
    portalTargetLabel: handle.portalTargetLabel,
    stop: () => handle.stop(),
  }
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

async function post(
  server: RunningServer,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/api/v1/token-usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function stats(
  server: RunningServer,
  sub: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${server.url}/api/v1/stats/${sub}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${TOKENS.zhang}` },
  })
  const body = (await res.json()) as Record<string, unknown>
  if (res.status !== 200) {
    throw new Error(`${server.label} /api/v1/stats/${sub} → ${res.status} ${JSON.stringify(body)}`)
  }
  return body
}

let sqlite: RunningServer | null = null
let mysql: RunningServer | null = null
let mysqlStore: PortalStore | null = null
/** 跑之前 MySQL 里 `ingest_run.last_ingest_ms` 的原值（跑完要还回去）。 */
let previousIngestMoment: number | null = null

// ── 主流程 ──────────────────────────────────────────────────────────────────

try {
  console.log('='.repeat(72))
  console.log('部门上报库双后端对照：SQLite vs MySQL（真 HTTP + 真 MySQL）')
  console.log('='.repeat(72))
  console.log(`MySQL : ${MYSQL_URL.replace(/\/\/([^:/?#]+):([^@]*)@/, '//$1:***@')}`)
  console.log(`临时 home: ${home}\n`)

  // ── 1. 起两个服务端 ──────────────────────────────────────────────────────
  console.log('【1】起两个服务端（同一批凭证，不同后端）')
  sqlite = await startServer({ label: 'sqlite', port: SQLITE_PORT, dbPath: sqliteDbPath })
  mysql = await startServer({
    label: 'mysql',
    port: MYSQL_PORT,
    dbPath: mysqlSideDbPath,
    mysqlUrl: MYSQL_URL,
  })
  console.log(`  SQLite 服务端: ${sqlite.url}`)
  console.log(`  MySQL  服务端: ${mysql.url}`)

  // ★ 横幅脱敏：`ATR_MYSQL_URL` 里带密码，而启动日志经常被贴进工单与聊天记录。
  //   这一段是**生产入口**（`createServer`）产出的，不是脚本自己拼的。
  check(
    '★ MySQL 服务端的横幅描述指向 MySQL',
    mysql.portalTargetLabel.includes('MySQL'),
    mysql.portalTargetLabel,
  )
  check(
    '🚨 横幅描述里没有密码',
    !mysql.portalTargetLabel.includes(PASSWORD),
    mysql.portalTargetLabel,
  )
  check(
    'SQLite 服务端的横幅描述是文件路径（不含 MySQL 字样）',
    sqlite.portalTargetLabel.includes('portal.sqlite') &&
      !sqlite.portalTargetLabel.includes('MySQL'),
    sqlite.portalTargetLabel,
  )

  for (const s of [sqlite, mysql]) {
    const health = (await (await fetch(`${s.url}/api/health`)).json()) as {
      ok?: boolean
      initialized?: boolean
    }
    check(`${s.label}: /api/health 正常且身份已入库`, health.ok === true && health.initialized === true)
  }

  // ── 2. 记录 MySQL 侧原状态（跑完恢复，绝不留痕）──────────────────────────
  mysqlStore = await openPortalStore({ sqlitePath: mysqlSideDbPath, mysqlUrl: MYSQL_URL })
  check('MySQL 后端的门面 kind 是 mysql', mysqlStore.kind === 'mysql', mysqlStore.kind)
  const before = await mysqlStore.get<{ last_ingest_ms: unknown }>(
    'SELECT last_ingest_ms FROM ingest_run WHERE id = 1',
  )
  previousIngestMoment = before === null ? null : Number(before.last_ingest_ms)

  // ── 3. 幂等插入（两侧同一批数据）─────────────────────────────────────────
  console.log('\n【2】同一批上报数据分别投给两个后端')
  const firstZhang = await post(sqlite, TOKENS.zhang, payload(BATCH_ZHANG, '李四'))
  const firstZhangMy = await post(mysql, TOKENS.zhang, payload(BATCH_ZHANG, '李四'))
  const firstLi = await post(sqlite, TOKENS.li, payload(BATCH_LI, '张三'))
  const firstLiMy = await post(mysql, TOKENS.li, payload(BATCH_LI, '张三'))

  check('SQLite: 第一批 accepted=3', firstZhang.body['accepted'] === 3, JSON.stringify(firstZhang.body))
  check('MySQL : 第一批 accepted=3', firstZhangMy.body['accepted'] === 3, JSON.stringify(firstZhangMy.body))
  check('SQLite: 第二批 accepted=2', firstLi.body['accepted'] === 2, JSON.stringify(firstLi.body))
  check('MySQL : 第二批 accepted=2', firstLiMy.body['accepted'] === 2, JSON.stringify(firstLiMy.body))
  same('两侧三个计数完全一致', firstZhang.body, firstZhangMy.body)
  same('两侧三个计数完全一致（第二批）', firstLi.body, firstLiMy.body)

  // 归属以服务端为准：两批载荷里的 client.userName 都是**别人**的名字
  const mysqlUsers = await stats(mysql, 'breakdown', { period: 'today', by: 'user' })
  check(
    '★ 归属只信 token（client.userName 被忽略）',
    JSON.stringify((mysqlUsers['rows'] as { key: string }[]).map((r) => r.key).sort()) ===
      JSON.stringify(['张三', '李四']),
    JSON.stringify(mysqlUsers['rows']),
  )

  console.log('\n【3】幂等：同一批重发')
  const again = await post(mysql, TOKENS.zhang, payload(BATCH_ZHANG, '李四'))
  const againLite = await post(sqlite, TOKENS.zhang, payload(BATCH_ZHANG, '李四'))
  check('MySQL : 重发 accepted=0 / duplicates=3', again.body['accepted'] === 0 && again.body['duplicates'] === 3, JSON.stringify(again.body))
  check('SQLite: 重发 accepted=0 / duplicates=3', againLite.body['accepted'] === 0 && againLite.body['duplicates'] === 3, JSON.stringify(againLite.body))
  same('两侧重发结果一致', again.body, againLite.body)

  // ── 4. MySQL 里确实有数据（防「两边都空所以相等」）───────────────────────
  console.log('\n【4】MySQL 里确实落了数据')
  // 🚨 只统计本脚本造的行（session_id 前缀），不碰库里其它任何数据。
  const cnt = await mysqlStore.get<{ c: unknown }>(
    'SELECT COUNT(*) AS c FROM usage_event WHERE session_id LIKE $prefix',
    { $prefix: `${SESSION_PREFIX}%` },
  )
  const myCount = Number(cnt?.c ?? 0)
  check(`MySQL usage_event 里有本脚本的 ${EXPECTED.events} 行`, myCount === EXPECTED.events, String(myCount))
  check('★ MySQL 侧没有走 SQLite 退路（那个库文件根本没被创建）', !existsSync(mysqlSideDbPath), mysqlSideDbPath)

  // ⚠️ 必须给列起别名：information_schema 的列名在 MySQL 8 里是**大写**
  //   （`COLUMN_NAME`），驱动按结果集的标签返回 —— 直接读 `column_name`
  //   会得到一串 undefined（踩过一次）。
  const cols = await mysqlStore.all<{ name: string }>(
    'SELECT column_name AS name FROM information_schema.columns ' +
      "WHERE table_schema = DATABASE() AND table_name = 'usage_event'",
  )
  const colNames = cols.map((c) => c.name)
  check('usage_event 里**没有** total_tokens 列（铁律 2）', !colNames.includes('total_tokens'), JSON.stringify(colNames))
  check(
    'usage_event 的四个 token 列各占一列（铁律 1）',
    ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].every((c) =>
      colNames.includes(c),
    ),
    JSON.stringify(colNames),
  )
  check('usage_event 带 user_id / user_name / dept 三列', ['user_id', 'user_name', 'dept'].every((c) => colNames.includes(c)), JSON.stringify(colNames))

  // ── 5. 逐位对照看板接口 ──────────────────────────────────────────────────
  console.log('\n【5】★ 看板接口逐位对照（这是防方言/驱动漂移的核心断言）')

  const overviewLite = await stats(sqlite, 'overview', { period: 'today' })
  const overviewMy = await stats(mysql, 'overview', { period: 'today' })
  same('overview 整个响应体逐位一致', overviewLite, overviewMy)
  check(
    '★ 两侧的绝对数字都等于脚本手算值（不是「两边都空」）',
    overviewMy['totalTokens'] === EXPECTED.total &&
      overviewMy['inputTokens'] === EXPECTED.input &&
      overviewMy['outputTokens'] === EXPECTED.output &&
      overviewMy['cacheReadTokens'] === EXPECTED.cacheRead &&
      overviewMy['cacheWriteTokens'] === EXPECTED.cacheWrite &&
      overviewMy['calls'] === EXPECTED.calls &&
      overviewMy['sessions'] === EXPECTED.sessions,
    JSON.stringify(overviewMy),
  )
  check('★ MySQL 的 totalTokens 是数字而不是字符串', typeof overviewMy['totalTokens'] === 'number', typeof overviewMy['totalTokens'])

  for (const bucket of ['day', 'hour'] as const) {
    const a = await stats(sqlite, 'series', { period: 'today', bucket })
    const b = await stats(mysql, 'series', { period: 'today', bucket })
    same(`series(bucket=${bucket}) 逐位一致`, a, b)
    check(`series(bucket=${bucket}) 非空且有数据`, (b['points'] as { calls: number }[]).some((p) => p.calls > 0))
  }

  for (const by of ['user', 'provider', 'model', 'provider-model', 'project', 'day', 'hour'] as const) {
    const a = await stats(sqlite, 'breakdown', { period: 'today', by })
    const b = await stats(mysql, 'breakdown', { period: 'today', by })
    same(`breakdown(by=${by}) 逐位一致`, a, b)
    check(`breakdown(by=${by}) 非空`, (b['rows'] as unknown[]).length > 0)
    const rows = b['rows'] as { cacheWriteTokens: number }[]
    check(`breakdown(by=${by}) 独立返回全部非零缓存写入`, rows.every((row) => typeof row.cacheWriteTokens === 'number') && rows.reduce((total, row) => total + row.cacheWriteTokens, 0) === EXPECTED.cacheWrite)
  }

  const recordsLite = await stats(sqlite, 'records', { period: 'today', limit: '50' })
  const recordsMy = await stats(mysql, 'records', { period: 'today', limit: '50' })
  same('records 逐位一致（含 (ts, seq) 定序结果）', recordsLite, recordsMy)
  check('records 总数正确', recordsMy['total'] === EXPECTED.events, JSON.stringify(recordsMy['total']))

  // ── 6. 直接钉住 `||` 那个坑 ───────────────────────────────────────────────
  console.log('\n【6】★ provider-model 分组键必须是 `a/b` 拼接结果，不是 0/1')
  const pmRows = (await stats(mysql, 'breakdown', { period: 'today', by: 'provider-model' }))['rows'] as {
    key: string
    calls: number
  }[]
  const pmKeys = pmRows.map((r) => r.key).sort()
  check(
    '分组键是真实拼接结果',
    JSON.stringify(pmKeys) ===
      JSON.stringify(
        ['dashscope/deepseek-v4.1-flash', 'dashscope/qwen-max', 'openai/gpt-4o'].sort(),
      ),
    JSON.stringify(pmKeys),
  )
  check('🚨 分组键里没有 "0"/"1"（逻辑或的典型症状）', !pmKeys.includes('0') && !pmKeys.includes('1'), JSON.stringify(pmKeys))
  check(
    '每个拼接键都含分隔符 "/"',
    pmRows.every((r) => r.key.includes('/')),
    JSON.stringify(pmKeys),
  )

  // ── 7. 诊断（只比对与「时刻」无关的字段）────────────────────────────────
  console.log('\n【7】诊断字段（lastIngestAt 是各自进程的时刻，不参与比对）')
  const diagLite = await stats(sqlite, 'diagnostics', { period: 'today' })
  const diagMy = await stats(mysql, 'diagnostics', { period: 'today' })
  const pickDiag = (d: Record<string, unknown>): unknown => ({
    totalEvents: d['totalEvents'],
    unattributedEvents: d['unattributedEvents'],
    unattributedRate: d['unattributedRate'],
    identityViolations: d['identityViolations'],
    distinctUsers: d['distinctUsers'],
    earliestTs: d['earliestTs'],
    latestTs: d['latestTs'],
  })
  same('diagnostics（除 lastIngestAt 外）逐位一致', pickDiag(diagLite), pickDiag(diagMy))
  check('两侧都记下了「最近落库时刻」', typeof diagMy['lastIngestAt'] === 'number' && typeof diagLite['lastIngestAt'] === 'number')
  check('两侧 distinctUsers 都是 2', diagMy['distinctUsers'] === EXPECTED.users, JSON.stringify(diagMy['distinctUsers']))
} catch (err) {
  failed++
  console.log(`\n❌ 未捕获异常：${err instanceof Error ? err.stack ?? err.message : String(err)}`)
} finally {
  // ── 8. 清理：只删自己造的行，并恢复 ingest_run 的原值 ────────────────────
  console.log('\n【8】清理（只动本脚本造的数据）')
  try {
    if (mysqlStore) {
      const del = await mysqlStore.run('DELETE FROM usage_event WHERE session_id LIKE $prefix', {
        $prefix: `${SESSION_PREFIX}%`,
      })
      check('已按 session_id 前缀删掉自己造的行', del.changes === EXPECTED.events, `changes=${del.changes}`)

      if (previousIngestMoment === null) {
        await mysqlStore.run('DELETE FROM ingest_run WHERE id = 1', {})
      } else {
        await mysqlStore.run('UPDATE ingest_run SET last_ingest_ms = $v WHERE id = 1', {
          $v: previousIngestMoment,
        })
      }

      const left = await mysqlStore.get<{ c: unknown }>(
        'SELECT COUNT(*) AS c FROM usage_event WHERE session_id LIKE $prefix',
        { $prefix: `${SESSION_PREFIX}%` },
      )
      check('库里已无本脚本的行', Number(left?.c ?? 0) === 0, String(left?.c))
      // 🚨 表结构保留（schema 是上报库契约的一部分，别人可能正在用）
      const stillThere = await mysqlStore.get<{ c: unknown }>(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('usage_event','ingest_run','portal_meta')",
      )
      check('usage_event / ingest_run / portal_meta 三张表都还在（绝不 DROP）', Number(stillThere?.c ?? 0) === 3, String(stillThere?.c))
    }
  } catch (err) {
    failed++
    console.log(`  ❌ 清理失败：${err instanceof Error ? err.message : String(err)}`)
  }

  if (sqlite) await sqlite.stop().catch(() => undefined)
  if (mysql) await mysql.stop().catch(() => undefined)
  // MySQL 后端 close() 是空操作（连接来自共享池），进程退出时统一关池
  await closeAllMysqlBackends().catch(() => undefined)
  await isolation.dispose()
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n' + '='.repeat(72))
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项断言，两种后端的看板数字逐位一致`)
} else {
  console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
}
console.log('='.repeat(72))
process.exit(failed > 0 ? 1 : 0)
