/**
 * 插件侧的项目名称别名（「自定义配置」里的那一栏）。
 *
 * ## 这个文件在守什么
 *
 * `core` 侧已经把匹配语义与三条取数路径钉住了（`core/test/local-project-alias.test.ts`）。
 * 这里守的是**插件这条链路上的接线**，而接线错了**不会报错**，只会显示成另一个项目名：
 *
 * 1. `StatsContext.projectAliases` → `openStats()`：漏传 ⇒ 面板按 cwd 最后一段出数，
 *    而 `token_usage` 工具（同一个 `executeQuery`，只是走线程）折了 —— 两个入口不一致；
 * 2. ★ **金额与 token 行对齐**：`costByGroupOf()` 必须拿 `session.projectNameOf`
 *    这个**同一个**解析器。自己再装一个不会报错，只会让「折出来的那一行」缺金额
 *    （页面显示成「未计价」），或者干脆把金额挂到别的键上。
 * 3. 别名只改 `project` 维度：总量、其它维度、上报数据一个字节都不动。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import type { LocalProjectAliasRule } from '@ai-token-report/core/db'
import { executeQuery, type StatsContext } from '../src/stats.js'

interface Spec { seq: number; input: number; output: number }

/** 建一个会话日志（三层目录 + 会话头里的 `cwd`，项目维度就是由它决定的）。 */
function writeSession(sessionsRoot: string, projectDir: string, id: string, cwd: string, specs: Spec[]): void {
  const dir = join(sessionsRoot, projectDir, id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, createdAt: Date.now(), cwd }),
    ...specs.map((spec) => JSON.stringify({
      type: 'assistant/message',
      seq: spec.seq,
      time: Date.now(),
      data: {
        message: { source: { provider: 'dashscope', model: 'm' } },
        usage: {
          inputTokens: spec.input,
          outputTokens: spec.output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    })),
  ]
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
}

/** 一份只覆盖 `dashscope/m` 的单价快照（金额有价才会出现在行上）。 */
function writePricing(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'pricing.json'), JSON.stringify({
    syncedAtMs: Date.now(),
    prices: [{
      provider: 'dashscope', model: 'm', currency: 'CNY',
      inputMicroPerKtok: 1_000, outputMicroPerKtok: 2_000,
      cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0,
      effectiveFromMs: 0, effectiveToMs: null,
    }],
  }))
}

const RULES: LocalProjectAliasRule[] = [{ prefix: 'my-project', alias: 'presales-kb-parent' }]

/** 一个临时 home + 两个同仓库目录（仓库根与子目录）+ 一个不相干项目。 */
function fixture(): { home: string; sessionsRoot: string; dataDir: string; dbPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'atr-plugin-alias-'))
  const sessionsRoot = join(home, 'sessions')
  const dataDir = join(home, 'data')
  writeSession(sessionsRoot, 'root', 's-root', 'D:\\Coding\\my-project', [{ seq: 1, input: 1_000, output: 100 }])
  writeSession(sessionsRoot, 'sub', 's-sub', 'D:\\Coding\\my-project\\packages\\core', [{ seq: 1, input: 500, output: 50 }])
  writeSession(sessionsRoot, 'other', 's-other', 'D:\\Coding\\other-project', [{ seq: 1, input: 2_000, output: 0 }])
  writePricing(dataDir)
  return { home, sessionsRoot, dataDir, dbPath: join(home, 'usage.sqlite') }
}

function contextOf(f: ReturnType<typeof fixture>, projectAliases?: readonly LocalProjectAliasRule[]): StatsContext {
  return {
    config: { localDb: true },
    sessionsRoots: [f.sessionsRoot],
    dbPath: f.dbPath,
    dataDir: f.dataDir,
    backgroundQueries: false,
    ...(projectAliases !== undefined ? { projectAliases } : {}),
  }
}

describe('项目名称别名：插件取数链路', () => {
  test('没配别名：项目名仍是 cwd 最后一段（三行）', async () => {
    const f = fixture()
    try {
      const result = await executeQuery(contextOf(f), { by: ['project'] })
      expect(result.groups[0]!.rows.map((row) => row.key).sort()).toEqual(['core', 'my-project', 'other-project'])
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })

  test('★ 配上别名：同一仓库的两个目录折成一行，会话数按折后去重', async () => {
    const f = fixture()
    try {
      const result = await executeQuery(contextOf(f, RULES), { by: ['project'] })
      const rows = result.groups[0]!.rows
      expect(rows.map((row) => row.key).sort()).toEqual(['other-project', 'presales-kb-parent'])
      const merged = rows.find((row) => row.key === 'presales-kb-parent')!
      expect(merged.sessions).toBe(2)
      expect(merged.calls).toBe(2)
      // 只改显示：总量不变
      expect(result.totals.calls).toBe(3)
      expect(result.totals.total).toBe(3_650)
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })

  test('★ 折后那一行的金额不许缺（金额桶与 token 行必须是同一个解析器）', async () => {
    const f = fixture()
    try {
      const result = await executeQuery(contextOf(f, RULES), { by: ['project'] })
      for (const row of result.groups[0]!.rows) {
        // 每一行都必须有金额字段：缺了会显示成「未计价」，而这条数据是有价的
        expect(row.cost).toBeDefined()
        // 两条独立路径（SQL 聚合 vs 逐条事件取价）的 token 数必须对上 ——
        // 对不上就说明金额桶的键没命中
        expect(row.cost!.totalTokens).toBe(row.total)
        expect(row.cost!.unpricedTokens).toBe(0)
      }
      // 仓库根 1000/100 + 子目录 500/50：input 1500×1000微/千 + output 150×2000微/千 = 1800 微
      const merged = result.groups[0]!.rows.find((row) => row.key === 'presales-kb-parent')!
      expect(merged.cost!.costs).toEqual([{ currency: 'CNY', amountMicro: 1_800, tokens: 1_650 }])
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })

  test('路径前缀模式同样生效（含未命中回落）', async () => {
    const f = fixture()
    try {
      const result = await executeQuery(
        contextOf(f, [{ prefix: 'D:\\Coding\\my-project', alias: '限定位置' }]),
        { by: ['project'] },
      )
      // 前缀模式按分隔符边界匹配 ⇒ 仓库根与它的子目录**都**折进同一个名字；
      // 不相干的 other-project 逐字保留（未命中回落 `projectName()`）
      expect(result.groups[0]!.rows.map((row) => row.key).sort())
        .toEqual(['other-project', '限定位置'])
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })

  test('别名只改 project 维度：provider / provider-model 行一个都不变', async () => {
    const f = fixture()
    try {
      const withRules = await executeQuery(contextOf(f, RULES), { by: ['provider', 'provider-model', 'project'] })
      const without = await executeQuery(contextOf(f), { by: ['provider', 'provider-model', 'project'] })
      try {
        for (const dim of ['provider', 'provider-model'] as const) {
          const a = withRules.groups.find((group) => group.by === dim)!
          const b = without.groups.find((group) => group.by === dim)!
          expect(a.rows).toEqual(b.rows)
        }
      } finally { /* 两个 session 都已随 executeQuery 关闭 */ }
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })

  test('空规则数组与不传等价（没配别名的行为与迁移前相同）', async () => {
    const f = fixture()
    try {
      const empty = await executeQuery(contextOf(f, []), { by: ['project'] })
      const none = await executeQuery(contextOf(f), { by: ['project'] })
      expect(empty.groups[0]!.rows.map((row) => row.key)).toEqual(none.groups[0]!.rows.map((row) => row.key))
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
})