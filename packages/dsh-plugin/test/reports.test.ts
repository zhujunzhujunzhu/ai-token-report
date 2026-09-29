/**
 * 上报调试路由（`/api/tokenReport.reports`）的契约。
 *
 * 这条路由单独存在的原因见 `src/reports.ts`；这里钉住的是它**容易悄悄坏掉**的四点：
 *
 * 1. **形状**：`stats.outbox` 是嵌套的（与 `ReporterStats` 同形），
 *    页面读的就是这个形状 —— 扁平化过一次就会静默显示 0。
 * 2. **凭证边界**：请求体里**只有 payload**，不许出现请求头。
 * 3. **「立即上报」不能挂死**：宿主 `flush()` 等服务端超时可能几十秒，
 *    而用户点的是按钮。超时必须**如实返回 ok:true + 说明**（投递还在后台跑），
 *    不能让前端把一次仍在进行的上报显示成失败。
 * 4. **405 / 坏 JSON 走业务字段**：DSH 的 `/api` 面没有中间件兜底。
 */
import { expect, test } from 'bun:test'

import { emptyBackfillStats } from '../src/backfill-runner.js'
import { resolveConfig } from '../src/config.js'
import type { ReportAttempt } from '../src/report-log.js'
import { createReportsHandler, toReportsPayload, type ReportsHost } from '../src/reports.js'
import type { ReporterStats } from '../src/reporter.js'

function stats(over: Partial<ReporterStats> = {}): ReporterStats {
  return {
    enqueued: 12,
    delivered: 10,
    duplicates: 1,
    rejected: 1,
    queueLength: 2,
    requests: 3,
    failures: 1,
    lastSuccessAt: 1_700_000_000_000,
    lastError: 'HTTP 500',
    outbox: { pendingBatches: 2, pendingRecords: 4, pendingBytes: 2048, droppedBatches: 1 },
    ...over,
  }
}

function attempt(over: Partial<ReportAttempt> = {}): ReportAttempt {
  return {
    at: 1_700_000_000_000, ok: true, source: 'queue', records: 2, bytes: 64,
    accepted: 2, duplicates: 0, rejected: 0, httpStatus: 200, error: null,
    payload: '{"records":[]}', truncated: false,
    ...over,
  }
}

function host(over: Partial<ReportsHost> = {}): ReportsHost {
  return {
    config: () => resolveConfig({ name: '本地开发', appKey: 'secret-appkey' }),
    status: () => ({ enabled: true, endpoint: 'http://127.0.0.1:8787/api/v1/token-usage' }),
    identity: () => ({ name: '张三', group: '研发一部' }),
    stats: () => stats(),
    backfillStats: () => ({ ...emptyBackfillStats(), status: 'complete', filesTotal: 3, filesProcessed: 3, confirmed: 9 }),
    attempts: () => [attempt()],
    flush: async () => {},
    preview: () => ({ ok: true, body: '{"records":[]}', records: 2, source: 'queue' }),
    ...over,
  }
}

test('GET 搬出完整形状：嵌套 outbox / 实录 / 补报进度', async () => {
  const response = await createReportsHandler(host())(new Request('http://x/api/tokenReport.reports'))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json() as Record<string, any>
  expect(body['reporting']).toMatchObject({ enabled: true })
  expect(body['flushIntervalMillis']).toBe(resolveConfig({}).batch.flushIntervalMillis)
  expect(body['maxRecords']).toBe(resolveConfig({}).batch.maxRecords)
  expect(body['identity']).toEqual({ name: '张三', group: '研发一部' })
  expect(body['stats']['outbox']).toEqual({
    pendingBatches: 2, pendingRecords: 4, pendingBytes: 2048, droppedBatches: 1,
  })
  expect(body['backfill']).toMatchObject({ status: 'complete', confirmed: 9 })
  expect(body['recent']).toHaveLength(1)
})

test('未装配上报时 stats 为 null，页面照样能渲染（不能整条路由失败）', async () => {
  const html = await createReportsHandler(host({
    stats: () => null,
    status: () => ({ enabled: false, endpoint: '', reason: '尚未署名' }),
  }))(new Request('http://x/i')).then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(html['stats']).toBeNull()
  expect(html['reporting']).toMatchObject({ enabled: false, reason: '尚未署名' })
})

test('🚨 凭证边界：响应体里绝不出现请求头 / Bearer / appKey', async () => {
  const text = await createReportsHandler(host())(new Request('http://x/i')).then((r) => r.text())
  expect(text).not.toContain('secret-appkey')
  expect(text.toLowerCase()).not.toContain('authorization')
  expect(text.toLowerCase()).not.toContain('bearer')
  expect(text).not.toContain('headers')
})

test('POST preview：回请求体原文 + 字节数，且**不发送**', async () => {
  let flushed = 0
  const response = await createReportsHandler(host({ flush: async () => { flushed += 1 } }))(
    new Request('http://x/i', { method: 'POST', body: JSON.stringify({ action: 'preview' }) }),
  )
  const body = await response.json() as Record<string, any>
  expect(body['ok']).toBe(true)
  expect(body['preview']).toMatchObject({ records: 2, source: 'queue' })
  // 中文也算准（byteLength 而不是 length）
  expect(body['preview']['bytes']).toBe(Buffer.byteLength('{"records":[]}'))
  expect(flushed).toBe(0)
})

test('preview 不可用时回 ok:false + 原因', async () => {
  const body = await createReportsHandler(host({
    preview: () => ({ ok: false, reason: '没有待投递的记录', records: 0 }),
  }))(new Request('http://x/i', { method: 'POST', body: JSON.stringify({ action: 'preview' }) }))
    .then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(body).toEqual({ ok: false, reason: '没有待投递的记录' })
})

test('POST flush：等服务端回执，成功即 ok:true', async () => {
  let flushed = 0
  const body = await createReportsHandler(host({ flush: async () => { flushed += 1 } }))(
    new Request('http://x/i', { method: 'POST', body: JSON.stringify({ action: 'flush' }) }),
  ).then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(flushed).toBe(1)
  expect(body).toEqual({ ok: true })
})

test('★ POST flush 超时：不许把仍在进行的上报报成失败', async () => {
  const started = Date.now()
  const body = await createReportsHandler(
    // 服务端不可达 → flush 要等到连接超时（几十秒）
    host({ flush: () => new Promise(() => {}) }),
    { flushTimeoutMs: 20 },
  )(new Request('http://x/i', { method: 'POST', body: JSON.stringify({ action: 'flush' }) }))
    .then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(body['ok']).toBe(true)
  expect(String(body['reason'])).toContain('稍后')
})

test('未知动作 / 坏 JSON / 不支持的方法都走业务字段', async () => {
  const handler = createReportsHandler(host())
  const unknown = await handler(new Request('http://x/i', { method: 'POST', body: JSON.stringify({ action: 'nope' }) }))
    .then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(String(unknown['reason'])).toContain('nope')

  const broken = await handler(new Request('http://x/i', { method: 'POST', body: '{' }))
    .then((r) => r.json() as Promise<Record<string, unknown>>)
  expect(broken['ok']).toBe(false)

  const deleted = await handler(new Request('http://x/i', { method: 'DELETE' }))
  expect(deleted.status).toBe(405)
  expect(await deleted.json()).toMatchObject({ ok: false })
})

test('toReportsPayload 直接可用（路由之外也复用同一份组装）', () => {
  const payload = toReportsPayload(host())
  expect(payload.maxRecords).toBeGreaterThan(0)
  expect(payload.outboxEnabled).toBeTypeOf('boolean')
  expect(payload.recent[0]?.httpStatus).toBe(200)
})