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
import type { WireTokenRecord } from '@ai-token-report/shared'
import { portalDialect, type PortalStore } from './portal-db.js'
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
 * 打开**服务端上报库**的 SQLite 后端：schema 版本不符时**抛错，绝不重建**。
 *
 * ★ 实现只有一份 —— 从 `portal-db.ts` re-export `openPortalSqlite`。
 *   这里曾经有过第二份「版本闸门」实现（与 `openPortalSqlite` 逐字重复）：
 *   两份闸门必然各自演化，而它们分歧的表现是「某条路径开始静默重建上报库」，
 *   那是**全员历史用量永久消失**级的故障。所以绝不留下第二份。
 *
 * ⚠️ 名字保留是兼容需要（`packages/server/test/e2e-ingest.ts` 等在用）。
 *   新代码请优先用异步门面 `openPortalStore()` / `openPortalStats()` ——
 *   只有它们认 MySQL 后端。
 *
 * 为什么与 `openDatabaseForIngest` 不同：本机库是日志的派生物（坏了重建，
 * 代价是重扫一次）；上报库是全员数据的**唯一副本**（客户端投递成功后已清掉
 * 自己的 pending），删掉无从恢复。详见 `portal-db.ts` 的模块注释。
 */
export { openPortalSqlite as openPortalDb } from './portal-db.js'

/**
 * 记录「最近一次落库时刻」，供部门看板显示**数据是什么时候到的**。
 *
 * ## 为什么不新建一列 / 一张表
 *
 * 🚨 上报库的 schema **不能动**：`openPortalStore()` 在版本不符时会抛错而
 *   不重建（它是全员数据的唯一副本），所以任何一次 schema 变更都会让
 *   现网的上报库直接打不开。`ingest_run` 表本来就在 schema 里
 *   （本机库用它存扫描诊断），上报库这边它是空的 —— 复用它**不产生任何
 *   版本变更**。
 *
 * ⚠️ 冲突分支**只更新 `last_ingest_ms`**，其余列一律不动：
 *   本机库的 `writeRunStats()` 往同一行写的是扫描诊断，若这里顺手覆盖
 *   那些列，本机页面的诊断信息会被清零。
 *
 * ## 两种后端
 *
 * ★ SQL 由 `dialect.render()` 生成：SQLite 是 `ON CONFLICT(id) DO UPDATE SET
 *   last_ingest_ms = excluded.last_ingest_ms`，MySQL 是
 *   `AS new ON DUPLICATE KEY UPDATE last_ingest_ms = new.last_ingest_ms`。
 *   一套模板、两种方言，不存在第二份 upsert 语句。
 *
 * ⚠️ 列清单必须把 `event_types_json` / `providers_json` **显式写全**：
 *   SQLite 侧它们有 `DEFAULT '{}'` / `DEFAULT '[]'`，而 MySQL 侧的 DDL
 *   没有默认值且是 `NOT NULL` —— 靠默认值会在 MySQL 上报
 *   `Field 'event_types_json' doesn't have a default value`。
 *   显式填的字面量与 SQLite 的默认值刻意相同，两种后端的行完全一致。
 */
export async function recordIngestMoment(store: PortalStore, at: number = Date.now()): Promise<void> {
  const dialect = portalDialect(store.kind)
  const sql = dialect.render({
    table: 'ingest_run',
    columns: [
      'id',
      'last_ingest_ms',
      'last_scan_events',
      'total_events_ingested',
      'mismatch_count',
      'files_failed',
      'frames_failed',
      'frames_ok',
      'usage_events',
      'assistant_without_usage',
      'retry_started',
      'retry',
      'attempts',
      'missing_provider',
      'files_scanned',
      'event_types_json',
      'providers_json',
    ],
    // ⚠️ `values` 里**不要自己加括号**：`dialect.render()` 已经写了
    //   `VALUES (...)`，再加一层会变成 `VALUES ((1, ...))` —— SQLite 会报
    //   「1 values for 17 columns」这种看不出所以然的错误。
    values: "1, $now, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}', '[]'",
    keyColumn: 'id',
    assignments: [`last_ingest_ms = ${dialect.incoming}.last_ingest_ms`],
  })

  await store.run(sql, { $now: at })
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

// ─────────────────────────────────────────────────────────────
// 服务端上报落库（POST /api/v1/token-usage）
// ─────────────────────────────────────────────────────────────

/**
 * 落库用的上报记录 —— **刻意没有 `total_tokens`**。
 *
 * ⚠️ 这不是笔误：`usage_event` 表里压根没有 total 列（铁律 2 —— 库里不存
 *   派生口径，展示时的相加由 `shared/metrics.ts` 负责）。把该字段排除在
 *   类型之外，能让「服务端哪天顺手把客户端上报的 total 当权威值存下来」
 *   这件事**在编译期就不可能发生**。
 */
export type IngestRecord = Omit<WireTokenRecord, 'total_tokens'>

/**
 * 上报方的归属身份。
 *
 * ★ 这三个值**只可能来自服务端的凭证表**（`Authorization` 头里的 token
 *   查表得出），绝不用客户端在 body 里自称的 `client.userName` 覆盖 ——
 *   否则任何人改一下本地配置就能以他人名义上报。
 */
export interface EventOwner {
  /** 归属键。凭证表里没有独立的人员 ID，归属键就是**服务端认定的姓名**。 */
  userId: string
  /** 展示用姓名。当前与 `userId` 同值，分开是为了将来一人多 token 时能只改一处。 */
  userName?: string | null
  dept?: string | null
}

/**
 * 把一批**服务端已鉴权**的上报记录写入库，并带上归属。
 *
 * ## 与 `insertRecords` / `ingest` 的关系
 *
 * 三者共用同一张表、同一套列映射与同一个幂等键（`event_id`），区别只在数据来源：
 *
 * | 函数 | 来源 | 归属列 | 后端 |
 * |---|---|---|---|
 * | `ingest` | 本机会话日志增量扫描 | 不写（NULL） | 同步 SQLite |
 * | `insertRecords` | 已有的 `UsageRecord`（迁移 / 造数） | 不写（NULL） | 同步 SQLite |
 * | **本函数** | **HTTP 上报（插件 / CLI）** | **写入鉴权得到的归属** | **两种（`PortalStore`）** |
 *
 * ★ 收 `PortalStore` 而不是 `Database`：部门服务端可能连 MySQL，
 *   而本机库（`ingest` / `insertRecords`）**恒为同步 SQLite** —— 那条边界
 *   是类型级的，见 `portal-db.ts` 的模块注释。
 *
 * ## 幂等与归属的先后
 *
 * 用 `dialect.insertIgnore()`（SQLite `INSERT OR IGNORE` / MySQL `INSERT IGNORE`），
 * 冲突即跳过（`event_id` 是 PRIMARY KEY），两种后端的判据都是 `changes > 0`：
 * MySQL 的 `affectedRows` 在 `INSERT IGNORE` 撞主键时实测为 **0**，
 * 与 SQLite 的 `changes` 语义一致。
 *
 * ⚠️ 由此得到一个必须知道的语义：**同一条记录被两个上报方上报时，
 *   归属以先到的那条为准** —— 后到的因为主键冲突整行都不写，自然不会覆盖归属。
 *   这正是我们要的：插件与 CLI 可以在同一台机器上同时上报而无需协调。
 *
 * 返回的 `inserted` / `duplicates` 直接对应上报响应里的
 * `accepted` / `duplicates`（见 `shared/src/protocol.ts` 的 `IngestResponse`）。
 */
export async function insertAttributedRecords(
  store: PortalStore,
  records: IngestRecord[],
  owner: EventOwner,
): Promise<{ inserted: number; duplicates: number }> {
  const sql = `${portalDialect(store.kind).insertIgnore(EVENT_TABLE)}
     (event_id, session_id, seq, ts, provider, model, cwd,
      user_id, user_name, dept,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, turn, step)
     VALUES ($eventId, $sessionId, $seq, $ts, $provider, $model, $cwd,
             $userId, $userName, $dept,
             $input, $output, $cacheRead, $cacheWrite,
             $reasoning, $turn, $step)`

  let inserted = 0
  let duplicates = 0
  // 归属在整批里是同一个值：先在事务外算好，避免每行重复 ?? 判断
  const userId = owner.userId
  const userName = owner.userName ?? owner.userId
  const dept = owner.dept ?? null

  // ★ 整批一个事务（与迁移前一致）：两种后端都支持事务，
  //   半批写入会让客户端重试时多一次无谓的往返，也让「这一批到底进没进」
  //   在排障时变得难以回答。
  await store.transaction(async (tx) => {
    for (const rec of records) {
      const res = await tx.run(sql, {
        $eventId: rec.event_id,
        $sessionId: rec.session_id,
        $seq: rec.seq,
        $ts: rec.ts,
        $provider: rec.provider,
        $model: rec.model,
        $cwd: rec.cwd,
        $userId: userId,
        $userName: userName,
        $dept: dept,
        $input: rec.input_tokens,
        $output: rec.output_tokens,
        $cacheRead: rec.cache_read_tokens,
        $cacheWrite: rec.cache_write_tokens,
        $reasoning: rec.reasoning_tokens,
        $turn: rec.turn,
        $step: rec.step,
      })
      if (res.changes > 0) inserted++
      else duplicates++
    }
  })

  return { inserted, duplicates }
}