/**
 * 把 `/api/local/*` 的响应组装成页面消费的视图模型。
 *
 * ## 为什么要有这一层
 *
 * 服务端返回的是**契约形态**（四个 token 分列、`cacheHitRate` 是 0~1 的小数），
 * 而页面要的是**展示形态**（格式化好的字符串、图表要的数组）。
 * 把转换集中在这里，组件就只消费视图模型：
 *
 * - 组件里不再出现任何 `toLocaleString` / `toFixed` 的口径计算
 * - 四个 token 的相加只发生在这一处，不会在两三个组件里各写一遍
 *
 * ## ★ 口径铁律
 *
 * `cacheHitRate` / `cacheLeverage` **一律由服务端算好返回**，
 * 前端只做格式化（`0.9503` → `'95.0%'`），**绝不在这里重算**。
 * 前端一旦自己算一遍，就是第二个口径来源，两端迟早会不一致。
 *
 * ## 不展示金额
 *
 * 全程不出现任何人民币字段 —— 无单价来源，只展示 token 数（已确认决策）。
 */

import type {
  LocalBreakdownRow,
  LocalOverviewResponse,
  LocalSeriesResponse,
} from '@ai-token-report/shared'

import type {
  ChartCard,
  ChartSeries,
  MetricCard,
  MetricGroup,
  TimeRangeOption,
  UsageSummary,
} from '@/types/usage'
import { formatCompact, formatCount, formatPercent } from '@/utils/format'

/**
 * 可选的具名周期。
 *
 * 只列最常用的几个 —— 服务端支持 `last14d` / `last90d` 等更多值，
 * 但下拉里塞十几个选项反而让人挑不出来。要更细的窗口请用 CLI。
 */
export const TIME_RANGES: TimeRangeOption[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'week', label: '本周' },
  { value: 'last7d', label: '最近 7 天' },
  { value: 'month', label: '本月' },
  { value: 'last30d', label: '最近 30 天' },
  { value: 'year', label: '今年' },
]

/** 分组维度页签。 */
export const GROUP_TABS: { value: string; label: string }[] = [
  { value: 'provider-model', label: '厂商 / 模型' },
  { value: 'provider', label: '厂商' },
  { value: 'model', label: '模型' },
  { value: 'project', label: '项目' },
]

/** 顶部卡片的提示文案。集中一处，便于统一措辞与口径说明。 */
export const METRIC_HINTS: Record<string, string> = {
  total:
    '计费总量 = 未缓存输入 + 输出 + 缓存读 + 缓存写。' +
    '这四项始终分列存储，展示时才相加。',
  cacheHitRate:
    '缓存命中率 = 缓存读 /（缓存读 + 未缓存输入）。' +
    '注意分母不是「输入」—— 未缓存输入只是没命中那部分。',
  calls: '计费事件条数，即带 usage 的 assistant/message 条数。',
  sessions: '这段时间内有实际调用的会话数。',
}

/** 图表卡片的提示文案。 */
export const CHART_HINTS: Record<string, string> = {
  tokens: '四项相加的计费总量，按时间分桶。',
  calls: '按时间分桶的调用次数。',
}

/** 明细表的列定义（供表头渲染与宽度控制）。 */
export interface DetailColumn {
  key: string
  title: string
  /** 是否右对齐（数值列） */
  numeric: boolean
}

export const DETAIL_COLUMNS: DetailColumn[] = [
  { key: 'key', title: '分组', numeric: false },
  { key: 'calls', title: '调用次数', numeric: true },
  { key: 'inputTokens', title: '未缓存输入', numeric: true },
  { key: 'outputTokens', title: '输出', numeric: true },
  { key: 'cacheReadTokens', title: '缓存读', numeric: true },
  { key: 'totalTokens', title: '计费总量', numeric: true },
  { key: 'cacheHitRate', title: '命中率', numeric: true },
]

/** 把一行的字段渲染成单元格文本。 */
export function detailCell(row: LocalBreakdownRow, key: string): string {
  switch (key) {
    case 'key':
      return row.key
    case 'calls':
      return formatCount(row.calls)
    case 'inputTokens':
      return formatCount(row.inputTokens)
    case 'outputTokens':
      return formatCount(row.outputTokens)
    case 'cacheReadTokens':
      return formatCount(row.cacheReadTokens)
    case 'totalTokens':
      return formatCount(row.totalTokens)
    case 'cacheHitRate':
      return formatPercent(row.cacheHitRate)
    default:
      return ''
  }
}

/** 顶部四个指标卡片。 */
function buildMetrics(overview: LocalOverviewResponse): MetricCard[] {
  return [
    {
      key: 'total',
      label: '计费总量',
      value: formatCount(overview.totalTokens),
    },
    {
      key: 'cacheHitRate',
      label: '缓存命中率',
      value: formatPercent(overview.cacheHitRate),
    },
    {
      key: 'calls',
      label: '调用次数',
      value: formatCount(overview.calls),
    },
    {
      key: 'sessions',
      label: '会话数',
      value: formatCount(overview.sessions),
    },
  ]
}

/**
 * Y 轴刻度文案（自下而上）。
 *
 * 用紧凑格式（`32M` / `1.2B`）而不是完整数字：刻度位置窄，
 * 放完整数字会被截断成省略号，反而读不出量级。
 */
function buildTicks(max: number): string[] {
  if (max <= 0) return ['0', '0', '0']
  return [
    '0',
    formatCompact(max / 2),
    formatCompact(max),
  ]
}

/** 计费总量趋势（堆叠柱，按时间分桶）。 */
function buildTokensChart(series: LocalSeriesResponse): ChartCard {
  const labels = series.points.map((p) => shortLabel(p.bucket, series.bucket))
  const values = series.points.map((p) => p.totalTokens)
  const max = Math.max(...values, 0)

  const chart: ChartSeries = {
    kind: 'bar',
    labels,
    values,
    layers: [],
    color: 'var(--c-chart-bar-light)',
    fillColor: 'var(--c-chart-bar-light)',
  }

  return {
    key: 'tokens',
    title: '计费总量',
    total: formatCount(values.reduce((a, b) => a + b, 0)),
    chart,
    ticks: buildTicks(max),
  }
}

/** 调用次数趋势（面积图）。 */
function buildCallsChart(series: LocalSeriesResponse): ChartCard {
  const labels = series.points.map((p) => shortLabel(p.bucket, series.bucket))
  const values = series.points.map((p) => p.calls)
  const max = Math.max(...values, 0)

  const chart: ChartSeries = {
    kind: 'area',
    labels,
    values,
    layers: [],
    color: 'var(--c-chart-area-stroke)',
    fillColor: 'var(--c-chart-area-fill)',
  }

  return {
    key: 'calls',
    title: '调用次数',
    total: formatCount(values.reduce((a, b) => a + b, 0)),
    chart,
    ticks: buildTicks(max),
  }
}

/**
 * 桶标签的短形态。
 *
 * `2026-09-21` → `09-21`；`2026-09-21T14` → `14:00`。
 * 省略年份是因为窗口最长也就一年，X 轴放完整日期一定挤成一团。
 */
function shortLabel(bucket: string, granularity: 'day' | 'hour'): string {
  if (granularity === 'hour') {
    const hour = bucket.split('T')[1] ?? '00'
    return `${hour}:00`
  }
  const [, month, day] = bucket.split('-')
  return month && day ? `${month}-${day}` : bucket
}

/** 数据新鲜度文案。 */
function freshnessOf(overview: LocalOverviewResponse): string {
  const time = new Date(overview.scannedAt)
  const hh = String(time.getHours()).padStart(2, '0')
  const mm = String(time.getMinutes()).padStart(2, '0')
  const ss = String(time.getSeconds()).padStart(2, '0')
  return `${overview.cached ? '缓存' : '重扫'} · ${hh}:${mm}:${ss}`
}

/**
 * 组装页面视图模型。
 *
 * @param overview 指标卡片数据
 * @param series 趋势数据。为空时只出指标卡与明细表。
 * @param rows 明细表分组行
 * @param activeTimeRange 当前选中的具名周期
 */
export function buildUsageSummary(
  overview: LocalOverviewResponse,
  series: LocalSeriesResponse | null,
  rows: LocalBreakdownRow[],
  activeTimeRange: string,
): UsageSummary {
  const metricGroups: MetricGroup[] = series
    ? [
        {
          // 有多个桶才画趋势 —— 单桶的「趋势图」只有一根柱子，纯属噪声
          name: '',
          cards:
            series.points.length > 1
              ? [buildTokensChart(series), buildCallsChart(series)]
              : [],
        },
      ].filter((g) => g.cards.length > 0)
    : []

  return {
    timeRanges: TIME_RANGES,
    activeTimeRange,
    freshness: freshnessOf(overview),
    metrics: buildMetrics(overview),
    metricGroups,
    rows,
  }
}

/** 趋势用哪个分桶：当天/昨天看小时，更长窗口看天。 */
export function bucketFor(period: string): 'day' | 'hour' {
  return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
}