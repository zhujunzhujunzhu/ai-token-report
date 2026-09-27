/** 隔离库内对比逐行与批量上报写入；不包含 HTTP/鉴权，不对真实业务库造数。 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore, type PortalStore } from '../src/db/portal-db.js'
import { insertAttributedRecordsInTransaction, type IngestRecord } from '../src/db/ingest.js'
import { createIsolatedMysql } from '../../server/verify/mysql-isolation.js'

const recordsPerBatch = 2000
const rounds = 3
const root = mkdtempSync(join(tmpdir(), 'atr-ingest-benchmark-'))

// 基线保留优化前的一次事务 + 每事件一次普通 INSERT，身份常量和列与批量路径一致。
const columns = ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'cwd',
  'user_id', 'user_name', 'dept', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'turn', 'step', 'member_id', 'department_id', 'report_token_id', 'received_at_ms']
const singleSql = `INSERT INTO usage_event (${columns.join(',')}) VALUES (${columns.map((_, i) => `$v${i}`).join(',')})`
async function singleRows(store: PortalStore, records: IngestRecord[]): Promise<void> {
  if (store.kind === 'mysql') await store.get('SELECT @@SESSION.sql_mode AS mode')
  for (const record of records) {
    const values = [record.event_id, record.session_id, record.seq, record.ts, record.provider, record.model, record.cwd,
      '基准人员', '基准人员', null, record.input_tokens, record.output_tokens, record.cache_read_tokens,
      record.cache_write_tokens, record.reasoning_tokens, record.turn, record.step, null, null, null, null]
    assert.equal((await store.run(singleSql, Object.fromEntries(values.map((value, i) => [`$v${i}`, value])))).changes, 1)
  }
}

async function benchmark(store: PortalStore): Promise<void> {
  const measurements: Record<string, number[]> = { single: [], batch: [] }
  for (let round = 0; round < rounds; round++) {
    // 交替顺序，避免总是让某一种实现独占冷缓存或热缓存。
    for (const mode of round % 2 ? ['batch', 'single'] : ['single', 'batch']) {
      const records: IngestRecord[] = Array.from({ length: recordsPerBatch }, (_, i) => ({
        event_id: `${mode}:${round}:${i}`, session_id: `${mode}:${round}`, seq: i,
        ts: 1750000000000 + i, provider: 'benchmark', model: 'test-model', cwd: '/benchmark',
        input_tokens: 1200, output_tokens: 300, cache_read_tokens: 14000, cache_write_tokens: 100,
        reasoning_tokens: 20, turn: i, step: 1,
      }))
      const start = performance.now()
      await store.transaction(async tx => {
        if (mode === 'single') await singleRows(tx, records)
        else assert.deepEqual(await insertAttributedRecordsInTransaction(tx, records, { userId: '基准人员' }),
          { inserted: recordsPerBatch, duplicates: 0 })
      })
      measurements[mode]!.push(performance.now() - start)
    }
  }
  const count = Number((await store.get<{ count: number }>('SELECT COUNT(*) AS count FROM usage_event'))?.count)
  assert.equal(count, recordsPerBatch * rounds * 2)
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  const singleMs = median(measurements.single!), batchMs = median(measurements.batch!)
  console.log(JSON.stringify({ backend: store.kind, runtime: process.versions.bun ? 'bun' : 'node',
    recordsPerBatch, rounds, singleMs: Number(singleMs.toFixed(2)), batchMs: Number(batchMs.toFixed(2)),
    speedup: Number((singleMs / batchMs).toFixed(2)), batchRecordsPerSecond: Math.round(recordsPerBatch * 1000 / batchMs),
    statementRoundTrips: { single: recordsPerBatch, batch: store.kind === 'mysql' ? 30 : 150 },
    note: '本机隔离库原始写入基准；不包含 HTTP、鉴权、排队和网络跨机延迟。' }))
}

try {
  const sqlite = await openPortalStore({ sqlitePath: join(root, 'benchmark.sqlite') })
  try { await benchmark(sqlite) } finally { await sqlite.close() }
  if (process.argv.includes('--mysql')) {
    const isolation = await createIsolatedMysql()
    try {
      const mysql = await openPortalStore({ sqlitePath: 'unused', mysqlUrl: isolation.url })
      try { await benchmark(mysql) } finally { await mysql.close() }
    } finally { await isolation.dispose() }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
