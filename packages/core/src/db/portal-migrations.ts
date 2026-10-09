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
import { PORTAL_SCHEMA_VERSION, PORTAL_SQLITE_INGEST_SQL, PORTAL_MYSQL_INGEST_SQL, portalSchemaChecksum, portalSchemaChecksumV6, portalSchemaChecksumV7, portalSchemaChecksumV8, portalSchemaChecksumV9, portalSchemaChecksumV10, portalSchemaChecksumV11, portalSchemaChecksumV12, portalSchemaChecksumV13, portalSchemaChecksumV14, portalSchemaStatements, portalV6Statements, portalV6TableStatement, portalV7Statements, portalV7TableStatement, portalV8Statements, portalV8TableStatement, PORTAL_V8_TABLES, PORTAL_SOURCE_COLUMN, portalV9AddColumnStatement, portalV10AddColumnStatements, PORTAL_OFFPEAK_SCHEDULE_COLUMN, portalV11Statements, portalV11TableStatement, portalV13Statements, portalSourceIndex, PORTAL_SOURCE_INDEX, PORTAL_SOURCE_INDEX_COLUMNS, PROJECT_ALIAS_TABLE, portalV12AddColumnStatement, portalV12ReplaceProviderAliasIndex, portalProviderAliasTemporaryIndex, portalProviderAliasUniqueIndex, PORTAL_MODEL_COLUMN, PORTAL_PROVIDER_ALIAS_TEMP_INDEX, PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS, PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX } from './portal-schema-v5.js'
import { PORTAL_SQLITE_V4_INGEST_SQL, PORTAL_MYSQL_V4_INGEST_SQL, portalSchemaChecksumV4, portalSchemaStatementsV4 } from './portal-schema-v4.js'
import { portalV15TableStatements, portalV15TriggerStatements, CUBE_TRIGGER_NAMES, CUBE_HOUR_INDEX, cubeHourIndexSql, cubeHourSql } from './portal-schema-v15.js'
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
 * 而 `PORTAL_SCHEMA_VERSION` 已经是 8。
 */
const V5_VERSION = 5
/**
 * v6 的**结构**版本号。与 v5 同理：v7 的账本行是当前版本，
 * 而 v6 行必须能被认出来 —— 那是「这个库是完整的上一版、可以原地升 v7」的证据。
 */
const V6_VERSION = 6
/**
 * v7 的**结构**版本号（= v5 + provider_alias + model_price）。
 *
 * ★ 线上库就是这一版，所以这一行必须存在，否则它会被判成 `unsupported`
 *   （服务端拒绝启动），而 v8 只是纯追加、一条语句就能升上去。
 */
const V7_VERSION = 7
/**
 * v8 的**结构**版本号（= v7 + 三张看板汇总表）。
 *
 * ★ 与 v7 同理：v9 的账本行是当前版本，而 v8 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v9」的证据。
 *   少了这一行，已经迁到 v8 的库会变成 `unsupported`（服务端拒绝启动），
 *   而 v9 只是给事实表补一列、一条 ALTER 就能升上去。
 */
const V8_VERSION = 8
/**
 * v9 的**结构**版本号（= v8 + `usage_event.source`）。
 *
 * ★ 与 v7 / v8 同理：v10 的账本行是当前版本，而 v9 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v10」的证据。
 *   少了这一行，已经迁到 v9 的库（本机快照库就是、线上库升级后也是）
 *   会变成 `unsupported`（服务端拒绝启动），而 v10 只是给 `model_price`
 *   补五列、五条 ALTER 就能升上去。
 */
const V9_VERSION = 9
/**
 * v10 的**结构**版本号（= v9 + `model_price` 的闲时五列）。
 *
 * ★ 与 v7 / v8 / v9 同理：v11 的账本行是当前版本，而 v10 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v11」的证据。
 *   少了这一行，已经迁到 v10 的库（本机快照库就是、线上库升级后也是）
 *   会变成 `unsupported`（服务端拒绝启动），而 v11 只是纯追加一张规则表、
 *   一条语句就能升上去。
 */
const V10_VERSION = 10
/**
 * v11 的**结构**版本号（= v10 + `project_alias`）。
 *
 * ★ 与 v7~v10 同理：v12 的账本行是当前版本，而 v11 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v12」的证据。
 *   少了这一行，已经迁到 v11 的库会变成 `unsupported`（服务端拒绝启动），
 *   而 v12 只是给 `provider_alias` 加一列 + 换一次唯一索引就能升上去。
 */
const V11_VERSION = 11
/**
 * v12 的**结构**版本号（= v11 + `provider_alias.model` 与三列唯一索引）。
 *
 * ★ 与 v7~v11 同理：v13 的账本行是当前版本，而 v12 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v13」的证据。
 *   少了这一行，已经迁到 v12 的库会变成 `unsupported`（服务端拒绝启动），
 *   而 v13 **连 DDL 都没有**（只是把 `cost:read` 授给内置 `member` 角色，
 *   好让普通成员签得出 appKey）—— 一条权限关系而已，却被判成不可迁移。
 */
const V12_VERSION = 12
/**
 * v13 的**结构**版本号（= v12，因为 v13 没有任何 DDL）。
 *
 * ★ 与 v7~v12 同理：v14 的账本行是当前版本，而 v13 行必须能被认出来 ——
 *   那是「这个库是完整的上一版、可以原地升 v14」的证据。
 *   少了这一行，已经迁到 v13 的库（**线上库升级后的形态**）会变成 `unsupported`
 *   （服务端拒绝启动），而 v14 只是一个索引。
 */
const V13_VERSION = 13
const V14_VERSION = 14
/**
 * ★ 闸门需要逐个判定的**全部**账本版本（v4 基线 + v5~v13 过渡 + v14 当前）。
 *
 * ⚠️ 升 v15 时**必须**把 v14 加进来，否则「v14 库升不上去」：
 *   漏一个版本的表现不是报错，而是那个版本被静默判成 `unsupported`
 *   —— 服务端拒绝启动，而错误文案说的是「状态 unsupported」，不说是谁漏了。
 *   与其靠人记得改这里，不如让测试对着版本号范围断言（见 `portal-v14.test.ts`）。
 */
const LEDGER_VERSIONS: readonly number[] = [BASELINE_VERSION, V5_VERSION, V6_VERSION, V7_VERSION, V8_VERSION, V9_VERSION, V10_VERSION, V11_VERSION, V12_VERSION, V13_VERSION, V14_VERSION, PORTAL_SCHEMA_VERSION]
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
/**
 * ★ 一次性读回**全部**版本账本行（v4~v12 一次查完），替代逐版本 `migrationRow()`。
 *
 * ## 为什么可以这样改（语义不变）
 *
 * 原来 `readPortalState()` 为了判「这一版账本在不在、checksum 对不对」，
 * 逐个版本各发一条 `SELECT ... WHERE version=$v`，**9 个版本就是 9 次往返**。
 * 但这些行全都来自**同一张只有十几行的小表**，一次 `IN` 查询拿回的就是同一份事实 ——
 * 改动只影响「怎么取」，不影响「比什么」。
 *
 * 线上实测（MySQL 8，`117.72.173.21`）：逐版本 9 次 **138ms**，
 * 一次 IN 查 **16ms**；**往返 9→1**。这条在业务热路径上每个 API 请求都要付一次。
 *
 * ⚠️ 刻意**不缓存**这张表：闸门的存在理由就是「运行中改结构立刻拒绝」
 *   （见 `ensurePortalReady` 的 🚨），缓存会让它在一个 TTL 窗口内被放行。
 *   这里的收益来自「少发语句」，不是「少读数据」。
 */
async function migrationLedger(store: PortalStore, tables: string[]): Promise<Map<number, MigrationRow>> {
  if (!tables.includes('portal_schema_migrations')) return new Map()
  // ⚠️ 占位符名**必须以字母或下划线开头**（`$v4` 而不是 `$4`）。
  //   `mysql.ts` 的翻译正则是 `\$([A-Za-z_][A-Za-z0-9_]*)` —— `$1` 这类位置写法
  //   在 SQLite 上正常、在 MySQL 上原样送进服务端，报 **`Unknown column '$1' in
  //   'where clause'`**。而这类分叉只有真 MySQL 才暴露（SQLite 全绿）。
  //   同一个 `$name` 出现多次时驱动会各补一个值，这里每个版本只出现一次。
  const params: Record<string, unknown> = {}
  const placeholders = LEDGER_VERSIONS.map((version, index) => {
    const name = `$ledger${index}`
    params[name] = version
    return name
  })
  const rows = await store.all<MigrationRow>(
    `SELECT version,checksum,status,last_completed_step,checkpoint_json FROM portal_schema_migrations
     WHERE version IN (${placeholders.join(',')})`,
    params,
  )
  const ledger = new Map<number, MigrationRow>()
  for (const row of rows) ledger.set(Number(row.version), row)
  return ledger
}
async function readPortalState(store: PortalStore): Promise<Omit<PortalInspection, 'eventCount'>> {
  const tables = await tablesOf(store)
  const version = store.kind === 'sqlite'
    ? Number((await store.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0)
    : tables.includes('portal_meta') ? Number((await store.get<{ schema_version: number }>('SELECT schema_version FROM portal_meta WHERE id=1'))?.schema_version ?? 0) : 0
  // ★ 一次读完全部版本账本，而不是逐版本各查一次（见 `migrationLedger` 的注释）。
  const ledger = await migrationLedger(store, tables)
  const rowOf = (v: number): MigrationRow | null => ledger.get(v) ?? null
  const current = rowOf(PORTAL_SCHEMA_VERSION)
  const baseline = rowOf(BASELINE_VERSION)
  /**
   * v5 账本行是否存在且完整。
   *
   * 🚨 判定「v4 基线是否就绪」**不能看 `state.version`**：v6 的 DDL 是在 v5
   *   之上追加的，所以一个已经迁到 v5 的库版本号是 5、`dept` 早已改名
   *   `group_name`。若按版本号判断，会得出「基线还没做」→ 重跑 v3→v4 →
   *   `historyFingerprint('dept')` 抛 `Unknown column 'dept'`，此后每次 resume
   *   都失败。v5 账本行一旦存在，基线步骤就早已过去。
   */
  const v5Row = rowOf(V5_VERSION)
  const v6Row = rowOf(V6_VERSION)
  const v7Row = rowOf(V7_VERSION)
  const v8Row = rowOf(V8_VERSION)
  const v9Row = rowOf(V9_VERSION)
  const v10Row = rowOf(V10_VERSION)
  const v11Row = rowOf(V11_VERSION)
  const v12Row = rowOf(V12_VERSION)
  const v13Row = rowOf(V13_VERSION)
  const v14Row = rowOf(V14_VERSION)
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
  // ★ v7：结构 = v5 + provider_alias + model_price，但受控 DDL 已经追加了汇总表。
  //   与 v6 同理，额外比对**冻结的 v7 摘要**：只有「确实是本程序发布出去的那一版 v7」
  //   才放行。少了它，一个被手工改过结构的 v7 库会冒充成「只差一次追加迁移」，
  //   而 v8 是纯追加 —— 它会一路升上去、把手工改动留在库里，且没有任何一步会报错。
  //   ⚠️ 线上库正是 v7，这一条决定它能不能启动。
  else if (version === V7_VERSION && v7Row?.status === 'completed' && v7Row.checksum === portalSchemaChecksumV7(store.kind) && !current) status = 'legacy'
  // ★ v8：结构 = v7 + 三张汇总表，但受控 DDL 已经追加了 `usage_event.source`。
  //   与 v6 / v7 同理，额外比对**冻结的 v8 摘要**：只有「确实是本程序发布出去的那一版 v8」
  //   才放行。少了它，一个被手工改过结构的 v8 库会冒充成「只差一次追加迁移」，
  //   而 v9 会给它补上 source 列 —— 手工改动会被一路带上去，且没有任何一步报错。
  else if (version === V8_VERSION && v8Row?.status === 'completed' && v8Row.checksum === portalSchemaChecksumV8(store.kind) && !current) status = 'legacy'
  // ★ v9：结构 = v8 + `usage_event.source`，但受控 DDL 已经给 `model_price`
  //   补了闲时五列。与 v6 / v7 / v8 同理，额外比对**冻结的 v9 摘要**：
  //   只有「确实是本程序发布出去的那一版 v9」才放行。少了它，一个被手工改过结构的
  //   v9 库会冒充成「只差一次追加迁移」，而 v10 会给它补五列 ——
  //   手工改动会被一路带上去，且没有任何一步报错。
  else if (version === V9_VERSION && v9Row?.status === 'completed' && v9Row.checksum === portalSchemaChecksumV9(store.kind) && !current) status = 'legacy'
  // ★ v10：结构 = v9 + `model_price` 的闲时五列，但受控 DDL 已经追加了
  //   `project_alias`。与 v6~v9 同理，额外比对**冻结的 v10 摘要**：
  //   只有「确实是本程序发布出去的那一版 v10」才放行。少了它，一个被手工改过结构的
  //   v10 库会冒充成「只差一次追加迁移」，而 v11 是纯追加 ——
  //   手工改动会被一路带上去，且没有任何一步报错。
  else if (version === V10_VERSION && v10Row?.status === 'completed' && v10Row.checksum === portalSchemaChecksumV10(store.kind) && !current) status = 'legacy'
  // ★ v11：结构 = v10 + `project_alias`，但受控 DDL 已经给 `provider_alias`
  //   补了 `model` 列**并换掉了它的唯一索引**。与 v6~v10 同理，额外比对
  //   **冻结的 v11 摘要**：只有「确实是本程序发布出去的那一版 v11」才放行。
  //   少了它，一个被手工改过结构的 v11 库会冒充成「只差一次追加迁移」，
  //   而 v12 会给它加列换索引 —— 手工改动会被一路带上去，且没有任何一步报错。
  else if (version === V11_VERSION && v11Row?.status === 'completed' && v11Row.checksum === portalSchemaChecksumV11(store.kind) && !current) status = 'legacy'
  // ★ v12：结构 = v11 + `provider_alias.model` 与三列唯一索引。额外比对**冻结的 v12 摘要**，
  //   理由与 v6~v11 完全一致（手工改过结构的库不许冒充「只差一次追加迁移」）。
  //   而 v13 是**纯权限版本**（无 DDL），所以 v12 库正是「结构完整、可原地升 v13」的起点。
  else if (version === V12_VERSION && v12Row?.status === 'completed' && v12Row.checksum === portalSchemaChecksumV12(store.kind) && !current) status = 'legacy'
  // ★ v13：结构 = v12（v13 没有任何 DDL），但受控 DDL 已经追加了
  //   `idx_usage_event_source`。额外比对**冻结的 v13 摘要** ——
  //   ⚠️ 它与 `portalSchemaChecksumV12()` 逐字相同（纯权限版本不留痕），
  //     所以这一条**看起来**与上面那条同形，但它们判的是**不同的版本号**，
  //     少一条就会让 v13 库（线上库升级后的形态）变成 unsupported。
  else if (version === V13_VERSION && v13Row?.status === 'completed' && v13Row.checksum === portalSchemaChecksumV13(store.kind) && !current) status = 'legacy'
  else if (version === V14_VERSION && v14Row?.status === 'completed' && v14Row.checksum === portalSchemaChecksumV14(store.kind) && !current) status = 'legacy'
  // v5/v6/v7/v8/v9/v10/v11/v12 账本存在但 checksum 不符（程序换了 SQL 或库被改过）会落到 'unsupported'，绝不冒充 current。
  return { kind: store.kind, label: store.label, version, status, tables, migration: current ?? v14Row ?? v13Row ?? v12Row ?? v11Row ?? v10Row ?? v9Row ?? v8Row ?? v7Row ?? v6Row ?? v5Row ?? baseline }
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
  // ★ MySQL 走**批量目录核对**（一次读全库目录，再在 JS 侧和受控定义逐表比对）。
  //   语义与下面的逐表 SQLite 分支**逐条相同**（见 `verifyCurrentMysql` 的注释），
  //   但语句数从「每张表 2~6 条」降到「整个库 5 条」——
  //   实测 19 张表从 116 条降到 5 条，闸门从 55~85ms 降到 3~8ms。
  if (store.kind === 'mysql') {
    await verifyCurrentMysql(store)
    await verifyCubeTriggers(store)
    await ensureCubeHourIndex(store, false)
    if (checkHistory) await verifyHistoricalReferences(store)
    return
  }
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
  await verifySqliteUsageConstraints(store, false)
  await verifyCubeTriggers(store)
  await ensureCubeHourIndex(store, false)
  // 每条业务连接已启用外键，新增写入由数据库逐行拒绝无效引用。
  // 全历史检查留在启动和显式迁移；每次鉴权都扫一次会让上报随历史积累退化。
  if (checkHistory) await verifyHistoricalReferences(store)
}

/**
 * MySQL 版的终态核验：**把逐表循环换成五次全库目录读取**。
 *
 * ## 为什么可以这样改（语义不变）
 *
 * 原来每张表各发 2~6 条 `information_schema` 查询（列 / 唯一约束 / 引擎 /
 * 外键 / CHECK）。这些查询**本身都支持不带 `TABLE_NAME` 的全库过滤**，
 * 所以「19 张表 × 各查一遍」与「查一次全库、在 JS 里按表分组」得到的是
 * 同一份事实。改动只影响**怎么取**，不影响**比什么**：
 *
 * | 检查项 | 原来 | 现在 |
 * |---|---|---|
 * | 表存在 | `tablesOf()` ×1 + 逐表 `includes` | 同左（1 条） |
 * | 列定义 | 每表 1 条 `columns` | 1 条全库 `columns` |
 * | 唯一约束 | 每表 1 条 `statistics` | 1 条全库 `statistics` |
 * | 外键 + RESTRICT | 每表 1 条三表 JOIN | 1 条全库三表 JOIN |
 * | CHECK + 执行状态 | 每表 1 条两表 JOIN | 1 条全库两表 JOIN |
 * | 存储引擎 | 每表 1 条 `tables` | 复用表存在那一条（`ENGINE` 已在其中） |
 * | `event_id` 主键 + 排序规则 | 2 条 | 复用上面两条，只做过滤 |
 *
 * 🚨 **`event_id` 的排序规则仍然必须查**（`utf8mb4_0900_bin`）：它决定
 *   `event_id` 的比较是否 NO PAD，猜错会让「大小写不同的两个 id」被判成同一个，
 *   于是**静默少收一条用量**。它现在挂在全库 `columns` 查询里，不额外发语句。
 *
 * ⚠️ **只对「本库自己的表」做比对**：过滤条件是 `TABLE_SCHEMA = DATABASE()`
 *   （不是表名白名单），所以同一库里的额外表照样被发现（`expectedTables` 之外
 *   的表不进循环，与原来逐表核对的覆盖面一致）。
 */
async function verifyCurrentMysql(store: PortalStore): Promise<void> {
  const statements = portalSchemaStatements('mysql')
  const expectedTables = statements
    .map(sql => /^CREATE TABLE (\w+) \(/.exec(sql)?.[1])
    .filter((name): name is string => !!name)
  const tableSql = new Map<string, string>()
  for (const sql of statements) {
    const name = /^CREATE TABLE (\w+) \(/.exec(sql)?.[1]
    if (name) tableSql.set(name, sql)
  }
  // ⚠️ `ingest_run` **不在受控 DDL 里**（它是 `PORTAL_*_INGEST_SQL`，建库时单独执行），
  //   所以按「表缺失」而不是「DDL 里有它」来判 —— 原来的 `tablesOf()` 也是这么判的。
  if (!tableSql.has('usage_event')) throw gate('受控定义缺少 usage_event。')

  // ── 5 条批量目录查询（不再随表数增长）──────────────────────────────────
  const tables = await store.all<{ name: string; engine: string }>(
    'SELECT table_name AS name, engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE()',
  )
  const columnRows = await store.all<{ table: string; name: string; type: string; nullable: string }>(
    'SELECT table_name AS `table`, column_name AS name, column_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name, ordinal_position',
  )
  const uniqueRows = await store.all<{ table: string; name: string; col: string }>(
    'SELECT table_name AS `table`, index_name AS name, column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND non_unique=0 ORDER BY table_name, index_name, seq_in_index',
  )
  const foreignRows = await store.all<{ table: string; name: string; col: string; ref_table: string; ref_col: string; delete_rule: string; update_rule: string }>(
    'SELECT k.table_name AS `table`, k.constraint_name AS name, k.column_name AS col, k.referenced_table_name AS ref_table, k.referenced_column_name AS ref_col, r.delete_rule AS delete_rule, r.update_rule AS update_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema=k.constraint_schema AND r.constraint_name=k.constraint_name WHERE k.table_schema=DATABASE() ORDER BY k.table_name, k.constraint_name, k.ordinal_position',
  )
  // 🚨 CHECK 必须**收窄到本库的 constraint_schema**。
  //   `information_schema.check_constraints` 是**实例级**的：本机实测同一实例有 226 行，
  //   其中其它 schema 的 CHECK 文本也带正则表达式，不收窄时 MySQL 要把它们全取出来比较。
  //   加上 `c.constraint_schema=DATABASE()` 后只比较本库的约束。
  //
  // ★ 这里**刻意用「全库一条」而不是「每表一条」**（v12 及以前是每表一轮）：
  //   两者取到的是同一份事实（`table_constraints` 与 `check_constraints` 的连接键
  //   就是 `constraint_schema` + `constraint_name`，`table_name` 只是个过滤条件），
  //   差别只在往返次数。线上实测（19→27 张表）：
  //   逐表 27 次 **446ms**、全库一条 **185ms**，**往返 27→1**（同一条「全库一条」
  //   在 2026-10-07 复测为 **161ms**，见下面那张表）。
  //   闸门在业务热路径上每个 API 请求都要付一次，这个线性项是每请求固定开销的主因。
  //
  // 🚨 **必须是 `STRAIGHT_JOIN`（强制以本库的 `table_constraints` 为驱动表）**。
  //   写成普通 `JOIN` 时 MySQL 会自己选驱动表，实测它选的是**实例级**的
  //   `check_constraints` —— 于是每次请求都要把整个实例的 CHECK 视图物化一遍，
  //   只为挑出本库那 226 行。线上库（27 表 / 226 CHECK）实测同样 226 行的两种写法：
  //
  //   | 写法 | 服务端耗时 | 结果集 |
  //   |---|---|---|
  //   | `JOIN`（原实现） | **161ms** | 226 行 |
  //   | `STRAIGHT_JOIN` | **23.8ms** | 226 行，内容逐行等价 |
  //
  //   等价性不是推断出来的：两种写法在线上库上按
  //   `COUNT(*) + SUM(CRC32(table|name|clause|enforced))` 取指纹，两者都是
  //   `226 / 451807555195`（内连接可交换，`STRAIGHT_JOIN` 只固定连接顺序，
  //   不改任何一行）。往返条数也没变（仍是一条），所以这次优化不欠新债。
  //   ⚠️ 顺序反过来写（`check_constraints STRAIGHT_JOIN table_constraints`）等于
  //     把物化那一步又请回来 —— 改动这一行前先跑
  //     `packages/core/test/gate-statement-budget.test.ts` 里的形状与等价性用例。
  const checkRows = await store.all<{ table: string; expression: string; enforced: string }>(
    "SELECT t.table_name AS `table`, c.check_clause AS expression, t.enforced AS enforced FROM information_schema.table_constraints t STRAIGHT_JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.constraint_type='CHECK' AND c.constraint_schema=DATABASE() ORDER BY t.table_name, t.constraint_name",
  )

  const groupBy = <Row extends { table: string }>(rows: readonly Row[]): Map<string, Row[]> => {
    const grouped = new Map<string, Row[]>()
    for (const row of rows) {
      const list = grouped.get(row.table)
      if (list) list.push(row)
      else grouped.set(row.table, [row])
    }
    return grouped
  }
  const columnsByTable = groupBy(columnRows)
  const uniqueByTable = groupBy(uniqueRows)
  const foreignByTable = groupBy(foreignRows)
  const checksByTable = groupBy(checkRows)
  const engineByTable = new Map(tables.map(row => [row.name, row.engine]))
  const presentTables = new Set(tables.map(row => row.name))

  // 表存在 + 存储引擎（InnoDB 才保证回滚与历史外键）。
  for (const table of expectedTables) {
    if (!presentTables.has(table)) throw gate(`v${PORTAL_SCHEMA_VERSION} 缺少表 ${table}。`)
    if ((engineByTable.get(table) ?? '').toUpperCase() !== 'INNODB') throw gate(`表 ${table} 必须使用 InnoDB 才能保证回滚与历史外键；不会自动转换存储引擎。`)
  }
  if (!presentTables.has('ingest_run') || (engineByTable.get('ingest_run') ?? '').toUpperCase() !== 'INNODB') throw gate('缺少 ingest_run 诊断表或它不是 InnoDB。')

  // 逐表比对：列定义 / 唯一约束 / 外键 / CHECK。
  for (const [table, sql] of tableSql) {
    const expected = expectedColumns(sql)
    const actual = (columnsByTable.get(table) ?? []).map(row => ({ name: row.name, type: row.type.toLowerCase(), nullable: row.nullable === 'YES' }))
    if (actual.length !== expected.length || expected.some(column => !actual.some(row => row.name === column.name && row.type === column.type && row.nullable === column.nullable))) {
      throw gate(`表 ${table} 的实际列定义与迁移计划不一致，拒绝继续。`)
    }
    verifyMysqlUniqueConstraints(table, sql, uniqueByTable.get(table) ?? [])
    verifyMysqlForeignKeys(table, foreignByTable.get(table) ?? [])
    verifyMysqlChecks(table, sql, checksByTable.get(table) ?? [])
  }

  // token 归属外键的复合列（与 `requireEventPrimaryKey` 的 MySQL 分支同义）。
  const eventColumnsActual = (columnsByTable.get('usage_event') ?? []).map(row => row.name)
  if (V5_FACT_COLUMNS.some(name => !eventColumnsActual.includes(name))) throw gate('usage_event 事实列缺失。')
  const eventPrimary = (uniqueByTable.get('usage_event') ?? []).filter(row => row.name === 'PRIMARY')
  if (eventPrimary.length !== 1 || eventPrimary[0]!.col !== 'event_id') throw gate('usage_event 必须以完整 event_id 为唯一主键。')
  const eventIdColumn = (columnsByTable.get('usage_event') ?? []).find(row => row.name === 'event_id')
  if (!eventIdColumn) throw gate('usage_event 缺少 event_id 列。')
  const collation = await store.get<{ collation_name: string }>(
    "SELECT collation_name AS collation_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event' AND column_name='event_id'",
  )
  if (collation?.collation_name !== 'utf8mb4_0900_bin') throw gate('usage_event.event_id 必须使用精确 NO PAD 比较，拒绝可能错误去重的表。')

  // ★ v14：`usage_event(source)` **普通索引**的逐列核对。
  //   🚨 上面那条 `uniqueRows` 查询带了 `AND non_unique=0`，所以普通索引**根本不在
  //     那份目录里** —— 而本版唯一的 DDL 就是这样一个普通索引。
  //     不单独核对的后果不是「闸门放行坏库」那么简单：索引缺失时
  //     `SELECT DISTINCT source` 会退成全表扫描（线上实测 13ms → 0ms 的收益归零），
  //     而**闸门会照样放行** —— 一次部署「成功」却毫无收益，且没有任何报错。
  //   这一条也顺带钉住「同名但列不同」（`ensureIndex()` 建的是单列，
  //   而如果有人把它改成 `(source, ts)`，loose index scan 就失效了 —— 文件头有推导）。
  const sourceIndexColumns = await store.all<{ col: string }>(
    'SELECT column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=\'usage_event\' AND index_name=$index ORDER BY seq_in_index',
    { $index: PORTAL_SOURCE_INDEX },
  )
  if (sourceIndexColumns.map(row => row.col).join(',') !== PORTAL_SOURCE_INDEX_COLUMNS) {
    throw gate(`索引 ${PORTAL_SOURCE_INDEX} 缺失或列组合不是 (${PORTAL_SOURCE_INDEX_COLUMNS})；没有它来源候选查询会退化成全表扫描。`)
  }
}

/** 唯一约束比对（原 `verifyTable` 的 MySQL 分支，逐表版本）。 */
function verifyMysqlUniqueConstraints(
  table: string,
  sql: string,
  rows: readonly { name: string; col: string }[],
): void {
  // ⚠️ 只认**表级**唯一约束，且必须是「关键字后紧跟列清单」的形状。
  //   写成 `(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)` 会**跨过中间的令牌**去匹配，
  //   于是列级写法 `alias_id … NOT NULL PRIMARY KEY CHECK (alias_id REGEXP '…')`
  //   会被捕获成 `alias_id REGEXP '^[0-9a-f]{8}-…'` —— 一个根本不存在的「列组合」。
  const expectedUnique = [...sql.matchAll(/(?:PRIMARY KEY|UNIQUE) \(([^)]+)\)/g)]
    .filter(match => /^[\s\w,]+$/.test(match[1]!))
    .map(match => match[1]!.replace(/\s/g, ''))
  const create = new RegExp(`CREATE UNIQUE INDEX [A-Za-z_][\\w]* ON ${table} \\(([^)]+)\\)`)
  for (const statement of portalSchemaStatements('mysql')) {
    const index = create.exec(statement)
    if (index) expectedUnique.push(index[1]!.replace(/\s/g, ''))
  }
  for (const line of sql.split('\n')) {
    const name = /^  ([a-z_]+) /.exec(line)?.[1]
    if (name && /PRIMARY KEY|\bUNIQUE\b/.test(line)) expectedUnique.push(name)
  }
  const unique = new Map<string, string[]>()
  for (const row of rows) { const names = unique.get(row.name) ?? []; names.push(row.col); unique.set(row.name, names) }
  const actualUnique = [...unique.values()].map(names => names.join(',')).sort()
  if (JSON.stringify(actualUnique) !== JSON.stringify(expectedUnique.sort())) throw gate(`表 ${table} 的唯一约束与主键不一致。`)
}

/** 外键 + RESTRICT 规则比对（原 `verifyMysqlConstraints` 的外键部分）。 */
function verifyMysqlForeignKeys(
  table: string,
  rows: readonly { name: string; col: string; ref_table: string; ref_col: string; delete_rule: string; update_rule: string }[],
): void {
  const sql = tableSqlFor(table)
  const expectedForeign = [...sql.matchAll(/FOREIGN KEY \(([^)]+)\) REFERENCES (\w+)\(([^)]+)\) ON DELETE RESTRICT ON UPDATE RESTRICT/g)]
    .map(match => `${match[1]!.replace(/\s/g, '')}=>${match[2]}(${match[3]!.replace(/\s/g, '')})`).sort()
  const grouped = new Map<string, { name: string; col: string; ref_table: string; ref_col: string; delete_rule: string; update_rule: string }[]>()
  for (const row of rows) { const list = grouped.get(row.name) ?? []; list.push(row); grouped.set(row.name, list) }
  const actualForeign = [...grouped.values()]
    .map(list => `${list.map(row => row.col).join(',')}=>${list[0]!.ref_table}(${list.map(row => row.ref_col).join(',')})`).sort()
  if (JSON.stringify(actualForeign) !== JSON.stringify(expectedForeign) || rows.some(row => row.delete_rule !== 'RESTRICT' || row.update_rule !== 'RESTRICT')) {
    throw gate(`表 ${table} 的实际外键与 RESTRICT 规则不一致。`)
  }
}

/** CHECK 定义 + 执行状态比对（原 `verifyMysqlConstraints` 的 CHECK 部分）。 */
function verifyMysqlChecks(
  table: string,
  sql: string,
  rows: readonly { expression: string; enforced: string }[],
): void {
  // MySQL 的 information_schema 用反斜线转义表达式中的字符串定界符。
  if (rows.some(row => row.enforced !== 'YES') || !sameChecks(rows.map(row => row.expression.replace(/\\'/g, "'")), checkExpressions(sql))) {
    throw gate(`表 ${table} 的 CHECK 实际定义或执行状态不一致。`)
  }
}

/** 取受控 DDL 里某张表的定义文本（缓存一次，避免每表重扫全部语句）。 */
const tableSqlCache = new Map<string, string>()
function tableSqlFor(table: string): string {
  const cached = tableSqlCache.get(table)
  if (cached !== undefined) return cached
  for (const sql of portalSchemaStatements('mysql')) {
    if (sql.startsWith(`CREATE TABLE ${table} (`)) { tableSqlCache.set(table, sql); return sql }
  }
  throw gate(`缺少受控表定义：${table}`)
}
/** MySQL 侧的探查入口：只在**启动与显式迁移**时扫全历史（每请求扫一次会随历史积累退化）。 */
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
  for (const sql of portalV15TriggerStatements('sqlite')) {
    const name = /^CREATE TRIGGER (\w+)/.exec(sql)![1]!
    const row = db.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=$name").get({ $name: name })
    if (!row || normalizeTrigger(row.sql) !== normalizeTrigger(sql)) throw gate(`汇总失效触发器 ${name} 缺失或定义不一致。`)
  }
  const hourIndex = db.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND name=$name").get({ $name: CUBE_HOUR_INDEX })
  if (!hourIndex || normalizeTrigger(hourIndex.sql) !== normalizeTrigger(cubeHourIndexSql('sqlite'))) throw gate(`索引 ${CUBE_HOUR_INDEX} 缺失或定义不一致。`)
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
/** 业务热路径的版本闸门：**每次都重读真实结构**（见函数体里的 🚨）。 */
export async function ensurePortalReady(store: PortalStore): Promise<void> {
  const initial = await readPortalState(store)
  // 每次都重读真实结构，不缓存版本或约束，因此运行中缺表、篡改 CHECK 和半迁移仍立即拒绝。
  // 🚨 **不要为了省时间把这一步降成「版本指纹 + TTL 缓存」**：`portal-v5.test.ts` 有一条
  //   活体用例（「v3 真实备份证明…」）会 DROP 掉 `fk_usage_v4_member` 再 open，
  //   要求**立刻**抛「实际外键不一致」。缓存会让它在一个 TTL 窗口内被放行 ——
  //   「运行中改结构立刻拒绝」是本闸门存在的理由，省下的时间不值这个价。
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
export async function historyFingerprint(store: PortalStore, snapshot: 'dept' | 'group_name'): Promise<{ hash: string; count: number }> {
  const columns = snapshot === 'dept' ? legacyColumns : V5_FACT_COLUMNS
  const hash = createHash('sha256')
  // 当前 MySQL 主键为二进制排序；去掉 BINARY 包裹才能利用主键。
  // PAD SPACE 排序忽略尾部空格，含这类旧键时仍保留原来的逐字节顺序。
  let order = 'event_id COLLATE BINARY'
  if (store.kind === 'mysql') {
    const column = await store.get<{ collation: string }>("SELECT collation_name AS collation FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event' AND column_name='event_id'")
    const binary = column?.collation?.endsWith('_bin') ?? false
    const padded = binary && await store.get("SELECT event_id FROM usage_event WHERE LENGTH(event_id)<>LENGTH(RTRIM(event_id)) LIMIT 1")
    order = binary && !padded ? 'event_id' : 'BINARY event_id'
  }
  let count = 0
  let cursor: string | undefined
  // 旧库非二进制排序或带尾部空格时，保留旧算法，避免更改已存检查点的顺序。
  const seek = store.kind === 'sqlite' || order === 'event_id'
  for (;;) {
    const rows = await store.all<Record<string, unknown>>(`SELECT ${columns.join(',')} FROM usage_event${!seek || cursor === undefined ? '' : ` WHERE ${order} > $cursor`} ORDER BY ${order} LIMIT 1000${seek ? '' : ` OFFSET ${count}`}`, !seek || cursor === undefined ? {} : { $cursor: cursor })
    for (const row of rows) hash.update(JSON.stringify(columns.map(name => typeof row[name] === 'bigint' ? String(row[name]) : row[name])) + '\n')
    count += rows.length
    if (rows.length < 1000) return { hash: hash.digest('hex'), count }
    cursor = String(rows[rows.length - 1]!.event_id)
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
    // 🚨 v12 的「给 `provider_alias` 加列 + 换唯一索引」**必须排在最前面**
    //   （早于 v5→v6），而不能按版本号顺序放在链尾：
    //   `upgradeV5ToV6()` 用**当前受控定义**建表并核对，它内部的
    //   `ensureControlledIndexes()` 在索引已存在时会**逐列核对** —— 一个 v11 库的
    //   `idx_provider_alias_member` 还是旧的 `(member_id, provider)`，先跑 v5→v6
    //   就会当场报「索引 idx_provider_alias_member 目录定义不匹配」，
    //   而真正的原因（索引该先被 v12 换掉）在报错里完全看不出来。
    //   反过来先跑 v12 是安全的：它内部逐项幂等（表不存在 / 列已在 / 索引已对都跳过），
    //   对 v3/v4 老库是空操作，随后 v5→v6 才把表按含 `model` 的受控定义建出来。
    //   它还必须在 v5 的事实表重建之前：`provider_alias` 引用 `members`，
    //   重建 `members` 时这张表必须已经存在（理由见下面 v6 的注释）。
    await upgradeV11ToV12(store)
    await upgradeCubeTables(store)
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
    // v8 建的是三张汇总表 + 元数据表，**不引用任何既有表**（刻意不加外键），
    // 所以同样放在 v5 重建之前。⚠️ 这里只**建表**，不灌数据 ——
    // 灌历史要扫全表（300 万行实测 41s），迁移不该把它算进事务里；
    // 首次补齐由业务启动时的 `syncRollups()` 负责（可中断、可重试、不阻塞迁移）。
    await upgradeV7ToV8(store)
    await upgradeV8ToV9(store)
    // v10 给 `model_price` 补五列闲时价。它**必须排在这里**（v5 的事实表重建之前）：
    //   `verifyTable('model_price', …)` 是拿**受控定义全文**比对的，而受控定义
    //   已经含这五列（`portalSchemaStatements()` 的拼接）—— 放到重建之后再跑，
    //   中间那段时间里 model_price 与受控定义不一致，MySQL 侧的
    //   `verifyCurrentMysql` 会把它当成结构不符。而且 model_price 在 v6→v7 里刚建好，
    //   不引用任何既有表，放这里没有任何副作用。
    await upgradeV9ToV10(store)
    // v11 追加 `project_alias`（项目归一化规则）。与 v6 / v7 完全同构：
    //   只建表 + 建索引 + 补权限行，**事实表一个字节都不动**。
    // ⚠️ 它引用 `members`（`member_id` 外键），所以**必须早于 v5 的事实表重建** ——
    //   理由与 v6 的注释逐字相同：SQLite 重建 `members`（RENAME → 新建 → 拷贝 → 删旧）
    //   时会重新解析全部引用它的表，那一刻 `project_alias` 还不存在就会抛
    //   `no such table: main.project_alias`，而错误信息完全不提「是 v11 的表还没建」。
    await upgradeV10ToV11(store)
    if (!v5Ready) {
      if (kind === 'sqlite') await runV5Sqlite(store)
      else await runV5Mysql(store)
      const after = await historyFingerprint(store, 'group_name')
      if (checkpoint.historyHash && (after.hash !== checkpoint.historyHash || after.count !== checkpoint.historyCount)) {
        throw gate('迁移前后原始事件不一致，拒绝标记完成。')
      }
    }
    // 🚨 v13 **必须排在最后**（v7 之后、v5 重建之后）：它给内置 `member` 角色补一条
    //   `role_permissions`，而 `permission_id` 上有指向 `permissions` 的外键 ——
    //   那行 `cost:read`（`…114`）是 **v7** 才插进去的。排在 v12 那一步后面
    //   （v7 之前）会在老库上直接 `FOREIGN KEY constraint failed`，
    //   而错误信息完全不提「是权限行还没建」。
    await upgradeV12ToV13(store)
    // ★ v14：**建索引**（`usage_event(source)`），它不改任何数据 ——
    //   所以放在事件指纹终检之前是安全的（指纹必然不变，那一步只是照例跑一遍）。
    await upgradeV13ToV14(store)
    await installCubeTriggers(store)
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
  /**
   * ★ 建表与核对都用**当前受控定义**（= v6 的表 + v12 的 `model` 列 +
   *   换成三列的唯一索引），而不是 `portalV6TableStatement()` 那段冻结的 v6 文本。
   *
   * 理由与 `upgradeV6ToV7()` 完全相同：一个「结构已经是当前版本、但账本被回滚到
   *   v6」的库本来就带着那一列（迁移用例正是这么造旧版库的），拿 v6 文本去
   *   逐列核对会当场判「provider_alias 的列定义与迁移计划不一致」，
   *   而它实际完全正确 —— 紧随其后的 `upgradeV9ToV10` / `upgradeV11ToV12`
   *   本来就是幂等的（列已在就跳过）。
   *
   * ⚠️ 索引那一份也必须用**替换后**的清单：`ensureIndex()` 在索引已存在时
   *   会逐列核对，拿旧的 `(member_id, provider)` 去核对一个已经是
   *   `(member_id, provider, model)` 的索引会直接判「索引目录定义不匹配」——
   *   而 `upgradeV11ToV12` 已经把它换对了。
   */
  const controlStatements = portalV12ReplaceProviderAliasIndex(portalV6Statements(store.kind))
  const table = tableStatement(store.kind, 'provider_alias')
  if (!(await tablesOf(store)).includes('provider_alias')) await store.exec(table)
  // ⚠️ 必须用 `ensureControlledIndexes()`（它认 `CREATE UNIQUE INDEX`）。
  //   早先这里写的是 `sql.startsWith('CREATE INDEX')`，于是
  //   `idx_provider_alias_member` 从来没被建出来过 —— 见 `isCreateIndex()` 的注释。
  // 🚨 **建索引必须早于 `verifyTable`**：MySQL 分支的 `verifyTable` 会把
  //   `CREATE UNIQUE INDEX … ON <表>` 也算进「期望的唯一约束」（见那里的注释），
  //   而唯一索引在受控 DDL 里是**独立语句**、不在 `CREATE TABLE` 文本内。
  //   先校验后建索引 ⇒ 在任何真实 MySQL 上 v5→v6 的第一步必然报
  //   「表 provider_alias 的唯一约束与主键不一致」，整个迁移一步都走不动；
  //   而 SQLite 分支只比 `sqlite_master.sql` 全文、根本不看索引，
  //   所以这个顺序错误在本地 SQLite 测试里永远看不见。
  await ensureControlledIndexes(store, controlStatements)
  await verifyTable(store, 'provider_alias', table)
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
  /**
   * ★ 建表用**当前受控定义**（= v7 的表 + 之后各版给 `model_price` 追加的列），
   *   而不是 `portalV7TableStatement()` 那段冻结的 v7 文本 —— 与 `runV5Sqlite()`
   *   用「拼接过 v9 列」的定义重建 `usage_event` 是同一个思路：新库一步到位，
   *   后面的追加步骤（`upgradeV9ToV10`）幂等跳过。
   */
  const current = tableStatement(store.kind, 'model_price')
  if (!(await tablesOf(store)).includes('model_price')) await store.exec(current)
  // 🚨 同 v5→v6：**建索引必须早于 `verifyTable`**。`idx_model_price_span` 是受控 DDL 里的
  //   独立 `CREATE UNIQUE INDEX`，而 MySQL 分支的 `verifyTable` 会把它算进期望的唯一约束 ——
  //   先校验后建索引会让 v6→v7 的第一步也报「唯一约束与主键不一致」。
  await ensureControlledIndexes(store, portalV7Statements(store.kind))
  /**
   * ⚠️ 逐列核对要**按这张表当前停在哪个版本**选期望形状：
   *   - 老库（v7 / v8 / v9）：表还是 v7 的 13 列，期望形状就是那段冻结的 v7 文本；
   *   - 全新库，或**结构已经升到更高版本、只是账本被回滚下来**的库（`verify-v8-migration.ts`
   *     的「回滚-再迁移」演练与 v9 / v10 那些夹具都是这种）：表已经带上了后面版本追加的列，
   *     期望形状必须是当前受控定义 —— 拿 v7 文本去比会当场判「列定义不一致」，
   *     而它实际完全正确，紧随其后的追加步骤本来就是幂等的。
   *   ★ 两种情况都会在**追加步骤的最后一步**（当前版本那一步）再整体核对一次，
   *     所以这里选错形状不会让任何结构问题漏过去，只会误报。
   */
  const columns = await tableColumns(store, 'model_price')
  const target = columns.includes(PORTAL_OFFPEAK_SCHEDULE_COLUMN)
    ? current
    : portalV7TableStatement(store.kind, 'model_price')
  await verifyTable(store, 'model_price', target)
  for (const sql of portalV7Statements(store.kind)) {
    if (sql.startsWith('INSERT')) await store.exec(sql)
  }
}

/**
 * v7 → v8：**只追加**三张看板汇总表与单行元数据表。
 *
 * 与 v5→v6 / v6→v7 完全同构，因此同样安全：
 * 1. 建四张表（先看目标状态，幂等）；
 * 2. 建受控索引（v8 里只有 `idx_rollup_day_member` 一条普通索引，无唯一索引）；
 * 3. 逐表按受控定义核对。
 *
 * 🚨 **事实表一个字节都不动**，所以这一步**不需要**备份证明，也不需要重比事件指纹。
 *
 * ★ **本步骤刻意不灌数据。** 汇总表可以从 `usage_event` 完整重建，
 *   而首次全量构建要扫整张事实表（300 万行实测 41 秒）。把它塞进迁移事务会让
 *   「一次迁移」变成「一次长事务 + 大 undo」，且中途崩了要整体重来。
 *   所以这里只建空表，由 `syncRollups()` 在业务侧补齐 —— 它可中断、可重试、
 *   而且**汇总表是空的也不会让看板出错**（查询层会自动退原始表）。
 */
async function upgradeV7ToV8(store: PortalStore): Promise<void> {
  const existing = await tablesOf(store)
  for (const table of PORTAL_V8_TABLES) {
    if (existing.includes(table)) continue
    await store.exec(portalV8TableStatement(store.kind, table))
  }
  // 🚨 建索引必须早于 `verifyTable`（同 v5→v6 的注释）：MySQL 分支的 `verifyTable`
  //   会把受控 DDL 里的 `CREATE INDEX` / `CREATE UNIQUE INDEX` 也算进期望集合，
  //   先校验后建索引会让这一步在任何真实 MySQL 上直接失败。
  await ensureControlledIndexes(store, portalV8Statements(store.kind))
  for (const table of PORTAL_V8_TABLES) {
    await verifyTable(store, table, portalV8TableStatement(store.kind, table))
  }
}

/**
 * v8 → v9：给事实表补一列 `usage_event.source`。
 *
 * ## 为什么这一步是幂等的（**必须**是）
 *
 * 两条升级路径会在不同时刻把这一列带进来：
 *   1. **全新库 / v5 之前的老库**：`portalSchemaStatements()` 里的 `usage_event`
 *      已经是**拼接过 source 的受控定义**，建出来的表本来就有这一列；
 *   2. **已经是 v8 的库**：表里没有这一列，靠下面这条 `ALTER` 补。
 * 所以这里先查列是否存在，缺了才 ALTER —— 不查的话第 1 条路径会在
 * `duplicate column name: source` 上炸掉，而它的根因与迁移本身无关。
 *
 * ## 为什么不重建事实表
 *
 * v5 那次重建是因为要去掉一列（SQLite 不支持 DROP COLUMN 于受控 DDL 的形态）；
 * v9 只**追加**一列且带默认值，SQLite 与 MySQL 的 `ADD COLUMN` 都不会重写既有行，
 * 于是这次迁移**不碰任何事件原值**，也不需要备份证明 —— 与 v6 / v7 / v8 同一档。
 *
 * ⚠️ 校验仍然逐列比对（`verifyTable`）：`source` 的类型 / 可空 / 默认值写错
 *   （例如 MySQL 上用 `TEXT` 而不是 `VARCHAR(32)`）会在这里当场失败，
 *   而不是等到看板查询返回一个读不出来的值。
 */
async function upgradeV8ToV9(store: PortalStore): Promise<void> {
  const before = await eventColumns(store)
  if (!before.some(column => column.name === PORTAL_SOURCE_COLUMN)) {
    await store.exec(portalV9AddColumnStatement(store.kind))
  }
  /**
   * ⚠️ **只有在事实表已经是 v5 形态时才在这里逐列核对**。
   *
   * 这一步在升级链里的位置是「v6 / v7 / v8 的追加之后、v5 的事实表重建之前」——
   * 那是**刻意**的：MySQL 的 `alignMysqlEventColumns()` 要求
   * 「实际列数 == 受控定义列数」，所以 v9 的列必须先存在（见 `upgradeV4ToV5`
   * 里那段「结构追加必须早于 v5」的注释）。
   *
   * 而 v5 **之前**的库（快照列还叫 `dept`）形状与受控定义本来就不同：
   * SQLite 会在紧随其后的 `runV5Sqlite()` 里**按受控定义重建**事实表
   * （拼接后的定义已含 `source`，重建时会把它一起搬过去），MySQL 由
   * `alignMysqlEventColumns()` 逐列对齐 —— 两条路的终态都由
   * `verifyCurrent()` 统一核对。在这里提前核对只会把**每一条** v3/v4 的迁移拦下，
   * 而报错文案是「usage_event 的列定义与迁移计划不一致」，指向一个并不存在的问题。
   */
  if (before.some(column => column.name === 'group_name')) {
    await verifyTable(store, 'usage_event', tableStatement(store.kind, 'usage_event'))
  }
}

/**
 * v9 → v10：给 `model_price` 补五列闲时（低谷）价。
 *
 * ## 为什么这一版也不需要备份证明
 *
 * 五列全部**可空、无默认值**，两种后端的 `ADD COLUMN` 都不重写既有行 ——
 * 于是历史价行读出来就是「不分时段」，与它们当年被写入时的语义逐字一致，
 * **历史金额一个字节都不会变**。与 v6 / v7 / v8 / v9 同一档。
 *
 * ## 为什么先查列再 ALTER（幂等是硬要求）
 *
 * 两条路径会在不同时刻把这几列带进来：
 *   1. **全新库**：`portalSchemaStatements()` 里的 `model_price` 已经是**拼接过
 *      闲时五列**的受控定义（见 `portal-schema-v10.ts`），建出来就有；
 *   2. **已经是 v9 的库**：表里没有，靠下面这五条 `ALTER` 补。
 * 不查就 ALTER 的话，第 1 条路径会在 `duplicate column name` 上炸掉，
 * 而它的根因与迁移本身无关。
 *
 * ⚠️ **一列一条 ALTER**（见 `portalV10AddColumnStatements`）：MySQL 的 DDL 隐式提交，
 *   一条语句里加五列中途失败会留下一套半成品列，而分开加能明确停在哪一列。
 *
 * ⚠️ 校验仍然逐列比对（`verifyTable`）：类型 / 可空写错（例如 MySQL 上用
 *   `INTEGER` 而不是 `INT`）会在这里当场失败，而不是等看板按错误的档算钱。
 *   SQLite 分支还会比对**表定义全文**（只抹空白与引号）—— 插入点必须与
 *   `ALTER TABLE … ADD COLUMN` 的改写位置一致，见 `portal-schema-v10.ts`。
 */
async function upgradeV9ToV10(store: PortalStore): Promise<void> {
  const existing = new Set((await tableColumns(store, PRICE_TABLE)).map(name => name.toLowerCase()))
  for (const statement of portalV10AddColumnStatements(store.kind)) {
    const column = /ADD COLUMN ([a-z_]+)/.exec(statement)?.[1]
    if (column && existing.has(column)) continue
    await store.exec(statement)
  }
  await verifyTable(store, PRICE_TABLE, tableStatement(store.kind, PRICE_TABLE))
}

/** 单价表的表名（与 `query.ts` 的 `PRICE_TABLE` 同一个字面量；这里刻意不 import 查询层）。 */
const PRICE_TABLE = 'model_price'

/**
 * v10 → v11：**只追加** `project_alias`（项目归一化规则表）与权限码 `projects:*`。
 *
 * 与 v5→v6 完全同构，因此同样安全：
 * 1. 建 `project_alias`（先看目标状态，幂等）；
 * 2. 建它的索引（含**唯一**索引 `idx_project_alias_member`，走 `ensureControlledIndexes`）；
 * 3. 逐列按受控定义核对；
 * 4. 补权限行（`WHERE NOT EXISTS`，幂等）。
 *
 * 🚨 **事实表一个字节都不动**，所以这一步**不需要**备份证明，也不需要重比事件指纹。
 *   项目归一化是查询时应用的：规则写进这张表，`usage_event.cwd` 永远是上报当时的原值
 *   （这正是「删掉规则就恢复原状」的机制）。
 *
 * ⚠️ 与 `upgradeV6ToV7` 用**当前受控定义**（而不是某个冻结的 v11 文本）是同一回事：
 *   受控定义是唯一真源，而 v11 就是当前版本，两者本来就该相同。
 */
async function upgradeV10ToV11(store: PortalStore): Promise<void> {
  const table = portalV11TableStatement(store.kind, PROJECT_ALIAS_TABLE)
  if (!(await tablesOf(store)).includes(PROJECT_ALIAS_TABLE)) await store.exec(table)
  // 🚨 同 v5→v6：**建索引必须早于 `verifyTable`**。`idx_project_alias_member` 是受控 DDL 里的
  //   独立 `CREATE UNIQUE INDEX`，而 MySQL 分支的 `verifyTable` 会把它算进期望的唯一约束 ——
  //   先校验后建索引会让这一步在任何真实 MySQL 上必然报「唯一约束与主键不一致」，
  //   整个迁移一步都走不动；而 SQLite 分支只比 `sqlite_master.sql` 全文、根本不看索引，
  //   所以这个顺序错误在本地 SQLite 测试里永远看不见。
  await ensureControlledIndexes(store, portalV11Statements(store.kind))
  await verifyTable(store, PROJECT_ALIAS_TABLE, table)
  for (const sql of portalV11Statements(store.kind)) {
    if (sql.startsWith('INSERT')) await store.exec(sql)
  }
}

/**
 * v11 → v12：给 `provider_alias` 补一列 `model`，**并把唯一索引换成三列**。
 *
 * ## 为什么这一版既加列又换索引
 *
 * 加列让规则从「只折叠供应商」扩展到「模型也能折叠」（`model IS NULL` = 供应商规则，
 * 非 NULL = 模型规则）。而不换索引的话，「`dashscope` 这条供应商规则」与
 * 「`dashscope` + `qwen-max` 这条模型规则」在 `(member_id, provider)` 下是同一个键 ——
 * 第二条根本写不进去，而这两条规则正是使用者会同时配置的。详见
 * `portal-schema-v12.ts` 的文件头。
 *
 * ## 为什么不需要备份证明
 *
 * `model` 列**可空、无默认值**：两种后端的 `ADD COLUMN` 都不重写既有行，于是
 * 历史规则读出来就是「供应商规则」，与它们当年被写入时的语义**逐字一致**。
 * 换索引只改索引结构，一个字节的规则数据都不动 ——
 * 与 v6 / v7 / v8 / v9 / v10 / v11 同一档。`usage_event` 更是完全不碰。
 *
 * ## 幂等（硬要求：两条升级路径会在不同时刻把这一列带进来）
 *
 * 1. **全新库 / v5 之前的老库**：`portalSchemaStatements()` 里的 `provider_alias`
 *    已经是**拼接过 `model` 列**、且唯一索引已是三列的受控定义，建出来就对；
 * 2. **已经是 v11 的库**：表里没有这一列、索引还是两列，靠下面这两步补。
 * 不查就 ALTER 会在第 1 条路径上撞 `duplicate column name`（根因与迁移无关），
 * 不查就换索引会在第 1 条路径上撞 `index already exists`。
 *
 * ⚠️ 表不存在时**直接返回**（v3/v4 老库走的就是这条路）：随后 `upgradeV5ToV6`
 *   会按含 `model` 的受控定义把表建出来，一步到位。
 *
 * 🚨 MySQL 侧换索引**不能先 DROP**：`member_id` 上有指向 `members` 的外键，
 *   而 InnoDB 要求外键列上存在以它为最左前缀的索引 —— 当前唯一覆盖它的恰恰是
 *   待删的那个索引，先删会被 errno 1553 挡住（`Cannot drop index …: needed in a
 *   foreign key constraint`）。所以必须「以临时名建新 → 删旧 → 临时名改回」三步。
 *   SQLite 没有这条联动，直接 DROP + CREATE 即可。
 */
async function upgradeV11ToV12(store: PortalStore): Promise<void> {
  if (!(await tablesOf(store)).includes('provider_alias')) return
  // ── 一列：`model`（可空、无默认值）────────────────────────────────
  const columns = new Set((await tableColumns(store, 'provider_alias')).map(name => name.toLowerCase()))
  if (!columns.has(PORTAL_MODEL_COLUMN)) await store.exec(portalV12AddColumnStatement(store.kind))
  // ── 唯一索引：`(member_id, provider)` → `(member_id, provider, model)` ──
  await replaceProviderAliasUniqueIndex(store)
  await verifyTable(store, 'provider_alias', tableStatement(store.kind, 'provider_alias'))
}

/**
 * v12 → v13：**只动数据** —— 把 `cost:read` 授予内置 `member` 角色。
 *
 * 这一版没有任何 DDL，理由写在 `portal-schema-v13.ts` 的文件头
 * （appKey 的固定范围 2026-10 起含 `cost:read`，而「凭证能做什么 = 角色权限 ∩
 * 凭证 scopes」，内置 `member` 角色没有它 ⇒ 普通成员一条 appKey 都签不出来）。
 *
 * ⚠️ 幂等由 SQL 自身保证（`WHERE NOT EXISTS`），所以 resume 重跑安全；
 *   这里**没有** `verifyTable()` 可核对 —— 本版本不动结构，
 *   受控摘要也因此与 v12 逐字相同（见 `portalSchemaChecksumV12()`）。
 */
async function upgradeV12ToV13(store: PortalStore): Promise<void> {
  if (!(await tablesOf(store)).includes('role_permissions')) return
  for (const sql of portalV13Statements()) await store.exec(sql)
}

/**
 * v13 → v14：**只建一个索引** —— `usage_event(source)`。
 *
 * ## 为什么它排在 v13 权限步骤**之后**
 *
 * 顺序在这一版无关紧要（一个插 `role_permissions`、一个建索引，互不相干）。
 * 但把它排在后面有个实际好处：`upgradeV12ToV13()` 是**幂等且极便宜**的一步，
 * 先跑它意味着「如果 v13 那步在这个库上因为历史原因失败」，
 * 报错会指向真正的问题，而不是被一个建索引的 DDL 失败盖住。
 *
 * ## 幂等
 *
 * `ensureIndex()` 先查目录再决定建不建，所以重复执行安全；
 * 它还会**逐列比对**已存在的索引 —— 同名但列不同则直接 `gate()` 拒绝，
 * 不会把一个错的索引当成对的（这正是 `CREATE INDEX IF NOT EXISTS` 做不到的）。
 *
 * ## 🚨 它不该、也没有改变任何数据
 *
 * 因此这一版**不需要备份证明、不需要比对事件指纹**（`upgradeV6ToV7` 那条
 * 「事件指纹逐位不变」的检查在这里是空转）。而回退位就是「删掉这个索引」：
 * 查询层在索引缺失时自动退全表扫描，**正确性完全不受影响**，
 * 变的只是那个候选下拉框从 0~1ms 变回 13ms。
 */
async function upgradeV13ToV14(store: PortalStore): Promise<void> {
  if (!(await tablesOf(store)).includes('usage_event')) return
  await ensureIndex(store, portalSourceIndex(), true)
}

/**
 * 把 `provider_alias` 的唯一索引换成 `(member_id, provider, model)`。
 *
 * ⚠️ 需要**临时名**，理由见 `upgradeV11ToV12()` 的注释（MySQL 的 errno 1553）。
 *   两端的终态都是受控索引名 + 受控列组合，所以 `verifyTable()` 之后的
 *   `expectedUnique` 核对在两个后端上看到的是同一份事实。
 *
 * 三步都各自先查状态：MySQL 的 DDL 会隐式提交，中途崩过之后 resume
 * 必须能从任意中间态接着跑（半状态正是「临时索引在、旧索引也在」）。
 */
async function replaceProviderAliasUniqueIndex(store: PortalStore): Promise<void> {
  const actual = await uniqueIndexColumns(store, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX)
  if (actual === PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS) return
  if (store.kind === 'sqlite') {
    // SQLite 可以随时删索引（外键不会因此失去索引），一步到位。
    if (actual !== null) await store.exec(`DROP INDEX ${PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX}`)
    await store.exec(portalProviderAliasUniqueIndex())
    return
  }
  const temporary = await uniqueIndexColumns(store, 'provider_alias', PORTAL_PROVIDER_ALIAS_TEMP_INDEX)
  if (temporary !== PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS) {
    // 上一次跑崩在「临时索引建了一半」：先清掉再建，否则撞 duplicate key name。
    if (temporary !== null) await store.exec(`DROP INDEX ${PORTAL_PROVIDER_ALIAS_TEMP_INDEX} ON provider_alias`)
    await store.exec(portalProviderAliasTemporaryIndex())
  }
  // 到这里外键已经有覆盖 `member_id` 最左前缀的索引可用，删旧索引不会再被 1553 挡住。
  if (actual !== null) await store.exec(`DROP INDEX ${PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX} ON provider_alias`)
  await store.exec(`ALTER TABLE provider_alias RENAME INDEX ${PORTAL_PROVIDER_ALIAS_TEMP_INDEX} TO ${PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX}`)
}

/**
 * 某个索引当前的列组合（**用逗号 + 空格连接**，与受控常量同形）；索引不存在返回 `null`。
 *
 * ⚠️ `PRAGMA index_info` 在索引不存在时返回**空结果集**而不是报错，
 *   所以「不存在」只能靠 `length === 0` 判，不能靠异常。
 *   列名在两种后端上大小写可能不同，统一小写后再比。
 */
async function uniqueIndexColumns(store: PortalStore, table: string, name: string): Promise<string | null> {
  const rows = store.kind === 'sqlite'
    ? await store.all<{ name: string | null }>(`PRAGMA index_info(${name})`)
    : await store.all<{ name: string | null }>('SELECT column_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND index_name=$name ORDER BY seq_in_index', { $table: table, $name: name })
  const columns = rows.map(row => String(row.name ?? '').toLowerCase()).filter(Boolean)
  return columns.length ? columns.join(', ') : null
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
  if (sql === cubeHourIndexSql(store.kind)) return ensureCubeHourIndex(store, createMissing)
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

/** 表达式索引的列名是 NULL，必须核对表达式，而非把它当成普通列索引。 */
async function ensureCubeHourIndex(store: PortalStore, createMissing: boolean): Promise<void> {
  if (store.kind === 'sqlite') {
    const row = await store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND name=$name", { $name: CUBE_HOUR_INDEX })
    if (row && normalizeTrigger(row.sql) === normalizeTrigger(cubeHourIndexSql('sqlite'))) return
    if (row) throw gate(`索引 ${CUBE_HOUR_INDEX} 目录定义不匹配。`)
  } else {
    const rows = await store.all<{ expression: string | null; name: string | null; non_unique: number; sub_part: number | null; visible: string; index_type: string }>(
      'SELECT expression AS expression,column_name AS name,non_unique AS non_unique,sub_part AS sub_part,is_visible AS visible,index_type AS index_type FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=\'usage_event\' AND index_name=$name ORDER BY seq_in_index', { $name: CUBE_HOUR_INDEX })
    const normalize = (value: string) => value.replace(/[\s`()]/g, '').toLowerCase()
    if (rows.length === 1 && rows[0]!.name === null && Number(rows[0]!.non_unique) === 1 && rows[0]!.sub_part === null && rows[0]!.visible === 'YES' && rows[0]!.index_type === 'BTREE' && normalize(rows[0]!.expression ?? '') === normalize(cubeHourSql('mysql', 'ts'))) return
    if (rows.length) throw gate(`索引 ${CUBE_HOUR_INDEX} 目录定义不匹配。`)
  }
  if (!createMissing) throw gate(`索引 ${CUBE_HOUR_INDEX} 缺失，拒绝自愈。`)
  await store.exec(cubeHourIndexSql(store.kind))
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

/** v15 只追加派生表；必须先于 v5 的索引补齐，触发器则在事实表重建后安装。 */
async function upgradeCubeTables(store: PortalStore): Promise<void> {
  const statements = portalV15TableStatements(store.kind)
  const existing = await tablesOf(store)
  for (const sql of statements) {
    const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (table && !existing.includes(table)) await store.exec(sql)
  }
  await ensureControlledIndexes(store, statements)
  for (const sql of statements) {
    const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1]
    if (table) await verifyTable(store, table, sql)
  }
}
async function installCubeTriggers(store: PortalStore): Promise<void> {
  const rows = store.kind === 'mysql'
    ? await store.all<{ name: string }>('SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema=DATABASE()')
    : await store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger'")
  const names = new Set(rows.map(row => row.name))
  for (const sql of portalV15TriggerStatements(store.kind)) {
    const name = /^CREATE TRIGGER (\w+)/.exec(sql)![1]!
    if (!names.has(name)) await store.exec(sql)
  }
  await verifyCubeTriggers(store)
}
async function verifyCubeTriggers(store: PortalStore): Promise<void> {
  const rows = store.kind === 'mysql'
    ? await store.all<{ name: string; body: string; event: string; timing: string; table_name: string }>(
        "SELECT trigger_name AS name, action_statement AS body, event_manipulation AS event, action_timing AS timing, event_object_table AS table_name FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name IN ('usage_cube_insert','usage_cube_update','usage_cube_delete')")
    : await store.all<{ name: string; body: string }>("SELECT name, sql AS body FROM sqlite_master WHERE type='trigger' AND name IN ('usage_cube_insert','usage_cube_update','usage_cube_delete')")
  for (const [i, sql] of portalV15TriggerStatements(store.kind).entries()) {
    const row = rows.find(row => row.name === CUBE_TRIGGER_NAMES[i])
    const expected = store.kind === 'mysql' ? sql.slice(sql.indexOf('BEGIN')) : sql
    const actual = row?.body ?? ''
    if (!row || normalizeTrigger(actual) !== normalizeTrigger(expected)) throw gate(`汇总失效触发器 ${CUBE_TRIGGER_NAMES[i]} 缺失或定义不一致。`)
    if (store.kind === 'mysql') {
      const value = row as { event?: string; timing?: string; table_name?: string }
      if (value.event !== ['INSERT', 'UPDATE', 'DELETE'][i] || value.timing !== 'AFTER' || value.table_name !== 'usage_event') throw gate('汇总失效触发器挂载位置不一致。')
    }
  }
}
