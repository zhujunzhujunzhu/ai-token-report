/** 上报库显式迁移：先备份与预检，再逐步建表；唯一副本永远不 DROP/重建。 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Database } from './driver.js'
import { describePortalTarget, openRawPortalStore, type PortalStore, type PortalTarget } from './portal-connection.js'
import { PORTAL_SCHEMA_VERSION, PORTAL_SQLITE_INGEST_SQL, PORTAL_MYSQL_INGEST_SQL, portalSchemaChecksum, portalSchemaStatements } from './portal-schema-v4.js'
import { checkExpressions, sameChecks, normalizeTrigger } from './portal-catalog.js'

export interface PortalInspection {
  kind: 'sqlite' | 'mysql'
  label: string
  version: number
  status: 'empty' | 'current' | 'legacy' | 'incomplete' | 'unsupported'
  tables: string[]
  eventCount: number
  migration: MigrationRow | null
}
interface MigrationRow {
  version: number; checksum: string; status: string; last_completed_step: number; checkpoint_json: string | object
}
export interface PortalMigrationOptions {
  resume?: boolean
  /** 旧服务必须停止；数据库锁不能阻止运行旧版本的其他进程。 */
  confirmOffline?: boolean
  sqliteBackupPath?: string
  mysqlBackupProof?: { path: string; sha256: string; target: string }
}
interface Checkpoint { sourceVersion: number; backup?: { path: string; sha256: string }; historyHash: string; historyCount: number }
const legacyColumns = ['event_id','session_id','seq','ts','provider','model','cwd','user_id','user_name','dept','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','turn','step']
const migrationHint = '上报库是全员历史的唯一副本，不会自动重建。请停止旧服务并运行 bun run packages/server/scripts/migrate-db.ts inspect，然后按备份指引显式 migrate/resume。'
function gate(message: string): Error { return new Error(`${message} ${migrationHint}`) }
function checkpointOf(row: MigrationRow): Checkpoint {
  return typeof row.checkpoint_json === 'string' ? JSON.parse(row.checkpoint_json) as Checkpoint : row.checkpoint_json as Checkpoint
}
async function tablesOf(store: PortalStore): Promise<string[]> {
  const rows = store.kind === 'sqlite'
    ? await store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    : await store.all<{ name: string }>('SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name')
  return rows.map(row => row.name)
}
async function inspectStore(store: PortalStore): Promise<PortalInspection> {
  const tables = await tablesOf(store)
  const version = store.kind === 'sqlite'
    ? Number((await store.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0)
    : tables.includes('portal_meta') ? Number((await store.get<{ schema_version: number }>('SELECT schema_version FROM portal_meta WHERE id=1'))?.schema_version ?? 0) : 0
  const migration = tables.includes('portal_schema_migrations')
    ? await store.get<MigrationRow>('SELECT version,checksum,status,last_completed_step,checkpoint_json FROM portal_schema_migrations WHERE version=4') : null
  const eventCount = tables.includes('usage_event') ? Number((await store.get<{ count: number }>('SELECT COUNT(*) AS count FROM usage_event'))?.count ?? 0) : 0
  let status: PortalInspection['status'] = 'unsupported'
  if (tables.length === 0 && version === 0) status = 'empty'
  else if (version === 0 && tables.length === 1 && tables[0] === 'portal_schema_migrations' && !migration) status = 'incomplete'
  else if (migration && migration.status !== 'completed') status = 'incomplete'
  else if (version === PORTAL_SCHEMA_VERSION && migration?.status === 'completed' && migration.checksum === portalSchemaChecksum(store.kind)) status = 'current'
  else if (version === 3 && tables.includes('usage_event') && !migration) status = 'legacy'
  return { kind: store.kind, label: store.label, version, status, tables, eventCount, migration }
}
export async function inspectPortalDatabase(target: PortalTarget): Promise<PortalInspection> {
  if (!target.mysqlUrl && !existsSync(target.sqlitePath)) return { kind: 'sqlite', label: target.sqlitePath, version: 0, status: 'empty', tables: [], eventCount: 0, migration: null }
  const store = await openRawPortalStore(target)
  try { return await inspectStore(store) } finally { await store.close() }
}

function tableStatement(kind: 'sqlite' | 'mysql', table: string): string {
  const statement = portalSchemaStatements(kind).find(sql => sql.startsWith(`CREATE TABLE ${table} (`))
  if (!statement) throw new Error(`缺少受控表定义：${table}`)
  return statement
}
function expectedColumns(sql: string): { name: string; type: string; nullable: boolean }[] {
  return [...sql.matchAll(/^  ([a-z_]+) (TEXT|INTEGER|BIGINT|INT|TINYINT|CHAR\(\d+\)|VARCHAR\(\d+\)|JSON)(?=\s)([^\n]*)/gm)]
    .map(match => ({ name: match[1]!, type: match[2]!.toLowerCase(), nullable: !/NOT NULL|PRIMARY KEY/.test(match[3]!) }))
}
async function verifyTable(store: PortalStore, table: string, sql: string, allowExtra = false): Promise<void> {
  const expected = expectedColumns(sql)
  const actual = store.kind === 'sqlite'
    ? (await store.all<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info(${table})`)).map(row => ({ name: row.name, type: row.type.toLowerCase(), nullable: row.notnull === 0 && row.pk === 0 }))
    : (await store.all<{ name: string; type: string; nullable: string }>('SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=$table ORDER BY ordinal_position', { $table: table })).map(row => ({ ...row, nullable: row.nullable === 'YES' }))
  if ((!allowExtra && actual.length !== expected.length) || expected.some(column => !actual.some(row => row.name === column.name && row.type === column.type && row.nullable === column.nullable))) {
    throw gate(`表 ${table} 的实际列定义与迁移计划不一致，拒绝继续。`)
  }
  if (store.kind === 'sqlite') {
    const catalog = await store.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=$name', { $name: table })
    const normalize = (value: string) => value.replace(/\s/g, '').replace(/;$/, '')
    if (!catalog || normalize(catalog.sql) !== normalize(sql)) throw gate(`表 ${table} 的 CHECK/外键/唯一约束与受控定义不一致。`)
    return
  }
  await requireTransactionalTable(store,table)
  await verifyMysqlConstraints(store,table,sql)
  const expectedUnique = [...sql.matchAll(/(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)/g)].map(match => match[1]!.replace(/\s/g,''))
  for (const line of sql.split('\n')) {
    const name = /^  ([a-z_]+) /.exec(line)?.[1]
    if (name && /PRIMARY KEY|\bUNIQUE\b/.test(line)) expectedUnique.push(name)
  }
  const uniqueRows = await store.all<{ name: string; col: string }>('SELECT index_name AS name,column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND non_unique=0 ORDER BY index_name,seq_in_index', { $table: table })
  const unique = new Map<string,string[]>()
  for (const row of uniqueRows) { const names = unique.get(row.name) ?? []; names.push(row.col); unique.set(row.name,names) }
  if (JSON.stringify([...unique.values()].map(names => names.join(',')).sort()) !== JSON.stringify(expectedUnique.sort())) throw gate(`表 ${table} 的唯一约束与主键不一致。`)
}
async function verifyMysqlConstraints(store: PortalStore, table: string, sql: string): Promise<void> {
  const expectedForeign = [...sql.matchAll(/FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)\(([^)]+)\) ON DELETE RESTRICT ON UPDATE RESTRICT/g)]
    .map(match => `${match[1]!.replace(/\s/g,'')}=>${match[2]}(${match[3]!.replace(/\s/g,'')})`).sort()
  const foreignRows = await store.all<{ name: string; col: string; ref_table: string; ref_col: string; delete_rule: string; update_rule: string }>('SELECT k.constraint_name AS name,k.column_name AS col,k.referenced_table_name AS ref_table,k.referenced_column_name AS ref_col,r.delete_rule AS delete_rule,r.update_rule AS update_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name WHERE k.table_schema=DATABASE() AND k.table_name=$table ORDER BY k.constraint_name,k.ordinal_position', { $table: table })
  const grouped = new Map<string, typeof foreignRows>()
  for (const row of foreignRows) { const rows = grouped.get(row.name) ?? []; rows.push(row); grouped.set(row.name, rows) }
  const actualForeign = [...grouped.values()].map(rows => `${rows.map(row => row.col).join(',')}=>${rows[0]!.ref_table}(${rows.map(row => row.ref_col).join(',')})`).sort()
  if (JSON.stringify(actualForeign) !== JSON.stringify(expectedForeign) || foreignRows.some(row => row.delete_rule !== 'RESTRICT' || row.update_rule !== 'RESTRICT')) throw gate(`表 ${table} 的实际外键与 RESTRICT 规则不一致。`)
  const checks = await store.all<{ expression: string; enforced: string }>("SELECT c.check_clause AS expression,t.enforced AS enforced FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.table_name=$table AND t.constraint_type='CHECK'", { $table: table })
  // MySQL 的 information_schema 用反斜线转义表达式中的字符串定界符。
  if (checks.some(row => row.enforced !== 'YES') || !sameChecks(checks.map(row => row.expression.replace(/\\'/g,"'")), checkExpressions(sql))) throw gate(`表 ${table} 的 CHECK 实际定义或执行状态不一致。`)
}
async function verifySqliteUsageConstraints(store: PortalStore, legacy: boolean): Promise<void> {
  const ddl = tableStatement('sqlite','usage_event')
  const catalog = await store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_event'")
  const expectedChecks = legacy
    ? checkExpressions(ddl.split('\n').filter(line => /^  (member_id|department_id|report_token_id|received_at_ms) /.test(line)).join('\n'))
    : checkExpressions(ddl)
  if (!catalog || !sameChecks(checkExpressions(catalog.sql),expectedChecks)) throw gate('usage_event 的 CHECK 实际定义不一致。')
  const rows = await store.all<{ id:number; seq:number; table:string; from:string; to:string; on_update:string; on_delete:string }>('PRAGMA foreign_key_list(usage_event)')
  const grouped = new Map<number, typeof rows>()
  for (const row of rows) { const group=grouped.get(row.id)??[]; group.push(row); grouped.set(row.id,group) }
  const actual = [...grouped.values()].map(group => { group.sort((a,b)=>a.seq-b.seq); return `${group.map(row=>row.from).join(',')}=>${group[0]!.table}(${group.map(row=>row.to).join(',')})` }).sort()
  const expected = [...ddl.matchAll(/FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)\(([^)]+)\)/g)]
    .filter(match => !legacy || !match[1]!.includes(','))
    .map(match => `${match[1]}=>${match[2]}(${match[3]})`).sort()
  if (JSON.stringify(actual)!==JSON.stringify(expected) || rows.some(row=>row.on_delete!=='RESTRICT'||row.on_update!=='RESTRICT')) throw gate('usage_event 的实际外键与 RESTRICT 规则不一致。')
  if (legacy) for (const sql of legacySqliteTriggers()) {
    const name = /^CREATE TRIGGER (\w+)/.exec(sql)![1]!
    const row = await store.get<{ sql:string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=$name",{$name:name})
    if (!row || normalizeTrigger(row.sql)!==normalizeTrigger(sql)) throw gate(`历史约束触发器 ${name} 缺失或实际定义不一致。`)
  }
}

/** 迁移写入与 current/resume 核验共用同一份触发器定义。 */
function legacySqliteTriggers(): string[] {
  const ddl = tableStatement('sqlite','usage_event')
  const triggers = ['INSERT','UPDATE'].map(event => `CREATE TRIGGER usage_v4_token_${event.toLowerCase()} BEFORE ${event} ON usage_event WHEN NEW.report_token_id IS NOT NULL AND (NEW.member_id IS NULL OR NOT EXISTS (SELECT 1 FROM report_tokens WHERE token_id=NEW.report_token_id AND member_id=NEW.member_id)) BEGIN SELECT RAISE(ABORT,'usage_event token member mismatch'); END`)
  triggers.push("CREATE TRIGGER usage_v4_token_owner_update BEFORE UPDATE OF member_id ON report_tokens WHEN NEW.member_id<>OLD.member_id AND EXISTS (SELECT 1 FROM usage_event WHERE report_token_id=OLD.token_id) BEGIN SELECT RAISE(ABORT,'usage_event historical token owner is immutable'); END")
  const checks = legacyColumns.flatMap(name => {
    const line = ddl.split('\n').find(line => line.startsWith(`  ${name} `))
    return checkExpressions(line ?? '').map(expression=>expression.replace(new RegExp(`\\b(${legacyColumns.join('|')})\\b`,'g'),'NEW.$1'))
  })
  for (const event of ['INSERT','UPDATE']) triggers.push(`CREATE TRIGGER usage_v4_values_${event.toLowerCase()} BEFORE ${event} ON usage_event WHEN NEW.event_id IS NULL OR NOT (${checks.map(check=>`(${check})`).join(' AND ')}) BEGIN SELECT RAISE(ABORT,'usage_event v4 value constraint'); END`)
  return triggers
}
async function verifyCurrent(store: PortalStore): Promise<void> {
  const tables = await tablesOf(store)
  for (const sql of portalSchemaStatements(store.kind)) {
    const match = /^CREATE TABLE (\w+) \(/.exec(sql)
    if (!match) continue
    if (!tables.includes(match[1]!)) throw gate(`v4 缺少表 ${match[1]}。`)
    // 旧 usage_event 只增列，保留旧字段类型及约束；新外键另行验证。
    if (match[1] !== 'usage_event') await verifyTable(store, match[1]!, sql)
  }
  const columns = store.kind === 'sqlite'
    ? (await store.all<{ name: string; type: string; notnull: number }>('PRAGMA table_info(usage_event)')).map(row => ({ name:row.name,type:row.type.toLowerCase(),nullable:row.notnull===0 }))
    : (await store.all<{ name: string; type: string; nullable: string }>("SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")).map(row => ({ ...row,nullable:row.nullable==='YES' }))
  if (['member_id','department_id','report_token_id','received_at_ms',...legacyColumns].some(name => !columns.some(row => row.name===name))) throw gate('usage_event 事实列缺失。')
  for (const column of expectedColumns(tableStatement(store.kind,'usage_event')).filter(column => !legacyColumns.includes(column.name))) {
    if (!columns.some(row => row.name===column.name && row.type===column.type && row.nullable===column.nullable)) throw gate(`usage_event 新列 ${column.name} 的目录定义不一致。`)
  }
  if (!tables.includes('ingest_run')) throw gate('缺少 ingest_run 诊断表。')
  await requireEventPrimaryKey(store,true)
  if (store.kind === 'mysql') {
    await requireTransactionalTable(store,'usage_event')
    await requireTransactionalTable(store,'ingest_run')
    await verifyMysqlConstraints(store,'usage_event',tableStatement('mysql','usage_event'))
  } else {
    const migration = await store.get<MigrationRow>('SELECT checkpoint_json FROM portal_schema_migrations WHERE version=4')
    await verifySqliteUsageConstraints(store, migration ? checkpointOf(migration).sourceVersion === 3 : false)
  }
  if (store.kind === 'sqlite' && (await store.all('PRAGMA foreign_key_check')).length) throw gate('检测到外键不一致。')
}

/** 同步兼容入口只初始化空库；版本与迁移记录必须同时吻合。 */
export function ensurePortalSqliteReady(db: Database): void {
  const tables = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name)
  const version = Number(db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version ?? 0)
  if (tables.length === 0 && version === 0) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const sql of portalSchemaStatements('sqlite')) db.exec(sql)
      db.exec(PORTAL_SQLITE_INGEST_SQL)
      const now = Date.now()
      db.query('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,4,$checksum,\'completed\',1,$checkpoint,$now,$now)').run({ $id: randomUUID(), $checksum: portalSchemaChecksum('sqlite'), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }), $now: now })
      db.exec('PRAGMA user_version=4; COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ } throw error }
    return
  }
  const migration = tables.includes('portal_schema_migrations') ? db.query<MigrationRow>('SELECT checksum,status FROM portal_schema_migrations WHERE version=4').get() : null
  if (version !== 4 || migration?.status !== 'completed' || migration.checksum !== portalSchemaChecksum('sqlite')) throw gate(`上报库 schema 版本 ${version} 不符合当前 v4。`)
  for (const sql of portalSchemaStatements('sqlite')) {
    const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (table && !tables.includes(table)) throw gate(`v4 缺少表 ${table}。`)
  }
}

/** 迁移锁必须跨 MySQL 隐式提交的 DDL 保持在同一条连接。 */
async function withMigrationLock<T>(store: PortalStore, fn: (connection: PortalStore) => Promise<T>): Promise<T> {
  return store.withConnection(async connection => {
    if (store.kind === 'sqlite') return fn(connection)
    const db = await connection.get<{ name: string }>('SELECT DATABASE() AS name')
    const lock = `atr-v4-${createHash('sha256').update(db?.name ?? '').digest('hex').slice(0,40)}`
    const result = await connection.get<{ acquired: number }>('SELECT GET_LOCK($lock,15) AS acquired', { $lock: lock })
    if (Number(result?.acquired) !== 1) throw gate('获取上报库迁移锁超时。')
    try { return await fn(connection) }
    finally { await connection.get('SELECT RELEASE_LOCK($lock)', { $lock: lock }) }
  })
}
export async function ensurePortalReady(store: PortalStore): Promise<void> {
  const initial = await inspectStore(store)
  if (initial.status === 'current') { await verifyCurrent(store); return }
  if (initial.status !== 'empty' && initial.status !== 'incomplete') throw gate(`上报库状态 ${initial.status}，版本 ${initial.version}。`)
  await withMigrationLock(store, async connection => {
    const state = await inspectStore(connection)
    if (state.status === 'current') return verifyCurrent(connection)
    // 若另一进程正在初始化，先等迁移锁再看结果；崩溃遗留仍须显式 resume。
    if (state.status !== 'empty') throw gate(`上报库状态 ${state.status}，请显式恢复。`)
    if (store.kind === 'sqlite') await connection.transaction(tx => executePlan(tx, { sourceVersion: 0, historyHash: '', historyCount: 0 }))
    else await executePlan(connection, { sourceVersion: 0, historyHash: '', historyCount: 0 })
  })
}
export async function preparePortalDatabase(target: PortalTarget, options: PortalMigrationOptions & { migrate?: boolean } = {}): Promise<PortalInspection> {
  if (options.migrate) return migratePortalDatabase(target, options)
  const store = await openRawPortalStore(target)
  try { await ensurePortalReady(store); return await inspectStore(store) } finally { await store.close() }
}

async function historyFingerprint(store: PortalStore): Promise<{ hash: string; count: number }> {
  // 逐页按精确事件键排序，不把全员历史一次性读进内存。
  const hash = createHash('sha256')
  let count = 0
  for (;;) {
    const rows = await store.all<Record<string, unknown>>(`SELECT ${legacyColumns.join(',')} FROM usage_event ORDER BY ${store.kind === 'mysql' ? 'BINARY event_id' : 'event_id COLLATE BINARY'} LIMIT 1000 OFFSET ${count}`)
    for (const row of rows) hash.update(JSON.stringify(legacyColumns.map(name => typeof row[name] === 'bigint' ? String(row[name]) : row[name])) + '\n')
    count += rows.length
    if (rows.length < 1000) return { hash: hash.digest('hex'), count }
  }
}
async function preflight(store: PortalStore): Promise<void> {
  await requireEventPrimaryKey(store,false)
  if (store.kind === 'mysql') {
    await requireTransactionalTable(store,'usage_event')
    await requireTransactionalTable(store,'ingest_run')
    await requireTransactionalTable(store,'portal_meta')
  }
  const len = store.kind === 'mysql' ? 'CHAR_LENGTH' : 'length'
  const textChecks = ['event_id','session_id','user_id','user_name','dept'].map(name => `(${name} IS NOT NULL AND ${len}(${name}) NOT BETWEEN 1 AND 255)`)
  textChecks.push(...['provider','model'].map(name => `${len}(${name}) > 255`))
  const numeric = ['seq','ts','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens']
  const numericChecks = numeric.map(name => `(${name} IS NULL OR ${name} < 0 OR ${name} > 9007199254740991${store.kind === 'sqlite' ? ` OR typeof(${name}) <> 'integer'` : ''})`)
  numericChecks.push(...['turn','step'].map(name => `(${name} IS NOT NULL AND (${name} < -9007199254740991 OR ${name} > 9007199254740991${store.kind === 'sqlite' ? ` OR typeof(${name}) <> 'integer'` : ''}))`))
  const result = await store.get<{ count: number }>(`SELECT COUNT(*) AS count FROM usage_event WHERE event_id IS NULL OR ${[...textChecks,...numericChecks].join(' OR ')}`)
  if (Number(result?.count ?? 0) > 0) throw gate(`迁移预检发现 ${result?.count} 条原始事件超出 v4 存储边界；不会截断或改写。`)
}
async function requireTransactionalTable(store: PortalStore, table: string): Promise<void> {
  const row=await store.get<{engine:string}>('SELECT engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=$table',{$table:table})
  if(row?.engine?.toUpperCase()!=='INNODB') throw gate(`表 ${table} 必须使用 InnoDB 才能保证回滚与历史外键；不会自动转换存储引擎。`)
}
async function requireEventPrimaryKey(store: PortalStore,current: boolean): Promise<void> {
  if(store.kind==='sqlite') {
    const indexes=await store.all<{name:string;origin:string;unique:number}>('PRAGMA index_list(usage_event)')
    const primary=indexes.find(index=>index.origin==='pk' && Number(index.unique)===1)
    const columns=primary ? (await store.all<{name:string|null;coll:string;key:number}>(`PRAGMA index_xinfo('${primary.name.replace(/'/g,"''")}')`)).filter(row=>Number(row.key)===1) : []
    if(columns.length!==1 || columns[0]!.name!=='event_id' || columns[0]!.coll!=='BINARY') throw gate('usage_event 必须以精确 BINARY event_id 为完整主键，拒绝可能错误去重的表。')
    return
  }
  const primary=await store.all<{name:string;sub_part:number|null}>("SELECT column_name AS name,sub_part AS sub_part FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='usage_event' AND index_name='PRIMARY' ORDER BY seq_in_index")
  if(primary.length!==1 || primary[0]!.name!=='event_id' || primary[0]!.sub_part!==null) throw gate('usage_event 必须以完整 event_id 为唯一主键。')
  if(current) {
    const row=await store.get<{collation_name:string}>("SELECT collation_name AS collation_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event' AND column_name='event_id'")
    if(row?.collation_name!=='utf8mb4_0900_bin') throw gate('usage_event.event_id 必须使用精确 NO PAD 比较，拒绝可能错误去重的表。')
  }
}
function backupProof(target: PortalTarget, options: PortalMigrationOptions): { path: string; sha256: string } {
  const proof = options.mysqlBackupProof
  if (!proof || proof.target !== describePortalTarget(target) || !/^[0-9a-f]{64}$/.test(proof.sha256)) throw gate('MySQL 迁移要求明确匹配目标库的备份文件与 SHA256 证明。')
  const path = resolve(proof.path)
  if (!statSync(path).isFile() || statSync(path).size === 0) throw gate('备份证明文件为空或不是普通文件。')
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (sha256 !== proof.sha256) throw gate('备份文件 SHA256 不匹配。')
  return { path, sha256 }
}
export async function migratePortalDatabase(target: PortalTarget, options: PortalMigrationOptions = {}): Promise<PortalInspection> {
  const store = await openRawPortalStore(target)
  try {
    await withMigrationLock(store, async connection => {
      const state = await inspectStore(connection)
      if (state.status === 'current') return verifyCurrent(connection)
      if (state.status === 'empty') {
        if (store.kind === 'sqlite') return connection.transaction(tx => executePlan(tx, { sourceVersion: 0, historyHash: '', historyCount: 0 }))
        return executePlan(connection, { sourceVersion: 0, historyHash: '', historyCount: 0 })
      }
      if (state.status !== 'legacy' && state.status !== 'incomplete') throw gate(`不支持迁移版本 ${state.version}。`)
      if (state.status === 'incomplete' && !options.resume) throw gate('发现未完成迁移，必须显式 resume。')
      if (state.migration && state.migration.checksum !== portalSchemaChecksum(store.kind)) throw gate('未完成迁移的 checksum 与当前程序不同，拒绝跳步。')
      const previous = state.migration ? checkpointOf(state.migration) : null
      // MySQL CREATE 迁移表会隐式提交；紧接着进程退出时还来不及写第一条检查点。
      if (!previous && state.version === 0 && state.tables.length === 1 && state.tables[0] === 'portal_schema_migrations') return executePlan(connection, { sourceVersion: 0, historyHash: '', historyCount: 0 })
      if ((previous?.sourceVersion ?? 3) === 0) return executePlan(connection, previous!)
      if (!options.confirmOffline) throw gate('迁移 v3 前必须明确确认旧服务已停止（--confirm-offline）。')
      await preflight(connection)
      const before = await historyFingerprint(connection)
      let backup: Checkpoint['backup']
      if (store.kind === 'mysql') backup = backupProof(target, options)
      else {
        const path = resolve(options.sqliteBackupPath ?? `${target.sqlitePath}.v3-backup-${Date.now()}.sqlite`)
        if (existsSync(path) || path === resolve(target.sqlitePath)) throw gate('SQLite 备份路径必须不存在且不同于源库。')
        mkdirSync(dirname(path), { recursive: true })
        await connection.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
        backup = { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
        writeFileSync(`${path}.manifest.json`, JSON.stringify({ target: describePortalTarget(target), ...backup, historyHash: before.hash, historyCount: before.count }, null, 2), { flag: 'wx' })
      }
      const checkpoint: Checkpoint = previous ?? { sourceVersion: 3, backup, historyHash: before.hash, historyCount: before.count }
      if (checkpoint.historyHash !== before.hash || checkpoint.historyCount !== before.count) throw gate('迁移恢复时原始事件与检查点不符。')
      if (store.kind === 'sqlite') await connection.transaction(async tx => {
        const locked = await historyFingerprint(tx)
        if (locked.hash !== before.hash) throw gate('备份后检测到并发写入，请停止旧服务后重试。')
        await executePlan(tx, checkpoint)
      })
      else await executePlan(connection, checkpoint)
    })
    return await inspectStore(store)
  } finally { await store.close() }
}

async function executePlan(store: PortalStore, checkpoint: Checkpoint): Promise<void> {
  const ledger = tableStatement(store.kind, 'portal_schema_migrations')
  if (!(await tablesOf(store)).includes('portal_schema_migrations')) await store.exec(ledger)
  await verifyTable(store, 'portal_schema_migrations', ledger)
  let row = await store.get<MigrationRow>('SELECT * FROM portal_schema_migrations WHERE version=4')
  if (!row) {
    await store.run('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms) VALUES ($id,4,$hash,\'started\',0,$checkpoint,$now)', { $id: randomUUID(), $hash: portalSchemaChecksum(store.kind), $checkpoint: JSON.stringify(checkpoint), $now: Date.now() })
    row = { version: 4, checksum: portalSchemaChecksum(store.kind), status: 'started', last_completed_step: 0, checkpoint_json: JSON.stringify(checkpoint) }
  }
  const steps: (() => Promise<void>)[] = []
  let verifyingCompletedStep = false
  const seed: string[] = []
  for (const sql of portalSchemaStatements(store.kind)) {
    const table = /^CREATE TABLE (\w+) \(/.exec(sql)?.[1]
    if (table === 'portal_schema_migrations') continue
    if (sql.startsWith('INSERT')) { seed.push(sql); continue }
    if (table) {
      if (table === 'usage_event' && checkpoint.sourceVersion === 3) continue
      steps.push(async () => {
        if (!(await tablesOf(store)).includes(table)) {
          if (verifyingCompletedStep) throw gate(`已完成迁移步骤的表 ${table} 缺失，拒绝重建。`)
          await store.exec(sql)
        }
        await verifyTable(store, table, sql)
      })
    } else if (sql.startsWith('CREATE INDEX')) {
      if (checkpoint.sourceVersion === 3 && / ON usage_event /.test(sql) && !/member|department|token/.test(sql)) continue
      steps.push(async () => { await ensureIndex(store, sql, !verifyingCompletedStep) })
    }
  }
  // 新列必须早于使用它们的索引；旧表原列与全部事件保持原位。
  if (checkpoint.sourceVersion === 3) {
    const usageIndicesAt = steps.length
    const identities = steps.splice(0, usageIndicesAt)
    steps.push(...identities.filter((_step, index) => index < identities.length - 3))
    if (store.kind === 'mysql') steps.push(() => correctLegacyCollation(store))
    steps.push(() => addLegacyColumns(store, verifyingCompletedStep))
    steps.push(...identities.slice(-3))
  }
  steps.push(async () => { await store.exec(store.kind === 'sqlite' ? PORTAL_SQLITE_INGEST_SQL : PORTAL_MYSQL_INGEST_SQL) })
  // seed 和检查点同事务；崩溃重试不能覆盖管理员之后修改的权限关系。
  steps.push(async () => {
    const index = steps.length - 1
    const latest = await store.get<MigrationRow>('SELECT * FROM portal_schema_migrations WHERE version=4')
    if (Number(latest?.last_completed_step ?? 0) > index) return
    await store.transaction(async tx => {
      for (const sql of seed) await tx.exec(sql)
      await tx.run('UPDATE portal_schema_migrations SET last_completed_step=$step WHERE version=4', { $step: index + 1 })
    })
  })
  try {
    for (let index = 0; index < steps.length; index++) {
      // 已完成的 DDL 仍核对 catalog，只有原子 seed 可按检查点跳过。
      if (index < Number(row.last_completed_step) && index === steps.length - 1) continue
      verifyingCompletedStep = index < Number(row.last_completed_step)
      await steps[index]!()
      await store.run('UPDATE portal_schema_migrations SET last_completed_step=CASE WHEN last_completed_step<$step THEN $step ELSE last_completed_step END,status=\'started\' WHERE version=4', { $step: index + 1 })
    }
    if (checkpoint.sourceVersion === 3) {
      const after = await historyFingerprint(store)
      if (after.hash !== checkpoint.historyHash || after.count !== checkpoint.historyCount) throw gate('迁移前后原始事件不一致，拒绝标记完成。')
      await store.transaction(async tx => {
        const users = await tx.all<{ user_id: string }>('SELECT DISTINCT user_id FROM usage_event WHERE user_id IS NOT NULL')
        for (const user of users) {
          if (await tx.get('SELECT mapping_id FROM legacy_attribution_map WHERE legacy_user_id=$key', { $key: user.user_id })) continue
          await tx.run('INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,source_import_ref,created_at_ms) VALUES ($id,$key,\'portal-v3-v4\',$now)', { $id: randomUUID(), $key: user.user_id, $now: Date.now() })
        }
      })
    }
    await verifyCurrent(store)
    if (store.kind === 'mysql') {
      await store.exec('CREATE TABLE IF NOT EXISTS portal_meta (id TINYINT NOT NULL PRIMARY KEY,schema_version INT NOT NULL) ENGINE=InnoDB')
      await store.transaction(async tx => {
        if (await tx.get('SELECT id FROM portal_meta WHERE id=1')) await tx.exec('UPDATE portal_meta SET schema_version=4 WHERE id=1')
        else await tx.exec('INSERT INTO portal_meta (id,schema_version) VALUES (1,4)')
        await tx.run('UPDATE portal_schema_migrations SET status=\'completed\',completed_at_ms=$now WHERE version=4', { $now: Date.now() })
      })
    } else {
      await store.exec('PRAGMA user_version=4')
      await store.run('UPDATE portal_schema_migrations SET status=\'completed\',completed_at_ms=$now WHERE version=4', { $now: Date.now() })
    }
  } catch (error) {
    try { await store.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=4") } catch { /* 保留最初的迁移失败原因 */ }
    throw error
  }
}

async function correctLegacyCollation(store: PortalStore): Promise<void> {
  for (const name of ['event_id','session_id','provider','model','user_id','user_name','dept']) {
    const row = await store.get<{ type: string; nullable: string; collation_name: string; charset: string; column_default: string | null }>('SELECT column_type AS type,is_nullable AS nullable,collation_name AS collation_name,character_set_name AS charset,column_default AS column_default FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=\'usage_event\' AND column_name=$name', { $name: name })
    if (!row || row.type !== 'varchar(255)' || row.column_default !== null || row.charset !== 'utf8mb4') throw gate(`旧列 ${name} 定义不符合可安全校正的 v3 边界。`)
    if (row.collation_name === 'utf8mb4_0900_bin') continue
    await store.exec(`ALTER TABLE usage_event MODIFY COLUMN ${name} VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin ${row.nullable === 'YES' ? 'NULL DEFAULT NULL' : 'NOT NULL'}`)
  }
}

async function ensureIndex(store: PortalStore, sql: string, createMissing = true): Promise<void> {
  const match = /^CREATE INDEX (\w+) ON (\w+) \(([^)]+)\)/.exec(sql)
  if (!match) throw new Error('不支持的受控索引定义')
  const [, name, table, columns] = match
  const existing = store.kind === 'sqlite'
    ? await store.all<{ name: string }>(`PRAGMA index_info(${name})`)
    : await store.all<{ name: string }>('SELECT column_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND index_name=$name ORDER BY seq_in_index', { $table: table, $name: name })
  if (!existing.length) {
    if (!createMissing) throw gate(`已完成迁移步骤的索引 ${name} 缺失，拒绝自愈。`)
    await store.exec(sql)
  }
  else if (existing.map(row => row.name).join(',') !== columns!.replace(/\s/g,'')) throw gate(`索引 ${name} 目录定义不匹配。`)
}
async function addLegacyColumns(store: PortalStore, verifyOnly = false): Promise<void> {
  const ddl = tableStatement(store.kind, 'usage_event')
  if (verifyOnly) {
    if (store.kind === 'sqlite') await verifySqliteUsageConstraints(store,true)
    else await verifyMysqlConstraints(store,'usage_event',ddl)
    return
  }
  const existing = store.kind === 'sqlite'
    ? (await store.all<{ name: string }>('PRAGMA table_info(usage_event)')).map(row => row.name)
    : (await store.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")).map(row => row.name)
  for (const name of ['member_id','department_id','report_token_id','received_at_ms']) {
    if (existing.includes(name)) continue
    const line = ddl.split('\n').find(line => line.startsWith(`  ${name} `))!.trim().replace(/,$/,'')
    const reference = name === 'member_id' ? 'members(member_id)' : name === 'department_id' ? 'departments(department_id)' : name === 'report_token_id' ? 'report_tokens(token_id)' : null
    await store.exec(`ALTER TABLE usage_event ADD COLUMN ${line}${store.kind === 'sqlite' && reference ? ` REFERENCES ${reference} ON DELETE RESTRICT ON UPDATE RESTRICT` : ''}`)
  }
  if (store.kind === 'sqlite') {
    // SQLite 不能 ALTER ADD 复合外键；等价触发器补足令牌归属约束而不重建事实表。
    for (const sql of legacySqliteTriggers()) await store.exec(sql.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS '))
    await verifySqliteUsageConstraints(store,true)
  } else {
    const constraints = await store.all<{ name: string }>("SELECT constraint_name AS name FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='usage_event'")
    const foreign = [ ['member','member_id','members(member_id)'], ['department','department_id','departments(department_id)'], ['token','report_token_id','report_tokens(token_id)'], ['owner','member_id,report_token_id','report_tokens(member_id,token_id)'] ]
    for (const [suffix, columns, reference] of foreign) if (!constraints.some(row => row.name === `fk_usage_v4_${suffix}`)) await store.exec(`ALTER TABLE usage_event ADD CONSTRAINT fk_usage_v4_${suffix} FOREIGN KEY (${columns}) REFERENCES ${reference} ON DELETE RESTRICT ON UPDATE RESTRICT`)
    if (!constraints.some(row => row.name === 'ck_usage_v4_owner')) await store.exec('ALTER TABLE usage_event ADD CONSTRAINT ck_usage_v4_owner CHECK (report_token_id IS NULL OR member_id IS NOT NULL)')
    for (const name of legacyColumns) {
      const expression = ddl.split('\n').find(line => line.startsWith(`  ${name} `))?.match(/CHECK \((.*)\)/)?.[1]
      if (expression && !constraints.some(row => row.name === `ck_usage_v4_${name}`)) await store.exec(`ALTER TABLE usage_event ADD CONSTRAINT ck_usage_v4_${name} CHECK (${expression})`)
    }
    await verifyMysqlConstraints(store,'usage_event',ddl)
  }
}
