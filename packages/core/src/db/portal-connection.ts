/** 上报库连接层：不创建表，供版本闸门与显式迁移共同使用。 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createSqliteDatabase, type Database } from './driver.js'
import type { PortalBackendKind } from './dialect.js'
import { sharedMysqlBackend, type MysqlBackend } from './mysql.js'

export interface PortalTarget { sqlitePath: string; mysqlUrl?: string }
export interface PortalStore {
  readonly kind: PortalBackendKind
  readonly label: string
  all<Row = unknown>(sql: string, params?: Record<string, unknown>): Promise<Row[]>
  get<Row = unknown>(sql: string, params?: Record<string, unknown>): Promise<Row | null>
  run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }>
  exec(sql: string): Promise<void>
  transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T>
  withConnection<T>(fn: (connection: PortalStore) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function resolvePortalTarget(input: { sqlitePath: string; mysqlUrl?: string | undefined }): PortalTarget {
  return { sqlitePath: input.sqlitePath, ...(input.mysqlUrl ? { mysqlUrl: input.mysqlUrl } : {}) }
}
export function redactMysqlUrl(url: string): string {
  try { const parsed = new URL(url); if (parsed.password) parsed.password = '***'; return parsed.href }
  catch { return 'MySQL (连接地址无效)' }
}
export function describePortalTarget(target: PortalTarget): string {
  if (!target.mysqlUrl) return target.sqlitePath
  try { const url = new URL(target.mysqlUrl); return `MySQL ${url.pathname.slice(1) || '(未指定库)'} @ ${url.hostname}:${url.port || '3306'}` }
  catch { return 'MySQL (连接地址无效)' }
}

// 同一路径的多个门面共享队列；不能只锁单个连接，否则 await 期间第二个请求会阻塞整个线程。
const queues = new Map<string, Promise<void>>()
async function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((done) => { release = done })
  queues.set(key, current)
  await previous
  try { return await fn() }
  finally { release(); if (queues.get(key) === current) queues.delete(key) }
}
function busy(error: unknown): boolean {
  const value = error as { code?: string; message?: string }
  return value?.code === 'SQLITE_BUSY' || value?.code === 'SQLITE_LOCKED' || /database is (locked|busy)/i.test(value?.message ?? '')
}
async function retryBusy<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + 15_000
  let delay = 5
  for (;;) {
    try { return fn() }
    catch (error) {
      if (!busy(error) || Date.now() >= deadline) throw error
      await new Promise((done) => setTimeout(done, delay))
      delay = Math.min(100, delay * 2)
    }
  }
}

/** 上报库独立使用 FULL；本地可重建库的 NORMAL 设置不受影响。 */
export function openRawPortalSqlite(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = createSqliteDatabase(path)
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    return db
  } catch (error) { db.close(); throw error }
}

export class SqlitePortalStore implements PortalStore {
  readonly kind = 'sqlite' as const
  readonly key: string
  #closed = false
  constructor(readonly db: Database, readonly label: string, readonly leased = false, readonly inTransaction = false) {
    const path = resolve(label)
    this.key = process.platform === 'win32' ? path.toLowerCase() : path
  }
  private perform<T>(fn: () => T): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('上报库连接已关闭'))
    return this.leased ? Promise.resolve().then(fn) : queued(this.key, () => retryBusy(fn))
  }
  all<Row>(sql: string, params?: Record<string, unknown>): Promise<Row[]> {
    return this.perform(() => this.db.query<Row>(sql).all(params as never))
  }
  get<Row>(sql: string, params?: Record<string, unknown>): Promise<Row | null> {
    return this.perform(() => this.db.query<Row>(sql).get(params as never) ?? null)
  }
  run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }> {
    return this.perform(() => ({ changes: Number(this.db.query(sql).run(params as never).changes) }))
  }
  exec(sql: string): Promise<void> { return this.perform(() => this.db.exec(sql)) }
  withConnection<T>(fn: (connection: PortalStore) => Promise<T>): Promise<T> {
    if (this.leased) return fn(this)
    return queued(this.key, () => fn(new SqlitePortalStore(this.db, this.label, true)))
  }
  transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this)
    return this.withConnection(async () => {
      await retryBusy(() => this.db.exec('BEGIN IMMEDIATE'))
      const tx = new SqlitePortalStore(this.db, this.label, true, true)
      try { const result = await fn(tx); this.db.exec('COMMIT'); return result }
      catch (error) { try { this.db.exec('ROLLBACK') } catch { /* 保留原始错误 */ } throw error }
    })
  }
  async close(): Promise<void> {
    if (this.leased || this.#closed) return
    await queued(this.key, async () => { if (!this.#closed) { this.#closed = true; this.db.close() } })
  }
}

class MysqlPortalStore implements PortalStore {
  readonly kind = 'mysql' as const
  constructor(readonly backend: MysqlBackend, readonly label: string) {}
  all<Row>(sql: string, params?: Record<string, unknown>): Promise<Row[]> { return this.backend.all(sql, params as never) }
  get<Row>(sql: string, params?: Record<string, unknown>): Promise<Row | null> { return this.backend.get(sql, params as never) }
  run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }> { return this.backend.run(sql, params as never) }
  exec(sql: string): Promise<void> { return this.backend.exec(sql) }
  transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    return this.backend.transaction((tx) => fn(new MysqlPortalStore(tx, this.label)))
  }
  withConnection<T>(fn: (connection: PortalStore) => Promise<T>): Promise<T> {
    return this.backend.withConnection((connection) => fn(new MysqlPortalStore(connection, this.label)))
  }
  async close(): Promise<void> { /* 共享池只在进程退出时关闭。 */ }
}

/** 仅迁移器可以绕过版本闸门；业务代码必须使用 openPortalStore。 */
export async function openRawPortalStore(target: PortalTarget): Promise<PortalStore> {
  if (target.mysqlUrl) return new MysqlPortalStore(await sharedMysqlBackend(target.mysqlUrl), describePortalTarget(target))
  return new SqlitePortalStore(await retryBusy(() => openRawPortalSqlite(target.sqlitePath)), target.sqlitePath)
}
