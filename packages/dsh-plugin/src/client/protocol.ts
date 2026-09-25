/**
 * 浏览器半与宿主半之间的**唯一契约**。
 *
 * ## 为什么要有这个文件
 *
 * 插件的两半是**两个互不相通的模块图**：宿主半跑在 DSH 的 Node 进程里，
 * 浏览器半跑在页面里，浏览器半**不能** import 宿主半的任何值
 * （`lib/client.js` 只被允许 require 前端预置的那 9 个模块）。
 * 两边唯一的公分母就是这条 HTTP 路由与它上面的 JSON 形状 ——
 * 所以形状必须写在一个**双方都能 import 类型**的地方，否则两边会各写一份
 * 然后悄悄分叉：宿主改了字段名，浏览器读到 `undefined`，
 * 页面上表现为「有卡片、数字全是 0」，而不是报错。
 *
 * 本文件是**纯类型 + 常量**，零运行时依赖，因此可以同时被
 * `src/ui-bridge.ts`（Node）和 `src/client/**`（浏览器包）引入。
 *
 * ## 命名：为什么这里是 camelCase
 *
 * `packages/shared/src/protocol.ts` 定下的规矩是「DB 列 / HTTP 线上字段用
 * snake_case」—— 那条规矩管的是**上报给部门服务端的 `Wire*` 契约**。
 * 本地读取面（`/api/local/*`、`LocalOverviewResponse` 一族）在本仓一律
 * camelCase，本路由与它们同类（同机、同一次读取），所以跟随本地面。
 *
 * ## 🚨 这里不算任何口径
 *
 * `totals` 的四个 token 列**原样透传**，`metrics` 直接取宿主用
 * `@ai-token-report/shared` 的 `deriveMetrics()` 算好的结果。
 * 浏览器半只做格式化与排版 —— 在页面里写一遍除法，
 * 就会出现第二个口径实现（铁律 1）。
 */

/** UI 取数地址。 */
export const UI_STATS_PATH = '/api/tokenReport.stats'
export const UI_SETTINGS_PATH = '/api/tokenReport.settings'

/**
 * 界面呈现配置的取数地址。
 *
 * ★ 为什么需要**单独一条**路由：DSH 的客户端插件条目**拿不到**插件的
 *   `config`（`WebBootEntry` 只有 id/url/rev/inject/immediately/external，
 *   壳层组装条目时也只传 `name`），所以部署 YAML 里的 `config.ui` 到不了页面。
 *   位置这种「挂载前就要知道」的事实只能由宿主半经 HTTP 送过去。
 *
 * ⚠️ 必须挂在 `/api` 下（与 stats 同款）—— 那层前缀由 `dsh-client-connection`
 *   加了 Host/Origin 栅栏与浏览器鉴权，裸挂等于把本机信息公开给能访问端口的人。
 */
export const UI_CONFIG_PATH = '/api/tokenReport.config'

/**
 * 用量面板的落点。
 *
 * - `dock` —— 输入框上方的用量条（**默认**，0.3.0 起只挂这一个）
 * - `header` —— 会话标题栏右侧的胶囊（右上角）
 * - `both` —— 两个都挂（**等价于 0.2.0 的外观**，老用户的兼容开关）
 */
export const UI_POSITIONS = ['dock', 'header', 'both'] as const

export type UiPosition = (typeof UI_POSITIONS)[number]

/**
 * ★ 默认值只在这里定义一次。
 *
 * ⚠️ 不要把它抄到 `config.ts` 的 `DEFAULTS` 里：宿主半与浏览器半都必须认同
 *   一个默认值 —— 浏览器半在**取不到配置**（404 / 超时 / 旧宿主）时用的就是它，
 *   两边一旦各写一份，就会出现「配置路由打不通时面板跑到了另一个位置」。
 */
export const UI_DEFAULT_POSITION: UiPosition = 'dock'

/** 配置通道的响应体。刻意只有位置一项：这是展示面，不是数据面。 */
export interface UiConfigPayload {
  position: UiPosition
}

/**
 * 严格认值：**只认精确的 id，不认识就返回 `undefined`**。
 *
 * 返回 `undefined` 而不是回退默认值，是为了让调用方能区分
 * 「没配」与「配错了」——后者要告警（宿主半）或回退（浏览器半）。
 */
export function parseUiPosition(value: unknown): UiPosition | undefined {
  return typeof value === 'string' && (UI_POSITIONS as readonly string[]).includes(value)
    ? (value as UiPosition)
    : undefined
}

/**
 * 面板上可切换的周期。
 *
 * `id` 必须是 `core/range.ts` 的 `resolveRange()` 认得的具名周期 ——
 * 写错不会报错，只会让面板显示「未知周期」。
 */
export const UI_PERIODS = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: 'week', label: '本周' },
  { id: 'last7d', label: '最近 7 天' },
  { id: 'month', label: '本月' },
  { id: 'last30d', label: '近 30 天' },
  { id: 'year', label: '今年' },
  { id: 'custom', label: '自定义' },
] as const

export type UiPeriod = (typeof UI_PERIODS)[number]['id']

/** 自定义范围传日期文本，由宿主按本地时区解析，包含起止两天。 */
export interface UiDateRange { since: string; until: string }

/** 仅校验日历日期；时间边界仍由 core/range.ts 统一计算。 */
export function validDateRange(range: UiDateRange | undefined): range is UiDateRange {
  const valid = (value: string): boolean => {
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }
  return !!range && valid(range.since) && valid(range.until) && range.since <= range.until
}

/** 默认周期：同事打开面板时最想看的是「我今天用了多少」。 */
export const UI_DEFAULT_PERIOD: UiPeriod = 'today'

/** 趋势图最多画多少个点（超出取最近的 N 个）。 */
export const UI_SERIES_POINTS = 31

/** 数据来源。与宿主 `stats.ts` 的 `StatsSource` 同义，如实标注实际走的那条路径。 */
export type UiSource = 'local-db' | 'scan' | 'none'

/** 一个分组排行行。 */
export interface UiGroupRow {
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

/** 趋势图的一个点。 */
export interface UiSeriesPoint {
  bucket: string
  total: number
  calls: number
  cacheHitRate: number
}

/** 取数成功的载荷。 */
export interface UiPayload {
  period: UiPeriod
  /** 宿主办认的时间窗描述（"今天" / "最近 30 天（自然日）"…）。 */
  rangeLabel: string
  source: UiSource
  /** 降级原因（例如本地库不可用）。有值时如实显示，不假装数据来自库。 */
  degradedReason?: string
  /** 🚨 四个 token 列**分列**，绝不在宿主侧合并。 */
  totals: {
    total: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    calls: number
  }
  /** ★ 派生指标，**由宿主调用 shared/metrics.ts 算好**，浏览器半不重算。 */
  metrics: {
    cacheHitRate: number
    cacheLeverage: number
    avgTokensPerCall: number
  }
  groups: { by: string; rows: UiGroupRow[] }[]
  series?: UiSeriesPoint[]
  sessions: number
  elapsedMs: number
  scannedAt: number
}

/**
 * 取数失败的载荷。
 *
 * ⚠️ 失败**也走 200**：这样浏览器半能拿到一段可读的原因并就地显示，
 *   而不是把一个 HTTP 状态码翻译成「出错了」——后者会让
 *   「会话目录不在」和「路由没装上」看起来一模一样。
 *   与本地页的身份接口（200 + `ok:false`）同一套思路。
 */
export interface UiErrorPayload {
  period: UiPeriod
  error: string
}

/** 路由的响应体。 */
export type UiResponse = UiPayload | UiErrorPayload

/** 合法周期集合。 */
const PERIOD_IDS: readonly string[] = UI_PERIODS.map((p) => p.id)

/**
 * 把任意值收窄成合法周期。
 *
 * ⚠️ **不抛错**：URL 上的 `period` 是外部输入，写错一个周期不该让面板白屏，
 *   回落到默认值即可（用户点到「今天」就能恢复）。宿主与浏览器半共用这一份。
 */
export function coercePeriod(value: unknown): UiPeriod {
  return typeof value === 'string' && PERIOD_IDS.includes(value) ? (value as UiPeriod) : UI_DEFAULT_PERIOD
}

/** 只接受有限数字，其余一律当 0（坏数据不该让页面显示 NaN）。 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * 从不可信载荷里读出位置。
 *
 * ★ 与 `readUiResponse` 同一套思路：逐字段重建而不是 `as` 一转了事。
 *   这里的**任何异常都必须回退默认值**，绝不抛错 —— 位置是展示面的事，
 *   而「读配置时抛错」会让面板整个不挂载，那是最坏的结果。
 *
 * 失败路径（旧宿主 404、SPA 兜底 HTML、中间层塞了别的东西）一律得到
 * `UI_DEFAULT_POSITION`，即与浏览器半不请求配置时的行为完全一致。
 */
export function readUiConfig(value: unknown): UiPosition {
  const raw = record(value)
  return (raw === undefined ? undefined : parseUiPosition(raw['position'])) ?? UI_DEFAULT_POSITION
}

function coerceSource(value: unknown): UiSource {
  return value === 'local-db' || value === 'scan' ? value : 'none'
}

/**
 * 解析响应体。
 *
 * ★ **这是不可信输入的边界**：响应可能来自旧版本的宿主、
 *   也可能是 404 时 SPA 兜底返回的 HTML。所以这里逐字段重建一个
 *   `UiPayload`，而不是 `as UiPayload` 一转了事 ——
 *   转换（cast）会让「字段名对不上」变成**运行时的 undefined**，
 *   在页面上表现为「卡片在、数字全是 0」，是最难查的一类症状。
 *
 * 判据是「有没有 `totals`」而不是「有没有 `error`」：
 * 一个半损坏的载荷宁可报「格式不认识」，也不要渲染成一片 0。
 */
export function readUiResponse(value: unknown): { ok: true; payload: UiPayload } | { ok: false; error: string } {
  const raw = record(value)
  if (raw === undefined) return { ok: false, error: '响应不是合法的 JSON 对象' }

  const failure = raw['error']
  if (typeof failure === 'string' && failure !== '') return { ok: false, error: failure }

  const rawTotals = record(raw['totals'])
  if (rawTotals === undefined) return { ok: false, error: '响应格式不认识（缺少 totals）' }
  const rawMetrics = record(raw['metrics']) ?? {}

  const groups: UiPayload['groups'] = []
  for (const entry of Array.isArray(raw['groups']) ? raw['groups'] : []) {
    const group = record(entry)
    if (group === undefined) continue
    const rows: UiGroupRow[] = []
    for (const item of Array.isArray(group['rows']) ? group['rows'] : []) {
      const row = record(item)
      if (row === undefined) continue
      rows.push({
        key: text(row['key'], '(未命名)'),
        total: count(row['total']),
        input: count(row['input']),
        output: count(row['output']),
        cacheRead: count(row['cacheRead']),
        cacheWrite: count(row['cacheWrite']),
        calls: count(row['calls']),
        sessions: count(row['sessions']),
        cacheHitRate: count(row['cacheHitRate']),
      })
    }
    groups.push({ by: text(group['by'], '?'), rows })
  }

  let series: UiSeriesPoint[] | undefined
  if (Array.isArray(raw['series'])) {
    series = []
    for (const item of raw['series']) {
      const point = record(item)
      if (point === undefined) continue
      series.push({
        bucket: text(point['bucket'], '?'),
        total: count(point['total']),
        calls: count(point['calls']),
        cacheHitRate: count(point['cacheHitRate']),
      })
    }
  }

  const degradedReason = raw['degradedReason']

  return {
    ok: true,
    payload: {
      period: coercePeriod(raw['period']),
      rangeLabel: text(raw['rangeLabel'], ''),
      source: coerceSource(raw['source']),
      ...(typeof degradedReason === 'string' && degradedReason !== '' ? { degradedReason } : {}),
      totals: {
        total: count(rawTotals['total']),
        input: count(rawTotals['input']),
        output: count(rawTotals['output']),
        cacheRead: count(rawTotals['cacheRead']),
        cacheWrite: count(rawTotals['cacheWrite']),
        reasoning: count(rawTotals['reasoning']),
        calls: count(rawTotals['calls']),
      },
      metrics: {
        cacheHitRate: count(rawMetrics['cacheHitRate']),
        cacheLeverage: count(rawMetrics['cacheLeverage']),
        avgTokensPerCall: count(rawMetrics['avgTokensPerCall']),
      },
      groups,
      ...(series !== undefined ? { series } : {}),
      sessions: count(raw['sessions']),
      elapsedMs: count(raw['elapsedMs']),
      scannedAt: count(raw['scannedAt']),
    },
  }
}

/** 返回值的判别联合，供宿主半如实报告「路由到底装上没有」。 */
export type UiRouteInstall =
  /** 已经注册到 connection 的 `/api` 通道上。 */
  | 'registered'
  /** 宿主此刻还没有 connection 服务，已挂上「等它出现再注册」。 */
  | 'pending'
  /** 宿主不提供 connection（headless / 非 web profile），UI 数据通道不可用。 */
  | 'unavailable'
