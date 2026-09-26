/**
 * 磁盘 outbox：**崩溃不丢**的那一环。
 *
 * ## 为什么必须自己写
 *
 * DSH 官方对 telemetry 投递的定性是 **best-effort** ——
 * coordinator 的游标记的是「已交出」，不是「已送达」
 * （见 `@deepseek-ai/dsh-session-telemetry` 的模块注释）。
 * 也就是说：进程在批量发送之前崩掉，那批记录**不会有人替你补**。
 *
 * ## 设计：两种文件，一次 rename
 *
 * ```
 * <dir>/pending-<ts>-<pid>-<n>.jsonl   ← 新攒的批，还没发
 * <dir>/inflight-<ts>-<pid>-<n>.jsonl  ← 已发出但还没收到响应
 * ```
 *
 * - **先落 pending，再发请求**：发送前那一瞬间崩溃，数据已经在磁盘上。
 * - **发送前 rename 成 inflight**：明确标记「这批可能已经到服务端了」。
 * - **收到成功响应后删除 inflight**：投递完成。
 * - **启动时把 inflight 改回 pending 并重放**：崩溃/断电后自动补发。
 *
 * 重放会不会重复上账？**不会。** 幂等键 `event_id = sessionId:seq` 由服务端
 * `ON CONFLICT DO NOTHING` 去重，所以**宁可重发，不可漏发** ——
 * 这与 `core/state.ts` 的 pending 语义、CLI `report` 的重试语义完全一致。
 *
 * ## 为什么不用单个大 JSON 数组
 *
 * 一个文件里存所有记录时，每次追加都要「读全文 → 改 → 原子写回」，
 * 批量一大就是几十毫秒的同步 IO，而它在**投递线程**上，会拖慢整个队列。
 * 一批一个文件是 append-once 的，写完即完，不需要回读。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 未发送批次的前缀。 */
const PENDING_PREFIX = 'pending-'
/** 已发送、等待回执批次的前缀。 */
const INFLIGHT_PREFIX = 'inflight-'
/** 文件后缀。 */
const SUFFIX = '.jsonl'
const RECONCILE_INTERVAL_MS = 30_000

/** 一个待投递批次。 */
export interface OutboxBatch {
  /** 文件名（不含目录）。回执时用它来删除/改名。 */
  file: string
  /** 该批的记录（**线上格式**，下划线字段，见 `fold.ts` 的 `toWireRecord`）。 */
  records: Record<string, unknown>[]
}

/** outbox 运行状态，暴露出来便于诊断。 */
export interface OutboxStats {
  /** 当前待投递的批次数。 */
  pendingBatches: number
  /** 当前待投递的记录条数。 */
  pendingRecords: number
  /** 待投递内容的总字节数。 */
  pendingBytes: number
  /** 因超过上限被丢弃的批次数（累计，进程内）。 */
  droppedBatches: number
}

interface BatchMeta { bytes: number; records: number; mtimeMs: number }

/**
 * JSONL outbox。元数据随本实例的写入、确认和丢弃增量维护。
 *
 * ★ 方法仍在宿主线程同步执行，不能在 emit 的调用栈里调用。
 * 目录戳变化时只读取新文件；每 30 秒核对已有文件，兜住另一个进程的
 * 原地修改、时间戳精度及检查与写入之间的竞争。共享目录的缓存允许短暂滞后，
 * 真正发送前总是重新读文件，并以 rename 是否成功判断是否取得该批。
 */
export class Outbox {
  readonly #dir: string
  readonly #maxBytes: number
  /** 进程内单调递增序号，保证同一毫秒内多个批次的文件名不撞。 */
  #counter = 0
  #droppedBatches = 0
  readonly #instanceId = randomUUID()
  readonly #now: () => number
  readonly #entries = new Map<string, BatchMeta>()
  #ordered: string[] = []
  #orderedSet = new Set<string>()
  #head = 0
  #bytes = 0
  #records = 0
  #stamp = ''
  #checkedAt = -Infinity

  constructor(options: { dir: string; maxBytes: number; now?: () => number }) {
    this.#dir = options.dir
    this.#maxBytes = options.maxBytes
    this.#now = options.now ?? Date.now
    try {
      mkdirSync(this.#dir, { recursive: true })
    } catch {
      // 目录建不出来（磁盘满 / 权限）时**不抛错**：outbox 是兜底，
      // 让兜底把主流程拖死是本末倒置。后续写盘会各自失败并降级为「仅内存」。
    }
    this.#refresh(true)
  }

  get dir(): string {
    return this.#dir
  }

  /** 列出一个前缀下的文件名（已排序，旧的在前）。 */
  #list(prefix: string): string[] {
    try {
      return readdirSync(this.#dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(SUFFIX))
        .sort()
    } catch {
      return []
    }
  }

  #pathOf(file: string): string {
    return join(this.#dir, file)
  }

  /** 生成一个不撞的文件名。 */
  #nextFile(prefix: string): string {
    this.#counter += 1
    // ★ 序号用**固定宽度左补零**。文件名同时承担两个职责：
    //   1. 唯一性（时间戳 + pid + 序号）
    //   2. **排序键** —— `take()` 按文件名字典序取「最旧的先发」
    //
    //   不补零的话字典序是 1, 10, 100, 11, 2…，同一毫秒内写下 11 批之后
    //   顺序就乱了：不仅「先采的先上账」失效，容量超限时丢掉的也**不一定是
    //   最旧的那批**（那正是这个模块最不能出错的地方）。
    // 多个实例可能在同一毫秒从序号 1 开始，实例标识防止覆盖另一实例的唯一副本。
    return `${prefix}${Date.now()}-${process.pid}-${String(this.#counter).padStart(9, '0')}-${this.#instanceId}${SUFFIX}`
  }

  /**
   * 落盘一批新记录。
   *
   * @returns 文件名；写盘失败返回 null（调用方应降级为「仅内存投递」）。
   */
  write(records: Record<string, unknown>[]): string | null {
    if (records.length === 0) return null
    this.#refresh()
    const file = this.#nextFile(PENDING_PREFIX)
    const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const temporary = this.#pathOf(`.writing-${file}`)
    try {
      // 另一个进程只会看到完整 pending 文件，不会把正在写的一半当成坏 JSON。
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, this.#pathOf(file))
    } catch {
      try { unlinkSync(temporary) } catch { /* 写入未完成，没有可确认的磁盘副本 */ }
      return null
    }
    this.#remember(file, { bytes: Buffer.byteLength(text), records: records.length, mtimeMs: this.#mtime(file) })
    this.#enforceLimit()
    this.#stamp = this.#directoryStamp()
    return file
  }

  /**
   * 把待投递批次标记为「已发出」。
   *
   * ⚠️ 必须在 `fetch` **之前**调用：发送后才标的话，
   *   正好在「服务端已收到、进程还没标记」的窗口里崩溃，
   *   记录会被当成没发过 —— 但那种情况其实无害（重发会被幂等吸收）。
   *   真正危险的是反过来：先标已发再真发，崩了就永久丢数据。
   */
  markInflight(file: string): boolean {
    try {
      renameSync(this.#pathOf(file), this.#pathOf(file.replace(PENDING_PREFIX, INFLIGHT_PREFIX)))
      this.#forget(file)
      this.#stamp = this.#directoryStamp()
      return true
    } catch {
      // 可能已经被另一个实例取走，不能继续发送并删除别人持有的文件。
      this.#refresh(true)
      return false
    }
  }

  /** 投递成功：删除对应的 inflight 文件（`file` 是 pending 名）。 */
  ack(file: string): void {
    const inflight = file.replace(PENDING_PREFIX, INFLIGHT_PREFIX)
    for (const candidate of [inflight, file]) {
      try {
        unlinkSync(this.#pathOf(candidate))
      } catch {
        /* 已经不在就无所谓 —— ack 是幂等的 */
      }
    }
    this.#forget(file)
    this.#stamp = this.#directoryStamp()
  }

  /**
   * 投递失败：把 inflight 改回 pending，留待下一轮重发。
   *
   * 失败可能是网络、可能是服务端 500，**一律当作「没送达」**。
   * 重发的最坏代价是一批重复事件，而服务端按 `event_id` 去重 —— 零代价。
   */
  release(file: string): void {
    const inflight = file.replace(PENDING_PREFIX, INFLIGHT_PREFIX)
    const from = this.#pathOf(inflight)
    if (!existsSync(from)) return
    try {
      renameSync(from, this.#pathOf(file))
      const batch = this.#read(file)
      if (batch) this.#remember(file, batch.meta)
      this.#stamp = this.#directoryStamp()
    } catch {
      /* 改不回来时保持 inflight —— 下次启动的 recover() 会再捞一次 */
    }
  }

  /**
   * 进程启动时调用：把残留的 inflight 全部改回 pending。
   *
   * 这是「崩溃不丢」的兑现点。返回捞回了几批，供启动日志展示 ——
   * 「上次异常退出补发了 N 批」比一句「启动成功」有用得多。
   */
  recover(): number {
    let restored = 0
    for (const f of this.#list(INFLIGHT_PREFIX)) {
      const back = f.replace(INFLIGHT_PREFIX, PENDING_PREFIX)
      try {
        renameSync(this.#pathOf(f), this.#pathOf(back))
        restored += 1
      } catch {
        /* 单个文件坏了不影响其余 */
      }
    }
    if (restored > 0) this.#refresh(true)
    else this.#refresh()
    return restored
  }

  /**
   * 取出最早的若干批待投递记录。
   *
   * 每次重读要发送的文件，缓存只保存统计和顺序，不作为记录正文的真值。
   * 文件暂时不可读时跳过而不删除，等待下一次目录核对重试。
   */
  take(maxBatches: number): OutboxBatch[] {
    this.#refresh()
    this.#prune()
    const out: OutboxBatch[] = []
    for (let i = this.#head; i < this.#ordered.length && out.length < maxBatches; i++) {
      const file = this.#ordered[i]!
      if (!this.#entries.has(file)) continue
      const batch = this.#read(file)
      if (batch === null) {
        // 文件可能暂时不可读或已被其它实例领取，不能把权限/竞争误判成损坏后删除。
        this.#forget(file)
        continue
      }
      this.#remember(file, batch.meta)
      out.push({ file, records: batch.records })
    }
    return out
  }

  /** 读取一批；损坏时返回 null。 */
  #read(file: string): { records: Record<string, unknown>[]; meta: BatchMeta } | null {
    let text: string
    try {
      text = readFileSync(this.#pathOf(file), 'utf8')
    } catch {
      return null
    }
    const records: Record<string, unknown>[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>)
        }
      } catch {
        // 单行坏掉丢掉这一行：整批丢弃会让一次断电抹掉几百条已经采到的用量
        continue
      }
    }
    return { records, meta: { bytes: Buffer.byteLength(text), records: records.length, mtimeMs: this.#mtime(file) } }
  }

  /** 当前状态。 */
  stats(): OutboxStats {
    this.#refresh()
    return {
      pendingBatches: this.#entries.size,
      pendingRecords: this.#records,
      pendingBytes: this.#bytes,
      droppedBatches: this.#droppedBatches,
    }
  }

  /**
   * 强制字节上限：超了就丢**最旧**的批。
   *
   * ⚠️ 丢的是最旧的而不是最新的：内网断了三天、磁盘又快满时，
   *   保留最近的用量比保留三天前的更有价值（且最近的还能对上账）。
   *   每次丢弃都会累计进 `droppedBatches`，由调用方告警 ——
   *   **静默丢弃是不可接受的**，那会让看板少数据而没人知道。
   */
  #enforceLimit(): void {
    this.#prune()
    for (let i = this.#head; i < this.#ordered.length && this.#bytes > this.#maxBytes; i++) {
      const f = this.#ordered[i]!
      if (!this.#entries.has(f)) continue
      try {
        unlinkSync(this.#pathOf(f))
        this.#forget(f)
        this.#droppedBatches += 1
      } catch {
        /* 删不掉就下一轮再说 */
      }
    }
  }

  #mtime(file: string): number {
    try { return statSync(this.#pathOf(file)).mtimeMs } catch { return -1 }
  }

  #directoryStamp(): string {
    try {
      const s = statSync(this.#dir)
      return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
    } catch { return '' }
  }

  #forget(file: string): void {
    const old = this.#entries.get(file)
    if (!old) return
    this.#bytes -= old.bytes
    this.#records -= old.records
    this.#entries.delete(file)
  }

  #remember(file: string, meta: BatchMeta): void {
    this.#forget(file)
    this.#entries.set(file, meta)
    this.#bytes += meta.bytes
    this.#records += meta.records
    if (this.#orderedSet.has(file)) return
    this.#orderedSet.add(file)
    // 通常只是追加；只有外部新增旧文件、恢复失败批次时才需要插到队列中间。
    let lo = this.#head
    let hi = this.#ordered.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.#ordered[mid]! < file) lo = mid + 1
      else hi = mid
    }
    this.#ordered.splice(lo, 0, file)
  }

  #prune(): void {
    while (this.#head < this.#ordered.length && !this.#entries.has(this.#ordered[this.#head]!)) {
      this.#orderedSet.delete(this.#ordered[this.#head]!)
      this.#head++
    }
    if (this.#head > 1024 && this.#head * 2 > this.#ordered.length) {
      this.#ordered = this.#ordered.slice(this.#head)
      this.#head = 0
    }
  }

  #refresh(force = false): void {
    const now = this.#now()
    const deep = force || now - this.#checkedAt >= RECONCILE_INTERVAL_MS
    const stamp = this.#directoryStamp()
    if (!deep && stamp === this.#stamp) return
    const files = this.#list(PENDING_PREFIX)
    const present = new Set(files)
    for (const file of this.#entries.keys()) if (!present.has(file)) this.#forget(file)
    for (const file of files) {
      const old = this.#entries.get(file)
      if (old && !deep) continue
      if (old) {
        try {
          const st = statSync(this.#pathOf(file))
          if (st.size === old.bytes && st.mtimeMs === old.mtimeMs) continue
        } catch { this.#forget(file); continue }
      }
      const batch = this.#read(file)
      if (batch) this.#remember(file, batch.meta)
    }
    this.#prune()
    this.#stamp = stamp
    if (deep) this.#checkedAt = now
  }

  /** 清空 outbox（测试与「重置」场景）。 */
  clear(): void {
    for (const prefix of [PENDING_PREFIX, INFLIGHT_PREFIX]) {
      for (const f of this.#list(prefix)) {
        try {
          unlinkSync(this.#pathOf(f))
        } catch {
          /* 忽略 */
        }
      }
    }
    this.#refresh(true)
  }
}
