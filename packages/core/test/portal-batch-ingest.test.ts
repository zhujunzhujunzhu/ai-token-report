/** 上报批量写入的真实事务验证：吞吐优化不能改变幂等、归属和失败回滚。 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { insertAttributedRecords, type IngestRecord } from '../src/db/ingest.js'
import { openPortalStore, type PortalStore } from '../src/db/portal-db.js'
import { openMysqlBackend, closeAllMysqlBackends } from '../src/db/mysql.js'

const root = mkdtempSync(join(tmpdir(), 'atr-batch-ingest-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const record = (id: string): IngestRecord => ({
  event_id: id, session_id: '批量会话', seq: 1, ts: 1000, provider: '', model: '', cwd: null,
  input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44,
  reasoning_tokens: 2, turn: -1, step: -2,
})
const owner = { userId: '先到人员', userName: '原姓名', dept: '原部门', receivedAtMs: 1234 }

interface Writes { parameters: number; bytes: number; rows: number }
function observe(store: PortalStore, writes: Writes[]): PortalStore {
  return new Proxy(store, { get(target, property) {
    if (property === 'transaction') return <T>(fn: (tx: PortalStore) => Promise<T>) =>
      target.transaction(tx => fn(observe(tx, writes)))
    if (property === 'run') return (sql: string, params?: Record<string, unknown> | unknown[]) => {
      if (sql.startsWith('INSERT INTO usage_event ')) {
        const values = Object.values(params ?? {})
        writes.push({ parameters: values.length, rows: (sql.match(/\(\?/g) ?? []).length,
          bytes: values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 8), 0) })
      }
      return target.run(sql, params)
    }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

async function isolated(kind: 'sqlite' | 'mysql', fn: (store: PortalStore) => Promise<void>): Promise<void> {
  if (kind === 'sqlite') {
    const store = await openPortalStore({ sqlitePath: join(root, `${randomUUID()}.sqlite`) })
    try { await fn(store) } finally { await store.close() }
    return
  }
  const adminUrl = process.env.ATR_V4_TEST_MYSQL_URL!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_batch_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_batch_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
  const url = new URL(adminUrl); url.pathname = `/${schema}`
  let created = false
  try {
    await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
    created = true
    const store = await openPortalStore({ sqlitePath: 'unused', mysqlUrl: url.href })
    try { await fn(store) } finally { await store.close() }
  } finally {
    await closeAllMysqlBackends()
    if (created) await admin.exec(`DROP DATABASE ${schema}`)
    await admin.close()
  }
}

for (const kind of ['sqlite', 'mysql'] as const) {
  describe.skipIf(kind === 'mysql' && !process.env.ATR_V4_TEST_MYSQL_URL)(`${kind} 批量上报`, () => {
    test('605 条用少量有界 SQL 写入，四列与可选字段保真，重投精确去重', async () => isolated(kind, async store => {
      const records = Array.from({ length: 605 }, (_, i) => ({ ...record(`batch:${i}`), seq: i }))
      const writes: Writes[] = []
      expect(await insertAttributedRecords(observe(store, writes), records, owner)).toEqual({ inserted: 605, duplicates: 0 })
      expect(writes.length).toBeLessThan(20)
      expect(writes.every(write => write.parameters <= 5000 && write.rows > 1)).toBe(true)
      const row = await store.get<Record<string, unknown>>("SELECT * FROM usage_event WHERE event_id='batch:200'")
      expect([row?.input_tokens, row?.output_tokens, row?.cache_read_tokens, row?.cache_write_tokens].map(Number)).toEqual([11, 22, 33, 44])
      expect([row?.cwd, row?.member_id, row?.department_id, row?.report_token_id]).toEqual([null, null, null, null])
      expect([Number(row?.seq), Number(row?.turn), Number(row?.step), Number(row?.received_at_ms)]).toEqual([200, -1, -2, 1234])
      writes.length = 0
      expect(await insertAttributedRecords(observe(store, writes), records, { userId: '后到人员' })).toEqual({ inserted: 0, duplicates: 605 })
      // 全重复重投只多出每个块的一次失败尝试，不允许二分把写请求数翻倍。
      expect(writes.length).toBeLessThan(640)
      expect((await store.get<{ user_id: string }>("SELECT user_id FROM usage_event WHERE event_id='batch:200'"))?.user_id).toBe(owner.userId)
    }), 30_000)

    test('批内及跨块重复只保留第一次的原始值与归属', async () => isolated(kind, async store => {
      await insertAttributedRecords(store, [record('existing')], owner)
      const records = [record('existing'), record('same'), { ...record('same'), input_tokens: 999 },
        ...Array.from({ length: 205 }, (_, i) => record(`new:${i}`)), { ...record('same'), output_tokens: 999 }]
      expect(await insertAttributedRecords(store, records, { userId: '后来人员' })).toEqual({ inserted: 206, duplicates: 3 })
      expect(await store.get<Record<string, unknown>>("SELECT input_tokens,output_tokens,user_id FROM usage_event WHERE event_id='same'"))
        .toEqual({ input_tokens: 11, output_tokens: 22, user_id: '后来人员' })
      expect((await store.get<{ user_id: string }>("SELECT user_id FROM usage_event WHERE event_id='existing'"))?.user_id).toBe(owner.userId)
    }), 30_000)

    test('后块 CHECK 失败回滚前面全部块，重复不能掩盖其他约束错误', async () => isolated(kind, async store => {
      await insertAttributedRecords(store, [record('existing')], owner)
      const records = Array.from({ length: 205 }, (_, i) => record(`rollback:${i}`))
      await expect(insertAttributedRecords(store, [...records, { ...record('invalid'), input_tokens: -1 }], owner)).rejects.toThrow()
      await expect(insertAttributedRecords(store, [record('new'), record('existing'), { ...record('invalid'), output_tokens: -1 }], owner)).rejects.toThrow()
      expect(await store.all('SELECT event_id FROM usage_event')).toEqual([{ event_id: 'existing' }])
    }), 30_000)

    test('其他 UNIQUE 与 FK 错误不计为重复，整批必须回滚', async () => isolated(kind, async store => {
      await store.exec('CREATE UNIQUE INDEX test_unique_model ON usage_event(model)')
      // 唯一键错误中的冲突值可来自客户端，不能因值里含 PRIMARY 就误判为事件主键。
      const unique = [record('unique:first'), record('unique:second')].map(row => ({ ...row, model: "for key 'PRIMARY'" }))
      await expect(insertAttributedRecords(store, unique, owner)).rejects.toThrow()
      expect(await store.all('SELECT event_id FROM usage_event')).toEqual([])
      await expect(insertAttributedRecords(store, [record('fk:first'), { ...record('fk:second'), model: '另外模型' }],
        { ...owner, memberId: randomUUID() })).rejects.toThrow()
      expect(await store.all('SELECT event_id FROM usage_event')).toEqual([])
    }), 30_000)

    test('大 UTF-8 字段按字节拆块，不截断原值', async () => isolated(kind, async store => {
      const cwd = '中文路径'.repeat(5000)
      const writes: Writes[] = []
      const records = Array.from({ length: 25 }, (_, i) => ({ ...record(`bytes:${i}`), cwd }))
      expect(await insertAttributedRecords(observe(store, writes), records, owner)).toEqual({ inserted: 25, duplicates: 0 })
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.every(write => write.bytes < 512 * 1024)).toBe(true)
      expect((await store.get<{ cwd: string }>("SELECT cwd FROM usage_event WHERE event_id='bytes:24'"))?.cwd).toBe(cwd)
      if (kind === 'mysql') {
        await expect(insertAttributedRecords(store, [record('overflow:first'), { ...record('overflow:bad'), model: 'x'.repeat(256) }], owner)).rejects.toThrow()
        expect(await store.all("SELECT event_id FROM usage_event WHERE event_id LIKE 'overflow:%'")).toEqual([])
      } else {
        const large = 'x'.repeat(1024 * 1024)
        await insertAttributedRecords(store, [{ ...record('large:single'), cwd: large }], owner)
        expect((await store.get<{ cwd: string }>("SELECT cwd FROM usage_event WHERE event_id='large:single'"))?.cwd).toBe(large)
      }
    }), 30_000)
  })
}

test('SQLite FAIL 保留前半块时先回滚保存点，再准确统计新增与重复', async () => isolated('sqlite', async store => {
  await insertAttributedRecords(store, [record('existing')], owner)
  await store.exec(`CREATE TRIGGER test_duplicate_fail BEFORE INSERT ON usage_event
    WHEN NEW.event_id='existing' BEGIN SELECT RAISE(FAIL,'UNIQUE constraint failed: usage_event.event_id'); END`)
  expect(await insertAttributedRecords(store, [record('first'), record('existing'), record('last')], owner))
    .toEqual({ inserted: 2, duplicates: 1 })
  expect((await store.all('SELECT event_id FROM usage_event')).length).toBe(3)
}))
