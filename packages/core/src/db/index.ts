/**
 * `core/db` —— 本地 SQLite 增量库。
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `schema.ts` | 表结构（4 个独立列 + `event_id` 主键）与 PRAGMA |
 * | `ingest.ts` | 增量入库：复用 `scanIncremental`，数据与水印同事务 |
 * | `query.ts` | 查询：**只做原始列求和，不写任何公式** |
 * | `stats.ts` | 门面：SQL / 直扫两条路径统一为 `StatsSession` |
 *
 * ★ 为什么这个库存在、以及为什么必须保留降级路径，
 *   见 `stats.ts` 与 `schema.ts` 的模块注释。
 */

export * from './schema.js'
export * from './ingest.js'
export * from './query.js'
export * from './stats.js'