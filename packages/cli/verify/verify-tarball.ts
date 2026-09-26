/** 对实际 tarball 重跑现有双运行时验证，解包后禁止重建 dist 掩盖漏文件。 */
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { cleanChildEnv } from '../../core/verify/lib/runtime.js'

const tarball = resolve(process.argv[2] ?? '')
assert.ok(tarball.endsWith('.tgz'), '需要 .tgz 发布文件')
const sandbox = mkdtempSync(join(tmpdir(), 'atr-cli-tarball-'))
try {
  cpSync(tarball, join(sandbox, 'candidate.tgz'))
  for (const args of [['tar', '-tzf', 'candidate.tgz'], ['tar', '-xzf', 'candidate.tgz']]) {
    const result = Bun.spawnSync(args, { cwd: sandbox, stdout: 'pipe', stderr: 'pipe' })
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
    if (args[1] === '-tzf') assert.ok(new TextDecoder().decode(result.stdout).trim().split(/\r?\n/).every((p) => p.startsWith('package/') && !p.split('/').includes('..')))
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'verify-npm-package.ts')], {
    cwd: sandbox, env: { ...cleanChildEnv(), ATR_CLI_PACKAGE_DIR: join(sandbox, 'package') }, stdout: 'inherit', stderr: 'inherit',
  })
  assert.equal(await child.exited, 0, 'CLI tarball 验证失败')
} finally {
  assert.ok(relative(tmpdir(), sandbox).startsWith('atr-cli-tarball-'))
  rmSync(sandbox, { recursive: true, force: true })
}
