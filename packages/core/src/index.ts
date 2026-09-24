/**
 * `@ai-token-report/core` —— 统计内核。
 *
 * ★ 这是整个平台的**唯一取数与聚合实现**。CLI、本地服务、部门服务端
 *   全部调用这里，因此「命令行看到的数」与「页面看到的数」必然一致。
 *
 * ## 模块构成
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `decode.ts` | zstd 分帧解码（按 magic `28 B5 2F FD`） |
 * | `scanner.ts` | 会话日志扫描 + 全量/增量过滤 |
 * | `aggregate.ts` | 分组聚合 / 时间序列 / 交叉表 |
 * | `range.ts` | 时间范围解析（today / week / 最近7天 / 中文别名） |
 * | `state.ts` | 增量水位线（文件大小 / 帧数 / seq 三层） |
 * | `format.ts` | 终端表格渲染 |
 * | `types.ts` | 用量与计费记录类型 |
 * | `home.ts` | DSH home 路径解析 |
 * | `identity-store.ts` | 本地身份存储 |
 * | `db/` | ★ 本地 SQLite 增量库（**独立入口**，见下） |
 *
 * HTTP 投递（`deliver.ts`）与上报编排（`report.ts`）**不在 core**——
 * 它们是 CLI 职责，见 `packages/cli/src/`。
 *
 * ## ⚠️ `db/` 为什么不在这个入口里 re-export
 *
 * `db/` 依赖 `bun:sqlite`（Bun 运行时专有）。若在这里 `export * from './db/index.js'`，
 * 任何 import 本模块的代码都会被拖进 sqlite 依赖 —— 包括
 * web 前端、DSH 插件这类**根本不需要数据库**的消费方。
 *
 * 因此 db 走**独立入口** `@ai-token-report/core/db`，
 * 需要数据库的调用方显式 import 它。
 */

export const CORE_VERSION = '0.1.0'

export * from './home.js'
export * from './identity-store.js'

// S1 阶段迁入：先原样搬，不改逻辑
export * from './decode.js'
export * from './scanner.js'
export * from './aggregate.js'
export * from './range.js'
export * from './state.js'
export * from './format.js'
export * from './types.js'