/** 附件 HTTP 链路：真实 multipart、内容解析、模型入参、私有历史与撤权后的下载。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { createHandlerFor } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'
import type { AssistantEngine, AssistantRun } from '../src/assistant/runtime.js'
import type { AssistantDetail, AssistantEvent } from '@ai-token-report/shared'

const root = await mkdtemp(join(tmpdir(), 'atr-assistant-upload-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'upload-a', name: '上传甲', role: 'member' },
  { token: 'upload-b', name: '上传乙', role: 'member' },
  { token: 'upload-admin', name: '上传管理员', role: 'admin' },
])
const captured: AssistantRun[] = []
const engine: AssistantEngine = { supportsImages: true, async run(input) {
  captured.push(input)
  input.emit({ type: 'text', text: '已读取附件' })
} }
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, assistantEngine: engine, requestLog: false })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK2kAAAAASUVORK5CYII=', 'base64')
for (let offset = 8; offset < png.length;) {
  const size = png.readUInt32BE(offset)
  png.writeUInt32BE(crc32(png.subarray(offset + 4, offset + 8 + size)), offset + 8 + size)
  offset += 12 + size
}
function call(path: string, token = 'upload-a', method = 'GET', body?: FormData | string) {
  return bundle.handler(new Request(`http://localhost/api/v1/assistant/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) }, body,
  }))
}
function form(files: File[], prompt?: string, sessionId?: string) {
  const body = new FormData()
  if (prompt !== undefined) body.set('prompt', prompt)
  if (sessionId) body.set('session_id', sessionId)
  for (const file of files) body.append('files', file)
  return body
}
async function events(response: Response): Promise<AssistantEvent[]> {
  expect(response.status).toBe(200)
  return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-assistant-upload-'))) throw new Error('测试目录越界')
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('图片和中文文本经解析进入模型，私有历史保留原始附件并可下载', async () => {
  const text = '项目复盘\n这是上传的中文资料。'
  const output = await events(await call('chat', 'upload-a', 'POST', form([
    new File([text], '复盘.md', { type: 'text/markdown' }), new File([png], '截图.png', { type: 'image/png' }),
  ], '结合两个附件分析')))
  const session = output.find(event => event.type === 'session')!
  if (session.type !== 'session') throw new Error('缺少会话事件')
  const accepted = output.find(event => event.type === 'attachments')!
  if (accepted.type !== 'attachments') throw new Error('缺少附件事件')
  expect(output.at(-1)?.type).toBe('done')
  expect(accepted.attachments.map(item => [item.file_name, item.kind])).toEqual([['复盘.md', 'text'], ['截图.png', 'image']])
  expect(captured.at(-1)?.prompt).toBe('结合两个附件分析')
  expect(captured.at(-1)?.attachments?.[0]?.text).toContain(text)
  expect(captured.at(-1)?.attachments?.[1]?.image).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
  const id = session.session.session_id
  const detail = await call(`sessions/${id}`).then(response => response.json()) as AssistantDetail
  expect(detail.messages[0]?.attachments).toEqual(accepted.attachments)
  expect(JSON.stringify(detail)).not.toContain('这是上传的中文资料')
  const attachmentId = accepted.attachments[0]!.attachment_id
  const path = `sessions/${id}/attachments/${attachmentId}/download`
  const download = await call(path)
  expect(download.status).toBe(200)
  expect(await download.text()).toBe(text)
  expect(download.headers.get('cache-control')).toContain('no-store')
  expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''")
  expect((await call(path, '')).status).toBe(401)
  expect((await call(path, 'upload-b')).status).toBe(404)
  expect((await call(path, 'upload-admin')).status).toBe(404)
  expect((await call(`sessions/${id}/attachments/../download`)).status).not.toBe(200)
  await events(await call('chat', 'upload-a', 'POST', JSON.stringify({ prompt: '继续分析', session_id: id })))
  expect(captured.at(-1)?.attachments).toBeUndefined()
  expect((await call(`sessions/${id}`, 'upload-a', 'DELETE')).status).toBe(200)
  expect((await call(path)).status).toBe(404)
})

test('只发附件有默认问题；JSON文字提问仍兼容', async () => {
  await events(await call('chat', 'upload-a', 'POST', form([new File(['仅附件正文'], '说明.txt')], '   ')))
  expect(captured.at(-1)?.prompt).toBe('请分析上传的附件。')
  await events(await call('chat', 'upload-a', 'POST', JSON.stringify({ prompt: '正常文字' })))
  expect(captured.at(-1)?.prompt).toBe('正常文字')
})

test('格式或限额错误拒绝整批，不调用模型、不创建会话，修正后可重试', async () => {
  const before = captured.length
  const sessionsBefore = await call('sessions').then(response => response.json())
  for (const [files, expected] of [
    [[new File(['伪图片'], 'fake.png')], 400],
    [[new File(['旧Word'], 'legacy.doc')], 415],
    [[new File([''], 'empty.txt')], 400],
    [Array.from({ length: 7 }, (_, index) => new File(['正文'], `${index}.txt`)), 413],
  ] as [File[], number][]) {
    expect((await call('chat', 'upload-a', 'POST', form(files, '分析'))).status).toBe(expected)
  }
  const invalid = form([new File(['正文'], 'a.txt')], '提问')
  invalid.set('member_id', '别人的身份')
  expect((await call('chat', 'upload-a', 'POST', invalid)).status).toBe(400)
  const repeated = form([new File(['正文'], 'a.txt')], '提问')
  repeated.append('prompt', '第二个提问')
  expect((await call('chat', 'upload-a', 'POST', repeated)).status).toBe(400)
  expect((await call('chat', '', 'POST', form([new File(['正文'], 'a.txt')], '提问'))).status).toBe(401)
  expect(captured.length).toBe(before)
  expect(await call('sessions').then(response => response.json())).toEqual(sessionsBefore)
  await events(await call('chat', 'upload-a', 'POST', form([new File(['正文'], 'a.txt')], '重试')))
  expect(captured.length).toBe(before + 1)
})

test('未声明视觉能力的模型拒绝图片并在状态中明确能力', async () => {
  const plain = await createHandlerFor({ dshHome: root, dataDir: join(root, 'plain'), dbPath, assistantEngine: { async run() { throw new Error('不应调用') } }, requestLog: false })
  try {
    const status = await plain.handler(new Request('http://localhost/api/v1/assistant/status', { headers: { Authorization: 'Bearer upload-a' } })).then(response => response.json())
    expect(status.supports_images).toBe(false)
    const response = await plain.handler(new Request('http://localhost/api/v1/assistant/chat', { method: 'POST', headers: { Authorization: 'Bearer upload-a' }, body: form([new File([png], '图片.png')], '识别图像') }))
    expect(response.status).toBe(415)
    expect((await response.json()).reason).toContain('图片理解')
  } finally { await plain.close() }
})
