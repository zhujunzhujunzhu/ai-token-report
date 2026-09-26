/** 上报库 v4 门面：业务入口强制版本闸门，旧库只能通过显式迁移保留历史升级。 */
import type { Database } from './driver.js'
import { openRawPortalSqlite, openRawPortalStore, type PortalTarget, type PortalStore } from './portal-connection.js'
import { ensurePortalReady, ensurePortalSqliteReady } from './portal-migrations.js'
export { resolvePortalTarget, describePortalTarget, redactMysqlUrl } from './portal-connection.js'
export type { PortalTarget, PortalStore } from './portal-connection.js'
export { portalDialect } from './dialect.js'
export type { PortalBackendKind, PortalDialect } from './dialect.js'
export { PORTAL_SCHEMA_VERSION } from './portal-schema-v4.js'
export { inspectPortalDatabase, migratePortalDatabase, preparePortalDatabase } from './portal-migrations.js'
export type { PortalInspection, PortalMigrationOptions } from './portal-migrations.js'

/** 同步入口只兼容测试/已有造数调用；不会迁移旧 v3。 */
export function openPortalSqlite(path: string): Database {
  const db = openRawPortalSqlite(path)
  try { ensurePortalSqliteReady(db); return db }
  catch (error) { try { db.close() } catch { /* 保留原始错误 */ } throw error }
}

export async function openPortalStore(target: PortalTarget): Promise<PortalStore> {
  const store = await openRawPortalStore(target)
  try { await ensurePortalReady(store); return store }
  catch (error) { await store.close(); throw error }
}
