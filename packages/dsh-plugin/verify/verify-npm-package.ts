/**
 * 发布产物（npm 包 `dsh-plugin-token-report`）的**装载前验证**。
 *
 * ## 为什么需要它
 *
 * 单元测试与 typecheck 都在 **Bun** 下跑，而 DSH 宿主跑在 **Node** 上。
 * 发布形态最容易坏的三处，它们一个都答不了：
 *
 * 1. **`cordis.patch.yml` 的 `name` 写成 workspace 名** → 同事装了以后
 *    DSH 启动报「找不到模块」，而本地直挂（junction）测试全绿。
 * 2. **浏览器半信封 id 与包名不一致** → 表现为「面板不见了」，不是报错。
 * 3. **产物里残留顶层 `bun:` / workspace 包 import** → Node 加载即崩。
 *
 * 所以本脚本对着**真正要发布的那份 `dist/`** 做三件事：
 *
 * | 步骤 | 验证什么 |
 * |---|---|
 * | 产物自检 | 清单字段、`files` 落齐、patch `name` == 包名 == 信封 id、无 workspace 残留 |
 * | **真 Node 装载** | 用**真的 Node**（不是 Bun）在**模拟 profile 的目录**里 import 宿主半 |
 * | 收尾 | 打印发布命令 |
 *
 * ## 🚨 为什么「真 Node」这一步不能省，也不能用 `process.execPath`
 *
 * 实测：`bun run` 下 `process.execPath` **就是 `bun.exe`**。用它起子进程
 * 等于「同一个运行时跑两遍」，两边当然一致 —— 什么都没验证到。
 * 本仓已有 `resolveNodeBin()` 逐个候选**真的执行并检查输出**，
 * 只认报得出 `process.version` 且 `typeof Bun === 'undefined'` 的那个。
 *
 * ## 🚨 为什么要造一个临时目录，而不是就地 import
 *
 * `dist/` 里没有 `node_modules`，就地 import 会直接 `Cannot find package
 * '@deepseek-ai/dsh-session-telemetry'` —— 那是**目录布局问题**，不是产物问题。
 * 真实场景里这份产物躺在 profile 的 `node_modules` 下，靠向上查找拿到
 * DSH 宿主自带的 `@deepseek-ai/*`。所以这里用一个临时目录 + 目录联接
 * （Windows 的 junction，无需管理员）复刻那个布局。
 *
 * 前置条件：本机有真 Node（可用 `ATR_NODE_BIN` 指定）。
 * 用法：`bun run --filter '@ai-token-report/dsh-plugin' verify:npm`
 * 退出码：`0` 全部通过；`1` 任一检查失败。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const distDir = join(pkgRoot, 'dist')

const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}\n`)
  if (!ok) failures.push(name)
}

const nodeBin = resolveNodeBin()
if (!nodeBin) {
  process.stderr.write('❌ 找不到真正的 Node，无法验证发布产物。可用 ATR_NODE_BIN 指定。\n')
  process.exit(1)
}

// ══ 1. 构建发布产物 ═══════════════════════════════════════════════════════
process.stdout.write('\n=== 1. 构建发布产物 ===\n')
const build = Bun.spawnSync([process.execPath, join(pkgRoot, 'scripts', 'build-npm.ts')], {
  stdout: 'pipe',
  stderr: 'pipe',
  env: cleanChildEnv(),
})
if (build.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(build.stderr) + '\n')
  process.exit(1)
}
process.stdout.write(new TextDecoder().decode(build.stdout))

// ══ 2. 清单与挂载声明自检 ═════════════════════════════════════════════════
process.stdout.write('\n=== 2. 清单与挂载声明自检 ===\n')

const manifestPath = join(distDir, 'package.json')
check('dist/package.json 存在', existsSync(manifestPath))
const manifestRaw = await Bun.file(manifestPath).text()
const manifest = JSON.parse(manifestRaw) as {
  name: string
  version: string
  license?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  files: string[]
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: { inject?: string[] } }
}

check('包名是发布名', manifest.name === 'dsh-plugin-token-report', manifest.name)
const sourceManifest = await Bun.file(join(pkgRoot, 'package.json')).json()
check('发布版本与源码清单一致', manifest.version === sourceManifest.version, manifest.version)
const readme = await Bun.file(join(distDir, 'README.md')).text()
const offlineReadme = await Bun.file(join(distDir, 'README.offline.md')).text()
check('发布文档不包含仓内开发章节', !readme.includes('<!-- DEVELOPMENT-DOCS -->') && !readme.includes('## 开发与部署参考'))
const screenshots = [...offlineReadme.matchAll(/!\[([^\]]*)\]\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/g)]
check('离线 README 包含两张真实截图', screenshots.length === 2)
for (const [index, filename] of ['usage-overview.png', 'date-range.png'].entries()) {
  const bytes = Buffer.from(await Bun.file(join(distDir, 'screenshots', filename)).arrayBuffer())
  check(`截图 ${filename} 的 Base64 与随包文件一致`, Buffer.from(screenshots[index]?.[2] ?? '', 'base64').equals(bytes))
  check(`网页截图 ${filename} 使用当前版本链接`, readme.includes(`https://cdn.jsdelivr.net/npm/${manifest.name}@${manifest.version}/screenshots/${filename}`))
}
check('license 已填', manifest.license === 'MIT', String(manifest.license))
check(
  '没有 `dependencies`（workspace 包必须已内联）',
  manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0,
  JSON.stringify(manifest.dependencies ?? {}),
)
// 🚨 这是「同事装不上」的头号原因：workspace:* 在发布时会被改写成
//   指向未发布 private 包的版本号，安装期 404。
check('清单里没有 workspace: 残留', !manifestRaw.includes('workspace:'))

check(
  'files 列出的文件都真的存在',
  manifest.files.every((f) => existsSync(join(distDir, f))),
  manifest.files.filter((f) => !existsSync(join(distDir, f))).join(', ') || '全部就位',
)

// ★★★ 最关键的一条：DSH loader 拿 patch 里的 name 去 import()
const patchPath = join(distDir, 'cordis.patch.yml')
check('dist/cordis.patch.yml 存在', existsSync(patchPath))
const patchText = await Bun.file(patchPath).text()
check(
  'patch 顶层是数组且含 insert（写成映射会让 DSH 起不来）',
  /^\s*-\s*insert:/m.test(patchText) && !/^insert:/.test(patchText),
)
const patchName = patchText.match(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]
check(
  'patch 里的 name == 发布包名（写错就是启动时「找不到模块」）',
  patchName === manifest.name,
  `${patchName} vs ${manifest.name}`,
)
check('patch 里不含 workspace 名', !patchText.includes('@ai-token-report/'))

// 浏览器半信封 id 同样必须等于包名 —— 不一致表现为「面板不见了」，不报错
const clientText = await Bun.file(join(distDir, 'client.js')).text()
const envelopeId = clientText.match(/id:\s*"([^"]+)",/)?.[1]
check(
  '浏览器半信封 id == 发布包名（不一致＝面板静默消失）',
  envelopeId === manifest.name,
  `${envelopeId} vs ${manifest.name}`,
)
check('浏览器半走的是 __ModuleLoader__ 信封', clientText.includes('window.__ModuleLoader__.load('))

const hostText = await Bun.file(join(distDir, 'index.js')).text()
// 🚨 `bun build --target=node` 会把 bun: 说明符原样留在产物顶层，Node 加载即崩，
//   而所有在 Bun 下跑的测试依然全绿。
check('宿主半没有顶层 bun: import', !/^[ \t]*import[^;\n]*from[ \t]*["']bun:/m.test(hostText))
check(
  '宿主半没有残留 workspace 包 import（必须已内联）',
  !/^\s*import[^;\n]*from\s*["']@ai-token-report\//m.test(hostText),
)
check('宿主半导出了默认插件条目', /export\s*\{[^}]*\bas\s+default\b|export\s+default/.test(hostText))

// 发布清单里声明的 patch 路径必须真的指向 dist 里的文件
const declaredPatch = manifest.dsh?.bundle?.patch
check(
  'dsh.bundle.patch 指向存在的文件（缺了 DSH 报 declares no dsh.bundle）',
  typeof declaredPatch === 'string' && existsSync(join(distDir, declaredPatch)),
  String(declaredPatch),
)
check(
  'dsh.client.inject 非空（界面面板要靠它挂载）',
  (manifest.dsh?.client?.inject?.length ?? 0) > 0,
)
check('exports 暴露了 ./client 子路径', './client' in manifest.exports)

// ══ 3. 真 Node 装载（模拟 profile 的目录布局）═════════════════════════════
process.stdout.write('\n=== 3. 真 Node 装载（模拟 profile 布局）===\n')

/**
 * 找出一个**含 `@deepseek-ai/` 完整闭包**的 node_modules 目录。
 *
 * 候选顺序（先到先得，且要求目标包真的存在 —— 不接受悬空路径）：
 * 1. `ATR_DSH_MODULES`：显式覆盖，换机器/换 DSH 安装方式时的逃生门
 * 2. `~/.bun/install/global/node_modules`：本机 DSH 的实际安装位置
 * 3. 本仓 `node_modules`：兜底。⚠️ 真 Node **可能解析不到**（bun 把包放在
 *    `.bun/` 下），届时会如实报「加载失败」而不是静默通过。
 */
function resolveHostModules(): string | null {
  const candidates = [
    process.env['ATR_DSH_MODULES'],
    join(homedir(), '.bun', 'install', 'global', 'node_modules'),
    join(repoRoot, 'node_modules'),
  ]
  for (const dir of candidates) {
    if (!dir) continue
    // ⚠️ 断言到**具体包**，不只看 `@deepseek-ai` 目录在不在：
    //   悬空 junction 也能让 existsSync 对上层目录为真。
    if (existsSync(join(dir, '@deepseek-ai', 'dsh-session-telemetry'))) return dir
  }
  return null
}

const sandbox = mkdtempSync(join(tmpdir(), 'atr-plugin-pkg-'))
try {
  cpSync(distDir, sandbox, { recursive: true })

  // ⚠️ 必须连**宿主真正的模块树**，而不是本仓的 `node_modules`。
  //   实测：本仓的 `@deepseek-ai/*` 由 bun 放在 `node_modules/.bun/...` 下，
  //   **只有 Bun 的解析器看得见**，真 Node 从 `node_modules/@deepseek-ai` 找不到 ——
  //   连它会建出一个**悬空 junction**，然后把「环境布局不对」误报成「产物加载失败」。
  //   全局安装的那棵树才是宿主：DSH 就是从那里加载插件依赖的，闭包完整。
  const hostModules = resolveHostModules()
  check(
    '找得到宿主模块树（@deepseek-ai/* 的完整闭包）',
    hostModules !== null,
    hostModules ?? '可用 ATR_DSH_MODULES 指定一个含 @deepseek-ai/ 的 node_modules 目录',
  )
  if (hostModules === null) throw new Error('缺少宿主模块树，无法做真 Node 装载验证')

  // 复刻「插件装在 profile 的 node_modules 下、@deepseek-ai/* 由宿主提供」的布局。
  // ⚠️ junction 而不是 symlink：Windows 上建目录符号链接需要管理员权限。
  mkdirSync(join(sandbox, 'node_modules'), { recursive: true })
  symlinkSync(
    join(hostModules, '@deepseek-ai'),
    join(sandbox, 'node_modules', '@deepseek-ai'),
    'junction',
  )
  check(
    'junction 指向真实存在的包（悬空 junction 会伪装成产物故障）',
    existsSync(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-session-telemetry')),
  )
  process.stdout.write(`  ℹ️ 宿主模块树：${hostModules}\n`)

  const probe = `
    const mod = await import(${JSON.stringify('file:///' + join(sandbox, 'index.js').replace(/\\/g, '/'))})
    const d = mod.default
    console.log(JSON.stringify({
      name: d?.name,
      hasApply: typeof d?.apply === 'function',
      injectOnDefault: Array.isArray(d?.inject),
      hasQueryUsage: typeof mod.queryUsage === 'function',
      node: process.version,
      isBun: typeof Bun !== 'undefined',
    }))
  `
  const run = Bun.spawnSync([nodeBin, '--input-type=module', '-e', probe], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: sandbox,
    env: cleanChildEnv(),
  })
  const stdout = new TextDecoder().decode(run.stdout).trim()
  const stderr = new TextDecoder().decode(run.stderr).trim()
  if (run.exitCode !== 0) {
    check('真 Node 能加载发布产物', false, stderr.split('\n').slice(0, 4).join(' / '))
  } else {
    const info = JSON.parse(stdout.split('\n').pop() ?? '{}') as Record<string, unknown>
    check('真 Node 能加载发布产物', true, `node ${info['node']}`)
    check('确认加载它的是 Node 而不是 Bun', info['isBun'] === false)
    check('导出 name == "token-report"', info['name'] === 'token-report', String(info['name']))
    check('默认导出带 apply()', info['hasApply'] === true)
    // 🚨 inject 必须在**默认导出**上：写在类上会静默失效（类根本不会被实例化）
    check('inject 挂在默认导出上', info['injectOnDefault'] === true)
    check('导出 queryUsage()（供服务/工具复用）', info['hasQueryUsage'] === true)
  }

  // 让「双份实例」这件事可观测：宿主那份 telemetry 与产物解析到的是否同一路径。
  // ⚠️ 这里只报告不断言 —— 真实安装布局由 DSH 决定，本脚本不替它做判断。
  const resolved = Bun.spawnSync(
    [
      nodeBin,
      '--input-type=module',
      '-e',
      `console.log(import.meta.resolve('@deepseek-ai/dsh-session-telemetry'))`,
    ],
    { stdout: 'pipe', stderr: 'pipe', cwd: sandbox, env: cleanChildEnv() },
  )
  if (resolved.exitCode === 0) {
    process.stdout.write(
      `  ℹ️ 产物解析到的 telemetry：${new TextDecoder().decode(resolved.stdout).trim()}\n` +
        '     （与 DSH 宿主实际加载的那份比对一下：两份实例不会报错，但会让诊断变难）\n',
    )
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// ══ 汇总 ═════════════════════════════════════════════════════════════════
process.stdout.write('\n' + '='.repeat(72) + '\n')
if (failures.length === 0) {
  process.stdout.write('✅ 发布产物验证全部通过\n')
  process.stdout.write(`   发布：npm publish ${distDir}\n`)
} else {
  process.stdout.write(`❌ ${failures.length} 项失败：\n`)
  for (const f of failures) process.stdout.write(`   - ${f}\n`)
}
process.stdout.write('='.repeat(72) + '\n')
if (failures.length > 0) process.exitCode = 1
