/** 主键分页与旧二进制排序必须产生相同 SHA；尾部空格不能改变冻结检查点。 */
import { afterAll, expect, test } from 'bun:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore, type PortalStore } from '../src/db/portal-db.js'
import { historyFingerprint } from '../src/db/portal-migrations.js'
import { openMysqlBackend, closeAllMysqlBackends } from '../src/db/mysql.js'

const root = mkdtempSync(join(tmpdir(), 'atr-fingerprint-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']
for (const kind of ['sqlite', 'mysql'] as const) (kind === 'mysql' && !mysqlUrl ? test.skip : test)(`${kind}：跨两页、大小写与控制字符逐位相同；有主键范围查找`, async () => {
  const schema = `atr_fp_${Date.now()}_${randomUUID().slice(0, 8)}`
  const admin = kind === 'mysql' ? await openMysqlBackend(mysqlUrl!) : undefined
  const url = kind === 'mysql' ? new URL(mysqlUrl!) : undefined
  if (admin && url) { await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); url.pathname = '/' + schema }
  const store = await openPortalStore({ sqlitePath: join(root, schema + '.sqlite'), ...(url ? { mysqlUrl: url.href } : {}) })
  const columns = ['event_id','session_id','seq','ts','provider','model','cwd','user_id','user_name','group_name','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','turn','step']
  const statements: string[] = []
  const counted: PortalStore = {
    kind: store.kind, label: store.label,
    all: async <Row>(sql: string, params?: Parameters<PortalStore['all']>[1]) => { statements.push(sql); return store.all<Row>(sql, params) },
    get: (sql, params) => store.get(sql, params), run: (sql, params) => store.run(sql, params), exec: sql => store.exec(sql),
    transaction: fn => store.transaction(fn), withConnection: fn => store.withConnection(fn), close: () => store.close(),
  }
  const legacyHash = async () => {
    const hash = createHash('sha256')
    const rows = await store.all<Record<string, unknown>>(`SELECT ${columns.join(',')} FROM usage_event ORDER BY ${kind === 'mysql' ? 'BINARY event_id' : 'event_id COLLATE BINARY'}`)
    for (const row of rows) hash.update(JSON.stringify(columns.map(name => typeof row[name] === 'bigint' ? String(row[name]) : row[name])) + '\n')
    return { hash: hash.digest('hex'), count: rows.length }
  }
  try {
    const ids = ['A!', 'Z', 'a\x1f', ...Array.from({ length: 1100 }, (_, i) => 'key' + String(i).padStart(5, '0'))]
    for (let at = 0; at < ids.length; at += 100) await store.run(`INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ${ids.slice(at, at + 100).map(() => "(?,'session',0,100,'p','m',1,2,3,4)").join(',')}`, ids.slice(at, at + 100))
    expect(await historyFingerprint(counted, 'group_name')).toEqual(await legacyHash())
    const paging = statements.filter(sql => sql.startsWith('SELECT event_id,session_id'))
    expect(paging).toHaveLength(2)
    expect(paging.some(sql => sql.includes('OFFSET'))).toBe(false)
    const seek = paging[1]!
    expect(seek).toContain('> $cursor')
    if (kind === 'mysql') {
      const plan = await store.all<{ type: string; key: string }>('EXPLAIN ' + seek, { $cursor: 'key00500' })
      expect(plan[0]?.type).toBe('range')
      expect(plan[0]?.key).toBe('PRIMARY')
    }
    await store.run("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ('x ','s',0,100,'p','m',1,2,3,4)")
    await store.run("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ($id,'s',0,100,'p','m',1,2,3,4)", { $id: 'x\x1f' })
    expect(await historyFingerprint(counted, 'group_name')).toEqual(await legacyHash())
  } finally {
    await store.close()
    if (admin) { await closeAllMysqlBackends(); await admin.exec(`DROP DATABASE ${schema}`); await admin.close() }
  }
}, 60000)
