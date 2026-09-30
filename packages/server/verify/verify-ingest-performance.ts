/**
 * 真 HTTP 上报性能验收：临时 SQLite、真实人员/appKey 与数据库鉴权，不访问部署库。
 * 默认 20 人各两批 200 条，每条 75 万 token，共 60 亿 token；吞吐按事件数衡量。
 * 可用 ATR_PERF_CONCURRENCY / ATR_PERF_RECORDS / ATR_PERF_ROUNDS 调整负载，
 * ATR_PERF_HISTORY_RECORDS 可先通过同一 HTTP 接口填充历史事件，再测新增及重放。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  computeTotal,
  type IngestPayload, type IngestResponse, type OverviewResponse,
  type PortalMemberResult, type PortalRole, type PortalTokenResult,
} from '@ai-token-report/shared'
import { createServer, type ServerHandle } from '../src/index.js'

function option(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 需要是 ${min}~${max} 的整数`)
  return value
}
const concurrency = option('ATR_PERF_CONCURRENCY', 20, 2, 40)
const recordsPerBatch = option('ATR_PERF_RECORDS', 200, 1, 5000)
const rounds = option('ATR_PERF_ROUNDS', 2, 2, 100)
const historyRecords = option('ATR_PERF_HISTORY_RECORDS', 0, 0, 1_000_000)
const usage = { input: 20_000, output: 1_000, cacheRead: 728_000, cacheWrite: 1_000, reasoning: 200 }
const tokensPerRecord = computeTotal(usage)
const tempRoot = mkdtempSync(join(tmpdir(), 'atr-ingest-performance-'))
const adminSecret = randomBytes(32).toString('base64url')
const members: { id: string; token: string }[] = []
let server: ServerHandle | undefined
let checks = 0

function checked(condition: unknown, message: string): asserts condition {
  assert(condition, message)
  checks++
}
async function http<T>(path: string, token: string, body?: unknown): Promise<T> {
  assert(server)
  const response = await fetch(`${server.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const value = await response.json() as T & { reason?: string }
  checked(response.status === 200, `${path} 返回 HTTP ${response.status}${value.reason ? `：${value.reason}` : ''}`)
  return value
}
function payload(member: number, batch: string, count: number): IngestPayload {
  const session = `perf-${member}-${batch}`
  return {
    schemaVersion: 1,
    client: { userId: 'untrusted-client-name', userName: '客户端伪造姓名应忽略' },
    generatedAt: new Date().toISOString(),
    records: Array.from({ length: count }, (_, seq) => ({
      event_id: `${session}:${seq}`, session_id: session, seq, ts: Date.now(),
      provider: 'performance-fixture', model: 'fixture-model', cwd: 'performance-fixture',
      input_tokens: usage.input, output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite,
      reasoning_tokens: usage.reasoning, total_tokens: tokensPerRecord, turn: 1, step: seq,
    })),
  }
}
async function overview(member?: number): Promise<OverviewResponse> {
  const selector = member === undefined ? '' : `&member_id=${members[member]!.id}`
  // 🚨 两种读法刻意用两把不同的凭证：
  //   - 不带 `member_id`（并发期间与收尾的全量核对）→ **管理员**：数据范围从 v7 起
  //     收窄成「非管理员只看自己」，拿某个 appKey 读全员合计会只读到自己那一份。
  //   - 带 `member_id` → 那个人**自己的** appKey：顺带钉住「点名自己的 ID 允许」。
  const token = member === undefined ? adminSecret : members[member]!.token
  return http(`/api/v1/stats/overview?period=last7d&identity_view=member${selector}`, token)

function verifyOverview(value: OverviewResponse, calls: number): void {
  const expected = {
    calls, inputTokens: calls * usage.input, outputTokens: calls * usage.output,
    cacheReadTokens: calls * usage.cacheRead, cacheWriteTokens: calls * usage.cacheWrite,
    totalTokens: computeTotal({
      input: calls * usage.input, output: calls * usage.output,
      cacheRead: calls * usage.cacheRead, cacheWrite: calls * usage.cacheWrite,
      reasoning: calls * usage.reasoning,
    }),
  }
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    checked(value[key] === expected[key], `即时统计 ${key} 期望 ${expected[key]}，实际 ${value[key]}`)
  }
}
function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? 0
}
const timings: { stage: string; events: number; durationMs: number; ackMs: number[]; statsMs: number[]; concurrentStats: number }[] = []

async function burst(stage: string, batch: string, replay: boolean, completedRounds: number): Promise<void> {
  const ackMs: number[] = [], statsMs: number[] = []
  let active = concurrency, concurrentStats = 0, lastAckAt = 0
  const started = performance.now()
  const writes = Promise.allSettled(members.map(async (member, index) => {
    const sent = performance.now()
    const result = await http<IngestResponse>('/api/v1/token-usage', member.token, payload(index, batch, recordsPerBatch)).finally(() => { active-- })
    lastAckAt = performance.now()
    ackMs.push(lastAckAt - sent)
    assert.deepEqual(result, { accepted: replay ? 0 : recordsPerBatch, duplicates: replay ? recordsPerBatch : 0, rejected: 0 })
    checks++
    // 每个 appKey 的 ACK 之后立刻读自身稳定 ID，避免其他并发提交让精确计数产生竞态。
    verifyOverview(await overview(index), completedRounds * recordsPerBatch + (index === 0 ? historyRecords : 0))
  })).then(results => {
    for (const result of results) if (result.status === 'rejected') throw result.reason
  })
  const poll = (async () => {
    while (active > 0) {
      const sent = performance.now()
      const snapshot = await overview()
      statsMs.push(performance.now() - sent)
      checked(Number.isSafeInteger(snapshot.calls), '并发期间统计接口仍返回可读快照')
      if (active > 0) concurrentStats++
      if (active > 0) await delay(25)
    }
  })()
  // 一个任务失败也等待其余请求收束，避免清理数据库时仍有后台请求在写入。
  const results = await Promise.allSettled([writes, poll])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  verifyOverview(await overview(), historyRecords + completedRounds * concurrency * recordsPerBatch)
  timings.push({ stage, events: concurrency * recordsPerBatch, durationMs: lastAckAt - started, ackMs, statsMs, concurrentStats })
  console.log(`${stage}: ${(concurrency * recordsPerBatch / ((lastAckAt - started) / 1000)).toFixed(0)} events/s，HTTP ACK p50=${percentile(ackMs, 0.5).toFixed(1)}ms p95=${percentile(ackMs, 0.95).toFixed(1)}ms，duration=${(lastAckAt - started).toFixed(1)}ms，并发统计=${concurrentStats} 次`)
}

try {
  // 空 mysqlUrl 显式覆盖部署环境；凭证和监听地址也不继承生产配置。
  server = await createServer({
    host: '127.0.0.1', port: 0, dshHome: tempRoot, dataDir: join(tempRoot, 'token-report'), dbPath: join(tempRoot, 'portal.sqlite'),
    mysqlUrl: '', adminToken: adminSecret, adminName: '性能夹具管理员',
    adminUsername: '', adminPassword: '', captchaHmacKey: '', portalOrigin: '', requestLog: false,
    ingestQueue: { maxRequests: 64, maxWaitMs: 30_000 },
  })
  checked(server.portalTargetLabel === join(tempRoot, 'portal.sqlite'), '必须使用本次创建的临时 SQLite')
  const roles = await http<{ roles: PortalRole[] }>('/api/v1/admin/roles', adminSecret)
  const memberRole = roles.roles.find(role => role.code === 'member')
  checked(memberRole, '数据库包含普通人员角色')
  for (let index = 0; index < concurrency; index++) {
    const created = await http<PortalMemberResult>('/api/v1/admin/members', adminSecret, { name: `性能人员${index + 1}`, role_ids: [memberRole.role_id] })
    checked(created.ok && created.member, '真实 HTTP 创建独立人员成功')
    const key = await http<PortalTokenResult>('/api/v1/admin/members/appkey', adminSecret, { member_id: created.member.member_id })
    checked(key.ok && key.token_secret, '真实 HTTP 为独立人员签发 appKey 成功')
    members.push({ id: created.member.member_id, token: key.token_secret })
  }
  console.log(`隔离 SQLite，${concurrency} 名独立人员/appKey，${rounds} 轮 × ${recordsPerBatch} 条/人，新增 ${concurrency * rounds * recordsPerBatch} 条 / ${tokensPerRecord * concurrency * rounds * recordsPerBatch} token`)
  if (historyRecords > 0) {
    const started = performance.now()
    for (let offset = 0; offset < historyRecords; offset += 1000) {
      const count = Math.min(1000, historyRecords - offset)
      const result = await http<IngestResponse>('/api/v1/token-usage', members[0]!.token, payload(0, `history-${offset}`, count))
      assert.deepEqual(result, { accepted: count, duplicates: 0, rejected: 0 })
      checks++
    }
    verifyOverview(await overview(), historyRecords)
    console.log(`历史预填 ${historyRecords} 条完成，耗时 ${(performance.now() - started).toFixed(1)}ms（不计入吞吐）`)
  }
  for (let round = 0; round < rounds; round++) await burst(`新增第${round + 1}轮`, `round-${round}`, false, round + 1)
  await burst('最后一轮精确重放', `round-${rounds - 1}`, true, rounds)
  checked(timings.some(result => result.concurrentStats > 0), '上报尚未全部完成时，统计请求已获得响应')
  const inserted = timings.filter(result => result.stage.startsWith('新增'))
  const durationMs = inserted.reduce((sum, result) => sum + result.durationMs, 0)
  const ackMs = inserted.flatMap(result => result.ackMs)
  const statsMs = timings.flatMap(result => result.statsMs)
  const events = concurrency * rounds * recordsPerBatch
  console.log(JSON.stringify({
    backend: 'SQLite', concurrency, recordsPerBatch, rounds, historyRecords,
    insertedEvents: events, totalTokens: events * tokensPerRecord,
    durationMs: Number(durationMs.toFixed(1)), eventsPerSecond: Math.round(events / (durationMs / 1000)),
    ackP50Ms: Number(percentile(ackMs, 0.5).toFixed(1)), ackP95Ms: Number(percentile(ackMs, 0.95).toFixed(1)),
    statsP95Ms: Number(percentile(statsMs, 0.95).toFixed(1)), checks,
  }, null, 2))
  console.log('通过：精确 ACK/重放、稳定人员归属、ACK 后立即可见四列和总量、并发统计可响应。结果仅代表本机隔离压测。')
} finally {
  await server?.stop()
  const location = relative(resolve(tmpdir()), resolve(tempRoot))
  if (!location || location.startsWith('..') || !location.startsWith('atr-ingest-performance-')) throw new Error('临时目录不在本次压测范围，拒绝清理')
  rmSync(tempRoot, { recursive: true, force: true })
}

