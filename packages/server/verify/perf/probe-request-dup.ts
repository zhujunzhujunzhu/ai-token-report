/**
 * **单请求内重复语句**检测 —— 回答「一个看板请求里，有没有同一条 SQL 跑了不止一次」。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-request-dup.ts --scale 1e6 --pool 1024
 * ```
 *
 * ## 做法：一次请求 = 一个 digest 周期
 *
 * `performance_schema.events_statements_summary_by_digest` 按指纹聚合，但是**累计**的。
 * 于是每发一个请求、立刻读一次，就能知道这个请求里每个指纹各跑了几次：
 *
 * ```
 * 每轮：TRUNCATE → 发一个请求 → 读全部 digest 的 COUNT_STAR
 * ```
 *
 * `COUNT_STAR >= 2` 的指纹就是「同一个请求里重复执行的语句」——
 * 这些是纯浪费（同一份数据算了两遍），而且**在响应体上完全看不出来**。
 *
 * ★ 这比「读代码猜」可靠：`portal.ts` 的调用点分散在 5 个路由方法里，
 *   而 `stats-route.ts` 的 `buildOverview()` 会连续调 4 个门面方法。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { closeAllMysqlBackends, sharedMysqlBackend } from '@ai-token-report/core/db'

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
const scale = arg('scale', '1e6')!
const poolMb = Number(arg('pool', '1024'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend = await sharedMysqlBackend(state.url)
const originalPool = Number((await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${poolMb * 1024 * 1024}`)
for (let attempt = 0; attempt < 120; attempt++) {
  const size = await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
  if (Number(size?.v) === poolMb * 1024 * 1024) break
  await new Promise((done) => setTimeout(done, 1_000))
}
await new Promise((done) => setTimeout(done, 3_000))

function rootSql(sql: string): string {
  const result = spawnSync('docker', ['exec', '-i', 'local-database-review-mysql', '/tmp/atr-mysql-root.sh'], {
    input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`root SQL 失败：${result.stderr || result.stdout}`)
  return result.stdout
}
const resetDigests = (): void => { rootSql('TRUNCATE performance_schema.events_statements_summary_by_digest;') }
function readDigests(): { text: string; count: number; totalMs: number }[] {
  const raw = rootSql(`SELECT COUNT_STAR, ROUND(SUM_TIMER_WAIT/1000000000,2), LEFT(REPLACE(DIGEST_TEXT,'\\n',' '),100) FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME='${state.schema}' ORDER BY COUNT_STAR DESC;`)
  const rows: { text: string; count: number; totalMs: number }[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    if (cells.length < 3) continue
    rows.push({ count: Number(cells[0] ?? 0), totalMs: Number(cells[1] ?? 0), text: (cells[2] ?? '') })
  }
  return rows
}

const { createHandlerFor } = await import('../../src/index.js') as { createHandlerFor: (options: Record<string, unknown>) => Promise<{ handler: (request: Request) => Promise<Response>; close: () => Promise<void> }> }
const home = join(STATE_DIR, `dup-home-${scale}`)
mkdirSync(home, { recursive: true })
const bundle = await createHandlerFor({
  dshHome: home, dataDir: join(home, 'data'), dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})

const adminAuth = { Authorization: `Bearer ${state.adminToken}` }
const ENDPOINTS = [
  { name: 'overview', path: '/api/v1/stats/overview?period=last30d&identity_view=member' },
  { name: 'diagnostics', path: '/api/v1/stats/diagnostics?identity_view=member' },
  { name: 'breakdown:user', path: '/api/v1/stats/breakdown?by=user&period=last30d&identity_view=member' },
  { name: 'breakdown:group', path: '/api/v1/stats/breakdown?by=group&period=last30d&identity_view=member' },
  { name: 'breakdown:provider-model', path: '/api/v1/stats/breakdown?by=provider-model&period=last30d&identity_view=member' },
  { name: 'breakdown:project', path: '/api/v1/stats/breakdown?by=project&period=last30d&identity_view=member' },
  { name: 'series:day', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member' },
  { name: 'series:day+stack', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member&stack=user' },
  { name: 'records:100', path: '/api/v1/stats/records?period=last30d&limit=100&identity_view=member' },
  { name: 'groups', path: '/api/v1/stats/groups' },
  { name: 'members', path: '/api/v1/stats/members' },
  { name: 'providers', path: '/api/v1/stats/providers' },
  { name: 'pricing', path: '/api/v1/stats/pricing' },
]

interface DupReport {
  totalStatements: number
  distinctDigests: number
  duplicated: { count: number; totalMs: number; text: string }[]
  legacyCheckRuns: number
}
const report: Record<string, DupReport> = {}

try {
  for (const endpoint of ENDPOINTS) {
    for (let index = 0; index < 2; index++) {
      await (await bundle.handler(new Request(`http://127.0.0.1${endpoint.path}`, { headers: adminAuth }))).text()
    }
    resetDigests()
    const response = await bundle.handler(new Request(`http://127.0.0.1${endpoint.path}`, { headers: adminAuth }))
    const status = response.status
    await response.text()
    const digests = readDigests()
    const duplicated = digests.filter((row) => row.count >= 2 && !/^COMMIT$|^START TRANSACTION$|information_schema/i.test(row.text))
    const legacy = digests.filter((row) => /SELECT DISTINCT `?member_id`?/i.test(row.text) || /DISTINCT `member_id` , `user_id`/i.test(row.text))
    report[endpoint.name] = {
      totalStatements: digests.reduce((sum, row) => sum + row.count, 0),
      distinctDigests: digests.length,
      duplicated,
      legacyCheckRuns: legacy.reduce((sum, row) => sum + row.count, 0),
    }
    console.log(`\n【${endpoint.name}】HTTP ${status}；共 ${report[endpoint.name]!.totalStatements} 条语句 / ${digests.length} 种指纹`)
    if (duplicated.length === 0) console.log('   ✓ 没有重复执行的语句')
    for (const row of duplicated.slice(0, 8)) {
      console.log(`   ⚠️ ${row.count} × ${String(row.totalMs).padStart(8)}ms 累计  ${row.text}`)
    }
    if (report[endpoint.name]!.legacyCheckRuns > 0) console.log(`   · 旧视图自检跑了 ${report[endpoint.name]!.legacyCheckRuns} 次`)
  }

  console.log('\n══ 汇总：每个请求里重复执行（COUNT_STAR ≥ 2）的语句 ══')
  for (const [name, entry] of Object.entries(report)) {
    const summary = entry.duplicated.length === 0
      ? '无'
      : entry.duplicated.map((row) => `${row.count}× ${row.text.slice(0, 60)}`).join(' | ')
    console.log(`  ${name.padEnd(24)} ${String(entry.totalStatements).padStart(4)} 条  ${summary}`)
  }
} finally {
  await bundle.close()
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-request-dup.json`)
  writeFileSync(file, JSON.stringify({ scale, poolMb, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
