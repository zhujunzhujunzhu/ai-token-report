/**
 * 上报入口的有界异步 FIFO：只排请求任务，轮到执行才读取 JSON、鉴权和落库。
 * ★ 任务完成后才回 HTTP；内存排队不是投递成功，崩溃时客户端仍保留 pending。
 * 单消费者限制并发解析与写锁竞争，每批之间归还事件循环给查询与管理请求。
 */
import type { IngestQueueStatusResponse } from '@ai-token-report/shared'

export interface IngestQueueOptions {
  /** 包含正在处理的请求；等待者尚未读入/解析完整请求体。 */
  maxRequests?: number
  /** 仅限制等待，不能超时取消已开始的事务并误报提交结果。 */
  maxWaitMs?: number
}

export class IngestQueueUnavailable extends Error {}

interface Job {
  enqueuedAt: number
  work: () => Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export class IngestQueue {
  readonly maxRequests: number
  readonly maxWaitMs: number
  #pending: Job[] = []
  #active = false
  #closing = false
  #pumpScheduled = false
  #drain: Promise<void> | undefined
  #resolveDrain: (() => void) | undefined
  #completed = 0
  #rejected = 0
  #lastWaitMs = 0
  #lastProcessingMs = 0
  #lastCompletedAt: number | null = null

  constructor(options: IngestQueueOptions = {}) {
    this.maxRequests = options.maxRequests ?? 64
    this.maxWaitMs = options.maxWaitMs ?? 5_000
    for (const [name, value] of [['maxRequests', this.maxRequests], ['maxWaitMs', this.maxWaitMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error(`上报队列 ${name} 必须是正整数且不超过 2147483647`)
    }
  }

  run(work: () => Promise<void>): Promise<void> {
    if (this.#closing || this.#pending.length + Number(this.#active) >= this.maxRequests) {
      this.#rejected++
      return Promise.reject(new IngestQueueUnavailable(this.#closing ? '服务正在停止，请稍后重试上报' : '上报队列已满，请稍后重试'))
    }
    return new Promise<void>((resolve, reject) => {
      const job: Job = { enqueuedAt: Date.now(), work, resolve, reject }
      job.timer = setTimeout(() => {
        const index = this.#pending.indexOf(job)
        if (index < 0) return
        this.#pending.splice(index, 1)
        this.#rejected++
        reject(new IngestQueueUnavailable('上报排队超时，请稍后重试'))
        this.#finishDrain()
      }, this.maxWaitMs)
      this.#pending.push(job)
      this.#schedule()
    })
  }

  snapshot(): IngestQueueStatusResponse {
    return {
      scope: 'process', accepting: !this.#closing,
      active_requests: Number(this.#active), waiting_requests: this.#pending.length,
      max_requests: this.maxRequests, max_wait_ms: this.maxWaitMs,
      oldest_wait_ms: this.#pending.length ? Date.now() - this.#pending[0]!.enqueuedAt : 0,
      completed_requests: this.#completed, rejected_requests: this.#rejected,
      last_wait_ms: this.#lastWaitMs, last_processing_ms: this.#lastProcessingMs,
      last_completed_at: this.#lastCompletedAt,
    }
  }

  /** 停止接收新任务；已入队任务照常处理（仍受排队超时约束）。可重复调用。 */
  close(): Promise<void> {
    this.#closing = true
    this.#drain ??= new Promise<void>((resolve) => { this.#resolveDrain = resolve })
    this.#finishDrain()
    return this.#drain
  }

  #finishDrain(): void {
    if (!this.#active && this.#pending.length === 0) this.#resolveDrain?.()
  }

  #schedule(): void {
    if (this.#active || this.#pumpScheduled || this.#pending.length === 0) return
    this.#pumpScheduled = true
    // 不连成永不结束的 Promise 微任务链，否则一波补报会饿死健康检查与看板刷新。
    setTimeout(() => { this.#pumpScheduled = false; void this.#consume() }, 0)
  }

  async #consume(): Promise<void> {
    const job = this.#pending.shift()
    if (!job) { this.#finishDrain(); return }
    clearTimeout(job.timer)
    this.#active = true
    const started = Date.now()
    this.#lastWaitMs = started - job.enqueuedAt
    try { await job.work(); job.resolve() }
    catch (error) { job.reject(error) }
    finally {
      this.#active = false
      this.#completed++
      this.#lastProcessingMs = Date.now() - started
      this.#lastCompletedAt = Date.now()
      this.#schedule()
      this.#finishDrain()
    }
  }
}
