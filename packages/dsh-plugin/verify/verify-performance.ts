/**
 * 可重复的本机面板压力验证：独立临时库 → 已构建插件 → 真实 Node Worker。
 * 默认 100 万事件、1 万连续会话、180 天，四列之和恰好 100 亿 token。
 *
 * 先构建：bun run --filter @ai-token-report/dsh-plugin build
 * 执行：bun run packages/dsh-plugin/verify/verify-performance.ts > performance.json
 * 小样本：追加 --records 10000 --sessions 100
 *
 * ★ 不读用户日志、身份或凭证；成功和失败都清理自己创建并核验过的临时目录。
 * 首次冷查询指新 Worker / 新派生索引，不代表操作系统磁盘缓存已清空。
 * 此脚本测查询与载荷序列化；空日志目录不用于测扫描吞吐或浏览器绘制。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openDatabaseForIngest } from '@ai-token-report/core/db'
import { computeTotal } from '@ai-token-report/shared'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const TOTAL = 10_000_000_000
const DAYS = 180
const DAY_MS = 86_400_000
const START = Date.UTC(2026, 0, 1)
const args = process.argv.slice(2)
const options = new Map<string, number>()
for (let i = 0; i < args.length; i++) {
  const key = args[i]!
  assert(key === '--records' || key === '--sessions', `未知参数：${key}`)
  const value = Number(args[++i])
  assert(Number.isSafeInteger(value) && value > 0, `${key} 必须为正整数`)
  assert(!options.has(key), `重复参数：${key}`)
  options.set(key, value)
}
const records = options.get('--records') ?? 1_000_000
const sessions = options.get('--sessions') ?? Math.min(10_000, records)
assert(sessions <= records, '会话数不能超过事件数')
assert(records <= TOTAL, '事件数不能超过总 token 数')
const modulePath = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/index.js')
const workerPath = join(dirname(modulePath), 'stats-worker.js')
assert(existsSync(modulePath) && existsSync(workerPath), '请先运行插件 build，宿主与 Worker 产物必须同时存在')
const nodeBin = resolveNodeBin()
assert(nodeBin, '找不到真实 Node，请设置 ATR_NODE_BIN 后重试')

interface Counts { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; calls: number }
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 })
const add = (target: Counts, source: Counts): void => {
  for (const key of Object.keys(target) as (keyof Counts)[]) target[key] += source[key]
}
const totals = zero()
const expectedSessions: Record<string, Counts> = {}
const daily: Record<string, Counts> = {}
const expectedGroupSizes = { 'provider-model': Math.min(sessions, 33), provider: Math.min(sessions, 3), project: Math.min(sessions, 100), session: sessions }
const tempParent = realpathSync(tmpdir())
const work = mkdtempSync(join(tempParent, 'atr-plugin-performance-'))
const dbPath = join(work, 'usage.sqlite')
const sessionsRoot = join(work, 'sessions')
mkdirSync(sessionsRoot)

function databaseBytes(): Record<string, number> {
  const files: Record<string, number> = {}
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix
    files[basename(file)] = existsSync(file) ? statSync(file).size : 0
  }
  return files
}

try {
  const seedStart = performance.now()
  const db = openDatabaseForIngest(dbPath)
  try {
    const statement = db.prepare(`INSERT INTO usage_event
      (event_id, session_id, seq, ts, provider, model, cwd,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    try {
      db.transaction(() => {
        let index = 0
        for (let session = 0; session < sessions; session++) {
          const id = `session-${String(session).padStart(8, '0')}`
          const count = Math.floor(records / sessions) + (session < records % sessions ? 1 : 0)
          const subtotal = zero()
          for (let seq = 0; seq < count; seq++, index++) {
            const total = Math.floor(TOTAL / records) + (index < TOTAL % records ? 1 : 0)
            const input = Math.floor(total * 0.01)
            const output = Math.floor(total * 0.005)
            const cacheWrite = Math.floor(total * 0.002)
            const usage = { input, output, cacheWrite, cacheRead: total - input - output - cacheWrite, reasoning: Math.floor(output / 3), calls: 1 }
            const time = START + Math.floor(index / records * DAYS * DAY_MS)
            statement.run([`${id}:${seq}`, id, seq, time, `provider-${session % 3}`, `model-${session % 11}`,
              `/synthetic/project-${session % 100}`, input, output, usage.cacheRead, cacheWrite, usage.reasoning])
            add(totals, usage)
            add(subtotal, usage)
            const day = new Date(time).toISOString().slice(0, 10)
            add(daily[day] ??= zero(), usage)
          }
          expectedSessions[id] = subtotal
        }
      })
    } finally { statement.finalize() }
    assert.equal(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM usage_event').get()!.n, records)
    assert.equal(computeTotal(totals), TOTAL)
  } finally { db.close() }
  const seedMs = performance.now() - seedStart
  const databaseBefore = databaseBytes()
  const configuration = { moduleUrl: pathToFileURL(modulePath).href, dbPath, sessionsRoot, records, sessions,
    totals: { ...totals, total: TOTAL }, expectedSessions, daily, expectedGroupSizes }
  writeFileSync(join(work, 'fixture.json'), JSON.stringify(configuration))

  // 不打包源码替代宿主：动态 import 的是用户真正安装的 lib 入口，其 Worker 也由该入口创建。
  const runnerPath = join(work, 'runner.mjs')
  writeFileSync(runnerPath, String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
assert.equal(typeof globalThis.Bun, 'undefined', '必须由真实 Node 执行');
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));
const { queryUsage, toUiPayload } = await import(fixture.moduleUrl);
const ctx = { config: { localDb: true }, dbPath: fixture.dbPath, sessionsRoot: fixture.sessionsRoot, backgroundQueries: true };
const range = { since: '2026-01-01', until: '2026-12-31' };
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls'];
function assertCounts(actual, expected) {
  for (const key of fields) assert.equal(actual[key], expected[key], key);
}
function check(result, mode) {
  assert.equal(result.source, 'local-db', result.degradedReason);
  assert.deepEqual(result.totals, fixture.totals);
  assert.equal(result.sessions, fixture.sessions);
  if (mode === 'summary') { assert.deepEqual(result.groups, []); return; }
  assert.equal(result.series.length, Object.keys(fixture.daily).length);
  for (const point of result.series) {
    const expected = fixture.daily[point.bucket];
    assert(expected, '出现不存在的日期');
    for (const key of ['input', 'output', 'cacheRead', 'calls']) assert.equal(point[key], expected[key]);
    assert.equal(point.total, expected.input + expected.output + expected.cacheRead + expected.cacheWrite);
  }
  for (const group of result.groups) {
    assert.equal(group.rowCount, fixture.expectedGroupSizes[group.by]);
    if (mode === 'detail') {
      assert.equal(group.by, 'session');
      assert.equal(group.rows.length, Math.min(10, fixture.sessions));
      for (const row of group.rows) {
        const expected = fixture.expectedSessions[row.key];
        assert(expected, '出现不存在的会话');
        assertCounts(row, expected);
        assert.equal(row.total, expected.input + expected.output + expected.cacheRead + expected.cacheWrite);
        assert.equal(row.sessions, 1);
      }
    } else {
      assert.equal(group.rows.length, fixture.expectedGroupSizes[group.by]);
      for (const key of [...fields, 'total']) assert.equal(group.rows.reduce((n, row) => n + row[key], 0), fixture.totals[key]);
      assert.equal(group.rows.reduce((n, row) => n + row.sessions, 0), fixture.sessions);
    }
  }
  assert.equal(result.groups.length, mode === 'detail' ? 1 : 4);
}
async function sample(query, mode) {
  let lastTick = performance.now(), maxDelayMs = 0, ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - lastTick - 5);
    lastTick = now; ticks++;
  }, 5);
  try {
    const start = performance.now();
    const result = await queryUsage(ctx, { ...range, ...query });
    const queryMs = performance.now() - start;
    const payload = toUiPayload(result, 'year');
    const uiPayloadBytes = Buffer.byteLength(JSON.stringify(payload));
    const wallMs = performance.now() - start;
    // 留一次到期计时器，防止刚结束的同步序列化阻塞没有被采样到。
    await delay(6);
    clearInterval(timer);
    check(result, mode);
    return { queryMs, wallMs, serializeMs: wallMs - queryMs, timerMaxDelayMs: Math.max(0, maxDelayMs), timerTicks: ticks, uiPayloadBytes };
  } finally { clearInterval(timer); }
}
function summarize(samples) {
  const median = key => {
    const values = samples.map(row => row[key]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  return { repeats: samples.length, medianQueryMs: median('queryMs'), medianWallMs: median('wallMs'),
    medianSerializeMs: median('serializeMs'), maxTimerDelayMs: Math.max(...samples.map(row => row.timerMaxDelayMs)),
    medianUiPayloadBytes: median('uiPayloadBytes'), samples };
}
async function repeat(n, query, mode) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(await sample(query, mode));
  return summarize(samples);
}
const cases = {};
cases.coldSummary = await repeat(1, { summaryOnly: true }, 'summary');
cases.hotSummary = await repeat(5, { summaryOnly: true }, 'summary');
cases.sessionDetail10 = await repeat(5, { by: ['session'], top: 10, series: 'day' }, 'detail');
cases.legacyFourDimensions = await repeat(3, { by: ['provider-model', 'provider', 'project', 'session'], top: Number.MAX_SAFE_INTEGER, series: 'day' }, 'legacy');
process.stdout.write(JSON.stringify({ node: process.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, cases }));
`)
  const proc = Bun.spawn([nodeBin, runnerPath], { stdout: 'pipe', stderr: 'pipe', env: { ...cleanChildEnv(), TZ: 'UTC' } })
  const timeout = setTimeout(() => proc.kill(), 10 * 60_000)
  let measured: unknown
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    assert.equal(code, 0, `Node 验证失败（${code}）：${stderr || stdout}`)
    measured = JSON.parse(stdout)
  } finally { clearTimeout(timeout) }
  const databaseAfter = databaseBytes()
  const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  process.stdout.write(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
    fixture: { records, sessions, days: DAYS, range: ['2026-01-01', '2026-12-31'], totals: configuration.totals,
      distribution: '按时间顺序排列的连续会话；每会话固定 provider/model/project；UTC；没有日志文件' },
    environment: { bun: Bun.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    artifacts: { indexSha256: sha256(modulePath), workerSha256: sha256(workerPath) }, seedMs,
    database: { before: databaseBefore, after: databaseAfter,
      beforeBytes: Object.values(databaseBefore).reduce((a, b) => a + b, 0), afterBytes: Object.values(databaseAfter).reduce((a, b) => a + b, 0) },
    measurement: measured,
    notes: ['首次包含 Worker 启动与派生索引构建，磁盘缓存未清空', 'timerMaxDelayMs 是 Node 主线程 5ms 定时器的最大额外延迟',
      'UiPayload 字节数来自真实 toUiPayload 和 JSON.stringify，不含 HTTP 封装', '验证通过不代表浏览器绘制或日志扫描已压测'],
  }, null, 2) + '\n')
} finally {
  // 递归清理前再次验证真实绝对路径，绝不接受调用方传入的清理目录。
  const actual = realpathSync(work)
  assert.equal(actual, work)
  assert.equal(dirname(actual), tempParent)
  assert(basename(actual).startsWith('atr-plugin-performance-') && !lstatSync(work).isSymbolicLink())
  rmSync(actual, { recursive: true, force: true })
}
