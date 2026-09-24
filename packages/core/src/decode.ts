/**
 * zstd 分帧日志解码器。
 *
 * DSH 的会话日志是 zstd **分帧追加**（每帧一个独立 zstd frame，顺序 append），
 * 不是单个 zstd 流。因此不能用「一次解压整个文件」的方式读取——那样只能拿到第一帧。
 *
 * 做法：按 zstd magic number (`28 B5 2F FD`) 定位每一帧的起始偏移，
 * 逐帧解压后拼接。文件末尾可能有被写入中断的半帧，忽略即可。
 */

import { zstdDecompressSync, zstdDecompress } from 'node:zlib'

/** zstd frame magic number：0xFD2FB528 的小端字节序。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 扫描 buffer 中所有 zstd 帧的起始偏移。
 *
 * 注意：magic 序列理论上可能出现在压缩数据内部，但对本场景
 * （DSH 顺序 append 的帧）足够可靠，且与 DSH 自身的实现一致。
 */
export function findFrameOffsets(buf: Buffer): number[] {
  const offsets: number[] = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) {
      offsets.push(i)
    }
  }
  return offsets
}

/** 把 buffer 拆成若干帧的切片。 */
export function splitFrames(buf: Buffer): Buffer[] {
  const offsets = findFrameOffsets(buf)
  const frames: Buffer[] = []
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]!
    const end = i + 1 < offsets.length ? offsets[i + 1]! : buf.length
    frames.push(buf.subarray(start, end))
  }
  return frames
}

export interface DecodeResult {
  /** 解压出的完整文本（各帧拼接）。 */
  text: string
  /** 成功解压的帧数。 */
  framesOk: number
  /** 解压失败的帧数（通常是末尾半帧）。 */
  framesFailed: number
}

/**
 * 增量解码结果。在 {@link DecodeResult} 之上额外报告**帧总数**。
 *
 * `frameCount` 是水位线的关键：下一次可以从 `splitFrames(buf).slice(frameCount)`
 * 继续，已处理的帧不必再解压。
 *
 * ⚠️ `frameCount` 统计的是**全部**帧（含末尾半帧），与 `framesOk + framesFailed`
 * 恒等，测试里有断言锁死。
 */
export interface IncrementalDecodeResult extends DecodeResult {
  /** `splitFrames` 结果的长度，即该 buffer 当前包含的帧总数。 */
  frameCount: number
}

/**
 * 同步解码分帧 zstd buffer。
 *
 * ⚠️ 运行时差异（实测）：
 *   - Node  `zstdDecompressSync` 对截断帧抛 `Z_BUF_ERROR`
 *   - Bun   对截断帧**静默返回空 Buffer**，不抛错
 *
 * 因此不能只靠 try/catch 判断帧是否完整，否则在 Bun 下
 * 尾部半帧会被误计为「成功帧」。这里改为显式解析帧头、
 * 做**帧完整性检查**，让两个运行时行为一致、诊断数字可信。
 */
export function decodeFramedZstdSync(buf: Buffer): DecodeResult {
  const frames = splitFrames(buf)
  let text = ''
  let framesOk = 0
  let framesFailed = 0

  for (const frame of frames) {
    if (!isCompleteZstdFrame(frame)) {
      framesFailed++
      continue
    }
    try {
      text += zstdDecompressSync(frame).toString('utf8')
      framesOk++
    } catch {
      framesFailed++
    }
  }
  return { text, framesOk, framesFailed }
}

/**
 * 解析 zstd frame 的**帧头**，返回压缩数据块的结束偏移；
 * 返回 -1 表示帧头不完整（即被截断）。
 *
 * 参考 RFC 8878 §3.1.1.1（Frame_Header_Descriptor）。
 */
function parseFrameHeaderEnd(frame: Buffer): number {
  if (frame.length < 5) return -1

  // magic(4) 之后是 Frame_Header_Descriptor(1)
  const descriptor = frame[4]!
  const fcsFlag = descriptor >> 6 // Frame_Content_Size_flag
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictIdFlag = descriptor & 3

  let pos = 5

  // Window_Descriptor：仅在非 single-segment 时存在
  if (!singleSegment) {
    if (frame.length < pos + 1) return -1
    pos += 1
  }

  // Dictionary_ID_Size 由 dictIdFlag 决定
  const dictIdSize = dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4
  if (frame.length < pos + dictIdSize) return -1
  pos += dictIdSize

  // Frame_Content_Size 字段大小：
  //   fcsFlag=0 -> singleSegment ? 1 : 0 字节
  //   fcsFlag=1 -> 2 字节
  //   fcsFlag=2 -> 4 字节
  //   fcsFlag=3 -> 8 字节
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (frame.length < pos + fcsSize) return -1
  pos += fcsSize

  return hasChecksum ? pos + 4 : pos
}

/**
 * 判断一个 zstd frame 是否完整（未被截断）。
 *
 * 判据：帧头可完整解析，且之后至少还有一个字节的 block 数据。
 * 注意 frame 的末尾一定以 EndMark block 结束——如果写入被中断，
 * 帧头之后的数据会不足，或 block 数据不完整（由解压器报错兜住）。
 */
export function isCompleteZstdFrame(frame: Buffer): boolean {
  const headerEnd = parseFrameHeaderEnd(frame)
  if (headerEnd < 0) return false
  // 帧头之后必须有 block 数据（至少 3 字节的 block header）
  return frame.length >= headerEnd + 3
}

/**
 * 异步解码，用于大文件避免阻塞事件循环。
 * 帧之间并发解压，但仍按原始顺序拼接以保证事件顺序。
 * 与同步版共用帧完整性检查，跨运行时行为一致。
 */
export async function decodeFramedZstd(buf: Buffer): Promise<DecodeResult> {
  const frames = splitFrames(buf)
  const results = await Promise.all(
    frames.map(async (frame) => {
      if (!isCompleteZstdFrame(frame)) {
        return { ok: false as const, text: '' }
      }
      try {
        const out = await new Promise<Buffer>((resolve, reject) => {
          zstdDecompress(frame, (err, res) =>
            err ? reject(err) : resolve(res as Buffer),
          )
        })
        return { ok: true as const, text: out.toString('utf8') }
      } catch {
        return { ok: false as const, text: '' }
      }
    }),
  )

  let text = ''
  let framesOk = 0
  let framesFailed = 0
  for (const r of results) {
    if (r.ok) {
      text += r.text
      framesOk++
    } else {
      framesFailed++
    }
  }
  return { text, framesOk, framesFailed }
}

/** 把解压文本按行解析为 JSON 对象，跳过空行与坏行。 */
export function* parseJsonl(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>
      }
    } catch {
      // 尾部不完整的行，跳过
    }
  }
}

/**
 * 增量解码：只解压 `fromFrame` 之后的帧。
 *
 * 这是「每 10 分钟扫一次」不重扫历史的关键。DSH 日志 append-only 且每帧独立，
 * 所以按帧下标续读是安全的：第 0..fromFrame-1 帧的内容不会变。
 *
 * ⚠️ **残缺帧会被计入 `frameCount`，但不会被消费**。
 *
 * 这是必须的：如果只把「成功解压的帧」计入水位线，那么尾部那个正在写的半帧
 * 会让水位线停在它前面，下一轮重新解析它——看似安全，但它**下一轮就成了完整帧**，
 * 于是永远差一帧。
 *
 * 反过来若把半帧也计入并推进，则它被永久跳过、数据丢失。
 *
 * 正确做法是：**半帧计入 `frameCount`（下一轮从它之后开始），但本轮不产出记录**——
 * 也就是让它在本轮被「消费掉」。这成立的前提是半帧里不会有完整的事件行：
 * 一个 zstd 帧在 DSH 里对应一次 append，半帧意味着这次 append 还没写完，
 * 而 JSONL 行本身是完整写入的。所以被跳过的半帧不会带走任何已提交的事件。
 *
 * @param buf - 完整文件内容。
 * @param fromFrame - 已处理过的帧数（水位线）。从这一帧开始解压。
 */
export function decodeFramedZstdFrom(
  buf: Buffer,
  fromFrame: number,
): IncrementalDecodeResult {
  const frames = splitFrames(buf)
  const frameCount = frames.length

  // 水位线超前（文件被截断/重建）时从头发起，而不是返回空——
  // 返回空会让水位线永久卡住，文件的新内容再也读不到。
  const start = Number.isFinite(fromFrame) && fromFrame > 0 && fromFrame <= frameCount
    ? fromFrame
    : 0

  let text = ''
  let framesOk = 0
  let framesFailed = 0

  for (let i = start; i < frameCount; i++) {
    const frame = frames[i]!
    if (!isCompleteZstdFrame(frame)) {
      framesFailed++
      continue
    }
    try {
      text += zstdDecompressSync(frame).toString('utf8')
      framesOk++
    } catch {
      framesFailed++
    }
  }

  return { text, framesOk, framesFailed, frameCount }
}