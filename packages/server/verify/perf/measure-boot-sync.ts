/**
 * **启动补齐的代价**（部署风险的关键数字）。
 *
 * ```bash
 * bun run packages/server/verify/perf/measure-boot-sync.ts --scale 1e6 --pool 2048
 * ```
 *
 * ## 为什么必须单独量
 *
 * `createHandlerFor()` 里 `await syncOnce('启动补齐')` 是**同步等待**的：
 * 它跑完之前服务端**不监听端口**。而单次同步有行数上界（默认 20 万），
 * 所以「积压很多」时启动只会推一批，剩下的靠 5 分钟定时器慢慢追
 * —— 期间看板**正确但慢**（安全阀判为落后 → 退原始表）。
 *
 * 本脚本量三件事：
 * ① 空汇总表时，一批（20 万行）要多久；
 * ② 从零追平整个库要几批、总共多久；
 * ③ 追平之后再启动，补齐要多久（稳态：应该接近 0）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { closeAllMysqlBackends, openPortalStore, sharedMysqlBackend, syncRollups } from '@ai-token-report/core/db'

const STATE_DIR = resolve('.artifacts/perf')
const RESULT_DIR = join(STATE_DIR, 'results')

interface PerfState { schema: string; url: string; events: number }
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const scale = arg('scale', '1e6')!
const poolMb = Number(arg('pool', '2048'))!
const stateFile = join(STATE_DIR, `${scale}.json`)
if (!existsSync(stateFile)) throw new Error(`没有 ${stateFile}（先跑 seed.ts --scale ${scale}）`)
const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PerfState
if (!/^atr_http_v5_/.test(state.schema)) throw new Error('拒绝在非隔离库上操作')

const admin = await sharedMysqlBackend(state.url)
const originalPool = Number((await admin.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v'))?.v ?? 0)
await admin.exec(`SET GLOBAL innodb_buffer_pool_size = ${poolMb * 1024 * 1024}`)
for (let attempt = 0; attempt < 180; attempt++) {
  const size = await admin.get<{ v: number }>('SELECT @@innodb_buffer_pool_size AS v')
  if (Number(size?.v) === poolMb * 1024 * 1024) break
  await new Promise((done) => setTimeout(done, 1_000))
}
await new Promise((done) => setTimeout(done, 3_000))

const store = await openPortalStore({ sqlitePath: join(STATE_DIR, 'unused.sqlite'), mysqlUrl: state.url })
const report: Record<string, unknown> = {}
try {
  // 先清空汇总，模拟「刚迁到 v8、汇总表还是空的」
  for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod', 'usage_rollup_meta']) {
    await store.exec(`DELETE FROM ${table}`)
  }
  const total = Number((await store.get<{ c: unknown }>('SELECT COUNT(*) AS c FROM usage_event'))?.c ?? 0)
  console.log(`库 ${state.schema}：${total} 条事件，pool ${poolMb}MB\n`)

  // ① + ② 从零追平：一次一份，记每一批的耗时
  const batches: { round: number; mode: string; ms: number; dayCells: number }[] = []
  const startedAll = performance.now()
  for (let round = 1; round <= 200; round++) {
    const started = performance.now()
    const result = await syncRollups(store)
    const ms = Number((performance.now() - started).toFixed(1))
    batches.push({ round, mode: result.mode, ms, dayCells: result.dayCells })
    console.log(`  第 ${String(round).padStart(2)} 批：${result.mode.padEnd(11)} ${String(ms).padStart(9)}ms  日格 ${result.dayCells}`)
    if (result.mode === 'skipped') break
  }
  const totalMs = Number((performance.now() - startedAll).toFixed(1))
  const syncBatches = batches.filter(batch => batch.mode !== 'skipped').length
  const rolled = await store.get<{ c: unknown }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
  console.log(`\n从零追平：${syncBatches} 批 / ${totalMs}ms；SUM(汇总.calls)=${rolled?.c} vs 原始 ${total}`)
  report['coldStart'] = { batches: syncBatches, totalMs, firstBatchMs: batches[0]?.ms ?? 0, dayCellsSum: rolled?.c }
  report['fromScratchMatchesSource'] = Number(rolled?.c) === total

  // ③ 稳态：追平之后再跑一次（= 服务重启时的实际代价）
  const steadyStarted = performance.now()
  const steady = await syncRollups(store)
  const steadyMs = Number((performance.now() - steadyStarted).toFixed(1))
  console.log(`稳态再同步（= 重启代价）：${steady.mode} / ${steadyMs}ms`)
  report['steadyState'] = { mode: steady.mode, ms: steadyMs }

  // ④ 有 1 条新数据时的增量代价
  await store.run(
    `INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,received_at_ms)
     VALUES ('boot-probe:1','boot-probe',0,$ts,'p','m',1,1,1,1,0,$now)`,
    { $ts: Date.now(), $now: Date.now() + 2_000_000 },
  )
  const incStarted = performance.now()
  const incremental = await syncRollups(store)
  const incrementalMs = Number((performance.now() - incStarted).toFixed(1))
  console.log(`单条新增的增量同步：${incremental.mode} / ${incrementalMs}ms / 日格 ${incremental.dayCells}`)
  report['incrementalOneRow'] = { mode: incremental.mode, ms: incrementalMs }
} finally {
  await store.close()
  mkdirSync(RESULT_DIR, { recursive: true })
  const file = join(RESULT_DIR, `${scale}-boot-sync.json`)
  writeFileSync(file, JSON.stringify({ scale, events: state.events, poolMb, report, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`\n结果已写：${file}`)
  await admin.exec(`SET GLOBAL innodb_buffer_pool_size = ${originalPool}`)
  await closeAllMysqlBackends()
}
