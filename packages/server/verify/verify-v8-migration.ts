/**
 * v7 → v8（→ 当前版本）迁移与**回滚**的专项验证（真 MySQL + 真 SQLite）。
 *
 * ```bash
 * bun run packages/server/verify/verify-v8-migration.ts
 * ```
 *
 * ## 为什么单独验这一件事
 *
 * v8 是**纯追加**（只加四张表），所以风险不在「改坏数据」，而在三处
 * **只有真实迁移路径才会暴露**的东西：
 *
 * 1. **v7 库必须仍被认成 `legacy`（可迁移起点）**，而不是 `unsupported`。
 *    这取决于 `portalSchemaChecksumV7()` 是否被正确冻结 —— 少了它，
 *    线上那个 v7 库会**拒绝启动**（`bun run typecheck` 与 SQLite 单测都看不出来）。
 * 2. **迁移只增表**：`usage_event` 的事件指纹必须逐位不变。
 * 3. **回滚路径真的能用**：删掉四张表 ⇒ 库变成 `legacy`（结构是 v7，可再迁回来）
 *    ⇒ 再迁一次又回到当前版本。这决定了「上线后发现不对能不能退」。
 *
 * ⚠️ **版本断言一律对着 `PORTAL_SCHEMA_VERSION`，绝不写死 8**：v9 落地时这里曾把
 *   `version === 8` 写死，于是「迁移明明成功、版本已经是 9」被判成失败 ——
 *   一条会因为**加了新版本**而误报的断言，比没有断言更糟。这条链现在天然覆盖
 *   `v7 → v8 → v9` 的连续升级（以及两轮回滚-再迁移）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeAllMysqlBackends,
  inspectPortalDatabase,
  migratePortalDatabase,
  openPortalStore,
  preparePortalDatabase,
  PORTAL_SCHEMA_VERSION,
  PORTAL_SOURCE_COLUMN,
  PORTAL_V8_TABLES,
  portalSchemaChecksumV7,
  type PortalTarget,
} from '@ai-token-report/core/db'
// ⚠️ `openRawPortalStore` **刻意不经 `core/db` 的根入口**导出（业务代码不该用它，
//    它绕过版本闸门）。这里要它只是为了「迁移前直接读事实表算指纹」，
//    所以按**相对路径**精确导入 core 的那个模块（包 exports 没有暴露它）。
import { openRawPortalStore } from '../../core/src/db/portal-connection.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, extra = ''): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

/** 事件指纹：迁移前后必须逐位相同（抄 `portal-v5.test.ts` 的做法）。 */
async function fingerprint(target: PortalTarget): Promise<string> {
  const store = await openRawPortalStore(target)
  try {
    const rows = await store.all<Record<string, unknown>>(
      'SELECT event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM usage_event ORDER BY event_id')
    const hash = createHash('sha256')
    for (const row of rows) hash.update(JSON.stringify(row) + '\n')
    return hash.digest('hex')
  } finally { await store.close() }
}

/**
 * `usage_event.source` 必须**恰好一份**（v9 的加列在多次迁移、多轮回滚之后
 * 都不许重复添加 —— 重复列的表现是「这条断言失败」，而不是某个查询悄悄错）。
 */
async function hasSingleSourceColumn(target: PortalTarget): Promise<boolean> {
  const store = await openRawPortalStore(target)
  try {
    const columns = store.kind === 'sqlite'
      ? await store.all<{ name: string }>('PRAGMA table_info(usage_event)')
      : await store.all<{ name: string }>(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'")
    return columns.filter(column => column.name === PORTAL_SOURCE_COLUMN).length === 1
  } finally { await store.close() }
}

/** 把一个 v8 库降级成 v7 形态：删掉四张汇总表 + v8 账本行 + 版本标记。 */
async function downgradeToV7(target: PortalTarget): Promise<void> {
  const store = await openRawPortalStore(target)
  try {
    for (const table of PORTAL_V8_TABLES) await store.exec(`DROP TABLE ${table}`)
    // 🚨 **删掉「v7 以上」的全部账本行**（不是只删 v8 那一行）。
    //   只删 v8 时：当前版本是 v9，那条 v9 账本行还留着 ⇒ 判定逻辑里的 `current` 仍为真
    //   ⇒ 库被判成 `unsupported`（而不是 `legacy`），整条回滚路径当场失效。
    //   实测（2026-10-03，v9 落地后首次跑本脚本）：`{"status":"unsupported","version":7}`。
    await store.exec('DELETE FROM portal_schema_migrations WHERE version > 7')
    // 🚨 **版本标记也必须一起退回去**：SQLite 是 `PRAGMA user_version`、
    //   MySQL 是 `portal_meta.schema_version`。只删账本行而留着版本 8，
    //   `readPortalState()` 会得到「version=8 但没有 v8 账本行」⇒ `unsupported`
    //   （实测就是我第一版踩到的：报「不支持迁移版本 8」）。
    await store.exec(target.mysqlUrl ? 'UPDATE portal_meta SET schema_version = 7 WHERE id = 1' : 'PRAGMA user_version = 7')
    // 账本里的 v7 摘要要写回**冻结的那一份**，否则 v7 库的身份不成立。
    // ⚠️ 先删再插：升级路径自己也会补一条 v7 账本行（为了让还在跑旧版本的进程
    //   能认这个库），所以第二次降级时会撞 `version` 的唯一约束
    //   （实测 `UNIQUE constraint failed: portal_schema_migrations.version`）。
    await store.run('DELETE FROM portal_schema_migrations WHERE version = 7')
    await store.run(
      `INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms)
       VALUES ($id,7,$hash,'completed',1,$checkpoint,$now,$now)`,
      { $id: randomUUID(), $hash: portalSchemaChecksumV7(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 5, historyHash: '', historyCount: 0 }), $now: Date.now() },
    )
  } finally { await store.close() }
}

// ── SQLite 分支 ─────────────────────────────────────────────────────────────
console.log('\n【SQLite】')
{
  const dir = mkdtempSync(join(tmpdir(), 'atr-v8-migrate-'))
  const target: PortalTarget = { sqlitePath: join(dir, 'portal.sqlite') }
  try {
    await preparePortalDatabase(target)
    // 落两条真实事件：纯追加迁移必须一条都不改写
    const store = await openPortalStore(target)
    try {
      await store.run(
        `INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,received_at_ms)
         VALUES ('m:1','m',0,1000,'p','m',1,2,3,4,5,1000),('m:2','m',1,2000,'p','m',6,7,8,9,10,2000)`)
    } finally { await store.close() }
    const before = await fingerprint(target)

    await downgradeToV7(target)
    const downgraded = await inspectPortalDatabase(target)
    check('降级后的库被认成 v7 的可迁移起点（legacy）', downgraded.status === 'legacy', JSON.stringify({ status: downgraded.status, version: downgraded.version }))
    check('降级后确实没有 v8 的表', !downgraded.tables.includes('usage_rollup_day'))

    const migrated = await migratePortalDatabase(target)
    check('v7 → v8 → 当前版本 迁移成功', migrated.status === 'current' && migrated.version === PORTAL_SCHEMA_VERSION, JSON.stringify({ status: migrated.status, version: migrated.version }))
    check('迁移后四张 v8 表都在', PORTAL_V8_TABLES.every(table => migrated.tables.includes(table)))
    check('★ 迁移只增表：事件指纹逐位不变', (await fingerprint(target)) === before)
    const after = await openPortalStore(target)
    try {
      const row = await after.get<{ c: number }>('SELECT COUNT(*) AS c FROM usage_rollup_day')
      check('迁移建的是空表（灌历史归 syncRollups）', Number(row?.c) === 0)
    } finally { await after.close() }
    // ★ v9 的幂等护栏在这条链上也会被压到：降级只删了 v8 的四张表，
    //   而 `usage_event.source` 早在建库时就有了 ⇒ 再迁一次时
    //   `upgradeV8ToV9` 面对的是「列已存在」的库，必须照常收尾（不能重复加列）。
    check('★ 迁移链跑完仍是当前版本（v9 的加列幂等）', (await inspectPortalDatabase(target)).version === PORTAL_SCHEMA_VERSION)
    check('★ 库里的 source 列只有一份', await hasSingleSourceColumn(target))

    // 回滚：再删一次四张表 → 又能被认成 legacy 并再迁回来
    await downgradeToV7(target)
    const again = await inspectPortalDatabase(target)
    check('★ 回滚（删四张表）后仍可再迁回来', again.status === 'legacy')
    const remigrated = await migratePortalDatabase(target)
    check('再迁一次又回到当前版本', remigrated.status === 'current' && remigrated.version === PORTAL_SCHEMA_VERSION)
    check('★ 回滚-再迁移两轮之后事件指纹仍然不变', (await fingerprint(target)) === before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ── MySQL 分支（同一套断言，走真 MySQL）────────────────────────────────────
const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']
if (!mysqlUrl) {
  console.log('\n【MySQL】跳过：没有 ATR_V4_TEST_MYSQL_URL')
} else {
  console.log('\n【MySQL】')
  const { createIsolatedMysql } = await import('./mysql-isolation.js')
  const isolation = await createIsolatedMysql()
  const target: PortalTarget = { sqlitePath: '/tmp/unused.sqlite', mysqlUrl: isolation.url }
  try {
    await preparePortalDatabase(target)
    const store = await openPortalStore(target)
    try {
      await store.run(
        `INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,received_at_ms)
         VALUES ('m:1','m',0,1000,'p','m',1,2,3,4,5,1000),('m:2','m',1,2000,'p','m',6,7,8,9,10,2000)`)
    } finally { await store.close() }
    const before = await fingerprint(target)

    await downgradeToV7(target)
    const downgraded = await inspectPortalDatabase(target)
    check('MySQL：降级后被认成 v7 的可迁移起点', downgraded.status === 'legacy', JSON.stringify({ status: downgraded.status, version: downgraded.version }))

    const migrated = await migratePortalDatabase(target)
    check('MySQL：v7 → v8 → 当前版本 迁移成功', migrated.status === 'current' && migrated.version === PORTAL_SCHEMA_VERSION, JSON.stringify({ status: migrated.status, version: migrated.version }))
    check('MySQL：四张 v8 表都在', PORTAL_V8_TABLES.every(table => migrated.tables.includes(table)))
    check('★ MySQL：迁移只增表，事件指纹逐位不变', (await fingerprint(target)) === before)
    check('★ MySQL：v9 的 source 列只有一份（加列幂等）', await hasSingleSourceColumn(target))
    // MySQL 侧的索引核对最容易漏（受控 DDL 里 `CREATE INDEX` 是独立语句）
    const after = await openPortalStore(target)
    try {
      const indexes = await after.all<{ name: string }>(
        "SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='usage_rollup_day'")
      check('MySQL：idx_rollup_day_member 被真的建出来了（独立 CREATE INDEX 语句）',
        indexes.some(row => row.name === 'idx_rollup_day_member'), JSON.stringify(indexes.map(row => row.name)))
      check('MySQL：usage_rollup_day 的主键索引存在', indexes.some(row => String(row.name).toUpperCase() === 'PRIMARY'))
    } finally { await after.close() }
  } finally {
    await closeAllMysqlBackends()
    await isolation.dispose()
  }
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 项通过 / ${failed} 项失败`)
if (failed > 0) process.exit(1)
