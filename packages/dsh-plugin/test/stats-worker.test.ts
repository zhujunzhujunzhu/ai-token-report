/** 真线程验证：查询、刷新、外部写入和卸载不能依赖宿主线程里的数据库状态。 */
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { queryUsage, type StatsContext } from '../src/stats.js'
import { closeStatsWorker } from '../src/stats-worker-client.js'
import { openDatabaseForIngest, insertRecords } from '@ai-token-report/core/db'
import { emptyCounts, resolveSourceRoots } from '@ai-token-report/core'

test('会话根目录是联接时，监听真实目录但增量路径保持调用方目录', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'atr-worker-alias-'))
  const target = join(root, 'real-sessions')
  const sessionsRoot = join(root, 'alias-sessions')
  mkdirSync(target)
  symlinkSync(target, sessionsRoot, process.platform === 'win32' ? 'junction' : 'dir')
  // `dataDir` 是金额的取价来源（`pricing.json`）：钉在临时目录里，
  // 免得读到开发者本机真实的单价快照，让断言随机器漂移。
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [sessionsRoot], dbPath: join(root, 'usage.sqlite'), dataDir: join(root, 'data'), backgroundQueries: true }
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
    dbPath: join(root, 'usage.sqlite'), dataDir: join(root, 'data'), backgroundQueries: true, queryTimeoutMs: 1 }
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

test('★ 面板默认只统计 DSH：库里别的来源的行（Codex）不许混进来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atr-worker-sources-'))
  const dbPath = join(root, 'usage.sqlite')
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [join(root, 'sessions')],
    dbPath, dataDir: join(root, 'data'), backgroundQueries: true }
  /**
   * 本地库是 CLI / 本地页 / 插件 / report **共用的一个文件**：CLI 跑过一次缺省运行
   * （或 `--source all`）之后，库里就躺着别的来源的行。而 `openStats` 的 `sources`
   * 缺省语义是「库里的全部来源」—— 面板不显式收窄就会把这些行当成自己的数字。
   *
   * ⚠️ 这里**不能用 `insertRecords` 造那条 Codex 行**：它对非 `dsh` 来源是硬拒绝的
   *   （种子数据不许带来源）。所以走真路径：造一份最小的 Codex rollout 日志，
   *   让 `ingestPlainSources()` 自己把它写进去。
   */
  const codexHome = join(root, 'codex-home')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const dayDir = join(codexHome, 'sessions', '2026', '01', '01')
  mkdirSync(dayDir, { recursive: true })
  const envelope = (ordinal: number, type: string, payload: unknown, at: string) =>
    JSON.stringify({ timestamp: at, ordinal, type, payload })
  writeFileSync(join(dayDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`), [
    envelope(0, 'session_meta', { session_id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/work/codex', model_provider: 'openai' }, '2026-01-01T00:00:00.000Z'),
    envelope(1, 'turn_context', { model: 'gpt-5-codex', cwd: '/work/codex' }, '2026-01-01T00:00:00.500Z'),
    envelope(2, 'event_msg', { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
    } }, '2026-01-01T00:00:01.000Z'),
  ].join('\n') + '\n')
  const codexRoots = resolveSourceRoots({ sources: ['codex'], homes: { codex: [codexHome] } }).roots
  try {
    // ① 白名单里显式配上 Codex：这一轮把 Codex 的用量写进**同一个库**，并如实算出来
    const withCodex = await queryUsage({ ...ctx, sourceRoots: codexRoots, sources: ['dsh', 'codex'] }, { summaryOnly: true })
    expect(withCodex.totals.calls).toBe(1)
    expect(withCodex.totals.total).toBe(1050)

    // ② 关键断言：白名单为空（缺省 = 只统计 DSH）时，库里那条 Codex 行**一位都不许算**
    const dshOnly = await queryUsage(ctx, { summaryOnly: true })
    expect(dshOnly.totals.calls).toBe(0)
    expect(dshOnly.totals.total).toBe(0)

    // ③ 收回白名单之外的那一轮：DSH 的口径没有被「筛选」这件事本身改坏
    const stillBoth = await queryUsage({ ...ctx, sourceRoots: codexRoots, sources: ['dsh', 'codex'] }, { summaryOnly: true })
    expect(stillBoth.totals.total).toBe(1050)
  } finally {
    await closeStatsWorker(dbPath)
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

test('真实 Worker 支持摘要、精确分页、手动追加刷新及外部写入，卸载释放线程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atr-worker-test-'))
  const sessionsRoot = join(root, 'sessions')
  const dbPath = join(root, 'usage.sqlite')
  const ctx: StatsContext = { config: { localDb: true }, sessionsRoots: [sessionsRoot], dbPath, dataDir: join(root, 'data'), backgroundQueries: true }
  /**
   * ★ 单价快照放进 `dataDir`，用来证明 **Worker 通道真的把 `dataDir` 传进去了**。
   *
   * 漏传的后果是「金额一位都不显示」—— 它会落到 `pricingSource: 'none'` + 空价表，
   * 并把原因写进 note（2026-10 起不再有内置种子价兜底），于是使用者看到的
   * 是「未计价」而不是与看板不一致的金额；这一条断言就是用来钉住那个通道的。
   * 所以这里断言 `pricingSource === 'snapshot'`（读到的是**这一份**快照），
   * 以及金额确实按四类分价算出来了。
   */
  mkdirSync(ctx.dataDir, { recursive: true })
  writeFileSync(join(ctx.dataDir, 'pricing.json'), JSON.stringify({ syncedAtMs: 0, prices: [
    { provider: 'p', model: 'm', currency: 'CNY', inputMicroPerKtok: 1000, outputMicroPerKtok: 2000,
      cacheReadMicroPerKtok: 500, cacheWriteMicroPerKtok: 4000, effectiveFromMs: 0, effectiveToMs: null },
  ] }))
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
    // ★ 金额也必须在 Worker 里算出来，且用的是 dataDir 里那一份快照：
    //   3 条事件各 input 10 / output 2 / cacheRead 90 / cacheWrite 3 →
    //   30×1000/1000 + 6×2000/1000 + 270×500/1000 + 9×4000/1000 = 213 微元。
    expect(summary.cost.pricing.pricingSource).toBe('snapshot')
    expect(summary.cost.costs).toEqual([{ currency: 'CNY', amountMicro: 213, tokens: 315 }])
    expect(summary.cost.unpricedTokens).toBe(0)
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
      insertRecords(db, [{ source: 'dsh', eventId: 'external:1', sessionId: 'external', seq: 1, time, provider: 'p', model: 'm',
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
