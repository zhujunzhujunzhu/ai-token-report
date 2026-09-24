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
  /** 幂等键：`sessionId:seq`。 */
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
  sessionId: string
  cwd: string | null
  createdAt: number | null
  /** 该会话归属的项目目录名（sessions/<project>/<id>/ 的 <project>）。 */
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