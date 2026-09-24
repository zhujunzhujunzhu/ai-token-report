/**
 * 上报器：内存队列 → 批量 → 磁盘 outbox → HTTP 投递。
 *
 * ## 🚨 热路径约束（改这个文件前必须理解）
 *
 * `enqueue()` 被 `TokenReportBackend.emit()` **同步**调用，而 `emit()`
 * 又在 `session/event` 的**热路径**上 —— 每一条会话事件都会走到这里。
 * 所以 `enqueue()` 只能做**内存 push**：一旦在里面 `await fetch`，
 * 用户会直接感觉到 agent 卡顿。
 *
 * 所有 IO（写盘、发请求、重试）都在**另一条异步链路**上（`#flush`），
 * 由「满 N 条」「定时器到期」「turn 结束」三个触发点驱动。
 *
 * ## 投递语义：at-least-once
 *
 * - 单次请求**不重试**，失败就整批留在 outbox，等下一个周期。
 *   内层指数退避 + 外层定时器两层重试叠加，只会让长尾更难预测。
 * - 服务端按 `event_id` 幂等，所以**重发永远安全**，
 *   我们只需要保证「不丢」——宁可重发，不可漏发。
 * - 任何异常都被吞掉并转成统计数字（`lastError`），
 *   **绝不让上报失败影响 agent loop**。
 */

import { join } from 'node:path'

import { SCHEMA_VERSION, type IngestResponse } from '@ai-token-report/shared'
import { resolveDshHome } from '@ai-token-report/core'

import type { EffectiveConfig } from './config.js'
import { toWireRecord, type BillingRecord, type FoldIdentity } from './fold.js'
import { Outbox, type OutboxStats } from './outbox.js'

/** 运行统计 —— 暴露给诊断工具，回答「我的数据到底发出去了没有」。 */
export interface ReporterStats {
  /** 已入队（采集到）的记录条数。 */
  enqueued: number
  /** 已成功投递（服务端 2xx）的记录条数。 */
  delivered: number
  /** 服务端判定为重复的条数（幂等去重，正常现象）。 */
  duplicates: number
  /** 服务端明确拒收的条数。 */
  rejected: number
  /** 还在内存队列里、尚未落盘的条数。 */
  queueLength: number
  /** 发起过的请求次数。 */
  requests: number
  /** 请求失败次数（含超时 / 非 2xx）。 */
  failures: number
  /** 最近一次成功投递时间（epoch ms），0 = 从未成功。 */
  lastSuccessAt: number
  /** 最近一次错误原文（已截断，**不含 appKey**）。 */
  lastError: string | null
  /** 磁盘 outbox 状态。 */
  outbox: OutboxStats
}

/**
 * 计数器本体。
 *
 * ★ 拆成独立对象，是为了让 `TokenReportBackend` 能把**同一份快照**
 *   既作为私有状态更新、又作为公开字段暴露 —— 见下面 `Reporter.stats` 的注释。
 */
class StatsKeeper {
  enqueued = 0
  delivered = 0
  duplicates = 0
  rejected = 0
  requests = 0
  failures = 0
  lastSuccessAt = 0
  lastError: string | null = null
}

export interface ReporterOptions {
  config: EffectiveConfig
  /** 折叠时用的身份（进 `client` 字段，服务端会忽略）。 */
  identity: FoldIdentity
  /** 注入用，便于测试。默认全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 注入用，便于测试观察诊断输出。 */
  onLog?: (level: 'info' | 'warn', message: string) => void
}

/** outbox 目录：默认与身份文件同级，便于「一键清理这台机器的插件数据」。 */
export function resolveOutboxDir(config: EffectiveConfig): string {
  if (config.outbox.dir) return config.outbox.dir
  return join(resolveDshHome(config.dshHome), 'token-report', 'outbox')
}

/** 把任意异常转成一句话（**不包含请求头，因此不会泄漏 appKey**）。 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 截断过长的错误文本，避免把整个 HTML 错误页写进日志。 */
function truncate(s: string, max = 300): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

/**
 * 批量上报器。
 *
 * 生命周期：`start()` 起定时器 → 持续 `enqueue()` → `shutdown()` 排空。
 */
export class Reporter {
  readonly #config: EffectiveConfig
  readonly #identity: FoldIdentity
  readonly #fetch: typeof fetch
  readonly #log: (level: 'info' | 'warn', message: string) => void
  readonly #outbox: Outbox | null
  /** 计数器集中在这里，便于整体读快照。 */
  readonly #stats = new StatsKeeper()

  /** 内存队列：`enqueue()` 只碰它。 */
  #queue: BillingRecord[] = []
  #timer: ReturnType<typeof setInterval> | null = null
  /** 是否有 flush 在跑 —— 防止定时器与「满 N 条」触发并发投递同一批。 */
  #flushing = false
  #closed = false

  /**
   * 读运行统计的入口 —— **既可直接调用，也可当作纯数据字段读**。
   *
   * 🚨 为什么挂一个带属性的函数而不是普通方法：
   *   cordis 的 `ctx.get(name)` 返回服务代理，而 JS **私有字段穿不过 Proxy**，
   *   任何 `this.#xxx` 的方法/取值器经代理调用都会抛
   *   `TypeError: Cannot access invalid private field`。
   *   这里在构造时就把 `#stats` 捕获进闭包并挂成**自有属性**，
   *   于是 `backend.reporterStats.enqueued` 与 `backend.reporterStats()` 都成立，
   *   且不需要宿主做任何绑定。
   *
   *   这不是理论风险：真实 cordis 装载冒烟（`verify/verify-cordis-load.ts`）
   *   连炸了两次才发现 —— 先是方法，后是 getter。
   */
  readonly stats: (() => ReporterStats) & ReporterStats

  constructor(options: ReporterOptions) {
    this.#config = options.config
    this.#identity = options.identity
    this.#fetch = options.fetchImpl ?? fetch
    this.#log = options.onLog ?? (() => {})

    // 闭包捕获私有状态，绕开 Proxy 对私有字段的限制。
    //
    // ⚠️ 用 `Object.defineProperties` 而不是 `Object.assign` + getter 字面量：
    //   `Object.assign` 会**立即求值** getter，把字段冻结成构造那一刻的 0。
    //   这是本仓真实踩过的坑（脱敏测试的 `effects` getter 同样栽在这里）。
    const read = (): ReporterStats => this.#snapshot()
    const field = (key: keyof ReporterStats): PropertyDescriptor => ({
      get: () => read()[key],
      enumerable: true,
      configurable: false,
    })

    this.stats = Object.defineProperties(read, {
      enqueued: field('enqueued'),
      delivered: field('delivered'),
      duplicates: field('duplicates'),
      rejected: field('rejected'),
      queueLength: field('queueLength'),
      requests: field('requests'),
      failures: field('failures'),
      lastSuccessAt: field('lastSuccessAt'),
      lastError: field('lastError'),
      outbox: field('outbox'),
    }) as (() => ReporterStats) & ReporterStats

    if (options.config.outbox.enabled) {
      this.#outbox = new Outbox({
        dir: resolveOutboxDir(options.config),
        maxBytes: options.config.outbox.maxBytes,
      })
      // ★ 启动时把上次崩溃留下的 inflight 捞回来 —— 这是「崩溃不丢」的兑现点
      const restored = this.#outbox.recover()
      if (restored > 0) {
        this.#log('info', `token-report: 上次异常退出，已恢复 ${restored} 批未确认的上报数据`)
      }
    } else {
      this.#outbox = null
    }
  }

  get outbox(): Outbox | null {
    return this.#outbox
  }

  /** 启动定时冲刷。 */
  start(): void {
    if (this.#timer !== null || this.#closed) return
    this.#timer = setInterval(() => {
      void this.flush()
    }, this.#config.batch.flushIntervalMillis)
    // 定时器不该把进程钉住：DSH 退出时我们靠 shutdown() 排空，而不是靠它续命
    this.#timer.unref?.()
  }

  /**
   * 入队一条计费记录。
   *
   * 🚨 **同步、O(1)、不抛错**。这是热路径上的唯一职责。
   */
  enqueue(record: BillingRecord): void {
    if (this.#closed) return
    this.#queue.push(record)
    this.#stats.enqueued += 1

    // 满一批立即触发，不必等定时器 —— 短会话也能及时上账
    if (this.#queue.length >= this.#config.batch.maxRecords) {
      void this.flush()
    }
  }

  /** turn 结束提示：把手上攒的发出去，让长会话的延迟从 10s 降到「每轮」。 */
  hintFlush(): void {
    if (this.#queue.length > 0) void this.flush()
  }

  /**
   * 一轮冲刷：内存队列 → outbox → HTTP。
   *
   * 顺序不可调换 —— 先把内存里的落盘，再发盘上的。
   * 反过来的话，恰好在这一刻崩溃就会丢掉整个内存队列。
   */
  async flush(): Promise<void> {
    if (this.#closed || this.#flushing) return
    this.#flushing = true
    try {
      // 1. 内存 → 磁盘（先落盘，再发送）
      if (this.#queue.length > 0 && this.#outbox) {
        const batch = this.#queue
        this.#queue = []
        this.#outbox.write(batch.map(toWireRecord))
      }

      // 2. 发送盘上的批次（含历史遗留）
      await this.#drainOutbox()
    } catch (err) {
      // flush 的任何异常都不许逃到调用方（它在 emit 的调用链上）
      this.#stats.failures += 1
      this.#stats.lastError = truncate(messageOf(err))
    } finally {
      this.#flushing = false
    }
  }

  /** 把 outbox 里的批次逐批发出去。 */
  async #drainOutbox(): Promise<void> {
    if (!this.#outbox) {
      // 没开 outbox（或磁盘不可写）时退化为「直接发内存队列」：
      // 仍然不能丢数据，只是失去了崩溃保护。
      if (this.#queue.length === 0) return
      const batch = this.#queue
      this.#queue = []
      const ok = await this.#post(batch.map(toWireRecord))
      if (!ok) {
        // 发失败就把记录塞回队列头部，等下一轮
        this.#queue = [...batch, ...this.#queue]
      }
      return
    }

    // 一次 flush 最多发 maxRecords 条，避免网络恢复后一次冲爆服务端
    const batches = this.#outbox.take(this.#config.batch.maxRecords)
    for (const batch of batches) {
      // 先标 inflight 再发：这一步之后崩溃，下次启动会捞回来重发
      this.#outbox.markInflight(batch.file)
      const ok = await this.#post(batch.records)
      if (ok) {
        this.#outbox.ack(batch.file)
      } else {
        this.#outbox.release(batch.file)
        // 失败就停手，不必把后面几批也撞一遍（网络多半整体不通）
        break
      }
    }
  }

  /**
   * 发一批记录。
   *
   * @returns 是否成功（服务端 2xx）。
   */
  async #post(records: Record<string, unknown>[]): Promise<boolean> {
    if (records.length === 0) return true

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      client: {
        name: this.#identity.clientName,
        userId: this.#identity.claimedUserId,
        ...(this.#identity.userName ? { userName: this.#identity.userName } : {}),
        ...(this.#identity.dept ? { dept: this.#identity.dept } : {}),
      },
      generatedAt: new Date().toISOString(),
      records,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#config.batch.timeoutMillis)
    this.#stats.requests += 1

    let res: Response
    try {
      res = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 🚨 appKey 只走请求头。写进 body 会落进服务端日志与数据库。
          Authorization: `Bearer ${this.#config.appKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (err) {
      this.#stats.failures += 1
      this.#stats.lastError =
        err instanceof Error && err.name === 'AbortError'
          ? `请求超时（${this.#config.batch.timeoutMillis}ms）`
          : truncate(messageOf(err))
      return false
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      this.#stats.failures += 1
      this.#stats.lastError = truncate(`HTTP ${res.status}${text ? ` — ${text}` : ''}`)
      return false
    }

    // 服务端如实返回三个计数时才采信；返回空体也视为成功（兼容只回 200 的实现）
    const raw = await res.text().catch(() => '')
    const counts = parseCounts(raw, records.length)
    this.#stats.delivered += counts.accepted
    this.#stats.duplicates += counts.duplicates
    this.#stats.rejected += counts.rejected
    this.#stats.lastSuccessAt = Date.now()
    this.#stats.lastError = null
    return true
  }

  /**
   * 排空并停止。
   *
   * 官方对 telemetry 后端的建议是给外层超时（OTel 后端用 3000ms）：
   * 退出时卡在这里比丢几条数据更让人难受，所以这里同样只等一轮。
   */
  async shutdown(): Promise<void> {
    if (this.#closed) return
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }

    // 最后一次尝试把内存队列落盘 —— 即使网络不通，数据也留在磁盘上等下次启动
    if (this.#queue.length > 0 && this.#outbox) {
      this.#outbox.write(this.#queue.map(toWireRecord))
      this.#queue = []
    }

    await this.flush()
    this.#closed = true
  }

  /** 取一次运行统计快照（公开面是上面的 `stats`）。 */
  #snapshot(): ReporterStats {
    const outbox = this.#outbox?.stats() ?? {
      pendingBatches: 0,
      pendingRecords: this.#queue.length,
      pendingBytes: 0,
      droppedBatches: 0,
    }
    return {
      enqueued: this.#stats.enqueued,
      delivered: this.#stats.delivered,
      duplicates: this.#stats.duplicates,
      rejected: this.#stats.rejected,
      queueLength: this.#queue.length,
      requests: this.#stats.requests,
      failures: this.#stats.failures,
      lastSuccessAt: this.#stats.lastSuccessAt,
      lastError: this.#stats.lastError,
      outbox,
    }
  }
}

/**
 * 解析服务端的三个计数。
 *
 * ⚠️ 缺失时**回退成「全部接受」**——与 CLI 的 `deliver.ts:147` 保持同一策略。
 *   服务端只回空体的实现在契约上是允许的，此时把它判成失败会导致无限重发。
 */
function parseCounts(raw: string, total: number): Pick<IngestResponse, 'accepted' | 'duplicates' | 'rejected'> {
  if (!raw.trim()) return { accepted: total, duplicates: 0, rejected: 0 }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { accepted: total, duplicates: 0, rejected: 0 }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  const n = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback

  return {
    accepted: n(obj['accepted'], total),
    duplicates: n(obj['duplicates'], 0),
    rejected: n(obj['rejected'], 0),
  }
}
