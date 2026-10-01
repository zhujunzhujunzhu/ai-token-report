/**
 * v8 汇总表的**性能验证**（同机同数据集、真 HTTP）。
 *
 * ```bash
 * bun run packages/server/verify/perf/measure-rollup.ts --scale 3e6 --pool 2048
 * ```
 *
 * 做法：起服务端 → 让启动补齐把汇总填好 → 逐个端点量热态 p50（**快路径**）
 * → 清空三张汇总表 → 同样的端点再量一遍（**原始表**）→ 输出对照。
 *
 * ★ 这就是报告里「收益倍数」那一栏的来源，可复现、同数据集、同进程。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, sharedMysqlBackend, syncRollups } from '@ai-token-report/core/db'
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
const scale = arg('scale', '3e6')!
const poolMb = Number(arg('pool', '2048'))!
const repeats = Number(arg('repeats', '7'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}（先跑 seed.ts --scale ${scale}）`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const admin = await sharedMysqlBackend(state.url)
const originalPool = Number((await admin.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
await admin.exec(`SET GLOBAL innodb_buffer_pool_size = ${poolMb * 1024 * 1024}`)
for (let attempt = 0; attempt < 180; attempt++) {
  const size = await admin.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
  if (Number(size?.v) === poolMb * 1024 * 1024) break
  await new Promise((done) => setTimeout(done, 1_000))
}
await new Promise((done) => setTimeout(done, 3_000))

const home = join(STATE_DIR, `rollup-measure-home-${scale}`)
mkdirSync(home, { recursive: true })
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '汇总测量管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  // 0 = 关掉定时补齐；本脚本自己控制「有汇总 / 无汇总」两种状态。
  rollupSyncMs: 0,
})
console.log(`服务端 ${server.url}；库内 ${state.events} 条（${state.schema}），pool ${poolMb}MB`)

const auth = { Authorization: `Bearer ${state.adminToken}` }
const ENDPOINTS = [
  { name: 'series:day（30 天）', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member' },
  { name: 'series:hour（今天）', path: '/api/v1/stats/series?bucket=hour&period=today&identity_view=member' },
  { name: 'hour-of-day（30 天）', path: '/api/v1/stats/hour-of-day?period=last30d&identity_view=member' },
  { name: 'hour-of-day（工作日）', path: '/api/v1/stats/hour-of-day?period=last30d&identity_view=member&day_kind=workday' },
  { name: 'overview（30 天）', path: '/api/v1/stats/overview?period=last30d&identity_view=member' },
]

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function measure(path: string): Promise<number> {
  await (await fetch(`${server.url}${path}`, { headers: auth })).text()
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const response = await fetch(`${server.url}${path}`, { headers: auth, signal: AbortSignal.timeout(120_000) })
    await response.text()
    if (response.status !== 200) throw new Error(`${path} → HTTP ${response.status}`)
    timings.push(performance.now() - started)
  }
  return Number(percentile(timings, 0.5).toFixed(1))
}

const report: Record<string, { withRollup: number; withoutRollup: number }> = {}
try {
  // ① 有汇总（启动时已经补过一轮；这里再显式对齐一次，确保不落后）
  const store = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: state.url })
  let sync = await syncRollups(store)
  // 积压多时它一次只推一批（有行数上界），循环推到追平
  for (let round = 0; round < 200 && sync.mode !== 'skipped'; round++) sync = await syncRollups(store)
  console.log(`汇总已对齐：日格 ${sync.dayCells} / 小时格 ${sync.hourCells} / 时段格 ${sync.hodCells}`)
  const rolledSum = await store.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
  const rawCount = await store.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event')
  console.log(`不变量：SUM(汇总.calls)=${rolledSum?.c} vs COUNT(原始)=${rawCount?.c}`)

  console.log('\n【快路径（汇总表）】')
  for (const endpoint of ENDPOINTS) {
    const ms = await measure(endpoint.path)
    report[endpoint.name] = { withRollup: ms, withoutRollup: 0 }
    console.log(`  ${endpoint.name.padEnd(24)} p50=${String(ms).padStart(9)}ms`)
  }

  console.log('\n【原始表】')
  for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod']) {
    await store.exec(`DELETE FROM ${table}`)
  }
  await store.close()
  for (const endpoint of ENDPOINTS) {
    const ms = await measure(endpoint.path)
    report[endpoint.name]!.withoutRollup = ms
    console.log(`  ${endpoint.name.padEnd(24)} p50=${String(ms).padStart(9)}ms`)
  }

  console.log('\n对照（p50 ms，同机同数据集）：')
  console.log(`  ${'端点'.padEnd(24)} ${'原始表'.padStart(10)} ${'汇总表'.padStart(10)} ${'提升'.padStart(8)}`)
  for (const endpoint of ENDPOINTS) {
    const entry = report[endpoint.name]!
    console.log(`  ${endpoint.name.padEnd(24)} ${String(entry.withoutRollup).padStart(10)} ${String(entry.withRollup).padStart(10)} ${(entry.withoutRollup / Math.max(entry.withRollup, 0.01)).toFixed(1).padStart(7)}×`)
  }
} finally {
  await server.stop()
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-rollup-measure.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, poolMb, repeats, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await admin.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
