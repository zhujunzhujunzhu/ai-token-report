/**
 * 上报水位线状态：让「扫描」变成「增量扫描」的关键。
 *
 * ## 为什么可以按文件大小跳过
 *
 * DSH 会话日志是 **zstd 分帧追加**（每帧一个独立 frame，顺序 append，从不重写）。
 * 因此「文件字节数没变」⇒「内容逐字节没变」。这个性质让热态扫描
 * 只需要一次 `stat`，不必解压 66 MB 的历史。
 *
 * ## 三层水位线
 *
 * | 层 | 依据 | 作用 |
 * |---|---|---|
 * | L1 | `size` | 整个文件跳过，不读不压 |
 * | L2 | `frameCount` | 只解压新增的帧 |
 * | L3 | `lastSeqBySession` | 事件级兜底，防帧边界判错 |
 *
 * L3 必须按 **sessionId** 存而不是按文件存：一个会话可能被拆成多个
 * `session*.jsonl.zstd` 文件（格式版本升级、分段），而 `seq` 是
 * **会话内**单调的，跨文件仍然连续。
 *
 * ## 崩溃安全：水位线不早于投递推进
 *
 * `report` 的推进顺序是 **先入 pending、再投递、投递成功才推水位线**。
 * 中途崩溃最坏结果是「重发已发过的记录」，而服务端按 `event_id`
 * 幂等去重，重复投递无害。宁可重发，不可漏发。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDshHome } from './home.js'
import type { UsageRecord } from './types.js'

/** 单个日志文件的增量水位线。 */
export interface FileWatermark {
  /** L1：上次处理时的字节数。相等 ⇒ 整个文件跳过。 */
  size: number
  /** L2：已处理过的完整 zstd 帧数（`splitFrames` 的下标上界）。 */
  frameCount: number
  /** 上次处理时的 mtime（仅用于诊断，不参与跳过判定）。 */
  mtimeMs: number
  /** 首次见到该文件的时间。 */
  firstSeenMs: number
}

/** 上报状态文件的当前版本。结构变动时递增，触发 `--reset` 重建。 */
export const STATE_VERSION = 1

export interface ReportState {
  version: number
  /** key = 会话日志文件的绝对路径。 */
  files: Record<string, FileWatermark>
  /** L3：sessionId → 已上报的最大 seq。 */
  lastSeqBySession: Record<string, number>
  /**
   * sessionId → 该会话的项目工作目录。
   *
   * 必须持久化：增量块通常**不含** `session` 首行（首行早就被处理过了），
   * 若不记住 cwd，增量记录的项目归属会全部退化成 `null`，
   * 「按项目统计」在增量路径上就废了。
   */
  cwdBySession: Record<string, string | null>
  /**
   * 已生成但尚未确认投递成功的记录。
   *
   * 这是「水位线不早于投递推进」的落点：崩溃后重放 pending，
   * 服务端靠 `event_id` 幂等吸收重复。
   */
  pending: UsageRecord[]
  /** 最近一次成功投递完成的时间（epoch ms），0 表示从未投递成功。 */
  lastFlushMs: number
  /** 累计成功投递的记录条数（诊断用）。 */
  totalDelivered: number
}

/** 统计信息，供 `--dry-run` 与诊断输出展示。 */
export interface StateStats {
  trackedFiles: number
  trackedSessions: number
  pendingRecords: number
  lastFlushMs: number
  totalDelivered: number
}

export function emptyState(): ReportState {
  return {
    version: STATE_VERSION,
    files: {},
    lastSeqBySession: {},
    cwdBySession: {},
    pending: [],
    lastFlushMs: 0,
    totalDelivered: 0,
  }
}

export function statsOf(state: ReportState): StateStats {
  return {
    trackedFiles: Object.keys(state.files).length,
    trackedSessions: Object.keys(state.lastSeqBySession).length,
    pendingRecords: state.pending.length,
    lastFlushMs: state.lastFlushMs,
    totalDelivered: state.totalDelivered,
  }
}

/**
 * 状态文件路径。默认 `$DSH_HOME/token-report/state.json`。
 *
 * 放进 DSH home 而不是系统临时目录：它是长期状态，且应当和设备上的
 * 会话日志同生命周期（用户清空 home 时一起清掉才合理）。
 */
export function resolveStatePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'token-report', 'state.json')
}

/**
 * 读取状态文件。
 *
 * 刻意**不抛错**：文件缺失、损坏、版本不符都退回空状态。
 * 代价是「全量重扫一次」，而服务端幂等，所以完全安全——
 * 这比让一个 10 分钟一次的计划任务因为一个坏文件永久失败要好得多。
 */
export function loadState(path: string): { state: ReportState; note?: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { state: emptyState() }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: emptyState(), note: `状态文件无法解析，已按空状态处理（将全量重扫）: ${path}` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: emptyState(), note: `状态文件结构异常，已按空状态处理: ${path}` }
  }

  const obj = parsed as Partial<ReportState>
  if (obj.version !== STATE_VERSION) {
    return {
      state: emptyState(),
      note: `状态文件版本 ${String(obj.version)} 与当前 ${STATE_VERSION} 不符，已按空状态处理（将全量重扫）`,
    }
  }

  // 逐字段兜底：任何一个字段坏掉都退回该字段的空值，而不是整份状态作废。
  return {
    state: {
      version: STATE_VERSION,
      files: isPlainObject(obj.files) ? (obj.files as Record<string, FileWatermark>) : {},
      lastSeqBySession: isPlainObject(obj.lastSeqBySession)
        ? (obj.lastSeqBySession as Record<string, number>)
        : {},
      cwdBySession: isPlainObject(obj.cwdBySession)
        ? (obj.cwdBySession as Record<string, string | null>)
        : {},
      pending: Array.isArray(obj.pending) ? (obj.pending as UsageRecord[]) : [],
      lastFlushMs: typeof obj.lastFlushMs === 'number' ? obj.lastFlushMs : 0,
      totalDelivered: typeof obj.totalDelivered === 'number' ? obj.totalDelivered : 0,
    },
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 原子写入状态文件：先写 `<path>.tmp` 再 `rename`。
 *
 * `rename` 在同一文件系统内是原子的，所以状态文件任何时刻要么是
 * 旧的完整内容、要么是新的完整内容，不会被读到半截 JSON。
 * 这是「崩溃不丢水位线」的前提。
 */
export function saveState(path: string, state: ReportState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    // 重命名失败时清掉临时文件，避免留下垃圾让下一次误判
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不影响主流程 */
    }
    throw err
  }
}

/** 删除状态文件（`--reset`）。不存在时静默成功。 */
export function resetState(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}.tmp`, { force: true })
}

/**
 * L3 判定：该记录是否已在更早的轮次被处理过。
 *
 * 用 `>` 而不是 `>=`：`seq` 在会话内唯一，等于水位线的那条已经处理过。
 */
export function isAlreadyHandled(state: ReportState, rec: UsageRecord): boolean {
  const last = state.lastSeqBySession[rec.sessionId]
  return last !== undefined && rec.seq <= last
}

/**
 * 把一批记录并入状态：更新 L3 水位线并追加到 pending。
 *
 * ⚠️ 调用方必须保证**同一批去重后的 L3 值只增不减**，
 * 否则会出现「水位线回退 → 重复上报」或「水位线超前 → 漏报」。
 * 这里的实现取 max，天然满足。
 */
export function stageRecords(state: ReportState, records: UsageRecord[]): void {
  for (const rec of records) {
    const prev = state.lastSeqBySession[rec.sessionId]
    if (prev === undefined || rec.seq > prev) {
      state.lastSeqBySession[rec.sessionId] = rec.seq
    }
    // 只在解析出非空 cwd 时覆盖：增量块可能没有 session 行（cwd 为 null），
    // 此时必须保留上一轮记住的值，否则项目归属会被 null 冲掉。
    if (rec.cwd) state.cwdBySession[rec.sessionId] = rec.cwd
    else if (!(rec.sessionId in state.cwdBySession)) state.cwdBySession[rec.sessionId] = null
    state.pending.push(rec)
  }
}

/**
 * 投递成功后确认：从 pending 移除这批记录并累计计数。
 *
 * 按 `eventId` 移除而不是按下标切片——重试路径可能把同一批
 * 重新投递，按下标会误删后续追加的新记录。
 */
export function ackRecords(state: ReportState, records: UsageRecord[], nowMs: number): void {
  if (records.length > 0) {
    const delivered = new Set(records.map((r) => r.eventId))
    state.pending = state.pending.filter((r) => !delivered.has(r.eventId))
    state.totalDelivered += records.length
  }
  state.lastFlushMs = nowMs
}