/**
 * 性能摸底：**schema 闸门的成本与可优化空间**。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-gate.ts --scale 1e5
 * ```
 *
 * ## 要回答的问题
 *
 * `openPortalStats()`（每个看板请求的第一件事）→ `openPortalStore()` →
 * `ensurePortalReady()` → `verifyCurrent()`：**逐表重读 information_schema**。
 * 实测它一个请求要跑 100~120 条语句。本探针把它的成本切开：
 *
 * | 量 | 含义 |
 * |---|---|
 * | `verifyCurrent` 的语句条数与服务端耗时 | 闸门本身 |
 * | 纯 `information_schema` 单条往返 | 其中「驱动往返」占多少 |
 * | 同样的语句在 **MySQL 9.5 原生服务**（本机 3306，非容器）| 排除容器网络因素 |
 *
 * 结论若显示闸门占请求延迟的绝大部分，那优化方向就明确了：
 * 把「逐表结构核对」从每请求降到「启动一次 + 版本指纹」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { closeAllMysqlBackends, openPortalStore, sharedMysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')

interface PerfState { schema: string; url: string; events: number; memberCount: number }

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e5')!
const repeats = Number(arg('repeats', '10'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
const target = { sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url }

function rootSql(sql: string): string {
  const result = spawnSync('docker', ['exec', '-i', 'local-database-review-mysql', '/tmp/atr-mysql-root.sh'], {
    input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`root SQL 失败：${result.stderr || result.stdout}`)
  return result.stdout
}
async function countStatements(fn: () => Promise<void>): Promise<{ statements: number; totalMs: number; rows: string[] }> {
  rootSql('TRUNCATE performance_schema.events_statements_summary_by_digest;')
  await fn()
  const raw = rootSql(`SELECT COUNT_STAR, ROUND(SUM_TIMER_WAIT/1000000000,3), ROUND(AVG_TIMER_WAIT/1000000,3), LEFT(REPLACE(DIGEST_TEXT,'\\n',' '),90) FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME='${state.schema}' ORDER BY SUM_TIMER_WAIT DESC;`)
  let statements = 0, totalMs = 0
  const rows: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    statements += Number(cells[0] ?? 0)
    totalMs += Number(cells[1] ?? 0)
    rows.push(`${String(cells[0]).padStart(4)} 条 / ${String(cells[1]).padStart(7)}ms 累计 / 平均 ${String(cells[2]).padStart(7)}ms  ${cells[3]}`)
  }
  return { statements, totalMs: Number(totalMs.toFixed(2)), rows }
}
function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function timeIt(label: string, fn: () => Promise<void>, note = ''): Promise<number> {
  for (let index = 0; index < 3; index++) await fn()
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    await fn()
    timings.push(performance.now() - started)
  }
  const p50 = percentile(timings, 0.5)
  console.log(`  ${label.padEnd(40)} p50=${p50.toFixed(2).padStart(8)}ms p95=${percentile(timings, 0.95).toFixed(2).padStart(8)}ms  ${note}`)
  return p50
}

console.log(`schema 闸门成本（库 ${state.schema}，各 ${repeats} 次热态）`)

const openStoreP50 = await timeIt('openPortalStore()（= 闸门）', async () => { await openPortalStore(target) }, '每个看板 / 上报请求都跑')
const gateCount = await countStatements(async () => {
  for (let index = 0; index < 3; index++) await openPortalStore(target)
})
console.log(`      └ 语句 ${Math.round(gateCount.statements / 3)} 条 / 服务端 ${(gateCount.totalMs / 3).toFixed(2)}ms，按服务端耗时排序：`)
for (const row of gateCount.rows.slice(0, 10)) console.log(`         ${row}`)
const openStatsP50 = await timeIt('openPortalStats()（+ 旧视图自检）', async () => {
  const { openPortalStats } = await import('@ai-token-report/core/db')
  const session = await openPortalStats(target, { sinceMs: Date.now() - 30 * 86_400_000 }, undefined, false)
  await session.close()
})

// 对照：闸门里跑得最多的那条语句，单独看它的往返。
const backend = await sharedMysqlBackend(state.url)
await timeIt('（对照）单条 information_schema.tables', async () => {
  await backend.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name")
}, '闸门里跑 8 次')

console.log(`\n小结：闸门 ${openStoreP50.toFixed(1)}ms ≈ ${(openStatsP50 - openStoreP50).toFixed(1)}ms（旧视图自检）+ ${openStoreP50.toFixed(1)}ms（结构核对）`)
await closeAllMysqlBackends()
