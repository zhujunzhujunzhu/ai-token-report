/**
 * 端到端冒烟：**真实装载**插件，走完整的「会话事件 → 上报 → 服务端收下」链路。
 *
 * 这不是单元测试，而是人工验证脚本（`bun run` 执行，不是 `bun test`）：
 *   bun run packages/dsh-plugin/verify/verify-plugin.ts
 *
 * ## 它验证什么（单元测试覆盖不到的部分）
 *
 * 1. **打包产物真能 import** —— `lib/index.js` 的 external 是否写对了、
 *    是否漏了 `node:` 前缀。单测跑的是 `src/`，打包后才发现问题就太晚了。
 * 2. **真实的 HTTP 往返** —— 起一个真的 `Bun.serve` 收上报，断言它收到的
 *    字段与 shared 契约逐一对应（含四个 token 列分列）。
 * 3. **身份文件 → Authorization 头** —— 身份从磁盘读到请求头的完整路径。
 * 4. **未署名时确实一个字节都不发**（合规底线，用真实 socket 验证）。
 * 5. **崩溃恢复** —— 手工造出 inflight 文件，看新进程是否补发。
 *
 * ⚠️ 全程用临时 `DSH_HOME` 与临时 outbox，**不碰**真实的 `~/.dsh`。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IngestPayload } from '@ai-token-report/shared'

import { apply, type ApplyContext } from '../src/index.js'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) {
    console.log(`  ✅ ${label}`)
  } else {
    failures++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

/** 造一个临时 DSH home，并按需写入身份文件。 */
function makeHome(signed: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'atr-smoke-'))
  if (signed) {
    mkdirSync(join(home, 'token-report'), { recursive: true })
    writeFileSync(
      join(home, 'token-report', 'identity.json'),
      JSON.stringify({ name: '张三', token: 'tok-smoke', dept: '研发一部', createdAt: 1, updatedAt: 1 }),
    )
  }
  return home
}

/**
 * 假 DSH 宿主上下文。
 *
 * 只实现插件真正依赖的五个能力。`effect` **必须真的执行回调** ——
 * cordis 就是这样注册监听的；写成「只计数」会让脱敏规则静默缺失。
 */
function makeCtx(): {
  ctx: ApplyContext
  logs: string[]
  emitEvent: (record: SessionTelemetryRecord) => void
  runWaterfall: (record: SessionTelemetryRecord) => SessionTelemetryRecord
  collectEffects: () => void
} {
  const logs: string[] = []
  const eventListeners: ((...args: unknown[]) => unknown)[] = []
  const waterfallListeners: ((record: unknown, next: () => unknown) => unknown)[] = []
  const pendingEffects: (() => (() => void) | void)[] = []

  const ctx: ApplyContext = {
    logger: {
      info: (m) => void logs.push(`info: ${m}`),
      warn: (m) => void logs.push(`warn: ${m}`),
    },
    // 惰性执行：cordis 在 fiber 就绪后才跑 effect 回调。这里先攒着，
    // 装配完成后再统一执行，模拟真实的时序。
    effect: (cb) => void pendingEffects.push(cb),
    on: ((event: string, listener: (...args: never[]) => unknown) => {
      if (event === 'session-telemetry/record') {
        waterfallListeners.push(listener as unknown as (r: unknown, n: () => unknown) => unknown)
      } else {
        eventListeners.push(listener as (...args: unknown[]) => unknown)
      }
      return () => {}
    }) as ApplyContext['on'],
    reflect: { provide: () => {} },
    sessions: { list: () => [] },
  }

  return {
    ctx,
    logs,
    emitEvent: (record) => {
      // coordinator 注册的是 `session/event`，行为是「把事件交给后端」
      for (const l of eventListeners) void l({}, {})
      void record
    },
    runWaterfall: (record) => {
      let current: unknown = record
      for (const l of waterfallListeners) {
        const next = (): unknown => current
        current = l(current, next)
      }
      return current as SessionTelemetryRecord
    },
    collectEffects: () => {
      for (const cb of pendingEffects) cb()
      pendingEffects.length = 0
    },
  }
}

/** 一条真实的计费事件（字段取自实测样本）。 */
function usageEvent(seq: number): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time: 1_789_984_019_944 + seq,
    severity: 'info',
    attributes: {
      'session.id': 'session-044004d8',
      'session.format_version': 3,
      'event.type': 'assistant/message',
      'event.seq': seq,
      'session.cwd': 'D:\\Coding\\ai-token-report',
    },
    body: {
      turn: 1,
      step: seq,
      message: {
        source: { kind: 'model', provider: 'dashscope', model: 'deepseek-v4.1-flash' },
        content: [{ type: 'text', text: '这段对话内容绝不该被上报' }],
      },
      usage: { inputTokens: 7772, outputTokens: 186, totalTokens: 8982, cacheReadTokens: 1024 },
      stream: [{ delta: '推理过程也不该被上报' }],
    },
  }
}

/** 起一个真的 HTTP 接收端，把收到的载荷存下来。 */
function startReceiver(): { url: string; received: IngestPayload[]; authHeaders: string[]; stop: () => void } {
  const received: IngestPayload[] = []
  const authHeaders: string[] = []

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      authHeaders.push(req.headers.get('Authorization') ?? '')
      const body = (await req.json()) as IngestPayload
      received.push(body)
      return Response.json({ accepted: body.records.length, duplicates: 0, rejected: 0 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/api/v1/token-usage`,
    received,
    authHeaders,
    stop: () => void server.stop(true),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log('DSH 插件端到端冒烟（真实 HTTP 往返，全部使用临时目录）')
console.log('='.repeat(72))

// ── 0. 打包产物能否 import ───────────────────────────────────────────────────
console.log('\n── 0. 打包产物 ──')
const libPath = join(import.meta.dir, '..', 'lib', 'index.js')
check('lib/index.js 已构建（先跑 bun run --filter @ai-token-report/dsh-plugin build）', existsSync(libPath))
if (existsSync(libPath)) {
  const mod = (await import(libPath)) as { default?: { name?: string; apply?: unknown } }
  check('打包产物可被 import', mod.default !== undefined)
  check('导出默认对象带 name = token-report', mod.default?.name === 'token-report')
  check('导出默认对象带 apply()', typeof mod.default?.apply === 'function')
}

// ── 1. 未署名：一个字节都不发 ────────────────────────────────────────────────
console.log('\n── 1. 未署名 = 不采集也不上报 ──')
{
  const home = makeHome(false)
  const receiver = startReceiver()
  try {
    const host = makeCtx()
    const { status, backend } = apply(host.ctx, {
      appKey: 'atr-smoke-key',
      endpoint: receiver.url,
      dshHome: home,
      outbox: { dir: join(home, 'outbox') },
    })
    host.collectEffects()

    check('未署名时 reportingEnabled = false', status.reportingEnabled === false)
    check('未署名时不创建上报后端', backend === null)
    check('未署名时服务端一个请求都没收到', receiver.received.length === 0)
    check(
      '未署名时给出了可操作的提示',
      host.logs.some((l) => l.includes('尚未署名') && l.includes('不采集')),
    )
  } finally {
    receiver.stop()
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 2. 已署名 + 配齐：完整链路 ──────────────────────────────────────────────
console.log('\n── 2. 已署名：会话事件 → 上报 → 服务端收下 ──')
{
  const home = makeHome(true)
  const receiver = startReceiver()
  try {
    const host = makeCtx()
    const config = {
      name: 'dsh-token-report',
      appKey: 'atr-smoke-key',
      endpoint: receiver.url,
      dshHome: home,
      batch: { maxRecords: 50, flushIntervalMillis: 60_000 },
      outbox: { dir: join(home, 'outbox') },
    }

    const { status, backend } = apply(host.ctx, config)
    host.collectEffects()

    check('已署名 + 配齐 → reportingEnabled = true', status.reportingEnabled === true)
    check('上报后端已创建', backend !== null)

    // 喂 3 条计费事件 + 1 条非计费事件
    backend!.emit(usageEvent(1))
    backend!.emit(usageEvent(2))
    backend!.emit(usageEvent(3))
    const toolCall = usageEvent(4)
    toolCall.attributes['event.type'] = 'tool/call'
    backend!.emit(toolCall)

    check('emit 是同步的：此刻服务端还没收到任何请求', receiver.received.length === 0)
    check('队列里正好是 3 条计费记录（工具调用不计费）', backend!.reporterStats.enqueued === 3)

    await backend!.shutdown()

    check('shutdown 后服务端收到了请求', receiver.received.length === 1)

    const payload = receiver.received[0]
    check('schemaVersion = 1', payload?.schemaVersion === 1)
    check('client.name 用的是配置里的插件名', payload?.client.name === 'dsh-token-report')
    check('client.userName 来自身份文件', payload?.client.userName === '张三')
    check('client.dept 来自身份文件', payload?.client.dept === '研发一部')
    check('appKey 走 Authorization: Bearer 头', receiver.authHeaders[0] === 'Bearer atr-smoke-key')
    check('请求体里不含 appKey', !JSON.stringify(payload).includes('atr-smoke-key'))
    check('条数为 3（非计费事件没进去）', payload?.records.length === 3)

    const first = payload?.records[0] as unknown as Record<string, unknown>
    check('event_id = ${sessionId}:${seq}', first?.['event_id'] === 'session-044004d8:1')
    check('session_id 正确', first?.['session_id'] === 'session-044004d8')
    check('seq 正确', first?.['seq'] === 1)
    check('provider 正确', first?.['provider'] === 'dashscope')
    check('model 正确', first?.['model'] === 'deepseek-v4.1-flash')
    check('★ cache_read_tokens 单列保留（1024）', first?.['cache_read_tokens'] === 1024)
    check('input_tokens 是「未命中缓存」的 7772', first?.['input_tokens'] === 7772)
    check('output_tokens = 186', first?.['output_tokens'] === 186)
    check('cache_write_tokens = 0（仍然占列）', first?.['cache_write_tokens'] === 0)
    check('total_tokens = 四项之和 8982', first?.['total_tokens'] === 8982)
    check('cwd 进了项目归属字段', first?.['cwd'] === 'D:\\Coding\\ai-token-report')
    check('turn / step 正确', first?.['turn'] === 1 && first?.['step'] === 1)
    check('★ 载荷里没有对话内容', !JSON.stringify(payload).includes('这段对话内容'))
    check('★ 载荷里没有推理过程', !JSON.stringify(payload).includes('推理过程'))

    check('投递统计：delivered = 3', backend!.reporterStats.delivered === 3)
    check('请求成功后 outbox 已清空', backend!.reporterStats.outbox.pendingRecords === 0)
  } finally {
    receiver.stop()
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 3. 脱敏瀑布 ─────────────────────────────────────────────────────────────
console.log('\n── 3. 脱敏：DSH 记录在到达后端前就被裁剪 ──')
{
  const home = makeHome(true)
  try {
    const host = makeCtx()
    apply(host.ctx, { appKey: 'k', dshHome: home, outbox: { dir: join(home, 'outbox') } })
    host.collectEffects()

    const cleaned = host.runWaterfall(usageEvent(9))
    const text = JSON.stringify(cleaned.body)

    check('计费字段保留', text.includes('cacheReadTokens') && text.includes('dashscope'))
    check('★ 对话内容被剥掉', !text.includes('这段对话内容'))
    check('★ 推理过程被剥掉', !text.includes('推理过程'))
    check('★ content / stream 字段整体消失', !text.includes('"content"') && !text.includes('"stream"'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 4. 崩溃恢复 ─────────────────────────────────────────────────────────────
console.log('\n── 4. 崩溃不丢：inflight 文件在新进程里被补发 ──')
{
  const home = makeHome(true)
  const receiver = startReceiver()
  const outboxDir = join(home, 'outbox')
  try {
    // 第一段生命周期：发出去了但没等到回执就被杀（手工造出这个中间态）
    const first = makeCtx()
    const r1 = apply(first.ctx, {
      appKey: 'atr-smoke-key',
      endpoint: 'http://127.0.0.1:1/unreachable',
      dshHome: home,
      outbox: { dir: outboxDir },
    })
    first.collectEffects()
    r1.backend!.emit(usageEvent(7))
    await r1.backend!.shutdown()

    const pending = readdirSync(outboxDir).filter((f) => f.startsWith('pending-'))
    check('投递失败后数据留在磁盘上', pending.length === 1)

    // 模拟「已发出、未确认」的中间态，然后进程消失
    renameSync(join(outboxDir, pending[0]!), join(outboxDir, pending[0]!.replace('pending-', 'inflight-')))

    // 第二段生命周期：新进程，网络恢复
    const second = makeCtx()
    const r2 = apply(second.ctx, {
      appKey: 'atr-smoke-key',
      endpoint: receiver.url,
      dshHome: home,
      outbox: { dir: outboxDir },
    })
    second.collectEffects()
    await r2.backend!.shutdown()

    check('新进程把上一轮的 inflight 补发成功', receiver.received.length === 1)
    check(
      '补发的正是那条 seq=7 的记录',
      (receiver.received[0]?.records[0] as unknown as Record<string, unknown>)?.['seq'] === 7,
    )
    check('补发后 outbox 清空', readdirSync(outboxDir).length === 0)
  } finally {
    receiver.stop()
    rmSync(home, { recursive: true, force: true })
  }
}

// ── 5. 统计工具与服务 ───────────────────────────────────────────────────────
console.log('\n── 5. 统计工具与服务（真扫本机会话日志）──')
{
  const provided: Record<string, unknown> = {}
  const home = mkdtempSync(join(tmpdir(), 'atr-smoke-tools-'))
  try {
    const host = makeCtx()
    const ctxWithReflect: ApplyContext = {
      ...host.ctx,
      reflect: { provide: (name, value) => void (provided[name] = value) },
    }
    apply(ctxWithReflect, { appKey: 'k', dshHome: home, outbox: { dir: join(home, 'outbox') } })
    host.collectEffects()

    check('注册了 tokenReportTools', provided['tokenReportTools'] !== undefined)
    check('注册了 ctx.tokenReport', provided['tokenReport'] !== undefined)

    const tools = provided['tokenReportTools'] as Record<string, { run: (a: Record<string, unknown>) => Promise<string> }>
    check('工具名为 token_usage', tools['token_usage'] !== undefined)
    check('附带诊断工具', tools['token_usage_diagnostics'] !== undefined)

    // 用真实的 DSH home 跑一次查询（只读，不写任何东西）
    const realHome = process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? '', '.dsh')
    const realCtx = makeCtx()
    const realProvided: Record<string, unknown> = {}
    apply(
      { ...realCtx.ctx, reflect: { provide: (n, v) => void (realProvided[n] = v) } },
      { appKey: 'k', dshHome: realHome, features: { reporting: false }, localDb: false },
    )
    realCtx.collectEffects()

    const realTools = realProvided['tokenReportTools'] as Record<string, { run: (a: Record<string, unknown>) => Promise<string> }>
    const text = await realTools['token_usage']!.run({ period: 'last30d', by: 'provider' })

    console.log('\n  ── token_usage(period=last30d, by=provider) 实际输出 ──')
    for (const line of text.split('\n').slice(0, 16)) console.log(`  │ ${line}`)

    check('真实查询返回了总计区块', text.includes('=== 总计 ==='))
    check('★ 四项 token 分列展示', text.includes('未缓存输入') && text.includes('缓存读'))
    check('★ 缓存命中率带口径说明', text.includes('cacheRead/(cacheRead+input)'))
    check('数据来源如实标注', text.includes('数据来源'))
    check('没有把降级伪装成库查询（localDb=false 时应为直扫）', text.includes('直扫会话日志') || text.includes('未找到'))

    const diag = await tools['token_usage_diagnostics']!.run({})
    check('诊断文本说明了上报地址', diag.includes('上报地址'))
    check('诊断文本不回显凭证', diag.includes('已配置（不回显）'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(72))
if (failures === 0) {
  console.log(`✅ 全部通过：${checks} 项断言`)
} else {
  console.log(`❌ ${failures} / ${checks} 项断言失败`)
  process.exitCode = 1
}
console.log('='.repeat(72))
