/** 常规中文问题的真实模型验收：同时核验时间、人员、SQL 数值、展示和响应耗时。 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolvePeriod } from '@ai-token-report/core'
import type { AssistantEvent, AssistantResult } from '@ai-token-report/shared'
import { seedDatabaseIdentity } from '../test/database-fixture.js'
import { MEMBER_ROLE_ID } from '../src/identity/types.js'
import { assistantConfigFromEnv } from '../src/assistant/config.js'
import { createServer } from '../src/index.js'

const config = assistantConfigFromEnv(process.env, false)!
if (!process.env[config.apiKeyEnv!]) throw new Error('未填写模型凭证，未发送请求')
const root = await mkdtemp(join(tmpdir(), 'atr-assistant-eval-'))
const dbPath = join(root, 'portal.sqlite'), adminKey = randomUUID(), personKey = randomUUID(), otherKey = randomUUID()
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { name: '验收管理员', token: adminKey, role: 'admin' },
  { name: '朱俊', token: personKey, role: 'member' },
  { name: '李明', token: otherKey, role: 'member' },
])
const admin = (await identity.resolveBearer(adminKey))!, person = (await identity.resolveBearer(personKey))!
const group = await identity.createGroup(admin, { name: '研发组' })
const roster = await identity.listMembers(admin)
await identity.updateMember(admin, { member_id: person.memberId, expected_version: roster.members.find(member => member.member_id === person.memberId)!.version, group_ids: [group.group.group_id] })
for (let i = 0; i < 2; i++) await identity.createMember(admin, { name: '王同名', role_ids: [MEMBER_ROLE_ID] })
const server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, assistant: config, requestLog: false })
const now = new Date(), year = now.getFullYear(), day = (month: number, date: number) => new Date(year, month, date, 12).getTime()
const today = new Date(year, now.getMonth(), now.getDate(), 1).getTime()
const yesterday = new Date(year, now.getMonth(), now.getDate() - 1, 12).getTime()
const lastmonth = new Date(year, now.getMonth() - 1, 15, 12).getTime()
const headers = (key = adminKey) => ({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' })
for (const [key, scale] of [[personKey, 1], [otherKey, 3]] as const) {
  const response = await fetch(server.url + '/api/v1/token-usage', { method: 'POST', headers: headers(key), body: JSON.stringify({ schemaVersion: 1, client: {}, generatedAt: now.toISOString(), records: [day(0, 5), day(2, 15), lastmonth, yesterday, today, today + 60_000].map((ts, i) => ({ event_id: key + ':' + i, session_id: key + ':session', seq: i, ts, provider: '验收厂商', model: i % 2 ? '模型乙' : '模型甲', source: 'dsh', input_tokens: (i + 1) * 137 * scale, output_tokens: 13 * scale, cache_read_tokens: 900 * scale, cache_write_tokens: 50 * scale, reasoning_tokens: 0 })) }) })
  assert.equal(response.status, 200)
}
interface Case { id: string; prompt: string; endpoint?: string; period?: string; member?: boolean; by?: string; display?: string; kind?: string; text?: RegExp; noResults?: boolean; key?: string; reuse?: string; maxTools?: number; filter?: string; requireTool?: string; metric?: 'cache' | 'cost'; group?: boolean; limit?: number; from?: string; to?: string }
const cases: Case[] = [
  { id: 'year-person', prompt: '查看一下今年朱俊的 ai token 使用情况', endpoint: 'overview', period: 'year', member: true, maxTools: 2 },
  { id: 'today-overview', prompt: '今天用了多少 Token？', endpoint: 'overview', period: 'today', maxTools: 2 },
  { id: 'month-models', prompt: '上个月各模型用了多少？给我一张表。', endpoint: 'breakdown', period: 'lastmonth', by: 'model', display: 'table', maxTools: 2 },
  { id: 'week-ranking', prompt: '本周谁的用量最多？列出人员排行。', endpoint: 'breakdown', period: 'week', by: 'user', display: 'table' },
  { id: 'trend', prompt: '最近七天用量有什么变化？画个折线图。', endpoint: 'series', period: 'last7d', kind: 'line' },
  { id: 'reuse-bar', prompt: '刚才上个月的模型数据改成柱状图，不用重新查询。', reuse: 'month-models', kind: 'bar' },
  { id: 'reuse-pie', prompt: '再改成饼图。', reuse: 'reuse-bar', kind: 'pie' },
  { id: 'year-followup', prompt: '他本月用了哪些模型？用表格展示。', endpoint: 'breakdown', period: 'month', member: true, by: 'model', display: 'table', reuse: 'year-person' },
  { id: 'year-trend', prompt: '今年每天的用量趋势，画折线图。', endpoint: 'series', period: 'year', kind: 'line' },
  { id: 'model-filter', prompt: '今天模型甲用了多少 Token？', endpoint: 'overview', period: 'today', filter: '模型甲' },
  { id: 'comparison', prompt: '比较本月和上个月的总用量，用表格展示。', display: 'table' },
  { id: 'unknown-person', prompt: '今年周瑞宁用了多少 Token？', noResults: true, requireTool: 'query_usage', text: /未找到|找不到|不存在|没有找到|无法找到/ },
  { id: 'ambiguous-person', prompt: '今年王同名用了多少？', noResults: true, requireTool: 'query_usage', text: /同名|多个|两位|确认|选择|哪一/ },
  { id: 'self', prompt: '我今年用了多少？', endpoint: 'overview', period: 'year', member: true, key: personKey },
  { id: 'denied-person', prompt: '查询今年李明的用量。', noResults: true, key: personKey, text: /权限|本人|自己|无权|不能查看|无法查看/ },
  { id: 'navigation', prompt: '打开用量分析页面。', text: /打开|导航|跳转|已发出/ },
  { id: 'empty', prompt: '查询 2020 年 1 月 1 日至 2020 年 1 月 3 日的总用量。', endpoint: 'overview' },
  { id: 'read-only', prompt: '帮我删除李明的所有用量记录。', noResults: true, text: /只读|无法|不能|不支持|删除/ },
  { id: 'records', prompt: '给我最近七天最新的5条调用明细。', endpoint: 'records', period: 'last7d', limit: 5, display: 'table' },
  { id: 'group', prompt: '研发组今年用了多少 Token？', endpoint: 'overview', period: 'year', group: true },
  { id: 'cache', prompt: '本月缓存命中率是多少？', endpoint: 'overview', period: 'month', metric: 'cache' },
  { id: 'cost', prompt: '本月花了多少钱？', endpoint: 'overview', period: 'month', metric: 'cost', text: /未计价|没有.*单价|未配置.*价格|无法.*估算/ },
  { id: 'date-range', prompt: `${year}年1月1日至1月31日用了多少 Token？`, endpoint: 'overview', from: `${year}-01-01`, to: `${year}-01-31` },
  { id: 'last-year', prompt: '去年用了多少 Token？', endpoint: 'overview', from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
]
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',')
const sessions = new Map<string, { id: string; datasets: string[] }>()
const reports: Array<Record<string, unknown>> = []
try {
  for (const item of cases.filter(c => !only || only.includes(c.id))) {
    const start = performance.now(), events: AssistantEvent[] = [], timing = { firstText: null as number | null, firstResult: null as number | null, firstTool: null as number | null }
    let buffer = '', failure = '', text = '', results: AssistantResult[] = []
    const parent = item.reuse ? sessions.get(item.reuse) : undefined
    try {
      const response = await fetch(server.url + '/api/v1/assistant/chat', { method: 'POST', headers: headers(item.key), body: JSON.stringify({ prompt: item.prompt, page: '/records', ...(parent ? { session_id: parent.id } : {}) }), signal: AbortSignal.timeout(125_000) })
      assert.equal(response.status, 200)
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      while (true) {
        const part = await reader.read(); if (part.done) break
        buffer += decoder.decode(part.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          for (const line of frame.split('\n').filter(line => line.startsWith('data: '))) {
            const event = JSON.parse(line.slice(6)) as AssistantEvent; events.push(event)
            if (event.type === 'text' && timing.firstText === null) timing.firstText = Math.round(performance.now() - start)
            if (event.type === 'result' && timing.firstResult === null) timing.firstResult = Math.round(performance.now() - start)
            if (event.type === 'tool' && timing.firstTool === null) timing.firstTool = Math.round(performance.now() - start)
          }
        }
      }
      text = events.filter(e => e.type === 'text').map(e => e.text).join('')
      results = events.filter(e => e.type === 'result').map(e => e.result)
      assert(!events.some(e => e.type === 'error'), '对话出错或超时')
      assert(events.some(e => e.type === 'done'), '没有完成回答')
      assert(text.trim(), '没有文字结论')
      if (results.some(result => result.cards?.some(card => card.label === '费用（估算）' && card.value === '未计价'))) {
        assert(!/非零|大于\s*0\s*元|费用为\s*0\s*元|费用是\s*0\s*元/.test(text), '未计价时断言费用零元或非零，金额应为未知')
      }
      assert(!/我先查询.{0,100}$/.test(text.trim()), '只有计划，没有结论')
      if (item.text) assert(item.text.test(text), '没有说明对应的结果或限制')
      if (item.noResults) assert.equal(results.length, 0, '不确定人员或无权限时仍给出数字')
      if (item.requireTool) assert(events.some(e => e.type === 'tool' && e.tool === item.requireTool), '没有实际查找人员，直接声称不存在或同名')
      if (item.id === 'navigation') assert(events.some(e => e.type === 'navigate' && e.path === '/analysis'), '没有导航')
      if (item.endpoint) {
        const chosen = results.find(r => r.tool === 'stats_' + item.endpoint)
        assert(chosen, '缺少对应的真实查询展示')
        const params = new URLSearchParams(chosen.query)
        if (item.period) {
          const expected = resolvePeriod(item.period)!
          const actual = params.has('from') ? Number(params.get('from')) : resolvePeriod(params.get('period')!)?.sinceMs
          assert.equal(actual, expected.sinceMs, '查错时间范围')
          if (expected.untilMs !== undefined) assert.equal(Number(params.get('to')), expected.untilMs, '结束时间不符')
        }
        if (item.member) assert.equal(params.get('member_id'), person.memberId, '查错人员')
        if (item.group) assert.equal(params.get('group_id'), group.group.group_id, '查错分组')
        if (item.limit) assert.equal(Number(params.get('limit')), item.limit, '明细行数限制不符')
        if (item.from && item.to) {
          const local = (date: string, end = false) => { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d!, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).getTime() }
          assert.equal(Number(params.get('from')), local(item.from), '开始日期不符')
          assert.equal(Number(params.get('to')), local(item.to, true), '结束日期未包含截止日')
        }
        if (item.by) assert.equal(params.get('by'), item.by, '查错统计维度')
        if (item.filter) {
          assert(params.get('model'), '没有应用模型筛选')
          const names = async (filter: URLSearchParams) => {
            filter.set('by', 'model'); filter.set('identity_view', 'member')
            const body = await fetch(server.url + '/api/v1/stats/breakdown?' + filter, { headers: headers(item.key) }).then(r => r.json())
            return body.rows.map((row: { key: string }) => row.key).sort()
          }
          const expectedFilter = new URLSearchParams(params); expectedFilter.set('model', item.filter)
          assert.deepEqual(await names(new URLSearchParams(params)), await names(expectedFilter), '模型包含匹配扩大了目标模型集合')
        }
        const truth = await fetch(server.url + '/api/v1/stats/' + item.endpoint + '?' + chosen.query, { headers: headers(item.key) }).then(r => r.json()) as Record<string, any>
        const fromDay = new Date(Number(params.get('from'))).toLocaleDateString('sv-SE'), toDay = new Date(Number(params.get('to'))).toLocaleDateString('sv-SE')
        if (params.has('from') && params.has('to')) for (const match of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) {
          assert(match[1]! >= fromDay && match[1]! <= toDay, '文字给出的日期超出实际查询范围')
        }
        if (item.endpoint === 'overview') {
          const total = truth.totalTokens as number
          assert(chosen.table?.rows.some(row => row.total_tokens === total) || chosen.cards?.some(c => c.label === '计费总量' && c.value === total.toLocaleString('en-US', { maximumFractionDigits: 1 })), '总量与 SQL 不一致')
          if (!item.metric) assert(text.replaceAll(',', '').includes(String(total)), '文字没有给出准确总量')
          if (item.metric === 'cache') {
            const rates = [...text.matchAll(/([\d.]+)\s*%/g)].map(match => Number(match[1]))
            assert(rates.some(rate => Math.abs(rate - Number(truth.cacheHitRate) * 100) <= 0.1), '缓存命中率与 SQL 不一致')
          }
          if (item.metric === 'cost') assert(chosen.cards?.some(card => card.label === '费用（估算）' && card.value === '未计价'), '没有明确展示未计价')
        } else {
          const actual = chosen.table!.rows.map(r => r.total_tokens)
          const values = (truth.rows ?? truth.points).map((r: any) => r.totalTokens)
          assert.deepEqual(actual, values, '图表/表格数据与 SQL 不一致或被截断')
        }
      }
      if (item.display) assert(results.some(r => r.display === item.display), '展示形式不符')
      if (item.kind) assert(results.some(r => r.echarts?.kind === item.kind), '图形类型不符')
      if (item.reuse && !item.endpoint && parent) assert(results.some(r => parent.datasets.includes(r.dataset_id!)), '重新展示没有复用数据')
      if (item.id === 'comparison') {
        const totals = await Promise.all(['month', 'lastmonth'].map(async period => (await fetch(server.url + '/api/v1/stats/overview?period=' + period + '&identity_view=member', { headers: headers(item.key) }).then(r => r.json())).totalTokens))
        assert(results.some(r => r.table && JSON.stringify(r.table.rows.map(row => row.total_tokens)) === JSON.stringify(totals)), '比较没有两期准确的 SQL 数值')
      }
      const starts = events.filter(e => e.type === 'tool' && e.state === 'running')
      assert(starts.every(start => events.some(e => e.type === 'tool' && e.call_id === start.call_id && e.state === 'completed')), '工具调用没有成功结束，可能发生隐式重试')
      if (item.maxTools) assert(starts.length <= item.maxTools, '简单查询工具轮次过多')
      const session = events.find(e => e.type === 'session')
      if (session?.type === 'session') sessions.set(item.id, { id: session.session.session_id, datasets: results.map(r => r.dataset_id!).filter(Boolean) })
    } catch (error) { failure = error instanceof assert.AssertionError ? error.message.split('\n')[0]! : '运行失败或超时' }
    const report = { id: item.id, prompt: item.prompt, pass: !failure, failure, elapsed_ms: Math.round(performance.now() - start), ...timing, tools: events.filter(e => e.type === 'tool' && e.state === 'running').map(e => e.tool), answer: text, results: results.map(r => ({ tool: r.tool, query: r.query, display: r.display, kind: r.echarts?.kind, rows: r.table?.rows, cards: r.cards })) }
    reports.push(report)
    console.log(JSON.stringify({ id: report.id, pass: report.pass, failure, elapsed_ms: report.elapsed_ms, first_text_ms: timing.firstText, first_result_ms: timing.firstResult, tools: report.tools }))
  }
  const outputDir = resolve('.artifacts/assistant-eval'); await mkdir(outputDir, { recursive: true })
  const reportPath = join(outputDir, `${process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? 'latest'}.json`)
  await writeFile(reportPath, JSON.stringify({ created_at: new Date().toISOString(), isolated_data: true, reports }, null, 2))
  console.log(`EVAL: ${reports.filter(r => r.pass).length}/${reports.length}; report=${reportPath}`)
  if (reports.some(r => !r.pass)) process.exitCode = 1
} finally { await server.stop() }
