/** 线上只读 A/B：同一事务快照内比较逐事件连接与预聚合，逐列核对后输出耗时。 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { costByDimensionQuery, costTotalsQuery, type SqlQuery } from '../../../core/src/db/query.js'
import { MYSQL_DIALECT } from '../../../core/src/db/dialect.js'
import { modelPriceFromWire } from '@ai-token-report/shared'

const require = createRequire('/data/ai-token-report/packages/server/package.json')
const mysql = require('mysql2/promise')
const credentials = readFileSync('/root/.atr/mysql8-credentials.txt', 'utf8')
const section = credentials.split(/^\[/m).find((part) => part.startsWith('atr_user]'))!
const password = section.split(/\r?\n/).find((line) => line.startsWith('password='))!.slice(9)
const db = await mysql.createConnection({ host: '127.0.0.1', port: 3308, user: 'atr_user', password, database: 'ai_token_report' })
function bound(query: SqlQuery): [string, (string | number | null)[]] {
  const values: (string | number | null)[] = []
  const sql = query.sql.replace(/\$[A-Za-z0-9_]+/g, (key) => {
    if (!(key in query.params)) throw new Error(`缺少绑定 ${key}`)
    values.push(query.params[key]!)
    return '?'
  })
  return [sql, values]
}
function canonical(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}
try {
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [rows] = await db.query('SELECT * FROM model_price')
  const prices = rows.map((row: any) => ({ priceId: String(row.price_id), ...modelPriceFromWire(row) }))
  const filter = { sinceMs: Date.UTC(2025, 11, 31, 16), untilMs: Date.now() }
  const cases = [
    { name: 'year-total', old: costTotalsQuery(filter, undefined, MYSQL_DIALECT), next: costTotalsQuery(filter, undefined, MYSQL_DIALECT, prices) },
    ...(['user', 'provider-model'] as const).map((dim) => ({ name: `year-${dim}`,
      old: costByDimensionQuery(dim, filter, MYSQL_DIALECT)!, next: costByDimensionQuery(dim, filter, MYSQL_DIALECT, undefined, prices)! })),
    { name: 'year-dsh', old: costTotalsQuery({ ...filter, sources: ['dsh'] }, undefined, MYSQL_DIALECT),
      next: costTotalsQuery({ ...filter, sources: ['dsh'] }, undefined, MYSQL_DIALECT, prices) },
  ]
  for (const item of cases) {
    let expected = ''
    const timings: Record<string, number[]> = { old: [], next: [] }
    for (let i = 0; i < 3; i++) {
      for (const variant of (i % 2 ? ['next', 'old'] : ['old', 'next']) as ('old' | 'next')[]) {
        const start = performance.now()
        const [result] = await db.query(...bound(item[variant]))
        timings[variant]!.push(Math.round(performance.now() - start))
        const value = canonical(result)
        if (!expected) expected = value
        if (value !== expected) throw new Error(`${item.name}/${variant} 结果不一致`)
      }
    }
    console.log(JSON.stringify({ name: item.name, timings, parity: true, hash: createHash('sha256').update(expected).digest('hex') }))
  }
  await db.rollback()
} finally { await db.end() }
