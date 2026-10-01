/**
 * v8 性能验证的**补充测量**：把「SQL 本身」与「HTTP/框架固定开销」分开。
 *
 * ```bash
 * bun run packages/server/verify/perf/measure-rollup-sql.ts --scale 3e6 --pool 2048
 * ```
 *
 * ## 为什么要它
 *
 * `measure-rollup.ts` 是端到端（真 HTTP）的，而本机的**固定开销**很大
 * （HTTP 回环 + `Bun.serve` + 逐请求的 schema 闸门，实测单个请求 60~90ms 起）。
 * 于是当「原始表 SQL」已经只有 100~200ms 时，汇总表把它压到 1ms，
 * 端到端看起来却是 **1.0×** —— 收益被固定开销吃掉了。
 *
 * 本脚本直接量两条 SQL：
 *
 * | 场景 | 原始表 SQL | 汇总表 SQL |
 * |---|---|---|
 * | 30 天四项求和 | `SELECT SUM(...) FROM usage_event WHERE ts >= ?` | `... FROM usage_rollup_day WHERE day_key >= ?` |
 * | 30 天按天趋势 | 取全窗口原始行（JS 分桶） | `SELECT day_key, SUM(...) ... GROUP BY day_key` |
 * | 人员聚合 | `GROUP BY member_id` | `GROUP BY member_id` on rollup |
 * | 供应商聚合 | `GROUP BY provider` | `GROUP BY provider` on rollup |
 * | 时段分布 | 取全窗口原始行（JS 折叠） | `... FROM usage_rollup_hod` |
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend, type MysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = join(STATE_DIR, 'results')

interface PerfState { schema: string; url: string; events: number }
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '3e6')!
const poolMb = Number(arg('pool', '2048'))!
const repeats = Number(arg('repeats', '7'))!
const state = JSON.parse(readFileSync(join(STATE_DIR, `${scale}.json`), 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend: MysqlBackend = await sharedMysqlBackend(state.url)
const originalPool = Number((await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${poolMb * 1024 * 1024}`)
for (let attempt = 0; attempt < 180; attempt++) {
  const size = await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
  if (Number(size?.v) === poolMb * 1024 * 1024) break
  await new Promise((done) => setTimeout(done, 1_000))
}
await new Promise((done) => setTimeout(done, 3_000))

const since = Date.now() - 30 * 86_400_000
/**
 * ⚠️ `day_key` 是**本地日**（`toDayKey()`），所以窗口左边界也必须用**本地日**算。
 *   我第一版用 `new Date(since).toISOString().slice(0,10)`（= UTC 日），
 *   在 +08:00 下会**早一天**，于是 `WHERE day_key >= ?` 把 30 天窗口切错 ——
 *   实测表现为汇总表侧「返回 0 行」（而原始表侧有 24 万行），
 *   看起来像汇总表是空的。
 */
const localDay = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const sinceDay = localDay(since)
const sampleDay = localDay(since + 5 * 86_400_000)

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function time(sql: string, params: Record<string, string | number> = {}): Promise<{ ms: number; rows: number }> {
  await backend.all(sql, params)
  const timings: number[] = []
  let rows = 0
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const result = await backend.all(sql, params)
    timings.push(performance.now() - started)
    rows = result.length
  }
  return { ms: Number(percentile(timings, 0.5).toFixed(1)), rows }
}

const CASES: { name: string; raw: string; rollup: string; rawParams?: Record<string, string | number>; rollupParams?: Record<string, string | number> }[] = [
  {
    name: '30 天四项求和（overview 的一部分）',
    raw: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since',
    rollup: 'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_rollup_day WHERE day_key >= $sinceDay',
    rawParams: { $since: since }, rollupParams: { $sinceDay: sinceDay },
  },
  {
    name: '30 天趋势（series:day）',
    raw: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since',
    rollup: 'SELECT day_key, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(calls) AS calls FROM usage_rollup_day WHERE day_key >= $sinceDay GROUP BY day_key',
    rawParams: { $since: since }, rollupParams: { $sinceDay: sinceDay },
  },
  {
    name: '人员聚合（breakdown by=user）',
    raw: 'SELECT member_id, SUM(input_tokens) AS input, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY member_id',
    rollup: 'SELECT member_id, SUM(input_tokens) AS input, SUM(calls) AS calls FROM usage_rollup_day WHERE day_key >= $sinceDay GROUP BY member_id',
    rawParams: { $since: since }, rollupParams: { $sinceDay: sinceDay },
  },
  {
    name: '供应商聚合（breakdown by=provider）',
    raw: 'SELECT provider, SUM(input_tokens) AS input FROM usage_event WHERE ts >= $since GROUP BY provider',
    rollup: 'SELECT provider, SUM(input_tokens) AS input FROM usage_rollup_day WHERE day_key >= $sinceDay GROUP BY provider',
    rawParams: { $since: since }, rollupParams: { $sinceDay: sinceDay },
  },
  {
    name: '时段分布（hour-of-day，全历史）',
    raw: 'SELECT ts, input_tokens FROM usage_event',
    rollup: 'SELECT hour_of_day, day_kind, calls, input_tokens FROM usage_rollup_hod',
  },
  {
    name: '单日日内曲线（series:hour，某一天）',
    raw: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $day AND ts < $dayEnd',
    rollup: 'SELECT hour_of_day, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_rollup_hour WHERE day_key = $dayKey',
    rawParams: { $day: Date.parse(`${sampleDay}T00:00:00Z`), $dayEnd: Date.parse(`${sampleDay}T00:00:00Z`) + 86_400_000 },
    rollupParams: { $dayKey: sampleDay },
  },
]

console.log(`库 ${state.schema}，${state.events} 条，pool ${poolMb}MB，窗口 30 天，各 ${repeats} 次`)
const report: Record<string, { raw: number; rawRows: number; rollup: number; rollupRows: number }> = {}
try {
  console.log(`\n  ${'用例'.padEnd(34)} ${'原始表'.padStart(12)} ${'行'.padStart(9)} ${'汇总表'.padStart(11)} ${'行'.padStart(7)} ${'提升'.padStart(8)}`)
  for (const entry of CASES) {
    const raw = await time(entry.raw, entry.rawParams ?? {})
    const rolled = await time(entry.rollup, entry.rollupParams ?? {})
    report[entry.name] = { raw: raw.ms, rawRows: raw.rows, rollup: rolled.ms, rollupRows: rolled.rows }
    console.log(`  ${entry.name.padEnd(34)} ${String(raw.ms).padStart(12)} ${String(raw.rows).padStart(9)} ${String(rolled.ms).padStart(11)} ${String(rolled.rows).padStart(7)} ${(raw.ms / Math.max(rolled.ms, 0.01)).toFixed(1).padStart(7)}×`)
  }
} finally {
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-rollup-sql.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, poolMb, repeats, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
