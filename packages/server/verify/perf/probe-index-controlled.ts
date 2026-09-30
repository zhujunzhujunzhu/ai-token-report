/**
 * 索引受控实验：一条 SQL 一条 SQL 地量，并打印执行计划。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-index-controlled.ts --scale 1e6
 * ```
 *
 * 判据不是「快了还是慢了」，而是：
 * ① 计划里到底用了哪个索引（`key`）；② 扫了多少行；③ 有没有回表。
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
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const backend: MysqlBackend = await sharedMysqlBackend(state.url)
const since = Date.now() - 30 * 86_400_000
const params = { $since: since }

async function dropCandidateIndexes(): Promise<void> {
  for (const name of ['idx_perf_ts_member', 'idx_perf_ts_cov', 'idx_perf_ts_session']) {
    try { await backend.exec(`DROP INDEX ${name} ON usage_event`) } catch { /* 不存在就算了 */ }
  }
}
async function report(label: string, sql: string): Promise<void> {
  const plan = await backend.all<Record<string, unknown>>(`EXPLAIN FORMAT=JSON ${sql}`, params)
  const text = JSON.stringify(plan)
  const keys = [...text.matchAll(/"key":\s*"([^"]+)"/g)].map((match) => match[1])
  const examined = [...text.matchAll(/"rows_examined_per_scan":\s*(\d+)/g)].map((match) => Number(match[1]))
  const used = [...text.matchAll(/"using_filesort":\s*(true|false)/g)].map((match) => match[1])
  await backend.all(sql, params) // 预热
  const timings: number[] = []
  for (let index = 0; index < 3; index++) {
    const started = performance.now()
    await backend.all(sql, params)
    timings.push(performance.now() - started)
  }
  const p50 = [...timings].sort((a, b) => a - b)[1]!
  console.log(`  ${label.padEnd(30)} p50=${p50.toFixed(1).padStart(9)}ms  索引=${(keys[0] ?? 'none').padEnd(28)} 预估扫=${(examined[0] ?? 0).toString().padStart(9)}  filesort=${used[0] ?? '?'}`)
}

const SQL = {
  count: 'SELECT COUNT(*) AS c FROM usage_event WHERE ts >= $since',
  totals: 'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning FROM usage_event WHERE ts >= $since',
  series: 'SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ts >= $since',
  provider: 'SELECT provider AS grp_key, SUM(input_tokens) AS input, COUNT(*) AS calls FROM usage_event WHERE ts >= $since GROUP BY grp_key',
  sessions: 'SELECT COUNT(DISTINCT session_id) AS c FROM usage_event WHERE ts >= $since',
  records: 'SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_event WHERE ts >= $since ORDER BY ts DESC, seq DESC, event_id DESC LIMIT 100 OFFSET 0',
}

console.log(`【A. 现状索引】库 ${state.schema}，${state.events} 条，窗口 30 天`)
await dropCandidateIndexes()
await backend.exec('ANALYZE TABLE usage_event')
const a = performance.now()
await report('COUNT(*)', SQL.count)
await report('totals（四项求和）', SQL.totals)
await report('series 原始行', SQL.series)
await report('groups(provider)', SQL.provider)
await report('COUNT(DISTINCT session)', SQL.sessions)
await report('records 首页', SQL.records)
console.log(`  （A 组合计 ${((performance.now() - a) / 1000).toFixed(1)}s）`)

console.log(`\n【B. 加 (ts, member_id)】`)
await backend.exec('CREATE INDEX idx_perf_ts_member ON usage_event (ts, member_id)')
await backend.exec('ANALYZE TABLE usage_event')
await report('COUNT(*)', SQL.count)
await report('totals（四项求和）', SQL.totals)
await report('series 原始行', SQL.series)
await report('groups(provider)', SQL.provider)
await report('COUNT(DISTINCT session)', SQL.sessions)
await report('records 首页', SQL.records)

console.log(`\n【C. 再加覆盖索引 (ts, 四项 token)】`)
await backend.exec('CREATE INDEX idx_perf_ts_cov ON usage_event (ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)')
await backend.exec('ANALYZE TABLE usage_event')
await report('COUNT(*)', SQL.count)
await report('totals（四项求和）', SQL.totals)
await report('series 原始行', SQL.series)
await report('groups(provider)', SQL.provider)
await report('COUNT(DISTINCT session)', SQL.sessions)
await report('records 首页', SQL.records)

console.log(`\n【D. 再加 (ts, session_id)】`)
await backend.exec('CREATE INDEX idx_perf_ts_session ON usage_event (ts, session_id)')
await backend.exec('ANALYZE TABLE usage_event')
await report('COUNT(*)', SQL.count)
await report('totals（四项求和）', SQL.totals)
await report('series 原始行', SQL.series)
await report('groups(provider)', SQL.provider)
await report('COUNT(DISTINCT session)', SQL.sessions)
await report('records 首页', SQL.records)

await backend.exec(`SELECT ROUND((data_length+index_length)/1024/1024,1) AS mb FROM information_schema.tables WHERE table_schema='${state.schema}' AND table_name='usage_event'`)

console.log('\n清理候选索引…')
await dropCandidateIndexes()
await backend.exec('ANALYZE TABLE usage_event')
console.log('完成（已恢复现状索引）')
await closeAllMysqlBackends()
