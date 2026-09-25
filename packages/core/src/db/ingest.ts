/**
 * 增量入库 —— 把「扫描本地会话日志」变成「只处理新增部分并写库」。
 *
 * ## 核心复用：不重写扫描逻辑
 *
 * 入库直接调用 `scanner.ts` 的 `scanIncremental()`，**水位线判定与解析
 * 全部复用**，本文件只做两件事：
 *
 * 1. 从库里读出水位线，适配成 scanner 要的 `WatermarkLookup`
 * 2. 把产出的 records 写进库，并在**同一个事务**里推进水位线
 *
 * ⚠️ 为什么必须复用而不是另写一套：两套实现会随时间漂移，
 *   导致「增量入库的结果 ≠ 全量扫描的结果」—— 这是最难查的一类口径 bug。
 *   `scanIncremental` 内部与 `scanAll` 共用 `collectEvents()`，天然保证一致。
 *
 * ## 幂等：靠 `event_id` 主键，不靠水位线的精确性
 *
 * 入库用 `INSERT OR IGNORE`，冲突即跳过。因此以下情况全部安全：
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 库比日志旧（崩在事务提交前） | 重扫，主键去重 |
 * | 文件被截断重建 | 该文件全量重扫，主键去重 |
 * | 两个进程同时 ingest | `busy_timeout` 排队，主键去重 |
 * | 用户手工删了水位线 | 全量重扫，主键去重 |
 *
 * 这是「宁可重扫，不可漏扫」的落点 —— 与 `report` 子命令的崩溃安全策略同源。
 */

import type { Database } from './driver.js'

import { scanIncremental, type ScanOptions } from '../scanner.js'
import type { ScanDiagnostics, UsageRecord } from '../types.js'
import { openDb, ensureSchema, needsRebuild, rebuildSchema, EVENT_TABLE } from './schema.js'

/** 一次 ingest 的结果。 */
export interface IngestResult {
  /** 本轮真正新插入库的记录数（已扣除重复）。 */
  inserted: number
  /** 因 `event_id` 冲突被跳过的记录数。 */
  duplicates: number
  /** 本轮解压的日志文件数（L1 未变的文件不计入，值为 0 表示走了纯热路径）。 */
  filesScanned: number
  /** L1 跳过的文件数（字节数未变，零解压）。 */
  skippedUnchanged: number
  /** 本次 ingest 的诊断（供 `/api/local/stats/diagnostics` 展示）。 */
  diagnostics: ScanDiagnostics
  /** 本次 ingest 耗时（毫秒）。 */
  elapsedMs: number
  /** ingest 完成时刻。 */
  ingestedAt: number
}

export interface IngestOptions {
  /** 会话日志根目录。 */
  sessionsRoot: string
  /** 实际上库路径（已由调用方解析）。 */
  dbPath: string
  /** 进度回调（长扫描时给页面/终端反馈）。 */
  onProgress?: ScanOptions['onProgress']
  /** 已打开的库连接。传入时复用，不关闭。 */
  db?: Database
}

/**
 * 执行一轮增量入库。
 *
 * ## 事务边界：**数据与水印必须原子**
 *
 * 顺序是「写数据 → 推水位线」，且**都在同一个事务里**：
 *
 * - 事务提交前崩溃 ⇒ 数据与水印都没变 ⇒ 下一轮重扫 ⇒ 主键去重 ⇒ 安全
 * - 事务提交后崩溃 ⇒ 数据与水印都已生效 ⇒ 无需重扫 ⇒ 安全
 *
 * 🚨 绝不可拆成两个事务：若数据先提交、水位线后提交而中间崩溃，
 *   下一轮会重扫并靠主键去重（只是慢一点，仍安全）；
 *   但**若水位线先提交、数据后提交而中间崩溃，那批数据就永久丢了** ——
 *   水位线说「这批已处理」，而库里根本没有。所以顺序与原子性都不能动。
 */
export async function ingest(options: IngestOptions): Promise<IngestResult> {
  const started = Date.now()
  const ownsDb = options.db === undefined
  const db = options.db ?? openDatabaseForIngest(options.dbPath)

  try {
    const watermarks = readWatermarks(db)

    const scan = await scanIncremental(options.sessionsRoot, {
      watermarks,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    })

    // ── 单事务：写数据 + 推水位线 + 更新诊断 ──────────────────────────
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${EVENT_TABLE}
       (event_id, session_id, seq, ts, provider, model, cwd,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, turn, step)
       VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd,
               $input, $output, $cacheRead, $cacheWrite,
               $reasoning, $turn, $step)`,
    )
    const upsertFile = db.prepare(
      `INSERT INTO file_watermark
       (file_path, session_id, size, frame_count, mtime_ms, first_seen_ms, updated_at_ms)
       VALUES ($path, $sessionId, $size, $frameCount, $mtime, $firstSeen, $now)
       ON CONFLICT(file_path) DO UPDATE SET
         size = excluded.size,
         frame_count = excluded.frame_count,
         mtime_ms = excluded.mtime_ms,
         updated_at_ms = excluded.updated_at_ms`,
    )
    // cwd 只在非空时覆盖 —— 增量块常没有 session 首行，
    // 用 null 冲掉已知值会让「按项目统计」在增量路径上退化成 (unknown)。
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
    // 每会话本轮的 max seq，事务里一次性推进（取 max，天然不回退）
    const lastSeqBySession = new Map<string, number>()
    // 每会话本轮解析出的 cwd（非空才记）
    const cwdBySession = new Map<string, string>()
    // 一次性取回，避免在循环里对每个文件各查一次库（196 次往返）
    const firstSeenMap = readFirstSeenMap(db)

    db.transaction(() => {
      for (const rec of scan.records) {
        // bun:sqlite 的 run() 返回 { changes, lastInsertRowid }，
        // changes=0 即被主键冲突忽略 —— 这是去重的唯一判据。
        const res = insert.run({
          $eventId: rec.eventId,
          $sessionId: rec.sessionId,
          $seq: rec.seq,
          $ts: rec.time,
          $provider: rec.provider,
          $model: rec.model,
          $cwd: rec.cwd,
          $input: rec.usage.input,
          $output: rec.usage.output,
          $cacheRead: rec.usage.cacheRead,
          $cacheWrite: rec.usage.cacheWrite,
          $reasoning: rec.usage.reasoning,
          $turn: rec.turn,
          $step: rec.step,
        })
        if (res.changes > 0) inserted++
        else duplicates++

        const prev = lastSeqBySession.get(rec.sessionId)
        if (prev === undefined || rec.seq > prev) lastSeqBySession.set(rec.sessionId, rec.seq)
        if (rec.cwd) cwdBySession.set(rec.sessionId, rec.cwd)
      }

      // L3 水位线：取本轮各会话的最大 seq。即使本轮无新记录也要写 ——
      // 文件水位线（L1/L2）仍然需要推进，否则每轮都会重扫。
      for (const [sessionId, lastSeq] of lastSeqBySession) {
        upsertSession.run({
          $sessionId: sessionId,
          $lastSeq: lastSeq,
          $cwd: cwdBySession.get(sessionId) ?? null,
          $now: now,
        })
      }

      for (const f of scan.files) {
        upsertFile.run({
          $path: f.filePath,
          $sessionId: f.sessionId,
          $size: f.size,
          $frameCount: f.frameCount,
          $mtime: f.mtimeMs,
          $firstSeen: firstSeenMap.get(f.filePath) ?? now,
          $now: now,
        })
      }

      writeRunStats(db, {
        now,
        insertedTotal: countEvents(db),
        diagnostics: scan.diagnostics,
      })
    })

    // ⚠️ 必须 finalize 全部 prepared statement。
    //   bun:sqlite 里未 finalize 的语句会让 `db.close()` **不释放文件句柄**，
    //   之后 `rmSync` 这个库文件会抛 `EBUSY: resource busy or locked`
    //   （实测 Windows 与 Linux 都如此）。表现是 `--reset-db` 永远失败，
    //   而错误信息完全不提 prepared statement，极难定位。
    //   放在这里而不是 finally：成功路径才需要 —— 抛错时连接会整体关闭。
    insert.finalize()
    upsertFile.finalize()
    upsertSession.finalize()

    return {
      inserted,
      duplicates,
      filesScanned: scan.diagnostics.filesScanned,
      skippedUnchanged: scan.skippedUnchanged,
      diagnostics: scan.diagnostics,
      elapsedMs: Date.now() - started,
      ingestedAt: now,
    }
  } finally {
    // 只关闭自己打开的连接；外部传入的由调用方管理
    if (ownsDb) db.close()
  }
}

/**
 * 打开库并保证 schema 就绪（含版本不符时重建）。
 *
 * ★ **任何失败都降级为「重建」而不是抛错** ——
 *   本地库是日志的派生物，坏了重建只多花一次全量扫描；
 *   而抛错会让本地页白屏、CLI 直接失败，代价大得多。
 *   这与仓库既定的「解析失败要降级不要抛错」一致。
 */
export function openDatabaseForIngest(dbPath: string): Database {
  const db = openDb(dbPath)
  try {
    if (needsRebuild(db)) rebuildSchema(db)
    else ensureSchema(db)
  } catch {
    // 建表/读版本失败说明文件已损坏（如被写坏、磁盘错误）：
    // 丢表重建是唯一能自愈的路径。
    rebuildSchema(db)
  }
  return db
}

/**
 * 读取库内记录总数（诊断用）。
 *
 * ⚠️ 用 `db.query().get()` 的短生命周期形式而不是长期持有 `prepare()`：
 *   前者由 bun:sqlite 内部管理，不会留下阻止 `close()` 释放句柄的语句。
 */
export function countEvents(db: Database): number {
  const row = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`).get()
  return row?.c ?? 0
}

/**
 * 读取全部文件水位线的 firstSeenMs（保留首次见到的时间）。
 *
 * 一次性取回而不是在循环里逐文件查询：196 次往返会明显拖慢热路径，
 * 而且每次 `prepare()` 都会产生一个需要 finalize 的语句句柄。
 */
function readFirstSeenMap(db: Database): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of db
    .query<{ file_path: string; first_seen_ms: number }, []>(
      'SELECT file_path, first_seen_ms FROM file_watermark',
    )
    .all()) {
    map.set(row.file_path, row.first_seen_ms)
  }
  return map
}

/**
 * 写诊断行（幂等覆盖单行）。
 *
 * ⚠️ 这里**只记「本轮增量」的计数**，而 `eventTypes` / `providersSeen` 是
 *   「本轮扫描所见」。若某一轮所有文件都被 L1 跳过（热态常态），
 *   本轮 `diagnostics` 全为 0 —— 直接覆盖会把上一轮有价值的诊断冲掉，
 *   页面上的「事件类型分布」会变成空。
 *
 *   因此对这几个**累加型**字段采用「本轮为 0 时保留旧值」的策略：
 *   热态轮次不会抹掉上一轮真实扫描得到的信息。
 *   `mismatch_count` 等则需要如实反映最近一次真实扫描，同样只在有扫描时更新。
 */
function writeRunStats(
  db: Database,
  input: { now: number; insertedTotal: number; diagnostics: ScanDiagnostics },
): void {
  const d = input.diagnostics
  // 本轮是否真的解压了文件。false ⇒ 是纯热态轮次，扫描类字段保留旧值。
  const didScan = d.filesScanned > 0 || d.totalEvents > 0

  const stmt = db.prepare(
    `INSERT INTO ingest_run
     (id, last_ingest_ms, last_scan_events, total_events_ingested,
      mismatch_count, files_failed, frames_failed, frames_ok, usage_events,
      assistant_without_usage, retry_started, retry, attempts, missing_provider,
      files_scanned, event_types_json, providers_json)
     VALUES (1, $now, $scanEvents, $ingestedTotal,
             $mismatch, $filesFailed, $framesFailed, $framesOk, $usageEvents,
             $noUsage, $retryStarted, $retry, $attempts, $missingProvider,
             $filesScanned, $eventTypes, $providers)
     ON CONFLICT(id) DO UPDATE SET
       last_ingest_ms = excluded.last_ingest_ms,
       total_events_ingested = excluded.total_events_ingested,
       -- 扫描类字段：仅在本轮确实扫描过时更新，否则保留旧值（见函数注释）
       last_scan_events = CASE WHEN $didScan THEN excluded.last_scan_events ELSE ingest_run.last_scan_events END,
       mismatch_count   = CASE WHEN $didScan THEN excluded.mismatch_count   ELSE ingest_run.mismatch_count   END,
       files_failed     = CASE WHEN $didScan THEN excluded.files_failed     ELSE ingest_run.files_failed     END,
       frames_failed    = CASE WHEN $didScan THEN excluded.frames_failed    ELSE ingest_run.frames_failed    END,
       frames_ok        = CASE WHEN $didScan THEN excluded.frames_ok        ELSE ingest_run.frames_ok        END,
       usage_events     = CASE WHEN $didScan THEN excluded.usage_events     ELSE ingest_run.usage_events     END,
       assistant_without_usage = CASE WHEN $didScan THEN excluded.assistant_without_usage ELSE ingest_run.assistant_without_usage END,
       retry_started    = CASE WHEN $didScan THEN excluded.retry_started    ELSE ingest_run.retry_started    END,
       retry            = CASE WHEN $didScan THEN excluded.retry            ELSE ingest_run.retry            END,
       attempts         = CASE WHEN $didScan THEN excluded.attempts         ELSE ingest_run.attempts         END,
       missing_provider = CASE WHEN $didScan THEN excluded.missing_provider ELSE ingest_run.missing_provider END,
       files_scanned    = CASE WHEN $didScan THEN excluded.files_scanned    ELSE ingest_run.files_scanned    END,
       event_types_json = CASE WHEN $didScan THEN excluded.event_types_json ELSE ingest_run.event_types_json END,
       providers_json   = CASE WHEN $didScan THEN excluded.providers_json   ELSE ingest_run.providers_json   END`,
  )

  stmt.run({
    $now: input.now,
    $scanEvents: d.totalEvents,
    $ingestedTotal: input.insertedTotal,
    $mismatch: d.totalTokenMismatches,
    $filesFailed: d.filesFailed,
    $framesFailed: d.framesFailed,
    $framesOk: d.framesOk,
    $usageEvents: d.usageEvents,
    $noUsage: d.assistantMessagesWithoutUsage,
    $retryStarted: d.retryStarted,
    $retry: d.retry,
    $attempts: d.attempts,
    $missingProvider: d.missingProvider,
    $filesScanned: d.filesScanned,
    // Map/Set 必须显式转换：JSON.stringify(new Map()) 得到 "{}"
    $eventTypes: JSON.stringify(Object.fromEntries(d.eventTypes)),
    $providers: JSON.stringify([...d.providersSeen].sort()),
    $didScan: didScan ? 1 : 0,
  })
  stmt.finalize()
}

/**
 * 从库读出水位线，适配成 `scanIncremental` 需要的查表接口。
 *
 * 全部一次查询取回后放内存 Map —— 避免在扫描循环里对每个文件各查一次库
 * （196 次往返会明显拖慢热路径）。
 */
export function readWatermarks(db: Database): {
  sizeOf(filePath: string): number | undefined
  frameCountOf(filePath: string): number | undefined
  lastSeqOf(sessionId: string): number | undefined
  cwdOf(sessionId: string): string | null | undefined
} {
  const files = new Map<string, { size: number; frameCount: number }>()
  for (const row of db
    .query<{ file_path: string; size: number; frame_count: number }, []>(
      'SELECT file_path, size, frame_count FROM file_watermark',
    )
    .all()) {
    files.set(row.file_path, { size: row.size, frameCount: row.frame_count })
  }

  const sessions = new Map<string, { lastSeq: number; cwd: string | null }>()
  for (const row of db
    .query<{ session_id: string; last_seq: number; cwd: string | null }, []>(
      'SELECT session_id, last_seq, cwd FROM session_state',
    )
    .all()) {
    sessions.set(row.session_id, { lastSeq: row.last_seq, cwd: row.cwd })
  }

  return {
    sizeOf: (p) => files.get(p)?.size,
    frameCountOf: (p) => files.get(p)?.frameCount,
    lastSeqOf: (s) => sessions.get(s)?.lastSeq,
    cwdOf: (s) => sessions.get(s)?.cwd,
  }
}

/**
 * 把一批已有记录直接写入库（用于从 `state.json` 的 pending 迁移，或测试造数）。
 *
 * 与 {@link ingest} 共用同一套列映射，因此两边写出的行结构必然一致。
 */
export function insertRecords(db: Database, records: UsageRecord[]): {
  inserted: number
  duplicates: number
} {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${EVENT_TABLE}
     (event_id, session_id, seq, ts, provider, model, cwd,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, turn, step)
     VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd,
             $input, $output, $cacheRead, $cacheWrite,
             $reasoning, $turn, $step)`,
  )
  let inserted = 0
  let duplicates = 0
  db.transaction(() => {
    for (const rec of records) {
      const res = insert.run({
        $eventId: rec.eventId,
        $sessionId: rec.sessionId,
        $seq: rec.seq,
        $ts: rec.time,
        $provider: rec.provider,
        $model: rec.model,
        $cwd: rec.cwd,
        $input: rec.usage.input,
        $output: rec.usage.output,
        $cacheRead: rec.usage.cacheRead,
        $cacheWrite: rec.usage.cacheWrite,
        $reasoning: rec.usage.reasoning,
        $turn: rec.turn,
        $step: rec.step,
      })
      if (res.changes > 0) inserted++
      else duplicates++
    }
  })
  // ⚠️ 必须 finalize：未 finalize 的 prepared statement 会让
  //   `db.close()` **不释放文件句柄**，之后 `rmSync` 该库文件会抛
  //   `EBUSY: resource busy or locked`（Windows 与 Linux 都会）。
  //   实测：不 finalize 时 `--reset-db` 永远失败。
  insert.finalize()
  return { inserted, duplicates }
}