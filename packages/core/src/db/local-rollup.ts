/**
 * 本机统计的可重建派生索引：按「本地小时、会话、模型、cwd」压缩重复事件。
 *
 * ★ 只由本机查询显式启用，不改变共享 schema 版本，也不接触部门上报库。
 * 旧 CLI 继续写 usage_event：新增由 rowid 游标补齐，更新/删除由触发器使索引失效。
 * 索引和游标在同一事务提交，崩溃后可以重复构建，绝不会重复累加。
 * 小时键仍由 aggregate.ts 生成；汇总只存原始列，比例交给 shared。
 */
import { computeTotal } from '@ai-token-report/shared'
import { groupKey, toHourKey, type GroupDimension, type GroupRow } from '../aggregate.js'
import { derive, emptyCounts, mergeCounts, type TokenCounts, type UsageRecord } from '../types.js'
import type { Database } from './driver.js'
import { buildWhere, queryRecords, type QueryFilter } from './query.js'

const VERSION = 4
const BATCH = 10_000
const CELLS = 'local_usage_cell'
const META = 'local_usage_cell_meta'
const INVALIDATION = 'local_usage_cell_change'
const INDEXED = 'local_usage_cell_event'

interface RawCell {
  cell_key: string; hour_key: string; session_id: string; provider: string; model: string
  cwd: string | null; min_ts: number; max_ts: number; calls: number
  input_tokens: number; output_tokens: number; cache_read_tokens: number
  cache_write_tokens: number; reasoning_tokens: number
  first_positive_ts: number | null
}
interface SourceRow extends Omit<RawCell, 'cell_key' | 'hour_key' | 'min_ts' | 'max_ts' | 'calls' | 'first_positive_ts'> {
  row_id: number; ts: number
}
interface Cell {
  key: string; hour: string; sessionId: string; provider: string; model: string
  cwd: string | null; lo: number; hi: number; firstPositive: number | null; counts: TokenCounts
}

function timezoneKey(): string {
  // 环境 TZ 和系统时区都纳入版本，避免已持久化的本地小时被另一个时区复用。
  return `${process.env['TZ'] ?? ''}|${Intl.DateTimeFormat().resolvedOptions().timeZone}|${VERSION}`
}

function keyOf(ts: number, session: string, provider: string, model: string, cwd: string | null): string {
  // JSON 元组可无歧义编码 null、分隔符及 Unicode，不能用手拼字符串作复合键。
  return JSON.stringify([toHourKey(ts), session, provider, model, cwd])
}

function ensure(db: Database): { cursor: number; reset: number } {
  const hasMeta = db.query('SELECT name FROM sqlite_master WHERE name = ?').get([META])
  const previous = hasMeta ? db.query<{ version: number }>(`SELECT version FROM ${META} WHERE id = 1`).get() : undefined
  if (previous && previous.version !== VERSION) {
    db.exec(`DROP TABLE IF EXISTS ${CELLS}; DROP TABLE IF EXISTS ${INVALIDATION}; DROP TABLE IF EXISTS ${INDEXED}; DELETE FROM ${META}`)
    db.exec('DROP TRIGGER IF EXISTS local_usage_cell_replacing; DROP TRIGGER IF EXISTS local_usage_cell_insert')
  }
  const intact = db.query('SELECT name FROM sqlite_master WHERE type = \'trigger\' AND name = \'local_usage_cell_update\'').get()
  db.exec(`CREATE TABLE IF NOT EXISTS ${META} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, timezone TEXT NOT NULL, cursor INTEGER NOT NULL, reset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ${INVALIDATION} (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO ${INVALIDATION} VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS ${INDEXED} (event_id TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ${CELLS} (
      cell_key TEXT PRIMARY KEY, hour_key TEXT NOT NULL, session_id TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT,
      min_ts INTEGER NOT NULL, max_ts INTEGER NOT NULL, calls INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
      first_positive_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS local_usage_cell_time ON ${CELLS}(max_ts);
    CREATE TRIGGER IF NOT EXISTS local_usage_cell_update AFTER UPDATE ON usage_event BEGIN
      UPDATE ${INVALIDATION} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS local_usage_cell_delete AFTER DELETE ON usage_event BEGIN
      UPDATE ${INVALIDATION} SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS local_usage_cell_insert AFTER INSERT ON usage_event
    WHEN NEW.rowid <= (SELECT cursor FROM ${META} WHERE id = 1)
      OR EXISTS (SELECT 1 FROM ${INDEXED} WHERE event_id = NEW.event_id) BEGIN
      UPDATE ${INVALIDATION} SET revision = revision + 1 WHERE id = 1;
    END;`)
  const reset = db.query<{ revision: number }>(`SELECT revision FROM ${INVALIDATION} WHERE id = 1`).get()!.revision
  const meta = db.query<{ cursor: number; reset: number; version: number; timezone: string }>(`SELECT * FROM ${META} WHERE id = 1`).get()
  const high = db.query<{ n: number | null }>('SELECT MAX(rowid) AS n FROM usage_event').get()?.n ?? 0
  if (!intact || !meta || meta.version !== VERSION || meta.timezone !== timezoneKey() || meta.reset !== reset || meta.cursor > high) {
    // 这里只丢可重新生成的辅助索引；usage_event 和采集水位线一个字节都不改。
    db.exec(`DELETE FROM ${CELLS}; DELETE FROM ${INDEXED}`)
    db.query(`INSERT OR REPLACE INTO ${META} VALUES (1, ?, ?, 0, ?)`).run([VERSION, timezoneKey(), reset])
    return { cursor: 0, reset }
  }
  return { cursor: meta.cursor, reset }
}

function countsOf(r: Pick<RawCell, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'reasoning_tokens' | 'calls'>): TokenCounts {
  const counts = { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens,
    cacheWrite: r.cache_write_tokens, reasoning: r.reasoning_tokens, calls: r.calls, total: 0 }
  counts.total = computeTotal(counts)
  return counts
}

/** 将尚未索引的原始行压缩后提交。每批原始行有界，冷建库也不物化百万条对象。 */
function sync(db: Database): void {
  const state = ensure(db)
  let cursor = state.cursor
  const insert = db.prepare(`INSERT INTO ${CELLS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cell_key) DO UPDATE SET
      min_ts = MIN(min_ts, excluded.min_ts), max_ts = MAX(max_ts, excluded.max_ts),
      calls = calls + excluded.calls,
      input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
      first_positive_ts = CASE WHEN first_positive_ts IS NULL THEN excluded.first_positive_ts
        WHEN excluded.first_positive_ts IS NULL THEN first_positive_ts
        ELSE MIN(first_positive_ts, excluded.first_positive_ts) END`)
  try {
    while (true) {
      const rows = db.query<SourceRow>(`SELECT rowid AS row_id, ts, session_id, provider, model, cwd,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
        FROM usage_event WHERE rowid > ? ORDER BY rowid LIMIT ?`).all([cursor, BATCH])
      if (rows.length === 0) break
      const previousCursor = cursor
      const cells = new Map<string, Cell>()
      for (const r of rows) {
        const key = keyOf(r.ts, r.session_id, r.provider, r.model, r.cwd)
        const counts = countsOf({ ...r, calls: 1 })
        const cell = cells.get(key)
        if (cell) {
          mergeCounts(cell.counts, counts)
          cell.lo = Math.min(cell.lo, r.ts); cell.hi = Math.max(cell.hi, r.ts)
          if (r.ts > 0) cell.firstPositive = Math.min(cell.firstPositive ?? r.ts, r.ts)
        } else cells.set(key, { key, hour: toHourKey(r.ts), sessionId: r.session_id, provider: r.provider,
          model: r.model, cwd: r.cwd, lo: r.ts, hi: r.ts, firstPositive: r.ts > 0 ? r.ts : null, counts })
        cursor = r.row_id
      }
      for (const c of cells.values()) insert.run([c.key, c.hour, c.sessionId, c.provider, c.model, c.cwd,
        c.lo, c.hi, c.counts.calls, c.counts.input, c.counts.output, c.counts.cacheRead, c.counts.cacheWrite, c.counts.reasoning, c.firstPositive])
      // REPLACE 默认不触发隐式 DELETE 的触发器。保留已汇总主键，在实际 INSERT 后失效；
      // 不用 BEFORE INSERT 写状态，否则 Bun 的 run().changes 会把被忽略的重复记录误报为新增。
      db.query(`INSERT INTO ${INDEXED} SELECT event_id FROM usage_event WHERE rowid > ? AND rowid <= ?`).run([previousCursor, cursor])
    }
    if (cursor !== state.cursor) db.query(`UPDATE ${META} SET cursor = ? WHERE id = 1`).run([cursor])
  } finally { insert.finalize() }
}

/** 一次查询共用同一份已过滤的压缩行；总计、精确会话去重、分组和趋势不再读原始表。 */
export class LocalRollupSnapshot {
  readonly counts = emptyCounts()
  readonly sessions: number
  constructor(private readonly cells: Cell[]) {
    const sessions = new Set<string>()
    for (const cell of cells) { mergeCounts(this.counts, cell.counts); sessions.add(cell.sessionId) }
    this.sessions = sessions.size
  }

  groups(dim: GroupDimension): GroupRow[] {
    const groups = new Map<string, GroupRow>()
    const sessions = new Map<string, Set<string>>()
    for (const cell of this.cells) {
      const first = dim === 'day' || dim === 'hour' ? cell.firstPositive ?? cell.lo : cell.lo
      const key = groupKey({ time: cell.lo, provider: cell.provider, model: cell.model, cwd: cell.cwd, sessionId: cell.sessionId } as UsageRecord, dim)
      let row = groups.get(key)
      if (!row) {
        row = { key, counts: emptyCounts(), metrics: derive(emptyCounts()), firstTime: first, lastTime: cell.hi, sessions: 0 }
        groups.set(key, row); sessions.set(key, new Set())
      }
      mergeCounts(row.counts, cell.counts)
      if (dim === 'day' || dim === 'hour') {
        if (first > 0 && (row.firstTime === 0 || first < row.firstTime)) row.firstTime = first
      } else row.firstTime = Math.min(row.firstTime, first)
      row.lastTime = Math.max(row.lastTime, cell.hi)
      sessions.get(key)!.add(cell.sessionId)
    }
    for (const row of groups.values()) { row.sessions = sessions.get(row.key)!.size; row.metrics = derive(row.counts) }
    // 同值按键稳定排序，分页期间不会因为对象插入次序不同而跳行。
    const compareKey = (a: GroupRow, b: GroupRow) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    return [...groups.values()].sort(dim === 'day' || dim === 'hour' ? compareKey : (a, b) => b.counts.total - a.counts.total || compareKey(a, b))
  }

  series(granularity: 'day' | 'hour'): { bucket: string; counts: TokenCounts }[] {
    const buckets = new Map<string, TokenCounts>()
    for (const cell of this.cells) {
      const bucket = granularity === 'day' ? cell.hour.slice(0, 10) : cell.hour
      let counts = buckets.get(bucket)
      if (!counts) { counts = emptyCounts(); buckets.set(bucket, counts) }
      mergeCounts(counts, cell.counts)
    }
    return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, counts]) => ({ bucket, counts }))
  }
}

/** 只在本地库使用；更新派生索引与生成快照共用事务，避免一半旧一半新的响应。 */
export function readLocalRollup(db: Database, filter: QueryFilter = {}): LocalRollupSnapshot {
  if (filter.userIds?.length) throw new Error('本地派生索引不支持人员筛选，请使用上报库查询')
  return db.transaction(() => {
    sync(db)
    const { sql, params } = buildWhere({ providers: filter.providers, models: filter.models })
    const clauses = sql ? [sql.slice(' WHERE '.length)] : []
    if (filter.sinceMs !== undefined) { clauses.push('max_ts >= $since'); params['$since'] = filter.sinceMs }
    if (filter.untilMs !== undefined) { clauses.push('min_ts <= $until'); params['$until'] = filter.untilMs }
    const rows = db.query<RawCell>(`SELECT * FROM ${CELLS}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`).all(params)
    const cells: Cell[] = []
    const partial = new Set<string>()
    const edges: { lo: number; hi: number }[] = []
    for (const r of rows) {
      if ((filter.sinceMs !== undefined && r.min_ts < filter.sinceMs) || (filter.untilMs !== undefined && r.max_ts > filter.untilMs)) {
        partial.add(r.cell_key)
        edges.push({ lo: Math.max(r.min_ts, filter.sinceMs ?? -Infinity), hi: Math.min(r.max_ts, filter.untilMs ?? Infinity) })
      } else cells.push({ key: r.cell_key, hour: r.hour_key, sessionId: r.session_id, provider: r.provider, model: r.model,
        cwd: r.cwd, lo: r.min_ts, hi: r.max_ts, firstPositive: r.first_positive_ts, counts: countsOf(r) })
    }
    // 精确时间边界只回查被切开的小时段；不把整小时算入，也不为每个会话做一次 SQL。
    edges.sort((a, b) => a.lo - b.lo)
    const spans: { lo: number; hi: number }[] = []
    for (const edge of edges) {
      const last = spans[spans.length - 1]
      if (last && edge.lo <= last.hi) last.hi = Math.max(last.hi, edge.hi)
      else spans.push({ ...edge })
    }
    for (const span of spans) for (const r of queryRecords(db, { ...filter, sinceMs: span.lo, untilMs: span.hi })) {
      const key = keyOf(r.time, r.sessionId, r.provider, r.model, r.cwd)
      if (partial.has(key)) cells.push({ key, hour: toHourKey(r.time), sessionId: r.sessionId, provider: r.provider,
        model: r.model, cwd: r.cwd, lo: r.time, hi: r.time, firstPositive: r.time > 0 ? r.time : null, counts: r.usage })
    }
    return new LocalRollupSnapshot(cells)
  })
}

/**
 * 常驻摘要只把一行计数带回 JS，不物化每个会话的 cell。
 * 完整小时直接 SUM 独立原始列；自定义边界切开 cell 时复用精确回查路径。
 * COUNT(DISTINCT) 在整个窗口去重，不能累加每小时会话数。
 */
export function readLocalRollupSummary(db: Database, filter: QueryFilter = {}): { counts: TokenCounts; sessions: number } {
  if (filter.userIds?.length) throw new Error('本地派生索引不支持人员筛选，请使用上报库查询')
  return db.transaction(() => {
    sync(db)
    const { sql, params } = buildWhere({ providers: filter.providers, models: filter.models })
    const clauses = sql ? [sql.slice(' WHERE '.length)] : []
    const partial: string[] = []
    if (filter.sinceMs !== undefined) {
      clauses.push('max_ts >= $since'); partial.push('min_ts < $since'); params['$since'] = filter.sinceMs
    }
    if (filter.untilMs !== undefined) {
      clauses.push('min_ts <= $until'); partial.push('max_ts > $until'); params['$until'] = filter.untilMs
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    if (partial.length && db.query(`SELECT 1 FROM ${CELLS}${where} AND (${partial.join(' OR ')}) LIMIT 1`).get(params)) {
      const snapshot = readLocalRollup(db, filter)
      return { counts: snapshot.counts, sessions: snapshot.sessions }
    }
    const row = db.query<Pick<RawCell, 'calls' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'reasoning_tokens'> & { sessions: number }>(`SELECT
      COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COUNT(DISTINCT session_id) AS sessions FROM ${CELLS}${where}`).get(params)!
    return { counts: countsOf(row), sessions: row.sessions }
  })
}
