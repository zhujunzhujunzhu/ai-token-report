/**
 * 折叠：把 DSH 交给 telemetry 后端的一条条原始事件，折叠成**计费记录**。
 *
 * ## 为什么需要这一层
 *
 * `SessionTelemetryCoordinator` 是「一条会话事件 = 一条记录」的**镜像**，
 * 它不挑不拣 —— `user/message`、`tool/call`、`step/start` 全都会交过来。
 * 而计费只认一种事件：带 `data.usage` 的 `assistant/message`
 * （provider 真实上报值，见 `dsh-session-log-parsing` skill）。
 *
 * 所以插件必须自己完成「抬头 → 取数 → 缩到计费字段」这三步。
 *
 * ## 为什么抽成不依赖任何运行时的纯函数
 *
 * 这一段是整个插件**唯一会算错数**的地方：字段取错一个，服务端就少一块用量，
 * 而且不会报错、只会让看板数字偏低。把它写成纯函数（无 IO、无 cordis、无 Time），
 * 才能用 `bun test` 一行行钉死，而不是靠「装进 DSH 里看看对不对」。
 *
 * ## 与 `core/scanner.ts` 的关系（刻意的不复用）
 *
 * 扫描器读的是**磁盘上的会话日志**（zstd 分帧 → JSONL → 事件），
 * 而这里拿到的已经是 DSH 深拷贝好的 JS 对象。两者共用的是**字段口径**
 * （`data.usage.*` 的五个字段、`data.turn/step`、`session.cwd`），
 * 而不是代码路径 —— 强行复用会让插件被迫依赖 `node:fs` 与日志布局。
 * 口径本身由 `packages/shared/test` 与 `token-metrics-contract` skill 保证同源。
 */

import { computeTotal, type TokenUsage } from '@ai-token-report/shared'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

/**
 * 插件的身份参数 —— 折叠时需要它来填 `client` 字段。
 *
 * 只依赖这三个标量而不是整个 Config，是为了让本模块保持零依赖。
 */
export interface FoldIdentity {
  /** 插件实例名（全局配置 `name`），进 `client.name` 便于服务端区分来源。 */
  clientName: string
  /** 上报方自称的标识。**服务端一律忽略它**，只认 Authorization 头里的 token。 */
  claimedUserId: string
  userName?: string
  dept?: string
}

/** 折叠后的计费记录（TS 内存侧，camelCase）。 */
export interface BillingRecord {
  /** 幂等键 `${sessionId}:${seq}`。服务端以此为 PRIMARY KEY。 */
  eventId: string
  sessionId: string
  seq: number
  /** epoch 毫秒 */
  time: number
  provider: string
  model: string
  cwd: string | null
  turn: number | null
  step: number | null
  /**
   * ★ 四个 token 类目**始终分开**。
   *
   * 铁律 3：采集端一旦合并，后续任何拆分都无法还原。
   * `cacheRead` 实测占总用量 94.3%，漏掉它等于漏掉 94% 的用量。
   */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** 恒等式重算值 `input + output + cacheRead + cacheWrite`，不直接信任上报的 total。 */
  totalTokens: number
  /** provider 上报的 total 与恒等式不符时为 true（正常恒为 false）。 */
  identityViolation: boolean
  /** 上报方身份（服务端以 token 为准，这里是排查用的自称）。 */
  identity: FoldIdentity
}

/** 从任意值里安全取一个有限数；取不到返回 0。 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 取嵌套字段，任何一层不是对象就返回 undefined。 */
function pick(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 取非空字符串（去首尾空白），否则 null。 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 取可选数字：缺失或非有限数返回 null（**不是 0** —— 0 是合法值，会污染统计）。 */
function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 一条 telemetry 记录 → 一条计费记录；不是计费事件则返回 null。
 *
 * ## 过滤条件（缺一不可）
 *
 * 1. `channel === 'ledger'` —— `ops` 通道是 `agent-error` / `shutdown` 这类
 *    运维信号，**故意不带 `event.seq`**，把它们当账本行会让幂等键collapse。
 * 2. `event.type === 'assistant/message'` —— 唯一带计费级 usage 的事件。
 * 3. 存在**非空** `data.usage` —— 适配器没上报 accounting 时该字段缺席，
 *    此时**不能**补 0 上账（那会凭空多出一条 0 token 的记录，把 calls 抬高）。
 * 4. `event.seq` 是有限数 —— 幂等键的一半，取不到就没法安全重发。
 *
 * @param record - coordinator 交过来的记录（已经是深拷贝，不会被复用）。
 * @param identity - 当前身份参数。
 * @returns 计费记录；不是计费事件时返回 null。
 */
export function foldRecord(
  record: SessionTelemetryRecord,
  identity: FoldIdentity,
): BillingRecord | null {
  if (record.channel !== 'ledger') return null
  if (record.attributes['event.type'] !== 'assistant/message') return null

  const sessionId = str(record.attributes['session.id'])
  if (!sessionId) return null

  const seq = optNum(record.attributes['event.seq'])
  if (seq === null) return null

  const body = record.body
  const usage = pick(body, 'usage')
  if (usage === null || typeof usage !== 'object') return null

  // ★ 缺席的 usage 字段按 0 计，但**整条 usage 对象缺席时整条事件不计费**
  //   —— 适配器没上报 accounting 时补 0 会凭空多出一条 0 token 的记录，
  //   把「调用次数」抬高而总量不变，看板上的均值会莫名其妙变小。
  if (Object.keys(usage as Record<string, unknown>).length === 0) return null

  // ★ 恒等式重算，而不是直接信任 usage.totalTokens：
  //   该 provider 的 totalTokens 实测可能缺席，而缺席时按 0 处理会让「计费总量」
  //   整列变成 0 却毫无报错。重算的代价只是加三个数。
  const input = num(pick(usage, 'inputTokens'))
  const output = num(pick(usage, 'outputTokens'))
  const cacheRead = num(pick(usage, 'cacheReadTokens'))
  const cacheWrite = num(pick(usage, 'cacheWriteTokens'))
  const reasoning = num(pick(usage, 'reasoningTokens'))
  const computed = computeTotal({ input, output, cacheRead, cacheWrite, reasoning })

  const rawTotal = optNum(pick(usage, 'totalTokens'))

  return {
    eventId: `${sessionId}:${seq}`,
    sessionId,
    seq,
    // 事件的 time 由 coordinator 填好（ledger 记录 = 源事件的 append 时间）
    time: num(record.time),
    provider: str(pick(body, 'message', 'source', 'provider')) ?? '(none)',
    model: str(pick(body, 'message', 'source', 'model')) ?? '(unknown)',
    // 会话级事实由 coordinator 放进 attributes（`session.cwd`），不在 body 里
    cwd: str(record.attributes['session.cwd']),
    turn: optNum(pick(body, 'turn')),
    step: optNum(pick(body, 'step')),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    totalTokens: computed,
    identityViolation: rawTotal !== null && rawTotal !== computed,
    identity,
  }
}

/**
 * 折叠成线上下划线格式。
 *
 * 🚨 **字段名与顺序由服务端契约固化**（`ARCHITECTURE.md` §5.2 与
 *   `packages/shared/src/protocol.ts` 的 `WireTokenRecord`）。
 *   改名会让服务端**静默丢数据** —— 它不会报错，只会让某个数字变成 0。
 *
 * `reasoning_tokens` 是插件比 CLI 多带的一个字段：它不在恒等式内
 * （是 output 的子集），但留着便于后续排查「reasoning 是否被重复计费」。
 */
export function toWireRecord(rec: BillingRecord): Record<string, unknown> {
  return {
    event_id: rec.eventId,
    session_id: rec.sessionId,
    seq: rec.seq,
    ts: rec.time,
    provider: rec.provider,
    model: rec.model,
    input_tokens: rec.inputTokens,
    output_tokens: rec.outputTokens,
    cache_read_tokens: rec.cacheReadTokens,
    cache_write_tokens: rec.cacheWriteTokens,
    reasoning_tokens: rec.reasoningTokens,
    total_tokens: rec.totalTokens,
    cwd: rec.cwd,
    turn: rec.turn,
    step: rec.step,
  }
}

/**
 * 把计费记录折成 `shared` 的 `TokenUsage`，供口径公式使用。
 *
 * ★ 存在的意义是让调用方**没有机会自己写公式** —— 要算缓存命中率就
 *   `cacheHitRate(toTokenUsage(rec))`，不要在本文件里再实现一遍除法。
 */
export function toTokenUsage(rec: BillingRecord): TokenUsage {
  return {
    input: rec.inputTokens,
    output: rec.outputTokens,
    cacheRead: rec.cacheReadTokens,
    cacheWrite: rec.cacheWriteTokens,
    reasoning: rec.reasoningTokens,
    total: rec.totalTokens,
  }
}