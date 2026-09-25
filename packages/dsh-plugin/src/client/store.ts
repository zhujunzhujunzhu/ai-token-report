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
 * ## 三条设计约束
 *
 * 1. **纯逻辑**：`fetch` / `now` / 轮询间隔全部从外部注入，
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
  type UiDateRange,
  type UiPayload,
  type UiPeriod,
} from './protocol.js'

/** 默认两分钟刷新；SQL 热态跳过未变化日志，降级直扫时仍限制后台开销。 */
const DEFAULT_INTERVAL_MS = 120_000

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
  /** 轮询间隔（毫秒）。 */
  intervalMs?: number
}

/** 面板渲染所需的全部状态。 */
export interface UsageState {
  period: UiPeriod
  dateRange?: UiDateRange
  /** 首次加载（`data` 还没有值时）。 */
  loading: boolean
  /** 后台刷新中（已有数据，正在取更新的）。 */
  refreshing: boolean
  /** 成功载荷。 */
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

/** 造一个取数 store。 */
export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const now = deps.now ?? (() => Date.now())
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS

  let state: UsageState = { period: UI_DEFAULT_PERIOD, loading: true, refreshing: false }
  const listeners = new Set<() => void>()

  let disposers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let controller: AbortController | undefined
  /** 请求序号：只认最新一次，旧响应直接丢弃。 */
  let seq = 0
  let disposed = false

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
   */
  const load = async (period: UiPeriod, force: boolean, dateRange = state.dateRange): Promise<void> => {
    const mine = ++seq
    controller?.abort()
    const own = new AbortController()
    controller = own

    // 切换期间保留上次成功内容与其范围标签，避免卡片/图表卸载造成弹框塌缩。
    // 新结果到达后整体替换；失败时继续显示原范围，不冒充已切换成功。
    patch({ period, dateRange, loading: state.data === undefined,
      refreshing: state.data !== undefined, error: undefined })

    const query = new URLSearchParams({ period })
    if (force) query.set('refresh', '1')
    if (period === 'custom' && dateRange) {
      query.set('since', dateRange.since)
      query.set('until', dateRange.until)
    }

    let body: unknown
    let status = 200
    try {
      const res = await deps.fetch(`${UI_STATS_PATH}?${query.toString()}`, { signal: own.signal })
      status = res.status
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
      patch({
        loading: false,
        refreshing: false,
        error: parsed !== undefined && !parsed.ok ? parsed.error : describeFetchFailure(status, body),
      })
      return
    }

    patch({
      loading: false,
      refreshing: false,
      data: parsed.payload,
      fetchedAt: now(),
      error: undefined,
    })
  }

  const startPolling = (): void => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      if (!state.loading && !state.refreshing) void load(state.period, false)
    }, intervalMs)
  }

  const stopPolling = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
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

    dispose() {
      disposed = true
      stopPolling()
      controller?.abort()
      controller = undefined
      listeners.clear()
    },
  }
}
