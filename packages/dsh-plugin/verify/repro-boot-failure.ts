/**
 * 真实 DSH 装载复现：把插件按 **DSH 组装出来的配置**挂进 cordis，
 * 并把真实的激活错误完整打出来（DSH 的 launcher 会把 cause 吞掉）。
 *
 * ```
 * bun run packages/dsh-plugin/verify/repro-boot-failure.ts
 * ```
 *
 * 存在的理由：`dsh --profile web` 失败时只报
 * 「loader entries failed to apply」，**看不到根因**。
 * 这个脚本直接走 cordis 的 loader，把 `cause` 链一层层展开。
 */

import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const profileDir = join(process.env['USERPROFILE'] ?? '', '.dsh', 'profiles', 'web')
const libPath = join(profileDir, 'node_modules', '@ai-token-report', 'dsh-plugin', 'lib', 'index.js')

console.log('='.repeat(72))
console.log('插件激活复现（展开真实 cause）')
console.log('='.repeat(72))

/** 把任意错误的 cause 链完整展开。 */
function expand(err: unknown, depth = 0): void {
  const pad = '  '.repeat(depth)
  if (err instanceof AggregateError) {
    console.log(`${pad}AggregateError: ${err.message}（${err.errors.length} 个）`)
    for (const e of err.errors) expand(e, depth + 1)
    return
  }
  if (err instanceof Error) {
    console.log(`${pad}${err.constructor.name}: ${err.message}`)
    if (err.stack) {
      for (const line of err.stack.split('\n').slice(1, 6)) console.log(`${pad}  ${line.trim()}`)
    }
    if (err.cause !== undefined) {
      console.log(`${pad}↳ cause:`)
      expand(err.cause, depth + 1)
    }
    return
  }
  console.log(`${pad}${String(err)}`)
}

const mod = (await import(pathToFileURL(libPath).href)) as {
  default: { name: string; apply: (ctx: unknown, config: unknown) => void }
}

console.log(`\n插件  ${libPath}`)
console.log(`名称  ${mod.default.name}`)

// 按 profile 里配的那份 config 走一遍（与 cordis.patch.yml 保持一致）
const config = {
  name: 'dsh-token-report',
  appKey: '',
  endpoint: 'http://127.0.0.1:8787/api/v1/token-usage',
  batch: { maxRecords: 50, flushIntervalMillis: 10000, timeoutMillis: 15000 },
  outbox: { enabled: true, maxBytes: 33554432 },
  features: { reporting: true, tools: true, service: true },
  localDb: false,
}

console.log('\n── 直接调用 apply()（不经过 loader）──')
const root = new Context()
root.provide('sessions', { list: () => [] })
try {
  mod.default.apply(root as never, config)
  await new Promise((r) => setTimeout(r, 400))
  console.log('  ✅ apply() 未抛错')
  console.log('  sessionTelemetry =', root.get('sessionTelemetry') === undefined ? 'undefined' : '已注册')

  const backend = root.get('sessionTelemetry') as { reporterStats?: { enqueued: number } } | undefined
  console.log('  reporterStats.enqueued =', backend?.reporterStats?.enqueued)
} catch (err) {
  console.log('  ❌ apply() 抛错：')
  expand(err, 2)
}

console.log('\n── 经由 cordis 插件系统挂载（与 DSH 的 loader 同路径）──')
const root2 = new Context()
root2.provide('sessions', { list: () => [] })
try {
  root2.plugin(mod.default as never, config as never)
  await new Promise((r) => setTimeout(r, 500))
  console.log('  ✅ plugin() 挂载完成')
  const backend = root2.get('sessionTelemetry') as { reporterStats?: { enqueued: number } } | undefined
  console.log('  sessionTelemetry =', backend === undefined ? 'undefined' : '已注册')
  console.log('  reporterStats.enqueued =', backend?.reporterStats?.enqueued)

  // 走一次热路径（真实 DSH 里 coordinator 就是这么调的）
  const b = root2.get('sessionTelemetry') as { emit: (r: unknown) => void } | undefined
  b?.emit({
    channel: 'ledger',
    time: Date.now(),
    severity: 'info',
    attributes: {
      'session.id': 's-repro',
      'event.type': 'assistant/message',
      'event.seq': 1,
    },
    body: {
      turn: 1,
      step: 1,
      message: { source: { kind: 'model', provider: 'dashscope', model: 'm' } },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 },
    },
  })
  const after = root2.get('sessionTelemetry') as { reporterStats?: { enqueued: number } } | undefined
  console.log('  emit 后 enqueued =', after?.reporterStats?.enqueued)
  await (after as unknown as { shutdown: () => Promise<void> })?.shutdown?.()
} catch (err) {
  console.log('  ❌ plugin() 挂载失败：')
  expand(err, 2)
  process.exitCode = 1
}