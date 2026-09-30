/**
 * 性能摸底：**驱动往返开销** —— 回答「一条语句从 JS 发出到拿到结果要多久」。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-driver.ts --scale 1e5
 * ```
 *
 * ## 为什么必须单独量这一项
 *
 * `performance_schema` 只统计**服务端执行时间**，而本仓每个看板请求会发
 * **二十多条语句**（schema 闸门 + 鉴权 + 取数）。如果每条语句的**客户端往返**
 * 是几毫秒，那 `26 × N` 就是请求延迟的主体 —— 而这部分在看板代码里完全看不见，
 * 只有单独量驱动程序才能发现。
 *
 * 量三种形状：
 * - `SELECT 1` —— 最小往返（无表、无解析负担）
 * - `SELECT @@SESSION.sql_mode` —— 一条真实的小系统查询
 * - 一条 `information_schema` 目录查询（闸门里跑 8 次的那条）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')

interface PerfState { schema: string; url: string; events: number; memberCount: number }

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e5')!
const repeats = Number(arg('repeats', '200'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState

const backend = await sharedMysqlBackend(state.url)

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const probes: { name: string; sql: string; note: string }[] = [
  { name: 'SELECT 1', sql: 'SELECT 1', note: '最小往返' },
  { name: 'SELECT @@SESSION.sql_mode', sql: 'SELECT @@SESSION.sql_mode AS mode', note: '系统变量（闸门/入库各一次）' },
  {
    name: 'information_schema.tables（闸门）',
    sql: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name",
    note: '每个请求跑 8 次',
  },
  {
    name: 'information_schema.columns（闸门）',
    sql: "SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event' ORDER BY ordinal_position",
    note: '每个请求跑 4 次',
  },
  { name: 'portal_meta 版本', sql: 'SELECT schema_version FROM portal_meta WHERE id=1', note: '每个请求跑 4 次' },
]

console.log(`驱动往返（只读探针，各 ${repeats} 次）：${state.schema}`)
for (const probe of probes) {
  for (let index = 0; index < 10; index++) await backend.all(probe.sql)
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    await backend.all(probe.sql)
    timings.push(performance.now() - started)
  }
  console.log(`  ${probe.name.padEnd(34)} p50=${percentile(timings, 0.5).toFixed(3)}ms p95=${percentile(timings, 0.95).toFixed(3)}ms min=${Math.min(...timings).toFixed(3)}ms  ${probe.note}`)
}

// 串行 26 条（= 一个看板请求的语句条数）看累计往返。
const started = performance.now()
for (let index = 0; index < 26; index++) await backend.all('SELECT 1')
console.log(`  串行 26 × SELECT 1 → ${(performance.now() - started).toFixed(1)}ms`)

await closeAllMysqlBackends()
