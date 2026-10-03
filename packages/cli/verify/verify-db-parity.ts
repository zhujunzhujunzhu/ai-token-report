/**
 * 双轨对照验证：对**真实日志**同时跑 SQL 路径与直扫路径，
 * 断言两者的四项 token / calls / sessions / 分组 / 序列完全相等。
 *
 * 这不是单元测试（跑一次要十几秒），是一次性的人工验证脚本。
 *   bun run packages/cli/verify/verify-db-parity.ts
 */

import { resolvePaths, resolveSourceRoots } from '@ai-token-report/core'
import { openStats } from '@ai-token-report/core/db'
import { derive } from '@ai-token-report/core'
import type { GroupDimension } from '@ai-token-report/core'

const paths = resolvePaths()
/**
 * ★ **冻结窗口**：右端落在**昨天 24:00**，不可能再被写入。
 *
 * 为什么不用 `period`（today / last7d / …）：那些窗口的右端是「现在」，
 * 而这条脚本要跑两次取数（库一次、直扫一次）——**这台机器上正在进行的工作
 * 本身就在写日志**，两次取数之间落进来的新事件足以让断言失败。
 * 实测症状：失败项在两次运行之间**来回变**（先 `today`、后 `(全部)`），
 * 与口径毫无关系；同一台机器用冻结窗口对照时逐位一致（1,609 条 / 2.69 亿 token）。
 *
 * 要看含今天的实时窗口，加 `--live`（那是信息性的，天然可能因新事件而不同）。
 */
const DAY = 86_400_000
const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const windows = process.argv.includes('--live')
  ? [
    { label: '截至昨天（全部历史）', untilMs: todayStart - 1 },
    { label: '今天（实时，可能漂移）', period: 'today' },
    { label: '近 7 天（含今天，实时）', period: 'last7d' },
    { label: '本月（含今天，实时）', period: 'month' },
  ]
  : [
    { label: '截至昨天（全部历史）', untilMs: todayStart - 1 },
    { label: '昨天', sinceMs: todayStart - DAY, untilMs: todayStart - 1 },
    { label: '近 7 天（截至昨天）', sinceMs: todayStart - 7 * DAY, untilMs: todayStart - 1 },
    { label: '近 30 天（截至昨天）', sinceMs: todayStart - 30 * DAY, untilMs: todayStart - 1 },
  ] as const
const dims: GroupDimension[] = ['provider', 'model', 'provider-model', 'project', 'day', 'hour']

/**
 * ★ 多来源之下，**两条路径必须吃同一份带来源的根清单**。
 *
 * 这条脚本比的是「库查询 == 直扫」，而它们的取数范围来自两个不同的入参：
 *
 * | 路径 | 范围从哪来 |
 * |---|---|
 * | 库（`openStats` 不传 `forceScan`） | `sources: ['dsh']` ⇒ SQL 里按来源筛 |
 * | 直扫（`forceScan: true`） | **`sourceRoots`** —— 不传就退回 `sessionsRoot`（DSH 的根） |
 *
 * 只筛 `sources` 而不给 `sourceRoots` 时，直扫那侧仍会按**全部已注册来源**列举：
 * 于是屏幕上出现的是「库 = 只有 DSH / 直扫 = DSH + Codex + Claude Code」，
 * 表现为一大堆 `records.length` / `records.content` 断言失败，而**根因与口径无关**。
 * 本机实测（2026-10，`~/.claude` 有 551 次真实调用）差了 5,000 多万 token。
 */
const dshRoots = resolveSourceRoots({ sources: ['dsh'] })
if (dshRoots.roots.length === 0) {
  process.stderr.write(`❌ 没有可用的 DSH 会话目录：${paths.sessionsRoots.join(' / ')}\n`)
  process.exit(1)
}

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
console.log(`会话日志: ${dshRoots.roots.map((r) => r.path).join(' + ')}（${dshRoots.roots.length} 个 DSH 根）`)
console.log(`本地库  : ${paths.dbPath}\n`)

for (const win of windows) {
  const label = win.label
  const windowParam = 'period' in win && win.period !== undefined
    ? { period: win.period }
    : {
      ...('sinceMs' in win && win.sinceMs !== undefined ? { sinceMs: win.sinceMs } : {}),
      ...('untilMs' in win && win.untilMs !== undefined ? { untilMs: win.untilMs } : {}),
    }
  console.log(`── ${label} ──`)

  // 🚨 多来源之后必须**同时**给「来源筛选」与「带来源的根」：
  //   - `sources: ['dsh']` 让**库**那条路按来源筛（库里装着 Codex / Claude Code 的记录，
  //     那是正确的，但这里只对照 DSH）；
  //   - `sourceRoots` 让**直扫**那条路用同一批根 —— 不给它，直扫会按全部已注册来源列举，
  //     比的就是「只有 DSH 的库」与「DSH + 别的来源的直扫」。
  const scope = {
    sessionsRoot: dshRoots.roots.map((root) => root.path),
    dbPath: paths.dbPath,
    sources: ['dsh'] as const,
    sourceRoots: dshRoots.roots,
  }
  const sql = await openStats({ ...scope, ...windowParam })
  const scan = await openStats({ ...scope, ...windowParam, forceScan: true })

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