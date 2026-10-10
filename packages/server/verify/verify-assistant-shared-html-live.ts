/**
 * 根目录 .env 的真实模型分享查询验收：两轮自然中文、真实 DSH / HTTP / 隔离 SQLite。
 * ★ 旧会话只含合成 HTML；显式空 mysqlUrl 屏蔽线上配置，报告不保存凭证、链接或模型回答。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import type { AssistantArtifact, AssistantArtifactShare, AssistantEvent } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { assistantConfigFromEnv, type DshAssistantConfig } from '../src/assistant/config.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { AssistantStore } from '../src/assistant/store.js'
import { createServer } from '../src/index.js'

const keyName = process.env.ATR_ASSISTANT_API_KEY_ENV || (!process.env.ATR_ASSISTANT_PROTOCOL || process.env.ATR_ASSISTANT_PROTOCOL === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
if (!process.env.ATR_ASSISTANT_MODEL?.trim() || !process.env[keyName]?.trim()) {
  console.log('SHARED_HTML_LIVE_PENDING: 配置缺少模型或凭证；没有发送模型请求。')
  process.exit(process.argv.includes('--check') ? 0 : 2)
}
let config: DshAssistantConfig
try { config = assistantConfigFromEnv(process.env, false)! }
catch { console.error('SHARED_HTML_LIVE_CONFIG_INVALID: 模型服务配置无效；未发送请求，未输出配置值。'); process.exit(2) }
if (process.argv.includes('--check')) {
  console.log('SHARED_HTML_LIVE_CONFIG_READY: 配置齐全；只读检查完成，没有发送模型请求。')
  process.exit(0)
}

interface Check { id: string; name: string; status: 'passed' | 'failed'; duration_ms: number }
interface SharedFixture { artifact: AssistantArtifact; share: AssistantArtifactShare }
const checks: Check[] = []
const temporaryRoot = resolve(process.cwd(), '.tmp')
const reportDirectory = resolve(process.cwd(), '.artifacts', 'assistant-shared-html-live')
mkdirSync(temporaryRoot, { recursive: true })
// ⚠️ Windows 的系统 Temp 较长；短目录避免身份哈希、会话 UUID 与附件路径触及原生长度限制。
const root = mkdtempSync(join(temporaryRoot, 'ai-share-'))
const dbPath = join(root, 'portal.sqlite'), token = randomBytes(32).toString('hex')
let server: Awaited<ReturnType<typeof createServer>> | undefined
let turnCount = 0
let passed = false
let activeCheckId = 'setup', activeCheck = '初始化隔离环境', activeStarted = Date.now()
async function check(id: string, name: string, work: () => Promise<void>) {
  activeCheckId = id; activeCheck = name; activeStarted = Date.now()
  await work()
  const duration = Date.now() - activeStarted
  checks.push({ id, name, status: 'passed', duration_ms: duration })
  console.log(`SHARED_HTML_LIVE_STEP_OK: ${name}（${duration}ms）`)
}
function assertAnswer(text: string, fixtures: SharedFixture[]) {
  // ★ 允许自然语言用中文或斜线日期；核对同一北京时间日期，不限定模型排版。
  const normalized = text.replace(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, (_, year: string, month: string, day: string) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`)
    .replace(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/g, (_, year: string, month: string, day: string) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`)
  for (const fixture of fixtures) {
    assert(text.includes(fixture.artifact.title), '回答遗漏真实分享标题')
    assert(text.includes(fixture.share.url), '回答遗漏真实分享链接')
    assert(normalized.includes(new Date(fixture.share.expires_at_ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })), '回答遗漏真实到期日期')
  }
  assert(!/\/(?:overview|analysis|records|diagnostics|members|appkeys|roles|groups|providers|projects|pricing)(?:\b|[/?#])/.test(text), '回答将后台路由列作公开分享')
}
try {
  const target = { sqlitePath: dbPath, mysqlUrl: '' }
  await preparePortalDatabase(target)
  const identity = new IdentityRepository(target)
  // ★ 管理员测试凭证带完整角色权限，与浏览器登录后的文件权限边界及匿名主人复验一致。
  await identity.importCredentials([{ name: '分享查询隔离成员', token, role: 'admin' }], 'assistant-shared-html-live-fixture')
  const principal = await identity.resolveBearer(token)
  assert(principal, '隔离成员身份未建立')
  assert(principal.permissions.includes('stats:read'), '隔离成员身份无法访问助手')
  server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, mysqlUrl: '', enableLocalApi: false, portalOrigin: '', adminToken: '', adminUsername: '', adminPassword: '', assistant: config, requestLog: false })
  const url = server.url, origin = new URL(url).origin
  const store = new AssistantStore(join(root, 'assistant'))
  const artifacts = new AssistantArtifacts(store.root, origin)
  const oldSession = await store.create(principal.memberId)
  await store.assertAccess(principal, oldSession.session.session_id)
  const fixtures: SharedFixture[] = []
  await check('old_session_fixtures', '隔离成员旧会话创建两份合成 HTML 及限时分享', async () => {
    for (const [index, expiresInHours] of [1, 24].entries()) {
      const artifact = await artifacts.create(principal.memberId, oldSession.session.session_id, { format: 'html', title: index === 0 ? '分享查询验收报告甲' : '分享查询验收报告乙', content: '这是分享查询验收的合成内容，不含业务数据。' }, new AssistantDatasets(), principal)
      const share = await artifacts.share(principal.memberId, artifact.artifact_id, { expires_in_hours: expiresInHours }, principal)
      fixtures.push({ artifact, share })
    }
    assert.equal((await artifacts.listSharedHtml(principal.memberId, {}, principal)).total, 2, '旧会话合成分享夹具不完整')
  })
  const request = (method: string, path: string, body?: unknown, anonymous = false) => {
    const destination = new URL(path, url)
    assert.equal(destination.origin, origin, '验收请求不允许离开隔离本地服务')
    return fetch(destination, { method, headers: { ...(!anonymous ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(method === 'POST' && destination.pathname.endsWith('/chat') ? 130_000 : 35_000) })
  }
  const chat = async (): Promise<{ text: string; sessionId: string }> => {
    assert(++turnCount <= 2, '真实模型验收超过两轮上限')
    // ★ 两轮都省略 session_id，查询答案不能依赖历史创建或分享消息。
    const response = await request('POST', '/api/v1/assistant/chat', { prompt: '目前对外开放的 html 页面有哪些', page: '/overview' })
    assert.equal(response.status, 200, '助手对话 HTTP 失败')
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
    assert(!events.some(event => event.type === 'error'), '自然查询出现 error 事件')
    assert(events.some(event => event.type === 'done'), '自然查询缺少 done 事件')
    const activity = events.filter(event => event.type === 'tool')
    assert(activity.some(event => event.tool === 'list_shared_html' && event.state === 'completed'), '自然查询没有选择并完成 list_shared_html')
    assert(!activity.some(event => event.state === 'failed'), '自然查询存在失败工具调用')
    assert(!activity.some(event => ['share_html', 'create_file', 'portal_manage_mutate'].includes(event.tool)), '查询历史分享却调用了生成、分享或修改工具')
    assert(!events.some(event => ['artifact', 'action', 'navigate'].includes(event.type)), '查询历史分享产生了非只读动作')
    for (const started of activity.filter(event => event.state === 'running')) assert(activity.some(ended => ended.call_id === started.call_id && ended.state === 'completed'), '工具调用缺少对应完成进度')
    const session = events.find(event => event.type === 'session')
    assert(session?.type === 'session' && session.session.session_id !== oldSession.session.session_id, '历史分享未在全新会话查询')
    return { text: events.filter(event => event.type === 'text').map(event => event.text).join(''), sessionId: session.session.session_id }
  }
  let first: Awaited<ReturnType<typeof chat>> | undefined
  await check('first_query_tool', '第一轮全新对话自然选择只读列表工具并完成', async () => { first = await chat() })
  await check('first_query_answer', '第一轮答复包含两个真实标题、链接及到期日期', async () => { assertAnswer(first!.text, fixtures) })
  await check('first_query_readonly', '第一轮查询后两份旧文件及匿名分享仍有效', async () => {
    assert.equal((await artifacts.list(principal.memberId, oldSession.session.session_id, principal)).length, 2, '查询改变了旧会话文件')
    assert.equal((await artifacts.listSharedHtml(principal.memberId, {}, principal)).total, 2, '查询改变了旧会话分享')
    for (const fixture of fixtures) assert.equal((await request('GET', fixture.share.url, undefined, true)).status, 200, '查询关闭了有效匿名分享')
  })
  await check('revoke_one_share', '直接撤销一份旧分享，匿名链接失效且有效列表只剩一份', async () => {
    await artifacts.revoke(principal.memberId, fixtures[0]!.artifact.artifact_id)
    assert.equal((await request('GET', fixtures[0]!.share.url, undefined, true)).status, 410, '已撤销分享仍能匿名读取')
    const active = await artifacts.listSharedHtml(principal.memberId, {}, principal)
    assert.equal(active.total, 1, '撤销后有效分享总数错误')
    assert.equal(active.shares[0]?.artifact_id, fixtures[1]!.artifact.artifact_id, '撤销后留下了错误分享')
  })
  let second: Awaited<ReturnType<typeof chat>> | undefined
  await check('second_query_tool', '第二轮另一全新对话自然选择只读列表工具并完成', async () => {
    second = await chat()
    assert.notEqual(second.sessionId, first!.sessionId, '第二轮沿用了第一轮会话')
  })
  await check('second_query_answer', '第二轮只答复仍有效分享，排除已撤销标题与链接', async () => {
    assertAnswer(second!.text, [fixtures[1]!])
    assert(!second!.text.includes(fixtures[0]!.artifact.title) && !second!.text.includes(fixtures[0]!.share.url), '回答仍列出已撤销分享')
    assert.equal((await request('GET', fixtures[1]!.share.url, undefined, true)).status, 200, '第二轮查询关闭了仍有效分享')
    const active = await artifacts.listSharedHtml(principal.memberId, {}, principal)
    assert.equal(active.total, 1, '第二轮查询改变了有效分享')
    assert.equal(active.shares[0]?.url, fixtures[1]!.share.url, '第二轮查询替换了分享链接')
  })
  passed = true
  console.log('ASSISTANT_SHARED_HTML_LIVE_OK: 真实模型两轮自然中文验收全部通过；报告仅保存固定检查项及耗时。')
} catch {
  checks.push({ id: activeCheckId, name: activeCheck, status: 'failed', duration_ms: Date.now() - activeStarted })
  // ★ SDK 和断言异常都可能携带模型请求或链接；失败只报告固定阶段，不输出异常内容。
  console.error('ASSISTANT_SHARED_HTML_LIVE_FAILED: ' + activeCheck + '；未输出凭证、链接或模型回答。')
  process.exitCode = 1
} finally {
  await server?.stop()
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ ok: passed, turns: turnCount, checks }, null, 2) + '\n')
  const destination = resolve(root)
  if (!destination.startsWith(temporaryRoot + sep) || !destination.slice(temporaryRoot.length + 1).startsWith('ai-share-')) throw new Error('清理目录超出隔离验收边界')
  for (let attempt = 0; ; attempt++) {
    try { await rm(destination, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 20 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}
