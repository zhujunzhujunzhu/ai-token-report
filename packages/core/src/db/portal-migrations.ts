/**
 * 上报库显式迁移：先备份与预检，再逐步升级；唯一副本永远不 DROP/重建整库。
 *
 * ## 版本路线
 *
 * | 起点 | 路径 |
 * |---|---|
 * | 空库 | **直接建 v5**（`executeV5Plan`） |
 * | v3 老库 | 先 `executeV4Plan` 迁到 v4 基线，再 `upgradeV4ToV5` |
 * | v4 库 | 只走 `upgradeV4ToV5` |
 *
 * ★ v4 是**冻结基线**：v3→v4 的加列逻辑与 v4 的 DDL 都不再改动，
 *   因为 v4 的 checksum 必须能重算出来，否则「这个库是不是完整 v4」无从判断。
 *
 * 🚨 v5 的 `usage_event` 去掉了一列（`department_id`）并把 `dept` 改名为 `group_name`。
 *   SQLite 不允许 DROP 掉被外键引用的列，所以 SQLite 分支必须**重建该表**，
 *   而重建期间必须关掉 `foreign_keys`（该 PRAGMA 在事务内无效，因此顺序是
 *   `PRAGMA OFF → BEGIN IMMEDIATE → DDL → PRAGMA foreign_key_check → COMMIT → PRAGMA ON`）。
 *   MySQL 分支则是常规的 `RENAME COLUMN` / `DROP FOREIGN KEY` / `DROP COLUMN`。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Database } from './driver.js'
import { describePortalTarget, openRawPortalStore, type PortalStore, type PortalTarget } from './portal-connection.js'
import { PORTAL_SCHEMA_VERSION, PORTAL_SQLITE_INGEST_SQL, PORTAL_MYSQL_INGEST_SQL, portalSchemaChecksum, portalSchemaChecksumV6, portalSchemaStatements, portalV6Statements, portalV6TableStatement, portalV7Statements, portalV7TableStatement } from './portal-schema-v5.js'
import { PORTAL_SQLITE_V4_INGEST_SQL, PORTAL_MYSQL_V4_INGEST_SQL, portalSchemaChecksumV4, portalSchemaStatementsV4 } from './portal-schema-v4.js'
import { checkExpressions, sameChecks, normalizeTrigger } from './portal-catalog.js'

/**
 * 冻结基线版本：v3 库先迁到它，再由 v5 步骤接管。
 *
 * ⚠️ **v5 是「结构改造步骤」而不是冻结基线**：它的 DDL 文本在升 v6 时
 *   被追加了（`provider_alias` 与权限行），所以已迁到 v5 的库 digest 会变，
 *   从而落入 `legacy` 并被要求显式迁移 —— 这正是我们要的。
 */
const BASELINE_VERSION = 4
/**
 * v5 的**结构**版本号。它的账本行仍然要能被认出来（那是「基线已就绪」的证据），
 * 而 `PORTAL_SCHEMA_VERSION` 已经是 7。
 */
const V5_VERSION = 5
/**
 * v6 的**结构**版本号。与 v5 同理：v7 的账本行是当前版本，
 * 而 v6 行必须能被认出来 —— 那是「这个库是完整的上一版、可以原地升 v7」的证据。
 */
const V6_VERSION = 6
type SchemaVersion = 4 | 5

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
/**
 * v4 事实表的原始列（v3 就有的那批 + 快照列 `dept`）。
 *
 * ⚠️ 这是 **v4 的**列表。v5 把 `dept` 改名为 `group_name`，所以涉及
 *   「v4 的表结构」的校验必须用这一份，涉及 v5 的用 {@link V5_FACT_COLUMNS}。
 */
const legacyColumns = ['event_id','session_id','seq','ts','provider','model','cwd','user_id','user_name','dept','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','turn','step']
/** v5 事实表的原始列：与 v4 同序，只有快照列换了名字。 */
const V5_FACT_COLUMNS = [...legacyColumns.slice(0, 9), 'group_name', ...legacyColumns.slice(10)]
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
/** 业务版本闸门只读目录与迁移账本，不能随历史事件数增长而扫描整张事实表。 */
async function migrationRow(store: PortalStore, tables: string[], version: number): Promise<MigrationRow | null> {
  if (!tables.includes('portal_schema_migrations')) return null
  return await store.get<MigrationRow>('SELECT version,checksum,status,last_completed_step,checkpoint_json FROM portal_schema_migrations WHERE version=$version', { $version: version })
}
async function readPortalState(store: PortalStore): Promise<Omit<PortalInspection, 'eventCount'>> {
  const tables = await tablesOf(store)
  const version = store.kind === 'sqlite'
    ? Number((await store.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0)
    : tables.includes('portal_meta') ? Number((await store.get<{ schema_version: number }>('SELECT schema_version FROM portal_meta WHERE id=1'))?.schema_version ?? 0) : 0
  const current = await migrationRow(store, tables, PORTAL_SCHEMA_VERSION)
  const baseline = await migrationRow(store, tables, BASELINE_VERSION)
  /**
   * v5 账本行是否存在且完整。
   *
   * 🚨 判定「v4 基线是否就绪」**不能看 `state.version`**：v6 的 DDL 是在 v5
   *   之上追加的，所以一个已经迁到 v5 的库版本号是 5、`dept` 早已改名
   *   `group_name`。若按版本号判断，会得出「基线还没做」→ 重跑 v3→v4 →
   *   `historyFingerprint('dept')` 抛 `Unknown column 'dept'`，此后每次 resume
   *   都失败。v5 账本行一旦存在，基线步骤就早已过去。
   */
  const v5Row = await migrationRow(store, tables, V5_VERSION)
  const v6Row = await migrationRow(store, tables, V6_VERSION)
  let status: PortalInspection['status'] = 'unsupported'
  if (tables.length === 0 && version === 0) status = 'empty'
  else if (version === 0 && tables.length === 1 && tables[0] === 'portal_schema_migrations' && !current && !baseline) status = 'incomplete'
  else if (current && current.status !== 'completed') status = 'incomplete'
  else if (version === PORTAL_SCHEMA_VERSION && current?.status === 'completed' && current.checksum === portalSchemaChecksum(store.kind)) status = 'current'
  // v4：基线账本完整、checksum 与冻结基线一致 —— 它是**可迁移的起点**，不是坏库。
  else if (version === BASELINE_VERSION && baseline?.status === 'completed' && baseline.checksum === portalSchemaChecksumV4(store.kind)) status = 'legacy'
  // v3：一条账本行都没有的老库，先迁到 v4 基线再升 v5。
  else if (version === 3 && tables.includes('usage_event') && !current && !baseline) status = 'legacy'
  // ★ v5：结构是「分组多对多」，但受控 DDL 已经追加了 provider_alias。
  //   它的 digest 必然对不上 —— 落进 legacy，必须显式迁移到当前版本。
  else if (version === V5_VERSION && v5Row?.status === 'completed' && !current) status = 'legacy'
  // ★ v6：结构 = v5 + provider_alias，但受控 DDL 已经追加了 model_price。
  //   这里额外比对**冻结的 v6 摘要**（`portalSchemaChecksumV6`）：只有
  //   「确实是本程序发布出去的那一版 v6」才放行。少了它，一个被手工改过结构的
  //   v6 库会冒充成「结构完好、只差一次追加迁移」，而 v7 是纯追加 ——
  //   它会一路升上去、把手工改动留在库里，且没有任何一步会报错。
  else if (version === V6_VERSION && v6Row?.status === 'completed' && v6Row.checksum === portalSchemaChecksumV6(store.kind) && !current) status = 'legacy'
  // v5/v6/v7 账本存在但 checksum 不符（程序换了 SQL 或库被改过）会落到 'unsupported'，绝不冒充 current。
  return { kind: store.kind, label: store.label, version, status, tables, migration: current ?? v6Row ?? v5Row ?? baseline }
}
async function inspectStore(store: PortalStore): Promise<PortalInspection> {
  const state = await readPortalState(store)
  const eventCount = state.tables.includes('usage_event') ? Number((await store.get<{ count: number }>('SELECT COUNT(*) AS count FROM usage_event'))?.count ?? 0) : 0
  return { ...state, eventCount }
}
export async function inspectPortalDatabase(target: PortalTarget): Promise<PortalInspection> {
  if (!target.mysqlUrl && !existsSync(target.sqlitePath)) return { kind: 'sqlite', label: target.sqlitePath, version: 0, status: 'empty', tables: [], eventCount: 0, migration: null }
  const store = await openRawPortalStore(target)
  try { return await inspectStore(store) } finally { await store.close() }
}

function tableStatement(kind: 'sqlite' | 'mysql', table: string, version: SchemaVersion = 5): string {
  const statements = version === 5 ? portalSchemaStatements(kind) : portalSchemaStatementsV4(kind)
  const statement = statements.find(sql => sql.startsWith(`CREATE TABLE ${table} (`))
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
    // ★ 双引号必须一并去掉：SQLite 的 `ALTER TABLE ... RENAME TO/COLUMN` 会**改写**
    //   表定义文本，并给被改名的标识符补上双引号（`CREATE TABLE "member_groups"`）。
    //   保留引号会让「RENAME 出来的表」永远不等于受控定义，迁移当场失败 ——
    //   而它实际上完全正确。SQLite 的单引号才是字符串字面量，双引号只用于标识符，
    //   所以去掉它是安全的、也不会放松任何校验。
    const normalize = (value: string) => value.replace(/\s/g, '').replace(/"/g, '').replace(/;$/, '')
    if (!catalog || normalize(catalog.sql) !== normalize(sql)) throw gate(`表 ${table} 的 CHECK/外键/唯一约束与受控定义不一致。`)
    return
  }
  await requireTransactionalTable(store,table)
  await verifyMysqlConstraints(store,table,sql)
  // ⚠️ 只认**表级**唯一约束，且必须是「关键字后紧跟列清单」的形状。
  //   写成 `(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)` 会**跨过中间的令牌**去匹配，
  //   于是列级写法 `alias_id … NOT NULL PRIMARY KEY CHECK (alias_id REGEXP '…')`
  //   会被捕获成 `alias_id REGEXP '^[0-9a-f]{8}-…'` —— 一个根本不存在的「列组合」，
  //   让每一张主键写成列级约束的表都在 MySQL 上判成「唯一约束不一致」。
  //   这个洞在 SQLite 上永不暴露（那里只比 `sqlite_master.sql` 全文，见上面 return），
  //   所以它专挑「只有活体 MySQL 才走到」的路径发作。
  const expectedUnique = [...sql.matchAll(/(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)/g)]
    .filter(match => /^[\s\w,]+$/.test(match[1]!))
    .map(match => match[1]!.replace(/\s/g,''))
  // 显式建的唯一索引（`CREATE UNIQUE INDEX <名> ON <表> (列…)`）：在受控 DDL 里它是
  // **独立语句**，不在 `CREATE TABLE` 文本内，所以必须单独取 —— 只解析 `sql`
  // 会漏掉 `provider_alias` 的 `(member_id, provider)`，MySQL 上直接判成不一致。
  // ⚠️ **只认 `CREATE UNIQUE INDEX`**：`CREATE INDEX` 是普通索引，
  //   把它算进来会让期望值多出一份不存在的唯一约束。
  const create = new RegExp(`CREATE UNIQUE INDEX [A-Za-z_][\\w]* ON ${table} \\(([^)]+)\\)`)
  for (const statement of portalSchemaStatements(store.kind)) {
    const index = create.exec(statement)
    if (index) expectedUnique.push(index[1]!.replace(/\s/g,''))
  }
  for (const line of sql.split('\n')) {
    const name = /^  ([a-z_]+) /.exec(line)?.[1]
    if (name && /PRIMARY KEY|\bUNIQUE\b/.test(line)) expectedUnique.push(name)
  }
  // ⚠️ 受控 DDL 里写的是**列名**（内联 `PRIMARY KEY` 没有索引名），
  //   而 MySQL 的主键索引名恒为 `PRIMARY` —— 所以只比**列组合**，不比索引名：
  //   比索引名会让每一张带主键的表都在 MySQL 上判成「约束不一致」。
  //   顺序由 `seq_in_index` 固定，故先按索引名分组、再 join 是稳定的。
  const uniqueRows = await store.all<{ name: string; col: string }>('SELECT index_name AS name,column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND non_unique=0 ORDER BY index_name,seq_in_index', { $table: table })
  const unique = new Map<string,string[]>()
  for (const row of uniqueRows) { const names = unique.get(row.name) ?? []; names.push(row.col); unique.set(row.name,names) }
  const actualUnique = [...unique.values()].map(names => names.join(',')).sort()
  if (JSON.stringify(actualUnique) !== JSON.stringify(expectedUnique.sort())) throw gate(`表 ${table} 的唯一约束与主键不一致。`)
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
async function verifySqliteUsageConstraints(store: PortalStore, legacy: boolean, version: SchemaVersion = 5): Promise<void> {
  const ddl = tableStatement('sqlite','usage_event',version)
  const catalog = await store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_event'")
  // v4 的库分两种形态：由 v3 迁来的（新列是 ALTER 加的，CHECK 只覆盖新列 + 触发器兜底）
  // 与新建的 v4（完整定义）。v5 一律是完整定义 —— 它的 usage_event 被重建过。
  const partial = legacy && version === BASELINE_VERSION
  const expectedChecks = partial
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
  if (partial) for (const sql of legacySqliteTriggers()) {
    const name = /^CREATE TRIGGER (\w+)/.exec(sql)![1]!
    const row = await store.get<{ sql:string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=$name",{$name:name})
    if (!row || normalizeTrigger(row.sql)!==normalizeTrigger(sql)) throw gate(`历史约束触发器 ${name} 缺失或实际定义不一致。`)
  }
}

/** 迁移写入与 current/resume 核验共用同一份触发器定义。**只服务 v4 基线**。 */
function legacySqliteTriggers(): string[] {
  const ddl = tableStatement('sqlite','usage_event',BASELINE_VERSION)
  const triggers = ['INSERT','UPDATE'].map(event => `CREATE TRIGGER usage_v4_token_${event.toLowerCase()} BEFORE ${event} ON usage_event WHEN NEW.report_token_id IS NOT NULL AND (NEW.member_id IS NULL OR NOT EXISTS (SELECT 1 FROM report_tokens WHERE token_id=NEW.report_token_id AND member_id=NEW.member_id)) BEGIN SELECT RAISE(ABORT,'usage_event token member mismatch'); END`)
  triggers.push("CREATE TRIGGER usage_v4_token_owner_update BEFORE UPDATE OF member_id ON report_tokens WHEN NEW.member_id<>OLD.member_id AND EXISTS (SELECT 1 FROM usage_event WHERE report_token_id=OLD.token_id) BEGIN SELECT RAISE(ABORT,'usage_event historical token owner is immutable'); END")
  const checks = legacyColumns.flatMap(name => {
    const line = ddl.split('\n').find(line => line.startsWith(`  ${name} `))
    return checkExpressions(line ?? '').map(expression=>expression.replace(new RegExp(`\\b(${legacyColumns.join('|')})\\b`,'g'),'NEW.$1'))
  })
  for (const event of ['INSERT','UPDATE']) triggers.push(`CREATE TRIGGER usage_v4_values_${event.toLowerCase()} BEFORE ${event} ON usage_event WHEN NEW.event_id IS NULL OR NOT (${checks.map(check=>`(${check})`).join(' AND ')}) BEGIN SELECT RAISE(ABORT,'usage_event v4 value constraint'); END`)
  return triggers
}
/** usage_event 的实际列目录（两种后端形状归一）。 */
async function eventColumns(store: PortalStore): Promise<{ name: string; type: string; nullable: boolean }[]> {
  return store.kind === 'sqlite'
    ? (await store.all<{ name: string; type: string; notnull: number }>('PRAGMA table_info(usage_event)')).map(row => ({ name:row.name,type:row.type.toLowerCase(),nullable:row.notnull===0 }))
    : (await store.all<{ name: string; type: string; nullable: string }>("SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")).map(row => ({ ...row,nullable:row.nullable==='YES' }))
}

/**
 * 核验一个**完整的 v4 基线库**（v4→v5 的起点）。
 *
 * ⚠️ 它只回答「这个库能不能作为升 v5 的起点」，不是终态校验：
 *   v4 的 `usage_event` 是「v3 原始列 + 只增列」的形态，所以这里允许
 *   新列之外的列保持旧定义，靠触发器兜住复合外键。
 */
async function verifyBaseline(store: PortalStore): Promise<void> {
  const tables = await tablesOf(store)
  for (const sql of portalSchemaStatementsV4(store.kind)) {
    const match = /^CREATE TABLE (\w+) \(/.exec(sql)
    if (!match) continue
    if (!tables.includes(match[1]!)) throw gate(`v4 缺少表 ${match[1]}。`)
    if (match[1] !== 'usage_event') await verifyTable(store, match[1]!, sql)
  }
  const columns = await eventColumns(store)
  if (['member_id','department_id','report_token_id','received_at_ms',...legacyColumns].some(name => !columns.some(row => row.name===name))) throw gate('usage_event 事实列缺失。')
  for (const column of expectedColumns(tableStatement(store.kind,'usage_event',BASELINE_VERSION)).filter(column => !legacyColumns.includes(column.name))) {
    if (!columns.some(row => row.name===column.name && row.type===column.type && row.nullable===column.nullable)) throw gate(`usage_event 新列 ${column.name} 的目录定义不一致。`)
  }
  if (!tables.includes('ingest_run')) throw gate('缺少 ingest_run 诊断表。')
  await requireEventPrimaryKey(store,true)
  if (store.kind === 'mysql') {
    await requireTransactionalTable(store,'usage_event')
    await requireTransactionalTable(store,'ingest_run')
    await verifyMysqlConstraints(store,'usage_event',tableStatement('mysql','usage_event',BASELINE_VERSION))
  } else {
    const migration = await migrationRow(store, tables, BASELINE_VERSION)
    await verifySqliteUsageConstraints(store, migration ? checkpointOf(migration).sourceVersion === 3 : false, BASELINE_VERSION)
  }
}

/**
 * 核验**终态**（当前受控定义 = v5 结构 + v6 追加 + v7 追加）。
 *
 * ★ 与 v4 核验最大的差别：这里**每一张表都按受控定义逐列比对**，
 *   不再有「usage_event 只增列所以跳过」的例外 —— v5 的 usage_event
 *   是被重建过的完整结构。少了这个例外，任何一列的类型漂移都会立刻被发现。
 *
 * ⚠️ SQLite 分支只比对**表定义文本**，不比对索引 —— 所以「迁移少建了一个索引」
 *   在 SQLite 上永远测不出来（`idx_provider_alias_member` 就这么漏了两个版本），
 *   而 MySQL 分支走 `verifyUniqueConstraints` 会当场判失败。
 */
async function verifyCurrent(store: PortalStore, checkHistory = true): Promise<void> {
  const tables = await tablesOf(store)
  for (const sql of portalSchemaStatements(store.kind)) {
    const match = /^CREATE TABLE (\w+) \(/.exec(sql)
    if (!match) continue
    if (!tables.includes(match[1]!)) throw gate(`v${PORTAL_SCHEMA_VERSION} 缺少表 ${match[1]}。`)
    await verifyTable(store, match[1]!, sql)
  }
  const columns = await eventColumns(store)
  if (V5_FACT_COLUMNS.some(name => !columns.some(row => row.name===name))) throw gate('usage_event 事实列缺失。')
  if (!tables.includes('ingest_run')) throw gate('缺少 ingest_run 诊断表。')
  await requireEventPrimaryKey(store,true)
  if (store.kind === 'mysql') {
    await requireTransactionalTable(store,'usage_event')
    await requireTransactionalTable(store,'ingest_run')
    await verifyMysqlConstraints(store,'usage_event',tableStatement('mysql','usage_event'))
  } else {
    await verifySqliteUsageConstraints(store, false)
  }
  // 每条业务连接已启用外键，新增写入由数据库逐行拒绝无效引用。
  // 全历史检查留在启动和显式迁移；每次鉴权都扫一次会让上报随历史积累退化。
  if (checkHistory) await verifyHistoricalReferences(store)
}
async function verifyHistoricalReferences(store: PortalStore): Promise<void> {
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
      // ⚠️ 版本号与 checksum 都取**当前**常量：这里写死数字会让新库一建好
      //   就被自己的版本闸门判成旧库（见 `verifyCurrent` 的逐表核对）。
      db.query(`INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,${PORTAL_SCHEMA_VERSION},$checksum,'completed',1,$checkpoint,$now,$now)`).run({ $id: randomUUID(), $checksum: portalSchemaChecksum('sqlite'), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }), $now: now })
      db.exec(`PRAGMA user_version=${PORTAL_SCHEMA_VERSION}; COMMIT`)
    } catch (error) { try { db.exec('ROLLBACK') } catch { /* 保留原始错误 */ } throw error }
    return
  }
  const migration = tables.includes('portal_schema_migrations') ? db.query<MigrationRow>('SELECT checksum,status FROM portal_schema_migrations WHERE version=$version').get({ $version: PORTAL_SCHEMA_VERSION }) : null
  if (version !== PORTAL_SCHEMA_VERSION || migration?.status !== 'completed' || migration.checksum !== portalSchemaChecksum('sqlite')) throw gate(`上报库 schema 版本 ${version} 不符合当前 v${PORTAL_SCHEMA_VERSION}。`)
  for (const sql of portalSchemaStatements('sqlite')) {
    const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (table && !tables.includes(table)) throw gate(`v${PORTAL_SCHEMA_VERSION} 缺少表 ${table}。`)
  }
}

/** 迁移锁必须跨 MySQL 隐式提交的 DDL 保持在同一条连接。 */
async function withMigrationLock<T>(store: PortalStore, fn: (connection: PortalStore) => Promise<T>): Promise<T> {
  return store.withConnection(async connection => {
    if (store.kind === 'sqlite') return fn(connection)
    const db = await connection.get<{ name: string }>('SELECT DATABASE() AS name')
    // ⚠️ 锁名前缀里的 `v4` 是历史遗留，**刻意不改名**：仍可能有一台机器在跑旧版本，
    //   两边用同一把锁才能在迁移期间真正互斥。改成 `atr-v5-` 会让新旧进程各锁各的。
    const lock = `atr-v4-${createHash('sha256').update(db?.name ?? '').digest('hex').slice(0,40)}`
    const result = await connection.get<{ acquired: number }>('SELECT GET_LOCK($lock,15) AS acquired', { $lock: lock })
    if (Number(result?.acquired) !== 1) throw gate('获取上报库迁移锁超时。')
    try { return await fn(connection) }
    finally { await connection.get('SELECT RELEASE_LOCK($lock)', { $lock: lock }) }
  })
}
export async function ensurePortalReady(store: PortalStore): Promise<void> {
  const initial = await readPortalState(store)
  // 每次都重读真实结构，不缓存版本或约束，因此运行中缺表、篡改 CHECK 和半迁移仍立即拒绝。
  if (initial.status === 'current') { await verifyCurrent(store, false); return }
  if (initial.status !== 'empty' && initial.status !== 'incomplete') throw gate(`上报库状态 ${initial.status}，版本 ${initial.version}。`)
  await withMigrationLock(store, async connection => {
    const state = await readPortalState(connection)
    if (state.status === 'current') return verifyCurrent(connection, false)
    // 若另一进程正在初始化，先等迁移锁再看结果；崩溃遗留仍须显式 resume。
    if (state.status !== 'empty') throw gate(`上报库状态 ${state.status}，请显式恢复。`)
    await executeV5PlanAsync(connection, { sourceVersion: 0, historyHash: '', historyCount: 0 })
  })
}
export async function preparePortalDatabase(target: PortalTarget, options: PortalMigrationOptions & { migrate?: boolean } = {}): Promise<PortalInspection> {
  if (options.migrate) return migratePortalDatabase(target, options)
  const store = await openRawPortalStore(target)
  try {
    await ensurePortalReady(store)
    // 启动时保留历史完整性检查；不可把业务热路径减负变成启动时接受坏库。
    await verifyHistoricalReferences(store)
    return await inspectStore(store)
  } finally { await store.close() }
}

/**
 * 事件指纹：逐页按精确事件键排序，不把全员历史一次性读进内存。
 *
 * ⚠️ `snapshot` 是快照列名，**必须由调用方显式给**：v5 把它从 `dept` 改成了
 *   `group_name`。写死任何一个名字，都会让「迁移前后指纹必须逐位相同」
 *   在另一半迁移里必然失败，而报错文案只会说「原始事件不一致」——
 *   看起来像数据被改了，实际是校验自己写错了列名。
 */
async function historyFingerprint(store: PortalStore, snapshot: 'dept' | 'group_name'): Promise<{ hash: string; count: number }> {
  const columns = snapshot === 'dept' ? legacyColumns : V5_FACT_COLUMNS
  const hash = createHash('sha256')
  let count = 0
  for (;;) {
    const rows = await store.all<Record<string, unknown>>(`SELECT ${columns.join(',')} FROM usage_event ORDER BY ${store.kind === 'mysql' ? 'BINARY event_id' : 'event_id COLLATE BINARY'} LIMIT 1000 OFFSET ${count}`)
    for (const row of rows) hash.update(JSON.stringify(columns.map(name => typeof row[name] === 'bigint' ? String(row[name]) : row[name])) + '\n')
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
/**
 * 显式迁移入口。
 *
 * ★ 一次调用最多推进到 v5，走哪条路由库当前处于哪一版决定（见文件头表格）。
 * ⚠️ **每个版本步骤各自做备份与指纹校验**：v3→v5 会留下两份恢复点
 *   （v3 原库、v4 中间态）。「唯一副本」不允许只有一个回退位。
 */
export async function migratePortalDatabase(target: PortalTarget, options: PortalMigrationOptions = {}): Promise<PortalInspection> {
  const store = await openRawPortalStore(target)
  try {
    await withMigrationLock(store, async connection => {
      const state = await inspectStore(connection)
      if (state.status === 'current') return verifyCurrent(connection)
      if (state.status === 'empty') return executeV5PlanAsync(connection, { sourceVersion: 0, historyHash: '', historyCount: 0 })
      if (state.status !== 'legacy' && state.status !== 'incomplete') throw gate(`不支持迁移版本 ${state.version}。`)
      if (state.status === 'incomplete' && !options.resume) throw gate('发现未完成迁移，必须显式 resume。')

      const baselineRow = await migrationRow(connection, state.tables, BASELINE_VERSION)
      // 🚨 不能只看 `state.version`。v5/v6 的结构已经就位、但账本行被标成
      //   `started`/`failed` 的库（迁移中途崩过之后就是这副样子）版本号已经是 5 或 6，
      //   只按版本判断会得出「v4 基线还没做」，于是重跑 v3→v4 ——
      //   而那时 `dept` 早已改名 `group_name`，`historyFingerprint('dept')` 会抛
      //   「Unknown column 'dept'」，**resume 永久失败**（真实 MySQL 上实测到过）。
      //   只要 **v5 或 v6 的账本行存在**，基线步骤就早已过去了。
      const v5Bookkeeping = state.migration?.version === V5_VERSION || state.tables.includes('provider_alias')
      const baselineReady = v5Bookkeeping || (state.version === BASELINE_VERSION && baselineRow?.status === 'completed' && baselineRow.checksum === portalSchemaChecksumV4(store.kind))
      if (!baselineReady) await migrateToBaseline(connection, target, state, options)
      // 基线到位后升 v5，再依次追加 v6、v7。每一步都自检目标状态，所以 resume 直接重跑即可。
      // 🚨 「要不要补写 v5 账本行」必须**直接查 v5 行在不在**，不能用 `state.migration`：
      //   从 v6/v7 起点重跑时那个字段已经是更高版本的行，按它判断会得出
      //   「库里原本没有 v5 行」→ 补写一条 —— 而老库早就有那一行，
      //   轻则多出一行重复账本，重则直接撞 `version` 的唯一约束，
      //   表现成「一个结构完好、只差一次追加迁移的库永远迁不动」。
      const v5RowPresent = (await migrationRow(connection, state.tables, V5_VERSION)) !== null
      await upgradeV4ToV5(connection, target, options, v5RowPresent)
    })
    return await inspectStore(store)
  } finally { await store.close() }
}

/** v3 → v4 基线：预检 → 备份 → 指纹 → 加列式迁移。 */
async function migrateToBaseline(
  store: PortalStore,
  target: PortalTarget,
  state: PortalInspection,
  options: PortalMigrationOptions,
): Promise<void> {
  const previous = state.migration?.version === BASELINE_VERSION && state.migration.status !== 'completed'
    ? checkpointOf(state.migration)
    : null
  // MySQL CREATE 迁移表会隐式提交；紧接着进程退出时还来不及写第一条检查点。
  if (!previous && state.version === 0) return executeV4Plan(store, { sourceVersion: 0, historyHash: '', historyCount: 0 })
  if ((previous?.sourceVersion ?? 3) === 0) return executeV4Plan(store, previous!)
  if (!options.confirmOffline) throw gate('迁移 v3 前必须明确确认旧服务已停止（--confirm-offline）。')
  await preflight(store)
  const before = await historyFingerprint(store, 'dept')
  // 与 v4→v5 同一口径：没有历史事件的库不需要外部备份证明（见 upgradeV4ToV5 的注释）。
  const backup = store.kind === 'mysql'
    ? (before.count === 0 ? undefined : backupProof(target, options))
    : await sqliteBackup(store, target, options.sqliteBackupPath ?? `${target.sqlitePath}.v3-backup-${Date.now()}.sqlite`, before)
  const checkpoint: Checkpoint = previous ?? { sourceVersion: 3, backup, historyHash: before.hash, historyCount: before.count }
  if (checkpoint.historyHash !== before.hash || checkpoint.historyCount !== before.count) throw gate('迁移恢复时原始事件与检查点不符。')
  if (store.kind === 'sqlite') await store.transaction(async tx => {
    const locked = await historyFingerprint(tx, 'dept')
    if (locked.hash !== before.hash) throw gate('备份后检测到并发写入，请停止旧服务后重试。')
    await executeV4Plan(tx, checkpoint)
  })
  else await executeV4Plan(store, checkpoint)
}

/**
 * 空库初始化：**直接建成 v5**，不走 v4 中间态 —— 没有任何历史要保留，
 * 多一次中间态只会多一份需要维护的 DDL。
 */
async function executeV5PlanAsync(store: PortalStore, checkpoint: Checkpoint): Promise<void> {
  const ledger = tableStatement(store.kind, 'portal_schema_migrations')
  if (!(await tablesOf(store)).includes('portal_schema_migrations')) await store.exec(ledger)
  await verifyTable(store, 'portal_schema_migrations', ledger)
  const run = async (target: PortalStore): Promise<void> => {
    for (const sql of portalSchemaStatements(store.kind)) {
      const table = /^CREATE TABLE (\w+) \(/.exec(sql)?.[1]
      if (table === 'portal_schema_migrations') continue
      if (table) { if (!(await tablesOf(target)).includes(table)) await target.exec(sql) }
      else await target.exec(sql)
    }
    await target.exec(store.kind === 'sqlite' ? PORTAL_SQLITE_INGEST_SQL : PORTAL_MYSQL_INGEST_SQL)
    await target.run('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,$version,$hash,\'completed\',1,$checkpoint,$now,$now)', { $id: randomUUID(), $version: PORTAL_SCHEMA_VERSION, $hash: portalSchemaChecksum(store.kind), $checkpoint: JSON.stringify(checkpoint), $now: Date.now() })
    await markVersion(target, PORTAL_SCHEMA_VERSION)
  }
  if (store.kind === 'sqlite') await store.transaction(run)
  else await run(store)
  await verifyCurrent(store)
}

/** 把「当前 schema 版本」写进各后端自己的位置（SQLite 用 PRAGMA，MySQL 用 portal_meta）。 */
async function markVersion(store: PortalStore, version: number): Promise<void> {
  if (store.kind === 'sqlite') return void await store.exec(`PRAGMA user_version=${version}`)
  await store.exec('CREATE TABLE IF NOT EXISTS portal_meta (id TINYINT NOT NULL PRIMARY KEY,schema_version INT NOT NULL) ENGINE=InnoDB')
  await store.transaction(async tx => {
    if (await tx.get('SELECT id FROM portal_meta WHERE id=1')) await tx.exec(`UPDATE portal_meta SET schema_version=${version} WHERE id=1`)
    else await tx.exec(`INSERT INTO portal_meta (id,schema_version) VALUES (1,${version})`)
  })
}

/** 表的实际列名（两种后端形状归一）。 */
async function tableColumns(store: PortalStore, table: string): Promise<string[]> {
  return store.kind === 'sqlite'
    ? (await store.all<{ name: string }>(`PRAGMA table_info(${table})`)).map(row => row.name)
    : (await store.all<{ name: string }>('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=$table', { $table: table })).map(row => row.name)
}

/**
 * 事实表的快照列此刻叫什么。
 *
 * ★ v5 把 `dept` 改名成了 `group_name`，而迁移可能在中途崩过 ——
 *   所以指纹校验必须**先看真实列名**再决定查哪一列，不能写死。
 */
async function usageSnapshotColumn(store: PortalStore): Promise<'dept' | 'group_name'> {
  const columns = await tableColumns(store, 'usage_event')
  if (columns.includes('group_name')) return 'group_name'
  if (columns.includes('dept')) return 'dept'
  throw gate('usage_event 缺少分组快照列。')
}

/** SQLite 一致性备份（`VACUUM INTO`）+ 指纹清单，与 v3→v4 步骤同款。 */
async function sqliteBackup(store: PortalStore, target: PortalTarget, path: string, fingerprint: { hash: string; count: number }): Promise<Checkpoint['backup']> {
  const resolved = resolve(path)
  if (existsSync(resolved) || resolved === resolve(target.sqlitePath)) throw gate('SQLite 备份路径必须不存在且不同于源库。')
  mkdirSync(dirname(resolved), { recursive: true })
  await store.exec(`VACUUM INTO '${resolved.replace(/'/g, "''")}'`)
  const backup = { path: resolved, sha256: createHash('sha256').update(readFileSync(resolved)).digest('hex') }
  writeFileSync(`${resolved}.manifest.json`, JSON.stringify({ target: describePortalTarget(target), ...backup, historyHash: fingerprint.hash, historyCount: fingerprint.count }, null, 2), { flag: 'wx' })
  return backup
}

/** 按 v5 的受控定义重建一张 SQLite 表（SQLite 不允许 DROP 掉被外键引用的列）。 */
async function rebuildSqliteTable(store: PortalStore, table: string): Promise<void> {
  const ddl = tableStatement('sqlite', table)
  const temporary = `${table}__v5_rebuild`
  const source = new Set(await tableColumns(store, table))
  // 目标列 → 源表达式：只有快照列会跨版本改名，其余同名搬运。
  const pairs = expectedColumns(ddl).map(column => column.name)
    .filter(name => source.has(name) || (name === 'group_name' && source.has('dept')))
    .map(name => (name === 'group_name' && !source.has('group_name') ? 'dept AS group_name' : name))
  if (!pairs.length) throw gate(`重建 ${table} 时没有可搬运的列。`)
  const target = pairs.map(pair => pair.includes(' AS ') ? pair.slice(pair.indexOf(' AS ') + 4) : pair)
  await store.exec(`DROP TABLE IF EXISTS ${temporary}`)
  await store.exec(ddl.replace(`CREATE TABLE ${table} (`, `CREATE TABLE ${temporary} (`))
  await store.exec(`INSERT INTO ${temporary} (${target.join(',')}) SELECT ${pairs.join(',')} FROM ${table}`)
  await store.exec(`DROP TABLE ${table}`)
  await store.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`)
}

/** MySQL：查出一张表上用到某一列的外键约束名（迁移要按真名删，不能猜）。 */
async function mysqlForeignKeys(store: PortalStore, table: string, column: string): Promise<string[]> {
  const rows = await store.all<{ name: string }>(
    'SELECT constraint_name AS name FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name=$table AND column_name=$column AND referenced_table_name IS NOT NULL',
    { $table: table, $column: column })
  return rows.map(row => row.name)
}
async function mysqlIndexExists(store: PortalStore, table: string, name: string): Promise<boolean> {
  const rows = await store.all<{ name: string }>('SELECT index_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND index_name=$name', { $table: table, $name: name })
  return rows.length > 0
}

/** 建齐 v5 的受控索引（已存在的逐列核对，缺失的补建）。 */
async function ensureV5Indexes(store: PortalStore): Promise<void> {
  await ensureControlledIndexes(store, portalSchemaStatements(store.kind))
}

/**
 * v4 → v5 → v6。
 *
 * ## v5 步骤：三件事
 *
 * 表/列改名为「分组」、人员与分组改成多对多、事实表去掉单值分组列。
 *
 * ## v6 步骤：只追加
 *
 * `provider_alias` 表 + 权限码 `providers:*`。事实表一个字节都不动 ——
 * 供应商归一化是**查询时**应用的（见 `provider-alias.ts` 的文件头）。
 *
 * ## v7 步骤：同样只追加
 *
 * `model_price` 表 + 权限码 `cost:read` / `pricing:manage`。事实表同样一个字节都不动 ——
 * 费用是**查询期**用 token 数与生效单价现算的（见 `shared/price.ts`）。
 * 三处「纯追加」的好处是可重入且无需备份证明：没有会被改写的对象。
 *
 * ★ **每一步都自检目标状态**（表/列是否存在），所以重复执行是安全的：
 *   MySQL 的 DDL 会隐式提交，中途崩溃后 resume 必须能接着跑下去，
 *   而不能靠 `last_completed_step` 记住「走到第几步」。
 *
 * 🚨 **已经迁到 v5 的库只走 v6 步骤，不重跑 v5 的表重建。**
 *   判断依据是 `provider_alias` 表在不在（而不是版本号）——
 *   版本号在 v5 库上仍是 5，而 `dept` 早已改名 `group_name`，
 *   重跑 `runV5Sqlite` 会在一个已经是 v5 的库上做无意义的表重建。
 *
 * 🚨 迁移前后的**事件指纹必须逐位相同**，v5 步骤里只是快照列换了名字 ——
 *   这是「没有一条历史用量被改写」的唯一证据。
 */
async function upgradeV4ToV5(store: PortalStore, target: PortalTarget, options: PortalMigrationOptions, v5RowPresent: boolean): Promise<void> {
  const kind = store.kind
  const ledger = tableStatement(kind, 'portal_schema_migrations')
  if (!(await tablesOf(store)).includes('portal_schema_migrations')) await store.exec(ledger)
  await verifyTable(store, 'portal_schema_migrations', ledger)

  const existing = await migrationRow(store, await tablesOf(store), PORTAL_SCHEMA_VERSION)
  if (existing && existing.checksum !== portalSchemaChecksum(kind)) throw gate('未完成迁移的 checksum 与当前程序不同，拒绝跳步。')

  // ★ v5 的结构是否已经就位 —— 判据是**事实表的快照列名**（v5 把 `dept` 改名
  //   `group_name`），而不是「provider_alias 在不在」：后者是 v6 的产物，
  //   在一个 v4 库上完全可以手工建出来（那会让「跳过 v5 重建」被误判为真）。
  const v5Ready = (await tableColumns(store, 'usage_event')).includes('group_name')

  let row = existing
  if (!row) {
    const before = await historyFingerprint(store, await usageSnapshotColumn(store))
    // 🚨 没有历史事件时不要求外部备份证明：备份的意义是「不丢唯一副本里的历史」，
    //   而 `historyCount === 0` 说明这张事实表本来就是空的（全新部署，或 v4 刚由空库建出来）。
    //   对一份没有保护对象的库索要备份证明，只会把「空库初始化」这条最常见的路径卡死 ——
    //   它恰恰是除 `--confirm-offline` 之外不需要任何人工准备的那条路。
    //
    // ⚠️ 库已经是 v5 时**不备份**：v6 只追加一张新表与两行权限，
    //   既有数据一个字节都不动，没有可回退的对象。
    //   对一份不会被改写的库索要备份证明，只会在运维流程里多出一次手工步骤。
    const backup = v5Ready ? undefined : kind === 'mysql'
      ? (before.count === 0 ? undefined : backupProof(target, options))
      : await sqliteBackup(store, target, `${target.sqlitePath}.v4-backup-${Date.now()}.sqlite`, before)
    const checkpoint: Checkpoint = { sourceVersion: v5Ready ? V5_VERSION : BASELINE_VERSION, backup, historyHash: before.hash, historyCount: before.count }
    await store.run('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms) VALUES ($id,$version,$hash,\'started\',0,$checkpoint,$now)', { $id: randomUUID(), $version: PORTAL_SCHEMA_VERSION, $hash: portalSchemaChecksum(kind), $checkpoint: JSON.stringify(checkpoint), $now: Date.now() })
    row = { version: PORTAL_SCHEMA_VERSION, checksum: portalSchemaChecksum(kind), status: 'started', last_completed_step: 0, checkpoint_json: JSON.stringify(checkpoint) }
  }
  const checkpoint = checkpointOf(row)
  const current = await historyFingerprint(store, await usageSnapshotColumn(store))
  // 检查点是空指纹时（全新 v4 库、没有 v3 历史）不比对 —— 那说明本来就没有起点数据。
  if (checkpoint.historyHash && (current.hash !== checkpoint.historyHash || current.count !== checkpoint.historyCount)) {
    throw gate('迁移恢复时原始事件与检查点不符。')
  }

  try {
    // 🚨 **v6 的追加必须早于 v5 的表重建**：`provider_alias.member_id` 有外键
    //   指向 `members`，而 SQLite 在重建 `members`（RENAME → 新建 → 拷贝 → 删旧）
    //   的过程中会重新解析全部引用它的表 —— 那一刻 `provider_alias` 还不存在时，
    //   RENAME 会直接抛 `no such table: main.provider_alias`，
    //   而错误信息完全不提「是 v6 的表还没建」。
    //   先建这张空表没有任何副作用：它此时必然是空的（v6 才引入）。
    await upgradeV5ToV6(store)
    // v7 同样只增表，也不引用 members，所以放在 v5 重建之前或之后都可以。
    // 放在这里是为了让「全部结构追加」集中在重建之前 —— 重建期间
    // `PRAGMA foreign_key_check` 会扫描**所有**表，新表越早到位越好核对。
    await upgradeV6ToV7(store)
    if (!v5Ready) {
      if (kind === 'sqlite') await runV5Sqlite(store)
      else await runV5Mysql(store)
      const after = await historyFingerprint(store, 'group_name')
      if (checkpoint.historyHash && (after.hash !== checkpoint.historyHash || after.count !== checkpoint.historyCount)) {
        throw gate('迁移前后原始事件不一致，拒绝标记完成。')
      }
    }
    const final = await historyFingerprint(store, 'group_name')
    if (checkpoint.historyHash && (final.hash !== checkpoint.historyHash || final.count !== checkpoint.historyCount)) {
      throw gate('迁移前后原始事件不一致，拒绝标记完成。')
    }
    await verifyCurrent(store)
    await store.transaction(async tx => {
      await tx.run('UPDATE portal_schema_migrations SET status=\'completed\',completed_at_ms=$now,last_completed_step=1 WHERE version=$version', { $now: Date.now(), $version: PORTAL_SCHEMA_VERSION })
      // ★ 同时补一条 **v5 账本行**（如果这次是从 v4/v3 走上来的）。
      //   理由不是形式主义：这台机器上可能还有旧版本的服务端进程，
      //   它认的「当前版本」是 5 —— 少了这一行，那个进程会把一个结构完好的库
      //   读成 `incomplete`，直接拒绝启动。多一行历史账本的成本是零。
      //   ⚠️ 已经是 v5 的库（`v5RowPresent`）**不动**它原有的那一行：
      //   账本一经 completed 就不该被改写（它的 checksum 是当时的证据）。
      if (!v5RowPresent) {
        await tx.run('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,$version,$hash,\'completed\',1,$checkpoint,$now,$now)', { $id: randomUUID(), $version: V5_VERSION, $hash: portalSchemaChecksum(kind), $checkpoint: JSON.stringify(checkpoint), $now: Date.now() })
      }
    })
    await markVersion(store, PORTAL_SCHEMA_VERSION)
  } catch (error) {
    try { await store.exec(`UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=${PORTAL_SCHEMA_VERSION}`) } catch { /* 保留最初的迁移失败原因 */ }
    throw error
  }
}

/**
 * v5 → v6：**只追加** `provider_alias` 与权限码 `providers:*`。
 *
 * 三件事，每件都先看目标状态再动手，所以 resume 重跑是安全的：
 * 1. 建 `provider_alias`（SQLite 上没有 `ALTER`，直接 `CREATE TABLE` 就行）；
 * 2. 建它的索引（走通用的 `ensureIndex`，会逐列核对已存在的索引）；
 * 3. 补权限行（`WHERE NOT EXISTS`，幂等）。
 *
 * 🚨 **事实表一个字节都不动**。供应商归一化是查询时应用的：
 *   规则写进这张表，`usage_event.provider` 永远是上报当时的原值。
 *   这也意味着这一步**不需要**再比对一次事件指纹去证明「没改数据」——
 *   v5 步骤已经比对过，而这里根本没有会改数据的语句。
 */
async function upgradeV5ToV6(store: PortalStore): Promise<void> {
  const table = portalV6TableStatement(store.kind, 'provider_alias')
  if (!(await tablesOf(store)).includes('provider_alias')) await store.exec(table)
  await verifyTable(store, 'provider_alias', table)
  // ⚠️ 必须用 `ensureControlledIndexes()`（它认 `CREATE UNIQUE INDEX`）。
  //   早先这里写的是 `sql.startsWith('CREATE INDEX')`，于是
  //   `idx_provider_alias_member` 从来没被建出来过 —— 见 `isCreateIndex()` 的注释。
  await ensureControlledIndexes(store, portalV6Statements(store.kind))
  for (const sql of portalV6Statements(store.kind)) {
    if (sql.startsWith('INSERT')) await store.exec(sql)
  }
}

/**
 * v6 → v7：**只追加** `model_price` 与权限码 `cost:read` / `pricing:manage`。
 *
 * 与 v5→v6 完全同构，因此同样安全：
 * 1. 建 `model_price`（先看目标状态，幂等）；
 * 2. 建它的索引（含**唯一**索引 `idx_model_price_span`，走 `ensureControlledIndexes`）；
 * 3. 补权限行（`WHERE NOT EXISTS`，幂等）。
 *
 * 🚨 **事实表一个字节都不动**，所以这一步**不需要**再比对一次事件指纹。
 *   「费用」是查询期用 token 数与单价现算的，库里的历史用量从不因计价而改写 ——
 *   改单价、补历史价都不会动 `usage_event`（这正是「绝不存金额」的收益）。
 *
 * ⚠️ **这一步不要求备份证明**：`upgradeV4ToV5` 里 `v5Ready` 为真时
 *   （v6 库必然是这种情况）本就不做备份 —— 没有会被改写的对象，
 *   索要备份只会在运维流程里多一次手工步骤。真正的回退位是「删掉这张表」。
 */
async function upgradeV6ToV7(store: PortalStore): Promise<void> {
  const table = portalV7TableStatement(store.kind, 'model_price')
  if (!(await tablesOf(store)).includes('model_price')) await store.exec(table)
  await verifyTable(store, 'model_price', table)
  await ensureControlledIndexes(store, portalV7Statements(store.kind))
  for (const sql of portalV7Statements(store.kind)) {
    if (sql.startsWith('INSERT')) await store.exec(sql)
  }
}

/**
 * SQLite 的 v5 升级。
 *
 * 🚨 必须**关掉 `foreign_keys` 再开事务**：该 PRAGMA 在事务内是空操作，
 *   而 `DROP TABLE members/usage_event` 在有外键指向它们时会被拒。
 *   重建期间的一致性由事务内的 `PRAGMA foreign_key_check` 兜住 ——
 *   关掉外键不等于放弃校验。
 */
async function runV5Sqlite(store: PortalStore): Promise<void> {
  await store.exec('PRAGMA foreign_keys=OFF')
  await store.exec('BEGIN IMMEDIATE')
  try {
    // 🚨 先清掉 v4 的全部补偿触发器。
    //   v3→v4 是「只增列」，所以复合外键只能靠触发器模拟，其中一部分
    //   **建在 report_tokens 等别的表上、body 里引用 usage_event**。
    //   重建事实表时会短暂出现「表不存在」的窗口，而 SQLite 在
    //   `ALTER TABLE ... RENAME` 时会重新分析这些触发器并直接报
    //   `no such table: main.usage_event`。
    //   v5 的重建表带真正的复合外键，不再需要任何触发器 —— 所以全部删掉，
    //   而不是只删挂在 usage_event 上的那几个。
    for (const trigger of await store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger'")) {
      await store.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`)
    }
    if ((await tablesOf(store)).includes('departments')) await store.exec('ALTER TABLE departments RENAME TO member_groups')
    if ((await tableColumns(store, 'member_groups')).includes('department_id')) {
      await store.exec('ALTER TABLE member_groups RENAME COLUMN department_id TO group_id')
    }
    if (!(await tablesOf(store)).includes('member_group_assignments')) {
      await store.exec(tableStatement('sqlite', 'member_group_assignments'))
    }
    const memberColumns = await tableColumns(store, 'members')
    if (memberColumns.includes('department_id')) {
      await store.exec('INSERT OR IGNORE INTO member_group_assignments (member_id,group_id,created_at_ms) SELECT member_id,department_id,updated_at_ms FROM members WHERE department_id IS NOT NULL')
      await rebuildSqliteTable(store, 'members')
    }
    const eventColumns = await tableColumns(store, 'usage_event')
    if (eventColumns.includes('department_id') || eventColumns.includes('dept')) {
      await rebuildSqliteTable(store, 'usage_event')
    }
    await ensureV5Indexes(store)
    await retitlePermissions(store)
    const broken = await store.all<{ table: string }>('PRAGMA foreign_key_check')
    if (broken.length) throw gate(`迁移后发现 ${broken.length} 处外键不一致，已回滚。`)
    await store.exec('COMMIT')
  } catch (error) {
    try { await store.exec('ROLLBACK') } catch { /* 保留最初的失败原因 */ }
    throw error
  } finally {
    // 无论成败都恢复外键强制：留着 OFF 会让后续所有写入静默失去引用完整性。
    await store.exec('PRAGMA foreign_keys=ON')
  }
}

/** MySQL 的 v5 升级：常规 RENAME / DROP，DDL 隐式提交，靠每步自检做到可重入。 */
/**
 * 🚨 MySQL 8.0.16+ 的一条隐形墙：`DROP COLUMN` / `RENAME COLUMN` 会被**引用该列的 CHECK 约束**挡住
 *   （errno 3959：`Check constraint 'x' uses column 'y', hence column cannot be dropped or renamed`）。
 *
 *   SQLite **不会**这样 —— 它会连同 CHECK 表达式一起改写列名，所以这个坑在 SQLite 分支上
 *   永远测不出来，只有活体 MySQL 才会暴露（v5 的第一版就是这么挂的，报错发生在
 *   `ALTER TABLE member_groups RENAME COLUMN department_id TO group_id`）。
 *
 *   处理办法：动列之前先把引用该列的 CHECK 摘下来，改完再装回去 ——
 *   列名被改的按新列名重装，列被彻底删掉的就不再装回（v5 里没有那一列，
 *   留着它反而会让受控定义校验失败）。
 *   表达式取自 `information_schema.check_constraints.CHECK_CLAUSE`（数据库里的真实文本），
 *   既不去猜也不从 DDL 正则里抠 —— 内联 CHECK 的约束名是 MySQL 自己生成的
 *   （`member_groups_chk_1` 这种），硬编码必然写错。
 */
async function mysqlChecksUsing(store: PortalStore, table: string, column: string): Promise<{ name: string; clause: string }[]> {
  const rows = await store.all<{ name: string; clause: string }>(
    "SELECT c.constraint_name AS name,c.check_clause AS clause FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.table_name=$table AND t.constraint_type='CHECK'",
    { $table: table })
  // 按词边界匹配列名：`dept` 不能命中 `department_id`，否则会误摘掉无关约束。
  const needle = new RegExp(`(^|[^0-9A-Za-z_])${column}([^0-9A-Za-z_]|$)`, 'i')
  // ⚠️ `CHECK_CLAUSE` 里字符串定界符是**反斜线转义**的（`\'...\'`），必须还原成 `'...'`，
  //   否则拼回 `ADD CONSTRAINT ... CHECK (...)` 会直接语法错误（errno 1064）。
  //   这与 `verifyMysqlConstraints()` 读同一列时的处理必须一致 —— 两处一旦不一致，
  //   就会变成「装回去的定义与受控定义对不上」。
  return rows.filter(row => needle.test(row.clause)).map(row => ({ name: row.name, clause: row.clause.replace(/\\'/g, "'") }))
}
async function mysqlDetachChecks(store: PortalStore, table: string, column: string): Promise<{ name: string; clause: string }[]> {
  const checks = await mysqlChecksUsing(store, table, column)
  for (const check of checks) await store.exec(`ALTER TABLE \`${table}\` DROP CHECK \`${check.name}\``)
  return checks
}
async function mysqlReattachChecks(store: PortalStore, table: string, checks: { name: string; clause: string }[], rename?: readonly [string, string]): Promise<void> {
  for (const check of checks) {
    // CHECK_CLAUSE 里的列引用可能带反引号；`\b` 在反引号两侧同样成立，所以一次替换就够。
    const clause = rename ? check.clause.replace(new RegExp(`\\b${rename[0]}\\b`, 'g'), rename[1]) : check.clause
    await store.exec(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${clause})`)
  }
}

/**
 * 把 MySQL 的 `usage_event` 列定义逐列对齐到 v5 受控定义。
 *
 * 🚨 为什么非有不可：v3 事实表的列类型与 v5 受控定义**不一定相同**
 *   （活体实测：v3 的 `dept` 是 `TEXT`，v5 的 `group_name` 是 `VARCHAR(255)`），
 *   而 MySQL 的 `RENAME COLUMN` **只改名字、不改类型**，`DROP COLUMN` 也只是少一列 ——
 *   于是一路 ALTER 走下来，真实表的列定义与受控 DDL 对不上，
 *   `verifyCurrent` 会在最后一步拒绝标记完成（迁移做完了却不算成功）。
 *   SQLite 分支没有这个问题，因为它在 v5 里**重建**了事实表。
 *   这里用逐列 `MODIFY COLUMN` 达到同样的终态，好处是不搬数据（列的语义没变，只是类型对齐）。
 */
async function alignMysqlEventColumns(store: PortalStore): Promise<void> {
  const ddl = tableStatement('mysql', 'usage_event')
  const expected = expectedColumns(ddl)
  const actual = await store.all<{ name: string; type: string; nullable: string }>('SELECT column_name AS name,column_type AS type,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=\'usage_event\'')
  if (actual.length !== expected.length) throw gate(`v5 迁移后 usage_event 有 ${actual.length} 列，受控定义是 ${expected.length} 列。`)
  for (const column of expected) {
    const row = actual.find(entry => entry.name === column.name)
    if (!row) throw gate(`v5 迁移后 usage_event 缺少列 ${column.name}。`)
    if (row.type === column.type && (row.nullable === 'YES') === column.nullable) continue
    // ⚠️ 必须剥掉行尾的内联 CHECK：`MODIFY COLUMN … CHECK (…)` 是**新增**一个 CHECK 约束，
    //   并不会替换原有那条 —— 结果是同一条件出现两份，受控定义校验随即失败。
    const declaration = ddl.split('\n').find(line => line.startsWith(`  ${column.name} `))!.trim().replace(/\s+CHECK\s*\(.*$/i, '').replace(/,$/, '')
    await store.exec(`ALTER TABLE usage_event MODIFY COLUMN ${declaration}`)
  }
}

async function runV5Mysql(store: PortalStore): Promise<void> {
  const tables = await tablesOf(store)
  if (tables.includes('departments')) await store.exec('ALTER TABLE departments RENAME TO member_groups')
  if ((await tableColumns(store, 'member_groups')).includes('department_id')) {
    const checks = await mysqlDetachChecks(store, 'member_groups', 'department_id')
    await store.exec('ALTER TABLE member_groups RENAME COLUMN department_id TO group_id')
    await mysqlReattachChecks(store, 'member_groups', checks, ['department_id', 'group_id'])
  }
  if (!(await tablesOf(store)).includes('member_group_assignments')) {
    await store.exec(tableStatement('mysql', 'member_group_assignments'))
  }
  if ((await tableColumns(store, 'members')).includes('department_id')) {
    await store.exec('INSERT IGNORE INTO member_group_assignments (member_id,group_id,created_at_ms) SELECT member_id,department_id,updated_at_ms FROM members WHERE department_id IS NOT NULL')
    for (const name of await mysqlForeignKeys(store, 'members', 'department_id')) await store.exec(`ALTER TABLE members DROP FOREIGN KEY ${name}`)
    if (await mysqlIndexExists(store, 'members', 'idx_members_department')) await store.exec('DROP INDEX idx_members_department ON members')
    // 这一列在 v5 里被彻底删掉：引用它的 CHECK 只摘不装。
    await mysqlDetachChecks(store, 'members', 'department_id')
    await store.exec('ALTER TABLE members DROP COLUMN department_id')
  }
  const eventColumns = await tableColumns(store, 'usage_event')
  if (eventColumns.includes('dept')) {
    const checks = await mysqlDetachChecks(store, 'usage_event', 'dept')
    await store.exec('ALTER TABLE usage_event RENAME COLUMN dept TO group_name')
    await mysqlReattachChecks(store, 'usage_event', checks, ['dept', 'group_name'])
  }
  if (eventColumns.includes('department_id')) {
    for (const name of await mysqlForeignKeys(store, 'usage_event', 'department_id')) await store.exec(`ALTER TABLE usage_event DROP FOREIGN KEY ${name}`)
    if (await mysqlIndexExists(store, 'usage_event', 'idx_usage_event_department_ts')) await store.exec('DROP INDEX idx_usage_event_department_ts ON usage_event')
    await mysqlDetachChecks(store, 'usage_event', 'department_id')
    await store.exec('ALTER TABLE usage_event DROP COLUMN department_id')
  }
  await alignMysqlEventColumns(store)
  await ensureV5Indexes(store)
  await retitlePermissions(store)
}

/**
 * 权限码改名：`departments:read|manage` → `groups:read|manage`。
 *
 * ★ 只改 `permissions.code`，**权限 ID 与角色关联一律不动** ——
 *   已签发令牌的 scopes、角色授权都指向 `permission_id`，
 *   重建权限行会让「谁有什么权限」静默清空。
 */
async function retitlePermissions(store: PortalStore): Promise<void> {
  for (const [from, to] of [['departments:read', 'groups:read'], ['departments:manage', 'groups:manage']]) {
    await store.run('UPDATE permissions SET code=$to,description=$to WHERE code=$from', { $from: from, $to: to })
  }
}

/**
 * v3 → v4 基线的加列式迁移（也用于「v0 半初始化」的补建）。
 *
 * ⚠️ 它**只服务 v4 基线**：这里的所有 DDL 与 checksum 都取自冻结基线文件。
 *   升 v5 是另一条独立路径（`upgradeV4ToV5`），因为 v5 要重建事实表，
 *   与「只增列」的步骤模型根本不同。
 */
async function executeV4Plan(store: PortalStore, checkpoint: Checkpoint): Promise<void> {
  const ledger = tableStatement(store.kind, 'portal_schema_migrations', BASELINE_VERSION)
  if (!(await tablesOf(store)).includes('portal_schema_migrations')) await store.exec(ledger)
  await verifyTable(store, 'portal_schema_migrations', ledger)
  let row = await store.get<MigrationRow>('SELECT * FROM portal_schema_migrations WHERE version=4')
  if (!row) {
    await store.run('INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms) VALUES ($id,4,$hash,\'started\',0,$checkpoint,$now)', { $id: randomUUID(), $hash: portalSchemaChecksumV4(store.kind), $checkpoint: JSON.stringify(checkpoint), $now: Date.now() })
    row = { version: 4, checksum: portalSchemaChecksumV4(store.kind), status: 'started', last_completed_step: 0, checkpoint_json: JSON.stringify(checkpoint) }
  }
  const steps: (() => Promise<void>)[] = []
  let verifyingCompletedStep = false
  const seed: string[] = []
  for (const sql of portalSchemaStatementsV4(store.kind)) {
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
  steps.push(async () => { await store.exec(store.kind === 'sqlite' ? PORTAL_SQLITE_V4_INGEST_SQL : PORTAL_MYSQL_V4_INGEST_SQL) })
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
      const after = await historyFingerprint(store, 'dept')
      if (after.hash !== checkpoint.historyHash || after.count !== checkpoint.historyCount) throw gate('迁移前后原始事件不一致，拒绝标记完成。')
      await store.transaction(async tx => {
        const users = await tx.all<{ user_id: string }>('SELECT DISTINCT user_id FROM usage_event WHERE user_id IS NOT NULL')
        for (const user of users) {
          if (await tx.get('SELECT mapping_id FROM legacy_attribution_map WHERE legacy_user_id=$key', { $key: user.user_id })) continue
          await tx.run('INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,source_import_ref,created_at_ms) VALUES ($id,$key,\'portal-v3-v4\',$now)', { $id: randomUUID(), $key: user.user_id, $now: Date.now() })
        }
      })
    }
    // ⚠️ 这里只能核验 **v4 基线**，不能调 verifyCurrent ——
    //   本步骤的产出就是 v4，而 v5 的表（member_groups 等）此刻还不该存在。
    //   写成终态校验会让每一次 v3→v4 都必然失败。
    await verifyBaseline(store)
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

/**
 * 受控 DDL 里的建索引语句 —— **含 `CREATE UNIQUE INDEX`**。
 *
 * 🚨 早先这里与 `ensureIndex()` 都只认 `CREATE INDEX`，于是
 *   `provider_alias` 的 `CREATE UNIQUE INDEX idx_provider_alias_member`
 *   在**任何迁移路径里都没被执行过**（只有全新库的建库路径会整条 `exec`）。
 *   后果是「迁移出来的库」与「新建的库」在同一个版本号下**索引集不同**：
 *   实测 SQLite 侧完全看不出来（`verifyCurrent` 对 SQLite 只比对表定义文本，
 *   不比对索引），而 MySQL 侧会在最后一步 `verifyCurrent` 判
 *   「表 provider_alias 的唯一约束与主键不一致」—— 迁移做完了却不算成功。
 *   这正是「SQLite 上测过了不构成证据」那条的又一个实例。
 */
function isCreateIndex(sql: string): boolean {
  return /^CREATE (?:UNIQUE )?INDEX /.test(sql)
}

/** 建齐受控索引（已存在的逐列核对，缺失的补建）。 */
async function ensureControlledIndexes(store: PortalStore, statements: string[]): Promise<void> {
  for (const sql of statements) {
    if (isCreateIndex(sql)) await ensureIndex(store, sql, true)
  }
}

async function ensureIndex(store: PortalStore, sql: string, createMissing = true): Promise<void> {
  const match = /^CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+) \(([^)]+)\)/.exec(sql)
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
  const ddl = tableStatement(store.kind, 'usage_event', BASELINE_VERSION)
  if (verifyOnly) {
    if (store.kind === 'sqlite') await verifySqliteUsageConstraints(store,true,BASELINE_VERSION)
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
    await verifySqliteUsageConstraints(store,true,BASELINE_VERSION)
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
