/**
 * 双轨对照验证：对**真实日志**同时跑 SQL 路径与直扫路径，
 * 断言两者的四项 token / calls / sessions / 分组 / 序列完全相等。
 *
 * 这不是单元测试（跑一次要十几秒），是一次性的人工验证脚本。
 *   bun run packages/cli/verify/verify-db-parity.ts
 */

import { resolvePaths } from '@ai-token-report/core'
import { openStats } from '@ai-token-report/core/db'
import { derive } from '@ai-token-report/core'
import type { GroupDimension } from '@ai-token-report/core'

const paths = resolvePaths()
const periods = [undefined, 'today', 'last7d', 'last30d', 'month'] as const
const dims: GroupDimension[] = ['provider', 'model', 'provider-model', 'project', 'day', 'hour']

let failures = 0
let checks = 0

function eq<T>(label: string, a: T, b: T): void {
  checks++
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) {
    failures++
    console.log(`  ❌ ${label}\n     SQL : ${sa}\n     SCAN: ${sb}`)
  }
}

function counts(c: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number; total: number }) {
  return { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, calls: c.calls, total: c.total }
}

console.log('='.repeat(70))
console.log('SQL 路径 vs 直扫路径 双轨对照（真实日志）')
console.log('='.repeat(70))
console.log(`会话日志: ${paths.sessionsRoot}`)
console.log(`本地库  : ${paths.dbPath}\n`)

for (const period of periods) {
  const label = period ?? '(全部)'
  console.log(`── period = ${label} ──`)

  const sql = await openStats({ sessionsRoot: paths.sessionsRoot, dbPath: paths.dbPath, ...(period ? { period } : {}) })
  const scan = await openStats({ sessionsRoot: paths.sessionsRoot, dbPath: paths.dbPath, ...(period ? { period } : {}), forceScan: true })

  try {
    if (sql.source !== 'sql') {
      failures++
      console.log(`  ❌ 期望走 SQL 路径，实际 ${sql.source}（${sql.degradedReason ?? ''}）`)
    }

    const st = sql.totals()
    const ct = scan.totals()
    eq(`${label} totals`, counts(st), counts(ct))
    eq(`${label} sessions`, sql.sessions, scan.sessions)
    eq(`${label} cacheHitRate`, derive(st).cacheHitRate, derive(ct).cacheHitRate)
    eq(`${label} cacheLeverage`, derive(st).cacheLeverage, derive(ct).cacheLeverage)

    console.log(
      `  总量 ${st.total.toLocaleString().padStart(15)}  调用 ${String(st.calls).padStart(6)}  会话 ${String(sql.sessions).padStart(3)}  命中率 ${(derive(st).cacheHitRate * 100).toFixed(1)}%`,
    )

    for (const dim of dims) {
      const a = sql.groups(dim)
      const b = scan.groups(dim)
      eq(`${label} groups(${dim}).keys`, a.map((r) => r.key), b.map((r) => r.key))
      eq(`${label} groups(${dim}).counts`, a.map((r) => counts(r.counts)), b.map((r) => counts(r.counts)))
      eq(`${label} groups(${dim}).sessions`, a.map((r) => r.sessions), b.map((r) => r.sessions))
      eq(`${label} groups(${dim}).firstTime`, a.map((r) => r.firstTime), b.map((r) => r.firstTime))
      eq(`${label} groups(${dim}).lastTime`, a.map((r) => r.lastTime), b.map((r) => r.lastTime))
    }

    for (const g of ['day', 'hour'] as const) {
      const a = sql.series(g, true)
      const b = scan.series(g, true)
      eq(`${label} series(${g}).buckets`, a.map((p) => p.bucket), b.map((p) => p.bucket))
      eq(`${label} series(${g}).counts`, a.map((p) => counts(p.counts)), b.map((p) => counts(p.counts)))
    }

    const ra = sql.records()
    const rb = scan.records()
    eq(`${label} records.length`, ra.length, rb.length)
    const key = (r: { eventId: string }) => r.eventId
    const sa = [...ra].sort((x, y) => key(x).localeCompare(key(y))).map((r) => ({ e: r.eventId, ...counts(r.usage), p: r.provider, m: r.model, t: r.time, c: r.cwd }))
    const sb = [...rb].sort((x, y) => key(x).localeCompare(key(y))).map((r) => ({ e: r.eventId, ...counts(r.usage), p: r.provider, m: r.model, t: r.time, c: r.cwd }))
    eq(`${label} records.content`, sa, sb)
  } finally {
    sql.close()
    scan.close()
  }
}

console.log('\n' + '='.repeat(70))
if (failures === 0) {
  console.log(`✅ 全部通过：${checks} 项断言，两条路径逐位一致`)
} else {
  console.log(`❌ ${failures} / ${checks} 项断言失败`)
  process.exitCode = 1
}
console.log('='.repeat(70))