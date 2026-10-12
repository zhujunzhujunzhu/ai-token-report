/** 浏览器控件往返的真实 HTTP 边界：身份、轮次、最新控件、写入授权与取消必须同时成立。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AssistantEvent, AssistantPageContext, AssistantPageOperation, AssistantPageActionResult } from '@ai-token-report/shared'
import { createHandlerFor } from '../src/index.js'
import type { AssistantRun } from '../src/assistant/runtime.js'
import { AssistantPageBridge } from '../src/assistant/page-bridge.js'
import { validateAssistantPageContext, validateAssistantPageOperation } from '../src/assistant/page-context.js'
import { seedDatabaseIdentity } from './database-fixture.js'
import { cleanChildEnv } from '../../core/verify/lib/runtime.js'

const root = await mkdtemp(join(tmpdir(), 'atr-page-actions-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'page-owner', name: '页面管理员', role: 'admin' },
  { token: 'page-other', name: '另一成员', role: 'member' },
])
const principal = (await identity.resolveBearer('page-owner'))!
const alternate = await identity.issueToken(principal, { member_id: principal.memberId, label: '同人另一个身份', scopes: principal.permissions })
const captured: AssistantRun[] = []
const plans = new Map<string, AssistantPageOperation[]>()
const replies = new Map<string, AssistantPageActionResult[]>()
const failures = new Map<string, unknown>()
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, requestLog: false, assistantEngine: { async run(input) {
  captured.push(input)
  try {
    const results: AssistantPageActionResult[] = []
    replies.set(input.prompt, results)
    for (const operation of plans.get(input.prompt) ?? []) results.push(await input.operatePage!(operation))
    input.signal.throwIfAborted()
    input.emit({ type: 'text', text: JSON.stringify(results) })
  } catch (error) { failures.set(input.prompt, error); input.signal.throwIfAborted(); input.emit({ type: 'text', text: '已拒绝不允许的页面操作' }) }
} } })
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-page-actions-'))) throw new Error('测试目录越界')
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const context: AssistantPageContext = { path: '/groups', controls: [
  { id: 'filter', kind: 'fill', label: '分组筛选', effect: 'read', value: '' },
  { id: 'next', kind: 'click', label: '下一页', effect: 'read' },
  { id: 'save', kind: 'click', label: '保存', effect: 'write' },
] }
const fresh: AssistantPageContext = { path: '/groups', controls: [
  { id: 'fresh-filter', kind: 'fill', label: '新筛选框', effect: 'read', value: '' },
  { id: 'save', kind: 'click', label: '保存', effect: 'write' },
] }
function call(path: string, body?: unknown, token = 'page-owner', method = 'POST') {
  return bundle.handler(new Request(`http://localhost/api/v1/assistant/${path}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  }))
}
async function begin(prompt: string) {
  const response = await call('chat', { prompt, page: context.path, page_context: context })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), decoder = new TextDecoder(), events: AssistantEvent[] = []
  let buffer = ''
  const read = async () => {
    const chunk = await reader.read()
    if (chunk.done) return false
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n').find(line => line.startsWith('data: '))
      if (data) events.push(JSON.parse(data.slice(6)))
    }
    return true
  }
  while (!events.some(event => event.type === 'session')) if (!await read()) throw new Error('缺少会话事件')
  const session = events.find(event => event.type === 'session') as Extract<AssistantEvent, { type: 'session' }>
  let delivered = 0
  return { events, reader, sessionId: session.session.session_id, runId: session.run_id!, async next() {
    while (!events.filter(event => event.type === 'page_action')[delivered]) if (!await read()) throw new Error('缺少页面动作')
    return events.filter(event => event.type === 'page_action')[delivered++] as Extract<AssistantEvent, { type: 'page_action' }>
  }, async complete() { while (await read()) { /* 必须消费关闭边界后再断言运行表已释放。 */ } } }
}
function reply(run: Awaited<ReturnType<typeof begin>>, requestId: string, result: unknown, token = 'page-owner', overrides: Record<string, unknown> = {}) {
  return call('page-action-result', { session_id: run.sessionId, run_id: run.runId, request_id: requestId, result, ...overrides }, token)
}

test('控件快照验证白名单、页面权限、唯一身份和长度，JSON 与 multipart 均支持', async () => {
  for (const value of [
    null, [], { ...context, selector: 'body' }, { ...context, path: '/roles' },
    { ...context, controls: [...context.controls, context.controls[0]] },
    { ...context, controls: [{ ...context.controls[0], password: 'secret' }] },
    { ...context, controls: [{ ...context.controls[0], id: 'a'.repeat(101) }] },
    { ...context, controls: [{ ...context.controls[0], label: 'a'.repeat(201) }] },
    { ...context, controls: [{ ...context.controls[0], value: 'a'.repeat(2001) }] },
    { ...context, controls: Array.from({ length: 81 }, (_, id) => ({ id: String(id), kind: 'click', label: '按钮', effect: 'read' })) },
  ]) expect((await call('chat', { prompt: '快照验证', page: '/groups', page_context: value })).status).toBe(400)
  expect((await call('chat', { prompt: '快照验证', page: '/groups', page_context: context }, 'page-other')).status).toBe(403)
  const body = new FormData()
  body.set('prompt', 'multipart快照'); body.set('page', '/groups'); body.set('page_context', JSON.stringify(context))
  const accepted = await call('chat', body)
  expect(accepted.status).toBe(200)
  await accepted.text()
  expect(captured.at(-1)?.pageContext).toEqual(context)
  body.append('page_context', JSON.stringify(context))
  expect((await call('chat', body)).status).toBe(400)
  expect((await call('page-action-result', {}, '')).status).toBe(401)
  const wrongMethod = await call('page-action-result', undefined, 'page-owner', 'GET')
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('Allow')).toBe('POST')
})

test('页面动作等浏览器确认后才继续，下一操作只接受返回的最新控件', async () => {
  const prompt = '查看页面并填写筛选'
  plans.set(prompt, [{ operation: 'inspect' }, { operation: 'fill', control_id: 'fresh-filter', value: '研发' }])
  const run = await begin(prompt)
  const inspect = await run.next()
  expect(inspect.action).toEqual({ operation: 'inspect' })
  expect(replies.get(prompt)).toEqual([])
  expect((await reply(run, inspect.request_id, { ok: true, page_context: fresh, form_context: null })).status).toBe(200)
  const fill = await run.next()
  expect(fill.action).toEqual({ operation: 'fill', control_id: 'fresh-filter', value: '研发' })
  expect((await reply(run, fill.request_id, { ok: true, page_context: { ...fresh, controls: [{ ...fresh.controls[0]!, value: '研发' }] } })).status).toBe(200)
  await run.complete()
  expect(replies.get(prompt)).toHaveLength(2)
  expect(failures.has(prompt)).toBe(false)
  expect((await reply(run, fill.request_id, { ok: true })).status).toBe(409)
})
test('导航后查看允许的新页面可继续操作，新页面快照废弃旧控件身份', async () => {
  const prompt = '查看导航后的分析页面'
  plans.set(prompt, [{ operation: 'inspect' }, { operation: 'click', control_id: 'analysis-sort' }, { operation: 'click', control_id: 'next' }])
  const run = await begin(prompt), inspect = await run.next()
  const nextPage: AssistantPageContext = { path: '/analysis', controls: [{ id: 'analysis-sort', kind: 'click', label: '按用量排序', effect: 'read' }] }
  expect((await reply(run, inspect.request_id, { ok: true, page_context: nextPage, form_context: null })).status).toBe(200)
  const sort = await run.next()
  expect(sort.action).toEqual({ operation: 'click', control_id: 'analysis-sort' })
  expect((await reply(run, sort.request_id, { ok: true, page_context: nextPage })).status).toBe(200)
  await run.complete()
  expect(failures.get(prompt)).toMatchObject({ status: 409 })
  expect(run.events.filter(event => event.type === 'page_action')).toHaveLength(2)
})

test('跨人、同人另一凭证、旧轮次、错误请求与伪造返回均不能接管当前浏览器动作', async () => {
  const prompt = '查看页面身份边界'
  plans.set(prompt, [{ operation: 'inspect' }])
  const run = await begin(prompt), action = await run.next()
  expect((await reply(run, action.request_id, { ok: true }, 'page-other')).status).toBe(404)
  expect((await reply(run, action.request_id, { ok: true }, alternate.token_secret)).status).toBe(409)
  expect((await reply(run, action.request_id, { ok: true }, 'page-owner', { run_id: randomUUID() })).status).toBe(409)
  expect((await reply(run, randomUUID(), { ok: true })).status).toBe(409)
  for (const result of [{ ok: 'yes' }, { ok: true, script: 'save()' }, { ok: true, page_context: { ...fresh, path: '/secret' } }, { ok: true, form_context: { resource: 'pricing', operation: 'create', values: { api_key: 'secret' } } }]) expect((await reply(run, action.request_id, result)).status).toBe(400)
  expect(replies.get(prompt)).toEqual([])
  expect((await reply(run, action.request_id, { ok: false, reason: '控件已关闭', page_context: fresh, form_context: null })).status).toBe(200)
  await run.complete()
  expect(replies.get(prompt)?.[0]?.ok).toBe(false)
})

test('只读或仅预填问题拒绝保存控件，明确填写并保存的原指令才发出保存动作', async () => {
  for (const prompt of ['查询分组', '帮我预填，等我核对并保存']) {
    plans.set(prompt, [{ operation: 'click', control_id: 'save' }])
    const response = await call('chat', { prompt, page: '/groups', page_context: context })
    const text = await response.text()
    expect(text).not.toContain('"type":"page_action"')
    expect(failures.get(prompt)).toMatchObject({ status: 403 })
  }
  const prompt = '帮我填写当前表单并保存'
  plans.set(prompt, [{ operation: 'click', control_id: 'save' }])
  const run = await begin(prompt), action = await run.next()
  expect(action.action).toEqual({ operation: 'click', control_id: 'save' })
  expect((await reply(run, action.request_id, { ok: false, reason: '表单校验未通过', page_context: context })).status).toBe(200)
  await run.complete()
  expect(replies.get(prompt)?.[0]?.ok).toBe(false)
})

test('未知或操作类型不符的控件拒绝；取消 SSE 立即结束待确认页面请求', async () => {
  expect(() => validateAssistantPageOperation({ operation: 'click', control_id: 'filter' }, context, true)).toThrow('控件')
  expect(() => validateAssistantPageOperation({ operation: 'fill', control_id: 'filter', value: true }, context, true)).toThrow('类型')
  expect(() => validateAssistantPageOperation({ operation: 'inspect', control_id: 'save' }, context, true)).toThrow('目标')
  const prompt = '等待页面取消'
  plans.set(prompt, [{ operation: 'inspect' }])
  const run = await begin(prompt), action = await run.next()
  await run.reader.cancel()
  for (let attempt = 0; attempt < 50 && !failures.has(prompt); attempt++) await new Promise(done => setTimeout(done, 10))
  expect((await reply(run, action.request_id, { ok: true })).status).toBe(409)
  expect(failures.has(prompt)).toBe(true)
})

test('浏览器无回复最多等待 15 秒，超时和重复回复不能重放请求', async () => {
  let action: Extract<AssistantEvent, { type: 'page_action' }> | undefined
  const bridge = new AssistantPageBridge(validateAssistantPageContext(context, '/groups', principal), '/groups', new AbortController().signal, event => { if (event.type === 'page_action') action = event }, async () => principal, false, 10)
  const result = await bridge.operate({ operation: 'inspect' })
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('未及时确认') })
  expect(() => bridge.respond(action!.request_id, { ok: true }, principal)).toThrow('过期')
})
test('真实 DSH 三协议执行页面工具，并保留过期目标、写入门禁与浏览器失败', () => {
  const entry = resolve(import.meta.dir, '../verify/verify-assistant-runtime.ts')
  for (const protocol of ['deepseek-messages', 'openai-completions', 'openai-responses']) {
    const child = spawnSync(process.execPath, [entry, protocol, '--page-actions'], { env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
    expect(child.stdout).toContain('DSH_PAGE_ACTIONS_OK')
  }
}, 120_000)
