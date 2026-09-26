/** 在真实 SQLite / 可选隔离 MySQL 上验证 v4 闸门、事务与无损迁移。 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { openDb, ensureSchema } from '../src/db/schema.js'
import { openPortalStore, inspectPortalDatabase, preparePortalDatabase, migratePortalDatabase, describePortalTarget, type PortalTarget, type PortalStore } from '../src/db/portal-db.js'
import { openRawPortalStore } from '../src/db/portal-connection.js'
import { insertAttributedRecords, insertAttributedRecordsInTransaction, type IngestRecord } from '../src/db/ingest.js'
import { PORTAL_MYSQL_V4_SQL, PORTAL_SQLITE_V4_SQL, PORTAL_MYSQL_INGEST_SQL, portalSchemaStatements } from '../src/db/portal-schema-v4.js'
import { closeAllMysqlBackends, openMysqlBackend } from '../src/db/mysql.js'
import { canonicalCheck } from '../src/db/portal-catalog.js'

const root = mkdtempSync(join(tmpdir(), 'atr-runtime-v4-'))
afterAll(async () => { await closeAllMysqlBackends(); rmSync(root, { recursive: true, force: true }) })
const target = (): PortalTarget => ({ sqlitePath: join(root, `${randomUUID()}.sqlite`) })
const record = (id: string): IngestRecord => ({ event_id: id, session_id: '真实测试', seq: 1, ts: 100, provider: '', model: '', cwd: null, input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, reasoning_tokens: 2, turn: -1, step: -2 })
const legacyDDL = `CREATE TABLE usage_event (event_id VARCHAR(255) NOT NULL PRIMARY KEY,session_id VARCHAR(255) NOT NULL,seq BIGINT NOT NULL,ts BIGINT NOT NULL,provider VARCHAR(255) NOT NULL,model VARCHAR(255) NOT NULL,cwd TEXT NULL,user_id VARCHAR(255) NULL,user_name VARCHAR(255) NULL,dept VARCHAR(255) NULL,input_tokens BIGINT NOT NULL DEFAULT 0,output_tokens BIGINT NOT NULL DEFAULT 0,cache_read_tokens BIGINT NOT NULL DEFAULT 0,cache_write_tokens BIGINT NOT NULL DEFAULT 0,reasoning_tokens BIGINT NOT NULL DEFAULT 0,turn INT NULL,step INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; CREATE TABLE portal_meta(id TINYINT PRIMARY KEY,schema_version INT NOT NULL); INSERT INTO portal_meta VALUES (1,3); ${PORTAL_MYSQL_INGEST_SQL}`
async function createLegacy(t: PortalTarget): Promise<void> {
  if (!t.mysqlUrl) { const db = openDb(t.sqlitePath); ensureSchema(db); db.close() }
  const store = await openRawPortalStore(t)
  try {
    if (t.mysqlUrl) await store.exec(legacyDDL)
    await store.exec("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ('历史:1','历史',1,100,'','','原姓名','原姓名','原部门',11,22,33,44,2,-1,-2)")
  } finally { await store.close() }
}
async function addMember(store: PortalStore): Promise<{ memberId: string; tokenId: string }> {
  const memberId = randomUUID(), tokenId = randomUUID()
  await store.run("INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,'姓名',1,1)", { $id: memberId })
  await store.run("INSERT INTO report_tokens (token_id,member_id,token_hash,token_prefix,label,created_at_ms) VALUES ($id,$member,$hash,'atr','测试',1)", { $id: tokenId, $member: memberId, $hash: createHash('sha256').update(tokenId).digest('hex') })
  return { memberId, tokenId }
}
async function verifyWrites(t: PortalTarget): Promise<void> {
  const store = await openPortalStore(t)
  try {
    const ids = await addMember(store)
    const owner = { userId: '姓名', userName: '姓名', ...ids, receivedAtMs: 1000 }
    expect(await insertAttributedRecords(store, [record('Key:1'),record('key:1'),record('Key:1 ')], owner)).toEqual({ inserted: 3, duplicates: 0 })
    expect(await insertAttributedRecords(store, [record('Key:1')], owner)).toEqual({ inserted: 0, duplicates: 1 })
    await expect(insertAttributedRecords(store, [record('rollback:first'),{ ...record('rollback:bad'), input_tokens: -1 }], owner)).rejects.toThrow()
    expect(await store.get<Record<string, unknown>>("SELECT event_id FROM usage_event WHERE event_id='rollback:first'")).toBeNull()
    await expect(insertAttributedRecords(store, [record('bad-owner')], { ...owner, memberId: randomUUID() })).rejects.toThrow()
    await expect(store.transaction(async tx => { await insertAttributedRecordsInTransaction(tx,[record('outer-rollback')],owner); throw new Error('事务终止') })).rejects.toThrow('事务终止')
    expect(await store.get<Record<string, unknown>>("SELECT event_id FROM usage_event WHERE event_id='outer-rollback'")).toBeNull()
    await store.exec("UPDATE members SET display_name='新姓名',version=version+1,updated_at_ms=2")
    const row = await store.get<Record<string, unknown>>("SELECT * FROM usage_event WHERE event_id='Key:1'")
    expect(row?.member_id).toBe(ids.memberId)
    expect(row?.user_id).toBe('姓名')
    expect([row?.input_tokens,row?.output_tokens,row?.cache_read_tokens,row?.cache_write_tokens].map(Number)).toEqual([11,22,33,44])
    await expect(store.run('DELETE FROM members WHERE member_id=$id', { $id: ids.memberId })).rejects.toThrow()
    const stores = await Promise.all(Array.from({ length: 6 }, () => openPortalStore(t)))
    try {
      const results = await Promise.all(stores.map((connection, index) => connection.transaction(async tx => {
        await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1')
        await new Promise(done => setTimeout(done, 2))
        return insertAttributedRecordsInTransaction(tx,[record('concurrent:1')],owner)
      })))
      expect(results.reduce((sum,value) => sum + value.inserted,0)).toBe(1)
      expect(Number((await store.get<{ revision: number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(6)
    } finally { await Promise.all(stores.map(connection => connection.close())) }
    if (store.kind === 'mysql') await store.withConnection(async connection => {
      const first = await connection.get<{ id: number }>('SELECT CONNECTION_ID() AS id')
      await connection.transaction(async tx => { expect(await tx.get<Record<string, unknown>>('SELECT CONNECTION_ID() AS id')).toEqual(first) })
      expect(await connection.get<Record<string, unknown>>('SELECT CONNECTION_ID() AS id')).toEqual(first)
      const original = await connection.get<{ mode: string }>('SELECT @@SESSION.sql_mode AS mode')
      await connection.exec("SET SESSION sql_mode=''")
      try {
        await expect(connection.transaction(tx=>insertAttributedRecordsInTransaction(tx,[record('x'.repeat(256))],owner))).rejects.toThrow('拒绝可能截断')
      } finally {await connection.run('SET SESSION sql_mode=$mode',{$mode:original!.mode})}
    })
  } finally { await store.close() }
}

test('运行时 SQL 与已验证的设计 DDL 逐字一致，不依赖运行时 docs 目录', () => {
  expect(PORTAL_SQLITE_V4_SQL).toBe(readFileSync('docs/database-v4/schema.sqlite.sql','utf8'))
  expect(PORTAL_MYSQL_V4_SQL).toBe(readFileSync('docs/database-v4/schema.mysql.sql','utf8'))
})
test('SQLite 新库 v4、FULL、17 表及旧诊断表', async () => {
  const t = target()
  const info = await preparePortalDatabase(t)
  expect(info.status).toBe('current')
  expect(info.version).toBe(4)
  expect(info.tables.length).toBe(18)
  const store = await openPortalStore(t)
  expect(await store.get<Record<string, unknown>>('PRAGMA synchronous')).toEqual({ synchronous: 2 })
  expect(await store.get<Record<string, unknown>>('SELECT initialized_at_ms FROM portal_identity_state')).toEqual({ initialized_at_ms: null })
  await store.close()
  await verifyWrites(t)
})
test('SQLite 多连接同时首次启动只初始化一次', async () => {
  const t=target()
  const prepared=await Promise.all(Array.from({length:6},()=>preparePortalDatabase(t)))
  expect(prepared.every(result=>result.status==='current')).toBe(true)
})
test('SQLite v3 默认拒绝，显式备份迁移保持事件/待确认历史映射', async () => {
  const t = target(); await createLegacy(t)
  await expect(openPortalStore(t)).rejects.toThrow('唯一副本')
  expect((await inspectPortalDatabase(t)).version).toBe(3)
  await expect(migratePortalDatabase(t)).rejects.toThrow('confirm-offline')
  const backup = join(root, `${randomUUID()}.backup.sqlite`)
  expect((await migratePortalDatabase(t,{ confirmOffline: true, sqliteBackupPath: backup })).status).toBe('current')
  const db = openDb(backup)
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 }); db.close()
  const store = await openPortalStore(t)
  expect(await store.get<Record<string, unknown>>('SELECT user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,member_id,received_at_ms FROM usage_event')).toEqual({ user_id:'原姓名',user_name:'原姓名',dept:'原部门',input_tokens:11,output_tokens:22,cache_read_tokens:33,cache_write_tokens:44,member_id:null,received_at_ms:null })
  expect(await store.get<Record<string, unknown>>('SELECT status,member_id FROM legacy_attribution_map')).toEqual({ status:'pending',member_id:null })
  const ids = await addMember(store)
  await expect(insertAttributedRecords(store,[record('mismatched')],{ userId:'姓名',tokenId:ids.tokenId,memberId:randomUUID() })).rejects.toThrow()
  await store.close()
  expect((await migratePortalDatabase(t)).status).toBe('current')
})
test('SQLite 超长原始事件预检阻止迁移且不改写', async () => {
  const t = target(); await createLegacy(t)
  const db = openDb(t.sqlitePath); db.query('UPDATE usage_event SET event_id=$id').run({ $id:'x'.repeat(256) }); db.close()
  await expect(migratePortalDatabase(t,{ confirmOffline:true })).rejects.toThrow('不会截断')
  expect((await inspectPortalDatabase(t)).status).toBe('legacy')
})
test('SQLite 旧表大小写折叠主键在迁移前拒绝，不能将不同事件ACK为重复',async()=>{
  const t=target(),db=openDb(t.sqlitePath)
  db.exec("CREATE TABLE usage_event(event_id TEXT PRIMARY KEY COLLATE NOCASE); INSERT INTO usage_event VALUES('Case:1'); PRAGMA user_version=3")
  db.close()
  await expect(migratePortalDatabase(t,{confirmOffline:true})).rejects.toThrow('精确 BINARY')
  expect((await inspectPortalDatabase(t)).eventCount).toBe(1)
  expect((await inspectPortalDatabase(t)).tables).toEqual(['usage_event'])
})
test('SQLite 已标记v4却缺表时拒绝自愈', async () => {
  const t = target(); await preparePortalDatabase(t)
  const store = await openRawPortalStore(t); await store.exec('DROP TABLE auth_rate_limit_buckets'); await store.close()
  await expect(openPortalStore(t)).rejects.toThrow('缺少表')
})
test('CHECK 目录比较保留逻辑分组、数值和空值条件', () => {
  expect(canonicalCheck("a IS NULL OR (b BETWEEN 0 AND 9 AND c = 'x')")).toBe(canonicalCheck("((`a` is null) or ((`b` between 0 and 9) and (`c` = _utf8mb4'x')))"))
  expect(canonicalCheck("a IS NULL OR (b=1 AND c=2)")).not.toBe(canonicalCheck('(a IS NULL OR b=1) AND c=2'))
  expect(canonicalCheck('received_at_ms IS NULL OR received_at_ms BETWEEN 0 AND 9007199254740991')).not.toBe(canonicalCheck('received_at_ms IS NULL OR received_at_ms BETWEEN -1 AND 9007199254740991'))
  expect(canonicalCheck("member_id REGEXP '^[a-z]+$'")).toBe(canonicalCheck("regexp_like(`member_id`,_utf8mb4'^[a-z]+$')"))
})
test('SQLite current 拒绝事实外键缺失、非负或接收时间 CHECK 改写，保持历史不变', async () => {
  const changes = [
    (sql:string) => sql.replace(/  FOREIGN KEY \(department_id\)[^\n]+\n/,''),
    (sql:string) => sql.replace('input_tokens BETWEEN 0 AND','input_tokens BETWEEN -1 AND'),
    (sql:string) => sql.replace('received_at_ms BETWEEN 0 AND','received_at_ms BETWEEN -1 AND'),
  ]
  for (const change of changes) {
    const t=target(), store=await openPortalStore(t)
    await insertAttributedRecords(store,[record('history-safe')],{userId:'姓名'}); await store.close()
    // Bun SQLite 防御模式禁止改 sqlite_master；仅在本测试的随机副本构造损坏结构。
    // 生产闸门随后必须只拒绝，不能自动修补这张已带历史的表。
    const db=openDb(t.sqlitePath)
    const before=db.query<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='usage_event'").get()!.sql
    const after=change(before); expect(after).not.toBe(before)
    db.exec('ALTER TABLE usage_event RENAME TO usage_event_fixture_old')
    db.exec(after)
    db.exec('INSERT INTO usage_event SELECT * FROM usage_event_fixture_old; DROP TABLE usage_event_fixture_old')
    db.close()
    await expect(openPortalStore(t)).rejects.toThrow(/实际外键|CHECK 实际定义/)
    const raw=await openRawPortalStore(t)
    expect(await raw.get<Record<string,unknown>>('SELECT event_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_event')).toEqual({event_id:'history-safe',input_tokens:11,output_tokens:22,cache_read_tokens:33,cache_write_tokens:44})
    await raw.close()
  }
})
test('SQLite 旧库迁移的缺失/同名错误触发器在 current 和 resume 均拒绝，不自动修补', async () => {
  for (const wrongDefinition of [false,true]) {
    const t=target(); await createLegacy(t); await migratePortalDatabase(t,{confirmOffline:true})
    const raw=await openRawPortalStore(t)
    await raw.exec('DROP TRIGGER usage_v4_values_insert')
    if(wrongDefinition) await raw.exec("CREATE TRIGGER usage_v4_values_insert BEFORE INSERT ON usage_event WHEN 0 BEGIN SELECT RAISE(ABORT,'wrong definition'); END")
    await expect(openPortalStore(t)).rejects.toThrow('触发器 usage_v4_values_insert')
    await raw.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL")
    await expect(migratePortalDatabase(t,{resume:true,confirmOffline:true})).rejects.toThrow('触发器 usage_v4_values_insert')
    expect(Number((await raw.get<{c:number}>('SELECT COUNT(*) AS c FROM usage_event'))?.c)).toBe(1)
    expect((await raw.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name='usage_v4_values_insert'")).length).toBe(wrongDefinition?1:0)
    await raw.close()
  }
})
test('SQLite INSERT被触发器静默忽略时不能确认投递',async()=>{
  const t=target(),store=await openPortalStore(t)
  try{
    await store.exec("CREATE TRIGGER test_silent_ignore BEFORE INSERT ON usage_event WHEN NEW.event_id='silent-ignore' BEGIN SELECT RAISE(IGNORE); END")
    await expect(insertAttributedRecords(store,[record('batch-first'),record('silent-ignore')],{userId:'测试'})).rejects.toThrow('拒绝确认投递')
    expect(await store.get<Record<string,unknown>>('SELECT event_id FROM usage_event')).toBeNull()
  }finally{await store.close()}
})
test('SQLite 跨进程写锁异步重试不阻塞事件循环，杀进程回滚未提交数据', async () => {
  const t = target(); await preparePortalDatabase(t)
  const source = pathToFileURL(join(process.cwd(),'packages/core/src/db/portal-db.ts')).href
  const childPath = join(root,`${randomUUID()}.ts`)
  writeFileSync(childPath, `import {openPortalStore} from ${JSON.stringify(source)}; const s=await openPortalStore(${JSON.stringify(t)}); await s.transaction(async tx=>{await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1'); console.log('LOCKED'); await new Promise(r=>setTimeout(r,300));}); await s.close();`)
  const child = Bun.spawn([process.execPath,childPath],{stdout:'pipe',stderr:'pipe'})
  const reader = child.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('LOCKED')
  const store = await openPortalStore(t)
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true },20)
  await store.transaction(async tx => { await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1') })
  clearTimeout(timer)
  expect(heartbeat).toBe(true)
  expect(await child.exited).toBe(0)
  expect(Number((await store.get<{ revision:number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(2)
  writeFileSync(childPath, `import {openPortalStore} from ${JSON.stringify(source)}; const s=await openPortalStore(${JSON.stringify(t)}); await s.transaction(async tx=>{await tx.exec('UPDATE portal_identity_state SET revision=99 WHERE singleton_key=1'); console.log('LOCKED'); await new Promise(r=>setTimeout(r,30000));});`)
  const killed = Bun.spawn([process.execPath,childPath],{stdout:'pipe',stderr:'pipe'})
  expect(new TextDecoder().decode((await killed.stdout.getReader().read()).value)).toContain('LOCKED')
  killed.kill(); await killed.exited
  expect(Number((await store.get<{ revision:number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(2)
  await store.close()
}, 10_000)

describe.skipIf(!process.env.ATR_V4_TEST_MYSQL_URL)('真实隔离 MySQL v4', () => {
  async function isolated(fn: (t: PortalTarget) => Promise<void>): Promise<void> {
    const adminUrl = process.env.ATR_V4_TEST_MYSQL_URL!
    const admin = await openMysqlBackend(adminUrl)
    const schema = `atr_runtime_v4_${Date.now()}_${randomUUID().slice(0,8)}`
    if (!/^atr_runtime_v4_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
    const url = new URL(adminUrl); url.pathname = `/${schema}`
    let created = false
    try { await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); created=true; await fn({ sqlitePath:'unused', mysqlUrl:url.href }) }
    finally { await closeAllMysqlBackends(); if (created) await admin.exec(`DROP DATABASE ${schema}`); await admin.close() }
  }
  test('空库真实建表、四列保留、精确幂等、回滚、同连接事务及并发', async () => isolated(async t => {
    const first=preparePortalDatabase(t)
    await new Promise(done=>setTimeout(done,30))
    const initialized=await Promise.all([first,...Array.from({length:3},()=>preparePortalDatabase(t))])
    expect(initialized.every(result=>result.status==='current')).toBe(true)
    await verifyWrites(t)
  }), 30_000)
  test('第一条 CREATE ledger 已提交但还没写检查点时仍可显式 resume', async () => isolated(async t => {
    const raw = await openRawPortalStore(t)
    await raw.exec(portalSchemaStatements('mysql').find(sql => sql.startsWith('CREATE TABLE portal_schema_migrations ('))!)
    await raw.close()
    expect((await inspectPortalDatabase(t)).status).toBe('incomplete')
    await expect(openPortalStore(t)).rejects.toThrow('incomplete')
    await expect(migratePortalDatabase(t)).rejects.toThrow('resume')
    expect((await migratePortalDatabase(t,{resume:true})).status).toBe('current')
  }),30_000)
  test('current/resume 拒绝事实 FK 缺失、同名错误 CHECK 和 NOT ENFORCED，保留历史',async()=>isolated(async t=>{
    const raw=await openPortalStore(t)
    await insertAttributedRecords(raw,[record('history-safe')],{userId:'姓名'})
    const foreign=await raw.get<{name:string}>("SELECT constraint_name AS name FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='usage_event' AND column_name='department_id' AND referenced_table_name IS NOT NULL")
    await raw.exec(`ALTER TABLE usage_event DROP FOREIGN KEY ${foreign!.name}`)
    await expect(openPortalStore(t)).rejects.toThrow('实际外键')
    await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${foreign!.name} FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE RESTRICT`)
    for(const column of ['input_tokens','received_at_ms']) {
      const checks=await raw.all<{name:string;clause:string}>("SELECT c.constraint_name AS name,c.check_clause AS clause FROM information_schema.check_constraints c JOIN information_schema.table_constraints t ON t.constraint_schema=c.constraint_schema AND t.constraint_name=c.constraint_name WHERE t.table_schema=DATABASE() AND t.table_name='usage_event' AND t.constraint_type='CHECK'")
      const check=checks.find(row=>row.clause.includes('`'+column+'`'))!
      await raw.exec(`ALTER TABLE usage_event DROP CHECK ${check.name}`)
      const correct=check.clause.replace(/\\'/g,"'")
      await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${check.name} CHECK (${correct.replace('between 0 and','between -1 and')})`)
      await expect(openPortalStore(t)).rejects.toThrow('CHECK 实际定义')
      await raw.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL")
      await expect(migratePortalDatabase(t,{resume:true})).rejects.toThrow('CHECK 实际定义')
      await raw.exec(`ALTER TABLE usage_event DROP CHECK ${check.name}`)
      await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${check.name} CHECK (${correct}) NOT ENFORCED`)
      await expect(migratePortalDatabase(t,{resume:true})).rejects.toThrow('执行状态')
      await raw.exec(`ALTER TABLE usage_event ALTER CHECK ${check.name} ENFORCED`)
      expect((await migratePortalDatabase(t,{resume:true})).status).toBe('current')
    }
    expect(await raw.get<Record<string,unknown>>('SELECT event_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_event')).toEqual({event_id:'history-safe',input_tokens:11,output_tokens:22,cache_read_tokens:33,cache_write_tokens:44})
    await raw.close()
  }),30000)
  test('v3 非事务存储引擎在任何迁移写入之前拒绝，防止假回滚',async()=>isolated(async t=>{
    await createLegacy(t)
    const raw=await openRawPortalStore(t)
    // MyISAM 的索引字节上限更低；缩短隔离夹具主键后才能构造非事务表。
    await raw.exec('ALTER TABLE usage_event MODIFY COLUMN event_id VARCHAR(200) NOT NULL')
    await raw.exec('ALTER TABLE usage_event ENGINE=MyISAM')
    await expect(migratePortalDatabase(t,{confirmOffline:true})).rejects.toThrow('InnoDB')
    const info=await inspectPortalDatabase(t)
    expect(info.status).toBe('legacy');expect(info.eventCount).toBe(1)
    expect(info.tables.includes('portal_schema_migrations')).toBe(false)
    await raw.close()
  }),30000)
  test('v3 真实备份证明、显式迁移、原始字段指纹与 pending 归属', async () => isolated(async t => {
    await createLegacy(t)
    await expect(openPortalStore(t)).rejects.toThrow('唯一副本')
    const raw = await openRawPortalStore(t)
    const backup = join(root, `${randomUUID()}.mysql-backup.json`)
    const dump: Record<string, unknown> = {}
    for (const table of ['usage_event','portal_meta','ingest_run']) dump[table] = { ddl:await raw.get<Record<string, unknown>>(`SHOW CREATE TABLE ${table}`), rows:await raw.all(`SELECT * FROM ${table}`) }
    await raw.close()
    writeFileSync(backup,JSON.stringify(dump,null,2))
    const proof = { path:backup,sha256:createHash('sha256').update(readFileSync(backup)).digest('hex'),target:describePortalTarget(t) }
    await expect(migratePortalDatabase(t,{ confirmOffline:true,mysqlBackupProof:{...proof,sha256:'0'.repeat(64)} })).rejects.toThrow('SHA256')
    expect((await migratePortalDatabase(t,{confirmOffline:true,mysqlBackupProof:proof})).status).toBe('current')
    const store = await openPortalStore(t)
    expect(await store.get<Record<string, unknown>>('SELECT status,member_id FROM legacy_attribution_map')).toEqual({status:'pending',member_id:null})
    expect(Number((await store.get<{ count:number }>('SELECT COUNT(*) AS count FROM usage_event'))?.count)).toBe(1)
    await store.close()
    const tampered=await openRawPortalStore(t)
    const count=await tampered.get<Record<string,unknown>>('SELECT COUNT(*) AS c FROM usage_event')
    await tampered.exec('ALTER TABLE usage_event DROP FOREIGN KEY fk_usage_v4_member')
    await expect(openPortalStore(t)).rejects.toThrow('实际外键')
    await tampered.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL")
    await expect(migratePortalDatabase(t,{resume:true,confirmOffline:true,mysqlBackupProof:proof})).rejects.toThrow('实际外键')
    expect(await tampered.get<Record<string,unknown>>('SELECT COUNT(*) AS c FROM usage_event')).toEqual(count)
    expect(await tampered.get("SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='usage_event' AND constraint_name='fk_usage_v4_member'")).toBeNull()
    await tampered.exec('ALTER TABLE usage_event ADD CONSTRAINT fk_usage_v4_member FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT')
    expect((await migratePortalDatabase(t,{resume:true,confirmOffline:true,mysqlBackupProof:proof})).status).toBe('current')
    await tampered.close()
    await verifyWrites(t)
  }), 30_000)
  test('部分 DDL 失败后只允许显式 resume，核对已完成 catalog 并保留检查点', async () => isolated(async t => {
    await createLegacy(t)
    const raw = await openRawPortalStore(t)
    await raw.exec('CREATE TABLE departments (broken INT)')
    const backup = join(root, `${randomUUID()}.mysql-backup.json`)
    const dump: Record<string,unknown> = {}
    for (const table of ['usage_event','portal_meta','ingest_run','departments']) dump[table] = { ddl:await raw.get<Record<string,unknown>>(`SHOW CREATE TABLE ${table}`),rows:await raw.all(`SELECT * FROM ${table}`) }
    writeFileSync(backup,JSON.stringify(dump,null,2))
    const proof = {path:backup,sha256:createHash('sha256').update(readFileSync(backup)).digest('hex'),target:describePortalTarget(t)}
    await expect(migratePortalDatabase(t,{confirmOffline:true,mysqlBackupProof:proof})).rejects.toThrow('实际列定义')
    expect((await inspectPortalDatabase(t)).status).toBe('incomplete')
    await expect(openPortalStore(t)).rejects.toThrow('incomplete')
    await expect(migratePortalDatabase(t,{confirmOffline:true,mysqlBackupProof:proof})).rejects.toThrow('resume')
    await raw.exec('DROP TABLE departments')
    expect((await migratePortalDatabase(t,{resume:true,confirmOffline:true,mysqlBackupProof:proof})).status).toBe('current')
    // 模拟提交种子后进程终止；恢复时不能再次插入或覆盖管理员已有权限。
    const before = await raw.get<{ last_completed_step:number }>('SELECT last_completed_step FROM portal_schema_migrations')
    await raw.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL")
    expect((await migratePortalDatabase(t,{resume:true,confirmOffline:true,mysqlBackupProof:proof})).status).toBe('current')
    expect(await raw.get<{ last_completed_step:number }>('SELECT last_completed_step FROM portal_schema_migrations')).toEqual(before)
    expect(Number((await raw.get<{ count:number }>('SELECT COUNT(*) AS count FROM roles'))?.count)).toBe(2)
    await raw.close()
  }),30_000)
})
