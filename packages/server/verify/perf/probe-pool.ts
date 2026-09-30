/**
 * 决定性实验：**buffer pool 大小**是不是 1M 行之后性能悬崖的原因。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-pool.ts --scale 1e6
 * ```
 *
 * 做法：同一个库、同一批 SQL，分别在
 * `innodb_buffer_pool_size = 128M`（当前默认）与 `1024M` 下量 p50。
 *
 * ⚠️ `innodb_buffer_pool_size` 是**全局动态变量**，改完会立刻开始 resize；
 *   本脚本跑完会**恢复成原值**（128M）。这是本机开发实例，改动仅用于测量。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend, type MysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
interface PerfState { schema: string; url: string; events: number }
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e6')!
const state = JSON.parse(readFileSync(join(STATE_DIR, `${scale}.json`), 'utf8')) as PerfState

const backend: MysqlBackend = await sharedMysqlBackend(state.url)
const since = Date.now() - 30 * 86_400_000
const p = { $since: since }

async function setPool(bytes: number): Promise<void> {
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${bytes}`)
  // resize 是后台任务，等到稳定（最多 60 秒）。
  for (let attempt = 0; attempt < 60; attempt++) {
    const size = await backend.get<{ v: number }>("SELECT @@innodb_buffer_pool_size AS v")
    if (Number(size?.v) === bytes) break
    await new Promise((done) => setTimeout(done, 1_000))
  }
  await new Promise((done) => setTimeout(done, 3_000))
}

const CASES: { name: string; sql: string }[] = [
  { name: 'COUNT(*)', sql: 'SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since' },
  { name: 'totals（四项求和）', sql: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since' },
  { name: 'series 原始行', sql: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since' },
  { name: 'groups(provider)', sql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, COUNT(*) AS calls FROM usage_event WHERE ts >= $since GROUP BY grp_key' },
  { name: 'COUNT(DISTINCT session)', sql: 'SELECT COUNT(DISTINCT session_id) AS c FROM usage_event WHERE ts >= $since' },
  { name: 'records 首页', sql: 'SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100 OFFSET 0' },
  { name: 'memberGroups', sql: 'SELECT member_id, SUM(input_tokens) AS input, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY member_id' },
]

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function measure(sql: string): Promise<number> {
  await backend.all(sql, p)
  const timings: number[] = []
  for (let index = 0; index < 3; index++) {
    const started = performance.now()
    await backend.all(sql, p)
    timings.push(performance.now() - started)
  }
  return Number(percentile(timings, 0.5).toFixed(1))
}

const results: Record<string, Record<string, number>> = { '128M': {}, '1024M': {} }
try {
  console.log(`【buffer pool = 128M】${state.schema}，${state.events} 条，窗口 30 天`)
  for (const entry of CASES) {
    results['128M']![entry.name] = await measure(entry.sql)
    console.log(`  ${entry.name.padEnd(24)} p50=${String(results['128M']![entry.name]).padStart(10)}ms`)
  }

  console.log(`\n【buffer pool = 1024M】（改完会等 resize 稳定）`)
  await setPool(1024 * 1024 * 1024)
  for (const entry of CASES) {
    results['1024M']![entry.name] = await measure(entry.sql)
    console.log(`  ${entry.name.padEnd(24)} p50=${String(results['1024M']![entry.name]).padStart(10)}ms`)
  }

  console.log('\n对比（30 天窗口，p50）：')
  console.log(`  ${'用例'.padEnd(24)} ${'128M'.padStart(11)} ${'1024M'.padStart(11)} ${'提升'.padStart(8)}`)
  for (const entry of CASES) {
    const small = results['128M']![entry.name]!
    const big = results['1024M']![entry.name]!
    console.log(`  ${entry.name.padEnd(24)} ${String(small).padStart(11)} ${String(big).padStart(11)} ${(small / big).toFixed(0).padStart(7)}×`)
  }
} finally {
  console.log('\n恢复 innodb_buffer_pool_size = 128M…')
  await setPool(128 * 1024 * 1024)
  await closeAllMysqlBackends()
}
