/** 真实模型自然中文管理验收；仅写随机本地 SQLite，不接线上库，报告不含模型回答或凭证。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import type { AssistantEvent, AssistantForm } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { assistantConfigFromEnv, type DshAssistantConfig } from '../src/assistant/config.js'
import { createServer } from '../src/index.js'

const keyName = process.env.ATR_ASSISTANT_API_KEY_ENV || (!process.env.ATR_ASSISTANT_PROTOCOL || process.env.ATR_ASSISTANT_PROTOCOL === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
if (!process.env.ATR_ASSISTANT_MODEL?.trim() || !process.env[keyName]?.trim()) {
  console.log('MANAGEMENT_LIVE_PENDING: 配置缺少模型或凭证；没有发送模型请求。')
  process.exit(process.argv.includes('--check') ? 0 : 2)
}
let config: DshAssistantConfig
try { config = assistantConfigFromEnv(process.env, false)! }
catch { console.error('MANAGEMENT_LIVE_CONFIG_INVALID: 模型服务配置无效；未输出配置值。'); process.exit(2) }
if (process.argv.includes('--check')) { console.log('MANAGEMENT_LIVE_CONFIG_READY: 配置齐全；没有发送模型请求。'); process.exit(0) }

interface Alias { alias_id: string; provider: string; model: string | null; alias: string; scope: string }
const temporaryRoot = resolve(process.cwd(), '.tmp'), reportDirectory = resolve(process.cwd(), '.artifacts', 'assistant-management-live')
mkdirSync(temporaryRoot, { recursive: true })
const root = mkdtempSync(join(temporaryRoot, 'ai-manage-')), dbPath = join(root, 'portal.sqlite'), token = randomBytes(32).toString('hex')
const checks: Array<{ id: string; status: 'passed' | 'failed'; duration_ms: number }> = []
const diagnostics: Array<{ turn: number; tools: Array<{ name: string; state?: string; status: number }>; has_error: boolean }> = []
let server: Awaited<ReturnType<typeof createServer>> | undefined
let sessionId: string | undefined, turns = 0, passed = false, phase = 'setup', started = Date.now(), failureReason = ''
async function check(id: string, work: () => Promise<void>) {
  phase = id; started = Date.now()
  await work()
  checks.push({ id, status: 'passed', duration_ms: Date.now() - started })
  console.log('MANAGEMENT_LIVE_STEP_OK: ' + id)
}
function formFrom(events: AssistantEvent[]): AssistantForm {
  const forms = events.filter(event => event.type === 'open_form')
  assert.equal(forms.length, 1, '表单请求数量错误')
  assert(!events.some(event => event.type === 'tool' && ['portal_manage_save', 'portal_manage_mutate'].includes(event.tool)), '打开表单执行了写入')
  return forms[0]!.form
}
try {
  const target = { sqlitePath: dbPath, mysqlUrl: '' }
  await preparePortalDatabase(target)
  await new IdentityRepository(target).importCredentials([{ name: '管理工具隔离管理员', token, role: 'admin' }], 'assistant-management-live-fixture')
  server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, mysqlUrl: '', enableLocalApi: false, portalOrigin: '', adminToken: '', adminUsername: '', adminPassword: '', assistant: config, requestLog: false })
  const origin = new URL(server.url).origin
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin)
    return await fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(path.endsWith('/chat') ? 130_000 : 35_000) })
  }
  const aliases = async (): Promise<Alias[]> => {
    const response = await request('GET', '/api/v1/admin/provider-aliases')
    assert.equal(response.status, 200)
    return ((await response.json()) as { aliases: Alias[] }).aliases
  }
  const chat = async (prompt: string, fresh = false): Promise<AssistantEvent[]> => {
    assert(++turns <= 5, '真实模型轮次超出验收上限')
    const response = await request('POST', '/api/v1/assistant/chat', { prompt, ...(!fresh && sessionId ? { session_id: sessionId } : {}), page: '/providers' })
    assert.equal(response.status, 200)
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
    diagnostics.push({ turn: turns, tools: events.filter(event => event.type === 'tool').map(event => ({ name: event.tool, state: event.state, status: event.status })), has_error: events.some(event => event.type === 'error') })
    assert(events.some(event => event.type === 'done') && !events.some(event => event.type === 'error'), '自然语言轮次没有正常完成')
    assert(!events.some(event => event.type === 'tool' && event.state === 'failed'), '自然语言轮次有失败工具')
    const session = events.find(event => event.type === 'session')
    assert(session?.type === 'session')
    sessionId = session.session.session_id
    return events
  }
  await check('readonly_context', async () => {
    const events = await chat('我打算新增两条全局供应商归一化规则：原供应商 manage-live-a 统一为 验收阿里云，原供应商 manage-live-b 统一为 验收DeepSeek。先看看已有规则并说明怎么填写，暂时不要保存。')
    assert(!events.some(event => event.type === 'tool' && ['portal_manage_save', 'portal_manage_mutate'].includes(event.tool)))
    assert.equal((await aliases()).length, 0)
  })
  await check('affirmative_direct_save', async () => {
    const events = await chat('是的直接帮我新建两条')
    assert(events.some(event => event.type === 'tool' && event.tool === 'portal_manage_save' && event.state === 'completed'), '截图原话没有选用直接保存工具')
    const rows = await aliases()
    assert.equal(rows.length, 2)
    assert(rows.some(row => row.provider === 'manage-live-a' && row.alias === '验收阿里云' && row.model === null && row.scope === 'global'))
    assert(rows.some(row => row.provider === 'manage-live-b' && row.alias === '验收DeepSeek' && row.model === null && row.scope === 'global'))
  })
  await check('create_form_without_write', async () => {
    const form = formFrom(await chat('请打开供应商规则的新建弹框，预填全局规则：原供应商 manage-live-form，统一名称 验收待填写。我填写后点击保存。', true))
    assert.equal(form.resource, 'provider-aliases'); assert.equal(form.operation, 'create'); assert.equal(form.path, '/providers')
    assert.equal(form.values.provider, 'manage-live-form'); assert.equal(form.values.alias, '验收待填写')
    assert.equal((await aliases()).length, 2)
    // ★ 模拟既有页面保存接口；工具预填值仍需经过管理路由的完整校验。
    const saved = await request('POST', '/api/v1/admin/provider-aliases', form.values)
    assert.equal(saved.status, 200)
    assert.equal((await aliases()).length, 3)
  })
  await check('update_form_without_write', async () => {
    const target = (await aliases()).find(row => row.provider === 'manage-live-form')!
    const form = formFrom(await chat('帮我查询原供应商 manage-live-form 的全局规则，然后打开它的编辑弹框，将统一名称预填为 验收编辑草稿。等我点击保存。', true))
    assert.equal(form.operation, 'update'); assert.equal(form.target_id, target.alias_id)
    assert(form.values.provider === undefined || form.values.provider === 'manage-live-form'); assert.equal(form.values.alias, '验收编辑草稿')
    assert.equal((await aliases()).find(row => row.alias_id === target.alias_id)?.alias, '验收待填写')
  })
  await check('direct_update_after_draft', async () => {
    const events = await chat('现在请直接帮我保存刚才这条规则的统一名称为 验收编辑已保存。')
    assert(events.some(event => event.type === 'tool' && event.tool === 'portal_manage_save' && event.state === 'completed'))
    const rows = await aliases()
    assert.equal(rows.length, 3)
    assert.equal(rows.find(row => row.provider === 'manage-live-form')?.alias, '验收编辑已保存')
  })
  passed = true
  console.log('ASSISTANT_MANAGEMENT_LIVE_OK: 真实模型五轮管理工具验收全部通过。')
} catch (error) {
  // 自有断言只涉及合成字段、工具名及HTTP状态；SDK异常仍不输出。
  if (error instanceof assert.AssertionError) failureReason = String(error.message).slice(0, 300)
  checks.push({ id: phase, status: 'failed', duration_ms: Date.now() - started })
  console.error('ASSISTANT_MANAGEMENT_LIVE_FAILED: ' + phase + '；未输出凭证或模型回答。')
  process.exitCode = 1
} finally {
  await server?.stop()
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ ok: passed, turns, checks, diagnostics, ...(failureReason ? { failure_reason: failureReason } : {}) }, null, 2) + '\n')
  const destination = resolve(root)
  if (!destination.startsWith(temporaryRoot + sep) || !destination.slice(temporaryRoot.length + 1).startsWith('ai-manage-')) throw new Error('清理目录超出隔离验收边界')
  await rm(destination, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
