/**
 * 会话日志扫描器：遍历 `$DSH_HOME/sessions/<project>/<sessionId>/session*.jsonl.zstd`，
 * 解码并把 `assistant/message` 事件折叠为计费记录。
 */

import { open, readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

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

  let projects: Dirent[]
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }

  for (const project of projects) {
    const projectDir = project.name
    const projPath = join(sessionsRoot, projectDir)
    try {
      if (!project.isDirectory() && !(project.isSymbolicLink() && (await stat(projPath)).isDirectory())) continue
    } catch {
      continue
    }

    let sessionIds: Dirent[]
    try {
      sessionIds = await readdir(projPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const session of sessionIds) {
      const sessionId = session.name
      const sessPath = join(projPath, sessionId)
      try {
        if (!session.isDirectory() && !(session.isSymbolicLink() && (await stat(sessPath)).isDirectory())) continue
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

/** 文件监听器已知具体变更路径时不再遍历历史目录；目录变更由调用方触发完整扫描。 */
export function sessionFilesFromPaths(sessionsRoot: string, paths: readonly string[]): SessionMeta[] {
  const root = resolve(sessionsRoot)
  const files = new Map<string, SessionMeta>()
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`变更日志路径必须是绝对路径：${path}`)
    const filePath = resolve(path)
    const rel = relative(root, filePath)
    const parts = rel.split(/[\\/]/)
    const [projectDir, sessionId, entry] = parts
    if (isAbsolute(rel) || parts.length !== 3 || parts.some((part) => part === '..' || part === '') ||
      !entry?.startsWith('session') || !entry.endsWith('.jsonl.zstd')) {
      throw new Error(`变更日志路径不属于会话目录结构：${path}`)
    }
    files.set(filePath, { sessionId: sessionId!, projectDir: projectDir!, filePath, cwd: null, createdAt: null })
  }
  return [...files.values()]
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
  /** 未变化的文件只参与诊断，不必重新写入水位线。 */
  changed: boolean
  /** 可选性能元数据；旧版调用方缺少它时仍能按帧数续扫。 */
  cursor?: FileCursor
}

/** 帧数用于兼容旧调用方，字节光标使追加一帧的成本不再取决于历史文件长度。 */
export interface FileCursor {
  byteOffset: number
  frameCount: number
  observedSize: number
  fileIdentity: string
  /** 首帧可能只有 session 元信息，尚无计费记录时也必须保住项目归属。 */
  cwd?: string | null
}

export interface IncrementalScanResult {
  records: UsageRecord[]
  files: IncrementalFileResult[]
  diagnostics: ScanDiagnostics
  /** L1 跳过的文件数（字节数未变，零解压）。 */
  skippedUnchanged: number
  /** 被 L3 事件级水位线过滤掉的记录数（正常应为 0，非 0 说明帧边界有偏差）。 */
  filteredBySeq: number
  /** 实际读取的压缩字节数，用来区分全文件重扫与真正的尾部续读。 */
  bytesRead: number
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
  /** 已消费完整帧的字节位置。没有它的旧水位线仍可使用。 */
  cursorOf?(filePath: string): FileCursor | undefined
}

export interface IncrementalScanOptions {
  watermarks: WatermarkLookup
  onProgress?: (done: number, total: number, file: string) => void
  /** 仅扫描监听器报告的具体日志路径；undefined 完整对账，空数组不扫描。 */
  changedFiles?: string[]
}

function fileIdentity(st: Stats): string {
  // mtime 仍只作诊断；inode 与创建时刻用来识别同一路径被原子替换的情况。
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`
}

function validCursor(cursor: FileCursor | undefined, size: number | undefined, frames: number): cursor is FileCursor {
  return cursor != null && typeof cursor === 'object' && Number.isSafeInteger(cursor.byteOffset) && cursor.byteOffset >= 0 &&
    Number.isSafeInteger(cursor.frameCount) && cursor.frameCount >= 0 && Number.isSafeInteger(cursor.observedSize) &&
    cursor.observedSize === size && cursor.byteOffset <= cursor.observedSize &&
    cursor.frameCount === frames && typeof cursor.fileIdentity === 'string'
}

/** 读取 stat 时已存在的尾部，避免追加中的文件让本轮水位线越过实际读到的内容。 */
async function readTail(path: string, previous: FileCursor | undefined) {
  const handle = await open(path, 'r')
  try {
    const st = await handle.stat()
    const identity = fileIdentity(st)
    const resume = previous !== undefined && previous.fileIdentity === identity && st.size >= previous.observedSize
    const offset = resume ? previous.byteOffset : 0
    const buf = Buffer.allocUnsafe(st.size - offset)
    let bytesRead = 0
    while (bytesRead < buf.length) {
      const read = await handle.read(buf, bytesRead, buf.length - bytesRead, offset + bytesRead)
      if (read.bytesRead === 0) break
      bytesRead += read.bytesRead
    }
    return { buf: buf.subarray(0, bytesRead), offset, baseFrames: resume ? previous.frameCount : 0,
      size: offset + bytesRead, mtimeMs: st.mtimeMs, identity }
  } finally {
    await handle.close()
  }
}

/**
 * 增量扫描：只处理自上次以来新增的内容。
 *
 * 三层过滤（见 `state.ts` 的模块注释）：
 *
 * 1. **L1 文件大小**：`size === watermark.size` ⇒ 整个文件跳过（一次 stat，零解压）。
 *    依据是日志 append-only，字节数不变则内容不变。
 * 2. **L2 帧边界**：有字节光标时只读取完整帧末尾之后的内容；旧水位线按帧数兼容。
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
  const files = options.changedFiles === undefined
    ? await listSessionFiles(sessionsRoot)
    : sessionFilesFromPaths(sessionsRoot, options.changedFiles)
  const records: UsageRecord[] = []
  const fileResults: IncrementalFileResult[] = []
  let skippedUnchanged = 0
  let filteredBySeq = 0
  let bytesRead = 0
  let done = 0

  // 每个 sessionId 的 cwd 缓存：增量块大多不含 `session` 首行，
  // 必须从上一轮或同轮更早的文件继承，否则项目归属会丢。
  const cwdBySession = new Map<string, string | null>()

  for (const meta of files) {
    let size: number
    let mtimeMs: number
    let identity: string
    try {
      const st = await stat(meta.filePath)
      size = st.size
      mtimeMs = st.mtimeMs
      identity = fileIdentity(st)
    } catch {
      diagnostics.filesFailed++
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    const prevSize = options.watermarks.sizeOf(meta.filePath)
    const prevFrames = options.watermarks.frameCountOf(meta.filePath) ?? 0
    const previousCursor = options.watermarks.cursorOf?.(meta.filePath)
    const cursor = validCursor(previousCursor, prevSize, prevFrames) ? previousCursor : undefined

    // L1：字节数未变 ⇒ 内容未变 ⇒ 零解压跳过
    if (prevSize !== undefined && prevSize === size &&
      (previousCursor === undefined || cursor?.fileIdentity === identity)) {
      skippedUnchanged++
      if (cursor?.cwd != null) cwdBySession.set(meta.sessionId, cursor.cwd)
      fileResults.push({
        filePath: meta.filePath,
        sessionId: meta.sessionId,
        size,
        // 水位线不回退也不前进：帧数保持原值
        frameCount: prevFrames,
        mtimeMs,
        produced: 0,
        changed: false,
        ...(cursor ? { cursor } : {}),
      })
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    let tail: Awaited<ReturnType<typeof readTail>>
    try {
      tail = await readTail(meta.filePath, cursor)
    } catch {
      diagnostics.filesFailed++
      done++
      options.onProgress?.(done, files.length, meta.filePath)
      continue
    }

    diagnostics.filesScanned++
    bytesRead += tail.buf.length

    // 文件被截断/重建 ⇒ 旧帧水位线失效，从头读
    const reset = prevSize !== undefined && (tail.size < prevSize ||
      (previousCursor !== undefined && (cursor === undefined || cursor.fileIdentity !== tail.identity)))
    // 旧版光标把尾部半帧也计入帧数，首次升级多重读最后一帧，L3 会去掉已消费事件。
    const fromFrame = tail.offset > 0 || reset || cursor !== undefined ? 0 : Math.max(0, prevFrames - 1)

    const decoded = decodeFramedZstdFrom(tail.buf, fromFrame)
    diagnostics.framesOk += decoded.framesOk
    diagnostics.framesFailed += decoded.framesFailed

    const parseState: ParseState = {
      cwd:
        cwdBySession.get(meta.sessionId) ??
        cursor?.cwd ??
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
      let next = before
      for (let i = before; i < records.length; i++) {
        const rec = records[i]!
        if (lastSeq !== undefined && rec.seq <= lastSeq) {
          filteredBySeq++
          continue
        }
        records[next++] = rec
      }
      // 原地压紧，避免单个长会话的十几万条记录触发 spread 参数数量上限。
      records.length = next
      kept = next - before
    }

    fileResults.push({
      filePath: meta.filePath,
      sessionId: meta.sessionId,
      size: tail.size,
      frameCount: tail.baseFrames + decoded.consumedFrameCount,
      mtimeMs: tail.mtimeMs,
      produced: kept,
      changed: true,
      cursor: {
        byteOffset: tail.offset + decoded.byteOffset,
        frameCount: tail.baseFrames + decoded.consumedFrameCount,
        observedSize: tail.size,
        fileIdentity: tail.identity,
        cwd: parseState.cwd,
      },
    })

    done++
    options.onProgress?.(done, files.length, meta.filePath)
  }

  return { records, files: fileResults, diagnostics, skippedUnchanged, filteredBySeq, bytesRead }
}
