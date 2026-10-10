/** 会话锁、初始化期引导与最终落盘使用真实身份和文件存储，模型等待由可控夹具替代。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cleanChildEnv } from '../../core/verify/lib/runtime.js'
import type { AssistantEvent } from '@ai-token-report/shared'
import { AssistantRoute } from '../src/assistant-route.js'
import { AssistantStore } from '../src/assistant/store.js'
import type { AssistantEngine, AssistantRun } from '../src/assistant/runtime.js'
import type { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const root = await mkdtemp(join(tmpdir(), 'atr-assistant-concurrency-'))
const identity = await seedDatabaseIdentity({ sqlitePath: join(root, 'portal.sqlite') }, [
  { token: 'concurrent-owner', name: '并行用户', role: 'admin' },
  { token: 'concurrent-other', name: '另一用户', role: 'member' },
])
const owner = (await identity.resolveBearer('concurrent-owner'))!
const store = new AssistantStore(join(root, 'assistant'), 1)
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}
interface ControlledRun { input: AssistantRun; initialized: ReturnType<typeof gate>; finish: ReturnType<typeof gate>; accepted: string[] }
const running = new Map<string, ControlledRun>()
const wait = async (promise: Promise<void>, signal: AbortSignal) => {
  if (signal.aborted) return
  const aborted = gate()
  signal.addEventListener('abort', aborted.open, { once: true })
  try { await Promise.race([promise, aborted.promise]) }
  finally { signal.removeEventListener('abort', aborted.open) }
}
const engine: AssistantEngine = { supportsSteering: true, async run(input) {
  const current: ControlledRun = { input, initialized: gate(), finish: gate(), accepted: [] }
  running.set(input.sessionId, current)
  input.emit({ type: 'text', text: '引导前的回答。' })
  let unsubscribe: (() => void) | undefined
  try {
    await wait(current.initialized.promise, input.signal)
    input.signal.throwIfAborted()
    unsubscribe = input.subscribeSteering?.(prompt => current.accepted.push(prompt))
    await wait(current.finish.promise, input.signal)
    input.signal.throwIfAborted()
    input.emit({ type: 'text', text: current.accepted.length ? `引导后的回答：${current.accepted.join('；')}` : '完整回答。' })
  } finally { unsubscribe?.(); running.delete(input.sessionId) }
} }
// ★ 文件操作仍保留成员写锁，防止并行轮次与确认/分享互相覆盖元数据。
const artifacts = { async list() { return [] }, share() { throw new Error('运行中不应执行分享') } } as unknown as AssistantArtifacts
const route = new AssistantRoute(identity, store, engine, { artifacts })
afterAll(async () => {
  await route.close()
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
const call = (method: string, action: string, body?: unknown, token = 'concurrent-owner') => route.handle(method, action, `Bearer ${token}`, body)
async function begin(prompt: string, sessionId?: string) {
  const response = await call('POST', 'chat', { prompt, ...(sessionId ? { session_id: sessionId } : {}) })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: AssistantEvent[] = []
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
  while (!events.some(event => event.type === 'session')) if (!await read()) throw new Error('会话流没有 session 事件')
  const session = events.find(event => event.type === 'session') as Extract<AssistantEvent, { type: 'session' }>
  expect(session.run_id).toBeString()
  const id = session.session.session_id
  const control = running.get(id)!
  expect(control).toBeDefined()
  return { id, runId: session.run_id!, control, events, reader, async complete() {
    control.initialized.open(); control.finish.open()
    while (await read()) { /* 读到关闭边界才能断言最后一次落盘完成。 */ }
    expect(events.at(-1)?.type).toBe('done')
    return await store.get(owner.memberId, id)
  } }
}
const steer = (run: { id: string; runId: string }, prompt: string, token?: string) => call('POST', 'steer', { session_id: run.id, run_id: run.runId, prompt }, token)

test('同用户可同时运行不同会话；取消一条后另一条仍保持运行和成员清理保护', async () => {
  const first = await begin('第一个并行对话')
  const second = await begin('第二个并行对话')
  expect((await call('POST', 'chat', { prompt: '同会话重复提交', session_id: first.id })).status).toBe(409)
  expect((await call('DELETE', `sessions/${first.id}`)).status).toBe(409)
  expect((await call('GET', `sessions/${first.id}`, undefined, 'concurrent-other')).status).toBe(404)
  expect((await call('GET', 'sessions').then(response => response.json())).sessions.map((session: { session_id: string }) => session.session_id)).toEqual(expect.arrayContaining([first.id, second.id]))
  await first.reader.cancel()
  for (let attempt = 0; attempt < 50 && running.has(first.id); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  expect((await steer(second, '只看本月的数据')).status).toBe(200)
  expect((await call('POST', `artifacts/${randomUUID()}/share`, {})).status).toBe(409)
  await store.prune(new Set([owner.memberId]))
  expect((await call('GET', `sessions/${second.id}`)).status).toBe(200)
  await second.complete()
})

test('DSH 初始化期间的即时引导按顺序交付，SSE 与最终历史保留相同消息边界', async () => {
  const run = await begin('查询今天用量')
  expect((await call('GET', 'status').then(response => response.json())).supports_steering).toBe(true)
  expect((await steer(run, '改看本月')).status).toBe(200)
  expect((await steer(run, '用表格展示')).status).toBe(200)
  expect(run.control.accepted).toEqual([])
  const detail = await run.complete()
  expect(run.control.accepted).toEqual(['改看本月', '用表格展示'])
  expect(run.events.filter(event => event.type === 'steering')).toEqual([{ type: 'steering', text: '改看本月' }, { type: 'steering', text: '用表格展示' }])
  expect(detail.messages).toEqual([
    { role: 'user', text: '查询今天用量' },
    { role: 'assistant', text: '引导前的回答。' },
    { role: 'user', text: '改看本月', delivery: 'steer' },
    { role: 'user', text: '用表格展示', delivery: 'steer' },
    { role: 'assistant', text: '引导后的回答：改看本月；用表格展示' },
  ])
  expect(detail.session.turn_count).toBe(1)
  expect((await steer(run, '结束后到达的消息')).status).toBe(409)
})

test('引导复验会话归属和本轮ID，不接受额外字段、不扩大首问写入或分享授权', async () => {
  const run = await begin('查询今天用量')
  expect((await steer(run, '另一人的引导', 'concurrent-other')).status).toBe(404)
  expect((await call('POST', 'steer', { session_id: '../escape', run_id: run.runId, prompt: '越界' })).status).toBe(400)
  expect((await call('POST', 'steer', { session_id: run.id, prompt: '缺少本轮ID' })).status).toBe(400)
  expect((await call('POST', 'steer', { session_id: run.id, run_id: run.runId, prompt: '非法参数', directory: root })).status).toBe(400)
  expect((await steer({ ...run, runId: randomUUID() }, '过期轮次')).status).toBe(409)
  expect((await steer(run, '删除所有成员')).status).toBe(409)
  expect((await steer(run, '是的直接帮我新建两条')).status).toBe(409)
  expect((await steer(run, '好的请帮我新增规则')).status).toBe(409)
  expect((await steer(run, '嗯那就直接保存')).status).toBe(409)
  expect((await steer(run, '分享刚才的文件')).status).toBe(409)
  expect((await steer(run, '帮我把这些预填到新建弹框，等我点击保存')).status).toBe(200)
  expect((await steer(run, '先打开表单，然后直接帮我保存这条规则')).status).toBe(409)
  expect((await steer(run, '是的')).status).toBe(200)
  expect((await steer(run, '只解释删除流程，不需要修改')).status).toBe(200)
  await run.complete()
  const next = await begin('同会话下一轮', run.id)
  expect(next.runId).not.toBe(run.runId)
  expect((await steer(run, '上一轮延迟到达')).status).toBe(409)
  await next.complete()
})

test('服务端四会话容量按运行数限制；结束后容量释放', async () => {
  const runs = []
  for (let index = 0; index < 4; index++) runs.push(await begin(`容量测试 ${index}`))
  expect((await call('POST', 'chat', { prompt: '第五个会话' })).status).toBe(429)
  await runs[0]!.complete()
  const replacement = await begin('容量释放后的会话')
  for (const run of [...runs.slice(1), replacement]) await run.complete()
})

test('会话创建的100个配额在并发检查时仍然成立，活动历史列表不触发过期删除', async () => {
  const capped = new AssistantStore(join(root, 'cap'))
  for (let index = 0; index < 99; index++) await capped.create(owner.memberId)
  const result = await Promise.allSettled([capped.create(owner.memberId), capped.create(owner.memberId)])
  expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
  expect(await capped.list(owner.memberId)).toHaveLength(100)
  const retained = new AssistantStore(join(root, 'active-list'), 1)
  const old = await retained.create(owner.memberId)
  old.session.updated_at_ms -= 2 * 86_400_000
  await retained.save(owner.memberId, old)
  expect(await retained.list(owner.memberId, new Set([old.session.session_id]))).toHaveLength(1)
  expect(await retained.list(owner.memberId)).toHaveLength(0)
})

test('真实 DSH steer 在下一步生效，保留原轮请求且持久化引导事件', () => {
  const child = spawnSync(process.execPath, [resolve(import.meta.dir, '../verify/verify-assistant-runtime.ts'), 'openai-completions', '--steering'], { env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
  expect(child.stdout).toContain('DSH_STEERING_OK')
}, 35_000)
