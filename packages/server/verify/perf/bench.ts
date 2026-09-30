/**
 * 性能摸底：对称压测（隔离 MySQL 库 + 真 HTTP + 生产入口）。
 *
 * ```bash
 * bun run packages/server/verify/perf/bench.ts --scale 1e6
 * bun run packages/server/verify/perf/bench.ts --scale 1e6 --mode current --tag baseline
 * ```
 *
 * ## 测什么
 *
 * | 阶段 | 指标 |
 * |---|---|
 * | **入库** | `POST /api/v1/token-usage` 的 ACK 延迟（p50/p95）与事件吞吐（条/秒） |
 * | **统计** | 每个 `/api/v1/stats/*` 端点的 HTTP 延迟（p50/p95） |
 * | **归因** | 每个请求内部**逐条 SQL** 的耗时（`stats-route` 一趟跑了几条语句、各多久） |
 *
 * ## 为什么两个「统计」口径都要量
 *
 * 页面默认打 `identity_view=member`（人员下拉需要稳定 ID），而**服务端默认值是
 * `legacy`** —— 两者走的代码路径不同（`assertLegacyIdentityView()` 只在后者跑），
 * 所以两端都量，否则会得到一个「按页面口径测出来的假结论」。
 *
 * ## 冷 / 热
 *
 * 热 = 连续请求（InnoDB buffer pool 已缓存该表的页）。
 * 冷 = 每个用例前 `FLUSH TABLES`（清空 buffer pool 里本表相关页与查询缓存）。
 * 两者都报，因为线上是混合的：看板刷新的第一次往往是冷的。
 *
 * ⚠️ 只在隔离库上跑：脚本自己校验连接串的库名必须以 `atr_http_v5_` 开头。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, sharedMysqlBackend } from '@ai-token-report/core/db'
import { createServer } from '../../src/index.js'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = resolve('.artifacts/perf/results')

interface PerfState {
  schema: string
  url: string
  adminToken: string
  members: { memberId: string; tokenId: string; token: string }[]
  events: number
  memberCount: number
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const scale = arg('scale', '1e6')!
const tag = arg('tag', 'current')!
const mode = arg('mode', 'current')!
const ingestBatches = Number(arg('ingest-batches', '20'))!
const recordsPerBatch = Number(arg('records', '200'))!
const repeats = Number(arg('repeats', '5'))!
const cold = process.argv.includes('--cold')

function statePath(name: string): string {
  return join(STATE_DIR, `${name}.json`)
}
function assertIsolated(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!/^atr_http_v5_\d+_[a-f0-9]{8}$/.test(name)) throw new Error(`拒绝在非隔离库上压测：${name}`)
}
if (!existsSync(statePath(scale))) throw new Error(`没有 ${statePath(scale)}，先跑 seed.ts --scale ${scale}`)
const state = JSON.parse(readFileSync(statePath(scale), 'utf8')) as PerfState
assertIsolated(state.url)

// ── 计时工具 ────────────────────────────────────────────────────────────────

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
const round = (value: number): number => Number(value.toFixed(1))

/** 逐条 SQL 的耗时归因：包在 PortalStore 外面，不改被测代码。 */
interface SqlSample { sql: string; ms: number; rows: number }
/**
 * 给被测库的驱动加一层「计时壳」。
 *
 * ⚠️ 参数一律用本仓的 `$name` 具名形状：`toPositional()` 只翻译 `$name`，
 *   写 SQL 原生 `?` 会被原样发给 MySQL（症状是莫名 1064 语法错误）。
 */
const samples: SqlSample[] = []
let collecting = false

async function timedRaw(sql: string, params?: Record<string, string | number> | (string | number | null)[]): Promise<{ ms: number; rows: number }> {
  // ★ 用**共享池**（与服务端同一个）：`openMysqlBackend` 每次都会新建一个池，
  //   那会把「建池 + 握手」算进每一条 SQL 的耗时里。
  const backend = await sharedMysqlBackend(state.url)
  const started = performance.now()
  const rows = await backend.all(sql, params)
  return { ms: performance.now() - started, rows: rows.length }
}

/** 一条 SQL 跑 `repeats` 次，返回中位耗时。 */
async function sqlTiming(
  label: string,
  sql: string | ((attempt: number) => string),
  params?: Record<string, string | number> | ((attempt: number) => (string | number | null)[]),
): Promise<number> {
  const timings: number[] = []
  let rows = 0
  for (let index = 0; index < repeats; index++) {
    // ⚠️ 写操作的 SQL 与参数都要每次重建：重复用同一批 event_id 会撞主键，
    //   而中位耗时不能建立在「第一次成功、后面全失败」上。
    const text = typeof sql === 'function' ? sql(index) : sql
    const bound = typeof params === 'function' ? params(index) : params
    const result = await timedRaw(text, bound)
    timings.push(result.ms)
    rows = result.rows
  }
  const median = percentile(timings, 0.5)
  console.log(`    · ${label.padEnd(34)} 中位 ${round(median).toString().padStart(8)}ms  行数 ${rows}`)
  if (collecting) samples.push({ sql: label, ms: median, rows })
  return median
}

async function flushTables(): Promise<void> {
  const { spawnSync } = await import('node:child_process')
  const script = `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "USE \\\`${state.schema}\\\`; FLUSH TABLES;"`
  const result = spawnSync('docker', ['exec', 'local-database-review-mysql', 'sh', '-c', script], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`FLUSH TABLES 失败：${result.stderr || result.stdout}`)
}

// ── 起动服务端（生产入口）─────────────────────────────────────────────────

const home = join(STATE_DIR, `bench-home-${scale}`)
mkdirSync(home, { recursive: true })
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'),
  mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  ingestQueue: { maxRequests: 256, maxWaitMs: 60_000 },
})
console.log(`服务端 ${server.url} → ${server.portalTargetLabel}；库内 ${state.events} 条事件、${state.memberCount} 人`)

const adminAuth = { Authorization: `Bearer ${state.adminToken}` }
const memberAuth = { Authorization: `Bearer ${state.members[0]!.token}` }

interface HttpSample { name: string; ms: number; status: number; bytes: number }
async function hit(path: string, headers: Record<string, string> = adminAuth): Promise<HttpSample> {
  const started = performance.now()
  const response = await fetch(`${server.url}${path}`, { headers, signal: AbortSignal.timeout(120_000) })
  const text = await response.text()
  return { name: path, ms: performance.now() - started, status: response.status, bytes: text.length }
}

// ── 阶段 1：入库 ────────────────────────────────────────────────────────────

interface IngestReport {
  batches: number
  recordsPerBatch: number
  events: number
  durationMs: number
  eventsPerSecond: number
  ackP50Ms: number
  ackP95Ms: number
  statuses: number[]
}

async function measureIngest(): Promise<IngestReport> {
  console.log(`\n【入库】${ingestBatches} 批 × ${recordsPerBatch} 条，逐批串行（真实客户端就是一问一答）`)
  const acks: number[] = []
  const statuses: number[] = []
  let accepted = 0
  const runTag = `bench-${tag}-${Date.now()}`
  const started = performance.now()
  for (let batch = 0; batch < ingestBatches; batch++) {
    const member = state.members[batch % state.members.length]!
    const session = `${runTag}-${batch}`
    const payload = {
      schemaVersion: 1,
      client: { userId: 'untrusted', userName: 'ignored' },
      generatedAt: new Date().toISOString(),
      records: Array.from({ length: recordsPerBatch }, (_, seq) => ({
        event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
        provider: 'deepseek-official', model: 'deepseek-chat', cwd: 'D:\\perf\\ingest',
        input_tokens: 20_000, output_tokens: 1_000, cache_read_tokens: 728_000,
        cache_write_tokens: 1_000, reasoning_tokens: 200, total_tokens: 750_000, turn: 1, step: seq,
      })),
    }
    const sent = performance.now()
    const response = await fetch(`${server.url}/api/v1/token-usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    })
    const body = await response.json() as { accepted?: number; duplicates?: number; rejected?: number; reason?: string }
    acks.push(performance.now() - sent)
    statuses.push(response.status)
    if (!response.ok) throw new Error(`入库失败 HTTP ${response.status}：${body.reason ?? ''}`)
    accepted += body.accepted ?? 0
    if ((batch + 1) % 5 === 0) console.log(`  ${batch + 1}/${ingestBatches} 批已确认，累计 ${accepted} 条`)
  }
  const durationMs = performance.now() - started
  const report: IngestReport = {
    batches: ingestBatches, recordsPerBatch, events: accepted,
    durationMs: round(durationMs), eventsPerSecond: Math.round(accepted / (durationMs / 1000)),
    ackP50Ms: round(percentile(acks, 0.5)), ackP95Ms: round(percentile(acks, 0.95)), statuses,
  }
  console.log(`  ✓ ${report.events} 条 / ${report.durationMs}ms = ${report.eventsPerSecond} 条/秒；ACK p50=${report.ackP50Ms}ms p95=${report.ackP95Ms}ms`)
  return report
}

/** 逐条 SQL 的入库归因（不经过 HTTP，量与 HTTP 的差额就是协议 + JSON + 鉴权的开销）。 */
async function measureIngestSql(): Promise<void> {
  console.log('\n【入库 · 逐条 SQL 归因】（每条量一次，中位）')
  await sqlTiming('会话 sql_mode 检查', 'SELECT @@SESSION.sql_mode AS mode')
  // 与 `recordIngestMoment()` 用 `dialect.render()` 生成的语句逐字相同。
  await sqlTiming('ingest_run upsert（每次上报一次）',
    "INSERT INTO ingest_run (id, last_ingest_ms, last_scan_events, total_events_ingested, mismatch_count, files_failed, frames_failed, frames_ok, usage_events, assistant_without_usage, retry_started, retry, attempts, missing_provider, files_scanned, event_types_json, providers_json) VALUES (1, $now, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}', '[]') AS new ON DUPLICATE KEY UPDATE last_ingest_ms = new.last_ingest_ms",
    { $now: Date.now() })
  // 200 行多值 INSERT 的文本与生产一致（见 ingest.ts 的 attributedInsertSql）。
  // ⚠️ 只把 `event_id` 写成字面量（每次探针都要唯一，否则第二次直接撞主键）；
  //   其余 19 列走位置绑定 —— 20 列 × 200 行的绑定开销与生产**完全一致**。
  const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`
  // 与生产的 `attributedInsertSql(200)` 逐字同形：20 列 × 200 行多值 INSERT。
  // ⚠️ 只有 `event_id` 写成字面量（每次尝试必须唯一），其余 19 列走位置绑定 ——
  //   绑定值的数量与生产完全一致，所以量到的就是真实的解析 + 绑定开销。
  const insertSql = (attempt: number): string => {
    const rowValues = (index: number): string =>
      `(${literal(`sqlprobe-${attempt}-${index}`)}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    return `INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step,member_id,report_token_id,received_at_ms) VALUES ${Array.from({ length: 200 }, (_, index) => rowValues(index)).join(',')}`
  }
  const base = [`sqlprobe-session-${Date.now()}`, 1, Date.now(), 'deepseek-official', 'deepseek-chat', 'D:\\perf',
    'perf-member-0', 'perf-member-0', null, 20_000, 1_000, 728_000, 1_000, 200, 1, 1,
    state.members[0]!.memberId, state.members[0]!.tokenId, Date.now()]
  await sqlTiming('200 行多值 INSERT（含 3 个外键）', insertSql,
    () => Array.from({ length: 200 }, (_, index) => [base[0]!, index, ...base.slice(2)]).flat())
}

// ── 阶段 2：统计 ────────────────────────────────────────────────────────────

interface QueryReport { name: string; p50Ms: number; p95Ms: number; bytes: number; status: number }

const ENDPOINTS: { name: string; path: string; note: string }[] = [
  { name: 'overview', path: '/api/v1/stats/overview?period=last30d&identity_view=member', note: '总览卡片' },
  { name: 'overview(all)', path: '/api/v1/stats/overview?identity_view=member', note: '全时间窗总览' },
  { name: 'series:day', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member', note: '30 天趋势' },
  { name: 'series:hour', path: '/api/v1/stats/series?bucket=hour&period=last7d&identity_view=member', note: '7 天小时趋势' },
  { name: 'series+stack', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member&stack=user', note: '趋势 + 按人堆叠' },
  { name: 'breakdown:user', path: '/api/v1/stats/breakdown?by=user&period=last30d&identity_view=member', note: '人员排行' },
  { name: 'breakdown:group', path: '/api/v1/stats/breakdown?by=group&period=last30d&identity_view=member', note: '分组排行' },
  { name: 'breakdown:provider', path: '/api/v1/stats/breakdown?by=provider&period=last30d&identity_view=member', note: '供应商分布' },
  { name: 'breakdown:model', path: '/api/v1/stats/breakdown?by=model&period=last30d&identity_view=member', note: '模型分布' },
  { name: 'breakdown:prov-model', path: '/api/v1/stats/breakdown?by=provider-model&period=last30d&identity_view=member', note: '供应商×模型' },
  { name: 'breakdown:project', path: '/api/v1/stats/breakdown?by=project&period=last30d&identity_view=member', note: '项目分布' },
  { name: 'breakdown:day', path: '/api/v1/stats/breakdown?by=day&period=last30d&identity_view=member', note: '按天分布' },
  { name: 'records:100', path: '/api/v1/stats/records?period=last30d&limit=100&identity_view=member', note: '明细首页' },
  { name: 'records:1000', path: '/api/v1/stats/records?period=last30d&limit=1000&identity_view=member', note: '明细大页' },
  { name: 'diagnostics', path: '/api/v1/stats/diagnostics?identity_view=member', note: '采集诊断' },
  { name: 'groups', path: '/api/v1/stats/groups', note: '分组候选' },
  { name: 'members', path: '/api/v1/stats/members', note: '人员候选' },
  { name: 'providers', path: '/api/v1/stats/providers', note: '供应商候选' },
  { name: 'breakdown:user(legacy)', path: '/api/v1/stats/breakdown?by=user&period=last30d', note: '旧视图人员排行（服务端默认值）' },
  { name: 'overview(legacy)', path: '/api/v1/stats/overview?period=last30d', note: '旧视图总览' },
]

async function measureQueries(): Promise<QueryReport[]> {
  console.log(`\n【统计】每个端点 ${repeats} 次${cold ? '（每次前 FLUSH TABLES）' : '（连续，热态）'}`)
  const reports: QueryReport[] = []
  for (const endpoint of ENDPOINTS) {
    const timings: number[] = []
    let last: HttpSample | null = null
    for (let index = 0; index < repeats; index++) {
      if (cold) await flushTables()
      last = await hit(endpoint.path)
      timings.push(last.ms)
    }
    if (!last || last.status !== 200) throw new Error(`${endpoint.name} 返回 HTTP ${last?.status}`)
    const report: QueryReport = {
      name: endpoint.name, p50Ms: round(percentile(timings, 0.5)), p95Ms: round(percentile(timings, 0.95)),
      bytes: last.bytes, status: last.status,
    }
    reports.push(report)
    console.log(`  ${endpoint.name.padEnd(24)} p50=${String(report.p50Ms).padStart(8)}ms p95=${String(report.p95Ms).padStart(8)}ms  ${String(report.bytes).padStart(8)}B  ${endpoint.note}`)
  }
  return reports
}

/** 统计接口的逐条 SQL 归因：把「一个请求跑了几条语句」摊开看。 */
async function measureQuerySql(): Promise<void> {
  console.log('\n【统计 · 逐条 SQL 归因】30 天窗口（`$since` = 30 天前），中位')
  const since = Date.now() - 30 * 86_400_000
  const p = { $since: since }
  const where = ' WHERE ts >= $since'
  await sqlTiming('① assertLegacyIdentityView', `SELECT DISTINCT member_id, user_id FROM usage_event${where}`, p)
  await sqlTiming('② totals', `SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event${where}`, p)
  await sqlTiming('③ sessions(COUNT DISTINCT)', `SELECT COUNT(DISTINCT session_id) AS c FROM usage_event${where}`, p)
  await sqlTiming('④ unattributedCalls', `SELECT COUNT(*) AS c FROM usage_event${where} AND member_id IS NULL AND user_id IS NULL`, p)
  await sqlTiming('⑤ distinctUsers(子查询 GROUP BY)', `SELECT COUNT(*) AS c FROM (SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id FROM usage_event${where} AND (member_id IS NOT NULL OR user_id IS NOT NULL) GROUP BY member_id, legacy_id) AS identities`, p)
  await sqlTiming('⑥ series 原始行（day/hour 在 JS 分桶）', `SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event${where}`, p)
  await sqlTiming('⑦ stackSeries 原始行（按人）', `SELECT ts, member_id, user_id, user_name, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event${where}`, p)
  await sqlTiming('⑧ memberGroups 聚合', `SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id, MIN(user_name) AS snapshot_name, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event${where} GROUP BY member_id, legacy_id`, p)
  await sqlTiming('⑨ groupsQuery(provider)', `SELECT provider AS grp_key, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event${where} GROUP BY grp_key`, p)
  await sqlTiming('⑩ records COUNT(*)', `SELECT COUNT(*) AS c FROM usage_event${where}`, p)
  await sqlTiming('⑪ records LIMIT 100 (ORDER BY ts DESC)', `SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, provider AS provider, provider AS provider_norm, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event${where} ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100 OFFSET 0`, p)
  await sqlTiming('⑫ timeBounds + COUNT', `SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM usage_event${where}`, p)
  await sqlTiming('⑬ 版本闸门 COUNT(*)（每请求 verifyCurrent）', 'SELECT COUNT(*) AS count FROM usage_event')
  await sqlTiming('⑭ 闸门：table_name 目录', "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name")
  await sqlTiming('⑮ 闸门：usage_event 列目录', "SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")
  await sqlTiming('⑯ 闸门：usage_event 唯一约束', "SELECT index_name AS name,column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='usage_event' AND non_unique=0 ORDER BY index_name,seq_in_index")
  await sqlTiming('⑰ 闸门：usage_event 外键', "SELECT k.constraint_name AS name,k.column_name AS col,k.referenced_table_name AS ref_table,k.referenced_column_name AS ref_col,r.delete_rule AS delete_rule,r.update_rule AS update_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name WHERE k.table_schema=DATABASE() AND k.table_name='usage_event' ORDER BY k.constraint_name,k.ordinal_position")
  await sqlTiming('⑱ 闸门：usage_event CHECK', "SELECT c.check_clause AS expression,t.enforced AS enforced FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.table_name='usage_event' AND t.constraint_type='CHECK'")
  void where
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const ingest = await measureIngest()
await measureIngestSql()
const queries = await measureQueries()
await measureQuerySql()

await server.stop()
await closeAllMysqlBackends()

const result = {
  scale, tag, mode, cold, repeats,
  eventCount: state.events, memberCount: state.memberCount,
  ingest, queries, generatedAt: new Date().toISOString(),
}
mkdirSync(RESULT_DIR, { recursive: true })
const file = join(RESULT_DIR, `${scale}-${tag}${cold ? '-cold' : ''}.json`)
writeFileSync(file, JSON.stringify(result, null, 2))
console.log(`\n结果已写：${file}`)
