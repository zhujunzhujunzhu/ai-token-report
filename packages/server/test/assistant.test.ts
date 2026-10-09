/** 助手隔离与 DSH 实际装载验证；模型服务只用回环夹具，不消耗线上额度。 */
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'
import { dshBundlePlugin } from '../scripts/dsh-bundle.js'
import { createHandlerFor } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'
import { AssistantStore } from '../src/assistant/store.js'
import type { AssistantEngine } from '../src/assistant/runtime.js'
import { queryAssistantStats, projectToolResult } from '../src/assistant/tools.js'
import { StatsRoute } from '../src/stats-route.js'

const root = mkdtempSync(join(tmpdir(), 'atr-assistant-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'assistant-admin', name: '助手管理员', role: 'admin' },
  { token: 'assistant-a', name: '用户甲', role: 'member' },
  { token: 'assistant-b', name: '用户乙', role: 'member' },
])
const admin = (await identity.resolveBearer('assistant-admin'))!
const stats = new StatsRoute({ identityStore: identity, dbPath })
let entered: (() => void) | undefined, release: (() => void) | undefined
let waiting = false
const engine: AssistantEngine = { async run(input) {
  if (waiting) {
    const released = new Promise<void>(done => { release = done; input.signal.addEventListener('abort', () => done(), { once: true }) })
    entered?.()
    await released
  }
  input.signal.throwIfAborted()
  await queryAssistantStats(stats, input.principal, 'overview', 'period=last7d', input.emit)
  input.emit({ type: 'text', text: '隔离后的回答' })
} }
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, assistantEngine: engine, requestLog: false })
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-assistant-'))) throw new Error('临时目录超出测试边界')
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})
function call(method: string, path: string, token?: string, body?: unknown) {
  return bundle.handler(new Request(`http://localhost/api/v1/assistant/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
}
const conversationId = async (response: Response) => {
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain('"type":"done"')
  return JSON.parse(text.split('\n').find(line => line.includes('"type":"session"'))!.slice(6)).session.session_id as string
}
test('登录才可访问助手，拒绝客户端指定身份和目录', async () => {
  expect((await call('GET', 'status')).status).toBe(401)
  expect((await call('POST', 'chat', 'assistant-admin', { prompt: '你好', member_id: '别人' })).status).toBe(400)
  expect((await call('POST', 'chat', 'assistant-admin', { prompt: '你好', session_id: '../escape' })).status).toBe(400)
  expect((await call('POST', 'chat', 'assistant-admin', { prompt: '' })).status).toBe(400)
  expect((await call('GET', 'status', 'assistant-admin')).status).toBe(200)
})
test('同一成员重启后续聊；不同用户及管理员也不能读取或删除他人的空间', async () => {
  const a = await conversationId(await call('POST', 'chat', 'assistant-admin', { prompt: '首问' }))
  const b = await conversationId(await call('POST', 'chat', 'assistant-admin', { prompt: '独立对话' }))
  const store = new AssistantStore(join(root, 'assistant'))
  const restored = await store.get(admin.memberId, a)
  expect(restored.messages.map(m => m.text)).toEqual(['首问', '隔离后的回答'])
  expect(restored.messages[1]!.results?.[0]?.title).toBe('用量总览')
  expect(restored.messages[1]!.results?.[0]?.table?.rows[0]?.total_tokens).toBe(0)
  expect((await call('GET', `sessions/${a}`, 'assistant-a')).status).toBe(404)
  expect((await call('DELETE', `sessions/${a}`, 'assistant-b')).status).toBe(404)
  expect((await call('GET', 'sessions', 'assistant-a').then(r => r.json())).sessions).toEqual([])
  const own = await conversationId(await call('POST', 'chat', 'assistant-a', { prompt: '私有会话' }))
  expect((await call('GET', `sessions/${own}`, 'assistant-admin')).status).toBe(404)
  expect((await call('DELETE', `sessions/${own}`, 'assistant-admin')).status).toBe(404)
  await conversationId(await call('POST', 'chat', 'assistant-admin', { prompt: '续问', session_id: a }))
  expect((await store.get(admin.memberId, a)).session.turn_count).toBe(2)
  expect((await store.get(admin.memberId, b)).session.turn_count).toBe(1)
  expect((await call('DELETE', `sessions/${a}`, 'assistant-admin')).status).toBe(200)
  expect((await call('GET', `sessions/${a}`, 'assistant-admin')).status).toBe(404)
})
test('并发续聊和运行中删除被拒绝，取消流释放用户锁', async () => {
  waiting = true
  const started = new Promise<void>(done => { entered = done })
  const response = await call('POST', 'chat', 'assistant-admin', { prompt: '等待取消' })
  await started
  expect((await call('POST', 'chat', 'assistant-admin', { prompt: '并发' })).status).toBe(409)
  const reader = response.body!.getReader()
  const first = await reader.read()
  const id = JSON.parse(new TextDecoder().decode(first.value).split('\n')[0]!.slice(6)).session.session_id
  expect((await call('DELETE', `sessions/${id}`, 'assistant-admin')).status).toBe(409)
  await reader.cancel()
  release?.()
  waiting = false
  for (let i = 0; i < 50; i++) {
    const deleted = await call('DELETE', `sessions/${id}`, 'assistant-admin')
    if (deleted.status === 200) return
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('取消后仍持有锁')
})
test('工具拒绝写端点、无界窗口与任意参数；脱敏不改变 token 数', async () => {
  const emit = () => {}
  await expect(queryAssistantStats(stats, admin, '../admin/members', '', emit)).rejects.toThrow()
  await expect(queryAssistantStats(stats, admin, 'records', 'limit=10000', emit)).rejects.toThrow()
  await expect(queryAssistantStats(stats, admin, 'overview', 'from=0&to=9999999999999', emit)).rejects.toThrow()
  await expect(queryAssistantStats(stats, admin, 'overview', 'sql=select', emit)).rejects.toThrow()
  const output = projectToolResult({ cwd: 'D:\\secret', user_id: '张三', userId: '张三', user_name_snapshot: '张三', group_name_snapshot: '私有部门', inputTokens: 23, input_tokens: 23, cache_read_tokens: 99 }) as Record<string, unknown>
  expect(output.cwd).toBeUndefined()
  expect(JSON.stringify(output)).not.toContain('张三')
  const coverage = projectToolResult({ reporters: [{ key: 'legacy:张三', label: '历史人员：张三', groupNames: ['私有部门'], totalTokens: 123 }] })
  expect(JSON.stringify(coverage)).not.toContain('张三')
  expect(JSON.stringify(coverage)).not.toContain('私有部门')
  expect((coverage as any).reporters[0].totalTokens).toBe(123)
  expect(JSON.stringify(output)).not.toContain('私有部门')
  expect(output.input_tokens).toBe(23)
  expect(output.inputTokens).toBe(23)
  expect(output.cache_read_tokens).toBe(99)
})
test('工具沿用真实数据范围：伪造人员筛选仍只能读自己，金额门禁保留', async () => {
  for (const [token, count] of [['assistant-a', 13], ['assistant-b', 37]] as const) {
    const response = await bundle.handler(new Request('http://localhost/api/v1/token-usage', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(), records: [{
        event_id: `assistant-scope-${token}`, session_id: 'assistant-scope', seq: 1, ts: Date.now(),
        provider: 'fixture', model: 'fixture', input_tokens: count, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      }] }),
    }))
    expect(response.status).toBe(200)
  }
  const a = (await identity.resolveBearer('assistant-a'))!, b = (await identity.resolveBearer('assistant-b'))!
  await expect(queryAssistantStats(stats, a, 'overview', `member_id=${b.memberId}`, () => {})).rejects.toThrow()
  const own: any = await queryAssistantStats(stats, a, 'overview', '', () => {})
  const all: any = await queryAssistantStats(stats, admin, 'overview', '', () => {})
  expect(own.data.totalTokens).toBe(13)
  expect(all.data.totalTokens).toBe(50)
  expect(own.data.cost).toBeUndefined()
  await expect(queryAssistantStats(stats, a, 'pricing', '', () => {})).rejects.toThrow()
  const denied = { ...a, permissions: [] }
  // ★ 传入快照不能跳过数据库裁决；现有身份重新授权后仍认当前权限。
  expect((await queryAssistantStats(stats, denied, 'overview', '', () => {})) as any).toBeDefined()
})
test('过期清理覆盖不再登录的用户，同时移除 DSH 记录；活跃用户受锁保护', async () => {
  const store = new AssistantStore(join(root, 'retention'), 1)
  const expired = await store.create(admin.memberId)
  expired.session.updated_at_ms = Date.now() - 2 * 86_400_000
  await store.save(admin.memberId, expired)
  const path = store.sessionPath(admin.memberId, expired.session.session_id)
  mkdirSync(join(path, 'dsh'))
  writeFileSync(join(path, 'dsh', 'log'), '对话正文')
  await store.prune(new Set([admin.memberId]))
  expect(existsSync(path)).toBe(true)
  await store.prune(new Set())
  expect(existsSync(path)).toBe(false)
})

test('真实 DSH agent 在 Bun 与 Node 中均能调用工具并持久化续聊', async () => {
  // ★ 其它测试会替换全局 fetch；真 HTTP 夹具必须放独立进程，不能误用别人的 mock。
  const entry = resolve(import.meta.dir, '../verify/verify-assistant-runtime.ts')
  const built = await Bun.build({ entrypoints: [entry], outdir: join(root, 'runtime-node'), target: 'node', format: 'esm', naming: '[name].mjs', plugins: [dshBundlePlugin] })
  expect(built.success).toBe(true)
  if (!built.success) throw new Error(built.logs.join('\n'))
  const node = resolveNodeBin()
  expect(node).not.toBeNull()
  for (const [binary, script] of [[process.execPath, entry], [node!, join(root, 'runtime-node', 'verify-assistant-runtime.mjs')]]) {
    const child = spawnSync(binary!, [script!], { env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
    expect(child.stdout).toContain('DSH_RUNTIME_OK')
  }
}, 35_000)
