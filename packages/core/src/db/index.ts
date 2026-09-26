/**
 * `core/db` —— 本地 SQLite 增量库 + 上报库（SQLite / MySQL 双后端）。
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `driver.ts` | ★ 驱动适配：Bun → `bun:sqlite`，Node → `node:sqlite`（只抹平调用方式，不碰 SQL） |
 * | `schema.ts` | 表结构（4 个独立列 + `event_id` 主键）与 PRAGMA |
 * | `ingest.ts` | 增量入库（同步 SQLite）+ 服务端上报落库（异步 `PortalStore`） |
 * | `query.ts` | 查询：**只做原始列求和，不写任何公式**；★ SQL 构建器的唯一来源 |
 * | `stats.ts` | 门面：SQL / 直扫两条路径统一为 `StatsSession`（本机库） |
 * | `portal.ts` | 门面：**上报库**只读查询（部门看板），无降级路径 |
 * | `dialect.ts` | ★ SQLite ↔ MySQL 的**四处**语法差异（两处会「静默语义变化」） |
 * | `mysql.ts` | MySQL 驱动适配（`Bun.sql`）+ `$name` → `?` 参数翻译；Node 上明确报错 |
 * | `portal-db.ts` | 上报库门面：`PortalStore` / `PortalTarget` / 版本闸门（绝不重建） |
 *
 * ★ 为什么这些库存在、以及为什么必须保留降级路径，
 *   见 `stats.ts` 与 `schema.ts` 的模块注释。
 * ★ 「本机库恒为 SQLite、只有上报库能换 MySQL」这条边界见 `portal-db.ts`。
 */

export * from './driver.js'
export * from './schema.js'
export * from './ingest.js'
export * from './query.js'
export * from './stats.js'
export * from './local-rollup.js'
// ★ 上报库：部门看板的取数入口。与 `stats.js` 并列导出，
//   因为两者服务的是**两个不同的库**（usage.sqlite vs portal.sqlite/MySQL），
//   调用方必须显式选一个，不能靠「默认值」蒙对。
export * from './portal.js'
// ★ 方言 / MySQL 驱动 / 上报库门面。三者共同构成「一份 SQL、两种后端」：
//   方言定义必须可被 `query.ts`（本地 + 部门共用）与 `ingest.ts` 直接取到，
//   不能只藏在 `portal-db.ts` 里（那会形成 `query.ts → portal-db.ts` 的假依赖）。
//   ⚠️ `portal-db.ts` 会 re-export `dialect.ts` 的同名符号 —— 它们是**同一个
//   声明的别名**，因此不构成重名冲突（`bun run typecheck` 会兜住这一点）。
export * from './dialect.js'
export * from './mysql.js'
export * from './portal-db.js'
