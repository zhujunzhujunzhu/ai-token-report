/**
 * 诊断 profile 的激活失败条目（简化版，只用 Node 内置能力）。
 *
 * ```
 * bun run packages/dsh-plugin/verify/diagnose-boot.ts [profileName]
 * ```
 *
 * 存在的理由：`dsh --profile X` 失败时只报「loader entries failed to apply」，
 * 把真正的根因（哪个条目、什么异常）整条吞掉。
 * 这个脚本按 profile 的组装规则，把**每个候选包**逐个 import 一遍，
 * 谁炸就报谁，并展开完整 cause 链。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileName = process.argv[2] ?? 'web'
const dshHome = join(process.env['USERPROFILE'] ?? '', '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)

console.log('='.repeat(72))
console.log(`诊断 profile "${profileName}"`)
console.log('='.repeat(72))
console.log(`目录  ${profileDir}\n`)

/** 展开任意错误的 cause 链。 */
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
      for (const line of err.stack.split('\n').slice(1, 4)) console.log(`${pad}  ${line.trim()}`)
    }
    if (err.cause !== undefined) {
      console.log(`${pad}↳ cause:`)
      expand(err.cause, depth + 1)
    }
    return
  }
  console.log(`${pad}${String(err)}`)
}

const req = createRequire(join(profileDir, 'package.json'))

/** 试 import 一个包，返回是否成功。 */
async function tryImport(label: string, spec: string): Promise<boolean> {
  let resolved: string
  try {
    resolved = req.resolve(spec)
  } catch (err) {
    // bundle 包可能通过 exports 暴露 patch 而非可执行入口；解析失败只作提示
    console.log(`  ⚠️  ${label}  —— 无法解析入口`)
    console.log(`      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    return true // 解析不到入口不算「import 失败」，交给后面的 patch 检查
  }
  try {
    await import(pathToFileURL(resolved).href)
    console.log(`  ✅ ${label}`)
    return true
  } catch (err) {
    console.log(`  ❌ ${label}  —— import 失败  (${resolved})`)
    expand(err, 3)
    return false
  }
}

// ── 1. bundles 里的包 ────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
  dsh?: { profile?: { bundles?: string[] } }
}
console.log('── bundles ──')
for (const b of pkg.dsh?.profile?.bundles ?? []) await tryImport(b, b)

// ── 2. bundle 自己的 patch 里 insert 的包 ────────────────────────────────────
console.log('\n── bundle patch 里 insert 的包 ──')
for (const b of pkg.dsh?.profile?.bundles ?? []) {
  let patchPath: string | undefined
  try {
    const bPkgPath = req.resolve(`${b}/package.json`)
    const bPkg = JSON.parse(readFileSync(bPkgPath, 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    const rel = bPkg.dsh?.bundle?.patch
    if (rel) patchPath = join(bPkgPath, '..', rel)
  } catch {
    continue
  }
  if (!patchPath || !existsSync(patchPath)) continue

  const text = readFileSync(patchPath, 'utf8')
  // 只取 insert 段里的 name（缩进 ≥4 空格的 name:）
  const names = [...text.matchAll(/^\s{4,}name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1]!.trim())
  for (const n of names) {
    if (n.startsWith('@deepseek-ai/') && !n.includes('browser-skill')) {
      // 第一方包数量巨大，只报失败的
      const resolved = (() => {
        try {
          return req.resolve(n)
        } catch {
          return null
        }
      })()
      if (!resolved) {
        console.log(`  ⚠️  ${n}  —— 无法解析`)
        continue
      }
      try {
        await import(pathToFileURL(resolved).href)
      } catch (err) {
        console.log(`  ❌ ${n}  —— import 失败  (${resolved})`)
        expand(err, 3)
      }
    } else {
      await tryImport(n, n)
    }
  }
}

// ── 3. 用户 patch 里点名的包 ─────────────────────────────────────────────────
console.log('\n── 用户 cordis.patch.yml 里点名的包 ──')
const userPatch = join(profileDir, 'cordis.patch.yml')
if (existsSync(userPatch)) {
  const text = readFileSync(userPatch, 'utf8')
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1]!.trim())
  for (const n of [...new Set(names)]) await tryImport(n, n)
}

console.log('\n' + '='.repeat(72))