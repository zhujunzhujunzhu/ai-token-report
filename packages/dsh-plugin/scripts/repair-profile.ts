#!/usr/bin/env node
/** 离线修复入口。默认检查；--apply 才写入，落盘前备份，失败则还原。 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertSinglePlugin, repairProfileData } from '../src/profile-repair.js'

export function hostRequire(profileDir: string) {
  const candidates = [process.env['ATR_DSH_MODULES'], join(homedir(), '.bun/install/global/node_modules')]
  const anchors = [join(profileDir, 'package.json'), ...candidates.filter(Boolean).map((p) => join(p!, '_probe.cjs'))]
  for (const anchor of anchors) {
    const req = createRequire(anchor)
    try { req.resolve('@deepseek-ai/dsh-app-boot'); return req } catch { /* 换一个宿主安装位置。 */ }
  }
  throw new Error('找不到 DSH 宿主，请用 ATR_DSH_MODULES 指定宿主 node_modules')
}

export async function repairProfile(profileDir: string, home: string, apply: boolean) {
  const req = hostRequire(profileDir)
  const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const originalManifest = readFileSync(manifestPath, 'utf8')
  const originalPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
  const original = JSON.parse(originalManifest)
  const patches = boot.loadOptionalPatches('token-report-repair', patchPath) ?? []
  const homePatches = boot.loadOptionalPatches('token-report-repair', join(home, 'cordis.patch.yml')) ?? []
  const fixed = repairProfileData(original, patches)
  const anchor = req.resolve('@deepseek-ai/dsh/package.json')
  const layers = fixed.manifest['dsh'] as { profile: { bundles: string[] } }
  const bundlePatches = layers.profile.bundles.map((name) => {
    const dir = boot.resolveBundleDir('token-report-repair', name, anchor, profileDir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return boot.loadOverlayPatches('token-report-repair', join(dir, pkg.dsh.bundle.patch))
  })
  // 宿主真实合并算法；全局层若再次插入，会在任何写入之前拒绝。
  assertSinglePlugin(boot.composeEntries([...bundlePatches, fixed.patches, homePatches]))
  const changed = JSON.stringify(original) !== JSON.stringify(fixed.manifest) || JSON.stringify(patches) !== JSON.stringify(fixed.patches)
  if (!changed) return { changed: false }
  if (!apply) return { changed: true }
  // 使用宿主同款 !!js 类型，保留表达式而绝不求值。YAML 注释保留在原始备份中。
  const yaml = createRequire(req.resolve('@deepseek-ai/dsh-app-boot'))('js-yaml')
  const js = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', predicate: (v: unknown) => !!v && typeof v === 'object' && '__jsExpr' in v,
    represent: (v: { __jsExpr: string }) => v.__jsExpr,
  })
  const output = yaml.dump(fixed.patches, { schema: yaml.JSON_SCHEMA.extend(js), lineWidth: -1, noRefs: true })
  const backup = join(home, 'token-report', 'plugin-backups', `repair-${Date.now()}-${process.pid}`)
  mkdirSync(backup, { recursive: true })
  copyFileSync(manifestPath, join(backup, 'package.json'))
  if (originalPatch !== undefined) copyFileSync(patchPath, join(backup, 'cordis.patch.yml'))
  const writeAtomic = (path: string, text: string) => {
    const temp = `${path}.repair-${process.pid}.tmp`
    writeFileSync(temp, text, { flag: 'wx' })
    renameSync(temp, path)
  }
  // 防止检查期间用户/DSH 改过配置，覆盖别人刚保存的内容。
  if (readFileSync(manifestPath, 'utf8') !== originalManifest ||
      (existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined) !== originalPatch) {
    throw new Error('配置在检查期间发生变化，请停止 DSH 后重试')
  }
  try {
    writeAtomic(manifestPath, JSON.stringify(fixed.manifest, null, 2) + '\n')
    writeAtomic(patchPath, output)
  } catch (error) {
    writeFileSync(manifestPath, originalManifest)
    if (originalPatch !== undefined) writeFileSync(patchPath, originalPatch)
    throw error
  }
  return { changed: true, backup }
}

export async function main(args = process.argv.slice(2)) {
  let profile = 'web'
  let apply = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true
    else if (args[i] === '--profile' && args[i + 1]) profile = args[++i]!
    else throw new Error('用法：dsh-token-report-repair [--profile web] [--apply]')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('profile 名称只能包含字母、数字、下划线和连字符')
  const home = resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const result = await repairProfile(join(home, 'profiles', profile), home, apply)
  console.log(result.backup ? `已修复；备份：${result.backup}` : result.changed ? '检测到重复挂载；停止 DSH 后加 --apply 修复' : '挂载检查通过，无需修改')
  if (result.changed && !apply) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
