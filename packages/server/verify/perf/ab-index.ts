/**
 * 性能摸底：**索引与汇总表候选的 A/B**（纯 SQL，直连隔离库）。
 *
 * ```bash
 * bun run packages/server/verify/perf/ab-index.ts --scale 1e6
 * ```
 *
 * ## 为什么要单独量 SQL
 *
 * 看板请求的墙上时间被「schema 闸门」主导（实测占 58~88%），
 * 把闸门摘掉之后，**取数 SQL 自己**才成为瓶颈 —— 所以必须单独量它，
 * 否则优化顺序会搞反（先加索引、却没解决主要延迟）。
 *
 * ## 三组对照
 *
 * | 组 | 内容 |
 * |---|---|
 * | `现状` | 现有索引（`ts` / `provider` / `model` / `session_id` / `user_id` / `member_id,ts`） |
 * | `候选索引` | 临时加 `(ts,member_id,…)` 等覆盖索引后再量（**测完立刻删掉**） |
 * | `汇总表` | 建一张 `perf_rollup_*` 表把 30 天数据折叠成 (天,人,供应商,模型) 后量同样的聚合 |
 *
 * ⚠️ 只在隔离库上操作，且新增的索引 / 表都在测量结束后 **DROP**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend, type MysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = join(STATE_DIR, 'results')

interface PerfState { schema: string; url: string; events: number; memberCount: number }

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e6')!
const repeats = Number(arg('repeats', '5'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error(`拒绝在非隔离库上操作：${state.schema}`)

const backend: MysqlBackend = await sharedMysqlBackend(state.url)

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
interface Timing { p50: number; p95: number; rows: number; examined: number; keyUsed: string }
async function timeSql(sql: string, params: Record<string, string | number>): Promise<Timing> {
  for (let index = 0; index < 2; index++) await backend.all(sql, params)
  const timings: number[] = []
  let rows = 0
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const result = await backend.all(sql, params)
    timings.push(performance.now() - started)
    rows = result.length
  }
  // 计划里的 rows / key 用来解释「为什么快 / 为什么慢」。
  let examined = 0
  let keyUsed = ''
  try {
    const plan = await backend.all<Record<string, unknown>>(`EXPLAIN FORMAT=JSON ${sql}`, params)
    const text = JSON.stringify(plan)
    const match = /"rows_examined_per_scan":\s*(\d+)/.exec(text)
    examined = match ? Number(match[1]) : 0
    keyUsed = /"key":\s*"([^"]*)"/.exec(text)?.[1] ?? '(none)'
  } catch { /* EXPLAIN 失败不影响计时结论 */ }
  return { p50: Number(percentile(timings, 0.5).toFixed(1)), p95: Number(percentile(timings, 0.95).toFixed(1)), rows, examined, keyUsed }
}

const since = Date.now() - 30 * 86_400_000
const p = { $since: since }

/** 看板真实会跑的那几条取数 SQL（与 `query.ts` 的构建器产出一致）。 */
const CASES: { name: string; sql: string; note: string }[] = [
  {
    name: 'totals（总览四项求和）',
    note: '每个 overview 请求一次',
    sql: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since',
  },
  {
    name: 'sessions（COUNT DISTINCT）',
    note: 'overview / diagnostics 各一次',
    sql: 'SELECT COUNT(DISTINCT session_id) AS c FROM usage_event WHERE ts >= $since',
  },
  {
    name: 'series 原始行（day/hour 在 JS 分桶）',
    note: 'series 每请求一次，返回 3 万行到 JS',
    sql: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since',
  },
  {
    name: '堆叠趋势原始行（按人）',
    note: 'series?stack=user 每请求一次',
    sql: 'SELECT ts, member_id, user_id, user_name, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since',
  },
  {
    name: 'memberGroups（人员聚合）',
    note: 'breakdown by=user',
    sql: `SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id, MIN(user_name) AS snapshot_name, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY member_id, legacy_id`,
  },
  {
    name: 'groups(provider) 聚合',
    note: 'breakdown by=provider（**实测最慢的一条**）',
    sql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi, COUNT(DISTINCT session_id) AS sessions FROM usage_event WHERE ts >= $since GROUP BY grp_key',
  },
  {
    name: 'records 计数',
    note: '明细分页的 total',
    sql: 'SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since',
  },
  {
    name: 'records 首页',
    note: 'ORDER BY ts DESC LIMIT 100',
    sql: 'SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100 OFFSET 0',
  },
  {
    name: '旧视图自检（DISTINCT 人）',
    note: '每个 legacy 视图请求一次',
    sql: 'SELECT DISTINCT member_id, user_id FROM usage_event WHERE ts >= $since',
  },
]

/** 候选索引：为「按时间窗聚合」提供覆盖，避免回表。 */
const CANDIDATES: { name: string; ddl: string; reason: string }[] = [
  {
    name: 'idx_usage_event_ts_member',
    ddl: 'CREATE INDEX idx_perf_ts_member ON usage_event (ts, member_id)',
    reason: '时间窗 + 人员维度的覆盖起点，避免按时间取行时回表',
  },
  {
    name: 'idx_usage_event_ts_cov',
    ddl: 'CREATE INDEX idx_perf_ts_cov ON usage_event (ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)',
    reason: 'totals / 时间序列完全覆盖（不回表）',
  },
  {
    name: 'idx_usage_event_ts_session',
    ddl: 'CREATE INDEX idx_perf_ts_session ON usage_event (ts, session_id)',
    reason: 'COUNT(DISTINCT session_id) 覆盖',
  },
]

const report: Record<string, Record<string, Timing>> = {}
try {
  console.log(`【现状索引】库 ${state.schema}，${state.events} 条，窗口 30 天，各 ${repeats} 次`)
  report['现状'] = {}
  for (const entry of CASES) {
    const timing = await timeSql(entry.sql, p)
    report['现状']![entry.name] = timing
    console.log(`  ${entry.name.padEnd(34)} p50=${String(timing.p50).padStart(9)}ms  扫 ${String(timing.examined).padStart(9)} 行  key=${timing.keyUsed}`)
  }

  // ── 候选索引：加 → 量 → 删 ──────────────────────────────────────────────
  console.log(`\n【候选索引】临时添加（测完 DROP）：`)
  for (const candidate of CANDIDATES) {
    const started = performance.now()
    await backend.exec(candidate.ddl)
    console.log(`  + ${candidate.name}（建索引 ${((performance.now() - started) / 1000).toFixed(1)}s）— ${candidate.reason}`)
  }
  await backend.exec('ANALYZE TABLE usage_event')
  report['候选索引'] = {}
  for (const entry of CASES) {
    const timing = await timeSql(entry.sql, p)
    report['候选索引']![entry.name] = timing
    console.log(`  ${entry.name.padEnd(34)} p50=${String(timing.p50).padStart(9)}ms  扫 ${String(timing.examined).padStart(9)} 行  key=${timing.keyUsed}`)
  }
  const sizeWith = await backend.get<Record<string, unknown>>(`SELECT ROUND((data_length+index_length)/1024/1024,1) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='usage_event'`)
  console.log(`  表体积（含候选索引）：${JSON.stringify(sizeWith)}`)

  for (const candidate of CANDIDATES) await backend.exec(`DROP INDEX ${candidate.name} ON usage_event`)
  await backend.exec('ANALYZE TABLE usage_event')
  console.log('  候选索引已删除')

  // ── 汇总表候选：把 30 天粒度折叠成 (天, 人, 供应商, 模型) ────────────────
  const rollupRows = await backend.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (SELECT member_id, provider, model, FLOOR(ts/86400000) AS day_ms FROM usage_event WHERE ts >= $since GROUP BY member_id, provider, model, day_ms) AS t`, p)
  console.log(`\n【汇总表候选】30 天窗口折叠后 ${rollupRows?.c ?? 0} 行（原始 ${state.events} 行）`)
  const builtAt = performance.now()
  await backend.exec(`CREATE TABLE perf_rollup_event (
    day_ms BIGINT NOT NULL, member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    provider VARCHAR(255) NOT NULL, model VARCHAR(255) NOT NULL,
    calls BIGINT NOT NULL, sessions BIGINT NOT NULL,
    input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL, cache_write_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    lo BIGINT NOT NULL, hi BIGINT NOT NULL,
    PRIMARY KEY (day_ms, member_id, provider, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`)
  await backend.exec(`INSERT INTO perf_rollup_event
    SELECT FLOOR(ts/86400000) AS day_ms, member_id, provider, model,
           COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions,
           SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens),
           MIN(ts), MAX(ts)
      FROM usage_event WHERE ts >= $since GROUP BY day_ms, member_id, provider, model`, p)
  console.log(`  构建耗时 ${((performance.now() - builtAt) / 1000).toFixed(1)}s`)

  const ROLLUP_CASES: { name: string; sql: string }[] = [
    {
      name: 'totals（总览四项求和）',
      sql: 'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM perf_rollup_event WHERE day_ms >= $daySince',
    },
    {
      name: 'memberGroups（人员聚合）',
      sql: 'SELECT member_id, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(calls) AS calls, MIN(lo) AS lo, MAX(hi) AS hi, SUM(sessions) AS sessions FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY member_id',
    },
    {
      name: 'groups(provider) 聚合',
      sql: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(calls) AS calls, MIN(lo) AS lo, MAX(hi) AS hi, SUM(sessions) AS sessions FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY grp_key',
    },
    {
      name: 'series（按天）',
      sql: 'SELECT day_ms, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(calls) AS calls FROM perf_rollup_event WHERE day_ms >= $daySince GROUP BY day_ms',
    },
  ]
  const rollupParams = { $daySince: Math.floor(since / 86_400_000) }
  report['汇总表'] = {}
  for (const entry of ROLLUP_CASES) {
    const timing = await timeSql(entry.sql, rollupParams)
    report['汇总表']![entry.name] = timing
    console.log(`  ${entry.name.padEnd(34)} p50=${String(timing.p50).padStart(9)}ms  扫 ${String(timing.examined).padStart(9)} 行  key=${timing.keyUsed}`)
  }
  const rollupSize = await backend.get<Record<string, unknown>>(`SELECT ROUND((data_length+index_length)/1024/1024,1) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='perf_rollup_event'`)
  console.log(`  汇总表体积：${JSON.stringify(rollupSize)}`)

  await backend.exec('DROP TABLE perf_rollup_event')
  console.log('  汇总表已删除')
} finally {
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-index.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, window: 'last30d', report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await closeAllMysqlBackends()
}
