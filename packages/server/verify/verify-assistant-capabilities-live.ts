/**
 * 根目录 .env 的真实模型自然中文能力验收：八轮对话，真实 DSH / HTTP / 隔离 SQLite。
 * ★ 显式空 mysqlUrl 屏蔽线上环境配置；只打印检查项，不打印凭证、模型响应或业务数据。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import { resolvePeriod } from '@ai-token-report/core'
import type { AssistantArtifact, AssistantDetail, AssistantEvent, AssistantPendingAction } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { IdentityError } from '../src/identity/types.js'
import { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { assistantConfigFromEnv, type DshAssistantConfig } from '../src/assistant/config.js'
import { createServer } from '../src/index.js'
import { renderAssistantMarkdown } from '../../web-portal/src/utils/assistantMarkdown.js'

const keyName = process.env.ATR_ASSISTANT_API_KEY_ENV || (!process.env.ATR_ASSISTANT_PROTOCOL || process.env.ATR_ASSISTANT_PROTOCOL === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
const missing = ['ATR_ASSISTANT_MODEL', keyName].filter(name => !process.env[name]?.trim())
if (missing.length) {
  console.log('CAPABILITY_LIVE_PENDING: 请填写根目录 .env 的 ' + missing.join('、') + '；没有发送模型请求。')
  process.exit(process.argv.includes('--check') ? 0 : 2)
}
let config: DshAssistantConfig
try { config = assistantConfigFromEnv(process.env, false)! }
catch { console.error('CAPABILITY_LIVE_CONFIG_INVALID: 模型服务配置无效；未发送请求，未输出配置值。'); process.exit(2) }
if (process.argv.includes('--check')) {
  console.log('CAPABILITY_LIVE_CONFIG_READY: 配置齐全；只读检查完成，没有发送模型请求。')
  process.exit(0)
}

interface Check { id: string; name: string; status: 'passed' | 'failed'; duration_ms: number }
interface Alias { alias_id: string; prefix: string; alias: string; scope: string; enabled: boolean }
const checks: Check[] = []
const temporaryRoot = resolve(process.cwd(), '.tmp')
const reportDirectory = resolve(process.cwd(), '.artifacts', 'assistant-capabilities-live')
mkdirSync(temporaryRoot, { recursive: true })
// ⚠️ Windows 系统 Temp 较长；短目录避免身份哈希、会话 UUID 与附件路径触及原生长度限制。
const root = mkdtempSync(join(temporaryRoot, 'ai-live-'))
const dbPath = join(root, 'portal.sqlite'), token = randomBytes(32).toString('hex')
let server: Awaited<ReturnType<typeof createServer>> | undefined
let sessionId: string | undefined
let turnCount = 0
let activeCheck = '初始化'
let activeCheckId = 'setup'
let activeStarted = Date.now()
let passed = false
const safeCreateReasons = new Set([
  '文件参数需要是对象', '不支持的文件参数', '文件格式支持 docx、xlsx、html、md、csv、txt',
  '文件标题需要为 1～120 个字符且不含控制字符', '文件正文需要是文本', '文件正文超过 200 KB 上限',
  'dataset_id 需要来自统计查询结果', '数据集导出不能混入模型正文，请单独生成说明文件',
  '需要提供正文或已查询的数据集', 'Excel 单元格超过 32767 字符，请缩小数据内容',
  '文件超过 3 MB 上限，请缩小查询范围',
])
const createFailureReasons = new Set<string>()
const originalCreate = AssistantArtifacts.prototype.create
// ★ 仅在隔离验收进程观察固定校验文案；原方法照常执行，不修改参数、结果或错误。
AssistantArtifacts.prototype.create = async function (this: AssistantArtifacts, ...args: Parameters<typeof originalCreate>) {
  try { return await originalCreate.apply(this, args) }
  catch (error) {
    if (error instanceof IdentityError && safeCreateReasons.has(error.message)) createFailureReasons.add(error.message)
    throw error
  }
}
async function check(id: string, name: string, work: () => Promise<void>) {
  activeCheckId = id; activeCheck = name; activeStarted = Date.now()
  await work()
  checks.push({ id, name, status: 'passed', duration_ms: Date.now() - activeStarted })
  console.log('CAPABILITY_LIVE_STEP_OK: ' + name)
}
/** 固定 OOXML 产物的 ZIP 结构校验；文件路径来自下载内容，不接受任何解压落盘路径。 */
function unpack(bytes: Buffer): Record<string, string> {
  assert(bytes.length >= 52, 'Office 下载文件过短')
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'Office 下载不是 ZIP')
  const end = bytes.length - 22
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'Office ZIP 缺少目录终止结构')
  const entries: Record<string, string> = {}; let offset = 0; let count = 0
  while (offset + 30 <= end && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 8, 'Office ZIP 压缩格式错误')
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + nameSize + extraSize
    assert(start + size <= end, 'Office ZIP 文件边界错误')
    const data = inflateRawSync(bytes.subarray(start, start + size))
    assert.equal(data.length, bytes.readUInt32LE(offset + 22), 'Office ZIP 解压长度错误')
    entries[bytes.subarray(offset + 30, offset + 30 + nameSize).toString()] = data.toString()
    offset = start + size; count++
  }
  assert.equal(bytes.readUInt32LE(end + 16), offset, 'Office ZIP 目录偏移错误')
  assert.equal(bytes.readUInt16LE(end + 8), count, 'Office ZIP 文件数错误')
  return entries
}
try {
  await preparePortalDatabase({ sqlitePath: dbPath })
  const identity = new IdentityRepository({ sqlitePath: dbPath })
  await identity.importCredentials([{ name: '自然能力隔离管理员', token, role: 'admin' }], 'assistant-capabilities-live-fixture')
  server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, mysqlUrl: '', enableLocalApi: false, portalOrigin: '', assistant: config, requestLog: false })
  const url = server.url, origin = new URL(url).origin
  const request = (method: string, path: string, body?: unknown, anonymous = false) => {
    const target = new URL(path, url)
    assert.equal(target.origin, origin, '验收请求不允许离开隔离本地服务')
    return fetch(target, { method, headers: { ...(!anonymous ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(method === 'POST' && target.pathname.endsWith('/chat') ? 130_000 : 35_000) })
  }
  const chat = async (prompt: string): Promise<AssistantEvent[]> => {
    createFailureReasons.clear()
    assert(++turnCount <= 8, '真实模型验收超过八轮上限')
    const response = await request('POST', '/api/v1/assistant/chat', { prompt, ...(sessionId ? { session_id: sessionId } : {}), page: '/overview' })
    assert.equal(response.status, 200, '助手对话 HTTP 失败')
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
    assert(!events.some(event => event.type === 'error'), '对话出现 error 事件')
    assert(events.some(event => event.type === 'done'), '对话缺少 done 事件')
    const activity = events.filter(event => event.type === 'tool')
    const failure = activity.find(event => event.state === 'failed')
    assert(!failure, '对话中存在失败工具调用：' + (failure && /^[a-z_]+$/.test(failure.tool) ? failure.tool : 'unknown') + '，HTTP状态 ' + (failure?.status ?? 'unknown') + (failure?.tool === 'create_file' && createFailureReasons.size ? '，校验原因：' + [...createFailureReasons].join('；') : ''))
    for (const started of activity.filter(event => event.state === 'running')) assert(activity.some(ended => ended.call_id === started.call_id && ended.state === 'completed'), '工具调用缺少对应完成进度')
    const session = events.find(event => event.type === 'session')
    assert(session?.type === 'session', '对话未返回私有会话')
    if (sessionId) assert.equal(session.session.session_id, sessionId, '续聊没有沿用同一会话')
    sessionId = session.session.session_id
    return events
  }
  const aliases = async (): Promise<Alias[]> => {
    const response = await request('GET', '/api/v1/admin/project-aliases')
    assert.equal(response.status, 200, '管理接口查询项目规则失败')
    return (await response.json() as { aliases: Alias[] }).aliases
  }
  const sqlAlias = (id: string) => identity.read(tx => tx.get<Alias>('SELECT alias_id,prefix,alias,scope,enabled FROM project_alias WHERE alias_id = $id', { $id: id }))
  const prefix = 'live-ai-' + randomUUID().slice(0, 8), firstName = '自然验收临时项目', changedName = '自然验收已更新项目'
  let datasetId: string | undefined, ruleId: string | undefined, pending: AssistantPendingAction | undefined
  let artifacts: AssistantArtifact[] = []
  const fixtureModels = ['自然验收模型甲', '自然验收模型乙']
  const now = Date.now()
  const ingest = await request('POST', '/api/v1/token-usage', { schemaVersion: 1, client: {}, generatedAt: new Date(now).toISOString(), records: [125, 300].map((input_tokens, index) => ({ event_id: 'natural-capability:' + index, session_id: 'natural-capability-session', seq: index, ts: now, provider: 'test-fixture', model: fixtureModels[index], source: 'dsh', input_tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 })) })
  assert.equal(ingest.status, 200, '隔离合成用量入库失败')
  const truthResponse = await request('GET', '/api/v1/stats/breakdown?period=last7d&by=model&identity_view=member')
  assert.equal(truthResponse.status, 200, '真实统计接口读取失败')
  const truth = await truthResponse.json() as { rows: Array<{ key: string; totalTokens: number }> }

  await check('query_dataset', '自然中文模型用量 → 授权数据集与 SQL 一致', async () => {
    const events = await chat('帮我看看最近七天各模型的用量，给我一张表。')
    const table = events.filter(event => event.type === 'result').map(event => event.result).find(result => result.display === 'table')
    assert(table?.dataset_id && table.table, '自然请求没有产生真实表格数据集')
    const query = new URLSearchParams(table.query)
    if (query.has('period')) assert.equal(query.get('period'), 'last7d', '模型选择了错误时间范围')
    else {
      // ★ query_usage 固定本次时间窗后传 from/to；验收实际边界，不能把无 period 当错窗。
      const from = Number(query.get('from')), to = Number(query.get('to'))
      assert(Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= now && to <= Date.now(), '数据集的绝对时间范围无效')
      assert.equal(from, resolvePeriod('last7d', new Date(to))!.sinceMs, '模型选择了错误时间范围')
    }
    assert.deepEqual(table.table.rows.map(row => [row.dimension, row.total_tokens]).sort(), truth.rows.map(row => [row.key, row.totalTokens]).sort(), '自然请求结果与真实 SQL 不一致')
    datasetId = table.dataset_id
  })

  await check('export_share', '自然中文导出 Word/Excel/HTML 并分享 24 小时', async () => {
    const events = await chat('把刚才这份模型用量整理成 Word、Excel 和 HTML 三个可下载文件，表格要保留同一份真实数据；再把 HTML 分享给我，有效期24小时。')
    assert(!events.some(event => event.type === 'tool' && (event.tool === 'query_usage' || event.tool.startsWith('stats_'))), '导出没有复用已有数据集，而是重新取数')
    const received = events.filter(event => event.type === 'artifact').map(event => event.artifact)
    artifacts = [...new Map(received.map(artifact => [artifact.artifact_id, artifact])).values()]
    assert.equal(artifacts.length, 3, '自然请求没有生成恰好三个文件')
    assert.deepEqual([...new Set(artifacts.map(artifact => artifact.format))].sort(), ['docx', 'html', 'xlsx'], '没有按自然请求生成三种文件')
    for (const artifact of artifacts) {
      assert.equal(artifact.session_id, sessionId, '文件不属于当前会话')
      assert(/^[0-9a-f-]{36}$/.test(artifact.artifact_id) && artifact.size_bytes > 0 && artifact.created_at_ms >= now && artifact.file_name.endsWith('.' + artifact.format), '文件元数据无效')
      assert.equal(artifact.download_path, `/api/v1/assistant/artifacts/${artifact.artifact_id}/download`, '下载路径无效')
      const response = await request('GET', artifact.download_path)
      assert.equal(response.status, 200, '真实 HTTP 文件下载失败')
      assert(response.headers.get('content-disposition')?.startsWith('attachment;'), '下载未声明附件')
      assert(response.headers.get('cache-control')?.includes('no-store'), '下载响应可以被缓存')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.length, artifact.size_bytes, '文件大小与元数据不同')
      if (artifact.format === 'html') {
        const content = bytes.toString()
        assert(content.includes('<table>') && fixtureModels.every(model => content.includes(model)) && content.includes('125') && content.includes('300'), 'HTML 未导出真实用量表格')
        assert(response.headers.get('content-security-policy')?.includes("sandbox; default-src 'none'"), 'HTML 缺少静态安全策略')
      } else {
        const entries = unpack(bytes), document = artifact.format === 'docx' ? entries['word/document.xml'] : entries['xl/worksheets/sheet1.xml']
        assert(document && entries['[Content_Types].xml'] && fixtureModels.every(model => document.includes(model)) && document.includes('125') && document.includes('300'), 'Office 文件没有真实模型及数值')
        if (artifact.format === 'xlsx') assert(!document.includes('<f>'), 'Excel 包含公式')
      }
    }
    const html = artifacts.find(artifact => artifact.format === 'html')!
    assert(html.share, '自然分享请求没有生成 HTML 链接')
    const remaining = html.share.expires_at_ms - Date.now()
    assert(remaining > 23.9 * 3_600_000 && remaining <= 24 * 3_600_000, '分享有效期没有设置为24小时')
    const publicResponse = await request('GET', html.share.url, undefined, true)
    assert.equal(publicResponse.status, 200, 'HTML 分享不能匿名读取')
    assert((await publicResponse.text()).includes('自然验收模型甲'), '分享内容与导出文件不一致')
    const stored = await request('GET', '/api/v1/assistant/sessions/' + sessionId)
    assert.equal(stored.status, 200, '导出历史无法读取')
    const detail = await stored.json() as AssistantDetail
    // ★ 用结果记录核对复用关系；模型生成的文本不能替代授权快照中的表格。
    assert(detail.messages.flatMap(message => message.results ?? []).some(result => result.dataset_id === datasetId), '导出所依据的数据集未持久化')
  })

  await check('create_rule', '自然中文新建随机项目规则 → 管理接口与 SQL 对照', async () => {
    await chat(`新建一个全局项目归一化规则：仓库名“${prefix}”归一化为“${firstName}”，启用这条规则。`)
    const found = (await aliases()).filter(row => row.prefix === prefix)
    assert.equal(found.length, 1, '自然新建未得到唯一真实项目规则')
    assert.equal(found[0]!.alias, firstName, '新建规则的归一化名称错误')
    assert.equal(found[0]!.scope, 'global', '新建规则的作用域错误')
    ruleId = found[0]!.alias_id
    assert.equal((await sqlAlias(ruleId))?.alias, firstName, '新建规则未写入隔离 SQLite')
  })

  await check('update_navigate', '自然中文精确编辑规则并打开对应搜索页', async () => {
    const events = await chat(`修改项目归一化规则“${prefix}”的归一化名称为“${changedName}”，先查询精确ID；修改完成后打开项目归一化页面，并搜索仓库名“${prefix}”。`)
    assert(events.some(event => event.type === 'tool' && event.tool === 'portal_manage_query'), '编辑前没有查询精确目标')
    assert.equal((await aliases()).find(row => row.alias_id === ruleId)?.alias, changedName, '管理接口未反映自然编辑')
    assert.equal((await sqlAlias(ruleId!))?.alias, changedName, '自然编辑未真实修改 SQLite')
    assert(events.some(event => event.type === 'navigate' && event.path === '/projects' && event.search === prefix), '导航没有同步项目搜索条件')
  })

  await check('explain_no_write', '询问如何删除仅解释，不启用写入', async () => {
    const events = await chat('如何删除项目归一化规则？只介绍操作方式。')
    assert(!events.some(event => event.type === 'action'), '解释请求产生了待确认动作')
    assert(!events.some(event => event.type === 'tool' && event.tool === 'portal_manage_mutate'), '解释请求调用了修改工具')
    assert.equal((await sqlAlias(ruleId!))?.alias, changedName, '解释请求改变了项目规则')
  })

  await check('delete_confirm', '自然删除仅生成卡片，独立确认 API 才真正删库', async () => {
    const events = await chat(`删除全局项目规则“${prefix}”，先查询精确ID，展示待确认卡让我核对。`)
    const action = events.find(event => event.type === 'action')
    assert(action?.type === 'action', '自然删除未产生确认卡')
    pending = action.action
    assert.equal(pending.status, 'pending', '删除动作不处于待确认状态')
    assert.equal(pending.resource, 'project-aliases', '删除动作资源错误')
    assert.equal(pending.operation, 'delete', '删除动作类型错误')
    assert(pending.target_label.includes(prefix), '确认卡不能核对目标')
    assert((await aliases()).some(row => row.alias_id === ruleId) && await sqlAlias(ruleId!), '用户确认前对象已被删除')
    const confirmed = await request('POST', `/api/v1/assistant/actions/${pending.action_id}/confirm`, { session_id: sessionId, decision: 'confirm' })
    assert.equal(confirmed.status, 200, '独立确认 API 失败')
    assert.equal((await confirmed.json() as { action: AssistantPendingAction }).action.status, 'confirmed', '确认后的状态错误')
    assert(!(await aliases()).some(row => row.alias_id === ruleId), '独立确认后管理接口仍有目标')
    assert.equal(await sqlAlias(ruleId!), null, '独立确认后 SQLite 仍有目标')
    assert.equal((await request('POST', `/api/v1/assistant/actions/${pending.action_id}/confirm`, { session_id: sessionId, decision: 'confirm' })).status, 409, '确认动作可以重复执行')
  })

  await check('navigate_filters', '自然导航同步时间、模型和来源筛选', async () => {
    const events = await chat('打开调用明细页面，筛选最近七天、自然验收模型甲和 DSH 来源。')
    const navigation = events.find(event => event.type === 'navigate' && event.path === '/records')
    assert(navigation?.type === 'navigate', '自然导航没有打开调用明细')
    assert.equal(navigation.filters?.period, 'last7d', '导航时间条件错误')
    assert.equal(navigation.filters?.model, fixtureModels[0], '导航模型条件错误')
    assert.equal(navigation.filters?.source, 'dsh', '导航来源条件错误')
  })

  await check('public_web', '自然请求读取公开网页并提供来源链接', async () => {
    const events = await chat('读取 https://example.com 的公开网页，告诉我页面用途，并给出原网页的来源链接。')
    assert(events.some(event => event.type === 'tool' && event.tool === 'web_read' && event.state === 'completed'), '自然联网请求没有成功读取网页')
    const text = events.filter(event => event.type === 'text').map(event => event.text).join('')
    // ★ 按用户实际看到的前端渲染结果核对来源；验收允许所有受保护的可点击语法。
    const html = renderAssistantMarkdown(text)
    const links = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(match => {
      try { return new URL(match[1]!).href } catch { return '' }
    })
    assert(links.includes('https://example.com/'), '联网回答没有提供可点击的原网页来源；原URL出现=' + /https:\/\/example\.com\/?/.test(text) + '，渲染来源链接=' + links.includes('https://example.com/'))
  })

  await check('restore_cleanup', '文件与确认历史恢复，删除会话让链接失效', async () => {
    const restored = await request('GET', '/api/v1/assistant/sessions/' + sessionId)
    assert.equal(restored.status, 200, '私有历史恢复失败')
    const detail = await restored.json() as AssistantDetail
    assert(detail.messages.flatMap(message => message.actions ?? []).some(action => action.action_id === pending?.action_id && action.status === 'confirmed'), '历史未恢复确认后的状态')
    assert.deepEqual([...new Set(detail.messages.flatMap(message => message.artifacts ?? []).map(artifact => artifact.format))].sort(), ['docx', 'html', 'xlsx'], '历史缺少导出文件')
    assert.equal((await request('DELETE', '/api/v1/assistant/sessions/' + sessionId)).status, 200, '隔离会话删除失败')
    const html = artifacts.find(artifact => artifact.format === 'html')!
    assert.equal((await request('GET', html.download_path)).status, 404, '会话删除后私有附件仍可下载')
    assert.equal((await request('GET', html.share!.url, undefined, true)).status, 410, '会话删除后公开分享仍可读取')
  })
  passed = true
  console.log('ASSISTANT_CAPABILITIES_LIVE_OK: 真实模型八轮自然中文验收全部通过；报告仅保存检查项。')
} catch (error) {
  checks.push({ id: activeCheckId, name: activeCheck, status: 'failed', duration_ms: Date.now() - activeStarted })
  // ★ SDK 异常可能带请求体和凭证，只输出阶段及自有断言，永远不打印堆栈或模型响应。
  console.error('ASSISTANT_CAPABILITIES_LIVE_FAILED: ' + activeCheck + (error instanceof assert.AssertionError ? '；' + error.message : '；模型或服务调用失败，请检查配置与网络'))
  process.exitCode = 1
} finally {
  AssistantArtifacts.prototype.create = originalCreate
  await server?.stop()
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ ok: passed, turns: turnCount, checks }, null, 2) + '\n')
  const target = resolve(root)
  if (!target.startsWith(temporaryRoot + sep) || !target.slice(temporaryRoot.length + 1).startsWith('ai-live-')) throw new Error('清理目录超出隔离验收边界')
  for (let attempt = 0; ; attempt++) {
    try { await rm(target, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 20 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}
