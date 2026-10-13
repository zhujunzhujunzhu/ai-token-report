/**
 * ★ **来源筛选**（面板工具栏那个下拉 / `token_usage` 的 `source` 参数 / `ctx.tokenReport`）。
 *
 * ## 这个文件在守什么
 *
 * 面板并把全部已注册来源（DSH + Codex + Claude Code + …）一起统计之后，
 * 一屏数字回答得了「本机总用量」，回答不了「这些几乎全是 Codex 跑的」。
 * 于是有了这个筛选 —— 它有三条**错了不会报错**的边界，正是这里要钉的：
 *
 * 1. **默认（`sources` 缺省 / 空数组 / 全量）必须与筛选存在之前逐位相同**
 *    —— 筛选是「视图状态」，不是新的统计口径。
 * 2. **未注册的来源必须当场报错**，不能静默变成「不过滤」：
 *    `sources: ['Codex']`（大小写打错）在「取交集」的写法下交集为空，
 *    而空交集在 `openStats` 那边**等于不过滤** —— 于是它安静地返回**全部来源**的数，
 *    数字变大、不报错、与「筛了但只有这些」长得一样。
 * 3. **筛选只收窄查询，不碰采集与上报**：筛过一轮之后，不带筛选的那一轮
 *    必须还能看到全部来源（说明来源 `sourceRoots` 没被筛选改动过）。
 *
 * 数据是**真日志**：一份 DSH 会话 + 一份 Codex rollout，让 `ingest` 自己把它们
 * 写进同一个本地库 —— 库里「别的来源的行」这件事只有真路径造得出来
 * （`insertRecords` 对非 `dsh` 来源是硬拒绝的，见 `stats-worker.test.ts`）。
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { resolveSourceRoots } from '@ai-token-report/core'

import { executeQuery, formatUsage, type StatsContext, type UsageQuery } from '../src/stats.js'

let root: string
/** 一份 DSH 会话日志：input 2,000（未缓存），计费总量 2,000。 */
let dshTotal: number
/** 一份 Codex rollout：total_token_usage 1,050（含缓存 800），计费总量 1,050。 */
let codexTotal: number
let ctx: StatsContext

const CODEX_SESSION_ID = '11111111-2222-3333-4444-555555555555'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atr-source-filter-'))
  const sessionsRoot = join(root, 'sessions')
  const dataDir = join(root, 'data')
  const codexHome = join(root, 'codex-home')

  // ── DSH：三层目录 + zstd 帧 ───────────────────────────────────────────
  const dshDir = join(sessionsRoot, 'project', 's-dsh')
  mkdirSync(dshDir, { recursive: true })
  writeFileSync(join(dshDir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({
    type: 'assistant/message', seq: 1, time: Date.now(),
    data: { usage: { inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { provider: 'dashscope', model: 'm' } } },
  }) + '\n')))
  dshTotal = 2_000

  // ── Codex：rollout JSONL（纯文本来源，走 `ingestPlainSources()`）────────
  const dayDir = join(codexHome, 'sessions', '2026', '01', '01')
  mkdirSync(dayDir, { recursive: true })
  const envelope = (ordinal: number, type: string, payload: unknown, at: string) =>
    JSON.stringify({ timestamp: at, ordinal, type, payload })
  writeFileSync(join(dayDir, `rollout-2026-01-01T00-00-00-${CODEX_SESSION_ID}.jsonl`), [
    envelope(0, 'session_meta', { session_id: CODEX_SESSION_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/work/codex', model_provider: 'openai' }, '2026-01-01T00:00:00.000Z'),
    envelope(1, 'turn_context', { model: 'gpt-5-codex', cwd: '/work/codex' }, '2026-01-01T00:00:00.500Z'),
    envelope(2, 'event_msg', { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1_000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1_050 },
      total_token_usage: { input_tokens: 1_000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1_050 },
    } }, '2026-01-01T00:00:01.000Z'),
  ].join('\n') + '\n')
  codexTotal = 1_050

  mkdirSync(dataDir, { recursive: true })
  ctx = {
    config: { localDb: true },
    sessionsRoots: [sessionsRoot],
    dbPath: join(root, 'usage.sqlite'),
    dataDir,
    // ★ 来源清单一**显式**给：给出即接管环境开关（测试 preload 把所有非 DSH 来源关了，
    //   见 `scripts/test-preload.ts`），于是这里不必去动环境变量。
    sources: ['dsh', 'codex'],
    // ★ DSH 的根**必须自己放进 `sourceRoots`**：给了 `sourceRoots` 之后
    //   `openStats` 就只从它里面取 DSH 的根（`sessionsRoots` 那条路被接管了，
    //   见 `core/db/stats.ts`）—— 漏掉它的表现正是「DSH 一条都不统计」，
    //   而这个夹具如果只用 Codex 的根，就会把那个 bug 当成「筛选生效了」。
    sourceRoots: [
      { source: 'dsh', path: sessionsRoot },
      ...resolveSourceRoots({ sources: ['codex'], homes: { codex: [codexHome] } }).roots,
    ],
    backgroundQueries: false,
  }
})

/** 跑一轮统计，返回计费总量与调用数。 */
async function totals(query: UsageQuery): Promise<{ total: number; calls: number }> {
  const result = await executeQuery(ctx, { ...query, summaryOnly: true })
  return { total: result.totals.total, calls: result.totals.calls }
}

describe('来源筛选：查询期收窄，缺省 = 全部来源', () => {
  test('★ 缺省（不给 `sources`）统计**全部已注册来源**，两个来源的行都在', async () => {
    const all = await totals({})
    expect(all.calls).toBe(2)
    expect(all.total).toBe(dshTotal + codexTotal)
  })

  test('`sources: []` 与缺省**逐位相同**（空 = 不过滤，不是「一个都不要」）', async () => {
    expect(await totals({ sources: [] })).toEqual(await totals({}))
  })

  test('`sources` 给全量注册来源时同样等价于缺省（不因为「显式」而走另一条路）', async () => {
    expect(await totals({ sources: ['dsh', 'codex'] })).toEqual(await totals({}))
  })

  test('只筛 Codex：DSH 的两千 tokens 一位都不许算进来', async () => {
    expect(await totals({ sources: ['codex'] })).toEqual({ total: codexTotal, calls: 1 })
  })

  test('只筛 DSH：Codex 那一千零五十同样一位都不许算进来', async () => {
    expect(await totals({ sources: ['dsh'] })).toEqual({ total: dshTotal, calls: 1 })
  })

  test('★ 未注册的来源**当场抛错**，绝不静默回落成「全部来源」', async () => {
    // 大小写打错是这个陷阱最容易踩的形态：`['Codex']` 取交集后为空，
    // 而空交集在 `openStats` 那边等于不过滤 —— 那样它会返回全部来源的数。
    await expect(executeQuery(ctx, { sources: ['Codex'], summaryOnly: true })).rejects.toThrow('未注册的来源：Codex')
    await expect(executeQuery(ctx, { sources: ['dsh', 'bogus'], summaryOnly: true })).rejects.toThrow('bogus')
  })

  test('★ 筛选**只收窄查询**：筛过之后不带筛选的那一轮仍然看得到全部来源', async () => {
    await totals({ sources: ['codex'] })
    // 采集范围（`sourceRoots`）没有被筛选改坏 —— 否则这里会少掉一个来源，
    // 而症状是「切过一次筛选，别的客户端就再也不统计了」且**不报错**。
    expect(await totals({ sources: ['codex'] })).toEqual({ total: codexTotal, calls: 1 })
    expect(await totals({})).toEqual({ total: dshTotal + codexTotal, calls: 2 })
  })

  test('筛选与其它过滤条件叠加（provider 子串 + 来源）', async () => {
    expect(await totals({ sources: ['codex'], provider: 'openai' })).toEqual({ total: codexTotal, calls: 1 })
    // DSH 那两个事件是 `dashscope`：按 openai 过滤 + 只筛 DSH ⇒ 如实的 0，
    // 而不是「过滤没生效」。
    expect(await totals({ sources: ['dsh'], provider: 'openai' })).toEqual({ total: 0, calls: 0 })
  })
})

describe('来源筛选：明细维度与趋势也一致', () => {
  test('分组结果里只有被筛中的来源的行', async () => {
    const result = await executeQuery(ctx, { sources: ['codex'], by: ['provider-model'] })
    const rows = result.groups.flatMap((group) => group.rows)
    expect(rows.length).toBe(1)
    expect(rows[0]!.total).toBe(codexTotal)
  })

  test('★ 工具/面板拿得到「本机注册了哪些来源」的候选（下拉就靠它）', async () => {
    // `ctx.sources` 是活取值（`index.ts` 的 getter），筛选的可选范围与查询的
    // 实际收窄永远是同一组 —— 两处各写一份的结果是「下拉里能选、查出来是 0」。
    expect(ctx.sources).toEqual(['dsh', 'codex'])
  })
})

/**
 * ★ **直扫路径**（`--no-db`，或库打不开时的降级目标）。
 *
 * 这条路径曾经**完全忽略**来源筛选：`openStats` 里那份 `sources` 只喂给库查询，
 * 而直扫那边照旧扫全部根、把全部记录都算进去。表现是**数字变大且不报错** ——
 * 「筛了 Codex 却拿到 DSH+Codex」与「筛了 Codex、而本机本来就只有这些」
 * 在输出上分不开。实测出处：`verify-plugin.ts` 的 `?source=codex` 回落成了
 * DSH 的 1,110（库那一步失败后自动直扫）。
 */
describe('★ 直扫路径同样收窄（降级不等于丢掉筛选）', () => {
  /** 强制直扫：`config.localDb = false` ⇒ `executeQuery` 传 `forceScan`。 */
  const scanned = async (query: UsageQuery, override: Partial<StatsContext> = {}) => {
    const result = await executeQuery({ ...ctx, config: { localDb: false }, ...override }, { ...query, summaryOnly: true })
    return { total: result.totals.total, calls: result.totals.calls, source: result.source }
  }

  test('缺省 = 全部来源（两份日志都直扫进来）', async () => {
    expect(await scanned({})).toEqual({ total: dshTotal + codexTotal, calls: 2, source: 'scan' })
  })

  test('★ 只筛 Codex：DSH 那两千在直扫路径上同样一位都不许算', async () => {
    expect(await scanned({ sources: ['codex'] })).toEqual({ total: codexTotal, calls: 1, source: 'scan' })
  })

  test('只筛 DSH：Codex 的一千零五十同样不许算', async () => {
    expect(await scanned({ sources: ['dsh'] })).toEqual({ total: dshTotal, calls: 1, source: 'scan' })
  })

  test('★ 筛一个**没有 root** 的来源：如实的 0，绝不把 DSH 的数字交出去', async () => {
    const dshOnlyRoots = ctx.sourceRoots!.filter((root) => root.source === 'dsh')
    // ⚠️ 只断言数字：`source` 在「一个根都没得扫」时会如实报 `none`
    //    （= 什么都没找到），而不是 `scan`。形状不是这里要钉的东西。
    const noRoot = await scanned({ sources: ['codex'] }, { sourceRoots: dshOnlyRoots })
    expect({ total: noRoot.total, calls: noRoot.calls }).toEqual({ total: 0, calls: 0 })
    // 旧调用方（没给 `sourceRoots`，只有 DSH 的 `sessionsRoots`）那条分支也是同一个答案
    const legacyShape = await scanned({ sources: ['codex'] }, { sourceRoots: undefined })
    expect({ total: legacyShape.total, calls: legacyShape.calls }).toEqual({ total: 0, calls: 0 })
    expect(await scanned({}, { sourceRoots: undefined }))
      .toEqual({ total: dshTotal, calls: 1, source: 'scan' })
  })
})

/**
 * 文本输出（`token_usage` 工具 / 终端）。
 *
 * 同一句「今天用了多少」在筛选前后的答案不同，而结果文本里没有别的痕迹能区分
 * 它们 —— 数字变小会被读成「用量降了」。所以筛了来源就必须写出来。
 */
describe('来源筛选：文本里必须显式写出来', () => {
  test('筛了来源 → 结果里多一行「来源筛选」并带上口径说明', async () => {
    const result = await executeQuery(ctx, { sources: ['codex'], summaryOnly: true })
    const text = formatUsage(result, { sources: ['codex'] })
    expect(text).toContain('来源筛选  codex（只统计这些来源；缺省 = 全部已注册来源）')
  })

  test('没筛 → 那一行不出现（默认形态与筛选存在之前逐字相同）', async () => {
    const result = await executeQuery(ctx, { summaryOnly: true })
    expect(formatUsage(result)).not.toContain('来源筛选')
    expect(formatUsage(result, { sources: [] })).not.toContain('来源筛选')
  })
})
