/** 当前表单身份只帮助定位；JSON、附件与 DSH 入口都不能把它变成写入授权或秘密通道。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { AssistantFormContext } from '@ai-token-report/shared'
import { createHandlerFor } from '../src/index.js'
import type { AssistantRun } from '../src/assistant/runtime.js'
import { validateAssistantFormContext } from '../src/assistant/form-context.js'
import { seedDatabaseIdentity } from './database-fixture.js'
import { cleanChildEnv } from '../../core/verify/lib/runtime.js'

const root = await mkdtemp(join(tmpdir(), 'atr-form-context-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'form-context-admin', name: '表单上下文管理员', role: 'admin' },
  { token: 'form-context-member', name: '普通成员', role: 'member' },
])
const principal = (await identity.resolveBearer('form-context-admin'))!
const captured: AssistantRun[] = []
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, requestLog: false, assistantEngine: { async run(input) {
  captured.push(input)
  input.emit({ type: 'text', text: '表单身份仅供参考' })
} } })
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-form-context-'))) throw new Error('测试目录越界')
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function call(body: unknown, token = 'form-context-admin') {
  return bundle.handler(new Request('http://localhost/api/v1/assistant/chat', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : JSON.stringify(body),
  }))
}
async function read(response: Response) {
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"type":"done"')
}
const context: AssistantFormContext = { resource: 'groups', operation: 'create' }

test('JSON 与 multipart 只传本轮表单身份，未传时不继承旧引用', async () => {
  await read(await call({ prompt: '帮我填写当前弹框', page: '/groups', form_context: context }))
  expect(captured.at(-1)?.formContext).toEqual(context)
  const multipart = new FormData()
  const update: AssistantFormContext = { resource: 'pricing', operation: 'update', target_id: randomUUID() }
  multipart.set('prompt', '分析这个附件')
  multipart.set('page', '/pricing')
  multipart.set('form_context', JSON.stringify(update))
  multipart.append('files', new File(['资料内容'], '参考.txt', { type: 'text/plain' }))
  await read(await call(multipart))
  expect(captured.at(-1)?.formContext).toEqual(update)
  expect(captured.at(-1)?.attachments?.[0]?.text).toBe('资料内容')
  await read(await call({ prompt: '普通查询', page: '/groups' }))
  expect(captured.at(-1)?.formContext).toBeUndefined()
})

test('不支持的资源、秘密字段、伪造目标、页面不匹配均在创建会话和调用模型前拒绝', async () => {
  const before = captured.length
  const sessionsBefore = await bundle.handler(new Request('http://localhost/api/v1/assistant/sessions', { headers: { Authorization: 'Bearer form-context-admin' } })).then(response => response.json())
  for (const value of [
    null, 'groups', [], {},
    { resource: 'roles', operation: 'create' },
    { ...context, values: { name: '不应收集的输入', password: 'secret' } },
    { ...context, token: 'secret' },
    { ...context, member_id: principal.memberId },
    { ...context, operation: 'delete' },
    { ...context, target_id: randomUUID() },
    { resource: 'groups', operation: 'update' },
    { resource: 'groups', operation: 'update', target_id: '../escape' },
    { resource: 'pricing', operation: 'create' },
  ]) expect((await call({ prompt: '普通查询', page: '/groups', form_context: value })).status).toBe(400)
  expect((await call({ prompt: '普通查询', form_context: context })).status).toBe(400)
  expect((await call({ prompt: '普通查询', page: '/groups', form_context: context }, 'form-context-member')).status).toBe(403)
  expect(captured.length).toBe(before)
  expect(await bundle.handler(new Request('http://localhost/api/v1/assistant/sessions', { headers: { Authorization: 'Bearer form-context-admin' } })).then(response => response.json())).toEqual(sessionsBefore)
})

test('multipart 拒绝无效 JSON、重复上下文和文件冒充上下文', async () => {
  const before = captured.length
  for (const value of ['{', 'null', '"groups"', JSON.stringify({ ...context, values: { api_key: 'secret' } })]) {
    const body = new FormData()
    body.set('prompt', '普通查询'); body.set('page', '/groups'); body.set('form_context', value)
    expect((await call(body)).status).toBe(400)
  }
  const duplicate = new FormData()
  duplicate.set('prompt', '普通查询'); duplicate.set('page', '/groups')
  duplicate.append('form_context', JSON.stringify(context)); duplicate.append('form_context', JSON.stringify(context))
  expect((await call(duplicate)).status).toBe(400)
  duplicate.delete('form_context'); duplicate.append('form_context', new File([JSON.stringify(context)], 'context.json'))
  expect((await call(duplicate)).status).toBe(400)
  expect(captured.length).toBe(before)
})

test('上下文归一化不转发额外身份，撤去管理权限后同一引用失效', () => {
  const normalized = validateAssistantFormContext(context, '/groups', principal)
  expect(normalized).toEqual(context)
  expect(normalized).not.toBe(context)
  expect(() => validateAssistantFormContext(context, '/groups', { ...principal, permissions: ['stats:read'] })).toThrow('权限')
})

test('真实 DSH 三协议收到当前表单引用，但只读提问仍不挂载保存或删除工具', () => {
  const entry = resolve(import.meta.dir, '../verify/verify-assistant-runtime.ts')
  for (const protocol of ['deepseek-messages', 'openai-completions', 'openai-responses']) {
    const child = spawnSync(process.execPath, [entry, protocol, '--form-context'], { env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
    expect(child.stdout).toContain('DSH_FORM_CONTEXT_OK')
  }
}, 120_000)
