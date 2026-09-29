/**
 * 运行时「就地换连接」的测试 —— 本文件保护的是**设置页保存后不再需要重启 DSH**。
 *
 * ## 这里为什么必须用假的 backfill 工厂
 *
 * 真 backfill 会去扫 `$DSH_HOME/sessions`（可能几万个文件）并真的发请求。
 * 而本文件要断言的东西恰好**只有单元装了/换了几次**才看得见：
 *
 * - 只改间隔 → **不能重建单元**（重建会丢掉内存队列里还没落盘的记录）；
 * - 改地址 / 换人 → 必须换单元，且旧单元要**停下来**（否则新旧两个 reporter
 *   同时往同一个 outbox 写，批次会互相覆盖）；
 * - 未署名 / 停用 → 单元必须停，且诊断仍要能报告 `stopped`。
 *
 * ## 只装一次后端
 *
 * `SessionTelemetryCoordinator` 的监听器挂在 fiber 上、**不随服务注销撤销**
 * （见 `runtime.ts` 文件头）。所以后端在这些用例里必须恰好被创建一次 ——
 * 换连接只能换「单元」。
 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyBackfillStats, type BackfillStats } from '../src/backfill-runner.js'
import { resolveConfig } from '../src/config.js'
import { IdentityResolver } from '../src/identity.js'
import {
  ReportRuntime,
  unitKey,
  type BackendRefs,
  type ReportBackendLike,
} from '../src/runtime.js'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

const HOME = mkdtempSync(join(tmpdir(), 'atr-runtime-'))

/** 一份计费事件（形状与真日志一致，折叠后才会有记录）。 */
function event(seq: number): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time: 1_700_000_000_000 + seq,
    severity: 'info',
    attributes: { 'session.id': 's1', 'event.type': 'assistant/message', 'event.seq': seq },
    body: {
      turn: 1,
      step: seq,
      message: { source: { kind: 'model', provider: 'dashscope', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 },
    },
  }
}

function writeIdentity(home: string, name: string, token: string, group?: string): void {
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(join(home, 'token-report', 'identity.json'), JSON.stringify({
    name, token, ...(group ? { group } : {}), createdAt: 1, updatedAt: 1,
  }), 'utf8')
}

/** 写「已保存的连接」。间隔故意取很大，免得测试期间真的发请求。 */
function writeConnection(
  home: string,
  value: { baseUrl: string; appKey: string; flushIntervalMillis?: number; position?: string },
): void {
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(join(home, 'token-report', 'plugin-connection.json'), JSON.stringify(value), 'utf8')
}

interface Harness {
  runtime: ReportRuntime<ReportBackendLike>
  refs: BackendRefs
  readonly installs: number
  readonly stops: number
  readonly backends: number
  logs: string[]
  shutdown(): Promise<void>
}

/**
 * 造一个运行时。
 *
 * ⚠️ `createBackfill` 是**唯一**能观察到「单元换了几次」的地方：
 *   `Reporter` 没有对外可见的实例标识。
 */
function harness(home: string): Harness {
  const counts = { installs: 0, stops: 0, backends: 0 }
  const logs: string[] = []
  // 后端只造一次的事实由这里计数（换连接不该再造一个）
  let refs!: BackendRefs
  const runtime = new ReportRuntime<ReportBackendLike>({
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    raw: { dshHome: home, outbox: { enabled: false } },
    resolver: new IdentityResolver({ dshHome: home }),
    createBackend: (r) => {
      counts.backends += 1
      refs = r
      return {
        reporterStats: r.reporterStats,
        backfillStats: () => r.backfillStats(),
        shutdown: () => r.shutdown(),
      }
    },
    createBackfill: (() => {
      counts.installs += 1
      let stats: BackfillStats = emptyBackfillStats()
      return {
        start: () => { stats = { ...stats, status: 'running' } },
        stop: async () => {
          counts.stops += 1
          stats = { ...stats, status: 'stopped' }
        },
        stats: () => ({ ...stats }),
      }
    }) as never,
  }, resolveConfig({ dshHome: home }))

  return {
    runtime,
    get refs() { return refs },
    get installs() { return counts.installs },
    get stops() { return counts.stops },
    get backends() { return counts.backends },
    logs,
    async shutdown() { await runtime.shutdown() },
  }
}

test('未署名：不装后端，也不采集 —— 未署名 = 不采集', async () => {
  const home = mkdtempSync(join(HOME, 'anon-'))
  const h = harness(home)
  // 配了地址、没配身份：这就是 apply() 在身份文件缺失时看到的状态
  const status = h.runtime.applyState(
    resolveConfig({ dshHome: home, appKey: 'k' }),
    { ready: false, reason: 'missing' },
  )
  expect(status.enabled).toBe(false)
  expect(status.reason).toBeTruthy()
  // ★ 连后端都不装：没有 coordinator，就没有任何采集路径
  expect(h.runtime.attached).toBe(false)
  expect(h.backends).toBe(0)
  expect(h.runtime.enqueued()).toBe(0)
  await h.shutdown()
})

test('★ 保存后 refresh 就地生效：不必重启，且只装一次后端', async () => {
  const home = mkdtempSync(join(HOME, 'enable-'))
  writeIdentity(home, '张三', 'tok-1', '研发一部')
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-1', flushIntervalMillis: 600_000 })

  const h = harness(home)
  // 启动时身份文件还没写（这里刻意用未署名状态起手）→ 不上报
  h.runtime.applyState(resolveConfig({ dshHome: home }), { ready: false, reason: 'missing' })
  expect(h.runtime.attached).toBe(false)
  expect(h.backends).toBe(0)

  // 设置页保存后走的就是这一步
  const status = await h.runtime.refresh()
  expect(status.enabled).toBe(true)
  expect(status.endpoint).toBe('http://127.0.0.1:1/api/v1/token-usage')
  expect(h.runtime.status().enabled).toBe(true)
  expect(h.runtime.identity()).toEqual({ name: '张三', group: '研发一部' })
  expect(h.backends).toBe(1)
  expect(h.installs).toBe(1)

  h.refs.emit(event(1))
  expect(h.runtime.enqueued()).toBe(1)
  await h.shutdown()
})

test('★ 只改间隔：不重建单元（内存队列里没落盘的记录不能丢）', async () => {
  const home = mkdtempSync(join(HOME, 'interval-'))
  writeIdentity(home, '李四', 'tok-2')
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-2', flushIntervalMillis: 600_000 })

  const h = harness(home)
  await h.runtime.refresh()
  expect(h.installs).toBe(1)

  h.refs.emit(event(1))
  h.refs.emit(event(2))
  expect(h.runtime.enqueued()).toBe(2)

  // 用户只把间隔从 10 分钟改成 5 秒 → 落盘后 refresh
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-2', flushIntervalMillis: 5_000 })
  const status = await h.runtime.refresh()

  expect(status.enabled).toBe(true)
  expect(h.installs).toBe(1)
  expect(h.stops).toBe(0)
  expect(h.runtime.config().batch.flushIntervalMillis).toBe(5_000)
  expect(h.logs.some((line) => line.includes('上报间隔已更新'))).toBe(true)
  // ★ 换连接最容易犯的错就是顺手重建 —— 那会把这两条记录丢掉
  expect(h.runtime.stats()?.queueLength).toBe(2)
  expect(h.runtime.enqueued()).toBe(2)
  await h.shutdown()
})

test('★ 改地址 / 换人：换单元 + 旧单元停下来，但已采集计数与后端都不重来', async () => {
  const home = mkdtempSync(join(HOME, 'swap-'))
  writeIdentity(home, '王五', 'tok-3')
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-3', flushIntervalMillis: 600_000 })

  const h = harness(home)
  await h.runtime.refresh()
  h.refs.emit(event(1))
  const first = h.runtime.config()
  const firstKey = unitKey(first, { name: '王五', token: 'tok-3', createdAt: 0, updatedAt: 0 })

  // 换地址（同一个 appKey）
  writeConnection(home, { baseUrl: 'http://127.0.0.1:2', appKey: 'tok-3', flushIntervalMillis: 600_000 })
  await h.runtime.refresh()

  expect(h.installs).toBe(2)
  expect(h.stops).toBe(1)
  expect(h.backends).toBe(1)          // ★ 后端仍然只有一个
  expect(h.runtime.status().endpoint).toBe('http://127.0.0.1:2/api/v1/token-usage')
  expect(unitKey(h.runtime.config(), { name: '王五', token: 'tok-3', createdAt: 0, updatedAt: 0 }))
    .not.toBe(firstKey)

  // 换人（服务端可能给了新姓名）→ 也要换单元
  writeIdentity(home, '赵六', 'tok-3')
  await h.runtime.refresh()
  expect(h.installs).toBe(3)
  expect(h.stops).toBe(2)
  expect(h.runtime.identity()).toEqual({ name: '赵六' })

  // ★ 采集计数是运行时的，换单元不归零（否则调试页会显示「已采集 0」）
  expect(h.runtime.enqueued()).toBe(1)
  await h.shutdown()
})

test('★ 身份被删掉：立刻停上报，诊断仍能报 stopped 而不是假装还在跑', async () => {
  const home = mkdtempSync(join(HOME, 'unsign-'))
  writeIdentity(home, '钱七', 'tok-4')
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-4', flushIntervalMillis: 600_000 })

  const h = harness(home)
  await h.runtime.refresh()
  expect(h.runtime.status().enabled).toBe(true)

  rmSync(join(home, 'token-report', 'identity.json'))
  const status = await h.runtime.refresh()
  expect(status.enabled).toBe(false)
  expect(status.reason).toBeTruthy()
  expect(h.stops).toBe(1)

  // 诊断必须说「已停止」：说「正在扫描」等于骗人
  await Bun.sleep(10)
  expect(h.runtime.backfillStats().status).toBe('stopped')
  expect(h.installs).toBe(1)
  await h.shutdown()
})

test('停用后 emit 只是空转（热路径不能因为停用而抛错）', async () => {
  const home = mkdtempSync(join(HOME, 'after-stop-'))
  writeIdentity(home, '孙八', 'tok-5')
  writeConnection(home, { baseUrl: 'http://127.0.0.1:1', appKey: 'tok-5', flushIntervalMillis: 600_000 })

  const h = harness(home)
  await h.runtime.refresh()
  h.refs.emit(event(1))
  const before = h.runtime.enqueued()
  rmSync(join(home, 'token-report', 'identity.json'))
  await h.runtime.refresh()
  expect(() => h.refs.emit(event(2))).not.toThrow()
  expect(h.runtime.enqueued()).toBe(before)
  await h.shutdown()
})