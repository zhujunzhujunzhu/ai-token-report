/**
 * 聚合引擎：把计费记录折叠成任意维度的汇总，以及时间序列。
 */

import {
  derive,
  emptyCounts,
  mergeCounts,
  type DerivedMetrics,
  type TokenCounts,
  type UsageRecord,
} from './types.js'

export type GroupDimension = 'provider' | 'model' | 'provider-model' | 'project' | 'session' | 'day' | 'hour'

export interface GroupRow {
  key: string
  /** 该分组下的细分键（如 provider 分组时的模型列表）。 */
  counts: TokenCounts
  metrics: DerivedMetrics
  /** 首次/末次出现时间。 */
  firstTime: number
  lastTime: number
  /** 涉及的会话数。 */
  sessions: number
  /** 时间序列（仅当按时间维度聚合时有意义）。 */
  sub?: Map<string, TokenCounts>
}

/** 取分组键。 */
export function groupKey(rec: UsageRecord, dim: GroupDimension): string {
  switch (dim) {
    case 'provider':
      return rec.provider
    case 'model':
      return rec.model
    case 'provider-model':
      return `${rec.provider}/${rec.model}`
    case 'project':
      return projectName(rec.cwd)
    case 'session':
      return rec.sessionId
    case 'day':
      return toDayKey(rec.time)
    case 'hour':
      return toHourKey(rec.time)
  }
}

/** `D:\Coding\ai-token-report` → `ai-token-report`；无 cwd 时返回 `(unknown)`。 */
export function projectName(cwd: string | null): string {
  if (!cwd) return '(unknown)'
  const normalized = cwd.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

/** 本地时区的 YYYY-MM-DD。 */
export function toDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地时区的 YYYY-MM-DDTHH。 */
export function toHourKey(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, '0')
  return `${toDayKey(ms)}T${h}`
}

/** 按维度聚合。 */
export function aggregate(
  records: UsageRecord[],
  dim: GroupDimension,
): GroupRow[] {
  const map = new Map<string, GroupRow>()
  const sessionSets = new Map<string, Set<string>>()

  for (const rec of records) {
    const key = groupKey(rec, dim)
    let row = map.get(key)
    if (!row) {
      row = {
        key,
        counts: emptyCounts(),
        metrics: derive(emptyCounts()),
        firstTime: rec.time,
        lastTime: rec.time,
        sessions: 0,
      }
      map.set(key, row)
      sessionSets.set(key, new Set())
    }
    mergeCounts(row.counts, rec.usage)
    if (rec.time > 0) {
      if (row.firstTime === 0 || rec.time < row.firstTime) row.firstTime = rec.time
      if (rec.time > row.lastTime) row.lastTime = rec.time
    }
    sessionSets.get(key)!.add(rec.sessionId)
  }

  for (const [key, row] of map) {
    row.metrics = derive(row.counts)
    row.sessions = sessionSets.get(key)!.size
  }

  const rows = [...map.values()]
  // 时间维度按时间升序（趋势可读），其余维度按用量降序（找大户）
  if (dim === 'day' || dim === 'hour') {
    return rows.sort((a, b) => a.key.localeCompare(b.key))
  }
  return rows.sort((a, b) => b.counts.total - a.counts.total)
}

/**
 * 交叉表：主维度 × 次维度。
 * 例如 provider × model，或 day × provider。
 */
export function crossTab(
  records: UsageRecord[],
  primary: GroupDimension,
  secondary: GroupDimension,
): { primaryKeys: string[]; secondaryKeys: string[]; cells: Map<string, TokenCounts> } {
  const cells = new Map<string, TokenCounts>()
  const primarySet = new Set<string>()
  const secondarySet = new Set<string>()
  const cellKey = (p: string, s: string): string => `${p}\u0000${s}`

  for (const rec of records) {
    const p = groupKey(rec, primary)
    const s = groupKey(rec, secondary)
    primarySet.add(p)
    secondarySet.add(s)
    const k = cellKey(p, s)
    let cell = cells.get(k)
    if (!cell) {
      cell = emptyCounts()
      cells.set(k, cell)
    }
    mergeCounts(cell, rec.usage)
  }

  return {
    primaryKeys: [...primarySet].sort(),
    secondaryKeys: [...secondarySet].sort(),
    cells,
  }
}

/**
 * 交叉表（按用量排序的版本）。
 * secondary 维度按总量降序排列，避免 `--top` 截断时丢掉真正的大头。
 */
export function crossTabRanked(
  records: UsageRecord[],
  primary: GroupDimension,
  secondary: GroupDimension,
): { primaryKeys: string[]; secondaryKeys: string[]; cells: Map<string, TokenCounts> } {
  const base = crossTab(records, primary, secondary)

  const sumFor = (fixed: string, keys: string[], axis: 'row' | 'col'): number => {
    let total = 0
    for (const k of keys) {
      const key = axis === 'row' ? `${fixed}\u0000${k}` : `${k}\u0000${fixed}`
      total += base.cells.get(key)?.total ?? 0
    }
    return total
  }

  const secondaryTotals = base.secondaryKeys
    .map((s) => ({ key: s, total: sumFor(s, base.primaryKeys, 'col') }))
    .sort((a, b) => b.total - a.total)

  const primaryTotals = base.primaryKeys
    .map((p) => ({ key: p, total: sumFor(p, base.secondaryKeys, 'row') }))
    .sort((a, b) => b.total - a.total)

  return {
    primaryKeys: primaryTotals.map((x) => x.key),
    secondaryKeys: secondaryTotals.map((x) => x.key),
    cells: base.cells,
  }
}

/**
 * 时间序列：按天或按小时，输出每个时间桶的汇总。
 * 缺失的时间桶会被补零，便于画趋势图。
 */
export interface SeriesPoint {
  bucket: string
  counts: TokenCounts
  metrics: DerivedMetrics
  /** 按 provider 细分。 */
  byProvider: Map<string, TokenCounts>
}

export function timeSeries(
  records: UsageRecord[],
  granularity: 'day' | 'hour',
  fillGaps = true,
): SeriesPoint[] {
  const map = new Map<string, SeriesPoint>()

  for (const rec of records) {
    const bucket = granularity === 'day' ? toDayKey(rec.time) : toHourKey(rec.time)
    let point = map.get(bucket)
    if (!point) {
      point = {
        bucket,
        counts: emptyCounts(),
        metrics: derive(emptyCounts()),
        byProvider: new Map(),
      }
      map.set(bucket, point)
    }
    mergeCounts(point.counts, rec.usage)

    let prov = point.byProvider.get(rec.provider)
    if (!prov) {
      prov = emptyCounts()
      point.byProvider.set(rec.provider, prov)
    }
    mergeCounts(prov, rec.usage)
  }

  for (const point of map.values()) {
    point.metrics = derive(point.counts)
  }

  const sorted = [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))

  if (!fillGaps || sorted.length < 2) return sorted

  // 补零，保证趋势连续
  const filled: SeriesPoint[] = []
  const first = sorted[0]!.bucket
  const last = sorted[sorted.length - 1]!.bucket
  const existing = new Map(sorted.map((p) => [p.bucket, p]))

  const stepMs = granularity === 'day' ? 86_400_000 : 3_600_000
  let cursor = parseBucket(first, granularity)
  const end = parseBucket(last, granularity)

  while (cursor <= end) {
    const bucket = granularity === 'day' ? toDayKey(cursor) : toHourKey(cursor)
    filled.push(
      existing.get(bucket) ?? {
        bucket,
        counts: emptyCounts(),
        metrics: derive(emptyCounts()),
        byProvider: new Map(),
      },
    )
    cursor += stepMs
  }
  return filled
}

function parseBucket(bucket: string, granularity: 'day' | 'hour'): number {
  if (granularity === 'day') {
    const [y, m, d] = bucket.split('-').map(Number)
    return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime()
  }
  const [datePart, hourPart] = bucket.split('T')
  const [y, m, d] = datePart!.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1, Number(hourPart ?? 0)).getTime()
}

/** 全局总计。 */
export function totalOf(records: UsageRecord[]): TokenCounts {
  const total = emptyCounts()
  for (const rec of records) mergeCounts(total, rec.usage)
  return total
}