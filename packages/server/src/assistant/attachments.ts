/**
 * 助手上传边界：在内存中校验原文件并提取可供模型阅读的正文。
 * ★ 文件名、MIME 和 ZIP 元数据都不可信；不落盘、不解引用外链、不执行宏或公式。
 */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { crc32 } from 'node:zlib'
import { fromBufferPromise } from 'yauzl'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { imageSize } from 'image-size'
import { ASSISTANT_ATTACHMENT_ACCEPT, ASSISTANT_ATTACHMENT_LIMITS, type AssistantAttachment } from '@ai-token-report/shared'
import { IdentityError } from '../identity/types.js'

export interface PreparedAssistantAttachment {
  metadata: AssistantAttachment
  bytes: Uint8Array
  text?: string
  image?: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; width: number; height: number }
}

const ZIP_LIMITS = { entries: 2048, totalBytes: 40 * 1024 * 1024, xmlBytes: 12 * 1024 * 1024, ratio: 200 }
const OFFICE = {
  docx: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', part: 'word/document.xml', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
  xlsx: { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', part: 'xl/workbook.xml', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
  pptx: { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', part: 'ppt/presentation.xml', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' },
} as const
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const
const ACCEPTED = new Set(ASSISTANT_ATTACHMENT_ACCEPT.split(',').map((ext) => ext.slice(1)))
type OfficeExtension = keyof typeof OFFICE
type ImageExtension = keyof typeof IMAGE_TYPES
type XmlNode = Record<string, unknown>
const xmlParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, ignoreDeclaration: true, maxNestedTags: 100 })

function invalid(reason: string, status = 400): never { throw new IdentityError(status, reason) }
function extension(name: string): string { return name.toLowerCase().split('.').at(-1) ?? '' }
function safeName(name: string): string {
  const normalized = name.replace(/\\/g, '/').split('/').at(-1)?.normalize('NFC').trim() ?? ''
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)) invalid('附件文件名无效')
  return normalized
}

function decodeText(bytes: Uint8Array): string {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8'
  let offset = 0
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2 }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2 }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3
  if (encoding !== 'utf-8' && (bytes.length - offset) % 2 !== 0) invalid('文本的 UTF-16 编码不完整')
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)) }
  catch { invalid('文本编码无法识别，请转存为 UTF-8 或带 BOM 的 UTF-16') }
  // 二进制改名为 .txt 不能越过白名单；允许的文本控制符仅有换行、回车和制表。
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) invalid('文件包含二进制内容，不能按文本解析', 415)
  return text.replace(/\r\n?/g, '\n')
}

function nodeName(node: XmlNode): string { return Object.keys(node).find((key) => key !== ':@' && key !== '#text') ?? '' }
function children(node: XmlNode): XmlNode[] { const value = node[nodeName(node)]; return Array.isArray(value) ? value as XmlNode[] : [] }
function attrs(node: XmlNode): Record<string, string> { return (node[':@'] ?? {}) as Record<string, string> }
function direct(nodes: XmlNode[], name: string): XmlNode[] { return nodes.filter((node) => nodeName(node) === name) }
function find(nodes: XmlNode[], name: string): XmlNode[] {
  const result: XmlNode[] = []
  const stack = [...nodes].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (nodeName(node) === name) result.push(node)
    else {
      const nested = children(node)
      for (let index = nested.length - 1; index >= 0; index--) stack.push(nested[index]!)
    }
  }
  return result
}
class BoundedText {
  private readonly parts: string[] = []
  private length = 0
  // 多保留一个字符供最终阶段辨认截断，避免大量共享字符串重复引用膨胀成巨大正文。
  private readonly limit = ASSISTANT_ATTACHMENT_LIMITS.max_text_chars + 1
  get full(): boolean { return this.length >= this.limit }
  add(value: string): void {
    const part = value.slice(0, this.limit - this.length)
    if (part) { this.parts.push(part); this.length += part.length }
  }
  text(): string { return this.parts.join('') }
}
function plain(nodes: XmlNode[]): string {
  return nodes.map((node) => typeof node['#text'] === 'string' ? node['#text'] : plain(children(node))).join('')
}
function rich(nodes: XmlNode[]): string {
  return nodes.map((node) => {
    const name = nodeName(node)
    return name === 't' ? plain(children(node)) : name === 'tab' ? '\t' : name === 'br' || name === 'cr' ? '\n' : rich(children(node))
  }).join('')
}
function paragraphs(nodes: XmlNode[]): string {
  const output = new BoundedText()
  let first = true
  for (const node of find(nodes, 'p')) {
    if (!first) output.add('\n')
    output.add(rich(children(node)))
    if (output.full) break
    first = false
  }
  return output.text()
}
function wordText(nodes: XmlNode[]): string {
  const output = new BoundedText()
  let first = true
  const block = (text: string) => { if (!first) output.add('\n'); output.add(text); first = false }
  const visit = (list: XmlNode[]): void => {
    for (const node of list) {
      const name = nodeName(node)
      if (name === 'p') block(rich(children(node)))
      else if (name === 'tbl') {
        // 段落全量查找会把表格打散；每行按制表符保留单元格关系，嵌套表格归属于所在单元格。
        for (const row of find(children(node), 'tr')) {
          const cells = find(children(row), 'tc')
          if (!first) output.add('\n')
          for (const [index, cell] of cells.entries()) {
            if (index) output.add('\t')
            output.add(wordText(children(cell)))
            if (output.full) return
          }
          first = false
        }
      } else visit(children(node))
      if (output.full) return
    }
  }
  visit(nodes)
  return output.text()
}
function xml(files: Map<string, Uint8Array>, name: string): XmlNode[] {
  const bytes = files.get(name)
  if (!bytes) invalid(`Office 文件缺少 ${name}`)
  const text = decodeText(bytes)
  // 只处理 OOXML 内置实体；拒绝 DTD，避免实体膨胀与外部实体解析。
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) invalid('Office XML 不能包含 DTD 或实体声明')
  const valid = XMLValidator.validate(text)
  if (valid !== true) invalid(`Office 文件中的 ${name} 不是有效 XML`)
  try { return xmlParser.parse(text) as XmlNode[] }
  catch { invalid(`Office 文件中的 ${name} 无法解析（嵌套过深或格式错误）`) }
}

async function officeFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) invalid('Office 文件格式与扩展名不符；旧版或加密文件请转存为无密码的 docx、xlsx 或 pptx', 415)
  let zip: Awaited<ReturnType<typeof fromBufferPromise>> | undefined
  try {
    zip = await fromBufferPromise(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false })
    if (zip.entryCount > ZIP_LIMITS.entries) invalid('Office 文件的压缩条目过多', 413)
    const files = new Map<string, Uint8Array>()
    const names = new Set<string>()
    let total = 0
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted()) invalid('不支持有密码保护的 Office 文件，请先另存为无密码版本', 415)
      if (!entry.canDecodeFileData()) invalid('Office 文件使用不支持的压缩方式', 415)
      if (names.has(entry.fileName)) invalid('Office 文件含有重复的压缩条目')
      names.add(entry.fileName)
      if (/vbaproject\.bin$/i.test(entry.fileName)) invalid('不支持包含宏的 Office 文件，请另存为无宏版本', 415)
      if (entry.uncompressedSize > ZIP_LIMITS.totalBytes - total || (entry.uncompressedSize > 65536 && entry.uncompressedSize > Math.max(entry.compressedSize, 1) * ZIP_LIMITS.ratio)) invalid('Office 文件解压大小或压缩膨胀比超过上限', 413)
      const keep = /\.(?:xml|rels)$/i.test(entry.fileName)
      if (keep && entry.uncompressedSize > ZIP_LIMITS.xmlBytes) invalid('Office 文件单个 XML 内容过大', 413)
      const chunks: Buffer[] = []
      let size = 0
      let checksum = 0
      const stream = await zip.openReadStreamPromise(entry)
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        size += chunk.length
        total += chunk.length
        if (total > ZIP_LIMITS.totalBytes || (keep && size > ZIP_LIMITS.xmlBytes) || (size > 65536 && size > Math.max(entry.compressedSize, 1) * ZIP_LIMITS.ratio)) { stream.destroy(); invalid('Office 文件实际解压大小或压缩膨胀比超过上限', 413) }
        checksum = crc32(chunk, checksum)
        if (keep) chunks.push(chunk)
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32) invalid('Office 压缩内容损坏，大小或校验和不一致')
      if (keep) files.set(entry.fileName, Buffer.concat(chunks))
    }
    return files
  } catch (error) {
    if (error instanceof IdentityError) throw error
    throw new IdentityError(400, 'Office 文件已损坏或不是有效 ZIP 文档')
  } finally { zip?.close() }
}

function relationships(files: Map<string, Uint8Array>, part: string): Map<string, string> {
  const relPath = posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`)
  const result = new Map<string, string>()
  for (const node of find(xml(files, relPath), 'Relationship')) {
    const values = attrs(node)
    if (values['@_TargetMode'] === 'External') continue
    const target = values['@_Target'] ?? ''
    if (!target || /[\\\u0000]|^[a-z][a-z\d+.-]*:/i.test(target)) invalid('Office 内部文件引用无效')
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(part), target))
    if (path === '..' || path.startsWith('../')) invalid('Office 内部文件引用越界')
    const id = values['@_Id'] ?? ''
    if (!id || result.has(id)) invalid('Office 内部文件引用重复或缺少 ID')
    result.set(id, path)
  }
  return result
}

function workbookText(files: Map<string, Uint8Array>, part: string): string {
  const workbook = xml(files, part)
  const rels = relationships(files, part)
  const shared = files.has('xl/sharedStrings.xml') ? find(xml(files, 'xl/sharedStrings.xml'), 'si').map((node) => rich(children(node))) : []
  const sheets = find(workbook, 'sheet')
  if (sheets.length > 512) invalid('Excel 工作表数量超过上限', 413)
  const output = new BoundedText()
  let hasCells = false
  for (const sheet of sheets) {
    const info = attrs(sheet)
    const path = rels.get(info['@_id'] ?? '')
    if (!path || !/^xl\/worksheets\/[^/]+\.xml$/.test(path)) invalid('Excel 工作表引用缺失或格式错误')
    const rows = find(xml(files, path), 'row')
    if (output.text()) output.add('\n\n')
    output.add(`工作表：${(info['@_name'] ?? '(未命名)').slice(0, 255)}`)
    for (const row of rows) {
      let rowStarted = false
      for (const cell of direct(children(row), 'c')) {
        const info = attrs(cell)
        const coordinate = info['@_r'] ?? ''
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(coordinate)) invalid('Excel 单元格坐标无效')
        const raw = plain(children(direct(children(cell), 'v')[0] ?? {}))
        const type = info['@_t']
        let value = type === 'inlineStr' ? rich(children(cell)) : type === 's' ? shared[Number(raw)] : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw
        if (type === 's' && (!/^\d+$/.test(raw) || value === undefined)) invalid('Excel 共享字符串引用无效')
        const formula = direct(children(cell), 'f')[0]
        if (formula) value = `=${plain(children(formula)).slice(0, 60001)}${value ? `（缓存值：${value.slice(0, 60001)}）` : ''}`
        if (value) {
          if (!rowStarted) { output.add(`\n第 ${attrs(row)['@_r'] ?? '?'} 行`); rowStarted = true }
          output.add(`\t${coordinate}=${value.slice(0, 60001)}`)
          hasCells = true
          if (output.full) return output.text()
        }
      }
    }
  }
  if (!hasCells) invalid('Excel 文件没有可解析的单元格内容')
  return output.text()
}

function presentationText(files: Map<string, Uint8Array>, part: string): string {
  const rels = relationships(files, part)
  const slides = find(xml(files, part), 'sldId')
  if (slides.length > 1024) invalid('PowerPoint 幻灯片数量超过上限', 413)
  const output = new BoundedText()
  let hasText = false
  for (const [index, slide] of slides.entries()) {
    const path = rels.get(attrs(slide)['@_id'] ?? '')
    if (!path || !/^ppt\/slides\/[^/]+\.xml$/.test(path)) invalid('PowerPoint 幻灯片引用缺失或格式错误')
    const text = paragraphs(xml(files, path))
    hasText ||= !!text.trim()
    if (index) output.add('\n\n')
    output.add(`幻灯片 ${index + 1}\n`)
    output.add(text)
    if (output.full) break
  }
  if (!hasText) invalid('PowerPoint 文件没有可解析的文本内容')
  return output.text()
}

async function officeText(bytes: Uint8Array, ext: OfficeExtension): Promise<string> {
  const files = await officeFiles(bytes)
  const format = OFFICE[ext]
  const overrides = find(xml(files, '[Content_Types].xml'), 'Override')
  if (!overrides.some((node) => attrs(node)['@_PartName'] === `/${format.part}` && attrs(node)['@_ContentType'] === format.contentType)) invalid('Office 文档类型与扩展名不符', 415)
  const rootName = ext === 'docx' ? 'document' : ext === 'xlsx' ? 'workbook' : 'presentation'
  if (direct(xml(files, format.part), rootName).length !== 1) invalid('Office 正文结构与文档类型不符', 415)
  if (ext === 'xlsx') return workbookText(files, format.part)
  if (ext === 'pptx') return presentationText(files, format.part)
  const parts = [format.part, ...Array.from(files.keys()).filter((name) => /^word\/(?:header|footer|footnotes|endnotes)[^/]*\.xml$/.test(name)).sort()]
  const output = new BoundedText()
  for (const name of parts) {
    if (output.text()) output.add('\n\n')
    output.add(wordText(xml(files, name)))
    if (output.full) break
  }
  if (!output.text().trim()) invalid('Word 文件没有可解析的文本内容')
  return output.text()
}

function validateImage(bytes: Uint8Array, ext: ImageExtension): PreparedAssistantAttachment['image'] {
  if (bytes.length > ASSISTANT_ATTACHMENT_LIMITS.max_image_bytes) invalid('图片不能超过 5 MiB，请先压缩图片', 413)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size: ReturnType<typeof imageSize>
  try { size = imageSize(bytes) } catch { invalid('图片损坏或格式无法识别') }
  const expected = ext === 'jpeg' ? 'jpg' : ext
  if (size.type !== expected) invalid('图片真实格式与扩展名不符', 415)
  if (!size.width || !size.height || size.width > ASSISTANT_ATTACHMENT_LIMITS.max_image_dimension || size.height > ASSISTANT_ATTACHMENT_LIMITS.max_image_dimension || size.width * size.height > ASSISTANT_ATTACHMENT_LIMITS.max_image_pixels) invalid('图片分辨率超过上限，请缩小至单边 4096 且总像素不超过 4194304', 413)
  if (size.type === 'png') {
    if (buffer.length < 33 || buffer[24]! > 8) invalid('不支持 16 位 PNG，请转存为 8 位图片', 415)
    let cursor = 8
    let data = false
    let end = false
    let chunks = 0
    while (cursor + 12 <= buffer.length) {
      if (++chunks > 100_000) invalid('PNG 图片块数量超过上限', 413)
      const length = buffer.readUInt32BE(cursor)
      if (length > buffer.length - cursor - 12) invalid('PNG 图片内容不完整')
      const type = buffer.toString('ascii', cursor + 4, cursor + 8)
      if (crc32(buffer.subarray(cursor + 4, cursor + 8 + length)) !== buffer.readUInt32BE(cursor + 8 + length)) invalid('PNG 图片校验和不一致')
      if (chunks === 1 && (type !== 'IHDR' || length !== 13)) invalid('PNG 图片头无效')
      if (type === 'IDAT' && length) data = true
      cursor += length + 12
      if (type === 'IEND') { end = length === 0 && cursor === buffer.length; break }
    }
    if (!data || !end) invalid('PNG 图片缺少像素内容或完整结束标记')
  } else if (size.type === 'jpg') {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) invalid('JPEG 图片内容不完整')
    let cursor = 2
    let scan = false
    while (cursor + 4 <= buffer.length) {
      if (buffer[cursor++] !== 0xff) invalid('JPEG 图片段结构无效')
      while (buffer[cursor] === 0xff) cursor++
      if (cursor + 3 > buffer.length) invalid('JPEG 图片段头不完整')
      const marker = buffer[cursor++]!
      if (marker === 0xda) {
        const length = buffer.readUInt16BE(cursor)
        if (length < 6 || cursor + length >= buffer.length - 2) invalid('JPEG 图片像素扫描段不完整')
        scan = true
        break
      }
      if (marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = buffer.readUInt16BE(cursor)
      if (length < 2 || cursor + length > buffer.length) invalid('JPEG 图片段不完整')
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && buffer[cursor + 2] !== 8) invalid('只支持 8 位 JPEG 图片', 415)
      cursor += length
    }
    if (!scan) invalid('JPEG 图片缺少像素扫描内容')
  } else if (size.type === 'gif') {
    let cursor = 13 + ((buffer[10]! & 0x80) ? 3 * (1 << ((buffer[10]! & 7) + 1)) : 0)
    let hasImage = false
    let ended = false
    const subBlocks = () => {
      while (cursor < buffer.length) {
        const length = buffer[cursor++]!
        if (!length) return
        if (cursor + length > buffer.length) invalid('GIF 图片数据块不完整')
        cursor += length
      }
      invalid('GIF 图片数据块缺少结束标记')
    }
    while (cursor < buffer.length) {
      const marker = buffer[cursor++]!
      if (marker === 0x3b) { ended = cursor === buffer.length; break }
      if (marker === 0x21) {
        if (cursor >= buffer.length) invalid('GIF 扩展块不完整')
        cursor++
        subBlocks()
      } else if (marker === 0x2c) {
        if (cursor + 9 > buffer.length) invalid('GIF 图像描述块不完整')
        const width = buffer.readUInt16LE(cursor + 4)
        const height = buffer.readUInt16LE(cursor + 6)
        if (!width || !height || width > size.width || height > size.height) invalid('GIF 帧尺寸无效')
        const packed = buffer[cursor + 8]!
        cursor += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0)
        if (cursor + 2 > buffer.length || buffer[cursor]! < 2 || buffer[cursor]! > 8 || !buffer[cursor + 1]) invalid('GIF 图片缺少有效像素内容')
        cursor++
        subBlocks()
        hasImage = true
      } else invalid('GIF 图片块结构无效')
    }
    if (!hasImage || !ended) invalid('GIF 图片内容不完整')
  } else if (size.type === 'webp') {
    if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) invalid('WebP 图片内容不完整')
    let cursor = 12
    let hasImage = false
    while (cursor + 8 <= buffer.length) {
      const type = buffer.toString('ascii', cursor, cursor + 4)
      const length = buffer.readUInt32LE(cursor + 4)
      if (length > buffer.length - cursor - 8) invalid('WebP 图片块内容不完整')
      if ((type === 'VP8 ' && length >= 10) || (type === 'VP8L' && length >= 5) || (type === 'ANMF' && length >= 24)) hasImage = true
      cursor += 8 + length + (length % 2)
    }
    if (!hasImage || cursor !== buffer.length) invalid('WebP 图片缺少完整像素块')
  }
  return { mediaType: IMAGE_TYPES[ext], width: size.width, height: size.height }
}

/** 本轮正文合计限长；原文件仍完整保留，截断标记随着消息保存。 */
export async function prepareAssistantAttachments(files: File[]): Promise<PreparedAssistantAttachment[]> {
  if (files.length > ASSISTANT_ATTACHMENT_LIMITS.max_files) invalid('每条消息最多上传 6 个附件', 413)
  let totalBytes = 0
  for (const file of files) {
    if (!file.size) invalid(`附件 ${safeName(file.name)} 是空文件`)
    if (file.size > ASSISTANT_ATTACHMENT_LIMITS.max_file_bytes) invalid('单个附件不能超过 10 MiB', 413)
    totalBytes += file.size
    if (totalBytes > ASSISTANT_ATTACHMENT_LIMITS.max_total_bytes) invalid('每条消息的附件合计不能超过 20 MiB', 413)
  }
  const prepared: PreparedAssistantAttachment[] = []
  let remaining = ASSISTANT_ATTACHMENT_LIMITS.max_text_chars as number
  for (const file of files) {
    const fileName = safeName(file.name)
    const ext = extension(fileName)
    if (!fileName.includes('.') || !ACCEPTED.has(ext)) invalid('不支持此附件类型；支持 PNG/JPEG/WebP/GIF、docx/xlsx/pptx 和常见文本文件，旧版 Office 请先转存', 415)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length !== file.size) invalid('附件内容大小与声明不一致')
    const metadata: AssistantAttachment = { attachment_id: randomUUID(), file_name: fileName, media_type: 'text/plain', size_bytes: bytes.length, kind: 'text' }
    const item: PreparedAssistantAttachment = { metadata, bytes }
    if (ext in IMAGE_TYPES) {
      item.image = validateImage(bytes, ext as ImageExtension)
      metadata.kind = 'image'
      metadata.media_type = item.image!.mediaType
    } else {
      const text = ext in OFFICE ? await officeText(bytes, ext as OfficeExtension) : decodeText(bytes)
      if (!text.trim()) invalid(`附件 ${fileName} 没有可解析的文本内容`)
      if (ext in OFFICE) {
        metadata.kind = 'document'
        metadata.media_type = OFFICE[ext as OfficeExtension].mediaType
        metadata.note = ext === 'xlsx' ? '提取单元格文本、公式及缓存值；日期等保留原始值，未应用显示格式，未执行公式，未解析图表和嵌入对象。' : '已提取文档文字；文档内图片、图表和嵌入对象未解析。'
      }
      // 不能切断 UTF-16 的代理对，否则 Unicode 字符会在模型输入中损坏。
      let length = Math.min(text.length, remaining)
      if (length && length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]!)) length--
      item.text = text.slice(0, length)
      metadata.extracted_chars = length
      remaining -= length
      if (length < text.length) metadata.note = `${metadata.note ?? ''}正文超过本轮合计 ${ASSISTANT_ATTACHMENT_LIMITS.max_text_chars} 字符上限，仅向助手提供前 ${length} 字符；原文件完整保留。`
    }
    prepared.push(item)
  }
  return prepared
}
