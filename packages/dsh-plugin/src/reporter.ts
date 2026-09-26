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
import { setImmediate as yieldToHost } from 'node:timers/promises'

import { SCHEMA_VERSION, type IngestResponse } from '@ai-token-report/shared'
import { resolveDshHome } from '@ai-token-report/core'

import type { EffectiveConfig } from './config.js'
import { toWireRecord, type BillingRecord, type FoldIdentity } from './fold.js'
import { Outbox, type OutboxStats } from './outbox.js'

/** 给一次编码/请求设硬边界；低于服务端 32 MiB 上限，并限制宿主的同步工作片段。 */
export const MAX_REPORT_BODY_BYTES = 1024 * 1024
const MAX_OUTBOX_BATCHES_PER_FLUSH = 50

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
  #queue: (BillingRecord | undefined)[] = []
  #queueHead = 0
  #timer: ReturnType<typeof setInterval> | null = null
  /** 共享正在进行的一轮，停机时必须真正等待它，而不是提前返回。 */
  #flushing: Promise<void> | null = null
  #shutdown: Promise<void> | null = null
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
    const field = (get: () => unknown): PropertyDescriptor => ({
      get,
      enumerable: true,
      configurable: false,
    })

    this.stats = Object.defineProperties(read, {
      // 🚨 generation 每 3 秒读 enqueued；标量 getter 不能顺带扫描整个 outbox。
      enqueued: field(() => this.#stats.enqueued),
      delivered: field(() => this.#stats.delivered),
      duplicates: field(() => this.#stats.duplicates),
      rejected: field(() => this.#stats.rejected),
      queueLength: field(() => this.#queueLength()),
      requests: field(() => this.#stats.requests),
      failures: field(() => this.#stats.failures),
      lastSuccessAt: field(() => this.#stats.lastSuccessAt),
      lastError: field(() => this.#stats.lastError),
      outbox: field(() => this.#outboxStats()),
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
    if (this.#closed || this.#shutdown) return
    this.#queue.push(record)
    this.#stats.enqueued += 1

    // 满一批立即触发，不必等定时器 —— 短会话也能及时上账
    if (this.#queueLength() >= this.#config.batch.maxRecords) {
      void this.flush()
    }
  }

  /** turn 结束提示：把手上攒的发出去，让长会话的延迟从 10s 降到「每轮」。 */
  hintFlush(): void {
    if (this.#queueLength() > 0) void this.flush()
  }

  /**
   * 一轮冲刷：内存队列 → outbox → HTTP。
   *
   * 顺序不可调换 —— 先把内存里的落盘，再发盘上的。
   * 反过来的话，恰好在这一刻崩溃就会丢掉整个内存队列。
   */
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#flushing) return this.#flushing
    // ★ async 函数在第一个 await 前仍同步执行。满批 enqueue 只能安排任务，
    // 不能因此在 agent 热路径里写盘、读整份 outbox 或调用 fetch。
    this.#flushing = Promise.resolve().then(() => this.#flushOnce()).finally(() => {
      this.#flushing = null
    })
    return this.#flushing
  }

  async #flushOnce(): Promise<void> {
    try {
      // 本轮只处理开始时的队列前缀，持续产生新事件不会把一次 flush 无限延长。
      const through = this.#queue.length
      let written = 0
      while (this.#outbox && this.#queueHead < through) {
        const batch = this.#memoryBatch(through, true)
        if (this.#outbox.write(batch) === null) {
          this.#log('warn', 'token-report: outbox 写入失败，本批暂存内存并尝试投递')
          break
        }
        this.#consume(batch.length)
        // 每次最多编码一小批，并定期让出事件循环，避免同步突发入队占住宿主。
        if (++written % 8 === 0) await yieldToHost()
      }

      // 2. 发送盘上的批次（含历史遗留）
      await this.#drainOutbox()
      // 3. 没有磁盘副本时，只在确认成功后消耗队头；失败不用复制整个积压数组。
      while (this.#queueHead < through) {
        const batch = this.#memoryBatch(through)
        if (!await this.#post(batch)) break
        this.#consume(batch.length)
      }
    } catch (err) {
      // flush 的任何异常都不许逃到调用方（它在 emit 的调用链上）
      this.#stats.failures += 1
      this.#stats.lastError = truncate(messageOf(err))
    } finally {
      // 仅在一轮末尾压缩一次，避免每发一批就 splice 整个队列而退化为平方复杂度。
      if (this.#queueHead > 0) {
        this.#queue = this.#queue.slice(this.#queueHead)
        this.#queueHead = 0
      }
    }
  }

  #queueLength(): number { return this.#queue.length - this.#queueHead }

  #consume(count: number): void {
    // 清掉已经持久化的对象引用，等待网络时不会让整个旧队列继续占着堆。
    for (let i = 0; i < count; i++) this.#queue[this.#queueHead++] = undefined
  }

  #memoryBatch(through: number, persistOversized = false): Record<string, unknown>[] {
    return this.#boundedBatch(through - this.#queueHead, i => toWireRecord(this.#queue[this.#queueHead + i]!), persistOversized)
  }

  #boundedBatch(available: number, recordAt: (index: number) => Record<string, unknown>, persistOversized = false): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = []
    let bytes = Buffer.byteLength(JSON.stringify(this.#payload([])))
    const limit = Math.max(1, Math.floor(this.#config.batch.maxRecords))
    for (let i = 0; i < Math.min(available, limit); i++) {
      const record = recordAt(i)
      const size = Buffer.byteLength(JSON.stringify(record)) + (records.length > 0 ? 1 : 0)
      if (bytes + size > MAX_REPORT_BODY_BYTES) {
        if (records.length > 0) break
        // 单条原子事件不能拆字段。允许先单独保存磁盘副本，但绝不发超限 HTTP。
        // 否则新增请求上限会把原本可恢复的记录永远留在易失内存里。
        if (persistOversized) { records.push(record); break }
        // 不能截断计费字段或删除这条记录；保留原副本，诊断明确说明无法发送的原因。
        throw new Error(`单条上报记录超过 ${MAX_REPORT_BODY_BYTES} 字节，保留记录等待处理`)
      }
      records.push(record)
      bytes += size
    }
    return records
  }

  /** 把 outbox 里的批次逐批发出去。 */
  async #drainOutbox(): Promise<void> {
    if (!this.#outbox) return
    for (let i = 0; i < MAX_OUTBOX_BATCHES_PER_FLUSH; i++) {
      // 按需读一批；网络断开时，不白白预读并解析后面的 49 批。
      const batch = this.#outbox.take(1)[0]
      if (!batch) break
      // 先标 inflight 再发：这一步之后崩溃，下次启动会捞回来重发
      if (!this.#outbox.markInflight(batch.file)) continue
      let ok = true
      try {
        // 老版本可能写过一个超大的文件：按新上限逐段发，全部确认才删源文件。
        for (let offset = 0; offset < batch.records.length;) {
          const part = this.#boundedBatch(batch.records.length - offset, n => batch.records[offset + n]!)
          if (!await this.#post(part)) { ok = false; break }
          offset += part.length
        }
      } catch (err) {
        this.#outbox.release(batch.file)
        throw err
      }
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

    const payload = this.#payload(records)
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > MAX_REPORT_BODY_BYTES) throw new Error('上报请求超过批次字节上限，保留待投递记录')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#config.batch.timeoutMillis)
    this.#stats.requests += 1

    try {
      const res = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 🚨 appKey 只走请求头。写进 body 会落进服务端日志与数据库。
          Authorization: `Bearer ${this.#config.appKey}`,
        },
        body,
        signal: controller.signal,
      })
      // ★ 超时覆盖整个响应体。只等响应头就清定时器，会让半截回执永远卡住 flush。
      const raw = await res.text()
      if (!res.ok) throw new Error(truncate(`HTTP ${res.status}${raw ? ` — ${raw}` : ''}`))
      const counts = parseCounts(raw, records.length)
      if (counts.rejected > 0) {
        this.#stats.rejected += counts.rejected
        throw new Error(`服务端拒收 ${counts.rejected} 条记录，保留整批等待重试`)
      }
      this.#stats.delivered += counts.accepted
      this.#stats.duplicates += counts.duplicates
      this.#stats.lastSuccessAt = Date.now()
      this.#stats.lastError = null
      return true
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
  }

  #payload(records: Record<string, unknown>[]) {
    return {
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
  }

  /**
   * 排空并停止。
   *
   * 官方对 telemetry 后端的建议是给外层超时（OTel 后端用 3000ms）：
   * 退出时卡在这里比丢几条数据更让人难受，所以这里同样只等一轮。
   */
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    if (this.#closed) return Promise.resolve()
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }

    this.#shutdown = (async () => {
      await this.flush()
      // flush 开始后可能又采集到一批；停机必须等前一轮结束，再保存这批。
      if (this.#queueLength() > 0) await this.flush()
      this.#closed = true
    })()
    return this.#shutdown
  }

  /** 取一次运行统计快照（公开面是上面的 `stats`）。 */
  #outboxStats(): OutboxStats {
    return this.#outbox?.stats() ?? {
      pendingBatches: 0,
      pendingRecords: this.#queueLength(),
      pendingBytes: 0,
      droppedBatches: 0,
    }
  }

  #snapshot(): ReporterStats {
    return {
      enqueued: this.#stats.enqueued,
      delivered: this.#stats.delivered,
      duplicates: this.#stats.duplicates,
      rejected: this.#stats.rejected,
      queueLength: this.#queueLength(),
      requests: this.#stats.requests,
      failures: this.#stats.failures,
      lastSuccessAt: this.#stats.lastSuccessAt,
      lastError: this.#stats.lastError,
      outbox: this.#outboxStats(),
    }
  }
}

/**
 * 解析服务端的三个计数。
 *
 * ★ HTTP 2xx 只说明请求走通，计数齐全且逐条对账才算投递确认。
 * 反向代理回 HTML 或响应中途断开时，绝不能删除唯一的 outbox 副本。
 */
function parseCounts(raw: string, total: number): Pick<IngestResponse, 'accepted' | 'duplicates' | 'rejected'> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('上报响应不是有效 JSON，保留待投递记录')
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('上报响应缺少有效计数，保留待投递记录')
  }
  const { accepted, duplicates, rejected } = parsed as Record<string, unknown>
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!valid(accepted) || !valid(duplicates) || !valid(rejected) || accepted + duplicates + rejected !== total) {
    throw new Error('上报响应计数与本批记录不符，保留待投递记录')
  }
  return { accepted, duplicates, rejected }
}
