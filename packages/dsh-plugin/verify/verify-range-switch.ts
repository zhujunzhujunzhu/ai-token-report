/** 固定日志副本上比较直扫与增量库的范围切换；真 Node、真实发布模块，不写用户日志/数据库。 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const args = process.argv.slice(2)
assert.equal(args.length, 2, '用法：bun run packages/dsh-plugin/verify/verify-range-switch.ts --sessions-root <日志目录>')
assert.equal(args[0], '--sessions-root')
const node = resolveNodeBin()
assert.ok(node, '需要真实 Node')
const parent = realpathSync.native(tmpdir())
const work = mkdtempSync(join(parent, 'atr-range-switch-'))
try {
  const sessionsRoot = join(work, 'sessions')
  cpSync(resolve(args[1]!), sessionsRoot, { recursive: true })
  mkdirSync(join(work, 'db'))
  writeFileSync(join(work, 'fixture.json'), JSON.stringify({ sessionsRoot,
    dbPath: join(work, 'db/usage.sqlite'),
    moduleUrl: pathToFileURL(resolve(import.meta.dir, '../lib/index.js')).href }))
  writeFileSync(join(work, 'runner.mjs'), String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.equal(typeof globalThis.Bun, 'undefined');
const f = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const { queryUsage, createUiStatsProvider } = await import(f.moduleUrl);
const periods = ['today', 'yesterday', 'week', 'last7d', 'month', 'last30d', 'year'];
const results = {};
const timings = {};
for (const localDb of [false, true]) {
  const label = localDb ? 'indexed' : 'scan';
  const ctx = { ...f, config: { localDb }, backgroundQueries: true };
  const provider = createUiStatsProvider({ run: query => queryUsage(ctx, query) });
  const at = performance.now();
  const first = await provider.get('today', false, undefined, { view: 'summary' });
  assert.ok(first.totals, first.error);
  const firstSummaryMs = performance.now() - at;
  const switches = [];
  for (const period of periods) {
    const start = performance.now();
    const data = await provider.get(period, false, undefined, { view: 'detail', by: 'provider-model', page: 1, pageSize: 10 });
    const ms = performance.now() - start;
    assert.ok(data.totals, data.error);
    assert.equal(data.source, localDb ? 'local-db' : 'scan', data.degradedReason);
    const comparable = { totals: data.totals, metrics: data.metrics, sessions: data.sessions,
      groups: data.groups, series: data.series, pagination: data.pagination };
    if (!localDb) results[period] = comparable;
    else assert.deepEqual(comparable, results[period], period + ' SQL/直扫对账');
    switches.push({ period, ms: Math.round(ms * 100) / 100, calls: data.totals.calls, total: data.totals.total });
  }
  timings[label] = { firstSummaryMs: Math.round(firstSummaryMs), switches };
}
console.log(JSON.stringify({ node: process.version, timings, parity: '全部范围总计/指标/会话/分组/趋势/分页一致' }, null, 2));
`)
  const child = Bun.spawn([node, join(work, 'runner.mjs')], { env: cleanChildEnv(), stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 180_000)
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    assert.equal(code, 0, err || out)
    process.stdout.write(out)
  } finally { clearTimeout(timeout) }
} finally {
  const actual = realpathSync.native(work)
  assert.equal(dirname(actual), parent)
  assert.ok(basename(actual).startsWith('atr-range-switch-'))
  rmSync(actual, { recursive: true, force: true })
}
