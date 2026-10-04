/**
 * 在真实 SQLite / 可选隔离 MySQL 上验证上报库闸门、事务与**无损迁移**。
 *
 * ## 当前版本是 v7，本文件覆盖 v4 / v5 / v6 / v7 四段
 *
 * | 版本 | 结构 | 本文件里的覆盖 |
 * |---|---|---|
 * | v4 | 冻结基线 | 逐字比对 `docs/database-v4/*.sql` |
 * | v5 | 分组多对多 | v4→v5 / v3→v5 迁移、指纹逐位不变、触发器清空 |
 * | v6 | 供应商归一化（`provider_alias`） | 作为**可迁移起点**被认出来、追加迁移不动事实表 |
 * | **v7** | ★ **当前终态**：追加 `model_price` + `cost:read` / `pricing:manage` | 新库表数、受控索引（**含唯一索引**）全在位 |
 *
 * ★ v6 与 v7 都是**纯追加**：只建表 / 建索引 / 补权限行，事实表一个字节都不动 ——
 *   所以两段迁移都不要求备份证明，也不需要重新比对事件指纹
 *   （费用与供应商归一化一样是**查询期**口径，库里的历史用量从不因它们改写）。
 *
 * 🚨 **受控索引必须逐条核对（含 `CREATE UNIQUE INDEX`）**：SQLite 分支的
 *   `verifyCurrent` 只比对表定义文本、不看索引，所以「迁移少建了一个索引」
 *   在这里永远暴露不出来，而 MySQL 分支会在最后一步直接判失败。
 *   本文件因此显式断言迁移后 `PRAGMA index_list` 的结果。
 *
 * ⚠️ 契约文件（`docs/database-v4/*.sql`、`docs/database-v5/*.sql`）与跨进程子脚本
 *   都在**仓库根**下。从 `packages/core` 直接 `bun test test/portal-v5.test.ts` 时
 *   `process.cwd()` 不是仓库根，写死相对路径会让契约断言与子进程用例一起假失败 ——
 *   所以这里用 `import.meta.dir` 反推仓库根，让测试与运行目录无关。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { openDb, ensureSchema } from '../src/db/schema.js'
import { openPortalStore, inspectPortalDatabase, preparePortalDatabase, migratePortalDatabase, describePortalTarget, type PortalTarget, type PortalStore } from '../src/db/portal-db.js'
import { openRawPortalStore } from '../src/db/portal-connection.js'
import { insertAttributedRecords, insertAttributedRecordsInTransaction, type IngestRecord } from '../src/db/ingest.js'
import { PORTAL_MYSQL_V4_SQL, PORTAL_SQLITE_V4_SQL, PORTAL_MYSQL_V4_INGEST_SQL, PORTAL_SQLITE_V4_INGEST_SQL, portalSchemaChecksumV4, portalSchemaStatementsV4 } from '../src/db/portal-schema-v4.js'
import { PORTAL_MYSQL_V5_SQL, PORTAL_SQLITE_V5_SQL, PORTAL_SCHEMA_VERSION, PORTAL_SOURCE_COLUMN, portalSchemaChecksumV6, portalSchemaStatements } from '../src/db/portal-schema-v5.js'
import { closeAllMysqlBackends, openMysqlBackend } from '../src/db/mysql.js'
import { canonicalCheck } from '../src/db/portal-catalog.js'
import { ensurePortalReady } from '../src/db/portal-migrations.js'

const root = mkdtempSync(join(tmpdir(), 'atr-runtime-v5-'))
/** 仓库根：契约文件与子进程脚本都相对它定位（见文件头「与运行目录无关」）。 */
const repoRoot = resolve(import.meta.dir, '../../..')
afterAll(async () => { await closeAllMysqlBackends(); rmSync(root, { recursive: true, force: true }) })
const target = (): PortalTarget => ({ sqlitePath: join(root, `${randomUUID()}.sqlite`) })
const record = (id: string): IngestRecord => ({ event_id: id, session_id: '真实测试', seq: 1, ts: 100, provider: '', model: '', cwd: null, input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, reasoning_tokens: 2, turn: -1, step: -2 })
/** v3 老库的 MySQL 形态：只有老的 usage_event + `portal_meta.schema_version=3` + 诊断表。 */
const legacyDDL = `CREATE TABLE usage_event (event_id VARCHAR(255) NOT NULL PRIMARY KEY,session_id VARCHAR(255) NOT NULL,seq BIGINT NOT NULL,ts BIGINT NOT NULL,provider VARCHAR(255) NOT NULL,model VARCHAR(255) NOT NULL,cwd TEXT NULL,user_id VARCHAR(255) NULL,user_name VARCHAR(255) NULL,dept VARCHAR(255) NULL,input_tokens BIGINT NOT NULL DEFAULT 0,output_tokens BIGINT NOT NULL DEFAULT 0,cache_read_tokens BIGINT NOT NULL DEFAULT 0,cache_write_tokens BIGINT NOT NULL DEFAULT 0,reasoning_tokens BIGINT NOT NULL DEFAULT 0,turn INT NULL,step INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; CREATE TABLE portal_meta(id TINYINT PRIMARY KEY,schema_version INT NOT NULL); INSERT INTO portal_meta VALUES (1,3); ${PORTAL_MYSQL_V4_INGEST_SQL}`

/**
 * 造一个真 v3 老库（本机库 v3 与 portal v3 的 `usage_event` 同形）。
 *
 * ⚠️ `user_version=3` 是 **portal** 的版本号（迁移入口判定 legacy 的依据），
 *   与**本地库**的 `DB_SCHEMA_VERSION`（会随本地库结构变）**没有任何关系**。
 *   所以这里建完表后**显式**把它设成 3，而不是依赖 `ensureSchema()` 顺手写下的值 ——
 *   后者一升版本（P2 加 `source` 列时就是），这个夹具就会被判成「不是 legacy」，
 *   表现是三条迁移用例同时失败，而根因完全在别处。
 */
async function createLegacy(t: PortalTarget): Promise<void> {
  if (!t.mysqlUrl) { const db = openDb(t.sqlitePath); ensureSchema(db); db.exec('PRAGMA user_version=3'); db.close() }
  const store = await openRawPortalStore(t)
  try {
    if (t.mysqlUrl) await store.exec(legacyDDL)
    await store.exec("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ('历史:1','历史',1,100,'','','原姓名','原姓名','原部门',11,22,33,44,2,-1,-2)")
  } finally { await store.close() }
}

/**
 * 造一个**真正的 v4 库**（v4→v5 的起点），含 2 个分组、2 个人、3 条事件。
 *
 * ★ 两件必须自己补的事（已读 `portal-schema-v4.ts` 源码确认）：
 *   1. v4 的 statements **没有** `portal_schema_migrations` 的 version=4 行 ——
 *      文件里写明「迁移记录由执行器在核实 DDL 后写入真实 checksum；本文件不伪造迁移完成证据」；
 *   2. `portalSchemaStatementsV4()` 在拆句时会**过滤掉全部 PRAGMA**，
 *      所以 `user_version` 必须自己设。
 *   缺任何一件，`inspectStore` 都不会把它当 v4 完成态，构造出来的就不是「真 v4 库」。
 */
async function createV4Library(t: PortalTarget): Promise<{ groupA: string; groupB: string; memberA: string; memberB: string }> {
  const groupA = randomUUID(), groupB = randomUUID(), memberA = randomUUID(), memberB = randomUUID()
  const store = await openRawPortalStore(t)
  const kind = store.kind
  try {
    for (const sql of portalSchemaStatementsV4(kind)) await store.exec(sql)
    await store.exec(kind === 'mysql' ? PORTAL_MYSQL_V4_INGEST_SQL : PORTAL_SQLITE_V4_INGEST_SQL)
    await store.run("INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,4,$hash,'completed',1,$checkpoint,1,1)", { $id: randomUUID(), $hash: portalSchemaChecksumV4(kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) })
    // ★ 版本号写在两个后端各自的「版本位置」上：SQLite 是 `user_version`，MySQL 是 `portal_meta` 的 id=1 行
    //   （v4 的受控 SQL 里**没有** `portal_meta` —— 它由执行器的 `markVersion()` 建）。
    //   漏掉这一步，`readPortalState` 会读到 version=0，把库整个判成 `unsupported`，
    //   构造出来的就不是「可迁移的 v4 起点」。
    if (kind === 'sqlite') await store.exec('PRAGMA user_version=4')
    else {
      await store.exec('CREATE TABLE IF NOT EXISTS portal_meta (id TINYINT NOT NULL PRIMARY KEY,schema_version INT NOT NULL) ENGINE=InnoDB')
      await store.run('INSERT INTO portal_meta (id,schema_version) VALUES (1,4)', {})
    }
    await store.run("INSERT INTO departments (department_id,name,status,version,created_at_ms,updated_at_ms) VALUES ($id,'分组A','active',1,1,1)", { $id: groupA })
    await store.run("INSERT INTO departments (department_id,name,status,version,created_at_ms,updated_at_ms) VALUES ($id,'分组B','active',1,1,1)", { $id: groupB })
    // 甲属于分组 A；乙不属于任何分组（v5 迁移后必须仍然没有任何归属行）。
    // updated_at_ms=5 会被当成 `member_group_assignments.created_at_ms` 搬过去。
    await store.run("INSERT INTO members (member_id,display_name,department_id,status,version,created_at_ms,updated_at_ms) VALUES ($id,'甲',$group,'active',1,1,5)", { $id: memberA, $group: groupA })
    await store.run("INSERT INTO members (member_id,display_name,department_id,status,version,created_at_ms,updated_at_ms) VALUES ($id,'乙',NULL,'active',1,1,1)", { $id: memberB })
    // 3 条事件：两条带归属、一条纯历史；4 个 token 列刻意取可区分且能求和的值。
    const rows: [string, string, string, number, number, number, number, string, string | null, string | null][] = [
      ['v4:1', '会话A', '分组A', 11, 22, 33, 44, '甲', groupA, memberA],
      ['v4:2', '会话B', '分组B', 1, 2, 3, 4, '乙', groupB, memberB],
      ['v4:3', '会话C', '已取消的分组', 100, 200, 300, 400, '丙', null, null],
    ]
    for (const [id, session, dept, input, output, cacheRead, cacheWrite, user, departmentId, memberId] of rows) {
      await store.run("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step,member_id,department_id,report_token_id,received_at_ms) VALUES ($id,$session,1,100,'prov','mod',NULL,$user,$user,$dept,$input,$output,$cacheRead,$cacheWrite,2,-1,-2,$memberId,$departmentId,NULL,NULL)", { $id: id, $session: session, $dept: dept, $input: input, $output: output, $cacheRead: cacheRead, $cacheWrite: cacheWrite, $user: user, $memberId: memberId, $departmentId: departmentId })
    }
  } finally { await store.close() }
  return { groupA, groupB, memberA, memberB }
}

/**
 * MySQL 侧的事件指纹 —— 与下面的 `eventFingerprint` 同一套列与顺序，只是走异步 `PortalStore`。
 *
 * ★ 存在意义完全相同：迁移前后各算一次、**逐位相等**，才等价于「没有一条历史用量被改写」。
 *   `dept` / `group_name` 由调用方指定 —— 那是这次迁移里唯一改名的列。
 *   `BIGINT` 经驱动可能回 `bigint`，归一成字符串后再入哈希（与迁移内部同一处理）。
 */
async function mysqlFingerprint(store: PortalStore, snapshot: 'dept' | 'group_name'): Promise<{ hash: string; count: number }> {
  const columns = ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'user_id', 'user_name', snapshot, 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
  const rows = await store.all<Record<string, unknown>>(`SELECT ${columns.join(',')} FROM usage_event ORDER BY BINARY event_id`)
  const hash = createHash('sha256')
  for (const row of rows) hash.update(JSON.stringify(columns.map(name => typeof row[name] === 'bigint' ? String(row[name]) : row[name])) + '\n')
  return { hash: hash.digest('hex'), count: rows.length }
}

/**
 * 事件指纹：按精确 `event_id` 排序后，把每行的 13 个原始列拼成字符串做 sha256。
 *
 * ★ 快照列名由调用方显式给（v4 是 `dept`、v5 是 `group_name`）：除此之外**列名与顺序完全相同**，
 *   所以「迁移前后哈希逐位相等」等价于「每一行原始值都没被改写」。
 *   这里刻意不调用 `migratePortalDatabase` 内部的指纹 —— 校验必须能独立复算。
 */
function eventFingerprint(path: string, snapshot: 'dept' | 'group_name'): { hash: string; count: number } {
  const columns = ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'user_id', 'user_name', snapshot, 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
  const db = openDb(path)
  try {
    const rows = db.query<Record<string, unknown>>(`SELECT ${columns.join(',')} FROM usage_event ORDER BY event_id COLLATE BINARY`).all()
    const hash = createHash('sha256')
    for (const row of rows) hash.update(JSON.stringify(columns.map(name => row[name])) + '\n')
    return { hash: hash.digest('hex'), count: rows.length }
  } finally { db.close() }
}
/** 迁移留下的备份文件名（源库本身与 `.manifest.json` 都排除）。 */
function backupNames(t: PortalTarget, kind: 'v3' | 'v4'): string[] {
  return readdirSync(root).filter(name => name.startsWith(`${basename(t.sqlitePath)}.${kind}-backup-`) && name.endsWith('.sqlite'))
}
/** 备份的 sha256 必须与 manifest 里声明的相等 —— 否则「备份」只是个好听的文件名。 */
function readManifest(name: string): { sha256: string; historyCount: number; historyHash: string; target: string; path: string } {
  return JSON.parse(readFileSync(join(root, `${name}.manifest.json`), 'utf8')) as { sha256: string; historyCount: number; historyHash: string; target: string; path: string }
}
function sha256File(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
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
    // v5 的归属是 `member_id` + 关联表；`groupName` 只是上报当时的文本快照，必须原样落库。
    const owner = { userId: '姓名', userName: '姓名', groupName: '上报分组快照', ...ids, receivedAtMs: 1000 }
    expect(await insertAttributedRecords(store, [record('Key:1'), record('key:1'), record('Key:1 ')], owner)).toEqual({ inserted: 3, duplicates: 0 })
    expect(await insertAttributedRecords(store, [record('Key:1')], owner)).toEqual({ inserted: 0, duplicates: 1 })
    await expect(insertAttributedRecords(store, [record('rollback:first'), { ...record('rollback:bad'), input_tokens: -1 }], owner)).rejects.toThrow()
    expect(await store.get<Record<string, unknown>>("SELECT event_id FROM usage_event WHERE event_id='rollback:first'")).toBeNull()
    await expect(insertAttributedRecords(store, [record('bad-owner')], { ...owner, memberId: randomUUID() })).rejects.toThrow()
    await expect(store.transaction(async tx => { await insertAttributedRecordsInTransaction(tx, [record('outer-rollback')], owner); throw new Error('事务终止') })).rejects.toThrow('事务终止')
    expect(await store.get<Record<string, unknown>>("SELECT event_id FROM usage_event WHERE event_id='outer-rollback'")).toBeNull()
    await store.exec("UPDATE members SET display_name='新姓名',version=version+1,updated_at_ms=2")
    const row = await store.get<Record<string, unknown>>("SELECT * FROM usage_event WHERE event_id='Key:1'")
    expect(row?.member_id).toBe(ids.memberId)
    expect(row?.user_id).toBe('姓名')
    expect(row?.group_name).toBe('上报分组快照')
    expect([row?.input_tokens, row?.output_tokens, row?.cache_read_tokens, row?.cache_write_tokens].map(Number)).toEqual([11, 22, 33, 44])
    // 历史引用是 RESTRICT：删掉人员等于让历史归属断链，必须被数据库拒绝。
    await expect(store.run('DELETE FROM members WHERE member_id=$id', { $id: ids.memberId })).rejects.toThrow()
    const stores = await Promise.all(Array.from({ length: 6 }, () => openPortalStore(t)))
    try {
      const results = await Promise.all(stores.map((connection) => connection.transaction(async tx => {
        await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1')
        await new Promise(done => setTimeout(done, 2))
        return insertAttributedRecordsInTransaction(tx, [record('concurrent:1')], owner)
      })))
      expect(results.reduce((sum, value) => sum + value.inserted, 0)).toBe(1)
      expect(Number((await store.get<{ revision: number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(6)
    } finally { await Promise.all(stores.map(connection => connection.close())) }
    if (store.kind === 'mysql') await store.withConnection(async connection => {
      const first = await connection.get<{ id: number }>('SELECT CONNECTION_ID() AS id')
      await connection.transaction(async tx => { expect(await tx.get<Record<string, unknown>>('SELECT CONNECTION_ID() AS id')).toEqual(first) })
      expect(await connection.get<Record<string, unknown>>('SELECT CONNECTION_ID() AS id')).toEqual(first)
      const original = await connection.get<{ mode: string }>('SELECT @@SESSION.sql_mode AS mode')
      await connection.exec("SET SESSION sql_mode=''")
      try {
        await expect(connection.transaction(tx => insertAttributedRecordsInTransaction(tx, [record('x'.repeat(256))], owner))).rejects.toThrow('拒绝可能截断')
      } finally { await connection.run('SET SESSION sql_mode=$mode', { $mode: original!.mode }) }
    })
  } finally { await store.close() }
}

/**
 * 把一个刚建好的当前版本库**退回真实 v6 的形状**：删掉 v7 的表与账本行、
 * 删掉两条 v7 权限行、补一条 v6 账本行（checksum 用**冻结的 v6 摘要**）、
 * 把 `user_version` 设回 6。
 *
 * ★ 这就是现网「已经迁到 v6」的那些库的形状。用它才能验到 v7 新增的那条判定：
 *   `readPortalState()` 必须把它认成 `legacy`（可迁移的起点），而不是 `unsupported`
 *   —— 后者会让服务端拒绝启动、迁移脚本也拒绝接手，而 v7 明明只加一张表。
 *   不冻结 `portalSchemaChecksumV6` 就必定是这个下场。
 */
async function downgradeToV6(t: PortalTarget): Promise<void> {
  const store = await openRawPortalStore(t)
  const v7Permissions = ['00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000115']
  try {
    await store.exec('DROP TABLE model_price')
    await store.run(`DELETE FROM role_permissions WHERE permission_id IN ('${v7Permissions[0]}','${v7Permissions[1]}')`, {})
    await store.run(`DELETE FROM permissions WHERE permission_id IN ('${v7Permissions[0]}','${v7Permissions[1]}')`, {})
    await store.run('DELETE FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
    // ⚠️ 账本行必须补上：真实 v6 库的那一行是当时的程序写的，
    //   少了它这个库就是「结构在、账本不在」的半初始化态，那是另一种（不可迁移的）形状。
    await store.run("INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,6,$hash,'completed',1,$checkpoint,1,1)", { $id: randomUUID(), $hash: portalSchemaChecksumV6('sqlite'), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) })
    await store.exec('PRAGMA user_version=6')
  } finally { await store.close() }
}

test('v5 运行时 SQL 与设计契约逐字一致，v4 基线仍逐字冻结', () => {
  expect(PORTAL_SQLITE_V5_SQL).toBe(readFileSync(join(repoRoot, 'docs/database-v5/schema.sqlite.sql'), 'utf8'))
  expect(PORTAL_MYSQL_V5_SQL).toBe(readFileSync(join(repoRoot, 'docs/database-v5/schema.mysql.sql'), 'utf8'))
  // 冻结基线：v4 的文本摘要就是「这个库是不是完整 v4」的判据，改一个字都会让旧库失去可迁移起点。
  expect(PORTAL_SQLITE_V4_SQL).toBe(readFileSync(join(repoRoot, 'docs/database-v4/schema.sqlite.sql'), 'utf8'))
  expect(PORTAL_MYSQL_V4_SQL).toBe(readFileSync(join(repoRoot, 'docs/database-v4/schema.mysql.sql'), 'utf8'))
})
test('SQLite 新库 v11、FULL、26 表及旧诊断表', async () => {
  const t = target()
  const info = await preparePortalDatabase(t)
  expect(info.status).toBe('current')
  expect(info.version).toBe(PORTAL_SCHEMA_VERSION)
  // ★ v11 = v10 的 25 张表 + `project_alias`（v9 / v10 都只改既有表，不建表）。
  //   ⚠️ 这个数字是**结构**断言，加表时必须跟着改；它不是版本号，
  //   所以不适用「断言一律对着 PORTAL_SCHEMA_VERSION」那条规矩。
  expect(info.tables.length).toBe(26)
  expect(info.tables).toContain('member_groups')
  expect(info.tables).toContain('member_group_assignments')
  expect(info.tables).toContain('provider_alias')
  expect(info.tables).toContain('model_price')
  // ★ v11：项目归一化规则表（只引用 members，与 provider_alias 同一形状）。
  expect(info.tables).toContain('project_alias')
  // ★ v8：汇总表是**性能设施**，四张表必须一起到位（查询层按它们是否存在决定路由）。
  expect(info.tables).toContain('usage_rollup_day')
  expect(info.tables).toContain('usage_rollup_hour')
  expect(info.tables).toContain('usage_rollup_hod')
  expect(info.tables).toContain('usage_rollup_meta')
  expect(info.tables).not.toContain('departments')
  const store = await openPortalStore(t)
  expect(await store.get<Record<string, unknown>>('PRAGMA synchronous')).toEqual({ synchronous: 2 })
  expect(await store.get<Record<string, unknown>>('SELECT initialized_at_ms FROM portal_identity_state')).toEqual({ initialized_at_ms: null })
  await store.close()
  await verifyWrites(t)
})
test('★ v8 汇总表建好即空、且建表不改任何事实表（迁移只增表）', async () => {
  const t = target()
  await preparePortalDatabase(t)
  // 先落两条真实事件：纯追加迁移必须**一条都不改写**。
  const seed = await openPortalStore(t)
  try {
    await insertAttributedRecords(seed, [record('v8:1'), record('v8:2')], { userId: '姓名', userName: '姓名', groupName: '分组快照', ...(await addMember(seed)), receivedAtMs: 1000 })
    // ★ 迁移建的是**空表**：灌历史归 `syncRollups()`（它要扫全表，不该塞进迁移事务）。
    for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod', 'usage_rollup_meta']) {
      const row = await seed.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)
      expect(row?.c, `${table} 迁移后必须是空表`).toBe(0)
    }
  } finally { await seed.close() }
})
test('SQLite v6 库是可迁移起点：只追加 model_price 与两条权限码，事实表逐位不变', async () => {
  const t = target()
  await preparePortalDatabase(t)
  // 先落两条真实事件：纯追加迁移必须**一条都不改写**。
  const seed = await openPortalStore(t)
  try {
    await insertAttributedRecords(seed, [record('v6:1'), record('v6:2')], { userId: '姓名', userName: '姓名', groupName: '分组快照', ...(await addMember(seed)), receivedAtMs: 1000 })
  } finally { await seed.close() }
  const before = eventFingerprint(t.sqlitePath, 'group_name')
  await downgradeToV6(t)

  // ★ 核心断言：v6 库必须被认成「结构完整的上一版、可原地迁移」。
  const state = await inspectPortalDatabase(t)
  expect(state.status).toBe('legacy')
  expect(state.version).toBe(6)
  expect(state.tables).not.toContain('model_price')

  const migrated = await migratePortalDatabase(t)
  expect(migrated.status).toBe('current')
  expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
  expect(migrated.eventCount).toBe(before.count)
  // 纯追加：历史用量逐位不变（这就是「只存单价、绝不存金额」换来的性质）。
  expect(eventFingerprint(t.sqlitePath, 'group_name')).toEqual(before)

  const after = await openRawPortalStore(t)
  try {
    expect(await after.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='model_price'")).toEqual({ name: 'model_price' })
    // ★ 唯一索引必须在位 —— 这正是迁移路径曾经整个漏掉的东西（见 `isCreateIndex()`）。
    expect((await after.all<{ name: string; unique: number; origin: string }>('PRAGMA index_list(model_price)')).filter(row => row.origin === 'c').map(row => `${row.name}:${row.unique}`).sort()).toEqual(['idx_model_price_span:1', 'idx_model_price_target:0'])
    // 两条权限码补齐；`pricing:manage` 只授给内置管理员，而 `cost:read` 自 **v13** 起
    // **也**授给内置 `member` —— appKey 的固定范围含 `cost:read`，而「一份凭证能做什么
    // = 角色权限 ∩ 凭证 scopes」，不授这一条，普通成员连一条 appKey 都签不出来。
    expect(await after.all<{ code: string }>("SELECT code FROM permissions WHERE code LIKE 'cost:%' OR code LIKE 'pricing:%' ORDER BY code")).toEqual([{ code: 'cost:read' }, { code: 'pricing:manage' }])
    expect(await after.all<{ role_id: string; permission_id: string }>("SELECT role_id,permission_id FROM role_permissions WHERE permission_id IN ('00000000-0000-4000-8000-000000000114','00000000-0000-4000-8000-000000000115') ORDER BY permission_id,role_id")).toEqual([
      { role_id: '00000000-0000-4000-8000-000000000001', permission_id: '00000000-0000-4000-8000-000000000114' },
      { role_id: '00000000-0000-4000-8000-000000000002', permission_id: '00000000-0000-4000-8000-000000000114' },
      { role_id: '00000000-0000-4000-8000-000000000001', permission_id: '00000000-0000-4000-8000-000000000115' },
    ])
    // 账本：一条未完成的都不许有，v6 那一行的 checksum 必须**仍是冻结的 v6 摘要**
    // （历史账本一经 completed 就不该被改写 —— 它是「当时确实迁到了 v6」的证据）。
    const ledger = await after.all<{ version: number; status: string; checksum: string }>('SELECT version,status,checksum FROM portal_schema_migrations ORDER BY version')
    expect(ledger.map(row => `${row.version}:${row.status}`)).toEqual([`5:completed`, `6:completed`, `${PORTAL_SCHEMA_VERSION}:completed`])
    expect(ledger.find(row => row.version === 6)!.checksum).toBe(portalSchemaChecksumV6('sqlite'))
  } finally { await after.close() }
})
test('SQLite 多连接同时首次启动只初始化一次', async () => {
  const t = target()
  const prepared = await Promise.all(Array.from({ length: 6 }, () => preparePortalDatabase(t)))
  expect(prepared.every(result => result.status === 'current')).toBe(true)
})
test('业务版本闸门不扫描事件历史，显式检查仍返回真实条数且不缓存迁移状态', async () => {
  const t = target(), store = await openPortalStore(t)
  try {
    await insertAttributedRecords(store, [record('gate:1'), record('gate:2')], { userId: '姓名' })
    // 在真实数据库上阻断历史扫描，避免依赖机器速度的计时断言掩盖复杂度回退。
    const guarded = new Proxy(store, {
      get(current, key) {
        const value: unknown = Reflect.get(current, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const sql = args[0]
          if (typeof sql === 'string' && (/\bFROM\s+usage_event\b/i.test(sql) || /PRAGMA\s+foreign_key_check/i.test(sql))) {
            throw new Error('业务版本闸门不能扫描用量历史')
          }
          return Reflect.apply(value, current, args)
        }
      },
    })
    await ensurePortalReady(guarded)
    expect((await inspectPortalDatabase(t)).eventCount).toBe(2)
    expect((await preparePortalDatabase(t)).eventCount).toBe(2)
    // ★ 把**当前版本**的账本行标成失败：闸门必须按账本（而不是版本号）判定
    //   「这个库是半迁移状态」。写成 `version=5` 在 v6 之后会失去意义 ——
    //   那条行是历史遗留，改它不会影响当前版本的判定。
    await store.exec(`UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=${PORTAL_SCHEMA_VERSION}`)
    await expect(ensurePortalReady(guarded)).rejects.toThrow('incomplete')
  } finally { await store.close() }
})
test('启动与显式迁移仍拒绝历史外键损坏，业务新写入仍强制外键', async () => {
  const t = target(), store = await openPortalStore(t)
  try {
    await expect(insertAttributedRecords(store, [record('invalid:new')], { userId: '姓名', memberId: randomUUID() })).rejects.toThrow()
    // 仅在随机测试库模拟外部工具关闭外键后留下的历史坏引用。
    await store.exec('PRAGMA foreign_keys=OFF')
    await store.run("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,member_id) VALUES ('invalid:historical','历史',1,1,'','',$member)", { $member: randomUUID() })
  } finally { await store.close() }
  await expect(preparePortalDatabase(t)).rejects.toThrow('外键不一致')
  await expect(migratePortalDatabase(t)).rejects.toThrow('外键不一致')
  expect((await inspectPortalDatabase(t)).eventCount).toBe(1)
})
test('SQLite 未迁移的 v4 库直接 openPortalStore 必须抛版本错，不能自愈', async () => {
  const t = target()
  await createV4Library(t)
  // v4 是**可迁移的起点**而不是坏库：闸门要说清状态与版本，并把人指向显式迁移入口。
  await expect(openPortalStore(t)).rejects.toThrow(/上报库状态 legacy，版本 4/)
  // 闸门只读：拒绝之后库必须还是 v4，不能被顺手改一版。
  const after = await inspectPortalDatabase(t)
  expect(after.version).toBe(4)
  expect(after.status).toBe('legacy')
  expect(after.tables).toContain('departments')
})
test('SQLite v4→v5：分组改名、归属搬进关联表、权限码保 ID、备份可验、事件指纹逐位不变', async () => {
  const t = target()
  const { groupA, memberA } = await createV4Library(t)
  // 起点确认：真 v4 库、21 列事实表（含 dept 与 department_id）、members 仍有 department_id。
  const before = await inspectPortalDatabase(t)
  expect(before.status).toBe('legacy')
  expect(before.version).toBe(4)
  const beforeFingerprint = eventFingerprint(t.sqlitePath, 'dept')
  const raw = await openRawPortalStore(t)
  const beforeEventColumns = (await raw.all<{ name: string }>('PRAGMA table_info(usage_event)')).map(row => row.name)
  expect(beforeEventColumns).toHaveLength(21)
  expect(beforeEventColumns).toContain('dept')
  expect(beforeEventColumns).toContain('department_id')
  expect((await raw.all<{ name: string }>('PRAGMA table_info(members)')).map(row => row.name)).toContain('department_id')
  // 权限 id 必须实测记录：硬要求是「改名不改 ID」，照抄常量证明不了这一点。
  const v4Permissions = await raw.all<{ code: string; permission_id: string }>("SELECT code,permission_id FROM permissions WHERE code LIKE 'departments:%' ORDER BY code")
  await raw.close()
  expect(v4Permissions).toEqual([
    { code: 'departments:manage', permission_id: '00000000-0000-4000-8000-000000000111' },
    { code: 'departments:read', permission_id: '00000000-0000-4000-8000-000000000110' },
  ])

  const migrated = await migratePortalDatabase(t, { confirmOffline: true })

  // a. 版本与状态推进到 v5，事件条数一条不少。
  expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
  expect(migrated.status).toBe('current')
  expect(migrated.eventCount).toBe(before.eventCount)
  const after = await openRawPortalStore(t)
  try {
    // b. 表改名：member_groups / member_group_assignments 在位，departments 消失。
    const tables = (await after.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name)
    expect(tables).toContain('member_groups')
    expect(tables).toContain('member_group_assignments')
    expect(tables).not.toContain('departments')
    // c. `members.department_id` 被搬到关联表：恰好一行 (甲, 分组A)，乙没有任何行。
    //    created_at_ms 取迁移前的 members.updated_at_ms，保留「何时入组」的历史。
    expect(await after.all('SELECT member_id,group_id,created_at_ms FROM member_group_assignments')).toEqual([{ member_id: memberA, group_id: groupA, created_at_ms: 5 }])
    // d. 单值分组列两处都被删掉，快照列改名 group_name。
    expect((await after.all<{ name: string }>('PRAGMA table_info(members)')).map(row => row.name)).not.toContain('department_id')
    const eventColumns = (await after.all<{ name: string }>('PRAGMA table_info(usage_event)')).map(row => row.name)
    // v5 的受控定义是 20 列；**v9 又加了 `source`**（这条用量是哪个客户端写的），
    // 所以 v4→当前版本的迁移终态是 21 列。这个数字是刻意的门槛：
    // 多一列少一列都要有人回来看一眼（列数对得上但列定义不对由后面的逐列核对拦）。
    expect(eventColumns).toHaveLength(21)
    expect(eventColumns).toContain('source')
    expect(eventColumns).not.toContain('department_id')
    expect(eventColumns).not.toContain('dept')
    expect(eventColumns).toContain('group_name')
    // e. 快照列的值必须逐行等于迁移前 dept 的值（改名不是重写）。
    expect(await after.all('SELECT event_id,group_name FROM usage_event ORDER BY event_id')).toEqual([
      { event_id: 'v4:1', group_name: '分组A' },
      { event_id: 'v4:2', group_name: '分组B' },
      { event_id: 'v4:3', group_name: '已取消的分组' },
    ])
    // f. 权限码改名而 ID 不变；`departments:*` 一条都不许剩。
    expect(await after.all<{ code: string; permission_id: string }>("SELECT code,permission_id FROM permissions WHERE code LIKE 'groups:%' OR code LIKE 'departments:%' ORDER BY code")).toEqual([
      { code: 'groups:manage', permission_id: v4Permissions[0]!.permission_id },
      { code: 'groups:read', permission_id: v4Permissions[1]!.permission_id },
    ])
    expect(Number((await after.get<{ c: number }>("SELECT COUNT(*) AS c FROM permissions WHERE code LIKE 'departments:%'"))?.c)).toBe(0)
    // ★ 受控索引必须**逐条**在位，包括唯一索引。
    //   🚨 这一条抓的是一个真实缺口：`ensureIndex()` 与它的调用点早先只认 `CREATE INDEX`，
    //   于是 `CREATE UNIQUE INDEX idx_provider_alias_member` 在**任何迁移路径里都没被
    //   执行过**（只有全新库的建库路径会整条 exec）。后果是同一个版本号下，
    //   「迁移来的库」与「新建的库」索引集不同 —— SQLite 侧完全看不出来
    //   （verifyCurrent 对 SQLite 只比对表定义文本），而 MySQL 侧会在最后一步
    //   `verifyCurrent` 判「表 provider_alias 的唯一约束与主键不一致」，
    //   表现成「迁移做完了却不算成功」。所以这里两边都显式钉住。
    expect((await after.all<{ name: string; unique: number; origin: string }>('PRAGMA index_list(provider_alias)')).filter(row => row.origin === 'c').map(row => `${row.name}:${row.unique}`).sort()).toEqual(['idx_provider_alias_alias:0', 'idx_provider_alias_member:1', 'idx_provider_alias_scope:0'])
    expect((await after.all<{ name: string; unique: number; origin: string }>('PRAGMA index_list(model_price)')).filter(row => row.origin === 'c').map(row => `${row.name}:${row.unique}`).sort()).toEqual(['idx_model_price_span:1', 'idx_model_price_target:0'])
  } finally { await after.close() }

  // g. 备份：一份 .v4-backup-*.sqlite + 同名 manifest；manifest.sha256 必须与文件实际值相等。
  const backups = backupNames(t, 'v4')
  expect(backups.length).toBe(1)
  const backupName = backups[0]!
  const manifest = readManifest(backupName)
  expect(manifest.sha256).toBe(sha256File(join(root, backupName)))
  expect(manifest.historyCount).toBe(before.eventCount)
  expect(manifest.target).toBe(describePortalTarget(t))
  // 迁移账本里的检查点必须指回**同一份**备份与同一个历史计数：
  // 否则「resume 时比对指纹」这句话就没有可信的起点（manifest 与 checkpoint 各说各话）。
  const ledger = await openRawPortalStore(t)
  const checkpoint = JSON.parse((await ledger.get<{ checkpoint_json: string }>('SELECT checkpoint_json FROM portal_schema_migrations WHERE version=5'))!.checkpoint_json) as { backup: { path: string; sha256: string }; historyHash: string; historyCount: number }
  await ledger.close()
  expect(checkpoint.backup.sha256).toBe(manifest.sha256)
  expect(checkpoint.backup.path).toBe(manifest.path)
  expect(checkpoint.historyCount).toBe(manifest.historyCount)
  expect(checkpoint.historyHash).toBe(manifest.historyHash)
  // 备份必须是**迁移前**的真实快照：仍有 departments、user_version 仍是 4。
  const backupDb = openDb(join(root, backupName))
  expect(backupDb.query('PRAGMA user_version').get()).toEqual({ user_version: 4 })
  expect(backupDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('departments','member_groups')").all()).toEqual([{ name: 'departments' }])
  backupDb.close()

  // ★ 逐位指纹：唯一能证明「没有一条历史用量被改写」的断言。
  const afterFingerprint = eventFingerprint(t.sqlitePath, 'group_name')
  expect(afterFingerprint.count).toBe(beforeFingerprint.count)
  expect(afterFingerprint.hash).toBe(beforeFingerprint.hash)

  // h. 迁移后的库能被业务入口正常打开，并按 v5 语义（含 groupName 快照）写入。
  const store = await openPortalStore(t)
  try {
    const ids = await addMember(store)
    expect(await insertAttributedRecords(store, [record('v5:new')], { userId: '甲', userName: '甲', groupName: '新快照分组', ...ids, receivedAtMs: 1000 })).toEqual({ inserted: 1, duplicates: 0 })
    expect(await store.get<Record<string, unknown>>('SELECT group_name,member_id,report_token_id,received_at_ms FROM usage_event WHERE event_id=\'v5:new\'')).toEqual({ group_name: '新快照分组', member_id: ids.memberId, report_token_id: ids.tokenId, received_at_ms: 1000 })
  } finally { await store.close() }
  // i. 幂等/resume：再迁一次不抛错，版本、事件数与指纹都不变（新增那条也不许被改写）。
  const stable = eventFingerprint(t.sqlitePath, 'group_name')
  const resumed = await migratePortalDatabase(t, { resume: true, confirmOffline: true })
  expect(resumed.version).toBe(PORTAL_SCHEMA_VERSION)
  expect(resumed.status).toBe('current')
  expect(resumed.eventCount).toBe(stable.count)
  expect(eventFingerprint(t.sqlitePath, 'group_name').hash).toBe(stable.hash)
}, 20_000)
test('SQLite v4→v5 清空全部补偿触发器，事实表由真实复合外键兜底', async () => {
  const t = target()
  await createV4Library(t)
  const raw = await openRawPortalStore(t)
  // 与 v3→v4 迁移生成的第三支补偿触发器同形：**建在 report_tokens 上、body 引用 usage_event**。
  // 重建事实表时它会让 `ALTER TABLE ... RENAME` 报 `no such table: main.usage_event`。
  await raw.exec("CREATE TRIGGER usage_v4_token_owner_update BEFORE UPDATE OF member_id ON report_tokens WHEN NEW.member_id<>OLD.member_id AND EXISTS (SELECT 1 FROM usage_event WHERE report_token_id=OLD.token_id) BEGIN SELECT RAISE(ABORT,'usage_event historical token owner is immutable'); END")
  await raw.close()
  expect((await migratePortalDatabase(t, { confirmOffline: true })).status).toBe('current')
  const after = await openRawPortalStore(t)
  // v5 的事实表带真正的复合外键，触发器全部清掉 —— 残留的补偿触发器会与真实外键重复判定，
  // 而且它们引用的可能是「旧表名/旧列名」，留着只会让下一次重建更难。
  expect(await after.all("SELECT name FROM sqlite_master WHERE type='trigger'")).toEqual([])
  await after.close()
}, 20_000)
test('SQLite v3→v5 一次迁移：两份备份、token 四列逐位保留、迁移后无触发器', async () => {
  const t = target()
  await createLegacy(t)
  const before = await inspectPortalDatabase(t)
  expect(before.version).toBe(3)
  expect(before.status).toBe('legacy')
  const beforeFingerprint = eventFingerprint(t.sqlitePath, 'dept')
  const migrated = await migratePortalDatabase(t, { confirmOffline: true })
  expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
  expect(migrated.status).toBe('current')
  expect(migrated.eventCount).toBe(before.eventCount)
  const raw = await openRawPortalStore(t)
  try {
    // 历史事件逐位保留：迁移是「加列 + 换快照列名」，绝不重建事件值。
    expect(await raw.get<Record<string, unknown>>('SELECT user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,member_id,received_at_ms FROM usage_event')).toEqual({ user_id: '原姓名', user_name: '原姓名', group_name: '原部门', input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, member_id: null, received_at_ms: null })
    // v3→v4 的补偿触发器在 v5 阶段必须被清空（理由见上一条用例）。
    expect(await raw.all("SELECT name FROM sqlite_master WHERE type='trigger'")).toEqual([])
    // 账本三行：v4 基线、v5 终态、v6 终态各自 completed。
    // ★ v5 那一行是**本次迁移补写的**：这台机器上可能还有旧版本进程，
    //   它认的「当前版本」是 5（见 upgradeV4ToV5 里的注释）。
    expect(await raw.all('SELECT version,status FROM portal_schema_migrations ORDER BY version')).toEqual([{ version: 4, status: 'completed' }, { version: 5, status: 'completed' }, { version: PORTAL_SCHEMA_VERSION, status: 'completed' }])
  } finally { await raw.close() }
  expect(eventFingerprint(t.sqlitePath, 'group_name').hash).toBe(beforeFingerprint.hash)
  // 两个版本步骤各留一份恢复点：v3→v4 那份与 v4→v5 那份，缺一不可（唯一副本没有第二个回退位）。
  const v3Backups = backupNames(t, 'v3'), v4Backups = backupNames(t, 'v4')
  expect(v3Backups.length).toBe(1)
  expect(v4Backups.length).toBe(1)
  for (const name of [...v3Backups, ...v4Backups]) {
    const manifest = readManifest(name)
    expect(manifest.sha256).toBe(sha256File(join(root, name)))
    expect(manifest.historyCount).toBe(before.eventCount)
  }
  // 两份备份各是**它那一步之前**的真实快照：v3 备份没有 departments，v4 备份有。
  const v3Backup = openDb(join(root, v3Backups[0]!))
  expect(v3Backup.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
  expect(v3Backup.query("SELECT name FROM sqlite_master WHERE type='table' AND name='departments'").all()).toEqual([])
  v3Backup.close()
  const v4Backup = openDb(join(root, v4Backups[0]!))
  expect(v4Backup.query('PRAGMA user_version').get()).toEqual({ user_version: 4 })
  expect(v4Backup.query("SELECT name FROM sqlite_master WHERE type='table' AND name='departments'").all()).toEqual([{ name: 'departments' }])
  v4Backup.close()
}, 20_000)
test('SQLite v3 默认拒绝，显式备份迁移保持事件/待确认历史映射', async () => {
  const t = target(); await createLegacy(t)
  await expect(openPortalStore(t)).rejects.toThrow('唯一副本')
  expect((await inspectPortalDatabase(t)).version).toBe(3)
  await expect(migratePortalDatabase(t)).rejects.toThrow('confirm-offline')
  const backup = join(root, `${randomUUID()}.backup.sqlite`)
  expect((await migratePortalDatabase(t, { confirmOffline: true, sqliteBackupPath: backup })).status).toBe('current')
  const db = openDb(backup)
  expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 }); db.close()
  const store = await openPortalStore(t)
  expect(await store.get<Record<string, unknown>>('SELECT user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,member_id,received_at_ms FROM usage_event')).toEqual({ user_id: '原姓名', user_name: '原姓名', group_name: '原部门', input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, member_id: null, received_at_ms: null })
  // 待确认历史留在 legacy_attribution_map：v5 不把旧姓名自动映射成稳定人员。
  expect(await store.get<Record<string, unknown>>('SELECT status,member_id FROM legacy_attribution_map')).toEqual({ status: 'pending', member_id: null })
  const ids = await addMember(store)
  await expect(insertAttributedRecords(store, [record('mismatched')], { userId: '姓名', tokenId: ids.tokenId, memberId: randomUUID() })).rejects.toThrow()
  await store.close()
  // 已是 current 时再迁一次是「核对」而不是「重写」。
  expect((await migratePortalDatabase(t)).status).toBe('current')
}, 20_000)
test('SQLite 超长原始事件预检阻止迁移且不改写', async () => {
  const t = target(); await createLegacy(t)
  const db = openDb(t.sqlitePath); db.query('UPDATE usage_event SET event_id=$id').run({ $id: 'x'.repeat(256) }); db.close()
  await expect(migratePortalDatabase(t, { confirmOffline: true })).rejects.toThrow('不会截断')
  expect((await inspectPortalDatabase(t)).status).toBe('legacy')
})
test('SQLite 旧表大小写折叠主键在迁移前拒绝，不能将不同事件ACK为重复', async () => {
  const t = target(), db = openDb(t.sqlitePath)
  db.exec("CREATE TABLE usage_event(event_id TEXT PRIMARY KEY COLLATE NOCASE); INSERT INTO usage_event VALUES('Case:1'); PRAGMA user_version=3")
  db.close()
  await expect(migratePortalDatabase(t, { confirmOffline: true })).rejects.toThrow('精确 BINARY')
  expect((await inspectPortalDatabase(t)).eventCount).toBe(1)
  expect((await inspectPortalDatabase(t)).tables).toEqual(['usage_event'])
})
test('SQLite 已标记 v5 却缺表时拒绝自愈', async () => {
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
    // v5 的事实表只剩 members / report_tokens 两支外键，去掉其中一支必须被拒绝。
    (sql: string) => sql.replace(/  FOREIGN KEY \(member_id\) REFERENCES members\(member_id\)[^\n]*\n/, ''),
    (sql: string) => sql.replace('input_tokens BETWEEN 0 AND', 'input_tokens BETWEEN -1 AND'),
    (sql: string) => sql.replace('received_at_ms BETWEEN 0 AND', 'received_at_ms BETWEEN -1 AND'),
  ]
  for (const change of changes) {
    const t = target(), store = await openPortalStore(t)
    await insertAttributedRecords(store, [record('history-safe')], { userId: '姓名' }); await store.close()
    // Bun SQLite 防御模式禁止改 sqlite_master；仅在本测试的随机副本构造损坏结构。
    // 生产闸门随后必须只拒绝，不能自动修补这张已带历史的表。
    const db = openDb(t.sqlitePath)
    const before = db.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='usage_event'").get()!.sql
    const after = change(before); expect(after).not.toBe(before)
    db.exec('ALTER TABLE usage_event RENAME TO usage_event_fixture_old')
    db.exec(after)
    db.exec('INSERT INTO usage_event SELECT * FROM usage_event_fixture_old; DROP TABLE usage_event_fixture_old')
    db.close()
    // v5 的 `verifyCurrent` 对**每一张表**都按受控定义逐字比对（v4 时代事实表是例外），
    // 所以 SQLite 上这三处改写统一落在那句目录不一致的报文上；MySQL 侧仍是更细的外键/CHECK 报文。
    await expect(openPortalStore(t)).rejects.toThrow(/usage_event 的 CHECK\/外键\/唯一约束与受控定义不一致|实际外键|CHECK 实际定义/)
    const raw = await openRawPortalStore(t)
    expect(await raw.get<Record<string, unknown>>('SELECT event_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_event')).toEqual({ event_id: 'history-safe', input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44 })
    await raw.close()
  }
}, 20_000)
test('SQLite INSERT被触发器静默忽略时不能确认投递', async () => {
  const t = target(), store = await openPortalStore(t)
  try {
    await store.exec("CREATE TRIGGER test_silent_ignore BEFORE INSERT ON usage_event WHEN NEW.event_id='silent-ignore' BEGIN SELECT RAISE(IGNORE); END")
    await expect(insertAttributedRecords(store, [record('batch-first'), record('silent-ignore')], { userId: '测试' })).rejects.toThrow('拒绝确认投递')
    expect(await store.get<Record<string, unknown>>('SELECT event_id FROM usage_event')).toBeNull()
  } finally { await store.close() }
})
test('SQLite 跨进程写锁异步重试不阻塞事件循环，杀进程回滚未提交数据', async () => {
  const t = target(); await preparePortalDatabase(t)
  const source = pathToFileURL(join(repoRoot, 'packages/core/src/db/portal-db.ts')).href
  const childPath = join(root, `${randomUUID()}.ts`)
  writeFileSync(childPath, `import {openPortalStore} from ${JSON.stringify(source)}; const s=await openPortalStore(${JSON.stringify(t)}); await s.transaction(async tx=>{await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1'); console.log('LOCKED'); await new Promise(r=>setTimeout(r,300));}); await s.close();`)
  const child = Bun.spawn([process.execPath, childPath], { stdout: 'pipe', stderr: 'pipe' })
  const reader = child.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('LOCKED')
  const store = await openPortalStore(t)
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 20)
  await store.transaction(async tx => { await tx.exec('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1') })
  clearTimeout(timer)
  expect(heartbeat).toBe(true)
  expect(await child.exited).toBe(0)
  expect(Number((await store.get<{ revision: number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(2)
  writeFileSync(childPath, `import {openPortalStore} from ${JSON.stringify(source)}; const s=await openPortalStore(${JSON.stringify(t)}); await s.transaction(async tx=>{await tx.exec('UPDATE portal_identity_state SET revision=99 WHERE singleton_key=1'); console.log('LOCKED'); await new Promise(r=>setTimeout(r,30000));});`)
  const killed = Bun.spawn([process.execPath, childPath], { stdout: 'pipe', stderr: 'pipe' })
  expect(new TextDecoder().decode((await killed.stdout.getReader().read()).value)).toContain('LOCKED')
  killed.kill(); await killed.exited
  expect(Number((await store.get<{ revision: number }>('SELECT revision FROM portal_identity_state'))?.revision)).toBe(2)
  await store.close()
}, 10_000)

describe.skipIf(!process.env.ATR_V4_TEST_MYSQL_URL)('真实隔离 MySQL v5', () => {
  async function isolated(fn: (t: PortalTarget) => Promise<void>): Promise<void> {
    const adminUrl = process.env.ATR_V4_TEST_MYSQL_URL!
    const admin = await openMysqlBackend(adminUrl)
    const schema = `atr_runtime_v5_${Date.now()}_${randomUUID().slice(0, 8)}`
    if (!/^atr_runtime_v5_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
    const url = new URL(adminUrl); url.pathname = `/${schema}`
    let created = false
    try { await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); created = true; await fn({ sqlitePath: 'unused', mysqlUrl: url.href }) }
    finally { await closeAllMysqlBackends(); if (created) await admin.exec(`DROP DATABASE ${schema}`); await admin.close() }
  }
  test('空库真实建表、四列保留、精确幂等、回滚、同连接事务及并发', async () => isolated(async t => {
    const first = preparePortalDatabase(t)
    await new Promise(done => setTimeout(done, 30))
    const initialized = await Promise.all([first, ...Array.from({ length: 3 }, () => preparePortalDatabase(t))])
    expect(initialized.every(result => result.status === 'current')).toBe(true)
    await verifyWrites(t)
  }), 30_000)
  test('第一条 CREATE ledger 已提交但还没写检查点时仍可显式 resume', async () => isolated(async t => {
    const raw = await openRawPortalStore(t)
    await raw.exec(portalSchemaStatements('mysql').find(sql => sql.startsWith('CREATE TABLE portal_schema_migrations ('))!)
    await raw.close()
    expect((await inspectPortalDatabase(t)).status).toBe('incomplete')
    await expect(openPortalStore(t)).rejects.toThrow('incomplete')
    await expect(migratePortalDatabase(t)).rejects.toThrow('resume')
    expect((await migratePortalDatabase(t, { resume: true })).status).toBe('current')
  }), 30_000)
  test('current/resume 拒绝事实 FK 缺失、同名错误 CHECK 和 NOT ENFORCED，保留历史', async () => isolated(async t => {
    const raw = await openPortalStore(t)
    await insertAttributedRecords(raw, [record('history-safe')], { userId: '姓名' })
    // v5 的 usage_event 没有 department_id 外键，改挑「member_id → members」这一支单列外键。
    // 复合外键 `(member_id,report_token_id) → report_tokens` 也含 member_id 列，所以必须按被引用表区分。
    const foreign = await raw.get<{ name: string }>("SELECT constraint_name AS name FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='usage_event' AND column_name='member_id' AND referenced_table_name='members' AND referenced_column_name='member_id'")
    await raw.exec(`ALTER TABLE usage_event DROP FOREIGN KEY ${foreign!.name}`)
    await expect(openPortalStore(t)).rejects.toThrow('实际外键')
    await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${foreign!.name} FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT`)
    for (const column of ['input_tokens', 'received_at_ms']) {
      const checks = await raw.all<{ name: string; clause: string }>("SELECT c.constraint_name AS name,c.check_clause AS clause FROM information_schema.check_constraints c JOIN information_schema.table_constraints t ON t.constraint_schema=c.constraint_schema AND t.constraint_name=c.constraint_name WHERE t.table_schema=DATABASE() AND t.table_name='usage_event' AND t.constraint_type='CHECK'")
      const check = checks.find(row => row.clause.includes('`' + column + '`'))!
      await raw.exec(`ALTER TABLE usage_event DROP CHECK ${check.name}`)
      const correct = check.clause.replace(/\\'/g, "'")
      await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${check.name} CHECK (${correct.replace('between 0 and', 'between -1 and')})`)
      await expect(openPortalStore(t)).rejects.toThrow('CHECK 实际定义')
      await raw.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=5")
      await expect(migratePortalDatabase(t, { resume: true })).rejects.toThrow('CHECK 实际定义')
      await raw.exec(`ALTER TABLE usage_event DROP CHECK ${check.name}`)
      await raw.exec(`ALTER TABLE usage_event ADD CONSTRAINT ${check.name} CHECK (${correct}) NOT ENFORCED`)
      await expect(migratePortalDatabase(t, { resume: true })).rejects.toThrow('执行状态')
      await raw.exec(`ALTER TABLE usage_event ALTER CHECK ${check.name} ENFORCED`)
      expect((await migratePortalDatabase(t, { resume: true })).status).toBe('current')
    }
    expect(await raw.get<Record<string, unknown>>('SELECT event_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_event')).toEqual({ event_id: 'history-safe', input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44 })
    await raw.close()
  }), 30_000)
  test('v3 非事务存储引擎在任何迁移写入之前拒绝，防止假回滚', async () => isolated(async t => {
    await createLegacy(t)
    const raw = await openRawPortalStore(t)
    // MyISAM 的索引字节上限更低；缩短隔离夹具主键后才能构造非事务表。
    await raw.exec('ALTER TABLE usage_event MODIFY COLUMN event_id VARCHAR(200) NOT NULL')
    await raw.exec('ALTER TABLE usage_event ENGINE=MyISAM')
    await expect(migratePortalDatabase(t, { confirmOffline: true })).rejects.toThrow('InnoDB')
    const info = await inspectPortalDatabase(t)
    expect(info.status).toBe('legacy'); expect(info.eventCount).toBe(1)
    expect(info.tables.includes('portal_schema_migrations')).toBe(false)
    await raw.close()
  }), 30_000)
  test('v4→v5 真实迁移：分组改名保 ID、归属进关联表、快照逐位不变、resume 幂等', async () => isolated(async t => {
    const ids = await createV4Library(t)
    await expect(openPortalStore(t)).rejects.toThrow(/上报库状态 legacy，版本 4/)
    const raw = await openRawPortalStore(t)
    // ★ 迁移前先记下指纹与权限 ID：指纹此刻按 `dept` 算，迁移后要按 `group_name` 复算并逐位比对。
    const before = await mysqlFingerprint(raw, 'dept')
    // 指纹必须真的覆盖到那 3 条事件 —— 否则「前后逐位相等」会退化成 0 条对 0 条的空洞断言。
    expect(before.count).toBe(3)
    const v4Permissions = await raw.all<{ code: string; permission_id: string }>("SELECT code,permission_id FROM permissions WHERE code LIKE 'departments:%' ORDER BY code")
    expect(v4Permissions.map(row => row.code)).toEqual(['departments:manage', 'departments:read'])
    const backup = join(root, `${randomUUID()}.mysql-v4-backup.json`)
    const dump: Record<string, unknown> = {}
    for (const table of ['usage_event', 'members', 'departments', 'portal_meta', 'ingest_run']) dump[table] = { ddl: await raw.get<Record<string, unknown>>(`SHOW CREATE TABLE ${table}`), rows: await raw.all(`SELECT * FROM ${table}`) }
    await raw.close()
    writeFileSync(backup, JSON.stringify(dump, null, 2))
    const proof = { path: backup, sha256: sha256File(backup), target: describePortalTarget(t) }
    // 证明与目标库对不上、或 SHA256 不符时必须在动手之前拒绝。
    await expect(migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: { ...proof, sha256: '0'.repeat(64) } })).rejects.toThrow('SHA256')
    expect((await migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')

    const store = await openPortalStore(t)
    try {
      // a. 分组目录是**同 ID 改名**：主键与名字都不许变。
      expect(await store.all('SELECT group_id,name FROM member_groups ORDER BY name')).toEqual([
        { group_id: ids.groupA, name: '分组A' }, { group_id: ids.groupB, name: '分组B' }])
      // b. 单值归属搬进关联表；没有归属的人**一行都不该有**（绝不能给人硬塞一个分组）。
      //    `created_at_ms` 取迁移前的 `members.updated_at_ms`，保留「何时入组」的历史。
      const assignments = await store.all<{ member_id: string; group_id: string; created_at_ms: unknown }>('SELECT member_id,group_id,created_at_ms FROM member_group_assignments')
      expect(assignments.map(row => ({ member_id: row.member_id, group_id: row.group_id, created_at_ms: Number(row.created_at_ms) }))).toEqual([
        { member_id: ids.memberA, group_id: ids.groupA, created_at_ms: 5 }])
      // c. 两个单值列都被删掉，快照列改名后**值逐行不变**（改名不是重写）。
      const memberColumns = (await store.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='members'")).map(row => row.name)
      expect(memberColumns).not.toContain('department_id')
      const eventColumns = (await store.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")).map(row => row.name)
      // ★ 21 列 = v5 的 20 列 + v9 的 `source`（迁移链一路走到当前版本）。
      //   ⚠️ 这条与 SQLite 分支那一条是**两个方言各一份**：只改一处时，
      //   `bun test`（没有 MySQL 连接时整段 skip）全绿，而真实 MySQL 上必炸
      //   （2026-10-03 实测：Received length: 21）。
      expect(eventColumns).toHaveLength(21)
      expect(eventColumns).not.toContain('department_id')
      expect(eventColumns).not.toContain('dept')
      expect(eventColumns).toContain('group_name')
      expect(eventColumns).toContain(PORTAL_SOURCE_COLUMN)
      expect(await store.all('SELECT event_id,group_name FROM usage_event ORDER BY BINARY event_id')).toEqual([
        { event_id: 'v4:1', group_name: '分组A' },
        { event_id: 'v4:2', group_name: '分组B' },
        { event_id: 'v4:3', group_name: '已取消的分组' }])
      // d. 权限码改名而**权限 ID 不动** —— 已签发令牌的 scopes 与角色授权都指向 ID。
      expect(await store.all<{ code: string; permission_id: string }>("SELECT code,permission_id FROM permissions WHERE code LIKE 'groups:%' OR code LIKE 'departments:%' ORDER BY code")).toEqual([
        { code: 'groups:manage', permission_id: v4Permissions[0]!.permission_id },
        { code: 'groups:read', permission_id: v4Permissions[1]!.permission_id }])
      expect(Number((await store.get<{ c: number }>("SELECT COUNT(*) AS c FROM permissions WHERE code LIKE 'departments:%'"))?.c)).toBe(0)
    } finally { await store.close() }

    // e. ★ 逐位指纹：唯一能证明「没有一条历史用量被改写」的断言。
    const check = await openRawPortalStore(t)
    const after = await mysqlFingerprint(check, 'group_name')
    await check.close()
    expect(after.count).toBe(before.count)
    expect(after.hash).toBe(before.hash)

    // f. resume 幂等：带着同一份证明再迁一次，版本与指纹都不许变。
    expect((await migratePortalDatabase(t, { resume: true, confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')
    const again = await openRawPortalStore(t)
    expect(await mysqlFingerprint(again, 'group_name')).toEqual(after)
    await again.close()
  }), 60_000)
  test('v3 真实备份证明、显式迁移、原始字段指纹与 pending 归属', async () => isolated(async t => {
    await createLegacy(t)
    await expect(openPortalStore(t)).rejects.toThrow('唯一副本')
    const raw = await openRawPortalStore(t)
    const backup = join(root, `${randomUUID()}.mysql-backup.json`)
    const dump: Record<string, unknown> = {}
    for (const table of ['usage_event', 'portal_meta', 'ingest_run']) dump[table] = { ddl: await raw.get<Record<string, unknown>>(`SHOW CREATE TABLE ${table}`), rows: await raw.all(`SELECT * FROM ${table}`) }
    await raw.close()
    writeFileSync(backup, JSON.stringify(dump, null, 2))
    const proof = { path: backup, sha256: sha256File(backup), target: describePortalTarget(t) }
    await expect(migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: { ...proof, sha256: '0'.repeat(64) } })).rejects.toThrow('SHA256')
    expect((await migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')
    const store = await openPortalStore(t)
    expect(await store.get<Record<string, unknown>>('SELECT status,member_id FROM legacy_attribution_map')).toEqual({ status: 'pending', member_id: null })
    expect(Number((await store.get<{ count: number }>('SELECT COUNT(*) AS count FROM usage_event'))?.count)).toBe(1)
    await store.close()
    const tampered = await openRawPortalStore(t)
    const count = await tampered.get<Record<string, unknown>>('SELECT COUNT(*) AS c FROM usage_event')
    // v3→v5 的 MySQL 路径不重建事实表，所以 v4 阶段显式命名的 `fk_usage_v4_member` 仍在。
    await tampered.exec('ALTER TABLE usage_event DROP FOREIGN KEY fk_usage_v4_member')
    await expect(openPortalStore(t)).rejects.toThrow('实际外键')
    await tampered.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=5")
    await expect(migratePortalDatabase(t, { resume: true, confirmOffline: true, mysqlBackupProof: proof })).rejects.toThrow('实际外键')
    expect(await tampered.get<Record<string, unknown>>('SELECT COUNT(*) AS c FROM usage_event')).toEqual(count)
    expect(await tampered.get("SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='usage_event' AND constraint_name='fk_usage_v4_member'")).toBeNull()
    await tampered.exec('ALTER TABLE usage_event ADD CONSTRAINT fk_usage_v4_member FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE RESTRICT ON UPDATE RESTRICT')
    expect((await migratePortalDatabase(t, { resume: true, confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')
    await tampered.close()
    await verifyWrites(t)
  }), 30_000)
  test('v5 目标表已被同名坏表占住时只允许显式 resume，核对已完成 catalog 并保留检查点', async () => isolated(async t => {
    await createLegacy(t)
    const raw = await openRawPortalStore(t)
    // 模拟上一轮 v5 迁移在「departments → member_groups」改名阶段崩过：
    // 目标名已被一张**非受控定义**的表占住。v3→v4 阶段不受影响，卡点在 v5。
    await raw.exec('CREATE TABLE member_groups (broken INT)')
    const backup = join(root, `${randomUUID()}.mysql-backup.json`)
    const dump: Record<string, unknown> = {}
    for (const table of ['usage_event', 'portal_meta', 'ingest_run', 'member_groups']) dump[table] = { ddl: await raw.get<Record<string, unknown>>(`SHOW CREATE TABLE ${table}`), rows: await raw.all(`SELECT * FROM ${table}`) }
    writeFileSync(backup, JSON.stringify(dump, null, 2))
    const proof = { path: backup, sha256: sha256File(backup), target: describePortalTarget(t) }
    await expect(migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: proof })).rejects.toThrow(/member_groups/)
    expect((await inspectPortalDatabase(t)).status).toBe('incomplete')
    await expect(openPortalStore(t)).rejects.toThrow('incomplete')
    await expect(migratePortalDatabase(t, { confirmOffline: true, mysqlBackupProof: proof })).rejects.toThrow('resume')
    await raw.exec('DROP TABLE member_groups')
    expect((await migratePortalDatabase(t, { resume: true, confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')
    // 模拟提交种子后进程终止；恢复时不能再次插入或覆盖管理员已有权限。
    const before = await raw.get<{ last_completed_step: number }>('SELECT last_completed_step FROM portal_schema_migrations WHERE version=5')
    await raw.exec("UPDATE portal_schema_migrations SET status='failed',completed_at_ms=NULL WHERE version=5")
    expect((await migratePortalDatabase(t, { resume: true, confirmOffline: true, mysqlBackupProof: proof })).status).toBe('current')
    expect(await raw.get<{ last_completed_step: number }>('SELECT last_completed_step FROM portal_schema_migrations WHERE version=5')).toEqual(before)
    expect(Number((await raw.get<{ count: number }>('SELECT COUNT(*) AS count FROM roles'))?.count)).toBe(2)
    await raw.close()
  }), 30_000)
})