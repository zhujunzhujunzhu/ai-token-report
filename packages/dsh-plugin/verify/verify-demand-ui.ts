/**
 * 真浏览器按需取数验收：真实 lib/client.js + React 模块表 + 纯合成 HTTP 数据。
 *
 * bun run packages/dsh-plugin/verify/verify-demand-ui.ts
 * 打开打印的本机地址，依次操作详情、明细下一页、会话、今年、图表数据及下一页、关闭。
 * bun run packages/dsh-plugin/verify/verify-demand-ui.ts --check http://127.0.0.1:<port>
 *
 * 不读取 DSH_HOME、身份或真实日志；只监听 loopback。浏览器观察与请求记录留在服务内存。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { createUiStatsProvider, makeStatsFetch } from '../src/ui-bridge.js'
import type { UsageQuery, UsageResult } from '../src/stats.js'
import type { UiPayload } from '../src/client/protocol.js'

if (process.argv[2] === '--check') {
  const base = process.argv[3]
  if (!base) throw new Error('缺少待验收的本机 fixture 地址')
  const url = new URL(base)
  if (url.hostname !== '127.0.0.1') throw new Error('此验证只检查 loopback fixture')
  const state = await fetch(new URL('/__verify/state', url)).then(res => res.json()) as { checks: Record<string, boolean> }
  for (const [name, passed] of Object.entries(state.checks)) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  process.exit(Object.values(state.checks).every(Boolean) ? 0 : 1)
}

const pkgDir = resolve(import.meta.dir, '..')
const repoDir = resolve(pkgDir, '../..')
const require = createRequire(join(pkgDir, 'package.json'))
const total = 10_000_000_000

function sample(query: UsageQuery): UsageResult {
  const dims: NonNullable<UsageQuery['by']> = query.by ?? ['provider-model']
  const groups = query.summaryOnly ? [] : dims.map(by => {
    const count = by === 'session' ? 1000 : by === 'provider-model' ? 25 : by === 'provider' ? 5 : 20
    const rows = Array.from({ length: count }, (_, index) => ({ key: `${by}-${String(index + 1).padStart(4, '0')}`,
      total: total / count, input: 0, output: 0, cacheRead: total / count, cacheWrite: 0,
      calls: 1000 / count, sessions: 1000 / count, cacheHitRate: 1 }))
    return { by, rowCount: count, rows: rows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.top ?? count)) }
  })
  const points = query.series === 'hour' ? 24 : 100
  return {
    source: 'local-db', rangeLabel: query.period === 'year' ? '今年（合成样例）' : '今天（合成样例）',
    range: { since: 0, until: 1 },
    totals: { total, input: 0, output: 0, cacheRead: total, cacheWrite: 0, reasoning: 0, calls: 1000 },
    metrics: { total, cacheHitRate: 1, cacheLeverage: 0, avgTokensPerCall: 10_000_000 },
    groups, sessions: 1000, elapsedMs: 0, scannedAt: Date.now(),
    ...(!query.summaryOnly && query.series ? { series: Array.from({ length: points }, (_, index) => {
      const value = Math.floor(total / points) + (index === points - 1 ? total % points : 0)
      const calls = Math.floor(1000 / points) + (index === points - 1 ? 1000 % points : 0)
      return { bucket: query.series === 'hour' ? `2026-09-26T${String(index).padStart(2, '0')}`
        : new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
        total: value, input: 0, output: 0, cacheRead: value, calls, cacheHitRate: 1 }
    }) } : {}),
  }
}

const queries: UsageQuery[] = []
const stats = makeStatsFetch(createUiStatsProvider({ generation: () => 1, run: async query => {
  queries.push(query)
  return sample(query)
} }))
const requests: { url: string; view?: string; by?: string; page?: number; rows: number; points: number; status: number }[] = []
interface Observation { dialog: boolean; rows: number; firstRow: string; chartRows: number; chartPage: string; error?: string }
const observations: Observation[] = []
const checks = (): Record<string, boolean> => ({
  '初始常驻入口只取摘要': requests[0]?.view === 'summary' && requests[0]?.rows === 0 && requests[0]?.points === 0,
  '打开详情只返回一个维度的十行': requests.some(r => r.view === 'detail' && r.by === 'provider-model' && r.page === 1 && r.rows === 10),
  '点击明细下一页请求第二页': requests.some(r => r.by === 'provider-model' && r.page === 2 && r.rows === 10),
  '第二页渲染第十一行而非再次切片': observations.some(o => o.dialog && o.rows === 10 && o.firstRow.includes('provider-model-0011')),
  '切会话维度重置为第一页': requests.some(r => r.by === 'session' && r.page === 1 && r.rows === 10),
  '图表折叠时不挂载精确值表': observations.some(o => o.dialog && o.rows === 10 && o.chartRows === 0),
  '展开长范围趋势精确值只挂载五十行': observations.some(o => o.chartRows === 50 && o.chartPage.includes('1 / 2')),
  '图表精确值可以翻到第二页': observations.some(o => o.chartRows === 50 && o.chartPage.includes('2 / 2')),
  '关闭详情恢复摘要请求': requests.filter(r => r.view === 'summary' && r.status === 200).length >= 2
    && observations.some(o => o.dialog) && observations.at(-1)?.dialog === false,
  '浏览器未报告运行错误': observations.every(o => !o.error),
})

await mkdir(join(repoDir, '.tmp'), { recursive: true })
const scratch = await mkdtemp(join(repoDir, '.tmp', 'dsh-demand-ui-'))
const entryPath = join(scratch, 'host.ts')
const entry = `
import * as React from ${JSON.stringify(require.resolve('react'))};
import * as ReactDOM from ${JSON.stringify(require.resolve('react-dom'))};
import * as JSXRuntime from ${JSON.stringify(require.resolve('react/jsx-runtime'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
const modules = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSXRuntime };
let last = '', timer;
const report = error => {
  const dialog = document.querySelector('.atr-dialog');
  const value = { dialog: !!dialog, rows: dialog?.querySelectorAll('.atr-row-detail').length ?? 0,
    firstRow: dialog?.querySelector('.atr-row-k')?.textContent ?? '',
    chartRows: dialog?.querySelectorAll('.atr-chart-table tbody tr').length ?? 0,
    chartPage: dialog?.querySelector('[aria-label="图表数据分页"]')?.textContent ?? '',
    ...(error ? {error} : {}) };
  const json = JSON.stringify(value);
  if (json === last) return;
  last = json;
  fetch('/__verify/observe', {method:'POST',headers:{'content-type':'application/json'},body:json});
};
window.addEventListener('error', event => report(event.message));
window.addEventListener('unhandledrejection', event => report(String(event.reason)));
window.__ModuleLoader__ = { load(entry) {
  const plugin = entry.factory(name => {
    if (!(name in modules)) throw Error('Unexpected platform module: '+name);
    return modules[name];
  });
  const root = createRoot(document.getElementById('plugin'));
  const cleanup = [];
  plugin.apply({ slots: { inject: (_name, callback) => callback(),
    register: (options, Component) => { root.render(React.createElement(Component,options.inject()));return () => root.unmount(); } },
    effect: fn => { const dispose = fn(); if(dispose) cleanup.push(dispose); },
    logger: {info: console.info, warn: console.warn},
  }).catch(error => report(String(error)));
  window.addEventListener('pagehide', () => { root.unmount();cleanup.forEach(fn => fn()); });
  new MutationObserver(() => { clearTimeout(timer);timer=setTimeout(() => report(),80); }).observe(document.getElementById('app'), {childList:true,subtree:true});
  // 插件详情通过 portal 挂到 body，因此单独观察浮层内部 DOM。
  new MutationObserver(() => { clearTimeout(timer);timer=setTimeout(() => report(),80); }).observe(document.body, {childList:true,subtree:true});
}};
const script=document.createElement('script');script.src='/client.js';document.head.append(script);
`
await writeFile(entryPath, entry)
const build = await Bun.build({ entrypoints: [entryPath], target: 'browser', format: 'esm',
  minify: true, define: { 'process.env.NODE_ENV': JSON.stringify('production') } })
if (!build.success) throw new AggregateError(build.logs, 'fixture React 宿主构建失败')
const hostBundle = await build.outputs[0]!.text()
const clientBundle = await readFile(join(pkgDir, 'lib/client.js'), 'utf8')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 用量面板按需取数验收</title>
<style>body{font-family:Arial,sans-serif;margin:32px;background:#f4f6f9;color:#172033}main{max-width:1080px;margin:auto}h1{font-size:22px}p{line-height:1.7}a{color:#3655b3}:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#172033;--dsw-alias-label-secondary:#667085;--dsw-alias-border-l1:#e4e8ef}</style></head>
<body><main id="app"><h1>DSH 用量面板按需取数验收</h1><p>100 亿 token 合成数据 · 1,000 个会话 · 真实浏览器产物 · 未连接 DSH</p>
<p>依次操作：详情 → 明细下一页 → 会话 → 今年 → 查看图表数据 → 图表下一页 → 关闭详情。</p><div id="plugin"></div>
<p><a href="/__verify/state" target="_blank">查看验收记录</a></p></main><script type="module" src="/fixture-host.js"></script></body></html>`

const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env['ATR_VERIFY_UI_PORT'] ?? 0), idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    if (url.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (url.pathname === '/fixture-host.js') return new Response(hostBundle, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/client.js') return new Response(clientBundle, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/api/tokenReport.config') return Response.json({ position: 'dock' })
    if (url.pathname === '/api/tokenReport.stats') {
      const response = await stats(request)
      const body = response.status === 200 ? await response.clone().json() as UiPayload : undefined
      requests.push({ url: url.search, view: body?.view, by: body?.pagination?.by, page: body?.pagination?.page,
        rows: body?.groups.reduce((sum, group) => sum + group.rows.length, 0) ?? 0,
        points: body?.series?.length ?? 0, status: response.status })
      return response
    }
    if (url.pathname === '/__verify/observe' && request.method === 'POST') {
      observations.push(await request.json() as Observation)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/__verify/state') return Response.json({ checks: checks(), requests, queries, observations })
    return new Response('Not found', { status: 404 })
  },
})
console.log(`FIXTURE_URL=http://127.0.0.1:${server.port}`)
console.log(`STATE_URL=http://127.0.0.1:${server.port}/__verify/state`)
console.log(`SCRATCH_DIR=${scratch}`)
