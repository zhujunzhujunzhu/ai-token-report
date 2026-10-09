/** DSH 实际包装载的双运行时哨兵。只访问回环模型夹具，不读取生产凭证。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DshAssistantEngine } from '../src/assistant/runtime.js'
import { ASSISTANT_ENDPOINTS } from '../src/assistant/tools.js'
import type { StatsRoute } from '../src/stats-route.js'
import type { Principal } from '../src/identity/types.js'
import type { AssistantEvent } from '@ai-token-report/shared'

const directory = mkdtempSync(join(tmpdir(), 'atr-dsh-runtime-'))
const requests: any[] = []
const fixture = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk.toString()
  requests.push(JSON.parse(raw))
  const tool = requests.length <= 2
  const navigation = requests.length === 2
  const events = [
    { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: navigation ? 'nav-1' : 'query-1', name: navigation ? 'portal_navigate' : 'stats_overview', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: navigation ? '{"path":"/analysis"}' : '{"query":"period=last7d"}' } : { type: 'text_delta', text: '最近七天已查询。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
})
await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done))
const port = (fixture.address() as { port: number }).port
process.env.ATR_ASSISTANT_TEST_KEY = 'fixture-key'
// ★ 统计 SQL 与实时鉴权由 assistant.test.ts 覆盖；本脚本专门钉 DSH 和 HTTP 模型边界。
const stats = { async handle() { return { status: 200, body: { totalTokens: 50 } } } } as unknown as StatsRoute
const engine = new DshAssistantEngine(stats, { model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'ATR_ASSISTANT_TEST_KEY' })
const events: AssistantEvent[] = []
try {
  const input = {
    sessionId: randomUUID(), directory,
    principal: { memberId: randomUUID(), permissions: ['stats:read'] } as Principal,
    signal: AbortSignal.timeout(10_000), emit: (event: AssistantEvent) => { events.push(event) },
  }
  await engine.run({ ...input, prompt: '首次问题标记' })
  assert(events.some(e => e.type === 'tool' && e.tool === 'stats_overview' && e.status === 200))
  assert(events.some(e => e.type === 'result' && e.result.table?.rows[0]?.total_tokens === 50))
  assert(events.some(e => e.type === 'text' && e.text === '最近七天已查询。'))
  assert.deepEqual(requests[0].tools.map((t: any) => t.name).sort(), [...ASSISTANT_ENDPOINTS.map(e => `stats_${e}`), 'portal_navigate'].sort())
  assert(events.some(e => e.type === 'navigate' && e.path === '/analysis'))
  assert(!JSON.stringify(requests[0].tools.find((t: any) => t.name === 'portal_navigate')).includes('/pricing'))
  await engine.run({ ...input, signal: AbortSignal.timeout(10_000), prompt: '续聊问题标记' })
  assert(JSON.stringify(requests.at(-1).messages).includes('首次问题标记'))
  assert(JSON.stringify(requests.at(-1).messages).includes('续聊问题标记'))
  console.log('DSH_RUNTIME_OK: 工具白名单、实际调用、文本事件、持久化续聊')
} finally {
  delete process.env.ATR_ASSISTANT_TEST_KEY
  fixture.closeAllConnections()
  await new Promise<void>(done => fixture.close(() => done()))
  if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'atr-dsh-runtime-'))) throw new Error('临时目录超出测试边界')
  rmSync(directory, { recursive: true, force: true })
}
