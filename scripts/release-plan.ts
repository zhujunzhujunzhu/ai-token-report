/** 发布入口参数严格解析；拼错参数不能退回成真实发布。 */
export function parseReleaseArgs(args: string[]) {
  const [target, ...flags] = args
  if (target !== 'plugin' && target !== 'cli' && target !== 'all') throw new Error('目标必须为 plugin、cli 或 all')
  let publish = false
  let dry = false
  let tag = 'next'
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--publish') publish = true
    else if (flags[i] === '--dry-run') dry = true
    else if (flags[i] === '--tag' && ['next', 'latest'].includes(flags[i + 1] ?? '')) tag = flags[++i]!
    else throw new Error(`未知发布参数：${flags[i]}`)
  }
  if (publish && dry) throw new Error('--publish 与 --dry-run 不能同时使用')
  return { target, publish, tag }
}

/** 不捕获失败继续跑：任一验证拒绝，后面的 pack/publish 都不可达。 */
export async function runReleaseSteps<T>(steps: T[], run: (step: T) => Promise<void>) {
  for (const step of steps) await run(step)
}
