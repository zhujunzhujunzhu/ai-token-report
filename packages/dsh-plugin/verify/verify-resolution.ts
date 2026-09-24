/**
 * 解析验证：模拟 DSH 宿主（**Node**，不是 Bun）加载插件时的模块解析。
 *
 * ```
 * bun run packages/dsh-plugin/verify/verify-resolution.ts
 * ```
 *
 * ## 为什么必须有这一步
 *
 * 本仓的开发与测试全部跑在 **Bun** 上，而 DSH 宿主跑在 **Node** 上。
 * 两者的解析规则有两处关键差异，都能让「本地全绿、装上去就炸」：
 *
 * 1. **Bun 读 `exports` 的 `bun` 条件**，Node 不读。
 * 2. **Bun 能直接 import `.ts`**，Node 不能 —— 本仓的 workspace 包
 *    （`@ai-token-report/core` / `shared`）的 `main` 恰恰指向 **`src/index.ts`**！
 *
 * 所以这个脚本用 `createRequire` 从**插件的实际安装位置**出发做解析，
 * 断言每一个运行时依赖在 **Node 语义下**都能落到一个真实文件上。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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
console.log('模块解析验证（Node 语义，模拟 DSH 宿主加载插件）')
console.log('='.repeat(72))

const pluginDir = resolve(import.meta.dir, '..')
const libPath = join(pluginDir, 'lib', 'index.js')

console.log(`\n插件目录  ${pluginDir}`)
console.log(`打包产物  ${libPath}`)

console.log('\n── 打包产物 ──')
check('lib/index.js 存在', existsSync(libPath))

const source = readFileSync(libPath, 'utf8')
// 抽出所有裸模块说明符（"from \"x\"" 形式）
const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)]
  .map((m) => m[1]!)
  .filter((s) => !s.startsWith('node:') && !s.startsWith('.') && !s.startsWith('/'))
const unique = [...new Set(specifiers)].sort()

console.log('\n── 运行时依赖（排除 node: 内置）──')
for (const spec of unique) console.log(`  · ${spec}`)

// ★ 关键：用 Node 的解析算法，从打包产物所在目录出发解析
const requireFromPlugin = createRequire(libPath)

console.log('\n── Node 能否解析每一个依赖 ──')
for (const spec of unique) {
  try {
    const resolved = requireFromPlugin.resolve(spec)
    // ⚠️ Bun 允许 import .ts，Node 不允许 —— 解析到 .ts 等于运行时必炸
    const isTs = resolved.endsWith('.ts')
    check(
      `${spec} → Node 可解析`,
      existsSync(resolved) && !isTs,
      isTs
        ? `解析到 ${resolved}\n     Node 无法加载 .ts 文件（Bun 可以）。需要在 profile 里为该包提供构建产物或改指向 .js。`
        : `解析到 ${resolved}，但文件不存在`,
    )
    if (existsSync(resolved) && !isTs) console.log(`      → ${resolved}`)
  } catch (err) {
    check(`${spec} → Node 可解析`, false, err instanceof Error ? err.message : String(err))
  }
}

// ── peer 依赖 ────────────────────────────────────────────────────────────────
console.log('\n── peer 依赖（DSH 宿主提供）──')
const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
}
for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
  try {
    const resolved = requireFromPlugin.resolve(peer)
    check(`${peer} @ ${range} 可解析`, existsSync(resolved))
    console.log(`      → ${resolved}`)
  } catch (err) {
    check(`${peer} @ ${range} 可解析`, false, err instanceof Error ? err.message : String(err))
  }
}

// ── 真实 import：只有打包产物能被 Node 加载才算数 ────────────────────────────
console.log('\n── Node 真实加载打包产物 ──')
try {
  // 注意：这里用 Node 而不是 Bun 来跑，才真正验证宿主语义
  const { spawnSync } = await import('node:child_process')
  const script = `import(${JSON.stringify(libPath)}).then(m => { console.log(JSON.stringify({ name: m.default?.name, hasApply: typeof m.default?.apply === 'function', hasRunTool: typeof m.queryUsage === 'function' })) }).catch(e => { console.error('LOAD_FAIL: ' + e.message); process.exit(1) })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: pluginDir,
    timeout: 30_000,
    // ⚠️ 不能用管道捕获 —— 受限沙箱下 pipe stdio 会 EPERM
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.status === 0) {
    const out = JSON.parse(r.stdout.trim()) as { name: string; hasApply: boolean; hasRunTool: boolean }
    check(`Node 加载成功，导出 name = ${out.name}`, out.name === 'token-report')
    check('导出 apply()', out.hasApply)
    check('导出 queryUsage()（供服务/工具复用）', out.hasRunTool)
  } else {
    check('Node 能加载打包产物', false, r.stderr.trim() || `exit ${r.status}`)
  }
} catch (err) {
  check('Node 能加载打包产物', false, err instanceof Error ? err.message : String(err))
}

console.log('\n' + '='.repeat(72))
if (failures === 0) console.log(`✅ 全部通过：${checks} 项断言`)
else console.log(`❌ ${failures} / ${checks} 项断言失败`)
console.log('='.repeat(72))
if (failures > 0) process.exitCode = 1
void dirname