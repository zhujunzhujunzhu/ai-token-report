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
import { emptyCounts, type SessionSource, type TokenCounts } from '../types.js'
import { EVENT_TABLE } from './schema.js'
import { SQLITE_DIALECT, type PortalDialect } from './dialect.js'
import {
  applyProviderModel,
  coalesceOriginal,
  providerCaseSql,
  providerModelKey,
  type ProviderNormalizer,
} from './provider-alias.js'
import { UNATTRIBUTED_USER, type BillableUsage } from '@ai-token-report/shared'

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
export type QueryDimension = GroupDimension | 'user' | 'group'

/** 查询筛选条件。字段语义与 CLI 的 `--period/--provider/--model` 一致。 */
export interface QueryFilter {
  identityView?: 'legacy' | 'member'
  memberIds?: string[]
  legacyUserIds?: string[]
  unattributedOnly?: boolean
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
  /**
   * 按分组筛选（多选，**精确匹配**稳定分组 ID）。
   *
   * ⚠️ 多对多语义：一个人可同属多个分组，所以**多选是 OR**（命中任一所选分组即计入）。
   *   因此「按两个分组分别筛出来的合计」会大于全量合计 —— 这不是重复计数的 bug，
   *   同一条事件本来就要计入它所属的每个分组。
   *
   * 🚨 这一条会生成引用 `member_group_assignments` 的子查询，那张表**只有上报库有**。
   *   本地库路径（`usage.sqlite`）绝不能带上它 —— 一旦带上就是「no such table」。
   */
  groupIds?: string[]
  /**
   * 按**来源**筛选（多选，**精确匹配**，多个之间是 OR）。
   *
   * ⚠️ 与 provider / model 刻意不同：那两个是子串匹配（「找一类模型」的便利），
   *   来源是**受控枚举**（`dsh` / `codex` / …），子串匹配会让
   *   `--source code` 把 `codex` 也捞进来 —— 一个字母之差就是另一个采集方。
   */
  sources?: string[]
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
 *
 * ## 供应商归一化（`normalize`）
 *
 * 传了 {@link ProviderNormalizer} 时，`provider` 筛选匹配的是**归一化后**的名字：
 * 使用者看到的行是 `bailian-tpp`，他筛 `bailian-tpp` 就必须把
 * `dashscope` / `bailian` 那些原值一起筛出来。
 * 这与 `dimensionExpression()` 的分组口径**必须一致**，否则会出现
 * 「筛了某个供应商，行里却有别的名字」这种看起来像数据错了的现象。
 *
 * ⚠️ 反过来的代价是**不能按原始名搜**（`dashscope` 已经改名为 `bailian-tpp`）。
 *   这是刻意的：页面展示的名字就是可搜的名字，两套名字只会让人怀疑自己筛错了。
 */
export function buildWhere(
  filter: QueryFilter,
  normalize?: ProviderNormalizer,
): {
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

  // ★ 供应商筛选走归一化后的名字（见上方注释）。没有规则时
  //   `providerFilterExpression()` 返回裸 `provider`，SQL 与迁移前逐字相同。
  likeAny(providerFilterExpression(normalize, params), filter.providers, 'prov')
  likeAny('model', filter.models, 'model')

  // 来源：精确匹配（受控枚举，不做子串 —— 见 QueryFilter.sources 的注释）。
  if (filter.sources && filter.sources.length > 0) {
    const parts: string[] = []
    filter.sources.forEach((sourceValue, i) => {
      const key = `$source${i}`
      parts.push(`source = ${key}`)
      params[key] = sourceValue
    })
    clauses.push(`(${parts.join(' OR ')})`)
  }

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

  // ★ 仅 portal v4 使用这些列；本地 usage.sqlite 的 schema 和查询保持独立。
  const identities: string[] = []
  filter.memberIds?.forEach((id, i) => {
    const key = `$member${i}`
    identities.push(`member_id = ${key}`); params[key] = id
  })
  filter.legacyUserIds?.forEach((id, i) => {
    const key = `$legacy${i}`
    // 旧 key 永远指历史子集；显式映射后也不能扩展到该人员的新事件。
    identities.push(`(received_at_ms IS NULL AND user_id = ${key})`); params[key] = id
  })
  if (filter.unattributedOnly) identities.push('(member_id IS NULL AND user_id IS NULL)')
  if (identities.length) clauses.push(`(${identities.join(' OR ')})`)

  // 按分组筛选：走关联表。用子查询而不是 JOIN —— JOIN 会让每个事件按所属分组数
  // 复制成多行，把「筛选」悄悄变成「重复计数」。
  if (filter.groupIds && filter.groupIds.length > 0) {
    const keys = filter.groupIds.map((id, i) => {
      const key = `$group${i}`
      params[key] = id
      return key
    })
    clauses.push(`member_id IN (SELECT member_id FROM member_group_assignments WHERE group_id IN (${keys.join(',')}))`)
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

/** 没有任何规则时，归一化表达式就是裸列名 —— SQL 与迁移前逐字相同。 */
function hasNormalization(normalize?: ProviderNormalizer): normalize is ProviderNormalizer {
  // `apply()` 对未命中的字符串返回 undefined，所以「有没有规则」只能由
  // 调用方在拿到映射表时就判定（见 `providerNormalizer()` 的调用点）。
  return !!normalize && normalize.rules > 0
}

/**
 * 供应商筛选用的 SQL 表达式（归一化已内联）。
 *
 * ⚠️ 返回的表达式**已经内联了绑定值**，所以调用方必须先调用它、
 *   再把 pattern 参数写进同一张 `params` 表。
 */
function providerFilterExpression(
  normalize: ProviderNormalizer | undefined,
  params: Record<string, string | number>,
): string {
  if (!hasNormalization(normalize)) return 'provider'
  return coalesceOriginal(providerCaseSql('provider', normalize.map, params, 'pf'), 'provider')
}

/**
 * `provider/model` 组合维度的表达式（走方言拼接）。
 *
 * ⚠️ `provider-model` 的分组键必须与 `aggregate.ts` 的 `groupKey()` 逐字一致，
 *   而「归一化作用在拼接后的字符串上」这件事也只能有一份实现 ——
 *   两处各写一遍必然漂移，且漂移的表现只是「某些模型的行名不一样」。
 *
 * @param providerExpression 参与拼接的 provider 表达式。默认是裸列名；
 *   传了归一化规则时由调用方给出 `COALESCE(CASE …)` —— **归一化必须作用在
 *   拼接之前的那一段上**。
 *   🚨 直接把 `CASE` 套在拼接结果上（`CASE WHEN provider || '/' || model = 'dashscope'`）
 *   永远不成立：拿一个 `provider/model` 字符串去等于一个 provider 名，
 *   结果是一行都不命中，于是「按 provider-model 分组」静默地全是原值。
 */
function providerModelExpression(dialect: PortalDialect, providerExpression = 'provider'): string {
  // 分隔符与 aggregate.ts 的 groupKey() 一致（`provider/model`）。
  return dialect.concat([providerExpression, `'${PROVIDER_MODEL_SEPARATOR_SQL}'`, 'model'])
}

/** SQL 字符串字面量里的分隔符，与 `provider-alias.ts` 的常量必须同值。 */
const PROVIDER_MODEL_SEPARATOR_SQL = '/'

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
 *
 * ## 归一化
 *
 * 传了 `normalize` 时，`provider` 维度与 `provider-model` 维度都会把
 * 原值经规则折叠后再分组。**逐条覆盖、未命中保持原值**两条约束的实现在
 * `provider-alias.ts`，这里只负责把表达式接上去。
 */
function dimensionExpression(
  dim: QueryDimension,
  dialect: PortalDialect = SQLITE_DIALECT,
  normalize?: ProviderNormalizer,
  params?: Record<string, string | number>,
): string | null {
  switch (dim) {
    case 'source':
      // 来源是受控枚举（dsh / codex / …），**不做归一化**：它的值由采集端决定，
      // 不是用户可配的显示名（那是 provider 的事）。
      return 'source'
    case 'provider': {
      if (!hasNormalization(normalize) || !params) return 'provider'
      return coalesceOriginal(providerCaseSql('provider', normalize.map, params, 'gp'), 'provider')
    }
    case 'model':
      return 'model'
    case 'session':
      return 'session_id'
    case 'provider-model': {
      if (!hasNormalization(normalize) || !params) return providerModelExpression(dialect)
      // ★ 先归一化 provider 那一段，再拼接：规则里的 `provider` 只写供应商名，
      //   所以比较也必须发生在单个 provider 上（见 providerModelExpression 的 🚨）。
      return providerModelExpression(dialect, coalesceOriginal(providerCaseSql('provider', normalize.map, params, 'gm'), 'provider'))
    }
    case 'source-provider-model': {
      // 组合维度：`<source>/<provider>/<model>`，与 `aggregate.ts` 的 `groupKey()` 逐字同形
      //   （两端不一致会让「库查询 == 直扫」这条对照断言失败 —— 它正是为此存在的）。
      const inner = !hasNormalization(normalize) || !params
        ? providerModelExpression(dialect)
        : providerModelExpression(dialect, coalesceOriginal(providerCaseSql('provider', normalize.map, params, 'gs'), 'provider'))
      return dialect.concat(['source', `'${PROVIDER_MODEL_SEPARATOR_SQL}'`, inner])
    }
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
    case 'group':
      // ★ 分组维度**不能**在这里出表达式：人员与分组是多对多，一个事件要同时
      //   计入它的人员所属的每个分组，非 JOIN 关联表不可。JOIN 会放大行数，
      //   于是「一个事件算几行」这件事必须由 `portal.ts` 显式处理 ——
      //   本函数只产出等值聚合，硬塞进来会让它悄悄变成重复计数。
      return null
  }
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
export function totalsQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
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
export function sessionCountQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
  return {
    sql: `SELECT COUNT(DISTINCT session_id) AS c FROM ${EVENT_TABLE}${sql}`,
    params,
  }
}

/** 最早 / 最晚事件时间。 */
export function timeBoundsQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
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
export function unattributedCallsQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
  // 未归属条件与筛选条件用 AND 组合：filter 里若已有 user_id 条件，
  // 也能正确收敛（例如只看某个已署名的人 → 未归属恒为 0）
  const condition = filter.identityView === 'member' ? 'member_id IS NULL AND user_id IS NULL' : 'user_id IS NULL'
  const clause = sql ? `${sql} AND ${condition}` : ` WHERE ${condition}`
  return { sql: `SELECT COUNT(*) AS c FROM ${EVENT_TABLE}${clause}`, params }
}

/** 已署名人数（按 `user_id` 去重）。 */
export function distinctUsersQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
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
  normalize?: ProviderNormalizer,
): SqlQuery | null {
  const params: Record<string, string | number> = {}
  const dimExpr = dimensionExpression(dim, dialect, normalize, params)
  if (!dimExpr) return null

  const { sql, params: whereParams } = buildWhere(filter, normalize)
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
    // ⚠️ 两份参数必须合并：`dimExpr` 里内联了归一化映射的绑定值
    //   （`$gpk0` / `$gpv0`），而 `buildWhere` 产出的是筛选条件的绑定值。
    //   漏掉任何一份都会让 MySQL 侧抛「绑定参数缺失」，而 SQLite 侧
    //   只是把那几个参数当 NULL —— 于是分组结果里少掉所有配了规则的供应商。
    params: { ...params, ...whereParams },
  }
}

// ---------------------------------------------------------------------------
// 费用取数（v7 模型单价）
// ---------------------------------------------------------------------------

/**
 * 模型单价表（portal v7）。
 *
 * ⚠️ 与事件表无关：这张表**只被金额取数读**，一行的存活期覆盖一段时间区间，
 *   金额按「事件发生时刻」选中的那一行算 —— 所以改价即时生效，
 *   而 `usage_event` 一个字节都不会被动。
 */
export const PRICE_TABLE = 'model_price'

/**
 * 金额取数的原始行。
 *
 * ★ 这里**只出 `SUM(原始列)` 与分组键，一个算术式都没有**（铁律：
 *   本地库只定义存储、不定义口径）。四类 token 各乘各自的价是
 *   `shared/price.ts` 的 `costMicroOf()`，在 JS 侧调用。
 */
export interface RawCostRow {
  grp_key?: string | null
  /** 仅整体金额取数带这两列（用于回答「哪些模型没配价」）。 */
  provider?: string | null
  model?: string | null
  price_id: string | null
  currency: string | null
  input: unknown
  output: unknown
  cache_read: unknown
  cache_write: unknown
}

/**
 * 金额取数的公共骨架。
 *
 * ## 为什么是 LEFT JOIN + 按 `price_id` 分组，而不是在 SQL 里写乘法
 *
 * 把 `SUM(input * p_in + …)` 写进 SQL 看似少一趟，但它会**在 SQL 里造出
 * 第二个口径实现** —— 换价、加币种、改四类拆分时两边必然漂移，而它不会报错。
 * 所以这里只做两件 SQL 擅长的事：
 *
 * 1. `LEFT JOIN` 把每条事件**在它自己的时刻**能匹配到的价行取出来
 *    （`LEFT` 而不是 `JOIN`：没配价的事件必须留下来，它们要被计成「未计价」，
 *     而不是从结果里消失 —— 后者会让「没配价」看起来像「没用量」）；
 * 2. 按 `(分组键, price_id)` 分组求和四类 token。
 *
 * 于是「未定价」那一撮天然落进 `price_id IS NULL` 的那一行，
 * 不需要 `SUM(CASE WHEN …)` 这类把口径混进 SQL 的写法。
 *
 * ⚠️ 两条已知代价（都刻意接受）：
 *   - 这是**区间连接**，代价约 O(事件数 × 单价行数)。单价只有几十行，
 *     所以实际影响很小；真要优化需要给 `usage_event(provider, model)` 加索引，
 *     那是一次 schema 变更（加索引 = 改受控 DDL = 改校验和），不在这一期做。
 *   - 区间**重叠**时一条事件会命中两行、被算两次。写入路径由
 *     `findPriceConflicts()` 回 409 挡住重叠，所以只可能来自直接改库；
 *     这条风险记在 `docs/费用统计方案.md`。
 *
 * 🚨 JOIN 条件里的 `provider` 用的是**事件表的原值**，不是归一化后的展示名：
 *   单价按上报原值匹配，供应商归一化只是查询期的显示口径。
 *   分组键（`grp_key`）才用归一化表达式 —— 两者刻意不同名不同义。
 */
function costQueryFor(
  dimExpr: string | null,
  filter: QueryFilter,
  normalize: ProviderNormalizer | undefined,
  dimParams: Record<string, string | number>,
  withTarget = false,
): SqlQuery {
  const { sql, params: whereParams } = buildWhere(filter, normalize)
  const targetCols = withTarget ? 'provider, model, ' : ''
  const targetGroup = withTarget ? 'provider, model, ' : ''
  const select = dimExpr === null ? '' : `${dimExpr} AS grp_key,\n                 `
  const group = dimExpr === null ? '' : 'grp_key, '
  return {
    sql: `SELECT ${select}${targetCols}mp.price_id AS price_id,
                 mp.currency  AS currency,
                 SUM(input_tokens)       AS input,
                 SUM(output_tokens)      AS output,
                 SUM(cache_read_tokens)  AS cache_read,
                 SUM(cache_write_tokens) AS cache_write
          FROM ${EVENT_TABLE}
          LEFT JOIN (
                 -- 🚨 必须把 provider / model 两列**改名**再 JOIN：它们在两张表里同名，
                 --   而分组维度表达式（dimensionExpression）产出的是裸列名
                 --   （provider / model / provider 与 model 的拼接）。
                 --   直接 LEFT JOIN model_price mp 会让它们变成**歧义列**：
                 --   SQLite 报 ambiguous column name: provider、MySQL 报 errno 1052，
                 --   于是「按供应商 / 按模型看金额」整条路径直接不可用。
                 --   子查询改名之后，外层作用域里的 provider / model 只属于事件表。
                 SELECT price_id, provider AS mp_provider, model AS mp_model, currency,
                        effective_from_ms, effective_to_ms
                   FROM ${PRICE_TABLE}
                 ) mp
                 ON mp.mp_provider = ${EVENT_TABLE}.provider
                AND mp.mp_model = ${EVENT_TABLE}.model
                AND ts >= mp.effective_from_ms
                AND (mp.effective_to_ms IS NULL OR ts <= mp.effective_to_ms)${sql}
          GROUP BY ${group}${targetGroup}mp.price_id, mp.currency`,
    // ⚠️ 与 `groupsQuery` 同样的合并理由：`dimExpr` 内联了归一化映射的绑定值。
    params: { ...dimParams, ...whereParams },
  }
}

/**
 * 按维度取金额。**返回 `null` 表示该维度必须走 JS 侧**（`day` / `hour` / `project`），
 * 与 {@link dimensionExpression} 的语义一致 —— `project` 走
 * {@link costByCwdQuery}，`day` / `hour` 走 {@link timeBucketRowsQuery} 的逐行路径。
 */
export function costByDimensionQuery(
  dim: QueryDimension,
  filter: QueryFilter = {},
  dialect: PortalDialect = SQLITE_DIALECT,
  normalize?: ProviderNormalizer,
): SqlQuery | null {
  const dimParams: Record<string, string | number> = {}
  const dimExpr = dimensionExpression(dim, dialect, normalize, dimParams)
  if (!dimExpr) return null
  return costQueryFor(dimExpr, filter, normalize, dimParams)
}

/**
 * 整体金额（顶部卡片用）：不按任何维度分组。
 *
 * ★ **绝不改成「总量 × 某个均价」**。这里仍然按 `(price_id)` 分组求和，
 *   也就是说每个价各自乘自己那部分用量 —— 这是「先按 (provider, model) 分组
 *   算完再求和」的等价实现（价与 `(provider, model)` 一一对应）。
 *
 * ★ 额外按 `(provider, model)` 分组，是为了让**同一趟**就能回答
 *   「哪些 `(provider, model)` 一条价都没配上」（那些行的 `price_id` 是 NULL）。
 *   把它们显示出来是「未计价」唯一可行动的形态 —— 只给一个比例，
 *   使用者知道有 12% 没算钱，却不知道该去补哪个价。
 */
export function costTotalsQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  return costQueryFor(null, filter, normalize, {}, true)
}

/** `project` 维度的金额：先按 `cwd` 取，再在 JS 侧按项目名合并（同分组路径）。 */
export function costByCwdQuery(filter: QueryFilter = {}, normalize?: ProviderNormalizer): SqlQuery {
  return costQueryFor('cwd', filter, normalize, {})
}

/** 金额取数行 → 内核形状（`SUM` 的字符串归一化只此一处，理由同 `mapGroupRows`）。 */
export interface CostRowCounts {
  /** 分组键；整体金额时为 `null`。 */
  key: string | null
  /** 命中的单价行 ID；`null` = **未计价**（不是 0 元）。 */
  priceId: string | null
  /** 该单价行的币种；未计价时为 `null`。 */
  currency: string | null
  /** 仅整体金额取数带这两列（未计价的行靠它指出「该去补哪个价」）。 */
  provider: string | null
  model: string | null
  usage: BillableUsage
}

export function mapCostRows(rows: readonly RawCostRow[]): CostRowCounts[] {
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
  return rows.map((row) => ({
    key: text(row.grp_key),
    priceId: text(row.price_id),
    currency: text(row.currency),
    provider: text(row.provider),
    model: text(row.model),
    usage: {
      input: toNumber(row.input),
      output: toNumber(row.output),
      cacheRead: toNumber(row.cache_read),
      cacheWrite: toNumber(row.cache_write),
    },
  }))
}

/**
 * 明细行的**取数**投影（只出列与表达式，拼接 WHERE / ORDER BY / LIMIT 由调用方做）。
 *
 * ## ★ 为什么明细要同时取「原值」和「归一化名」
 *
 * 聚合维度只认归一化名（`by=provider` 的行就该是 `bailian-tpp`），但明细是
 * 人用来**核对规则配得对不对**的地方：只显示归一化名的话，一条把
 * `dashscope` 错配成 `bailian-tpp` 的规则会表现得完全正常 ——
 * 总量对、名字错，没有任何地方能看出来。
 *
 * ⚠️ 两个字段名刻意不叫 `provider` / `provider_raw`：
 *   取数层的字段名与线上契约解耦，「哪一个是展示名」这件事只由
 *   `stats-route.ts` 的映射决定，改契约时不会牵动 SQL。
 */
export interface RecordProjection {
  columns: string
  params: Record<string, string | number>
}

export function recordProjection(normalize?: ProviderNormalizer): RecordProjection {
  const params: Record<string, string | number> = {}
  const raw = 'provider'
  // 没有规则时两个表达式都是裸列名 —— SQL 与迁移前逐字相同（多一列同值）。
  const normalized = hasNormalization(normalize)
    ? coalesceOriginal(providerCaseSql(raw, normalize.map, params, 'rp'), raw)
    : raw
  return {
    columns: `${raw} AS provider, ${normalized} AS provider_norm`,
    params,
  }
}

/**
 * 明细行的归一化**返回值**。
 *
 * ★ 与 `portal.ts` 取数用的是同一个 `recordProjection()`：归一化的实现在
 *   查询层只有一份，明细不可能与分组口径漂移。
 */
export interface NormalizedRecordProvider {
  /** 上报当时的原值，一个字节都没改过。 */
  providerRaw: string
  /** 看板展示用的名字（未配规则时等于 `providerRaw`）。 */
  provider: string
}

export function mapRecordProvider(row: { provider: unknown; provider_norm?: unknown }): NormalizedRecordProvider {
  const raw = String(row.provider ?? '')
  // ⚠️ `provider_norm` 在旧调用方（不带归一化的查询）里没有这一列，
  //   此时回落原值 —— 而不是回落空串，那会让明细里的供应商列整列消失。
  const normalized = row.provider_norm === null || row.provider_norm === undefined ? raw : String(row.provider_norm)
  return { providerRaw: raw, provider: normalized }
}

/**
 * `day` / `hour` 分组与时间序列用的**原始行**（不在 SQL 里分桶）。
 *
 * 🚨 分桶必须在 JS 侧做，理由见 {@link dimensionExpression} 的注释。
 *   `withSessionId` 只有分组才需要（会话要去重计数），序列不需要 ——
 *   少取一列在大表上就是少一次宽行扫。
 */
export function timeBucketRowsQuery(
  filter: QueryFilter = {},
  withSessionId = false,
  normalize?: ProviderNormalizer,
  /**
   * 是否连 `provider` / `model` 一起取。
   *
   * ★ 只有**要算金额**时才取（`withCost`）：金额必须按**每条事件当时的价**算，
   *   而价是按 `(provider, model)` 定的 —— 少了这两列就只能拿整个时间桶的
   *   总量去乘一个「平均单价」，那是错的（世上没有平均单价）。
   *   代价是每次扫描多两列，所以默认关。
   */
  withTarget = false,
): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
  const cols = [
    'ts',
    ...(withSessionId ? ['session_id'] : []),
    ...(withTarget ? ['provider', 'model'] : []),
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  ].join(', ')
  return { sql: `SELECT ${cols}\n       FROM ${EVENT_TABLE}${sql}`, params }
}

/**
 * 堆叠趋势（按人 / 按模型展开）用的**原始行**。
 *
 * ★ 分桶的理由与 {@link timeBucketRowsQuery} 完全相同：时间键必须在 JS 侧用
 *   `toDayKey()` / `toHourKey()` 算（SQLite 的 `'localtime'` 按操作系统时区、
 *   JS 按进程 TZ，在 `bun test` 下差 8 小时）。
 *
 * ⚠️ 数值列一律 `unknown`：`SUM()` 在 MySQL 驱动下是字符串（见 `toNumber()`）。
 *   这一支只取原始行、不做任何 SUM，但列类型仍然按同一约定声明。
 */
export interface StackRow {
  ts: unknown
  /** `model` 维度的分组键。`user` 维度没有这一列。 */
  stack_key?: unknown
  /** `user` 维度的归属三列 —— 键在 JS 侧算（成员视图与旧视图的键不同形）。 */
  member_id?: unknown
  user_id?: unknown
  user_name?: unknown
  /** 只在要算金额时才取（`(provider, model)` 是单价的匹配键）。 */
  provider?: unknown
  model?: unknown
  input_tokens: unknown
  output_tokens: unknown
  cache_read_tokens: unknown
  cache_write_tokens: unknown
}

/**
 * 堆叠趋势的取数：**原始行**，不聚合。
 *
 * ★ 为什么不像 `groupsQuery()` 那样把分组键交给 SQL：
 *
 * - `user` 维度的键有两种形态（成员视图是稳定 `member_id`、旧视图是 `user_id`），
 *   把这段 CASE 写进 SQL 就等于在 SQL 里再造一份归属口径 ——
 *   而它必须与 `PortalStatsSession.memberGroups()` **逐字相同**；
 * - 时间桶无论如何都在 JS 侧做，行反正要过一遍 JS。
 *
 * ⚠️ `member_id` / `user_id` / `user_name` 是**上报库专有**的列（本地
 *   `usage.sqlite` 那三列恒为 NULL，也只由 `portal.ts` 调用本函数）。
 */
export function stackRowsQuery(
  dim: 'user' | 'model',
  filter: QueryFilter = {},
  normalize?: ProviderNormalizer,
  /**
   * 是否连 `provider` / `model` 一起取。
   *
   * ★ 只有**要算金额**时才取：金额必须按每条事件**当时的价**算，而价是按
   *   `(provider, model)` 定的。少了这两列就只能拿整个桶的总量去乘一个
   *   「平均单价」—— 那是错的（世上没有平均单价）。
   *   理由与 `timeBucketRowsQuery()` 的第 4 个参数完全相同。
   */
  withTarget = false,
): SqlQuery {
  const { sql, params } = buildWhere(filter, normalize)
  const keyCols = dim === 'model' ? 'model AS stack_key' : 'member_id, user_id, user_name'
  return {
    sql: `SELECT ts, ${keyCols}, ${withTarget ? 'provider, model, ' : ''}
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
          FROM ${EVENT_TABLE}${sql}`,
    params,
  }
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
  label?: string
  memberId?: string | null
  /**
   * 该人员当前所属的全部分组名（多对多）。
   *
   * ★ 只有人员维度与分组维度的行才带它：其余维度（provider / model / …）
   *   一行对应的是「一批调用」，没有单一的所属分组可言。
   */
  groupNames?: string[]
  attributionStatus?: 'member' | 'legacy' | 'unattributed'
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
  normalize?: ProviderNormalizer,
): QueryGroupRow[] {
  // project 维度走「取出 cwd 后内存分组」的特殊路径
  if (dim === 'project') return queryGroupsByProject(db, filter)
  // day / hour 同理：时间键必须在 JS 侧算
  if (dim === 'day' || dim === 'hour') return queryGroupsByTime(db, dim, filter)

  const q = groupsQuery(dim, filter, dialect, normalize)
  if (!q) return []

  const rows = db.query<RawGroupRow, SQLQueryBindings>(q.sql).all(q.params)

  return sortGroupRows(mapGroupRows(rows), dim)
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
  /** 来源（DSH / Codex / …）；P2 起由 `usage_event.source` 列给出。 */
  source: SessionSource
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
        source: SessionSource
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
      `SELECT event_id, session_id, seq, ts, provider, model, cwd, source,
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
      // 来源直接来自列（老库重建时默认 `'dsh'`，那是历史事实）。
      source: r.source,
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
