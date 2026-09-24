/**
 * 本地统计门面 —— CLI 与本地服务共用的**唯一取数入口**。
 *
 * ## 两条路径，一个口径
 *
 * ```
 *              ┌─ SQL 路径（默认）: 增量 ingest → SQL 查询 → TokenCounts
 * 统计请求 ────┤
 *              └─ 直扫路径（降级）: scanAll → 内存聚合 → TokenCounts
 * ```
 *
 * 两条路径**产出的都是同一套 `TokenCounts`**，派生指标一律交给调用方
 * 用 `derive()` / `shared/metrics.ts` 计算。因此无论走哪条，
 * 页面与命令行的数字都逐位相同。
 *
 * ## 🚨 为什么必须有降级路径
 *
 * 本地库是**日志的派生物**，不是真值。以下情况都可能发生：
 *
 * | 情况 | 现象 |
 * |---|---|
 * | 磁盘满 / 权限变更 | 建库失败 |
 * | 库文件被其他工具写坏 | `SQLITE_CORRUPT` |
 * | 多进程并发写 | `SQLITE_BUSY` 超时 |
 *
 * 抛错会让本地页白屏、CLI 直接失败 —— 而用户只是想看个数字。
 * 降级为直扫日志虽然慢（实测 15.7 秒），但**结果是正确的**，
 * 这远好过「打不开」。这与仓库既定的「解析失败要降级不要抛错」一致。
 *
 * ## 新鲜度：ingest 前置
 *
 * 每次取数前先跑一次增量 `ingest()`。热态下 L1 让所有文件零解压跳过，
 * 实测只需 ~9 ms（196 次 stat），因此可以把「库比日志旧」的窗口
 * 压到一次请求之内 —— 直扫路径最被称道的「天然最新」得以保留。
 *
 * ## 用法
 *
 * ```ts
 * const s = await openStats({ sessionsRoot, dbPath, period: 'today' })
 * try {
 *   const total = s.totals()              // TokenCounts（四项独立）
 *   const rows  = s.groups('provider')    // 分组
 *   const pts   = s.series('day')         // 时间序列（含补零）
 * } finally {
 *   s.close()
 * }
 * ```
 */

import type { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'

import { aggregate, timeSeries, totalOf, type GroupDimension, type GroupRow } from '../aggregate.js'
import { resolveRange } from '../range.js'
import { scanAll } from '../scanner.js'
import type { ScanDiagnostics, TokenCounts, UsageRecord } from '../types.js'
import { ingest, openDatabaseForIngest, readWatermarks } from './ingest.js'
import {
  queryGroups,
  queryRecords,
  queryDbStats,
  queryScanDiagnostics,
  querySessionCount,
  querySeries,
  queryTotals,
} from './query.js'

/** 数据源模式。 */
export type StatsSource = 'sql' | 'scan'

/** 打开统计会话的选项。 */
export interface OpenStatsOptions {
  /** 会话日志根目录。 */
  sessionsRoot: string
  /** 本地库路径。 */
  dbPath: string
  /** 具名周期（与 CLI `--period` 同义）。缺省 = 全部时间。 */
  period?: string
  /** 显式起始 / 结束（epoch ms），优先于 `period`。 */
  sinceMs?: number
  untilMs?: number
  /** provider 子串匹配（大小写不敏感）。 */
  providers?: string[]
  /** model 子串匹配。 */
  models?: string[]
  /** 强制走直扫日志（`--no-db`，用于对照验证）。 */
  forceScan?: boolean
  /** 进度回调（长扫描时给终端反馈）。 */
  onProgress?: (done: number, total: number, file: string) => void
  /** 只读模式：跳过 ingest，不写库（供验证脚本用）。 */
  readOnly?: boolean
}

/**
 * 一个已就绪的统计会话。
 *
 * 持有库连接（sql 路径）或全量记录（scan 路径），提供统一的查询方法。
 * **用完必须 `close()`** —— 否则 WAL 文件不会回收。
 */
export class StatsSession {
  readonly source: StatsSource
  readonly scannedAt: number
  /** 降级原因。仅在确实发生过失败时存在。 */
  readonly degradedReason?: string
  /** 解析后的时间窗标签（供页面/终端显示口径）。 */
  readonly rangeLabel: string
  readonly sinceMs?: number
  readonly untilMs?: number
  /** 库路径（sql 路径才有）。 */
  readonly dbPath?: string

  readonly #providers: string[]
  readonly #models: string[]
  /** sql 路径下的库连接。 */
  #db: Database | null = null
  /** scan 路径下的全量记录。 */
  #records: UsageRecord[] | null = null
  #sessions: number
  #diagnostics: ScanDiagnostics | null
  #closed = false

  // ★ 构造函数刻意公开：`StatsSession` 的两个工厂（`openStats` 的
  //   SQL 分支与 `scanPath` 降级分支）都需要构造它，而它们不是静态方法。
  //   把构造逻辑收敛在 `openStats` 里、用文档说明「不要直接 new」，
  //   比为了封住构造函数把两条分支塞进同一个巨型函数要好维护。
  constructor(init: {
    source: StatsSource
    scannedAt: number
    degradedReason?: string
    rangeLabel: string
    sinceMs?: number
    untilMs?: number
    dbPath?: string
    providers: string[]
    models: string[]
    db: Database | null
    records: UsageRecord[] | null
    sessions: number
    diagnostics: ScanDiagnostics | null
  }) {
    this.source = init.source
    this.scannedAt = init.scannedAt
    if (init.degradedReason) this.degradedReason = init.degradedReason
    this.rangeLabel = init.rangeLabel
    if (init.sinceMs !== undefined) this.sinceMs = init.sinceMs
    if (init.untilMs !== undefined) this.untilMs = init.untilMs
    if (init.dbPath) this.dbPath = init.dbPath
    this.#providers = init.providers
    this.#models = init.models
    this.#db = init.db
    this.#records = init.records
    this.#sessions = init.sessions
    this.#diagnostics = init.diagnostics
  }

  /** 查询过滤条件（子串匹配数组只在非空时带上）。 */
  #filter(): {
    sinceMs?: number
    untilMs?: number
    providers?: string[]
    models?: string[]
  } {
    return {
      ...(this.sinceMs !== undefined ? { sinceMs: this.sinceMs } : {}),
      ...(this.untilMs !== undefined ? { untilMs: this.untilMs } : {}),
      ...(this.#providers.length > 0 ? { providers: this.#providers } : {}),
      ...(this.#models.length > 0 ? { models: this.#models } : {}),
    }
  }

  /** 涉及的会话数（按当前过滤条件去重）。 */
  get sessions(): number {
    return this.#sessions
  }

  /** 诊断信息。scan 路径总有；sql 路径为 null（诊断见 `dbDiagnostics()`）。 */
  get diagnostics(): ScanDiagnostics | null {
    return this.#diagnostics
  }

  /** 总计（四项独立 + calls）。派生指标请用 `derive()`。 */
  totals(): TokenCounts {
    if (this.#db) return queryTotals(this.#db, this.#filter())
    return totalOf(this.#records ?? [])
  }

  /**
   * 分组聚合。
   *
   * 两条路径都返回 `GroupRow[]` 同构结果，且排序规则一致
   * （时间维度升序、其余按用量降序）。
   */
  groups(dim: GroupDimension): GroupRow[] {
    if (this.#db) {
      return queryGroups(this.#db, dim, this.#filter()).map((r) => ({
        key: r.key,
        counts: r.counts,
        // metrics 由调用方用 derive() 计算；这里先给零值占位，
        // 避免 core/db 自己实现一遍公式（铁律 1）。
        metrics: derivePlaceholder(),
        firstTime: r.firstTime,
        lastTime: r.lastTime,
        sessions: r.sessions,
      }))
    }
    return aggregate(this.#records ?? [], dim)
  }

  /**
   * 时间序列。
   *
   * ⚠️ SQL 路径**也要补零**，且规则必须与 `timeSeries()` 完全一致。
   *   这里直接复用 `timeSeries()` 的补零逻辑（把 SQL 的桶喂进去），
   *   而不是重写一遍 —— 否则会出现「命令行 30 个点、页面 4 个点」。
   */
  series(granularity: 'day' | 'hour', fillGaps = true): { bucket: string; counts: TokenCounts }[] {
    if (this.#db) {
      const points = querySeries(this.#db, granularity, this.#filter())
      if (!fillGaps) return points
      return fillGapsFor(points, granularity)
    }
    return timeSeries(this.#records ?? [], granularity, fillGaps).map((p) => ({
      bucket: p.bucket,
      counts: p.counts,
    }))
  }

  /**
   * 物化全部记录。
   *
   * `crossTabRanked()` 等能力目前只接受 `UsageRecord[]`（CLI 的 `--cross` 走这条）。
   * 实测 16,021 条约 20 ms，可接受。
   */
  records(): UsageRecord[] {
    if (this.#db) return queryRecords(this.#db, this.#filter()) as UsageRecord[]
    return this.#records ?? []
  }

  /** 库侧诊断（sql 路径）。scan 路径返回 null。 */
  dbDiagnostics(): ReturnType<typeof queryDbStats> | null {
    return this.#db ? queryDbStats(this.#db) : null
  }

  /**
   * 上次 ingest 期间观察到的解析诊断（sql 路径）。
   *
   * 与 `diagnostics` 的区别：`diagnostics` 只在**本进程本轮扫描过**时才有值，
   * 而这个是**从库里读回上一轮 ingest 记录下来的**，因此热态请求
   * （全部文件被 L1 跳过、本轮无扫描）也能拿到有意义的数字。
   *
   * scan 路径返回 null —— 那条路径直接用 `diagnostics` 即可。
   */
  scanDiagnostics(): ReturnType<typeof queryScanDiagnostics> | null {
    return this.#db ? queryScanDiagnostics(this.#db) : null
  }

  /** 关闭底层连接。可重复调用。 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#db?.close()
    this.#db = null
    this.#records = null
  }
}

/**
 * 打开统计会话。
 *
 * 默认走 SQL：先增量 ingest（保证新鲜），再查库。
 * **任何一步失败都降级为直扫日志**，并把原因带在 `degradedReason` 上
 * —— 静默降级会让人以为「库没生效」，带上原因才能排查。
 */
export async function openStats(opts: OpenStatsOptions): Promise<StatsSession> {
  const range = resolveRange({
    ...(opts.period ? { period: opts.period } : {}),
  })
  // 显式 since/until 覆盖 period（与 CLI 的 --since/--until 语义一致）
  const sinceMs = opts.sinceMs ?? range.sinceMs
  const untilMs = opts.untilMs ?? range.untilMs
  const rangeLabel = range.label

  const providers = opts.providers ?? []
  const models = opts.models ?? []

  // ── 直扫路径（显式强制，或作为降级目标）──────────────────────────
  const scanPath = async (degradedReason?: string): Promise<StatsSession> => {
    const { records, sessions, diagnostics } = await scanAll(opts.sessionsRoot, {
      providers,
      models,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(untilMs !== undefined ? { untilMs } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
    return new StatsSession({
      source: 'scan',
      ...(degradedReason ? { degradedReason } : {}),
      scannedAt: Date.now(),
      rangeLabel,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(untilMs !== undefined ? { untilMs } : {}),
      providers,
      models,
      db: null,
      records,
      // ★ 与 SQL 路径一致：按过滤后的记录去重，而不是用文件数。
      //   文件数会包含「有文件但这段时间没调用」的会话，让卡片虚高。
      sessions: new Set(records.map((r) => r.sessionId)).size,
      diagnostics,
    })
  }

  if (opts.forceScan) return scanPath()

  let db: Database
  try {
    db = openDatabaseForIngest(opts.dbPath)
  } catch (err) {
    return scanPath(`本地库不可用，已降级为直扫日志：${msg(err)}`)
  }

  try {
    if (!opts.readOnly) {
      // ★ ingest 前置：热态约 9 ms，把「库旧于日志」的窗口压到最小
      await ingest({
        sessionsRoot: opts.sessionsRoot,
        dbPath: opts.dbPath,
        db,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      })
    }

    const filter = {
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(untilMs !== undefined ? { untilMs } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(models.length > 0 ? { models } : {}),
    }

    return new StatsSession({
      source: 'sql',
      scannedAt: Date.now(),
      rangeLabel,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(untilMs !== undefined ? { untilMs } : {}),
      dbPath: opts.dbPath,
      providers,
      models,
      db,
      records: null,
      sessions: querySessionCount(db, filter),
      diagnostics: null,
    })
  } catch (err) {
    // 库不可用 ⇒ 降级直扫。原因必须带出去，否则用户无法判断
    // 「这次慢」是因为库坏了还是因为日志真的变大了。
    try {
      db.close()
    } catch {
      /* 关闭失败不影响降级 */
    }
    return scanPath(`本地库不可用，已降级为直扫日志：${msg(err)}`)
  }
}

/**
 * 给 SQL 路径的时间序列补零，规则与 `aggregate.ts` 的 `timeSeries()` 一致。
 *
 * ⚠️ 刻意**不重写**补零算法，而是构造一批「只有桶键」的占位记录喂给
 *   `timeSeries()` —— 这样补零逻辑只有一份实现，两条路径永远不会分叉。
 *   占位记录用零计数，因此对结果没有贡献，只是让 `timeSeries()` 知道
 *   有哪些桶存在。
 */
function fillGapsFor(
  points: { bucket: string; counts: TokenCounts }[],
  granularity: 'day' | 'hour',
): { bucket: string; counts: TokenCounts }[] {
  if (points.length < 2) return points

  const byBucket = new Map(points.map((p) => [p.bucket, p.counts]))
  // 用桶键还原成最小可解析的时间戳，交给 timeSeries 生成连续区间
  const stamps = points.map((p) => bucketToTime(p.bucket, granularity)).filter((t) => t !== null)
  if (stamps.length < 2) return points

  // 占位记录：只有 time，usage 全零 —— 只为让 timeSeries 看到桶的存在
  const placeholders: UsageRecord[] = stamps.map((t, i) => ({
    eventId: `placeholder:${i}`,
    sessionId: 'placeholder',
    seq: i,
    time: t,
    provider: '',
    model: '',
    cwd: null,
    turn: null,
    step: null,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      calls: 0,
    },
  }))

  const skeleton = timeSeries(placeholders, granularity, true)
  return skeleton.map((p) => ({
    bucket: p.bucket,
    counts: byBucket.get(p.bucket) ?? zeroCounts(),
  }))
}

/** 桶键 → epoch ms（本地时区）。 */
function bucketToTime(bucket: string, granularity: 'day' | 'hour'): number | null {
  if (granularity === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket)
    if (!m) return null
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(bucket)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime()
}

function zeroCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: 0 }
}

/**
 * `GroupRow.metrics` 的占位值。
 *
 * 🚨 这里刻意返回全零而不是真实指标：`GroupRow` 结构要求 `metrics` 字段，
 *   但**公式必须由 `shared/src/metrics.ts` 计算**（铁律 1）。
 *   调用方拿到 `counts` 后应自行 `derive(counts)`。
 *   若在 core/db 里算一遍，就出现了第二个口径实现。
 */
function derivePlaceholder(): GroupRow['metrics'] {
  return {
    cacheHitRate: 0,
    cacheShareOfTotal: 0,
    avgTokensPerCall: 0,
    avgOutputPerCall: 0,
    cacheLeverage: 0,
  }
}

/**
 * 打开一个长期持有的库连接（供本地服务复用）。
 *
 * 与服务端缓存配合：连接只开一次，避免每个请求都付一次
 * 打开 + PRAGMA 的成本。
 */
export function openStatsDb(dbPath: string): Database {
  return openDatabaseForIngest(dbPath)
}

/**
 * 删除本地库（`dsh-token --reset-db`）。库不存在时静默成功。
 *
 * ⚠️ **Windows 上 `close()` 之后文件句柄不会立即释放** —— SQLite 的
 *   WAL / 共享内存映射仍挂在进程上，紧接着 `unlink` 会抛
 *   `EBUSY: resource busy or locked`。这与 `state.ts` 里 `resetState()`
 *   的处境不同（那是纯文件写入，没有 mmap），所以那里不需要重试。
 *
 * 因此这里是 **async** 并把重试之间**真正让出事件循环**（`await sleep`）——
 * 同步的紧凑重试在同一个 tick 里跑完，句柄根本没机会释放，实测必然失败。
 *
 * 删除顺序是「先 WAL/SHM、后主库」：先移除附属文件能显著提高主库的
 * 删除成功率。附属文件删不掉不影响正确性（SQLite 下次打开会自行处理），
 * 但**主库删不掉必须抛错** —— 否则用户以为重置成功、实际仍在读旧数据。
 */
export async function resetDb(dbPath: string): Promise<void> {
  const targets = [`${dbPath}-wal`, `${dbPath}-shm`, dbPath] as const

  for (const target of targets) {
    const isPrimary = target === dbPath
    let lastErr: unknown = null

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(target, { force: true })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        // 让出事件循环：Windows 需要真实的时间流逝才能回收 mmap 句柄
        await sleep(20)
      }
    }

    // 主库删不掉必须让调用方知道（重置没生效 ≠ 重置成功）
    if (lastErr !== null && isPrimary) throw lastErr
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读水位线（供测试与诊断）。 */
export { readWatermarks }

/** 解析具名周期为时间窗 —— 与 CLI `--period` 是同一个函数。 */
export function resolveWindow(period?: string): ReturnType<typeof resolveRange> {
  return resolveRange(period ? { period } : {})
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}