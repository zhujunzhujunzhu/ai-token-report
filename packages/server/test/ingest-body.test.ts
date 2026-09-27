/** 上报正文阶段单独计时，超时释放消费者且不会留下后台写入。 */
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { connect } from 'node:net'
import { IngestQueue } from '../src/ingest-queue.js'
import { BODY_READ_TIMEOUT_REASON, BODY_TOO_LARGE_REASON, MAX_BODY_BYTES, readIngestBody, requestBodyLimit } from '../src/http/body.js'
import { fail } from '../src/http/envelope.js'

function fixture(timeoutMs = 40) {
  const app = new Hono(), queue = new IngestQueue({ maxWaitMs: 1000 })
  const accepted: unknown[] = []
  app.use('/api/v1/token-usage', async (_c, next) => { await queue.run(next) })
  app.use('*', requestBodyLimit())
  app.post('/api/v1/token-usage', async c => {
    const parsed = await readIngestBody(c, timeoutMs)
    if ('error' in parsed) return fail(parsed.error, parsed.status)
    accepted.push(parsed.value)
    return c.json({ accepted: 1, duplicates: 0, rejected: 0 })
  })
  app.post('/other', async c => c.text(await c.req.text()))
  const send = (body: BodyInit, headers?: HeadersInit) => app.request('http://localhost/api/v1/token-usage', {
    method: 'POST', body, headers,
  })
  return { app, queue, accepted, send }
}

test('不结束的正文得到408，排队的下一请求执行，关闭能完成且迟到正文不写入', async () => {
  const { queue, accepted, send } = fixture()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const slow = send(body)
  const next = send('{"after":true}')
  const closed = queue.close()
  const [first, second] = await Promise.all([slow, next, closed])
  expect(first.status).toBe(408)
  expect(await first.json()).toEqual({ ok: false, reason: BODY_READ_TIMEOUT_REASON })
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
  expect(body.locked).toBe(false)
  expect(cancelled).toBe(false)
  controller.enqueue(new TextEncoder().encode('{"late":true}'))
  controller.close()
  expect(accepted).toEqual([{ after: true }])
  expect(queue.snapshot()).toMatchObject({ active_requests: 0, waiting_requests: 0, completed_requests: 2, accepting: false })
})

test('间断发送不会重置正文的总时限', async () => {
  const { queue, send, accepted } = fixture(50)
  let timer: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    timer = setInterval(() => controller.enqueue(new TextEncoder().encode(' ')), 10)
  } }, { highWaterMark: 0 })
  try {
    expect((await send(body)).status).toBe(408)
    expect(accepted).toEqual([])
  } finally { clearInterval(timer); await queue.close() }
})

test('Content-Length 提前413且不读取正文，其他路径仍有全局上限', async () => {
  const { queue, send, app } = fixture()
  let reads = 0
  const body = new ReadableStream<Uint8Array>({ pull() { reads++ } }, { highWaterMark: 0 })
  const response = await send(body, { 'content-length': String(MAX_BODY_BYTES + 1) })
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ ok: false, reason: BODY_TOO_LARGE_REASON })
  expect(reads).toBe(0)
  const other = await app.request('http://localhost/other', { method: 'POST', body: 'x', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })
  expect(other.status).toBe(413)
  await queue.close()
})

test('chunked 累计超32MiB提前413，伪小Content-Length也不能绕过', async () => {
  const { queue, send, accepted } = fixture(2000)
  for (const headers of [{ 'transfer-encoding': 'chunked' }, { 'content-length': '1' }]) {
    let pulls = 0
    const chunk = new Uint8Array(1024 * 1024).fill(32)
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++
      controller.enqueue(chunk)
    } }, { highWaterMark: 0 })
    expect((await send(body, headers)).status).toBe(413)
    expect(pulls).toBe(33)
    expect(body.locked).toBe(false)
  }
  expect(accepted).toEqual([])
  await queue.close()
})

test('多字节JSON跨块正确解码，空正文与非法JSON仍为400', async () => {
  const { queue, send, accepted } = fixture()
  const bytes = new TextEncoder().encode('{"name":"中文😀"}')
  let offset = 0
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) controller.close()
    else controller.enqueue(bytes.slice(offset, ++offset))
  } }, { highWaterMark: 0 })
  expect((await send(body)).status).toBe(200)
  expect(accepted).toEqual([{ name: '中文😀' }])
  expect((await send('')).status).toBe(400)
  expect((await send('not-json')).status).toBe(400)
  await queue.close()
})

test('真实 Bun HTTP 的未结束上传收到408，之后请求仍可处理', async () => {
  const { app, queue } = fixture(40)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 2, fetch: app.fetch })
  const socket = connect(server.port!, '127.0.0.1')
  try {
    const response = await new Promise<string>((resolve, reject) => {
      let received = ''
      socket.setTimeout(1500, () => reject(new Error('Bun 没有提前返回408')))
      socket.on('error', reject)
      socket.on('data', chunk => {
        received += chunk.toString()
        if (received.includes(BODY_READ_TIMEOUT_REASON)) resolve(received)
      })
      socket.on('connect', () => socket.write('POST /api/v1/token-usage HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n'))
    })
    expect(response).toContain('408')
    expect(server.pendingRequests).toBe(0)
    const next = await fetch(`http://127.0.0.1:${server.port}/api/v1/token-usage`, { method: 'POST', body: '{}' })
    expect(next.status).toBe(200)
    await next.text()
    await queue.close()
  } finally { socket.destroy(); await server.stop(true); await queue.close() }
})
