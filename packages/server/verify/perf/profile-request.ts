/**
 * 性能摸底：**单请求 SQL 剖析** —— 回答「一个看板请求到底跑了几条语句、每条多久」。
 *
 * ```bash
 * bun run packages/server/verify/perf/profile-request.ts --scale 1e5
 * ```
 *
 * ## 数据源：`performance_schema.events_statements_summary_by_digest`
 *
 * 这是 MySQL 8 内建的「按语句指纹聚合」的统计表，给出**执行条数**与
 * **累计等待时间**。相对 `general_log` 的三个决定性好处：
 *
 * 1. 它是**服务端自己数**的，不依赖日志刷盘与文本解析（general_log 的多行
 *    INSERT 会把文本解析打爆：实测同一份日志按行切会虚高 100 倍，按条目切又
 *    因为刷盘时机读到 0 条）；
 * 2. 自带 `SUM_ROWS_EXAMINED` / `SUM_NO_INDEX_USED`，能直接看出哪条语句在扫全表；
 * 3. 按 digest 聚合之后，输出就是「一个请求跑了几类语句、各几条」，可读。
 *
 * 做法是**前后取差值**：请求前 `TRUNCATE`，请求后读全部 digest。
 * ⚠️ `TRUNCATE` 统计表是**全局**的，所以本脚本必须在独占窗口里跑
 *   （本机开发实例上确认无其他负载时才做这件事）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { closeAllMysqlBackends } from '@ai-token-report/core/db'
import { createServer } from '../../src/index.js'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = join(STATE_DIR, 'results')

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

const scale = arg('scale', '1e5')!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState

/** 在容器里以 root 跑 SQL（SQL 从 stdin 进）。 */
function rootSql(sql: string): string {
  const result = spawnSync('docker', ['exec', '-i', 'local-database-review-mysql', '/tmp/atr-mysql-root.sh'], {
    input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`root SQL 失败：${result.stderr || result.stdout}`)
  return result.stdout
}

interface DigestRow {
  text: string
  count: number
  totalMs: number
  rowsExamined: number
  rowsSent: number
  noIndex: number
}

/** 读当前 digests 并清空统计（只清统计表，不动业务数据）。 */
function takeDigests(): DigestRow[] {
  const sql = `SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT, SUM_NO_INDEX_USED
FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME='${state.schema}';
TRUNCATE performance_schema.events_statements_summary_by_digest;`
  const rows: DigestRow[] = []
  for (const line of rootSql(sql).split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    if (cells.length < 6) continue
    const count = Number(cells[1] ?? 0)
    const totalPs = Number(cells[2] ?? 0)
    rows.push({
      text: (cells[0] ?? '').replace(/\s+/g, ' ').slice(0, 200),
      count,
      totalMs: Number((totalPs / 1e9).toFixed(2)),
      rowsExamined: Number(cells[3] ?? 0),
      rowsSent: Number(cells[4] ?? 0),
      noIndex: Number(cells[5] ?? 0),
    })
  }
  return rows
}
const resetDigests = (): void => { rootSql('TRUNCATE performance_schema.events_statements_summary_by_digest;') }

const ENDPOINTS: { name: string; path: string; note: string }[] = [
  { name: 'overview', path: '/api/v1/stats/overview?period=last30d&identity_view=member', note: '总览卡片' },
  { name: 'breakdown:user', path: '/api/v1/stats/breakdown?by=user&period=last30d&identity_view=member', note: '人员排行' },
  { name: 'breakdown:group', path: '/api/v1/stats/breakdown?by=group&period=last30d&identity_view=member', note: '分组排行' },
  { name: 'breakdown:provider', path: '/api/v1/stats/breakdown?by=provider&period=last30d&identity_view=member', note: '供应商分布' },
  { name: 'series:day', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member', note: '30 天趋势' },
  { name: 'series+stack', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member&stack=user', note: '趋势 + 堆叠' },
  { name: 'records:100', path: '/api/v1/stats/records?period=last30d&limit=100&identity_view=member', note: '明细首页' },
  { name: 'groups', path: '/api/v1/stats/groups', note: '分组候选' },
  { name: 'members', path: '/api/v1/stats/members', note: '人员候选' },
  { name: 'providers', path: '/api/v1/stats/providers', note: '供应商候选' },
  { name: 'diagnostics', path: '/api/v1/stats/diagnostics?identity_view=member', note: '采集诊断' },
  { name: 'ingest', path: '__INGEST__', note: '上报 200 条' },
]

const home = join(STATE_DIR, `profile-home-${scale}`)
mkdirSync(home, { recursive: true })
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})
console.log(`服务端 ${server.url}；库内 ${state.events} 条（${state.schema}）`)

const adminAuth = { Authorization: `Bearer ${state.adminToken}` }
let ingestSeq = 0
async function send(path: string): Promise<number> {
  const started = performance.now()
  if (path === '__INGEST__') {
    const member = state.members[ingestSeq % state.members.length]!
    const session = `profile-${Date.now()}-${ingestSeq}`
    ingestSeq++
    const response = await fetch(`${server.url}/api/v1/token-usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(),
        records: Array.from({ length: 200 }, (_, seq) => ({
          event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
          provider: 'deepseek-official', model: 'deepseek-chat', cwd: 'D:\\perf',
          input_tokens: 20_000, output_tokens: 1_000, cache_read_tokens: 728_000,
          cache_write_tokens: 1_000, reasoning_tokens: 200, total_tokens: 750_000, turn: 1, step: seq,
        })),
      }),
      signal: AbortSignal.timeout(120_000),
    })
    await response.text()
    return performance.now() - started
  }
  const response = await fetch(`${server.url}${path}`, { headers: adminAuth, signal: AbortSignal.timeout(120_000) })
  await response.text()
  return performance.now() - started
}

/** 把 digest 归一成「类别」，用于回答「这些语句是什么」。 */
function classify(text: string): string {
  if (/information_schema\s*\.\s*`?tables`?/i.test(text)) return '闸门：information_schema.tables'
  if (/information_schema\s*\.\s*`?columns`?/i.test(text)) return '闸门：information_schema.columns'
  if (/information_schema\s*\.\s*`?statistics`?/i.test(text)) return '闸门：information_schema.statistics'
  if (/information_schema\s*\.\s*`?key_column_usage`?/i.test(text)) return '闸门：外键'
  if (/information_schema\s*\.\s*`?table_constraints`?/i.test(text)) return '闸门：CHECK'
  if (/FROM `usage_event`.*COUNT \( \* \) AS `c`/i.test(text) && !/GROUP BY/i.test(text)) return '闸门：usage_event COUNT(*)'
  if (/FROM `portal_meta`/i.test(text)) return '闸门：portal_meta 版本'
  if (/FROM `report_tokens`/i.test(text)) return '鉴权：凭证查询'
  if (/FROM `members`|FROM `member_roles`|FROM `role_permissions`|FROM `permissions`|FROM `login_accounts`/i.test(text)) return '鉴权：角色/权限'
  if (/^INSERT INTO `usage_event`/i.test(text)) return '入库：事件写入'
  if (/^INSERT INTO `ingest_run`/i.test(text)) return '入库：水位线 upsert'
  if (/SELECT @\@SESSION\.sql_mode/i.test(text)) return '入库：sql_mode 检查'
  if (/FROM `usage_event`.*GROUP BY/i.test(text)) return '统计：聚合分组'
  if (/FROM `usage_event`.*ORDER BY `ts` DESC/i.test(text)) return '统计：明细分页'
  if (/FROM `usage_event`/i.test(text)) return '统计：原始行 / 标量聚合'
  if (/FROM `model_price`/i.test(text)) return '统计：单价表'
  if (/FROM `member_group_assignments`|FROM `member_groups`/i.test(text)) return '统计：分组关联'
  if (/^COMMIT$|^START TRANSACTION$|^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK/i.test(text)) return '事务控制'
  if (/^SET /i.test(text)) return '会话设置'
  return `其它：${text.slice(0, 60)}`
}
function summarize(rows: readonly DigestRow[]): { category: string; count: number; totalMs: number; avgMs: number }[] {
  const grouped = new Map<string, { category: string; count: number; totalMs: number; avgMs: number }>()
  for (const row of rows) {
    const category = classify(row.text)
    const entry = grouped.get(category) ?? { category, count: 0, totalMs: 0, avgMs: 0 }
    entry.count += row.count
    entry.totalMs = Number((entry.totalMs + row.totalMs).toFixed(2))
    entry.avgMs = Number((entry.totalMs / Math.max(entry.count, 1)).toFixed(3))
    grouped.set(category, entry)
  }
  return [...grouped.values()].sort((a, b) => b.totalMs - a.totalMs)
}

interface RequestProfile {
  httpMs: number
  sqlCount: number
  sqlTotalMs: number
  digestCount: number
  categories: ReturnType<typeof summarize>
  statements: DigestRow[]
}

const report: Record<string, RequestProfile> = {}

try {
  for (const endpoint of ENDPOINTS) await send(endpoint.path) // 预热
  for (const endpoint of ENDPOINTS) {
    await send(endpoint.path)
    resetDigests()
    const httpMs = await send(endpoint.path)
    const digests = takeDigests()
    const sqlCount = digests.reduce((sum, row) => sum + row.count, 0)
    const sqlTotalMs = Number(digests.reduce((sum, row) => sum + row.totalMs, 0).toFixed(1))
    const categories = summarize(digests)
    report[endpoint.name] = {
      httpMs: Number(httpMs.toFixed(1)), sqlCount, sqlTotalMs, digestCount: digests.length,
      categories, statements: [...digests].sort((a, b) => b.totalMs - a.totalMs),
    }
    console.log(`\n【${endpoint.name}】HTTP ${httpMs.toFixed(1)}ms ← SQL ${sqlCount} 条 / 累计 ${sqlTotalMs}ms / ${digests.length} 种指纹  （${endpoint.note}）`)
    for (const entry of categories) {
      console.log(`   ${String(entry.count).padStart(5)} 条  ${String(entry.totalMs).padStart(8)}ms  平均 ${String(entry.avgMs).padStart(7)}ms  ${entry.category}`)
    }
    for (const row of [...digests].sort((a, b) => b.totalMs - a.totalMs).filter((row) => row.totalMs >= 5).slice(0, 5)) {
      const flags = [row.noIndex > 0 ? `无索引×${row.noIndex}` : '', row.rowsExamined > 0 ? `扫 ${row.rowsExamined} 行` : ''].filter(Boolean).join(' ')
      console.log(`      · ${row.count} × ${row.totalMs}ms ${flags}  ${row.text.slice(0, 110)}`)
    }
  }
} finally {
  await server.stop()
  await closeAllMysqlBackends()
}

mkdirSync(RESULT_DIR, { recursive: true })
const file = join(RESULT_DIR, `${scale}-profile.json`)
writeFileSync(file, JSON.stringify({ scale, schema: state.schema, report, generatedAt: new Date().toISOString() }, null, 2))
console.log(`\n结果已写：${file}`)
