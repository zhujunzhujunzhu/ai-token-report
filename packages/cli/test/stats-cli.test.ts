/** 用真实 CLI 对照直扫，防止查询优化改变 JSON/CSV/终端输出口径。 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { pinnedChildEnv } from './child-env.js'

test('CLI 索引聚合与直扫的分组、趋势、交叉表及空窗口一致', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atr-cli-stats-'))
  /**
   * 数据目录：**必须显式传给子进程**。
   *
   * ⚠️ 缺省值在家目录下（`~/.ai-token-report`），而且 `bun test` 的 preload
   *   （`scripts/test-preload.ts`）**管不到子进程** —— 实测 Bun 1.4.2 下
   *   preload 里改的 `process.env` 不会被 `Bun.spawn` 继承（父进程能读到，
   *   子进程读到 `undefined`）。少了这一项，这条用例会把本地库写进使用者
   *   真实的 `~/.ai-token-report/usage.sqlite`。
   * ⚠️ 来源与自动发现同样要钉（见 `child-env.ts`）：CLI 缺省统计**全部已注册来源**，
   *   不钉就会冷扫开发者真实的 Codex / Claude Code 日志（本机 2.8 GB），
   *   这条用例会以 5 秒超时失败 —— 而原因看起来与断言毫无关系。
   */
  const dataDir = join(home, 'token-report')
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'),
      '--dsh-home', home, '--data-dir', dataDir, '--quiet', ...args], {
      stdout: 'pipe', stderr: 'pipe', env: pinnedChildEnv(),
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    return stdout
  }
  try {
    for (let s = 0; s < 3; s++) {
      const dir = join(home, 'sessions', 'project', `session-${s}`)
      mkdirSync(dir, { recursive: true })
      const rows: unknown[] = [{ type: 'session', cwd: `/work/project-${s % 2}` }]
      for (let seq = 1; seq <= (s + 1) * 3; seq++) rows.push({ type: 'assistant/message', seq,
        time: new Date(2026, 8, 20 + seq % 3, 10 + seq % 2).getTime(),
        data: { message: { source: { provider: `p${s % 2}`, model: `m${s}` } },
          usage: { inputTokens: 11 * seq, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 7, reasoningTokens: 1 } } })
      writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n')))
    }
    const dims = 'provider,model,provider-model,project,session,day,hour'
    for (const extra of [[], ['--series', 'day'], ['--series', 'hour', '--provider', 'p1'], ['--since', '2099-01-01']]) {
      const args = ['--format', 'json', '--by', dims, ...extra]
      const sql = JSON.parse(await run(args))
      const scan = JSON.parse(await run([...args, '--no-db']))
      expect(sql.source).toBe('sql')
      const normalize = (value: typeof sql) => ({ totals: value.totals,
        groups: Object.fromEntries(Object.entries(value.groups).map(([key, rows]) => [key, (rows as any[]).sort((a, b) => a.key.localeCompare(b.key))])),
        series: value.series })
      expect(normalize(sql)).toEqual(normalize(scan))
      /**
       * ★ 序列点里的 `byProvider` 键必须**排序**。
       *
       * 它的插入顺序取决于记录被并进桶里的先后（库路径按 `ts` 取、直扫按文件顺序），
       * 所以同一个桶在两条路径上会得到「同一个映射、不同的键序」—— 数值全等，
       * 但「库 == 直扫」的逐字对照会看起来不一致（本机 `--source all` 实测：
       * 133 个日桶里 8 个桶只有键序不同，数值一个不差）。
       */
      for (const point of (sql.series ?? []) as { byProvider?: Record<string, number> }[]) {
        const keys = Object.keys(point.byProvider ?? {})
        expect(keys).toEqual([...keys].sort())
      }
    }
    for (const args of [
      ['--format', 'csv', '--by', dims, '--series', 'day'],
      ['--list-providers'],
      ['--format', 'table', '--no-diag', '--by', 'provider-model', '--cross', '--series', 'day'],
    ]) {
      const sql = await run(args)
      const scan = await run([...args, '--no-db'])
      const body = (text: string) => args.includes('table') ? text.slice(text.indexOf('\n=== ')) : text
      expect(body(sql)).toBe(body(scan))
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 30_000)
