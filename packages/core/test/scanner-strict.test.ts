/** 补报必须发现不可读目录；普通本地统计仍保留历史容错约定。 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessionFiles } from '../src/scanner.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'atr-strict-scan-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('严格扫描将根目录缺失报告为错误，普通扫描仍返回空数组', async () => {
  const missing = join(home, 'missing')
  expect(await listSessionFiles(missing)).toEqual([])
  await expect(listSessionFiles(missing, { strictErrors: true })).rejects.toThrow()
})

test('项目符号链接损坏时不允许全量补报假报完成', async () => {
  symlinkSync(join(home, 'missing-project'), join(home, 'broken-project'), 'junction')
  expect(await listSessionFiles(home)).toEqual([])
  await expect(listSessionFiles(home, { strictErrors: true })).rejects.toThrow()
})

test('会话符号链接损坏时不允许只发现其余文件就宣称完整', async () => {
  const project = join(home, 'project')
  mkdirSync(project)
  symlinkSync(join(home, 'missing-session'), join(project, 'broken-session'), 'junction')
  expect(await listSessionFiles(home)).toEqual([])
  await expect(listSessionFiles(home, { strictErrors: true })).rejects.toThrow()
})
