/** 模型终止原因的 HTTP 边界：保留已接受消息、释放会话锁，且不暴露原始思考或凭证。 */
import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AssistantEvent } from '@ai-token-report/shared'
import { AssistantRoute } from '../src/assistant-route.js'
import { AssistantStore } from '../src/assistant/store.js'
import { AssistantRuntimeError } from '../src/assistant/runtime-error.js'
import type { AssistantEngine } from '../src/assistant/runtime.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const root = await mkdtemp(join(tmpdir(), 'atr-assistant-runtime-errors-'))
const token = 'runtime-error-owner'
const identity = await seedDatabaseIdentity({ sqlitePath: join(root, 'portal.sqlite') }, [{ token, name: '运行错误夹具', role: 'admin' }])
const owner = (await identity.resolveBearer(token))!
const routes: AssistantRoute[] = []
const budgetMessage = '模型达到本轮输出预算，回答可能未完整。本轮消息已保留，请缩小范围后继续。'
const genericMessage = 'DSH 助手运行失败，请管理员检查模型配置与服务日志'
const secret = 'sk-fixture-credential-DO-NOT-EXPOSE'
const privateReasoning = '私密思考正文_DO_NOT_EXPOSE'
const unsafeMessage = `${secret}: ${privateReasoning}`

afterAll(async () => {
  await Promise.all(routes.map(route => route.close()))
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-assistant-runtime-errors-'))) throw new Error('临时目录超出测试边界')
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
function fixture(engine: AssistantEngine) {
  // Windows 还需容纳 64 位成员目录、会话 UUID 与原子落盘临时文件，夹具目录保持短名。
  const store = new AssistantStore(join(root, randomUUID().slice(0, 8)))
  const route = new AssistantRoute(identity, store, engine)
  routes.push(route)
  const chat = (prompt: string, sessionId?: string) => route.handle('POST', 'chat', `Bearer ${token}`, { prompt, ...(sessionId ? { session_id: sessionId } : {}) })
  return { route, store, chat }
}
async function consume(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  // ★ 读到 HTTP 流关闭后，服务端 finally 的保存与解锁也必须已经完成。
  const text = await response.text()
  const events = text.split('\n\n').flatMap(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '))
    return data ? [JSON.parse(data.slice(6)) as AssistantEvent] : []
  })
  const accepted = events.find(event => event.type === 'session') as Extract<AssistantEvent, { type: 'session' }> | undefined
  expect(accepted).toBeDefined()
  return { text, events, id: accepted!.session.session_id, runId: accepted!.run_id! }
}
async function captureWarnings<T>(work: () => Promise<T>) {
  const warnings: unknown[][] = [], original = console.warn
  console.warn = (...values: unknown[]) => { warnings.push(values) }
  try { return { value: await work(), warnings } }
  finally { console.warn = original }
}
function assertNoSensitiveContent(...values: unknown[]) {
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    expect(text).not.toContain(secret)
    expect(text).not.toContain(privateReasoning)
  }
}

test('只有思考耗尽预算时 SSE 明确说明输出预算，保留已接受附件且同会话可继续，不重复原轮', async () => {
  let calls = 0
  const f = fixture({ async run(input) {
    calls++
    if (calls === 1) {
      // 模拟底层异常附带原始响应；HTTP 只能使用类型化错误的固定 publicMessage。
      const error = new AssistantRuntimeError('max-tokens')
      error.message = unsafeMessage
      error.stack = `Error: ${unsafeMessage}`
      throw error
    }
    input.emit({ type: 'text', text: '缩小范围后的完整回答' })
  } })
  const form = new FormData()
  form.set('prompt', '先处理前两个问题')
  form.append('files', new File(['附件中的需求说明'], '需求.md', { type: 'text/markdown' }))
  const captured = await captureWarnings(() => f.route.handle('POST', 'chat', `Bearer ${token}`, new Request('http://localhost/api/v1/assistant/chat', { method: 'POST', body: form })).then(consume))
  const first = captured.value
  expect(first.events.filter(event => event.type === 'error')).toEqual([{ type: 'error', reason: budgetMessage }])
  expect(first.events.some(event => event.type === 'done' || event.type === 'text')).toBe(false)
  expect(first.text).not.toContain(genericMessage)
  expect(first.runId).toBeString()
  expect(calls).toBe(1)
  const before = await f.store.get(owner.memberId, first.id)
  expect(before.session.turn_count).toBe(1)
  expect(before.messages.map(message => message.text)).toEqual(['先处理前两个问题'])
  expect(before.messages[0]!.attachments).toHaveLength(1)
  expect(before.messages[0]!.attachments![0]!.file_name).toBe('需求.md')
  const attachment = before.messages[0]!.attachments![0]!
  const download = await f.route.handle('GET', `sessions/${first.id}/attachments/${attachment.attachment_id}/download`, `Bearer ${token}`)
  expect(download.status).toBe(200)
  expect(await download.text()).toBe('附件中的需求说明')
  expect(captured.warnings).toEqual([[expect.stringContaining('对话未完成'), expect.objectContaining({ code: 'MODEL_OUTPUT_LIMIT', reason_kind: 'max-tokens', session_id: first.id, aborted: false })]])
  assertNoSensitiveContent(first.text, captured.warnings, before)

  // 失败流已关闭，下一请求必须成功；409 会暴露未释放的会话锁。
  const second = await consume(await f.chat('先继续第一个问题', first.id))
  expect(second.id).toBe(first.id)
  expect(second.runId).not.toBe(first.runId)
  expect(second.events.at(-1)).toEqual({ type: 'done' })
  expect(calls).toBe(2)
  const restored = await new AssistantStore(f.store.root).get(owner.memberId, first.id)
  expect(restored.session.turn_count).toBe(2)
  expect(restored.messages.map(message => message.text)).toEqual(['先处理前两个问题', '先继续第一个问题', '缩小范围后的完整回答'])
  expect(restored.messages.filter(message => message.attachments?.length)).toHaveLength(1)
})

test('部分文字后达到预算仍保留回答并明确截断，同会话续聊不覆盖旧历史', async () => {
  let calls = 0
  const f = fixture({ async run(input) {
    calls++
    if (calls === 1) {
      input.emit({ type: 'text', text: '已完成第一个问题；第二个问题' })
      throw new AssistantRuntimeError('max-tokens')
    }
    input.emit({ type: 'text', text: '继续完成第二个问题。' })
  } })
  const first = (await captureWarnings(() => f.chat('分析两个问题').then(consume))).value
  expect(first.events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: '已完成第一个问题；第二个问题' }])
  expect(first.events.at(-1)).toEqual({ type: 'error', reason: budgetMessage })
  expect(first.events.some(event => event.type === 'done')).toBe(false)
  const before = await f.store.get(owner.memberId, first.id)
  expect(before.messages).toEqual([{ role: 'user', text: '分析两个问题' }, { role: 'assistant', text: '已完成第一个问题；第二个问题' }])
  await consume(await f.chat('继续第二个问题', first.id))
  const after = await f.store.get(owner.memberId, first.id)
  expect(after.messages.map(message => message.text)).toEqual(['分析两个问题', '已完成第一个问题；第二个问题', '继续第二个问题', '继续完成第二个问题。'])
  expect(calls).toBe(2)
})

test('未知底层异常的 message 和 stack 含凭证或思考时，SSE 与服务日志都不泄漏', async () => {
  let calls = 0
  const f = fixture({ async run() { calls++; throw new Error(unsafeMessage) } })
  const captured = await captureWarnings(() => f.chat('处理失败的请求').then(consume))
  expect(captured.value.events.filter(event => event.type === 'error')).toEqual([{ type: 'error', reason: genericMessage }])
  expect(calls).toBe(1)
  expect(captured.warnings).toEqual([[expect.stringContaining('对话未完成'), expect.objectContaining({ error: 'Error', session_id: captured.value.id, aborted: false })]])
  const saved = await f.store.get(owner.memberId, captured.value.id)
  expect(saved.messages).toEqual([{ role: 'user', text: '处理失败的请求' }])
  assertNoSensitiveContent(captured.value.text, captured.warnings, saved)
  expect((await f.route.handle('DELETE', `sessions/${captured.value.id}`, `Bearer ${token}`)).status).toBe(200)
})

test('未经许可的终止原因和错误码不能成为 SSE 文案或日志字段', async () => {
  const error = new AssistantRuntimeError(unsafeMessage, unsafeMessage)
  error.message = unsafeMessage
  const f = fixture({ async run() { throw error } })
  const captured = await captureWarnings(() => f.chat('检查错误分类').then(consume))
  expect(captured.value.events.filter(event => event.type === 'error')).toEqual([{ type: 'error', reason: error.publicMessage }])
  expect(captured.warnings).toEqual([[expect.stringContaining('对话未完成'), expect.objectContaining({ code: 'MODEL_RUNTIME_FAILURE', reason_kind: 'unknown', aborted: false })]])
  assertNoSensitiveContent(captured.value.text, captured.warnings)
})
