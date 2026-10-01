/**
 * 双运行时 A/B 压测**客户端** —— 跑在**被测服务器本机**（不是开发机）。
 *
 * 用法（在目标机上）：
 *   node bench.mjs --port 18901 --tag node --pid <服务端 pid> --token <appKey> \
 *                  --repeats 25 --out /tmp/atr-ab-results/node-r1.json
 *
 * 为什么这么设计（三条都是踩出来的）：
 * - 🚨 **客户端必须在被测机本机**：从开发机打过去，SSH/RTT 会把延迟污染成网络数字，
 *   而这里要回答的恰恰是「同机同库下两个运行时差多少」。
 * - ★ **交替 A/B**：node → bun → node → bun。只跑一轮的话，
 *   「第一轮时 MySQL 页缓存还冷」会被误读成运行时的差异。
 * - ★ **服务端 `/proc/<pid>/stat` 的 CPU 时间/请求**是最能归因到运行时的指标：
 *   它不受客户端调度、网络、MySQL 排队的影响；p50/p95 会被这三者一起污染。
 *
 * ⚠️ 本脚本**不自己起服务**（起停与端口断言在 `run.sh` 里），只负责打流量与读数。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', '18901'))
const tag = arg('tag', 'unknown')
const out = arg('out', `/tmp/ab-${tag}.json`)
const token = arg('token')
const portalDist = arg('static', '/data/ai-token-report/packages/web-portal/dist')
const repeats = Number(arg('repeats', '25'))
const base = `http://127.0.0.1:${port}`

// ── 计时与统计 ──────────────────────────────────────────────────────────────
const now = () => Number(process.hrtime.bigint()) / 1e6
function pct(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  // ⚠️ q=0 时 `Math.ceil(0)-1 = -1`，`sorted[-1]` 是 undefined（实测会崩在 `.toFixed`）
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))
  return Number(sorted[index].toFixed(1))
}
const mean = (v) => (v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)) : null)

// ── 服务端进程采样 ──────────────────────────────────────────────────────────
/** 读 `/proc/<pid>/stat` 与 `status`。utime+stime 是该进程**全部线程**的 CPU 时间。 */
function sampleProcess(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return {
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    threads: Number(fields[17]),
    rssKb: Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0),
    hwmKb: Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0),
  }
}
const TICKS_PER_SEC = 100

const AUTH = { Authorization: `Bearer ${token}` }
async function hit(path, init) {
  const started = now()
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...AUTH, ...(init?.headers ?? {}) } })
  const body = await response.text()
  return { status: response.status, ms: now() - started, bytes: body.length, body }
}

// ── 端点清单：照看板真实请求集 ──────────────────────────────────────────────
// ⚠️ `by=` 的合法值见 `shared/src/protocol.ts` 的 `GroupBy`：
//   人员维度是 **`user`**，不是 `member` —— 写错会静默拿到 400，
//   而压测脚本只把它当成「一个很快的端点」记进表里（实测踩过）。
const Q = 'identity_view=member'
const entryJs = readFileSync(`${portalDist}/index.html`, 'utf8').match(/assets\/(index-[\w-]+\.js)/)?.[1] ?? 'index.js'
const endpoints = [
  ['health', '/api/health'],
  ['overview:30d', `/api/v1/stats/overview?${Q}&period=last30d`],
  ['overview:today', `/api/v1/stats/overview?${Q}&period=today`],
  ['overview:90d', `/api/v1/stats/overview?${Q}&period=last90d`],
  ['series:day30', `/api/v1/stats/series?${Q}&period=last30d&bucket=day`],
  ['series:hour-today', `/api/v1/stats/series?${Q}&period=today&bucket=hour`],
  ['series:stack-model', `/api/v1/stats/series?${Q}&period=last30d&bucket=day&stack=model`],
  ['series:stack-user', `/api/v1/stats/series?${Q}&period=last30d&bucket=day&stack=user`],
  ['breakdown:user', `/api/v1/stats/breakdown?${Q}&period=last30d&by=user`],
  ['breakdown:provider', `/api/v1/stats/breakdown?${Q}&period=last30d&by=provider`],
  ['breakdown:model', `/api/v1/stats/breakdown?${Q}&period=last30d&by=model`],
  ['breakdown:provider-model', `/api/v1/stats/breakdown?${Q}&period=last30d&by=provider-model`],
  ['breakdown:project', `/api/v1/stats/breakdown?${Q}&period=last30d&by=project`],
  ['breakdown:group', `/api/v1/stats/breakdown?${Q}&period=last30d&by=group`],
  ['breakdown:day', `/api/v1/stats/breakdown?${Q}&period=last30d&by=day`],
  ['breakdown:hour', `/api/v1/stats/breakdown?${Q}&period=today&by=hour`],
  ['records:100', `/api/v1/stats/records?${Q}&period=last30d&limit=100&offset=0`],
  ['records:1000', `/api/v1/stats/records?${Q}&period=last30d&limit=1000&offset=0`],
  ['diagnostics', `/api/v1/stats/diagnostics?${Q}&period=last30d`],
  ['groups', '/api/v1/stats/groups'],
  ['members', '/api/v1/stats/members'],
  ['providers', '/api/v1/stats/providers'],
  ['pricing', '/api/v1/stats/pricing'],
  ['static:index', '/'],
  ['static:entry-js', `/assets/${entryJs}`],
]

const results = { tag, port, pid: Number(arg('pid', '0')), phases: {} }

/** 预热：把连接池、prepared statement、schema 闸门都跑到热态，且不计入统计。 */
for (const [, path] of endpoints) await hit(path)

const before = sampleProcess(results.pid)

// ── 阶段 1：逐端点顺序测（热态）────────────────────────────────────────────
const endpointStats = []
for (const [name, path] of endpoints) {
  const times = []
  let status = 0, bytes = 0
  for (let i = 0; i < repeats; i++) {
    const r = await hit(path)
    times.push(r.ms)
    status = r.status
    bytes = r.bytes
  }
  endpointStats.push({ name, path, status, bytes, p50: pct(times, 0.5), p95: pct(times, 0.95), min: pct(times, 0), mean: mean(times), n: times.length })
}
results.phases.sequential = endpointStats
const afterSequential = sampleProcess(results.pid)

// ── 阶段 2：并发「一次看板加载」────────────────────────────────────────────
/** 一次真实的看板首屏 = 概览 + 趋势 + 两个分布 + 三个候选目录（7 个请求）。 */
const dashboardLoad = [
  `/api/v1/stats/overview?${Q}&period=last30d`,
  `/api/v1/stats/series?${Q}&period=last30d&bucket=day`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=user`,
  `/api/v1/stats/breakdown?${Q}&period=last30d&by=provider`,
  '/api/v1/stats/groups',
  '/api/v1/stats/members',
  '/api/v1/stats/providers',
]
async function concurrencyPhase(clients) {
  const durationMs = 12_000
  const deadline = now() + durationMs
  let requests = 0, failures = 0
  const latencies = []
  const worker = async () => {
    while (now() < deadline) {
      for (const path of dashboardLoad) {
        if (now() >= deadline) return
        const r = await hit(path)
        requests++
        latencies.push(r.ms)
        if (r.status !== 200) failures++
      }
    }
  }
  const started = now()
  await Promise.all(Array.from({ length: clients }, worker))
  const elapsed = now() - started
  return {
    clients, durationMs: Number(elapsed.toFixed(0)), requests, failures,
    dashboardsPerSecond: Number(((requests / dashboardLoad.length) / (elapsed / 1000)).toFixed(2)),
    requestsPerSecond: Number((requests / (elapsed / 1000)).toFixed(1)),
    p50: pct(latencies, 0.5), p95: pct(latencies, 0.95),
  }
}
results.phases.concurrency = []
for (const clients of [1, 4, 16]) results.phases.concurrency.push(await concurrencyPhase(clients))
const afterConcurrency = sampleProcess(results.pid)

// ── 阶段 3：上报入库（串行批次，逐批等 ACK）────────────────────────────────
function payload(batchIndex, count) {
  const session = `abbench-${tag}-${batchIndex}`
  return {
    schemaVersion: 1,
    client: { userId: 'ab-fixture', userName: 'A/B 夹具' },
    generatedAt: new Date().toISOString(),
    records: Array.from({ length: count }, (_, seq) => ({
      event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
      provider: 'ab-fixture', model: 'ab-fixture-model', cwd: 'ab-fixture',
      input_tokens: 20_000, output_tokens: 1_000, cache_read_tokens: 728_000, cache_write_tokens: 1_000,
      reasoning_tokens: 200, total_tokens: 750_000, turn: 1, step: seq,
    })),
  }
}
const BATCH = 200
const batches = 40
const ackMs = []
let accepted = 0
const ingestStarted = now()
for (let i = 0; i < batches; i++) {
  const r = await hit('/api/v1/token-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(i, BATCH)),
  })
  ackMs.push(r.ms)
  if (r.status !== 200) throw new Error(`上报失败 HTTP ${r.status}：${r.body.slice(0, 200)}`)
  accepted += JSON.parse(r.body).accepted
}
const ingestElapsed = now() - ingestStarted
const afterIngest = sampleProcess(results.pid)

results.phases.ingest = {
  batches, recordsPerBatch: BATCH, records: batches * BATCH, accepted,
  wallMs: Number(ingestElapsed.toFixed(0)),
  recordsPerSecond: Number(((batches * BATCH) / (ingestElapsed / 1000)).toFixed(0)),
  ackP50: pct(ackMs, 0.5), ackP95: pct(ackMs, 0.95), ackMean: mean(ackMs),
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const cpuDelta = (a, b) => Number(((b.cpuTicks - a.cpuTicks) / TICKS_PER_SEC).toFixed(3))
const seqRequests = endpointStats.reduce((sum, e) => sum + e.n, 0)
const concRequests = results.phases.concurrency.reduce((sum, c) => sum + c.requests, 0)
const allRequests = seqRequests + concRequests + batches
const cpuTotal = cpuDelta(before, afterIngest)
results.summary = {
  pid: results.pid,
  requests: { sequential: seqRequests, concurrency: concRequests, ingest: batches, total: allRequests },
  cpuSecondsTotal: cpuTotal,
  cpuMsPerRequest: Number(((cpuTotal * 1000) / allRequests).toFixed(3)),
  cpuMsPerSequentialRequest: Number(((cpuDelta(before, afterSequential) * 1000) / seqRequests).toFixed(3)),
  cpuMsPerIngestRequest: Number(((cpuDelta(afterConcurrency, afterIngest) * 1000) / batches).toFixed(3)),
  cpuPerPhase: {
    sequential: cpuDelta(before, afterSequential),
    concurrency: cpuDelta(afterSequential, afterConcurrency),
    ingest: cpuDelta(afterConcurrency, afterIngest),
  },
  rssBeforeKb: before.rssKb, rssAfterKb: afterIngest.rssKb, peakRssKb: afterIngest.hwmKb,
  threadsBefore: before.threads, threadsAfter: afterIngest.threads,
}

writeFileSync(out, JSON.stringify(results, null, 2))
console.log(`\n══ ${tag} (端口 ${port}, pid ${results.pid}) ══`)
console.log('端点'.padEnd(26) + 'HTTP'.padEnd(6) + 'p50'.padStart(8) + 'p95'.padStart(9) + 'mean'.padStart(9) + '字节'.padStart(9))
for (const e of endpointStats) {
  console.log(e.name.padEnd(26) + String(e.status).padEnd(6) + String(e.p50).padStart(8) + String(e.p95).padStart(9) + String(e.mean).padStart(9) + String(e.bytes).padStart(9))
}
console.log('\n并发（一次看板加载 = 7 个请求）')
for (const c of results.phases.concurrency) {
  console.log(`  客户端 ${String(c.clients).padStart(2)} → ${String(c.requestsPerSecond).padStart(6)} req/s (${c.dashboardsPerSecond} 次看板/秒)  p50=${c.p50}ms p95=${c.p95}ms  失败=${c.failures}`)
}
console.log('\n上报：' + JSON.stringify(results.phases.ingest))
console.log('\n汇总：' + JSON.stringify(results.summary))
