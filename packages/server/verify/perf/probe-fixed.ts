/**
 * 性能摸底：**固定开销定位** —— handler 里 SQL 只占 2.6ms，为什么 `/api/health`
 * 要 77ms？
 *
 * ```bash
 * bun run packages/server/verify/perf/probe-fixed.ts
 * ```
 *
 * 逐层加东西，每层量一次，差值就是那一层的成本：
 *
 * | 层 | 加了什么 |
 * |---|---|
 * | 1 | 裸 `Hono` + 一个返回 JSON 的路由 |
 * | 2 | + `requestId()` |
 * | 3 | + `secureHeaders()` |
 * | 4 | + `requestBodyLimit()` |
 * | 5 | + `staticOnly(compress())` + `staticOnly(etag())` |
 * | 6 | + `methodNotAllowed()`（要读 Hono 路由表） |
 * | 7 | + 真实 `createHandlerFor()` 的 `/api/health` |
 *
 * ★ 这一步是把「该优化什么」钉死的关键：如果 1 层自己就要 60ms，那是运行时的
 *   本底开销，与数据库毫无关系；如果某层一加就涨 200ms，那就是那一层的问题。
 */
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { compress } from 'hono/compress'
import { etag } from 'hono/etag'
import { methodNotAllowed } from 'hono/method-not-allowed'

import { createHandlerFor } from '../../src/index.js'

function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}

const REPEATS = Number(process.env['ATR_PERF_REPEATS'] ?? 50)

async function measure(name: string, handler: (request: Request) => Promise<Response>): Promise<number> {
  const send = async (): Promise<void> => {
    const response = await handler(new Request('http://127.0.0.1/api/health'))
    await response.text()
  }
  for (let index = 0; index < 10; index++) await send()
  const timings: number[] = []
  for (let index = 0; index < REPEATS; index++) {
    const started = performance.now()
    await send()
    timings.push(performance.now() - started)
  }
  const p50 = percentile(timings, 0.5)
  console.log(`  ${name.padEnd(46)} p50=${p50.toFixed(2).padStart(8)}ms p95=${percentile(timings, 0.95).toFixed(2).padStart(8)}ms`)
  return p50
}

const results: Record<string, number> = {}
results['1 裸 Hono + 一条 JSON 路由'] = await measure('1 裸 Hono + 一条 JSON 路由', async () => {
  const app = new Hono()
  app.get('/api/health', (c) => c.json({ ok: true }))
  return app.fetch(new Request('http://127.0.0.1/api/health'))
})

{
  const app = new Hono()
  app.use('*', requestId())
  app.get('/api/health', (c) => c.json({ ok: true }))
  results['2 + requestId()'] = await measure('2 + requestId()', (request) => app.fetch(request))
}
{
  const app = new Hono()
  app.use('*', requestId())
  app.use('*', secureHeaders())
  app.get('/api/health', (c) => c.json({ ok: true }))
  results['3 + secureHeaders()'] = await measure('3 + secureHeaders()', (request) => app.fetch(request))
}
{
  const app = new Hono()
  app.use('*', requestId())
  app.use('*', secureHeaders())
  app.use('*', methodNotAllowed({ app }))
  app.get('/api/health', (c) => c.json({ ok: true }))
  results['4 + methodNotAllowed()'] = await measure('4 + methodNotAllowed()', (request) => app.fetch(request))
}
{
  const app = new Hono()
  app.use('*', requestId())
  app.use('*', secureHeaders())
  app.use('*', compress())
  app.use('*', etag())
  app.use('*', methodNotAllowed({ app }))
  app.get('/api/health', (c) => c.json({ ok: true }))
  results['5 + compress() + etag()'] = await measure('5 + compress() + etag()', (request) => app.fetch(request))
}

const home = `${process.cwd()}/.artifacts/perf/fixed-home`
const bundle = await createHandlerFor({
  dshHome: home, dataDir: `${home}/data`, dbPath: `${home}/portal.sqlite`,
  adminToken: 'placeholder-not-used-for-health',
  adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
})
try {
  // MySQL 未配置 → 走本机 SQLite 端口库；只测 /api/health，不触碰统计。
  results['6 真实 createHandlerFor() 的 /api/health'] = await measure(
    '6 真实 createHandlerFor() 的 /api/health',
    (request) => bundle.handler(request),
  )
} finally {
  await bundle.close()
}

console.log('\n逐层差值（固定开销的归属）：')
const keys = Object.keys(results)
for (let index = 0; index < keys.length; index++) {
  const current = results[keys[index]!]!
  const previous = index === 0 ? 0 : results[keys[index - 1]!]!
  console.log(`  ${keys[index]!.padEnd(46)} ${current.toFixed(2).padStart(8)}ms  (Δ ${(current - previous).toFixed(2)}ms)`)
}
