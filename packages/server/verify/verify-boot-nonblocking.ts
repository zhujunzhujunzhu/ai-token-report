/**
 * **启动不被汇总补齐阻塞**的验证（真 MySQL 隔离库 + 大表）。
 *
 * ```bash
 * bun run packages/server/verify/verify-boot-nonblocking.ts --scale 1e6
 * ```
 *
 * ## 它证明什么
 *
 * 实测背景：1M 行时首次全量重建的一批要 **19.5 秒**。
 * 若 `createHandlerFor()` 里 `await` 它，服务端 20 秒后才监听 —— 部署健检必挂。
 *
 * 本脚本钉住三条：
 * 1. `createServer()` 在**几秒内**返回（而不是 20 秒）；
 * 2. 返回后 `/api/health` 立刻可答（端口真的在监听）；
 * 3. 与此同时**看板请求立刻正确**（走原始表），等补齐追上后数字**逐位不变**。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, readRollupMeta } from '@ai-token-report/core/db'
import { createServer } from '../src/index.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, extra = ''): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const STATE_DIR = resolve('.artifacts/perf')
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e6')!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
  schema: string; url: string; adminToken: string; events: number
}
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

// 先把汇总清空，模拟「刚迁到 v8、汇总还是空的」——这是最坏情况
const store = await openPortalStore({ sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url })
try {
  for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod', 'usage_rollup_meta']) {
    await store.exec(`DELETE FROM ${table}`)
  }
} finally { await store.close() }
console.log(`库 ${state.schema}（${state.events} 条），汇总表已清空 —— 最坏情况的启动`)

const home = mkdtempSync(join(tmpdir(), 'atr-boot-nonblocking-'))
const started = performance.now()
const server = await createServer({
  host: '127.0.0.1', port: 0, dshHome: home, dataDir: join(home, 'data'),
  dbPath: join(home, 'portal.sqlite'), mysqlUrl: state.url,
  adminToken: state.adminToken, adminName: '启动夹具管理员',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
  rollupSyncMs: 0,   // 关掉定时器，只观察启动那一次
})
const bootMs = performance.now() - started
console.log(`  ℹ️ createServer() 返回耗时 ${bootMs.toFixed(0)}ms`)

const auth = { Authorization: `Bearer ${state.adminToken}` }
try {
  // ① 启动必须快（放宽到 5 秒：机器差异 + 建池；阻塞版会是 20000ms+）
  check(`createServer() 在 5 秒内返回（实测 ${bootMs.toFixed(0)}ms；阻塞版会 >19000ms）`, bootMs < 5000, `${bootMs.toFixed(0)}ms`)

  // ② 端口立刻可用
  const healthStarted = performance.now()
  const health = await fetch(`${server.url}/api/health`, { headers: auth })
  const healthMs = performance.now() - healthStarted
  check('返回后 /api/health 立刻可答（端口真的在监听）', health.status === 200, `HTTP ${health.status} / ${healthMs.toFixed(0)}ms`)

  // ③ 补齐还在进行时，看板就必须给出正确数字（走原始表）
  const path = '/api/v1/stats/series?bucket=day&period=last30d&identity_view=member'
  const during = await fetch(`${server.url}${path}`, { headers: auth, signal: AbortSignal.timeout(120_000) })
  const duringBody = await during.json() as { points?: { calls: number }[] }
  const duringCalls = (duringBody.points ?? []).reduce((sum, point) => sum + point.calls, 0)
  check('补齐进行中，看板已经返回非零数据（不是空看板）', during.status === 200 && duringCalls > 0, `calls=${duringCalls}`)

  // ④ 等后台补齐追上（每批 ~10s，1M 行约 5 批；给足 5 分钟）
  const meta = await (async () => {
    const poll = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: state.url })
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        const rolled = await poll.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
        const source = await poll.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event')
        if (Number(rolled?.c ?? 0) === Number(source?.c ?? 0) && Number(source?.c ?? 0) > 0) return { rolled: Number(rolled?.c), source: Number(source?.c) }
        await new Promise((done) => setTimeout(done, 2_000))
      }
      const rolled = await poll.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      const source = await poll.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event')
      return { rolled: Number(rolled?.c ?? 0), source: Number(source?.c ?? 0) }
    } finally { await poll.close() }
  })()
  check('后台补齐最终追平（SUM(汇总.calls) == COUNT(原始)）', meta.rolled === meta.source && meta.source > 0, JSON.stringify(meta))

  // ⑤ 追平之后数字逐位不变
  const after = await fetch(`${server.url}${path}`, { headers: auth, signal: AbortSignal.timeout(120_000) })
  const afterBody = await after.json() as { points?: { calls: number }[] }
  check('★ 补齐前后看板响应体逐位相同（快路径与原始表给出同一个答案）',
    JSON.stringify(afterBody) === JSON.stringify(duringBody))

  // ⑥ 水位真的被写过（补齐不是「跳过」）
  const verify = await openPortalStore({ sqlitePath: join(home, 'unused.sqlite'), mysqlUrl: state.url })
  try {
    const written = await readRollupMeta(verify)
    check('元数据水位已写入（含复合游标的第二段）', written !== null && written.builtThroughEventId !== '', JSON.stringify(written))
  } finally { await verify.close() }

  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 项通过 / ${failed} 项失败`)
} finally {
  await server.stop()
  await closeAllMysqlBackends()
  rmSync(home, { recursive: true, force: true })
}
if (failed > 0) process.exit(1)
