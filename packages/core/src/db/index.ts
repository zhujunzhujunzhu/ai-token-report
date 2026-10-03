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
// 纯文本来源（Codex 等）的增量入库：与 `ingest.ts` 共用 schema 与幂等语义，
// 但判据不同（没有 zstd 帧，用文件级 L1 + `event_id` 去重），所以是两个入口。
export * from './ingest-plain.js'
export * from './query.js'
export * from './stats.js'
export * from './local-rollup.js'
// ★ 费用聚合的公共件：**离线路径**（本地页 / CLI，价来自 `pricing.json` 快照）
//   与上报库路径（部门看板，价来自 `model_price` 表）共用同一份折叠与类型 ——
//   两条路径的差别只在「价从哪来」，不在「怎么算」。
export * from './cost.js'
// ★ 上报库：部门看板的取数入口。与 `stats.js` 并列导出，
//   因为两者服务的是**两个不同的库**（usage.sqlite vs portal.sqlite/MySQL），
//   调用方必须显式选一个，不能靠「默认值」蒙对。
export * from './portal.js'
// ★ 供应商归一化：上报库里五花八门的 provider 名折叠成一个口径。
//   它属于**查询层**（`query.ts` 的 SQL 构造器吃它的表达式），
//   所以必须与 `query.js` 一起可被 `portal.ts` / `stats-route.ts` 取到。
export * from './provider-alias.js'
// ★ 项目归一化：上报库里的 `cwd` 折叠成一个项目口径（按**目录前缀**匹配，
//   最长前缀优先）。与供应商归一化并列 —— 两者是同一类东西（查询期的展示口径），
//   差别只在匹配语义，所以必须一起可被 `portal.ts` / `stats-route.ts` 取到。
export * from './project-alias.js'
// ★ 方言 / MySQL 驱动 / 上报库门面。三者共同构成「一份 SQL、两种后端」：
//   方言定义必须可被 `query.ts`（本地 + 部门共用）与 `ingest.ts` 直接取到，
//   不能只藏在 `portal-db.ts` 里（那会形成 `query.ts → portal-db.ts` 的假依赖）。
//   ⚠️ `portal-db.ts` 会 re-export `dialect.ts` 的同名符号 —— 它们是**同一个
//   声明的别名**，因此不构成重名冲突（`bun run typecheck` 会兜住这一点）。
export * from './dialect.js'
export * from './mysql.js'
export * from './portal-db.js'
// ★ 看板汇总表（v8）：**性能设施**，可从 `usage_event` 完整重建。
//   与 `local-rollup.js`（本机库的派生索引）是一对：两者都做「把重复事件压缩」，
//   但服务的是两个不同的库、两套不同的维度（本机那份按会话/模型，这份按人员/分组归属）。
export * from './rollup.js'
