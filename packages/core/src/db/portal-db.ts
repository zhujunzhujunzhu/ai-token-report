/** 上报库 v5 门面：业务入口强制版本闸门，旧库只能通过显式迁移保留历史升级。 */
import type { Database } from './driver.js'
import { openRawPortalSqlite, type PortalTarget, type PortalStore } from './portal-connection.js'
import { openScopedPortalStore } from './portal-scope.js'
import { ensurePortalSqliteReady } from './portal-migrations.js'
export { resolvePortalTarget, describePortalTarget, redactMysqlUrl } from './portal-connection.js'
export type { PortalTarget, PortalStore } from './portal-connection.js'
export { portalDialect } from './dialect.js'
export type { PortalBackendKind, PortalDialect } from './dialect.js'
export { PORTAL_SCHEMA_VERSION } from './portal-schema-v5.js'
// ★ v9 的**来源**维度常量：脚本 / 验证要按列名核对结构时必须有单一真源，
//   各自手写 `'source'` 的话，写错的表现是「断言永远成立」而不是失败。
export { PORTAL_SOURCE_COLUMN, PORTAL_SOURCE_DEFAULT } from './portal-schema-v5.js'
// ★ v8 的对外交付面：**表名清单**与**冻结的 v7 摘要**。
//   它们要能被「迁移/回滚脚本」与「验证脚本」拿到 —— 让调用方自己去
//   `portal-schema-v8.ts` 里抄一份表名，就等于多了一处会漂移的定义
//   （漏一张表的表现是「回滚之后库仍被判成 current」，而它不会报错）。
export { PORTAL_V8_TABLES, ROLLUP_HOUR_RETAIN_DAYS, rollupTimezoneKey } from './portal-schema-v8.js'
export { portalSchemaChecksumV7 } from './portal-schema-v5.js'
export { inspectPortalDatabase, migratePortalDatabase, preparePortalDatabase } from './portal-migrations.js'
export type { PortalInspection, PortalMigrationOptions } from './portal-migrations.js'
// ★ 请求作用域（性能）：一次 HTTP 请求里 `openPortalStore()` 可能被调 2~4 次
//   （鉴权一次 + 业务一次 + 归一化规则若干），每次都重跑一遍版本闸门。
//   `withPortalStoreScope()` 让它们复用同一个已过闸门的 store。
//   ⚠️ 它**不是** TTL 缓存：作用域 = 一个请求，改结构后下一个请求立刻拒绝。
export { withPortalStoreScope, inPortalStoreScope } from './portal-scope.js'

/** 同步入口只兼容测试/已有造数调用；不会迁移旧 v3。 */
export function openPortalSqlite(path: string): Database {
  const db = openRawPortalSqlite(path)
  try { ensurePortalSqliteReady(db); return db }
  catch (error) { try { db.close() } catch { /* 保留原始错误 */ } throw error }
}

/**
 * 业务入口：开库 + 强制版本闸门。
 *
 * ★ 若当前处在 `withPortalStoreScope()` 里，复用作用域内那个**已过闸门**的
 *   store（见 `portal-scope.ts`：一个请求要开 2~4 次库，每次重跑闸门是纯浪费）。
 *   **没有作用域时行为与引入它之前逐字相同** —— CLI / 单测 / 迁移器都不开作用域。
 */
export async function openPortalStore(target: PortalTarget): Promise<PortalStore> {
  return await openScopedPortalStore(target)
}
