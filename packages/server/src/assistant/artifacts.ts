/**
 * 助手生成文件的私有存储与限时分享。Office 文件用基础 OOXML，表格值只读授权数据集。
 * ★ 分享是随机能力链接；文件仍绑定原会话，删除会话、撤销链接或权限变化都会关闭访问。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { AssistantArtifact, AssistantArtifactShare, AssistantResult } from '@ai-token-report/shared'
import { IdentityError, type Principal } from '../identity/types.js'
import { AssistantStore } from './store.js'
import type { AssistantDatasets } from './datasets.js'
import { replaceAssistantFile } from './atomic-file.js'

type Format = AssistantArtifact['format']
type Table = NonNullable<AssistantResult['table']>
interface StoredArtifact { metadata: AssistantArtifact; memberId: string; access: string; tokenHash?: string }
interface SharePointer { memberId: string; artifactId: string; expiresAtMs: number }
type AuthorizeOwner = (memberId: string) => Promise<Omit<Principal, 'auth'> | null>
interface SharedHtml {
  artifact_id: string; session_id: string; title: string; file_name: string; created_at_ms: number
  url: string; expires_at_ms: number; expires_at_label: string
}
interface SharedHtmlPage {
  scope: 'current_member'; captured_at_ms: number; total: number; offset: number; limit: number
  next_offset: number | null; shares: SharedHtml[]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const FORMATS = ['docx', 'xlsx', 'html', 'md', 'csv', 'txt'] as const
const MIME: Record<Format, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8',
}
const MAX_ARTIFACTS = 40
const MAX_CONTENT_BYTES = 200_000
const MAX_FILE_BYTES = 3_000_000
const CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const accessOf = (p: Omit<Principal, 'auth'>) => JSON.stringify([p.memberId, [...p.roleCodes ?? []].sort(), [...p.permissions].sort(), [...p.groupIds ?? []].sort()])
const fail = (message: string): never => { throw new IdentityError(400, message) }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('文件参数需要是对象')
const xml = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const cleanName = (title: string, format: Format) => `${title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '助手文件'}.${format}`
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

// ★ 自包含 ZIP 只用于固定 OOXML 路径，避免引入运行时依赖或接收模型指定的归档路径。
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let crc = i
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
function zip(entries: Record<string, string>): Buffer {
  const files: Buffer[] = []; const directory: Buffer[] = []; let offset = 0
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path); const bytes = Buffer.from(content); const compressed = deflateRawSync(bytes)
    let crc = 0xffffffff
    for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff]! ^ (crc >>> 8)
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26)
    files.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10)
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    directory.push(central, name); offset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, central, end])
}
const relationship = (type: string, target: string) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`
const contentTypes = (overrides: string) => `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
const paragraph = (value: unknown, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`
function docx(title: string, content: string, table?: Table): Buffer {
  const rows = table ? [table.columns.map(column => column.label), ...table.rows.map(row => table.columns.map(column => row[column.key] ?? ''))] : []
  const cells = rows.length ? `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="CCCCCC"/>`).join('')}</w:tblBorders></w:tblPr>${rows.map((row, index) => `<w:tr>${row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph(cell, index === 0)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : ''
  return zip({
    '[Content_Types].xml': contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    '_rels/.rels': relationship('officeDocument', 'word/document.xml'),
    'word/document.xml': `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(title, true)}${content.split(/\r?\n/).map(line => paragraph(line)).join('')}${cells}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  })
}
function columnName(index: number): string {
  let value = index + 1; let name = ''
  while (value) { name = String.fromCharCode(65 + (value - 1) % 26) + name; value = Math.floor((value - 1) / 26) }
  return name
}
function xlsx(title: string, content: string, table?: Table, note?: string): Buffer {
  // ⚠️ Excel 每个单元格最多 32767 字符；正文分段保存，数据集则拒绝超长值，绝不静默截断。
  const lines = content.split(/\r?\n/).flatMap(line => line.match(/[\s\S]{1,32767}/g) ?? [''])
  const rows: unknown[][] = table ? [table.columns.map(column => column.label), ...table.rows.map(row => table.columns.map(column => row[column.key] ?? null))] : [[title], ...lines.map(line => [line])]
  if (rows.some(row => row.some(value => typeof value === 'string' && value.length > 32767))) return fail('Excel 单元格超过 32767 字符，请缩小数据内容')
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, index) => {
    const ref = `${columnName(index)}${rowIndex + 1}`
    // ★ 字符串全部写 inlineStr，任何公式外观的内容都不会成为可执行单元格。
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
    if (value === null || value === undefined) return `<c r="${ref}"/>`
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
  }).join('')}</row>`).join('')
  const explanation = note ? `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` : ''
  return zip({
    '[Content_Types].xml': contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + explanation),
    '_rels/.rels': relationship('officeDocument', 'xl/workbook.xml'),
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/>${note ? '<sheet name="说明" sheetId="2" r:id="rId2"/>' : ''}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${note ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : ''}</Relationships>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="${Math.max(...rows.map(row => row.length), 1)}" width="22" customWidth="1"/></cols><sheetData>${body}</sheetData></worksheet>`,
    ...(note ? { 'xl/worksheets/sheet2.xml': `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="100" customWidth="1"/></cols><sheetData>${note.split('\n').map((line, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(line)}</t></is></c></row>`).join('')}</sheetData></worksheet>` } : {}),
  })
}
function csv(table: Table | undefined, title: string, content: string): string {
  const rows: unknown[][] = table ? [table.columns.map(column => column.label), ...table.rows.map(row => table.columns.map(column => row[column.key] ?? ''))] : [[title], ...content.split(/\r?\n/).map(line => [line])]
  return '\ufeff' + rows.map(row => row.map(value => {
    let text = String(value ?? '')
    // ⚠️ CSV 打开时 Excel 会自动解释公式；数字仍保持原值，只有危险字符串加文本前缀。
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }).join(',')).join('\r\n')
}
function markdownBody(content: string): string {
  const result: string[] = []; let paragraphLines: string[] = []; let list: string[] = []; let code: string[] | null = null
  const inline = (value: string) => xml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
  const flush = () => {
    if (paragraphLines.length) result.push(`<p>${paragraphLines.map(inline).join('<br>')}</p>`)
    if (list.length) result.push(`<ul>${list.map(value => `<li>${inline(value)}</li>`).join('')}</ul>`)
    paragraphLines = []; list = []
  }
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { flush(); if (code) { result.push(`<pre><code>${xml(code.join('\n'))}</code></pre>`); code = null } else code = []; continue }
    if (code) { code.push(line); continue }
    const heading = /^(#{1,5})\s+(.+)$/.exec(line)
    const bullet = /^\s*(?:[-*+] |\d+\. )(.+)$/.exec(line)
    if (!line.trim()) { flush(); continue }
    if (heading) { flush(); const level = Math.min(heading[1]!.length + 1, 6); result.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); continue }
    if (bullet) { if (paragraphLines.length) flush(); list.push(bullet[1]!); continue }
    if (list.length) flush()
    paragraphLines.push(line)
  }
  flush(); if (code) result.push(`<pre><code>${xml(code.join('\n'))}</code></pre>`)
  return result.join('')
}
function html(title: string, content: string, table?: Table): string {
  const cells = table ? `<div class="table"><table><thead><tr>${table.columns.map(column => `<th>${xml(column.label)}</th>`).join('')}</tr></thead><tbody>${table.rows.map(row => `<tr>${table.columns.map(column => `<td>${xml(row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''
  // 🚨 模型内容只进入文本节点。分享页不加载外部资源，也不接受脚本、表单或客户端凭证。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${xml(CSP)}"><title>${xml(title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#172033;background:#f6f8fc;margin:0;padding:32px}main{max-width:1000px;margin:auto;background:white;padding:32px;border-radius:16px}h1{font-size:28px;line-height:1.3}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}code{background:#edf2fa;padding:2px 4px;border-radius:4px}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #dae1ec;padding:10px;text-align:left}th{background:#edf2fa}footer{color:#637088;font-size:12px;margin-top:24px}@media(max-width:600px){body{padding:12px}main{padding:20px}}</style></head><body><main><h1>${xml(title)}</h1>${markdownBody(content)}${cells}<footer>AI Token 用量平台 · 助手生成文件</footer></main></body></html>`
}

export class AssistantArtifacts {
  private store: AssistantStore
  private publicBaseUrl: string
  constructor(private root: string, publicBaseUrl = '', private now: () => number = Date.now, private authorizeOwner?: AuthorizeOwner) {
    this.store = new AssistantStore(root)
    if (publicBaseUrl) {
      const url = new URL(publicBaseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('助手分享地址需要无凭证的 HTTP(S) 地址')
    }
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '')
  }
  private indexPath(memberId: string, id: string): string {
    if (!UUID.test(id)) throw new IdentityError(400, '文件 ID 无效')
    return join(this.root, '.artifact-index', hash(memberId), `${id}.json`)
  }
  private async atomic(path: string, value: unknown): Promise<void> {
    // ⚠️ 临时文件名不叠加目标 UUID，避免 Windows 深层会话目录超过原生路径限制。
    const temporary = join(dirname(path), `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await replaceAssistantFile(temporary, path)
  }
  private async read(memberId: string, id: string, principal?: Principal): Promise<StoredArtifact> {
    try {
      const pointer = JSON.parse(await readFile(this.indexPath(memberId, id), 'utf8')) as { sessionId: string }
      await this.store.get(memberId, pointer.sessionId)
      const stored = JSON.parse(await readFile(join(this.store.sessionPath(memberId, pointer.sessionId), 'artifacts', `${id}.json`), 'utf8')) as StoredArtifact
      if (stored.memberId !== memberId || stored.metadata.artifact_id !== id || stored.metadata.session_id !== pointer.sessionId || !FORMATS.includes(stored.metadata.format)) throw new IdentityError(404, '文件不存在或不属于当前用户')
      if (principal && (principal.memberId !== memberId || accessOf(principal) !== stored.access)) throw new IdentityError(403, '文件所属身份或权限已变化，请重新生成')
      return stored
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityError(404, '文件不存在或不属于当前用户'); throw error }
  }
  private metadataPath(memberId: string, artifact: AssistantArtifact): string { return join(this.store.sessionPath(memberId, artifact.session_id), 'artifacts', `${artifact.artifact_id}.json`) }
  private async save(stored: StoredArtifact): Promise<void> { await this.atomic(this.metadataPath(stored.memberId, stored.metadata), stored) }
  async list(memberId: string, sessionId: string, principal: Principal): Promise<AssistantArtifact[]> {
    await this.store.get(memberId, sessionId)
    if (principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    let names: string[]
    try { names = await readdir(join(this.store.sessionPath(memberId, sessionId), 'artifacts')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: AssistantArtifact[] = []
    for (const name of names) if (/^[0-9a-f-]{36}\.json$/.test(name)) {
      try { const entry = await this.read(memberId, name.slice(0, -5), principal); result.push(entry.metadata) }
      catch (error) { if (!(error instanceof IdentityError && [403, 404].includes(error.status))) throw error }
    }
    return result.sort((a, b) => a.created_at_ms - b.created_at_ms)
  }
  async listSharedHtml(memberId: string, input: unknown, principal: Principal): Promise<SharedHtmlPage> {
    if (principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    const args = record(input)
    if (Object.keys(args).some(key => !['limit', 'offset'].includes(key))) return fail('分享列表仅支持 limit 与 offset 参数')
    const limit = args.limit === undefined ? 50 : args.limit, offset = args.offset === undefined ? 0 : args.offset
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail('分享列表每页需要为 1～100 条')
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return fail('分享列表 offset 需要为非负安全整数')
    const capturedAtMs = this.now()
    let names: string[]
    // ★ 只枚举本人的文件索引，不遍历全局分享目录；管理员也不能因此读取他人会话。
    try { names = await readdir(join(this.root, '.artifact-index', hash(memberId))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    const shares: SharedHtml[] = []
    for (const name of names) if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) {
      try {
        const stored = await this.read(memberId, name.slice(0, -5), principal)
        if (stored.metadata.format !== 'html' || !stored.metadata.share) continue
        const token = stored.metadata.share.url.slice(stored.metadata.share.url.lastIndexOf('/') + 1)
        const active = await this.sharedArtifact(token, this.authorizeOwner ?? (async () => principal))
        if (!active || active.memberId !== memberId || active.metadata.artifact_id !== stored.metadata.artifact_id) continue
        // ⚠️ 分享元数据可能在文件写入失败或会话删除后残留；列表不能把无法读取的 HTML 当成开放页面。
        const file = await open(this.filePath(active), 'r')
        try { if (!(await file.stat()).isFile()) continue }
        finally { await file.close() }
        const metadata = active.metadata, share = metadata.share!
        shares.push({ artifact_id: metadata.artifact_id, session_id: metadata.session_id, title: metadata.title, file_name: metadata.file_name, created_at_ms: metadata.created_at_ms, url: share.url, expires_at_ms: share.expires_at_ms, expires_at_label: `${new Date(share.expires_at_ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（北京时间）` })
      } catch (error) {
        if (!((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof IdentityError && [400, 401, 403, 404].includes(error.status))) throw error
      }
    }
    // ★ 先过滤再分页，失效索引不会造成漏项或错误总数；同一创建时刻按 ID 稳定排序。
    shares.sort((a, b) => b.created_at_ms - a.created_at_ms || a.artifact_id.localeCompare(b.artifact_id))
    const page = shares.slice(offset, offset + limit)
    return { scope: 'current_member', captured_at_ms: capturedAtMs, total: shares.length, offset, limit, next_offset: offset + page.length < shares.length ? offset + page.length : null, shares: page }
  }
  async create(memberId: string, sessionId: string, input: unknown, datasets: AssistantDatasets, principal: Principal): Promise<AssistantArtifact> {
    const args = record(input)
    if (Object.keys(args).some(key => !['format', 'title', 'content', 'dataset_id'].includes(key))) return fail('不支持的文件参数')
    if (!FORMATS.includes(args.format as Format)) return fail('文件格式支持 docx、xlsx、html、md、csv、txt')
    const format = args.format as Format
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(args.title)) return fail('文件标题需要为 1～120 个字符且不含控制字符')
    if (args.content !== undefined && typeof args.content !== 'string') return fail('文件正文需要是文本')
    const content = String(args.content ?? '')
    if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) return fail('文件正文超过 200 KB 上限')
    if (args.dataset_id !== undefined && typeof args.dataset_id !== 'string') return fail('dataset_id 需要来自统计查询结果')
    if (args.dataset_id !== undefined && content) return fail('数据集导出不能混入模型正文，请单独生成说明文件')
    if (!content.trim() && !args.dataset_id) return fail('需要提供正文或已查询的数据集')
    if (principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    await this.store.get(memberId, sessionId)
    let existing: string[] = []
    try { existing = await readdir(join(this.store.sessionPath(memberId, sessionId), 'artifacts')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).length >= MAX_ARTIFACTS) throw new IdentityError(409, '每个会话最多生成 40 个文件')
    const title = args.title.trim()
    const snapshot = args.dataset_id ? datasets.render('table', { dataset_id: args.dataset_id }, principal) : undefined
    const table = snapshot?.table
    const note = snapshot && table ? [
      `数据来源：${snapshot.title}`,
      `采集时间：${new Date(snapshot.captured_at_ms).toISOString()}`,
      `查询范围：${snapshot.description}`,
      `查询条件：${snapshot.query || '默认查询条件'}`,
      `导出行数：${table.rows.length} / ${table.total_rows} 行${table.rows.length < table.total_rows ? '；仅导出当前快照，未包含其余行，请缩小范围或继续分页查询。' : '。'}`,
      ...(snapshot.note ? [snapshot.note] : []),
    ].join('\n') : undefined
    const plain = table ? [table.columns.map(column => column.label).join('\t'), ...table.rows.map(row => table.columns.map(column => String(row[column.key] ?? '')).join('\t'))].join('\n') : content
    const bytes = format === 'docx' ? docx(title, note ?? content, table) : format === 'xlsx' ? xlsx(title, content, table, note) : Buffer.from(format === 'html' ? html(title, note ?? content, table) : format === 'csv' ? csv(table, title, content) : format === 'md' ? `# ${title}\n\n${note ? note + '\n\n' : ''}${plain}\n` : `${title}\n\n${note ? note + '\n\n' : ''}${plain}\n`)
    if (bytes.length > MAX_FILE_BYTES) return fail('文件超过 3 MB 上限，请缩小查询范围')
    const id = randomUUID()
    const metadata: AssistantArtifact = { artifact_id: id, session_id: sessionId, title, format, file_name: cleanName(title, format), size_bytes: bytes.length, created_at_ms: this.now(), download_path: `/api/v1/assistant/artifacts/${id}/download`, ...(note ? { note } : {}) }
    const directory = join(this.store.sessionPath(memberId, sessionId), 'artifacts')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, '.artifact-index', hash(memberId)), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, `${id}.${format}`), bytes, { mode: 0o600, flag: 'wx' })
    await this.save({ metadata, memberId, access: accessOf(principal) })
    await this.atomic(this.indexPath(memberId, id), { sessionId })
    return metadata
  }
  private filePath(stored: StoredArtifact): string { return join(this.store.sessionPath(stored.memberId, stored.metadata.session_id), 'artifacts', `${stored.metadata.artifact_id}.${stored.metadata.format}`) }
  private async response(stored: StoredArtifact, inline: boolean): Promise<Response> {
    const metadata = stored.metadata
    const bytes = await readFile(this.filePath(stored))
    const headers: Record<string, string> = {
      'Content-Type': MIME[metadata.format], 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="assistant-${metadata.artifact_id}.${metadata.format}"; filename*=UTF-8''${encodeURIComponent(metadata.file_name)}`,
    }
    if (metadata.format === 'html') { headers['Content-Security-Policy'] = CSP; headers['X-Frame-Options'] = 'DENY' }
    return new Response(bytes, { headers })
  }
  async download(memberId: string, id: string, principal: Principal): Promise<Response> {
    if (!principal || principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    return this.response(await this.read(memberId, id, principal), false)
  }
  async getMetadata(memberId: string, id: string, principal: Principal): Promise<AssistantArtifact> {
    if (!principal || principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    return (await this.read(memberId, id, principal)).metadata
  }
  async share(memberId: string, id: string, input: unknown, principal: Principal): Promise<AssistantArtifactShare> {
    if (!principal || principal.memberId !== memberId) throw new IdentityError(403, '文件身份不匹配')
    const args = record(input)
    if (Object.keys(args).some(key => key !== 'expires_in_hours') || typeof args.expires_in_hours !== 'number' || !Number.isInteger(args.expires_in_hours) || args.expires_in_hours < 1 || args.expires_in_hours > 720) return fail('分享有效期需要为 1～720 小时的整数')
    const stored = await this.read(memberId, id, principal)
    if (stored.metadata.format !== 'html') return fail('只有 HTML 文件支持网页分享，其他文件请直接导出')
    if (stored.tokenHash) await rm(join(this.root, '.shares', `${stored.tokenHash}.json`), { force: true })
    const token = randomBytes(32).toString('base64url'); const tokenHash = hash(token); const expiresAtMs = this.now() + args.expires_in_hours * 3_600_000
    const shared: AssistantArtifactShare = { url: `${this.publicBaseUrl}/api/v1/assistant/shared/${token}`, expires_at_ms: expiresAtMs }
    await mkdir(join(this.root, '.shares'), { recursive: true, mode: 0o700 })
    stored.tokenHash = tokenHash; stored.metadata.share = shared
    await this.save(stored)
    await this.atomic(join(this.root, '.shares', `${tokenHash}.json`), { memberId, artifactId: id, expiresAtMs } satisfies SharePointer)
    return shared
  }
  async revoke(memberId: string, id: string): Promise<AssistantArtifact> {
    const stored = await this.read(memberId, id)
    if (stored.tokenHash) await rm(join(this.root, '.shares', `${stored.tokenHash}.json`), { force: true })
    delete stored.tokenHash; delete stored.metadata.share
    await this.save(stored)
    return stored.metadata
  }
  // ★ 列表与匿名访问使用同一判定，不能把过期、撤销或权限变化的链接报成仍可访问。
  private async sharedArtifact(token: string, authorizeOwner: AuthorizeOwner | undefined = this.authorizeOwner): Promise<StoredArtifact | null> {
    if (!TOKEN.test(token)) return null
    const tokenHash = hash(token)
    const pointer = JSON.parse(await readFile(join(this.root, '.shares', `${tokenHash}.json`), 'utf8')) as SharePointer
    if (!Number.isSafeInteger(pointer.expiresAtMs) || pointer.expiresAtMs <= this.now()) return null
    const stored = await this.read(pointer.memberId, pointer.artifactId)
    if (stored.tokenHash !== tokenHash || stored.metadata.format !== 'html' || stored.metadata.share?.expires_at_ms !== pointer.expiresAtMs || stored.metadata.share.url.slice(stored.metadata.share.url.lastIndexOf('/') + 1) !== token) return null
    if (authorizeOwner) { const principal = await authorizeOwner(pointer.memberId); if (!principal || accessOf(principal) !== stored.access) return null }
    return stored
  }
  async publicShare(token: string, authorizeOwner?: AuthorizeOwner): Promise<Response> {
    const gone = () => new Response('分享链接不存在、已撤销或已过期', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
    try {
      const stored = await this.sharedArtifact(token, authorizeOwner)
      return stored ? await this.response(stored, true) : gone()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof IdentityError && [400, 401, 403, 404].includes(error.status)) return gone()
      throw error
    }
  }
}
