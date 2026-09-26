/**
 * 会话日志扫描器：遍历 `$DSH_HOME/sessions/<project>/<sessionId>/session*.jsonl.zstd`，
 * 解码并把 `assistant/message` 事件折叠为计费记录。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeFramedZstd, decodeFramedZstdFrom, parseJsonl } from './decode.js'
import {
  addCounts,
  emptyCounts,
  emptyDiagnostics,
  type ScanDiagnostics,
  type SessionMeta,
  type UsageRecord,
} from './types.js'

/** 一个会话文件的扫描结果。 */
export interface SessionScanResult {
  meta: SessionMeta
  records: UsageRecord[]
}

export interface ScanOptions {
  /** 只扫描这些 provider（大小写不敏感）。空数组 = 全部。 */
  providers?: string[]
  /** 只扫描这些 model（大小写不敏感，支持子串匹配）。空数组 = 全部。 */
  models?: string[]
  /** 起始时间（含），epoch ms。 */
  sinceMs?: number
  /** 结束时间（含），epoch ms。 */
  untilMs?: number
  /** 进度回调。 */
  onProgress?: (done: number, total: number, file: string) => void
}

/** 列出 sessions 根目录下所有会话日志文件。 */
export async function listSessionFiles(sessionsRoot: string): Promise<SessionMeta[]> {
  const out: SessionMeta[] = []

  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return out
  }

  for (const projectDir of projects) {
    const projPath = join(sessionsRoot, projectDir)
    try {
      if (!(await stat(projPath)).isDirectory()) continue
    } catch {
      continue
    }

    let sessionIds: string[]
    try {
      sessionIds = await readdir(projPath)
    } catch {
      continue
    }

    for (const sessionId of sessionIds) {
      const sessPath = join(projPath, sessionId)
      try {
        if (!(await stat(sessPath)).isDirectory()) continue
      } catch {
        continue
      }

      // 日志文件名带格式版本（session.v3.jsonl.zstd），做前缀匹配以兼容升级
      let entries: string[]
      try {
        entries = await readdir(sessPath)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.startsWith('session') || !entry.endsWith('.jsonl.zstd')) continue
        out.push({
          sessionId,
          cwd: null,
          createdAt: null,
          projectDir,
          filePath: join(sessPath, entry),
        })
      }
    }
  }

  return out
}

function matchAny(value: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true
  const lower = value.toLowerCase()
  return patterns.some((p) => lower.includes(p.toLowerCase()))
}

/** 从事件对象里安全取嵌套字段。 */
function pick(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * 扫描单个会话文件。
 *
 * 只有 `assistant/message` 且带 `data.usage` 的事件才产生计费记录——
 * 这是唯一由 provider 真实上报的计费级数据。
 */
export async function scanSessionFile(
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
): Promise<SessionScanResult> {
  const records: UsageRecord[] = []
  let buf: Buffer
  try {
    buf = await readFile(meta.filePath)
  } catch {
    diagnostics.filesFailed++
    return { meta, records }
  }

  diagnostics.filesScanned++

  let text: string
  try {
    const decoded = await decodeFramedZstd(buf)
    text = decoded.text
    diagnostics.framesOk += decoded.framesOk
    diagnostics.framesFailed += decoded.framesFailed
  } catch {
    diagnostics.filesFailed++
    return { meta, records }
  }

  const state: ParseState = { cwd: null }
  collectEvents(text, meta, state, diagnostics, records)

  meta.cwd = state.cwd
  return { meta, records }
}

/** 跨事件行累积的解析状态（`cwd` 来自 `session` 首行，供后续事件继承）。 */
interface ParseState {
  cwd: string | null
}

/**
 * 把一段已解码的 JSONL 文本解析成计费记录。
 *
 * 抽成独立函数是为了让**全量扫描与增量扫描走完全相同的解析逻辑**——
 * 两套实现会随时间漂移，导致「增量结果 ≠ 全量结果」这种最难查的口径 bug。
 *
 * @param text - 已解压的 JSONL 文本（增量调用时只有新增帧的内容）。
 * @param meta - 会话元信息；`cwd` 由 `session` 首行填充。
 * @param state - 跨行累积状态。增量调用时必须传入上一轮的 `cwd`，
 *   否则增量块里若没有 `session` 行，记录会丢掉项目归属。
 * @param diagnostics - 累计诊断计数。
 * @param records - 输出数组，就地追加。
 */
function collectEvents(
  text: string,
  meta: SessionMeta,
  state: ParseState,
  diagnostics: ScanDiagnostics,
  records: UsageRecord[],
): void {
  for (const ev of parseJsonl(text)) {
    diagnostics.totalEvents++
    const type = asString(ev['type']) ?? '(no-type)'
    diagnostics.eventTypes.set(type, (diagnostics.eventTypes.get(type) ?? 0) + 1)

    // `session` 首行携带 cwd / createdAt
    if (type === 'session') {
      const data = ev['data']
      state.cwd = asString(pick(data, 'cwd')) ?? asString(ev['cwd']) ?? state.cwd
      const created = asNumber(pick(data, 'createdAt')) ?? asNumber(ev['time'])
      if (created !== null) meta.createdAt = created
      continue
    }

    if (type === 'llm/retry-started') {
      diagnostics.retryStarted++
      continue
    }
    if (type === 'llm/retry') {
      diagnostics.retry++
      continue
    }
    if (type === 'assistant/attempt') {
      diagnostics.attempts++
      continue
    }

    if (type !== 'assistant/message') continue

    const usage = pick(ev, 'data', 'usage') as Record<string, unknown> | undefined
    if (!usage) {
      diagnostics.assistantMessagesWithoutUsage++
      continue
    }

    const provider = asString(pick(ev, 'data', 'message', 'source', 'provider'))
    const model = asString(pick(ev, 'data', 'message', 'source', 'model')) ?? '(unknown)'

    if (provider) {
      diagnostics.providersSeen.add(provider)
    } else {
      diagnostics.missingProvider++
    }
    const providerName = provider ?? '(none)'

    const time = asNumber(ev['time']) ?? 0
    const seq = asNumber(ev['seq']) ?? 0

    // 恒等式校验：totalTokens 应等于四类之和
    const rawTotal = asNumber(usage['totalTokens'])
    const sum =
      (asNumber(usage['inputTokens']) ?? 0) +
      (asNumber(usage['outputTokens']) ?? 0) +
      (asNumber(usage['cacheReadTokens']) ?? 0) +
      (asNumber(usage['cacheWriteTokens']) ?? 0)
    if (rawTotal !== null && rawTotal !== sum) {
      diagnostics.totalTokenMismatches++
    }

    diagnostics.usageEvents++

    const counts = emptyCounts()
    addCounts(counts, {
      inputTokens: asNumber(usage['inputTokens']) ?? undefined,
      outputTokens: asNumber(usage['outputTokens']) ?? undefined,
      cacheReadTokens: asNumber(usage['cacheReadTokens']) ?? undefined,
      cacheWriteTokens: asNumber(usage['cacheWriteTokens']) ?? undefined,
      reasoningTokens: asNumber(usage['reasoningTokens']) ?? undefined,
    })

    records.push({
      eventId: `${meta.sessionId}:${seq}`,
      sessionId: meta.sessionId,
      seq,
      time,
      provider: providerName,
      model,
      cwd: state.cwd,
      turn: asNumber(pick(ev, 'data', 'turn')),
      step: asNumber(pick(ev, 'data', 'step')),
      usage: counts,
    })
  }
}

/** 扫描整个 sessions 目录，返回全部计费记录。 */
export async function scanAll(
  sessionsRoot: string,
  options: ScanOptions = {},
): Promise<{ records: UsageRecord[]; sessions: SessionMeta[]; diagnostics: ScanDiagnostics }> {
  const diagnostics = emptyDiagnostics()
  const files = await listSessionFiles(sessionsRoot)
  const sessions: SessionMeta[] = []
  const records: UsageRecord[] = []
  const seenEvents = new Set<string>()

  let done = 0
  for (const meta of files) {
    const result = await scanSessionFile(meta, diagnostics)
    sessions.push(result.meta)

    for (const rec of result.records) {
      // 与 SQLite 的 event_id 主键一致：重放帧/日志副本只认首次出现。
      // 必须先去重再筛选，否则后来的重复事件会在筛选时冒充首次记录。
      if (seenEvents.has(rec.eventId)) continue
      seenEvents.add(rec.eventId)
      if (!matchAny(rec.provider, options.providers)) continue
      if (!matchAny(rec.model, options.models)) continue
      if (options.sinceMs !== undefined && rec.time < options.sinceMs) continue
      if (options.untilMs !== undefined && rec.time > options.untilMs) continue
      records.push(rec)
    }

    done++
    options.onProgress?.(done, files.length, meta.filePath)
  }

  return { records, sessions, diagnostics }
}

// ── 增量扫描 ────────────────────────────────────────────────────────────────

/** 单个文件在本轮增量扫描中的处理结果，用于推进水位线。 */
export interface IncrementalFileResult {
  filePath: string
  sessionId: string
  /** 本轮结束时的字节数，写回水位线。 */
  size: number
  /** 本轮结束时的帧总数，写回水位线。 */
  frameCount: number
  /** 本轮结束时的 mtime，仅诊断用。 */
  mtimeMs: number
  /** 本轮新增的记录数（去重后）。 */
  produced: number
}

export interface IncrementalScanResult {
  records: UsageRecord[]
  files: IncrementalFileResult[]
  diagnostics: ScanDiagnostics
  /** L1 跳过的文件数（字节数未变，零解压）。 */
  skippedUnchanged: number
  /** 被 L3 事件级水位线过滤掉的记录数（正常应为 0，非 0 说明帧边界有偏差）。 */
  filteredBySeq: number
}

/** 上一轮的水位线查表接口——避免 scanner 直接依赖 state 模块。 */
export interface WatermarkLookup {
  /** 该文件上一轮的字节数；`undefined` 表示首次见到。 */
  sizeOf(filePath: string): number | undefined
  /** 该文件上一轮已处理的帧数。 */
  frameCountOf(filePath: string): number | undefined
  /** 该 session 上一轮已处理的最大 seq；`undefined` 表示首次见到。 */
  lastSeqOf(sessionId: string): number | undefined
  /** 上一轮该 session 解析出的 cwd（增量块缺 `session` 行时继承）。 */
  cwdOf?(sessionId: string): string | null | undefined
}

export interface IncrementalScanOptions {
  watermarks: WatermarkLookup
  onProgress?: (done: number, total: number, file: string) => void
}

/**
 * 增量扫描：只处理自上次以来新增的内容。
 *
 * 三层过滤（见 `state.ts` 的模块注释）：
 *
 * 1. **L1 文件大小**：`size === watermark.size` ⇒ 整个文件跳过（一次 stat，零解压）。
 *    依据是日志 append-only，字节数不变则内容不变。
 * 2. **L2 帧边界**：只解压 `frameCount` 之后的帧。
 * 3. **L3 事件 seq**：`seq > lastSeqBySession[sessionId]` 兜底。
 *
 * **文件被截断/重建**（size 变小）时回退到全量读该文件，而不是信任旧水位线——
 * 会话文件理论上不被重写，但把「水位线失效」处理成「重扫该文件」比
 * 「静默跳过」安全得多，代价只是一个文件的重复解析。
 */
export async function scanIncremental(
  sessionsRoot: string,
  options: IncrementalScanOptions,
): Promise<IncrementalScanResult> {
  const diagnostics = emptyDiagnostics()
  const files = await listSessionFiles(sessionsRoot)
  const records: UsageRecord[] = []
  const fileResults: IncrementalFileResult[] = []
  let skippedUnchanged = 0
  let filteredBySeq = 0
  let done = 0

  // 每个 sessionId 的 cwd 缓存：增量块大多不含 `session` 首行，
  // 必须从上一轮或同轮更早的文件继承，否则项目归属会丢。
  const cwdBySession = new Map<string, string | null>()

  for (const meta of files) {
    let size: number
    let mtimeMs: number
    try {
      const st = await stat(meta.filePath)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      diagnostics.filesFailed++
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    const prevSize = options.watermarks.sizeOf(meta.filePath)
    const prevFrames = options.watermarks.frameCountOf(meta.filePath) ?? 0

    // L1：字节数未变 ⇒ 内容未变 ⇒ 零解压跳过
    if (prevSize !== undefined && prevSize === size) {
      skippedUnchanged++
      fileResults.push({
        filePath: meta.filePath,
        sessionId: meta.sessionId,
        size,
        // 水位线不回退也不前进：帧数保持原值
        frameCount: prevFrames,
        mtimeMs,
        produced: 0,
      })
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    let buf: Buffer
    try {
      buf = await readFile(meta.filePath)
    } catch {
      diagnostics.filesFailed++
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    diagnostics.filesScanned++

    // 文件被截断/重建 ⇒ 旧帧水位线失效，从头读
    const truncated = prevSize !== undefined && size < prevSize
    const fromFrame = truncated ? 0 : prevFrames

    const decoded = decodeFramedZstdFrom(buf, fromFrame)
    diagnostics.framesOk += decoded.framesOk
    diagnostics.framesFailed += decoded.framesFailed

    const parseState: ParseState = {
      cwd:
        cwdBySession.get(meta.sessionId) ??
        options.watermarks.cwdOf?.(meta.sessionId) ??
        null,
    }

    const before = records.length
    collectEvents(decoded.text, meta, parseState, diagnostics, records)
    cwdBySession.set(meta.sessionId, parseState.cwd)
    meta.cwd = parseState.cwd

    // L3：事件级兜底过滤
    let kept = 0
    const lastSeq = options.watermarks.lastSeqOf(meta.sessionId)
    if (records.length > before) {
      const fresh: UsageRecord[] = []
      for (let i = before; i < records.length; i++) {
        const rec = records[i]!
        if (lastSeq !== undefined && rec.seq <= lastSeq) {
          filteredBySeq++
          continue
        }
        fresh.push(rec)
      }
      records.length = before
      records.push(...fresh)
      kept = fresh.length
    }

    fileResults.push({
      filePath: meta.filePath,
      sessionId: meta.sessionId,
      size,
      frameCount: decoded.frameCount,
      mtimeMs,
      produced: kept,
    })

    done++
    options.onProgress?.(done, files.length, meta.filePath)
  }

  return { records, files: fileResults, diagnostics, skippedUnchanged, filteredBySeq }
}