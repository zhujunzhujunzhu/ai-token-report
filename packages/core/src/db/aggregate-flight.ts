/**
 * 看板聚合的在途合并：同库、同 SQL、同参数的并发读取共用一次执行。
 * ★ 完成或失败即删除，不保留查询结果；下一次读取仍然看数据库的最新状态。
 * 筛选范围、归一化规则与单价快照都包含在参数中，不能仅按 URL 合并。
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { PortalStore, PortalTarget } from './portal-connection.js'
import type { SqlQuery } from './query.js'

const flights = new Map<string, Promise<unknown>>()
const MAX_FLIGHTS = 64

export async function readAggregate<Row>(
  target: PortalTarget,
  store: Pick<PortalStore, 'kind' | 'all'>,
  query: SqlQuery,
): Promise<Row[]> {
  return aggregateFlight(target, store.kind, ['sql', query.sql, Object.entries(query.params).sort(([a], [b]) => a.localeCompare(b))], () => store.all<Row>(query.sql, query.params))
}

/** 同一聚合结果的在途计算也可合并；identity 必须包含全部筛选、规则与价表快照。 */
export async function aggregateFlight<Result>(
  target: PortalTarget,
  kind: PortalStore['kind'],
  identity: unknown,
  work: () => Promise<Result>,
): Promise<Result> {
  const path = resolve(target.sqlitePath)
  const database = target.mysqlUrl ?? (process.platform === 'win32' ? path.toLowerCase() : path)
  // 连接身份也参与摘要：同一个库的不同数据库账号不能互相复用结果。
  const key = createHash('sha256').update(JSON.stringify([
    kind, database, identity,
  ])).digest('hex')
  const current = flights.get(key)
  if (current) return current as Promise<Result>
  // 不淘汰仍在执行的任务；达到上限时正常查询，保证内存有界。
  if (flights.size >= MAX_FLIGHTS) return work()
  const pending = work()
  flights.set(key, pending)
  try { return await pending }
  finally { if (flights.get(key) === pending) flights.delete(key) }
}
