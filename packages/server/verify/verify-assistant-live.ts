/** 填写 .env 后实跑模型、HTTP SSE、SQL 数据与跨轮展示；仅使用隔离的合成用量。 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { preparePortalDatabase } from '@ai-token-report/core/db'
import type { AssistantEvent, AssistantResult } from '@ai-token-report/shared'
import { IdentityRepository } from '../src/identity/index.js'
import { assistantConfigFromEnv, type DshAssistantConfig } from '../src/assistant/config.js'
import { createServer } from '../src/index.js'

const missing = ['ATR_ASSISTANT_MODEL', 'ATR_ASSISTANT_BASE_URL'].filter(name => !process.env[name]?.trim())
const keyName = process.env.ATR_ASSISTANT_API_KEY_ENV || (!process.env.ATR_ASSISTANT_PROTOCOL || process.env.ATR_ASSISTANT_PROTOCOL === 'deepseek-messages' ? 'DEEPSEEK_API_KEY' : 'ATR_ASSISTANT_API_KEY')
if (!process.env[keyName]?.trim()) missing.push(keyName)
if (missing.length) {
  console.log('LIVE_TEST_PENDING: 请填写根目录 .env 中的 ' + missing.join('、') + '。没有发送模型请求。')
  process.exit(process.argv.includes('--check') ? 0 : 2)
}
let config: DshAssistantConfig
try { config = assistantConfigFromEnv(process.env, false)! }
catch { console.error('LIVE_CONFIG_INVALID: 请检查协议、baseUrl、model 和凭证变量名；未发送请求。'); process.exit(2) }
if (process.argv.includes('--check')) { console.log('LIVE_CONFIG_READY: 配置齐全，协议=' + config.protocol + '；未发送请求，未展示凭证。'); process.exit(0) }
const root = mkdtempSync(join(tmpdir(), 'atr-assistant-live-'))
const dbPath = join(root, 'portal.sqlite'), token = randomUUID()
await preparePortalDatabase({ sqlitePath: dbPath })
const identity = new IdentityRepository({ sqlitePath: dbPath })
await identity.importCredentials([{ name: '隔离验收管理员', token, role: 'admin' }], 'assistant-live-fixture')
const server = await createServer({ host: '127.0.0.1', port: 0, dshHome: root, dataDir: root, dbPath, assistant: config, requestLog: false })
const url = server.url
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
const natural = process.argv.includes('--natural')
try {
  const ingest = await fetch(url + '/api/v1/token-usage', { method: 'POST', headers, body: JSON.stringify({
    schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(),
    records: [125, 300].map((input_tokens, index) => ({ event_id: 'live-fixture:' + index, session_id: 'live-fixture', seq: index, ts: Date.now(), provider: 'test-fixture', model: '验收模型' + (index + 1), source: 'dsh', input_tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 })),
  }) })
  assert.equal(ingest.status, 200, '合成用量入库失败')
  const truthResponse = await fetch(url + '/api/v1/stats/breakdown?period=last7d&by=model&identity_view=member', { headers })
  assert.equal(truthResponse.status, 200)
  const truth = await truthResponse.json() as { rows: Array<{ key: string; totalTokens: number }> }
  const expected = truth.rows.map(row => [row.key, row.totalTokens]).sort()
  let session_id: string | undefined, dataset_id: string | undefined
  const prompts = natural ? [
    '帮我看看最近七天各模型的用量，给我一张表。',
    '这份结果改成柱状图，不需要重新查询。',
    '用饼图展示同一份结果，然后打开用量分析页面。',
  ] : [
    '请查询最近7天按模型分布的用量，调用 render_table 展示真实数据集表格，至少包含 dimension 和 total_tokens。无需其它查询。',
    '请复用刚才的数据集，调用 render_echarts 改成柱状图，横轴 dimension、纵轴 total_tokens。不要重新查询。',
    '请复用同一数据集，调用 render_echarts 改成饼图，名称 dimension、值 total_tokens。不要重新查询。然后用 portal_navigate 打开 /analysis。',
  ]
  for (let turn = 0; turn < prompts.length; turn++) {
    const response = await fetch(url + '/api/v1/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt: prompts[turn], ...(session_id ? { session_id } : {}), page: '/records' }), signal: AbortSignal.timeout(130_000) })
    assert.equal(response.status, 200, '对话 HTTP 失败')
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
    assert(!events.some(event => event.type === 'error'), '模型调用未正常完成；请检查协议、model 和 appKey')
    assert(events.some(event => event.type === 'done'), '缺少完成事件')
    const activity = events.filter(event => event.type === 'tool')
    const started = activity.filter(event => event.state === 'running')
    assert(started.length > 0, '未收到工具执行进度')
    assert(started.every(event => activity.some(ended => ended.call_id === event.call_id && ended.state !== 'running')), '工具状态没有结束')
    const session = events.find(event => event.type === 'session')
    if (session?.type === 'session') session_id = session.session.session_id
    const results = events.filter(event => event.type === 'result').map(event => event.result)
    const chosen = results.find(result => turn === 0 ? result.display === 'table' : result.echarts?.kind === (turn === 1 ? 'bar' : 'pie'))
    assert(chosen, '模型没有按指令调用渲染工具：轮次 ' + (turn + 1))
    assert.deepEqual(chosen.table!.rows.map(row => [row.dimension, row.total_tokens]).sort(), expected, '图表/表格数值与真实 SQL 不一致')
    if (dataset_id) assert.equal(chosen.dataset_id, dataset_id, '续聊未复用原数据集')
    dataset_id = chosen.dataset_id
    if (turn === 2) assert(events.some(event => event.type === 'navigate' && event.path === '/analysis'), '导航工具未执行')
    console.log('LIVE_STEP_OK: ' + (turn + 1) + '，' + chosen.display + (chosen.echarts ? '/' + chosen.echarts.kind : '') + '，数值与 SQL 一致，工具进度完整')
  }
  const restored = await fetch(url + '/api/v1/assistant/sessions/' + session_id, { headers }).then(r => r.json()) as { messages: Array<{ results?: AssistantResult[] }> }
  const stored = restored.messages.flatMap(message => message.results ?? [])
  assert(stored.some(result => result.display === 'table') && stored.some(result => result.echarts?.kind === 'bar') && stored.some(result => result.echarts?.kind === 'pie'), '历史展示未持久化')
  if (natural) {
    for (const [prompt, endpoint, kind] of [
      ['最近七天的用量有什么变化？请给我一张折线图。', 'series', 'line'],
      ['再看看最近七天的整体用量，用指标卡展示。', 'overview', 'cards'],
    ] as const) {
      const response = await fetch(url + '/api/v1/assistant/chat', { method: 'POST', headers, body: JSON.stringify({ prompt, page: '/analysis' }), signal: AbortSignal.timeout(130_000) })
      assert.equal(response.status, 200)
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AssistantEvent)
      assert(events.some(event => event.type === 'done') && !events.some(event => event.type === 'error'), '自然语言测试未完成：' + kind)
      const chosen = events.filter(event => event.type === 'result').map(event => event.result).find(result => kind === 'cards' ? result.display === 'cards' : result.echarts?.kind === kind)
      assert(chosen, '未按自然语言意图展示：' + kind)
      const query = chosen.query
      assert.equal(new URLSearchParams(query).get('period'), 'last7d', '时间窗与问题不一致')
      const truth = await fetch(url + '/api/v1/stats/' + endpoint + '?' + query, { headers }).then(response => response.json()) as { points?: Array<{ bucket: string; totalTokens: number }>; totalTokens?: number }
      if (kind === 'line') {
        assert(chosen.echarts!.y_keys.includes('total_tokens'), '趋势图缺少用量指标')
        assert.deepEqual(chosen.table!.rows.map(row => [row.bucket, row.total_tokens]), truth.points!.map(point => [point.bucket, point.totalTokens]), '折线图与 SQL 不一致')
      } else assert(chosen.cards!.some(card => card.label === '计费总量' && card.value === truth.totalTokens!.toLocaleString('en-US', { maximumFractionDigits: 1 })), '指标卡与 SQL 不一致')
      console.log('LIVE_NATURAL_OK: ' + kind + '，普通中文意图 → 自主选工具 → 数值与 SQL 一致')
    }
  }
  console.log((process.env.ATR_ASSISTANT_VERIFICATION_SOURCE === 'loopback' ? 'LOOPBACK_TEST_OK: 回环模型夹具' : 'LIVE_TEST_OK: 真实模型') + ' → DSH → HTTP SSE → SQLite → 表格/柱状图/饼图 → 导航 → 私有历史')
} catch (error) {
  // ★ SDK 错误可能携带请求信息，因此只输出本脚本断言或固定失败提示。
  console.error(error instanceof assert.AssertionError ? error.message : 'LIVE_TEST_FAILED: 模型或服务调用失败，请检查配置；未输出请求头和凭证。')
  process.exitCode = 1
} finally {
  await server.stop()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-assistant-live-'))) throw new Error('临时目录超出测试边界')
  // ★ Windows 的扫描程序可能短暂持有文件；Bun 的 rm 重试选项不总会生效。
  for (let attempt = 0; ; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 20 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}
