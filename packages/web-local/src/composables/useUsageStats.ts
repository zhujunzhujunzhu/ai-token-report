/**
 * 用量统计页的数据编排。
 *
 * ## 数据流
 *
 * ```
 * timeRange / groupBy 变化
 *        │
 *        ├─ GET /api/local/stats/overview   → 顶部卡片
 *        ├─ GET /api/local/stats/series     → 趋势图
 *        └─ GET /api/local/stats/breakdown  → 明细表
 * ```
 *
 * 三个请求**并发**发出：服务端把它们合并到同一次日志扫描
 * （见 `server/src/local-api.ts` 的 `StatsCache`），串行发只会白等两轮。
 *
 * ## 时间窗不在前端换算
 *
 * `timeRange` 直接就是服务端认识的具名周期（`today` / `week` / `last7d`）。
 * 前端不做任何「今天是几号」的判断 —— 时区口径只在一处定义（`core/range.ts`），
 * 前端再算一遍必然会在跨天、跨时区时与服务端错开。
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { fetchBreakdown, fetchOverview, fetchSeries, refreshCache } from '@/api/stats'
import {
  bucketFor,
  buildUsageSummary,
  GROUP_TABS,
  TIME_RANGES,
} from '@/composables/usage-view-model'
import type {
  LocalBreakdownRow,
  LocalGroupBy,
  LocalOverviewResponse,
} from '@ai-token-report/shared'

/** 页面默认筛选条件，同时用于「清除筛选条件」的复位。 */
const DEFAULTS = { timeRange: 'today', groupBy: 'provider-model' as LocalGroupBy }

export function useUsageStats() {
  const loading = ref(true)
  const error = ref<string | null>(null)

  const summary = ref(buildUsageSummary(EMPTY_OVERVIEW, null, [], DEFAULTS.timeRange))

  const timeRange = ref(DEFAULTS.timeRange)
  const groupBy = ref<LocalGroupBy>(DEFAULTS.groupBy)

  /** 是否存在生效中的非默认筛选 */
  const dirty = computed(
    () => timeRange.value !== DEFAULTS.timeRange || groupBy.value !== DEFAULTS.groupBy,
  )

  /** 明细行：由最后一次 breakdown 响应填充 */
  const rows = ref<LocalBreakdownRow[]>([])

  let requestSeq = 0
  let pending = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  /**
   * 拉取一轮数据。
   *
   * 用递增的 `requestSeq` 丢弃过期响应：快速切换筛选时，
   * 先发的请求可能后到，直接写入会让页面回退到旧的筛选结果。
   */
  async function load(background = false): Promise<void> {
    if (background && (pending || document.hidden)) return
    const seq = ++requestSeq
    pending = true
    // 定时更新保留当前图表和表格，避免频繁闪回加载占位。
    if (!background) {
      loading.value = true
      error.value = null
    }

    const filter = { period: timeRange.value }

    const [overview, series, breakdown] = await Promise.all([
      fetchOverview(filter),
      fetchSeries(filter, bucketFor(timeRange.value)),
      fetchBreakdown(filter, groupBy.value),
    ])

    // 已经有更新的请求发出去了，这轮结果作废
    if (seq !== requestSeq) return
    pending = false

    // 三个请求任一失败都提示 —— 部分成功还照常渲染会让人以为「数据就是少了」
    const failure = [overview, series, breakdown].find((r) => !r.ok)
    if (failure && !failure.ok) {
      error.value = failure.error
      loading.value = false
      return
    }

    if (overview.ok && series.ok && breakdown.ok) {
      error.value = null
      rows.value = breakdown.data.rows
      summary.value = buildUsageSummary(
        overview.data,
        series.data,
        breakdown.data.rows,
        timeRange.value,
      )
    }

    loading.value = false
  }

  /** 强制服务端重扫日志后刷新。 */
  async function hardRefresh(): Promise<void> {
    await refreshCache()
    await load()
  }

  function clearFilters(): void {
    timeRange.value = DEFAULTS.timeRange
    groupBy.value = DEFAULTS.groupBy
  }

  /** 导出当前明细为 CSV。 */
  function exportCsv(): void {
    const columns = [
      '分组',
      '调用次数',
      '未缓存输入',
      '输出',
      '缓存读',
      '缓存写',
      '计费总量',
      '命中率',
    ]
    const body = rows.value.map((row) =>
      [
        // 分组键可能含逗号（如 cwd 路径），必须加引号，否则列会错位
        `"${row.key.replace(/"/g, '""')}"`,
        row.calls,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.totalTokens,
        (row.cacheHitRate * 100).toFixed(1) + '%',
      ].join(','),
    )

    // 前置 BOM，保证 Excel 正确识别 UTF-8 中文
    const csv = `\uFEFF${[columns.join(','), ...body].join('\n')}`
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `usage-${timeRange.value}-${groupBy.value}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // 切换时间窗 → 重新拉全部；切换分组 → 只需要换明细表，
  // 但明细表数据就在同一个响应里，一并重拉最简单也最不容易出错。
  watch([timeRange, groupBy], () => {
    void load()
  })

  onMounted(() => {
    void load()
    refreshTimer = setInterval(() => { void load(true) }, 3_000)
  })

  onUnmounted(() => {
    clearInterval(refreshTimer)
    // 卸载后不再应用尚未返回的响应。
    requestSeq += 1
  })

  return {
    loading,
    error,
    summary,
    rows,
    timeRange,
    groupBy,
    groupTabs: GROUP_TABS,
    timeRanges: TIME_RANGES,
    dirty,
    hardRefresh,
    clearFilters,
    exportCsv,
  }
}

/**
 * 首屏占位。
 *
 * 用于 `summary` 的初值，避免模板在第一个响应回来前访问 `undefined`。
 * 刻意全为 0 而不是随机数 —— 加载中的骨架由 `loading` 控制，
 * 这里填假数据只会在极慢的请求下露出一个「看起来像真数据」的 0。
 */
const EMPTY_OVERVIEW = {
  range: { from: null, to: null, label: '全部时间' },
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  calls: 0,
  sessions: 0,
  cacheHitRate: 0,
  cacheLeverage: 0,
  avgTokensPerCall: 0,
  scannedAt: Date.now(),
  cached: false,
} satisfies LocalOverviewResponse
