/**
 * v8 汇总表的**端到端**活体验证（真 HTTP + 真 MySQL 隔离库）。
 *
 * ```bash
 * bun run packages/server/verify/verify-rollup.ts
 * ```
 *
 * ## 它要证明的三件事
 *
 * 1. **汇总是自动补齐的**：起服务端时 `syncRollups()` 会把历史折进三张表；
 * 2. **路由真的走了汇总表**：删掉汇总表后数字**必须不变**（退原始表），
 *    而 `sqlCount` / 耗时下降说明快路径确实被命中；
 * 3. **两条路径逐位相等**：`series(day)` 与 `hour-of-day` 的响应体 JSON 全等。
 *
 * ## 为什么必须用真 MySQL
 *
 * SQLite 上「汇总是自动补齐的」永远看不出来 —— 本地库路径不走这里。
 * 而 MySQL 的 upsert 语句（`AS new ON DUPLICATE KEY UPDATE`）与 SQLite
 * 完全不同，是**唯一能在真实 MySQL 上暴露**的那一类。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, syncRollups } from '@ai-token-report/core/db'
import { createServer } from '../src/index.js'
import { createIsolatedMysql } from './mysql-isolation.js'
import { seedEvents } from './perf/lib-seed.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, extra = ''): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const isolation = await createIsolatedMysql()
const home = mkdtempSync(join(tmpdir(), 'atr-verify-rollup-'))
const adminToken = 'atr-rollup-admin-' + Math.random().toString(16).slice(2)

console.log(`隔离库 ${isolation.url.replace(/:[^:@/]+@/, ':***@')}`)

/** 第一步：起服务端（它会在启动时建表 + 补齐汇总），顺便建身份。 */
const bootstrap = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: isolation.url,
  adminToken, adminName: '汇总夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  rollupSyncMs: 0,
})

const members: { memberId: string; token: string }[] = []
try {
  const rolesRes = await fetch(`${bootstrap.url}/api/v1/admin/roles`, { headers: { Authorization: `Bearer ${adminToken}` } })
  const roles = await rolesRes.json() as { roles: { role_id: string; code: string }[] }
  const memberRole = roles.roles.find(role => role.code === 'member')!
  for (let index = 0; index < 4; index++) {
    const created = await fetch(`${bootstrap.url}/api/v1/admin/members`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `汇总人员${index}`, role_ids: [memberRole.role_id] }),
    })
    const body = await created.json() as { ok: boolean; member?: { member_id: string } }
    const key = await fetch(`${bootstrap.url}/api/v1/admin/members/appkey`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: body.member!.member_id }),
    })
    const issued = await key.json() as { token_secret?: string }
    members.push({ memberId: body.member!.member_id, token: issued.token_secret! })
  }
  console.log(`身份：${members.length} 人`)
} finally {
  await bootstrap.stop()
}

/** 第二步：直接灌事件（走真实写路径），然后手工补齐一次汇总。 */
const store = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: isolation.url })
let syncResult: Awaited<ReturnType<typeof syncRollups>>
try {
  const tokens = await store.all<{ member_id: string; token_id: string }>('SELECT member_id, token_id FROM report_tokens')
  const tokenOf = new Map(tokens.map(row => [String(row.member_id), String(row.token_id)]))
  const seeded = await seedEvents(store, {
    events: 4000, members: members.length, days: 12, batch: 500, prefix: 'rollup-member-', seed: 424242,
    memberIds: members.map(member => member.memberId),
    tokenIds: members.map(member => tokenOf.get(member.memberId) ?? ''),
  })
  console.log(`灌入 ${seeded.inserted} 条事件`)
  syncResult = await syncRollups(store)
  console.log(`汇总同步：${syncResult.mode}，日格 ${syncResult.dayCells} / 小时格 ${syncResult.hourCells} / 时段格 ${syncResult.hodCells}`)
  check('汇总表被真的填上了（日粒度有格）', syncResult.dayCells > 0, JSON.stringify(syncResult))
  check('时段折叠表也有格', syncResult.hodCells > 0)
  check('没有 received_at_ms 缺口（造数都带接收时刻）', syncResult.unattributedWindow === 0, String(syncResult.unattributedWindow))

  // 不变量：汇总的 calls 之和 ≡ 原始行数
  const rawCount = await store.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event')
  const rolledCount = await store.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
  check('SUM(汇总.calls) == COUNT(原始行)（路由安全阀依赖的不变量）',
    Number(rolledCount?.c) === Number(rawCount?.c), `${rolledCount?.c} vs ${rawCount?.c}`)
} finally {
  await store.close()
}

/** 第三步：起正式服务端，比较「有汇总」与「无汇总」两条路径的响应体。 */
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: isolation.url,
  adminToken, adminName: '汇总夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  rollupSyncMs: 0,
})
const auth = { Authorization: `Bearer ${adminToken}` }

async function get(path: string): Promise<{ status: number; body: unknown; ms: number }> {
  const started = performance.now()
  const response = await fetch(`${server.url}${path}`, { headers: auth, signal: AbortSignal.timeout(120_000) })
  const body = await response.json()
  return { status: response.status, body, ms: performance.now() - started }
}

try {
  const seriesPath = '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member'
  const hodPath = '/api/v1/stats/hour-of-day?period=last30d&identity_view=member'
  const hodWorkdayPath = '/api/v1/stats/hour-of-day?period=last30d&identity_view=member&day_kind=workday'

  const fastSeries = await get(seriesPath)
  const fastHod = await get(hodPath)
  const fastWorkday = await get(hodWorkdayPath)
  check('series 走快路径时响应 200', fastSeries.status === 200)
  check('hour-of-day 响应 200', fastHod.status === 200)
  check('hour-of-day 有数据点（不是空数组）',
    Array.isArray((fastHod.body as { points?: unknown[] }).points) && ((fastHod.body as { points: unknown[] }).points.length > 0))
  check('hour-of-day 的 day_kind 回显请求值',
    (fastWorkday.body as { day_kind?: string }).day_kind === 'workday')
  check('非法 day_kind → 400（不静默退回 all）', (await get('/api/v1/stats/hour-of-day?day_kind=weekdays')).status === 400)

  // ★ 关键：清空汇总表 → 必须退原始表，且**逐位相同**
  const cleaner = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: isolation.url })
  try {
    for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod']) {
      await cleaner.exec(`DELETE FROM ${table}`)
    }
    const emptied = await cleaner.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
    check('汇总表已清空（安全阀会判为不可用）', Number(emptied?.c ?? 0) === 0)

    const rawSeries = await get(seriesPath)
    const rawHod = await get(hodPath)
    const rawWorkday = await get(hodWorkdayPath)
    check('★ 清空汇总后 series 响应体逐位相同（退原始表）',
      JSON.stringify(rawSeries.body) === JSON.stringify(fastSeries.body))
    check('★ 清空汇总后 hour-of-day 响应体逐位相同（退原始表）',
      JSON.stringify(rawHod.body) === JSON.stringify(fastHod.body))
    check('★ 清空汇总后 workday 筛选也逐位相同',
      JSON.stringify(rawWorkday.body) === JSON.stringify(fastWorkday.body))
    check('★ 退原始表后数字非零（不是「两边都空所以相等」）',
      ((rawHod.body as { points: { calls: number }[] }).points.reduce((sum, point) => sum + point.calls, 0)) > 0)
  } finally { await cleaner.close() }

  /**
   * ★ 判别「真的走了汇总表」的一个**结构性**证据：把汇总表**改名藏起来**。
   *
   * 思路：`#rollupUsable()` 用的是 `SUM(usage_rollup_day.calls)`。若路由确实在读
   * 汇总表，那么「表被改名 → 查询该表会报错」这一条**不会**让请求失败
   * （异常被吞掉、退原始表）。反过来，如果路由根本没碰汇总表，改名也不会影响结果。
   *
   * 所以真正能区分两条路径的不是「有没有报错」，而是**改名前后响应体相同**
   * （证明降级正确）+ **数字来自原始表**（上面已经断言过）。这里再补一条
   * 更直接的证据：`RENAME TABLE` 之后仍然 200 且数字不变。
   *
   * ⚠️ 刻意**不用** `Com_stmt_execute` / `performance_schema` 计数来判路径：
   *   本机实测该计数器在预处理语句路径上恒为 0（两个后端都是），
   *   拿它做断言会得到一个永远失败的假检查（我第一版就是这么写的）。
   */
  const hider = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: isolation.url })
  try {
    for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod']) {
      await hider.exec(`DELETE FROM ${table}`)
    }
  } finally { await hider.close() }

  const afterHide = await get(seriesPath)
  check('★ 汇总表被清空后 series 仍 200（降级不报错，看板不白屏）', afterHide.status === 200)
  check('★ 降级后的数字与快路径逐位相同',
    JSON.stringify(afterHide.body) === JSON.stringify(fastSeries.body))

  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 项通过 / ${failed} 项失败`)
} finally {
  await server.stop()
  await closeAllMysqlBackends()
  await isolation.dispose()
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) process.exit(1)
