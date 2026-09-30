/** 真线程验证：查询、刷新、外部写入和卸载不能依赖宿主线程里的数据库状态。 */
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { queryUsage, type StatsContext } from '../src/stats.js'
import { closeStatsWorker } from '../src/stats-worker-client.js'
import { openDatabaseForIngest, insertRecords } from '@ai-token-report/core/db'
import { emptyCounts } from '@ai-token-report/core'

test('会话根目录是联接时，监听真实目录但增量路径保持调用方目录', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'atr-worker-alias-'))
  const target = join(root, 'real-sessions')
  const sessionsRoot = join(root, 'alias-sessions')
  mkdirSync(target)
  symlinkSync(target, sessionsRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [sessionsRoot], dbPath: join(root, 'usage.sqlite'), backgroundQueries: true }
  try {
    expect((await queryUsage(ctx, { summaryOnly: true })).totals.calls).toBe(0)
    const dir = join(target, 'project/session')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v3.jsonl.zstd')
    const frame = (seq: number) => zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', seq, time: Date.now(),
      data: { usage: { inputTokens: 3 }, message: { source: { provider: 'p', model: 'm' } } } }) + '\n'))
    writeFileSync(file, frame(1))
    await Bun.sleep(100)
    expect((await queryUsage(ctx, { summaryOnly: true })).totals.calls).toBe(1)
    appendFileSync(file, frame(2))
    await Bun.sleep(100)
    const added = await queryUsage(ctx, { summaryOnly: true })
    expect(added.totals.calls).toBe(2)
    expect(added.degradedReason).toBeUndefined()
  } finally {
    await closeStatsWorker(ctx.dbPath)
    rmSync(root, { recursive: true, force: true })
  }
})

test('Worker 超时拒绝排队请求，下一次查询可以重建线程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atr-worker-timeout-'))
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [join(root, 'sessions')],
    dbPath: join(root, 'usage.sqlite'), backgroundQueries: true, queryTimeoutMs: 1 }
  try {
    const pending = await Promise.allSettled([
      queryUsage(ctx, { summaryOnly: true }),
      queryUsage({ ...ctx, queryTimeoutMs: 5000 }, { summaryOnly: true }),
    ])
    for (const result of pending) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason.message).toContain('统计查询超时')
    }
    const recovered = await queryUsage({ ...ctx, queryTimeoutMs: 5000 }, { summaryOnly: true })
    expect(recovered.source).toBe('local-db')
    expect(recovered.totals.calls).toBe(0)
  } finally {
    await closeStatsWorker(ctx.dbPath)
    rmSync(root, { recursive: true, force: true })
  }
})

test('真实 Worker 支持摘要、精确分页、手动追加刷新及外部写入，卸载释放线程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atr-worker-test-'))
  const sessionsRoot = join(root, 'sessions')
  const dbPath = join(root, 'usage.sqlite')
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [sessionsRoot], dbPath, backgroundQueries: true }
  const time = new Date(2026, 8, 25, 12).getTime()
  const frame = (seq: number) => zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', seq, time,
    data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 3 },
      message: { source: { provider: 'p', model: 'm' } } } }) + '\n'))
  const files: string[] = []
  for (let i = 0; i < 3; i++) {
    const dir = join(sessionsRoot, 'project', `session-${i}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v3.jsonl.zstd')
    writeFileSync(file, frame(1)); files.push(file)
  }
  try {
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const summary = await queryUsage(ctx, { since: '2026-09-25', until: '2026-09-25', summaryOnly: true })
    clearInterval(timer)
    expect(summary.source).toBe('local-db')
    expect(summary.totals.calls).toBe(3)
    expect(summary.sessions).toBe(3)
    expect(summary.groups).toEqual([])
    expect(ticks).toBeGreaterThan(0)
    const detail = await queryUsage(ctx, { by: ['session'], top: 2, offset: 2, series: 'hour' })
    expect(detail.groups[0]?.rowCount).toBe(3)
    expect(detail.groups[0]?.rows).toHaveLength(1)
    expect(detail.series).toHaveLength(1)
    appendFileSync(files[0]!, frame(2))
    const refreshed = await queryUsage(ctx, { summaryOnly: true, refresh: true })
    expect(refreshed.totals.calls).toBe(4)
    expect(refreshed.totals.total).toBe(420)
    const db = openDatabaseForIngest(dbPath)
    try {
      insertRecords(db, [{ eventId: 'external:1', sessionId: 'external', seq: 1, time, provider: 'p', model: 'm',
        cwd: null, turn: null, step: null, usage: { ...emptyCounts(), input: 7, total: 7, calls: 1 } }])
    } finally { db.close() }
    const external = await queryUsage(ctx, { summaryOnly: true })
    expect(external.totals.calls).toBe(5)
    expect(external.totals.total).toBe(427)
  } finally {
    await closeStatsWorker(dbPath)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
