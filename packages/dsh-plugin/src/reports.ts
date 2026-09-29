/**
 * 上报调试面（宿主半）—— 把「刚刚到底发了什么」端到插件的设置页。
 *
 * ## 为什么值得单独一条路由
 *
 * 上报是**无人值守**的。用户能观察到的唯一现象是「部门看板上没有我的数」，
 * 而原因可能有一长串：没署名、地址写错、appKey 过期、服务端 401、
 * outbox 积压、历史补报还没跑完。在此之前这些都只能靠翻进程日志，
 * 而 DSH 的日志滚动很快，也不在用户面前。
 *
 * 这条路由把四件事一次说清：
 *
 * 1. **在不在跑** —— `reporting`（含没跑的原因）
 * 2. **发了多少** —— `stats`（入队 / 投递 / 待投递 / 失败）
 * 3. **发出了什么** —— `recent`（每次请求的**请求体原文** + 服务端回执）
 * 4. **历史补齐到哪了** —— `backfill`
 *
 * ## 🚨 凭证边界
 *
 * 响应体里**只有请求体与回执，没有请求头**。appKey 走
 * `Authorization: Bearer`，`ReportLog` 只记 `payload` 字段，
 * 所以这条路由天然不含凭证。**不要**为了「方便排查」把 headers 顺手塞进来 ——
 * 那会让一个调试页变成凭证泄漏面。
 */

import type { EffectiveConfig } from './config.js'
import type { BackfillStats } from './backfill-runner.js'
import type { ReportAttempt } from './report-log.js'
import type { ReporterPreview, ReporterStats } from './reporter.js'
import type {
  UiReportActionResult,
  UiReportsPayload,
  UiReportingStatus,
} from './client/protocol.js'

/** 调试面需要的宿主能力（`ReportRuntime` 结构上满足它；测试可以传桩）。 */
export interface ReportsHost {
  config(): EffectiveConfig
  status(): UiReportingStatus
  identity(): { name: string; group?: string } | null
  stats(): ReporterStats | null
  backfillStats(): BackfillStats
  /** 上报实录，**新的在前**。 */
  attempts(): ReportAttempt[]
  flush(): Promise<void>
  preview(): ReporterPreview
}

export interface ReportsHandlerOptions {
  /**
   * 「立即上报」的等待上限（毫秒）。
   *
   * ★ 必须有：服务端不可达时 `flush()` 要等到连接超时，而用户点的是
   *   「立即上报」，不是在等一个挂死的请求。超时只是**这次响应**不再等 ——
   *   投递本身仍在后台继续（结果会出现在下一次刷新里）。
   */
  flushTimeoutMs?: number
}

const DEFAULT_FLUSH_TIMEOUT_MS = 20_000

/** 组装响应体。**这里不做任何口径计算**，只是搬运。 */
export function toReportsPayload(host: ReportsHost): UiReportsPayload {
  const config = host.config()
  const stats = host.stats()
  const backfill = host.backfillStats()
  return {
    reporting: host.status(),
    name: config.name,
    flushIntervalMillis: config.batch.flushIntervalMillis,
    maxRecords: config.batch.maxRecords,
    timeoutMillis: config.batch.timeoutMillis,
    outboxEnabled: config.outbox.enabled,
    identity: host.identity(),
    stats:
      stats === null
        ? null
        : {
            enqueued: stats.enqueued,
            delivered: stats.delivered,
            duplicates: stats.duplicates,
            rejected: stats.rejected,
            queueLength: stats.queueLength,
            requests: stats.requests,
            failures: stats.failures,
            lastSuccessAt: stats.lastSuccessAt,
            lastError: stats.lastError,
            // 嵌套原样搬运，不做扁平化：形状与 `ReporterStats` 一致，
            // 少一次转换就少一处「字段名对不上」的机会。
            outbox: {
              pendingBatches: stats.outbox.pendingBatches,
              pendingRecords: stats.outbox.pendingRecords,
              pendingBytes: stats.outbox.pendingBytes,
              droppedBatches: stats.outbox.droppedBatches,
            },
          },
    backfill: {
      status: backfill.status,
      filesTotal: backfill.filesTotal,
      filesProcessed: backfill.filesProcessed,
      confirmed: backfill.confirmed,
      accepted: backfill.accepted,
      duplicates: backfill.duplicates,
      lastError: backfill.lastError,
    },
    recent: host.attempts(),
  }
}

/**
 * 造一条调试路由的处理器。
 *
 * GET 读状态；POST 触发两个动作：
 * - `flush`   —— 立即把手上攒的发出去（真实投递）
 * - `preview` —— 只回「下一批会发出去什么」，**不发送、不落盘、不消耗队列**
 */
export function createReportsHandler(
  host: ReportsHost,
  options: ReportsHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  return async (request) => {
    if (request.method === 'GET') return json(toReportsPayload(host))
    if (request.method !== 'POST') return json({ ok: false, reason: '不支持的请求方法' }, 405)

    let action: unknown
    try {
      action = (await request.json() as Record<string, unknown>)['action']
    } catch {
      return json({ ok: false, reason: '请求体不是合法 JSON' })
    }

    if (action === 'preview') {
      const result = host.preview()
      if (!result.ok) return json({ ok: false, reason: result.reason } satisfies UiReportActionResult)
      return json({
        ok: true,
        preview: {
          body: result.body,
          records: result.records,
          source: result.source,
          bytes: Buffer.byteLength(result.body),
        },
      } satisfies UiReportActionResult)
    }

    if (action === 'flush') {
      const outcome = await raceFlush(host, flushTimeoutMs)
      return json(
        outcome === 'timeout'
          ? { ok: true, reason: '上报仍在进行中（服务端未在上限内回应），稍后刷新即可看到结果' }
          : { ok: true },
      )
    }

    return json({ ok: false, reason: `未知动作 ${JSON.stringify(action)}` })
  }
}

/** 等一次冲刷，但**不让请求挂死**。 */
async function raceFlush(host: ReportsHost, timeoutMs: number): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      host.flush().then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}