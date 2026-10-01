/**
 * 上报库 v8 追加：**看板汇总表**（性能设施，不是新事实源）。
 *
 * ## 为什么是「只追加」
 *
 * v8 与 v6 / v7 同构：**只加表、加索引**，不改任何既有列、不重建事实表。
 * 因此迁移不需要备份证明、不需要重比事件指纹 —— 没有任何语句会改写 `usage_event`。
 * 回退位就是「删掉这三张表 + `usage_rollup_meta`」，看板会自动退回原始表（见下）。
 *
 * ## 这三张表是什么
 *
 * 看板取数一律是「整窗口聚合」：30 天要扫几十万行、`day`/`hour` 分桶还要把原始行
 * 搬回 Node。实测 300 万行下单个接口 330~490ms。汇总表把这些聚合**提前算好**，
 * 于是同样的接口变成查几千行小表（实测 191~485×）。
 *
 * | 表 | 粒度 | 服务 |
 * |---|---|---|
 * | `usage_rollup_day` | (本地日, 人, 供应商, 模型) | 长窗口趋势 / 排行 / 分布 |
 * | `usage_rollup_hour` | (本地日, 本地小时, 人, 供应商, 模型)，仅最近 N 天 | 单日日内曲线 + 近期时段分布 |
 * | `usage_rollup_hod` | (本地时点, 工作日?) | 全历史的「一天中的第几小时」分布 |
 *
 * ★ **时点粒度是被需求逼出来的**：`day` 粒度的汇总服务不了
 *   「选具体某天看趋势」（只有 1 个点）与「看工作时段分布」（时段信号被折叠掉），
 *   所以必须额外存一层「时刻」。设计与取舍见 `docs/汇总表设计规格.md`。
 *
 * ## 🚨 四条不许破的约束
 *
 * 1. **只存原始列的和**：`calls` + 四项 token + `reasoning_tokens` + `lo`/`hi`。
 *    **绝不存派生指标**（缓存命中率、均价、金额一律查询期现算）—— 这是铁律 1。
 * 2. **`sessions` 不在这三张表里**：去重会话数**不可加**（跨天会话会被算两次），
 *    所以它永远走原始表。少一列是刻意的，不是遗漏。
 * 3. **归属只存 `member_id`**：分组（多对多）在**查询期** JOIN
 *    `member_group_assignments` 展开。写进汇总行会让一个事件复制成多行、`SUM` 静默放大。
 * 4. **时间键在入库时就算好**（用 `aggregate.ts` 的 `toDayKey()` / `toHourKey()` /
 *    `hourOfDayOf()` / `dayKindOf()`），**绝不用 SQL 的 `DATE(FROM_UNIXTIME())`** ——
 *    那正是 `query.ts` 花大力气避开的时区分叉（SQLite 按 OS 时区、JS 按进程 TZ）。
 *
 * ## ⚠️ 汇总表不可用时必须退原始表
 *
 * 它是**性能设施，不是正确性依赖**。表缺了 / 水位落后 / 时区不匹配，
 * 一律回原始表并**不报错** —— 让看板白屏比慢 300ms 糟得多。
 *
 * ## ⚠️ MySQL 的索引键长（改这张表之前必读）
 *
 * InnoDB 的索引键上限是 **3072 字节**，而 utf8mb4 下 `CHAR(36)` 算 144 字节、
 *      `VARCHAR(255)` 算 **1020** 字节。`usage_rollup_day` 的主键
 *      `(day_key, member_id, provider, model)` = `40 + 144 + 1020 + 1020 = 2224` 字节，
 *      `usage_rollup_hod` 的主键 `(hour_of_day, day_kind, member_id, provider, model)`
 *      = `1 + 1 + 144 + 1020 + 1020 = 2186` 字节 —— **都在限内，但余量只有 ~850 字节**。
 *      任何一列加宽都要重新算，超了会在**真实 MySQL** 上抛 errno 1071，而 SQLite 完全不报。
 *
 * ## 🚨 为什么 `day_key` 用 `VARCHAR(10)` 而不是 `DATE`（实测踩到）
 *
 * `DATE` 在 SQL 语义上完全正确（`WHERE day_key = '2026-04-01'` 两种后端都对，
 * 写进去再读出来日期也不漂 —— 都实测过）。但它经驱动回来**不是字符串**：
 *
 * ```
 * DATE     → typeof=object ctor=Date json="2026-04-01T00:00:00.000Z"
 * VARCHAR  → typeof=string            json="2026-04-01"
 * ```
 *
 * 而查询路由要把 `day_key` 与 `toDayKey()` 产出的**字符串**比对
 * （分组键、缓存 key、`Map` 查找）。给一个 `Date` 对象就会出现
 * 「`'2026-04-01' !== Date`」这种静默不匹配 —— 表现是缓存永不命中、
 * 或分桶键变成 `Wed Apr 01 2026 08:00:00 GMT+0800` 这种本地时间文本，**且不报错**。
 *
 * ⇒ 用 `VARCHAR(10)`：两种后端回来都是 `YYYY-MM-DD` 字符串，
 *   与 `toDayKey()` 逐字相同，不需要任何类型归一。
 */
import type { PortalBackendKind } from './dialect.js'

/** 汇总表的保留窗口（天）：`usage_rollup_hour` 只留这么多天的细粒度。 */
export const ROLLUP_HOUR_RETAIN_DAYS = 30

/**
 * SQLite 形态的 v8 追加。
 *
 * ⚠️ 日期列写 `TEXT` 存 `YYYY-MM-DD`（与 `toDayKey()` 的输出逐字相同），
 *   不写 `DATE` —— SQLite 的 `DATE` 只是「类型亲和性」，落盘仍是文本，
 *   写 `TEXT` 能让「存的到底是什么」在 DDL 上就看得出来。
 */
export const PORTAL_SQLITE_V8_ADDITIONS = `
-- ★ v8：看板汇总表（性能设施；可从 usage_event 完整重建）。
-- 只存原始列的和；sessions 刻意不在其中（不可加，永远走原始表）。
CREATE TABLE usage_rollup_day (
  day_key TEXT NOT NULL CHECK (length(day_key) = 10),
  member_id TEXT NOT NULL CHECK (length(member_id) = 36 OR member_id = ''),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 0 AND 255),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 0 AND 255),
  calls INTEGER NOT NULL CHECK ((typeof(calls) = 'integer' AND calls >= 0)),
  input_tokens INTEGER NOT NULL CHECK ((typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens INTEGER NOT NULL CHECK ((typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  cache_read_tokens INTEGER NOT NULL CHECK ((typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0)),
  cache_write_tokens INTEGER NOT NULL CHECK ((typeof(cache_write_tokens) = 'integer' AND cache_write_tokens >= 0)),
  reasoning_tokens INTEGER NOT NULL CHECK ((typeof(reasoning_tokens) = 'integer' AND reasoning_tokens >= 0)),
  lo INTEGER NOT NULL CHECK ((typeof(lo) = 'integer' AND lo BETWEEN 0 AND 9007199254740991)),
  hi INTEGER NOT NULL CHECK ((typeof(hi) = 'integer' AND hi BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (day_key, member_id, provider, model),
  CHECK (hi >= lo)
);

CREATE TABLE usage_rollup_hour (
  day_key TEXT NOT NULL CHECK (length(day_key) = 10),
  hour_of_day INTEGER NOT NULL CHECK ((typeof(hour_of_day) = 'integer' AND hour_of_day BETWEEN 0 AND 23)),
  member_id TEXT NOT NULL CHECK (length(member_id) = 36 OR member_id = ''),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 0 AND 255),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 0 AND 255),
  calls INTEGER NOT NULL CHECK ((typeof(calls) = 'integer' AND calls >= 0)),
  input_tokens INTEGER NOT NULL CHECK ((typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens INTEGER NOT NULL CHECK ((typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  cache_read_tokens INTEGER NOT NULL CHECK ((typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0)),
  cache_write_tokens INTEGER NOT NULL CHECK ((typeof(cache_write_tokens) = 'integer' AND cache_write_tokens >= 0)),
  reasoning_tokens INTEGER NOT NULL CHECK ((typeof(reasoning_tokens) = 'integer' AND reasoning_tokens >= 0)),
  lo INTEGER NOT NULL CHECK ((typeof(lo) = 'integer' AND lo BETWEEN 0 AND 9007199254740991)),
  hi INTEGER NOT NULL CHECK ((typeof(hi) = 'integer' AND hi BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (day_key, hour_of_day, member_id, provider, model),
  CHECK (hi >= lo)
);

CREATE TABLE usage_rollup_hod (
  hour_of_day INTEGER NOT NULL CHECK ((typeof(hour_of_day) = 'integer' AND hour_of_day BETWEEN 0 AND 23)),
  day_kind INTEGER NOT NULL CHECK (day_kind IN (0,1)),
  member_id TEXT NOT NULL CHECK (length(member_id) = 36 OR member_id = ''),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 0 AND 255),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 0 AND 255),
  calls INTEGER NOT NULL CHECK ((typeof(calls) = 'integer' AND calls >= 0)),
  input_tokens INTEGER NOT NULL CHECK ((typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens INTEGER NOT NULL CHECK ((typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  cache_read_tokens INTEGER NOT NULL CHECK ((typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0)),
  cache_write_tokens INTEGER NOT NULL CHECK ((typeof(cache_write_tokens) = 'integer' AND cache_write_tokens >= 0)),
  reasoning_tokens INTEGER NOT NULL CHECK ((typeof(reasoning_tokens) = 'integer' AND reasoning_tokens >= 0)),
  PRIMARY KEY (hour_of_day, day_kind, member_id, provider, model)
);

-- 单行元数据：水位 + 时区键 + T2 的保留边界。
-- 🚨 水位是**复合游标** (built_through_ms, built_through_event_id)，不是单个时刻：
--   一次批量上报的接收时刻**完全相同**，只比 received_at_ms > 会让水位停住不动，
--   剩下的数据永远进不了汇总（实测：300 万行只同步了 20 万行，且没有任何报错）。
--   event_id 是主键，加进游标后严格单调。
CREATE TABLE usage_rollup_meta (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  timezone_key TEXT NOT NULL CHECK (length(timezone_key) BETWEEN 1 AND 128),
  built_through_ms INTEGER NOT NULL CHECK ((typeof(built_through_ms) = 'integer' AND built_through_ms >= 0)),
  built_through_event_id TEXT NOT NULL CHECK (length(built_through_event_id) BETWEEN 0 AND 255),
  hour_cutoff_ms INTEGER NOT NULL CHECK ((typeof(hour_cutoff_ms) = 'integer' AND hour_cutoff_ms >= 0)),
  updated_at_ms INTEGER NOT NULL CHECK ((typeof(updated_at_ms) = 'integer' AND updated_at_ms >= 0))
);
`

/**
 * MySQL 形态的 v8 追加（与 SQLite 侧**逐列同名**，只差方言与列宽写法）。
 *
 * ⚠️ `member_id` 用 `CHAR(36)` 且**不加外键**：汇总表可以从原始表完整重建，
 *   不存在「历史引用」需要保护；而加外键会让 `DELETE FROM usage_rollup_*`
 *   （保留窗口清理）多一层父子校验，且每行多一次索引查找。
 *   未归属用 `''` 哨兵而不是 `NULL` —— 主键列不能为 NULL（errno 1171）。
 */
export const PORTAL_MYSQL_V8_ADDITIONS = `
-- ★ v8：看板汇总表（性能设施；可从 usage_event 完整重建）。
-- 只存原始列的和；sessions 刻意不在其中（不可加，永远走原始表）。
CREATE TABLE usage_rollup_day (
  day_key VARCHAR(10) NOT NULL CHECK (CHAR_LENGTH(day_key) = 10),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 0 AND 255),
  model VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(model) BETWEEN 0 AND 255),
  calls BIGINT NOT NULL CHECK (calls BETWEEN 0 AND 9007199254740991),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  reasoning_tokens BIGINT NOT NULL CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  lo BIGINT NOT NULL CHECK (lo BETWEEN 0 AND 9007199254740991),
  hi BIGINT NOT NULL CHECK (hi BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (day_key, member_id, provider, model),
  CHECK (hi >= lo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX idx_rollup_day_member ON usage_rollup_day (member_id, day_key);

CREATE TABLE usage_rollup_hour (
  day_key VARCHAR(10) NOT NULL CHECK (CHAR_LENGTH(day_key) = 10),
  hour_of_day TINYINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 0 AND 255),
  model VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(model) BETWEEN 0 AND 255),
  calls BIGINT NOT NULL CHECK (calls BETWEEN 0 AND 9007199254740991),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  reasoning_tokens BIGINT NOT NULL CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  lo BIGINT NOT NULL CHECK (lo BETWEEN 0 AND 9007199254740991),
  hi BIGINT NOT NULL CHECK (hi BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (day_key, hour_of_day, member_id, provider, model),
  CHECK (hi >= lo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE usage_rollup_hod (
  hour_of_day TINYINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  day_kind TINYINT NOT NULL CHECK (day_kind IN (0,1)),
  member_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(provider) BETWEEN 0 AND 255),
  model VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(model) BETWEEN 0 AND 255),
  calls BIGINT NOT NULL CHECK (calls BETWEEN 0 AND 9007199254740991),
  input_tokens BIGINT NOT NULL CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens BIGINT NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_tokens BIGINT NOT NULL CHECK (cache_write_tokens BETWEEN 0 AND 9007199254740991),
  reasoning_tokens BIGINT NOT NULL CHECK (reasoning_tokens BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (hour_of_day, day_kind, member_id, provider, model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE usage_rollup_meta (
  id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
  timezone_key VARCHAR(128) NOT NULL CHECK (CHAR_LENGTH(timezone_key) BETWEEN 1 AND 128),
  built_through_ms BIGINT NOT NULL CHECK (built_through_ms BETWEEN 0 AND 9007199254740991),
  built_through_event_id VARCHAR(255) NOT NULL,
  hour_cutoff_ms BIGINT NOT NULL CHECK (hour_cutoff_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
`

/** v8 追加里的表名（迁移器与 `verifyCurrent` 都从这里取「该有哪些表」）。 */
export const PORTAL_V8_TABLES = ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod', 'usage_rollup_meta'] as const

/** 某后端上「v8 追加」的完整语句清单（建表 + 建索引）。 */
export function portalV8Statements(kind: PortalBackendKind): string[] {
  const additions = kind === 'mysql' ? PORTAL_MYSQL_V8_ADDITIONS : PORTAL_SQLITE_V8_ADDITIONS
  return additions.replace(/^--.*$/gm, '').split(';').map(statement => statement.trim()).filter(Boolean)
}

/** 某后端上 v8 追加里的**表定义**（供迁移器逐列核对）。 */
export function portalV8TableStatement(kind: PortalBackendKind, table: string): string {
  const sql = portalV8Statements(kind).find(statement => statement.startsWith(`CREATE TABLE ${table} (`))
  if (!sql) throw new Error(`缺少 v8 受控表定义：${table}`)
  return sql
}

/** v8 追加的文本摘要（供 `portalSchemaChecksum` 与冻结的 v7 摘要区分）。 */
export function portalV8ChecksumInput(kind: PortalBackendKind): string {
  return (kind === 'mysql' ? PORTAL_MYSQL_V8_ADDITIONS : PORTAL_SQLITE_V8_ADDITIONS).trim()
}

/**
 * 汇总表的**时区键** —— 恒等于「本进程看到的时区」。
 *
 * 🚨 它必须与 `local-rollup.ts` 的 `timezoneKey()` **同源**：那两个键都表示
 *   「这批 `day_key` 是在哪个时区算出来的」。任一处漏掉时区，
 *   「改了 TZ 但 `day_key` 还是旧的」就会表现为趋势点整体偏移 8 小时，
 *   而且**没有任何报错**。
 */
export function rollupTimezoneKey(version: number): string {
  return `${process.env['TZ'] ?? ''}|${Intl.DateTimeFormat().resolvedOptions().timeZone}|v${version}`
}

/** 供测试断言用：v8 的受控摘要输入里必须含这三张表 + 元数据表的定义文本。 */
export function portalV8MentionsAllTables(kind: PortalBackendKind): boolean {
  const text = portalV8ChecksumInput(kind)
  return PORTAL_V8_TABLES.every(table => text.includes(`CREATE TABLE ${table} (`))
}
