/**
 * 上报库 **v10 闲时（低谷）价 + 基础价（不限供应商）** 的取数口径。
 *
 * ## 为什么这两件事必须单独一个文件、而且必须走**真库**
 *
 * 这两条规则都有**两份实现**：
 *
 * | 规则 | JS 侧 | SQL 侧 |
 * |---|---|---|
 * | 哪段时间算闲时 | `shared/price.ts` 的 `isPeakAt()` | `query.ts` 的 `slotExpressionSql()` 生成的 `CASE` |
 * | 基础价兜底 | `resolvePrice()`（专属优先、基础兜底） | `query.ts` 的两次 `LEFT JOIN`（`mp_e` / `mp_b`） |
 *
 * 两边漂移的表现全都是「金额悄悄不对」：SQL 侧把闲时当高峰 → 总览虚高一倍；
 * 两次 JOIN 写错（例如用 `OR` 匹配） → 一条事件被算两遍、token 翻倍。
 * 所以这里的断言是**手算出来的具体数字**，而且要刻意让「用错做法」也得出一个
 * **不同**的数（见每张表下面的对照数字）。
 *
 * ## 数据集（2026 年 2–3 月，全部用固定时刻，与运行机器的时区无关）
 *
 * 单价（微元 / 千 token；只给输入价，好手算）：
 *
 * | (provider, model) | 高峰输入 | 闲时输入 | 时段表 |
 * |---|---|---|---|
 * | `dashscope/m-flash` | 2000 | 1000 | `deepseek-cn` |
 * | `'*' / m-mix`（基础价） | 100 | 50 | `deepseek-cn` |
 * | `dashscope/m-mix`（专属价） | 700 | 350 | `deepseek-cn` |
 *
 * 事件（各 1000 input token ⇒ 金额 = 单价本身）：
 *
 * | # | (provider, model) | 北京时间 | 档 | 金额 |
 * |---|---|---|---|---|
 * | 1 | dashscope/m-flash | 2026-03-02（周一）10:00 | 高峰 | 2000 |
 * | 2 | dashscope/m-flash | 2026-03-02（周一）03:00 | 闲时 | 1000 |
 * | 3 | dashscope/m-flash | 2026-03-07（周六）10:00 | 闲时 | 1000 |
 * | 4 | dashscope/m-flash | 2026-02-17（周二，春节假期）10:00 | 闲时 | 1000 |
 * | 5 | dashscope/m-mix | 2026-03-02（周一）10:00 | 高峰·专属 | 700 |
 * | 6 | bailian-tpp/m-mix | 2026-03-02（周一）10:00 | 高峰·基础 | 100 |
 * | 7 | bailian-tpp/m-mix | 2026-03-02（周一）03:00 | 闲时·基础 | 50 |
 *
 * ⇒ 正确合计 **5850** 微元 / 7000 token。
 * 对照（都是**错的**做法，且数不同）：
 * - 不区分闲时（全按高峰）：2000+2000+2000+2000+700+100+100 = **8900**；
 * - 忽略节假日：2000+1000+1000+2000+700+100+50 = **6850**；
 * - 基础价用 `OR` 匹配（专属与基础都命中）：第 5 条被算两遍 ⇒ 更大；
 * - 基础价没生效（只按专属价查）：第 6/7 条落进未计价 ⇒ 未计价 token ≠ 0。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ANY_PROVIDER, priceRatesAt, resolvePrice, summarizeCosts, type ModelPrice } from '@ai-token-report/shared'

import { insertAttributedRecords, openPortalStore, type IngestRecord } from '../src/db/index.js'
import { openPortalStats } from '../src/db/portal.js'
import type { QueryFilter } from '../src/db/query.js'

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-portal-offpeak-'))
  dbPath = join(home, 'token-report', 'portal.sqlite')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 北京时间 → epoch 毫秒（固定 UTC+8；中国没有夏令时）。 */
const bj = (year: number, month: number, day: number, hour: number, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

const PEAK_AT = bj(2026, 3, 2, 10) // 周一 10:00（高峰窗内）
const OFFPEAK_AT = bj(2026, 3, 2, 3) // 周一 03:00（闲时）
const WEEKEND_AT = bj(2026, 3, 7, 10) // 周六 10:00（闲时）
const HOLIDAY_AT = bj(2026, 2, 17, 10) // 春节假期里的周二 10:00（闲时）

const WINDOW: QueryFilter = { sinceMs: Date.UTC(2026, 1, 1), untilMs: Date.UTC(2026, 3, 1) }

const FLASH_OFFPEAK = { inputMicroPerKtok: 1_000, outputMicroPerKtok: 4_000, cacheReadMicroPerKtok: 20, cacheWriteMicroPerKtok: 0 }
const MIX_BASE_OFFPEAK = { inputMicroPerKtok: 50, outputMicroPerKtok: 0, cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0 }
const MIX_EXACT_OFFPEAK = { inputMicroPerKtok: 350, outputMicroPerKtok: 0, cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0 }

/** 库里那三行价（内存形状，`resolvePrice` 用的就是它）。 */
const PRICES: readonly ModelPrice[] = [
  {
    provider: 'dashscope', model: 'm-flash', currency: 'CNY',
    inputMicroPerKtok: 2_000, outputMicroPerKtok: 8_000, cacheReadMicroPerKtok: 40, cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0, effectiveToMs: null,
    offpeakRates: FLASH_OFFPEAK, offpeakSchedule: 'deepseek-cn',
  },
  {
    provider: ANY_PROVIDER, model: 'm-mix', currency: 'CNY',
    inputMicroPerKtok: 100, outputMicroPerKtok: 0, cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0, effectiveToMs: null,
    offpeakRates: MIX_BASE_OFFPEAK, offpeakSchedule: 'deepseek-cn',
  },
  {
    provider: 'dashscope', model: 'm-mix', currency: 'CNY',
    inputMicroPerKtok: 700, outputMicroPerKtok: 0, cacheReadMicroPerKtok: 0, cacheWriteMicroPerKtok: 0,
    effectiveFromMs: 0, effectiveToMs: null,
    offpeakRates: MIX_EXACT_OFFPEAK, offpeakSchedule: 'deepseek-cn',
  },
]

interface SeedSpec { eventId: string; provider: string; model: string; ts: number }

const SEEDS: readonly SeedSpec[] = [
  { eventId: 'p1', provider: 'dashscope', model: 'm-flash', ts: PEAK_AT },
  { eventId: 'p2', provider: 'dashscope', model: 'm-flash', ts: OFFPEAK_AT },
  { eventId: 'p3', provider: 'dashscope', model: 'm-flash', ts: WEEKEND_AT },
  { eventId: 'p4', provider: 'dashscope', model: 'm-flash', ts: HOLIDAY_AT },
  { eventId: 'p5', provider: 'dashscope', model: 'm-mix', ts: PEAK_AT },
  { eventId: 'p6', provider: 'bailian-tpp', model: 'm-mix', ts: PEAK_AT },
  { eventId: 'p7', provider: 'bailian-tpp', model: 'm-mix', ts: OFFPEAK_AT },
]

/** 每条事件 1000 input token ⇒ 金额（微元）= 该时刻适用的输入单价。 */
async function seed(): Promise<void> {
  const store = await openPortalStore({ sqlitePath: dbPath })
  try {
    const now = Date.UTC(2026, 3, 1)
    let i = 0
    for (const price of PRICES) {
      const offpeak = price.offpeakRates ?? null
      await store.run(
        `INSERT INTO model_price (
           price_id, provider, model, currency,
           input_micro_per_ktok, output_micro_per_ktok,
           cache_read_micro_per_ktok, cache_write_micro_per_ktok,
           offpeak_schedule, offpeak_input_micro_per_ktok, offpeak_output_micro_per_ktok,
           offpeak_cache_read_micro_per_ktok, offpeak_cache_write_micro_per_ktok,
           effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms
         ) VALUES ($id, $provider, $model, $currency, $input, $output, $cr, $cw,
           $schedule, $opInput, $opOutput, $opCr, $opCw, $from, $to, NULL, $now, $now)`,
        {
          $id: `00000000-0000-4000-8000-00000000000${i++}`,
          $provider: price.provider, $model: price.model, $currency: price.currency,
          $input: price.inputMicroPerKtok, $output: price.outputMicroPerKtok,
          $cr: price.cacheReadMicroPerKtok, $cw: price.cacheWriteMicroPerKtok,
          $schedule: price.offpeakSchedule ?? null,
          $opInput: offpeak?.inputMicroPerKtok ?? null, $opOutput: offpeak?.outputMicroPerKtok ?? null,
          $opCr: offpeak?.cacheReadMicroPerKtok ?? null, $opCw: offpeak?.cacheWriteMicroPerKtok ?? null,
          $from: price.effectiveFromMs, $to: price.effectiveToMs, $now: now,
        },
      )
    }
    const records: IngestRecord[] = SEEDS.map((seedItem, index) => ({
      event_id: seedItem.eventId,
      session_id: 'sess-offpeak',
      seq: index + 1,
      ts: seedItem.ts,
      provider: seedItem.provider,
      model: seedItem.model,
      input_tokens: 1_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cwd: 'D:\\Coding\\ai-token-report',
      turn: 1,
      step: 1,
    }))
    await insertAttributedRecords(store, records, { userId: '张三', userName: '张三', groupName: '研发一部' })
  } finally {
    await store.close()
  }
}

async function withCost<T>(fn: (s: Awaited<ReturnType<typeof openPortalStats>>) => Promise<T> | T): Promise<T> {
  const session = await openPortalStats({ sqlitePath: dbPath }, WINDOW, undefined, true)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

describe('闲时价：SQL 侧时段判定与 JS 侧逐事件定价必须逐位一致', () => {
  test('★ 总览金额 = 手算值 5850（六个错做法都得出不同的数）', async () => {
    await seed()
    const cost = await withCost((s) => s.costTotals())
    expect(cost).not.toBeNull()
    expect(cost!.costs).toEqual([{ currency: 'CNY', amountMicro: 5_850, tokens: 7_000 }])
    // 全部都有价：一条都不许落进未计价
    expect(cost!.unpricedTokens).toBe(0)
    expect(cost!.pricedTokens).toBe(7_000)
    expect(cost!.unpricedTargets).toEqual([])
  })

  test('★ 与「逐条事件在 JS 侧取价再折叠」的结果逐位相同（两份实现的对照）', async () => {
    await seed()
    const sql = (await withCost((s) => s.costTotals()))!
    // JS 侧：每条事件按它自己的时刻取价（`resolvePrice` → `priceRatesAt`）
    const parts = SEEDS.map((item) => {
      const price = resolvePrice(PRICES, item.provider, item.model, item.ts)
      return {
        usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        price,
        rates: price === null ? null : priceRatesAt(price, item.ts),
      }
    })
    const js = summarizeCosts(parts)
    expect(sql.costs).toEqual(js.costs)
    expect(sql.pricedTokens).toBe(js.pricedTokens)
    expect(sql.unpricedTokens).toBe(js.unpricedTokens)
  })

  test('★ 按 (provider, model) 分组的金额：专属价与基础价各自成行、互不串价', async () => {
    await seed()
    const byTarget = await withCost((s) => s.costByGroup('provider-model'))
    const amountOf = (key: string): number => byTarget.get(key)!.costs[0]?.amountMicro ?? 0
    expect(amountOf('dashscope/m-flash')).toBe(5_000) // 2000 + 1000 + 1000 + 1000
    expect(amountOf('dashscope/m-mix')).toBe(700) // 专属价（高峰）
    expect(amountOf('bailian-tpp/m-mix')).toBe(150) // 基础价（高峰 100 + 闲时 50）
  })

  test('★ 明细逐条金额按各自时刻取档（同页同一模型可以一行 2000、一行 1000）', async () => {
    await seed()
    const page = await withCost((s) => s.records(100, 0))
    const amountOf = (eventId: string): number =>
      page.rows.find((row) => row.eventId === eventId)?.cost?.amountMicro ?? -1
    expect(amountOf('p1')).toBe(2_000) // 周一高峰
    expect(amountOf('p2')).toBe(1_000) // 周一闲时
    expect(amountOf('p3')).toBe(1_000) // 周六
    expect(amountOf('p4')).toBe(1_000) // 春节假期里的工作日高峰窗
    expect(amountOf('p5')).toBe(700)
    expect(amountOf('p6')).toBe(100)
    expect(amountOf('p7')).toBe(50)
  })

  test('★ 趋势（day 维度）逐事件取价：三天的金额分别是 2000 / 2000 / 1000+50', async () => {
    await seed()
    const costs = await withCost((s) => s.costByGroup('day'))
    const amountOf = (day: string): number => costs.get(day)!.costs[0]?.amountMicro ?? 0
    // 2026-03-02 周一：p1(2000) + p5(700) + p6(100) = 2800
    expect(amountOf('2026-03-02')).toBe(2_800)
    // 2026-03-07 周六：p3 = 1000
    expect(amountOf('2026-03-07')).toBe(1_000)
    // 2026-02-17 春节：p4 = 1000
    expect(amountOf('2026-02-17')).toBe(1_000)
  })
})

describe('基础价（不限供应商）：SQL 的两次 JOIN 必须与 resolvePrice 同语义', () => {
  test('★ 有专属价时基础价**不参与**（否则一条事件被算两遍）', async () => {
    await seed()
    const byTarget = await withCost((s) => s.costByGroup('provider-model'))
    // `dashscope/m-mix` 只有 p5 一条事件：专属价 700；若基础价也命中会变成 700+100=800
    expect(byTarget.get('dashscope/m-mix')!.costs[0]!.amountMicro).toBe(700)
    expect(byTarget.get('dashscope/m-mix')!.costs[0]!.tokens).toBe(1_000)
  })

  test('★ 没有专属价的供应商落到基础价（这正是「不选供应商」的用途）', async () => {
    await seed()
    const byTarget = await withCost((s) => s.costByGroup('provider-model'))
    const row = byTarget.get('bailian-tpp/m-mix')!
    // 高峰 100 + 闲时 50，两条事件都算上了、而且都落在基础价这一行
    expect(row.costs).toEqual([{ currency: 'CNY', amountMicro: 150, tokens: 2_000 }])
    expect(row.unpricedTokens).toBe(0)
  })

  test('★ 只配了基础价时，金额与 token 都不会翻倍（`OR` 式 JOIN 的对照）', async () => {
    await seed()
    const totals = (await withCost((s) => s.costTotals()))!
    // 总 token 必须等于事件数 × 1000：漏 JOIN 会少、`OR` 匹配会多
    expect(totals.totalTokens).toBe(7_000)
  })
})
