/**
 * v15 看板查询表：原始小时的确定性压缩 + 事务内失效。
 * 不依赖接收水位：迟交事务、历史 NULL 接收时刻、修改归属、删除都由触发器标记小时。
 * 查询在单条 SQL 快照中排除失效小时，并从事实表精确补上；没有数据新鲜度缓存。
 */
import { createHash } from 'node:crypto'
import { PRICE_SCHEDULES, isPeakAt, type ModelPrice, type TokenRemainders } from '@ai-token-report/shared'
import { toDayKey, toHourKey, toHourOfDay, dayKindOf } from '../aggregate.js'
import type { PortalStore } from './portal-connection.js'
import { cubeHourSql } from './portal-schema-v15.js'
import { buildWhere, type QueryFilter, type SqlQuery } from './query.js'

export const CUBE_HOUR_MS = 3_600_000
export function cubeVersionKey(): string {
  return createHash('sha256').update(JSON.stringify([
    'cube-15.1', process.env['TZ'] ?? '', Intl.DateTimeFormat().resolvedOptions().timeZone, PRICE_SCHEDULES,
  ])).digest('hex')
}

export interface CubeSourceRow {
  ts: unknown; source: string; provider: string; model: string; session_id: string;
  cwd: string | null; member_id: string | null; user_id: string | null; user_name: string | null;
  received_at_ms: unknown;
  input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown; reasoning_tokens: unknown;
}
const TOKEN_COLUMNS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const
const CUBE_COLUMNS = ['cube_id', 'day_key', 'hour_key', 'source', 'member_id', 'user_id', 'user_name', 'provider', 'model', 'cwd', 'session_id', 'slot_key', 'legacy_only', 'remainders', 'utc_hour', 'hour_of_day', 'day_kind', 'calls', ...TOKEN_COLUMNS, 'reasoning_tokens', 'lo', 'hi'] as const
type Cell = Record<typeof CUBE_COLUMNS[number], string | number | null>

export function foldCubeRows(rows: readonly CubeSourceRow[]): Cell[] {
  const cells = new Map<string, { row: Cell; hist: Map<number, number>[]; identity: string }>()
  for (const event of rows) {
    const ts = Number(event.ts)
    const utcHour = Math.floor(ts / CUBE_HOUR_MS)
    // 所有已知时段表都分桶，与当前配了哪些价无关；补价 / 换价不需要重写汇总。
    const slotKey = PRICE_SCHEDULES.map(schedule => isPeakAt(schedule, ts) ? '0' : '1').join('')
    // ts=0 在时间分组中代表没有时间，不能与同小时的有效时间合并后丢掉边界。
    const identity = JSON.stringify([utcHour, toHourKey(ts), ts === 0, event.source, event.member_id, event.user_id,
      event.provider, event.model, event.cwd, event.session_id, slotKey, event.received_at_ms === null ? 1 : 0])
    const id = createHash('sha256').update(identity).digest('hex')
    let cell = cells.get(id)
    if (!cell) {
      cell = { identity, hist: Array.from({ length: 4 }, () => new Map()), row: {
        cube_id: id, day_key: toDayKey(ts), hour_key: toHourKey(ts), source: event.source,
        member_id: event.member_id, user_id: event.user_id, user_name: event.user_name,
        provider: event.provider, model: event.model, cwd: event.cwd, session_id: event.session_id,
        slot_key: slotKey, legacy_only: event.received_at_ms === null ? 1 : 0, remainders: '',
        utc_hour: utcHour, hour_of_day: toHourOfDay(ts), day_kind: dayKindOf(ts),
        calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        reasoning_tokens: 0, lo: ts, hi: ts,
      } }
      cells.set(id, cell)
    } else if (cell.identity !== identity) throw new Error('汇总键摘要冲突，拒绝合并不同维度')
    cell.row.calls = Number(cell.row.calls) + 1
    cell.row.reasoning_tokens = Number(cell.row.reasoning_tokens) + Number(event.reasoning_tokens)
    cell.row.lo = Math.min(Number(cell.row.lo), ts)
    cell.row.hi = Math.max(Number(cell.row.hi), ts)
    if (event.user_name !== null && (cell.row.user_name === null || event.user_name < String(cell.row.user_name))) cell.row.user_name = event.user_name
    TOKEN_COLUMNS.forEach((name, i) => {
      const tokens = Number(event[name])
      cell!.row[name] = Number(cell!.row[name]) + tokens
      const rest = tokens % 1000
      if (rest) cell!.hist[i]!.set(rest, (cell!.hist[i]!.get(rest) ?? 0) + 1)
    })
  }
  return [...cells.values()].map(cell => ({ ...cell.row,
    remainders: JSON.stringify(cell.hist.map(hist => [...hist].sort(([a], [b]) => a - b))),
  }))
}

/** 每批锁住失效小时后才建立事实快照，避免等待写事务期间读取到更早的快照。 */
export async function syncCube(store: PortalStore, options: { maxHours?: number; forceRebuild?: boolean } = {}): Promise<{ hours: number; cells: number; remaining: number }> {
  const key = cubeVersionKey()
  const meta = await store.get<{ version_key: string }>('SELECT version_key FROM usage_cube_meta WHERE id=1')
  if (options.forceRebuild || meta?.version_key !== key) {
    await store.transaction(async tx => {
      // MySQL 用元数据行锁串行化重建；正常服务端自身也只启动一轮后台任务。
      if (tx.kind === 'mysql') await tx.run('INSERT INTO usage_cube_meta (id, version_key, updated_at_ms) VALUES (1, $key, $now) ON DUPLICATE KEY UPDATE id=1', { $key: key, $now: Date.now() })
      if (tx.kind === 'mysql') await tx.get('SELECT id FROM usage_cube_meta WHERE id=1 FOR UPDATE')
      await tx.exec('DELETE FROM usage_cube')
      const hours = cubeHourSql(tx.kind, 'ts')
      const prefix = tx.kind === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE'
      await tx.exec(`${prefix} INTO usage_cube_dirty (utc_hour) SELECT DISTINCT ${hours} FROM usage_event`)
      await tx.exec('DELETE FROM usage_cube_meta')
      await tx.run('INSERT INTO usage_cube_meta (id, version_key, updated_at_ms) VALUES (1, $key, $now)', { $key: key, $now: Date.now() })
    })
  }
  const maxHours = Math.max(1, Math.min(64, options.maxHours ?? 24))
  const result = await store.transaction(async tx => {
    // FOR UPDATE 是当前读，不建立 RR 快照；事实 SELECT 必须排在这次锁定之后。
    const dirty = await tx.all<{ utc_hour: unknown }>(`SELECT utc_hour FROM usage_cube_dirty ORDER BY utc_hour LIMIT ${maxHours}${tx.kind === 'mysql' ? ' FOR UPDATE' : ''}`)
    if (!dirty.length) return { hours: 0, cells: 0 }
    const hours = dirty.map(row => Number(row.utc_hour))
    const ranges = hours.map(hour => `(ts >= ${hour * CUBE_HOUR_MS} AND ts < ${(hour + 1) * CUBE_HOUR_MS})`).join(' OR ')
    const rows = await tx.all<CubeSourceRow>(`SELECT ts, source, provider, model, session_id, cwd, member_id, user_id, user_name,
      received_at_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event WHERE ${ranges}`)
    const cells = foldCubeRows(rows)
    await tx.exec(`DELETE FROM usage_cube WHERE utc_hour IN (${hours.join(',')})`)
    // SQLite 旧参数上限 999；单次至多 30 行，且事实快照 / 重算 / 清失效标记在同一事务。
    for (let at = 0; at < cells.length; at += 30) {
      const batch = cells.slice(at, at + 30)
      await tx.run(`INSERT INTO usage_cube (${CUBE_COLUMNS.join(',')}) VALUES ${batch.map(() => `(${CUBE_COLUMNS.map(() => '?').join(',')})`).join(',')}`,
        batch.flatMap(row => CUBE_COLUMNS.map(name => row[name])))
    }
    await tx.exec(`DELETE FROM usage_cube_dirty WHERE utc_hour IN (${hours.join(',')})`)
    await tx.run('UPDATE usage_cube_meta SET updated_at_ms=$now WHERE id=1', { $now: Date.now() })
    return { hours: hours.length, cells: cells.length }
  })
  const remaining = await store.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM usage_cube_dirty')
  return { ...result, remaining: Number(remaining?.n ?? 0) }
}

export async function backfillCube(store: PortalStore, options: { maxHours?: number; forceRebuild?: boolean; maxRounds?: number; signal?: AbortSignal } = {}) {
  let hours = 0
  let cells = 0
  for (let i = 0; i < (options.maxRounds ?? 10000); i++) {
    if (options.signal?.aborted) return { hours, cells, caughtUp: false }
    const result = await syncCube(store, { ...options, forceRebuild: i === 0 && options.forceRebuild === true })
    hours += result.hours; cells += result.cells
    if (!result.remaining) return { hours, cells, caughtUp: true }
  }
  return { hours, cells, caughtUp: false }
}

/** 只在元数据与进程时区 / 时段表相同时启用；未建好时原始查询保持可用。 */
export async function cubeAvailable(store: PortalStore): Promise<boolean> {
  const row = await store.get<{ version_key: string }>('SELECT version_key FROM usage_cube_meta WHERE id=1')
  return row?.version_key === cubeVersionKey()
}

/**
 * 给原查询接入单条 SQL 的混合数据源。非整小时窗口与换价所在小时直接补原始数据。
 * 失效小时的集合在该 SQL 快照内读取，故不会把旧汇总和新事实重复计算或漏掉。
 */
export function cubeQuery(query: SqlQuery, kind: PortalStore['kind'], filter: QueryFilter, prices: readonly ModelPrice[], options: { rows?: boolean; withRemainders?: boolean } = {}): SqlQuery {
  const hot = new Set<number>()
  const since = filter.sinceMs ?? 0
  const until = filter.untilMs ?? Number.MAX_SAFE_INTEGER
  const mark = (at: number) => { if (at > since && at <= until && at % CUBE_HOUR_MS !== 0) hot.add(Math.floor(at / CUBE_HOUR_MS)) }
  if (since % CUBE_HOUR_MS) hot.add(Math.floor(since / CUBE_HOUR_MS))
  if (filter.untilMs !== undefined && (until + 1) % CUBE_HOUR_MS) hot.add(Math.floor(until / CUBE_HOUR_MS))
  for (const price of prices) { mark(price.effectiveFromMs); if (price.effectiveToMs !== null) mark(price.effectiveToMs + 1) }
  const hotSql = [...hot].filter(value => value * CUBE_HOUR_MS <= until && (value + 1) * CUBE_HOUR_MS > since)
    .map(value => `SELECT ${value} AS utc_hour`).join(' UNION ')
  const span = `utc_hour >= ${Math.floor(since / CUBE_HOUR_MS)} AND utc_hour <= ${Math.floor(until / CUBE_HOUR_MS)}`
  // UNION 会物化，宽行让临时表成本远大于 token 求和；只投影原查询真正使用的列。
  const fields = ['source', 'member_id', 'user_id', 'user_name', 'provider', 'model', 'cwd', 'session_id', ...TOKEN_COLUMNS, 'reasoning_tokens']
    .filter(name => new RegExp(`\\b${name}\\b`).test(query.sql)).join(', ')
  const projection = fields ? fields + ', ' : ''
  // 来源与稳定身份直接下推，让人员小范围查询命中汇总索引。
  // provider / model 仍由原查询的归一化表达式筛，不能误用原值过滤展示名。
  const pushed = buildWhere({ ...filter, providers: undefined, models: undefined })
  const predicate = pushed.sql ? pushed.sql.slice(' WHERE '.length) : ''
  const hotPushed = buildWhere({ ...filter, sinceMs: undefined, untilMs: undefined, providers: undefined, models: undefined })
  const hotPredicate = hotPushed.sql ? hotPushed.sql.slice(' WHERE '.length) : ''
  const cleanPredicate = predicate.replace(/\bts\b/g, 'lo')
    .replace(/\breceived_at_ms\b/g, '(CASE WHEN legacy_only=1 THEN NULL ELSE 0 END)')
  const hotHours = `SELECT utc_hour FROM usage_cube_dirty WHERE ${span}${hotSql ? ' UNION ' + hotSql : ''}`
  // MySQL 只在 WHERE 中替换表达式索引；LATERAL 保留外层小时的 ref 查找。
  // LIMIT 阻止派生表合并，否则优化器又会退回整年扫描后的 JOIN 条件判断。
  const rawHours = kind === 'mysql'
    ? `FROM hot_hours JOIN LATERAL (
        SELECT ${projection}ts, received_at_ms FROM usage_event FORCE INDEX (idx_usage_event_cube_hour)
        WHERE (ts DIV ${CUBE_HOUR_MS}) = hot_hours.utc_hour${hotPredicate ? ' AND ' + hotPredicate : ''}
        LIMIT 18446744073709551615
      ) AS raw_hour ON TRUE JOIN cube_meta ON cube_meta.id=1`
    : `FROM hot_hours JOIN usage_event
        ON (ts / ${CUBE_HOUR_MS}) = hot_hours.utc_hour
      JOIN cube_meta ON cube_meta.id=1 ${pushed.sql}`
  let sql = query.sql.replace(/FROM usage_event\b/g, 'FROM usage_read AS usage_event')
  sql = sql.replace(/COUNT\(\*\)/g, 'COALESCE(SUM(calls), 0)').replace(/MAX\(ts\)/g, 'MAX(event_hi)')
    .replace(/COUNT\(CASE WHEN ([\s\S]*?) THEN 1 END\)/g, 'COALESCE(SUM(CASE WHEN $1 THEN calls ELSE 0 END), 0)')
  // SQL 聚合路径原样取四列和；逐行路径额外取调用次数与余数用于精确复原。
  if (options.rows) sql = sql.replace(/^SELECT /, 'SELECT calls, remainders, event_hi, ')
  // 趋势不依赖会话或人员：完全相同的行只传一份，次数与舍入分布随后按 copies 加权。
  // 保留完整 token 列与完整余数文本作为分组键，不能仅凭摘要认定相同。
  const timeProjection = options.rows && /^SELECT ts, (?:provider, model, )?input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens\s+FROM/.exec(query.sql)?.[0]
  if (timeProjection) {
    const columns = timeProjection.slice(0, timeProjection.lastIndexOf('FROM')).split(',').length + 3
    sql = sql.replace(/^SELECT /, 'SELECT COUNT(*) AS copies, ') + ' GROUP BY ' + Array.from({ length: columns }, (_, i) => i + 2).join(',')
  }
  // 分组关联的子查询必须透传权重与末事件时刻；人员去重的外层 COUNT 保持不变。
  sql = sql.replace('SELECT member_id, input_tokens,', 'SELECT calls, member_id, input_tokens,')
    .replace('reasoning_tokens, ts, session_id', 'reasoning_tokens, ts, event_hi, session_id').replace('MAX(x.ts)', 'MAX(x.event_hi)')
  if (/SUM\(x.input_tokens\)/.test(sql)) sql = sql.replace('SUM(calls)', 'SUM(x.calls)')
  if (/\) AS identities/.test(sql)) sql = sql.replace('COALESCE(SUM(calls), 0) AS c', 'COUNT(*) AS c')
  const params = { ...query.params, ...pushed.params, $cube_key: cubeVersionKey() }
  return {
    sql: `WITH cube_meta AS (SELECT id FROM usage_cube_meta WHERE id=1 AND version_key=$cube_key),
      hot_hours AS (${hotHours}),
      usage_read AS (
        SELECT ${projection}lo AS ts, hi AS event_hi, calls, ${options.rows && options.withRemainders !== false ? 'remainders' : 'NULL AS remainders'},
               CASE WHEN legacy_only=1 THEN NULL ELSE 0 END AS received_at_ms
        FROM usage_cube JOIN cube_meta ON cube_meta.id=1
        WHERE ${span} AND utc_hour NOT IN (SELECT utc_hour FROM hot_hours)${cleanPredicate ? ' AND ' + cleanPredicate : ''}
        UNION ALL
        SELECT ${projection}ts, ts AS event_hi, 1 AS calls, NULL AS remainders, received_at_ms
        ${rawHours}
        UNION ALL
        SELECT ${projection}ts, ts AS event_hi, 1 AS calls, NULL AS remainders, received_at_ms
        FROM usage_event WHERE NOT EXISTS (SELECT id FROM cube_meta)${predicate ? ' AND ' + predicate : ''}
      ) ${sql}`,
    params,
  }
}

export function cubeRemainders(value: unknown): TokenRemainders | undefined {
  return typeof value === 'string' ? JSON.parse(value) as TokenRemainders : undefined
}
