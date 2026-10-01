/**
 * 把 `run.sh` 留下的逐轮 JSON 汇总成一张对照表（node22 vs bun）。
 *
 * 用法：node report.mjs --dir /tmp/atr-ab-results
 *
 * 汇总口径：
 * - 每轮独立算，**先看轮内一致性**（同运行时的两轮差多少），再看跨运行时差异。
 *   只给两轮的平均值会掩盖「噪声比差异还大」这种情况。
 * - 端点延迟取各轮 p50 的**中位数**（两轮只有两个值时就是均值），
 *   并标出逐轮值，让人一眼看出抖动幅度。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const dir = arg('dir', '/tmp/atr-ab-results')

const files = readdirSync(dir).filter((f) => /^(node|bun)-r\d+\.json$/.test(f))
if (!files.length) { console.error(`没有在 ${dir} 找到 node-r*/bun-r*.json`); process.exit(1) }

/** 按运行时归拢各轮。 */
const byRuntime = { node: [], bun: [] }
for (const file of files) {
  const data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  const runtime = file.startsWith('node') ? 'node' : 'bun'
  const startup = Number(readFileSync(join(dir, file.replace(/\.json$/, '.startup.txt')), 'utf8').trim())
  byRuntime[runtime].push({ file, data, startup })
}
const rounds = Math.min(...Object.values(byRuntime).map((r) => r.length))
if (rounds < 2) console.error('⚠️ 每个运行时少于 2 轮，无法区分「差异」与「漂移」——建议至少 node:1 bun:1 node:2 bun:2')

const median = (v) => {
  const s = [...v].sort((a, b) => a - b)
  const raw = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  // ⚠️ 不要统一 `toFixed(1)`：启动耗时在 0.4~0.9 秒这一档，一位小数会把
  //    node 0.556 与 bun 0.412 双双压成 0.6/0.4，看起来像噪声（实测踩过）。
  return Number(raw.toFixed(Math.abs(raw) < 10 ? 3 : 1))
}
const fmt = (n) => (n === null || n === undefined ? '—' : String(n))
const delta = (a, b) => (a && b ? `${(((b - a) / a) * 100).toFixed(1)}%` : '—')

const lines = []
const say = (s = '') => { lines.push(s); console.log(s) }

say(`# 运行时 A/B 实测汇总（${dir}）`)
say()
say(`每个运行时 ${rounds} 轮。**同运行时的两轮差异就是噪声底噪** —— 跨运行时差异小于它的一律不可信。`)
say()

// ── 1. 逐端点延迟 ───────────────────────────────────────────────────────────
const names = byRuntime.node[0].data.phases.sequential.map((e) => e.name)
say('## 1. 端点延迟（p50，逐轮 + 中位数）')
say()
say('| 端点 | node 各轮 p50 | bun 各轮 p50 | node 中位 | bun 中位 | 差 | HTTP |')
say('|---|---|---|---|---|---|---|')
for (const name of names) {
  const pick = (rt) => byRuntime[rt].map((r) => r.data.phases.sequential.find((e) => e.name === name))
  const n = pick('node'), b = pick('bun')
  const nv = n.map((e) => e?.p50 ?? 0), bv = b.map((e) => e?.p50 ?? 0)
  const nm = median(nv), bm = median(bv)
  const status = `${n[0]?.status}/${b[0]?.status}`
  const flag = status === '200/200' ? '' : ' ⚠️'
  say(`| \`${name}\` | ${nv.join(' / ')} | ${bv.join(' / ')} | ${fmt(nm)} | ${fmt(bm)} | ${delta(nm, bm)} | ${status}${flag} |`)
}
say()

// ── 2. 汇总指标 ─────────────────────────────────────────────────────────────
say('## 2. 汇总指标')
say()
const metricRows = [
  ['启动到就绪 (s)', (r) => r.startup],
  ['服务端 CPU 总计 (s)', (r) => r.data.summary.cpuSecondsTotal],
  ['**CPU ms / 请求**', (r) => r.data.summary.cpuMsPerRequest],
  ['CPU ms / 顺序 stats 请求', (r) => r.data.summary.cpuMsPerSequentialRequest],
  ['CPU ms / 上报请求', (r) => r.data.summary.cpuMsPerIngestRequest],
  ['RSS 起始 (MB)', (r) => Number((r.data.summary.rssBeforeKb / 1024).toFixed(1))],
  ['RSS 结束 (MB)', (r) => Number((r.data.summary.rssAfterKb / 1024).toFixed(1))],
  ['RSS 峰值 (MB)', (r) => Number((r.data.summary.peakRssKb / 1024).toFixed(1))],
  ['线程数', (r) => r.data.summary.threadsAfter],
  ['上报吞吐 (条/秒)', (r) => r.data.phases.ingest.recordsPerSecond],
  ['上报 ACK p50 (ms)', (r) => r.data.phases.ingest.ackP50],
  ['上报 ACK p95 (ms)', (r) => r.data.phases.ingest.ackP95],
]
say('| 指标 | node 各轮 | bun 各轮 | node 中位 | bun 中位 | 差 |')
say('|---|---|---|---|---|---|')
for (const [label, pick] of metricRows) {
  const nv = byRuntime.node.map(pick), bv = byRuntime.bun.map(pick)
  const nm = median(nv), bm = median(bv)
  say(`| ${label} | ${nv.join(' / ')} | ${bv.join(' / ')} | ${fmt(nm)} | ${fmt(bm)} | ${delta(nm, bm)} |`)
}
say()

// ── 3. 并发 ─────────────────────────────────────────────────────────────────
say('## 3. 并发（一次看板加载 = 7 个请求）')
say()
say('| 客户端数 | node req/s | bun req/s | node p95 (ms) | bun p95 (ms) | 失败(node vs bun) |')
say('|---|---|---|---|---|---|')
const clientCounts = byRuntime.node[0].data.phases.concurrency.map((c) => c.clients)
for (const clients of clientCounts) {
  const pick = (rt) => byRuntime[rt].map((r) => r.data.phases.concurrency.find((c) => c.clients === clients))
  const n = pick('node'), b = pick('bun')
  say(`| ${clients} | ${n.map((c) => c.requestsPerSecond).join(' / ')} | ${b.map((c) => c.requestsPerSecond).join(' / ')} `
    + `| ${n.map((c) => c.p95).join(' / ')} | ${b.map((c) => c.p95).join(' / ')} `
    + `| ${n.map((c) => c.failures).join(' / ')} vs ${b.map((c) => c.failures).join(' / ')} |`)
}
say()

// ── 4. 对账 ─────────────────────────────────────────────────────────────────
try {
  const parity = JSON.parse(readFileSync(join(dir, 'parity.json'), 'utf8'))
  say('## 4. 逐位对账（node22 vs bun 的响应体）')
  say()
  say(`- 端点逐字节相同：**${parity.pass} 项通过 / ${parity.fail} 项不同**`)
  say(`- 上报 ACK 相同：${parity.ackSame ? '✅' : '❌'}`)
  say(`- 重放判重语义相同：${parity.replaySame ? '✅' : '❌'}`)
  say(`- 写入后合计仍相同：${parity.afterSame ? '✅' : '❌'}`)
  if (parity.failures?.length) say(`\n不同的端点：\n\`\`\`json\n${JSON.stringify(parity.failures, null, 2)}\n\`\`\``)
} catch {
  say('## 4. 逐位对账')
  say()
  // ⚠️ 这里不要用模板字符串：里面的 `run.sh --parity` 一旦再带反引号，
  //    会把外层模板**提前闭合**，报 `SyntaxError: missing ) after argument list`（实测）。
  say('⚠️ 没有找到 parity.json，说明 run.sh --parity 没跑成功。')
}
say()
say('---')
say()
say('> 复现：在目标机 `bash fixture.sh setup` → `bash run.sh` → `bash fixture.sh dispose`。')

const outFile = join(dir, 'REPORT.md')
writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`\n已写入 ${outFile}`)
