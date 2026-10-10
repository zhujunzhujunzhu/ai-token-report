/** 线上自然语言导航验收；只使用随机标记的自建会话，日志不含凭证、搜索词或模型正文。 */
import { randomUUID } from 'node:crypto'

const navigationStarted = performance.now(), navigationRunAt = Date.now()
const navigationMarker = '导航验收-' + randomUUID().replaceAll('-', '').slice(0, 16)
const navigationHeaders = { ...jsonHeaders, cookie: 'atr_portal_session=' + session }
const navigationSessions = new Set(), navigationChecks = []
const navigationSafeIds = new Set([
  'login-status', 'assistant-enabled', 'navigation-permission', 'isolated-session', 'appkey-navigation', 'appkey-navigation-search',
  'chat-http-sse', 'chat-no-done', 'chat-engine-error', 'chat-missing-session', 'chat-unexpected-operation',
  'navigate-count', 'navigate-path', 'navigate-search', 'navigate-filters', 'navigate-call-count', 'navigate-call-id',
  'navigate-completed-202', 'navigate-failed', 'navigate-unexpected-tool', 'private-session-history',
  'cleanup-own-sessions', 'transport-or-parser-failure', 'unclassified-check',
])
let navigationStage = 'login-status', navigationFailed = false, navigationCleanupFailed = false, navigationDiagnostic = {}
class NavigationCheckError extends Error {
  constructor(id) { super('导航验收固定检查失败'); this.checkId = navigationSafeIds.has(id) ? id : 'unclassified-check' }
}
const navigationAssert = (value, id) => { if (!value) throw new NavigationCheckError(id) }
function navigationRecord(id, status, started, diagnostic) {
  const value = { id: navigationSafeIds.has(id) ? id : 'unclassified-check', status, elapsed_ms: started === undefined ? 0 : Math.round(performance.now() - started) }
  if (diagnostic) value.diagnostic = diagnostic
  navigationChecks.push(value)
  console.log('ASSISTANT_NAVIGATION_ONLINE_STEP ' + JSON.stringify(value))
}
async function navigationRequest(method, path, body, timeoutMs = 35000) {
  // ★ 认证 Cookie 只发给固定的本站接口，模型的输出不能决定请求目的地。
  return await fetch(baseUrl + path, { method, headers: navigationHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) })
}
async function navigationJson(path) {
  const response = await navigationRequest('GET', path)
  navigationAssert(response.ok, navigationStage)
  return await response.json()
}
/** 无网络纯契约判断；--check 用成功和失败事件证明断言确实覆盖同调用完成与参数边界。 */
function navigationContract(events, search) {
  const navigations = events.filter(event => event.type === 'navigate')
  if (navigations.length !== 1) return 'navigate-count'
  const selected = navigations[0]
  if (selected.path !== '/appkeys') return 'navigate-path'
  if (selected.search !== search) return 'navigate-search'
  if (selected.filters !== undefined) return 'navigate-filters'
  const tools = events.filter(event => event.type === 'tool')
  if (tools.some(event => event.state === 'failed' || event.status >= 400)) return 'navigate-failed'
  if (tools.some(event => event.tool !== 'portal_navigate')) return 'navigate-unexpected-tool'
  const starts = tools.filter(event => event.state === 'running')
  const completions = tools.filter(event => event.state === 'completed')
  if (tools.length !== 2 || starts.length !== 1 || completions.length !== 1) return 'navigate-call-count'
  const start = starts[0], completed = completions[0]
  if (typeof start.call_id !== 'string' || !start.call_id || completed.call_id !== start.call_id) return 'navigate-call-id'
  if (start.status !== 202 || start.query !== '/appkeys' || completed.status !== 202 || completed.query !== '/appkeys') return 'navigate-completed-202'
  return null
}
async function navigationChat(prompt, ownSession) {
  const started = performance.now(), events = []
  navigationDiagnostic = {}
  const response = await navigationRequest('POST', '/api/v1/assistant/chat', { prompt, page: '/records', ...(ownSession ? { session_id: ownSession } : {}) }, 130000)
  navigationDiagnostic.http_status = response.status
  navigationAssert(response.ok && response.headers.get('content-type')?.includes('text/event-stream'), 'chat-http-sse')
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
        if (event.type === 'session') navigationSessions.add(event.session.session_id)
      }
    }
  }
  navigationDiagnostic = {
    http_status: response.status, done: events.some(event => event.type === 'done'), error: events.some(event => event.type === 'error'),
    navigate_count: events.filter(event => event.type === 'navigate').length,
    tools: events.filter(event => event.type === 'tool').slice(0, 12).map(event => ({
      tool: event.tool === 'portal_navigate' ? 'portal_navigate' : 'unexpected-tool',
      state: ['running', 'completed', 'failed'].includes(event.state) ? event.state : 'legacy',
      status: Number.isInteger(event.status) && event.status >= 0 && event.status <= 599 ? event.status : null,
    })),
  }
  navigationAssert(navigationDiagnostic.done, 'chat-no-done')
  navigationAssert(!navigationDiagnostic.error, 'chat-engine-error')
  navigationAssert(!events.some(event => ['action', 'artifact', 'result'].includes(event.type)), 'chat-unexpected-operation')
  navigationAssert(events.some(event => event.type === 'session'), 'chat-missing-session')
  const sessionId = events.find(event => event.type === 'session').session.session_id
  navigationAssert(!ownSession || sessionId === ownSession, 'isolated-session')
  return { events, started, sessionId }
}
async function navigationCleanup() {
  // ★ 即使首个 SSE 会话帧丢失，也只补找本轮随机标记与创建时间同时匹配的会话。
  try {
    const response = await navigationRequest('GET', '/api/v1/assistant/sessions')
    if (response.ok) {
      const data = await response.json()
      for (const item of data.sessions ?? []) if (item.created_at_ms >= navigationRunAt && String(item.title).includes(navigationMarker)) navigationSessions.add(item.session_id)
    } else navigationCleanupFailed = true
  } catch { navigationCleanupFailed = true }
  for (const id of navigationSessions) {
    let removed = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await navigationRequest('DELETE', '/api/v1/assistant/sessions/' + id)
        if (response.ok || response.status === 404) { removed = true; break }
        if (response.status !== 409) break
      } catch { break }
      await new Promise(done => setTimeout(done, 1000))
    }
    if (!removed) navigationCleanupFailed = true
  }
  try {
    const response = await navigationRequest('POST', '/api/v1/auth/logout', {})
    if (!response.ok) navigationCleanupFailed = true
  } catch { navigationCleanupFailed = true }
}
try {
  const started = performance.now()
  const status = await navigationJson('/api/v1/assistant/status')
  navigationAssert(status.enabled, 'assistant-enabled')
  const identity = await navigationJson('/api/v1/auth/session')
  navigationAssert(identity.viewer?.permissions?.includes('tokens:manage'), 'navigation-permission')
  navigationRecord('login-status', 'PASS', started)

  // ★ 单独建立有随机标题的会话，后续两个用户原句保持不变，同时可在失败后安全清理。
  navigationStage = 'isolated-session'
  const seed = await navigationChat(navigationMarker + '。这是导航验收会话，请只回复收到，不要查询数据或执行操作。')
  navigationAssert(!seed.events.some(event => ['tool', 'navigate'].includes(event.type)), 'chat-unexpected-operation')
  navigationRecord('isolated-session', 'PASS', seed.started)
  for (const [id, prompt, search] of [
    ['appkey-navigation', '打开appKey管理页面', undefined],
    ['appkey-navigation-search', '打开appKey管理页面，搜索' + navigationMarker, navigationMarker],
  ]) {
    navigationStage = id
    const turn = await navigationChat(prompt, seed.sessionId)
    const violation = navigationContract(turn.events, search)
    navigationAssert(!violation, violation)
    navigationRecord(id, 'PASS', turn.started, navigationDiagnostic)
  }
  navigationStage = 'private-session-history'
  const historyStarted = performance.now(), history = await navigationJson('/api/v1/assistant/sessions/' + seed.sessionId)
  navigationAssert(history.session.session_id === seed.sessionId && history.session.title.includes(navigationMarker) && history.session.turn_count === 3 && history.messages.filter(item => item.role === 'user').length === 3, navigationStage)
  navigationRecord('private-session-history', 'PASS', historyStarted)
} catch (error) {
  navigationFailed = true
  navigationRecord(error instanceof NavigationCheckError ? error.checkId : 'transport-or-parser-failure', 'FAIL', undefined, { stage: navigationStage, ...navigationDiagnostic })
} finally {
  const started = performance.now()
  await navigationCleanup()
  navigationRecord('cleanup-own-sessions', navigationCleanupFailed ? 'FAIL' : 'PASS', started)
}
if (navigationFailed || navigationCleanupFailed) {
  console.log('ASSISTANT_NAVIGATION_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', elapsed_ms: Math.round(performance.now() - navigationStarted) }))
  process.exitCode = 1
} else console.log('ASSISTANT_NAVIGATION_ONLINE_OK ' + JSON.stringify({ status: 'PASS', checks: navigationChecks.length, elapsed_ms: Math.round(performance.now() - navigationStarted) }))
