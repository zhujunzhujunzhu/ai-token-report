/**
 * 性能摸底：**固定开销归因** —— 看板请求的 350~600ms 里，SQL 只占十几毫秒，
 * 剩下的时间去哪了？
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-overhead.ts --scale 1e5
 * ```
 *
 * 做法：对**同一条路径**打三类请求，各自量 p50——
 *
 * | 探针 | 它跳过什么 |
 * |---|---|
 * | `GET /api/health` | 跳过鉴权、跳过库 |
 * | `GET /api/v1/identity/verify`（带凭证） | 走鉴权，不查统计 |
 * | `POST /api/v1/token-usage`（200 条） | 走鉴权 + 一次写事务 |
 * | `GET /api/v1/stats/overview` | 全链路 |
 *
 * 四者的差值就是每一层的固定开销。★ 这一步很重要：只看总耗时会让人
 * 去优化 SQL，而如果时间花在固定开销上，优化 SQL 一点用都没有。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends } from '@ai-token-report/core/db'
import { createServer } from '../../src/index.js'

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

const scale = arg('scale', '1e5')!
const repeats = Number(arg('repeats', '30'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState

const home = join(STATE_DIR, `probe-home-${scale}`)
mkdirSync(home, { recursive: true })
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '性能夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})
console.log(`服务端 ${server.url}；库内 ${state.events} 条（${state.schema}），每个探针 ${repeats} 次`)

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

let ingestSeq = 0
function ingestBody(): string {
  const session = `probe-${Date.now()}-${ingestSeq}`
  ingestSeq++
  return JSON.stringify({
    schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(),
    records: Array.from({ length: 200 }, (_, seq) => ({
      event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
      provider: 'deepseek-official', model: 'deepseek-chat', cwd: 'D:\\perf',
      input_tokens: 20_000, output_tokens: 1_000, cache_read_tokens: 728_000,
      cache_write_tokens: 1_000, reasoning_tokens: 200, total_tokens: 750_000, turn: 1, step: seq,
    })),
  })
}

const probes: { name: string; run: () => Promise<Response>; note: string }[] = [
  {
    name: 'health（无鉴权、无库）',
    note: '纯 HTTP + 进程内',
    run: async () => await fetch(`${server.url}/api/health`),
  },
  {
    name: 'stats/overview（未带凭证 → 401）',
    note: '鉴权失败短路',
    run: async () => await fetch(`${server.url}/api/v1/stats/overview?period=last30d`),
  },
  {
    name: 'identity/verify（走鉴权，不查统计）',
    note: '鉴权成功',
    run: async () => await fetch(`${server.url}/api/v1/identity/verify`, { headers: { Authorization: `Bearer ${state.members[0]!.token}` } }),
  },
  {
    name: 'stats/overview（全链路）',
    note: '鉴权 + 统计会话 + 闸门 + 查询',
    run: async () => await fetch(`${server.url}/api/v1/stats/overview?period=last30d&identity_view=member`, { headers: { Authorization: `Bearer ${state.adminToken}` } }),
  },
  {
    name: 'stats/groups（目录，不含用量）',
    note: '鉴权 + 闸门 + 一条目录查询',
    run: async () => await fetch(`${server.url}/api/v1/stats/groups`, { headers: { Authorization: `Bearer ${state.adminToken}` } }),
  },
  {
    name: 'ingest（200 条）',
    note: '鉴权 + 写事务',
    run: async () => await fetch(`${server.url}/api/v1/token-usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.members[0]!.token}`, 'Content-Type': 'application/json' },
      body: ingestBody(),
    }),
  },
]

const report: Record<string, { p50: number; p95: number; min: number; status: number }> = {}
try {
  for (const probe of probes) {
    for (let index = 0; index < 5; index++) await (await probe.run()).text() // 预热
    const timings: number[] = []
    let status = 0
    for (let index = 0; index < repeats; index++) {
      const started = performance.now()
      const response = await probe.run()
      await response.text()
      timings.push(performance.now() - started)
      status = response.status
    }
    const entry = {
      p50: Number(percentile(timings, 0.5).toFixed(1)),
      p95: Number(percentile(timings, 0.95).toFixed(1)),
      min: Number(Math.min(...timings).toFixed(1)),
      status,
    }
    report[probe.name] = entry
    console.log(`  ${probe.name.padEnd(38)} p50=${String(entry.p50).padStart(7)}ms p95=${String(entry.p95).padStart(7)}ms min=${String(entry.min).padStart(6)}ms HTTP ${status}  ${probe.note}`)
  }
} finally {
  await server.stop()
  await closeAllMysqlBackends()
}

mkdirSync(RESULT_DIR, { recursive: true })
const file = join(RESULT_DIR, `${scale}-overhead.json`)
writeFileSync(file, JSON.stringify({ scale, repeats, report, generatedAt: new Date().toISOString() }, null, 2))
console.log(`\n结果已写：${file}`)
