/**
 * 共享类型定义。
 *
 * 计费语义（已对 9,845 条真实样本验证）：
 *
 *   totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
 *
 * 其中 `inputTokens` 是**未命中缓存**的部分，`cacheReadTokens` 单列。
 * 二者绝不可相加去当「输入」——实测 cacheRead 是 input 的 19.2 倍。
 */

/**
 * 会话日志的**来源**（产生这批用量的客户端）。
 *
 * ★ 为什么它必须是一等维度而不是「一个标签」：不同来源的模型族完全不同
 *   （`gpt-5.5` vs `deepseek-v4.1-flash`），而单价是按 `(provider, model)`
 *   精确匹配的 —— 合并之后就再也分不开「这个金额是按谁的价算的」，
 *   也答不出「这个数字是谁的」。
 *
 * ★ 这是一个**受控枚举**（不是 `string`）：来源名写错时应当在编译期就暴露，
 *   而不是在库里悄悄多出一个谁也叫不出名字的来源。新增来源的步骤见
 *   `sources/types.ts` 的文件头（加 id + 加适配器 + 注册一行）。
 *
 * ⚠️ 它**不参与**任何口径公式，只作为筛选 / 分组维度；
 *   `event_id` 里也只有 *非 DSH* 来源才带前缀（见 `scanner.ts`：
 *   DSH 的 `event_id` 是上报库主键，改它等于让服务端把历史事件再插一遍）。
 */
export type SessionSource = 'dsh' | 'codex' | 'claude-code' | 'workbuddy' | 'trae' | 'trae-cn'

/** provider 上报的单次调用用量（对应 @deepseek-ai/dsh-llm 的 TokenUsage）。 */
export interface RawUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 归集后的 token 计数，四个类目始终分开保存。 */
export interface TokenCounts {
  /** 未命中缓存的输入 token。 */
  input: number
  /** 输出 token。 */
  output: number
  /** 命中缓存读取的 token。 */
  cacheRead: number
  /** 写入缓存的 token。 */
  cacheWrite: number
  /** 推理 token（多数 provider 不下发，恒为 0 属正常）。 */
  reasoning: number
  /** 计费总量 = input + output + cacheRead + cacheWrite。 */
  total: number
  /** 计费事件条数（即 assistant/message 条数）。 */
  calls: number
}

export function emptyCounts(): TokenCounts {
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

export function addCounts(target: TokenCounts, usage: RawUsage): void {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0

  target.input += input
  target.output += output
  target.cacheRead += cacheRead
  target.cacheWrite += cacheWrite
  target.reasoning += usage.reasoningTokens ?? 0
  // 用恒等式重算而非直接信任 totalTokens，坏数据下更稳
  target.total += input + output + cacheRead + cacheWrite
  target.calls += 1
}

export function mergeCounts(target: TokenCounts, src: TokenCounts): void {
  target.input += src.input
  target.output += src.output
  target.cacheRead += src.cacheRead
  target.cacheWrite += src.cacheWrite
  target.reasoning += src.reasoning
  target.total += src.total
  target.calls += src.calls
}

/** 一条计费记录（一个 assistant/message 事件）。 */
export interface UsageRecord {
  /**
   * 来源（`dsh` / `codex`）。**必填**：缺省成 `dsh` 会让 Codex 的用量
   * 悄悄混进 DSH 的口径里，而那是「按来源拆分」永远无法还原的合并。
   */
  source: SessionSource
  /** 幂等键：DSH 是 `sessionId:seq`；Codex 是 `codex:sessionId:ordinal`。 */
  eventId: string
  sessionId: string
  seq: number
  /** epoch ms */
  time: number
  provider: string
  model: string
  /** session 记录中的项目工作目录。 */
  cwd: string | null
  turn: number | null
  step: number | null
  usage: TokenCounts
}

/** 会话级元信息。 */
export interface SessionMeta {
  /** 来源；**在列举阶段就要定下来** —— 它决定用哪种解码与解析。 */
  source: SessionSource
  sessionId: string
  cwd: string | null
  createdAt: number | null
  /** 该会话归属的项目目录名（DSH 是 sessions/<project>/<id>/ 的 <project>；Codex 用日期目录）。 */
  projectDir: string
  filePath: string
}

/** 扫描过程中的统计与异常信息。 */
export interface ScanDiagnostics {
  filesScanned: number
  filesFailed: number
  framesOk: number
  framesFailed: number
  totalEvents: number
  usageEvents: number
  /** 触发恒等式校验失败的事件数（正常应为 0）。 */
  totalTokenMismatches: number
  /** 缺少 usage 的 assistant/message 条数。 */
  assistantMessagesWithoutUsage: number
  /** 重试相关事件计数。 */
  retryStarted: number
  retry: number
  attempts: number
  /** 事件类型分布。 */
  eventTypes: Map<string, number>
  /** 未识别到 provider 的事件数。 */
  missingProvider: number
  /** 出现过的 provider 列表（用于发现口径边界）。 */
  providersSeen: Set<string>
  /**
   * ── Codex 侧专有计数 ──────────────────────────────────────────────
   *
   * 这一组是「**宁可报告不一致，也不假装一致**」的落点：Codex 的日志里
   * 存在几种已知会失真/跳过的形态，它们全部要**能被看见**，否则
   * 「少了一部分用量」与「本来就只有这么多」在输出上完全一样。
   */
  /** 采到的 Codex 文件数。 */
  codexFiles: number
  /** 采用 `token_usage_record` 代际的 Codex 文件数（其余走 `token_count`）。 */
  codexGenerationB: number
  /** 🚨 映射后四列之和 ≠ 上游上报的 `total_tokens` 的条数；**正常恒为 0**，非 0 说明上游语义变了。 */
  codexIdentityViolations: number
  /** 🚨 `cached + cache_write > input` 的条数；非 0 说明「cache_write 含在 input 内」这条前提被推翻。 */
  codexOverlapAnomalies: number
  /** `payload.info == null`（旧版会写空 info）而跳过的条数。 */
  codexNullInfo: number
  /** 零用量事件（input/output/cache 全 0）而跳过的条数。 */
  codexZeroUsage: number
  /**
   * 累计快照与逐条求和对不齐的 Codex 文件数（本机实测 20/1462 ≈ 1.4%）。
   * **允许非 0**，但它必须被显示出来 —— 它是「上游有没有漏发 token_count」的唯一信号。
   */
  codexCounterDriftFiles: number
  /**
   * 因「另一代际先出现」而被跳过的计费事件数（同文件里两代遥测并存时的取舍）。
   *
   * 实测同一批调用会被 `token_count` 与 `token_usage_record` 各写一份，
   * 因此**先出现的代际说了算**，另一种只计数不采 —— 宁可少算一代，也不双计。
   * 正常非 0（本机实测 5,161 条），它回答的是「这个文件里有多少事件是重复表述」。
   */
  codexOtherGenerationSkipped: number
  /** 信封里的 `session_id` 与文件名里的 uuid 不一致的条数（文件名是权威，不一致要能被看见）。 */
  codexMetaMismatch: number
  /** fork 重放（时间早于会话首行）而被跳过的计费事件数；宁可少算重放，不可重复计费。 */
  codexReplayedEvents: number
  /**
   * ── Claude Code 侧专有计数 ────────────────────────────────────────
   *
   * 与 Codex 那一组同一个理由：这一源的失真形态（**同一次调用被写成多行**）
   * 必须能被看见，否则「少了一半用量」与「本来就只有这么多」在输出上完全一样。
   */
  /** 采到的 Claude Code 文件数。 */
  claudeFiles: number
  /**
   * 🚨 因 `message.id` 已出现过而被跳过的重复行数。
   *
   * **正常必然非 0**：本机 9 个文件实测 563 条（1,114 条计费行只对应 551 次调用）。
   * 朴素逐行相加正好翻倍，所以这个数字是「去重到底有没有生效」的唯一信号。
   */
  claudeDuplicateWrites: number
  /** 没有 usage 的 assistant 行数（含 `<synthetic>` 之外的畸形行）。 */
  claudeAssistantWithoutUsage: number
  /** `<synthetic>` 行数：Claude Code 自造的消息，不是 API 调用，不采。 */
  claudeSyntheticRows: number
  /** 四类全 0 而跳过的行数（没有用量，不替上游入库）。 */
  claudeZeroUsage: number
  /** 🚨 四列之和 ≠ 上游自报 `total_tokens` 的行数；**正常恒为 0**（该字段当前不存在，故不校验）。 */
  claudeIdentityViolations: number
  /** 缺模型名的计费行数（正常为 0；非 0 说明行的形态变了）。 */
  claudeMissingModel: number
  /**
   * ── Trae 侧专有计数（`trae` 与 `trae-cn` 两个发行版**共用**这一组）─────────
   *
   * 同理：这一源的失真形态（标记在但结构变了、缓存语义翻转、模型名缺失）
   * 必须能被看见，否则「一条都没采到」与「这台机器没用过 Trae」在输出上一样。
   */
  /** 采到的 Trae 计费日志文件数（`logs/<时间戳>/Modular/ai-agent*_stdout.log`）。 */
  traeFiles: number
  /**
   * 认出 `TokenUsageEvent` 标记、且**可用**（必需字段齐全 + 时间戳可解析）的行数。
   *
   * ★ 它与 `traeFiles` 是**成对**的：「文件 > 0 而它 = 0」正是「日志文件名或结构变了」
   *   的唯一信号 —— 那种情况下总量会静默变成 0。
   */
  traeUsageLines: number
  /** 认出标记但不可用（缺必需字段，或时间戳解析不出）的行数；正常恒为 0。 */
  traeMalformedLines: number
  /** 整行指纹重复而被跳过的行数（本机实测 0；非 0 说明上游开始重复写同一行）。 */
  traeDuplicateEvents: number
  /** 🚨 四列之和 ≠ 上游自报的 `total_tokens` 的条数；**正常恒为 0**，非 0 说明上游语义变了。 */
  traeIdentityViolations: number
  /** 🚨 `cache_read + cache_creation > prompt_tokens` 的条数；非 0 说明「缓存含在输入内」被推翻。 */
  traeOverlapAnomalies: number
  /** 零用量事件（四列全 0）而跳过的条数。 */
  traeZeroUsage: number
  /**
   * 事件自带 `name` 为空的条数 ⇒ 模型名落成 `(unknown)`、这一源配不上单价。
   *
   * **实测正常 = 全部**（3.2.2 / 3.3.0 的 211 条事件 `name` 恒为空串）：
   * 它是「模型名到底有没有」的**唯一**信号 —— 哪天它变成 0，说明上游开始写模型名了。
   */
  traeUnnamedEvents: number
  /**
   * ── WorkBuddy 侧专有计数 ──────────────────────────────────────────
   *
   * 同理：这一源的失真形态（**两代格式并存**、老代际没有缓存字段、
   * 迁移过来的老会话时间戳为 0）必须能被看见，否则「少了一部分用量」
   * 与「本来就只有这么多」在输出上完全一样。
   */
  /** 采到的 WorkBuddy 会话文件数（`projects/<cwd 压缩名>/<sessionId>.jsonl`）。 */
  workbuddyFiles: number
  /**
   * 采到的**嵌套**（子代理 / 团队）会话文件数。
   *
   * 形态是 `<cwd 压缩名>/<sessionId>/subagents/<taskId>.jsonl`（WorkBuddy 自己的
   * 布局），本机实测 0 —— 它非 0 表示这台机器用过子代理，用量来自子会话自己的文件。
   */
  workbuddyNestedSessionFiles: number
  /**
   * 认出「带用量」的行数（可用 + 不可用）。
   *
   * ★ 它与 `workbuddyFiles` 是**成对**的：「文件 > 0 而它 = 0」正是「文件形态变了」
   *   的唯一信号 —— 那种情况下总量会静默变成 0。
   */
  workbuddyUsageLines: number
  /** 带用量但数字全缺（解析不出单次调用）的条数；正常恒为 0。 */
  workbuddyMalformedUsage: number
  /**
   * 🚨 同一个响应键（`messageId` / 行 `id`）出现第二次而跳过的条数。
   *
   * **实测本机为 0**（一条模型响应只写一次用量），它是「去重到底有没有生效」的唯一信号：
   * 哪天上游开始重复写同一笔，这个数字会跳出来，而不是总量悄悄翻倍。
   */
  workbuddyDuplicateResponses: number
  /**
   * 🚨 用量在但 `timestamp` 缺失 / 为 0 而跳过的条数。
   *
   * 实测迁移过来的老会话整文件 `timestamp: 0`（本机 `1a02ca59…` 16/16 行），
   * 只有末尾的 `custom-title` 用 `createdAt`。**不退化成 1970**：那会把整段用量
   * 塞进时间窗之外（表现为「这段时间没有用量」）或污染「全部时间」，两种都不报错。
   */
  workbuddyInvalidTimestamps: number
  /** 四类全 0 而跳过的条数（没有用量，不替上游入库）。 */
  workbuddyZeroUsage: number
  /** 🚨 四列之和 ≠ 上游自报 `total_tokens` 的条数；**正常恒为 0**，非 0 说明上游语义变了。 */
  workbuddyIdentityViolations: number
  /** 🚨 `cacheRead + cacheWrite > prompt_tokens` 的条数；非 0 说明「缓存含在输入内」被推翻。 */
  workbuddyOverlapAnomalies: number
  /**
   * 🚨 上游给了 `prompt_cache_miss_tokens` 却与「prompt − 缓存」对不上的条数。
   *
   * **正常恒为 0**：它比恒等式更早发现「缓存不再含在输入内」（本机实测 4/4 相符）。
   */
  workbuddyMissMismatch: number
  /**
   * ⚠️ **没有缓存字段**的用量条数（老代际格式）。
   *
   * 实测本机 6/10 条属这一类：老代际的 `usage` 只有 `input_tokens` / `output_tokens` /
   * `total_tokens`，于是 `cacheRead` 只能记 0、`input` 只能记整段上下文 ——
   * **这一源的缓存命中率因此被系统性低估**。非 0 时必须能在诊断里看到，否则
   * 「命中率低」会被读成「这个客户端真的不怎么用缓存」。
   */
  workbuddyUsageWithoutCache: number
  /** 缺模型名的计费记录条数 ⇒ 模型落成 `(unknown)`。**实测为 0**（`auto` 是上游的真实取值）。 */
  workbuddyMissingModel: number
  /** 信封 `sessionId` ≠ 文件名（顶层会话文件）的条数；文件名是权威，不一致要能被看见。 */
  workbuddyMetaMismatch: number
}

export function emptyDiagnostics(): ScanDiagnostics {
  return {
    filesScanned: 0,
    filesFailed: 0,
    framesOk: 0,
    framesFailed: 0,
    totalEvents: 0,
    usageEvents: 0,
    totalTokenMismatches: 0,
    assistantMessagesWithoutUsage: 0,
    retryStarted: 0,
    retry: 0,
    attempts: 0,
    eventTypes: new Map(),
    missingProvider: 0,
    providersSeen: new Set(),
    codexFiles: 0,
    codexGenerationB: 0,
    codexIdentityViolations: 0,
    codexOverlapAnomalies: 0,
    codexNullInfo: 0,
    codexZeroUsage: 0,
    codexCounterDriftFiles: 0,
    codexOtherGenerationSkipped: 0,
    codexMetaMismatch: 0,
    codexReplayedEvents: 0,
    claudeFiles: 0,
    claudeDuplicateWrites: 0,
    claudeAssistantWithoutUsage: 0,
    claudeSyntheticRows: 0,
    claudeZeroUsage: 0,
    claudeIdentityViolations: 0,
    claudeMissingModel: 0,
    traeFiles: 0,
    traeUsageLines: 0,
    traeMalformedLines: 0,
    traeDuplicateEvents: 0,
    traeIdentityViolations: 0,
    traeOverlapAnomalies: 0,
    traeZeroUsage: 0,
    traeUnnamedEvents: 0,
    workbuddyFiles: 0,
    workbuddyNestedSessionFiles: 0,
    workbuddyUsageLines: 0,
    workbuddyMalformedUsage: 0,
    workbuddyDuplicateResponses: 0,
    workbuddyInvalidTimestamps: 0,
    workbuddyZeroUsage: 0,
    workbuddyIdentityViolations: 0,
    workbuddyOverlapAnomalies: 0,
    workbuddyMissMismatch: 0,
    workbuddyUsageWithoutCache: 0,
    workbuddyMissingModel: 0,
    workbuddyMetaMismatch: 0,
  }
}

/** 派生指标。 */
export interface DerivedMetrics {
  /** 缓存命中率 = cacheRead / (cacheRead + input)。 */
  cacheHitRate: number
  /** 缓存读取占计费总量的比例。 */
  cacheShareOfTotal: number
  /** 平均每次调用的计费 token。 */
  avgTokensPerCall: number
  /** 平均每次调用的输出 token。 */
  avgOutputPerCall: number
  /** 缓存节省倍率：若 cacheRead 按 input 价计费会是多少倍。 */
  cacheLeverage: number
}

export function derive(counts: TokenCounts): DerivedMetrics {
  const denom = counts.cacheRead + counts.input
  return {
    cacheHitRate: denom > 0 ? counts.cacheRead / denom : 0,
    cacheShareOfTotal: counts.total > 0 ? counts.cacheRead / counts.total : 0,
    avgTokensPerCall: counts.calls > 0 ? counts.total / counts.calls : 0,
    avgOutputPerCall: counts.calls > 0 ? counts.output / counts.calls : 0,
    cacheLeverage: counts.input > 0 ? (counts.cacheRead + counts.input) / counts.input : 0,
  }
}