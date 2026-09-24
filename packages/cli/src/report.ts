/**
 * 增量上报：把「扫描本地会话日志」变成「每 N 分钟一次的增量投递」。
 *
 * ## 为什么不需要插件
 *
 * 官方 `SessionTelemetryBackend` 是**推**模型（DSH 进程内把事件交出来），
 * 而日志本身是 **append-only + 每事件带 `seq`** 的——这已经足以做增量：
 * 记一个水位线，每次只读新增部分即可。区别只是延迟（≤ 一个周期）
 * 与覆盖范围（日志在就在，反而比插件更全）。
 *
 * ## 一轮 `runReport()` 的顺序（崩溃安全的关键）
 *
 * ```
 * 1. 读状态（缺失/损坏 → 空状态，退化为全量重扫，安全）
 * 2. 增量扫描 → 新增 records
 * 3. stage：records 并入 pending + 推进【内存中】的 L3 水位线
 * 4. save 状态（含 pending）        ← 此刻数据已落盘，崩溃不丢
 * 5. 投递（dry-run 时跳过）
 *    ├─ 成功 → ack（清 pending、更新 lastFlushMs）+ save
 *    └─ 失败 → 保留 pending 与水印，返回非 0，等下一轮重试
 * ```
 *
 * 第 4 步必须先于第 5 步：如果先投递再落盘，投递成功后进程崩溃
 * 就会丢水位线 → 下一轮重发（可接受），但如果**先推水位线再投递**，
 * 投递失败时数据就永久消失了。所以顺序是「先存后发」。
 */

import type { IncrementalScanResult } from '@ai-token-report/core'
import { scanIncremental, type WatermarkLookup } from '@ai-token-report/core'
import {
  ackRecords,
  emptyState,
  loadState,
  resolveStatePath,
  saveState,
  stageRecords,
  statsOf,
  type ReportState,
  type StateStats,
} from '@ai-token-report/core'
import { emptyCounts, mergeCounts, type TokenCounts, type UsageRecord } from '@ai-token-report/core'

/** 投递器：把一批记录发到后台。抛错即视为失败，pending 保留。 */
export type Deliverer = (records: UsageRecord[]) => Promise<DeliverOutcome>

export interface DeliverOutcome {
  /** 服务端接受（含重复）的条数。 */
  accepted: number
  /** 服务端判定为重复的条数。 */
  duplicates: number
  /** 服务端拒收的条数。 */
  rejected: number
}

export interface RunReportOptions {
  sessionsRoot: string
  dshHome?: string
  /** 状态文件路径；默认 `$DSH_HOME/token-report/state.json`。 */
  statePath?: string
  /** 真实投递器。`dry-run` 时不需要提供。 */
  deliver?: Deliverer
  /** 干跑：扫描 + 落盘 pending，但不投递、不推进 lastFlushMs。 */
  dryRun?: boolean
  /** 只看不改：不写状态文件。用于纯观察当前增量。 */
  noSave?: boolean
  quiet?: boolean
  onProgress?: (done: number, total: number, file: string) => void
}

export interface RunReportResult {
  /** 本轮新生成的记录（去重后）。 */
  records: UsageRecord[]
  counts: TokenCounts
  scan: IncrementalScanResult
  /** 状态文件路径。 */
  statePath: string
  /** 扫描前的状态统计。 */
  before: StateStats
  /** 扫描后的状态统计。 */
  after: StateStats
  /** 投递结果；dry-run / noSave 时为 undefined。 */
  delivered?: DeliverOutcome
  /** 本轮结束时 pending 里仍未投递的条数（含历史遗留）。 */
  pendingRemaining: number
  /** 状态文件的加载告警（损坏 / 版本不符）。 */
  stateNote?: string
}

/** 把 {@link ReportState} 适配成 scanner 需要的水位线查表接口。 */
function lookupFor(state: ReportState): WatermarkLookup {
  return {
    sizeOf: (p) => state.files[p]?.size,
    frameCountOf: (p) => state.files[p]?.frameCount,
    lastSeqOf: (s) => state.lastSeqBySession[s],
    // 上一轮记住的 cwd：增量块通常不含 session 首行，靠这个保住项目归属
    cwdOf: (s) => state.cwdBySession[s],
  }
}

/** 计算一批记录的总量。 */
export function totalOfRecords(records: UsageRecord[]): TokenCounts {
  const total = emptyCounts()
  for (const rec of records) mergeCounts(total, rec.usage)
  return total
}

/**
 * 执行一轮增量上报。
 *
 * 纯编排：扫描 → 暂存 → 落盘 → 投递 → 确认。所有副作用都集中在
 * `state.ts` 与传入的 `deliver` 上，因此可用 `dryRun` 完整演练。
 */
export async function runReport(options: RunReportOptions): Promise<RunReportResult> {
  const statePath = options.statePath ?? resolveStatePath(options.dshHome)
  const loaded = loadState(statePath)
  const state = loaded.state
  const before = statsOf(state)

  const scan = await scanIncremental(options.sessionsRoot, {
    watermarks: lookupFor(state),
    onProgress: options.onProgress,
  })

  // 3. 暂存：pending + 内存水位线（此时尚未落盘）
  stageRecords(state, scan.records)

  // 4. 先落盘再投递 —— 崩溃安全的关键顺序
  if (!options.noSave) {
    for (const f of scan.files) {
      state.files[f.filePath] = {
        size: f.size,
        frameCount: f.frameCount,
        mtimeMs: f.mtimeMs,
        firstSeenMs: state.files[f.filePath]?.firstSeenMs ?? Date.now(),
      }
    }
    saveState(statePath, state)
  }

  const result: RunReportResult = {
    records: scan.records,
    counts: totalOfRecords(scan.records),
    scan,
    statePath,
    before,
    after: statsOf(state),
    pendingRemaining: state.pending.length,
    stateNote: loaded.note,
  }

  // 5. 投递
  if (options.dryRun || options.noSave || !options.deliver) {
    return result
  }

  // 投递 pending 的**全部**内容（含历史遗留），而不只是本轮新增：
  // 上一轮网络失败留下的记录必须在这一轮重发。
  const toSend = [...state.pending]
  if (toSend.length === 0) {
    result.delivered = { accepted: 0, duplicates: 0, rejected: 0 }
    return result
  }

  const outcome = await options.deliver(toSend)

  // 服务端拒收的记录留在 pending，不计入 ack —— 否则会静默丢数据
  const rejected = Math.max(0, outcome.rejected)
  if (rejected > 0) {
    const acceptedCount = toSend.length - rejected
    ackRecords(state, toSend.slice(0, acceptedCount), Date.now())
    // 被拒的部分保留在 pending 以便排查；不推进 lastFlushMs 的语义由 ack 决定
    state.pending = state.pending.filter((r) => toSend.slice(acceptedCount).some((x) => x.eventId === r.eventId))
  } else {
    ackRecords(state, toSend, Date.now())
  }

  saveState(statePath, state)

  result.delivered = outcome
  result.after = statsOf(state)
  result.pendingRemaining = state.pending.length
  return result
}

/** 清空状态（`--reset`），下次运行将全量重扫。 */
export function describeReset(statePath: string): string {
  return `已重置上报状态: ${statePath}\n下次运行将全量重扫（服务端按 event_id 幂等，重复投递无害）。`
}

export { emptyState }