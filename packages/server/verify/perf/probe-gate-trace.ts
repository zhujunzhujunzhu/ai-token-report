/**
 * 临时性能诊断：给 `MysqlBackend` 打一层「逐条计时」补丁，定位 `openPortalStore()`
 * 的 80ms 到底花在哪一条语句上。
 *
 * ⚠️ 这是**排查用**脚本，它 patch 的是进程内的 `sharedMysqlBackend` 结果对象，
 *   不修改仓库源码。跑完即可删。
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

const backend = await sharedMysqlBackend(state.url)
const originals = { all: backend.all.bind(backend), get: backend.get.bind(backend), run: backend.run.bind(backend), exec: backend.exec.bind(backend) }
const log: { sql: string; ms: number; kind: string }[] = []
let recording = false
function wrap<K extends keyof typeof originals>(kind: K): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(backend as any)[kind] = async (sql: string, params?: unknown) => {
    const started = performance.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (originals[kind] as any)(sql, params)
    } finally {
      if (recording) log.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 100), ms: performance.now() - started, kind: String(kind) })
    }
  }
}
wrap('all'); wrap('get'); wrap('run'); wrap('exec')

// 预热（把建池、连接握手排除）
for (let index = 0; index < 3; index++) await openPortalStore(target)

recording = true
const started = performance.now()
await openPortalStore(target)
const total = performance.now() - started
recording = false

console.log(`openPortalStore() 总耗时 ${total.toFixed(1)}ms，逐条语句 ${log.length} 条：`)
let sum = 0
for (const entry of log) { sum += entry.ms; console.log(`  ${entry.ms.toFixed(2).padStart(8)}ms  ${entry.kind.padEnd(4)} ${entry.sql}`) }
console.log(`  合计 ${sum.toFixed(2)}ms；未归属（不含在语句里的时间）${(total - sum).toFixed(2)}ms`)

await closeAllMysqlBackends()
