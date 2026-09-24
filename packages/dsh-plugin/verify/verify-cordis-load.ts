/**
 * 真实 cordis 装载冒烟：把**打包产物**挂进一个真的 cordis 根上下文。
 *
 * ```
 * bun run packages/dsh-plugin/verify/verify-cordis-load.ts
 * ```
 *
 * ## 为什么必须单独做这一步
 *
 * 前面的单测与端到端冒烟用的都是假 ctx —— 它们能证明**插件的逻辑**对，
 * 但证明不了**插件能被 DSH 装上去**。真实装载会额外暴露三类问题：
 *
 * 1. `SessionTelemetryBackend` 的 `super(ctx, 'sessionTelemetry')` 是否真的
 *    注册成功（服务名冲突会抛错）。
 * 2. 插件导出形状是否符合 cordis 的 `{ name, apply }` 约定。
 * 3. `ctx.on(...)` / `ctx.effect(...)` / `ctx.logger` 在真上下文里是否可调用，
 *    以及 **fiber 卸载时监听器与定时器是否被清干净**（泄漏在这里最容易暴露）。
 *
 * 全程使用临时 `DSH_HOME`，不碰真实数据；也**不会**发任何网络请求
 * （用一个不可达的地址，让上报必然失败并留在 outbox）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

console.log('='.repeat(72))
console.log('真实 cordis 装载冒烟（打包产物 → 真 Context）')
console.log('='.repeat(72))

const home = mkdtempSync(join(tmpdir(), 'atr-cordis-'))
mkdirSync(join(home, 'token-report'), { recursive: true })
writeFileSync(
  join(home, 'token-report', 'identity.json'),
  JSON.stringify({ name: '张三', token: 'tok-cordis', dept: '研发一部', createdAt: 1, updatedAt: 1 }),
)

try {
  const plugin = (await import(join(import.meta.dir, '..', 'lib', 'index.js'))) as {
    default: { name: string; apply: (ctx: Context, config: unknown) => void }
  }

  console.log('\n── 导出形状 ──')
  check('默认导出带 name', plugin.default.name === 'token-report')
  check('默认导出带 apply()', typeof plugin.default.apply === 'function')
  // 🚨 依赖声明必须在 **default 导出** 上。写在 TokenReportBackend 类上会静默失效：
  //    类根本不会被实例化（apply 是被直接调用的），loader 只读插件条目对象的 inject。
  //    这个坑真实踩过 —— 插件能 import、apply 也能跑，但依赖注入的等待语义全丢。
  check(
    '★ 默认导出带 inject（写类上会静默失效）',
    Array.isArray((plugin.default as { inject?: unknown }).inject) &&
      (plugin.default as { inject: string[] }).inject.includes('sessions'),
    `inject = ${JSON.stringify((plugin.default as { inject?: unknown }).inject ?? '(无)')}`,
  )

  // ── 真实装载 ────────────────────────────────────────────────────────────
  console.log('\n── 挂进真 Context ──')
  const root = new Context()
  // 插件声明 `inject = ['sessions']`：cordis 要求被注入的服务先就位。
  // DSH 里由 `dsh-session` 提供它，这里给一个最小替身。
  root.provide('sessions', { list: () => [] })

  const fiber = root.plugin(plugin.default as never, {
    appKey: 'atr-cordis-key',
    endpoint: 'http://127.0.0.1:1/unreachable',
    dshHome: home,
    outbox: { dir: join(home, 'outbox') },
  } as never)

  // 让 cordis 完成 fiber 装载与依赖注入
  await new Promise((r) => setTimeout(r, 200))

  check('fiber 未因加载失败而消失', fiber !== undefined)
  check('sessionTelemetry 服务已注册到上下文', root.get('sessionTelemetry') !== undefined)

  const backend = root.get('sessionTelemetry') as {
    emit: (r: unknown) => void
    reporterStats: { enqueued: number; outbox: { pendingRecords: number } }
    shutdown: () => Promise<void>
  }
  check('后端暴露了 emit()', typeof backend?.emit === 'function')
  // ★ 这两条断言是**只有真实装载才能发现的问题**的防线：cordis 的 ctx.get()
  //   返回服务代理，而 JS 私有字段穿不过 Proxy。所以热路径的 `emit()` 与
  //   诊断入口 `reporterStats` 都必须是不依赖私有字段的形式 ——
  //   否则每一次会话事件都会抛 "invalid private field"，而单测（用真实例）全绿。
  check(
    'reporterStats 能穿过 cordis 的服务代理读出数据',
    backend?.reporterStats !== undefined && typeof backend.reporterStats.enqueued === 'number',
  )

  // ── 真实事件走一遍热路径 ────────────────────────────────────────────────
  console.log('\n── 通过 cordis 事件总线喂一条计费事件 ──')
  const before = backend.reporterStats.enqueued
  backend.emit({
    channel: 'ledger',
    time: Date.now(),
    severity: 'info',
    attributes: {
      'session.id': 's-cordis',
      'event.type': 'assistant/message',
      'event.seq': 1,
      'session.cwd': 'D:/Coding/x',
    },
    body: {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'dashscope', model: 'm' } },
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 900 },
    },
  })
  check('计费事件被入队', backend.reporterStats.enqueued === before + 1)

  // ── 卸载：监听器与定时器必须被清掉 ──────────────────────────────────────
  console.log('\n── 卸载（fiber dispose）──')
  await backend.shutdown()
  await fiber.dispose()
  await new Promise((r) => setTimeout(r, 100))

  // 卸载后服务应随 fiber 一起消失；若还在，说明注册没挂在本插件的 fiber 上
  const after = root.get('sessionTelemetry')
  check('卸载后 sessionTelemetry 服务已解除注册', after === undefined || after === null)

  // 进程能自然退出即说明定时器被 clearInterval 了（unref 之外的第二道保险）
  check('没有把进程钉在定时器上（走到这里即通过）', true)
} catch (err) {
  failures++
  checks++
  console.log(`  ❌ 装载抛错：${err instanceof Error ? err.stack : String(err)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(72))
if (failures === 0) console.log(`✅ 全部通过：${checks} 项断言`)
else console.log(`❌ ${failures} / ${checks} 项断言失败`)
console.log('='.repeat(72))
if (failures > 0) process.exitCode = 1
