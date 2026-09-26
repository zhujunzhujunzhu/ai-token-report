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
  // 搜索交给原生实现：逐字节跨 JS/Buffer 边界会把一个 50 MiB 文件拖到秒级。
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) {
    offsets.push(i)
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
  /** 可安全跳过的帧数；末尾未完成的帧不算已消费。 */
  consumedFrameCount: number
  /** 相对于传入 buffer 的完整帧末尾；下次从这里读取，保留未写完的尾帧。 */
  byteOffset: number
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
    const completeSize = completeFrameSize(frame)
    if (completeSize === null) {
      framesFailed++
      continue
    }
    try {
      text += zstdDecompressSync(frame.subarray(0, completeSize)).toString('utf8')
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

  return pos
}

/**
 * 判断一个 zstd frame 是否完整（未被截断）。
 *
 * 必须读完每个 block header 声明的长度以及可选 checksum。
 * 只验证帧头会把「帧头完整、block 写了一半」误判为完成，Bun 还可能静默解出空值。
 */
export function isCompleteZstdFrame(frame: Buffer): boolean {
  return completeFrameSize(frame) !== null
}

/** RFC 8878 §3.1.1.2：RLE block 仅存一个字节，其余 block 按声明长度存储。 */
function completeFrameSize(frame: Buffer): number | null {
  let pos = parseFrameHeaderEnd(frame)
  if (pos < 0) return null
  while (pos + 3 <= frame.length) {
    const header = frame.readUIntLE(pos, 3)
    const last = (header & 1) !== 0
    const type = (header >> 1) & 3
    if (type === 3) return null
    pos += 3 + (type === 1 ? 1 : header >>> 3)
    if (pos > frame.length) return null
    if (last) {
      if ((frame[4]! & 4) !== 0) pos += 4
      return pos <= frame.length ? pos : null
    }
  }
  return null
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
      const completeSize = completeFrameSize(frame)
      if (completeSize === null) {
        return { ok: false as const, text: '' }
      }
      try {
        const out = await new Promise<Buffer>((resolve, reject) => {
          zstdDecompress(frame.subarray(0, completeSize), (err, res) =>
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
  // 不先 split 出整份日志的行数组，长会话只保留当前行的临时字符串。
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end)
    start = end + 1
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
 * ⚠️ `frameCount` 保留全部可见帧数的诊断语义；水位线必须使用
 * `consumedFrameCount` / `byteOffset`，不能消费尚未写完的尾帧。
 * 下一轮从尾帧起点重试，它完成后才能贡献用量。
 *
 * @param buf - 完整文件内容。
 * @param fromFrame - 已处理过的帧数（水位线）。从这一帧开始解压。
 */
export function decodeFramedZstdFrom(
  buf: Buffer,
  fromFrame: number,
): IncrementalDecodeResult {
  const offsets = findFrameOffsets(buf)
  const frameCount = offsets.length

  // 水位线超前（文件被截断/重建）时从头发起，而不是返回空——
  // 返回空会让水位线永久卡住，文件的新内容再也读不到。
  const start = Number.isSafeInteger(fromFrame) && fromFrame > 0 && fromFrame <= frameCount
    ? fromFrame
    : 0

  let text = ''
  let framesOk = 0
  let framesFailed = 0
  let consumedFrameCount = start
  let byteOffset = offsets[start] ?? (start > 0 ? buf.length : 0)

  for (let i = start; i < frameCount; i++) {
    const offset = offsets[i]!
    const frame = buf.subarray(offset, offsets[i + 1] ?? buf.length)
    const completeSize = completeFrameSize(frame)
    if (completeSize === null) {
      framesFailed++
      continue
    }
    try {
      text += zstdDecompressSync(frame.subarray(0, completeSize)).toString('utf8')
      framesOk++
      consumedFrameCount = i + 1
      byteOffset = offset + completeSize
    } catch {
      framesFailed++
    }
  }

  return { text, framesOk, framesFailed, frameCount, consumedFrameCount, byteOffset }
}
