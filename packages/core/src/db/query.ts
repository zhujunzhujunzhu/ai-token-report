/**
 * 库查询 —— 把 SQL 结果还原成内核的 `TokenCounts` / `UsageRecord`。
 *
 * ## 🚨 本文件最重要的约束：SQL 里不写任何口径公式
 *
 * `packages/shared/src/metrics.ts` 是**唯一**的口径真源（铁律 1）。
 * 因此这里：
 *
 * - ✅ 只做 `SUM(input_tokens)` 这类**原始列求和**，返回四项独立数字
 * - ❌ **绝不**在 SQL 里算 `cache_read/(cache_read+input)`
 * - ❌ **绝不**写 `SUM(input_tokens + output_tokens + ...)` 当作 total 返回给上层
 *
 * 为什么这么严：一旦 SQL 里出现公式，就存在第二个口径实现。
 * 两端口径不一致的 bug 在本仓被明确定义为「极难排查」——
 * 它不会报错，只会让页面上某个数字悄悄不对。
 *
 * 汇总出来的四项交给 `core/types.ts` 的 `derive()` / `shared/metrics.ts` 计算，
 * 与直扫日志路径**走的是同一个函数**，所以两条路径的结果必然逐位相等。
 *
 * ## 与 aggregate.ts 的关系
 *
 * 分组维度复用 `aggregate.ts` 的 `GroupDimension` / `projectName` /
 * `toDayKey` / `toHourKey` —— 保证「SQL 分组」与「内存分组」的键**完全一致**
 * （尤其是 `project` 维度：`D:\Coding\ai-token-report` → `ai-token-report`
 * 这条规则必须只有一份实现，否则两条路径的项目名会对不上）。
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite'

// ★ 时间键与项目名一律复用 aggregate.ts 的实现 ——
//   这两条规则（toDayKey / toHourKey / projectName）必须只有一份实现，
//   否则「SQL 路径」与「内存路径」会算出不同的桶键与项目名。
import { projectName, toDayKey, toHourKey, type GroupDimension } from '../aggregate.js'
import { emptyCounts, type TokenCounts } from '../types.js'
import { EVENT_TABLE } from './schema.js'

/** 查询筛选条件。字段语义与 CLI 的 `--period/--provider/--model` 一致。 */
export interface QueryFilter {
  /** 起始时间（含），epoch ms。 */
  sinceMs?: number
  /** 结束时间（含），epoch ms。 */
  untilMs?: number
  /** provider 子串匹配（大小写不敏感），与 CLI 语义一致。 */
  providers?: string[]
  /** model 子串匹配（大小写不敏感）。 */
  models?: string[]
}

/** 一条从库里还原出来的原始行（对应 `UsageRecord`，但带 project 键）。 */
export interface RawEventRow {
  eventId: string
  sessionId: string
  seq: number
  ts: number
  provider: string
  model: string
  cwd: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/**
 * 构造 WHERE 子句与参数。
 *
 * ## 子串匹配用 LIKE 而非 `=`
 *
 * CLI 的 `--provider dash` 是**子串**匹配（`matchAny` 里用的是 `includes`），
 * 本地页的 `provider` 参数同样如此。若这里改成精确匹配，
 * 「页面上筛选 dashscope 得到 0 条、命令行却有一堆」就会成为一个
 * 只在特定输入下才暴露的口径分叉。
 *
 * ⚠️ LIKE 的 `%` / `_` 必须转义：provider 名里理论上可以含这些字符，
 *   不转义会让「筛选 a_b」意外匹配到 `axb`。用 ESCAPE 子句显式声明转义符。
 */
function buildWhere(filter: QueryFilter): { sql: string; params: SQLQueryBindings } {
  const clauses: string[] = []
  const params: Record<string, string | number> = {}

  if (filter.sinceMs !== undefined) {
    clauses.push('ts >= $since')
    params['$since'] = filter.sinceMs
  }
  if (filter.untilMs !== undefined) {
    clauses.push('ts <= $until')
    params['$until'] = filter.untilMs
  }

  // 多个 pattern 之间是 OR；大小写不敏感靠 LOWER()
  const likeAny = (column: string, patterns: string[] | undefined, prefix: string): void => {
    if (!patterns || patterns.length === 0) return
    const parts: string[] = []
    patterns.forEach((p, i) => {
      const key = `$${prefix}${i}`
      parts.push(`LOWER(${column}) LIKE ${key} ESCAPE '\\'`)
      params[key] = `%${escapeLike(p.toLowerCase())}%`
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }

  likeAny('provider', filter.providers, 'prov')
  likeAny('model', filter.models, 'model')

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

/** 转义 LIKE 的通配符。`\` 必须最先替换，否则会把后加的反斜杠再转义一次。 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * 汇总四项 token 与调用次数。
 *
 * ★ 返回的是**原始四项之和**，不含任何派生指标 —— 派生一律交给
 *   `derive()`。`calls` 单独 COUNT，而不是用某个 token 列代替。
 */
export function queryTotals(db: Database, filter: QueryFilter = {}): TokenCounts {
  const { sql, params } = buildWhere(filter)
  const row = db
    .query<
      {
        calls: number
        input: number | null
        output: number | null
        cache_read: number | null
        cache_write: number | null
        reasoning: number | null
      },
      SQLQueryBindings
    >(
      `SELECT COUNT(*) AS calls,
              SUM(input_tokens)       AS input,
              SUM(output_tokens)      AS output,
              SUM(cache_read_tokens)  AS cache_read,
              SUM(cache_write_tokens) AS cache_write,
              SUM(reasoning_tokens)   AS reasoning
       FROM ${EVENT_TABLE}${sql}`,
    )
    .get(params)

  const counts = emptyCounts()
  if (!row || row.calls === 0) return counts

  counts.input = row.input ?? 0
  counts.output = row.output ?? 0
  counts.cacheRead = row.cache_read ?? 0
  counts.cacheWrite = row.cache_write ?? 0
  counts.reasoning = row.reasoning ?? 0
  counts.calls = row.calls
  // 用恒等式重算 total（与 addCounts 的语义一致：不信任外部 total）
  counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
  return counts
}

/** 涉及的去重会话数。overview 的 `sessions` 字段。 */
export function querySessionCount(db: Database, filter: QueryFilter = {}): number {
  const { sql, params } = buildWhere(filter)
  const row = db
    .query<{ c: number }, SQLQueryBindings>(
      `SELECT COUNT(DISTINCT session_id) AS c FROM ${EVENT_TABLE}${sql}`,
    )
    .get(params)
  return row?.c ?? 0
}

/** 最早 / 最晚事件时间（用于页面显示实际数据边界）。 */
export function queryTimeBounds(
  db: Database,
  filter: QueryFilter = {},
): { earliest: number | null; latest: number | null } {
  const { sql, params } = buildWhere(filter)
  const row = db
    .query<{ lo: number | null; hi: number | null }, SQLQueryBindings>(
      `SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM ${EVENT_TABLE}${sql}`,
    )
    .get(params)
  return { earliest: row?.lo ?? null, latest: row?.hi ?? null }
}

/** 分组聚合的一行（原始四项 + 计数，无派生指标）。 */
export interface QueryGroupRow {
  key: string
  counts: TokenCounts
  firstTime: number
  lastTime: number
  sessions: number
}

/**
 * 按维度分组聚合。
 *
 * ## 分组键在 SQL 里怎么算
 *
 * `provider` / `model` / `session` / `provider-model` 直接用列。
 *
 * ⚠️ **`day` / `hour` 与 `project` 一律不在 SQL 里分组**，而是取出
 *   分组依据的原始列后在 JS 侧调用 `toDayKey()` / `toHourKey()` /
 *   `projectName()`。原因见 {@link dimensionExpression} 的注释。
 */
export function queryGroups(
  db: Database,
  dim: GroupDimension,
  filter: QueryFilter = {},
): QueryGroupRow[] {
  // project 维度走「取出 cwd 后内存分组」的特殊路径
  if (dim === 'project') return queryGroupsByProject(db, filter)
  // day / hour 同理：时间键必须在 JS 侧算
  if (dim === 'day' || dim === 'hour') return queryGroupsByTime(db, dim, filter)

  const dimExpr = dimensionExpression(dim)
  if (!dimExpr) return []

  const { sql, params } = buildWhere(filter)

  const rows = db
    .query<
      {
        key: string
        input: number | null
        output: number | null
        cache_read: number | null
        cache_write: number | null
        reasoning: number | null
        calls: number
        lo: number
        hi: number
        sessions: number
      },
      SQLQueryBindings
    >(
      `SELECT ${dimExpr} AS key,
              SUM(input_tokens)       AS input,
              SUM(output_tokens)      AS output,
              SUM(cache_read_tokens)  AS cache_read,
              SUM(cache_write_tokens) AS cache_write,
              SUM(reasoning_tokens)   AS reasoning,
              COUNT(*)                AS calls,
              MIN(ts)                 AS lo,
              MAX(ts)                 AS hi,
              COUNT(DISTINCT session_id) AS sessions
       FROM ${EVENT_TABLE}${sql}
       GROUP BY key`,
    )
    .all(params)

  const out: QueryGroupRow[] = rows.map((r) => {
    const counts = emptyCounts()
    counts.input = r.input ?? 0
    counts.output = r.output ?? 0
    counts.cacheRead = r.cache_read ?? 0
    counts.cacheWrite = r.cache_write ?? 0
    counts.reasoning = r.reasoning ?? 0
    counts.calls = r.calls
    counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    return {
      key: r.key,
      counts,
      firstTime: r.lo,
      lastTime: r.hi,
      sessions: r.sessions,
    }
  })

  return sortGroupRows(out, dim)
}

/**
 * 维度 → SQL 表达式。返回 null 表示该维度需要特殊处理（在 JS 侧分组）。
 *
 * 🚨 **`day` / `hour` 返回 null 是有意为之，不要「优化」成 `strftime`。**
 *
 * 看起来 `strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime')` 与
 * `toDayKey()` 等价，实际**不是**：
 *
 * - SQLite 的 `'localtime'` 依据 **操作系统时区**
 * - JS 的 `new Date().getHours()` 依据 **进程的 TZ 解析结果**
 *
 * 两者在本项目的 `bun test` 环境下实测**不一致**：
 *
 * | 环境 | `new Date().getTimezoneOffset()` | SQLite `'localtime'` |
 * |---|---|---|
 * | `bun run` | -480（+08:00，正确） | +08:00 |
 * | `bun test` | **0（被强制成 UTC）** | **仍是 +08:00** |
 *
 * 于是同一份数据在测试里会分到相差 8 小时的桶：SQL 侧 `2026-09-25T00`、
 * 内存侧 `2026-09-24T16`。这会直接表现为「趋势图的点错位」，
 * 而且**只在测试环境下暴露**，本地手测完全正常 —— 最难查的一类 bug。
 *
 * 因此时间分桶一律在 JS 侧用 `toDayKey()` / `toHourKey()` 做：
 * 那是全仓唯一的时间键实现，两条路径必然一致，也不受 TZ 解析差异影响。
 * 代价是 `day` / `hour` 分组要多一次 `(ts, 四项, session_id)` 的取值，
 * 实测在 16k 行上仍是毫秒级。
 */
function dimensionExpression(dim: GroupDimension): string | null {
  switch (dim) {
    case 'provider':
      return 'provider'
    case 'model':
      return 'model'
    case 'session':
      return 'session_id'
    case 'provider-model':
      // 分隔符必须与 aggregate.ts 的 groupKey() 一致（`provider/model`）
      return "provider || '/' || model"
    case 'day':
    case 'hour':
      // ⚠️ 见上方 🚨 注释：故意交给 JS 侧分桶，不要改成 strftime
      return null
    case 'project':
      // 需要 projectName() 的目录切分规则，交给 JS 侧
      return null
  }
}

/**
 * 时间维度（day / hour）分组：取出原始行，在 JS 侧用
 * `toDayKey()` / `toHourKey()` 归并。
 *
 * ★ 这是唯一能保证「SQL 路径的桶 == 内存路径的桶」的做法 ——
 *   时间键实现只有一份（`aggregate.ts`），不受时区解析差异影响。
 */
function queryGroupsByTime(
  db: Database,
  dim: 'day' | 'hour',
  filter: QueryFilter,
): QueryGroupRow[] {
  const { sql, params } = buildWhere(filter)

  const rows = db
    .query<
      {
        ts: number
        session_id: string
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        reasoning_tokens: number
      },
      SQLQueryBindings
    >(
      `SELECT ts, session_id, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, reasoning_tokens
       FROM ${EVENT_TABLE}${sql}`,
    )
    .all(params)

  const merged = new Map<string, QueryGroupRow>()
  // 每个 (bucket, session) 只计一次，用于 sessions 去重
  const sessionSets = new Map<string, Set<string>>()

  for (const r of rows) {
    const key = dim === 'day' ? toDayKey(r.ts) : toHourKey(r.ts)
    let row = merged.get(key)
    if (!row) {
      row = {
        key,
        counts: emptyCounts(),
        firstTime: r.ts,
        lastTime: r.ts,
        sessions: 0,
      }
      merged.set(key, row)
      sessionSets.set(key, new Set())
    }
    row.counts.input += r.input_tokens
    row.counts.output += r.output_tokens
    row.counts.cacheRead += r.cache_read_tokens
    row.counts.cacheWrite += r.cache_write_tokens
    row.counts.reasoning += r.reasoning_tokens
    row.counts.calls += 1
    row.counts.total =
      row.counts.input + row.counts.output + row.counts.cacheRead + row.counts.cacheWrite
    // ts=0 视为「无时间」，不参与边界计算 —— 与 aggregate() 的语义一致
    if (r.ts > 0) {
      if (row.firstTime === 0 || r.ts < row.firstTime) row.firstTime = r.ts
      if (r.ts > row.lastTime) row.lastTime = r.ts
    }
    sessionSets.get(key)!.add(r.session_id)
  }

  for (const [key, set] of sessionSets) {
    const row = merged.get(key)
    if (row) row.sessions = set.size
  }

  return sortGroupRows([...merged.values()], dim)
}

/**
 * `project` 维度的分组：取出 distinct cwd 的四个原始列，在 JS 里按
 * `projectName()` 归并。
 *
 * 同一 cwd 前缀可能对应多个项目目录（`D:\a\proj` 与 `D:\b\proj`
 * 都叫 `proj`），所以必须按 **cwd 先聚合、再按项目名合并**，
 * 而不能直接把 projectName 塞进 SQL 的 GROUP BY。
 */
function queryGroupsByProject(db: Database, filter: QueryFilter): QueryGroupRow[] {
  const { sql, params } = buildWhere(filter)

  const rows = db
    .query<
      {
        cwd: string | null
        input: number | null
        output: number | null
        cache_read: number | null
        cache_write: number | null
        reasoning: number | null
        calls: number
        lo: number
        hi: number
        sessions: number
      },
      SQLQueryBindings
    >(
      `SELECT cwd,
              SUM(input_tokens)       AS input,
              SUM(output_tokens)      AS output,
              SUM(cache_read_tokens)  AS cache_read,
              SUM(cache_write_tokens) AS cache_write,
              SUM(reasoning_tokens)   AS reasoning,
              COUNT(*)                AS calls,
              MIN(ts)                 AS lo,
              MAX(ts)                 AS hi,
              COUNT(DISTINCT session_id) AS sessions
       FROM ${EVENT_TABLE}${sql}
       GROUP BY cwd`,
    )
    .all(params)

  const merged = new Map<string, QueryGroupRow>()
  // 各项目下的会话集合，用于合并后的去重计数（直接相加会把同一会话算两次）
  const sessionSets = new Map<string, Set<string>>()

  for (const r of rows) {
    const key = projectName(r.cwd)
    let row = merged.get(key)
    if (!row) {
      row = {
        key,
        counts: emptyCounts(),
        firstTime: r.lo,
        lastTime: r.hi,
        sessions: 0,
      }
      merged.set(key, row)
      sessionSets.set(key, new Set())
    }
    row.counts.input += r.input ?? 0
    row.counts.output += r.output ?? 0
    row.counts.cacheRead += r.cache_read ?? 0
    row.counts.cacheWrite += r.cache_write ?? 0
    row.counts.reasoning += r.reasoning ?? 0
    row.counts.calls += r.calls
    row.counts.total =
      row.counts.input + row.counts.output + row.counts.cacheRead + row.counts.cacheWrite
    if (r.lo < row.firstTime) row.firstTime = r.lo
    if (r.hi > row.lastTime) row.lastTime = r.hi
  }

  // ★ sessions 必须按「项目名」重新去重，而不是把各 cwd 的 COUNT(DISTINCT session_id) 相加：
  //   同一个项目名下可能有多个 cwd 前缀（D:\a\proj 与 D:\b\proj 都叫 proj），
  //   若同一会话在两者下都出现（迁移过目录），相加会把一个会话算两次。
  //   这里单独查一次 (cwd, session_id) 的 distinct 组合再在 JS 侧归并。
  for (const r of db
    .query<{ cwd: string | null; session_id: string }, SQLQueryBindings>(
      `SELECT DISTINCT cwd, session_id FROM ${EVENT_TABLE}${sql}`,
    )
    .all(params)) {
    sessionSets.get(projectName(r.cwd))?.add(r.session_id)
  }
  for (const [key, set] of sessionSets) {
    const row = merged.get(key)
    if (row) row.sessions = set.size
  }

  return sortGroupRows([...merged.values()], 'project')
}

/**
 * 排序：时间维度升序（趋势可读），其余按用量降序（找大户）。
 *
 * ★ 与 `aggregate()` 的排序规则**必须一致** —— 否则同一份数据
 *   在两条路径下的表格行序不同，看起来像「数据变了」。
 */
function sortGroupRows(rows: QueryGroupRow[], dim: GroupDimension): QueryGroupRow[] {
  if (dim === 'day' || dim === 'hour') {
    return rows.sort((a, b) => a.key.localeCompare(b.key))
  }
  return rows.sort((a, b) => b.counts.total - a.counts.total)
}

/**
 * 时间序列：按天/小时分桶，每个桶四项原始列 + 调用次数。
 *
 * 🚨 **分桶在 JS 侧用 `toDayKey()` / `toHourKey()` 做**，不用 SQL 的
 *   `strftime(..., 'localtime')` —— 理由与 {@link dimensionExpression}
 *   的注释完全相同（SQLite 时区与 JS 时区在 `bun test` 下会差 8 小时）。
 *   趋势图对桶键错位极其敏感：8 小时的偏移会让点整体平移，
 *   甚至把「今天」的数据划到「昨天」。
 *
 * ⚠️ **不在这里补零**。补零由 `aggregate.ts` 的 `timeSeries()` 负责，
 *   而那需要完整的 `UsageRecord[]`。为了让两条路径补齐逻辑完全一致，
 *   这里只返回有数据的桶，由调用方（`db/stats.ts`）决定是否需要补零。
 */
export function querySeries(
  db: Database,
  granularity: 'day' | 'hour',
  filter: QueryFilter = {},
): { bucket: string; counts: TokenCounts }[] {
  const { sql, params } = buildWhere(filter)

  const rows = db
    .query<
      {
        ts: number
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        reasoning_tokens: number
      },
      SQLQueryBindings
    >(
      `SELECT ts, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, reasoning_tokens
       FROM ${EVENT_TABLE}${sql}`,
    )
    .all(params)

  const merged = new Map<string, TokenCounts>()
  for (const r of rows) {
    const bucket = granularity === 'day' ? toDayKey(r.ts) : toHourKey(r.ts)
    let counts = merged.get(bucket)
    if (!counts) {
      counts = emptyCounts()
      merged.set(bucket, counts)
    }
    counts.input += r.input_tokens
    counts.output += r.output_tokens
    counts.cacheRead += r.cache_read_tokens
    counts.cacheWrite += r.cache_write_tokens
    counts.reasoning += r.reasoning_tokens
    counts.calls += 1
    counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
  }

  // 桶键升序，与 timeSeries() 的输出顺序一致
  return [...merged.entries()]
    .map(([bucket, counts]) => ({ bucket, counts }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/**
 * 取出全部原始记录，还原成 `UsageRecord[]`。
 *
 * 用于「需要复用 `aggregate.ts` 全部能力」的场景（如 CLi 的多维度输出、
 * `--list-providers`）。⚠️ 这是**唯一会物化全量记录**的函数，
 * 16,021 条约 20 ms —— 只在确实需要时才调用。
 */
export function queryRecords(db: Database, filter: QueryFilter = {}): {
  eventId: string
  sessionId: string
  seq: number
  time: number
  provider: string
  model: string
  cwd: string | null
  turn: number | null
  step: number | null
  usage: TokenCounts
}[] {
  const { sql, params } = buildWhere(filter)
  const rows = db
    .query<
      {
        event_id: string
        session_id: string
        seq: number
        ts: number
        provider: string
        model: string
        cwd: string | null
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_write_tokens: number
        reasoning_tokens: number
        turn: number | null
        step: number | null
      },
      SQLQueryBindings
    >(
      `SELECT event_id, session_id, seq, ts, provider, model, cwd,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, turn, step
       FROM ${EVENT_TABLE}${sql}
       ORDER BY ts ASC, seq ASC`,
    )
    .all(params)

  return rows.map((r) => {
    const usage = emptyCounts()
    usage.input = r.input_tokens
    usage.output = r.output_tokens
    usage.cacheRead = r.cache_read_tokens
    usage.cacheWrite = r.cache_write_tokens
    usage.reasoning = r.reasoning_tokens
    usage.calls = 1
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    return {
      eventId: r.event_id,
      sessionId: r.session_id,
      seq: r.seq,
      time: r.ts,
      provider: r.provider,
      model: r.model,
      cwd: r.cwd,
      turn: r.turn,
      step: r.step,
      usage,
    }
  })
}

/** 出现过的 provider（诊断用）。 */
export function queryProviders(db: Database): string[] {
  return db
    .query<{ provider: string }, []>(
      `SELECT DISTINCT provider FROM ${EVENT_TABLE} ORDER BY provider`,
    )
    .all()
    .map((r) => r.provider)
}

/** 库内记录总数与时间边界（诊断用）。 */
export function queryDbStats(db: Database): {
  events: number
  earliest: number | null
  latest: number | null
  lastIngestMs: number | null
} {
  const events = countRows(db)
  const bounds = queryTimeBounds(db)
  const run = db
    .query<{ last_ingest_ms: number }, []>('SELECT last_ingest_ms FROM ingest_run WHERE id = 1')
    .get()
  return {
    events,
    earliest: bounds.earliest,
    latest: bounds.latest,
    lastIngestMs: run?.last_ingest_ms ?? null,
  }
}

/**
 * 上次 ingest 期间观察到的**解析诊断**。
 *
 * 这些计数只能在解析日志时得到（解压了多少帧、有多少事件缺 usage、
 * 恒等式校验失败几条……），因此由 `ingest.ts` 持久化在 `ingest_run` 表里，
 * 这里读回来供 `/api/local/stats/diagnostics` 使用。
 *
 * 🚨 没有这组数字，「数据悄悄少了一部分」这类故障几乎无法发现 ——
 *   库里的行数永远自洽，它不会告诉你「日志里有 5 条 usage 被丢掉了」。
 *
 * 从未 ingest 过时返回 null（页面据此显示「尚无扫描记录」）。
 */
export function queryScanDiagnostics(db: Database): {
  lastIngestMs: number
  totalEvents: number
  usageEvents: number
  framesOk: number
  framesFailed: number
  filesScanned: number
  filesFailed: number
  assistantMessagesWithoutUsage: number
  totalTokenMismatches: number
  retryStarted: number
  retry: number
  attempts: number
  missingProvider: number
  eventTypes: Record<string, number>
  providersSeen: string[]
} | null {
  const row = db
    .query<
      {
        last_ingest_ms: number
        last_scan_events: number
        usage_events: number
        frames_ok: number
        frames_failed: number
        files_scanned: number
        files_failed: number
        assistant_without_usage: number
        mismatch_count: number
        retry_started: number
        retry: number
        attempts: number
        missing_provider: number
        event_types_json: string
        providers_json: string
      },
      []
    >(
      `SELECT last_ingest_ms, last_scan_events, usage_events, frames_ok, frames_failed,
              files_scanned, files_failed, assistant_without_usage, mismatch_count,
              retry_started, retry, attempts, missing_provider,
              event_types_json, providers_json
       FROM ingest_run WHERE id = 1`,
    )
    .get()

  if (!row) return null

  return {
    lastIngestMs: row.last_ingest_ms,
    totalEvents: row.last_scan_events,
    usageEvents: row.usage_events,
    framesOk: row.frames_ok,
    framesFailed: row.frames_failed,
    filesScanned: row.files_scanned,
    filesFailed: row.files_failed,
    assistantMessagesWithoutUsage: row.assistant_without_usage,
    totalTokenMismatches: row.mismatch_count,
    retryStarted: row.retry_started,
    retry: row.retry,
    attempts: row.attempts,
    missingProvider: row.missing_provider,
    // JSON 解析失败必须降级为空值，而不是抛错让诊断接口整个挂掉
    eventTypes: safeParse<Record<string, number>>(row.event_types_json, {}),
    providersSeen: safeParse<string[]>(row.providers_json, []),
  }
}

/** JSON 解析失败时返回兜底值（诊断数据不值得让整个请求失败）。 */
function safeParse<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed === null || typeof parsed !== 'object' ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

function countRows(db: Database): number {
  return (
    db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`).get()?.c ?? 0
  )
}