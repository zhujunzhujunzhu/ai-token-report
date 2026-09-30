/** 发布入口参数严格解析；拼错参数不能退回成真实发布。 */

/** 命令行目标：`all` 表示两个包都要（打包与发布仍逐个进行）。 */
export type ReleaseTarget = 'plugin' | 'cli' | 'all'
/** 真正被构建 / 打包 / 发布的那个包。 */
export type ReleasePackage = 'plugin' | 'cli'

export function parseReleaseArgs(args: string[]) {
  const [target, ...flags] = args
  if (target !== 'plugin' && target !== 'cli' && target !== 'all') throw new Error('目标必须为 plugin、cli 或 all')
  let publish = false
  let dry = false
  let quick = false
  let tag = 'next'
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--publish') publish = true
    else if (flags[i] === '--dry-run') dry = true
    // ★ `--quick` 只压缩**验证范围**，绝不隐含发布：不写 `--publish` 就仍然只是自检。
    else if (flags[i] === '--quick') quick = true
    else if (flags[i] === '--tag' && ['next', 'latest'].includes(flags[i + 1] ?? '')) tag = flags[++i]!
    else throw new Error(`未知发布参数：${flags[i]}`)
  }
  if (publish && dry) throw new Error('--publish 与 --dry-run 不能同时使用')
  return { target: target as ReleaseTarget, publish, quick, tag }
}

/**
 * 这次要构建 / 打包 / 发布的包。
 * - **完整通道恒为两个**：共享内核的改动会让另一种分发形态一起坏，所以即使只发 CLI 也验证插件；
 * - **快速通道只碰目标包**：「快」的代价只落在本次要发的那个产物上，不去动另一个包的 dist。
 */
export function releasePackages(target: ReleaseTarget, quick: boolean): ReleasePackage[] {
  if (target === 'all') return ['cli', 'plugin']
  return quick ? [target] : ['cli', 'plugin']
}

/**
 * 快速通道**额外**跑的验证步骤（按顺序，都是根目录 package.json 的脚本名）：
 * 类型检查 → 目标包构建 → 目标包产物体检。
 *
 * 🚨 全仓验证（单测 / e2e / 双轨与驱动对账 / MySQL 三条 / 两种 Web / 插件分层 / bundles）
 * **都不在其中**。范围、代价与「什么时候不许走快速通道」写在 `docs/发布检查与事故恢复.md`。
 */
export function quickStepNames(target: ReleaseTarget): string[] {
  const packages = releasePackages(target, true)
  return [
    'typecheck',
    ...packages.map((pkg) => (pkg === 'cli' ? 'build:npm:cli' : 'build:npm:plugin')),
    ...packages.map((pkg) => (pkg === 'cli' ? 'verify:npm:cli' : 'verify:npm:plugin')),
  ]
}

/**
 * 快速通道**没跑**的完整步骤，按完整通道的顺序逐条列出。
 * 逐条报出来（并写进 report.json）是刻意的：不许让「快」变成「不知道漏了什么」。
 */
export function skippedByQuick(fullLabels: string[], quickLabels: string[]): string[] {
  const kept = new Set(quickLabels)
  return fullLabels.filter((label) => !kept.has(label))
}

/** 不捕获失败继续跑：任一验证拒绝，后面的 pack/publish 都不可达。 */
export async function runReleaseSteps<T>(steps: T[], run: (step: T) => Promise<void>) {
  for (const step of steps) await run(step)
}
