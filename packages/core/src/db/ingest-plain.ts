/**
 * **纯文本来源的本地增量入库**（Codex / Claude Code / Trae / WorkBuddy …）。
 *
 * ## 为什么与 `ingest()` 分开
 *
 * `ingest()` 的水位线是围绕 **DSH 的 zstd 分帧**建的：L2 是「已消费帧数」+ 字节光标，
 * L3 是会话内单调 `seq`。而纯文本来源是**行式 JSONL**：没有帧、序号是文件内 `ordinal`。
 * 把两者塞进同一个函数，等于让一条最难的代码路径同时承载两种增量语义 ——
 * 一旦出错，症状是「某个来源的数字慢慢变少」，而且**不报错**。
 *
 * 所以这里只做纯文本来源，规则刻意简单到可以逐条说清：
 *
 * | 层 | 判据 | 作用 |
 * |---|---|---|
 * | L1 | `file_watermark.size` 与当前字节数相等 | 整个文件跳过（零解析） |
 * | L2 | —— | **没有**：文件一旦变化就**整份重解析** |
 * | L3 | `event_id` 主键（`codex:<sessionId>:<ordinal>`） | 重解析带回来的老记录被幂等吸收 |
 *
 * ⚠️ **为什么不做字节光标续读**：Codex 的计费事件有「同一次调用写两条」的形态，
 * 去重靠**上一条累计快照**。从半路续读会丢掉那个上下文，把第二次写入当成新调用 ——
 * 总量翻倍且不报错。整份重解析 > 少算/多算。代价是「只有发生变化的文件才重解析」：
 * 热态就是一次 `stat`（本机 1,512 个文件约 1 秒）。
 *
 * ## 与本地库共用的东西
 *
 * schema（`usage_event` 含 `source` 列）、`file_watermark` / `session_state` 两张水位线表、
 * `event_id` 幂等语义 —— 全部与 `ingest()` 共用。**只有解析与判据不同**。
 */

import { existsSync } from 'node:fs'

import type { ScanDiagnostics, SessionMeta } from '../types.js'
import { requireSource } from '../sources/registry.js'
import { scanPlainSources } from '../scanner.js'
import type { SourceRoot } from '../sources/types.js'
import type { Database } from './driver.js'
import { DB_SCHEMA_VERSION, EVENT_TABLE } from './schema.js'
import { openDatabaseForIngest } from './ingest.js'

export interface PlainIngestOptions {
  /** 只处理 `encoding === 'plain-jsonl'` 的来源根（DSH 的根请交给 `ingest()`）。 */
  roots: readonly SourceRoot[]
  /** 库里已有连接时复用；不传则按 `dbPath` 打开（并负责关闭）。 */
  db?: Database
  dbPath?: string
  onProgress?: (done: number, total: number, file: string) => void
}

export interface PlainIngestResult {
  inserted: number
  duplicates: number
  filesScanned: number
  skippedUnchanged: number
  /** 配置里给了、但目录不存在因而被跳过的根（绝不静默）。 */
  missingRoots: string[]
  diagnostics: ScanDiagnostics
  elapsedMs: number
}

/** 一条文件水位线（L1 只需 size；cwd 用来给增量块补项目归属）。 */
interface FileWatermark {
  size: number
  cwd: string | null
}

/**
 * 读一批文件的 L1 水位线。
 *
 * 用**具名参数**而不是位置参数：位置参数的展开行为在 `bun:sqlite` 与
 * `node:sqlite` 之间不一致，而这个函数将来可能被两种驱动走到（本机库目前恒为
 * Bun，但没必要在这里埋一个只在 Node 下才炸的坑）。
 *
 * ★ **分批查**：一次 `IN (...)` 里塞进所有路径会让参数个数等于文件数，而 SQLite 的
 *   `SQLITE_MAX_VARIABLE_NUMBER` 默认 **32,766**（更老的构建只有 999）——
 *   攒了几万份日志的目录会直接抛错。分批既避开上限，代价也只是一次循环。
 */
function readPlainWatermarks(db: Database, paths: readonly string[]): Map<string, FileWatermark> {
  const out = new Map<string, FileWatermark>()
  const CHUNK = 900
  for (let start = 0; start < paths.length; start += CHUNK) {
    const slice = paths.slice(start, start + CHUNK)
    const keys = slice.map((_, i) => `$p${i}`)
    const params: Record<string, string> = {}
    slice.forEach((path, i) => { params[`$p${i}`] = path })
    const rows = db.query<{ file_path: string; size: number; cwd: string | null }, Record<string, string>>(
      `SELECT f.file_path, f.size, s.cwd
       FROM file_watermark f
       LEFT JOIN session_state s ON s.session_id = f.session_id
       WHERE f.file_path IN (${keys.join(', ')})`,
    ).all(params)
    for (const row of rows) out.set(row.file_path, { size: row.size, cwd: row.cwd })
  }
  return out
}

/**
 * 文件 `stat` 的并发度。
 *
 * 实测（本机 1,512 个文件 / Windows + Bun）：串行 **123ms** → 并发 32 **35ms**
 * → 并发 128 **14ms**。取 32 是**刻意的折中**：再往上收益递减，而每个并发项都占一个
 * 文件句柄 —— 热态取数**每次请求都会跑一遍**，不值得为了 20ms 去试探 fd 上限。
 */
const STAT_CONCURRENCY = 32

/** 有界并发映射；结果顺序与输入一致（顺序决定「先到者胜」，不能乱）。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

/**
 * 入库一轮纯文本来源。
 *
 * 🚨 **数据与水位线在同一个事务里**（顺序：先数据、后水位线，且一次提交）：
 * - 提交前崩溃 ⇒ 两者都没变 ⇒ 下轮重解析 ⇒ 主键去重 ⇒ 安全；
 * - 提交后崩溃 ⇒ 两者都已生效 ⇒ 无需重扫 ⇒ 安全。
 * 反过来的顺序（水位线先落）会在中途崩溃时**永久丢数据**，所以顺序不能动。
 */
export async function ingestPlainSources(options: PlainIngestOptions): Promise<PlainIngestResult> {
  const started = Date.now()
  const ownsDb = options.db === undefined

  const db = options.db ?? openDatabaseForIngest(options.dbPath!)
  try {
    // 与 `ingest()` 同一道护栏：本地派生库可以重建，上报库（唯一副本）绝不碰。
    if (db.query<{ user_version: number }>('PRAGMA user_version').get()?.user_version !== DB_SCHEMA_VERSION) {
      throw new Error('日志增量采集只接受本地派生库，拒绝修改上报库')
    }

    const plain = options.roots.filter((root) => requireSource(root.source).encoding === 'plain-jsonl')
    // 列举成本要先付：水位线查询按**文件路径**批量取（分批避开 SQLite 的参数上限）。
    const files: SessionMeta[] = []
    for (const root of plain) {
      if (!existsSync(root.path)) continue
      for (const meta of await requireSource(root.source).list(root)) files.push(meta)
    }
    const watermarks = readPlainWatermarks(db, files.map((meta) => meta.filePath))
    // 会话 → 上次解析出的 cwd：增量块里没有 `session_meta`，靠它补项目归属。
    const watermarkCwd = new Map<string, string>()
    for (const meta of files) {
      const cwd = watermarks.get(meta.filePath)?.cwd
      if (cwd !== undefined && cwd !== null) watermarkCwd.set(meta.sessionId, cwd)
    }

    // ★ 扫描本身只有一份实现（L1 字节数水位线 + 顺序 + 折叠），上报路径走同一个函数。
    const scan = await scanPlainSources(options.roots, {
      sizeOf: (filePath) => watermarks.get(filePath)?.size,
      cwdOf: (sessionId) => watermarkCwd.get(sessionId),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    })
    const { records, diagnostics, missingRoots } = scan
    // 只有**真的解析过**的文件才写回水位线（跳过的不必改写 updated_at_ms）。
    const fileRows = scan.files.filter((file) => file.changed)

    // 每个会话本轮解析出的最大 ordinal（会话内单调，取 max 天然不回退）。
    const maxSeqBySession = new Map<string, number>()
    for (const rec of records) {
      const prev = maxSeqBySession.get(rec.sessionId)
      if (prev === undefined || rec.seq > prev) maxSeqBySession.set(rec.sessionId, rec.seq)
    }
    const cwdBySession = new Map<string, string>()
    for (const row of fileRows) if (row.meta.cwd !== null) cwdBySession.set(row.meta.sessionId, row.meta.cwd)

    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${EVENT_TABLE}
       (event_id, session_id, seq, ts, provider, model, cwd, source,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, turn, step)
       VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd, $source,
               $input, $output, $cacheRead, $cacheWrite,
               $reasoning, $turn, $step)`,
    )
    const upsertFile = db.prepare(
      `INSERT INTO file_watermark
       (file_path, session_id, size, frame_count, mtime_ms, first_seen_ms, updated_at_ms)
       VALUES ($path, $sessionId, $size, 0, $mtime, $now, $now)
       ON CONFLICT(file_path) DO UPDATE SET
         size = excluded.size, mtime_ms = excluded.mtime_ms, updated_at_ms = excluded.updated_at_ms`,
    )
    const upsertSession = db.prepare(
      `INSERT INTO session_state (session_id, last_seq, cwd, updated_at_ms)
       VALUES ($sessionId, $lastSeq, $cwd, $now)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seq = MAX(session_state.last_seq, excluded.last_seq),
         cwd = COALESCE(excluded.cwd, session_state.cwd),
         updated_at_ms = excluded.updated_at_ms`,
    )

    const now = Date.now()
    let inserted = 0
    let duplicates = 0
    try {
      db.transaction(() => {
        for (const rec of records) {
          // changes=0 即被主键冲突忽略 —— 整份重解析带回来的老记录走这条。
          const res = insert.run({
            $eventId: rec.eventId, $sessionId: rec.sessionId, $seq: rec.seq, $ts: rec.time,
            $provider: rec.provider, $model: rec.model, $cwd: rec.cwd, $source: rec.source,
            $input: rec.usage.input, $output: rec.usage.output,
            $cacheRead: rec.usage.cacheRead, $cacheWrite: rec.usage.cacheWrite,
            $reasoning: rec.usage.reasoning, $turn: rec.turn, $step: rec.step,
          })
          if (res.changes > 0) inserted++
          else duplicates++
        }
        for (const row of fileRows) {
          upsertFile.run({
            $path: row.meta.filePath, $sessionId: row.meta.sessionId,
            $size: row.size, $mtime: row.mtimeMs, $now: now,
          })
          upsertSession.run({
            $sessionId: row.meta.sessionId,
            $lastSeq: maxSeqBySession.get(row.meta.sessionId) ?? -1,
            $cwd: cwdBySession.get(row.meta.sessionId) ?? null,
            $now: now,
          })
        }
      })
    } finally {
      // 未 finalize 的 prepared statement 会让 `db.close()` 不释放句柄
      // （之后删库文件抛 EBUSY，Windows 与 Linux 都会）。
      insert.finalize()
      upsertFile.finalize()
      upsertSession.finalize()
    }

    return {
      inserted, duplicates,
      filesScanned: scan.filesScanned, skippedUnchanged: scan.skippedUnchanged,
      missingRoots, diagnostics,
      elapsedMs: Date.now() - started,
    }
  } finally {
    if (ownsDb) {
      try { db.close() } catch { /* 关闭失败不影响结果 */ }
    }
  }
}
