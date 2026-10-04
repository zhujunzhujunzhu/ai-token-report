/**
 * `apply()` 的装配测试。
 *
 * ★ 这里钉死的是**装上去之后会发生什么**：
 *
 * 1. 未署名 / 未配凭证 → **一个字节都不往外发**（合规底线）
 * 2. 三项齐了 → 注册上报捕获、工具、服务，且 emit 走的是同一条队列
 * 3. 正文不外发 → 宿主交过来的事件里带对话内容 / 命令参数时，
 *    落到请求体里的只有计费字段（走**真实**捕获路径，不是手工调脱敏函数）
 * 4. 凭证不泄漏进日志
 *
 * 用的是假 ctx（不搭 cordis 运行时）—— 我们测的是**装配决策**与**捕获路径**，
 * 而不是 cordis 的事件分发（那是 DSH 自己的测试覆盖范围）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { apply, describeDisabled, evaluateStatus, TOOL_NAME, type ApplyContext } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import type { EffectiveConfig } from '../src/config.js'
import type { FoldIdentity, TelemetryRecord } from '../src/fold.js'
import { Reporter } from '../src/reporter.js'

let home: string
let dataDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-apply-'))
  // 显式给数据目录：缺省在家目录下（`~/.ai-token-report`），不给就会读写真实身份与本地库。
  dataDir = join(home, 'token-report')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 假 ctx：只实现 apply() 用到的几个能力（不搭 cordis 运行时）。 */
function fakeCtx(): {
  ctx: ApplyContext
  logs: { level: string; message: string }[]
  provided: Record<string, unknown>
  listeners: Record<string, ((...args: unknown[]) => unknown)[]>
  effects: number
} {
  const logs: { level: string; message: string }[] = []
  const provided: Record<string, unknown> = {}
  const listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {}
  let effects = 0

  const ctx: ApplyContext = {
    logger: {
      info: (message) => void logs.push({ level: 'info', message }),
      warn: (message) => void logs.push({ level: 'warn', message }),
    },
    // ⚠️ 必须**真的执行**回调：cordis 的 `ctx.effect(fn)` 会立即调用 fn 来完成注册，
    //    只在 fn 的返回值上挂 dispose。把这里写成「只计数不执行」，
    //    测出来的就是「捕获侧没挂上」—— 而生产环境里它是挂上的。
    effect: (callback) => {
      effects += 1
      callback()
    },
    // 捕获侧订阅的是宿主会话事件流：`session/event` 与 `session/flush`。
    on: ((event: string, listener: (...args: unknown[]) => unknown) => {
      ;(listeners[event] ??= []).push(listener)
      return () => {}
    }) as ApplyContext['on'],
    reflect: {
      provide: (name, value) => void (provided[name] = value),
    },
  }

  return {
    ctx,
    logs,
    provided,
    listeners,
    get effects() {
      return effects
    },
  }
}

/** 写一份已署名的身份文件。 */
function signIdentity(): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'identity.json'),
    JSON.stringify({ name: '张三', token: 'tok-abc', group: '研发一部', createdAt: 1, updatedAt: 1 }),
    'utf8',
  )
}

/** 一份计费事件（账本记录形状，与捕获侧拼出来的一致）。 */
function event(seq: number): TelemetryRecord {
  return {
    channel: 'ledger',
    time: 1_700_000_000_000 + seq,
    severity: 'info',
    attributes: {
      'session.id': 's1',
      'event.type': 'assistant/message',
      'event.seq': seq,
      'session.cwd': 'D:/Coding/x',
    },
    body: {
      turn: 1,
      step: seq,
      message: { source: { kind: 'model', provider: 'dashscope', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 },
    },
  }
}

/**
 * 拦截出网请求：**绝不真的发请求**。
 *
 * ⚠️ 这里替换的是全局 `fetch`，而不是往 `apply()` 里注入一个假的 ——
 *   因为 `apply()` 走的是真实的 `TokenReportCapture`，那正是我们要测的东西。
 *   注入工厂会绕开它，测出来的就不是生产路径了。
 */
function interceptFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string; init: RequestInit; body: unknown }[]
  restore: () => void
} {
  const calls: { url: string; init: RequestInit; body: unknown }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}

/** 一份「服务端接受了全部记录」的响应。 */
function okResponse(accepted = 1): Response {
  return new Response(JSON.stringify({ accepted, duplicates: 0, rejected: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('启用插件后自动补报未打开的历史会话，诊断可读且停机终止线程', async () => {
  signIdentity()
  const sessionDir = join(home, 'sessions', 'project', 'unopened-history')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'assistant/message', seq: 7, time: 1_700_000_000_000,
    data: { usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 5 },
      message: { source: { provider: 'p', model: 'm' }, content: '不得上报的正文' } },
  }) + '\n')))
  const received: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120,
    async fetch(request) {
      const body = await request.json() as { records: Record<string, unknown>[] }
      received.push(...body.records)
      return okResponse(body.records.length)
    },
  })
  const fake = fakeCtx()
  const { backend } = apply(fake.ctx, { dshHome: home, dataDir, appKey: 'tok-abc',
    endpoint: `http://127.0.0.1:${server.port}/api/v1/token-usage` })
  try {
    expect(backend).not.toBeNull()
    const deadline = Date.now() + 8000
    while (backend!.backfillStats().status !== 'complete' && Date.now() < deadline) await Bun.sleep(20)
    expect(backend!.backfillStats().status).toBe('complete')
    expect(backend!.backfillStats().confirmed).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ event_id: 'unopened-history:7', input_tokens: 3,
      output_tokens: 2, cache_read_tokens: 90, cache_write_tokens: 5, total_tokens: 100 })
    expect(JSON.stringify(received)).not.toContain('不得上报的正文')
    expect(backend!.reporterStats.enqueued).toBe(0)
  } finally {
    await backend?.shutdown()
    server.stop(true)
  }
  expect(backend!.backfillStats().status).toBe('stopped')
}, 10_000)

describe('★ 未署名 / 未配凭证 = 不上报', () => {
  test('未署名 + 配了 appKey → 不注册上报后端，也不发任何请求', async () => {
    const { ctx, provided, logs } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status, backend } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } },
    )

    expect(status.reportingEnabled).toBe(false)
    expect(status.identityReady).toBe(false)
    expect(backend).toBeNull()
    expect(net.calls).toHaveLength(0)
    // 提示必须给出来（否则用户只会看到「看板上没我的数据」）
    expect(logs.some((l) => l.message.includes('尚未署名'))).toBe(true)
  })

  test('已署名但没配 appKey → 不注册上报后端', () => {
    signIdentity()
    const { ctx, logs } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status, backend } = apply(ctx, { dshHome: home, dataDir })

    expect(status.reportingEnabled).toBe(false)
    expect(status.identityReady).toBe(true)
    expect(backend).toBeNull()
    expect(net.calls).toHaveLength(0)
    expect(logs.some((l) => l.message.includes('appKey'))).toBe(true)
  })

  test('★ 未上报时**一个捕获监听都不挂**（未填写前不采集）', () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    apply(ctx, { dshHome: home, dataDir }, {})

    // 未署名 / 未配 appKey → 连宿主会话事件都不订阅，一个字节都不采集
    expect(listeners['session/event']).toBeUndefined()
    expect(listeners['session/flush']).toBeUndefined()
  })

  test('describeDisabled 对 appKey 缺失给出可执行的下一步', () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const { status } = ((): { status: ReturnType<typeof evaluateStatus> } => {
      const r = apply(ctx, { dshHome: home, dataDir }, {})
      return { status: r.status }
    })()

    const text = describeDisabled(status, {
      describeProblem: () => '',
    } as never)
    expect(text).toContain('appKey')
    expect(text).toContain('DSH_TOKEN_REPORT_APP_KEY')
    // 必须明确承诺不采集
    expect(text).toContain('不采集')
  })
})

describe('★ 配齐之后：上报 + 工具 + 服务', () => {
  test('注册上报捕获、工具、服务三件，并把捕获挂在宿主事件流上', () => {
    signIdentity()
    // ⚠️ 不要解构 `effects` —— getter 在解构那一刻就被求值，
    //    之后 apply() 增加的计数读不到（这行曾经因此误报「没挂脱敏规则」）
    const fake = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status, backend } = apply(fake.ctx, {
      appKey: 'atr-key',
      dshHome: home,
      dataDir,
      outbox: { dir: join(home, 'outbox') },
    })

    expect(status.reportingEnabled).toBe(true)
    expect(backend).not.toBeNull()
    expect(status.toolsRegistered).toBe(true)
    expect(status.serviceRegistered).toBe(true)
    expect(fake.provided['tokenReportTools']).toBeDefined()
    expect(fake.provided['tokenReport']).toBeDefined()
    // 捕获订阅挂在插件自己的 fiber 上（`ctx.effect` 里注册，卸载即解除）
    expect(fake.effects).toBeGreaterThan(0)
    expect(fake.listeners['session/event']).toHaveLength(1)
    expect(fake.listeners['session/flush']).toHaveLength(1)
    // ★ **不注册任何 cordis 服务名** —— 那正是与官方 OTel 后端互斥的根源
    //   （`sessionTelemetry` 一个进程只能注册一次，官方后端永远占着它）。
    expect(fake.provided['sessionTelemetry']).toBeUndefined()
    expect(net.calls).toHaveLength(0)
  })

  test('★ emit 只入队：调用后队列里有记录，但还没有任何请求', () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { backend } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } },
    )

    backend!.emit(event(1))
    backend!.emit(event(2))
    expect(net.calls).toHaveLength(0)
    expect(backend!.reporterStats.enqueued).toBe(2)
  })

  test('★ 非计费事件不会进队列（工具调用、用户消息一个都不上账）', () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { backend } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } },
    )

    const toolCall = event(1)
    toolCall.attributes['event.type'] = 'tool/call'
    const ops: TelemetryRecord = {
      channel: 'ops',
      time: Date.now(),
      severity: 'info',
      attributes: { 'telemetry.op': 'shutdown', 'session.id': 's1' },
      body: { op: 'shutdown' },
    }

    backend!.emit(toolCall)
    backend!.emit(ops)
    backend!.emit(event(3))

    expect(backend!.reporterStats.enqueued).toBe(1)
  })

  test('emit 之后 flush 会把记录发出去，且载荷里没有对话内容', async () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { backend } = apply(ctx, {
      appKey: 'atr-key',
      dshHome: home,
      dataDir,
      outbox: { dir: join(home, 'outbox') },
    })

    backend!.emit(event(1))
    await backend!.shutdown()

    expect(net.calls).toHaveLength(1)
    const body = net.calls[0]?.body as { records: Record<string, unknown>[] }
    expect(body.records[0]?.['event_id']).toBe('s1:1')
    expect(body.records[0]?.['cache_read_tokens']).toBe(900)
  })

  test('★ 凭证不出现在任何一条启动日志里', () => {
    signIdentity()
    const { ctx, logs } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    apply(ctx, { appKey: 'atr-super-secret', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } })

    for (const l of logs) {
      expect(l.message).not.toContain('atr-super-secret')
    }
    expect(net.calls).toHaveLength(0)
  })
})

describe('★ 不外发正文：折叠只取计费字段', () => {
  /** 一条带「正文」的宿主会话事件（形状与 DSH 的 firehose 一致）。 */
  function hostMessage(data: Record<string, unknown>): {
    session: { id: string; header: { cwd: string } }
    event: { type: string; seq: number; time?: number; data: Record<string, unknown> }
  } {
    return {
      session: { id: 's1', header: { cwd: 'D:/Coding/x' } },
      event: { type: 'assistant/message', seq: 5, time: 1_700_000_000_000, data },
    }
  }

  /** 等一次冲刷落到拦截器上（fetch 是异步的，不等就会读到空）。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

  test('带对话内容与推理过程的事件，请求体里只剩计费字段', async () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    apply(ctx, { appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } })

    // 走**真实**捕获路径：宿主发一条带正文的会话事件（不是手工调某个裁剪函数）
    const { session, event } = hostMessage({
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'model', provider: 'dashscope', model: 'm' },
        content: [{ type: 'text', text: '这是我的私密提示词与文件内容' }],
      },
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
      stream: [{ delta: '私密推理过程' }],
    })
    listeners['session/event']![0]!(session, event)
    // 宿主在 turn 结束时会发 `session/flush` —— 用它把这一批推出去
    listeners['session/flush']![0]!()
    await settle()

    expect(net.calls).toHaveLength(1)
    const text = JSON.stringify(net.calls[0]!.body)
    // 计费字段与模型名留着（服务端要靠它们算钱）
    expect(text).toContain('cache_read_tokens')
    expect(text).toContain('dashscope')
    // 正文与推理过程一个字节都不许出现
    expect(text).not.toContain('私密提示词')
    expect(text).not.toContain('私密推理过程')
    expect(text).not.toContain('content')
    expect(text).not.toContain('stream')
  })

  test('工具调用事件不是计费事件：一条都不入队', async () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    const { backend } = apply(ctx, {
      appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') },
    })

    const { session, event } = hostMessage({
      turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"command":"cat ~/.ssh/id_rsa"}',
    })
    event.type = 'tool/call'
    listeners['session/event']![0]!(session, event)
    listeners['session/flush']![0]!()
    await settle()

    // 既不发请求，也不在队列里留任何东西 —— 命令参数连内存都不落
    expect(net.calls).toHaveLength(0)
    expect(backend!.reporterStats.enqueued).toBe(0)
  })

  test('★ 拿不到事件时间的记录整条丢掉（绝不伪造成 1970 或「此刻」）', async () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    const { backend } = apply(ctx, {
      appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') },
    })

    const { session, event } = hostMessage({
      turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 1 },
    })
    delete event.time
    listeners['session/event']![0]!(session, event)
    listeners['session/flush']![0]!()
    await settle()

    // 退化成 0 会把记录挪到 1970（时间窗之外，看板上表现为「少了一块」），
    // Date.now() 则把统计挪到「插件看见它的那一刻」—— 两者都是伪造事实。
    // 宁可少这一条：磁盘补报线程会按日志里的真实时间把它补上。
    expect(backend!.reporterStats.enqueued).toBe(0)
    expect(net.calls).toHaveLength(0)
  })
})

describe('功能开关', () => {
  test('tools=false → 不注册工具，其余照旧', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, dataDir, features: { tools: false }, outbox: { dir: join(home, 'outbox') } },
    )
    expect(status.toolsRegistered).toBe(false)
    expect(provided['tokenReport']).toBeDefined()
  })

  test('service=false → 不注册 ctx.tokenReport，其余照旧', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, dataDir, features: { service: false }, outbox: { dir: join(home, 'outbox') } },
    )
    expect(status.serviceRegistered).toBe(false)
    expect(provided['tokenReportTools']).toBeDefined()
  })

  test('工具名稳定（团队文档里引用的就是它）', () => {
    expect(TOOL_NAME).toBe('token_usage')
  })
})

describe('服务与工具的形状', () => {
  test('工具注册了两个：查询 + 诊断', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    apply(ctx, { appKey: 'atr-key', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } })

    const tools = provided['tokenReportTools'] as Record<string, unknown>
    expect(Object.keys(tools).sort()).toEqual([TOOL_NAME, `${TOOL_NAME}_diagnostics`].sort())
  })

  test('★ 服务暴露的 config 里不含 appKey', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    apply(ctx, { appKey: 'atr-secret', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } })

    const service = provided['tokenReport'] as { config: Record<string, unknown> }
    expect(service.config).not.toHaveProperty('appKey')
    expect(JSON.stringify(service.config)).not.toContain('atr-secret')
    expect(service.config['name']).toBe('ai-token-report')
  })

  test('signed() 反映真实的署名状态', () => {
    const { ctx, provided } = fakeCtx()
    apply(ctx, { dshHome: home, dataDir }, {})
    const service = provided['tokenReport'] as { signed(): boolean }
    expect(service.signed()).toBe(false)

    signIdentity()
    const second = fakeCtx()
    apply(second.ctx, { dshHome: home, dataDir }, {})
    const service2 = second.provided['tokenReport'] as { signed(): boolean }
    expect(service2.signed()).toBe(true)
  })
})

describe('配置问题只告警，不让 DSH 起不来', () => {
  test('★ endpoint 写错时照样装配完成，只是不入网', () => {
    signIdentity()
    const { ctx, logs } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status } = apply(
      ctx,
      { appKey: 'atr-key', endpoint: 'ftp://nope', dshHome: home, dataDir, outbox: { dir: join(home, 'outbox') } },
    )

    expect(status.reportingEnabled).toBe(true)
    expect(logs.some((l) => l.message.includes('http(s)'))).toBe(true)
  })

  test('打开 localDb 不再错误警告 Bun 专属限制', () => {
    signIdentity()
    const { ctx, logs } = fakeCtx()
    apply(ctx, { appKey: 'k', dshHome: home, dataDir, localDb: true }, {})
    expect(logs.some((l) => l.message.includes('bun:sqlite'))).toBe(false)
  })
})

describe('默认导出', () => {
  test('插件名固定为 token-report（cordis 靠它定位插件）', async () => {
    const mod = await import('../src/index.js')
    expect(mod.default.name).toBe('token-report')
    expect(typeof mod.default.apply).toBe('function')
  })
})

describe('config 归一化后的默认 endpoint 指向本仓服务端', () => {
  test('未配置时用 shared 契约里的路径', () => {
    expect(resolveConfig({}).endpoint).toContain('/api/v1/token-usage')
  })
})

/**
 * ★ DSH Desktop：`dshHome` 与 `dataDir` 分开装配。
 *
 * Desktop 的 `DSH_HOME` 是 `%APPDATA%\dsh-desktop\harness`，命令行版是 `~/.dsh`。
 * 想「共用一份身份、但各看自己的会话」就必须走 `dataDir`；这里断言装配之后
 * 身份与 outbox 都落在 `dataDir`，而会话日志根仍指向 `dshHome`。
 */
describe('★ DSH Desktop：会话日志根与数据目录分开', () => {
  test('署名与 outbox 落在 dataDir，本机 dshHome 下不产生 token-report 目录', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'atr-shared-'))
    const net = interceptFetch(() => okResponse())
    try {
      // 共享目录里已有命令行版填好的署名 —— Desktop 不该再问一次
      writeFileSync(
        join(shared, 'identity.json'),
        JSON.stringify({ name: '共享张三', token: 'tok-shared', createdAt: 1, updatedAt: 1 }),
        'utf8',
      )

      const { ctx } = fakeCtx()
      const { status, backend } = apply(ctx, {
        dshHome: home,
        dataDir: shared,
        appKey: 'tok-shared',
        endpoint: 'http://127.0.0.1:9/api/v1/token-usage',
      })

      expect(status.identityReady).toBe(true)
      expect(status.reportingEnabled).toBe(true)
      expect(backend).not.toBeNull()

      // ★ 磁盘 outbox 建在共享数据目录下（崩溃不丢数据这件事也共用同一份队列）
      expect(existsSync(join(shared, 'outbox'))).toBe(true)
      // 本机 home 一个字节都不写：没有孤儿身份文件，也没有第二份 outbox
      expect(existsSync(join(home, 'token-report'))).toBe(false)

      await backend!.shutdown()
    } finally {
      net.restore()
      rmSync(shared, { recursive: true, force: true })
    }
  })

  test('数据目录里没有署名时仍是「未署名 → 不上报」（共享不改变合规底线）', () => {
    const shared = mkdtempSync(join(tmpdir(), 'atr-shared-'))
    try {
      // 本机 home 下有署名，但数据目录指到了空目录 → 以数据目录为准
      signIdentity()
      const { ctx, logs } = fakeCtx()
      const net = interceptFetch(() => okResponse())
      try {
        const { status, backend } = apply(ctx, {
          dshHome: home, dataDir: shared, appKey: 'tok-shared',
        })
        expect(status.identityReady).toBe(false)
        expect(backend).toBeNull()
        expect(net.calls).toHaveLength(0)
        expect(logs.some((l) => l.message.includes('尚未署名'))).toBe(true)
      } finally {
        net.restore()
      }
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })
})




