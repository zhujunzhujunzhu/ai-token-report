/**
 * 上报器的测试。
 *
 * ★ 这一组盯的是三件**出错就很贵**的事：
 *
 * 1. **`enqueue()` 是同步的、不碰网络** —— 它在 agent 热路径上，一旦变成
 *    `await fetch`，用户会直接感觉到每一轮对话变卡。
 * 2. **失败不丢数据** —— 网络断了记录要留在磁盘上，恢复后自动补发。
 * 3. **appKey 只走 Authorization 头** —— 进了请求体或日志就是凭证泄漏。
 *
 * 全部用注入的假 `fetch`，一个字节都不出网。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, type EffectiveConfig } from '../src/config.js'
import { toWireRecord, type BillingRecord, type FoldIdentity } from '../src/fold.js'
import { MAX_REPORT_BODY_BYTES, Reporter } from '../src/reporter.js'

let home: string

const IDENTITY: FoldIdentity = {
  clientName: 'dsh-token-report',
  claimedUserId: '张三',
  userName: '张三',
  dept: '研发一部',
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-reporter-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 一份指向临时 outbox 的配置（绝不碰真实的 ~/.dsh）。 */
function configWith(overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}): EffectiveConfig {
  return resolveConfig({
    appKey: 'atr-secret-key',
    endpoint: 'https://portal.test/api/v1/token-usage',
    outbox: { dir: join(home, 'outbox') },
    batch: { maxRecords: 2, flushIntervalMillis: 60_000 },
    ...overrides,
  })
}

/** 一条计费记录。 */
function billing(seq: number, tokens = 10): BillingRecord {
  return {
    eventId: `s1:${seq}`,
    sessionId: 's1',
    seq,
    time: 1_700_000_000_000 + seq,
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    cwd: 'D:/Coding/x',
    turn: 1,
    step: seq,
    inputTokens: tokens,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: tokens + 1,
    identityViolation: false,
    identity: IDENTITY,
  }
}

/** 假 fetch：记录调用，按脚本返回。 */
function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; calls: { url: string; init: RequestInit; body: unknown }[] } {
  const calls: { url: string; init: RequestInit; body: unknown }[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, init: init ?? {}, body })
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 服务端接受了全部记录。 */
function okResponse(count = 0): Response {
  return new Response(JSON.stringify({ accepted: count, duplicates: 0, rejected: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('★ 热路径：enqueue 只入队', () => {
  test('enqueue 同步返回，不做任何网络调用', () => {
    const { impl, calls } = fakeFetch(() => okResponse())
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    // 没有 await、没有 setTimeout 展开 —— 调用一返回就必须已经入队
    expect(calls).toHaveLength(0)
    expect(reporter.stats().queueLength).toBe(1)
    expect(reporter.stats().enqueued).toBe(1)
  })

  test('满一批才触发发送（maxRecords = 2）', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(2))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    expect(calls).toHaveLength(0)

    reporter.enqueue(billing(2))
    // 满批同样还在 agent 同步热路径上，不能提前写盘或碰网络。
    expect(calls).toHaveLength(0)
    expect(readdirSync(reporter.outbox!.dir)).toHaveLength(0)
    // 触发的是异步链路，给它一个微任务的机会
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
    expect((calls[0]?.body as { records: unknown[] }).records).toHaveLength(2)
  })

  test('hintFlush 把手上攒的发出去（turn 结束的提示）', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    reporter.hintFlush()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
  })

  test('队列为空时 hintFlush 不发空请求', async () => {
    const { impl, calls } = fakeFetch(() => okResponse())
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.hintFlush()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(0)
  })
})

describe('★ 请求形状与凭证', () => {
  test('appKey 只出现在 Authorization 头，绝不出现在请求体里', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()

    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer atr-secret-key')
    expect(headers['Content-Type']).toBe('application/json')
    // ★ 请求体里绝不能出现凭证
    expect(JSON.stringify(calls[0]?.body)).not.toContain('atr-secret-key')
  })

  test('载荷形状符合服务端契约（schemaVersion / client / records）', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()

    const body = calls[0]?.body as Record<string, unknown>
    expect(body['schemaVersion']).toBe(1)
    expect(body['client']).toEqual({
      name: 'dsh-token-report',
      userId: '张三',
      userName: '张三',
      dept: '研发一部',
    })
    expect(typeof body['generatedAt']).toBe('string')

    const records = body['records'] as Record<string, unknown>[]
    expect(records[0]).toMatchObject({
      event_id: 's1:1',
      session_id: 's1',
      seq: 1,
      provider: 'dashscope',
      model: 'deepseek-v4.1-flash',
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 11,
    })
  })

  test('URL 就是配置里的 endpoint', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(calls[0]?.url).toBe('https://portal.test/api/v1/token-usage')
  })
})

describe('★ 失败不丢数据', () => {
  test('outbox 路径不可写时仍从内存投递，不静默清掉记录', async () => {
    const blocked = join(home, 'blocked')
    writeFileSync(blocked, '这里是文件，不能建子目录')
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({
      config: configWith({ outbox: { dir: join(blocked, 'outbox') } }),
      identity: IDENTITY, fetchImpl: impl,
    })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(calls).toHaveLength(1)
    expect(reporter.stats().delivered).toBe(1)
    expect(reporter.stats().queueLength).toBe(0)
  })

  test('磁盘与网络同时不可用时保留内存，恢复后能补发', async () => {
    const blocked = join(home, 'blocked')
    writeFileSync(blocked, '这里是文件，不能建子目录')
    let offline = true
    const { impl } = fakeFetch(() => {
      if (offline) throw new Error('离线')
      return okResponse(1)
    })
    const reporter = new Reporter({
      config: configWith({ outbox: { dir: join(blocked, 'outbox') } }),
      identity: IDENTITY, fetchImpl: impl,
    })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().queueLength).toBe(1)
    expect(reporter.stats().delivered).toBe(0)
    offline = false
    await reporter.shutdown()
    expect(reporter.stats().delivered).toBe(1)
    expect(reporter.stats().queueLength).toBe(0)
  })

  test('网络错误 → 记录留在 outbox 里，不推进统计', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const config = configWith()
    const reporter = new Reporter({ config, identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()

    const stats = reporter.stats()
    expect(stats.delivered).toBe(0)
    expect(stats.failures).toBe(1)
    expect(stats.lastError).toContain('ECONNREFUSED')
    // ★ 数据还在磁盘上 —— 这是「崩溃/断网不丢」的落点
    expect(stats.outbox.pendingRecords).toBe(1)
    expect(readdirSync(config.outbox.dir!).some((f) => f.startsWith('pending-'))).toBe(true)
  })

  test('恢复后下一轮把历史遗留一并补发（同一批不会重复投递两次）', async () => {
    let fail = true
    const { impl, calls } = fakeFetch(() => {
      if (fail) throw new Error('ECONNREFUSED')
      return okResponse(1)
    })
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().outbox.pendingRecords).toBe(1)

    fail = false
    await reporter.flush()

    expect(calls).toHaveLength(2)
    const stats = reporter.stats()
    expect(stats.delivered).toBe(1)
    expect(stats.outbox.pendingRecords).toBe(0)
  })

  test('非 2xx 也当作失败（并带上状态码）', async () => {
    const { impl } = fakeFetch(() => new Response('bad token', { status: 401 }))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()

    expect(reporter.stats().lastError).toContain('401')
    expect(reporter.stats().outbox.pendingRecords).toBe(1)
  })

  test.each([
    '', '<html>反向代理首页</html>', '{}', '[]',
    JSON.stringify({ accepted: 0, duplicates: 0, rejected: 0 }),
    JSON.stringify({ accepted: -1, duplicates: 2, rejected: 0 }),
    JSON.stringify({ accepted: 0.5, duplicates: 0.5, rejected: 0 }),
  ])('2xx 但没有完整匹配回执时保留 outbox：%s', async (raw) => {
    const { impl } = fakeFetch(() => new Response(raw, { status: 200 }))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().delivered).toBe(0)
    expect(reporter.stats().failures).toBe(1)
    expect(reporter.stats().outbox.pendingRecords).toBe(1)
  })

  test('拒收回执没有逐条标识时保留整批，不猜测哪些记录可删除', async () => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ accepted: 0, duplicates: 0, rejected: 1 })))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().rejected).toBe(1)
    expect(reporter.stats().outbox.pendingRecords).toBe(1)
    expect(reporter.stats().lastError).toContain('拒收')
  })

  test('只收到响应头而响应体悬挂时也必须超时并保留批次', async () => {
    const { impl } = fakeFetch((_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('已超时', 'AbortError')), { once: true })
      },
    })))
    const reporter = new Reporter({
      config: configWith({ batch: { timeoutMillis: 20 } }), identity: IDENTITY, fetchImpl: impl,
    })
    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().lastError).toContain('超时')
    expect(reporter.stats().outbox.pendingRecords).toBe(1)
  })

  test('服务端返回的重复计数被如实记录（幂等去重的正常现象，不是错误）', async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ accepted: 0, duplicates: 1, rejected: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.flush()

    expect(reporter.stats().duplicates).toBe(1)
    expect(reporter.stats().lastError).toBeNull()
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
  })
})

describe('★ 崩溃不丢：新进程重放上一轮的 inflight', () => {
  test('构造 Reporter 时会 recover 残留数据，下一个 flush 就补发', async () => {
    // 第一段生命周期：发出去了但没等到回执（模拟进程被杀）
    const config = configWith()
    const dying = fakeFetch(() => {
      throw new Error('进程在此刻被杀')
    })
    const first = new Reporter({ config, identity: IDENTITY, fetchImpl: dying.impl })
    first.enqueue(billing(7))
    await first.flush()
    expect(first.stats().outbox.pendingRecords).toBe(1)
    // 手工把它挪成 inflight，模拟「已发出、未确认」的中间态
    const pendingFile = readdirSync(config.outbox.dir!).find((f) => f.startsWith('pending-'))!
    first.outbox!.markInflight(pendingFile)

    // 第二段生命周期：新进程启动
    const revived = fakeFetch(() => okResponse(1))
    const second = new Reporter({ config, identity: IDENTITY, fetchImpl: revived.impl })
    await second.flush()

    expect(revived.calls).toHaveLength(1)
    expect(second.stats().delivered).toBe(1)
    expect(second.stats().outbox.pendingRecords).toBe(0)
  })
})

describe('生命周期', () => {
  test('shutdown 等待正在发送的批次，再排空后来入队的记录', async () => {
    let finishFirst!: () => void
    let requestCount = 0
    const { impl, calls } = fakeFetch(async () => {
      if (++requestCount === 1) await new Promise<void>((resolve) => { finishFirst = resolve })
      return okResponse(1)
    })
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.enqueue(billing(1))
    const first = reporter.flush()
    await Promise.resolve()
    reporter.enqueue(billing(2))
    let stopped = false
    const stopping = reporter.shutdown().then(() => { stopped = true })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(stopped).toBe(false)
    } finally {
      finishFirst()
      await first
      await stopping
    }
    expect(calls).toHaveLength(2)
    expect(reporter.stats().delivered).toBe(2)
    expect(reporter.stats().queueLength).toBe(0)
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
  })

  test('shutdown 把内存队列落盘并排空', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const config = configWith()
    const reporter = new Reporter({ config, identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.shutdown()

    expect(calls).toHaveLength(1)
    expect(reporter.stats().queueLength).toBe(0)
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
  })

  test('shutdown 时网络不通 → 数据留在磁盘上，不抛错', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('离线')
    })
    const config = configWith()
    const reporter = new Reporter({ config, identity: IDENTITY, fetchImpl: impl })

    reporter.enqueue(billing(1))
    await reporter.shutdown()

    expect(reporter.stats().outbox.pendingRecords).toBe(1)
  })

  test('shutdown 之后再 enqueue 不再收数据（优雅停机后不该有新写入）', async () => {
    const { impl } = fakeFetch(() => okResponse())
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    await reporter.shutdown()

    reporter.enqueue(billing(1))
    expect(reporter.stats().enqueued).toBe(0)
  })

  test('start 起定时器，shutdown 会停掉它（不把进程钉住）', async () => {
    const { impl } = fakeFetch(() => okResponse())
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.start()
    reporter.start() // 重复 start 不该起两个定时器
    await reporter.shutdown()
    // 能正常结束即通过 —— 若定时器没被清掉，bun test 会挂在这里
    expect(reporter.stats().queueLength).toBe(0)
  })
})

describe('outbox 关闭时的降级路径', () => {
  test('outbox.enabled=false → 不落盘，但仍然投递', async () => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({
      config: configWith({ outbox: { enabled: false } }),
      identity: IDENTITY,
      fetchImpl: impl,
    })

    reporter.enqueue(billing(1))
    await reporter.flush()

    expect(calls).toHaveLength(1)
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
  })

  test('outbox 关闭 + 发送失败 → 记录退回内存队列，等下一轮（不静默丢）', async () => {
    let fail = true
    const { impl } = fakeFetch(() => {
      if (fail) throw new Error('离线')
      return okResponse(1)
    })
    const reporter = new Reporter({
      config: configWith({ outbox: { enabled: false } }),
      identity: IDENTITY,
      fetchImpl: impl,
    })

    reporter.enqueue(billing(1))
    await reporter.flush()
    expect(reporter.stats().queueLength).toBe(1)

    fail = false
    await reporter.flush()
    expect(reporter.stats().delivered).toBe(1)
    expect(reporter.stats().queueLength).toBe(0)
  })
})

describe('有界工作量与快照', () => {
  test('读取 generation 和其它标量统计不会调用磁盘快照', () => {
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY })
    const disk = spyOn(reporter.outbox!, 'stats')
    try {
      reporter.enqueue(billing(1))
      expect(reporter.stats.enqueued).toBe(1)
      expect(reporter.stats.queueLength).toBe(1)
      expect(reporter.stats.delivered).toBe(0)
      expect(reporter.stats.duplicates).toBe(0)
      expect(reporter.stats.rejected).toBe(0)
      expect(reporter.stats.requests).toBe(0)
      expect(reporter.stats.failures).toBe(0)
      expect(reporter.stats.lastSuccessAt).toBe(0)
      expect(reporter.stats.lastError).toBeNull()
      expect(disk).not.toHaveBeenCalled()
      reporter.stats()
      expect(disk).toHaveBeenCalledTimes(1)
    } finally { disk.mockRestore() }
  })

  test('同步突发入队也严格按 maxRecords 切分，所有记录各发送一次', async () => {
    const { impl, calls } = fakeFetch((_url, init) => okResponse(JSON.parse(String(init.body)).records.length))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    for (let i = 0; i < 21; i++) reporter.enqueue(billing(i))
    expect(calls).toHaveLength(0)
    await reporter.flush()
    const batches = calls.map(call => (call.body as { records: { seq: number }[] }).records)
    expect(batches.every(batch => batch.length <= 2)).toBe(true)
    expect(batches.flat().map(record => record.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i))
    expect(reporter.stats.enqueued).toBe(21)
    expect(reporter.stats.delivered).toBe(21)
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
  })

  test('按 UTF-8 字节而非字符串长度切分请求', async () => {
    const { impl, calls } = fakeFetch((_url, init) => okResponse(JSON.parse(String(init.body)).records.length))
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    for (let i = 0; i < 2; i++) reporter.enqueue({ ...billing(i), cwd: '路'.repeat(200000) })
    await reporter.flush()
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(Buffer.byteLength(String(call.init.body))).toBeLessThanOrEqual(MAX_REPORT_BODY_BYTES)
    expect(reporter.stats.delivered).toBe(2)
  })

  test.each([true, false])('不可拆分的超大单条保留副本并报告错误（outbox=%s）', async (enabled) => {
    const { impl, calls } = fakeFetch(() => okResponse(1))
    const reporter = new Reporter({ config: configWith({ outbox: { enabled, dir: join(home, 'outbox') } }), identity: IDENTITY, fetchImpl: impl })
    reporter.enqueue({ ...billing(1), cwd: 'x'.repeat(MAX_REPORT_BODY_BYTES) })
    await reporter.flush()
    expect(calls).toHaveLength(0)
    expect(reporter.stats.queueLength).toBe(enabled ? 0 : 1)
    if (enabled) expect(reporter.stats().outbox.pendingRecords).toBe(1)
    expect(reporter.stats.lastError).toContain('单条上报记录超过')
  })

  test('断网时只读取正在尝试发送的一批，不预读其它历史文件', async () => {
    const { impl, calls } = fakeFetch(() => { throw new Error('离线') })
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    for (let i = 0; i < 6; i++) reporter.outbox!.write([toWireRecord(billing(i))])
    const take = spyOn(reporter.outbox!, 'take')
    try {
      await reporter.flush()
      expect(calls).toHaveLength(1)
      expect(take.mock.calls).toEqual([[1]])
      expect(reporter.stats().outbox.pendingRecords).toBe(6)
    } finally { take.mockRestore() }
  })

  test('历史大文件拆请求后中途失败，保留源文件并通过幂等重试完整恢复', async () => {
    const seen = new Set<number>()
    let attempt = 0
    const { impl, calls } = fakeFetch((_url, init) => {
      if (++attempt === 2) throw new Error('中途断开')
      const batch = JSON.parse(String(init.body)).records as { seq: number }[]
      const accepted = batch.filter(record => !seen.has(record.seq)).length
      for (const record of batch) seen.add(record.seq)
      return new Response(JSON.stringify({ accepted, duplicates: batch.length - accepted, rejected: 0 }))
    })
    const reporter = new Reporter({ config: configWith(), identity: IDENTITY, fetchImpl: impl })
    reporter.outbox!.write(Array.from({ length: 5 }, (_, i) => toWireRecord(billing(i))))
    await reporter.flush()
    expect(reporter.stats.delivered).toBe(2)
    expect(reporter.stats().outbox.pendingRecords).toBe(5)
    await reporter.flush()
    expect(reporter.stats.delivered).toBe(5)
    expect(reporter.stats.duplicates).toBe(2)
    expect(reporter.stats().outbox.pendingRecords).toBe(0)
    expect(calls.every(call => (call.body as { records: unknown[] }).records.length <= 2)).toBe(true)
  })

  test('内存降级路径中途失败后，只保留未确认队尾并保持顺序', async () => {
    let attempt = 0
    const { impl, calls } = fakeFetch((_url, init) => {
      if (++attempt === 2) throw new Error('中途断开')
      return okResponse(JSON.parse(String(init.body)).records.length)
    })
    const reporter = new Reporter({
      config: configWith({ outbox: { enabled: false } }), identity: IDENTITY, fetchImpl: impl,
    })
    for (let i = 0; i < 5; i++) reporter.enqueue(billing(i))
    await reporter.flush()
    expect(reporter.stats.queueLength).toBe(3)
    reporter.enqueue(billing(5))
    await reporter.flush()
    expect(reporter.stats.delivered).toBe(6)
    expect(reporter.stats.queueLength).toBe(0)
    expect(calls.slice(2).flatMap(call => (call.body as { records: { seq: number }[] }).records.map(r => r.seq))).toEqual([2, 3, 4, 5])
  })
})
