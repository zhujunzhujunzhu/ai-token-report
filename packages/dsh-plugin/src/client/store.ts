/**
 * 浏览器半的取数状态机。
 *
 * ## 为什么要有「store」而不是在每个组件里各写一个 `useEffect(fetch)`
 *
 * 面板有**两个**挂载点（输入框上方的用量条、会话标题栏的徽章）。
 * 各写一个 effect 就会各发一次请求，重复触发增量检查。
 * 两个面板共享一次查询，降级直扫时也不会把扫描量翻倍。
 *
 * 所以取数只做一次，两个面板共享同一份状态：谁先挂载谁开始轮询，
 * 最后一个卸载时停掉轮询。
 *
 * ## 刷新模型（三层，各管一个时间尺度）
 *
 * | 机制 | 周期 | 干什么 |
 * |---|---|---|
 * | **代次探针** | `DEFAULT_PROBE_INTERVAL_MS`（3s） | 只问「宿主那边变了没有」：带上手上那份载荷的 `gen`，宿主不变就回 `204` —— 零载荷、零查询、零重渲染 |
 * | **兜底全量取数** | `DEFAULT_FULL_INTERVAL_MS`（120s） | 真查一次库/日志：兜住**库外**的变化（别的 DSH 实例、CLI `dsh-token`）以及探针失效 |
 * | **用户动作** | 立即 | 切周期 / 改区间 / 点「刷新」/ **从后台切回前台** |
 *
 * ★ 为什么不是「3 秒全量轮询」：全量取数在宿主侧是**同步解码 zstd + 查 SQLite**
 *   （实测热态 25~100ms、积压变更时 2.7s，见 `packages/dsh-plugin/README.md`），
 *   而宿主与 agent 是**同一个进程**。3 秒一次全量查询 = 每 3 秒在 agent loop 的
 *   事件循环里塞一段同步解码。探针把这件事降到「一个整数比较」，
 *   代价是新鲜度上限 = 宿主缓存 TTL（30s）而不是 3s。
 *
 * ## 三条设计约束
 *
 * 1. **纯逻辑**：`fetch` / `now` / 轮询间隔 / 页面可见性全部从外部注入，
 *    因此可以直接用 `bun test` 驱动（不需要真的浏览器、也不需要真网络）。
 * 2. **失败要说人话**：这个功能最大的失败模式不是报错，而是
 *    「面板在那儿、数字全是 0」。所以 404 / 401 / 非 JSON 各给一条
 *    能指向具体动作的提示，而不是统一成「加载失败」。
 * 3. **不覆盖新数据**：切周期时旧请求可能后返回 —— 用请求序号丢弃它，
 *    否则会出现「点了『本月』，显示的是『今天』的数」。
 */

import {
  UI_STATS_PATH,
  UI_DEFAULT_PERIOD,
  readUiResponse,
  validDateRange,
  UI_GROUP_BY,
  UI_PAGE_SIZE,
  type UiDateRange,
  type UiPayload,
  type UiPeriod,
  type UiGroupBy,
} from './protocol.js'

/** 代次探针周期：高频但零成本（宿主侧只比一个整数，回 204 时连载荷都没有）。 */
const DEFAULT_PROBE_INTERVAL_MS = 3_000

/**
 * 兜底全量取数的周期。
 *
 * SQL 热态会跳过未变化的日志，降级直扫时这个周期也限制了后台开销。
 * ★ 它同时是「库外变化」的唯一发现途径：代次只反映**本进程**采集到的用量，
 *   别的 DSH 实例或 CLI 写进来的数据只能靠这一轮真查询看到。
 */
const DEFAULT_FULL_INTERVAL_MS = 120_000

/**
 * 页面可见性。
 *
 * 后台标签页不该继续解码日志 —— 而 `setInterval` 在后台**不会**停
 * （浏览器只是把它降频，且在同一个页面里跑的几个面板会叠加）。
 */
export interface VisibilitySource {
  isHidden(): boolean
  /** 订阅可见性变化；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void
}

/** 取数模式：`full` 真取一次，`probe` 只问代次。 */
type LoadMode = 'full' | 'probe'

/** 一次取数所需的全部外部依赖。 */
export interface UsageStoreDeps {
  /** 取数实现。默认用全局 `fetch`。 */
  fetch: (input: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
  /** 注入时钟，便于测试相对时间。 */
  now?: () => number
  /** 轮询 tick 周期（毫秒）。默认 {@link DEFAULT_PROBE_INTERVAL_MS}。 */
  intervalMs?: number
  /** 兜底全量取数周期（毫秒）。默认 {@link DEFAULT_FULL_INTERVAL_MS}。 */
  fullIntervalMs?: number
  /** 页面可见性来源。缺省用 `document`；没有 `document`（纯逻辑测试）时视为始终可见。 */
  visibility?: VisibilitySource
}

/** 面板渲染所需的全部状态。 */
export interface UsageState {
  period: UiPeriod
  dateRange?: UiDateRange
  /** 有详情订阅者时才查询趋势与当前维度的一页。 */
  detail?: { by: UiGroupBy; page: number }
  /** 首次加载（`data` 还没有值时）。 */
  loading: boolean
  /** 后台刷新中（已有数据，正在取更新的）。 */
  refreshing: boolean
  /** 成功载荷。`data.gen` 是它的代次，探针拿它去问宿主（见文件头「刷新模型」）。 */
  data?: UiPayload
  /** 失败原因（已翻成中文、可指着动作）。 */
  error?: string
  /** 这次成功载荷的取得时刻（本地时钟）。 */
  fetchedAt?: number
}

/** 取数 store。 */
export interface UsageStore {
  /** ★ 必须返回**稳定引用**：`useSyncExternalStore` 会拿它做相等性判断。 */
  getSnapshot(): UsageState
  subscribe(listener: () => void): () => void
  /** 切换周期并立即取数。 */
  setPeriod(period: UiPeriod): void
  setCustomRange(range: UiDateRange): void
  /** 手动刷新（绕过宿主缓存）。 */
  refresh(): void
  /** 详情按打开的面板计数；同页多个入口共享一次取数。 */
  acquireDetails(): () => void
  setDetail(by: UiGroupBy, page?: number): void
  /** 停止轮询并取消在途请求。 */
  dispose(): void
}

/** 把 HTTP 层与响应体层的失败翻成一条能指着动作的提示。 */
export function describeFetchFailure(status: number, body: unknown): string {
  if (status === 404) {
    return (
      `宿主未提供用量数据通道（${UI_STATS_PATH} 返回 404）。` +
      ' 该 DSH 可能不是 web profile，或插件未启用 UI 通道。'
    )
  }
  if (status === 401 || status === 403) {
    return `未通过宿主鉴权（HTTP ${status}）。请从带 token 的 DSH 地址打开页面。`
  }
  if (status !== 200) return `取数失败：HTTP ${status}`
  return body === undefined ? '响应不是合法 JSON' : '响应格式不认识（缺少 totals）'
}

/** 浏览器里的可见性来源；不在浏览器里（单测）返回 `undefined`。 */
function browserVisibility(): VisibilitySource | undefined {
  if (typeof document === 'undefined') return undefined
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  }
}

/** 造一个取数 store。 */
export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const now = deps.now ?? (() => Date.now())
  const intervalMs = deps.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const fullIntervalMs = deps.fullIntervalMs ?? DEFAULT_FULL_INTERVAL_MS
  const visibility = deps.visibility ?? browserVisibility()

  let state: UsageState = { period: UI_DEFAULT_PERIOD, loading: true, refreshing: false }
  const listeners = new Set<() => void>()

  let disposers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let unobserveVisibility: (() => void) | undefined
  let controller: AbortController | undefined
  /** 请求序号：只认最新一次，旧响应直接丢弃。 */
  let seq = 0
  let disposed = false
  let requestPending = false
  let detailSubscribers = 0
  let detailBy: UiGroupBy = 'provider-model'
  let detailPage = 1
  let snapshotKey: string | undefined
  /**
   * 上一次**全量**取数的发起时刻。
   *
   * 用「发起」而不是「完成」计时：失败时也照常等一个兜底周期再试，
   * 否则一个持续失败的宿主会被每 3 秒的真实查询反复打。
   */
  let lastFullAt = 0

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const patch = (next: Partial<UsageState>): void => {
    state = { ...state, ...next }
    emit()
  }

  /**
   * 取一次数。
   *
   * ⚠️ 三层失败各有各的提示，不要合并成一句「加载失败」：
   *   **HTTP 层**（404 = 路由没装上 / 401 = 没带 token）、
   *   **JSON 层**（返回的是 SPA 兜底的 HTML）、
   *   **载荷层**（字段对不上）。
   *   三者的处置动作完全不同，混在一起排查时只能靠猜。
   *
   * @param mode - `probe` 时只问代次：不发 `refresh`、不置 `refreshing`
   *   （否则面板每 3 秒闪一次「正在更新」，控件也会跟着禁用），
   *   失败也不冒泡到界面上（后台检查失败由下一轮兜底全量取数如实报出来）。
   */
  const load = async (
    period: UiPeriod,
    force: boolean,
    dateRange = state.dateRange,
    mode: LoadMode = 'full',
  ): Promise<void> => {
    if (disposed) return
    const mine = ++seq
    controller?.abort()
    const own = new AbortController()
    controller = own
    requestPending = true

    try {
      if (mode === 'full' && (period !== state.period || dateRange?.since !== state.dateRange?.since
        || dateRange?.until !== state.dateRange?.until)) detailPage = 1
      const detail = detailSubscribers > 0 ? { by: detailBy, page: detailPage } : undefined

      if (mode === 'full') {
        lastFullAt = now()
        // 切换期间保留上次成功内容与其范围标签，避免卡片/图表卸载造成弹框塌缩。
        // 新结果到达后整体替换；失败时继续显示原范围，不冒充已切换成功。
        patch({ period, dateRange, detail, loading: state.data === undefined,
          refreshing: state.data !== undefined, error: undefined })
      }

      const query = new URLSearchParams({ period })
      query.set('view', detail ? 'detail' : 'summary')
      if (detail) {
        query.set('by', detail.by)
        query.set('page', String(detail.page))
        query.set('pageSize', String(UI_PAGE_SIZE))
      }
      if (force) query.set('refresh', '1')
      if (period === 'custom' && dateRange) {
        query.set('since', dateRange.since)
        query.set('until', dateRange.until)
      }
      const snapshotParams = new URLSearchParams(query)
      snapshotParams.delete('refresh')
      const requestKey = snapshotParams.toString()
      // ★ 探针：告诉宿主「我手上是第几代」。代次没变宿主回 204，一个字节都不用传。
      const gen = state.data?.gen
      if (mode === 'probe' && gen !== undefined && snapshotKey === requestKey) query.set('gen', String(gen))

      let body: unknown
      let status = 200
      try {
        const res = await deps.fetch(`${UI_STATS_PATH}?${query.toString()}`, { signal: own.signal })
        status = res.status
        // 204 = 代次没变：手上这份载荷仍然是最新的，什么都不用做
        if (status === 204) return
        if (res.ok) {
          try {
            body = await res.json()
          } catch {
            // 非 JSON（例如 HTML 兜底页）：交给下面统一翻译
            body = undefined
          }
        }
      } catch (err) {
        // 主动 abort（切周期 / 卸载）不是错误，静默退出即可
        if (disposed || mine !== seq) return
        // 后台探针失败不打扰使用者：兜底全量取数会把持续的故障如实报出来
        if (mode === 'probe') return
        patch({
          loading: false,
          refreshing: false,
          error: `请求失败：${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      // ★ 迟到的响应必须丢掉：否则「点了本月却显示今天的数」
      if (disposed || mine !== seq) return

      const parsed = body === undefined ? undefined : readUiResponse(body)
      if (parsed === undefined || !parsed.ok) {
        if (mode === 'probe') return
        patch({
          loading: false,
          refreshing: false,
          error: parsed !== undefined && !parsed.ok ? parsed.error : describeFetchFailure(status, body),
        })
        return
      }

      // ★ 数据没变就不要产生新快照。
      //
      //   宿主侧 TTL（30s）会让「探针说变了、随即全量取数」拿到一份**仍是旧代次**
      //   的载荷（在途的那次查询还没把新数据算进去）。此时若无条件 `patch`，
      //   面板就会在每次 tick 上重渲染一遍（图表整个重画、悬浮提示被清掉），
      //   而数字一个字都没变 —— 纯负收益。
      if (
        mode === 'probe' &&
        snapshotKey === requestKey &&
        state.data !== undefined &&
        parsed.payload.period === state.data.period &&
        parsed.payload.gen !== undefined &&
        parsed.payload.gen === state.data.gen
      ) {
        if (state.error !== undefined) patch({ error: undefined })
        return
      }

      if (detail && parsed.payload.pagination) detailPage = parsed.payload.pagination.page
      // 页码被宿主钳到最后一页时，后续探针应认这份实际返回的页面快照。
      if (detail) snapshotParams.set('page', String(detailPage))
      snapshotKey = snapshotParams.toString()
      patch({
        loading: false,
        refreshing: false,
        data: parsed.payload,
        fetchedAt: now(),
        error: undefined,
        ...(detail ? { detail: { by: detailBy, page: detailPage } } : {}),
      })
    } finally {
      // 探针保持界面安静，但在途状态必须独立记录，否则下一个 tick 会取消慢查询。
      if (mine === seq) requestPending = false
    }
  }

  /** 一次 tick：优先兜底全量，其次代次探针（见文件头「刷新模型」）。 */
  const tick = (): void => {
    if (disposed) return
    // 后台标签页什么都不做：回来时下面的 onVisible 会立刻补一次
    if (visibility?.isHidden() === true) return
    // 慢查询在途时不再叠加：探针与全量取数都等它
    if (requestPending) return

    if (now() - lastFullAt >= fullIntervalMs) {
      void load(state.period, false, state.dateRange, 'full')
      return
    }

    // ⚠️ 拿不到代次（老宿主 / 中间层改过响应）时**只能**走兜底周期。
    //   把这种情况当「代次 0」处理会让面板每 3 秒发一次全量请求 ——
    //   正是本设计要避免的那件事。
    if (state.data?.gen === undefined) return

    void load(state.period, false, state.dateRange, 'probe')
  }

  /** 从后台切回前台：使用者正要盯着看，立刻补一次全量（宿主 TTL 会吸收掉密集切换）。 */
  const onVisible = (): void => {
    if (disposed || visibility?.isHidden() === true) return
    if (requestPending) return
    void load(state.period, false, state.dateRange, 'full')
  }

  const startPolling = (): void => {
    if (timer === undefined) {
      timer = setInterval(tick, intervalMs)
    }
    if (unobserveVisibility === undefined && visibility !== undefined) {
      unobserveVisibility = visibility.subscribe(onVisible)
    }
  }

  const stopPolling = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    unobserveVisibility?.()
    unobserveVisibility = undefined
  }

  return {
    getSnapshot: () => state,

    subscribe(listener) {
      listeners.add(listener)
      disposers++
      // 第一个订阅者触发首次取数 + 开始轮询
      if (disposers === 1 && !disposed) {
        void load(state.period, false)
        startPolling()
      }
      return () => {
        listeners.delete(listener)
        disposers--
        // 最后一个订阅者走了就停轮询：面板卸载后不该还在解码日志
        if (disposers === 0) {
          stopPolling()
          seq++
          controller?.abort()
          controller = undefined
          requestPending = false
        }
      }
    },

    setPeriod(period) {
      if (period === 'custom' && !validDateRange(state.dateRange)) return
      if (period === state.period && state.data !== undefined && state.error === undefined) return
      void load(period, false)
    },

    setCustomRange(range) {
      if (!validDateRange(range)) return
      void load('custom', false, { ...range })
    },

    refresh() {
      void load(state.period, true)
    },

    acquireDetails() {
      if (disposed) return () => {}
      detailSubscribers++
      if (detailSubscribers === 1) {
        detailPage = 1
        void load(state.period, false)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        detailSubscribers--
        if (detailSubscribers === 0 && !disposed) {
          if (disposers > 0) void load(state.period, false)
          else patch({ detail: undefined, loading: state.data === undefined, refreshing: false })
        }
      }
    },

    setDetail(by, page = 1) {
      if (disposed || !UI_GROUP_BY.includes(by) || !Number.isSafeInteger(page) || page < 1) return
      if (by === detailBy && page === detailPage) return
      detailBy = by
      detailPage = page
      if (detailSubscribers > 0) void load(state.period, false)
    },

    dispose() {
      disposed = true
      stopPolling()
      controller?.abort()
      controller = undefined
      requestPending = false
      listeners.clear()
    },
  }
}
