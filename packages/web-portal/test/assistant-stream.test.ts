/** SSE 网络边界：中文字符和事件可以被网络任意拆开，心跳不能变成消息。 */
import { afterEach, expect, test } from 'bun:test'
import { chatAssistant, consumeAssistantStream, downloadAssistantAttachment, steerAssistant } from '../src/api/assistant.js'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
test('逐字节拆分的中文与心跳仍生成完整事件', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\n\ndata: {"type":"text","text":"中文回答"}\n\ndata: {"type":"done"}\n\n')
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close() } })
  const events: unknown[] = []
  await consumeAssistantStream(stream, event => events.push(event))
  expect(events).toEqual([{ type: 'text', text: '中文回答' }, { type: 'done' }])
})
test('连接中途断开需要显示失败，不能当成回答完成', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"text","text":"半段"}\n\n')); c.close() } })
  await expect(consumeAssistantStream(stream, () => {})).rejects.toThrow('连接中断')
})
test('动作、文件和带筛选导航都保留结构化事件', async () => {
  const events = [{ type: 'action', action: { action_id: 'a', status: 'pending' } }, { type: 'artifact', artifact: { artifact_id: 'f', format: 'xlsx' } }, { type: 'navigate', path: '/records', filters: { period: 'month', model: '模型甲' }, search: '规则甲' }, { type: 'done' }]
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const event of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); c.close() } })
  const received: unknown[] = []
  await consumeAssistantStream(stream, event => received.push(event))
  expect(received).toEqual(events)
})

test('无附件保留 JSON 请求与 Cookie、同源鉴权头', async () => {
  let options: RequestInit | undefined
  globalThis.fetch = (async (_url, init) => { options = init; return new Response('data: {"type":"done"}\n\n') }) as typeof fetch
  await chatAssistant('看看用量', '私有会话', new AbortController().signal, () => {}, '/overview')
  expect(options?.headers).toEqual({ 'X-Portal-Request': '1', 'Content-Type': 'application/json' })
  expect(options?.credentials).toBe('same-origin')
  expect(JSON.parse(options?.body as string)).toEqual({ prompt: '看看用量', session_id: '私有会话', page: '/overview' })
})

test('立即引导绑定原运行并沿用 Cookie 与同源鉴权；拒绝时保留服务端原因', async () => {
  let path = '', options: RequestInit | undefined
  const signal = new AbortController().signal
  globalThis.fetch = (async (url, init) => { path = String(url); options = init; return Response.json({ ok: true }) }) as typeof fetch
  await steerAssistant('先看上个月', '私有会话', '当前运行', signal)
  expect(path).toContain('/api/v1/assistant/steer')
  expect(options?.credentials).toBe('same-origin')
  expect(options?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Portal-Request': '1' })
  expect(options?.signal).toBe(signal)
  expect(JSON.parse(options?.body as string)).toEqual({ session_id: '私有会话', run_id: '当前运行', prompt: '先看上个月' })
  globalThis.fetch = (async () => Response.json({ reason: '本轮已结束，请排队发送' }, { status: 409 })) as typeof fetch
  await expect(steerAssistant('继续', '私有会话', '旧运行', signal)).rejects.toThrow('本轮已结束')
})

test('多附件 multipart 保留内容与中文文件名，浏览器负责 boundary；支持仅附件', async () => {
  let options: RequestInit | undefined
  const events: unknown[] = []
  const attachment = { attachment_id: '附件甲', file_name: '说明.md', media_type: 'text/markdown', size_bytes: 6, kind: 'text', extracted_chars: 2 }
  globalThis.fetch = (async (_url, init) => { options = init; return new Response(`data: ${JSON.stringify({ type: 'attachments', attachments: [attachment] })}\n\ndata: {"type":"done"}\n\n`) }) as typeof fetch
  await chatAssistant('', undefined, new AbortController().signal, event => events.push(event), '/analysis', [new File(['正文'], '说明.md', { type: 'text/markdown' }), new File(['x'], '数据.csv', { type: 'text/csv' })])
  expect(options?.headers).toEqual({ 'X-Portal-Request': '1' })
  expect(options?.credentials).toBe('same-origin')
  const form = options?.body as FormData
  expect(form).toBeInstanceOf(FormData)
  expect(form.get('prompt')).toBe('')
  expect(form.has('session_id')).toBe(false)
  expect(form.get('page')).toBe('/analysis')
  expect(form.getAll('files').map(item => (item as File).name)).toEqual(['说明.md', '数据.csv'])
  expect(await (form.getAll('files')[0] as File).text()).toBe('正文')
  expect(events).toEqual([{ type: 'attachments', attachments: [attachment] }, { type: 'done' }])
})

test('解析错误传回原服务端理由，附件下载拒绝发生在浏览器建立对象之前', async () => {
  let path = '', options: RequestInit | undefined
  globalThis.fetch = (async (url, init) => { path = String(url); options = init; return new Response(JSON.stringify({ reason: '附件解析失败：文档已加密' }), { status: 400 }) }) as typeof fetch
  await expect(chatAssistant('', 's', new AbortController().signal, () => {}, undefined, [new File(['正文'], '说明.docx')])).rejects.toThrow('文档已加密')
  await expect(downloadAssistantAttachment('会话/甲', { attachment_id: '附件/乙', file_name: '说明.txt', media_type: 'text/plain', size_bytes: 2, kind: 'text' })).rejects.toThrow('文档已加密')
  expect(path).toContain('/sessions/' + encodeURIComponent('会话/甲') + '/attachments/' + encodeURIComponent('附件/乙') + '/download')
  expect(options?.credentials).toBe('same-origin')
  expect(options?.headers).toEqual({ 'X-Portal-Request': '1' })
  expect(options?.cache).toBe('no-store')
})
