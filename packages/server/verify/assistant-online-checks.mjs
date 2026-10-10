/** 由线上验收入口拼接到可信登录流程后执行；不单独运行，不修改人员或用量。 */
const assertOnline = (ok, message) => { if (!ok) throw new Error(message) }
const authHeaders = { ...jsonHeaders, cookie: 'atr_portal_session=' + session }
const testSessions = new Set(), checks = []
const api = async path => {
  const response = await fetch(baseUrl + path, { headers: authHeaders, signal: AbortSignal.timeout(30000) })
  assertOnline(response.ok, '统计或历史接口失败：HTTP ' + response.status)
  return response.json()
}
async function chat(id, prompt, expected, sessionId) {
  const started = performance.now(), events = [], timing = { first_text_ms: null, first_result_ms: null }
  const response = await fetch(baseUrl + '/api/v1/assistant/chat', { method: 'POST', headers: authHeaders, body: JSON.stringify({ prompt, page: '/records', ...(sessionId ? { session_id: sessionId } : {}) }), signal: AbortSignal.timeout(130000) })
  assertOnline(response.ok && response.headers.get('content-type').includes('text/event-stream'), '对话不是成功的 SSE')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const part = await reader.read(); if (part.done) break
    buffer += decoder.decode(part.value, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0,end); buffer = buffer.slice(end + 2)
      for (const line of frame.split('\n').filter(line => line.startsWith('data: '))) {
        const event = JSON.parse(line.slice(6)); events.push(event)
        if (event.type === 'session') testSessions.add(event.session.session_id)
        if (event.type === 'text' && timing.first_text_ms === null) timing.first_text_ms = Math.round(performance.now() - started)
        if (event.type === 'result' && timing.first_result_ms === null) timing.first_result_ms = Math.round(performance.now() - started)
      }
    }
  }
  assertOnline(events.some(e => e.type === 'done') && !events.some(e => e.type === 'error'), '模型没有完成：' + id)
  const text = events.filter(e => e.type === 'text').map(e => e.text).join('')
  assertOnline(text.trim().length > 0, '缺少结论：' + id)
  const results = events.filter(e => e.type === 'result').map(e => e.result)
  const chosen = results.find(expected)
  assertOnline(chosen, '缺少预期展示：' + id)
  const terminal = events.filter(e => e.type === 'tool' && e.state === 'running')
  assertOnline(terminal.every(e => events.some(t => t.type === 'tool' && t.call_id === e.call_id && t.state === 'completed')), '工具未成功结束：' + id)
  if (chosen.tool.startsWith('stats_')) {
    const truth = await api('/api/v1/stats/' + chosen.tool.slice(6) + '?' + chosen.query)
    if (chosen.tool === 'stats_overview') {
      const total = truth.totalTokens.toLocaleString('en-US', { maximumFractionDigits: 1 })
      assertOnline(chosen.cards.some(c => c.label === '计费总量' && c.value === total), '指标与统计 API 不一致')
      assertOnline(text.replaceAll(',', '').includes(String(truth.totalTokens)), '文字没有准确总量')
    } else {
      const actual = chosen.table.rows.map(row => row.total_tokens)
      const values = (truth.rows ?? truth.points).slice(0,400).map(row => row.totalTokens)
      assertOnline(JSON.stringify(actual) === JSON.stringify(values), '展示与统计 API 不一致')
    }
  }
  const record = { id, pass: true, elapsed_ms: Math.round(performance.now() - started), ...timing, tools: terminal.map(e => e.tool) }
  checks.push(record); console.log('ASSISTANT_ONLINE_STEP ' + JSON.stringify(record))
  return { chosen, events, sessionId: events.find(e => e.type === 'session').session.session_id }
}
let failed
try {
  const anonymous = await fetch(baseUrl + '/api/v1/assistant/status')
  assertOnline(anonymous.status === 401, '匿名用户可读助手状态')
  const status = await api('/api/v1/assistant/status')
  assertOnline(status.enabled, '线上助手未启用')
  console.log('ASSISTANT_ONLINE_STEP ' + JSON.stringify({ id: 'login-status-auth', pass: true }))
  const directory = await api('/api/v1/stats/members')
  const matches = directory.members.filter(member => member.name === '朱俊')
  assertOnline(matches.length === 1, '年度点名验收人员需要唯一匹配')
  const annual = await chat('year-person', '查看一下今年朱俊的 ai token 使用情况', r => r.display === 'cards' && r.tool === 'stats_overview')
  const annualParams = new URLSearchParams(annual.chosen.query)
  assertOnline(annualParams.get('member_id') === matches[0].member_id, '年度查询查错人员')
  const yearStart = new Date(new Date().getFullYear(),0,1).getTime()
  assertOnline(Number(annualParams.get('from')) === yearStart, '年度查询查错起点')
  const table = await chat('model-table', '最近七天各模型用量，给我一张表。', r => r.display === 'table' && r.tool === 'stats_breakdown')
  assertOnline(new URLSearchParams(table.chosen.query).get('by') === 'model', '模型分布维度不符')
  const bar = await chat('reuse-bar', '把刚才同一份数据改成柱状图，不需要重新查询。', r => r.echarts?.kind === 'bar', table.sessionId)
  assertOnline(bar.chosen.dataset_id === table.chosen.dataset_id && JSON.stringify(bar.chosen.table.rows) === JSON.stringify(table.chosen.table.rows), '柱图没有复用原数据')
  const pie = await chat('reuse-pie-navigation', '同一份数据改成饼图，然后打开用量分析页面。', r => r.echarts?.kind === 'pie', table.sessionId)
  assertOnline(pie.chosen.dataset_id === table.chosen.dataset_id, '饼图没有复用原数据')
  assertOnline(pie.events.some(e => e.type === 'navigate' && e.path === '/analysis'), '没有站内导航事件')
  await chat('trend', '最近七天用量有什么变化？画个折线图。', r => r.echarts?.kind === 'line' && r.tool === 'stats_series')
  const history = await api('/api/v1/assistant/sessions/' + table.sessionId)
  const restored = history.messages.flatMap(m => m.results ?? [])
  assertOnline(restored.some(r => r.display === 'table') && restored.some(r => r.echarts?.kind === 'bar') && restored.some(r => r.echarts?.kind === 'pie'), '私有历史没有保存展示')
  console.log('ASSISTANT_ONLINE_STEP ' + JSON.stringify({ id: 'history', pass: true }))
} catch (error) { failed = error instanceof Error ? error.message : '验收失败' }
finally {
  for (const id of testSessions) {
    const response = await fetch(baseUrl + '/api/v1/assistant/sessions/' + id, { method: 'DELETE', headers: authHeaders })
    if (!response.ok) failed = '测试对话清理失败'
  }
  await fetch(baseUrl + '/api/v1/auth/logout', { method: 'POST', headers: authHeaders })
}
if (failed) { console.log('ASSISTANT_ONLINE_FAILED ' + JSON.stringify({ reason: failed })); process.exitCode = 1 }
else console.log('ASSISTANT_ONLINE_OK ' + JSON.stringify({ checks: checks.length + 2, synthetic_usage_written: false, test_sessions_removed: testSessions.size, path: 'public nginx → login → DSH → model → MySQL stats → SSE → presentation → history' }))
