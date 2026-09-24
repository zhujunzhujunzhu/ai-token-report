/**
 * 验证插件在 cordis 里 **何时** 被激活：`apply()` 是否真的被调用。
 *
 * ```
 * bun run packages/dsh-plugin/verify/probe-activation.ts
 * ```
 *
 * 用与 DSH loader 相同的调用形态（`ctx.registry.plugin(plugin, config)`），
 * 对比「有 sessions 服务」与「没有 sessions 服务」两种情况。
 * 这能区分「插件逻辑错」与「依赖等待导致 apply 从未执行」。
 */

import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = join(process.env['USERPROFILE'] ?? '', '.dsh', 'profiles', 'web')
const libPath = join(profileDir, 'node_modules', '@ai-token-report', 'dsh-plugin', 'lib', 'index.js')

const mod = (await import(pathToFileURL(libPath).href)) as {
  default: { name: string; inject?: unknown; apply: (ctx: unknown, config: unknown) => void }
}

console.log('='.repeat(72))
console.log('激活探针：apply() 到底有没有被调用')
console.log('='.repeat(72))
console.log(`插件  ${mod.default.name}`)
console.log(`inject = ${JSON.stringify(mod.default.inject ?? '(无)')}`)
console.log(`静态 inject = ${JSON.stringify((mod.default as unknown as { inject?: unknown }).inject ?? '(无)')}`)

const config = {
  name: 'dsh-token-report',
  appKey: 'atr-probe',
  endpoint: 'http://127.0.0.1:1/nope',
  outbox: { dir: join(process.env['TEMP'] ?? '', 'atr-probe-outbox') },
}

// —— 场景 1：sessions 服务**已提供** ——
console.log('\n── 场景 1：context 里已提供 sessions 服务 ──')
{
  const root = new Context()
  root.provide('sessions', { list: () => [] })
  let applied = false
  const origApply = mod.default.apply
  const spy = {
    ...mod.default,
    inject: (mod.default as unknown as { inject?: unknown }).inject,
    apply: (ctx: unknown, cfg: unknown) => {
      applied = true
      console.log('  ★ apply() 被调用')
      return origApply.call(mod.default, ctx, cfg)
    },
  }
  try {
    root.registry.plugin(spy as never, config as never)
    await new Promise((r) => setTimeout(r, 600))
    console.log(`  apply 是否执行: ${applied ? '✅ 是' : '❌ 否'}`)
    console.log(`  sessionTelemetry: ${root.get('sessionTelemetry') === undefined ? 'undefined' : '已注册'}`)
  } catch (err) {
    console.log(`  ❌ 抛错: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// —— 场景 2：sessions 服务**未提供**（模拟依赖未就绪）——
console.log('\n── 场景 2：context 里**没有** sessions 服务 ──')
{
  const root = new Context()
  let applied = false
  const origApply = mod.default.apply
  const spy = {
    ...mod.default,
    inject: (mod.default as unknown as { inject?: unknown }).inject,
    apply: (ctx: unknown, cfg: unknown) => {
      applied = true
      console.log('  ★ apply() 被调用')
      return origApply.call(mod.default, ctx, cfg)
    },
  }
  try {
    root.registry.plugin(spy as never, config as never)
    await new Promise((r) => setTimeout(r, 600))
    console.log(`  apply 是否执行: ${applied ? '✅ 是' : '❌ 否（在等服务，符合预期）'}`)
  } catch (err) {
    console.log(`  ❌ 抛错: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log('\n' + '='.repeat(72))