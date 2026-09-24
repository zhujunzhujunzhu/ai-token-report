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
 * ## 两条数据源，且**如实标注**
 *
 * 1. `local-db`：本机 SQLite 增量库（`core/db`）—— 快，但**依赖宿主是 Bun**。
 * 2. `scan`：直接扫会话日志（`core/scanner`）—— 慢，但任何运行时都能跑。
 *
 * `source` 字段会如实带出去。**不允许**在降级时假装数据来自库：
 * 「这次为什么慢了 30 倍」这种问题，必须能从输出里直接看出来。
 */

import {
  aggregate,
  resolveRange,
  scanAll,
  timeSeries,
  totalOf,
  type GroupDimension,
  type TokenCounts,
  type UsageRecord,
} from '@ai-token-report/core'
import {
  cacheHitRate,
  cacheLeverage,
  deriveMetrics,
  maskName,
  type UsageMetrics,
} from '@ai-token-report/shared'

import type { EffectiveConfig } from './config.js'

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
  /** 分组维度，默认 provider-model。 */
  by?: GroupDimension[]
  /** 只显示前 N 行。 */
  top?: number
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
  /** 分组排行。 */
  groups: { by: GroupDimension; rows: UsageGroupRow[] }[]
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
  config: EffectiveConfig
  /** 会话日志根目录。 */
  sessionsRoot: string
  /** 本地库路径。 */
  dbPath: string
}

/**
 * 本地库查询的**动态**入口。
 *
 * ## 为什么这里要绕这么多弯（🚨 改这段前先读懂）
 *
 * `core/db` 依赖 **`bun:sqlite`** —— 那是 Bun 专有的内建模块，
 * 而 **DSH 宿主跑在 Node 上**。所以：
 *
 * - **顶层 `import` 不行**：Node 加载插件时就会 `ERR_UNKNOWN_BUILTIN_MODULE`，
 *   整个插件（连同上报）直接挂掉。
 * - **`await import('@ai-token-report/core/db')` 也不行**：打包器（bun build）
 *   会**静态识别**这个字面量说明符并把 `bun:sqlite` 提到产物的顶层 import，
 *   等于绕了一圈又回到「加载即失败」。
 *
 * 解决办法是让说明符在**构建期不可静态分析**：用变量拼出来，
 * 打包器就只能原样保留成运行时的动态 import。Node 真正执行到这行时
 * （只有 `localDb: true` 才会走到）才会失败，而失败被 catch 成降级。
 *
 * ★ 这正是「库是派生物，不是真值」的落点：它坏了不该拖垮别的功能。
 */
async function importDbModule(): Promise<{
  openStats: (opts: {
    sessionsRoot: string
    dbPath: string
    period?: string
    providers?: string[]
    models?: string[]
  }) => Promise<DbStatsSession>
}> {
  const specifier = ['@ai-token-report', 'core', 'db'].join('/')
  return (await import(/* @vite-ignore */ specifier)) as Awaited<ReturnType<typeof importDbModule>>
}

/** `core/db` 的 `StatsSession` 里我们真正用到的那几个成员。 */
interface DbStatsSession {
  records(): UsageRecord[]
  source: string
  degradedReason?: string
  close(): void
}

async function tryOpenStats(
  ctx: StatsContext,
  query: UsageQuery,
): Promise<{ records: UsageRecord[]; source: StatsSource; degradedReason?: string } | null> {
  if (!ctx.config.localDb) return null
  try {
    const mod = await importDbModule()
    const session = await mod.openStats({
      sessionsRoot: ctx.sessionsRoot,
      dbPath: ctx.dbPath,
      ...(query.period ? { period: query.period } : {}),
      ...(query.provider ? { providers: [query.provider] } : {}),
      ...(query.model ? { models: [query.model] } : {}),
    })
    try {
      // 物化记录后统一交给 `aggregate` / `timeSeries` —— 与直扫路径**同一套聚合**，
      // 因此两条路径的结果必然一致（`verify-db-parity.ts` 就是断言这一点）
      return {
        records: session.records(),
        source: session.source === 'sql' ? 'local-db' : 'scan',
        ...(session.degradedReason ? { degradedReason: session.degradedReason } : {}),
      }
    } finally {
      session.close()
    }
  } catch (err) {
    // 库加载失败（Node 宿主没有 bun:sqlite / SQLITE_CORRUPT …）→ 降级直扫
    return {
      records: [],
      source: 'scan',
      degradedReason: `本地库不可用（${err instanceof Error ? err.message : String(err)}），已降级为直扫日志`,
    }
  }
}

/** 把分组结果转成输出行（派生指标交给 `shared`）。 */
function toRows(rows: ReturnType<typeof aggregate>): UsageGroupRow[] {
  return rows.map((r) => ({
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
  }))
}

/**
 * 执行一次统计查询。
 *
 * 不抛错（除参数非法外）：任何内部失败都降级为「直扫日志」并把原因带出去。
 */
export async function queryUsage(ctx: StatsContext, query: UsageQuery = {}): Promise<UsageResult> {
  const t0 = Date.now()

  // 时间窗解析复用 `core/range.ts` —— 保证「工具说的今天」与「CLI 说的今天」是同一段
  const range = resolveRange(query.period ? { period: query.period } : {})

  let degradedReason: string | undefined
  let source: StatsSource = 'scan'
  let records: UsageRecord[]

  const fromDb = await tryOpenStats(ctx, query)
  if (fromDb && fromDb.source === 'local-db') {
    records = fromDb.records
    source = 'local-db'
  } else {
    degradedReason = fromDb?.degradedReason
    const scanned = await scanAll(ctx.sessionsRoot, {
      ...(query.provider ? { providers: [query.provider] } : {}),
      ...(query.model ? { models: [query.model] } : {}),
      ...(range.sinceMs !== undefined ? { sinceMs: range.sinceMs } : {}),
      ...(range.untilMs !== undefined ? { untilMs: range.untilMs } : {}),
    })
    records = scanned.records
    source = records.length === 0 && scanned.diagnostics.filesScanned === 0 ? 'none' : 'scan'
  }

  const totals = totalOf(records)
  const dims = query.by && query.by.length > 0 ? query.by : (['provider-model'] as GroupDimension[])
  const top = query.top && query.top > 0 ? query.top : 30

  const groups = dims.map((dim) => ({
    by: dim,
    rows: toRows(aggregate(records, dim)).slice(0, top),
  }))

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
    groups,
    sessions: new Set(records.map((r) => r.sessionId)).size,
    elapsedMs: Date.now() - t0,
    scannedAt: Date.now(),
  }

  if (query.series) {
    result.series = timeSeries(records, query.series, false).map((p) => ({
      bucket: p.bucket,
      total: p.counts.total,
      input: p.counts.input,
      output: p.counts.output,
      cacheRead: p.counts.cacheRead,
      calls: p.counts.calls,
      cacheHitRate: cacheHitRate(p.counts),
    }))
  }

  return result
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
 */
export function formatUsage(result: UsageResult, options: { maskUser?: boolean } = {}): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  const lines: string[] = []

  lines.push(`DSH token 用量  |  ${result.rangeLabel}`)
  lines.push(`数据来源  ${sourceLabel(result.source)}${result.degradedReason ? `（${result.degradedReason}）` : ''}`)
  lines.push(`耗时      ${result.elapsedMs}ms`)
  lines.push('')

  const t = result.totals
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

  for (const group of result.groups) {
    if (group.rows.length === 0) continue
    lines.push('')
    lines.push(`=== 按 ${group.by}（计费总量降序）===`)
    lines.push(
      ['KEY', '总量', '未缓存输入', '输出', '缓存读', '调用', '命中率']
        .map((h, i) => (i === 0 ? h.padEnd(30) : h.padStart(13)))
        .join(''),
    )
    for (const row of group.rows) {
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
        ].join(''),
      )
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