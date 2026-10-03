/**
 * 来源选择的端到端契约（真 CLI 子进程）：两条**静默错数字**的防线。
 *
 * ## ① `--source dsh` 必须真的只统计 DSH
 *
 * 本地库（`usage.sqlite`）是 CLI / 本地页 / 插件 / report **共用的一个文件**，
 * 而 `openStats()` 的 `sources` 缺省语义是「**库里的全部来源**」。
 * 只要这台机器上跑过一次缺省运行或 `--source all`，库里就躺着别的来源的行 ——
 * 于是「纯 DSH」那条分支（`pureDsh`）只要不显式传 `sources`，
 * `--source dsh` 就会**静默返回并集**。
 *
 * 本机实测（2026-10-03）：先 `--source all` 再 `--source dsh`，两次总量
 * **逐位相同**（326,041,147），`--by source` 里还挂着 workbuddy。
 * 而 `--source dsh` 恰恰是 `--help` 里承诺「想回到旧口径」的那条路。
 *
 * ## ② `DSH_TOKEN_REPORT_<来源>=0` 必须在 CLI 里真的生效
 *
 * `resolveSourceRoots()` 的语义是「显式给了 sources 就接管」（否则 preload 把开关
 * 全设成 0 之后，`verify:*` 里那些 `resolveSourceRoots({ sources: ['codex'] })`
 * 会一条数据都拿不到），而 CLI 这一层**永远**把清单显式传下去 ——
 * 于是开关在 CLI 里被整个跳过：实测 `DSH_TOKEN_REPORT_CODEX=0 bun run stats`
 * 与不设它读的根**逐字相同**（2.8 GB 的 Codex 日志照扫，只是慢，不报错）。
 *
 * ⚠️ 数据目录一律显式传给子进程：缺省值在家目录下，而 `bun test` 的 preload
 *    **管不到 `Bun.spawn` 出来的子进程**（见 `packages/cli/test/stats-cli.test.ts`）。
 * ⚠️ 其余来源用环境开关钉死（`child-env.ts`）：不钉的话「缺省 = 全部已启用来源」
 *    那一轮会去读开发者真实的 `~/.claude` / Trae / `~/.workbuddy`。
 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { pinnedChildEnv } from './child-env.js'

/** CLI 的 JSON 输出里我们关心的那几项。 */
interface StatsJson {
  totals: { total: number; input: number; output: number; cacheRead: number; calls: number }
  sessionsRoots: string[]
  groups: { source?: { key: string; total: number }[] }
}

interface Fixture {
  home: string
  codexHome: string
  run: (args: string[], env?: Record<string, string>) => Promise<StatsJson>
  cleanup: () => void
}

/** 1 个 DSH 会话（zstd 分帧） + 1 个 Codex rollout（`1050` token）。 */
function setup(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'atr-cli-source-filter-'))
  const dataDir = join(home, 'token-report')
  const codexHome = join(home, 'codex-home')

  const sessionDir = join(home, 'sessions', 'project', 'session-0')
  mkdirSync(sessionDir, { recursive: true })
  const rows: unknown[] = [{ type: 'session', cwd: '/work/dsh-project' }]
  for (let seq = 1; seq <= 3; seq++) {
    rows.push({ type: 'assistant/message', seq,
      time: new Date(2026, 8, 20, 10).getTime(),
      data: { message: { source: { provider: 'deepseek', model: 'deepseek-v4' } },
        usage: { inputTokens: 100 * seq, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 7, reasoningTokens: 1 } } })
  }
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'),
    zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')))

  // Codex：`<home>/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`
  // （`archived_sessions` 也建出来，否则 CLI 会为它打一条「根不存在」的告警）
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const dayDir = join(codexHome, 'sessions', '2026', '01', '01')
  mkdirSync(dayDir, { recursive: true })
  mkdirSync(join(codexHome, 'archived_sessions'), { recursive: true })
  const envelope = (ordinal: number, type: string, payload: unknown, at: string) =>
    JSON.stringify({ timestamp: at, ordinal, type, payload })
  writeFileSync(join(dayDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`), [
    envelope(0, 'session_meta', { session_id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/work/codex-project', model_provider: 'openai' }, '2026-01-01T00:00:00.000Z'),
    envelope(1, 'turn_context', { model: 'gpt-5-codex', cwd: '/work/codex-project' }, '2026-01-01T00:00:00.500Z'),
    envelope(2, 'event_msg', { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
    } }, '2026-01-01T00:00:01.000Z'),
  ].join('\n') + '\n')

  const run: Fixture['run'] = async (args, env = {}) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'),
      '--dsh-home', home, '--data-dir', dataDir, '--quiet', '--format', 'json', '--by', 'source', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      // 只留 DSH 与 Codex 参与「缺省 = 全部已启用来源」，其余一律关掉；
      // 不关就会连带扫开发者真实的 ~/.claude / Trae / ~/.workbuddy（见 `child-env.ts`）。
      env: pinnedChildEnv({ DSH_TOKEN_REPORT_CODEX: '1', ...env }),
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    return JSON.parse(stdout) as StatsJson
  }

  return { home, codexHome, run, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const sourceKeys = (json: StatsJson) => (json.groups.source ?? []).map((row) => row.key).sort()

test('--source dsh 不被库里别的来源污染（缺省仍是并集）', async () => {
  const fx = setup()
  try {
    // ① 空库 + 只选 DSH：只入库 DSH，数字必须只有 DSH
    const dshFirst = await fx.run(['--source', 'dsh'])
    expect(dshFirst.totals.total).toBeGreaterThan(0)
    expect(sourceKeys(dshFirst)).toEqual(['dsh'])

    // ② 让**同一个库**里出现别的来源的行
    const codexOnly = await fx.run(['--source', 'codex', '--codex-home', fx.codexHome])
    expect(codexOnly.totals.total).toBe(1050)
    expect(sourceKeys(codexOnly)).toEqual(['codex'])

    // ③ 关键断言：`--source dsh` 不能被库里的 Codex 行污染
    const dshAgain = await fx.run(['--source', 'dsh'])
    expect(sourceKeys(dshAgain)).toEqual(['dsh'])
    expect(dshAgain.totals).toEqual(dshFirst.totals)

    // ④ 缺省（全部已启用来源）仍然是并集：筛选没有把正常口径改小
    const all = await fx.run(['--codex-home', fx.codexHome])
    expect(sourceKeys(all)).toEqual(['codex', 'dsh'])
    expect(all.totals.total).toBe(dshFirst.totals.total + codexOnly.totals.total)
  } finally {
    fx.cleanup()
  }
}, 60_000)

test('DSH_TOKEN_REPORT_<来源>=0 在 CLI 里真的生效（缺省不是「全部已注册来源」）', async () => {
  const fx = setup()
  try {
    // 开关打开：Codex 的根被读到、用量进得来
    const on = await fx.run(['--codex-home', fx.codexHome])
    expect(on.sessionsRoots.some((root) => root.includes('codex'))).toBe(true)
    expect(sourceKeys(on)).toContain('codex')

    // 开关关闭：Codex 的根**一个都不该出现在本次读取清单里**
    const off = await fx.run(['--codex-home', fx.codexHome], { DSH_TOKEN_REPORT_CODEX: '0' })
    expect(off.sessionsRoots.some((root) => root.includes('codex'))).toBe(false)
    expect(sourceKeys(off)).toEqual(['dsh'])
  } finally {
    fx.cleanup()
  }
}, 60_000)
