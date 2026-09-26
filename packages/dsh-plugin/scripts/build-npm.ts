/**
 * 把 DSH 插件打包成**可发布到 npm 的独立包**（`dsh-plugin-token-report`）。
 *
 * ## 产物形态
 *
 * ```
 * packages/dsh-plugin/dist/
 *   package.json      ← 发布用清单（名字是 dsh-plugin-token-report，不是 workspace 名）
 *   index.js          ← 宿主半（Node 跑，DSH 进程内）
 *   client.js         ← 浏览器半（`__ModuleLoader__` 信封）
 *   cordis.patch.yml  ← 挂载声明（`name` 必须是发布名）
 *   README.md
 * ```
 *
 * 发布：仓库根目录 `bun run publish:plugin`（强制完整验证）
 *
 * ## 为什么是「打包 + 独立清单」而不是直接发布 workspace 包
 *
 * 与 `packages/cli/scripts/build-npm.ts` 同源，三条理由：
 *
 * 1. **workspace 包发不出去**：`packages/dsh-plugin` 是 `private: true`，
 *    依赖写的是 `workspace:*`。npm 不允许「包名 ≠ manifest name」，
 *    所以想发成 `dsh-plugin-token-report` 就只能另写一份清单 ——
 *    这也正好**避免了一次全仓改名**（`@ai-token-report/*` 有 100+ 处引用）。
 * 2. **`@ai-token-report/{core,shared}` 是 private、从未发布**：
 *    直接发 workspace 包会让 `workspace:*` 被改写成指向未发布包的版本号，
 *    同事 `dsh plugin add` 时拉到 404。独立清单里**没有任何 dependencies**
 *    （它们已被 `bun build` 内联），装完即可用。
 * 3. **发布名与 dev 名不同是常态**：仓库里叫 `@ai-token-report/dsh-plugin`
 *    （`tsconfig` paths、workspace 解析都依赖它），npm 上叫
 *    `dsh-plugin-token-report`。两者的映射只在**本脚本**这一处发生。
 *
 * ## 🚨 三条硬约束（写错了同事那边是「装上了但不生效」）
 *
 * 1. **`cordis.patch.yml` 里的 `name` 必须是发布名**。DSH loader 拿这个字符串
 *    去 `import()` —— 写成 workspace 名就是启动时「找不到模块」。
 *    所以这个文件**不能从仓库原样拷**，必须生成。
 * 2. **浏览器半信封里的 `id` 也必须是发布名**。DSH 客户端模块图按包名解析，
 *    id 对不上表现为「面板不见了」。`build-client.ts` 用的是 workspace 名
 *    （开发直挂时是对的），这里改写一次。
 * 3. **宿主半不能出现顶层 `bun:` import**。`--target=node` 会把它原样留在
 *    产物顶层，Node 加载即崩。兜底断言见下面第 3 步。
 *
 * 用法：`bun run --filter '@ai-token-report/dsh-plugin' build:npm`
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const libDir = join(pkgRoot, 'lib')
const distDir = join(pkgRoot, 'dist')

/** 发布用的包名。与 workspace 内的 `@ai-token-report/dsh-plugin` 是两回事。 */
const PUBLISH_NAME = 'dsh-plugin-token-report'
/** 开发/直挂时用的 workspace 名 —— 浏览器半信封里现在写的是它。 */
const WORKSPACE_NAME = '@ai-token-report/dsh-plugin'
// 发布版本只读包清单，避免源码与发布产物的版本漂移。
const VERSION = (await Bun.file(join(pkgRoot, 'package.json')).json()).version as string

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`)
  process.exit(1)
}

// ── 1. 清空并重建产物目录 ────────────────────────────────────────────────
await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

// ── 2. 跑正常的双半构建（宿主半 + 浏览器半）──────────────────────────────
// 刻意复用 package.json 的 `build`：构建参数只有一处真源，
// 不在这里重复一遍 `--target` / `--external`，否则两边必然漂移。
const build = Bun.spawnSync([process.execPath, 'run', 'build'], {
  cwd: pkgRoot,
  stdout: 'pipe',
  stderr: 'pipe',
})
if (build.exitCode !== 0) {
  fail(`构建失败：\n${new TextDecoder().decode(build.stderr)}`)
}

const hostIn = join(libDir, 'index.js')
const clientIn = join(libDir, 'client.js')
if (!existsSync(hostIn)) fail(`缺少宿主半产物：${hostIn}`)
if (!existsSync(clientIn)) fail(`缺少浏览器半产物：${clientIn}`)

let hostText = await Bun.file(hostIn).text()

// ── 3. 兜底断言：宿主半不能有顶层 bun: import ────────────────────────────
// 🚨 与 CLI 同款的坑：`core/db` 若绕过 `driver.ts` 直接 import 'bun:sqlite'，
//   `bun build --target=node` 会把它留在产物顶层，Node（DSH 宿主）加载即崩，
//   而**所有在 Bun 下跑的测试依然全绿**。
if (/^[ \t]*import[^;\n]*from[ \t]*["']bun:/m.test(hostText)) {
  fail('产物里出现了顶层 bun: import —— Node 会加载失败。检查 core/db 是否绕过了 driver.ts')
}

// ── 4. 兜底断言：workspace 包必须已被内联 ───────────────────────────────
// 一旦有人给 build 加了 `--external '@ai-token-report/*'`，产物会留下
// 对 private 包的真实 import —— 发布出去就是「装得上、Node 解析不到」。
// 这里断言它们**不以静态 import 的形式出现**，把那条铁律钉在构建期。
const leaked = [...hostText.matchAll(/^\s*import[^;\n]*from\s*["'](@ai-token-report\/[^"']+)["']/gm)]
  .map((m) => m[1])
if (leaked.length > 0) {
  fail(
    `宿主半还在 import workspace 包（${[...new Set(leaked)].join(', ')}）—— ` +
      '构建时不要 external `@ai-token-report/*`，它们必须被内联。',
  )
}

await writeFile(join(distDir, 'index.js'), hostText, 'utf8')
// 与主入口同版本发布；线程内部已内联 core/shared，不依赖 workspace 包。
await cp(join(libDir, 'stats-worker.js'), join(distDir, 'stats-worker.js'))

// ── 5. 浏览器半：把信封 id 改成发布名 ───────────────────────────────────
let clientText = await Bun.file(clientIn).text()
const clientIdPattern = /id:\s*"([^"]+)",/
const clientIdMatch = clientText.match(clientIdPattern)
if (!clientIdMatch) {
  fail('浏览器半里找不到 `id: "..."` 信封字段 —— build-client.ts 的信封格式变了？')
}
const currentId = clientIdMatch[1]
if (currentId === PUBLISH_NAME) {
  // 已经是对的（例如 build-client.ts 将来直接支持发布名），无需改写
} else if (currentId === WORKSPACE_NAME) {
  // ⚠️ 只替换信封里那一个 id，不做全文替换：产物里可能还有别处出现包名
  //    （例如报错文案），误伤会让排查信息变味。
  clientText = clientText.replace(clientIdPattern, `id: "${PUBLISH_NAME}",`)
} else {
  fail(
    `浏览器半信封 id 是 ${JSON.stringify(currentId)}，既不是 workspace 名 ` +
      `(${WORKSPACE_NAME}) 也不是发布名 (${PUBLISH_NAME}) —— 请确认后更新本脚本。`,
  )
}
await writeFile(join(distDir, 'client.js'), clientText, 'utf8')

// 离线修复必须能在 DSH 启动前执行，只依赖宿主已有的 YAML/配置模块。
const repair = await Bun.build({
  entrypoints: [join(pkgRoot, 'scripts', 'repair-profile.ts')],
  target: 'node', format: 'esm', outdir: distDir,
  naming: 'repair-profile.mjs',
})
if (!repair.success) fail(`修复工具构建失败：${repair.logs.join('\n')}`)

// ── 6. 生成挂载声明（name 必须是发布名，见文件头约束 1）────────────────
const patch = `# 本文件由 scripts/build-npm.ts 生成 —— 不要手改（改仓库根那份 cordis.patch.yml）。
#
# 与仓库里那份的唯一区别：\`name\` 是**发布名**。
# DSH loader 拿这个字符串去 import()，所以它必须等于 npm 包名本身。
- insert:
    - id: token-report
      name: '${PUBLISH_NAME}'
`
await writeFile(join(distDir, 'cordis.patch.yml'), patch, 'utf8')

// ── 7. 写发布用的 package.json ──────────────────────────────────────────
const manifest = {
  name: PUBLISH_NAME,
  version: VERSION,
  description:
    'DSH 插件：无人值守地把 token 用量实时上报到部门服务端，另提供 token_usage 工具、ctx.tokenReport 服务与界面用量面板。',
  type: 'module',
  main: 'index.js',
  exports: {
    '.': { default: './index.js' },
    './client': { default: './client.js' },
    './package.json': './package.json',
  },
  files: ['index.js', 'stats-worker.js', 'client.js', 'repair-profile.mjs', 'cordis.patch.yml', 'README.md', 'README.offline.md', 'screenshots'],
  bin: { 'dsh-token-report-repair': './repair-profile.mjs' },
  // ★ 这两段是「能被 DSH 认成插件」的全部声明：bundle 决定配置树里有这一行，
  //   client 决定浏览器半挂到哪个平台、依赖哪个第一方客户端包。
  dsh: {
    bundle: {
      patch: './cordis.patch.yml',
    },
    client: {
      platform: 'web',
      inject: ['@deepseek-ai/dsh-client-ui-conversation'],
    },
  },
  // ⚠️ node 下限由 core 的原生能力决定：`node:zlib` 的 zstd 需要 ≥22.15，
  //   `core/db` 的 Node 驱动 `node:sqlite` 需要 ≥22.5（`localDb` 才走得到）。
  engines: {
    node: '>=22.15.0',
    bun: '>=1.1.0',
  },
  keywords: ['dsh', 'deepseek', 'token', 'usage', 'plugin', 'telemetry'],
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'git+https://github.com/zhujunzhujunzhu/ai-token-report.git',
  },
  homepage: 'https://github.com/zhujunzhujunzhu/ai-token-report#readme',
  publishConfig: { access: 'public' },
  // 运行时只需要 DSH 宿主自带的那几个 —— 它们由 profile 提供。
  // ⚠️ 一律不写 `dependencies`：`@ai-token-report/*` 已内联，
  //   写进去只会让同事装到指向未发布包的 404。
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-session-telemetry': '^0.1.5-rc.1',
    // ⚠️ 范围刻意收在 0.1.5 谱系：公网 `latest` 是 0.0.1-rc.1（API 不兼容的旧版），
    //   而 `^0.1.5-rc.1` 按 semver 的预发布规则**只**匹配 0.1.5-*，天然躲开它。
    '@deepseek-ai/dsh-agent': '^0.1.5-rc.1',
    '@deepseek-ai/dsh-session': '^0.1.5-rc.1',
  },
  peerDependenciesMeta: {
    '@deepseek-ai/dsh-agent': { optional: true },
    '@deepseek-ai/dsh-session': { optional: true },
  },
}
await writeFile(join(distDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// ── 8. 从同一份文档生成网页与离线版，截图随包发布，不依赖源码先推送 ──────
// npm 的 Markdown 清洗器可能过滤 data: URL，因此首页使用固定版本 CDN，
// 单文件离线版才内嵌 Base64。源文件仍用相对路径，便于仓内预览与审查。
const readmeSource = await Bun.file(join(pkgRoot, 'README.md')).text()
const publicReadme = readmeSource.split('<!-- DEVELOPMENT-DOCS -->')[0]!.trim()
const screenshotDir = join(distDir, 'screenshots')
await mkdir(screenshotDir, { recursive: true })
let onlineReadme = publicReadme
let offlineReadme = publicReadme
for (const match of publicReadme.matchAll(/!\[([^\]]*)\]\(docs\/screenshots\/([a-z0-9-]+\.png)\)/g)) {
  const [markdown, alt, filename] = match
  const source = join(pkgRoot, 'docs', 'screenshots', filename!)
  const bytes = Buffer.from(await Bun.file(source).arrayBuffer())
  await cp(source, join(screenshotDir, filename!))
  onlineReadme = onlineReadme.replace(markdown, `![${alt}](https://cdn.jsdelivr.net/npm/${PUBLISH_NAME}@${VERSION}/screenshots/${filename})`)
  offlineReadme = offlineReadme.replace(markdown, `![${alt}](data:image/png;base64,${bytes.toString('base64')})`)
}
await writeFile(join(distDir, 'README.md'), onlineReadme + `\n\n单文件离线版（截图以 Base64 内嵌）：[README.offline.md](https://cdn.jsdelivr.net/npm/${PUBLISH_NAME}@${VERSION}/README.offline.md)。\n`, 'utf8')
await writeFile(join(distDir, 'README.offline.md'), offlineReadme + '\n', 'utf8')

// ── 9. 报告产物 ─────────────────────────────────────────────────────────
const hostSize = (await Bun.file(join(distDir, 'index.js')).arrayBuffer()).byteLength
const clientSize = (await Bun.file(join(distDir, 'client.js')).arrayBuffer()).byteLength
const files = await readdir(distDir, { recursive: true })
process.stdout.write(
  `✅ 已生成 ${PUBLISH_NAME}@${VERSION}\n` +
    `   目录    ${distDir}\n` +
    `   宿主半  index.js（${(hostSize / 1024).toFixed(1)} KB，零运行时依赖）\n` +
    `   浏览器半 client.js（${(clientSize / 1024).toFixed(1)} KB，id 已改为发布名）\n` +
    `   文件数  ${files.length}\n` +
    `   发布    bun run publish:plugin（完整验证后发布）\n`,
)
