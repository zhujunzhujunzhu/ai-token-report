/**
 * 插件侧的金额（估算）。
 *
 * ## 为什么这个文件值得单独存在
 *
 * 金额有三类**不会报错**的错法，它们全都只在数字上看不出来：
 *
 * 1. **分组键对不上** —— 分组行的金额要么缺席（页面显示「未计价」，而
 *    使用者会以为「这段用量没配价」）、要么整列错位。所以这里逐维度断言
 *    「每一行都拿到了金额」，并用 `cost.totalTokens === row.total` 交叉验证：
 *    两个数来自两条独立的路径（SQL 聚合 vs 逐条事件取价），对得上才说明
 *    键真的命中了。
 * 2. **拿不到事件** —— 金额是逐条事件按**它自己的时刻**取价后折叠的。若
 *    `summaryOnly` / `rollup` / 直扫降级某条路径下 `records()` 是空的，
 *    金额就会静默变成「未计价」而 token 数照常显示。下面三条模式各断言一次。
 * 3. **未计价被写成 0 元** —— 这是本功能最危险的误读（未定价看起来像省了钱）。
 *    所以「一条价都没配上」的那一态被单独钉住：`costs` 必须是空数组，
 *    格式化结果必须是 `null`，展示层才有机会写「未计价」。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { executeQuery, formatUsage, type StatsContext } from '../src/stats.js'

/** 一个小时毫秒数。事件时刻刻意跨过换价点，用来验证「逐条取价」。 */
const HOUR = 3_600_000
const T0 = Date.UTC(2026, 0, 1, 0, 0)

interface EventSpec {
  seq: number
  atMs: number
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 搭一份可扫描的会话日志。
 *
 * ⚠️ 目录结构必须是**固定三层** `sessions/<project>/<sessionId>/<file>`：
 *    多一级会让扫描器静默扫到 0 个文件（不报错、总量为 0）。
 */
function writeSessions(home: string, specs: EventSpec[], sessionId = 'session-cost'): string {
  const sessionsRoot = join(home, 'sessions')
  const dir = join(sessionsRoot, 'project-a', sessionId)
  mkdirSync(dir, { recursive: true })
  const lines = specs.map((spec) =>
    JSON.stringify({
      type: 'assistant/message',
      seq: spec.seq,
      time: spec.atMs,
      data: {
        message: { source: { provider: spec.provider, model: spec.model } },
        usage: {
          inputTokens: spec.input,
          outputTokens: spec.output,
          cacheReadTokens: spec.cacheRead,
          cacheWriteTokens: spec.cacheWrite,
        },
      },
    }),
  )
  writeFileSync(
    join(dir, 'session.v3.jsonl.zstd'),
    zstdCompressSync(Buffer.from(lines.join('\n') + '\n')),
  )
  return sessionsRoot
}

/** 写一份单价快照（`pricing.json`）—— 快照优先；没有快照就是「没有价」（`'none'`）。 */
function writePricing(
  home: string,
  prices: { provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; currency?: string }[],
): void {
  writeFileSync(
    join(home, 'pricing.json'),
    JSON.stringify({
      syncedAtMs: T0,
      prices: prices.map((p) => ({
        provider: p.provider,
        model: p.model,
        currency: p.currency ?? 'CNY',
        inputMicroPerKtok: p.input,
        outputMicroPerKtok: p.output,
        cacheReadMicroPerKtok: p.cacheRead,
        cacheWriteMicroPerKtok: p.cacheWrite,
        effectiveFromMs: 0,
        effectiveToMs: null,
      })),
    }),
  )
}

function contextOf(home: string, sessionsRoot: string, localDb = true): StatsContext {
  return {
    config: { localDb },
    sessionsRoots: [sessionsRoot],
    dbPath: join(home, 'usage.sqlite'),
    dataDir: home,
    // 刻意不用 worker 线程：本文件断言的是 `records()` 的语义，
    // 那条路径由 stats-worker.test.ts 单独覆盖（两边都是同一个 executeQuery）。
    backgroundQueries: false,
  }
}

/**
 * 一份三模型的数据：
 * - `dashscope/a`：**换过一次价**（T0 之后 1 小时生效的新价），逐条取价才正确；
 * - `dashscope/b`：有价；
 * - `other/c`：**一条价都没有** → 必须落进 unpricedTokens。
 */
const SPECS: EventSpec[] = [
  { seq: 1, atMs: T0, provider: 'dashscope', model: 'a', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
  { seq: 2, atMs: T0 + 2 * HOUR, provider: 'dashscope', model: 'a', input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
  { seq: 3, atMs: T0, provider: 'dashscope', model: 'b', input: 0, output: 0, cacheRead: 2000, cacheWrite: 0 },
  { seq: 4, atMs: T0, provider: 'other', model: 'c', input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
]

/** 老价 1000 微/千 token（各列同价），新价 2000 微/千 token，从 T0+1h 生效。 */
function writeSplitPrice(home: string): void {
  writeFileSync(
    join(home, 'pricing.json'),
    JSON.stringify({
      syncedAtMs: T0,
      prices: [
        { provider: 'dashscope', model: 'a', currency: 'CNY', inputMicroPerKtok: 1000, outputMicroPerKtok: 1000,
          cacheReadMicroPerKtok: 1000, cacheWriteMicroPerKtok: 1000, effectiveFromMs: 0, effectiveToMs: T0 + HOUR - 1 },
        { provider: 'dashscope', model: 'a', currency: 'CNY', inputMicroPerKtok: 2000, outputMicroPerKtok: 2000,
          cacheReadMicroPerKtok: 2000, cacheWriteMicroPerKtok: 2000, effectiveFromMs: T0 + HOUR, effectiveToMs: null },
        { provider: 'dashscope', model: 'b', currency: 'CNY', inputMicroPerKtok: 500, outputMicroPerKtok: 500,
          cacheReadMicroPerKtok: 500, cacheWriteMicroPerKtok: 500, effectiveFromMs: 0, effectiveToMs: null },
      ],
    }),
  )
}

describe('★ 金额取数：三条模式都必须拿得到事件', () => {
  /**
   * 金额是逐条事件折叠出来的，所以「拿不到事件」= 「金额全是未计价」。
   *
   * ⚠️ `executeQuery` 固定传 `rollup: query.summaryOnly ? 'summary' : true`，
   *    所以下面这两条 SQL 用例**天然**就是「持久快照已就位」的那两种配置
   *    （`rollup: true` 与 `rollup: 'summary'`）—— 也就是说 `session.totals()`
   *    与 `session.groups()` 走的是预聚合行，而 `records()` 必须仍然回查事实表。
   *    这正是「金额悄悄变成未计价」最可能发生的组合，所以两条各断言一次。
   *
   * 断言用 `cost.totalTokens === totals.total` 交叉验证：后者来自聚合（快照/SQL），
   * 前者来自逐条事件，两条路对得上才说明事件真的都拿到了。
   */
  for (const mode of ['local-db', 'scan'] as const) {
    test(`${mode}：records() 给出过滤后的全部事件，金额与 token 数一致`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'atr-cost-mode-'))
      try {
        const sessionsRoot = writeSessions(home, SPECS)
        writeSplitPrice(home)
        const ctx = contextOf(home, sessionsRoot, mode !== 'scan')
        const result = await executeQuery(ctx, { by: ['provider-model'] })

        expect(result.totals.total).toBe(4700)
        expect(result.cost.totalTokens).toBe(result.totals.total)
        expect(result.cost.pricedTokens + result.cost.unpricedTokens).toBe(result.cost.totalTokens)
        // 一条价都没配上的 `other/c` 只有 500 token，所以绝不是 100% 未计价
        expect(result.cost.unpricedTokens).toBe(500)
        expect(result.cost.unpricedTargets).toEqual(['other/c'])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  test('摘要模式（summaryOnly → rollup: summary）同样算得出金额', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-summary-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      writeSplitPrice(home)
      const result = await executeQuery(contextOf(home, sessionsRoot), { summaryOnly: true })
      expect(result.groups).toEqual([])
      expect(result.cost.totalTokens).toBe(4700)
      expect(result.cost.pricedTokens).toBe(4200)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('直扫降级路径（库路径被一个同名文件占住）也带得出金额', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-degraded-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      writeSplitPrice(home)
      const blocked = join(home, 'blocked')
      writeFileSync(blocked, 'not a directory')
      const result = await executeQuery(
        { ...contextOf(home, sessionsRoot), dbPath: join(blocked, 'usage.sqlite') },
        { by: ['provider-model'] },
      )
      expect(result.source).toBe('scan')
      expect(result.degradedReason).toBeTruthy()
      expect(result.cost.totalTokens).toBe(result.totals.total)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('★ 金额口径：逐条取价、多币种、未计价', () => {
  test('换价那一刻两侧的事件各按自己的价算（总量×均价必然算错）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-split-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      writeSplitPrice(home)
      const result = await executeQuery(contextOf(home, sessionsRoot), { by: ['provider-model'] })

      /**
       * `dashscope/a` 两条事件各 1100 token：
       * - T0 那条按 1000 微/千 → 1100 × 1000 / 1000 = 1100 微
       * - T0+2h 那条按 2000 微/千 → 2200 微
       * 合计 3300 微 = ¥0.0033。
       * 「总量 2200 token × 某个价」只能得到 2200 或 4400，两者都不对。
       */
      const row = result.groups[0]!.rows.find((r) => r.key === 'dashscope/a')!
      expect(row.cost?.costs).toEqual([{ currency: 'CNY', amountMicro: 3300, tokens: 2200 }])
      // `dashscope/b` 只有 2000 token 缓存读，单价 500 微/千 → 1000 微
      const rowB = result.groups[0]!.rows.find((r) => r.key === 'dashscope/b')!
      expect(rowB.cost?.costs).toEqual([{ currency: 'CNY', amountMicro: 1000, tokens: 2000 }])
      // 整体 = 3300 + 1000 = 4300 微 = ¥0.0043
      expect(result.cost.costs).toEqual([{ currency: 'CNY', amountMicro: 4300, tokens: 4200 }])
      expect(result.cost.unpricedTokens).toBe(500)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('★ 每一维度的每一行都拿得到金额（键必须逐一命中）', async () => {
    // 这条是本次改动最关键的护栏：分组行的金额靠 `get(row.key)` 拿。
    // 键一旦对不上，行上就没有金额字段 → 页面显示「未计价」，
    // 而使用者会以为「这段用量没配价」——一个数据错误被伪装成一条提示。
    const dims = ['provider', 'model', 'provider-model', 'project', 'session', 'day', 'hour'] as const
    for (const localDb of [true, false]) {
      const home = mkdtempSync(join(tmpdir(), 'atr-cost-keys-'))
      try {
        const sessionsRoot = writeSessions(home, SPECS)
        writeSplitPrice(home)
        const result = await executeQuery(contextOf(home, sessionsRoot, localDb), { by: [...dims] })
        const label = localDb ? 'SQL' : '直扫'
        expect(result.groups.map((g) => g.by)).toEqual([...dims])
        for (const group of result.groups) {
          expect(group.rows.length).toBeGreaterThan(0)
          for (const row of group.rows) {
            expect({ dim: group.by, key: row.key, hasCost: row.cost !== undefined })
              .toEqual({ dim: group.by, key: row.key, hasCost: true })
            // 交叉验证：行金额覆盖的 token 数必须等于行上的 token 总数。
            // 两个数一条来自 SQL 聚合、一条来自逐条事件折叠，对得上才说明键命中了。
            expect({ dim: group.by, key: row.key, tokens: row.cost!.totalTokens })
              .toEqual({ dim: group.by, key: row.key, tokens: row.total })
          }
        }
        expect(label).toBe(localDb ? 'SQL' : '直扫')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  })

  test('多币种各自累加，绝不换算、绝不相加', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-currency-'))
    try {
      const specs: EventSpec[] = [
        { seq: 1, atMs: T0, provider: 'p1', model: 'cny', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
        { seq: 2, atMs: T0, provider: 'p2', model: 'usd', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ]
      const sessionsRoot = writeSessions(home, specs)
      writePricing(home, [
        { provider: 'p1', model: 'cny', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, currency: 'CNY' },
        { provider: 'p2', model: 'usd', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, currency: 'USD' },
      ])
      const result = await executeQuery(contextOf(home, sessionsRoot), { by: ['provider'] })
      // 1000 token × 1e6 微/千 = 1e6 微 = 1 个货币单位，两个币种各 1
      expect(result.cost.costs).toEqual([
        { currency: 'CNY', amountMicro: 1_000_000, tokens: 1000 },
        { currency: 'USD', amountMicro: 1_000_000, tokens: 1000 },
      ])
      // 展示层用 ` + ` 连接，**没有**任何换算后的合计
      expect(formatUsage(result)).toContain('¥1.00 + $1.00')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('★ 一条价都没配上：costs 是空数组（不是 ¥0.00），unpricedRate 是 1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-unpriced-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      // 刻意不写 pricing.json，也刻意不配 `other/c` 的价 —— 两条路都要落在「未计价」
      const result = await executeQuery(contextOf(home, sessionsRoot), { by: ['provider-model'] })
      expect(result.cost.costs).toEqual([])
      expect(result.cost.unpricedRate).toBe(1)
      expect(result.cost.pricedTokens).toBe(0)
      expect(result.cost.unpricedTokens).toBe(4700)
      expect(result.cost.unpricedTargets).toEqual(['dashscope/a', 'dashscope/b', 'other/c'])
      // ★ 2026-10 起**不再有内置种子价兜底**：一条价都没有就是「没有价」——
      //   金额一位都不显示，并把「怎么才能有价」写进 note。
      expect(result.cost.pricing.pricingSource).toBe('none')
      expect(result.cost.note).toContain('没有可用的单价')

      const text = formatUsage(result)
      expect(text).toContain('费用（估算）  未计价')
      expect(text).not.toContain('¥0.00')
      expect(text).toContain('未计价      100.0%')
      expect(text).toContain('单价来源    未配单价（没有可用的单价，不显示金额）')
      expect(text).toContain('还没配单价')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('坏掉的快照整份拒收并告警，绝不拿别的价顶上', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-broken-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      writeFileSync(join(home, 'pricing.json'), '{ 这不是 JSON')
      const result = await executeQuery(contextOf(home, sessionsRoot), {})
      // 拒收 ⇒ 没有价（不是退回某个兜底价），并且说明怎么修
      expect(result.cost.pricing.pricingSource).toBe('none')
      expect(result.cost.note).toContain('解析失败')
      // 告警里必须点出「重新同步」，否则使用者只知道金额不对、不知道怎么办
      expect(result.cost.note).toContain('pricing sync')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('★ formatUsage：金额必须带着口径出现', () => {
  test('总计块有费用、口径、未计价比例、单价来源，并点明「估算 ≠ 财务账单」', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-text-'))
    try {
      const sessionsRoot = writeSessions(home, SPECS)
      writeSplitPrice(home)
      const result = await executeQuery(contextOf(home, sessionsRoot), { by: ['provider-model'] })
      const text = formatUsage(result)

      expect(text).toContain('=== 总计 ===')
      expect(text).toContain('费用（估算）  ¥0.0043')
      expect(text).toContain('cacheWrite×p_cw')
      expect(text).toContain('不等于财务账单')
      expect(text).toContain('未计价      10.6%')
      expect(text).toContain('单价来源    本机单价快照')
      expect(text).toContain('还没配单价  other/c')

      // 表格：金额列有值；未配价的那一行写「未计价」，绝不写 0
      expect(text).toContain('费用（估算）')
      expect(text).toContain('¥0.0033')
      expect(text).toContain('¥0.0010')
      expect(text).toContain('未计价')
      // 表头与数据行的金额列必须同宽（否则表格从这一列开始歪）
      const header = text.split('\n').find((line) => line.startsWith('KEY'))!
      const rowLine = text.split('\n').find((line) => line.startsWith('other/c'))!
      expect(header.length).toBe(rowLine.length)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('部分未计价的行带 *，表下必须解释 * 的含义', async () => {
    const home = mkdtempSync(join(tmpdir(), 'atr-cost-star-'))
    try {
      // 同一行里两个模型，只有一个配了价 → 该行部分未计价
      const specs: EventSpec[] = [
        { seq: 1, atMs: T0, provider: 'p', model: 'priced', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
        { seq: 2, atMs: T0, provider: 'p', model: 'free', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ]
      const sessionsRoot = writeSessions(home, specs)
      writePricing(home, [
        { provider: 'p', model: 'priced', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ])
      const text = formatUsage(await executeQuery(contextOf(home, sessionsRoot), { by: ['provider'] }))
      expect(text).toContain('¥1.00*')
      expect(text).toContain('该行有部分 token 没配单价')
      expect(text).toContain('**不是**剩余用量免费')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})