/**
 * 性能摸底：**优化方案 A/B 实测**（不改仓库源码，靠进程内打桩模拟）。
 *
 * ```bash
 * bun run packages/server/verify/perf/ab-optimize.ts --scale 1e6
 * ```
 *
 * ## 为什么能这样测
 *
 * 三个候选优化都在**同一条缝**上：服务端拿到的是一个 `MysqlBackend` 对象
 * （由 `sharedMysqlBackend(url)` 返回、按 URL 缓存）。本脚本在**起服务端之前**
 * 把那个对象的方法换成包装版，于是服务端后续每一句 SQL 都经过我们 ——
 * 于是可以：
 *
 * | 方案 | 打桩做法 | 对应的真实改法 |
 * |---|---|---|
 * | A. 结构闸门降为「启动一次 + 版本指纹」 | 命中 information_schema 的语句直接返回缓存结果，不再发往 MySQL | `ensurePortalReady()` 只比对 `portal_meta.schema_version` + 迁移账本 checksum，逐表核对留在启动 |
 * | B. 旧视图自检不再每请求跑 | `SELECT DISTINCT member_id, user_id` 返回缓存结果 | `assertLegacyIdentityView()` 只在 `identity_view=legacy` **且**库内存在待确认历史时才跑（或按会话/时间窗缓存） |
 * | A+B | 两者同时 | — |
 *
 * ★ 这里量的是**上界**：真实实现还要加版本指纹比对与失效条件（会有少量额外查询），
 *   但不会改变数量级。基线（未打桩）与打桩后的差值就是收益。
 *
 * ⚠️ 打桩只影响**本进程**，不写库、不改源码。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, sharedMysqlBackend, type MysqlBackend } from '@ai-token-report/core/db'
import type { createHandlerFor } from '../../src/index.js'

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
const repeats = Number(arg('repeats', '15'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState & { ingestToken?: string }
if (!state.ingestToken) state.ingestToken = state.members[0]!.token

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const PATHS = [
  { name: 'stats/overview', path: '/api/v1/stats/overview?period=last30d&identity_view=member' },
  { name: 'stats/breakdown:user', path: '/api/v1/stats/breakdown?by=user&period=last30d&identity_view=member' },
  { name: 'stats/series:day', path: '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member' },
  { name: 'stats/records:100', path: '/api/v1/stats/records?period=last30d&limit=100&identity_view=member' },
  { name: 'stats/groups', path: '/api/v1/stats/groups' },
  { name: 'ingest(200)', path: '__INGEST__' },
]

const home = join(STATE_DIR, `ab-home-${scale}`)
mkdirSync(home, { recursive: true })

/** 每一轮都用**同一个** handler，只在两轮之间切换打桩开关。 */
let mode: 'baseline' | 'gate' | 'legacy' | 'both' = 'baseline'
const cache = new Map<string, unknown>()
let cachedStatements = 0
let passedStatements = 0

/**
 * 进程级打桩：直接替换共享后端的方法。
 *
 * ★ 打桩必须在 `createHandlerFor()` **之前**装好 —— 服务端在启动时会跑一次真闸门
 *   （那一次应当是真跑，也正好是「启动校验一次」的真实形态）。
 */
async function patchBackend(): Promise<void> {
  const backend = await sharedMysqlBackend(state.url) as MysqlBackend
  const originalAll = backend.all.bind(backend)
  const originalGet = backend.get.bind(backend)
  const isGate = (sql: string): boolean =>
    /information_schema\s*\.\s*`?(tables|columns|statistics|key_column_usage|table_constraints|check_constraints|referential_constraints)`?/i.test(sql) ||
    /FROM `portal_meta`/i.test(sql)
  const isLegacyCheck = (sql: string): boolean => /SELECT DISTINCT member_id/i.test(sql) && /usage_event/i.test(sql)
  const active = (sql: string): boolean =>
    ((mode === 'gate' || mode === 'both') && isGate(sql)) ||
    ((mode === 'legacy' || mode === 'both') && isLegacyCheck(sql))

  backend.all = (async (sql: string, params?: never) => {
    if (active(sql)) {
      const key = `${sql}|${JSON.stringify(params ?? null)}`
      if (cache.has(key)) { cachedStatements++; return cache.get(key) }
      const rows = await originalAll(sql, params)
      cache.set(key, rows)
      passedStatements++
      return rows
    }
    passedStatements++
    return await originalAll(sql, params)
  }) as MysqlBackend['all']
  backend.get = (async (sql: string, params?: never) => {
    if (active(sql)) {
      const key = `${sql}|${JSON.stringify(params ?? null)}`
      if (cache.has(key)) { cachedStatements++; return cache.get(key) }
      const row = await originalGet(sql, params)
      cache.set(key, row)
      passedStatements++
      return row
    }
    passedStatements++
    return await originalGet(sql, params)
  }) as MysqlBackend['get']
}
await patchBackend()

const { createHandlerFor: create } = await import('../../src/index.js') as { createHandlerFor: typeof createHandlerFor }
const bundle = await create({
  dshHome: home, dataDir: join(home, 'data'), dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})
console.log(`库内 ${state.events} 条（${state.schema}），每个用例 ${repeats} 次；A/B 全部走进程内 handler`)

const adminAuth = { Authorization: `Bearer ${state.adminToken}` }
let ingestSeq = 0
async function send(path: string): Promise<number> {
  const started = performance.now()
  if (path === '__INGEST__') {
    const session = `ab-${mode}-${Date.now()}-${ingestSeq}`
    ingestSeq++
    const member = state.members?.[ingestSeq % (state.members?.length ?? 1)]
    void member
    const response = await bundle.handler(new Request('http://127.0.0.1/api/v1/token-usage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.ingestToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(),
        records: Array.from({ length: 200 }, (_, seq) => ({
          event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
          provider: 'deepseek-official', model: 'deepseek-chat', cwd: 'D:\\perf',
          input_tokens: 20_000, output_tokens: 1_000, cache_read_tokens: 728_000,
          cache_write_tokens: 1_000, reasoning_tokens: 200, total_tokens: 750_000, turn: 1, step: seq,
        })),
      }),
    }))
    await response.text()
    return performance.now() - started
  }
  const response = await bundle.handler(new Request(`http://127.0.0.1${path}`, { headers: adminAuth }))
  await response.text()
  return performance.now() - started
}

const results: Record<string, Record<string, number>> = {}
const modes: ('baseline' | 'gate' | 'legacy' | 'both')[] = ['baseline', 'gate', 'legacy', 'both']

try {
  for (const current of modes) {
    mode = current
    console.log(`\n── 模式 ${current} ──`)
    const row: Record<string, number> = {}
    for (const entry of PATHS) {
      for (let index = 0; index < 3; index++) await send(entry.path)
      const timings: number[] = []
      for (let index = 0; index < repeats; index++) timings.push(await send(entry.path))
      row[entry.name] = Number(percentile(timings, 0.5).toFixed(1))
      console.log(`  ${entry.name.padEnd(22)} p50=${String(row[entry.name]).padStart(8)}ms`)
    }
    results[current] = row
  }
} finally {
  await bundle.close()
  await closeAllMysqlBackends()
}

console.log('\n优化收益（p50，单位 ms）：')
const header = ['用例'.padEnd(22), ...modes.map((entry) => entry.padStart(10)), 'A+B 提升'.padStart(12)]
console.log(header.join(' '))
for (const entry of PATHS) {
  const base = results['baseline']![entry.name]!
  const both = results['both']![entry.name]!
  const gain = base > 0 ? `${(((base - both) / base) * 100).toFixed(0)}%` : '-'
  console.log([entry.name.padEnd(22), ...modes.map((m) => String(results[m]![entry.name]).padStart(10)), gain.padStart(12)].join(' '))
}
console.log(`\n打桩统计：真实发往 MySQL ${passedStatements} 条，被缓存拦下 ${cachedStatements} 条`)

mkdirSync(RESULT_DIR, { recursive: true })
const file = join(RESULT_DIR, `${scale}-ab.json`)
writeFileSync(file, JSON.stringify({ scale, repeats, results, passedStatements, cachedStatements, generatedAt: new Date().toISOString() }, null, 2))
console.log(`结果已写：${file}`)
