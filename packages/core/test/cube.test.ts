/** 新汇总与原始查询逐位对照；事件更新、删除、迟到写入与换价均不能改变口径。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backfillCube, syncCube, cubeQuery, cubeVersionKey, insertAttributedRecords, openPortalStore, PortalStatsSession, totalsQuery, type PortalTarget, type PortalStore, type QueryFilter, type IngestRecord } from '../src/db/index.js'
import { openMysqlBackend, closeAllMysqlBackends } from '../src/db/mysql.js'
import { EMPTY_ALIAS_RULES } from '../src/db/provider-alias.js'

const root = mkdtempSync(join(tmpdir(), 'atr-cube-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']
const start = Date.UTC(2026, 8, 21)
const member = randomUUID(), group = randomUUID()

async function withStore(kind: 'sqlite' | 'mysql', fn: (store: PortalStore, target: PortalTarget) => Promise<void>) {
  const schema = `atr_cube_${Date.now()}_${randomUUID().slice(0, 8)}`
  const admin = kind === 'mysql' ? await openMysqlBackend(mysqlUrl!) : undefined
  const url = kind === 'mysql' ? new URL(mysqlUrl!) : undefined
  if (admin && url) { await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); url.pathname = '/' + schema }
  const target = { sqlitePath: join(root, `${schema}.sqlite`), ...(url ? { mysqlUrl: url.href } : {}) }
  try {
    const store = await openPortalStore(target)
    try { await fn(store, target) } finally { await store.close() }
  } finally {
    if (admin) { await closeAllMysqlBackends(); await admin.exec(`DROP DATABASE ${schema}`); await admin.close() }
  }
}

function event(i: number): IngestRecord {
  return { event_id: `e${i}`, session_id: `session${i % 7}`, seq: i,
    ts: start + Math.floor(i / 60) * 3600000 + (i % 60) * 60000,
    source: i % 3 === 0 ? 'codex' : 'dsh', provider: i % 5 === 0 ? 'other' : 'p', model: i % 11 === 0 ? 'unpriced' : 'm',
    cwd: i % 2 === 0 ? 'D:/a/project' : 'D:/b/project', turn: 1, step: 1,
    input_tokens: (i * 53) % 3019, output_tokens: (i * 29) % 1723,
    cache_read_tokens: (i * 997) % 6001, cache_write_tokens: i % 37, reasoning_tokens: i % 9 }
}

async function seed(store: PortalStore) {
  await store.run('INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,\'当前姓名\',1,1)', { $id: member })
  await store.run('INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,\'研发组\',1,1)', { $id: group })
  await store.run('INSERT INTO member_group_assignments (member_id,group_id,created_at_ms) VALUES ($m,$g,1)', { $m: member, $g: group })
  for (const [provider, currency, rate] of [['*', 'USD', 17], ['p', 'CNY', 7]] as const) {
    await store.run(`INSERT INTO model_price (price_id,provider,model,currency,input_micro_per_ktok,output_micro_per_ktok,cache_read_micro_per_ktok,cache_write_micro_per_ktok,
      offpeak_input_micro_per_ktok,offpeak_output_micro_per_ktok,offpeak_cache_read_micro_per_ktok,offpeak_cache_write_micro_per_ktok,offpeak_schedule,
      effective_from_ms,effective_to_ms,created_at_ms,updated_at_ms) VALUES ($id,$p,'m',$c,$r,19,3,11,2,5,1,3,'deepseek-cn',0,NULL,1,1)`,
      { $id: randomUUID(), $p: provider, $c: currency, $r: rate })
  }
  for (let owner = 0; owner < 3; owner++) {
    const records = Array.from({ length: 900 }, (_, i) => event(i)).filter((_, i) => i % 3 === owner)
    await insertAttributedRecords(store, records, { userId: owner === 2 ? '历史人员' : '旧姓名', memberId: owner === 2 ? null : member,
      receivedAtMs: owner === 0 ? null : start + 90000000 })
  }
  await insertAttributedRecords(store, [{ ...event(900), ts: 0 }, { ...event(901), ts: 100 }], { userId: '旧姓名', memberId: member })
  // 两个会话的时间 / token / 价均相同：趋势传输折叠仍须保留逐事件舍入与调用数。
  await insertAttributedRecords(store, [1, 2].map(i => ({ ...event(1), event_id: `same${i}`, session_id: `same-session${i}` })), { userId: '旧姓名', memberId: member })
}

async function snapshot(store: PortalStore, target: PortalTarget, filter: QueryFilter, disableCube: boolean) {
  const aliases = { ...EMPTY_ALIAS_RULES, providers: new Map([['other', '归一供应商']]), models: [] }
  const s = new PortalStatsSession({ store, target, filter, aliases, withCost: true, disableCube })
  const result: Record<string, unknown> = { overview: await s.overviewCounts(), cost: await s.costTotals(), totals: await s.totals(),
    sessions: await s.sessions(), users: await s.distinctUsers(), bounds: await s.timeBounds(), unattributed: await s.unattributedCalls(),
    sources: await s.sourceCoverage(), reporters: await s.reporterCoverage(), records: await s.records(5, 1), hod: await s.hourOfDay('workday') }
  for (const dim of ['user', 'group', 'provider', 'model', 'provider-model', 'source', 'session', 'project', 'day', 'hour'] as const) {
    // 相等总量的行顺序不是契约，按 key 排序后逐列比较。
    result[dim] = (await s.groups(dim)).sort((a, b) => a.key.localeCompare(b.key))
    result[dim + 'cost'] = [...await s.costByGroup(dim)].sort(([a], [b]) => a.localeCompare(b))
  }
  for (const granularity of ['day', 'hour'] as const) {
    result['series' + granularity] = await s.series(granularity, false)
    for (const dim of ['user', 'model'] as const) result['stack' + dim + granularity] = (await s.stackSeries(dim, granularity)).sort((a, b) => a.key.localeCompare(b.key))
  }
  return result
}

for (const kind of ['sqlite', 'mysql'] as const) (kind === 'mysql' && !mysqlUrl ? test.skip : test)(`${kind}：汇总 / 半回填 / 脏小时 / 换价 / 所有维度与原始结果逐位相等`, async () => {
  await withStore(kind, async (store, target) => {
    await seed(store)
    const all: QueryFilter = { identityView: 'member' }
    const filters: QueryFilter[] = [all, { ...all, sources: ['dsh'], memberIds: [member] },
      { ...all, groupIds: [group], providers: ['p'] }, { ...all, sinceMs: start + 4321000, untilMs: start + 43000123 },
      { ...all, legacyUserIds: ['历史人员'] }, { ...all, unattributedOnly: true }]
    const compare = async () => { for (const filter of filters) expect(await snapshot(store, target, filter, false)).toEqual(await snapshot(store, target, filter, true)) }
    await compare()
    await syncCube(store, { maxHours: 1 })
    await compare()
    const filled = await backfillCube(store)
    expect(filled.caughtUp).toBe(true)
    const cells = await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube')
    expect(Number(cells?.n)).toBeLessThan(900)
    await compare()
    const rawSeries = await new PortalStatsSession({ store, target, filter: all, withCost: true, disableCube: true }).series('day', false)
    const concurrentSeries = await Promise.all(Array.from({ length: 8 }, () => new PortalStatsSession({ store, target, filter: all, withCost: true }).series('day', false)))
    for (const series of concurrentSeries) expect(series).toEqual(rawSeries)
    // 失败事务的事实与失效标记一起回滚；幂等重复也不能制造多余重算。
    await expect(store.transaction(async tx => {
      await tx.run("UPDATE usage_event SET input_tokens=999 WHERE event_id='e2'")
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(Number((await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube_dirty'))?.n)).toBe(0)
    expect(await insertAttributedRecords(store, [event(2)], { userId: '历史人员' })).toEqual({ inserted: 0, duplicates: 1 })
    expect(Number((await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube_dirty'))?.n)).toBe(0)
    await store.run('UPDATE usage_event SET ts=$ts,input_tokens=10000,member_id=NULL,user_id=NULL,user_name=NULL WHERE event_id=\'e1\'', { $ts: start + 360000000 })
    await store.run('DELETE FROM usage_event WHERE event_id=\'e5\'')
    await insertAttributedRecords(store, [{ ...event(5), event_id: 'late' }], { userId: '历史人员', receivedAtMs: null })
    await compare()
    await backfillCube(store)
    await compare()
    // 价格在半小时变化、撤销专属价后回落基础价、以后补价，均无需重建汇总。
    await store.run('UPDATE model_price SET effective_to_ms=$to WHERE provider=\'p\'', { $to: start + 18301234 })
    await compare()
    await store.run('DELETE FROM model_price WHERE provider=\'p\'')
    await compare()
    await store.run('UPDATE model_price SET input_micro_per_ktok=113,offpeak_input_micro_per_ktok=61')
    await compare()
    // 元数据在可用检查之后被改动时，同一 SQL 必须退事实表，不能返回空汇总。
    const q = cubeQuery(totalsQuery(all), kind, all, [])
    await store.run('UPDATE usage_cube_meta SET version_key=\'different-timezone\'')
    const actual = await store.all<Record<string, unknown>>(q.sql, q.params)
    const raw = totalsQuery(all)
    const numeric = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])))
    expect(numeric(actual)).toEqual(numeric(await store.all(raw.sql, raw.params)))
    await backfillCube(store)
    expect((await store.get<{ version_key: string }>('SELECT version_key FROM usage_cube_meta'))?.version_key).toBe(cubeVersionKey())
    await compare()
  })
}, 60000)

const mysqlTest = mysqlUrl ? test : test.skip
mysqlTest('mysql：回填等待正在提交的迟到事务后，必须读取新快照且不丢失脏标记', async () => {
  await withStore('mysql', async (store, target) => {
    await seed(store)
    await backfillCube(store)
    let unlocked!: () => void, written!: () => void
    const release = new Promise<void>(done => { unlocked = done })
    const ready = new Promise<void>(done => { written = done })
    const writer = store.transaction(async tx => {
      await tx.run("UPDATE usage_event SET input_tokens=12345 WHERE event_id='e1'")
      written()
      await release
    })
    await ready
    const worker = syncCube(store)
    // 同步先在小时锁上等待，随后才允许写事务提交。
    await Bun.sleep(50)
    unlocked()
    await writer
    await worker
    const filter = { identityView: 'member' as const }
    expect(await snapshot(store, target, filter, false)).toEqual(await snapshot(store, target, filter, true))
    expect(Number((await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube_dirty'))?.n)).toBe(0)
  })
}, 60000)
