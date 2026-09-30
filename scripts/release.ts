/**
 * 唯一发布入口：验证 → 打包 → tarball 真启动 → 校验摘要 → 发布同一个文件。
 * 默认 dry-run；缺 Node、DSH、日志或 MySQL 都失败退出，绝不静默跳过。
 *
 * 两条通道，都在这一个文件里：
 * - **完整通道（缺省）**：全仓验证（单测 / e2e / 双轨对账 / MySQL / 两种 Web / 插件分层）。
 * - **快速通道（`--quick`，脚本 `publish:*:quick`）**：类型检查 + 目标包构建 + 目标包产物体检，
 *   然后照样打包、跑 tarball 真启动、发布。跳过的完整步骤逐条打印并写进 `report.json`。
 *   边界与「什么时候不许走快速通道」见 `docs/发布检查与事故恢复.md`。
 */
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { cleanChildEnv, resolveNodeBin } from '../packages/core/verify/lib/runtime.js'
import {
  parseReleaseArgs, quickStepNames, releasePackages, runReleaseSteps, skippedByQuick,
  type ReleasePackage,
} from './release-plan.js'

const options = parseReleaseArgs(process.argv.slice(2))
const root = resolve(import.meta.dir, '..')
const output = join(root, '.artifacts', 'releases', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
mkdirSync(output, { recursive: true })
const report: { status: string; target: string; tag: string; mode: 'full' | 'quick'; skipped: string[]; steps: unknown[]; artifacts: { target: string; file: string; sha256: string }[] } = {
  status: 'running', target: options.target, tag: options.tag, mode: options.quick ? 'quick' : 'full', skipped: [], steps: [], artifacts: [],
}
const reportPath = join(output, 'report.json')
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
const env = cleanChildEnv()
const node = resolveNodeBin()
if (!node) throw new Error('发布需要真正的 Node；设置 ATR_NODE_BIN 后重试')
env['ATR_NODE_BIN'] = node
type Step = { label: string; args: string[]; cwd?: string; env?: Record<string, string>; timeout?: number; liveOutput?: boolean }
async function collectOutput(stream: ReadableStream<Uint8Array>, sink?: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    sink?.write(chunk)
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}
async function run(step: Step) {
  const index = report.steps.length + 1
  console.log(`[${index}] ${step.label}`)
  const started = Date.now()
  const child = Bun.spawn([process.execPath, ...step.args], {
    cwd: step.cwd ?? root, env: { ...env, ...step.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), step.timeout ?? 300_000)
  // npm 的浏览器认证链接必须立即可见，不能等发布进程结束后才显示；日志仍完整保留。
  const [stdout, stderr, code] = await Promise.all([
    collectOutput(child.stdout, step.liveOutput ? process.stdout : undefined),
    collectOutput(child.stderr, step.liveOutput ? process.stderr : undefined),
    child.exited,
  ])
  clearTimeout(timer)
  const log = join(output, `${String(index).padStart(2, '0')}.log`)
  writeFileSync(log, stdout + stderr)
  report.steps.push({ label: step.label, code, milliseconds: Date.now() - started, log })
  save()
  if (code !== 0) throw new Error(`${step.label} 失败（退出码 ${code}）；详情 ${log}\n${(stdout + stderr).slice(-3500)}`)
  console.log(`    PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
const script = (path: string): Step => ({ label: path, args: ['run', path] })
const command = (name: string): Step => ({ label: name, args: ['run', name] })
const scratch = mkdtempSync(join(tmpdir(), 'atr-release-parity-'))
// ★ 数据目录**不跟随 `DSH_HOME`**（缺省是家目录下的 `~/.ai-token-report`）。
//   发布验证里的子进程一律继承这一项，免得把使用者的真实身份 / 本地库 / 补报水位写乱。
env['DSH_TOKEN_REPORT_DATA_DIR'] = join(scratch, 'token-report')

// ── 完整通道：全仓验证 ────────────────────────────────────────────────────
const fullSteps: Step[] = [
  { label: '全仓单元测试', args: ['test'] }, command('typecheck'), command('build'),
  script('packages/server/test/e2e-identity.ts'),
  script('packages/server/test/e2e-ingest.ts'),
  script('packages/server/test/e2e-admin.ts'),
  script('packages/cli/verify/verify-report-ingest.ts'),
  script('packages/cli/verify/verify-report-command.ts'),
  { ...script('packages/cli/verify/verify-db-parity.ts'), env: { DSH_HOME: scratch, DSH_TOKEN_REPORT_DATA_DIR: join(scratch, 'token-report'), DSH_TOKEN_REPORT_DSH_HOMES: scratch } },
  script('packages/core/verify/run-driver-parity.ts'),
  script('packages/core/verify/verify-mysql-dialect.ts'),
  script('packages/server/verify/verify-mysql-portal.ts'),
  script('packages/server/verify/verify-mysql-node.ts'),
  { label: '本地页面数据与 SSR', args: ['run', '--filter', '@ai-token-report/web-local', 'verify'] },
  { label: '本地页面布局', args: ['run', '--filter', '@ai-token-report/web-local', 'verify:layout'] },
  { label: '本地页面图表', args: ['run', 'verify/verify-charts.ts'], cwd: join(root, 'packages/web-local') },
  { label: '部门看板 SSR 与图表', args: ['run', '--filter', '@ai-token-report/web-portal', 'verify'] },
  command('verify:npm:cli'), command('verify:npm:plugin'),
  { label: 'CLI 发布产物上报命令', args: ['run', 'packages/cli/verify/verify-report-command.ts', '--package'] },
  script('packages/dsh-plugin/verify/verify-plugin.ts'),
  script('packages/dsh-plugin/verify/verify-cordis-load.ts'),
  script('packages/dsh-plugin/verify/verify-resolution.ts'),
  script('packages/dsh-plugin/verify/verify-sql.ts'),
  script('packages/dsh-plugin/verify/verify-client-bundle.ts'),
  script('packages/shared/verify/verify-schemas-not-bundled.ts'),
]

// ── 快速通道（`--quick`）：只跑「本次要发的那个产物自己的路径」──────────────
//   类型检查 → 目标包构建 → 目标包产物体检。全仓验证**不跑** —— 这是显式的取舍，
//   所以跳过的步骤逐条打印出来、也写进 report.json，并在这里就把完整通道的命令给出来。
const quickSteps: Step[] = quickStepNames(options.target).map(command)
const steps = options.quick ? quickSteps : fullSteps
if (options.quick) {
  report.skipped = skippedByQuick(fullSteps.map((step) => step.label), quickSteps.map((step) => step.label))
  const fullChannel = options.target === 'all' ? 'bun run publish:dry' : `bun run publish:${options.target}:dry`
  console.log(`⚠️  快速通道（--quick）：跳过 ${report.skipped.length} 步完整验证`)
  console.log(`   跳过：${report.skipped.join('、')}`)
  console.log(`   本次只跑：${steps.map((step) => step.label).join(' → ')} → 打包 → tarball 真启动 → ${options.publish ? `发布 (${options.tag})` : 'dry-run'}`)
  console.log(`   正式发布、或改动涉及内核 / 上报链路 / 数据库 / 插件装载时，请走完整通道：${fullChannel}`)
}
try {
  if (!options.quick) {
    // 固定输入快照：运行中的 DSH 仍会追加日志，双轨对账的两个查询不能读不同时间点的数据。
    // 快速通道不跑那些对账，也就不必复制一份日志。
    const dshHome = resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
    cpSync(join(dshHome, 'sessions'), join(scratch, 'sessions'), { recursive: true })
  }
  await runReleaseSteps(steps, run)

  // 完整通道恒为两个包（即使仅发布 CLI 也验证插件，以免共享内核的变动破坏另一种分发形态）；
  // 快速通道只打包本次要发的那个包。
  const distDirectory: Record<ReleasePackage, string> = { cli: 'cli', plugin: 'dsh-plugin' }
  const tarballs = new Map<ReleasePackage, string>()
  for (const target of releasePackages(options.target, options.quick)) {
    const dist = join(root, 'packages', distDirectory[target], 'dist')
    const manifest = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8')) as { name: string; version: string }
    const tarball = join(output, `${manifest.name}-${manifest.version}.tgz`)
    await run({ label: `${target} 打包实际发布文件`, args: ['pm', 'pack', '--filename', tarball], cwd: dist })
    tarballs.set(target, tarball)
    report.artifacts.push({ target, file: tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') })
    save()
  }
  // ★ tarball 真启动是**唯一**能挡住「发出去的包装不上 / DSH 起不来」（0.3.0 事故）的检查，
  //   所以快速通道照样跑 —— 它是「快速」与「盲发」的分界。只对本次真打了包的包执行。
  const pluginTarball = tarballs.get('plugin')
  if (pluginTarball !== undefined) await run({ label: 'tarball 安装/升级修复/完整 DSH Web 启动', args: ['run', 'packages/dsh-plugin/verify/verify-profile-boot.ts', pluginTarball] })
  // CLI 的产物层测试另行对已解包 tarball 执行，避免 files 漏文件却验证 dist 通过。
  const cliTarball = tarballs.get('cli')
  if (cliTarball !== undefined) await run({ label: 'CLI tarball 双运行时验证', args: ['run', 'packages/cli/verify/verify-tarball.ts', cliTarball] })
  const publishTargets: ReleasePackage[] = options.target === 'all' ? ['cli', 'plugin'] : [options.target]
  for (const target of publishTargets) {
    const tarball = tarballs.get(target)!
    const original = report.artifacts.find((a) => a.file === tarball)!
    if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== original.sha256) throw new Error('已验证 tarball 被修改，拒绝发布')
    await run({ label: `${target} ${options.publish ? '发布' : 'dry-run'} (${options.tag})`, args: ['publish', tarball, '--tag', options.tag, ...(options.publish ? [] : ['--dry-run'])], liveOutput: options.publish })
  }
  report.status = options.publish ? 'published' : 'verified-dry-run'
  save()
  console.log(options.quick
    ? `快速通道通过（未跑全仓验证，跳过 ${report.skipped.length} 步）。报告：${reportPath}`
    : `全部通过。报告：${reportPath}`)
} catch (error) {
  report.status = 'failed'
  save()
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (!relative(tmpdir(), scratch).startsWith('atr-release-parity-')) throw new Error('临时目录越界')
  rmSync(scratch, { recursive: true, force: true })
}
