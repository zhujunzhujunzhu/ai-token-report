/**
 * 插件对外能力：**统计服务 + Agent 工具**。
 *
 * 这一层存在的理由是团队使用：装上插件之后，「我这段时间用了多少 token」
 * 不该只有看板能回答。两种消费方式对应两类消费者：
 *
 * | 消费者 | 入口 | 要不要写代码 |
 * |---|---|---|
 * | 团队同事（在对话里问） | `token_usage` 工具 | 不用 |
 * | 其它 DSH 插件 | `ctx.tokenReport` 服务 | 要 |
 *
 * ## 🚨 口径只有一份
 *
 * 本文件**不实现任何公式**。缓存命中率、缓存杠杆、平均用量全部来自
 * `@ai-token-report/shared` 的 `deriveMetrics()`（铁律 1）。
 * 在这里写一遍除法，就会出现第二个口径实现 —— 它不会报错，
 * 只会让「工具说的数」和「看板上的数」在某天悄悄分叉。
 *
 * ## 🚨 金额是**估算**，而且同样是「口径只有一份」
 *
 * 金额的取价与折叠来自 `core/db/cost.ts`（`loadLocalPricing` / `priceResolver` /
 * `costTotalsOf` / `costByGroupOf`），四类分价相乘与按币种分桶来自
 * `shared/price.ts`。本文件里**不出现 `/ 1e6`，也不做任何跨币种相加** ——
 * 出现在这里的每一个金额算术都会是第二个口径实现。
 *
 * 三条必须守住的语义：
 *
 * 1. **逐条事件按它自己的时刻取价**，再折叠。单价带生效区间，换价那一刻两侧的
 *    用量适用不同的价；写成「分组 token 总量 × 一个价」看起来完全正常，
 *    而它必然把换价前后的一段算错。
 * 2. **多币种各自累加、绝不换算、绝不相加**（展示用 ` + ` 连接）。
 * 3. **未计价的用量绝不当 0 元**：`unpricedRate` 与 `unpricedTargets` 必须显式出现。
 *    把「没配价」显示成 `¥0.00` 会让人以为省了钱 —— 这是本功能最危险的误读。
 *
 * 另外，**自建计价 ≠ 财务账单**（折扣 / 预付 / 赠送额度不在单价里），
 * 所以金额旁边永远要说清「按哪份单价算的」「覆盖了多少用量」。
 *
 * ## 两条数据源，且**如实标注**
 *
 * 1. `local-db`：本机 SQLite 增量库（`core/db`）—— 增量更新，支持 Bun 与 Node。
 * 2. `scan`：直接扫会话日志（`core/scanner`）—— 慢，但任何运行时都能跑。
 *
 * `source` 字段会如实带出去。**不允许**在降级时假装数据来自库：
 * 「这次为什么慢了 30 倍」这种问题，必须能从输出里直接看出来。
 */

import {
  aggregate,
  resolveRange,
  type GroupDimension,
  type SessionSource,
  type SourceRoot,
  type TokenCounts,
} from '@ai-token-report/core'
import {
  cacheHitRate,
  cacheLeverage,
  deriveMetrics,
  formatCostSummary,
  maskName,
  type CostSummary,
  type UsageMetrics,
} from '@ai-token-report/shared'

import {
  costByGroupOf,
  costTotalsOf,
  loadLocalPricing,
  openStats,
  priceResolver,
  unpricedTargetsOf,
  type CostTotalsWithTargets,
} from '@ai-token-report/core/db'

import type { EffectiveConfig } from './config.js'
import { queryInStatsWorker } from './stats-worker-client.js'

/** 数据来源。如实反映实际走的那条路径。 */
export type StatsSource = 'local-db' | 'scan' | 'none'

/** 工具可选的统计维度（与 CLI 的 `--by` 同义）。 */
export const TOOL_DIMENSIONS: GroupDimension[] = [
  'provider',
  'model',
  'provider-model',
  'project',
  'session',
  'day',
  'hour',
]

/** 一次统计查询的参数（已做过校验）。 */
export interface UsageQuery {
  /** 具名周期，与 CLI `--period` 完全同义（today / last7d / month / 中文别名…）。 */
  period?: string
  /** 显式起止时间；纯日期包含结束当天。 */
  since?: string
  until?: string
  /** 分组维度，默认 provider-model。 */
  by?: GroupDimension[]
  /** 只显示前 N 行。 */
  top?: number
  /** 分组分页偏移；总行数在截断前统计。 */
  offset?: number
  /** 常驻摘要只需要总计和精确会话数。 */
  summaryOnly?: boolean
  /** 手动刷新要求重新检查本地日志。 */
  refresh?: boolean
  /** 趋势粒度。给了就附带时间序列。 */
  series?: 'day' | 'hour'
  /** provider 子串过滤。 */
  provider?: string
  /** model 子串过滤。 */
  model?: string
}

/** 一个分组的输出行 —— 字段名刻意与 CLI 的 JSON 输出保持一致。 */
export interface UsageGroupRow {
  key: string
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
  sessions: number
  cacheHitRate: number
  /**
   * ★ 该分组的金额（估算），**四类分价相乘后按币种分桶**的结果。
   *
   * ⚠️ 可选，且缺席**不代表 0 元**：它只可能是「这个键在金额表里没有对应
   *    记录」。两者在展示层必须长得不一样（未计价 ≠ 免费）。
   *    金额本身可能为空桶（`costs: []`）= 这一组的用量一条价都没配上。
   */
  cost?: CostSummary
}

/**
 * 一次统计的金额：整体汇总 + **这份钱是按哪份单价算的**。
 *
 * `note` 非空 = 这一份价**不是**同步来的快照（没有快照 / 快照坏了 / 快照里一条价都没有）——
 * 必须显示给使用者：两个都「看起来正常」的金额拿去对账是最坏的结果。
 *
 * ★ 2026-10 起**不再有内置种子价兜底**：读不到可用单价就是 `pricingSource: 'none'` +
 *   空价表，展示层**一位金额都不显示**（详见 `shared/price.ts` 文件尾的三条理由）。
 */
export interface UsageCost extends CostTotalsWithTargets {
  note: string | null
}

/** 一次统计查询的结果。 */
export interface UsageResult {
  /** 实际数据来源。 */
  source: StatsSource
  /** 降级原因（例如本地库不可用）。 */
  degradedReason?: string
  /** 时间窗口描述（"今天" / "最近 7 天"…）。 */
  rangeLabel: string
  /** 解析后的绝对窗口，便于结果可复现。 */
  range: { since: number | null; until: number | null }
  /** 总计（四项 token 分列 + calls）。 */
  totals: TokenCounts
  /** ★ 派生指标：由 `shared/metrics.ts` 计算，不是本地重写的公式。 */
  metrics: UsageMetrics
  /**
   * ★ 金额（估算）。逐条事件按**它自己的时刻**取价后折叠 —— 见文件头。
   *
   * 它是必填的：算不出金额也要如实给出一份「一条价都没配上、覆盖 0%」的结果，
   * 让消费方永远能区分「没有金额字段（老宿主）」与「这段用量没配价」。
   */
  cost: UsageCost
  /** 分组排行。 */
  groups: { by: GroupDimension; rows: UsageGroupRow[]; rowCount?: number }[]
  /** 时间序列（可选）。 */
  series?: { bucket: string; total: number; input: number; output: number; cacheRead: number; calls: number; cacheHitRate: number }[]
  /** 涉及的会话数。 */
  sessions: number
  /** 扫描 / 查询耗时（毫秒）。 */
  elapsedMs: number
  /** 数据新鲜度（本地库路径才有意义）。 */
  scannedAt: number
}

/** 本次统计是否可用（供服务层快速判断，避免把异常抛给调用方）。 */
export interface StatsContext {
  config: Pick<EffectiveConfig, 'localDb'>
  /**
   * ★ 会话日志根 —— **一组**（同一台机器上并存多套 DSH）。
   *
   * 传给 `openStats` 的与 CLI `--dsh-home`（可重复）、本地页 `CoreStatsProvider`
   * 是**同一个**入参，所以三个形态的数字必然一致。
   */
  sessionsRoots: string[]
  /** 本地库路径。 */
  dbPath: string
  /**
   * ★ 本机数据目录 —— **单价快照（`pricing.json`）就在这里**。
   *
   * 金额必须能回答「按哪份单价算的」，而这份价是一份放在数据目录里的文件，
   * 所以数据目录不只是「库在哪」，它本身就是计价口径的一部分。
   * 与 `dbPath` / `sessionsRoots` 一样，一律经 `paths.ts` 的 `reportPaths()` 取，
   * 不要在各处重新拼路径。
   */
  dataDir: string
  /**
   * ★ **带来源的根**（多客户端）—— 由 `extra-sources.ts` 给出**全部已注册来源**。
   *
   * 给了它之后，DSH 走 zstd 分帧、其余来源走纯文本通路，两条路写进**同一张**
   * `usage_event`，靠 `source` 列区分，于是面板上的数字天然是「全部来源的并集」。
   *
   * ⚠️ 代价是**取数时会增量 ingest 这些来源的日志**（面板每 30 秒探一次）：
   *   首次冷扫会明显变慢（本机实测 Codex 1,495 个文件 / 2.8 GB），之后按文件
   *   字节数增量。这是**刻意接受**的 —— 少统计一个来源与「那台客户端没用量」
   *   在界面上长得一模一样，见 `extra-sources.ts` 文件头。
   */
  sourceRoots?: readonly SourceRoot[]
  /**
   * ★ **查询期来源清单**（`extra-sources.ts` 的 `statsSourceIds()` = 全部已注册来源）
   *   ——与 `sourceRoots` 是一对：根管「本次 ingest 谁」，这份清单管「本次算谁」。
   *
   * 🚨 为什么必须有：本地库是 CLI / 本地页 / 插件 / report **共用的一个文件**，
   *   库里天然躺着别的来源的行（CLI 跑过一次缺省运行就会有）。不传时
   *   `openStats()` 的缺省语义是「库里的全部来源」—— 那正是我们要的，
   *   但**显式给全量**才不会被「库里躺着的未知来源」冒充面板自己的数字
   *   （`db/stats.ts` 的 `narrowSources` 只在数量**少于**已注册来源数时才收窄，
   *   所以给全量同时保住了汇总表那条快路径）。
   */
  sources?: readonly SessionSource[]
  /** 白名单里**配了但不存在**的根：页面/日志要能分辨「没装」与「路径写错」。 */
  missingRoots?: readonly string[]
  /** DSH 宿主启用独立线程，直接调用方仍可使用当前线程。 */
  backgroundQueries?: boolean
  /** 查询等待上限（含排队）；默认两分钟，异常线程不能让宿主无限等待。 */
  queryTimeoutMs?: number
}

/**
 * 把分组结果转成输出行（派生指标交给 `shared`；金额交给 `core/db/cost.ts`）。
 *
 * @param buckets - 该**维度**下的金额表，键与 `aggregate` 的 `groupKey()` 逐字相同。
 *   没给（`summaryOnly` 或调用方只要 token 数）时行上不带金额字段。
 */
function toRows(
  rows: ReturnType<typeof aggregate>,
  buckets?: Map<string, CostSummary>,
): UsageGroupRow[] {
  return rows.map((r) => {
    const cost = buckets?.get(r.key)
    return {
      key: r.key,
      total: r.counts.total,
      input: r.counts.input,
      output: r.counts.output,
      cacheRead: r.counts.cacheRead,
      cacheWrite: r.counts.cacheWrite,
      calls: r.counts.calls,
      sessions: r.sessions,
      // ★ 命中率只认 shared 的实现，这里不写第二个口径
      cacheHitRate: cacheHitRate(r.counts),
      // ⚠️ 键命中不了就**不带**这个字段，绝不补一个 0 金额：
      //   「这一组没配上价」与「这一组是空的」在展示层必须能分开。
      ...(cost ? { cost } : {}),
    }
  })
}

/**
 * 执行一次统计查询。
 *
 * 不抛错（除参数非法外）：任何内部失败都降级为「直扫日志」并把原因带出去。
 */
// 同一个库的增量写入串行执行，避免多个周期/工具同时打开连接互相等写锁。
const pendingQueries = new Map<string, Promise<unknown>>()
export function queryUsage(ctx: StatsContext, query: UsageQuery = {}): Promise<UsageResult> {
  if (ctx.backgroundQueries) return queryInStatsWorker(ctx, query)
  const previous = pendingQueries.get(ctx.dbPath) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(() => executeQuery(ctx, query))
  pendingQueries.set(ctx.dbPath, task)
  void task.finally(() => {
    if (pendingQueries.get(ctx.dbPath) === task) pendingQueries.delete(ctx.dbPath)
  }).catch(() => {})
  return task
}

export async function executeQuery(ctx: StatsContext, query: UsageQuery, options: { readOnly?: boolean; changedFiles?: string[] } = {}): Promise<UsageResult> {
  const t0 = Date.now()

  // 时间窗解析复用 `core/range.ts` —— 保证「工具说的今天」与「CLI 说的今天」是同一段
  const range = resolveRange({ period: query.period, since: query.since, until: query.until })

  // 驱动选择集中在 core/db/driver.ts，构建时内联 core，运行时才加载 SQLite。
  const session = await openStats({
    sessionsRoot: ctx.sessionsRoots,
    dbPath: ctx.dbPath,
    // ★ 来源清单**任何情况都要给**（= 全部已注册来源，见 `extra-sources.ts`）：
    //   `openStats` 的 `sources` 缺省语义是「库里的全部来源」，而库是几个形态共用的
    //   一个文件 —— 不传就等于让库里躺着的未知来源冒充面板自己的数字。
    //   给**全量**在本仓与不传等价（`db/stats.ts` 的 `narrowSources` 只在数量少于
    //   已注册来源数时才收窄），所以汇总表那条快路径也保住了。
    sources: ctx.sources ?? ['dsh'],
    // ★ 带来源的根 = 本机全部已注册来源（DSH 的根用生效配置里那一组）。
    //   给了它才把其它来源并进来，并把它解析出来但**不存在**的根一并报出去。
    ...(ctx.sourceRoots !== undefined && ctx.sourceRoots.length > 0
      ? {
        sourceRoots: ctx.sourceRoots,
        ...(ctx.missingRoots !== undefined && ctx.missingRoots.length > 0
          ? { missingRoots: ctx.missingRoots }
          : {}),
      }
      : {}),
    forceScan: !ctx.config.localDb,
    rollup: query.summaryOnly ? 'summary' : true,
    readOnly: options.readOnly,
    changedFiles: options.changedFiles,
    ...(range.sinceMs !== undefined ? { sinceMs: range.sinceMs } : {}),
    ...(range.untilMs !== undefined ? { untilMs: range.untilMs } : {}),
    ...(query.provider ? { providers: [query.provider] } : {}),
    ...(query.model ? { models: [query.model] } : {}),
  })
  try {
    const source: StatsSource = session.source === 'sql' ? 'local-db'
      : session.diagnostics?.filesScanned === 0 ? 'none' : 'scan'
    const degradedReason = session.degradedReason
    const totals = session.totals()
    const dims = query.by && query.by.length > 0 ? query.by : (['provider-model'] as GroupDimension[])
    const top = query.top && query.top > 0 ? query.top : 30

    // ── 金额 ───────────────────────────────────────────────────────
    //
    // ★ 价从**本机数据目录**里的快照来；读不到就是**没有价**（`pricingSource: 'none'`，
    //   空价表 ⇒ 一位金额都不显示），原因由 `note` 如实带出去。
    //   2026-10 起不再有内置种子价兜底 —— 那个兜底会让面板显示一个看起来正常、
    //   但与部门看板不同的金额。
    //   插件读的是本机自己的价，所以面板上的金额与部门看板可能不同 ——
    //   这一点必须由 `pricing` 与 `note` 如实带出去，绝不假装两者同源。
    //
    // ★ 逐条事件按它自己的时刻取价：`records()` 给的是**过滤后**的全部事件，
    //   在 SQL / 直扫 / rollup 三条路径上都是同一批（rollup 只影响
    //   totals/groups/series，不影响 records）。绝不能改成「分组总量 × 一个价」。
    const pricing = loadLocalPricing({ dataDir: ctx.dataDir })
    const resolve = priceResolver(pricing.prices)
    const records = session.records()
    const cost: UsageCost = {
      ...costTotalsOf(records, resolve, pricing.provenance),
      unpricedTargets: unpricedTargetsOf(records, resolve),
      note: pricing.note,
    }

    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const groups = query.summaryOnly ? [] : dims.map((dim) => {
      const rows = session.groups(dim)
      // ★ 金额按**维度**各自建一次索引：分组桶的口径只此一份
      //   （`groupKey()`），所以同一个维度里的行可以直接 `get(row.key)`。
      //   不同维度必须各建一次 —— 拿 provider 维度的金额表去查 model 维度，
      //   键看起来都是字符串，只是永远命中不了。
      const buckets = costByGroupOf(records, dim, resolve, pricing.provenance)
      return { by: dim, rowCount: rows.length, rows: toRows(rows.slice(offset, offset + top), buckets) }
    })

    const result: UsageResult = {
      source,
      ...(degradedReason ? { degradedReason } : {}),
      rangeLabel: range.label,
      range: {
        since: range.sinceMs ?? null,
        until: range.untilMs ?? null,
      },
      totals,
      metrics: deriveMetrics(
        {
          input: totals.input,
          output: totals.output,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
          reasoning: totals.reasoning,
          total: totals.total,
        },
        totals.calls,
      ),
      cost,
      groups,
      sessions: session.sessions,
      elapsedMs: Date.now() - t0,
      scannedAt: session.scannedAt,
    }

    if (query.series && !query.summaryOnly) {
      result.series = session.series(query.series, false).map((p) => ({
        bucket: p.bucket,
        total: p.counts.total,
        input: p.counts.input,
        output: p.counts.output,
        cacheRead: p.counts.cacheRead,
        calls: p.counts.calls,
        cacheHitRate: cacheHitRate(p.counts),
      }))
    }

    result.elapsedMs = Date.now() - t0
    return result
  } finally {
    session.close()
  }
}

/** 缓存杠杆（单独导出，便于调用方不直接碰 shared 的签名）。 */
export function leverageOf(counts: Pick<TokenCounts, 'input' | 'cacheRead'>): number {
  return cacheLeverage(counts)
}

/**
 * 渲染成人/模型都能读的终端文本。
 *
 * 措辞上刻意保留「单位」与「口径」：同事看到 `95.2%` 时应当知道
 * 那是 `cacheRead/(cacheRead+input)`，而不是「缓存省了 95% 的钱」。
 *
 * ★ 金额同样必须带着口径出现（估算 / 未计价比例 / 单价来源）：
 *   只给一个 `¥12.35` 会让人拿它去对财务账单，而两者本来就对不上。
 */
export function formatUsage(result: UsageResult, options: { maskUser?: boolean } = {}): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  const lines: string[] = []

  lines.push(`AI token 用量  |  ${result.rangeLabel}`)
  lines.push(`数据来源  ${sourceLabel(result.source)}${result.degradedReason ? `（${result.degradedReason}）` : ''}`)
  lines.push(`耗时      ${result.elapsedMs}ms`)
  lines.push('')

  const t = result.totals
  const cost = result.cost
  lines.push('=== 总计 ===')
  lines.push(`  调用数        ${n(t.calls)}`)
  lines.push(`  计费总量      ${n(t.total)}   (input + output + cacheRead + cacheWrite)`)
  lines.push(`    未缓存输入  ${n(t.input)}`)
  lines.push(`    输出        ${n(t.output)}`)
  lines.push(`    缓存读      ${n(t.cacheRead)}`)
  lines.push(`    缓存写      ${n(t.cacheWrite)}`)
  lines.push(`  缓存命中率    ${(result.metrics.cacheHitRate * 100).toFixed(1)}%   = cacheRead/(cacheRead+input)`)
  lines.push(`  缓存杠杆      ${result.metrics.cacheLeverage.toFixed(1)}x`)
  lines.push(`  平均每次调用  ${Math.round(result.metrics.avgTokensPerCall)} tokens`)
  lines.push(`  涉及会话      ${n(result.sessions)}`)
  lines.push(...costLines(cost, n))

  for (const group of result.groups) {
    if (group.rows.length === 0) continue
    lines.push('')
    lines.push(`=== 按 ${group.by}（计费总量降序）===`)

    // ★ 金额列的宽度按**本表实际内容**取：多币种是 ` + ` 连起来的
    //   （`¥12.35 + $0.5000`），写死 13 会让整张表从这里开始错位。
    //   同一张表里表头与每一行必须用同一个宽度。
    const money = group.rows.map((row) => moneyCellOf(row))
    const moneyWidth = Math.max(13, '费用（估算）'.length, ...money.map((cell) => cell.length))

    lines.push(
      ['KEY', '总量', '未缓存输入', '输出', '缓存读', '调用', '命中率', '费用（估算）']
        .map((h, i) => (i === 0 ? h.padEnd(30) : i === 7 ? h.padStart(moneyWidth) : h.padStart(13)))
        .join(''),
    )
    group.rows.forEach((row, index) => {
      const key = options.maskUser ? maskName(row.key) : row.key
      lines.push(
        [
          (key.length > 28 ? `${key.slice(0, 27)}…` : key).padEnd(30),
          n(row.total).padStart(13),
          n(row.input).padStart(13),
          n(row.output).padStart(13),
          n(row.cacheRead).padStart(13),
          n(row.calls).padStart(13),
          `${(row.cacheHitRate * 100).toFixed(1)}%`.padStart(13),
          money[index]!.padStart(moneyWidth),
        ].join(''),
      )
    })
    // `*` 的含义必须写出来：没有它，读者无法区分
    // 「这一行金额就是全部花费」与「这一行只有一部分 token 配上了价」。
    if (money.some((cell) => cell.endsWith('*'))) {
      lines.push('  * 该行有部分 token 没配单价：金额只覆盖已计价的那部分，**不是**剩余用量免费。')
    }
  }

  if (result.series && result.series.length > 0) {
    lines.push('')
    lines.push('=== 趋势 ===')
    for (const p of result.series) {
      lines.push(`  ${p.bucket}  ${n(p.total).padStart(14)}  ${n(p.calls).padStart(6)} 次`)
    }
  }

  return lines.join('\n')
}

/**
 * 金额区块。
 *
 * 三条不准省：
 * 1. 一条价都没配上时金额写 **未计价**（绝不是 `¥0.00`）；
 * 2. `unpricedRate` 永远显式给出 —— 「未定价」看起来像「省了钱」；
 * 3. 读不到可用单价时（`pricingSource === 'none'`）把 `note` 抬头显示 ——
 *    否则使用者拿着与看板不一致的金额去对账。
 */
function costLines(cost: UsageCost, n: (v: number) => string): string[] {
  const lines: string[] = []
  const total = formatCostSummary(cost.costs)
  lines.push(`  费用（估算）  ${total ?? '未计价'}`)
  lines.push(
    '    口径        input×p_in + output×p_out + cacheRead×p_cr + cacheWrite×p_cw' +
      '（估算，不等于财务账单：折扣 / 预付 / 赠送额度不在单价里）',
  )
  if (cost.totalTokens > 0) {
    lines.push(
      `    未计价      ${(cost.unpricedRate * 100).toFixed(1)}%（${n(cost.unpricedTokens)} token 没算钱）`,
    )
  }
  lines.push(`    单价来源    ${pricingSourceLabel(cost)}`)
  if (cost.note !== null) lines.push(`    注意        ${cost.note}`)
  if (cost.unpricedTargets.length > 0) {
    // 只给比例不够：知道「有 12% 没算钱」却不知道去补哪个价，等于没给可行动信息。
    const shown = cost.unpricedTargets.slice(0, 3).join('、')
    const rest = cost.unpricedTargets.length - 3
    lines.push(
      `    还没配单价  ${shown}${rest > 0 ? ` 等 ${cost.unpricedTargets.length} 个` : ''}` +
        '（在部门看板「模型单价」页配上之后同步快照）',
    )
  }
  return lines
}

/** 表格里的金额单元格。`*` = 该行只有部分 token 配上了价（表下有说明）。 */
function moneyCellOf(row: UsageGroupRow): string {
  const text = row.cost ? formatRowCost(row.cost) : null
  return text ?? '未计价'
}

/**
 * 一个分组的金额单元格 —— **终端表格与界面面板共用这一份实现**。
 *
 * 返回 `null` = 这一组一条价都没配上：展示层必须写成「未计价」，
 * **绝不能写 `¥0.00`**（那就是把「没配价」说成「免费」）。
 * 返回值以 `*` 结尾 = 只有部分 token 配上了价（金额只覆盖已计价的那部分）。
 *
 * ⚠️ 两处各写一遍的风险不是报错，而是「终端说一部分未计价、面板说全额已计价」。
 */
export function formatRowCost(cost: CostSummary): string | null {
  const text = formatCostSummary(cost.costs)
  if (text === null) return null
  return cost.unpricedTokens > 0 ? `${text}*` : text
}

/** 「这份钱是按哪份单价算的」—— 同一次查询换个单价就是另一个金额，必须说出来。 */
function pricingSourceLabel(cost: UsageCost): string {
  const { pricingSource, pricingSyncedAt } = cost.pricing
  // 显式声明返回 `string`：以后 `PricingSource` 多一种来源时，
  // 这里会因为「不是所有分支都有返回」直接编译失败，而不是静默返回 undefined。
  switch (pricingSource) {
    case 'snapshot':
      return `本机单价快照（同步于 ${
        pricingSyncedAt !== null ? new Date(pricingSyncedAt).toLocaleString() : '未知时刻'
      }）`
    case 'db':
      return '服务端单价表'
    case 'none':
      // ★ 没有价就是没有价：这里的措辞要让人立刻明白「不是 0 元，是没配上价」。
      return '未配单价（没有可用的单价，不显示金额）'
  }
}

function sourceLabel(source: StatsSource): string {
  switch (source) {
    case 'local-db':
      return '本机 SQLite 库'
    case 'scan':
      return '直扫会话日志'
    case 'none':
      return '未找到任何会话日志'
  }
}
