/**
 * 上报库查询门面 —— 部门看板（`/api/v1/stats/*`）的**唯一取数入口**。
 *
 * ## 与 `stats.ts`（本地统计门面）的关系
 *
 * 两者产出的都是同一套 `TokenCounts`，派生指标同样交给
 * `derive()` / `shared/metrics.ts`。差别只在数据源与「有没有第二条路径」：
 *
 * | | `openStats()`（本机） | `openPortalStats()`（部门） |
 * |---|---|---|
 * | 库文件 | `usage.sqlite`（日志的派生物） | `portal.sqlite` **或 MySQL**（唯一副本） |
 * | 写库 | 每次取数前先增量 ingest | **只读**，一个字节都不写 |
 * | 降级路径 | 库坏了回退直扫日志 | **没有降级** —— 上报库没有可重扫的真值 |
 * | 归属 | 不存在（三列恒为 NULL） | ★ 核心维度（`user` 分组） |
 *
 * ★ **这里没有「降级直扫」**，也不该有：上报数据的真值只有这一个库，
 *   日志早已不在服务端机器上。所以库打不开就如实报错（`openPortalStore`
 *   在 schema 版本不符时抛错而**不重建**），让管理员看到原因，
 *   而不是拿一份空数据冒充「今天没人用」。
 *
 * ## ★ 为什么整个门面是异步的
 *
 * MySQL 驱动（`Bun.sql`）只有异步 API，而 SQLite 驱动是同步的。
 * 统一成异步之后上层只有一套写法；SQLite 那侧只是把同步调用包成已解决的
 * Promise，代价可以忽略（本地库路径根本不走这里）。
 * 于是本文件的所有方法都返回 Promise —— **没有 getter**，因为
 * `get sessions()` 没法表达「这是个 I/O」。
 *
 * ## 🚨 口径约束（与 `query.ts` 完全一致）
 *
 * SQL 层只做**原始列求和**，本文件同样**不写任何公式**：
 * 四项 token 分列取出，`cacheHitRate` / `avgTokensPerCall` / `unattributedRate`
 * 一律由调用方用 `shared/metrics.ts` 计算。SQL 里出现公式 = 第二个口径实现，
 * 它不会报错，只会让某个数字悄悄不对。
 *
 * ## 🚨 唯一的口径边界：`num()`
 *
 * 两种后端的驱动返回类型不同，其中一处**猜错就静默出错**：
 *
 * | 表达式 | SQLite | MySQL |
 * |---|---|---|
 * | `COUNT(*)` | 数字 | 数字 |
 * | **`SUM(BIGINT)`** | 数字 | **字符串 `"60"`**（SUM 结果是 DECIMAL，驱动按精度优先给字符串） |
 *
 * 实测确认。若把 `"60"` 直接当 token 数用，`shared/metrics.ts` 的除法会得到
 * `NaN`，或者更糟 —— 字符串拼接（`"60" + 1` === `"601"`）。
 * ⇒ **所有数值字段（四项 token / calls / sessions / lo / hi / last_ingest_ms）
 * 一律在这里过一遍 `num()`**，绝不把驱动的原始类型放出去。
 */

import type { PortalBackendKind, PortalDialect, PortalStore, PortalTarget } from './portal-db.js'
import { openPortalStore, portalDialect } from './portal-db.js'

import type { TokenCounts } from '../types.js'
import { renderSeriesGaps, type SeriesPointCounts } from './stats.js'
import {
  buildWhere,
  distinctUsersQuery,
  groupsQuery,
  groupRowsFromProject,
  groupRowsFromTime,
  ingestMomentQuery,
  mapGroupRows,
  projectGroupsQuery,
  projectSessionsQuery,
  seriesFromRows,
  sessionCountQuery,
  sortGroupRows,
  timeBoundsQuery,
  timeBucketRowsQuery,
  toNumber,
  toNumberOrNull,
  totalsQuery,
  unattributedCallsQuery,
  type ProjectGroupRow,
  type ProjectSessionPair,
  type QueryDimension,
  type QueryFilter,
  type QueryGroupRow,
  type RawGroupRow,
  type TimeBucketRow,
} from './query.js'
import { EVENT_TABLE } from './schema.js'

/**
 * 数值归一 —— ★ **本仓唯一的口径边界**。
 *
 * 🚨 理由见文件头的对照表：MySQL 的 `SUM(BIGINT)` 返回**字符串**。
 *   `null`（空表的 SUM、没查到的行）按 0 处理，让调用方拿到的永远是可运算的数字。
 *
 * ⚠️ 实现刻意只有一份（`query.ts` 的 `toNumber`）：分组/序列那几条路径在
 *   `query.ts` 的共享映射里归一，本文件负责标量字段。若两边各写一遍取整规则，
 *   它们会慢慢分叉，而分叉的表现只是「某些接口的数字是字符串」。
 */
const num = toNumber

/**
 * 同 {@link num}，但**保留 NULL**。
 *
 * ⚠️ 时间边界与「最近落库时刻」上，NULL 的语义是「一条数据都没有」而不是 0：
 *   折成 0 会让页面显示「最早数据来自 1970 年」，或者把「从未上报」
 *   显示成「1970 年上报过」。
 */
const numOrNull = toNumberOrNull

/** 明细表的一行（上报库比本机库多一列归属）。 */
export interface PortalRecordRow {
  eventId: string
  sessionId: string
  seq: number
  ts: number
  /** 归属键。未归属时为 `null` —— 由调用方映射成协议里的 `unknown`。 */
  userId: string | null
  provider: string
  model: string
  cwd: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 明细 SQL 的原始行（数值列在 MySQL 下可能是字符串，必须经 `num()`）。 */
interface PortalRecordSqlRow {
  event_id: string
  session_id: string
  seq: unknown
  ts: unknown
  user_id: string | null
  provider: string
  model: string
  cwd: string | null
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  cache_write_tokens: unknown
}

/**
 * 一个已就绪的上报库统计会话。
 *
 * ⚠️ 持有 `PortalStore`（**不是 `Database`**），**用完必须 `await close()`**：
 *   SQLite 下这是真的关连接（否则 WAL 不回收），MySQL 下是空操作
 *   （连接来自进程内共享池，见 `portal-db.ts`）。两边调用形状一致。
 *   与 `StatsSession` 一样，构造逻辑收敛在 `openPortalStats()` 里。
 */
export class PortalStatsSession {
  /** 上报库的人类可读描述（已脱敏；MySQL 下是「库名 @ 主机:端口」）。 */
  readonly label: string
  /** SQLite 路径。配了 MySQL 时它只是「退路配置」，不代表当前连的是它。 */
  readonly dbPath: string
  readonly kind: PortalBackendKind
  /** 打开时刻，供页面显示「数据多新」。 */
  readonly openedAt: number

  readonly #store: PortalStore
  /** ★ 与 `store.kind` 绑定的方言：`provider-model` 的拼接表达式靠它。 */
  readonly #dialect: PortalDialect
  readonly #filter: QueryFilter
  #closed = false

  constructor(init: { store: PortalStore; target: PortalTarget; filter?: QueryFilter }) {
    this.#store = init.store
    this.#dialect = portalDialect(init.store.kind)
    this.label = init.store.label
    this.dbPath = init.target.sqlitePath
    this.kind = init.store.kind
    this.#filter = init.filter ?? {}
    this.openedAt = Date.now()
  }

  /** 总计（四项独立 + calls）。派生指标请用 `derive()` / `shared/metrics.ts`。 */
  async totals(): Promise<TokenCounts> {
    const q = totalsQuery(this.#filter)
    const row = await this.#store.get<{
      calls: unknown
      input: unknown
      output: unknown
      cache_read: unknown
      cache_write: unknown
      reasoning: unknown
    }>(q.sql, q.params)

    const calls = num(row?.calls)
    if (calls === 0) {
      // 空结果：四项与 total 全 0（与本地 `queryTotals` 的短路语义一致）
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
        calls: 0,
      }
    }

    const input = num(row?.input)
    const output = num(row?.output)
    const cacheRead = num(row?.cache_read)
    const cacheWrite = num(row?.cache_write)
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: num(row?.reasoning),
      // 用恒等式重算 total（与 addCounts 的语义一致：不信任外部 total）
      total: input + output + cacheRead + cacheWrite,
      calls,
    }
  }

  /** 涉及的会话数（按筛选去重）。 */
  async sessions(): Promise<number> {
    const q = sessionCountQuery(this.#filter)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 未归属的调用条数（`user_id IS NULL`）。 */
  async unattributedCalls(): Promise<number> {
    const q = unattributedCallsQuery(this.#filter)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 已署名人数（按 `user_id` 去重）。 */
  async distinctUsers(): Promise<number> {
    const q = distinctUsersQuery(this.#filter)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 数据的时间边界。NULL 必须保持 null（见 `numOrNull`）。 */
  async timeBounds(): Promise<{ earliest: number | null; latest: number | null }> {
    const q = timeBoundsQuery(this.#filter)
    const row = await this.#store.get<{ lo: unknown; hi: unknown }>(q.sql, q.params)
    return { earliest: numOrNull(row?.lo), latest: numOrNull(row?.hi) }
  }

  /** 最近一次成功落库的时刻。 */
  async lastIngestAt(): Promise<number | null> {
    const q = ingestMomentQuery()
    const row = await this.#store.get<{ last_ingest_ms: unknown }>(q.sql, q.params)
    return numOrNull(row?.last_ingest_ms)
  }

  /**
   * 分组聚合。排序规则与内核 `aggregate()` 一致
   * （时间维度升序，其余按用量降序）—— 否则「人员排行」的行序在
   * 两条路径下会不同，看起来像数据变了。
   *
   * ★ SQL 与归并逻辑都来自 `query.ts`（与本地路径**同一份**）：
   *   这里只负责「用哪种方言执行」和「异步 await」。
   */
  async groups(dim: QueryDimension): Promise<QueryGroupRow[]> {
    const q = groupsQuery(dim, this.#filter, this.#dialect)
    if (q) {
      const rows = await this.#store.all<RawGroupRow>(q.sql, q.params)
      return sortGroupRows(mapGroupRows(rows), dim)
    }

    // `project`：先按 cwd 聚合，再按项目名在 JS 侧合并
    if (dim === 'project') {
      const groups = projectGroupsQuery(this.#filter)
      const pairs = projectSessionsQuery(this.#filter)
      const rows = await this.#store.all<ProjectGroupRow>(groups.sql, groups.params)
      const sessionPairs = await this.#store.all<ProjectSessionPair>(pairs.sql, pairs.params)
      return groupRowsFromProject(rows, sessionPairs)
    }

    // day / hour：时间键必须在 JS 侧算（见 `dimensionExpression` 的注释）
    if (dim === 'day' || dim === 'hour') {
      const rowsQuery = timeBucketRowsQuery(this.#filter, true)
      const rows = await this.#store.all<TimeBucketRow>(rowsQuery.sql, rowsQuery.params)
      return groupRowsFromTime(rows, dim)
    }

    return []
  }

  /**
   * 时间序列。
   *
   * ⚠️ 补零复用 `stats.ts` 的 `renderSeriesGaps()` —— 与本地页/CLI 是
   *   同一份实现。自己再写一遍补零，会让「命令行 30 个点、页面 4 个点」
   *   这种差异出现，而且没有任何报错。
   */
  async series(granularity: 'day' | 'hour', fillGaps = true): Promise<SeriesPointCounts[]> {
    const q = timeBucketRowsQuery(this.#filter, false)
    const rows = await this.#store.all<TimeBucketRow>(q.sql, q.params)
    const points = seriesFromRows(rows, granularity)
    return fillGaps ? renderSeriesGaps(points, granularity) : points
  }

  /** 明细分页（最新在前）。返回总行数供页面算分页。 */
  async records(limit: number, offset: number): Promise<{ total: number; rows: PortalRecordRow[] }> {
    const { sql, params } = buildWhere(this.#filter)

    // ⚠️ 这条 SQL 刻意留在本文件：它带 `user_id`（**上报库专有**的列，
    //   本地库那三列恒为 NULL），因此不与本地路径共用。
    //   但参数仍是 `$named`，MySQL 侧由 `toPositional()` 翻成 `?`。
    const totalRow = await this.#store.get<{ c: unknown }>(
      `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${sql}`,
      params,
    )

    const rows = await this.#store.all<PortalRecordSqlRow>(
      // ⚠️ ORDER BY 用 (ts, seq) 而不是 ts：同一毫秒内的多条记录需要有
      //   稳定的次序，否则翻页时会出现「第 2 页重复了第 1 页的最后一行」。
      `SELECT event_id, session_id, seq, ts, user_id, provider, model, cwd,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM ${EVENT_TABLE}${sql}
       ORDER BY ts DESC, seq DESC
       LIMIT $limit OFFSET $offset`,
      { ...params, $limit: limit, $offset: offset },
    )

    return {
      total: num(totalRow?.c),
      rows: rows.map((r) => ({
        eventId: r.event_id,
        sessionId: r.session_id,
        seq: num(r.seq),
        ts: num(r.ts),
        userId: r.user_id,
        provider: r.provider,
        model: r.model,
        cwd: r.cwd,
        input: num(r.input_tokens),
        output: num(r.output_tokens),
        cacheRead: num(r.cache_read_tokens),
        cacheWrite: num(r.cache_write_tokens),
      })),
    }
  }

  /** 关闭底层连接。可重复调用。MySQL 下是空操作（见文件头）。 */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#store.close()
  }
}

/**
 * 打开一个**只读**的上报库统计会话。
 *
 * 🚨 用 `openPortalStore()`（→ `openPortalSqlite()` 或 MySQL 后端）而不是
 *   `openDatabaseForIngest()`：前者在 schema 版本不符时**抛错**
 *   （上报库是唯一副本，绝不自动重建），后者会「丢了重建」。
 *   两者搞反 = 一次版本升级静默清空全部门历史用量。
 *   两种后端遵守同一条铁律。
 */
export async function openPortalStats(
  target: PortalTarget,
  filter: QueryFilter = {},
): Promise<PortalStatsSession> {
  const store = await openPortalStore(target)
  return new PortalStatsSession({ store, target, filter })
}