/**
 * 把 CLI 打包成**可发布到 npm 的独立包**（`dsh-token-report`）。
 *
 * ## 产物形态
 *
 * ```
 * packages/cli/dist/
 *   package.json      ← 发布用的清单（名字是 dsh-token-report，不是 workspace 名）
 *   cli.js            ← 单文件产物，零运行时依赖
 *   web-local/        ← 本地页面的静态资源（内嵌，`web` 子命令要用）
 *   README.md
 * ```
 *
 * 发布：`npm publish packages/cli/dist`
 *
 * ## 为什么是「打包 + 独立清单」而不是直接发布 workspace 包
 *
 * - workspace 里的包名是 `@ai-token-report/cli` 且 `private: true`，
 *   依赖写的是 `workspace:*` —— 这些包**都是 private、发不出去**，
 *   所以发布物不能带任何 `dependencies`。
 * - `bun build` 把 `@ai-token-report/{core,shared,server}` 全部**内联**进
 *   `cli.js`，产物的 `dependencies` 因此是空的，用户装完就能跑。
 *
 * ## 两条硬约束（写错了 Node 用户直接起不来）
 *
 * 1. 🚨 `--target=node`：产物必须能跑在 Node 上。Bun 专有模块
 *    （`bun:sqlite`）由 `core/db/driver.ts` 在**运行期**按需加载，
 *    不能出现在产物顶层的 import 里 —— 见下面的兜底断言。
 * 2. 🚨 shebang 必须改成 `#!/usr/bin/env node`：源文件写的是 `bun`，
 *    直接发出去的话 Node 用户执行时会去找 bun，找不到就报
 *    `env: bun: No such file or directory`。
 *
 * 用法：`bun run --filter '@ai-token-report/cli' build:npm`
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..') // packages/cli
const repoRoot = resolve(pkgRoot, '..', '..')
const distDir = join(pkgRoot, 'dist')
const entry = join(pkgRoot, 'src', 'cli.ts')
const webDist = join(repoRoot, 'packages', 'web-local', 'dist')

/** 发布用的包名。与 workspace 内的 `@ai-token-report/cli` 是两回事。 */
const PUBLISH_NAME = 'dsh-token-report'

/**
 * 版本号**从 workspace 包的 `package.json` 读**，不在这里写死。
 *
 * ⚠️ 写死过一次的教训：发第二个版本时很容易只改一处，
 *   于是产物里的版本与仓库里的版本不一致 —— 而 npm **不允许重复发布同一个版本号**，
 *   表现是「明明改了版本却报 `cannot publish over previously published version`」，
 *   排查方向完全指不到这个文件。所以只留一个真源。
 */
const workspaceManifest = (await Bun.file(join(pkgRoot, 'package.json')).json()) as {
  version: string
}
const VERSION = workspaceManifest.version

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`)
  process.exit(1)
}

// ── 1. 清空并重建产物目录 ────────────────────────────────────────────────
await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

// ── 2. 打包成单文件 ──────────────────────────────────────────────────────
// `--target=node` 让产物同时能跑在 Node 与 Bun 上（Bun 是 Node 的超集）。
const build = Bun.spawnSync(
  [process.execPath, 'build', entry, '--target=node', `--outfile=${join(distDir, 'cli.js')}`],
  { stdout: 'pipe', stderr: 'pipe' },
)
if (build.exitCode !== 0) {
  fail(`打包失败：\n${new TextDecoder().decode(build.stderr)}`)
}

const cliPath = join(distDir, 'cli.js')
let cliText = await Bun.file(cliPath).text()

// ── 3. 兜底断言：产物里不能有顶层 bun: import ────────────────────────────
// 🚨 这条一旦破掉，Node 用户在 `import` 阶段就崩，且报错完全指不到这里。
//   实测过：`core/db` 若直接 `import ... from 'bun:sqlite'`，
//   `bun build --target=node` 会原样把这一行留在产物顶层。
if (/^[ \t]*import[^;\n]*from[ \t]*["']bun:/m.test(cliText)) {
  fail('产物里出现了顶层 bun: import —— Node 会加载失败。检查 core/db 是否绕过了 driver.ts')
}

// ── 4. shebang 改成 node ────────────────────────────────────────────────
const shebangEnd = cliText.indexOf('\n')
const firstLine = cliText.slice(0, shebangEnd)
if (!firstLine.startsWith('#!')) {
  fail(`产物没有 shebang（首行是 ${JSON.stringify(firstLine)}），npm 的 bin 会执行失败`)
}
cliText = '#!/usr/bin/env node' + cliText.slice(shebangEnd)
await writeFile(cliPath, cliText, 'utf8')

// ── 5. 内嵌 web-local 静态资源 ──────────────────────────────────────────
if (!existsSync(join(webDist, 'index.html'))) {
  fail(
    `找不到本地页面构建产物：${webDist}\n` +
      `  请先在仓库根执行 \`bun run build:local\`，再打包。`,
  )
}
await cp(webDist, join(distDir, 'web-local'), { recursive: true })

// ── 6. 写发布用的 package.json ──────────────────────────────────────────
const manifest = {
  name: PUBLISH_NAME,
  version: VERSION,
  description:
    'DSH token 用量统计 CLI：读本地会话日志，输出按厂商/模型/项目/会话/时间的用量报表，支持本地页面与增量上报。支持 Node 与 Bun。',
  type: 'module',
  bin: {
    [PUBLISH_NAME]: 'cli.js',
    // 沿用仓库里既有的短命令名。npm 上的 `dsh-token` 包只是占名、**没有 bin**，
    // 因此这里不会和任何已发布的可执行文件冲突。
    'dsh-token': 'cli.js',
  },
  main: 'cli.js',
  exports: {
    '.': './cli.js',
    './package.json': './package.json',
  },
  // ⚠️ 这里**不写** `cli.js`：`bin` 的目标文件会被打包器自动带上，
  //   列在这里是多余的（`npm pack` 确认最终仍是 6 个文件）。
  //
  //   📌 已知无害瑕疵：因为下面声明了**两个** bin（`dsh-token-report` + `dsh-token`）
  //   都指向同一个 `cli.js`，**`bun pm pack` / `bun publish` 会把它打包两次**
  //   （7 个条目 / 113 KB；`npm pack` 则是 6 个 / 80.7 KB）。
  //   两条 tar 条目路径相同，解包时后者覆盖前者，安装与执行都不受影响 ——
  //   只是白白多占约 40 KB。不要为此把短名 bin 删掉，那是拿可用性换体积。
  files: ['web-local/', 'README.md'],
  // ⚠️ node 下限由两个原生能力决定：
  //   `node:sqlite` 需要 ≥22.5，`node:zlib` 的 zstd 需要 ≥22.15。
  engines: {
    node: '>=22.15.0',
    bun: '>=1.1.0',
  },
  keywords: ['dsh', 'deepseek', 'token', 'usage', 'statistics', 'cli', 'sqlite'],
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'git+https://github.com/zhujunzhujunzhu/ai-token-report.git',
  },
  homepage: 'https://github.com/zhujunzhujunzhu/ai-token-report#readme',
  publishConfig: { access: 'public' },
}
await writeFile(join(distDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// ── 7. 带上 README ──────────────────────────────────────────────────────
const readme = join(pkgRoot, 'README.md')
const rootReadme = join(repoRoot, 'README.md')
const readmeSource = existsSync(readme) ? readme : existsSync(rootReadme) ? rootReadme : null
if (readmeSource) {
  await cp(readmeSource, join(distDir, 'README.md'))
}

// ── 8. 报告产物 ─────────────────────────────────────────────────────────
const files = await readdir(distDir, { recursive: true })
const size = (await Bun.file(cliPath).arrayBuffer()).byteLength
process.stdout.write(
  `✅ 已生成 ${PUBLISH_NAME}@${VERSION}\n` +
    `   目录    ${distDir}\n` +
    `   入口    cli.js（${(size / 1024).toFixed(1)} KB，零运行时依赖）\n` +
    `   资源    web-local/（内嵌本地页面）\n` +
    `   文件数  ${files.length}\n` +
    `   发布    npm publish ${distDir}\n`,
)
