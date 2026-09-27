/** 用真实 CLI 对照直扫，防止查询优化改变 JSON/CSV/终端输出口径。 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

test('CLI 索引聚合与直扫的分组、趋势、交叉表及空窗口一致', async () => {
  const home = mkdtempSync(join(tmpdir(), 'atr-cli-stats-'))
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'),
      '--dsh-home', home, '--quiet', ...args], { stdout: 'pipe', stderr: 'pipe' })
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
