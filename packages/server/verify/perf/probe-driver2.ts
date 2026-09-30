/**
 * 性能摸底：**只用共享池连续打 N 条查询**，看驱动是否有「每请求」级别的固定成本。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-driver2.ts --scale 1e5
 * ```
 *
 * 目的：把「6 条 info_schema 语句 = 2.4ms 服务端时间」与「openPortalStore() 一次 = 72ms
 * 墙上时间」之间的差额钉到具体调用上。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, sharedMysqlBackend } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
interface PerfState { schema: string; url: string; events: number }

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e5')!
const state = JSON.parse(readFileSync(join(STATE_DIR, `${scale}.json`), 'utf8')) as PerfState
const target = { sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url }

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const backend = await sharedMysqlBackend(state.url)

// ① 连续 60 条小查询（= 十个「6 条」的批），看每 6 条的耗时分布
{
  const perSix: number[] = []
  for (let batch = 0; batch < 10; batch++) {
    const started = performance.now()
    for (let index = 0; index < 6; index++) await backend.get('SELECT 1')
    perSix.push(performance.now() - started)
  }
  console.log(`① 连续 6 × SELECT 1：${perSix.map((value) => value.toFixed(2)).join(', ')} ms`)
}

// ② 逐条量 openPortalStore()，看是不是首条贵
{
  const timings: number[] = []
  for (let index = 0; index < 10; index++) {
    const started = performance.now()
    await openPortalStore(target)
    timings.push(performance.now() - started)
  }
  console.log(`② openPortalStore() ×10：${timings.map((value) => value.toFixed(2)).join(', ')} ms`)
}

// ③ 对照：把闸门跑的那 6 条语句手工按同样顺序跑一遍（同一个池）
{
  const statements: [string, Record<string, string> | undefined][] = [
    ["SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name", undefined],
    ["SELECT schema_version FROM portal_meta WHERE id=1", undefined],
    ["SELECT version,checksum,status,last_completed_step,checkpoint_json FROM portal_schema_migrations WHERE version=$version", { $version: '7' }],
    ["SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=$table ORDER BY ordinal_position", { $table: 'member_groups' }],
    ["SELECT engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=$table", { $table: 'member_groups' }],
    ["SELECT index_name AS name,column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND non_unique=0 ORDER BY index_name,seq_in_index", { $table: 'member_groups' }],
  ]
  const timings: number[] = []
  for (let index = 0; index < 10; index++) {
    const started = performance.now()
    for (const [sql, params] of statements) await backend.all(sql, params)
    timings.push(performance.now() - started)
  }
  console.log(`③ 手工 6 条闸门语句 ×10：${timings.map((value) => value.toFixed(2)).join(', ')} ms`)
  console.log(`   中位 ${percentile(timings, 0.5).toFixed(2)}ms（对照 ② 的中位数）`)
}

// ④ 直接数：一次 openPortalStore() 到底发了几条语句（逐条打印，不做聚合）。
{
  const { spawnSync } = await import('node:child_process')
  const rootSql = (sql: string): string => {
    const result = spawnSync('docker', ['exec', '-i', 'local-database-review-mysql', '/tmp/atr-mysql-root.sh'], {
      input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`root SQL 失败：${result.stderr}`)
    return result.stdout
  }
  rootSql('SET GLOBAL general_log = ON;')
  const before = Date.now()
  await openPortalStore(target)
  rootSql('SET GLOBAL general_log = OFF;')
  const log = rootSql("SELECT argument FROM mysql.general_log WHERE event_time >= FROM_UNIXTIME(" + Math.floor(before / 1000) + ") AND command_type IN ('Query','Execute') AND argument NOT LIKE 'SET GLOBAL%' ORDER BY event_time;")
  const lines = log.split('\n').filter((line) => line.trim())
  console.log(`④ 一次 openPortalStore() → general_log 记录 ${lines.length} 条语句：`)
  for (const line of lines.slice(0, 40)) console.log(`     ${line.replace(/\s+/g, ' ').slice(0, 130)}`)
  if (lines.length > 40) console.log(`     … 另有 ${lines.length - 40} 条`)
}
