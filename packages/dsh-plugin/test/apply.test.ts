/**
 * `apply()` 的装配测试。
 *
 * ★ 这里钉死的是**装上去之后会发生什么**：
 *
 * 1. 未署名 / 未配凭证 → **一个字节都不往外发**（合规底线）
 * 2. 三项齐了 → 注册上报后端、工具、服务，且 emit 走的是同一条队列
 * 3. 脱敏规则被挂上 → 事件正文（对话内容、命令输出）不会被带出去
 * 4. 凭证不泄漏进日志
 *
 * 用的是假 ctx（不搭 cordis 运行时）—— 我们测的是**装配决策**，
 * 而不是 cordis 的事件分发（那是 DSH 自己的测试覆盖范围）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

import { apply, describeDisabled, evaluateStatus, TOOL_NAME, type ApplyContext } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import type { EffectiveConfig } from '../src/config.js'
import type { FoldIdentity } from '../src/fold.js'
import { Reporter } from '../src/reporter.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-apply-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 假 ctx：只实现 apply() 用到的五个能力（不搭 cordis 运行时）。 */
function fakeCtx(): {
  ctx: ApplyContext
  logs: { level: string; message: string }[]
  provided: Record<string, unknown>
  listeners: Record<string, ((record: unknown, next: () => unknown) => unknown)[]>
  effects: number
} {
  const logs: { level: string; message: string }[] = []
  const provided: Record<string, unknown> = {}
  const listeners: Record<string, ((record: unknown, next: () => unknown) => unknown)[]> = {}
  let effects = 0

  const ctx: ApplyContext = {
    logger: {
      info: (message) => void logs.push({ level: 'info', message }),
      warn: (message) => void logs.push({ level: 'warn', message }),
    },
    // ⚠️ 必须**真的执行**回调：cordis 的 `ctx.effect(fn)` 会立即调用 fn 来完成注册，
//    只在 fn 的返回值上挂 dispose。把这里写成「只计数不执行」，
//    测出来的就是「脱敏规则没挂上」—— 而生产环境里它是挂上的。
    effect: (callback) => {
      effects += 1
      callback()
    },
    on: ((event: string, listener: (record: unknown, next: () => unknown) => unknown) => {
      ;(listeners[event] ??= []).push(listener)
      return () => {}
    }) as ApplyContext['on'],
    reflect: {
      provide: (name, value) => void (provided[name] = value),
    },
    // coordinator 会扫已在跑的会话；测试里一台都没有
    sessions: { list: () => [] },
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
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(
    join(home, 'token-report', 'identity.json'),
    JSON.stringify({ name: '张三', token: 'tok-abc', dept: '研发一部', createdAt: 1, updatedAt: 1 }),
    'utf8',
  )
}

/** 一份计费事件。 */
function event(seq: number): SessionTelemetryRecord {
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
 *   因为 `apply()` 走的是真实的 `TokenReportBackend`，那正是我们要测的东西。
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

describe('★ 未署名 / 未配凭证 = 不上报', () => {
  test('未署名 + 配了 appKey → 不注册上报后端，也不发任何请求', async () => {
    const { ctx, provided, logs } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status, backend } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } },
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

    const { status, backend } = apply(ctx, { dshHome: home })

    expect(status.reportingEnabled).toBe(false)
    expect(status.identityReady).toBe(true)
    expect(backend).toBeNull()
    expect(net.calls).toHaveLength(0)
    expect(logs.some((l) => l.message.includes('appKey'))).toBe(true)
  })

  test('★ 未上报时也**不注册**统计工具与服务之外的上报组件（只挂脱敏规则）', () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    apply(ctx, { dshHome: home }, {})

    // 上报未启用 → 不该有 telemetry 相关的注册动作
    expect(listeners['session/telemetry']).toBeUndefined()
  })

  test('describeDisabled 对 appKey 缺失给出可执行的下一步', () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const { status } = ((): { status: ReturnType<typeof evaluateStatus> } => {
      const r = apply(ctx, { dshHome: home }, {})
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
  test('注册上报后端、工具、服务三件，并挂上脱敏规则', () => {
    signIdentity()
    // ⚠️ 不要解构 `effects` —— getter 在解构那一刻就被求值，
    //    之后 apply() 增加的计数读不到（这行曾经因此误报「没挂脱敏规则」）
    const fake = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status, backend } = apply(fake.ctx, {
      appKey: 'atr-key',
      dshHome: home,
      outbox: { dir: join(home, 'outbox') },
    })

    expect(status.reportingEnabled).toBe(true)
    expect(backend).not.toBeNull()
    expect(status.toolsRegistered).toBe(true)
    expect(status.serviceRegistered).toBe(true)
    expect(fake.provided['tokenReportTools']).toBeDefined()
    expect(fake.provided['tokenReport']).toBeDefined()
    // 脱敏规则挂在插件自己的 fiber 上
    expect(fake.effects).toBeGreaterThan(0)
    expect(fake.listeners['session-telemetry/record']).toHaveLength(1)
    expect(net.calls).toHaveLength(0)
  })

  test('★ emit 只入队：调用后队列里有记录，但还没有任何请求', () => {
    signIdentity()
    const { ctx } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { backend } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } },
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
      { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } },
    )

    const toolCall = event(1)
    toolCall.attributes['event.type'] = 'tool/call'
    const ops: SessionTelemetryRecord = {
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

    apply(ctx, { appKey: 'atr-super-secret', dshHome: home, outbox: { dir: join(home, 'outbox') } })

    for (const l of logs) {
      expect(l.message).not.toContain('atr-super-secret')
    }
    expect(net.calls).toHaveLength(0)
  })
})

describe('★ 脱敏：事件正文不许带出去', () => {
  test('挂上的规则把 body 裁到只剩计费字段', () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    apply(ctx, { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } })

    const listener = listeners['session-telemetry/record']![0]!
    // 一条**带对话内容与工具参数**的真实形状记录
    const dirty: SessionTelemetryRecord = {
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 's1', 'event.type': 'assistant/message', 'event.seq': 5 },
      body: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'model', provider: 'dashscope', model: 'm' },
          content: [{ type: 'text', text: '这是我的私密提示词与文件内容' }],
        },
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
        stream: [{ delta: '私密推理过程' }],
      },
    }

    const cleaned = listener(dirty, () => dirty) as SessionTelemetryRecord
    const text = JSON.stringify(cleaned.body)

    // 计费字段留着
    expect(text).toContain('cacheReadTokens')
    expect(text).toContain('dashscope')
    // 内容与推理过程必须消失
    expect(text).not.toContain('私密提示词')
    expect(text).not.toContain('私密推理过程')
    expect(text).not.toContain('content')
    expect(text).not.toContain('stream')
  })

  test('工具调用事件里的命令参数同样被剥掉', () => {
    signIdentity()
    const { ctx, listeners } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    apply(ctx, { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } })

    const listener = listeners['session-telemetry/record']![0]!
    const toolCall: SessionTelemetryRecord = {
      channel: 'ledger',
      time: Date.now(),
      severity: 'info',
      attributes: { 'session.id': 's1', 'event.type': 'tool/call', 'event.seq': 6 },
      body: { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"command":"cat ~/.ssh/id_rsa"}' },
    }

    const cleaned = listener(toolCall, () => toolCall) as SessionTelemetryRecord
    const text = JSON.stringify(cleaned.body)
    expect(text).not.toContain('id_rsa')
    expect(text).not.toContain('arguments')
  })
})

describe('功能开关', () => {
  test('tools=false → 不注册工具，其余照旧', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())

    const { status } = apply(
      ctx,
      { appKey: 'atr-key', dshHome: home, features: { tools: false }, outbox: { dir: join(home, 'outbox') } },
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
      { appKey: 'atr-key', dshHome: home, features: { service: false }, outbox: { dir: join(home, 'outbox') } },
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
    apply(ctx, { appKey: 'atr-key', dshHome: home, outbox: { dir: join(home, 'outbox') } })

    const tools = provided['tokenReportTools'] as Record<string, unknown>
    expect(Object.keys(tools).sort()).toEqual([TOOL_NAME, `${TOOL_NAME}_diagnostics`].sort())
  })

  test('★ 服务暴露的 config 里不含 appKey', () => {
    signIdentity()
    const { ctx, provided } = fakeCtx()
    const net = interceptFetch(() => okResponse())
    apply(ctx, { appKey: 'atr-secret', dshHome: home, outbox: { dir: join(home, 'outbox') } })

    const service = provided['tokenReport'] as { config: Record<string, unknown> }
    expect(service.config).not.toHaveProperty('appKey')
    expect(JSON.stringify(service.config)).not.toContain('atr-secret')
    expect(service.config['name']).toBe('dsh-token-report')
  })

  test('signed() 反映真实的署名状态', () => {
    const { ctx, provided } = fakeCtx()
    apply(ctx, { dshHome: home }, {})
    const service = provided['tokenReport'] as { signed(): boolean }
    expect(service.signed()).toBe(false)

    signIdentity()
    const second = fakeCtx()
    apply(second.ctx, { dshHome: home }, {})
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
      { appKey: 'atr-key', endpoint: 'ftp://nope', dshHome: home, outbox: { dir: join(home, 'outbox') } },
    )

    expect(status.reportingEnabled).toBe(true)
    expect(logs.some((l) => l.message.includes('http(s)'))).toBe(true)
  })

  test('打开 localDb 不再错误警告 Bun 专属限制', () => {
    signIdentity()
    const { ctx, logs } = fakeCtx()
    apply(ctx, { appKey: 'k', dshHome: home, localDb: true }, {})
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




