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
  showCostColumn,
  TIME_RANGES,
} from '@/composables/usage-view-model'
import { UNPRICED_TEXT, costText } from '@/utils/cost'
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
  /** 本轮请求在飞时又来了新的刷新要求 —— 合并成「回来之后再跑一轮」。 */
  let queued = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  /**
   * 拉取一轮数据。
   *
   * ## ★ 同一时刻只允许一轮请求在飞（这是「切时间窗卡死」的一半原因）
   *
   * 一次取数是 **3 个并发请求**，而服务端每个请求都要先做一轮增量入库。
   * 早期实现在切换筛选时**不看有没有在飞**，直接再发 3 个：
   *
   * - 切一下 = 6 个请求，快速切几下 = 十几个请求同时压在服务端，
   *   每个都要 ingest 一次库 —— 于是互相抢库锁；
   * - 抢锁超过 5 秒的那几个请求过去会**降级成 20~30 秒的全量直扫**，
   *   把同一个（单线程的）服务端占满，后面的请求全部排队 —— 页面半天刷不出来。
   *
   * 现在：在飞时用户再切筛选，只记一个「还欠一轮」，等这一轮回来立刻按**最新**筛选
   * 再跑一轮。丢掉的只是中间那些过时的筛选值，而它们本来就不该被展示。
   *
   * 用递增的 `requestSeq` 丢弃过期响应：定时更新与切换筛选可能交错，
   * 先发的请求可能后到，直接写入会让页面回退到旧的筛选结果。
   */
  async function load(background = false): Promise<void> {
    // 后台轮询：上一轮没回来就跳过这一次（否则每 3 秒叠一轮，服务端被越堆越多）
    if (background && (pending || document.hidden)) return
    // 用户切换筛选：不叠加新请求，合并成「这一轮回来后再跑一次最新的」
    if (pending) {
      queued = true
      return
    }

    const seq = ++requestSeq
    pending = true
    // 定时更新保留当前图表和表格，避免频繁闪回加载占位。
    if (!background) {
      loading.value = true
      error.value = null
    }

    try {
      const filter = { period: timeRange.value }

      const [overview, series, breakdown] = await Promise.all([
        fetchOverview(filter),
        fetchSeries(filter, bucketFor(timeRange.value)),
        fetchBreakdown(filter, groupBy.value),
      ])

      // 已经有更新的请求发出去了，这轮结果作废
      if (seq !== requestSeq) return

      // 三个请求任一失败都提示 —— 部分成功还照常渲染会让人以为「数据就是少了」
      const failure = [overview, series, breakdown].find((r) => !r.ok)
      if (failure && !failure.ok) {
        error.value = failure.error
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
    } finally {
      if (seq === requestSeq) {
        pending = false
        loading.value = false
      }
      // 期间被合并掉的刷新要求：现在补上（读的是**当前**筛选值）
      if (queued && seq === requestSeq) {
        queued = false
        void load()
      }
    }
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
    const withCost = showCostColumn(rows.value)
    const columns = [
      '分组',
      '调用次数',
      '未缓存输入',
      '输出',
      '缓存读',
      '缓存写',
      '计费总量',
      '命中率',
      // ★ 费用列只在服务端下发了 `cost` 时才加（与页面上的列同一个开关）：
      //   导出一份恒为空的费用列，会让人以为「这段时间没花钱」。
      ...(withCost ? ['费用（估算）', '未计价Token'] : []),
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
        // ⚠️ 未配价的写「未计价」，绝不写 0 —— 导出的表格里 `0` 会被当成
        //   「免费」，而这个数是「还没配上单价」。多币种用 ` + ` 连接（见 costText）。
        ...(withCost
          ? [`"${row.cost ? (costText(row.cost) ?? UNPRICED_TEXT) : ''}"`, row.cost?.unpricedTokens ?? '']
          : []),
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
  // 首屏还不知道读了哪几处：给**空来源**而不是编几条假路径，加载完由真实响应覆盖
  sources: { sessionsRoots: [], missingRoots: [], dataDir: null },
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
