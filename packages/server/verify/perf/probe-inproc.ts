/**
 * 性能摸底：**进程内延迟分解** —— 把 HTTP 传输这一段剥掉，看请求在服务端进程里
 * 到底花了多少时间。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-inproc.ts --scale 1e5
 * ```
 *
 * ## 为什么需要它
 *
 * 本机的 HTTP 往返（Bun + Windows 回环）实测 p50 ≈ 10ms，而这台机器上
 * **每个请求的 SQL 只有十几毫秒** —— 于是「HTTP 总耗时」这个指标里，
 * 传输、`Bun.serve`、`fetch` 客户端自身占了大头，会把结论带偏。
 *
 * 这里绕开网络，直接用 `createHandlerFor()` 造出的 `handler(new Request(...))`
 * 量三件事：
 *
 * 1. **handler 内的真实处理时间**（对比 HTTP 总耗时 → 得出传输与服务器的固定开销）；
 * 2. **schema 闸门的成本**：单独 `openPortalStore()` 一次，用
 *    `performance_schema` 数它跑了几条语句（闸门在每个请求里都跑）；
 * 3. **handler 的语句条数**（与 HTTP 路径对照，确认没有别的隐藏开销）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { closeAllMysqlBackends, openPortalStore } from '@ai-token-report/core/db'
import { createHandlerFor } from '../../src/index.js'

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
const repeats = Number(arg('repeats', '30'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState

function rootSql(sql: string): string {
  const result = spawnSync('docker', ['exec', '-i', 'local-database-review-mysql', '/tmp/atr-mysql-root.sh'], {
    input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`root SQL 失败：${result.stderr || result.stdout}`)
  return result.stdout
}
/** 数一段代码跑了几条 SQL（服务端自己数，与客户端计时互补）。 */
async function countStatements(fn: () => Promise<void>): Promise<{ statements: number; totalMs: number }> {
  rootSql('TRUNCATE performance_schema.events_statements_summary_by_digest;')
  await fn()
  const raw = rootSql(`SELECT COUNT_STAR, SUM_TIMER_WAIT FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME='${state.schema}';`)
  let statements = 0
  let totalNs = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    statements += Number(cells[0] ?? 0)
    totalNs += Number(cells[1] ?? 0)
  }
  return { statements, totalMs: Number((totalNs / 1e9).toFixed(2)) }
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const home = join(STATE_DIR, `inproc-home-${scale}`)
mkdirSync(home, { recursive: true })
const bundle = await createHandlerFor({
  dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})
console.log(`进程内 handler；库内 ${state.events} 条（${state.schema}），每个用例 ${repeats} 次`)

const adminAuth = { Authorization: `Bearer ${state.adminToken}` }
const paths = [
  { name: 'stats/overview', path: '/api/v1/stats/overview?period=last30d&identity_view=member' },
  { name: 'stats/series:day', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member' },
  { name: 'stats/breakdown:user', path: '/api/v1/stats/breakdown?by=user&period=last30d&identity_view=member' },
  { name: 'stats/records:100', path: '/api/v1/stats/records?period=last30d&limit=100&identity_view=member' },
  { name: 'stats/groups', path: '/api/v1/stats/groups' },
  { name: 'health', path: '/api/health' },
]

const report: Record<string, { p50Ms: number; p95Ms: number; statements: number; sqlMs: number; status: number }> = {}
try {
  for (const entry of paths) {
    const url = `http://127.0.0.1${entry.path}`
    const send = async (): Promise<number> => {
      const started = performance.now()
      const response = await bundle.handler(new Request(url, { headers: adminAuth }))
      await response.text()
      return performance.now() - started
    }
    for (let index = 0; index < 5; index++) await send()
    const timings: number[] = []
    for (let index = 0; index < repeats; index++) timings.push(await send())
    const status = (await bundle.handler(new Request(url, { headers: adminAuth }))).status
    const counted = await countStatements(async () => {
      for (let index = 0; index < 3; index++) await send()
    })
    // ★ 把 handler 的耗时拆成「构造 Request」「handler 本身」「读 body」三段：
    //   若大头在构造 Request 或读 body 上，说明瓶颈是 Bun 的 Web 标准实现
    //   （与数据库毫无关系），优化 SQL 一点用都没有。
    const requestMs: number[] = []
    const handlerMs: number[] = []
    const bodyMs: number[] = []
    for (let index = 0; index < repeats; index++) {
      const t0 = performance.now()
      const request = new Request(url, { headers: adminAuth })
      const t1 = performance.now()
      const response = await bundle.handler(request)
      const t2 = performance.now()
      await response.text()
      const t3 = performance.now()
      requestMs.push(t1 - t0)
      handlerMs.push(t2 - t1)
      bodyMs.push(t3 - t2)
    }
    report[entry.name] = {
      p50Ms: Number(percentile(timings, 0.5).toFixed(1)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(1)),
      statements: Math.round(counted.statements / 3),
      sqlMs: Number((counted.totalMs / 3).toFixed(1)),
      status,
    }
    console.log(`  ${entry.name.padEnd(22)} handler p50=${String(report[entry.name]!.p50Ms).padStart(7)}ms p95=${String(report[entry.name]!.p95Ms).padStart(7)}ms  SQL ${String(report[entry.name]!.statements).padStart(3)} 条 / ${String(report[entry.name]!.sqlMs).padStart(6)}ms  HTTP ${status}`)
    console.log(`      └ 构造 Request ${percentile(requestMs, 0.5).toFixed(2)}ms ｜ handler ${percentile(handlerMs, 0.5).toFixed(1)}ms ｜ 读 body ${percentile(bodyMs, 0.5).toFixed(2)}ms`)
  }

  // ★ schema 闸门本身的成本：`openPortalStats()` 内部第一件事就是 `openPortalStore()`
  //   → `ensurePortalReady()` → `verifyCurrent()`，它在**每个请求**里跑。
  const gate = await countStatements(async () => { await openPortalStore({ sqlitePath: join(home, 'portal.sqlite'), mysqlUrl: state.url }) })
  console.log(`\n  【schema 闸门】openPortalStore() 一次 = SQL ${gate.statements} 条 / ${gate.totalMs}ms（每个看板 / 上报请求都跑一次）`)
  const store = await openPortalStore({ sqlitePath: join(home, 'portal.sqlite'), mysqlUrl: state.url })
  const warm: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    await store.get('SELECT 1')
    warm.push(performance.now() - started)
  }
  await store.close()
  console.log(`  已热连接的 SELECT 1 p50=${percentile(warm, 0.5).toFixed(3)}ms（对照：驱动往返下限）`)

  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-inproc.json`)
  writeFileSync(file, JSON.stringify({ scale, gate, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
} finally {
  await bundle.close()
  await closeAllMysqlBackends()
}
