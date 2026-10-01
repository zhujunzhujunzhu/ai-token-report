/**
 * **汇总表设计验证**：按线上真实形态造数，实测两张候选汇总表的行数、构建耗时与查询耗时。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-rollup-design.ts --members 300 --days 365 --events 3000000
 * ```
 *
 * ## 为什么必须单独做这一件事
 *
 * 「汇总表有多大」**只由维度基数决定**，而基数只能从真实数据算：
 * 线上实测是 `1 人 × 1 天 × 1 provider-model 组合 = 1 行` 的上限形态。
 * 按公式外推容易错一个数量级（我就先估错了），所以这里直接造一张同形的表再数。
 *
 * ## 三张候选表（对应报告 §7.3 / §8.2）
 *
 * | 表 | 粒度 | 服务 |
 * |---|---|---|
 * | `rollup_day` | (天, 人, 供应商, 模型) | 长窗口趋势 / 排行 / 分布 / 金额 |
 * | `rollup_hour_recent` | (天, 小时, 人, 供应商, 模型) 仅最近 N 天 | **单日日内曲线** |
 * | `rollup_hod` | (小时, 人, 供应商, 模型) 全历史折叠 | **工作时段分布** |
 *
 * ⚠️ 只在隔离库上建 / 删 `perf_rollup_*` 表，不动 `usage_event`。
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
const scale = arg('scale', '3e6')!
const poolMb = Number(arg('pool', '2048'))!
const recentDays = Number(arg('recent-days', '30'))!
const repeats = Number(arg('repeats', '5'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}（先跑 seed.ts --scale ${scale}）`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
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
console.log(`buffer pool ${poolMb}MB；库 ${state.schema}，${state.events} 条，最近 ${recentDays} 天走小时粒度`)

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
async function timeSql(sql: string, params: Record<string, string | number> = {}): Promise<number> {
  await backend.all(sql, params)
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    await backend.all(sql, params)
    timings.push(performance.now() - started)
  }
  return Number(percentile(timings, 0.5).toFixed(1))
}
const sizeOf = async (table: string): Promise<{ rows: number; mb: number }> => {
  const row = await backend.get<Record<string, unknown>>(
    `SELECT table_rows, ROUND((data_length+index_length)/1024/1024,2) AS mb
       FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='${table}'`)
  return { rows: Number(row?.['table_rows'] ?? 0), mb: Number(row?.['mb'] ?? 0) }
}
const countOf = async (table: string): Promise<number> =>
  Number((await backend.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))?.c ?? 0)

const DAY_MS = 86_400_000
const MS_PER_DAY = 86_400_000
/** 与 `aggregate.ts` 的 `toDayKey()` 同源的「本地日」表达式（这里用 DATE 代替，只用于行数测量）。 */
const dayExpr = 'DATE(FROM_UNIXTIME(ts/1000))'
const hourExpr = 'HOUR(FROM_UNIXTIME(ts/1000))'
const recentSince = Date.now() - recentDays * MS_PER_DAY
void DAY_MS

const report: Record<string, unknown> = {}
try {
  console.log('\n建三张候选汇总表…')
  for (const table of ['perf_rollup_day', 'perf_rollup_hour_recent', 'perf_rollup_hod']) {
    await backend.exec(`DROP TABLE IF EXISTS ${table}`)
  }

  // T1：日粒度（全历史）
  let started = performance.now()
  await backend.exec(`CREATE TABLE perf_rollup_day (
    day_key DATE NOT NULL, member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(255) NOT NULL, model VARCHAR(255) NOT NULL,
    calls BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL, cache_write_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    lo BIGINT NOT NULL, hi BIGINT NOT NULL,
    PRIMARY KEY (day_key, member_id, provider, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`)
  await backend.exec(`INSERT INTO perf_rollup_day
    SELECT ${dayExpr} AS day_key, COALESCE(member_id,'') AS member_id, provider, model,
           COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
           SUM(reasoning_tokens), MIN(ts), MAX(ts)
      FROM usage_event GROUP BY day_key, member_id, provider, model`)
  const t1Build = (performance.now() - started) / 1000

  // T2：小时粒度（仅最近 N 天）
  started = performance.now()
  await backend.exec(`CREATE TABLE perf_rollup_hour_recent (
    day_key DATE NOT NULL, hour_of_day TINYINT NOT NULL,
    member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(255) NOT NULL, model VARCHAR(255) NOT NULL,
    calls BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL, cache_write_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    lo BIGINT NOT NULL, hi BIGINT NOT NULL,
    PRIMARY KEY (day_key, hour_of_day, member_id, provider, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`)
  await backend.exec(`INSERT INTO perf_rollup_hour_recent
    SELECT ${dayExpr} AS day_key, ${hourExpr} AS hour_of_day, COALESCE(member_id,'') AS member_id, provider, model,
           COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
           SUM(reasoning_tokens), MIN(ts), MAX(ts)
      FROM usage_event WHERE ts >= ${recentSince} GROUP BY day_key, hour_of_day, member_id, provider, model`)
  const t2Build = (performance.now() - started) / 1000

  // T3：时段折叠粒度（全历史，只按「第几小时」）
  started = performance.now()
  await backend.exec(`CREATE TABLE perf_rollup_hod (
    hour_of_day TINYINT NOT NULL, member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(255) NOT NULL, model VARCHAR(255) NOT NULL,
    calls BIGINT NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL, cache_write_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    PRIMARY KEY (hour_of_day, member_id, provider, model)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`)
  await backend.exec(`INSERT INTO perf_rollup_hod
    SELECT ${hourExpr} AS hour_of_day, COALESCE(member_id,'') AS member_id, provider, model,
           COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
           SUM(reasoning_tokens)
      FROM usage_event GROUP BY hour_of_day, member_id, provider, model`)
  const t3Build = (performance.now() - started) / 1000

  const rawSize = await sizeOf('usage_event')
  const t1 = await sizeOf('perf_rollup_day')
  const t2 = await sizeOf('perf_rollup_hour_recent')
  const t3 = await sizeOf('perf_rollup_hod')
  const rawExact = await countOf('usage_event')
  report['rows'] = {
    raw: rawExact, day: await countOf('perf_rollup_day'),
    hourRecent: await countOf('perf_rollup_hour_recent'), hod: await countOf('perf_rollup_hod'),
  }
  report['size'] = { raw: rawSize, day: t1, hourRecent: t2, hod: t3 }
  report['buildSeconds'] = { day: Number(t1Build.toFixed(1)), hourRecent: Number(t2Build.toFixed(1)), hod: Number(t3Build.toFixed(1)) }

  console.log(`\n原始表      ${rawExact} 行 / ${rawSize.mb} MB`)
  console.log(`T1 日粒度   ${report['rows']['day']} 行 / ${t1.mb} MB（构建 ${t1Build.toFixed(1)}s）→ 压缩 ${(rawExact / Math.max(Number(report['rows']['day']), 1)).toFixed(1)}×`)
  console.log(`T2 小时/近${recentDays}天 ${report['rows']['hourRecent']} 行 / ${t2.mb} MB（构建 ${t2Build.toFixed(1)}s）`)
  console.log(`T3 时段折叠  ${report['rows']['hod']} 行 / ${t3.mb} MB（构建 ${t3Build.toFixed(1)}s）`)

  const lastDay = await backend.get<{ d: string }>(`SELECT MAX(${dayExpr}) AS d FROM usage_event`)
  /**
   * 取**中间那一天**，不要取最后一天。
   *
   * 🚨 造数是按时间顺序铺开的，所以最后一天只装了一个批次的尾巴（几百条）——
   *   拿它当「单日窗口」会把单日查询测成 0.4ms，得出「单日不需要优化」的假结论
   *   （虽然结论碰巧是对的，但证据是假的）。这里显式取窗口的中间日。
   */
  // ⚠️ 不要用 SQL 的 `MIN(DATE(...))`：DATE 列经 MySQL 驱动回来是 **Date 对象**，
  //   `String()` 出来是 `'Thu Oct 01 2026 …'`，`Date.parse` 拼 `YYYY-MM-DD` 就拿到
  //   `Invalid Date`（实测踩到两次）。直接取 epoch 毫秒，在 JS 里算中点。
  const spanRow = await backend.get<{ lo: number; hi: number }>(
    'SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM usage_event')
  const mid = Math.floor((Number(spanRow?.lo ?? 0) + Number(spanRow?.hi ?? 0)) / 2)
  const midDay = new Date(mid).toISOString().slice(0, 10)
  const midStart = Date.parse(`${midDay}T00:00:00Z`)
  const midRows = Number((await backend.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since AND ts < $until',
    { $since: midStart, $until: midStart + MS_PER_DAY }) as { c: number } | null)?.c ?? 0)
  console.log(`\n单日窗口取中间日 ${midDay}（该日 ${midRows} 条，最后一天 ${lastDay?.d} 只有尾巴，不能拿来代表单日）`)

  const since30 = Date.now() - 30 * MS_PER_DAY
  const cases: { name: string; raw: string; rollup: string; rawParams?: Record<string, string | number>; rollupParams?: Record<string, string | number> }[] = [
    {
      name: '30 天 totals',
      raw: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input FROM usage_event WHERE ts >= $since',
      rollup: 'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input FROM perf_rollup_day WHERE day_key >= $sinceDay',
      rawParams: { $since: since30 }, rollupParams: { $sinceDay: new Date(since30).toISOString().slice(0, 10) },
    },
    {
      name: '30 天 series（按天）',
      raw: 'SELECT ts, input_tokens FROM usage_event WHERE ts >= $since',
      rollup: 'SELECT day_key, SUM(input_tokens) AS input FROM perf_rollup_day WHERE day_key >= $sinceDay GROUP BY day_key',
      rawParams: { $since: since30 }, rollupParams: { $sinceDay: new Date(since30).toISOString().slice(0, 10) },
    },
    {
      name: '单日 series（按小时）',
      raw: 'SELECT ts, input_tokens FROM usage_event WHERE ts >= $since AND ts < $until',
      rollup: 'SELECT hour_of_day, SUM(input_tokens) AS input FROM perf_rollup_hour_recent WHERE day_key = $day GROUP BY hour_of_day',
      rawParams: { $since: midStart, $until: midStart + MS_PER_DAY },
      rollupParams: { $day: midDay },
    },
    {
      name: '时段分布（按小时折叠）',
      raw: `SELECT ${hourExpr} AS hod, COUNT(*) AS calls, SUM(input_tokens) AS input FROM usage_event GROUP BY hod`,
      rollup: 'SELECT hour_of_day AS hod, SUM(calls) AS calls, SUM(input_tokens) AS input FROM perf_rollup_hod GROUP BY hour_of_day',
    },
    {
      name: '时段分布（仅近 30 天）',
      raw: `SELECT ${hourExpr} AS hod, COUNT(*) AS calls FROM usage_event WHERE ts >= $since GROUP BY hod`,
      rollup: 'SELECT hour_of_day AS hod, SUM(calls) AS calls FROM perf_rollup_hour_recent GROUP BY hour_of_day',
      rawParams: { $since: since30 },
    },
    {
      name: '人员排行（30 天）',
      raw: 'SELECT member_id, SUM(input_tokens) AS input, COUNT(*) AS calls FROM usage_event WHERE ts >= $since GROUP BY member_id',
      rollup: 'SELECT member_id, SUM(input_tokens) AS input, SUM(calls) AS calls FROM perf_rollup_day WHERE day_key >= $sinceDay GROUP BY member_id',
      rawParams: { $since: since30 }, rollupParams: { $sinceDay: new Date(since30).toISOString().slice(0, 10) },
    },
    {
      name: '供应商分布（30 天）',
      raw: 'SELECT provider, SUM(input_tokens) AS input FROM usage_event WHERE ts >= $since GROUP BY provider',
      rollup: 'SELECT provider, SUM(input_tokens) AS input FROM perf_rollup_day WHERE day_key >= $sinceDay GROUP BY provider',
      rawParams: { $since: since30 }, rollupParams: { $sinceDay: new Date(since30).toISOString().slice(0, 10) },
    },
  ]

  console.log(`\n对比（30 天窗口 / 单日窗口，p50，各 ${repeats} 次）：`)
  console.log(`  ${'用例'.padEnd(26)} ${'原始表'.padStart(11)} ${'汇总表'.padStart(11)} ${'提升'.padStart(8)}`)
  const comparisons: Record<string, { raw: number; rollup: number }> = {}
  for (const entry of cases) {
    const rawMs = await timeSql(entry.raw, entry.rawParams ?? {})
    const rollupMs = await timeSql(entry.rollup, entry.rollupParams ?? {})
    comparisons[entry.name] = { raw: rawMs, rollup: rollupMs }
    console.log(`  ${entry.name.padEnd(26)} ${String(rawMs).padStart(11)} ${String(rollupMs).padStart(11)} ${(rawMs / Math.max(rollupMs, 0.01)).toFixed(1).padStart(7)}×`)
  }
  report['comparisons'] = comparisons
  report['singleDay'] = { day: midDay, rows: midRows }
} finally {
  for (const table of ['perf_rollup_day', 'perf_rollup_hour_recent', 'perf_rollup_hod']) {
    await backend.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  console.log('\n候选汇总表已删除')
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-rollup-design.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, poolMb, recentDays, repeats, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`结果已写：${file}`)
  await backend.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
