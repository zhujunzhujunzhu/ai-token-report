/** 拼接到可信远端登录源码后运行；只创建自己的验收会话/附件，结束时撤销分享并删除会话。 */
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

const capabilityStarted = performance.now(), capabilityRunAt = Date.now()
const capabilityMarker = '发布验收-' + randomUUID().replaceAll('-', '').slice(0, 12)
const capabilityHeaders = { ...jsonHeaders, cookie: 'atr_portal_session=' + session }
const capabilitySessions = new Set(), capabilityShares = new Set(), capabilityChecks = []
let capabilityStage = 'login-status', capabilityFailed = false, capabilityCleanupFailed = false
let capabilityDiagnostic = {}
const capabilitySafeIds = new Set([
  'login-status', 'assistant-enabled', 'docx-generation', 'xlsx-generation', 'html-generation', 'docx-download', 'xlsx-download', 'html-download',
  'chat-http-sse', 'chat-no-done', 'chat-engine-error', 'chat-tools-incomplete', 'chat-missing-session',
  'unexpected-management-action', 'unexpected-business-tool', 'artifact-missing', 'artifact-unexpected-share', 'artifact-title-marker',
  'share-link-origin', 'office-zip', 'office-zip-crc', 'office-directory', 'office-package', 'office-content', 'excel-formula-note',
  'excel-authorized-snapshot', 'excel-snapshot-missing', 'excel-snapshot-empty', 'excel-own-snapshot', 'excel-recent-seven-days', 'excel-single-authorized-query',
  'download-origin', 'download-security', 'download-size', 'html-security', 'html-share-24h', 'share-expiry-24h', 'share-anonymous',
  'html-share-24h-anonymous', 'html-share-revoke', 'html-share-revoke-410', 'public-web-read-source', 'public-web-citation',
  'records-navigation', 'records-navigation-filters', 'private-artifact-history', 'cleanup-own-sessions-files', 'transport-or-parser-failure', 'unclassified-check',
])
const capabilitySafeTools = new Set([
  'query_usage', 'create_file', 'share_html', 'web_read', 'web_search', 'portal_navigate', 'portal_manage_query', 'portal_manage_mutate',
  'list_datasets', 'render_table', 'render_cards', 'render_echarts', 'stats_overview', 'stats_breakdown', 'stats_series', 'stats_records',
  'stats_members', 'stats_groups', 'stats_providers', 'stats_sources', 'stats_projects', 'stats_pricing', 'stats_diagnostics',
])
class CapabilityCheckError extends Error {
  constructor(id) { super('验收固定检查失败'); this.checkId = capabilitySafeIds.has(id) ? id : 'unclassified-check' }
}
const assertCapability = (value, id) => { if (!value) throw new CapabilityCheckError(id) }
function capabilityRecord(id, status, started, diagnostic) {
  id = capabilitySafeIds.has(id) ? id : 'unclassified-check'
  const value = { id, status, elapsed_ms: started === undefined ? 0 : Math.round(performance.now() - started) }
  if (diagnostic) value.diagnostic = diagnostic
  capabilityChecks.push(value)
  console.log('ASSISTANT_CAPABILITIES_ONLINE_STEP ' + JSON.stringify(value))
}
async function capabilityRequest(method, path, body, timeoutMs = 35000) {
  // ★ 私有接口始终使用固定站内前缀，模型不能选择带认证 Cookie 的请求目的地。
  const target = new URL(baseUrl + path)
  return await fetch(target, { method, headers: capabilityHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
}
async function capabilityJson(path) {
  const response = await capabilityRequest('GET', path)
  assertCapability(response.ok, capabilityStage)
  return await response.json()
}
function capabilityShareUrl(share) {
  const target = new URL(share.url, baseUrl + '/')
  const base = new URL(baseUrl)
  const prefix = base.pathname.replace(/\/$/, '') + '/api/v1/assistant/shared/'
  assertCapability(target.origin === base.origin && target.pathname.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(target.pathname.slice(prefix.length)) && !target.search && !target.hash && !target.username && !target.password, 'share-link-origin')
  return target
}
async function capabilityPublic(share) {
  const target = capabilityShareUrl(share)
  // ★ 匿名读取绝不携带 Cookie；能力 URL 仅保留在远端内存，不写入日志或本地报告。
  return await fetch(target, { headers: { Accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(35000) })
}
function capabilitySourceHref(text) {
  // ★ Markdown、尖括号自动链接和裸 URL 都按实际 href 判断，凭证 URL 不算可信来源。
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\[\]"']+/gi)) {
    try {
      const target = new URL(match[0].replace(/[.,;:!，。；：！]+$/g, ''))
      if (target.protocol === 'https:' && ['example.com', 'www.example.com'].includes(target.hostname) && !target.username && !target.password && (!target.port || target.port === '443')) return target.href
    } catch { /* 无效来源地址不进入日志。 */ }
  }
  return null
}
async function capabilityChat(prompt, ownSession) {
  const started = performance.now(), events = []
  capabilityDiagnostic = {}
  const response = await capabilityRequest('POST', '/api/v1/assistant/chat', { prompt, page: '/records', ...(ownSession ? { session_id: ownSession } : {}) }, 130000)
  capabilityDiagnostic.http_status = response.status
  assertCapability(response.ok && response.headers.get('content-type')?.includes('text/event-stream'), 'chat-http-sse')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const part = await reader.read(); if (part.done) break
    buffer += decoder.decode(part.value, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      for (const line of frame.split('\n').filter(value => value.startsWith('data: '))) {
        const event = JSON.parse(line.slice(6)); events.push(event)
        if (event.type === 'session') capabilitySessions.add(event.session.session_id)
        if (event.type === 'artifact' && event.artifact.share) capabilityShares.add(event.artifact.artifact_id)
      }
    }
  }
  // ★ 仅输出固定工具名、状态和数量；query、参数、会话/附件ID、错误正文与模型文字不进日志。
  capabilityDiagnostic = {
    http_status: response.status,
    done: events.some(event => event.type === 'done'), error: events.some(event => event.type === 'error'),
    artifacts: events.filter(event => event.type === 'artifact').map(event => ['docx', 'xlsx', 'html', 'md', 'csv', 'txt'].includes(event.artifact.format) ? event.artifact.format : 'unrecognized-format'),
    results: events.filter(event => event.type === 'result').length,
    tools: events.filter(event => event.type === 'tool').slice(0, 40).map(event => ({
      tool: capabilitySafeTools.has(event.tool) ? event.tool : 'unrecognized-tool',
      state: ['running', 'completed', 'failed'].includes(event.state) ? event.state : 'legacy',
      status: Number.isInteger(event.status) && event.status >= 0 && event.status <= 599 ? event.status : null,
    })),
  }
  assertCapability(capabilityDiagnostic.done, 'chat-no-done')
  assertCapability(!capabilityDiagnostic.error, 'chat-engine-error')
  assertCapability(!events.some(event => event.type === 'action'), 'unexpected-management-action')
  // ★ 只有 Excel 步骤读取本人授权快照；各步骤都不能触发管理操作或额外业务探索。
  const usageStarts = events.filter(event => event.type === 'tool' && event.tool === 'query_usage' && event.state === 'running')
  const internalOverview = events.filter(event => event.type === 'tool' && event.tool === 'stats_overview' && event.state === undefined && event.call_id === undefined && event.status === 200)
  const isExpectedOverview = event => capabilityStage === 'xlsx-generation' && usageStarts.length === 1 && internalOverview.length === 1 && internalOverview[0] === event
  // ★ query_usage 内部的单个 overview 观测没有 state/call_id；它不是模型另一次 stats 工具调用。
  assertCapability(!events.some(event => event.type === 'tool' && (event.tool.startsWith('portal_manage_') || (event.tool.startsWith('stats_') && !isExpectedOverview(event)) || (event.tool === 'query_usage' && capabilityStage !== 'xlsx-generation'))), 'unexpected-business-tool')
  const startedTools = events.filter(event => event.type === 'tool' && event.state === 'running')
  assertCapability(startedTools.every(event => events.some(ended => ended.type === 'tool' && ended.call_id === event.call_id && ended.state === 'completed')), 'chat-tools-incomplete')
  assertCapability(events.some(event => event.type === 'session'), 'chat-missing-session')
  return { events, started, sessionId: events.find(event => event.type === 'session')?.session.session_id }
}
const capabilityCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function capabilityOffice(bytes, format, expectedTable) {
  assertCapability(bytes.length > 100 && bytes.readUInt32LE(0) === 0x04034b50 && bytes.readUInt32LE(bytes.length - 22) === 0x06054b50, 'office-zip')
  const entries = new Map(); let offset = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28)
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString()
    const start = offset + 30 + nameSize + extraSize
    assertCapability(bytes.readUInt16LE(offset + 8) === 8 && start + size <= bytes.length, 'office-zip')
    const content = inflateRawSync(bytes.subarray(start, start + size))
    assertCapability(content.length === bytes.readUInt32LE(offset + 22), 'office-zip')
    let crc = 0xffffffff
    for (const value of content) crc = capabilityCrcTable[(crc ^ value) & 255] ^ (crc >>> 8)
    assertCapability(((crc ^ 0xffffffff) >>> 0) === bytes.readUInt32LE(offset + 14), 'office-zip-crc')
    entries.set(name, content.toString()); offset = start + size
  }
  assertCapability(bytes.readUInt32LE(offset) === 0x02014b50 && bytes.readUInt32LE(bytes.length - 6) === offset, 'office-directory')
  assertCapability(entries.has('[Content_Types].xml') && entries.has('_rels/.rels'), 'office-package')
  const document = entries.get(format === 'docx' ? 'word/document.xml' : 'xl/worksheets/sheet1.xml')
  assertCapability(typeof document === 'string', 'office-content')
  if (format === 'docx') assertCapability(document.includes(capabilityMarker), 'office-content')
  if (format === 'xlsx') {
    assertCapability(entries.has('xl/workbook.xml') && entries.has('xl/worksheets/sheet2.xml') && !document.includes('<f>'), 'excel-formula-note')
    const text = value => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity])
    const rows = [...document.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b[^>]*\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
      if (!cell[2]) return null
      if (cell[1].includes('inlineStr')) return text(cell[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '')
      return Number(cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1])
    }))
    const expected = [expectedTable.columns.map(column => column.label), ...expectedTable.rows.map(row => expectedTable.columns.map(column => row[column.key] ?? null))]
    assertCapability(JSON.stringify(rows) === JSON.stringify(expected), 'excel-authorized-snapshot')
  }
}
async function capabilityDownload(artifact, expectedTable) {
  const started = performance.now()
  capabilityStage = artifact.format + '-download'
  assertCapability(/^[0-9a-f-]{36}$/.test(artifact.artifact_id) && artifact.download_path === '/api/v1/assistant/artifacts/' + artifact.artifact_id + '/download', 'download-origin')
  const response = await capabilityRequest('GET', artifact.download_path)
  assertCapability(response.ok && response.headers.get('content-disposition')?.startsWith('attachment;') && response.headers.get('cache-control')?.includes('no-store') && response.headers.get('x-content-type-options') === 'nosniff', 'download-security')
  const bytes = Buffer.from(await response.arrayBuffer())
  assertCapability(bytes.length === artifact.size_bytes, 'download-size')
  if (artifact.format === 'docx' || artifact.format === 'xlsx') capabilityOffice(bytes, artifact.format, expectedTable)
  else assertCapability(artifact.format === 'html' && bytes.toString().startsWith('<!doctype html>') && bytes.toString().includes(capabilityMarker) && response.headers.get('content-security-policy')?.includes("sandbox; default-src 'none'"), 'html-security')
  capabilityRecord(artifact.format + '-download', 'PASS', started)
}
async function capabilityCleanup() {
  // ★ 丢失 SSE 首帧时仍能按随机标记补找本次会话；时间与标记同时匹配，绝不清理其他历史。
  try {
    const response = await capabilityRequest('GET', '/api/v1/assistant/sessions')
    if (response.ok) {
      const data = await response.json()
      for (const item of data.sessions ?? []) if (item.created_at_ms >= capabilityRunAt && String(item.title).includes(capabilityMarker)) capabilitySessions.add(item.session_id)
    }
  } catch { capabilityCleanupFailed = true }
  for (const id of capabilityShares) {
    try {
      const response = await capabilityRequest('POST', '/api/v1/assistant/artifacts/' + id + '/revoke', {})
      if (!response.ok && response.status !== 404) capabilityCleanupFailed = true
    } catch { capabilityCleanupFailed = true }
  }
  for (const id of capabilitySessions) {
    let removed = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await capabilityRequest('DELETE', '/api/v1/assistant/sessions/' + id)
        if (response.ok || response.status === 404) { removed = true; break }
        if (response.status !== 409) break
      } catch { break }
      await new Promise(done => setTimeout(done, 1000))
    }
    if (!removed) capabilityCleanupFailed = true
  }
  try { await capabilityRequest('POST', '/api/v1/auth/logout', {}) }
  catch { capabilityCleanupFailed = true }
}
try {
  const started = performance.now()
  const status = await capabilityJson('/api/v1/assistant/status')
  assertCapability(status.enabled, 'assistant-enabled')
  const identity = await capabilityJson('/api/v1/auth/session')
  const permissions = identity.viewer?.permissions ?? []
  capabilityRecord('login-status', 'PASS', started)
  let ownSession
  const generated = []
  for (const [format, description] of [
    ['docx', 'Word 文档，写三段简短文字说明怎样登录、提问和下载附件'],
    ['xlsx', 'Excel 文件'],
    ['html', 'HTML 静态说明报告，包含标题、三项使用步骤和一段说明'],
  ]) {
    capabilityStage = format + '-generation'
    const prompt = format === 'xlsx'
      ? '请生成“' + capabilityMarker + '”的Excel文件。查询我本人最近七天的用量概览，展示为表格，再直接将同一份授权查询数据导出为Excel。保留查询结果原值，不要编造或追加数据，不要查询其他人员，不要分享。文件标题包含“' + capabilityMarker + '”。'
      : '请生成' + capabilityMarker + '的' + description + '。文件标题和正文第一行都包含“' + capabilityMarker + '”。内容只介绍基本使用操作，不涉及人员或业务用量，不需要查询任何统计。现在只生成文件，不要分享。'
    const turn = await capabilityChat(prompt, ownSession)
    ownSession = turn.sessionId
    const artifact = turn.events.filter(event => event.type === 'artifact').map(event => event.artifact).find(item => item.format === format)
    assertCapability(artifact, 'artifact-missing')
    assertCapability(!artifact.share, 'artifact-unexpected-share')
    assertCapability(artifact.title.includes(capabilityMarker), 'artifact-title-marker')
    let expectedTable
    if (format === 'xlsx') {
      const source = turn.events.filter(event => event.type === 'result').map(event => event.result).find(item => item.tool === 'stats_overview' && item.table)
      assertCapability(source, 'excel-snapshot-missing')
      assertCapability(source.table.rows.length > 0, 'excel-snapshot-empty')
      assertCapability(new URLSearchParams(source.query).get('member_id') === identity.viewer.member_id, 'excel-own-snapshot')
      const query = new URLSearchParams(source.query), from = Number(query.get('from')), to = Number(query.get('to'))
      // ★ 平台 last7d 为包含今天的七个自然日；结束时间应接近本次读取，不能用历史任意七天替代。
      assertCapability(Number.isSafeInteger(from) && Number.isSafeInteger(to) && to - from >= 6 * 86400000 && to - from <= 7 * 86400000 && Math.abs(Date.now() - to) < 180000, 'excel-recent-seven-days')
      const modelCalls = turn.events.filter(event => event.type === 'tool' && event.tool === 'query_usage' && event.state === 'running')
      assertCapability(modelCalls.length === 1, 'excel-single-authorized-query')
      expectedTable = source.table
    }
    generated.push(artifact)
    capabilityRecord(capabilityStage, 'PASS', turn.started)
    await capabilityDownload(artifact, expectedTable)
  }
  const html = generated.find(item => item.format === 'html')
  capabilityStage = 'html-share-24h'
  const shareTurn = await capabilityChat('请分享刚才的“' + capabilityMarker + '”HTML说明报告，生成可分享的链接，明确设置二十四小时后过期。', ownSession)
  const shared = shareTurn.events.filter(event => event.type === 'artifact').map(event => event.artifact).find(item => item.artifact_id === html.artifact_id)?.share
  assertCapability(shared, capabilityStage)
  capabilityShares.add(html.artifact_id)
  const remaining = shared.expires_at_ms - Date.now()
  assertCapability(Number.isSafeInteger(shared.expires_at_ms) && remaining > 23.9 * 3600000 && remaining <= 24 * 3600000, 'share-expiry-24h')
  const publicResponse = await capabilityPublic(shared)
  assertCapability(publicResponse.ok && publicResponse.headers.get('cache-control')?.includes('no-store') && publicResponse.headers.get('content-security-policy')?.includes('sandbox') && (await publicResponse.text()).includes(capabilityMarker), 'share-anonymous')
  capabilityRecord('html-share-24h-anonymous', 'PASS', shareTurn.started)

  capabilityStage = 'html-share-revoke'
  const revokeStarted = performance.now()
  const revoked = await capabilityRequest('POST', '/api/v1/assistant/artifacts/' + html.artifact_id + '/revoke', {})
  assertCapability(revoked.ok && !(await revoked.json()).artifact?.share, capabilityStage)
  const expired = await capabilityPublic(shared)
  assertCapability(expired.status === 410 && expired.headers.get('cache-control')?.includes('no-store'), capabilityStage)
  capabilityShares.delete(html.artifact_id)
  capabilityRecord('html-share-revoke-410', 'PASS', revokeStarted)

  capabilityStage = 'public-web-read-source'
  const web = await capabilityChat('请实际打开读取 https://example.com 的公开网页，简短概括页面内容，并给出完整的原始来源链接。只查询公开网站，不涉及任何内部资料。', ownSession)
  assertCapability(web.events.some(event => event.type === 'tool' && event.tool === 'web_read' && event.state === 'completed'), capabilityStage)
  const webText = web.events.filter(event => event.type === 'text').map(event => event.text).join('')
  assertCapability(capabilitySourceHref(webText), 'public-web-citation')
  capabilityRecord('public-web-read-source', 'PASS', web.started)

  capabilityStage = 'records-navigation'
  if (!permissions.includes('stats:read')) capabilityRecord('records-navigation', 'SKIP')
  else {
    const navigation = await capabilityChat('请直接打开调用明细页面，并将筛选设为最近七天、来源 DSH。只进行页面导航和筛选，不需要再查询数据。', ownSession)
    const selected = navigation.events.find(event => event.type === 'navigate' && event.path === '/records')
    assertCapability(selected?.filters?.period === 'last7d' && selected.filters.source === 'dsh', capabilityStage)
    capabilityRecord('records-navigation-filters', 'PASS', navigation.started)
  }
  capabilityStage = 'private-artifact-history'
  const historyStarted = performance.now(), history = await capabilityJson('/api/v1/assistant/sessions/' + ownSession)
  const saved = history.messages.flatMap(message => message.artifacts ?? [])
  assertCapability(generated.every(artifact => saved.some(item => item.artifact_id === artifact.artifact_id)) && saved.filter(item => item.artifact_id === html.artifact_id).every(item => !item.share), capabilityStage)
  capabilityRecord('private-artifact-history', 'PASS', historyStarted)
} catch (error) {
  capabilityFailed = true
  capabilityRecord(error instanceof CapabilityCheckError ? error.checkId : 'transport-or-parser-failure', 'FAIL', undefined, { stage: capabilityStage, ...capabilityDiagnostic })
} finally {
  const started = performance.now()
  await capabilityCleanup()
  capabilityRecord('cleanup-own-sessions-files', capabilityCleanupFailed ? 'FAIL' : 'PASS', started)
}
if (capabilityFailed || capabilityCleanupFailed) {
  console.log('ASSISTANT_CAPABILITIES_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', elapsed_ms: Math.round(performance.now() - capabilityStarted) }))
  process.exitCode = 1
} else console.log('ASSISTANT_CAPABILITIES_ONLINE_OK ' + JSON.stringify({ status: 'PASS', checks: capabilityChecks.length, elapsed_ms: Math.round(performance.now() - capabilityStarted) }))
