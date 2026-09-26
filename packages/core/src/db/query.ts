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

// 驱动类型来自适配层（Bun → bun:sqlite / Node → node:sqlite）。
// 🚨 这里**只换类型来源**，SQL 文本与口径公式一个字都不动。
import type { Database, SQLQueryBindings } from './driver.js'

// ★ 时间键与项目名一律复用 aggregate.ts 的实现 ——
//   这两条规则（toDayKey / toHourKey / projectName）必须只有一份实现，
//   否则「SQL 路径」与「内存路径」会算出不同的桶键与项目名。
import { projectName, toDayKey, toHourKey, type GroupDimension } from '../aggregate.js'
import { emptyCounts, type TokenCounts } from '../types.js'
import { EVENT_TABLE } from './schema.js'
import { SQLITE_DIALECT, type PortalDialect } from './dialect.js'
import { UNATTRIBUTED_USER } from '@ai-token-report/shared'

/**
 * 查询层可用的分组维度 = 内核维度 + `user`。
 *
 * ## 为什么 `user` 不并进 `aggregate.ts` 的 `GroupDimension`
 *
 * `GroupDimension` 是**内存聚合**（直扫日志路径）的维度集合，而日志里
 * 根本没有归属信息 —— 本机日志只属于我一个人（见 `schema.ts` 里
 * `user_id` 三列的注释）。把 `user` 塞进去只会得到一个恒为
 * `unknown` 的维度，却让 CLI 的 `--by` 多出一个永远没意义的选项。
 *
 * 归属只有上报库才有，而上报库**只有 SQL 一条路径**（`portal.ts`），
 * 所以这个维度只属于查询层。
 */
export type QueryDimension = GroupDimension | 'user'

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
  /**
   * 归属筛选（**精确匹配**，多个之间是 OR）。
   *
   * ⚠️ 刻意不做子串匹配：provider / model 用子串是「找一类模型」的便利，
   *   而人名做子串会把「张三」和「张三丰」混成一个人 —— 那是数据错误。
   *
   * 特殊值 {@link UNATTRIBUTED_USER} 表示**未归属**（`user_id IS NULL`），
   * 与分组键 `COALESCE(user_id, 'unknown')` 是同一套语义。
   */
  userIds?: string[]
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
 *
 * ★ 本函数是**唯一的筛选条件实现**（`portal.ts` 也用它），
 *   因此「按人筛选」不会出现第二套 SQL —— 两套筛选条件的漂移不会有任何报错，
 *   只会让某个接口的过滤悄悄失效。
 */
export function buildWhere(filter: QueryFilter): {
  sql: string
  params: Record<string, string | number>
} {
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
      parts.push(`LOWER(${column}) LIKE ${key} ESCAPE '!'`)
      params[key] = `%${escapeLike(p.toLowerCase())}%`
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }

  likeAny('provider', filter.providers, 'prov')
  likeAny('model', filter.models, 'model')

  // 归属：精确匹配。`unknown` 走 IS NULL —— 库里未归属的行 user_id 为 NULL，
  // 而不是字符串 'unknown'（本机库的归属三列恒为 NULL，见 schema.ts）。
  if (filter.userIds && filter.userIds.length > 0) {
    const parts: string[] = []
    filter.userIds.forEach((u, i) => {
      if (u === UNATTRIBUTED_USER) {
        parts.push('user_id IS NULL')
        return
      }
      const key = `$user${i}`
      parts.push(`user_id = ${key}`)
      params[key] = u
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

/** 两个数据库统一用 ! 转义，避免 MySQL 字符串反斜线模式改变 SQL 语义。 */
function escapeLike(s: string): string {
  return s.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')
}

// ─────────────────────────────────────────────────────────────
// ★ SQL 构建器 —— 本仓**唯一的 SQL 文本来源**
// ─────────────────────────────────────────────────────────────

/**
 * 一条已构建但未执行的查询：文本 + **`$name` 具名参数**。
 *
 * ★ 参数一律保持 `$name` 形状：SQLite 驱动直接吃具名参数，而 MySQL 侧由
 *   `mysql.ts` 的 `toPositional()` 翻成 `?` 位置参数（同名参数出现多次会各补一个值）。
 *   于是**同一条 SQL 文本能跑在两种后端上** —— 这是「换个后端不该换口径」
 *   的机制保证，而不是靠两边小心地写一样的话。
 *
 * ⚠️ 这些构建器只产出 SQL 与参数，**不执行**：本地路径（`queryTotals` 等）
 *   拿它喂同步的 SQLite `Database`，部门路径（`portal.ts`）拿它喂异步的
 *   `PortalStore`。执行方式不同，SQL 只有一份。
 */
export interface SqlQuery {
  sql: string
  params: Record<string, string | number>
}

/**
 * 驱动返回值 → 数字。
 *
 * 🚨 **这个函数存在的唯一理由是 MySQL 的 `SUM(BIGINT)` 经驱动返回字符串**
 *   （实测 `{"calls":3,"input":"60"}` —— `COUNT(*)` 是数字、`SUM()` 是 `"60"`，
 *   因为 MySQL 的 SUM 结果是 DECIMAL，驱动按精度优先给字符串）。
 *   不归一的话，页面上的 token 数字会变成字符串拼接或 NaN，
 *   **而不会有任何报错**。
 *
 * ⚠️ `null` / `undefined`（空表的 SUM、缺列）一律当 0：调用方拿到的必须是
 *   一个可以直接参与运算的数字。
 */
export function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 同 {@link toNumber}，但**保留 SQL 的 NULL**。
 *
 * ⚠️ 时间边界（`MIN(ts)` / `MAX(ts)`）与「最近落库时刻」上，NULL 的语义是
 *   **「没有数据」而不是 0**：把它折成 0 会让页面显示「最早数据来自 1970 年」，
 *   或者让「从未上报」看起来像「1970 年上报过」。
 */
export function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 汇总四项 token 与调用次数（本地路径 `queryTotals` 与部门看板共用）。 */
export function totalsQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT COUNT(*) AS calls,
                 SUM(input_tokens)       AS input,
                 SUM(output_tokens)      AS output,
                 SUM(cache_read_tokens)  AS cache_read,
                 SUM(cache_write_tokens) AS cache_write,
                 SUM(reasoning_tokens)   AS reasoning
          FROM ${EVENT_TABLE}${sql}`,
    params,
  }
}

/** 去重会话数。 */
export function sessionCountQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT COUNT(DISTINCT session_id) AS c FROM ${EVENT_TABLE}${sql}`,
    params,
  }
}

/** 最早 / 最晚事件时间。 */
export function timeBoundsQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM ${EVENT_TABLE}${sql}`,
    params,
  }
}

/**
 * 未归属（`user_id IS NULL`）的调用条数。
 *
 * ★ 它必须与 {@link totalsQuery} 打上**同一组筛选条件**（同一个 filter），
 *   否则比值的分子分母来自两个数据集 —— 会算出大于 1 的占比。
 */
export function unattributedCallsQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  // 未归属条件与筛选条件用 AND 组合：filter 里若已有 user_id 条件，
  // 也能正确收敛（例如只看某个已署名的人 → 未归属恒为 0）
  const clause = sql ? `${sql} AND user_id IS NULL` : ' WHERE user_id IS NULL'
  return { sql: `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${clause}`, params }
}

/** 已署名人数（按 `user_id` 去重）。 */
export function distinctUsersQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT COUNT(DISTINCT user_id) AS c FROM ${EVENT_TABLE}${sql}`,
    params,
  }
}

/** 最近一次落库时刻。 */
export function ingestMomentQuery(): SqlQuery {
  return { sql: 'SELECT last_ingest_ms FROM ingest_run WHERE id = 1', params: {} }
}

/**
 * 按维度分组聚合的 SQL。**返回 null 表示该维度必须走 JS 侧分组**
 * （`day` / `hour` / `project`），与 {@link dimensionExpression} 的语义一致。
 *
 * ⚠️ 分组别名是 `grp_key` 而不是 `key`：**`key` 是 MySQL 保留字**，
 *   `SELECT ... AS key` 在 MySQL 上直接语法错误（SQLite 允许）。
 *   读取后由 {@link mapGroupRows} 映射回对外契约里的 `key`。
 */
export function groupsQuery(
  dim: QueryDimension,
  filter: QueryFilter = {},
  dialect: PortalDialect = SQLITE_DIALECT,
): SqlQuery | null {
  const dimExpr = dimensionExpression(dim, dialect)
  if (!dimExpr) return null

  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT ${dimExpr} AS grp_key,
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
          GROUP BY grp_key`,
    params,
  }
}

/**
 * `day` / `hour` 分组与时间序列用的**原始行**（不在 SQL 里分桶）。
 *
 * 🚨 分桶必须在 JS 侧做，理由见 {@link dimensionExpression} 的注释。
 *   `withSessionId` 只有分组才需要（会话要去重计数），序列不需要 ——
 *   少取一列在大表上就是少一次宽行扫。
 */
export function timeBucketRowsQuery(filter: QueryFilter = {}, withSessionId = false): SqlQuery {
  const { sql, params } = buildWhere(filter)
  const cols = withSessionId
    ? 'ts, session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens'
    : 'ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens'
  return { sql: `SELECT ${cols}\n       FROM ${EVENT_TABLE}${sql}`, params }
}

/**
 * `project` 维度的第一段：按 cwd 聚合。
 *
 * ⚠️ 不能直接把 `projectName(cwd)` 塞进 SQL 的 GROUP BY —— 目录切分规则
 *   （`D:\a\proj` → `proj`）只有 `aggregate.ts` 一份实现，SQL 里再写一遍
 *   就是第二条项目名实现。所以先按 cwd 聚合，再在 JS 侧按项目名合并。
 */
export function projectGroupsQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return {
    sql: `SELECT cwd,
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
    params,
  }
}

/**
 * `project` 维度的第二段：`(cwd, session_id)` 去重对。
 *
 * ★ 合并后的 sessions 必须**按项目名重新去重**，不能把各 cwd 的
 *   `COUNT(DISTINCT session_id)` 相加：同一项目名下可能有多个 cwd 前缀
 *   （`D:\a\proj` 与 `D:\b\proj` 都叫 `proj`），同一会话在两者下都出现时
 *   相加会把它算两次。
 */
export function projectSessionsQuery(filter: QueryFilter = {}): SqlQuery {
  const { sql, params } = buildWhere(filter)
  return { sql: `SELECT DISTINCT cwd, session_id FROM ${EVENT_TABLE}${sql}`, params }
}

/**
 * 汇总四项 token 与调用次数。
 *
 * ★ 返回的是**原始四项之和**，不含任何派生指标 —— 派生一律交给
 *   `derive()`。`calls` 单独 COUNT，而不是用某个 token 列代替。
 */
export function queryTotals(db: Database, filter: QueryFilter = {}): TokenCounts {
  const q = totalsQuery(filter)
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
    >(q.sql)
    .get(q.params)

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
  const q = sessionCountQuery(filter)
  const row = db.query<{ c: number }, SQLQueryBindings>(q.sql).get(q.params)
  return row?.c ?? 0
}

/** 最早 / 最晚事件时间（用于页面显示实际数据边界）。 */
export function queryTimeBounds(
  db: Database,
  filter: QueryFilter = {},
): { earliest: number | null; latest: number | null } {
  const q = timeBoundsQuery(filter)
  const row = db
    .query<{ lo: number | null; hi: number | null }, SQLQueryBindings>(q.sql)
    .get(q.params)
  return { earliest: row?.lo ?? null, latest: row?.hi ?? null }
}

/**
 * 未归属（`user_id IS NULL`）的调用条数。
 *
 * ★ 部门看板的「未归属占比」分子。它与 `queryTotals().calls` 必须打上
 *   **同一组筛选条件**（都传同一个 `filter`），否则比值的分子分母来自
 *   两个不同的数据集 —— 那会算出大于 1 的占比，而页面只会显示成
 *   「覆盖率 -20%」这种没人看得懂的数字。
 */
export function queryUnattributedCalls(db: Database, filter: QueryFilter = {}): number {
  const q = unattributedCallsQuery(filter)
  const row = db.query<{ c: number }, SQLQueryBindings>(q.sql).get(q.params)
  return row?.c ?? 0
}

/**
 * 已上报的**人数**（按 `user_id` 去重，未归属不计入）。
 *
 * ⚠️ 它数的是「有归属的人」而不是「机器」：凭证表里没有设备维度，
 *   一台机器换人上报会算成两个人。这是当前 schema 的边界，不是 bug ——
 *   页面上的文案要说「已署名人数」，不要说「在线机器数」。
 */
export function queryDistinctUsers(db: Database, filter: QueryFilter = {}): number {
  const q = distinctUsersQuery(filter)
  const row = db.query<{ c: number }, SQLQueryBindings>(q.sql).get(q.params)
  return row?.c ?? 0
}

/** 最近一次落库时刻（`ingest_run.last_ingest_ms`）。从未记录过时返回 null。 */
export function queryIngestMoment(db: Database): number | null {
  const q = ingestMomentQuery()
  const row = db
    .query<{ last_ingest_ms: number }, []>(q.sql)
    .get()
  return row?.last_ingest_ms ?? null
}

/** 分组聚合的一行（原始四项 + 计数，无派生指标）。 */
/**
 * 分组聚合的一行（原始四项 + 计数，无派生指标）。
 *
 * ⚠️ 字段名 `key` 是**对外契约**，与 SQL 里的别名 `grp_key` 不同 ——
 *   后者是为了绕开 MySQL 的保留字（见 {@link groupsQuery}）。
 */
export interface QueryGroupRow {
  key: string
  counts: TokenCounts
  firstTime: number
  lastTime: number
  sessions: number
}

/**
 * 分组 SQL 的**原始行**（`groupsQuery` 的产出形状）。
 *
 * ⚠️ 数值字段声明成 `unknown` 是有意的：SQLite 驱动给数字，MySQL 驱动给
 *   字符串（`SUM()` 是 DECIMAL）。两侧都经 {@link toNumber} 归一，
 *   类型上就不给「直接当数字用」的机会。
 */
export interface RawGroupRow {
  grp_key: string | null
  input: unknown
  output: unknown
  cache_read: unknown
  cache_write: unknown
  reasoning: unknown
  calls: unknown
  lo: unknown
  hi: unknown
  sessions: unknown
}

/**
 * 分组 SQL 的原始行 → 内核形状。
 *
 * ★ 两种后端共用这一份映射（本地路径 `queryGroups` 与部门路径 `portal.ts`）——
 *   若各写一遍，「MySQL 忘了归一 SUM 字符串」这类问题就会只在看板上出现。
 */
export function mapGroupRows(rows: readonly RawGroupRow[]): QueryGroupRow[] {
  return rows.map((r) => {
    const counts = emptyCounts()
    counts.input = toNumber(r.input)
    counts.output = toNumber(r.output)
    counts.cacheRead = toNumber(r.cache_read)
    counts.cacheWrite = toNumber(r.cache_write)
    counts.reasoning = toNumber(r.reasoning)
    counts.calls = toNumber(r.calls)
    counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    return {
      key: r.grp_key ?? '',
      counts,
      firstTime: toNumber(r.lo),
      lastTime: toNumber(r.hi),
      sessions: toNumber(r.sessions),
    }
  })
}

/**
 * 分组聚合。
 *
 * ## 分组键在 SQL 里怎么算
 *
 * `provider` / `model` / `session` / `provider-model` 直接用列
 * （SQL 由 {@link groupsQuery} 产出，两种后端共用）。
 *
 * ⚠️ **`day` / `hour` 与 `project` 一律不在 SQL 里分组**，而是取出
 *   分组依据的原始列后在 JS 侧调用 `toDayKey()` / `toHourKey()` /
 *   `projectName()`。原因见 {@link dimensionExpression} 的注释。
 *
 * ★ `dialect` 只在 `provider-model` 维度上有影响（拼接表达式），
 *   本地调用方不传即 SQLite 语义，**行为与迁移前逐字一致**。
 */
export function queryGroups(
  db: Database,
  dim: QueryDimension,
  filter: QueryFilter = {},
  dialect: PortalDialect = SQLITE_DIALECT,
): QueryGroupRow[] {
  // project 维度走「取出 cwd 后内存分组」的特殊路径
  if (dim === 'project') return queryGroupsByProject(db, filter)
  // day / hour 同理：时间键必须在 JS 侧算
  if (dim === 'day' || dim === 'hour') return queryGroupsByTime(db, dim, filter)

  const q = groupsQuery(dim, filter, dialect)
  if (!q) return []

  const rows = db.query<RawGroupRow, SQLQueryBindings>(q.sql).all(q.params)

  return sortGroupRows(mapGroupRows(rows), dim)
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
 *
 * ## 🚨 拼接必须走方言（`provider-model`）
 *
 * `provider || '/' || model` 在 SQLite 是字符串拼接，在 **MySQL 是逻辑或** ——
 * 实测返回 `0` / `1`，于是分组键静默变成 `"0"` / `"1"`：看板上的模型分布
 * 变成两行垃圾数据，**没有任何报错**。所以这里调 `dialect.concat()`，
 * MySQL 侧生成 `CONCAT(provider, '/', model)`。
 */
function dimensionExpression(
  dim: QueryDimension,
  dialect: PortalDialect = SQLITE_DIALECT,
): string | null {
  switch (dim) {
    case 'provider':
      return 'provider'
    case 'model':
      return 'model'
    case 'session':
      return 'session_id'
    case 'provider-model':
      // 分隔符必须与 aggregate.ts 的 groupKey() 一致（`provider/model`）
      return dialect.concat(['provider', "'/'", 'model'])
    case 'user':
      // ★ 未归属归到 UNATTRIBUTED_USER 这一组，而不是被 GROUP BY 丢进 NULL ——
      //   人员排行里必须看得见「有 3 个人没署名」，否则覆盖率问题永远浮不上来。
      //   该值与 `QueryFilter.userIds` 的筛选语义、协议里的 `userId === 'unknown'`
      //   是同一个字符串（契约里只有一份定义）。
      return `COALESCE(user_id, '${UNATTRIBUTED_USER}')`
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
 * 时间维度（day / hour）分组用的**原始行**。
 *
 * ⚠️ 数值字段是 `unknown`：SQLite 驱动给数字，MySQL 驱动给字符串（`SUM()`）。
 */
export interface TimeBucketRow {
  ts: unknown
  session_id?: unknown
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  cache_write_tokens: unknown
  reasoning_tokens: unknown
}

/**
 * 时间维度（day / hour）分组：取出原始行，在 JS 侧用
 * `toDayKey()` / `toHourKey()` 归并。
 *
 * ★ 这是唯一能保证「SQL 路径的桶 == 内存路径的桶」的做法 ——
 *   时间键实现只有一份（`aggregate.ts`），不受时区解析差异影响。
 * ★ 两种后端共用本函数（本地 `queryGroupsByTime` 与部门 `portal.ts`）。
 */
export function groupRowsFromTime(
  rows: readonly TimeBucketRow[],
  dim: 'day' | 'hour',
): QueryGroupRow[] {
  const merged = new Map<string, QueryGroupRow>()
  // 每个 (bucket, session) 只计一次，用于 sessions 去重
  const sessionSets = new Map<string, Set<string>>()

  for (const r of rows) {
    const ts = toNumber(r.ts)
    const key = dim === 'day' ? toDayKey(ts) : toHourKey(ts)
    let row = merged.get(key)
    if (!row) {
      row = {
        key,
        counts: emptyCounts(),
        firstTime: ts,
        lastTime: ts,
        sessions: 0,
      }
      merged.set(key, row)
      sessionSets.set(key, new Set())
    }
    row.counts.input += toNumber(r.input_tokens)
    row.counts.output += toNumber(r.output_tokens)
    row.counts.cacheRead += toNumber(r.cache_read_tokens)
    row.counts.cacheWrite += toNumber(r.cache_write_tokens)
    row.counts.reasoning += toNumber(r.reasoning_tokens)
    row.counts.calls += 1
    row.counts.total =
      row.counts.input + row.counts.output + row.counts.cacheRead + row.counts.cacheWrite
    // ts=0 视为「无时间」，不参与边界计算 —— 与 aggregate() 的语义一致
    if (ts > 0) {
      if (row.firstTime === 0 || ts < row.firstTime) row.firstTime = ts
      if (ts > row.lastTime) row.lastTime = ts
    }
    sessionSets.get(key)!.add(String(r.session_id ?? ''))
  }

  for (const [key, set] of sessionSets) {
    const row = merged.get(key)
    if (row) row.sessions = set.size
  }

  return sortGroupRows([...merged.values()], dim)
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
  const q = timeBucketRowsQuery(filter, true)
  const rows = db.query<TimeBucketRow, SQLQueryBindings>(q.sql).all(q.params)
  return groupRowsFromTime(rows, dim)
}

/**
 * `project` 维度按 cwd 聚合后的原始行。
 *
 * ⚠️ 数值字段 `unknown` 的理由同 {@link TimeBucketRow}。
 */
export interface ProjectGroupRow {
  cwd: unknown
  input: unknown
  output: unknown
  cache_read: unknown
  cache_write: unknown
  reasoning: unknown
  calls: unknown
  lo: unknown
  hi: unknown
}

/** `(cwd, session_id)` 去重对。 */
export interface ProjectSessionPair {
  cwd: unknown
  session_id: unknown
}

/**
 * `project` 维度的分组：把「按 cwd 聚合的行」与「(cwd, session) 对」
 * 在 JS 里按 `projectName()` 归并。
 *
 * 同一 cwd 前缀可能对应多个项目目录（`D:\a\proj` 与 `D:\b\proj`
 * 都叫 `proj`），所以必须按 **cwd 先聚合、再按项目名合并**，
 * 而不能直接把 projectName 塞进 SQL 的 GROUP BY。
 *
 * ★ 两种后端共用本函数（本地 `queryGroupsByProject` 与部门 `portal.ts`）。
 */
export function groupRowsFromProject(
  rows: readonly ProjectGroupRow[],
  sessionPairs: readonly ProjectSessionPair[],
): QueryGroupRow[] {
  const merged = new Map<string, QueryGroupRow>()
  // 各项目下的会话集合，用于合并后的去重计数（直接相加会把同一会话算两次）
  const sessionSets = new Map<string, Set<string>>()

  for (const r of rows) {
    const key = projectName(typeof r.cwd === 'string' ? r.cwd : null)
    let row = merged.get(key)
    if (!row) {
      row = {
        key,
        counts: emptyCounts(),
        firstTime: toNumber(r.lo),
        lastTime: toNumber(r.hi),
        sessions: 0,
      }
      merged.set(key, row)
      sessionSets.set(key, new Set())
    }
    row.counts.input += toNumber(r.input)
    row.counts.output += toNumber(r.output)
    row.counts.cacheRead += toNumber(r.cache_read)
    row.counts.cacheWrite += toNumber(r.cache_write)
    row.counts.reasoning += toNumber(r.reasoning)
    row.counts.calls += toNumber(r.calls)
    row.counts.total =
      row.counts.input + row.counts.output + row.counts.cacheRead + row.counts.cacheWrite
    const lo = toNumber(r.lo)
    const hi = toNumber(r.hi)
    if (lo < row.firstTime) row.firstTime = lo
    if (hi > row.lastTime) row.lastTime = hi
  }

  // ★ sessions 必须按「项目名」重新去重，而不是把各 cwd 的 COUNT(DISTINCT session_id) 相加：
  //   同一个项目名下可能有多个 cwd 前缀（D:\a\proj 与 D:\b\proj 都叫 proj），
  //   若同一会话在两者下都出现（迁移过目录），相加会把一个会话算两次。
  for (const p of sessionPairs) {
    sessionSets
      .get(projectName(typeof p.cwd === 'string' ? p.cwd : null))
      ?.add(String(p.session_id ?? ''))
  }
  for (const [key, set] of sessionSets) {
    const row = merged.get(key)
    if (row) row.sessions = set.size
  }

  return sortGroupRows([...merged.values()], 'project')
}

/** `project` 维度的分组（本地 SQLite 路径）。 */
function queryGroupsByProject(db: Database, filter: QueryFilter): QueryGroupRow[] {
  const groups = projectGroupsQuery(filter)
  const pairs = projectSessionsQuery(filter)
  const rows = db.query<ProjectGroupRow, SQLQueryBindings>(groups.sql).all(groups.params)
  const sessionPairs = db
    .query<ProjectSessionPair, SQLQueryBindings>(pairs.sql)
    .all(pairs.params)
  return groupRowsFromProject(rows, sessionPairs)
}

/**
 * 排序：时间维度升序（趋势可读），其余按用量降序（找大户）。
 *
 * ★ 与 `aggregate()` 的排序规则**必须一致** —— 否则同一份数据
 *   在两条路径下的表格行序不同，看起来像「数据变了」。
 * ★ 两种后端共用本函数（部门路径 `portal.ts` 也调它）。
 */
export function sortGroupRows(rows: QueryGroupRow[], dim: QueryDimension): QueryGroupRow[] {
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
  const q = timeBucketRowsQuery(filter, false)
  const rows = db.query<TimeBucketRow, SQLQueryBindings>(q.sql).all(q.params)
  return seriesFromRows(rows, granularity)
}

/**
 * 原始时间行 → 桶序列（**不补零**）。
 *
 * ★ 两种后端共用（本地 `querySeries` 与部门 `portal.ts`）：桶键实现只有一份，
 *   部门趋势图与本机趋势图的「哪些桶存在」必然一致。
 */
export function seriesFromRows(
  rows: readonly TimeBucketRow[],
  granularity: 'day' | 'hour',
): { bucket: string; counts: TokenCounts }[] {
  const merged = new Map<string, TokenCounts>()
  for (const r of rows) {
    const bucket =
      granularity === 'day' ? toDayKey(toNumber(r.ts)) : toHourKey(toNumber(r.ts))
    let counts = merged.get(bucket)
    if (!counts) {
      counts = emptyCounts()
      merged.set(bucket, counts)
    }
    counts.input += toNumber(r.input_tokens)
    counts.output += toNumber(r.output_tokens)
    counts.cacheRead += toNumber(r.cache_read_tokens)
    counts.cacheWrite += toNumber(r.cache_write_tokens)
    counts.reasoning += toNumber(r.reasoning_tokens)
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
 *
 * ⚠️ 本函数与它下面的 `queryProviders` / `queryDbStats` / `queryScanDiagnostics`
 *   是**本地库专有**路径（收同步 SQLite `Database`），部门看板从不调用它们，
 *   因此这几条 SQL 没有做成构建器。真正被两种后端共用的 SQL **全部**在
 *   `totalsQuery` / `groupsQuery` / … 那些构建器里，且只有那一份文本。
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
  // ★ 复用构建器而不是再抄一遍 SQL 文本：同一句「最近落库时刻」在本地页
  //   与部门看板（`portal.ts` 走 `ingestMomentQuery()`）必须是同一句。
  const moment = ingestMomentQuery()
  const run = db
    .query<{ last_ingest_ms: number }, []>(moment.sql)
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