/** 历史补报必须覆盖未打开会话、失败重启和跨文件低序号；只用隔离日志和假接收端。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { resolveConfig, type EffectiveConfig } from '../src/config.js'
import type { FoldIdentity } from '../src/fold.js'
import { resolveBackfillDir, runBackfillPass } from '../src/backfill-runner.js'
import { createHistoryBackfill } from '../src/backfill.js'

let home: string
let sessionsRoot: string
let config: EffectiveConfig
const identity: FoldIdentity = { clientName: 'history-test', claimedUserId: '已签名成员', userName: '已签名成员' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-backfill-'))
  sessionsRoot = join(home, 'sessions')
  mkdirSync(sessionsRoot)
  config = resolveConfig({ dshHome: home, endpoint: 'https://portal.test/api/v1/token-usage',
    appKey: 'private-backfill-test-key', batch: { maxRecords: 2 } })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function usage(seq: number) {
  return { type: 'assistant/message', seq, time: 1_790_000_000_000 + seq,
    data: { turn: 2, step: seq, message: { source: { provider: 'provider', model: 'model' },
      content: '不准传输的会话内容' }, usage: { inputTokens: 10, outputTokens: 2,
      cacheReadTokens: 100, cacheWriteTokens: 3, reasoningTokens: 1, totalTokens: 115 } } }
}
function frame(events: unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
}
function writeSession(session: string, events: unknown[], name = 'session.v3.jsonl.zstd'): string {
  const path = join(sessionsRoot, 'project', session, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, frame(events))
  return path
}
function receiver(onCall?: (call: number, records: Record<string, unknown>[]) => Response | undefined) {
  const stored = new Map<string, Record<string, unknown>>()
  let requests = 0
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { records: Record<string, unknown>[] }
    expect(JSON.stringify(payload)).not.toContain('不准传输的会话内容')
    expect(JSON.stringify(payload)).not.toContain(config.appKey)
    requests++
    const override = onCall?.(requests, payload.records)
    if (override) return override
    let accepted = 0
    let duplicates = 0
    for (const record of payload.records) {
      const id = String(record.event_id)
      if (stored.has(id)) duplicates++
      else { stored.set(id, record); accepted++ }
    }
    return Response.json({ accepted, duplicates, rejected: 0 })
  }) as typeof fetch
  return { stored, fetchImpl, get requests() { return requests } }
}

describe('磁盘历史全量补报', () => {
  test('没有活跃会话对象也上报全部历史，四列保持独立且完成后无重复网络请求', async () => {
    writeSession('closed-a', [{ type: 'session', data: { cwd: '/project/a' } }, usage(1), usage(2)])
    writeSession('closed-b', [usage(4)])
    const target = receiver()
    const first = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(first).toMatchObject({ status: 'complete', filesTotal: 2, filesProcessed: 2, accepted: 3, confirmed: 3 })
    expect(first.lastCompletedAt).toBeGreaterThan(0)
    expect(target.stored.get('closed-a:1')).toMatchObject({ input_tokens: 10, output_tokens: 2,
      cache_read_tokens: 100, cache_write_tokens: 3, reasoning_tokens: 1, total_tokens: 115, cwd: '/project/a' })
    const calls = target.requests
    const second = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(second.status).toBe('complete')
    expect(second.confirmed).toBe(0)
    expect(target.requests).toBe(calls)
  })

  test('超过实时 outbox 单轮50批限制仍完整发送，历史不进入实时 outbox', async () => {
    config = { ...config, batch: { ...config.batch, maxRecords: 1 } }
    writeSession('long-history', Array.from({ length: 121 }, (_, i) => usage(i + 1)))
    const target = receiver()
    const result = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(result.status).toBe('complete')
    expect(target.requests).toBe(121)
    expect(target.stored.size).toBe(121)
    expect(readdirSync(join(home, 'token-report'))).toEqual(['backfill'])
  })

  test('同会话后发现的低序号分段不会被过滤，分段继承项目归属', async () => {
    const path = writeSession('split', [{ type: 'session', data: { cwd: '/project/split' } }, usage(100)], 'session.00.jsonl.zstd')
    const target = receiver()
    await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    writeSession('split', [usage(1)], 'session.01.jsonl.zstd')
    appendFileSync(path, frame([usage(101)]))
    const result = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(result.status).toBe('complete')
    expect([...target.stored.keys()].sort()).toEqual(['split:1', 'split:100', 'split:101'])
    expect(target.stored.get('split:1')?.cwd).toBe('/project/split')
  })

  test('断网停止整轮且不推进文件光标，重启重发已确认前缀后补齐', async () => {
    writeSession('first', [usage(1), usage(2), usage(3)])
    writeSession('second', [usage(4)])
    let online = false
    const target = receiver(call => !online && call >= 2 ? new Response('临时离线', { status: 503 }) : undefined)
    const failed = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(failed).toMatchObject({ status: 'retrying', filesProcessed: 0, confirmed: 2, lastCompletedAt: 0 })
    expect(target.requests).toBe(2)
    expect(readdirSync(resolveBackfillDir(config, sessionsRoot))).toEqual([])
    online = true
    const recovered = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(recovered).toMatchObject({ status: 'complete', confirmed: 4, accepted: 2, duplicates: 2 })
    expect(target.stored.size).toBe(4)
  })

  test('2xx HTML及不完整计数都不算完成，错误回显不会进入补报诊断', async () => {
    writeSession('missing-ack', [usage(1)])
    for (const response of [new Response('代理页面'), Response.json({ accepted: 0, duplicates: 0, rejected: 0 }),
      new Response(`凭证：${config.appKey.slice(0, 10)}`, { status: 401 })]) {
      const result = await runBackfillPass({ config, identity, sessionsRoot,
        fetchImpl: (async () => response) as unknown as typeof fetch })
      expect(result.status).toBe('retrying')
      expect(result.lastCompletedAt).toBe(0)
      expect(result.lastError).not.toContain('凭证：')
      expect(result.lastError).not.toContain(config.appKey.slice(0, 10))
      expect(readdirSync(resolveBackfillDir(config, sessionsRoot))).toEqual([])
    }
  })

  test('完整前缀之后的半帧不能被标记完成，补齐后重扫并确认', async () => {
    const path = writeSession('partial', [usage(1)])
    const tail = frame([usage(2)])
    appendFileSync(path, tail.subarray(0, 8))
    const target = receiver()
    const first = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(first.status).toBe('retrying')
    expect(first.lastError).toContain('压缩帧')
    expect(readdirSync(resolveBackfillDir(config, sessionsRoot))).toEqual([])
    appendFileSync(path, tail.subarray(8))
    const second = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(second).toMatchObject({ status: 'complete', accepted: 1, duplicates: 1 })
    expect(target.stored.size).toBe(2)
  })

  test('单个文件被拒收仍尝试其它文件，但整轮不得宣称完成', async () => {
    writeSession('a-invalid', [usage(1)])
    writeSession('b-valid', [usage(2)])
    const target = receiver((_call, records) => records[0]?.event_id === 'a-invalid:1'
      ? new Response('记录格式不合法', { status: 400 }) : undefined)
    const result = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(result).toMatchObject({ status: 'retrying', filesProcessed: 1, filesTotal: 2, accepted: 1, lastCompletedAt: 0 })
    expect(target.stored.has('b-valid:2')).toBe(true)
  })

  test('未凑齐 magic 的尾部和完全损坏的文件都不写完成光标', async () => {
    const partial = writeSession('partial-magic', [usage(1)])
    appendFileSync(partial, Buffer.from([0x28, 0xb5]))
    const corrupt = writeSession('corrupt', [])
    writeFileSync(corrupt, Buffer.from('损坏的压缩文件'))
    const target = receiver()
    const result = await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(result).toMatchObject({ status: 'retrying', filesProcessed: 0, lastCompletedAt: 0 })
    expect(readdirSync(resolveBackfillDir(config, sessionsRoot))).toEqual([])
  })

  test('目标地址和凭证分别隔离历史光标，状态文件不保存凭证明文', async () => {
    writeSession('scoped', [usage(1)])
    const target = receiver()
    await runBackfillPass({ config, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    const base = resolveBackfillDir(config, sessionsRoot)
    const changed = { ...config, endpoint: 'https://another.test/api/v1/token-usage' }
    expect(resolveBackfillDir(changed, sessionsRoot)).not.toBe(base)
    expect(resolveBackfillDir({ ...config, appKey: 'rotated-key' }, sessionsRoot)).not.toBe(base)
    expect(base).not.toContain(config.appKey)
    for (const file of readdirSync(base)) expect(readFileSync(join(base, file), 'utf8')).not.toContain(config.appKey)
    const replayed = await runBackfillPass({ config: changed, identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(replayed).toMatchObject({ status: 'complete', confirmed: 1, duplicates: 1 })
  })

  test('未签名或禁用上报不扫描、不建光标、不发请求；找不到根目录也不假报完成', async () => {
    const target = receiver()
    const unsigned = await runBackfillPass({ config, identity: { ...identity, claimedUserId: '' }, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(unsigned.status).toBe('retrying')
    const disabled = await runBackfillPass({ config: { ...config, features: { ...config.features, reporting: false } },
      identity, sessionsRoot, fetchImpl: target.fetchImpl })
    expect(disabled.status).toBe('retrying')
    expect(readdirSync(home)).toEqual(['sessions'])
    const missing = await runBackfillPass({ config, identity, sessionsRoot: join(home, 'missing'), fetchImpl: target.fetchImpl })
    expect(missing.status).toBe('retrying')
    expect(missing.lastCompletedAt).toBe(0)
    expect(target.requests).toBe(0)
  })

  test('线程启动异步完成空目录核对，stop确实终止后台工作', async () => {
    let done!: () => void
    const completed = new Promise<void>(resolve => { done = resolve })
    const controller = createHistoryBackfill({ config, identity, sessionsRoot,
      onLog: (_level, message) => { if (message.includes('历史补报完成')) done() } })
    controller.start()
    expect(controller.stats().status).toBe('running')
    try {
      await Promise.race([completed, new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('补报线程未完成')), 10_000)
        timer.unref()
      })])
      expect(controller.stats().status).toBe('complete')
    } finally { await controller.stop() }
    expect(controller.stats().status).toBe('stopped')
  }, 15_000)
})
