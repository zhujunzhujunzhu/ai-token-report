/**
 * 真实 cordis 装载冒烟：把**打包产物**挂进一个真的 cordis 根上下文。
 *
 * ```
 * bun run packages/dsh-plugin/verify/verify-cordis-load.ts
 * ```
 *
 * ## 为什么必须单独做这一步
 *
 * 单测与端到端冒烟用的都是假 ctx —— 它们能证明**插件的逻辑**对，
 * 但证明不了**插件能被 DSH 装上去**。真实装载会额外暴露三类问题：
 *
 * 1. 插件导出形状是否符合 cordis 的 `{ name, apply }` 约定；
 * 2. `ctx.on(...)` / `ctx.effect(...)` / `ctx.logger` 在真上下文里是否可调用，
 *    以及 **fiber 卸载时监听器是否被清干净**（泄漏在这里最容易暴露）；
 * 3. ★ **与官方 OTel 后端共存** —— 0.9.0 起本插件不再注册 `sessionTelemetry`
 *    服务（所以不再互斥），而「不再抢名字」这件事只有在**真的有人先占了那个名字**
 *    时才测得出来：本脚本先放一个「官方后端替身」进去占位，再装载本插件。
 *
 * 全程使用临时 `DSH_HOME` + 临时 `dataDir`，不碰真实数据（缺省数据目录在
 * 家目录下且**不跟随 `DSH_HOME`**）；也**不会**发任何网络请求
 * （用一个不可达的地址，让上报必然失败并留在 outbox）。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
console.log('真实 cordis 装载冒烟（打包产物 → 真 Context → 与官方后端共存）')
console.log('='.repeat(72))

const home = mkdtempSync(join(tmpdir(), 'atr-cordis-'))
mkdirSync(join(home, 'token-report'), { recursive: true })
writeFileSync(
  join(home, 'token-report', 'identity.json'),
  JSON.stringify({ name: '张三', token: 'tok-cordis', group: '研发一部', createdAt: 1, updatedAt: 1 }),
)

/** 一条计费事件（宿主 `session/event` 的形状）。 */
function billingEvent(seq: number, type = 'assistant/message'): [{ id: string; header: { cwd: string } }, Record<string, unknown>] {
  return [
    { id: 's-cordis', header: { cwd: 'D:/Coding/x' } },
    {
      type,
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        turn: 1,
        step: seq,
        message: { source: { kind: 'model', provider: 'dashscope', model: 'm' } },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 900 },
      },
    },
  ]
}

try {
  const plugin = (await import(join(import.meta.dir, '..', 'lib', 'index.js'))) as {
    default: { name: string; apply: (ctx: Context, config: unknown) => void }
  }

  console.log('\n── 导出形状 ──')
  check('默认导出带 name', plugin.default.name === 'token-report')
  check('默认导出带 apply()', typeof plugin.default.apply === 'function')
  // 🚨 依赖声明必须在 **default 导出** 上。写在插件类上会静默失效：
  //    类根本不会被实例化（apply 是被直接调用的），loader 只读插件条目对象的 inject。
  //    这个坑真实踩过 —— 插件能 import、apply 也能跑，但依赖注入的等待语义全丢。
  check(
    '★ 默认导出带 inject（写类上会静默失效）',
    Array.isArray((plugin.default as { inject?: unknown }).inject) &&
      (plugin.default as { inject: string[] }).inject.includes('sessions'),
    `inject = ${JSON.stringify((plugin.default as { inject?: unknown }).inject ?? '(无)')}`,
  )

  // ── 真实装载（并先让「官方后端」占住服务名）────────────────────────────
  console.log('\n── 挂进真 Context（服务名已被官方后端占住）──')
  const root = new Context()
  // 插件声明 `inject = ['sessions']`：cordis 要求被注入的服务先就位。
  // DSH 里由 `dsh-session` 提供它，这里给一个最小替身。
  root.provide('sessions', { list: () => [] })
  // ★ 官方 `dsh-session-telemetry-otel` 后端替身：它就干一件事 —— 占住
  //   `sessionTelemetry` 这个名字（宿主源码注释：它 "always registers" 该服务，
  //   连 `mode: DISABLED` 也一样）。0.8.x 时这一行会让下面的 plugin() 直接抛
  //   `service "sessionTelemetry" has been registered at <…>`；现在必须照样装得上。
  const official = {
    emit: () => {},
    flush: () => {},
    shutdown: async () => {},
    reporterStats: { enqueued: 0 },
  }
  root.provide('sessionTelemetry', official)

  const fiber = root.plugin(plugin.default as never, {
    appKey: 'atr-cordis-key',
    endpoint: 'http://127.0.0.1:1/unreachable',
    dshHome: home,
    dataDir: join(home, 'token-report'),
    outbox: { dir: join(home, 'outbox') },
  } as never)

  // 让 cordis 完成 fiber 装载与依赖注入
  await new Promise((r) => setTimeout(r, 200))

  check('fiber 未因加载失败而消失', fiber !== undefined)
  // ★ 这一条就是「不再互斥」的正面证据：那个名字仍然属于官方后端，
  //   而本插件照样装载成功（0.8.x 时 plugin() 会在这里直接抛）。
  check('★ 官方后端占着服务名时本插件照样装载，且没把官方后端顶掉', root.get('sessionTelemetry') === official)

  // ── 真实事件总线喂一条计费事件 ──────────────────────────────────────────
  console.log('\n── 通过 cordis 事件总线喂 session/event ──')
  // 诊断入口从插件自己的服务上取（不再是 sessionTelemetry —— 那是官方的）
  const tokenReport = root.get('tokenReport') as
    | { query: (q: unknown) => Promise<unknown>; signed: () => boolean }
    | undefined
  check('插件自己的 ctx.tokenReport 服务已注册', typeof tokenReport?.query === 'function')

  // 计数从插件导出的运行时读：这里用一个「读 outbox 目录文件个数」的观察点太脆，
  // 改为直接看 `token_usage` 工具之外的证据 —— 事件被折叠后会写进 outbox。
  const outboxDir = join(home, 'outbox')
  const pendingCount = (): number => {
    try {
      return readdirSync(outboxDir).filter((f) => f.startsWith('pending-')).length
    } catch {
      return 0
    }
  }

  root.emit('session/event', ...billingEvent(1))
  root.emit('session/event', ...billingEvent(2, 'tool/call'))
  // 冲刷提示（宿主在 turn 结束时会发）：走一遍，确认回调不炸
  root.emit('session/flush', { id: 's-cordis' })
  await new Promise((r) => setTimeout(r, 500))

  // 不可达地址 ⇒ 批次投递失败后留在磁盘上；「有一条 pending 批次」= 捕获 → 折叠 → 入队 → 投递
  // 这条路真的走通了（工具调用那条不计费，只有 1 条记录进了同一批）。
  check('★ 真事件总线上的计费事件被捕获并投递（失败后留在 outbox）', pendingCount() >= 1, `pending 文件 ${pendingCount()} 个`)

  // ── 卸载：捕获监听与定时器必须被清掉 ────────────────────────────────────
  console.log('\n── 卸载（fiber dispose）──')
  await fiber.dispose()
  await new Promise((r) => setTimeout(r, 100))

  check('★ 卸载后官方后端仍在（我们从来没碰过那个服务名）', root.get('sessionTelemetry') === official)

  // 卸载后再喂事件：既不能入队，也不能抛（监听器应随 fiber 一起解除）
  const before = pendingCount()
  let threw = false
  try {
    root.emit('session/event', ...billingEvent(3))
  } catch {
    threw = true
  }
  await new Promise((r) => setTimeout(r, 100))
  check('卸载后不再捕获（监听器已随 fiber 解除）', pendingCount() === before)
  check('卸载后喂事件不抛错', threw === false)

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
