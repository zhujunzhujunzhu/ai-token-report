/**
 * 性能摸底：**逐个操作的真实客户端耗时** —— 用服务器自己的门面函数，
 * 而不是手工拼 SQL。
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-ops.ts --scale 1e5
 * ```
 *
 * ## 为什么还要这一个
 *
 * 前面的探针各测了一半：
 * - `profile-request` 给出**服务端**执行时间（performance_schema）→ 一个请求 ~10ms；
 * - `probe-inproc` 给出**端到端** handler 时间 → 一个请求 350~500ms。
 *
 * 两者差 30~50 倍，而中间只剩「客户端驱动的往返 + 结果物化」这一段。
 * 本探针用**本仓真实的门面函数**（`openPortalStats` + `totals()` / `series()` /
 * `groups()` / `records()`）逐个量，于是：
 *
 * ① 每个操作的端到端耗时有了准确归属；
 * ② 顺带证明「时间花在驱动/连接，还是花在查询本身」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStats } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = join(STATE_DIR, 'results')

interface PerfState { schema: string; url: string; adminToken: string; events: number; memberCount: number }

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

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const sinceMs = Date.now() - 30 * 86_400_000
const filter = { sinceMs, identityView: 'member' as const }

const ops: { name: string; run: (session: Awaited<ReturnType<typeof openPortalStats>>) => Promise<unknown> }[] = [
  { name: 'openPortalStats（含 schema 闸门）', run: async () => { /* 由外面测 */ } },
  { name: 'totals()', run: async (session) => await session.totals() },
  { name: 'sessions()', run: async (session) => await session.sessions() },
  { name: 'unattributedCalls()', run: async (session) => await session.unattributedCalls() },
  { name: 'distinctUsers()', run: async (session) => await session.distinctUsers() },
  { name: 'timeBounds()', run: async (session) => await session.timeBounds() },
  { name: 'series(day)', run: async (session) => await session.series('day', true) },
  { name: 'stackSeries(user,day)', run: async (session) => await session.stackSeries('user', 'day') },
  { name: 'groups(user)', run: async (session) => await session.groups('user') },
  { name: 'groups(group)', run: async (session) => await session.groups('group') },
  { name: 'groups(provider)', run: async (session) => await session.groups('provider') },
  { name: 'groups(day)', run: async (session) => await session.groups('day') },
  { name: 'groups(project)', run: async (session) => await session.groups('project') },
  { name: 'records(100,0)', run: async (session) => await session.records(100, 0) },
]

console.log(`逐个操作的真实客户端耗时（库内 ${state.events} 条，窗口 30 天，各 ${repeats} 次）`)
const report: Record<string, { p50: number; p95: number }> = {}

// ① 先单独量「开一个统计会话」（闸门 + 别名加载）——它在**每次 API 请求**里都跑一次。
{
  const timings: number[] = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const session = await openPortalStats(target, filter, undefined, false)
    timings.push(performance.now() - started)
    await session.close()
  }
  report['openPortalStats（含 schema 闸门）'] = {
    p50: Number(percentile(timings, 0.5).toFixed(2)), p95: Number(percentile(timings, 0.95).toFixed(2)),
  }
  console.log(`  ${'openPortalStats（含 schema 闸门）'.padEnd(30)} p50=${String(report['openPortalStats（含 schema 闸门）']!.p50).padStart(8)}ms p95=${String(report['openPortalStats（含 schema 闸门）']!.p95).padStart(8)}ms`)
}

// ② 其余操作共用一个会话（真实请求也是一次会话跑多个操作）。
for (const op of ops.slice(1)) {
  const session = await openPortalStats(target, filter, undefined, false)
  try {
    await op.run(session)
    const timings: number[] = []
    for (let index = 0; index < repeats; index++) {
      const started = performance.now()
      await op.run(session)
      timings.push(performance.now() - started)
    }
    report[op.name] = { p50: Number(percentile(timings, 0.5).toFixed(2)), p95: Number(percentile(timings, 0.95).toFixed(2)) }
    console.log(`  ${op.name.padEnd(30)} p50=${String(report[op.name]!.p50).padStart(8)}ms p95=${String(report[op.name]!.p95).padStart(8)}ms`)
  } finally {
    await session.close()
  }
}

mkdirSync(RESULT_DIR, { recursive: true })
const file = join(RESULT_DIR, `${scale}-ops.json`)
writeFileSync(file, JSON.stringify({ scale, repeats, window: 'last30d', report, generatedAt: new Date().toISOString() }, null, 2))
console.log(`\n结果已写：${file}`)
await closeAllMysqlBackends()
