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
  mapRecordProvider,
  projectGroupsQuery,
  projectSessionsQuery,
  recordProjection,
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
import { providerNormalizer, type ProviderAliasMap, type ProviderNormalizer } from './provider-alias.js'
import { EVENT_TABLE } from './schema.js'
import { Buffer } from 'node:buffer'

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
  memberId?: string | null
  userNameSnapshot?: string | null
  /** 该人员**当前**所属的分组 ID（不是上报时的值，那个在 `groupNameSnapshot`）。 */
  groupIds?: string[]
  /** 上报当时客户端自己填的分组文本快照。 */
  groupNameSnapshot?: string | null
  attributionStatus?: 'member' | 'legacy' | 'unattributed'
  eventId: string
  sessionId: string
  seq: number
  ts: number
  /** 归属键。未归属时为 `null` —— 由调用方映射成协议里的 `unknown`。 */
  userId: string | null
  /** ★ 展示用的供应商名（已按规则归一化；未配规则时等于 `providerRaw`）。 */
  provider: string
  /** 上报当时的供应商原值。明细要能核对规则，所以两个都留着。 */
  providerRaw: string
  model: string
  cwd: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 明细 SQL 的原始行（数值列在 MySQL 下可能是字符串，必须经 `num()`）。 */
interface PortalRecordSqlRow {
  member_id: string | null
  user_name: string | null
  group_name: string | null
  event_id: string
  session_id: string
  seq: unknown
  ts: unknown
  user_id: string | null
  provider: string
  /** 归一化表达式的结果；没配规则时该列与 `provider` 同值。 */
  provider_norm?: unknown
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
  /**
   * 供应商归一化（可选）。`undefined` = 一条规则都没有 ——
   * 此时所有 SQL 与迁移前**逐字相同**，本机库路径也走这一支。
   */
  readonly #normalize: ProviderNormalizer | undefined
  #closed = false

  constructor(init: {
    store: PortalStore
    target: PortalTarget
    filter?: QueryFilter
    aliases?: ProviderAliasMap
  }) {
    this.#store = init.store
    this.#dialect = portalDialect(init.store.kind)
    this.label = init.store.label
    this.dbPath = init.target.sqlitePath
    this.kind = init.store.kind
    this.#filter = init.filter ?? {}
    // ⚠️ 空映射必须折成 `undefined`：空 `CASE` 在 MySQL 上是语法错误，
    //   而在 SQLite 上只是「恒为 NULL」—— 后者更危险，它不会报错。
    this.#normalize = init.aliases && init.aliases.size > 0
      ? providerNormalizer(init.aliases, this.#dialect)
      : undefined
    this.openedAt = Date.now()
  }

  /** 总计（四项独立 + calls）。派生指标请用 `derive()` / `shared/metrics.ts`。 */
  async totals(): Promise<TokenCounts> {
    const q = totalsQuery(this.#filter, this.#normalize)
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
    const q = sessionCountQuery(this.#filter, this.#normalize)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 未归属的调用条数（`user_id IS NULL`）。 */
  async unattributedCalls(): Promise<number> {
    const q = unattributedCallsQuery(this.#filter, this.#normalize)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 非空归属分组数；成员视图按稳定人员与历史身份分别计数，旧视图按 `user_id` 去重。 */
  async distinctUsers(): Promise<number> {
    if (this.#filter.identityView === 'member') {
      const { sql, params } = buildWhere(this.#filter, this.#normalize)
      const row = await this.#store.get<{ c: unknown }>(`SELECT COUNT(*) AS c FROM (
        SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id
        FROM ${EVENT_TABLE}${sql}${sql ? ' AND' : ' WHERE'} (member_id IS NOT NULL OR user_id IS NOT NULL)
        GROUP BY member_id, legacy_id) AS identities`, params)
      return num(row?.c)
    }
    const q = distinctUsersQuery(this.#filter, this.#normalize)
    const row = await this.#store.get<{ c: unknown }>(q.sql, q.params)
    return num(row?.c)
  }

  /** 数据的时间边界。NULL 必须保持 null（见 `numOrNull`）。 */
  async timeBounds(): Promise<{ earliest: number | null; latest: number | null }> {
    const q = timeBoundsQuery(this.#filter, this.#normalize)
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
    if (dim === 'user' && this.#filter.identityView === 'member') return this.memberGroups()
    if (dim === 'group') return this.groupGroups()
    const q = groupsQuery(dim, this.#filter, this.#dialect, this.#normalize)
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
      const rowsQuery = timeBucketRowsQuery(this.#filter, true, this.#normalize)
      const rows = await this.#store.all<TimeBucketRow>(rowsQuery.sql, rowsQuery.params)
      return groupRowsFromTime(rows, dim)
    }

    return []
  }

  /**
   * 把一批稳定人员 ID 映射成「他当前属于哪些分组」。
   *
   * 🚨 **刻意单独查一次，而不是在主聚合里 LEFT JOIN 关联表**：多对多的 JOIN
   *   会让每个事件行按所属分组数复制，`SUM()` 随之成倍放大 ——
   *   那是一个静默的数据错误，页面上只是数字变大，没有任何报错。
   *
   * ⚠️ 分批查询：一次绑定几千个 UUID 会撞上 SQLite 的参数个数上限。
   */
  private async groupsOf(members: readonly (string | null)[]): Promise<Map<string, { groupId: string; name: string }[]>> {
    const unique = [...new Set(members.filter((id): id is string => !!id))]
    const map = new Map<string, { groupId: string; name: string }[]>()
    for (let start = 0; start < unique.length; start += 200) {
      const chunk = unique.slice(start, start + 200)
      const params: Record<string, string> = {}
      chunk.forEach((id, i) => { params[`$m${i}`] = id })
      const rows = await this.#store.all<{ member_id: string; group_id: string; name: string }>(
        `SELECT a.member_id AS member_id, g.group_id AS group_id, g.name AS name
         FROM member_group_assignments a JOIN member_groups g ON g.group_id = a.group_id
         WHERE a.member_id IN (${chunk.map((_, i) => `$m${i}`).join(',')})
         ORDER BY g.name, g.group_id`, params)
      for (const row of rows) {
        const list = map.get(row.member_id) ?? []
        list.push({ groupId: row.group_id, name: row.name })
        map.set(row.member_id, list)
      }
    }
    return map
  }

  /** 按固定人员 ID 聚合；未确认历史的 key 与当前人员、真正未归属互不混淆。 */
  private async memberGroups(): Promise<QueryGroupRow[]> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.#store.all<RawGroupRow & {
      member_id: string | null; legacy_id: string | null; snapshot_name: string | null
      display_name: string | null
    }>(`SELECT g.*, m.display_name FROM (
      SELECT member_id, CASE WHEN member_id IS NULL THEN user_id ELSE NULL END AS legacy_id,
        MIN(user_name) AS snapshot_name, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
        SUM(reasoning_tokens) AS reasoning, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi,
        COUNT(DISTINCT session_id) AS sessions
      FROM ${EVENT_TABLE}${sql} GROUP BY member_id, legacy_id
      ) AS g LEFT JOIN members m ON m.member_id = g.member_id`, params)
    const groups = await this.groupsOf(rows.map((row) => row.member_id))
    return sortGroupRows(rows.map((row) => {
      const attributionStatus = row.member_id ? 'member' : row.legacy_id !== null ? 'legacy' : 'unattributed'
      const key = row.member_id ?? (row.legacy_id !== null ? `legacy:${Buffer.from(row.legacy_id, 'utf8').toString('base64url')}` : 'unknown')
      const mapped = mapGroupRows([{ ...row, grp_key: key }])[0]!
      return { ...mapped, memberId: row.member_id,
        groupNames: (row.member_id ? groups.get(row.member_id) ?? [] : []).map((group) => group.name),
        attributionStatus, label: row.member_id ? row.display_name ?? row.snapshot_name ?? '已停用人员'
          : row.legacy_id !== null ? `历史人员：${row.snapshot_name ?? row.legacy_id}（待确认）` : '未归属' }
    }), 'user')
  }

  /**
   * 按分组聚合（`by=group`）—— 「分组排行」的数据来源。
   *
   * ★ 这里 JOIN 关联表是**刻意的**：一个事件要同时计入它的人员所属的每个分组。
   *   因此各分组行的合计会大于总量，这不是重复计数，而是多对多分组的定义。
   * ⚠️ 没有关联行的人员（未分组）不进任何分组行，所以本维度看不见他们 ——
   *   「总量对不上分组之和」的差额正是这部分人，页面必须说清楚。
   * ⚠️ 事实表先按筛选收进子查询，再与关联表 JOIN：`buildWhere()` 产出的是
   *   不带表别名的裸列名（它要同时服务本地库路径），直接用在 JOIN 上会歧义。
   */
  private async groupGroups(): Promise<QueryGroupRow[]> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const rows = await this.#store.all<RawGroupRow & { grp_name: string }>(
      `SELECT g.group_id AS grp_key, g.name AS grp_name,
              SUM(x.input_tokens) AS input, SUM(x.output_tokens) AS output,
              SUM(x.cache_read_tokens) AS cache_read, SUM(x.cache_write_tokens) AS cache_write,
              SUM(x.reasoning_tokens) AS reasoning, COUNT(*) AS calls,
              MIN(x.ts) AS lo, MAX(x.ts) AS hi, COUNT(DISTINCT x.session_id) AS sessions
       FROM (SELECT member_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    reasoning_tokens, ts, session_id
             FROM ${EVENT_TABLE}${sql}) AS x
       JOIN member_group_assignments a ON a.member_id = x.member_id
       JOIN member_groups g ON g.group_id = a.group_id
       GROUP BY g.group_id, g.name`, params)
    return sortGroupRows(rows.map((row) => ({ ...mapGroupRows([row])[0]!, label: row.grp_name })), 'group')
  }

  /** 旧页面无法表达同名/改名关系时明确拒绝，不能输出看似合理的合并排行。 */
  async assertLegacyIdentityView(): Promise<void> {
    if (this.#filter.identityView === 'member') return
    const { sql, params } = buildWhere(this.#filter, this.#normalize)
    const pairs = await this.#store.all<{ member_id: string | null; user_id: string | null }>(
      `SELECT DISTINCT member_id, user_id FROM ${EVENT_TABLE}${sql}`, params,
    )
    const byLegacy = new Map<string, Set<string>>(), byMember = new Map<string, Set<string>>()
    for (const row of pairs) {
      if (row.member_id && row.user_id === null) throw new IdentityViewRequiredError()
      if (row.user_id === null) continue
      const identities = byLegacy.get(row.user_id) ?? new Set<string>()
      identities.add(row.member_id ?? 'legacy'); byLegacy.set(row.user_id, identities)
      if (row.member_id) {
        const names = byMember.get(row.member_id) ?? new Set<string>()
        names.add(row.user_id); byMember.set(row.member_id, names)
      }
    }
    if ([...byLegacy.values(), ...byMember.values()].some((ids) => ids.size > 1)) throw new IdentityViewRequiredError()
  }

  /**
   * 时间序列。
   *
   * ⚠️ 补零复用 `stats.ts` 的 `renderSeriesGaps()` —— 与本地页/CLI 是
   *   同一份实现。自己再写一遍补零，会让「命令行 30 个点、页面 4 个点」
   *   这种差异出现，而且没有任何报错。
   */
  async series(granularity: 'day' | 'hour', fillGaps = true): Promise<SeriesPointCounts[]> {
    const q = timeBucketRowsQuery(this.#filter, false, this.#normalize)
    const rows = await this.#store.all<TimeBucketRow>(q.sql, q.params)
    const points = seriesFromRows(rows, granularity)
    return fillGaps ? renderSeriesGaps(points, granularity) : points
  }

  /** 明细分页（最新在前）。返回总行数供页面算分页。 */
  async records(limit: number, offset: number): Promise<{ total: number; rows: PortalRecordRow[] }> {
    const { sql, params } = buildWhere(this.#filter, this.#normalize)

    // ⚠️ 这条 SQL 刻意留在本文件：它带 `user_id`（**上报库专有**的列，
    //   本地库那三列恒为 NULL），因此不与本地路径共用。
    //   但参数仍是 `$named`，MySQL 侧由 `toPositional()` 翻成 `?`。
    const totalRow = await this.#store.get<{ c: unknown }>(
      `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${sql}`,
      params,
    )

    // ★ provider 的归一化表达式来自 `query.ts` 的 `recordProjection()`
    //   （与分组维度同一份实现），这里只负责把两份参数合起来。
    const projection = recordProjection(this.#normalize)
    const rows = await this.#store.all<PortalRecordSqlRow>(
      // ⚠️ ORDER BY 用 (ts, seq) 而不是 ts：同一毫秒内的多条记录需要有
      //   稳定的次序，否则翻页时会出现「第 2 页重复了第 1 页的最后一行」。
      `SELECT event_id, session_id, seq, ts, user_id, member_id, user_name, group_name, model, cwd,
              ${projection.columns},
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM ${EVENT_TABLE}${sql}
       ORDER BY ts DESC, seq DESC, event_id DESC
       LIMIT $limit OFFSET $offset`,
      { ...projection.params, ...params, $limit: limit, $offset: offset },
    )
    const groups = await this.groupsOf(rows.map((row) => row.member_id))

    return {
      total: num(totalRow?.c),
      rows: rows.map((r) => ({
        eventId: r.event_id,
        sessionId: r.session_id,
        seq: num(r.seq),
        ts: num(r.ts),
        userId: r.user_id,
        ...(this.#filter.identityView === 'member' ? {
          memberId: r.member_id, userNameSnapshot: r.user_name,
          groupIds: (r.member_id ? groups.get(r.member_id) ?? [] : []).map((group) => group.groupId),
          groupNameSnapshot: r.group_name, attributionStatus: r.member_id ? 'member' as const : r.user_id !== null ? 'legacy' as const : 'unattributed' as const,
        } : {}),
        ...mapRecordProvider(r),
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
 *
 * `aliases` 是**已经按查看者解析完毕**的供应商归一化映射（全局 + 人员逐条覆盖），
 * 由 `stats-route.ts` 从 `provider_alias` 表读出来传进去 —— 查询层不认识那张表，
 * 也不该认识：它只认「原始名 → 展示名」这一件事。
 *
 * ⚠️ 传的是**加载函数**而不是现成的映射表：加载要用同一个已打开、且已过版本闸门的
 *   连接（`provider_alias` 表的存在性由闸门保证）。让调用方自己先开一次连接去读规则、
 *   再开一次查数据，等于每次看板请求握两次库句柄，而 SQLite 上的代价是真金白银的。
 */
export async function openPortalStats(
  target: PortalTarget,
  filter: QueryFilter = {},
  loadAliases?: (store: PortalStore) => Promise<ProviderAliasMap>,
): Promise<PortalStatsSession> {
  const store = await openPortalStore(target)
  try {
    const aliases = loadAliases ? await loadAliases(store) : undefined
    const session = new PortalStatsSession({ store, target, filter, ...(aliases && aliases.size > 0 ? { aliases } : {}) })
    await session.assertLegacyIdentityView()
    return session
  } catch (error) { await store.close(); throw error }
}

/** HTTP 层将它映射为 409，数据库故障仍保持 503。 */
export class IdentityViewRequiredError extends Error {
  readonly code = 'identity_view_required'
  constructor() { super('当前归属无法用旧版人员视图准确表达，请使用 identity_view=member') }
}
