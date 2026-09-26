/**
 * 唯一发布入口：全仓验证 → 打包 → tarball 真启动 → 校验摘要 → 发布同一个文件。
 * 默认 dry-run；缺 Node、DSH、日志或 MySQL 都失败退出，绝不静默跳过。
 */
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { cleanChildEnv, resolveNodeBin } from '../packages/core/verify/lib/runtime.js'
import { parseReleaseArgs, runReleaseSteps } from './release-plan.js'

const options = parseReleaseArgs(process.argv.slice(2))
const root = resolve(import.meta.dir, '..')
const output = join(root, '.artifacts', 'releases', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
mkdirSync(output, { recursive: true })
const report: { status: string; target: string; tag: string; steps: unknown[]; artifacts: { target: string; file: string; sha256: string }[] } = {
  status: 'running', target: options.target, tag: options.tag, steps: [], artifacts: [],
}
const reportPath = join(output, 'report.json')
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
const env = cleanChildEnv()
const node = resolveNodeBin()
if (!node) throw new Error('发布需要真正的 Node；设置 ATR_NODE_BIN 后重试')
env['ATR_NODE_BIN'] = node
type Step = { label: string; args: string[]; cwd?: string; env?: Record<string, string>; timeout?: number }
async function run(step: Step) {
  const index = report.steps.length + 1
  console.log(`[${index}] ${step.label}`)
  const started = Date.now()
  const child = Bun.spawn([process.execPath, ...step.args], {
    cwd: step.cwd ?? root, env: { ...env, ...step.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), step.timeout ?? 300_000)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
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
try {
  // 固定输入快照：运行中的 DSH 仍会追加日志，两个查询不能读不同时间点的数据。
  const dshHome = resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  cpSync(join(dshHome, 'sessions'), join(scratch, 'sessions'), { recursive: true })
  await runReleaseSteps([
    { label: '全仓单元测试', args: ['test'] }, command('typecheck'), command('build'),
    script('packages/server/test/e2e-identity.ts'),
    script('packages/server/test/e2e-ingest.ts'),
    script('packages/server/test/e2e-admin.ts'),
    script('packages/cli/verify/verify-report-ingest.ts'),
    script('packages/cli/verify/verify-report-command.ts'),
    { ...script('packages/cli/verify/verify-db-parity.ts'), env: { DSH_HOME: scratch } },
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
  ] as Step[], run)

  // 即使仅发布 CLI，也验证插件，以免共享内核的变动破坏另一种分发形态。
  const tarballs = new Map<string, string>()
  for (const [target, directory] of [['cli', 'cli'], ['plugin', 'dsh-plugin']] as const) {
    const dist = join(root, 'packages', directory, 'dist')
    const manifest = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'))
    const tarball = join(output, `${manifest.name}-${manifest.version}.tgz`)
    await run({ label: `${target} 打包实际发布文件`, args: ['pm', 'pack', '--filename', tarball], cwd: dist })
    tarballs.set(target, tarball)
    report.artifacts.push({ target, file: tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') })
    save()
  }
  await run({ label: 'tarball 安装/升级修复/完整 DSH Web 启动', args: ['run', 'packages/dsh-plugin/verify/verify-profile-boot.ts', tarballs.get('plugin')!] })
  // CLI 的产物层测试另行对已解包 tarball 执行，避免 files 漏文件却验证 dist 通过。
  await run({ label: 'CLI tarball 双运行时验证', args: ['run', 'packages/cli/verify/verify-tarball.ts', tarballs.get('cli')!] })
  for (const target of options.target === 'all' ? ['cli', 'plugin'] : [options.target]) {
    const tarball = tarballs.get(target)!
    const original = report.artifacts.find((a) => a.file === tarball)!
    if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== original.sha256) throw new Error('已验证 tarball 被修改，拒绝发布')
    await run({ label: `${target} ${options.publish ? '发布' : 'dry-run'} (${options.tag})`, args: ['publish', tarball, '--tag', options.tag, ...(options.publish ? [] : ['--dry-run'])] })
  }
  report.status = options.publish ? 'published' : 'verified-dry-run'
  save()
  console.log(`全部通过。报告：${reportPath}`)
} catch (error) {
  report.status = 'failed'
  save()
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (!relative(tmpdir(), scratch).startsWith('atr-release-parity-')) throw new Error('临时目录越界')
  rmSync(scratch, { recursive: true, force: true })
}
