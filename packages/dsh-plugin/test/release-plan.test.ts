/** 发布闸门必须失败即停；dry-run 和拼错参数都不能触发真实发布。 */
import { expect, test } from 'bun:test'
import { parseReleaseArgs, runReleaseSteps } from '../../../scripts/release-plan.js'
test('默认不发布，真实发布必须明确参数', () => {
  expect(parseReleaseArgs(['plugin'])).toEqual({ target: 'plugin', publish: false, tag: 'next' })
  expect(parseReleaseArgs(['cli', '--publish', '--tag', 'latest']).publish).toBe(true)
  expect(() => parseReleaseArgs(['plugin', '--dryrun'])).toThrow()
  expect(() => parseReleaseArgs(['plugin', '--publish', '--dry-run'])).toThrow()
})
test('验证失败时后续打包/发布从未执行', async () => {
  const visited: string[] = []
  await expect(runReleaseSteps(['test', 'typecheck', 'pack', 'publish'], async (step) => {
    visited.push(step)
    if (step === 'typecheck') throw new Error('fail')
  })).rejects.toThrow('fail')
  expect(visited).toEqual(['test', 'typecheck'])
})
