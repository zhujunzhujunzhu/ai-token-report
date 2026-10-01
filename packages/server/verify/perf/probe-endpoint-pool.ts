/**
 * **单个端点在多档 buffer pool 下的端到端延迟**。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-endpoint-pool.ts --scale 3e6
 * ```
 *
 * ## 为什么要单独做这一件事
 *
 * `bench.ts` 里 `diagnostics` / `overview(all)` 稳定落在 14~18 秒，
 * 而 `probe-ops.ts` 里它们各自的门面方法只有 330~570ms —— 差 30 倍。
 * 两者都跑真实代码，所以差异只能来自**「一个请求里连续跑多个全窗口查询」**
 * 这个事实：单条查询的页在两次之间可能已经被挤出 buffer pool。
 *
 * 本探针因此不看单条 SQL，只看**端到端**，并在多档 pool 上各量一次，
 * 给出「要多少 buffer pool 才能让这个端点回到线性区」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
const scale = arg('scale', '3e6')!
const repeats = Number(arg('repeats', '3'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend = await sharedMysqlBackend(state.url)
const originalPool = Number((await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)

async function setPool(bytes: number): Promise<void> {
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${bytes}`)
  for (let attempt = 0; attempt < 180; attempt++) {
    const size = await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
    if (Number(size?.v) === bytes) break
    await new Promise((done) => setTimeout(done, 1_000))
  }
  await new Promise((done) => setTimeout(done, 3_000))
}

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const { createHandlerFor } = await import('../../src/index.js') as {
  createHandlerFor: (options: Record<string, unknown>) => Promise<{ handler: (request: Request) => Promise<Response>; close: () => Promise<void> }>
}
const home = join(STATE_DIR, `ep-pool-home-${scale}`)
mkdirSync(home, { recursive: true })
const bundle = await createHandlerFor({
  dshHome: home, dataDir: join(home, 'data'), dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})

const ENDPOINTS = [
  { name: 'diagnostics', path: '/api/v1/stats/diagnostics?identity_view=member' },
  { name: 'overview(all)', path: '/api/v1/stats/overview?identity_view=member' },
  { name: 'overview(30d)', path: '/api/v1/stats/overview?period=last30d&identity_view=member' },
  { name: 'breakdown:provider', path: '/api/v1/stats/breakdown?by=provider&period=last30d&identity_view=member' },
]
const auth = { Authorization: `Bearer ${state.adminToken}` }

const tableMb = await backend.get<Record<string, unknown>>(
  `SELECT ROUND((data_length+index_length)/1024/1024) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='usage_event'`)
console.log(`库 ${state.schema}，${state.events} 条，表 ${JSON.stringify(tableMb)}；每档每端点 ${repeats} 次\n`)

const pools = [originalPool, 1024 * 1024 * 1024, 2048 * 1024 * 1024, 4096 * 1024 * 1024]
const report: Record<string, Record<string, number>> = {}
try {
  for (const bytes of pools) {
    const label = `${(bytes / 1024 / 1024).toFixed(0)}MB`
    if (report[label]) continue
    await setPool(bytes)
    report[label] = {}
    console.log(`【buffer pool = ${label}】`)
    for (const endpoint of ENDPOINTS) {
      await (await bundle.handler(new Request(`http://127.0.0.1${endpoint.path}`, { headers: auth }))).text()
      const timings: number[] = []
      for (let index = 0; index < repeats; index++) {
        const started = performance.now()
        const response = await bundle.handler(new Request(`http://127.0.0.1${endpoint.path}`, { headers: auth }))
        await response.text()
        timings.push(performance.now() - started)
      }
      report[label]![endpoint.name] = Number(percentile(timings, 0.5).toFixed(1))
      console.log(`  ${endpoint.name.padEnd(22)} p50=${String(report[label]![endpoint.name]).padStart(10)}ms`)
    }
  }
  const labels = Object.keys(report)
  console.log(`\n对比（进程内 handler，p50 ms）：`)
  console.log(`  ${'端点'.padEnd(22)} ${labels.map((label) => label.padStart(11)).join(' ')}`)
  for (const endpoint of ENDPOINTS) {
    console.log(`  ${endpoint.name.padEnd(22)} ${labels.map((label) => String(report[label]![endpoint.name]).padStart(11)).join(' ')}`)
  }
} finally {
  await bundle.close()
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-endpoint-pool.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, repeats, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await setPool(originalPool)
  await closeAllMysqlBackends()
}
