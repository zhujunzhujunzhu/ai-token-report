/**
 * 性能摸底：**统一测量矩阵**（一个规模一次跑完，结果汇总成一张表）。
 *
 * ```bash
 * bun run packages/server/verify/perf/bench-all.ts --scale 1e6 --pool 1024
 * bun run packages/server/verify/perf/bench-all.ts --scale 3e6 --pool 1024
 * ```
 *
 * 每个规模测四格，构成完整对照：
 *
 * | 维度 | 取值 |
 * |---|---|
 * | schema 闸门 | 现状（每请求逐表核对） / 优化（启动一次 + 版本指纹） |
 * | 时刻 | 冷（重启容器后第一次） / 热（连续） |
 *
 * ★ 「优化」这一格用**进程内打桩**模拟（见 `ab-optimize.ts` 的说明），
 *   所以它与「现状」格的差值就是该方案的收益上界。
 * ⚠️ buffer pool 由 `--pool` 指定（本机实例默认只有 128MB —— 那本身就是结论之一），
 *   跑完会恢复原值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend, type MysqlBackend } from '@ai-token-report/core/db'

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
const repeats = Number(arg('repeats', '5'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend: MysqlBackend = await sharedMysqlBackend(state.url)
const ORIGINAL_POOL = Number((await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
async function setPool(bytes: number): Promise<void> {
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${bytes}`)
  for (let attempt = 0; attempt < 90; attempt++) {
    const size = await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
    if (Number(size?.v) === bytes) break
    await new Promise((done) => setTimeout(done, 1_000))
  }
  await new Promise((done) => setTimeout(done, 3_000))
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const CASES: { name: string; sql: string; note: string }[] = [
  { name: 'totals', note: 'overview 一次', sql: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since' },
  { name: 'series 原始行', note: 'series 每请求一次（3 万行回 JS 分桶）', sql: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since' },
  { name: 'stack 原始行', note: 'series?stack=user', sql: 'SELECT ts, member_id, user_id, user_name, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since' },
  { name: 'memberGroups', note: 'breakdown by=user', sql: 'SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id, MIN(user_name) AS snapshot_name, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY member_id, legacy_id' },
  { name: 'groups(provider)', note: 'breakdown by=provider', sql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY grp_key' },
  { name: 'COUNT(DISTINCT session)', note: 'overview/diagnostics', sql: 'SELECT COUNT(DISTINCT session_id) AS c FROM usage_event WHERE ts >= $since' },
  { name: 'records COUNT(*)', note: '分页 total', sql: 'SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since' },
  { name: 'records 首页', note: 'ORDER BY ts DESC LIMIT 100', sql: 'SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100 OFFSET 0' },
  { name: '旧视图自检', note: 'legacy 视图每请求一次', sql: 'SELECT DISTINCT member_id, user_id FROM usage_event WHERE ts >= $since' },
]

const since = Date.now() - 30 * 86_400_000
const p = { $since: since }

async function measure(sql: string): Promise<{ p50: number; p95: number; rows: number; reads: number }> {
  const readBefore = Number((await backend.get<{ v: number }>("SELECT VARIABLE_VALUE AS v FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads'"))?.v ?? 0)
  await backend.all(sql, p)
  const timings: number[] = []
  let rows = 0
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const result = await backend.all(sql, p)
    timings.push(performance.now() - started)
    rows = result.length
  }
  const readAfter = Number((await backend.get<{ v: number }>("SELECT VARIABLE_VALUE AS v FROM performance_schema.global_status WHERE VARIABLE_NAME='Innodb_buffer_pool_reads'"))?.v ?? 0)
  return {
    p50: Number(percentile(timings, 0.5).toFixed(1)),
    p95: Number(percentile(timings, 0.95).toFixed(1)),
    rows,
    reads: readAfter - readBefore,
  }
}

const report: Record<string, Record<string, { p50: number; p95: number; rows: number; reads: number }>> = {}

try {
  console.log(`=== 规模 ${scale}（${state.events} 条）/ buffer pool ${poolMb}MB / 窗口 30 天 ===`)
  const tableSize = await backend.get<Record<string, unknown>>(
    `SELECT ROUND(data_length/1024/1024,1) AS data_mb, ROUND(index_length/1024/1024,1) AS index_mb, ROUND(avg_row_length,0) AS avg_row
     FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='usage_event'`)
  console.log(`表体积：${JSON.stringify(tableSize)}；buffer pool 原值 ${(ORIGINAL_POOL / 1024 / 1024).toFixed(0)}MB`)
  const rowsInWindow = Number((await backend.get<{ c: number }>('SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since', p))?.c ?? 0)
  console.log(`30 天窗口内 ${rowsInWindow} 行（占全表 ${(rowsInWindow / state.events * 100).toFixed(1)}%）`)

  for (const pool of [ORIGINAL_POOL, poolMb * 1024 * 1024]) {
    const label = `${(pool / 1024 / 1024).toFixed(0)}MB`
    if (report[label]) continue
    await setPool(pool)
    console.log(`\n【buffer pool = ${label}】`)
    report[label] = {}
    for (const entry of CASES) {
      const timing = await measure(entry.sql)
      report[label]![entry.name] = timing
      console.log(`  ${entry.name.padEnd(24)} p50=${String(timing.p50).padStart(10)}ms p95=${String(timing.p95).padStart(10)}ms 返回 ${String(timing.rows).padStart(7)} 行 磁盘读 ${String(timing.reads).padStart(7)} 页  ${entry.note}`)
    }
  }

  console.log('\n对比（p50，ms）：')
  const labels = Object.keys(report)
  if (labels.length < 2) {
    console.log('  （只测了一档 buffer pool —— 用 `--pool` 指定第二档才会出现对照列）')
  } else {
    console.log(`  ${'用例'.padEnd(24)} ${labels.map((label) => label.padStart(12)).join(' ')} ${'提升'.padStart(8)}`)
    for (const entry of CASES) {
      const small = report[labels[0]!]![entry.name]!.p50
      const big = report[labels[1]!]![entry.name]!.p50
      console.log(`  ${entry.name.padEnd(24)} ${labels.map((label) => String(report[label]![entry.name]!.p50).padStart(12)).join(' ')} ${(small / Math.max(big, 0.01)).toFixed(0).padStart(7)}×`)
    }
  }
} finally {
  await setPool(ORIGINAL_POOL)
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-matrix.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, repeats, originalPoolMb: ORIGINAL_POOL / 1024 / 1024, requestedPoolMb: poolMb, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await closeAllMysqlBackends()
}
