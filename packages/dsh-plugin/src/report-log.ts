/**
 * 上报实录（环形缓冲）—— 插件设置页「上报调试」的数据来源。
 *
 * ## 为什么需要它
 *
 * 上报是无人值守的：用户唯一能观察到的现象是「部门看板上没有我的数」。
 * 而可能的原因有很长一串（没署名、地址写错、服务端 401、outbox 积压、
 * 历史补报还没跑完）。在此之前，这些事实只存在于进程日志里，
 * 而 DSH 的日志滚动很快、也不在用户面前。
 *
 * 于是这里在**投递出口**留一份最近若干次请求的实录：发给了哪个地址、
 * 带了几条记录、请求体长什么样、服务端怎么回的。用户点开调试页就能看到。
 *
 * ## 三条边界（改这个文件前先读）
 *
 * 1. 🚨 **只存请求体，绝不存请求头**。appKey 走 `Authorization: Bearer`，
 *    一旦被顺手记进来，这个「方便排查」的功能就变成了凭证泄漏面。
 *    实录里的 `payload` 一律是 `JSON.stringify(#payload(records))` 的结果。
 * 2. **内存必须有硬上限**。单批请求体上限是 1 MiB，默认间隔 10 秒 ——
 *    不设上限的话，一个通宵就能把宿主进程的堆撑成几百 MB。
 *    这里三层都封：条数、单条载荷、总量。
 * 3. **不参与任何口径**。这些都是「发了什么」的搬运，不是统计。
 */

/** 一次真实上报尝试（成功或失败）的实录。 */
export interface ReportAttempt {
  /** 该次请求的发起时刻（epoch 毫秒）。 */
  at: number
  /** 服务端 2xx 且计数对得上 = `true`。 */
  ok: boolean
  /** 这批记录来自内存队列还是磁盘 outbox。 */
  source: 'queue' | 'outbox'
  /** 本批记录条数。 */
  records: number
  /** **未截断前**的请求体字节数。 */
  bytes: number
  accepted: number
  duplicates: number
  rejected: number
  /** HTTP 状态码；请求根本没发出去（DNS/超时）时为 `null`。 */
  httpStatus: number | null
  /** 失败原因（已截断，**不含 appKey**）。 */
  error: string | null
  /** 请求体原文（可能被截断，见 `truncated`）。 */
  payload: string
  /** 请求体是否被截断。截断了必须如实说，不能让用户以为看到的就是全部。 */
  truncated: boolean
}

/** 默认上限：条数 / 单条载荷 / 总量。 */
export const REPORT_LOG_LIMITS = {
  maxEntries: 20,
  maxPayloadBytes: 96 * 1024,
  maxTotalBytes: 512 * 1024,
} as const

export interface ReportLogOptions {
  maxEntries?: number
  maxPayloadBytes?: number
  maxTotalBytes?: number
}

/**
 * 只保留最近 N 条的小环形缓冲。
 *
 * ★ 保留顺序是「新的在前」：用户点开调试页想看的是**刚才那次**，
 *   而不是二十次之前那次。排序在这里做一次，页面就不用再排。
 */
export class ReportLog {
  readonly #maxEntries: number
  readonly #maxPayloadBytes: number
  readonly #maxTotalBytes: number
  /** 内部按时间正序追加，读取时反转；这样淘汰最旧的那条是 O(1) 的 `shift`。 */
  #entries: ReportAttempt[] = []
  #bytes = 0

  constructor(options: ReportLogOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? REPORT_LOG_LIMITS.maxEntries)
    this.#maxPayloadBytes = Math.max(0, options.maxPayloadBytes ?? REPORT_LOG_LIMITS.maxPayloadBytes)
    this.#maxTotalBytes = Math.max(0, options.maxTotalBytes ?? REPORT_LOG_LIMITS.maxTotalBytes)
  }

  /**
   * 记一次尝试。
   *
   * 🚨 这个方法在**投递链路上**被调用（`Reporter.#post` 的 `finally`）。
   *   所以它必须：同步、O(1) 摊还、**绝不抛错** ——
   *   调试记录失败不能反过来把一次成功的上报判成失败。
   */
  record(attempt: Omit<ReportAttempt, 'payload' | 'truncated'> & { payload: string }): void {
    try {
      const payload = this.#clip(attempt.payload)
      const entry: ReportAttempt = {
        ...attempt,
        payload: payload.text,
        truncated: payload.truncated,
      }
      const size = Buffer.byteLength(entry.payload)
      this.#entries.push(entry)
      this.#bytes += size
      // 条数与总量双封：只封条数时，20 条 × 96 KiB 仍有近 2 MB 常驻。
      // 至少留一条 —— 调试页看到「刚刚那一条」比看到空白有用。
      while (this.#entries.length > this.#maxEntries || (this.#bytes > this.#maxTotalBytes && this.#entries.length > 1)) {
        const removed = this.#entries.shift()
        if (removed === undefined) break
        this.#bytes -= Buffer.byteLength(removed.payload)
      }
      if (this.#bytes < 0) this.#bytes = 0
    } catch {
      // 记不下来就算了 —— 这里唯一不能做的事是把异常抛回投递链路。
    }
  }

  /** 最近的上报实录，**新的在前**。返回的是浅拷贝，调用方改不动内部状态。 */
  list(): ReportAttempt[] {
    return [...this.#entries].reverse()
  }

  clear(): void {
    this.#entries = []
    this.#bytes = 0
  }

  #clip(text: string): { text: string; truncated: boolean } {
    if (this.#maxPayloadBytes <= 0) return { text: '', truncated: text !== '' }
    if (Buffer.byteLength(text) <= this.#maxPayloadBytes) return { text, truncated: false }
    // 按字节截断，但从**字符边界**收口：直接 `toString()` 一个切在半路的
    // UTF-8 序列会得到 U+FFFD，用户看到的就是一串乱码 ——
    // 而请求体里的模型名、路径都可能是中文。
    const buffer = Buffer.from(text, 'utf8').subarray(0, this.#maxPayloadBytes)
    let end = buffer.length
    if (end > 0) {
      // 回退到最后一个完整的 UTF-8 字符之后
      while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1
      const lead = end > 0 ? buffer[end - 1]! : 0
      const need = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (buffer.length - (end - 1) < need) end -= 1
    }
    return { text: `${buffer.subarray(0, end).toString('utf8')}\n…（请求体过大，已截断）`, truncated: true }
  }
}