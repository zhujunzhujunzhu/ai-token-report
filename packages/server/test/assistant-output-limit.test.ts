/** 思考耗尽输出额度必须有明确错误；真实 DSH/OpenAI 适配器只连独立进程中的回环夹具。 */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanChildEnv } from '../../core/verify/lib/runtime.js'

// ★ 其它用例会替换全局 fetch，模型协议回归必须隔离到子进程，不能误用其它测试的 mock。
const fixtureSource = String.raw`
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DshAssistantEngine } from __RUNTIME__
import { AssistantRuntimeError } from __RUNTIME_ERROR__

const mode = __MODE__
const directory = mkdtempSync(join(tmpdir(), 'atr-assistant-output-limit-'))
const requests = [], events = [], fixtureErrors = []
const reasoning = 'REASONING_PRIVATE_FIXTURE: 仅供模型内部使用的分析，不能显示为回答。'
const partial = '这是输出到达上限前的部分结论。'
const complete = '已根据图片给出简短的完整结论。'
const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
const imageBase64 = Buffer.from(bytes).toString('base64')
const keyEnv = 'ATR_ASSISTANT_OUTPUT_LIMIT_FIXTURE_KEY'
process.env[keyEnv] = 'fixture-output-limit-key'

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  try {
    assert.equal(new URL(request.url).pathname, '/v1/chat/completions')
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-output-limit-key')
    const body = await request.json()
    requests.push(body)
    assert.equal(body.model, 'qwen3.8-max')
    assert.equal(body.messages[0].role, 'system', 'Qwen 系统指令不能被推理模型适配成 developer')
    assert(body.messages.every(message => ['system', 'assistant', 'user', 'tool', 'function'].includes(message.role)), '只允许上游支持的消息角色')
    assert.equal(body.max_completion_tokens, 16384, '输出预算必须透过真实适配器进入线上字段')
    assert.equal(body.reasoning_effort, 'low', '思考强度必须通过公开兼容映射进入请求')
    assert.equal(body.enable_thinking, true)
    assert.equal('thinking_budget' in body, false, '不能同时发送思考预算与思考强度')
    assert.equal('thinking_budget' in (body.extra_body ?? {}), false)
    assert.equal('max_tokens' in body, false, '本配置选择 max_completion_tokens，不能同时送两个预算字段')
    const number = requests.length
    const limited = number === 1 && mode !== 'adequate-budget'
    const id = 'output-fixture-' + number
    const chunks = []
    const chunk = (delta, finish_reason = null, usage) => chunks.push('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'qwen3.8-max', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n')
    chunk({ role: 'assistant', reasoning_content: reasoning })
    if (!limited || mode === 'partial-answer') chunk({ content: limited ? partial : complete })
    chunk({}, limited ? 'length' : 'stop', { prompt_tokens: 50, completion_tokens: limited ? 16384 : 45, total_tokens: limited ? 16434 : 95, completion_tokens_details: { reasoning_tokens: limited ? 16370 : 30 } })
    chunks.push('data: [DONE]\n\n')
    return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  } catch (error) {
    fixtureErrors.push(error)
    return Response.json({ error: { message: '固定回环请求契约失败', type: 'fixture-contract' } }, { status: 500 })
  }
} })

const fixtureOrigin = 'http://127.0.0.1:' + server.port
const originalFetch = globalThis.fetch
// 🚨 子进程中的所有模型网络请求仅允许此回环地址，配置错误也不能误连真实服务。
globalThis.fetch = (input, init) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  assert.equal(target.origin, fixtureOrigin, '测试禁止访问回环模型以外的网络')
  return originalFetch(input, init)
}
const config = { model: 'qwen3.8-max', protocol: 'openai-completions', baseUrl: fixtureOrigin + '/v1', apiKeyEnv: keyEnv, supportsImages: true, maxTokens: 16384, reasoningEffort: 'low' }
const principal = { memberId: randomUUID(), name: '输出边界夹具', permissions: ['stats:read'], roleCodes: ['member'], groupIds: [], groupNames: [], auth: { kind: 'token', tokenId: randomUUID() } }
const input = { sessionId: randomUUID(), directory, principal, signal: AbortSignal.timeout(20_000), emit: event => events.push(event) }
const stats = { handle() { throw new Error('本回归不应查询业务数据') } }
const services = { actions: { query: async () => ({ items: [] }), mutate() { throw new Error('本回归不允许管理写入') } } }
const text = () => events.filter(event => event.type === 'text').map(event => event.text).join('')
const snapshot = () => JSON.parse(readFileSync(join(directory, 'dsh', 'events.json'), 'utf8'))
function requestImages(request) {
  const found = []
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'image_url') found.push(value.image_url.url.split(',')[1])
    for (const child of Object.values(value)) walk(child)
  }
  walk(request.messages)
  return found
}
try {
  const attachments = [{ metadata: { attachment_id: randomUUID(), file_name: '输出边界图.png', media_type: 'image/png', size_bytes: bytes.byteLength, kind: 'image' }, bytes, image: { mediaType: 'image/png', width: 1, height: 1 } }]
  const first = () => new DshAssistantEngine(stats, config, services).run({ ...input, prompt: '首次图片判断标记：依据图片给出简短结论。', attachments })
  if (mode === 'adequate-budget') {
    await first()
    assert.equal(text(), complete)
    assert(snapshot().events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed'))
  } else {
    await assert.rejects(first, error => {
      assert(error instanceof AssistantRuntimeError)
      assert.equal(error.code, 'MODEL_OUTPUT_LIMIT')
      assert.equal(error.reasonKind, 'max-tokens')
      assert.equal(error.publicMessage.includes(reasoning), false)
      return true
    })
    assert.equal(text(), mode === 'partial-answer' ? partial : '', '思考不能当回答输出，部分正文也不能丢失')
    const failed = snapshot()
    assert(failed.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'max-tokens'))
    assert(failed.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'reasoning' && block.text.includes(reasoning))), '失败轮也应保留真实思考的持久化记录')
    assert(failed.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'image')), '失败轮也应保留用户的真实图片记录')
  }
  assert.equal(fixtureErrors.length, 0, fixtureErrors.map(error => error.message).join('; '))
  assert.deepEqual(requestImages(requests[0]), [imageBase64], '首轮必须发送真实图片字节')
  assert.equal(text().includes(reasoning), false)

  // ★ 每轮重新建立真实 DSH 引擎；失败思考与图片从落盘快照重放，不能依赖前轮内存。
  const before = text()
  await new DshAssistantEngine(stats, config, services).run({ ...input, signal: AbortSignal.timeout(20_000), prompt: '文字续聊标记：请直接给出简短最终结论。' })
  assert.equal(fixtureErrors.length, 0, fixtureErrors.map(error => error.message).join('; '))
  assert.equal(requests.length, 2, '耗尽输出不能触发不受控的模型重复调用')
  assert.deepEqual(requestImages(requests[1]), [imageBase64], '文字续聊仍须恢复历史图片字节')
  const assistantHistory = requests[1].messages.filter(message => message.role === 'assistant')
  // ★ Pi 的公开序列化规则会省略没有正文和工具调用的助手消息；DSH 原始记录仍须完整保存。
  if (mode === 'reasoning-only') assert.equal(assistantHistory.length, 0, '仅思考失败轮不能伪造空助手消息进入模型请求')
  else assert(assistantHistory.some(message => typeof message.reasoning_content === 'string' && message.reasoning_content.includes(reasoning)), 'Qwen3.8 续聊必须完整回传原思考到 reasoning_content')
  assert(assistantHistory.every(message => !(JSON.stringify(message.content) ?? '').includes(reasoning)), '原思考不得降级为可见正文 content')
  assert(JSON.stringify(requests[1]).includes('首次图片判断标记') && JSON.stringify(requests[1]).includes('文字续聊标记'))
  assert.equal(text(), before + complete, '续聊不能重放旧正文到浏览器或暴露思考')
  assert.equal(text().includes(reasoning), false)
  const restored = snapshot()
  assert.equal(restored.events.filter(event => event.type === 'turn/start').length, 2)
  assert(restored.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'reasoning')))
  assert.equal(restored.events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  console.log('ASSISTANT_OUTPUT_LIMIT_OK ' + mode)
} finally {
  globalThis.fetch = originalFetch
  delete process.env[keyEnv]
  server.stop(true)
  const target = resolve(directory), boundary = join(resolve(tmpdir()), 'atr-assistant-output-limit-')
  if (!target.startsWith(boundary)) throw new Error('输出额度夹具清理路径越界')
  rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
`

function verifyOutput(mode: 'reasoning-only' | 'partial-answer' | 'adequate-budget'): void {
  const source = fixtureSource
    .replace('__RUNTIME__', JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/assistant/runtime.ts')).href))
    .replace('__RUNTIME_ERROR__', JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/assistant/runtime-error.ts')).href))
    .replace('__MODE__', JSON.stringify(mode))
  const child = spawnSync(process.execPath, ['--eval', source], { env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 45_000 })
  if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
  expect(child.stdout).toContain('ASSISTANT_OUTPUT_LIMIT_OK ' + mode)
}

test('仅思考耗尽输出额度返回MODEL_OUTPUT_LIMIT，图片历史仍可文字续聊且思考不外流', () => verifyOutput('reasoning-only'), 50_000)
test('部分正文后耗尽输出额度保留已显示正文，失败轮图片与思考可重放', () => verifyOutput('partial-answer'), 50_000)
test('Qwen3.8较低思考强度和16384输出预算真实进入模型请求并正常完成图片及文字续聊', () => verifyOutput('adequate-budget'), 50_000)
