/**
 * 真 HTTP + 真 SQLite/MySQL + DSH 回环模型验收：文件、有限编辑、删除确认、分享与导航。
 * ★ 所有身份、业务数据和模型请求都在随机本地夹具内，不访问线上，也不消耗模型额度。
 */
import assert from 'node:assert/strict'
import { createServer as createModelServer } from 'node:http'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import type { AssistantArtifact, AssistantDetail, AssistantEvent, AssistantForm, AssistantPendingAction } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { createServer } from '../src/index.js'
import { createIsolatedMysql } from './mysql-isolation.js'

interface ToolCall { name: string; args: Record<string, unknown> }
interface Alias { alias_id: string; prefix: string; alias: string }
interface ProviderAlias { alias_id: string; scope: string; provider: string; model: string | null; alias: string; enabled: boolean }
interface ModelRequest {
  tools?: Array<{ function?: { name?: string } }>
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string } }> }>
}
interface SharedHtmlPage {
  scope: 'current_member'; captured_at_ms: number; total: number; offset: number; limit: number; next_offset: number | null
  shares: Array<{ artifact_id: string; session_id: string; title: string; file_name: string; created_at_ms: number; url: string; expires_at_ms: number; expires_at_label: string }>
}
const temporaryRoot = resolve(process.cwd(), '.tmp')
mkdirSync(temporaryRoot, { recursive: true })
// ⚠️ Windows sandbox 的系统 Temp 前缀较长；短路径避免哈希目录 + UUID 触及原生路径限制。
const root = mkdtempSync(join(temporaryRoot, 'atr-ai-capability-'))
const dbPath = join(root, 'portal.sqlite')
const apiKeyEnv = 'ATR_ASSISTANT_CAPABILITIES_KEY'
const previousKey = process.env[apiKeyEnv]
const fixtureKey = randomBytes(24).toString('hex')
const token = randomBytes(24).toString('hex'), otherToken = randomBytes(24).toString('hex')
let plan: ToolCall[] = []
let modelFailure = false
let modelFailureReason = ''
let modelRequests = 0
const capturedModelRequests: ModelRequest[] = []
let phase = '准备回环模型'
let server: Awaited<ReturnType<typeof createServer>> | undefined
let isolation: Awaited<ReturnType<typeof createIsolatedMysql>> | null = null
const model = createModelServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions', 'DSH 模型协议路径错误')
    assert.equal(req.headers.authorization, 'Bearer ' + fixtureKey, 'DSH 模型认证头错误')
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const request = JSON.parse(body) as ModelRequest
    capturedModelRequests.push(request)
    const selected = plan.shift()
    if (selected) assert(request.tools?.some(tool => tool.function?.name === selected.name), '本轮预期工具未挂载：' + selected.name)
    const id = 'capability-' + (++modelRequests)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta: unknown, finishReason: string | null = null) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'capability-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n')
    chunk(selected ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: selected.name, arguments: JSON.stringify(selected.args) } }] } : { role: 'assistant', content: '夹具步骤已完成，请查看对应结果卡片。' })
    chunk({}, selected ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) {
    modelFailure = true
    modelFailureReason = error instanceof assert.AssertionError ? error.message : '回环模型协议或工具夹具失败'
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end('{"error":{"message":"local fixture assertion failed"}}')
  }
})
const step = (message: string) => console.log('CAPABILITY_STEP_OK: ' + message)
const headers = (secret = token) => ({ Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' })
const sharedToken = (url: string) => url.slice(url.lastIndexOf('/') + 1)
function toolResponses(from: number, name: string): Array<Record<string, unknown>> {
  const previous = new Set(capturedModelRequests[from]?.messages?.filter(message => message.role === 'tool').map(message => message.tool_call_id))
  const collected = new Map<string, Record<string, unknown>>()
  for (const request of capturedModelRequests.slice(from)) {
    const ids = new Set(request.messages?.flatMap(message => message.tool_calls ?? []).filter(call => call.function?.name === name).map(call => call.id))
    for (const message of request.messages ?? []) {
      if (message.role !== 'tool' || !message.tool_call_id || previous.has(message.tool_call_id) || !ids.has(message.tool_call_id)) continue
      assert.equal(typeof message.content, 'string', '模型没有收到工具返回的真实正文')
      collected.set(message.tool_call_id, JSON.parse(message.content as string))
    }
  }
  return [...collected.values()]
}
function unpack(bytes: Buffer): Record<string, string> {
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, '下载不是 ZIP 文件')
  const end = bytes.length - 22
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'ZIP 缺少目录终止结构')
  const entries: Record<string, string> = {}; let offset = 0; let count = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 8)
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameSize + extraSize
    const data = inflateRawSync(bytes.subarray(start, start + size))
    assert.equal(data.length, bytes.readUInt32LE(offset + 22))
    entries[bytes.subarray(offset + 30, offset + 30 + nameSize).toString()] = data.toString()
    offset = start + size; count++
  }
  assert.equal(bytes.readUInt32LE(end + 16), offset); assert.equal(bytes.readUInt16LE(end + 8), count)
  return entries
}
try {
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  const modelPort = (model.address() as { port: number }).port
  process.env[apiKeyEnv] = fixtureKey
  phase = '准备隔离数据库'
  isolation = process.argv.includes('--mysql') ? await createIsolatedMysql() : null
  const target = { sqlitePath: dbPath, mysqlUrl: isolation?.url ?? '' }
  const backendLabel = isolation ? 'MySQL' : 'SQLite'
  await preparePortalDatabase(target)
  const identity = new IdentityRepository(target)
  await identity.importCredentials([{ name: '隔离能力管理员', token, role: 'admin' }, { name: '隔离能力成员', token: otherToken, role: 'member' }], 'assistant-capability-fixture')
  phase = '启动本地 HTTP 服务'
  server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, mysqlUrl: target.mysqlUrl, portalOrigin: '', requestLog: false, assistant: { model: 'capability-fixture', protocol: 'openai-completions', apiKeyEnv, baseUrl: `http://127.0.0.1:${modelPort}/v1` } })
  const url = server.url
  const request = (method: string, path: string, body?: unknown, secret: string | null = token) => fetch(new URL(path, url), { method, headers: secret ? headers(secret) : { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) })
  let sessionId: string | undefined
  const chat = async (prompt: string, calls: ToolCall[], secret = token, ownSession: string | null = sessionId ?? null, allowToolFailure = false) => {
    assert.equal(plan.length, 0, '前一轮模型夹具未消费完成')
    plan = [...calls]
    const response = await request('POST', '/api/v1/assistant/chat', { prompt, ...(ownSession ? { session_id: ownSession } : {}), page: '/records' }, secret)
    assert.equal(response.status, 200, '助手对话 HTTP 失败')
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
    assert(!modelFailure, modelFailureReason || '回环模型协议或工具挂载断言失败')
    assert.equal(plan.length, 0, 'DSH 未执行完整工具序列')
    assert(!events.some(event => event.type === 'error'), 'DSH 对话未完成')
    assert(events.some(event => event.type === 'done'), '缺少完成 SSE 事件')
    const activity = events.filter(event => event.type === 'tool')
    if (!allowToolFailure) assert(!activity.some(event => event.state === 'failed'), '工具返回失败')
    for (const started of activity.filter(event => event.state === 'running')) assert(activity.some(ended => ended.call_id === started.call_id && ['completed', 'failed'].includes(String(ended.state))), '工具状态未结束')
    const session = events.find(event => event.type === 'session')
    if (secret === token && session?.type === 'session') sessionId = session.session.session_id
    return events
  }
  const now = Date.now()
  phase = '写入隔离用量'
  assert.equal((await request('POST', '/api/v1/token-usage', { schemaVersion: 1, client: {}, generatedAt: new Date(now).toISOString(), records: [125, 300].map((input_tokens, index) => ({ event_id: 'capability:' + index, session_id: 'capability-session', seq: index, ts: now, provider: 'test-fixture', model: '能力验收模型' + (index + 1), source: 'dsh', input_tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 })) })).status, 200, '隔离用量入库失败')
  const truthResponse = await request('GET', '/api/v1/stats/breakdown?period=last7d&by=model&identity_view=member')
  assert.equal(truthResponse.status, 200)
  const truth = await truthResponse.json() as { rows: Array<{ key: string; totalTokens: number }> }
  phase = 'query_usage 工具链'
  const events = await chat('查询最近七天的模型用量，显示真实数据表格。', [{ name: 'query_usage', args: { view: 'breakdown', period: 'last7d', by: 'model', display: 'table' } }])
  const table = events.filter(event => event.type === 'result').map(event => event.result).find(result => result.display === 'table')
  assert(table?.dataset_id, '常规查询未生成数据集')
  assert.deepEqual(table.table!.rows.map(row => [row.dimension, row.total_tokens]).sort(), truth.rows.map(row => [row.key, row.totalTokens]).sort(), '查询结果与真实数据库不一致')
  step(`一次 query_usage → ${backendLabel} 真值 → 数据集表格`)

  phase = '文件生成与下载'
  const files = await chat('生成 Word、Excel 和 HTML 三种文件，复用刚才的真实统计数据。', ['docx', 'xlsx', 'html'].map(format => ({ name: 'create_file', args: { format, title: '能力验收报告 ' + format, dataset_id: table.dataset_id } })))
  const artifacts = files.filter(event => event.type === 'artifact').map(event => event.artifact)
  assert.deepEqual(artifacts.map(artifact => artifact.format), ['docx', 'xlsx', 'html'])
  for (const artifact of artifacts) {
    const response = await request('GET', artifact.download_path)
    assert.equal(response.status, 200, '文件下载失败')
    assert(response.headers.get('content-disposition')?.startsWith('attachment;'))
    assert(response.headers.get('cache-control')?.includes('no-store'))
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, artifact.size_bytes)
    if (artifact.format !== 'html') {
      const entries = unpack(bytes)
      const document = artifact.format === 'docx' ? entries['word/document.xml'] : entries['xl/worksheets/sheet1.xml']
      assert(document && entries['[Content_Types].xml'])
      assert(document.includes('125') && document.includes('300'), 'Office 文件未保留真实数值')
      if (artifact.format === 'xlsx') assert(!document.includes('<f>'), 'Excel 文件含可执行公式')
    } else {
      assert(bytes.toString().includes('<table>') && bytes.toString().includes('能力验收模型'))
      assert(response.headers.get('content-security-policy')?.includes("sandbox; default-src 'none'"))
    }
    assert.equal((await request('GET', artifact.download_path, undefined, otherToken)).status, 404, '跨用户下载文件成功')
  }
  step('DSH 生成 docx/xlsx/html → 真 HTTP 鉴权下载 → Office ZIP/真值验证')

  phase = 'HTML 分享'
  const html = artifacts.find(artifact => artifact.format === 'html')!
  const sharedEvents = await chat('分享刚才的 HTML 报告，有效期一小时。', [{ name: 'share_html', args: { artifact_id: html.artifact_id, expires_in_hours: 1 } }])
  const shared = sharedEvents.filter(event => event.type === 'artifact').map(event => event.artifact).find(artifact => artifact.artifact_id === html.artifact_id)?.share
  assert(shared, '分享工具未产生链接')
  assert.equal(Buffer.from(sharedToken(shared.url), 'base64url').length, 32, '分享令牌随机位数不足')
  assert.equal((await request('GET', shared.url, undefined, null)).status, 200, '匿名分享链接无法访问')
  assert.equal((await request('POST', `/api/v1/assistant/artifacts/${html.artifact_id}/share`, { expires_in_hours: 1 }, otherToken)).status, 404, '跨用户生成了分享链接')
  assert.equal((await request('POST', `/api/v1/assistant/artifacts/${html.artifact_id}/share`, { expires_in_hours: 0 })).status, 400, '非法过期时间未拒绝')
  const listSharedHtml = async (secret = token): Promise<SharedHtmlPage> => {
    const previousSessionId = sessionId, capturedFrom = capturedModelRequests.length, startedAt = Date.now()
    try {
      const listed = await chat('目前对外开放的 html 页面有哪些', [{ name: 'list_shared_html', args: { limit: 1, offset: 0 } }], secret, null)
      const session = listed.find(event => event.type === 'session')
      assert(session?.type === 'session' && session.session.session_id !== html.session_id, '历史分享查询必须在全新会话执行')
      assert(!listed.some(event => event.type === 'artifact' || event.type === 'action'), '只读查询生成了文件、分享或修改卡片')
      const requests = capturedModelRequests.slice(capturedFrom)
      assert.equal(requests.length, 2, '列表工具结果未进入下一次真实模型请求')
      for (const modelRequest of requests) {
        const names = modelRequest.tools?.map(tool => tool.function?.name) ?? []
        assert(names.includes('list_shared_html'), '纯查询没有挂载历史分享列表工具')
        assert(!names.includes('share_html') && !names.includes('portal_manage_mutate') && !names.includes('portal_manage_save'), '查询历史分享却挂载了发布或修改工具')
      }
      assert(!requests[0]?.messages?.some(message => message.role === 'tool'), '新会话沿用了旧工具上下文，无法证明跨会话查询')
      const nextRequest = requests[1]!
      const callId = nextRequest.messages?.flatMap(message => message.tool_calls ?? []).find(call => call.function?.name === 'list_shared_html')?.id
      assert(callId, '下一模型请求缺少列表工具调用记录')
      const result = nextRequest.messages?.find(message => message.role === 'tool' && message.tool_call_id === callId)
      assert(result && typeof result.content === 'string', '下一模型请求缺少列表工具真实结果')
      const page = JSON.parse(result.content) as SharedHtmlPage
      assert.equal(page.scope, 'current_member', '列表没有说明当前账号范围')
      assert(Number.isSafeInteger(page.captured_at_ms) && page.captured_at_ms >= startedAt && page.captured_at_ms <= Date.now(), '列表采集时间无效')
      assert.equal(page.offset, 0); assert.equal(page.limit, 1); assert.equal(page.next_offset, null)
      return page
    } finally {
      // ⚠️ 查询会新建会话；恢复原 ID，后续编辑、确认和历史断言仍应落在文件所属会话。
      sessionId = previousSessionId
    }
  }
  phase = '只读历史 HTML 分享查询'
  const currentShares = await listSharedHtml()
  assert.equal(currentShares.total, 1, '当前账号有效分享总数错误')
  assert.deepEqual(currentShares.shares, [{ artifact_id: html.artifact_id, session_id: html.session_id, title: html.title, file_name: html.file_name, created_at_ms: html.created_at_ms, url: shared.url, expires_at_ms: shared.expires_at_ms, expires_at_label: `${new Date(shared.expires_at_ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（北京时间）` }], '历史列表缺少真实文件、URL 或 TTL')
  const otherShares = await listSharedHtml(otherToken)
  assert.equal(otherShares.total, 0, '列表泄露其他账号的分享总数')
  assert.deepEqual(otherShares.shares, [], '列表泄露其他账号的分享链接')
  assert.equal((await request('GET', shared.url, undefined, null)).status, 200, '只读查询改变了匿名分享链接')
  assert.equal((await request('POST', `/api/v1/assistant/artifacts/${html.artifact_id}/revoke`, {})).status, 200)
  assert.equal((await request('GET', shared.url, undefined, null)).status, 410, '撤销后链接仍可访问')
  const revokedShares = await listSharedHtml()
  assert.equal(revokedShares.total, 0, '撤销后有效分享总数未清零')
  assert.deepEqual(revokedShares.shares, [], '撤销后仍向模型返回公开链接')
  step('list_shared_html → 新会话只读工具 → 模型收到历史真实URL/TTL → 跨owner空列表 → 查询不改链接 → 撤销后空列表')
  phase = 'HTML 分享重建'
  const reshared = await request('POST', `/api/v1/assistant/artifacts/${html.artifact_id}/share`, { expires_in_hours: 24 })
  assert.equal(reshared.status, 200)
  const renewed = (await reshared.json() as { artifact: AssistantArtifact }).artifact.share!
  assert.notEqual(renewed.url, shared.url)
  step('share_html → 匿名能力链接 → 跨owner拒绝 → 限时参数 → 撤销与重建')

  phase = '管理新建与修改'
  const prefix = 'capability-repo-' + randomUUID(), alias = '隔离能力项目'
  const aliases = async (): Promise<Alias[]> => {
    const response = await request('GET', '/api/v1/admin/project-aliases')
    assert.equal(response.status, 200)
    return (await response.json() as { aliases: Alias[] }).aliases
  }
  await chat('新建项目归一化规则，将能力验收仓库归到隔离能力项目。', [{ name: 'portal_manage_save', args: { resource: 'project-aliases', operation: 'create', values: { scope: 'global', prefix, alias, enabled: true } } }])
  const created = (await aliases()).find(row => row.prefix === prefix)
  assert(created, '管理创建工具未真实写入数据库')
  await chat('修改刚才新建的项目规则，项目名改为已修改；先查询精确规则ID。', [{ name: 'portal_manage_query', args: { resource: 'project-aliases', search: prefix } }, { name: 'portal_manage_save', args: { resource: 'project-aliases', operation: 'update', target_id: created.alias_id, values: { alias: '隔离能力项目已修改' } } }])
  assert.equal((await aliases()).find(row => row.alias_id === created.alias_id)?.alias, '隔离能力项目已修改', '管理更新工具未真实写入数据库')
  const sqlAlias = () => identity.read(tx => tx.get<{ alias: string }>('SELECT alias FROM project_alias WHERE alias_id = $id', { $id: created.alias_id }))
  assert.equal((await sqlAlias())?.alias, '隔离能力项目已修改', '编辑后的实际 SQL 与管理接口不同')
  step(`portal_manage_query → 精确规则ID → portal_manage_save 新建与编辑 → ${backendLabel} 真实变化`)

  phase = '肯定续聊直接保存两条供应商规则'
  const providerAliases = async (): Promise<ProviderAlias[]> => {
    const response = await request('GET', '/api/v1/admin/provider-aliases')
    assert.equal(response.status, 200)
    return (await response.json() as { aliases: ProviderAlias[] }).aliases
  }
  const sqlProvider = (id: string) => identity.read(tx => tx.get<{ provider: string; model: string | null; alias: string }>('SELECT provider, model, alias FROM provider_alias WHERE alias_id = $id', { $id: id }))
  const mappings = [{ provider: 'dashscope', alias: '数字集团阿里云' }, { provider: 'deepseek-official', alias: 'DeepSeek' }]
  const originalPromptFrom = capturedModelRequests.length
  const directSaved = await chat('是的直接帮我新建两条', mappings.map(values => ({ name: 'portal_manage_save', args: { resource: 'provider-aliases', operation: 'create', values: { scope: 'global', ...values, enabled: true } } })))
  assert(!directSaved.some(event => event.type === 'action' || event.type === 'open_form'), '直接保存误生成确认卡或填写弹框')
  assert(capturedModelRequests.slice(originalPromptFrom).every(modelRequest => modelRequest.tools?.some(tool => tool.function?.name === 'portal_manage_save')), '原话未挂载直接保存工具')
  assert.deepEqual(toolResponses(originalPromptFrom, 'portal_manage_save').map(result => [result.ok, result.executed]), [[true, true], [true, true]], '直接保存真实结果未明确告知模型已经执行')
  for (const mapping of mappings) {
    const row = (await providerAliases()).find(entry => entry.provider === mapping.provider && entry.model === null)
    assert(row, '供应商原值没有独立写入一条规则')
    assert.equal(row.alias, mapping.alias, '供应商规则统一名称与输入不符')
    assert.deepEqual(await sqlProvider(row.alias_id), { provider: mapping.provider, model: null, alias: mapping.alias }, '供应商管理接口与实际 SQL 不符')
  }
  step(`截图原话 → portal_manage_save 两个原供应商映射 → 管理 API 与 ${backendLabel} SQL 均真实入库`)

  phase = '纯查询和说明不开放保存'
  const managementSessionId = sessionId
  try {
    for (const prompt of ['查询现有供应商归一化规则', '解释新增供应商规则会有什么影响']) {
      const from = capturedModelRequests.length, before = await providerAliases()
      await chat(prompt, [{ name: 'portal_manage_query', args: { resource: 'provider-aliases' } }], token, null)
      for (const modelRequest of capturedModelRequests.slice(from)) {
        const names = modelRequest.tools?.map(tool => tool.function?.name) ?? []
        assert(names.includes('portal_open_form'), '普通对话缺少填写弹框工具')
        assert(!names.includes('portal_manage_save') && !names.includes('portal_manage_mutate'), '纯查询或说明挂载了直接写工具')
      }
      assert.deepEqual(await providerAliases(), before, '纯查询或说明改变了规则')
    }
  } finally { sessionId = managementSessionId }
  step('纯查询/解释 → 不挂载直接写工具 → 规则保持不变')

  phase = '全新会话打开填写弹框后用页面接口保存'
  try {
    const before = await providerAliases(), formProvider = 'capability-form-' + randomUUID()
    const from = capturedModelRequests.length
    const formEvents = await chat('帮我打开供应商规则新建弹框，预填原供应商，让我填写后保存', [{ name: 'portal_open_form', args: { resource: 'provider-aliases', operation: 'create', values: { scope: 'global', provider: formProvider } } }], token, null)
    const formEvent = formEvents.find(event => event.type === 'open_form')
    assert(formEvent?.type === 'open_form', '打开表单工具没有真实 SSE 表单事件')
    const form: AssistantForm = formEvent.form
    assert.equal(form.resource, 'provider-aliases'); assert.equal(form.operation, 'create'); assert.equal(form.path, '/providers')
    assert.match(form.request_id, /^[0-9a-f-]{36}$/); assert.equal(form.target_id, undefined)
    assert.deepEqual(form.values, { scope: 'global', provider: formProvider }, '新建表单没有保留可填写的部分预填')
    assert(!capturedModelRequests[from]?.messages?.some(message => message.role === 'tool'), '表单验收沿用了历史工具上下文')
    assert(capturedModelRequests.slice(from).every(modelRequest => !modelRequest.tools?.some(tool => tool.function?.name === 'portal_manage_save')), '用户等待填写却挂载了直接保存工具')
    assert.deepEqual(toolResponses(from, 'portal_open_form').map(result => [result.ok, result.requested, result.executed]), [[true, true, false]], '打开表单真实结果没有明确告知模型尚未执行保存')
    assert.deepEqual(await providerAliases(), before, '打开填写弹框时已经写入了规则')
    const formSaved = await request('POST', '/api/v1/admin/provider-aliases', { ...form.values, alias: '用户填写后保存', enabled: true })
    assert.equal(formSaved.status, 200, '用户填写后的页面现有管理接口保存失败')
    const formRow = (await providerAliases()).find(row => row.provider === formProvider)
    assert(formRow, '页面保存后的规则没有真实入库')
    assert.deepEqual(await sqlProvider(formRow.alias_id), { provider: formProvider, model: null, alias: '用户填写后保存' }, '页面保存后的 SQL 与表单不符')

    phase = '编辑弹框精确目标与实际值'
    const updateEvents = await chat('帮我打开刚才规则的编辑弹框，预填新的统一名称，让我填写后保存', [{ name: 'portal_manage_query', args: { resource: 'provider-aliases', search: formProvider } }, { name: 'portal_open_form', args: { resource: 'provider-aliases', operation: 'update', target_id: formRow.alias_id, values: { alias: '编辑弹框的预填名称' } } }])
    const updateEvent = updateEvents.find(event => event.type === 'open_form')
    assert(updateEvent?.type === 'open_form', '编辑表单没有真实 SSE 表单事件')
    assert.equal(updateEvent.form.target_id, formRow.alias_id, '编辑弹框目标 ID 不精确')
    assert.deepEqual(updateEvent.form.values, { scope: 'global', provider: formProvider, model: null, alias: '编辑弹框的预填名称' }, '编辑弹框未合并目标真实值与指定预填值')
    assert.equal((await sqlProvider(formRow.alias_id))?.alias, '用户填写后保存', '打开编辑弹框已经修改了数据库')
    assert.equal((await request('POST', '/api/v1/admin/provider-aliases', { ...updateEvent.form.values, alias: '用户编辑后保存', enabled: formRow.enabled })).status, 200, '编辑弹框的页面保存失败')
    assert.equal((await sqlProvider(formRow.alias_id))?.alias, '用户编辑后保存', '编辑弹框保存没有真实入库')

    phase = '普通成员填写表单权限拒绝'
    const forbiddenForm = await chat('帮我打开供应商规则新建弹框', [{ name: 'portal_open_form', args: { resource: 'provider-aliases', operation: 'create' } }], otherToken, null, true)
    assert(forbiddenForm.some(event => event.type === 'tool' && event.tool === 'portal_open_form' && event.state === 'failed' && event.status === 403), '普通成员可以打开管理填写弹框')
    assert(!forbiddenForm.some(event => event.type === 'open_form'), '越权请求仍向浏览器发出了表单事件')
    assert.equal((await providerAliases()).length, before.length + 1, '填写表单验收产生了额外规则')
  } finally { sessionId = managementSessionId }
  step(`新空会话 → portal_open_form 真 SSE → 新建/编辑打开不写库 → 页面现有 API 点击保存 → ${backendLabel} 入库；普通成员 403`)

  phase = '删除确认与重放'
  const deletion = async () => {
    const events = await chat('删除刚才新建的项目规则，请准备待用户确认的删除卡片。', [{ name: 'portal_manage_mutate', args: { resource: 'project-aliases', operation: 'delete', target_id: created.alias_id } }])
    const action = events.find(event => event.type === 'action')
    assert(action?.type === 'action' && action.action.status === 'pending', '删除未生成待确认卡片')
    assert((await aliases()).some(row => row.alias_id === created.alias_id), '用户确认前规则已被删除')
    return action.action
  }
  const decide = (action: AssistantPendingAction, decision: 'confirm' | 'cancel', secret = token, extra: Record<string, unknown> = {}) => request('POST', `/api/v1/assistant/actions/${action.action_id}/confirm`, { session_id: sessionId, decision, ...extra }, secret)
  const cancelled = await deletion()
  assert.equal((await decide(cancelled, 'confirm', otherToken)).status, 404, '跨用户确认删除成功')
  assert.equal((await decide(cancelled, 'confirm', token, { target_id: randomUUID() })).status, 400, '确认请求可替换目标')
  assert.equal((await decide(cancelled, 'cancel')).status, 200)
  assert.equal((await decide(cancelled, 'confirm')).status, 409, '已取消操作可被重放')
  assert((await aliases()).some(row => row.alias_id === created.alias_id), '取消操作却删除了规则')
  const changed = await deletion()
  assert.equal((await request('POST', '/api/v1/admin/project-aliases', { scope: 'global', prefix, alias: '隔离能力项目再次修改', enabled: true })).status, 200, '夹具并发修改目标失败')
  const stale = await decide(changed, 'confirm')
  assert.equal(stale.status, 409, '目标快照变化后确认未拒绝')
  assert.equal((await stale.json() as { action: AssistantPendingAction }).action.status, 'failed', '变化目标的旧确认卡没有终结')
  assert.equal((await sqlAlias())?.alias, '隔离能力项目再次修改', '拒绝旧快照确认时数据库仍发生变化')
  assert.equal((await decide(changed, 'confirm')).status, 409, '失败动作可以被重放')
  const confirmed = await deletion()
  assert.equal((await decide(confirmed, 'confirm')).status, 200, '独立确认 HTTP 失败')
  assert(!(await aliases()).some(row => row.alias_id === created.alias_id), '确认后数据库规则仍存在')
  assert.equal(await sqlAlias(), null, '确认后真实 SQL 仍有规则')
  assert.equal((await decide(confirmed, 'confirm')).status, 409, '已确认操作可被重放')
  step('删除仅准备卡片 → 跨owner/替换目标拒绝 → 取消/对象快照变化/重放拒绝 → 独立确认才删库')

  phase = '管理权限复验'
  const forbiddenPrefix = prefix + '-forbidden'
  const forbidden = await chat('新建项目归一化规则。', [{ name: 'portal_manage_save', args: { resource: 'project-aliases', operation: 'create', values: { scope: 'global', prefix: forbiddenPrefix, alias: '越权项目', enabled: true } } }], otherToken, null, true)
  assert(forbidden.some(event => event.type === 'tool' && event.state === 'failed' && event.status === 403), '普通成员管理权限未拒绝')
  assert(!(await aliases()).some(row => row.prefix === forbiddenPrefix), '越权操作写入了数据库')
  assert.equal((await request('GET', `/api/v1/assistant/sessions/${sessionId}`, undefined, otherToken)).status, 404, '跨owner可读取私有历史')
  step('工具执行时权限复验与私有空间隔离')

  phase = '导航与历史恢复'
  const navigation = await chat('打开调用明细页，筛选最近七天的第一个验收模型。', [{ name: 'portal_navigate', args: { path: '/records', filters: { period: 'last7d', model: '能力验收模型1', source: 'dsh' }, search: '能力验收模型1' } }])
  const navigated = navigation.find(event => event.type === 'navigate')
  assert(navigated?.type === 'navigate')
  assert.equal(navigated.path, '/records'); assert.deepEqual(navigated.filters, { period: 'last7d', model: '能力验收模型1', source: 'dsh' }); assert.equal(navigated.search, '能力验收模型1')
  const detailResponse = await request('GET', `/api/v1/assistant/sessions/${sessionId}`)
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json() as AssistantDetail
  const savedFiles = detail.messages.flatMap(message => message.artifacts ?? [])
  const savedActions = detail.messages.flatMap(message => message.actions ?? [])
  assert.deepEqual([...new Set(savedFiles.map(artifact => artifact.format))].sort(), ['docx', 'html', 'xlsx'])
  assert(savedFiles.some(artifact => artifact.artifact_id === html.artifact_id && artifact.share?.url === renewed.url), '历史未更新最新分享')
  assert(savedActions.some(action => action.action_id === cancelled.action_id && action.status === 'cancelled'), '历史未更新取消状态')
  assert(savedActions.some(action => action.action_id === confirmed.action_id && action.status === 'confirmed'), '历史未更新确认状态')
  assert(savedActions.some(action => action.action_id === changed.action_id && action.status === 'failed'), '历史未更新对象变更拒绝状态')
  assert.equal((await request('DELETE', `/api/v1/assistant/sessions/${sessionId}`)).status, 200)
  assert.equal((await request('GET', renewed.url, undefined, null)).status, 410, '删除会话后公开分享仍有效')
  assert.equal((await request('GET', html.download_path)).status, 404, '删除会话后附件仍可下载')
  step('导航筛选/search → 文件/确认历史恢复 → 会话删除让私有文件与分享失效')
  console.log(`ASSISTANT_CAPABILITIES_OK: 回环模型 → DSH 公开工具 → 真 HTTP SSE → 真 ${backendLabel}；全部验收通过，未访问线上或外部互联网`)
} catch (error) {
  // ★ SDK 失败可能携带模型请求及凭证，只输出自有断言信息，不打印堆栈或请求内容。
  console.error(error instanceof assert.AssertionError ? error.message : `ASSISTANT_CAPABILITIES_FAILED: ${phase} (${error instanceof Error ? error.name : 'Unknown'})；未输出请求头和凭证`)
  process.exitCode = 1
} finally {
  await server?.stop()
  await isolation?.dispose()
  model.closeAllConnections()
  if (model.listening) await new Promise<void>(done => model.close(() => done()))
  if (previousKey === undefined) delete process.env[apiKeyEnv]
  else process.env[apiKeyEnv] = previousKey
  const target = resolve(root)
  if (!target.startsWith(temporaryRoot + sep) || !target.slice(temporaryRoot.length + 1).startsWith('atr-ai-capability-')) throw new Error('临时清理目录超出验收边界')
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
