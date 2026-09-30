/** 发布闸门必须失败即停；dry-run 和拼错参数都不能触发真实发布。 */
import { expect, test } from 'bun:test'
import {
  parseReleaseArgs, quickStepNames, releasePackages, runReleaseSteps, skippedByQuick,
} from '../../../scripts/release-plan.js'
test('默认不发布，真实发布必须明确参数', () => {
  expect(parseReleaseArgs(['plugin'])).toEqual({ target: 'plugin', publish: false, quick: false, tag: 'next' })
  expect(parseReleaseArgs(['cli', '--publish', '--tag', 'latest']).publish).toBe(true)
  expect(() => parseReleaseArgs(['plugin', '--dryrun'])).toThrow()
  expect(() => parseReleaseArgs(['plugin', '--publish', '--dry-run'])).toThrow()
})
test('★ --quick 只压缩验证范围，绝不隐含发布', () => {
  expect(parseReleaseArgs(['plugin', '--quick'])).toEqual({ target: 'plugin', publish: false, quick: true, tag: 'next' })
  expect(parseReleaseArgs(['plugin', '--quick', '--publish', '--tag', 'latest'])).toEqual({ target: 'plugin', publish: true, quick: true, tag: 'latest' })
  // 拼错成 --quik 不能被当成「快速通道」静默吞掉 —— 它是未知参数。
  expect(() => parseReleaseArgs(['plugin', '--quik'])).toThrow()
})
test('★ 快速通道只碰目标包；完整通道恒为两个包', () => {
  // 完整通道即使只发 CLI 也验证插件：共享内核的改动会让另一种分发形态一起坏。
  expect(releasePackages('cli', false)).toEqual(['cli', 'plugin'])
  expect(releasePackages('plugin', false)).toEqual(['cli', 'plugin'])
  // 快速通道不去动另一个包的 dist。
  expect(releasePackages('plugin', true)).toEqual(['plugin'])
  expect(releasePackages('cli', true)).toEqual(['cli'])
  expect(releasePackages('all', true)).toEqual(['cli', 'plugin'])
})
test('★ 快速通道保留目标包自己的路径，且不含任何全仓步骤', () => {
  expect(quickStepNames('plugin')).toEqual(['typecheck', 'build:npm:plugin', 'verify:npm:plugin'])
  expect(quickStepNames('cli')).toEqual(['typecheck', 'build:npm:cli', 'verify:npm:cli'])
  expect(quickStepNames('all')).toEqual([
    'typecheck', 'build:npm:cli', 'build:npm:plugin', 'verify:npm:cli', 'verify:npm:plugin',
  ])
  // 全仓验证的代表性步骤一个都不许出现（口径漂移最贵的几条）。
  for (const forbidden of ['test', 'build', 'verify:npm', 'packages/cli/verify/verify-db-parity.ts']) {
    expect(quickStepNames('all')).not.toContain(forbidden)
  }
})
test('★ 跳过清单按完整通道顺序逐条给出，不静默漏项', () => {
  const full = ['全仓单元测试', 'typecheck', 'packages/cli/verify/verify-db-parity.ts', 'verify:npm:cli']
  const quick = ['typecheck', 'verify:npm:cli']
  expect(skippedByQuick(full, quick)).toEqual(['全仓单元测试', 'packages/cli/verify/verify-db-parity.ts'])
  // 完整通道下清单为空 —— 「跳过 0 步」与「压根没算」必须分得开。
  expect(skippedByQuick(full, full)).toEqual([])
})
test('验证失败时后续打包/发布从未执行', async () => {
  const visited: string[] = []
  await expect(runReleaseSteps(['test', 'typecheck', 'pack', 'publish'], async (step) => {
    visited.push(step)
    if (step === 'typecheck') throw new Error('fail')
  })).rejects.toThrow('fail')
  expect(visited).toEqual(['test', 'typecheck'])
})
