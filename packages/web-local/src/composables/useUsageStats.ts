/**
 * 用量统计页的数据编排。
 *
 * ## 数据流
 *
 * ```
 * timeRange 变化 ─┬─ GET /api/local/stats/overview   → 顶部卡片
 *                 ├─ GET /api/local/stats/series     → 趋势图
 *                 └─ GET /api/local/stats/breakdown  → 明细表
 *
 * groupBy 变化  ─── GET /api/local/stats/breakdown   → **只**换明细表
 * ```
 *
 * 同一次取数的几个请求**并发**发出（服务端在 `openStats` 里单飞，一轮只刷新一次），
 * 串行发只会白等两轮。
 *
 * ## ★ 为什么「换分组维度」只重取明细表
 *
 * 服务端的筛选条件只有 `period` / `provider` / `model` —— **`by` 只影响 breakdown 一个接口**。
 * 早期实现把三者绑在一起重取，于是点一下维度页签会：
 *
 * 1. 多跑两趟与结果无关的请求（服务端每个请求都要先做一轮 ingest）；
 * 2. 把顶部卡片与两张走势图整体**重建**一遍，同时 `loading` 置真让卡片闪回骨架，
 *    明细表也塌成一行「正在扫描本机日志…」—— 表格从 8 行掉到 1 行，
 *    页面高度跟着塌一下再撑开。
 *
 * 使用者看到的就是「点一下整页闪一下」。现在换维度只发 breakdown 一个请求：
 * 卡片与图表一个字节都不动，明细行在原地换掉（旧行留着并淡化，不塌陷）。
 * 一致性不受影响：`by` 不进 overview / series 的查询条件，
 * 而后台每 3 秒那一轮仍会按当前筛选把三者一起刷新。
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

/**
 * 一轮取数的范围。
 *
 * - `all`：时间窗变化 / 首屏 / 手动刷新 —— 卡片 + 图表 + 明细一起换；
 * - `rows`：只换了分组维度 —— **只**换明细表的行（见文件头）。
 */
export type LoadScope = 'all' | 'rows'

export function useUsageStats() {
  /**
   * 首屏骨架：**还没有任何数据可显示**时为真，拿到第一轮结果（或第一轮失败）之后
   * 永不再置回真。
   *
   * ★ 刻意不在「换时间窗 / 手动刷新」时置回真：那时旧数字仍然有效，
   *   闪回占位（卡片骨架 + 表格里那行「正在扫描本机日志…」）本身就是闪动的来源。
   */
  const loading = ref(true)

  /**
   * 用户发起的那一轮正在飞（`'idle'` = 空闲）。后台轮询刻意**不**置它 ——
   * 每 3 秒亮一次的话，数字会一直「呼吸」。
   *
   * 带范围是因为两处的反馈不同：`all` 连卡片与图表一起换（整块淡化），
   * `rows` 只换明细表的行（只有表格淡化 + 表头写「更新中…」）。
   */
  const busy = ref<LoadScope | 'idle'>('idle')

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

  let inFlight = false
  /**
   * 屏幕上是否已经有一份**可显示**的数据（首屏那一轮成功过）。
   *
   * 用来决定「筛选变了要补哪一轮」：还没有数据时任何筛选变化都要补 `all` ——
   * 只补明细会让卡片与图表停在 0（错误也已经清掉），看起来像「这段时间没有用量」。
   */
  let loaded = false
  /** 在飞期间被合并掉的刷新要求 —— 回来之后再跑一轮（读的是**最新**筛选值）。 */
  let queued: LoadScope | null = null
  /**
   * 筛选代际：筛选一变就自增，在飞的那一轮带回来的结果随即作废。
   *
   * ★ 少了它会出现「闪两下」：页签已经切到「厂商」了，而上一轮（后台轮询或
   *   上一次点击）带回来的是**旧维度**的行，先被写进表格、等下一轮再换成新维度。
   *   时间窗同理 —— 下拉已经显示「最近 7 天」，页面上却先闪过一遍「今天」的数。
   */
  let filterGen = 0
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  /** `all` 比 `rows` 宽：两者都要时按最宽的那一轮跑（时间窗那一轮本来就含明细）。 */
  function widen(current: LoadScope | null, next: LoadScope): LoadScope {
    return current === 'all' || next === 'all' ? 'all' : 'rows'
  }

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
   * @param scope `all` = 三个接口都取；`rows` = 只取明细表（分组维度变化）
   * @param background 后台轮询那一轮：不置 `busy`，也不排队
   */
  async function load(scope: LoadScope = 'all', background = false): Promise<void> {
    // 后台轮询：上一轮没回来就跳过这一次（否则每 3 秒叠一轮，服务端被越堆越多）
    if (background && (inFlight || document.hidden)) return
    if (inFlight) {
      // 走到这里必然不是后台轮询（后台在飞时上面已经返回了），所以一定会置 `busy`：
      // 用户刚点了页签却要等后台那一轮先回来，这段时间必须有「在处理」的反馈，
      // 否则页面看起来像没点动，然后整块突然换掉。
      queued = widen(queued, scope)
      busy.value = widen(busy.value === 'idle' ? null : busy.value, scope)
      return
    }

    const gen = filterGen
    const period = timeRange.value
    // ⚠️ 维度必须在**发请求时**固定：等响应回来再读 `groupBy.value`，
    //   结果就可能属于另一个维度（代际检查能兜住，但那一轮就白跑了）。
    const by = groupBy.value

    inFlight = true
    if (!background) {
      busy.value = scope
      error.value = null
    }

    try {
      if (scope === 'rows') {
        const result = await fetchBreakdown({ period }, by)
        // 期间筛选又变了：这一轮的行属于旧维度 / 旧时间窗，丢掉。
        if (gen !== filterGen) return
        if (!result.ok) {
          error.value = result.error
          return
        }
        error.value = null
        // ★ 只写明细行：`summary`（卡片 / 图表 / 来源那些行）**一个字节都不动**。
        rows.value = result.data.rows
        return
      }

      const filter = { period }

      const [overview, series, breakdown] = await Promise.all([
        fetchOverview(filter),
        fetchSeries(filter, bucketFor(period)),
        fetchBreakdown(filter, by),
      ])

      // 已经有更新的筛选了，这轮结果作废
      if (gen !== filterGen) return

      // 三个请求任一失败都提示 —— 部分成功还照常渲染会让人以为「数据就是少了」
      const failure = [overview, series, breakdown].find((r) => !r.ok)
      if (failure && !failure.ok) {
        error.value = failure.error
        return
      }

      if (overview.ok && series.ok && breakdown.ok) {
        error.value = null
        loaded = true
        rows.value = breakdown.data.rows
        summary.value = buildUsageSummary(
          overview.data,
          series.data,
          breakdown.data.rows,
          period,
        )
      }
    } finally {
      inFlight = false
      if (!background) busy.value = 'idle'
      // 首屏骨架在这一轮（无论成败）之后解除：失败时要显示错误，而不是永远停在骨架上。
      loading.value = false
      // 期间被合并掉的刷新要求：现在补上（读的是**当前**筛选值）。
      // 下面这行是同步执行的，`busy` 会被立刻置回真值 —— Vue 只看到一次变化。
      const next = queued
      queued = null
      if (next) void load(next)
    }
  }

  /** 强制服务端重扫日志后刷新。 */
  async function hardRefresh(): Promise<void> {
    await refreshCache()
    await load('all')
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

  /**
   * 筛选变化 → 重新取数。
   *
   * - 时间窗变了：三个接口一起重取（卡片 / 图表 / 明细都跟着换）；
   * - **只**换了分组维度：只重取明细表 —— `by` 只进 breakdown 一个接口，
   *   重取 overview / series 既白跑两趟 ingest，又会让卡片与图表整体重画（闪一下）。
   *
   * 两个 ref 一起 watch 是为了「清除筛选条件」这类**同时**改两者的动作：
   * 分成两个 watcher 会在同一拍里先起一轮 `all`、再排一轮，白跑一轮请求。
   */
  watch([timeRange, groupBy], ([period], [previousPeriod]) => {
    // 在飞的那一轮结果就此作废（它带回来的是旧筛选的数）。
    filterGen += 1
    // 时间窗变了 → 整轮重取；只换了维度 → 只换明细。
    // ⚠️ 但屏幕上还没有数据时（首屏那一轮刚被作废、或它失败过）一律补整轮：
    //   只补 `rows` 的话卡片与图表会永远停在 0，而它看起来像「这段没有用量」。
    const next: LoadScope = period !== previousPeriod || !loaded ? 'all' : 'rows'
    void load(next)
  })

  onMounted(() => {
    void load('all')
    refreshTimer = setInterval(() => { void load('all', true) }, 3_000)
  })

  onUnmounted(() => {
    clearInterval(refreshTimer)
    // 卸载后不再应用尚未返回的响应（与「筛选变了」同一套代际检查）。
    filterGen += 1
  })

  return {
    loading,
    busy,
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
