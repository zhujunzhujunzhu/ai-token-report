/**
 * 历史自动补报端到端验证：真实分帧日志 → 插件补报 → HTTP → portal SQLite。
 *
 * bun run packages/dsh-plugin/verify/verify-backfill.ts
 *
 * 全程使用临时 DSH home 与临时数据库，不读取或修改真实用户的日志、身份与水位线。
 * 四类 token、调用数、事件主键及元数据逐条对账；不能只比 total 掩盖字段互相抵消。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { scanAll, totalOf, type UsageRecord } from '@ai-token-report/core'
import { openPortalStats } from '@ai-token-report/core/db'
import type { IngestPayload, IngestResponse } from '@ai-token-report/shared'
import { createHandlerFor } from '../../server/src/index.js'
import { seedDatabaseIdentity } from '../../server/test/database-fixture.js'
import { runBackfillPass } from '../src/backfill-runner.js'
import { resolveConfig } from '../src/config.js'
import { Reporter } from '../src/reporter.js'
import type { BillingRecord, FoldIdentity } from '../src/fold.js'

let checks = 0
let failures = 0
function check(label: string, success: boolean): void {
  checks++
  if (!success) failures++
  console.log(`  ${success ? '✅' : '❌'} ${label}`)
}

const home = mkdtempSync(join(tmpdir(), 'atr-backfill-e2e-'))
const sessionsRoot = join(home, 'sessions')
const dbPath = join(home, 'portal.sqlite')
const target = { sqlitePath: dbPath }
const token = 'isolated-backfill-member-key'
const identity: FoldIdentity = { clientName: 'dsh-token-report', claimedUserId: '客户端错误署名', userName: '客户端错误署名' }
const epoch = 1_790_000_000_000

/** 同时覆盖四个独立 token 列，reasoning 有值但不能重复加进总量。 */
function usage(seq: number): string {
  const input = seq + 3, output = seq % 11 + 7, cacheRead = seq * 31 + 17, cacheWrite = seq % 5 + 1
  return JSON.stringify({
    type: 'assistant/message', seq, time: epoch + seq * 1000,
    data: {
      turn: 1, step: seq,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite, reasoningTokens: seq % 7,
        totalTokens: input + output + cacheRead + cacheWrite },
      message: { source: { provider: seq % 2 ? 'provider-a' : 'provider-b', model: `model-${seq % 3}` },
        content: [{ type: 'text', text: '对话正文绝不允许出现在上报请求中' }] },
    },
  })
}
const frame = (...lines: string[]) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
function sessionFile(session: string, file: string, sequences: number[]): string {
  const path = join(sessionsRoot, 'project', session, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, frame(JSON.stringify({ type: 'session', cwd: '/history-project' }), ...sequences.map(usage)))
  return path
}

function asBilling(record: UsageRecord): BillingRecord {
  return {
    eventId: record.eventId, sessionId: record.sessionId, seq: record.seq, time: record.time,
    provider: record.provider, model: record.model, cwd: record.cwd, turn: record.turn ?? null, step: record.step ?? null,
    inputTokens: record.usage.input, outputTokens: record.usage.output,
    cacheReadTokens: record.usage.cacheRead, cacheWriteTokens: record.usage.cacheWrite,
    reasoningTokens: record.usage.reasoning, totalTokens: record.usage.total,
    identityViolation: false, identity,
  }
}

async function assertParity(label: string): Promise<void> {
  const local = await scanAll(sessionsRoot)
  const expected = totalOf(local.records)
  const portal = await openPortalStats(target, { identityView: 'member' })
  try {
    const actual = await portal.totals()
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'calls'] as const) {
      check(`${label}：${key} 与本地全量直扫逐位一致`, actual[key] === expected[key])
    }
    check(`${label}：会话去重一致`, await portal.sessions() === new Set(local.records.map(r => r.sessionId)).size)
    const rows = (await portal.records(2000, 0)).rows
    const expectedById = new Map(local.records.map(r => [r.eventId, r]))
    check(`${label}：事件主键集合完全一致`, rows.length === expectedById.size && rows.every(r => expectedById.has(r.eventId)))
    check(`${label}：每条事件四列与元数据一致`, rows.every(row => {
      const rec = expectedById.get(row.eventId)
      return rec !== undefined && row.sessionId === rec.sessionId && row.seq === rec.seq && row.ts === rec.time &&
        row.provider === rec.provider && row.model === rec.model && row.cwd === rec.cwd &&
        row.input === rec.usage.input && row.output === rec.usage.output &&
        row.cacheRead === rec.usage.cacheRead && row.cacheWrite === rec.usage.cacheWrite
    }))
    check(`${label}：归属使用服务端署名`, rows.every(row => row.userNameSnapshot === '历史验证成员' && !!row.memberId))
  } finally { await portal.close() }
}

console.log('历史自动补报端到端验证（临时日志、真实 HTTP、真实 portal SQLite）')
await seedDatabaseIdentity(target, [{ token, name: '历史验证成员', group: '测试分组' }])
const bundle = await createHandlerFor({ dshHome: home, dbPath, mysqlUrl: '', enableLocalApi: false, requestLog: false })
let reportRequests = 0
let duplicateReceipts = 0
let failFromRequest = Infinity
let leakedContent = false
const server = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 120,
  async fetch(request) {
    if (new URL(request.url).pathname === '/api/v1/token-usage') {
      reportRequests++
      if (reportRequests >= failFromRequest) return Response.json({ ok: false, reason: '隔离验证的临时网络故障' }, { status: 503 })
      const payload = await request.clone().json() as IngestPayload
      if (JSON.stringify(payload).includes('对话正文绝不允许')) leakedContent = true
      const response = await bundle.handler(request)
      if (response.ok) duplicateReceipts += ((await response.clone().json()) as IngestResponse).duplicates
      return response
    }
    return bundle.handler(request)
  },
})
const config = resolveConfig({
  dshHome: home, endpoint: `http://127.0.0.1:${server.port}/api/v1/token-usage`, appKey: token,
  batch: { maxRecords: 2, flushIntervalMillis: 60_000, timeoutMillis: 5000 },
  outbox: { enabled: false },
})
const options = { config, identity, sessionsRoot }

try {
  // 文件名顺序刻意先高 seq 再低 seq，不能拿全会话最大 seq 过滤未扫描的历史文件。
  const mainFile = sessionFile('history-session', 'session.00.jsonl.zstd', Array.from({ length: 123 }, (_, i) => i + 10))
  sessionFile('history-session', 'session.01.jsonl.zstd', [1, 2, 3, 10])
  const initial = await scanAll(sessionsRoot)
  const realtime = new Reporter({ config, identity })
  realtime.enqueue(asBilling(initial.records[0]!))
  await realtime.flush()
  await realtime.shutdown()
  const beforeBackfill = reportRequests
  const first = await runBackfillPass(options)
  check('首次补报完成', first.status === 'complete')
  check('一个历史文件超过 50 个批次仍持续发送直到完成', reportRequests - beforeBackfill > 50)
  check('实时已报事件与日志副本由服务端按 event_id 去重', duplicateReceipts >= 2)
  await assertParity('首次补报')

  const beforeUnchanged = reportRequests
  const unchanged = await runBackfillPass(options)
  check('重启后未变化的文件不再次投递', unchanged.status === 'complete' && reportRequests === beforeUnchanged)

  sessionFile('restart-session', 'session.v3.jsonl.zstd', [1, 2, 3, 4, 5, 6])
  const beforeFailure = reportRequests
  failFromRequest = beforeFailure + 2
  const interrupted = await runBackfillPass(options)
  check('中途 HTTP 503 明确报告等待重试', interrupted.status === 'retrying' && interrupted.failures > 0)
  check('失败发生前至少一批已真实提交到服务端', reportRequests >= beforeFailure + 2)
  const failedSession = await openPortalStats(target, { identityView: 'member' })
  try {
    const rows = (await failedSession.records(2000, 0)).rows.filter(row => row.sessionId === 'restart-session')
    check('中断时该文件只落入已确认的两条', rows.length === 2)
  } finally { await failedSession.close() }

  const duplicatesBeforeRestart = duplicateReceipts
  failFromRequest = Infinity
  const resumed = await runBackfillPass(options)
  check('新一轮仅依靠磁盘状态即可续传完成', resumed.status === 'complete')
  check('失败文件已确认部分安全重发并去重', duplicateReceipts >= duplicatesBeforeRestart + 2)
  await assertParity('故障后恢复')

  appendFileSync(mainFile, frame(usage(133), usage(134)))
  const appended = await runBackfillPass(options)
  check('完成后追加日志仍自动纳入下一轮', appended.status === 'complete')
  await assertParity('增量追加')

  const tail = frame(usage(135))
  appendFileSync(mainFile, tail.subarray(0, tail.length - 1))
  await runBackfillPass(options)
  appendFileSync(mainFile, tail.subarray(tail.length - 1))
  const completedTail = await runBackfillPass(options)
  check('尾部半帧补齐后仍补报成功', completedTail.status === 'complete')
  await assertParity('半帧补齐')
  check('所有 HTTP 请求均未携带对话正文', !leakedContent)
} catch (error) {
  failures++
  console.error(error)
} finally {
  await server.stop(true)
  // 只清理由本脚本 mkdtemp 创建、且已关闭全部数据库连接的隔离目录。
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} 项通过`)
if (failures > 0) process.exitCode = 1
