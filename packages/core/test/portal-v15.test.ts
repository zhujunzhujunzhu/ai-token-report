/** v14→v15 纯追加迁移、断点恢复、受控失效触发器；事实行保持原值。 */
import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPortalStore, inspectPortalDatabase, migratePortalDatabase, type PortalTarget } from '../src/db/portal-db.js'
import { openRawPortalStore } from '../src/db/portal-connection.js'
import { portalSchemaChecksumV14, PORTAL_SCHEMA_VERSION } from '../src/db/portal-schema-v5.js'
import { CUBE_TRIGGER_NAMES, PORTAL_V15_TABLES, CUBE_HOUR_INDEX, cubeHourIndexSql, portalV15TableStatements, portalV15TriggerStatements } from '../src/db/portal-schema-v15.js'
import { openMysqlBackend, closeAllMysqlBackends } from '../src/db/mysql.js'

const root = mkdtempSync(join(tmpdir(), 'atr-v15-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']
for (const kind of ['sqlite', 'mysql'] as const) (kind === 'mysql' && !mysqlUrl ? test.skip : test)(`${kind}：真实 v14 可迁移；事实不改写；半状态 resume；触发器被删立即拒绝`, async () => {
  const schema = `atr_v15_${Date.now()}_${randomUUID().slice(0, 8)}`
  const admin = kind === 'mysql' ? await openMysqlBackend(mysqlUrl!) : undefined
  const url = kind === 'mysql' ? new URL(mysqlUrl!) : undefined
  if (admin && url) { await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); url.pathname = '/' + schema }
  const target: PortalTarget = { sqlitePath: join(root, `${schema}.sqlite`), ...(url ? { mysqlUrl: url.href } : {}) }
  try {
    let store = await openPortalStore(target)
    await store.exec("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ('fact','session',1,100,'p','m',11,22,33,44)")
    const facts = await store.all('SELECT * FROM usage_event')
    for (const name of CUBE_TRIGGER_NAMES) await store.exec(`DROP TRIGGER ${name}`)
    for (const name of PORTAL_V15_TABLES) await store.exec(`DROP TABLE ${name}`)
    await store.exec(`DROP INDEX idx_usage_event_recent${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await store.exec(`DROP INDEX ${CUBE_HOUR_INDEX}${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await store.run('UPDATE portal_schema_migrations SET version=14,checksum=$checksum', { $checksum: portalSchemaChecksumV14(kind) })
    await store.exec(kind === 'sqlite' ? 'PRAGMA user_version=14' : 'UPDATE portal_meta SET schema_version=14 WHERE id=1')
    await store.close()
    expect((await inspectPortalDatabase(target)).status).toBe('legacy')
    expect((await inspectPortalDatabase(target)).version).toBe(14)
    await expect(openPortalStore(target)).rejects.toThrow('legacy')
    await migratePortalDatabase(target, { confirmOffline: true })
    expect((await inspectPortalDatabase(target)).version).toBe(PORTAL_SCHEMA_VERSION)
    store = await openPortalStore(target)
    if (kind === 'mysql') {
      await store.exec(`ALTER TABLE usage_event ALTER INDEX ${CUBE_HOUR_INDEX} INVISIBLE`)
      await store.close()
      await expect(openPortalStore(target)).rejects.toThrow(CUBE_HOUR_INDEX)
      const visibleRepair = await openRawPortalStore(target)
      await visibleRepair.exec(`ALTER TABLE usage_event ALTER INDEX ${CUBE_HOUR_INDEX} VISIBLE`)
      await visibleRepair.close()
      store = await openPortalStore(target)
    }
    expect(await store.all('SELECT * FROM usage_event')).toEqual(facts)
    // 尾部补查必须有受控小时索引；同名但错误的表达式也不能放过。
    await store.exec(`DROP INDEX ${CUBE_HOUR_INDEX}${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await store.close()
    await expect(openPortalStore(target)).rejects.toThrow(CUBE_HOUR_INDEX)
    const badIndex = await openRawPortalStore(target)
    await badIndex.exec(cubeHourIndexSql(kind).replace('3600000', '3600001'))
    await badIndex.close()
    await expect(openPortalStore(target)).rejects.toThrow(CUBE_HOUR_INDEX)
    const indexRepair = await openRawPortalStore(target)
    await indexRepair.exec(`DROP INDEX ${CUBE_HOUR_INDEX}${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await indexRepair.exec(cubeHourIndexSql(kind))
    await indexRepair.close()
    store = await openPortalStore(target)
    // 运行中的触发器不能靠下次后台全量 COUNT 才发现丢失。
    await store.exec('DROP TRIGGER usage_cube_insert')
    await store.close()
    await expect(openPortalStore(target)).rejects.toThrow('usage_cube_insert')
    // 完成态被篡改时 resume 也必须拒绝，不把坏结构冒充未完成迁移。
    await expect(migratePortalDatabase(target, { confirmOffline: true, resume: true })).rejects.toThrow('usage_cube_insert')
    const repair = await openRawPortalStore(target)
    await repair.exec(portalV15TriggerStatements(kind)[0]!)
    await repair.close()
    await migratePortalDatabase(target, { confirmOffline: true, resume: true })
    store = await openPortalStore(target)
    expect(await store.all('SELECT * FROM usage_event')).toEqual(facts)
    await store.close()
    // 派生表在、索引还没建的半状态由同一迁移器恢复。
    const raw = await openRawPortalStore(target)
    for (const name of CUBE_TRIGGER_NAMES) await raw.exec(`DROP TRIGGER ${name}`)
    for (const name of PORTAL_V15_TABLES) await raw.exec(`DROP TABLE ${name}`)
    await raw.exec(`DROP INDEX idx_usage_event_recent${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await raw.exec(`DROP INDEX ${CUBE_HOUR_INDEX}${kind === 'mysql' ? ' ON usage_event' : ''}`)
    await raw.exec(`DELETE FROM portal_schema_migrations WHERE version=${PORTAL_SCHEMA_VERSION}`)
    await raw.exec(kind === 'sqlite' ? 'PRAGMA user_version=14' : 'UPDATE portal_meta SET schema_version=14 WHERE id=1')
    await raw.exec(portalV15TableStatements(kind)[0]!)
    await raw.close()
    await migratePortalDatabase(target, { confirmOffline: true, resume: true })
    store = await openPortalStore(target)
    expect(await store.all('SELECT * FROM usage_event')).toEqual(facts)
    await store.close()
  } finally {
    if (admin) { await closeAllMysqlBackends(); await admin.exec(`DROP DATABASE ${schema}`); await admin.close() }
  }
}, 60000)
