/** 文件导出的 Office 结构、数值来源与分享失效边界，防止私有数据从生成入口绕过权限。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { AssistantStore } from '../src/assistant/store.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { IdentityError, type Principal } from '../src/identity/types.js'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) })
const owner: Principal = { memberId: '文件归属甲', name: '甲', groupIds: ['一组'], groupNames: ['一组'], roleCodes: ['member'], permissions: ['stats:read'], auth: { kind: 'session', sessionId: randomUUID(), accountId: randomUUID() } }
const other: Principal = { ...owner, memberId: '文件归属乙', name: '乙' }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'atr-artifacts-')); roots.push(root)
  let now = 1_790_000_000_000
  const store = new AssistantStore(root); const session = (await store.create(owner.memberId)).session.session_id
  const artifacts = new AssistantArtifacts(root, 'https://example.test/ai-token', () => now)
  const datasets = new AssistantDatasets()
  const captured = datasets.capture('breakdown', 'by=model', { by: 'model', rows: [{ key: '=HYPERLINK("https://evil.test")', totalTokens: 123456789, inputTokens: 11, outputTokens: 12, cacheReadTokens: 123456766, cacheWriteTokens: 0, calls: 3, cacheHitRate: 0.875 }] }, owner)
  return { root, store, session, artifacts, datasets, datasetId: captured.dataset_id!, setNow: (value: number) => { now = value }, now: () => now }
}
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)
function unzip(bytes: Buffer): Record<string, string> {
  const entries: Record<string, string> = {}; let offset = 0; let count = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 6)).toBe(0x800)
    expect(bytes.readUInt16LE(offset + 8)).toBe(8)
    const compressedSize = bytes.readUInt32LE(offset + 18); const size = bytes.readUInt32LE(offset + 22); const nameSize = bytes.readUInt16LE(offset + 26); const extraSize = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameSize + extraSize
    const file = inflateRawSync(bytes.subarray(start, start + compressedSize))
    expect(file.length).toBe(size)
    entries[bytes.subarray(offset + 30, offset + 30 + nameSize).toString()] = file.toString()
    offset = start + compressedSize; count++
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50)
  const end = bytes.length - 22
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50)
  expect(bytes.readUInt16LE(end + 8)).toBe(count)
  expect(bytes.readUInt32LE(end + 16)).toBe(offset)
  expect(bytes.readUInt32LE(end + 12)).toBe(end - offset)
  return entries
}
test('Word 下载是有效 OOXML ZIP；标题、正文与数据集表格会转义 XML', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'docx', title: '中文 & <报告>', content: '第一行\n第二行 <script>alert(1)</script>' }, f.datasets, owner)
  const response = await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes.length).toBe(artifact.size_bytes)
  const entries = unzip(bytes)
  expect(entries['[Content_Types].xml']).toContain('/word/document.xml')
  expect(entries['_rels/.rels']).toContain('Target="word/document.xml"')
  expect(entries['word/document.xml']).toContain('中文 &amp; &lt;报告&gt;')
  expect(entries['word/document.xml']).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  const table = await f.artifacts.create(owner.memberId, f.session, { format: 'docx', title: '真实数据', dataset_id: f.datasetId }, f.datasets, owner)
  const exported = unzip(Buffer.from(await (await f.artifacts.download(owner.memberId, table.artifact_id, owner)).arrayBuffer()))
  expect(exported['word/document.xml']).toContain('<w:tbl>')
  expect(exported['word/document.xml']).toContain('123456789')
})
test('Excel 保持服务端真实数值与列；公式外观写为字符串且没有公式节点', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '统计数据', dataset_id: f.datasetId }, f.datasets, owner)
  const response = await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)
  expect(response.headers.get('content-type')).toContain('spreadsheetml.sheet')
  const entries = unzip(Buffer.from(await response.arrayBuffer()))
  expect(Object.keys(entries)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'])
  expect(entries['xl/_rels/workbook.xml.rels']).toContain('Target="worksheets/sheet1.xml"')
  expect(entries['xl/worksheets/sheet1.xml']).toContain('<v>123456789</v>')
  expect(entries['xl/worksheets/sheet1.xml']).toContain('<v>0.875</v>')
  expect(entries['xl/worksheets/sheet1.xml']).toContain('t="inlineStr"')
  expect(entries['xl/worksheets/sheet1.xml']).toContain('=HYPERLINK(&quot;https://evil.test&quot;)')
  expect(entries['xl/worksheets/sheet1.xml']).not.toContain('<f>')
})
test('Excel 超长正文分多个单元格，避免生成无法打开的工作簿', async () => {
  const f = await fixture(); const content = '长'.repeat(40000)
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '长内容', content }, f.datasets, owner)
  const entries = unzip(Buffer.from(await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).arrayBuffer()))
  const sheet = entries['xl/worksheets/sheet1.xml']!
  expect(sheet).toContain('<row r="3">')
  const text = [...sheet.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map(match => match[1]!)
  expect(text.every(value => value.length <= 32767)).toBe(true)
  expect(text.slice(1).join('')).toBe(content)
})
for (const format of ['html', 'md', 'csv', 'txt'] as const) test(`${format} 文本导出有正确扩展名、下载头与可恢复的私有元数据`, async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format, title: '我的/统计:报告', content: '导出正文' }, f.datasets, owner)
  expect(artifact.file_name).toBe(`我的_统计_报告.${format}`)
  expect(artifact.download_path).toBe(`/api/v1/assistant/artifacts/${artifact.artifact_id}/download`)
  const restored = new AssistantArtifacts(f.root)
  expect(await restored.list(owner.memberId, f.session, owner)).toEqual([artifact])
  const response = await restored.download(owner.memberId, artifact.artifact_id, owner)
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-disposition')).toContain('attachment;')
  expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''")
  expect(await response.text()).toContain('导出正文')
})
test('HTML 正文与数据单元格不能执行脚本、表单、外链或读取同源凭证', async () => {
  const f = await fixture(); const attack = '<script>fetch("/api/v1/auth/me")</script><img src="https://evil.test"><form action="https://evil.test">'
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '<script>标题</script>', content: attack }, f.datasets, owner)
  const response = await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)
  const html = await response.text()
  expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).not.toContain('<form')
  expect(html).toContain('&lt;script&gt;')
  expect(response.headers.get('content-security-policy')).toContain('sandbox;')
  expect(response.headers.get('content-security-policy')).toContain("script-src 'none'")
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
  expect(response.headers.get('content-security-policy')).toContain("form-action 'none'")
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('x-frame-options')).toBe('DENY')
})
test('HTML 将基础 Markdown 排成标题、列表、段落和代码；任何标签仍然转义', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '阅读报告', content: '# 章节\n\n一段 **重点** 与 `标识符`。\n\n- 项目甲\n- <iframe src="/api">\n\n```html\n<script>alert(1)</script>\n```' }, f.datasets, owner)
  const html = await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).text()
  expect(html).toContain('<h2>章节</h2>')
  expect(html).toContain('<strong>重点</strong>')
  expect(html).toContain('<code>标识符</code>')
  expect(html).toContain('<ul><li>项目甲</li>')
  expect(html).toContain('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>')
  expect(html).not.toContain('<iframe')
})
test('CSV 真实数字保持原值，公式外观字符串加文本前缀', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'csv', title: 'CSV', dataset_id: f.datasetId }, f.datasets, owner)
  const csv = await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).text()
  expect(csv).toContain('"123456789"')
  expect(csv).toContain('"\'=HYPERLINK(""https://evil.test"")"')
})
test('跨人员无法生成、下载、分享、撤销或查看别人的文件', async () => {
  const f = await fixture(); await f.store.create(other.memberId)
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '私有', content: '秘密正文' }, f.datasets, owner)
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'txt', title: '错误', content: 'x' }, f.datasets, other)).rejects.toThrow('身份不匹配')
  await expect(f.artifacts.download(other.memberId, artifact.artifact_id, other)).rejects.toThrow('文件不存在')
  await expect(f.artifacts.download(owner.memberId, artifact.artifact_id, other)).rejects.toThrow('身份不匹配')
  await expect(f.artifacts.share(other.memberId, artifact.artifact_id, { expires_in_hours: 1 }, other)).rejects.toThrow('文件不存在')
  await expect(f.artifacts.revoke(other.memberId, artifact.artifact_id)).rejects.toThrow('文件不存在')
  await expect(f.artifacts.list(owner.memberId, f.session, other)).rejects.toThrow('身份不匹配')
})
test('权限、角色、分组变化后不能导出旧数据集或下载/分享旧文件；仍允许owner撤销', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '真实数据', dataset_id: f.datasetId }, f.datasets, owner)
  for (const current of [{ ...owner, permissions: [] }, { ...owner, roleCodes: ['admin'] }, { ...owner, groupIds: ['二组'] }]) {
    await expect(f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '撤权数据', dataset_id: f.datasetId }, f.datasets, current)).rejects.toThrow('身份或权限')
    await expect(f.artifacts.download(owner.memberId, artifact.artifact_id, current)).rejects.toThrow('身份或权限')
    await expect(f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, current)).rejects.toThrow('身份或权限')
    expect(await f.artifacts.list(owner.memberId, f.session, current)).toEqual([])
  }
  await f.artifacts.revoke(owner.memberId, artifact.artifact_id)
})
test('拒绝在数据集导出中混入模型正文或捏造行，并复验数据集owner', async () => {
  const f = await fixture()
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '捏造', dataset_id: f.datasetId, content: '总量99999' }, f.datasets, owner)).rejects.toThrow('不能混入')
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '捏造', dataset_id: f.datasetId, rows: [{ total_tokens: 99999 }] }, f.datasets, owner)).rejects.toThrow('不支持')
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '不存在', dataset_id: randomUUID() }, f.datasets, owner)).rejects.toThrow('数据集不存在')
  const session = (await f.store.create(other.memberId)).session.session_id
  await expect(f.artifacts.create(other.memberId, session, { format: 'xlsx', title: '跨owner', dataset_id: f.datasetId }, f.datasets, other)).rejects.toThrow('身份或权限')
})
test('分享令牌具有256位随机熵；有效期结束精确返回410且缓存不可保留', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '分享', content: '公开快照' }, f.datasets, owner)
  const share = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  expect(share.url).toStartWith('https://example.test/ai-token/api/v1/assistant/shared/')
  expect(tokenOf(share.url)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(Buffer.from(tokenOf(share.url), 'base64url').length).toBe(32)
  const response = await f.artifacts.publicShare(tokenOf(share.url), async () => owner)
  expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('inline;')
  const html = await response.text(); expect(html).toContain('公开快照'); expect(html).not.toContain(owner.memberId); expect(html).not.toContain(owner.auth.sessionId)
  f.setNow(share.expires_at_ms - 1); expect((await f.artifacts.publicShare(tokenOf(share.url))).status).toBe(200)
  f.setNow(share.expires_at_ms)
  const expired = await f.artifacts.publicShare(tokenOf(share.url))
  expect(expired.status).toBe(410); expect(expired.headers.get('cache-control')).toBe('no-store')
})
test('重建分享会废弃旧链接；撤销立即失效；metadata恢复后保持链接', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '分享', content: '快照' }, f.datasets, owner)
  const first = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  const second = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 720 }, owner)
  expect(first.url).not.toBe(second.url)
  expect((await f.artifacts.publicShare(tokenOf(first.url))).status).toBe(410)
  expect((await f.artifacts.publicShare(tokenOf(second.url))).status).toBe(200)
  expect((await f.artifacts.list(owner.memberId, f.session, owner))[0]?.share).toEqual(second)
  await f.artifacts.revoke(owner.memberId, artifact.artifact_id)
  expect((await f.artifacts.publicShare(tokenOf(second.url))).status).toBe(410)
  expect((await f.artifacts.list(owner.memberId, f.session, owner))[0]?.share).toBeUndefined()
})
test('公开分享会复验创建人的现有权限；停用owner或撤权返回410', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '分享', content: '快照' }, f.datasets, owner)
  const share = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  expect((await f.artifacts.publicShare(tokenOf(share.url), async memberId => memberId === owner.memberId ? owner : null)).status).toBe(200)
  expect((await f.artifacts.publicShare(tokenOf(share.url), async () => null)).status).toBe(410)
  expect((await f.artifacts.publicShare(tokenOf(share.url), async () => ({ ...owner, permissions: [] }))).status).toBe(410)
  expect((await f.artifacts.publicShare(tokenOf(share.url), async () => { throw new IdentityError(401, '凭证已过期') })).status).toBe(410)
})
test('删除会话后，既有索引不能复活文件或公开链接', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '分享', content: '快照' }, f.datasets, owner)
  const share = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  await f.store.delete(owner.memberId, f.session)
  expect((await f.artifacts.publicShare(tokenOf(share.url))).status).toBe(410)
  await expect(f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).rejects.toThrow('会话不存在')
})
test('未知令牌、路径穿越、非法标题/格式/有效期与超长正文全部拒绝', async () => {
  const f = await fixture()
  for (const token of ['', '../secret', 'a'.repeat(43), '%2e%2e', 'a'.repeat(100)]) expect((await f.artifacts.publicShare(token)).status).toBe(410)
  for (const id of ['../secret', '..\\secret', 'not-a-uuid']) await expect(f.artifacts.download(owner.memberId, id, owner)).rejects.toThrow('文件 ID 无效')
  for (const args of [null, { format: 'exe', title: '标题', content: 'x' }, { format: 'txt', title: '', content: 'x' }, { format: 'txt', title: '换\n行', content: 'x' }, { format: 'txt', title: '标题', content: '' }, { format: 'txt', title: '标题', content: '中'.repeat(70000) }, { format: 'txt', title: '标题', content: {}, path: '../secret' }]) await expect(f.artifacts.create(owner.memberId, f.session, args, f.datasets, owner)).rejects.toBeInstanceOf(IdentityError)
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '有效', content: 'x' }, f.datasets, owner)
  for (const hours of [0, -1, 721, 1.5, NaN, Infinity, '24', undefined]) await expect(f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: hours }, owner)).rejects.toThrow('1～720')
})
test('Word/Excel 等附件没有公开浏览接口；分享站点地址不能携带凭证或脚本协议', async () => {
  const f = await fixture()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'docx', title: '附件', content: 'x' }, f.datasets, owner)
  await expect(f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)).rejects.toThrow('只有 HTML')
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test?credential=secret', 'https://example.test#secret']) expect(() => new AssistantArtifacts(f.root, url)).toThrow()
})
test('每会话40个文件限额不能通过修改权限绕过；其他会话仍可创建', async () => {
  const f = await fixture()
  for (let i = 0; i < 40; i++) await f.artifacts.create(owner.memberId, f.session, { format: 'txt', title: `文件 ${i}`, content: 'x' }, f.datasets, owner)
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'txt', title: '超量', content: 'x' }, f.datasets, owner)).rejects.toThrow('40')
  await expect(f.artifacts.create(owner.memberId, f.session, { format: 'txt', title: '换scope超量', content: 'x' }, f.datasets, { ...owner, permissions: [] })).rejects.toThrow('40')
  const session = (await f.store.create(owner.memberId)).session.session_id
  const next = await f.artifacts.create(owner.memberId, session, { format: 'txt', title: '新会话', content: 'x' }, f.datasets, owner)
  expect(next.session_id).toBe(session)
})
test('分页快照导出明确行数、采集时间、查询条件与说明；Excel数值sheet不挪行', async () => {
  const f = await fixture()
  const snapshot = f.datasets.capture('records', 'period=last7d&limit=2&offset=4', { rows: [{ ts: 1700000000000, model: '模型甲', totalTokens: 11 }, { ts: 1700000001000, model: '模型乙', totalTokens: 22 }], offset: 4, total: 1000 }, owner)
  for (const format of ['docx', 'xlsx', 'html', 'md', 'txt', 'csv'] as const) {
    const artifact = await f.artifacts.create(owner.memberId, f.session, { format, title: '分页快照', dataset_id: snapshot.dataset_id }, f.datasets, owner)
    expect(artifact.note).toContain('导出行数：2 / 1000 行；仅导出当前快照')
    expect(artifact.note).toContain('采集时间：')
    expect(artifact.note).toContain('period=last7d&limit=2&offset=4')
    expect(artifact.note).toContain('起始位置 4')
    const bytes = Buffer.from(await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).arrayBuffer())
    if (format === 'xlsx') {
      const entries = unzip(bytes)
      expect(entries['xl/workbook.xml']).toContain('name="说明"')
      expect(entries['xl/worksheets/sheet2.xml']).toContain('导出行数：2 / 1000')
      expect(entries['xl/worksheets/sheet1.xml']).toContain('<row r="2">')
      expect(entries['xl/worksheets/sheet1.xml']).toContain('<v>11</v>')
    } else if (format === 'docx') expect(unzip(bytes)['word/document.xml']).toContain('导出行数：2 / 1000')
    // HTML 页把说明拆成「事实键 / 值」两栏（键与值各自一个节点），其它文本格式保留整行写法。
    else if (format === 'html') expect(bytes.toString()).toContain('<dt>导出行数</dt><dd>2 / 1000 行')
    else if (format !== 'csv') expect(bytes.toString()).toContain('导出行数：2 / 1000')
  }
})

for (const format of ['docx', 'xlsx', 'html', 'md'] as const) test(`${format} 多节报表保留每个授权快照的原值、查询、行数与采集时间`, async () => {
  const f = await fixture()
  const query = 'period=last7d&limit=2&offset=4'
  const snapshot = f.datasets.capture('records', query, { rows: [{ ts: 1700000000000, model: '<script>甲|乙</script>', totalTokens: 11 }, { ts: 1700000001000, model: '模型乙', totalTokens: 22 }], offset: 4, total: 1000 }, owner)
  const capturedAt = new Date(snapshot.captured_at_ms).toISOString()
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format, title: '管理报表', dataset_ids: [f.datasetId, snapshot.dataset_id] }, f.datasets, owner)
  expect(artifact.note).toContain('第 1 节：模型用量分布')
  expect(artifact.note).toContain('第 2 节：调用明细')
  expect(artifact.note).toContain('导出行数：1 / 1 行。')
  expect(artifact.note).toContain('导出行数：2 / 1000 行；仅导出当前快照')
  expect(artifact.note).toContain(`采集时间：${capturedAt}`)
  expect(artifact.note).toContain(`报表生成时间：${new Date(f.now()).toISOString()}`)
  expect(artifact.note).toContain(query)
  expect(artifact.note).toContain('起始位置 4')
  const response = await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)
  const bytes = Buffer.from(await response.arrayBuffer())
  const text = ['docx', 'xlsx'].includes(format) ? Object.values(unzip(bytes)).join('\n') : bytes.toString()
  // HTML 页按列做展示格式（计数加千分位），其它格式保留原始数值写法。
  expect(text).toContain(format === 'html' ? '123,456,789' : '123456789')
  expect(text).toContain('11')
  expect(text).toContain('22')
  expect(text).toContain('模型用量分布')
  expect(text).toContain('调用明细')
  expect(text).toContain(format === 'html' ? '<dt>导出行数</dt><dd>2 / 1000 行' : '导出行数：2 / 1000')
  expect(text).toContain('起始位置 4')
  expect(text).toContain('&lt;script&gt;')
  expect(text).not.toContain('<script>')
  expect(text).not.toContain(f.root)
  if (format === 'xlsx') {
    const entries = unzip(bytes)
    expect(entries['xl/workbook.xml']).toContain('name="模型用量分布" sheetId="1"')
    expect(entries['xl/workbook.xml']).toContain('name="调用明细" sheetId="2"')
    expect(entries['xl/workbook.xml']).toContain('name="说明" sheetId="3"')
    expect(entries['xl/worksheets/sheet1.xml']).toContain('<v>123456789</v>')
    expect(entries['xl/worksheets/sheet1.xml']).toContain('t="inlineStr"')
    expect(entries['xl/worksheets/sheet2.xml']).toContain('<v>11</v>')
    expect(entries['xl/worksheets/sheet2.xml']).toContain('<row r="2">')
    expect(entries['xl/worksheets/sheet3.xml']).toContain(`采集时间：${capturedAt}`)
    expect(text).not.toContain('<f>')
  } else if (format === 'docx') expect((text.match(/<w:tbl>/g) ?? []).length).toBe(2)
  else if (format === 'html') expect((text.match(/<section[\s>]/g) ?? []).length).toBe(2)
  else expect(text).toContain('## 调用明细')
})

/**
 * 分享页的形状约定：时刻统一成「年月日时分秒」、说明拆成事实行 + 页脚「口径与边界」、
 * 数值按列格式美化。三条都是**展示**约定 —— 任何一条失效，页面就退回
 * 「一坨 ISO 时间 + 每节重复一遍的说明」这种没人愿意读的形态。
 */
test('HTML 页时刻写成 年月日时分秒、说明收敛成事实行与页脚边界、数值按列格式化', async () => {
  const f = await fixture()
  const second = f.datasets.capture('breakdown', 'by=model', { by: 'model', rows: [{ key: '模型乙', totalTokens: 22, calls: 1, cacheHitRate: 0.875 }] }, owner)
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '管理周报 · 2026-10-05 00:00:00 — 2026-10-11 23:59:59', dataset_ids: [f.datasetId, second.dataset_id] }, f.datasets, owner)
  const html = await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).text()
  const stamp = (ms: number) => new Date(ms).toLocaleString('sv-SE')
  // 1. 页面上不出现 `2026-10-13T15:46:26.835Z` 这种机器写法。
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  expect(html).toContain(`<dt>报表生成时间</dt><dd>${stamp(f.now())}</dd>`)
  expect(html).toMatch(/<dt>采集时间<\/dt><dd>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/dd>/)
  // 2. 说明拆成事实行；口径与边界收进一处可折叠块，不再以 <pre> 整段铺开。
  expect(html).not.toContain('<pre>')
  expect(html).toContain('<dt>导出行数</dt><dd>')
  expect(html).toContain('<summary>口径与边界')
  expect(html.match(/<summary>/g)).toHaveLength(1)
  // 3. 数值按列格式：比率 → 百分数（与看板同为 1 位小数），计数 → 千分位。
  expect(html).toContain('<td class="num">87.5%</td>')
  expect(html).toContain('<td class="num">123,456,789</td>')
})
test('多节 Excel 同名与非法名称不会覆盖工作表；八个数据集分别保留且都有出处', async () => {
  const f = await fixture()
  const snapshots = Array.from({ length: 8 }, (_, index) => f.datasets.capture('breakdown', `by=model&period=last7d&offset=${index}`, { by: 'model', rows: [{ key: `模型${index}`, totalTokens: index + 100 }] }, owner))
  snapshots[0]!.title = '说明'
  snapshots[1]!.title = "'A:/非法[名称]*?\\工作表'"
  snapshots[2]!.title = 'CASE'
  snapshots[3]!.title = 'case'
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '八维度', dataset_ids: snapshots.map(snapshot => snapshot.dataset_id) }, f.datasets, owner)
  const entries = unzip(Buffer.from(await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).arrayBuffer()))
  const names = [...entries['xl/workbook.xml']!.matchAll(/<sheet name="([^"]+)"/g)].map(match => match[1]!)
  expect(names.length).toBe(9)
  expect(new Set(names.map(name => name.toLowerCase())).size).toBe(9)
  expect(names.every(name => name.length <= 31 && !/[\[\]:*?/\\]/.test(name))).toBe(true)
  expect(names[8]).toBe('说明')
  for (let index = 0; index < 8; index++) {
    expect(entries[`xl/worksheets/sheet${index + 1}.xml`]).toContain(`<v>${index + 100}</v>`)
    expect(artifact.note).toContain(`offset=${index}`)
  }
})

test('多数据集参数严格互斥、去重与限额，CSV/TXT 明确要求单个数据集', async () => {
  const f = await fixture()
  for (const datasetIds of [null, '', [], [1], [''], [f.datasetId, f.datasetId], Array.from({ length: 9 }, () => randomUUID())]) {
    await expect(f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '非法', dataset_ids: datasetIds }, f.datasets, owner)).rejects.toThrow('1～8 个不重复')
  }
  for (const extra of [{ dataset_id: f.datasetId }, { content: '模型捏造99999' }, { content: '' }]) {
    await expect(f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '混入', dataset_ids: [f.datasetId], ...extra }, f.datasets, owner)).rejects.toThrow('不能混入')
  }
  for (const format of ['csv', 'txt'] as const) {
    const second = f.datasets.capture('overview', 'period=today', { totalTokens: 7 }, owner)
    await expect(f.artifacts.create(owner.memberId, f.session, { format, title: '多节', dataset_ids: [f.datasetId, second.dataset_id] }, f.datasets, owner)).rejects.toThrow('仅支持单个数据集')
    const artifact = await f.artifacts.create(owner.memberId, f.session, { format, title: '单节', dataset_ids: [f.datasetId] }, f.datasets, owner)
    expect(await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).text()).toContain('123456789')
  }
})

test('多节有任一数据集不存在或scope失效，整份拒绝且不产生部分文件', async () => {
  const f = await fixture()
  const foreign = f.datasets.capture('overview', 'period=today', { totalTokens: 999 }, other)
  for (const datasetIds of [[f.datasetId, randomUUID()], [f.datasetId, foreign.dataset_id]]) {
    await expect(f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '全部拒绝', dataset_ids: datasetIds }, f.datasets, owner)).rejects.toBeInstanceOf(IdentityError)
    expect(await f.artifacts.list(owner.memberId, f.session, owner)).toEqual([])
  }
  const second = f.datasets.capture('overview', 'period=today', { totalTokens: 7 }, owner)
  const ids = [f.datasetId, second.dataset_id]
  for (const current of [{ ...owner, permissions: [] }, { ...owner, roleCodes: ['admin'] }, { ...owner, groupIds: ['二组'] }]) {
    await expect(f.artifacts.create(owner.memberId, f.session, { format: 'xlsx', title: '已失效', dataset_ids: ids }, f.datasets, current)).rejects.toThrow('身份或权限')
    expect(await f.artifacts.list(owner.memberId, f.session, owner)).toEqual([])
  }
})

test('多节 HTML 分享沿用权限与撤销边界，不泄露私有存储位置', async () => {
  const f = await fixture()
  const second = f.datasets.capture('overview', 'period=today', { totalTokens: 7 }, owner)
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format: 'html', title: '私有报表', dataset_ids: [f.datasetId, second.dataset_id] }, f.datasets, owner)
  const share = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  const response = await f.artifacts.publicShare(tokenOf(share.url), async () => owner)
  const page = await response.text()
  expect(response.status).toBe(200)
  expect(page).toContain('模型用量分布')
  expect(page).toContain('用量总览')
  expect(page).not.toContain(f.root)
  expect(page).not.toContain(owner.memberId)
  expect(response.headers.get('content-security-policy')).toContain("script-src 'none'")
  await expect(f.artifacts.download(owner.memberId, artifact.artifact_id, { ...owner, permissions: [] })).rejects.toThrow('身份或权限')
  expect((await f.artifacts.publicShare(tokenOf(share.url), async () => ({ ...owner, permissions: [] }))).status).toBe(410)
  await f.artifacts.revoke(owner.memberId, artifact.artifact_id)
  expect((await f.artifacts.publicShare(tokenOf(share.url))).status).toBe(410)
})

for (const format of ['docx', 'xlsx', 'html', 'md'] as const) test(`${format} 多节说明保留诊断与概览独有的指标卡，不从表格推算总量`, async () => {
  const f = await fixture()
  const diagnostics = f.datasets.capture('diagnostics', 'period=last7d', { totalEvents: 9876543, unattributedEvents: 4313, identityViolations: 678, sessions: 22222, sources: [{ source: 'codex', latestEventTs: 1700000000000, silentForMs: 42 }] }, owner)
  const overview = f.datasets.capture('overview', 'period=last7d', { totalTokens: 100, sessions: 76543, calls: 9 }, owner)
  const diagnosticTable = f.datasets.render('table', { dataset_id: diagnostics.dataset_id }, owner)
  expect(diagnosticTable.cards).toBeUndefined()
  expect(diagnosticTable.table!.rows[0]).not.toHaveProperty('totalEvents')
  const artifact = await f.artifacts.create(owner.memberId, f.session, { format, title: '管理诊断', dataset_ids: [diagnostics.dataset_id, overview.dataset_id] }, f.datasets, owner)
  const expected = ['指标卡：已入库事件：9,876,543', '指标卡：未归属事件：4,313', '指标卡：口径校验异常：678', '指标卡：会话数：22,222', '指标卡：会话数：76,543']
  const bytes = Buffer.from(await (await f.artifacts.download(owner.memberId, artifact.artifact_id, owner)).arrayBuffer())
  const entries = ['docx', 'xlsx'].includes(format) ? unzip(bytes) : undefined
  const content = entries ? Object.values(entries).join('\n') : bytes.toString()
  for (const value of expected) {
    expect(artifact.note).toContain(value)
    // HTML 页把指标卡拆成「名称 / 值」两个节点（卡片样式需要分栏），文本格式保留整行写法。
    const card = value.slice('指标卡：'.length), at = card.indexOf('：')
    expect(content).toContain(format === 'html'
      ? `<span class="chip-k">${card.slice(0, at)}</span><span class="chip-v">${card.slice(at + 1)}</span>`
      : value)
  }
  if (format === 'xlsx') for (const value of expected) expect(entries!['xl/worksheets/sheet3.xml']).toContain(value)
})
