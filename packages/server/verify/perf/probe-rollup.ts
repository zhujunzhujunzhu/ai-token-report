/**
 * 汇总表候选的专项测量（3M 规模）：把 30 天窗口折叠成 `(天, 人, 供应商, 模型)` 后，
 * 同样的看板聚合要多久。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-rollup.ts --scale 3e6 --pool 1024
 * ```
 *
 * ★ 汇总表的语义前提（必须说清，否则数字没有意义）：
 *   - `calls` 可加、四项 token 可加、`min(lo)/max(hi)` 可加；
 *   - **`sessions` 不可加**（同一会话可能跨天）—— 所以汇总行里存的是
 *     「这一天这个人的去重会话数」，跨天求和会**高估**。要精确就必须回原始表。
 *   - 时间桶在 JS 侧（`toDayKey`）—— 汇总表按「天」存，**小时级趋势无法由它服务**。
 *
 * ⚠️ 只在隔离库上建 / 删 `perf_rollup_*` 表，不动 `usage_event`。
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
const scale = arg('scale', '3e6')!
const poolMb = Number(arg('pool', '1024'))!
const repeats = Number(arg('repeats', '5'))!
const state = JSON.parse(readFileSync(join(STATE_DIR, `${scale}.json`), 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend: MysqlBackend = await sharedMysqlBackend(state.url)
const originalPool = Number((await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${poolMb * 1024 * 1024}`)
for (let attempt = 0; attempt < 120; attempt++) {
  const size = await backend.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
  if (Number(size?.v) === poolMb * 1024 * 1024) break
  await new Promise((done) => setTimeout(done, 1_000))
}
await new Promise((done) => setTimeout(done, 3_000))
console.log(`buffer pool ${poolMb}MB；库 ${state.schema}，${state.events} 条`)

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function measure(sql: string, params: Record<string, string | number>): Promise<number> {
  await backend.all(sql, params)
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    await backend.all(sql, params)
    timings.push(performance.now() - started)
  }
  return Number(percentile(timings, 0.5).toFixed(1))
}

const since = Date.now() - 30 * 86_400_000
const raw = { $since: since }
const rolled = { $daySince: Math.floor(since / 86_400_000) }

const CASES: { name: string; rawSql: string; rollupSql: string; comparable: string }[] = [
  {
    name: 'totals（总览四项求和）',
    comparable: '可加',
    rawSql: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since',
    rollupSql: 'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM perf_rollup_event WHERE day_ms >= $daySince',
  },
  {
    name: 'groups(provider) 聚合',
    comparable: '可加',
    rawSql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, COUNT(*) AS calls FROM usage_event WHERE ts >= $since GROUP BY grp_key',
    rollupSql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, SUM(calls) AS calls FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY grp_key',
  },
  {
    name: 'memberGroups（人员聚合）',
    comparable: 'sessions 会高估',
    rawSql: 'SELECT member_id, SUM(input_tokens) AS input, COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY member_id',
    rollupSql: 'SELECT member_id, SUM(input_tokens) AS input, SUM(calls) AS calls, SUM(sessions) AS sessions FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY member_id',
  },
  {
    name: 'series 按天（JS 分桶 → SQL 分桶）',
    comparable: '可加（口径需与 toDayKey 对齐）',
    rawSql: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since',
    rollupSql: 'SELECT day_ms, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(calls) AS calls FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY day_ms',
  },
  {
    name: 'COUNT(DISTINCT session)',
    comparable: '不可由汇总表服务',
    rawSql: 'SELECT COUNT(DISTINCT session_id) AS c FROM usage_event WHERE ts >= $since',
    rollupSql: 'SELECT NULL AS c',
  },
]

const report: Record<string, { raw: number; rollup: number; comparable: string }> = {}
try {
  console.log('\n建汇总表（(天, 人, 供应商, 模型)）…')
  const started = performance.now()
  await backend.exec(`CREATE TABLE perf_rollup_event (
    day_ms BIGINT NOT NULL, member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(255) NOT NULL, model VARCHAR(255) NOT NULL,
    calls BIGINT NOT NULL, sessions BIGINT NOT NULL,
    input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL, cache_write_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    lo BIGINT NOT NULL, hi BIGINT NOT NULL,
    PRIMARY KEY (day_ms, member_id, provider, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`)
  await backend.exec(`INSERT INTO perf_rollup_event
    SELECT FLOOR(ts/86400000) AS day_ms, COALESCE(member_id, '') AS member_id, provider, model,
           COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions,
           SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens),
           MIN(ts), MAX(ts)
      FROM usage_event GROUP BY day_ms, member_id, provider, model`)
  const buildS = (performance.now() - started) / 1000
  const size = await backend.get<Record<string, unknown>>(
    `SELECT table_rows, ROUND((data_length+index_length)/1024/1024,1) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='perf_rollup_event'`)
  const rawSize = await backend.get<Record<string, unknown>>(
    `SELECT ROUND((data_length+index_length)/1024/1024,1) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='usage_event'`)
  console.log(`建表 ${buildS.toFixed(1)}s；汇总表 ${JSON.stringify(size)} vs 原始表 ${JSON.stringify(rawSize)}`)

  console.log(`\n对比（30 天窗口，p50，各 ${repeats} 次）：`)
  console.log(`  ${'用例'.padEnd(30)} ${'原始表'.padStart(11)} ${'汇总表'.padStart(11)} ${'提升'.padStart(8)}  语义`)
  for (const entry of CASES) {
    const rawMs = await measure(entry.rawSql, raw)
    const rollupMs = entry.rollupSql.includes('NULL AS c') ? NaN : await measure(entry.rollupSql, rolled)
    report[entry.name] = { raw: rawMs, rollup: Number.isNaN(rollupMs) ? -1 : rollupMs, comparable: entry.comparable }
    console.log(`  ${entry.name.padEnd(30)} ${String(rawMs).padStart(11)} ${(Number.isNaN(rollupMs) ? 'n/a' : String(rollupMs)).padStart(11)} ${(Number.isNaN(rollupMs) ? '-' : `${(rawMs / rollupMs).toFixed(1)}×`).padStart(8)}  ${entry.comparable}`)
  }
} finally {
  await backend.exec('DROP TABLE IF EXISTS perf_rollup_event')
  console.log('\n汇总表已删除')
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
