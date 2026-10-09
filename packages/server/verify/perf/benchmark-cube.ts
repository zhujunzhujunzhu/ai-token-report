/** 真实分布十倍造数；仅随机隔离 MySQL schema，结束删除，不打开业务库写入。 */
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createIsolatedMysql } from '../mysql-isolation.js'
import { openPortalStore, PortalStatsSession, syncCube, cubeQuery, totalsQuery, MYSQL_DIALECT, costTotalsQuery, type QueryFilter } from '@ai-token-report/core/db'
import { modelPriceFromWire } from '@ai-token-report/shared'

const args = process.argv.slice(2)
const value = (name: string) => args[args.indexOf(name) + 1]
const input = value('--input')
if (!input || !args.includes('--input')) throw new Error('必须指定 --input <只读导出的 ndjson.gz>')
const factor = args.includes('--factor') ? Number(value('--factor')) : 10
if (!Number.isInteger(factor) || factor < 1 || factor > 30) throw new Error('factor 必须为 1..30')
const tables = new Map<string, Record<string, unknown>[]>()
for (const line of gunzipSync(readFileSync(input)).toString('utf8').split('\n')) {
  if (!line) continue
  const { table, row } = JSON.parse(line)
  const list = tables.get(table) ?? []; list.push(row); tables.set(table, list)
}
const fixture = await createIsolatedMysql()
const target = { mysqlUrl: fixture.url, sqlitePath: 'unused' }
const store = await openPortalStore(target)
console.log(JSON.stringify({ phase: 'start', factor, originalRows: tables.get('usage_event')!.length, schema: new URL(fixture.url).pathname.slice(1) }))
const uuid = (id: string, replica: number) => {
  const h = createHash('sha256').update(`${id}:${replica}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
async function insert(table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const columns = Object.keys(rows[0]!)
  if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('非法列名')
  await store.run(`INSERT INTO ${table} (${columns.map(c => '`' + c + '`').join(',')}) VALUES ${rows.map(() => '(' + columns.map(() => '?').join(',') + ')').join(',')}`,
    rows.flatMap(row => columns.map(column => row[column])))
}
try {
  for (let replica = 0; replica < factor; replica++) {
    const mapId = (id: unknown) => id == null || replica === 0 ? id : uuid(String(id), replica)
    await insert('members', tables.get('members')!.map(row => ({ ...row, member_id: mapId(row.member_id), display_name: String(row.display_name) + (replica ? `-${replica}` : '') })))
    await insert('member_groups', (tables.get('member_groups') ?? []).map(row => ({ ...row, group_id: mapId(row.group_id), name: String(row.name) + (replica ? `-${replica}` : '') })))
    await insert('member_group_assignments', (tables.get('member_group_assignments') ?? []).map(row => ({ ...row, member_id: mapId(row.member_id), group_id: mapId(row.group_id) })))
    const events = tables.get('usage_event')!
    for (let at = 0; at < events.length; at += 1000) {
      await insert('usage_event', events.slice(at, at + 1000).map(row => ({ ...row,
        event_id: `${replica}:${row.event_id}`, session_id: `${replica}:${row.session_id}`,
        member_id: mapId(row.member_id), user_id: row.user_id == null ? null : String(row.user_id) + (replica ? `-${replica}` : ''),
      })))
    }
    console.log(JSON.stringify({ phase: 'loaded', replicas: replica + 1, rows: (replica + 1) * events.length }))
  }
  for (const name of ['model_price', 'provider_alias', 'project_alias']) await insert(name, tables.get(name) ?? [])
  const backfillStart = performance.now(); let hours = 0, cells = 0
  for (;;) {
    const result = await syncCube(store, { maxHours: 24 })
    hours += result.hours; cells += result.cells
    if (hours % 240 === 0 || !result.remaining) console.log(JSON.stringify({ phase: 'backfill', hours, cells, remaining: result.remaining, ms: Math.round(performance.now() - backfillStart) }))
    if (!result.remaining) break
  }
  await store.exec('ANALYZE TABLE usage_event, usage_cube')
  const rows = Number((await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_event'))?.n)
  const cubeRows = Number((await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube'))?.n)
  console.log(JSON.stringify({ phase: 'size', rows, cubeRows, compression: +(rows / cubeRows).toFixed(2),
    storage: await store.all("SELECT table_name AS name, data_length+index_length AS bytes FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('usage_event','usage_cube')"),
    runtime: await store.get('SELECT VERSION() AS version, @@innodb_buffer_pool_size AS buffer_pool_bytes') }))
  const prices = (await store.all<Record<string, unknown>>('SELECT * FROM model_price')).map(row => ({ priceId: String(row.price_id), ...modelPriceFromWire(row as never) }))
  const all: QueryFilter = { identityView: 'member', sinceMs: Date.UTC(2025, 11, 31, 16), untilMs: Date.now() }
  // 用真实有大量调用的人员，避免用零用量管理员把筛选耗时测成空查询。
  const memberId = String((await store.get<{ member_id: string }>("SELECT member_id FROM usage_cube WHERE source='dsh' AND member_id IS NOT NULL GROUP BY member_id ORDER BY SUM(calls) DESC LIMIT 1"))!.member_id)
  const filters = [all, { ...all, sources: ['dsh'] }, { ...all, sources: ['dsh'], memberIds: [memberId] }]
  const canonical = (value: unknown) => JSON.stringify(value, (_, v) => v instanceof Map ? [...v] : v)
  // 平手行序不影响口径；费用 Map 同样按键排序，保留全部字段参与逐位对照。
  const sorted = (v: any): any => v instanceof Map ? [...v].sort(([a], [b]) => String(a).localeCompare(String(b))).map(sorted)
    : Array.isArray(v) ? v.map(sorted).sort((a, b) => canonical(a).localeCompare(canonical(b)))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, sorted(value)])) : v
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]!
    const session = (disableCube = false) => new PortalStatsSession({ store, target, filter, withCost: true, disableCube })
    const cases = [
      ['overview', async (s: PortalStatsSession) => ({ ...(await s.overviewCounts()), cost: await s.costTotals() })],
      ['user', async (s: PortalStatsSession) => ({ groups: await s.groups('user'), costs: await s.costByGroup('user') })],
      ['model', async (s: PortalStatsSession) => ({ groups: await s.groups('provider-model'), costs: await s.costByGroup('provider-model') })],
      ['series', async (s: PortalStatsSession) => await s.series('day', false)],
    ] as const
    for (const [name, run] of cases) {
      const start = performance.now(); const expected = await run(session(true)); const rawMs = Math.round(performance.now() - start)
      const times: number[] = []
      for (let round = 0; round < 3; round++) {
        const start = performance.now(); const actual = await run(session()); times.push(Math.round(performance.now() - start))
        if (canonical(sorted(actual)) !== canonical(sorted(expected))) throw new Error(`${name}/${i} 逐位对照不一致`)
      }
      console.log(JSON.stringify({ phase: 'latency', filter: i, name, rawMs, cubeMs: times, parity: true }))
    }
  }
  // 查看快路径实际读取的计划，防止 UNION 的原始表兜底被错误地全表物化。
  const q = cubeQuery(costTotalsQuery(all, undefined, MYSQL_DIALECT, prices), 'mysql', all, prices)
  console.log(JSON.stringify({ phase: 'explain', rows: await store.all('EXPLAIN ' + q.sql, q.params) }))
  const start = performance.now()
  const concurrent = await Promise.all(Array.from({ length: 16 }, async () => {
    const s = new PortalStatsSession({ store, target, filter: all, withCost: true })
    const counts = await s.overviewCounts(), cost = await s.costTotals()
    return { ms: Math.round(performance.now() - start), hash: createHash('sha256').update(canonical({ counts, cost })).digest('hex') }
  }))
  if (new Set(concurrent.map(row => row.hash)).size !== 1) throw new Error('并发查询结果不一致')
  console.log(JSON.stringify({ phase: 'concurrency', requests: 16, ms: concurrent.map(row => row.ms), parity: true }))
  const screen = (filter: QueryFilter) => {
    const s = new PortalStatsSession({ store, target, filter, withCost: true })
    return Promise.all([s.overviewCounts(), s.costTotals(), s.groups('user'), s.costByGroup('user'),
      s.groups('provider-model'), s.costByGroup('provider-model'), s.series('day', false)])
  }
  const screenStart = performance.now()
  const screens = await Promise.all(Array.from({ length: 16 }, async () => {
    const data = canonical(sorted(await screen(all)))
    return { data, ms: Math.round(performance.now() - screenStart) }
  }))
  if (new Set(screens.map(row => row.data)).size !== 1) throw new Error('并发整屏查询结果不一致')
  console.log(JSON.stringify({ phase: 'concurrent-screens', requests: 16, ms: screens.map(row => row.ms), parity: true }))
  // 不同人员无法合并在途请求；覆盖真实活跃用户，避免只测相同参数的收益。
  const members = await store.all<{ member_id: string }>("SELECT member_id FROM usage_cube WHERE source='dsh' AND member_id IS NOT NULL GROUP BY member_id ORDER BY SUM(calls) DESC LIMIT 16")
  const distinctStart = performance.now()
  const distinct = await Promise.all(members.map(async ({ member_id }) => {
    const filter: QueryFilter = { ...all, sources: ['dsh'], memberIds: [member_id] }
    const data = canonical(sorted(await screen(filter)))
    return { filter, data, ms: Math.round(performance.now() - distinctStart) }
  }))
  for (const result of distinct) {
    if (result.data !== canonical(sorted(await screen(result.filter)))) throw new Error('不同人员并发与独立查询结果不一致')
  }
  console.log(JSON.stringify({ phase: 'distinct-screens', requests: distinct.length, ms: distinct.map(row => row.ms), parity: true }))
} finally { await store.close(); await fixture.dispose() }
