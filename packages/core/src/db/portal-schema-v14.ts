/**
 * 上报库 v14 追加：**给 `usage_event.source` 建单列索引**。
 *
 * ## 🚨 这一版是被线上实测逼出来的，不是「预计会有用」
 *
 * 2026-10-04 线上看板（`117.72.173.21`，MySQL 8.0.40，19.7 万行）实测：
 *
 * ```
 * EXPLAIN SELECT DISTINCT source FROM usage_event ORDER BY source
 *   → type=ALL  rows=224453  Extra=Using temporary; Using filesort
 *   → 656 次调用累计 120.1 秒，单次最大 0.5 秒
 * ```
 *
 * 也就是说，**筛选栏那一个下拉框**（`GET /api/v1/stats/sources`）一个人访问一次
 * 就要扫 22 万行。这条查询在页面上是「打开看板必发」的（候选列表），
 * 而慢查询日志里它是**耗时第一名**（超过所有聚合查询之和）。
 *
 * 本机隔离库（20 万行 / 来源基数 4）实测加索引前后：
 *
 * | | 加索引前 | 加索引后 |
 * |---|---|---|
 * | `DISTINCT source` | 13 / 13 / 7 ms | **1 / 1 / 0 ms** |
 * | `WHERE source='dsh'` | 7 / 6 / 7 ms | 7 / **2 / 2** ms |
 * | 执行计划 | `type=ALL  rows=224453  Using temporary` | `type=range  rows=4  Using index for group-by` |
 * | 索引体积 | — | 20 万行约 1.1 MB（数据 8.5 MB） |
 *
 * 🚨 关键在 `Using index for group-by` —— MySQL 的 **loose index scan**：
 *   基数是 4，它就只读 4 个索引项，**与表有多大完全无关**。
 *   这与「给 `(source, ts)` 建复合索引然后照样扫 20 万行」有本质区别
 *   （后者实测只有 8% 收益，因为它服务不了 `DISTINCT`）。
 *
 * ## 为什么不是「给 `source` 加到已有复合索引里」
 *
 * 候选列表是**不带时间窗、不带任何筛选**的（`#sources()` 的注释已说明）：
 * 「上个月用过的供应商」不该从下拉里消失。所以它需要的索引最左列就是 `source`，
 * 而线上现有的 8 个索引里**没有一条以 `source` 起头** ——
 * `idx_usage_event_ts(ts)` 只能被优化成「扫 ts 区间再判 source」，
 * 那仍然是全表扫描（实测 `type=ALL`）。
 *
 * ## ⚠️ 它是**只加索引、不动任何数据**的一版
 *
 * 与 v8 同构：只 `CREATE INDEX`，不新增/修改任何表、列、行。
 * 因此迁移不需要备份证明、不需要比对事件指纹（没有任何语句会改写 `usage_event`），
 * 回退位就是「删掉这个索引」，而查询层在索引缺失时**自动退全表扫描**（正确性不受影响）。
 *
 * ## 🚨 为什么**不加**进汇总表（`usage_rollup_*`）的键
 *
 * 看起来「汇总表也加 source 就能让按来源取数走汇总」是更大的收益，但代价是
 * **重建全部汇总行**（`rollup.ts` 的水位要从零重跑，线上 19.7 万行实测要几十秒）
 * 且三张表的主键都要换（MySQL 上换主键要 DROP + ADD，会与 `usage_rollup_meta`
 * 的水位事务纠缠）。这一版的收益已经覆盖了真实瓶颈（候选列表），
 * 汇总表那条路留到真的需要时再做 —— 那时它是一次独立的、有备份的迁移。
 */
import type { PortalBackendKind } from './dialect.js'

/** 受控索引名（迁移器与 `verifyCurrent` 共用同一份字面量）。 */
export const PORTAL_SOURCE_INDEX = 'idx_usage_event_source'

/**
 * 索引的列组合 —— **只有 `source` 一列**，刻意不加第二列。
 *
 * 🚨 加第二列（哪怕就是 `ts`）会让 loose index scan **失效**：
 *   `Using index for group-by` 要求索引是「按 `DISTINCT` 那一列有序」，
 *   而带第二列时优化器要先按两列的复合序扫描、再去重，
 *   实测退回 `Using temporary`（20 万行 13ms，无收益）。
 *   这也是为什么**不能**把它写成 `(source, ts)` 复用「反正要加 ts」的直觉 ——
 *   那个组合服务不了 `DISTINCT`，而 `DISTINCT` 正是我们要治的那条查询。
 */
export const PORTAL_SOURCE_INDEX_COLUMNS = 'source'

/**
 * 索引语句（两种后端**逐字相同**：只有索引名与列，没有方言差异）。
 *
 * ⚠️ 刻意**不带 `IF NOT EXISTS`**：幂等由迁移器自己判断
 *   （先查 `information_schema.statistics`，见 `ensureIndex()`），
 *   而 SQLite 的 `CREATE INDEX IF NOT EXISTS` 会让「同名但列不同」的索引
 *   被静默跳过 —— 那正是 `ensureIndex()` 的列比对存在的理由。
 */
export function portalSourceIndex(): string {
  return `CREATE INDEX ${PORTAL_SOURCE_INDEX} ON usage_event (${PORTAL_SOURCE_INDEX_COLUMNS})`
}

/**
 * v14 的语句清单。
 *
 * ★ 与 `portalSchemaStatements()` 拼接用的是**同一份** `portalSourceIndex()`：
 *   「新建的库」与「迁移上来的库」必须逐字一致，否则同一个版本号下
 *   两种库的索引集不同（`isCreateIndex()` 的注释记录过这个坑：
 *   `provider_alias` 的唯一索引曾因此漏执行两个版本）。
 */
export function portalV14Statements(): string[] {
  return [portalSourceIndex()]
}

/**
 * v14 的摘要输入（`portalSchemaChecksum` 按它把这次加索引算进去）。
 *
 * ★ 它是**独立**的函数而不是复用 `portalSchemaChecksumV12()`：
 *   两者逐字不同正是本版本存在的证据。将来 v15 只加索引时，
 *   v14 的摘要必须继续冻结，好让「v14 库」能被认成可迁移的上一版。
 */
export function portalV14ChecksumInput(kind: PortalBackendKind): string {
  // ⚠️ 参数刻意留着不删：签名与其他版本一致，且提醒调用方
  //   「这个版本没有方言差异」—— 两个后端的索引语句是同一句。
  void kind
  return portalSourceIndex()
}
