/**
 * 用量统计页的领域类型。
 *
 * ★ 这些类型**全部对齐 `@ai-token-report/shared` 的 `/api/local/*` 契约**。
 *   早期版本用的是 mock 时代的字段（`apiKey` / `cost` / `requests`），
 *   与后端完全对不上：
 *
 *   | 旧字段 | 现在 | 问题 |
 *   |---|---|---|
 *   | `apiKey` | `provider` + `model` | 概念不同 |
 *   | `cost`（CNY） | 无 | **不展示金额**（已确认决策），且无单价来源 |
 *   | `requests` | `calls` | 同义不同名 |
 *   | （无） | `cacheReadTokens` | **漏掉 94.3% 的用量** |
 *
 *   对齐后，字段对不上时 TypeScript 直接编译不过，而不是等到运行时
 *   看到空图表才发现。
 */

import type { LocalBreakdownRow, LocalGroupBy } from '@ai-token-report/shared'

export type { LocalBreakdownRow, LocalGroupBy }

/** 时间维度选项（value 是服务端认识的具名周期）。 */
export interface TimeRangeOption {
  /** 具名周期，如 'today'；与 CLI 的 `--period` 完全同义。 */
  value: string
  /** 展示文案，如 '今天' */
  label: string
}

/** 通用下拉选项。 */
export interface SelectOption {
  value: string
  label: string
}

/**
 * 顶部指标卡片。
 *
 * `key` 用于关联提示文案与格式化方式，取值见 `METRIC_HINTS`。
 */
export interface MetricCard {
  key: string
  label: string
  /** 主数值，已格式化的字符串 */
  value: string
  /** 数值后缀单位，如 '%' */
  unit?: string
}

/** 折线图上的一个数据点。 */
export interface TrendPoint {
  /** X 轴标签，如 '00:00' 或 '05-21' */
  label: string
  /** Y 轴数值 */
  value: number
}

/** 图表类型。 */
export type ChartKind = 'bar' | 'area' | 'stackedBar'

/** 堆叠柱的一层。 */
export interface SeriesLayer {
  name: string
  values: number[]
  color: string
}

/** 图表数据。 */
export interface ChartSeries {
  kind: ChartKind
  labels: string[]
  values: number[]
  layers: SeriesLayer[]
  color: string
  fillColor: string
}

/** 图表内嵌的指标卡片。 */
export interface ChartCard {
  key: string
  title: string
  /** 卡片右上角展示的合计值 */
  total: string
  chart: ChartSeries
  /** Y 轴刻度文案（自下而上） */
  ticks: string[]
}

/** 指标分组。 */
export interface MetricGroup {
  name: string
  cards: ChartCard[]
}

/** 明细表格的分组维度。 */
export type GroupBy = LocalGroupBy

/** 一次统计查询的结果汇总。 */
export interface UsageSummary {
  timeRanges: TimeRangeOption[]
  activeTimeRange: string
  /** 数据新鲜度提示（缓存 / 重扫、扫描时刻）。 */
  freshness: string
  metrics: MetricCard[]
  metricGroups: MetricGroup[]
  /** 明细表的分组行。 */
  rows: LocalBreakdownRow[]
}