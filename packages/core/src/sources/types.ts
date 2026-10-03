/**
 * **会话来源适配器**：本仓唯一的「多客户端」扩展点。
 *
 * ## 为什么要有这一层
 *
 * 平台要统计的不只是 DSH：Codex、Claude Code、WorkBuddy …… 它们之间**只有
 * 「日志长什么样、怎么折叠成计费记录」不同**，而下游（聚合 / 分桶 / 幂等键 /
 * 本地库 / 上报 / 看板 / 计价）**必须只有一套**。
 *
 * 因此这里的边界刻意画得很窄 —— 一个来源只需要回答三件事：
 *
 * | 问题 | 方法 |
 * |---|---|
 * | 本机有哪些日志根 | {@link SessionSourceAdapter.roots} |
 * | 根下有哪些会话文件 | {@link SessionSourceAdapter.list} |
 * | 文件怎么解码、怎么折叠成计费记录 | {@link SessionSourceAdapter.encoding} + {@link SessionSourceAdapter.createFolder} |
 *
 * 除此之外的一切都不允许按来源分叉：
 * `event_id` 的构造（除来源前缀外）、水位线推进、入库、聚合、上报、计价**全部共用**。
 *
 * ## 新增一个来源的完整步骤（就这三步）
 *
 * 1. 写一个 `sources/<id>.ts`，实现 {@link SessionSourceAdapter}；
 * 2. 在 `types.ts` 的 `SessionSource` 里加上这个 id（受控枚举，避免拼错悄悄多出一个来源）；
 * 3. 在 `sources/registry.ts` 里 `registerSource(...)`。
 *
 * 不需要改 schema、不需要改协议、不需要改任何路由 —— 除非那个来源带来了
 * **新的计费字段语义**（例如 Codex 的 `cached` 含在 `input` 内），
 * 那种情况只会出现在适配器的字段映射函数里，并在那里用中文注释钉住。
 */

import type { ScanDiagnostics, SessionMeta, SessionSource, UsageRecord } from '../types.js'

/**
 * 一个来源在本机的一处日志根。
 *
 * `secondary` 用来表达「同一批会话的第二份副本」（例如 Codex 的
 * `archived_sessions/`、或另一个 home 里的镜像）：**列举顺序上排在主根之后**，
 * 且同一会话以先出现者为准 —— 主副本优先，副本永远不能覆盖主副本。
 */
export interface SourceRoot {
  /** 日志根目录（绝对路径）。 */
  path: string
  /** 这个根属于哪个来源。 */
  source: SessionSource
  /** 次要副本（归档 / 镜像）。主根先列举，`event_id` 冲突时先到者胜。 */
  secondary?: boolean
}

/** 折叠器：把一个文件的（增量）文本块折叠成计费记录。 */
export interface SourceFolder {
  /** 喂入一段**文本**（适配器负责解码；`zstd-frames` 来源由 scanner 逐帧解压后喂入）。 */
  push(chunk: string): void
  /** 收尾：处理末尾没有换行的残行。 */
  finish(): void
}

/**
 * 一个来源的适配器。
 *
 * ⚠️ `list` 只负责**列文件**，不做任何解析；`createFolder` 只负责**折叠**，
 * 不碰文件系统。这样「列举 / 解码 / 折叠」三件事各自可测，
 * 也不会出现「同一个文件被两个来源各读一次」这种口径分叉。
 */
export interface SessionSourceAdapter {
  /** 来源 id（与 `SessionSource` 一致）。 */
  readonly id: SessionSource
  /**
   * 关掉这个来源的环境变量名（可选）。
   *
   * `0/false/no/off` 视为关闭。**它与 DSH 的 `DSH_TOKEN_REPORT_DISCOVER` 是两件事**：
   * 那个是「别自动发现」，这个是「这个来源整个不要采」。
   * 🚨 测试与验证脚本必须钉住它们，否则会连带扫开发者真实的日志目录（见 `scripts/test-preload.ts`）。
   */
  readonly disableEnv?: string
  /**
   * 本机该来源的日志根（**含次要副本**）。
   *
   * 传空数组表示「调用方没显式指定」，由适配器按自己的默认规则解析
   * （环境变量 > 约定目录）。**不存在的根要原样返回**，由上层报出来 ——
   * 「配了但不存在」与「本来就没有」是两件事。
   */
  roots(homes: readonly string[]): SourceRoot[]
  /** 列出一个根下的全部会话日志文件。`strictErrors` 用于全量补报路径（宁可整轮失败）。 */
  list(root: SourceRoot, options?: { strictErrors?: boolean }): Promise<SessionMeta[]>
  /**
   * 文件编码：
   * - `zstd-frames`：DSH 的分帧 zstd（必须显式做帧完整性检查，见 `decode.ts`）
   * - `plain-jsonl`：**纯文本逐行日志** —— Codex / Claude Code 的行式 JSONL，
   *   以及 Trae 的 Rust tracing 文本日志（不是 JSON，但同样是「按行喂文本」，
   *   走的通路与水位线语义完全相同，所以共用这个取值，见 `db/ingest-plain.ts`）
   */
  readonly encoding: 'zstd-frames' | 'plain-jsonl'
  /**
   * 造一个折叠器；计费字段映射（含「谁包含谁」这种上游语义差异）只在这里出现。
   *
   * `records` 由**调用方**提供（与 DSH 侧 `eventCollector` 同构）：产出直接落进
   * 调用方那个数组，全仓只有一条「记录 → 去重 → 筛选 → 入库/上报」的路径。
   */
  createFolder(meta: SessionMeta, diagnostics: ScanDiagnostics, records: UsageRecord[]): SourceFolder
  /**
   * 巡检一个根：回答「这个根里有多少会话 / 日志、最近写入是什么时候」。
   *
   * 🚨 **必须由来源自己实现**：DSH 的巡检假设 `<project>/<sessionId>/<file>` 三层结构，
   *   拿它去数 Codex 的 `<YYYY>/<MM>/<DD>/rollout-*.jsonl` 会得到
   *   「会话 0 / 日志 0」—— 一个**看起来完全正常的空目录**。
   *   这正是「静默 0」最典型的形态，所以巡检能力跟着适配器走。
   *
   * 未实现时上层只能报「未知」，**不得**回落到别的来源的巡检实现。
   */
  inspect?(root: SourceRoot): Promise<SourceInspection>
}

/** 一个来源根的巡检结果（字段与 DSH 的 `SessionsRootInspection` 对齐）。 */
export interface SourceInspection {
  /** 含日志文件的会话数。 */
  sessions: number
  /** 日志文件数。 */
  files: number
  /** 最近一次写入（epoch ms）；无文件或不可读时为 `null`。 */
  latestMs: number | null
  /** 读不了的原因（「存在但读不了」与「不存在」是两件事）。 */
  error?: string
}
