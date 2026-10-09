/** 真 Node HTTP 往返：正文背压与提前拒绝不能只靠 Bun 的兼容实现验证。 */
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

test('Node 流式适配保留 HTTP 契约、正文背压及 503/413 提前响应', async () => {
  const node = resolveNodeBin()
  expect(node).not.toBeNull()
  const dir = mkdtempSync(join(tmpdir(), 'atr-node-stream-'))
  const entry = join(dir, 'probe.ts')
  const adapter = resolve(import.meta.dir, '../src/serve-node.ts')
  const limiter = resolve(import.meta.dir, '../src/http/body.ts')
  const hono = resolve(import.meta.dir, '../node_modules/hono/dist/hono.js')
  try {
    writeFileSync(entry, `
import assert from 'node:assert/strict'
import { request, IncomingMessage } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { serveWithNodeHttp } from ${JSON.stringify(adapter)}
import { readIngestBody, requestBodyLimit, MAX_BODY_BYTES, BODY_TOO_LARGE_REASON, BODY_READ_TIMEOUT_REASON } from ${JSON.stringify(limiter)}
import { Hono } from ${JSON.stringify(hono)}
assert.equal(typeof Bun, 'undefined')
const checks = []
const clients = []
const sockets = new Set()
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const held = deferred(), release = deferred()
const sseAborted = deferred()
let bufferedBytes = 0, limitedCalls = 0
const originalEmit = IncomingMessage.prototype.emit
IncomingMessage.prototype.emit = function(event, ...args) {
  if (event === 'data' && this.url === '/held') bufferedBytes += args[0].byteLength
  return originalEmit.call(this, event, ...args)
}
const app = new Hono()
app.use('*', requestBodyLimit())
app.post('/limited', async c => { limitedCalls++; return c.text(await c.req.text()) })
app.post('/api/v1/token-usage', async c => {
  const parsed = await readIngestBody(c, 40)
  return 'error' in parsed ? c.json({ ok: false, reason: parsed.error }, parsed.status) : c.json(parsed.value)
})
const server = await serveWithNodeHttp({ host: '127.0.0.1', port: 0, idleTimeoutSeconds: 10,
  handler: async req => {
    const path = new URL(req.url).pathname
    if (path === '/sse') return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\\n\\n'))
        req.signal.addEventListener('abort', () => { sseAborted.resolve() }, { once: true })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
    if (path === '/limited' || path === '/api/v1/token-usage') return app.fetch(req)
    if (path === '/busy') return Response.json({ ok: false, reason: '队列已满' }, { status: 503 })
    if (path === '/held') { held.resolve(); await release.promise; return new Response('busy', { status: 503 }) }
    if (path === '/throws') throw new Error('测试失败')
    const headers = new Headers({ 'content-type': 'application/json' })
    headers.append('set-cookie', 'first=1; Path=/; HttpOnly')
    headers.append('set-cookie', 'second=2; Path=/; HttpOnly')
    return new Response(JSON.stringify({ method: req.method, url: req.url, body: await req.text(),
      cookie: req.headers.get('cookie'), marker: req.headers.get('x-marker') }), { headers })
  },
})
function send(path, { method = 'POST', headers = {}, chunks = [], end = true } = {}) {
  return new Promise((resolve, reject) => {
    let responded = false
    const client = request({ hostname: '127.0.0.1', port: server.port, path, method, headers, agent: false }, res => {
      responded = true
      const buffers = []
      res.on('data', chunk => buffers.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(buffers).toString() }))
      res.on('error', reject)
    })
    clients.push(client)
    client.on('socket', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    client.on('error', error => { if (!responded) reject(error) })
    client.setTimeout(3000, () => client.destroy(new Error('未及时返回响应')))
    client.flushHeaders()
    for (const chunk of chunks) client.write(chunk)
    if (end) client.end()
  })
}
try {
  const sse = await fetch('http://127.0.0.1:' + server.port + '/sse', { signal: AbortSignal.timeout(3000) })
  const reader = sse.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\\n\\n')
  await reader.cancel()
  await Promise.race([sseAborted.promise, delay(1000).then(() => { throw new Error('SSE 断开未取消服务端请求') })])
  checks.push('SSE 首帧无需等流结束，断开会取消服务端请求')
  const normal = await send('/echo?ok=1', { headers: { cookie: 'portal=fixture', 'x-marker': 'value' }, chunks: ['{"a":', '1}'] })
  assert.equal(normal.status, 200)
  const parsed = JSON.parse(normal.body)
  assert.equal(parsed.body, '{"a":1}')
  assert.equal(parsed.method, 'POST')
  assert.equal(parsed.cookie, 'portal=fixture')
  assert.equal(parsed.marker, 'value')
  assert.equal(parsed.url, 'http://127.0.0.1:' + server.port + '/echo?ok=1')
  assert.equal(normal.headers['set-cookie'].length, 2)
  checks.push('正常分块正文、请求头、URL 与独立 Cookie')

  const get = await send('/echo', { method: 'GET' })
  assert.equal(JSON.parse(get.body).body, '')
  const head = await send('/echo', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  checks.push('GET 与 HEAD 不构造正文')

  const empty = await send('/echo')
  assert.equal(JSON.parse(empty.body).body, '')
  checks.push('空 POST 可正常结束')

  const busy = await send('/busy', { chunks: ['first chunk'], end: false })
  assert.equal(busy.status, 503)
  assert.equal(JSON.parse(busy.body).reason, '队列已满')
  checks.push('上传未结束即可收到完整 503')

  const suspended = send('/held', { chunks: Array(16).fill(Buffer.alloc(256 * 1024)), end: false })
  await Promise.race([held.promise, delay(1500).then(() => { throw new Error('处理器等待了完整上传') })])
  await delay(50)
  assert.equal(bufferedBytes, 0)
  release.resolve()
  assert.equal((await suspended).status, 503)
  checks.push('处理器等待时桥接层不预读 4 MiB 正文')

  const declared = await send('/limited', { headers: { 'content-length': String(MAX_BODY_BYTES + 1) }, chunks: ['x'], end: false })
  assert.equal(declared.status, 413)
  assert.equal(JSON.parse(declared.body).reason, BODY_TOO_LARGE_REASON)
  checks.push('超限 Content-Length 无需读完即可返回 413')

  const chunked = await send('/limited', { chunks: Array(33).fill(Buffer.alloc(1024 * 1024, 32)), end: false })
  assert.equal(chunked.status, 413)
  assert.equal(JSON.parse(chunked.body).reason, BODY_TOO_LARGE_REASON)
  assert.equal(limitedCalls, 0)
  checks.push('chunked 超 32 MiB 后无需结束上传即可返回 413')

  const timed = await send('/api/v1/token-usage', { chunks: ['x'], end: false })
  assert.equal(timed.status, 408)
  assert.equal(JSON.parse(timed.body).reason, BODY_READ_TIMEOUT_REASON)
  const following = await send('/api/v1/token-usage', { chunks: ['{"after":true}'] })
  assert.equal(following.status, 200)
  assert.deepEqual(JSON.parse(following.body), { after: true })
  checks.push('正文超时完整返回408并允许下一请求正常解析')

  const failure = await send('/throws', { chunks: ['x'], end: false })
  assert.equal(failure.status, 500)
  assert.equal(JSON.parse(failure.body).reason, '服务内部错误: 测试失败')
  assert.equal((await send('/echo', { method: 'GET' })).status, 200)
  checks.push('未消费正文的异常仍返回 JSON，随后请求正常')
  console.log(JSON.stringify(checks))
} catch (error) {
  console.error('失败前已通过：', checks)
  throw error
} finally {
  release.resolve()
  for (const client of clients) client.destroy()
  for (const socket of sockets) socket.destroy()
  await server.stop()
  IncomingMessage.prototype.emit = originalEmit
}
`)
    const built = await Bun.build({ entrypoints: [entry], outdir: dir, target: 'node', format: 'esm', naming: '[name].mjs' })
    expect(built.success).toBe(true)
    if (!built.success) throw new Error(built.logs.join('\n'))
    const child = spawnSync(node!, [join(dir, 'probe.mjs')], {
      env: cleanChildEnv(), encoding: 'utf8', windowsHide: true, timeout: 15_000,
    })
    if (child.status !== 0) throw new Error(child.error?.message ?? child.stdout + child.stderr)
    expect(JSON.parse(child.stdout)).toEqual([
      'SSE 首帧无需等流结束，断开会取消服务端请求',
      '正常分块正文、请求头、URL 与独立 Cookie',
      'GET 与 HEAD 不构造正文',
      '空 POST 可正常结束',
      '上传未结束即可收到完整 503',
      '处理器等待时桥接层不预读 4 MiB 正文',
      '超限 Content-Length 无需读完即可返回 413',
      'chunked 超 32 MiB 后无需结束上传即可返回 413',
      '正文超时完整返回408并允许下一请求正常解析',
      '未消费正文的异常仍返回 JSON，随后请求正常',
    ])
  } finally {
    if (!resolve(dir).startsWith(join(resolve(tmpdir()), 'atr-node-stream-'))) throw new Error('临时目录超出测试边界')
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
