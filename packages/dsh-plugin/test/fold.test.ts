/**
 * 折叠逻辑的测试。
 *
 * ★ 这一组断言盯着的是**插件唯一会算错数的地方**：字段取错一个，
 *   服务端就少一块用量，而且不报错、只让看板数字偏低。
 *   因此这里的用例不是「覆盖率」，而是「口径的固化」——
 *   尤其是 cacheRead 必须单列（实测占总量 94.3%）。
 */

import { describe, expect, test } from 'bun:test'

import { cacheHitRate } from '@ai-token-report/shared'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

import { foldRecord, toTokenUsage, toWireRecord, type FoldIdentity } from '../src/fold.js'

const IDENTITY: FoldIdentity = {
  clientName: 'dsh-token-report',
  claimedUserId: '张三',
  userName: '张三',
  dept: '研发一部',
}

/**
 * 一条真实的计费事件（字段取自 `docs/PLAN.md` §2.1 的实测样本）。
 *
 * 刻意用实测样本而不是编造的数字：它带着「cacheRead 1024 远大于 input 7772」之外
 * 更重要的性质 —— `totalTokens` 与四项之和不符时该怎么处理。
 */
function usageEvent(overrides: {
  seq?: number
  usage?: Record<string, unknown> | undefined
  provider?: string
  model?: string
  cwd?: string
  time?: number
  turn?: number
  step?: number
} = {}): SessionTelemetryRecord {
  const usage =
    overrides.usage === undefined
      ? { inputTokens: 7772, outputTokens: 186, totalTokens: 8982, cacheReadTokens: 1024 }
      : overrides.usage

  return {
    channel: 'ledger',
    time: overrides.time ?? 1_789_984_019_944,
    severity: 'info',
    attributes: {
      'session.id': 'session-044004d8',
      'session.format_version': 3,
      'event.type': 'assistant/message',
      'event.seq': overrides.seq ?? 16,
      ...(overrides.cwd ? { 'session.cwd': overrides.cwd } : {}),
    },
    body: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      message: {
        source: {
          kind: 'model',
          provider: overrides.provider ?? 'dashscope',
          model: overrides.model ?? 'deepseek-v4.1-flash',
        },
      },
      ...(usage ? { usage } : {}),
    },
  }
}

describe('折叠：哪些事件计费', () => {
  test('★ assistant/message + usage → 折叠成一条计费记录', () => {
    const rec = foldRecord(usageEvent(), IDENTITY)
    expect(rec).not.toBeNull()
    if (!rec) return

    expect(rec.eventId).toBe('session-044004d8:16')
    expect(rec.sessionId).toBe('session-044004d8')
    expect(rec.seq).toBe(16)
    expect(rec.provider).toBe('dashscope')
    expect(rec.model).toBe('deepseek-v4.1-flash')
    expect(rec.turn).toBe(1)
    expect(rec.step).toBe(1)
    expect(rec.time).toBe(1_789_984_019_944)
  })

  test('★ ops 通道（agent-error / shutdown）不计费', () => {
    const rec = foldRecord(
      {
        channel: 'ops',
        time: Date.now(),
        severity: 'error',
        attributes: { 'telemetry.op': 'agent-error', 'session.id': 's1' },
        body: { name: 'Error', message: 'boom' },
      },
      IDENTITY,
    )
    expect(rec).toBeNull()
  })

  test('★ 其余事件类型（user/message、tool/call…）不计费', () => {
    for (const type of ['user/message', 'tool/call', 'tool/result', 'step/start', 'turn/start']) {
      const record = usageEvent()
      record.attributes['event.type'] = type
      expect(foldRecord(record, IDENTITY)).toBeNull()
    }
  })

  test('★ assistant/message 但没有 usage → 不计费（不补 0，否则会凭空抬高 calls）', () => {
    const record = usageEvent({ usage: undefined })
    delete (record.body as Record<string, unknown>)['usage']
    expect(foldRecord(record, IDENTITY)).toBeNull()
  })

  test('★ usage 是空对象 → 同样不计费（适配器没报 accounting 的另一种呈现）', () => {
    expect(foldRecord(usageEvent({ usage: {} }), IDENTITY)).toBeNull()
  })

  test('★ 缺 event.seq → 不计费（幂等键的一半，缺了无法安全重发）', () => {
    const record = usageEvent()
    delete record.attributes['event.seq']
    expect(foldRecord(record, IDENTITY)).toBeNull()
  })

  test('★ 缺 session.id → 不计费', () => {
    const record = usageEvent()
    delete record.attributes['session.id']
    expect(foldRecord(record, IDENTITY)).toBeNull()
  })
})

describe('折叠：口径（铁律）', () => {
  test('★ 四个 token 类目分列，一个都不合并', () => {
    const rec = foldRecord(
      usageEvent({
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 300,
          reasoningTokens: 50,
          totalTokens: 51_500,
        },
      }),
      IDENTITY,
    )
    expect(rec).not.toBeNull()
    if (!rec) return

    expect(rec.inputTokens).toBe(1000)
    expect(rec.outputTokens).toBe(200)
    expect(rec.cacheReadTokens).toBe(50_000)
    expect(rec.cacheWriteTokens).toBe(300)
    expect(rec.reasoningTokens).toBe(50)
  })

  test('★ total 按恒等式重算，reasoning 不在其中（它是 output 的子集）', () => {
    const rec = foldRecord(
      usageEvent({
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 300,
          reasoningTokens: 50,
          totalTokens: 51_500,
        },
      }),
      IDENTITY,
    )
    // 1000 + 200 + 50000 + 300 = 51500，reasoning 的 50 不该再加一次
    expect(rec?.totalTokens).toBe(51_500)
    expect(rec?.identityViolation).toBe(false)
  })

  test('★ provider 的 totalTokens 与恒等式不符 → 以重算为准，并打上违规标记', () => {
    const rec = foldRecord(
      usageEvent({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, totalTokens: 999 } }),
      IDENTITY,
    )
    expect(rec?.totalTokens).toBe(15)
    expect(rec?.identityViolation).toBe(true)
  })

  test('★ totalTokens 缺席时不会把总量算成 0', () => {
    const rec = foldRecord(
      usageEvent({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } }),
      IDENTITY,
    )
    expect(rec?.totalTokens).toBe(115)
    expect(rec?.identityViolation).toBe(false)
  })

  test('★ 缓存命中率交给 shared 计算，且分母是 cacheRead + input', () => {
    const rec = foldRecord(
      usageEvent({ usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 9000 } }),
      IDENTITY,
    )
    expect(rec).not.toBeNull()
    if (!rec) return
    // 9000 / (9000 + 1000) = 0.9 —— 若分母误用 input 会得到 9
    expect(cacheHitRate(toTokenUsage(rec))).toBeCloseTo(0.9, 6)
  })

  test('cwd 来自 coordinator 的 attributes，而不是 body', () => {
    const rec = foldRecord(usageEvent({ cwd: 'D:\\Coding\\ai-token-report' }), IDENTITY)
    expect(rec?.cwd).toBe('D:\\Coding\\ai-token-report')
  })

  test('缺 cwd / provider / model 时有稳定的兜底值，而不是 undefined', () => {
    const record = usageEvent()
    delete record.attributes['session.cwd']
    const message = record.body as Record<string, unknown>
    message['message'] = { source: {} }

    const rec = foldRecord(record, IDENTITY)
    expect(rec?.cwd).toBeNull()
    expect(rec?.provider).toBe('(none)')
    expect(rec?.model).toBe('(unknown)')
  })

  test('turn / step 缺失时为 null（不是 0 —— 0 是合法轮次）', () => {
    const record = usageEvent()
    const body = record.body as Record<string, unknown>
    delete body['turn']
    delete body['step']
    const rec = foldRecord(record, IDENTITY)
    expect(rec?.turn).toBeNull()
    expect(rec?.step).toBeNull()
  })
})

describe('线上格式', () => {
  test('★ 字段用下划线，且与服务端契约的字段名逐一对应', () => {
    const rec = foldRecord(usageEvent({ cwd: 'D:\\Coding\\ai-token-report' }), IDENTITY)
    expect(rec).not.toBeNull()
    if (!rec) return

    const wire = toWireRecord(rec)
    expect(Object.keys(wire).sort()).toEqual(
      [
        'cache_read_tokens',
        'cache_write_tokens',
        'cwd',
        'event_id',
        'input_tokens',
        'model',
        'output_tokens',
        'provider',
        'reasoning_tokens',
        'seq',
        'session_id',
        'step',
        'total_tokens',
        'ts',
        'turn',
      ].sort(),
    )
    expect(wire['event_id']).toBe('session-044004d8:16')
    expect(wire['cache_read_tokens']).toBe(1024)
  })

  test('★ 线上格式里不含任何身份字段（身份只走 Authorization 头与 client 对象）', () => {
    const rec = foldRecord(usageEvent(), IDENTITY)
    expect(rec).not.toBeNull()
    if (!rec) return
    const wire = toWireRecord(rec)
    const text = JSON.stringify(wire)
    expect(text).not.toContain('张三')
    expect(text).not.toContain('研发一部')
  })

  test('toTokenUsage 的 total 与恒等式一致', () => {
    const rec = foldRecord(usageEvent(), IDENTITY)
    expect(rec).not.toBeNull()
    if (!rec) return
    const u = toTokenUsage(rec)
    expect(u.total).toBe(u.input + u.output + u.cacheRead + u.cacheWrite)
  })
})