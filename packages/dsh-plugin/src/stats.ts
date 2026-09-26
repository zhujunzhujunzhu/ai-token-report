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
  type TokenCounts,
} from '@ai-token-report/core'
import {
  cacheHitRate,
  cacheLeverage,
  deriveMetrics,
  maskName,
  type UsageMetrics,
} from '@ai-token-report/shared'

import { openStats } from '@ai-token-report/core/db'

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
  /** 会话日志根目录。 */
  sessionsRoot: string
  /** 本地库路径。 */
  dbPath: string
  /** DSH 宿主启用独立线程，直接调用方仍可使用当前线程。 */
  backgroundQueries?: boolean
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
    sessionsRoot: ctx.sessionsRoot,
    dbPath: ctx.dbPath,
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

    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const groups = query.summaryOnly ? [] : dims.map((dim) => {
      const rows = session.groups(dim)
      return { by: dim, rowCount: rows.length, rows: toRows(rows.slice(offset, offset + top)) }
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
