/**
 * 项目名称别名（`<数据目录>/project-aliases.txt`）在 CLI 上的端到端契约。
 *
 * ## 为什么用真 CLI 子进程
 *
 * 别名这条链有三个「不报错但结果不同」的接点，只有跑真进程才能覆盖：
 * ① 文件从数据目录读（而不是别处）；② 规则进 `openStats()`（SQL / 汇总表 / 直扫
 * 三条路径同源）；③ `--cost` 的金额分桶用**同一个**解析器（否则折出来的那一行
 * 会缺金额，页面/终端显示成「未计价」）。
 *
 * ## 为什么这份文件与 core 的那份测试都要在
 *
 * `core/test/local-project-alias.test.ts` 钉的是匹配语义与取数路径；
 * 这里钉的是 **CLI 的接线**：CLI 是「同一份文件、多个消费者」里的一个消费者，
 * 漏接的症状是「插件面板折了、命令行没折」——两个入口给出不同的项目名，
 * 而两边都不报错。
 */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { pinnedChildEnv } from './child-env.js'

const CLI = resolve(import.meta.dir, '../src/cli.ts')

/** 同一仓库的两个目录：别名规则应当把它们折成同一个项目名。 */
const REPO_ROOT = 'D:\\Coding\\my-project'
const REPO_SUB = 'D:\\Coding\\my-project\\packages\\core'
const OTHER = 'D:\\Coding\\other-project'

interface Fixture {
  dataDir: string
  cleanup: () => void
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>
}

/** 一份最小日志：三条会话各一次调用，`cwd` 决定项目维度。 */
function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'atr-cli-alias-'))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })

  const write = (id: string, cwd: string, input: number) => {
    const dir = join(home, 'sessions', 'proj', id)
    mkdirSync(dir, { recursive: true })
    const rows = [
      { type: 'session', cwd, id },
      {
        type: 'assistant/message',
        seq: 1,
        time: new Date(2026, 8, 20, 10, 0).getTime(),
        // ⚠️ `usage` 必须在 `data.usage` 里（`scanner.ts` 读的是 `pick(ev, 'data', 'usage')`）
        data: { message: { source: { provider: 'dashscope', model: 'm' } },
          usage: { inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    ]
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')))
  }
  write('s-root', REPO_ROOT, 1_000)
  write('s-sub', REPO_SUB, 500)
  write('s-other', OTHER, 2_000)

  const run: Fixture['run'] = async (args) => {
    const child = Bun.spawn(
      // `--quiet` 是刻意的：那条「配置坏了必须说一声」的告警**不受它影响**。
      [process.execPath, CLI, '--dsh-home', home, '--data-dir', dataDir, '--quiet', ...args],
      { stdout: 'pipe', stderr: 'pipe', env: pinnedChildEnv() },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }
  return { dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }), run }
}

/** 写一份单价快照（CNY，整数微元 / 千 token，便于手算）。 */
function writePricing(dataDir: string): void {
  writeFileSync(join(dataDir, 'pricing.json'), JSON.stringify({
    syncedAtMs: new Date(2026, 0, 1, 9, 0).getTime(),
    prices: [{
      provider: 'dashscope', model: 'm', currency: 'CNY',
      inputMicroPerKtok: 1_000_000, outputMicroPerKtok: 0,
      cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0,
      effectiveFromMs: 0, effectiveToMs: null,
    }],
  }))
}

test('没配别名：项目名取 cwd 最后一段（三个目录 = 三行）', async () => {
  const fx = setup()
  try {
    const { stdout, code } = await fx.run(['--format', 'json', '--by', 'project'])
    expect(code).toBe(0)
    const payload = JSON.parse(stdout)
    expect(Object.keys(payload.groups.project).length).toBe(3)
    expect(payload.groups.project.map((row: { key: string }) => row.key).sort()).toEqual(['core', 'my-project', 'other-project'])
  } finally { fx.cleanup() }
})

test('★ 配了别名：同一仓库的两个目录折成一行（会话按折后去重）', async () => {
  const fx = setup()
  try {
    // ⚠️ 等号左边是**显示名**、右边是匹配值（面板上那行「显示名 ⇐ 匹配值」就是这个方向）
    writeFileSync(join(fx.dataDir, 'project-aliases.txt'), `presales-kb-parent = ${REPO_ROOT}\n`)
    const { stdout, stderr, code } = await fx.run(['--format', 'json', '--by', 'project'])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const payload = JSON.parse(stdout)
    const rows = payload.groups.project as { key: string; calls: number; sessions: number; input: number }[]
    expect(rows.map((row) => row.key).sort()).toEqual(['other-project', 'presales-kb-parent'])
    const merged = rows.find((row) => row.key === 'presales-kb-parent')!
    expect(merged.calls).toBe(2)
    expect(merged.sessions).toBe(2)
    // 只改显示：总量与四列一个字节都不变
    expect(merged.input).toBe(1_500)
    expect(payload.totals.total).toBe(3_500)
  } finally { fx.cleanup() }
})

test('★ 别名同样作用于 --cost 的金额桶（折出来的那行必须有金额）', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'project-aliases.txt'), `presales-kb-parent = ${REPO_ROOT}\n`)
    writePricing(fx.dataDir)
    const { stdout, code } = await fx.run(['--format', 'json', '--by', 'project', '--cost'])
    expect(code).toBe(0)
    const payload = JSON.parse(stdout)
    // 1500 token × 1_000_000 微/千 = 1_500_000 微
    const merged = (payload.groups.project as { key: string }[]).find((row) => row.key === 'presales-kb-parent')
    expect(merged).toBeDefined()
    // `--cost` 的金额分节在顶层 `cost.groups.<维度>.<分组键>`（见 `costJsonPayload`）
    const cost = payload.cost.groups.project['presales-kb-parent']
    expect(cost).toBeDefined()
    expect(cost.costs).toEqual([{ currency: 'CNY', amountMicro: 1_500_000, tokens: 1_500 }])
    expect(cost.unpricedTokens).toBe(0)
    // 金额分节里没有这一行 = 分桶键没命中（页面上表现为费用列缺行）
    expect(Object.keys(payload.cost.groups.project).sort()).toEqual(['other-project', 'presales-kb-parent'])
  } finally { fx.cleanup() }
})

test('★ 配置坏了：整份不生效，并且**在 stderr 上说一声**（--quiet 也不闭嘴）', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'project-aliases.txt'), `presales-kb-parent = ${REPO_ROOT}\n这行忘了等号\n`)
    const { stdout, stderr, code } = await fx.run(['--format', 'json', '--by', 'project'])
    expect(code).toBe(0)
    expect(stderr).toContain('第 2 行')
    expect(stderr).toContain('整份未生效')
    // 整份拒绝 ⇒ 项目名一个都没折（而不是「折了第一行、漏了第二行」）
    const payload = JSON.parse(stdout)
    expect((payload.groups.project as { key: string }[]).map((row) => row.key).sort())
      .toEqual(['core', 'my-project', 'other-project'])
  } finally { fx.cleanup() }
})

test('仓库名模式：在任意盘符 / 父目录下都折进来', async () => {
  const fx = setup()
  try {
    writeFileSync(join(fx.dataDir, 'project-aliases.txt'), 'presales-kb-parent = my-project, core\n')
    const { stdout, code } = await fx.run(['--format', 'json', '--by', 'project'])
    expect(code).toBe(0)
    const payload = JSON.parse(stdout)
    expect((payload.groups.project as { key: string }[]).map((row) => row.key).sort())
      .toEqual(['other-project', 'presales-kb-parent'])
  } finally { fx.cleanup() }
})