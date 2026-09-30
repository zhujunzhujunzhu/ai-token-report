#!/usr/bin/env bun
/**
 * 一次性数据目录搬家：`<dshHome>/token-report` → `~/.ai-token-report`。
 *
 * ## 为什么需要它
 *
 * `dataDir` 的缺省值从「跟着 `dshHome` 走」改成了固定的家目录路径
 * （理由见 `packages/core/src/home.ts` 文件头：DSH Desktop 与命令行版各有
 * 自己的 home，跟着 dshHome 会让同一个人在两套 DSH 里各存一份身份与本地库）。
 *
 * 🚨 **旧目录不会自动迁移**：新默认值指向一个**空目录**，于是升级后的第一感觉是
 *   「我的署名没了、历史用量也没了」—— 而实际上数据一直在旧目录里躺着。
 *   数据目录是长期状态，搬家必须是**显式**的一次性操作，这就是本脚本。
 *
 * ## 用法
 *
 * ```bash
 * # 1. 先干跑：只列出将要移动的条目，一个字节都不动
 * bun run scripts/migrate-data-dir.ts
 *
 * # 2. 停掉所有 DSH / 服务端进程（SQLite 被占用时 Windows 上 rename 会失败）
 *
 * # 3. 真正搬家
 * bun run scripts/migrate-data-dir.ts --apply
 * ```
 *
 * 源目录取 `--from` / `DSH_HOME` 推导的 `<dshHome>/token-report`；
 * 目标取 `--to` / `DSH_TOKEN_REPORT_DATA_DIR` / `~/.ai-token-report`。
 *
 * ## 它刻意不做什么
 *
 * - **不合并**：目标目录已存在且非空时直接拒绝（`--merge` 才逐条搬、同名跳过并
 *   报告）。两个目录各有一份 `identity.json` 时，「合并」等于替使用者猜哪份是真的。
 * - **不删除任何东西**：搬完只留下空目录，需要时自己 `rmdir`。
 * - **不碰本地库的 schema**：只是移动文件，`portal.sqlite` / `usage.sqlite`
 *   的版本与内容一个字节都不改。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { DATA_DIR_NAME, expandHomePath } from '../packages/core/src/home.js'

/**
 * 表驱动解析：只认带值的 `--key value`，未知参数一律报错（不静默忽略）。
 *
 * ⚠️ 先把 `argv` 收成一张表再取用：直接在 `flagOf()` 里扫 `process.argv` 的话，
 *   `--apply` 这类**开关**会被误判成「缺少值」（它后面正好跟着另一个 `--xxx`）。
 */
function parseArgs(argv: string[]): { flags: Map<string, string>; apply: boolean; merge: boolean } {
  const flags = new Map<string, string>()
  let apply = false
  let merge = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--merge') { merge = true; continue }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}（只支持 --from/--to/--apply/--merge）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`)
    flags.set(arg.slice(2), value)
    index += 1
  }
  return { flags, apply, merge }
}

const { flags, apply, merge } = parseArgs(process.argv.slice(2))

/**
 * ⚠️ 刻意**不用** `resolveDshHome()`：它现在会**自动发现**本机全部 DSH home 并取
 *   排序第一个，而本脚本的语义是「跟着 `--from` / `$DSH_HOME` 走」的那个**旧位置**。
 *   `DSH_HOME` 指向 Desktop 而 `~/.dsh` 也存在时，自动发现会把源目录悄悄换成另一个 ——
 *   表现为「源目录不存在」（数据其实还在原处）或搬错一份数据。
 */
const from = flags.get('from')?.trim()
const dshHome = from
  ? resolve(expandHomePath(from))
  : resolve(process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh'))
/** 缺省就是「跟着 dshHome 走」的那个旧位置 —— 这正是本次要搬离的目录。 */
const source = resolve(join(dshHome, 'token-report'))
const target = resolve(flags.get('to') ?? process.env['DSH_TOKEN_REPORT_DATA_DIR']?.trim() ?? join(homedir(), DATA_DIR_NAME))

if (source === target) throw new Error('源目录与目标目录是同一个：不需要搬家')
if (target.startsWith(source + '\\') || target.startsWith(source + '/')) throw new Error('目标目录在源目录内部：请换个目标')

if (!existsSync(source)) {
  console.log(`源目录不存在：${source}`)
  console.log('（如果数据目录本来就不在缺省位置，请用 --from <dshHome> 或 --to <数据目录> 显式指定）')
  process.exit(0)
}

/** 逐条列出（含隐藏文件），跳过已经搬过的空目录。 */
function entries(dir: string): string[] {
  const out: string[] = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) out.push(...entries(full))
    else out.push(relative(source, full))
  }
  return out
}

const files = entries(source)
const targetExists = existsSync(target)
const targetFiles = targetExists ? entries(target) : []

console.log(`源目录：${source}`)
console.log(`目标目录：${target}`)
console.log(`源文件：${files.length} 个${files.length ? `（${files.slice(0, 8).join(' / ')}${files.length > 8 ? ' …' : ''}）` : ''}`)
if (targetExists) console.log(`目标已存在：${targetFiles.length} 个文件`)

if (!files.length) {
  console.log('源目录里没有文件，无需搬家。')
  process.exit(0)
}

// 🚨 「目标非空」必须显式确认：两个目录各有一份 identity.json / portal.sqlite 时，
//   静默覆盖会丢掉其中一份 —— 而 portal.sqlite 是全员历史用量的唯一副本。
if (targetFiles.length && !merge) {
  throw new Error('目标目录已有文件：拒绝覆盖。确认要逐条搬（同名跳过）就加 --merge。')
}

if (!apply) {
  console.log('\n干跑：以上条**一个都不会动**。确认无误后加 --apply 真正搬家。')
  console.log('⚠️ 搬家前请停掉所有 DSH / 服务端进程：SQLite 被占用时 Windows 上 rename 会失败。')
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })
if (!targetExists) mkdirSync(target, { recursive: true })

let moved = 0
let skipped = 0
for (const name of files) {
  const from = join(source, name)
  const to = join(target, name)
  if (existsSync(to)) {
    // 同名不覆盖：`usage.sqlite` / `identity.json` 里可能是更新的一份。
    console.log(`  跳过（目标已存在）：${name}`)
    skipped += 1
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    // 跨卷（家目录与 DSH home 不在同一个盘）时 rename 会失败，退化成复制 + 删除源。
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
  moved += 1
}

// ★ 搬家后逐条核对「目标在、大小一致、源已不在」：只报「搬了 N 个」而不核验，
//   和静默丢文件是同一件事。
const problems: string[] = []
for (const name of files) {
  const to = join(target, name)
  if (!existsSync(to)) {
    if (!existsSync(join(source, name))) problems.push(`${name}：两边都不在`)
    continue
  }
  const from = join(source, name)
  if (existsSync(from) && statSync(from).size !== statSync(to).size) problems.push(`${name}：大小不一致`)
}

console.log(`\n搬完：${moved} 个${skipped ? `，跳过 ${skipped} 个` : ''}`)
if (problems.length) {
  console.error(`❌ ${problems.length} 个文件有问题：\n  ${problems.join('\n  ')}`)
  process.exitCode = 1
} else {
  console.log(`✅ 逐条核对通过（${files.length} 个文件都在目标目录里）`)
  console.log(`源目录里剩下的空壳可以自行删除：${source}`)
}