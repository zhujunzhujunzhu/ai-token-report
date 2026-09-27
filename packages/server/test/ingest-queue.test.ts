/** 队列护栏与真实 handler 回归：排队绝不提前确认，超载不读 body，撤权不被旧任务绕过。 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IngestQueue, IngestQueueUnavailable } from '../src/ingest-queue.js'
import { createHandlerFor, type HandlerBundle } from '../src/index.js'
import { MEMBER_ROLE_ID } from '../src/identity/index.js'
import type { IngestQueueStatusResponse } from '@ai-token-report/shared'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('上报有界异步队列', () => {
  test('FIFO、执行中也占容量、完成前不确认，任务之间不并发', async () => {
    const queue = new IngestQueue({ maxRequests: 2 })
    const gate = deferred(), started = deferred(), order: number[] = []
    let acknowledged = false
    const first = queue.run(async () => { started.resolve(); order.push(1); await gate.promise; order.push(2) }).then(() => { acknowledged = true })
    await started.promise
    const second = queue.run(async () => { order.push(3) })
    await expect(queue.run(async () => { order.push(4) })).rejects.toBeInstanceOf(IngestQueueUnavailable)
    expect(acknowledged).toBe(false)
    expect(queue.snapshot()).toMatchObject({ active_requests: 1, waiting_requests: 1, rejected_requests: 1 })
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2, 3])
    expect(queue.snapshot()).toMatchObject({ active_requests: 0, waiting_requests: 0, completed_requests: 2 })
    await queue.close()
  })

  test('超时只删除等待任务，不取消正在执行的事务，也不在之后补执行', async () => {
    const queue = new IngestQueue({ maxWaitMs: 30 })
    const gate = deferred(), started = deferred()
    const first = queue.run(async () => { started.resolve(); await gate.promise })
    await started.promise
    let ran = false
    await expect(queue.run(async () => { ran = true })).rejects.toThrow('排队超时')
    expect(queue.snapshot().active_requests).toBe(1)
    gate.resolve()
    await first
    await queue.close()
    expect(ran).toBe(false)
  })

  test('任务失败释放容量，停机排空并拒绝新任务，可重复关闭', async () => {
    const queue = new IngestQueue()
    const bad = queue.run(async () => { throw new Error('写入失败') })
    const good = queue.run(async () => {})
    const closed = queue.close()
    expect(queue.close()).toBe(closed)
    await expect(queue.run(async () => {})).rejects.toThrow('正在停止')
    await expect(bad).rejects.toThrow('写入失败')
    await good
    await closed
    expect(queue.snapshot()).toMatchObject({ accepting: false, active_requests: 0, waiting_requests: 0, completed_requests: 2 })
  })

  test('错误配置启动即失败，防止静默无限队列或定时器溢出', () => {
    for (const value of [0, -1, NaN, 1.5, Infinity, 2 ** 32]) {
      expect(() => new IngestQueue({ maxRequests: value })).toThrow()
      expect(() => new IngestQueue({ maxWaitMs: value })).toThrow()
    }
  })
})

const fixtures: { root: string; bundle: HandlerBundle }[] = []
afterEach(async () => {
  for (const { root, bundle } of fixtures.splice(0)) {
    await bundle.close()
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture(maxRequests = 64, maxWaitMs = 30_000) {
  const root = mkdtempSync(join(tmpdir(), 'atr-ingest-queue-'))
  const bundle = await createHandlerFor({ dshHome: root, dbPath: join(root, 'portal.sqlite'), mysqlUrl: '', adminToken: 'queue-test-admin', requestLog: false, ingestQueue: { maxRequests, maxWaitMs } })
  fixtures.push({ root, bundle })
  const repo = bundle.identityStore!
  const admin = (await repo.resolveBearer('queue-test-admin'))!
  const { member } = await repo.createMember(admin, { name: '队列测试成员', role_ids: [MEMBER_ROLE_ID] })
  const key = await repo.issueAppKey(admin, { member_id: member.member_id })
  const request = (path: string, method = 'GET', token = 'queue-test-admin', body?: string) => bundle.handler(new Request(`http://localhost${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }),
  }))
  return { bundle, repo, admin, member, key, request }
}

const payload = JSON.stringify({ schemaVersion: 1, records: [{
  event_id: 'queue:1', session_id: 'queue', seq: 1, ts: Date.now(), provider: 'test', model: 'test',
  input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, reasoning_tokens: 0, total_tokens: 100,
}] })

describe('上报队列 HTTP 契约', () => {
  test('超载503 + Retry-After，JSON解析前拒绝，健康检查和管理查询仍可用', async () => {
    const { bundle, request } = await fixture(1)
    const gate = deferred(), started = deferred()
    const busy = bundle.ingestQueue.run(async () => { started.resolve(); await gate.promise })
    await started.promise
    try {
      const response = await request('/api/v1/token-usage', 'POST', 'queue-test-admin', 'not-json')
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('1')
      expect(await response.json()).toMatchObject({ ok: false })
      expect((await request('/api/health')).status).toBe(200)
      const state = await request('/api/v1/admin/ingest-status')
      expect(state.headers.get('cache-control')).toBe('no-store')
      expect(await state.json()).toMatchObject({ active_requests: 1, rejected_requests: 1, scope: 'process' })
    } finally { gate.resolve(); await busy }
  })

  test('监控遵守401/403及真实405，不向appKey暴露管理接口', async () => {
    const { request, key } = await fixture()
    expect((await request('/api/v1/admin/ingest-status', 'GET', 'bad')).status).toBe(401)
    expect((await request('/api/v1/admin/ingest-status', 'GET', key.token_secret)).status).toBe(403)
    const wrongMethod = await request('/api/v1/admin/ingest-status', 'POST')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
  })

  test('等待中的上报在撤权后失败，不信任排队前的身份快照', async () => {
    const { bundle, repo, admin, member, key, request } = await fixture()
    const gate = deferred(), started = deferred()
    const busy = bundle.ingestQueue.run(async () => { started.resolve(); await gate.promise })
    await started.promise
    const pending = request('/api/v1/token-usage', 'POST', key.token_secret, payload)
    try {
      await repo.revokeToken(admin, { member_id: member.member_id, token_id: key.token.token_id, expected_version: key.token.version })
    } finally { gate.resolve(); await busy }
    expect((await pending).status).toBe(401)
    expect(await (await request('/api/v1/stats/overview')).json()).toMatchObject({ calls: 0 })
  })

  test('成功ACK后马上可查；重投精确去重；handler关闭排空后不再接收', async () => {
    const { bundle, request, key } = await fixture()
    const submitted = await request('/api/v1/token-usage', 'POST', key.token_secret, payload)
    expect(submitted.status).toBe(200)
    expect(await submitted.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    expect(await (await request('/api/v1/stats/overview')).json()).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100 })
    expect(await (await request('/api/v1/token-usage', 'POST', key.token_secret, payload)).json()).toEqual({ accepted: 0, duplicates: 1, rejected: 0 })
    await bundle.close()
    expect((await request('/api/v1/token-usage', 'POST', key.token_secret, payload)).status).toBe(503)
    const status = await (await request('/api/v1/admin/ingest-status')).json() as IngestQueueStatusResponse
    expect(status).toMatchObject({ accepting: false, completed_requests: 2, active_requests: 0 })
  })
})
