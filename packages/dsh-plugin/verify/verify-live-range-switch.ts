/**
 * 将正在运行的 DSH 所提供的浏览器产物接回其真实 HTTP 接口，验证范围切换的完整取数链。
 * DOM/slot 仅模拟装配；产物、状态机、配置和统计响应均为真实版本，不冒充浏览器绘制测试。
 * 使用现有启动日志完成正常本机鉴权，不输出登录地址或 Cookie，不修改日志、身份或上报配置。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JSXRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UsageStore } from '../src/client/store.js'
import type { ClientContext, ClientDeps } from '../src/client/index.js'
import { UI_PERIODS, type UiPayload } from '../src/client/protocol.js'
import { UsageDetail } from '../src/client/components.js'

const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--startup-log',
  '用法：bun run packages/dsh-plugin/verify/verify-live-range-switch.ts --startup-log <DSH启动日志>')
const log = readFileSync(args[1]!, 'utf8')
const match = log.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s]+/)
assert.ok(match, '启动日志缺少本机 DSH 登录地址')
const address = new URL(match[0])
const auth = await fetch(address, { redirect: 'manual', proxy: '', signal: AbortSignal.timeout(5000) })
const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
await auth.body?.cancel()
assert.ok(cookie, '现有登录地址已失效，请使用当前 DSH 的启动日志')

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  const url = new URL(path, address)
  assert.equal(url.origin, address.origin, '只允许向当前本机 DSH 请求')
  return fetch(url, { headers: { cookie }, proxy: '', signal: signal ?? AbortSignal.timeout(10_000) })
}
const page = await request('/')
assert.equal(page.status, 200)
const html = await page.text()
const row = html.match(/"id":"dsh-plugin-token-report","url":"([^"]+)"/)
assert.ok(row, '当前页面未装配 token 插件')
const response = await request(row[1]!)
assert.equal(response.status, 200)
const code = await response.text()
let registered: { id: string; factory(require: (id: string) => unknown): { apply(ctx: ClientContext, deps: ClientDeps): Promise<void> } } | undefined
const listeners = new Set<() => void>()
const document = {
  visibilityState: 'visible',
  addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
runInNewContext(code, { window: { __ModuleLoader__: { load: (entry: typeof registered) => { registered = entry } } },
  document, URLSearchParams, AbortController, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval,
}, { timeout: 5000 })
assert.ok(registered)
assert.equal(registered.id, 'dsh-plugin-token-report')
const client = registered.factory(id => {
  if (id === 'react') return React
  if (id === 'react-dom') return ReactDOM
  if (id === 'react/jsx-runtime') return JSXRuntime
  throw new Error(`客户端出现未支持的依赖：${id}`)
})
let store: UsageStore | undefined
const cleanup: (() => void)[] = []
const urls: string[] = []
const received = new Map<string, UiPayload>()
const checks: { name: string; ms: number; requests: number }[] = []
await client.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register(options) {
      const current = options.inject!()['usage'] as UsageStore
      assert.ok(!store || store === current, '所有挂载点必须共用一次取数')
      store = current
      return () => {}
    },
  },
  effect(callback) { const off = callback(); if (off) cleanup.push(off) },
}, { fetch: async (url, init) => {
  urls.push(url)
  const res = await request(url, init?.signal)
  if (url.includes('tokenReport.stats') && res.status === 200) {
    const payload = await res.clone().json() as UiPayload
    assert.ok(payload.totals, 'DSH 返回统计错误')
    received.set(url, payload)
  }
  return res
} })
assert.ok(store, '浏览器产物未注册用量 store')
const usage = store

async function ready(): Promise<void> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const state = usage.getSnapshot()
    assert.equal(state.error, undefined, state.error)
    if (!state.loading && !state.refreshing && state.data) return
    await Bun.sleep(1)
  }
  throw new Error('页面取数状态超过 10 秒仍未完成')
}
function checkView(period: string): void {
  const state = usage.getSnapshot()
  assert.equal(state.period, period)
  assert.equal(state.data?.period, period, '当前范围与展示数据不一致')
  assert.equal(state.data?.source, 'local-db', state.data?.degradedReason)
  assert.equal(state.refreshing, false)
  assert.equal(state.loading, false)
  const rendered = renderToStaticMarkup(React.createElement(UsageDetail, { state, store: usage }))
  assert.ok(rendered.includes(state.data!.rangeLabel), '渲染出的范围标签不一致')
  assert.ok(!rendered.includes('正在更新'), '取数结束后仍显示更新状态')
  assert.ok(rendered.includes('计费总量') && rendered.includes('用量明细'), '面板区块缺失')
}
async function measure(name: string, action: () => void, period: string): Promise<void> {
  const before = urls.length
  const at = performance.now()
  action()
  await ready()
  const ms = performance.now() - at
  checkView(period)
  checks.push({ name, ms: Math.round(ms * 100) / 100, requests: urls.length - before })
}

try {
  const unsubscribe = usage.subscribe(() => {})
  cleanup.push(unsubscribe)
  await ready()
  const release = usage.acquireDetails()
  cleanup.push(release)
  await ready()
  assert.equal(usage.getSnapshot().data?.view, 'detail')
  for (const { id } of UI_PERIODS.filter(p => p.id !== 'custom')) {
    await measure(`首次切换 ${id}`, () => usage.setPeriod(id), id)
  }
  for (const { id } of UI_PERIODS.filter(p => p.id !== 'custom')) {
    await measure(`缓存回切 ${id}`, () => usage.setPeriod(id), id)
    assert.equal(checks.at(-1)!.requests, 0, '有效范围缓存仍发起了请求')
  }
  for (const by of ['session', 'provider', 'project', 'provider-model'] as const) {
    await measure(`明细 ${by}`, () => usage.setDetail(by), 'year')
    assert.equal(usage.getSnapshot().data?.pagination?.by, by)
  }
  const range = { since: '2026-09-01', until: '2026-09-25' }
  await measure('自定义日期', () => usage.setCustomRange(range), 'custom')
  const custom = usage.getSnapshot().data
  await measure('离开自定义', () => usage.setPeriod('month'), 'month')
  await measure('回到自定义', () => usage.setCustomRange(range), 'custom')
  assert.equal(usage.getSnapshot().data, custom, '自定义范围未复用成功快照')
  assert.equal(checks.at(-1)!.requests, 0)
  await measure('手动刷新', () => usage.refresh(), 'custom')
  assert.ok(urls.at(-1)!.includes('refresh=1'), '手动刷新未绕过缓存')
  // 连续选中不同范围，只允许最后一个响应决定页面，随后仍能正常刷新。
  await measure('连续快速切换', () => {
    usage.setPeriod('today'); usage.setPeriod('week'); usage.setPeriod('year')
  }, 'year')
  await measure('快速切换后刷新', () => usage.refresh(), 'year')
  const last = usage.getSnapshot().data!
  const lastHttp = received.get(urls.at(-1)!)!
  assert.equal(JSON.stringify(last.totals), JSON.stringify(lastHttp.totals), '客户端四个原始 token 列改变')
  assert.equal(JSON.stringify(last.metrics), JSON.stringify(lastHttp.metrics), '客户端改变宿主指标')
  console.log(JSON.stringify({ checks, final: { source: last.source, calls: last.totals.calls, total: last.totals.total },
    coverage: '当前 DSH 提供的发布产物 → 状态机 → 真实鉴权 HTTP → 响应解析 → 详情组件静态渲染；不含浏览器布局绘制' }, null, 2))
} finally {
  usage.dispose()
  for (const off of cleanup.reverse()) off()
}
