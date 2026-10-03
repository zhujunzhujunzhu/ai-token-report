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
 * ## 金额（v7 起）
 *
 * 页面上会显示**费用（估算）**，但所有金额都来自服务端下发的 `cost`：
 * 四类分价相乘、按币种分桶、未计价比例一律在 `packages/shared/src/price.ts`
 * 算好后透传，这里只做格式化（`14200` 微元 → `¥0.01`）。
 * 本地页的价来自数据目录下的 `pricing.json` 快照（没有就退回内置种子价），
 * 与部门看板读库里的 `model_price` **不是同一份价** —— 所以那行
 * 「按哪份单价算的」必须跟着金额一起显示。
 */

import type {
  LocalBreakdownRow,
  LocalOverviewResponse,
  LocalSeriesResponse,
  LocalStatsSources,
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
import { UNPRICED_TEXT, costText, describeCost } from '@/utils/cost'

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
  // ★ 金额这条提示必须点明「估算」与「按哪份价」：本地页读数据目录下的
  //   pricing.json 快照（没有就退回内置种子价），而部门看板读的是库里的单价表 ——
  //   同一个时间窗在两边会给出不同的金额，而两个数都「看起来正常」。
  cost:
    '费用（估算）＝ 四类 token 各自乘单价后求和，按币种分别累加。' +
    '单价来自本机单价快照，不是财务账单（折扣、预付、赠送额度都不在其中）；' +
    '没配上单价的用量会显式标为「未计价」，绝不算成 0 元。',
}

/**
 * 图表卡片的提示文案。
 *
 * ⚠️ **趋势里刻意没有金额曲线**（本地页的金额出现在概览卡、明细列与口径那一行）。
 *   理由不是「懒得画」：金额曲线在多币种时**必须禁用而不是画线**
 *   （跨币种相加是个口径错误），而那条判定规则只允许有一份实现 ——
 *   它在部门看板的 `web-portal/src/utils/cost.ts`（`costSeriesOf`）。
 *   在这里照抄一遍，等于把「什么时候可以把钱加起来」变成两个地方各自决定，
 *   而它们分叉时不会报错，只会给出一个看起来正常的错误总额。
 */
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

/**
 * 费用列（**只在真的有金额可展示时**加到表里）。
 *
 * ★ 与指标卡同一条规矩：判「字段在不在」，不判数值大不大 ——
 *   一列恒为 `¥0.00` 会让「拿不到金额」看起来像「这段没花钱」。
 */
export const COST_COLUMN: DetailColumn = { key: 'cost', title: '费用（估算）', numeric: true }

/** 这张表要不要显示费用列（任一行带 `cost` 就显示）。 */
export function showCostColumn(rows: readonly LocalBreakdownRow[]): boolean {
  return rows.some((row) => row.cost)
}

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
    case 'cost':
      // ⚠️ 三种「没有数」措辞不同：字段缺席（旧服务端）→ `—`；
      //   字段在但没配价 → 「未计价」；有金额 → 货币金额。
      //   把中间那种显示成 `¥0.00`，就等于把「漏配了价」说成「省了钱」。
      return row.cost ? (costText(row.cost) ?? UNPRICED_TEXT) : '—'
    default:
      return ''
  }
}

/** 顶部指标卡片（金额卡只在服务端下发了 `cost` 时才出现）。 */
function buildMetrics(overview: LocalOverviewResponse): MetricCard[] {
  const metrics: MetricCard[] = [
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
  // ★ 判的是**字段在不在**，不是数值大不大：没有这个字段（旧版服务端）时
  //   一张 `¥0.00` 的卡片会让「拿不到金额」与「这段时间没花钱」长得一模一样。
  if (overview.cost) {
    metrics.push({
      key: 'cost',
      label: '费用（估算）',
      value: costText(overview.cost) ?? UNPRICED_TEXT,
    })
  }
  return metrics
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
    // ★ 来源原样透传：**不在前端加工**（「读了哪几处」是服务端的事实，不是展示口径）
    sources: overview.sources,
    metrics: buildMetrics(overview),
    // ★ 费用口径那一行（单价来源 + 未计价比例 + 缺哪个价）；没有金额时为 null。
    //   与 `sources` 同理：这是**服务端的事实**，前端只排版。
    costNote: describeCost(overview.cost),
    // ★ 降级说明（服务端跳过了刷新 / 换了直扫）：正常时为 null。
    notice: describeDegraded(overview.degradedReason),
    metricGroups,
    rows,
  }
}

/**
 * ★ 降级说明文案：这一轮的数**不是刚算的**。
 *
 * 服务端把「为什么没刷成」原样带在 `degradedReason` 里（库被别的写入者占用、
 * 或库不可用只能直扫），这里只加一句前缀 —— 不解释、不改写，
 * 因为它描述的是服务端发生的事，前端再加工一遍就是第二个说法。
 *
 * 🚨 刻意**不把它显示成错误**：数据仍然是对的，只是可能旧一个轮回。
 *   显示成报错会让人以为「页面坏了」，而实际要做的是「过一会儿再看一眼」。
 */
export function describeDegraded(reason: string | undefined): string | null {
  if (!reason) return null
  return `⚠ 这一轮没能刷新日志，数字可能不是最新的：${reason}`
}

/**
 * ★ 数据来源的一行文案。
 *
 * 多套 DSH 并存时页面上的数是**并集**（镜像会话按 `event_id` 去重），
 * 所以必须能自证「读了哪几处」：「加了一个 home 数字几乎没变」只有两种解释 ——
 * 镜像去重（正常）或那个根根本没读到（bug），而它们的数字看起来一样。
 */
export function describeSources(sources: LocalStatsSources): string {
  // ★ 多客户端（DSH / Codex / …）时按来源报 —— 「这些数字是谁的」与「读了哪几处」
  //   是两个问题，扁平的那组根只能回答后一个。
  const bySource = sources.bySource ?? []
  if (bySource.length > 0) {
    const names = bySource.map((entry) => SOURCE_LABELS[entry.source] ?? entry.source)
    const rootCount = bySource.reduce((sum, entry) => sum + entry.roots.length, 0)
    if (bySource.length === 1) {
      return `数据来源：${names[0]}（${rootCount} 个会话日志根）`
    }
    return `数据来源：${names.join(' + ')}，共 ${rootCount} 个会话日志根，按并集统计（同一会话只算一次）`
  }
  // 老服务端没有 `bySource`：退化成既有文案，而不是把「缺字段」说成「没有来源」。
  const roots = sources.sessionsRoots
  if (roots.length === 0) return '数据来源：未读到任何会话日志根'
  if (roots.length === 1) return '数据来源：1 个 DSH 的会话日志'
  return `数据来源：${roots.length} 个 DSH 的会话日志，按并集统计（镜像会话自动去重）`
}

/** 来源 id → 展示名。只影响**排版**，不认识的值原样显示（新来源不改前端也能看出来）。 */
const SOURCE_LABELS: Record<string, string> = {
  dsh: 'DSH',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  workbuddy: 'WorkBuddy',
  // Trae 的两个发行版是**两个来源**，展示名也要能分辨（否则合并统计时分不清谁是谁）。
  trae: 'Trae',
  'trae-cn': 'Trae CN',
}

/**
 * 逐项列出读到的根（鼠标悬停时展示完整路径）。
 *
 * 用换行分隔而不是逗号：路径本身可能含逗号，用逗号会读不出到底是几个根。
 * 多来源时每组前面标出来源 —— 只列路径的话，Codex 的根与 DSH 的根长得一样。
 */
export function describeSourcePaths(sources: LocalStatsSources): string {
  const bySource = sources.bySource ?? []
  if (bySource.length > 0) {
    return bySource
      .map((entry) => `[${SOURCE_LABELS[entry.source] ?? entry.source}]\n${entry.roots.join('\n')}`)
      .join('\n')
  }
  return sources.sessionsRoots.join('\n')
}

/** 趋势用哪个分桶：当天/昨天看小时，更长窗口看天。 */
export function bucketFor(period: string): 'day' | 'hour' {
  return period === 'today' || period === 'yesterday' ? 'hour' : 'day'
}