/**
 * 双驱动对照的**调度器** —— 把 `verify-driver-parity.ts` 分别丢给 Node 与 Bun 跑，
 * 再逐行比对两边的输出。
 *
 * ## 为什么需要调度器而不是一个普通脚本
 *
 * 要验证「同一份 `core/db` 在 Node 与 Bun 下结果一致」，就必须**真的换运行时执行**。
 * 单个进程只能是一个运行时，所以这里：
 *
 * 1. `bun build --target=node` 把验证脚本打成一份 Node 产物（workspace 依赖会被内联）
 * 2. 用 `node` 跑一遍 → 走 `node:sqlite`
 * 3. 用 `bun` 跑**同一份产物** → 走 `bun:sqlite`
 * 4. 剔除 `runtime=` 行后逐行 diff，**任何一行不同即失败**
 *
 * ⚠️ 第 3 步刻意复用同一份打包产物而不是直接跑 TS 源码：
 *   产物才是真正要发布给用户的东西，源码跑得通不代表打包后跑得通
 *   （`bun:sqlite` 被提到产物顶层就是只在产物里才会暴露的坑）。
 *
 * ## 🚨 本脚本踩过的一个坑：`bun run` 下 spawn 的 `node` 其实是 Bun
 *
 * 实测（Bun 1.4.2 / Windows）：`bun run <file>` 里执行
 * `Bun.spawnSync(['node', ...])`，**子进程是 Bun 而不是 Node**
 * （子进程里 `Bun.version` 有值、`driver` 报 `bun:sqlite`）；
 * 但同样一行代码写在 `bun <file>` 里执行时又是正确的 Node。
 *
 * 后果非常隐蔽：两侧其实跑的是同一个运行时，「输出一致」当然成立，
 * 对照验证**静默失效**却仍然报成功。
 *
 * 所以本脚本做了两件事，缺一不可：
 *
 * - **逐个探测**候选可执行文件，只认「真的能报出 `process.version`
 *   且 `typeof Bun === 'undefined'`」的那个当 Node（见 `lib/runtime.ts`）
 * - 跑完再**断言两侧的 `driver=` 确实是 `node:sqlite` / `bun:sqlite`**
 *   （见 {@link assertDriver}）—— 探测失效时至少会失败，而不是假装通过
 *
 * 用法：`bun run packages/core/verify/run-driver-parity.ts`
 * 退出码：`0` 两边一致；`1` 任一侧失败、驱动不对、或两侧输出不同。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { cleanChildEnv, resolveNodeBin } from './lib/runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, 'verify-driver-parity.ts')

/** 跑一个命令并连输出一起收回来。 */
function run(cmd: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', env: cleanChildEnv() })
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
  return { code: proc.exitCode, out }
}

const nodeBin = resolveNodeBin()
if (!nodeBin) {
  process.stderr.write(
    '❌ 找不到真正的 Node 可执行文件，无法做双驱动对照。\n' +
      '   可用环境变量 ATR_NODE_BIN 显式指定，例如：\n' +
      '   $env:ATR_NODE_BIN="C:\\Program Files\\nodejs\\node.exe"\n',
  )
  process.exit(1)
}

const bunBin = process.execPath // 当前正在跑的就是 Bun，最可靠
const workDir = mkdtempSync(join(tmpdir(), 'driver-parity-build-'))
const bundlePath = join(workDir, 'parity.js')

// 临时目录里放一个 `{"type":"module"}`：否则 Node 会因为「无 package.json、
// 但内容是 ESM」打一行 MODULE_TYPELESS_PACKAGE_JSON 警告到 stderr，
// 混进输出里干扰比对，还要多付一次「重新按 ESM 解析」的开销。
await Bun.write(join(workDir, 'package.json'), JSON.stringify({ type: 'module' }))

// ── 1. 打成 Node 产物 ────────────────────────────────────────────────────
const build = run([bunBin, 'build', entry, '--target=node', `--outfile=${bundlePath}`])
if (build.code !== 0) {
  process.stderr.write(`❌ 打包失败：\n${build.out}\n`)
  rmSync(workDir, { recursive: true, force: true })
  process.exit(1)
}

// 🚨 产物里**不允许**出现顶层 `import ... from "bun:sqlite"` ——
//   那会让 Node 用户在 import 阶段直接崩，而且报错完全指不到这里。
//   ⚠️ 检查的是**产物内容**，不是打包日志。
const bundleText = await Bun.file(bundlePath).text()
if (/^[ \t]*import[^;\n]*from[ \t]*["']bun:/m.test(bundleText)) {
  process.stderr.write('❌ 产物里出现了顶层 bun: import，Node 会加载失败\n')
  rmSync(workDir, { recursive: true, force: true })
  process.exit(1)
}

// ── 2. 两侧各跑一遍 ──────────────────────────────────────────────────────
const nodeRun = run([nodeBin, bundlePath])
const bunRun = run([bunBin, bundlePath])

/**
 * 剔除随运行时变化的行，只保留可比对的部分。
 *
 * `runtime=` 与 `driver=` 两侧**本来就该不同**（这正是「换了运行时」的证据），
 * 它们各自由 {@link runtimeOf} 展示、由 {@link assertDriver} 断言，
 * 因此不参与逐行比对。
 */
function comparable(out: string): string[] {
  return out
    .split('\n')
    .filter(
      (l) =>
        l.trim() !== '' && !l.startsWith('runtime=') && !l.startsWith('driver='),
    )
    .map((l) => l.trim())
}

/** 取出 `runtime=` 原文，用于在标题里**显式**证明这一侧真的换了运行时。 */
function runtimeOf(out: string): string {
  const line = out.split('\n').find((l) => l.startsWith('runtime='))
  return line ? line.trim() : '(未报告 runtime —— 可能根本没跑起来)'
}

const nodeLines = comparable(nodeRun.out)
const bunLines = comparable(bunRun.out)

process.stdout.write(`─── Node 侧（应为 node:sqlite） ${runtimeOf(nodeRun.out)} ───\n`)
process.stdout.write(nodeLines.join('\n') + '\n\n')
process.stdout.write(`─── Bun 侧（应为 bun:sqlite） ${runtimeOf(bunRun.out)} ───\n`)
process.stdout.write(bunLines.join('\n') + '\n\n')

rmSync(workDir, { recursive: true, force: true })

let failed = false

if (nodeRun.code !== 0) {
  process.stderr.write('❌ Node 侧未通过\n')
  failed = true
}
if (bunRun.code !== 0) {
  process.stderr.write('❌ Bun 侧未通过\n')
  failed = true
}

/**
 * 断言某一侧真的用了预期驱动。
 *
 * 🚨 这一步不是「锦上添花」：没有它，两侧跑成同一个运行时时
 *   「输出一致」照样成立，验证会静默失效并假报成功。
 */
function assertDriver(label: string, out: string, expected: string): boolean {
  const actual = out.split('\n').find((l) => l.startsWith('driver='))?.trim()
  if (actual === `driver=${expected}`) return true
  process.stderr.write(
    `❌ ${label} 侧驱动不对：期望 driver=${expected}，实到 ${actual ?? '(缺)'}\n`,
  )
  return false
}

if (!assertDriver('Node', nodeRun.out, 'node:sqlite')) failed = true
if (!assertDriver('Bun', bunRun.out, 'bun:sqlite')) failed = true

// 逐行比对：行序也必须一致（输出顺序是固定的，顺序不同本身就是信号）
const max = Math.max(nodeLines.length, bunLines.length)
for (let i = 0; i < max; i++) {
  if (nodeLines[i] !== bunLines[i]) {
    process.stderr.write(
      `❌ 第 ${i + 1} 行不一致：\n  node: ${nodeLines[i] ?? '(缺)'}\n  bun : ${bunLines[i] ?? '(缺)'}\n`,
    )
    failed = true
  }
}

if (failed) {
  process.stderr.write('\n❌ 双驱动对照失败\n')
  process.exit(1)
}

process.stdout.write('✅ 双驱动对照通过：Node(node:sqlite) 与 Bun(bun:sqlite) 输出逐行一致\n')
