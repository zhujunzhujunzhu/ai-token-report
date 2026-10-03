/**
 * 会话日志扫描器：遍历 `$DSH_HOME/sessions/<project>/<sessionId>/session*.jsonl.zstd`，
 * 解码并把 `assistant/message` 事件折叠为计费记录。
 */

import { existsSync } from 'node:fs'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { decodeFramedZstd, decodeFramedZstdFrom, parseJsonl } from './decode.js'
import { requireSource } from './sources/registry.js'
import type { SourceRoot } from './sources/types.js'
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

/** 扫描来源的语义版本；本地缓存与补报光标必须随来源选择规则重新生成。 */
export const SESSION_SCAN_REVISION = 2

/** 只有精确标准文件名才是格式代际；session.part-2 等分段绝不能被当成旧副本。 */
export function sessionLogVersion(name: string): number | null {
  const match = /^session(?:\.v([1-9]\d*))?\.jsonl\.zstd$/.exec(name)
  if (!match) return null
  const version = match[1] === undefined ? 0 : Number(match[1])
  return Number.isSafeInteger(version) ? version : null
}

/** DSH 升级会保留旧文件，但新格式会重编号 seq；同会话只能读最高格式的标准日志。 */
export function selectSessionLogFiles(entries: readonly string[]): string[] {
  let highest = -1
  for (const entry of entries) highest = Math.max(highest, sessionLogVersion(entry) ?? -1)
  return entries.filter(entry => entry.startsWith('session') && entry.endsWith('.jsonl.zstd') &&
    (sessionLogVersion(entry) === null || sessionLogVersion(entry) === highest))
}

/**
 * 会话日志根的入参：**单根（兼容老调用点）** 或 **一组根**（同一台机器上并存多套 DSH）。
 *
 * 两种写法在下游走完全相同的代码路径：多根只是把「列目录」重复几次再合并去重。
 * 之所以不让调用方自己循环再合并，是因为合并必须**去重且顺序确定**（见
 * {@link listSessionFiles}）——那是口径的一部分，散到各调用点必然漂移。
 */
export type SessionsRootInput = string | readonly string[]

/** 归一成一组根。单根写法与多根写法在下游不可区分。 */
export function sessionsRootList(input: SessionsRootInput): string[] {
  return typeof input === 'string' ? [input] : [...input]
}

/**
 * 列出**一组** sessions 根目录下的所有会话日志文件。
 *
 * ## 多根为什么必须去重、且顺序必须确定
 *
 * 同一台机器上并存多套 DSH 时，两个 home 的会话可能是**同一批的镜像**
 * （实测 224 个同名 sessionId）。更极端的是两个根互为父子、或其中一个是 symlink ——
 * 那时同一个文件会被列两次：
 *
 * - **去重**（按绝对路径）保证同一条日志只被解析一次；
 * - **顺序确定**（根序由调用方给定并已排序，合并取首次出现）保证
 *   `event_id = sessionId:seq` 在库里主键冲突时「先到者胜」的结果**可复现**。
 *   顺序随环境变量书写方式变化 = 同一批数据两次运行给出不同结果。
 */
export async function listSessionFiles(sessionsRoot: SessionsRootInput, options: { strictErrors?: boolean } = {}): Promise<SessionMeta[]> {
  const roots = sessionsRootList(sessionsRoot)
  if (roots.length === 1) return listSessionFilesInRoot(roots[0]!, options)

  const merged = new Map<string, SessionMeta>()
  for (const root of roots) {
    for (const meta of await listSessionFilesInRoot(root, options)) {
      if (!merged.has(meta.filePath)) merged.set(meta.filePath, meta)
    }
  }
  return [...merged.values()]
}

/** 单个根的列举实现。多根只是把它重复几次。 */
async function listSessionFilesInRoot(sessionsRoot: string, options: { strictErrors?: boolean } = {}): Promise<SessionMeta[]> {
  const out: SessionMeta[] = []

  let projects: Dirent[]
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    // 全量补报不能把不可读目录伪装成空历史；交互统计仍保留既有容错行为。
    if (options.strictErrors) throw error
    return out
  }

  for (const project of projects) {
    const projectDir = project.name
    const projPath = join(sessionsRoot, projectDir)
    try {
      if (!project.isDirectory() && !(project.isSymbolicLink() && (await stat(projPath)).isDirectory())) continue
    } catch (error) {
      if (options.strictErrors) throw error
      continue
    }

    let sessionIds: Dirent[]
    try {
      sessionIds = await readdir(projPath, { withFileTypes: true })
    } catch (error) {
      if (options.strictErrors) throw error
      continue
    }

    for (const session of sessionIds) {
      const sessionId = session.name
      const sessPath = join(projPath, sessionId)
      try {
        if (!session.isDirectory() && !(session.isSymbolicLink() && (await stat(sessPath)).isDirectory())) continue
      } catch (error) {
        if (options.strictErrors) throw error
        continue
      }

      // 旧格式是迁移前的只读副本，不能与重编号后的新格式一起统计。
      let entries: string[]
      try {
        entries = await readdir(sessPath)
      } catch (error) {
        if (options.strictErrors) throw error
        continue
      }

      for (const entry of selectSessionLogFiles(entries)) {
        out.push({
          // ← 这是 DSH 的列举实现（历史上只有来源），Codex 等由各自的适配器负责。
          source: 'dsh',
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
export function sessionFilesFromPaths(sessionsRoot: SessionsRootInput, paths: readonly string[]): SessionMeta[] {
  const roots = sessionsRootList(sessionsRoot).map((root) => resolve(root))
  const files = new Map<string, SessionMeta>()
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`变更日志路径必须是绝对路径：${path}`)
    const filePath = resolve(path)

    // ★ 多根：变更路径属于哪个根**事先不知道**，只能逐个根试 ——
    //   命中第一个能解析出「<project>/<sessionId>/<file>」三段式的根即为它的来源。
    //   跨盘符时 `relative()` 会回一个绝对路径，必须显式排除（否则 `D:` 会被当成项目名）。
    let parts: string[] | undefined
    for (const root of roots) {
      const rel = relative(root, filePath)
      if (isAbsolute(rel)) continue
      const candidate = rel.split(/[\\/]/)
      if (candidate.length !== 3 || candidate.some((part) => part === '..' || part === '')) continue
      parts = candidate
      break
    }

    const [projectDir, sessionId, entry] = parts ?? []
    if (parts === undefined || !entry?.startsWith('session') || !entry.endsWith('.jsonl.zstd')) {
      throw new Error(`变更日志路径不属于会话目录结构：${path}`)
    }
    files.set(filePath, { source: 'dsh', sessionId: sessionId!, projectDir: projectDir!, filePath, cwd: null, createdAt: null })
  }
  return [...files.values()]
}

/** 定向扫描也核对同目录的标准格式；监听到旧副本时只刷新当前格式，不把旧记录带回来。 */
export async function listSessionFilesFromPaths(sessionsRoot: SessionsRootInput, paths: readonly string[]): Promise<SessionMeta[]> {
  const requested = sessionFilesFromPaths(sessionsRoot, paths)
  const groups = new Map<string, SessionMeta[]>()
  for (const meta of requested) {
    const dir = dirname(meta.filePath)
    const group = groups.get(dir) ?? []
    group.push(meta)
    groups.set(dir, group)
  }
  const result: SessionMeta[] = []
  for (const [dir, group] of groups) {
    let entries: string[]
    try { entries = await readdir(dir) } catch {
      // 保留原路径让扫描器报告 filesFailed，不能把读取失败当成“无变化”。
      result.push(...group)
      continue
    }
    const wanted = new Set(group.map(meta => basename(meta.filePath)))
    for (const entry of selectSessionLogFiles(entries)) {
      // 标准日志总是带上，以便发现运行中升级；分段仍只扫描监听器指定的文件。
      if (!wanted.has(entry) && sessionLogVersion(entry) === null) continue
      result.push({ ...group[0]!, filePath: join(dir, entry) })
    }
  }
  return result
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

  const state: ParseState = { cwd: null }
  const collector = eventCollector(meta, state, diagnostics, records)
  try {
    const decoded = await decodeFramedZstd(buf, collector.push)
    collector.finish()
    diagnostics.framesOk += decoded.framesOk
    diagnostics.framesFailed += decoded.framesFailed
  } catch {
    diagnostics.filesFailed++
    return { meta, records }
  }

  meta.cwd = state.cwd
  return { meta, records }
}

/** 跨事件行累积的解析状态（`cwd` 来自 `session` 首行，供后续事件继承）。 */
export interface ParseState {
  cwd: string | null
}

/** 帧不等于 JSONL 行：保留跨帧的尾行，其余文本解析完立即释放。 */
export function eventCollector(meta: SessionMeta, state: ParseState, diagnostics: ScanDiagnostics, records: UsageRecord[]) {
  let pending = ''
  return {
    push(chunk: string) {
      const text = pending + chunk
      const end = text.lastIndexOf('\n')
      if (end < 0) { pending = text; return }
      collectEvents(text.slice(0, end + 1), meta, state, diagnostics, records)
      pending = text.slice(end + 1)
    },
    finish() { if (pending) collectEvents(pending, meta, state, diagnostics, records) },
  }
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
      // ⚠️ DSH 的幂等键**不带来源前缀**：它是上报库的主键，改它等于让服务端
      //   把历史事件当成新事件再插一遍（全量补报时数字翻倍，且不报错）。
      //   来源由 `source` 列承载，主键不该承担这件事。
      eventId: `${meta.sessionId}:${seq}`,
      source: 'dsh',
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

/** 单个会话日志根的巡检结果 —— 「这次统计到底读了哪几处」。 */
export interface SessionsRootInspection {
  /** 会话日志根（`<home>/sessions`）。 */
  root: string
  /** 目录是否存在。 */
  exists: boolean
  /** 含日志文件的会话目录数。 */
  sessions: number
  /** 候选日志文件数（按格式代际筛选后）。 */
  files: number
  /** 最近一次写入时间（epoch ms）；无文件或不可读时为 `null`。 */
  latestMs: number | null
  /** 不可用时的原因。**存在但读不了**与**根本不存在**是两件事，所以与 `exists` 分开。 */
  error?: string
}

/**
 * 逐个巡检会话日志根。
 *
 * 多根统计之后，「这个数字来自哪几个根」必须能被回答 —— 否则
 * 「我加了一个 home 但数字没变」既可能是镜像去重（正确），也可能是
 * 那个根根本读不到（错误），使用者无法区分。
 *
 * ⚠️ 会 stat 每个日志文件（这是 `latestMs` 的代价）。**不要**在每次取数的热路径上调用，
 *   只用于 `--discover`、诊断输出与「来源」展示。
 */
export async function inspectSessionRoots(sessionsRoot: SessionsRootInput): Promise<SessionsRootInspection[]> {
  const out: SessionsRootInspection[] = []

  for (const root of sessionsRootList(sessionsRoot)) {
    if (!existsSync(root)) {
      out.push({ root, exists: false, sessions: 0, files: 0, latestMs: null, error: '会话日志根不存在' })
      continue
    }

    let projects: Dirent[]
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      out.push({
        root, exists: true, sessions: 0, files: 0, latestMs: null,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    let sessions = 0
    let files = 0
    let latestMs: number | null = null
    for (const project of projects) {
      if (!project.isDirectory() && !project.isSymbolicLink()) continue
      const projPath = join(root, project.name)
      let sessionIds: Dirent[]
      try {
        sessionIds = await readdir(projPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessionIds) {
        if (!session.isDirectory() && !session.isSymbolicLink()) continue
        const sessPath = join(projPath, session.name)
        let entries: string[]
        try {
          entries = await readdir(sessPath)
        } catch {
          continue
        }
        let counted = false
        for (const entry of selectSessionLogFiles(entries)) {
          counted = true
          files++
          try {
            const st = await stat(join(sessPath, entry))
            if (latestMs === null || st.mtimeMs > latestMs) latestMs = st.mtimeMs
          } catch {
            // 单个文件 stat 失败只影响 latestMs，不该让整个巡检失败
          }
        }
        if (counted) sessions++
      }
    }
    out.push({ root, exists: true, sessions, files, latestMs })
  }

  return out
}

/** 扫描整个（一组）sessions 目录，返回全部计费记录。 */
export async function scanAll(
  sessionsRoot: SessionsRootInput,
  options: ScanOptions = {},
): Promise<{ records: UsageRecord[]; sessions: SessionMeta[]; diagnostics: ScanDiagnostics }> {
  const diagnostics = emptyDiagnostics()
  const files = await listSessionFiles(sessionsRoot)
  return scanFiles(files, options, diagnostics)
}

/**
 * 按**来源适配器**列举一组根下的会话文件。
 *
 * 与 `listSessionFiles` 的关系：那个是 DSH 的列举实现（历史上只有来源），
 * 这个是「任意来源」的列举 —— 每个根交给它自己的适配器，本函数只负责
 * **顺序确定**与**按文件路径去重**（同一份日志被两个根列出两次时只读一次）。
 *
 * ⚠️ 刻意**不按 sessionId 去重**：DSH 的一个会话可能被拆成多个
 * `session*.jsonl.zstd`（格式分段），按会话去重会**静默丢掉**那些分段。
 * 副本（Codex 的 `archived_sessions/`、互为镜像的两个 home）由
 * `event_id` 主键去重吸收，根序保证「先到者胜」可复现 —— 与多 home 的既有语义完全一致。
 */
export async function listSourceFiles(
  roots: readonly SourceRoot[],
  options: { strictErrors?: boolean } = {},
): Promise<SessionMeta[]> {
  const merged = new Map<string, SessionMeta>()
  for (const root of roots) {
    const adapter = requireSource(root.source)
    for (const meta of await adapter.list(root, options)) {
      if (!merged.has(meta.filePath)) merged.set(meta.filePath, meta)
    }
  }
  return [...merged.values()]
}

/** 扫描一组**带来源**的根（任意来源混合），返回全部计费记录。 */
export async function scanAllSources(
  roots: readonly SourceRoot[],
  options: ScanOptions = {},
): Promise<{ records: UsageRecord[]; sessions: SessionMeta[]; diagnostics: ScanDiagnostics }> {
  const diagnostics = emptyDiagnostics()
  const files = await listSourceFiles(roots)
  return scanFiles(files, options, diagnostics)
}

/**
 * 文件 `stat` 的并发度（纯文本来源的 L1 判定要按文件数走一遍）。
 *
 * 实测（本机 1,512 个文件 / Windows + Bun）：串行 **123ms** → 并发 32 **35ms**
 * → 并发 128 **14ms**。取 32 是**刻意的折中**：再往上收益递减，而每个并发项都占一个
 * 文件句柄 —— 热态取数**每次请求都会跑一遍**，不值得为了 20ms 去试探 fd 上限。
 */
const STAT_CONCURRENCY = 32

/** 有界并发映射；结果顺序与输入一致（顺序决定「先到者胜」，不能乱）。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return out
}

/** 一个纯文本来源文件在本轮扫描里的结果。 */
export interface PlainSourceFileResult {
  meta: SessionMeta
  /** 当前字节数（L1 水位线写回用）。 */
  size: number
  mtimeMs: number
  /** `true` = 本轮真的解析过它（字节数变过或还没有水位线）。 */
  changed: boolean
}

export interface PlainSourceScanOptions {
  /**
   * 上次处理时的**字节数**（相等 ⇒ 整个文件跳过，零解析）。
   *
   * 缺省（不传）= 没有任何水位线 ⇒ 全部解析。**没有 L2 字节光标**是刻意的：
   * 这些来源的计费事件有「同一次调用写两条 / 累计快照」的形态，半路续读会丢掉
   * 那份上下文（见 `db/ingest-plain.ts` 文件头）。代价是「发生变化的文件整份重解析」，
   * 而幂等由 `event_id` 主键兜住。
   */
  sizeOf?: (filePath: string) => number | undefined
  /** 上次解析出的 cwd（增量块里没有 `session_meta` 时靠它继承项目归属）。 */
  cwdOf?: (sessionId: string) => string | null | undefined
  onProgress?: (done: number, total: number, file: string) => void
}

export interface PlainSourceScanResult {
  /** 实际存在的根（不存在的那部分在 `missingRoots` 里，绝不静默）。 */
  presentRoots: SourceRoot[]
  missingRoots: string[]
  records: UsageRecord[]
  files: PlainSourceFileResult[]
  diagnostics: ScanDiagnostics
  /** 本轮真的解析过的文件数。 */
  filesScanned: number
  /** 因字节数未变而整份跳过的文件数。 */
  skippedUnchanged: number
}

/**
 * 扫描一组**纯文本来源**根，按字节数水位线决定要不要解析。
 *
 * ## 为什么单独有一个函数（而不是复用 `scanAllSources`）
 *
 * `scanAllSources` 是**全量**扫描（没有任何水位线），用在 `--no-db` 对照与验证脚本里；
 * 而「入库」与「上报」两条路都需要**增量**语义：没变过的文件一条 JSON 都不解析。
 * 这个函数就是那条增量语义的**唯一实现**，两条路都走它：
 *
 * | 调用方 | `sizeOf` 从哪来 | 解析结果去哪 |
 * |---|---|---|
 * | `db/ingest-plain.ts`（本地库 / 本地页 / 插件取数） | `file_watermark.size`（库） | `usage_event` + 水位线 |
 * | `cli/report.ts`（上报） | `state.json` 的 `files[path].size` | pending → 投递 → `ack` |
 *
 * 🚨 两处**不能各写一份**：「什么时候该重解析」「重解析后哪些老记录被主键吸收」
 *   这些判断一旦分叉，表现是「同一批日志，本地页与上报给出不同条数」而**不报错**。
 *
 * 🚨 阶段 2 刻意**串行**：列举顺序决定 `event_id` 冲突时谁先入库（活动副本优先于归档副本），
 *   并发会把这个顺序变成调度噪声。便宜的是 `stat`（阶段 1，并发），贵的是解析，
 *   而解析只在文件真的变了时才发生。
 */
export async function scanPlainSources(
  roots: readonly SourceRoot[],
  options: PlainSourceScanOptions = {},
): Promise<PlainSourceScanResult> {
  const diagnostics = emptyDiagnostics()
  const presentRoots: SourceRoot[] = []
  const missingRoots: string[] = []
  for (const root of roots) {
    if (existsSync(root.path)) presentRoots.push(root)
    else missingRoots.push(root.path)
  }

  // ── 列举：只认纯文本来源；DSH 的根混进来要明确报错，而不是静默不统计它 ──
  const files: SessionMeta[] = []
  for (const root of presentRoots) {
    const adapter = requireSource(root.source)
    if (adapter.encoding !== 'plain-jsonl') {
      throw new Error(`来源 ${root.source} 不是纯文本来源，请交给 scanAll()：${root.path}`)
    }
    for (const meta of await adapter.list(root)) files.push(meta)
  }

  // ── 阶段 1：并发 stat（纯读，与顺序无关）────────────────────────────
  const stats = await mapLimit(files, STAT_CONCURRENCY, async (meta) => {
    try {
      const info = await stat(meta.filePath)
      return { meta, size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return { meta, failed: true as const }
    }
  })

  // ── 阶段 2：按列举顺序串行折叠 ──────────────────────────────────────
  const records: UsageRecord[] = []
  const fileResults: PlainSourceFileResult[] = []
  let filesScanned = 0
  let skippedUnchanged = 0
  let done = 0
  for (const entry of stats) {
    const meta = entry.meta
    const report = () => { done++; options.onProgress?.(done, files.length, meta.filePath) }
    if ('failed' in entry) {
      diagnostics.filesFailed++
      report()
      continue
    }
    const { size, mtimeMs } = entry
    const previous = options.sizeOf?.(meta.filePath)
    if (previous !== undefined && previous === size) {
      skippedUnchanged++
      fileResults.push({ meta, size, mtimeMs, changed: false })
      report()
      continue
    }
    const adapter = requireSource(meta.source)
    let text: string
    try {
      text = await readFile(meta.filePath, 'utf8')
    } catch {
      diagnostics.filesFailed++
      report()
      continue
    }
    filesScanned++
    // 起始 cwd 从水位线继承（增量块里没有 `session_meta` 时靠它保住项目归属）。
    const inherited = options.cwdOf?.(meta.sessionId)
    if (meta.cwd === null && inherited !== undefined && inherited !== null) meta.cwd = inherited
    const folder = adapter.createFolder(meta, diagnostics, records)
    folder.push(text)
    folder.finish()
    fileResults.push({ meta, size, mtimeMs, changed: true })
    report()
  }

  return { presentRoots, missingRoots, records, files: fileResults, diagnostics, filesScanned, skippedUnchanged }
}

/**
 * 扫一批文件并按 `event_id` 去重、按筛选条件过滤。
 *
 * ★ 全量入口（`scanAll` / `scanAllSources`）**共用这一份**去重与筛选逻辑：
 *   两套实现会随时间漂移，表现是「同一批日志、不同入口给出不同数字」。
 */
async function scanFiles(
  files: readonly SessionMeta[],
  options: ScanOptions,
  diagnostics: ScanDiagnostics,
): Promise<{ records: UsageRecord[]; sessions: SessionMeta[]; diagnostics: ScanDiagnostics }> {
  const sessions: SessionMeta[] = []
  const records: UsageRecord[] = []
  const seenEvents = new Set<string>()

  let done = 0
  for (const meta of files) {
    const result = await scanSourceFile(meta, diagnostics)
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

/**
 * 按文件的**来源**选择解码与折叠方式。
 *
 * - `zstd-frames`（DSH）：走既有的 `scanSessionFile`（分帧解压 + 帧完整性检查）
 * - `plain-jsonl`（Codex 等）：整文件读文本，交给适配器的折叠器
 */
export async function scanSourceFile(
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
): Promise<SessionScanResult> {
  const adapter = requireSource(meta.source)
  if (adapter.encoding === 'zstd-frames') return scanSessionFile(meta, diagnostics)

  const records: UsageRecord[] = []
  const folder = adapter.createFolder(meta, diagnostics, records)
  let text: string
  try {
    text = await readFile(meta.filePath, 'utf8')
  } catch {
    diagnostics.filesFailed++
    return { meta, records }
  }
  diagnostics.filesScanned++
  // ⚠️ 这里**刻意不**再加 `diagnostics.codexFiles++`：「采到的文件数」是**每个来源
  //   自己的**计数（Codex / Claude Code / Trae / WorkBuddy 各自的适配器在
  //   `createFolder()` 里加一次）。加在这里会把它变成「全部纯文本来源的文件数」，
  //   而本地库路径（`ingestPlainSources`）根本不走这里 ⇒ 同一个字段在两条路径下
  //   一个偏高、一个恒为 0。
  folder.push(text)
  folder.finish()
  return { meta, records }
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
  /** 已按本模块来源策略发现的文件；入库需要同一份目录快照检测格式切换。 */
  sessionFiles?: SessionMeta[]
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
  sessionsRoot: SessionsRootInput,
  options: IncrementalScanOptions,
): Promise<IncrementalScanResult> {
  const diagnostics = emptyDiagnostics()
  const files = options.sessionFiles ?? (options.changedFiles === undefined
    ? await listSessionFiles(sessionsRoot)
    : await listSessionFilesFromPaths(sessionsRoot, options.changedFiles))
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

    const parseState: ParseState = {
      cwd:
        cwdBySession.get(meta.sessionId) ??
        cursor?.cwd ??
        options.watermarks.cwdOf?.(meta.sessionId) ??
        null,
    }

    const before = records.length
    const collector = eventCollector(meta, parseState, diagnostics, records)
    const decoded = decodeFramedZstdFrom(tail.buf, fromFrame, collector.push)
    collector.finish()
    diagnostics.framesOk += decoded.framesOk
    diagnostics.framesFailed += decoded.framesFailed
    cwdBySession.set(meta.sessionId, parseState.cwd)
    meta.cwd = parseState.cwd

    // L3：事件级兜底过滤
    let kept = 0
    // 标准日志升级会重编号，旧格式遗留的会话最大 seq 不能过滤新格式及其后续追加。
    // 文件光标负责增量；必要的重发由 event_id 主键去重，分段保留原有 L3 语义。
    const lastSeq = sessionLogVersion(basename(meta.filePath)) === null
      ? options.watermarks.lastSeqOf(meta.sessionId) : undefined
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
