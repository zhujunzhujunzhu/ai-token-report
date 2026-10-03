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
 * 上报调试地址（宿主保留的最近若干次上报实录）。
 *
 * ★ 为什么要有这条：上报是**无人值守**的 —— 用户唯一能观察到的现象是
 *   「部门看板上没有我的数」。而可能的原因有一长串（没署名、没配 appKey、
 *   地址写错、服务端 401、outbox 积压、补报还没跑完）。这条路由把
 *   「进程刚刚到底发了什么、服务端怎么回的」如实端到页面，
 *   让排查从「猜」变成「看」。
 *
 * ⚠️ 响应里**只有请求体，没有请求头** —— appKey 走 `Authorization`，
 *   绝不进入这份快照（否则调试页会变成凭证泄漏面）。
 */
export const UI_REPORTS_PATH = '/api/tokenReport.reports'

/** 调试页能触发的动作。 */
export type UiReportAction = 'flush' | 'preview'

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

/**
 * 面板上可选的「上报间隔」。
 *
 * ★ 只给几档而不是让用户填任意毫秒：这个数字直接决定**部门服务端**要承受的
 *   请求密度，而用户无从判断「3 秒一次」意味着什么。给档位 + 文案就够了。
 *
 * ⚠️ 用户也能选「自定义」以外的值时，宿主仍按 1 秒~60 分钟的范围校验
 *   （`MIN/MAX_FLUSH_INTERVAL_MILLIS`），不依赖这张表 ——
 *   表变了不该让旧客户端发来的值突然非法。
 */
export const UI_FLUSH_INTERVALS = [
  { millis: 5_000, label: '5 秒（最实时）' },
  { millis: 10_000, label: '10 秒（推荐）' },
  { millis: 30_000, label: '30 秒' },
  { millis: 60_000, label: '1 分钟' },
  { millis: 300_000, label: '5 分钟（最省流量）' },
] as const

/**
 * 取不到宿主间隔时的回退值。
 *
 * ⚠️ 必须与宿主 `config.ts` 的 `DEFAULTS.batch.flushIntervalMillis` **相等**：
 *   两边各写一份就会出现「面板显示 10 秒、实际按 30 秒发」这种没人能查的偏差。
 */
export const UI_DEFAULT_FLUSH_INTERVAL_MILLIS = 10_000

/** 趋势图最多画多少个点（超出取最近的 N 个）。 */
export const UI_SERIES_POINTS = 31

/** 明细只按当前维度取一页，常驻入口只取摘要。未声明 view 的旧客户端仍读全量。 */
export const UI_GROUP_BY = ['provider-model', 'provider', 'project', 'session'] as const
export type UiGroupBy = (typeof UI_GROUP_BY)[number]
export const UI_PAGE_SIZE = 10
export interface UiSelection {
  view: 'summary' | 'detail'
  by?: UiGroupBy
  page?: number
  pageSize?: number
}
export interface UiPagination {
  by: UiGroupBy
  page: number
  pageSize: number
  totalRows: number
}

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
  /**
   * ★ 该行的金额，**宿主已经格式化好的字符串**（例如 `¥12.35 + $0.5000`）。
   *
   * 🚨 浏览器半不 import `@ai-token-report/shared`，所以这里**只可能是串**，
   *   页面也不许做任何换算（那是第二个口径实现，且它不会报错）。
   *
   * ⚠️ `undefined` = **未计价**（这一行一条价都没配上），页面必须写「未计价」，
   *   **绝不许写 `¥0.00`** —— 未定价看起来像「省了钱」，是本功能最危险的误读。
   *   以 `*` 结尾 = 只有部分 token 配上了价（金额只覆盖已计价的那部分）。
   */
  cost?: string
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
  /** 缺省表示旧版全量载荷，浏览器继续支持本地分页。 */
  view?: 'summary' | 'detail'
  pagination?: UiPagination
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
  /**
   * ★ 总量金额（估算），**宿主格式化好的串**。
   *
   * 🚨 整块可选，而且「缺字段」与「没花钱」必须长得不一样：
   *   - 缺 `cost` = **老宿主**，它根本不知道有金额这回事 →
   *     面板整块不出现（绝不显示 0）；
   *   - `cost.text === null` = 新宿主，但这段区间**一条价都没配上** →
   *     显示「未计价」（同样绝不显示 `¥0.00`）。
   *
   * `note` 是那行费用口径说明（单价来源 / 未计价比例 / 「估算 ≠ 财务账单」），
   * 同样由宿主拼好 —— 浏览器半不重算任何比例。
   */
  cost?: { text: string | null; note: string | null }
  /**
   * ★ 数据代次：宿主每次**采集到**新的计费记录就加一。
   *
   * 浏览器半拿着上一次载荷里的 `gen` 做**轻量探针**
   * （`GET …?period=today&gen=N`），宿主发现代次没变就回 `204`——
   * 于是「3 秒看一眼有没有新数」这件事不再等于「3 秒扫一次日志」。
   *
   * ⚠️ 刻意是**可选**的：老宿主（或中间层）不带这个字段时，
   *   浏览器半必须退回「按兜底周期全量取数」，
   *   而不是把 `undefined` 当成一个合法代次（那会永远探测成功、数字再也不动）。
   */
  gen?: number
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
      // ★ 金额只认**非空字符串**：`""` / 数字 / null 一律当成「没有这个字段」→
      //   页面显示「未计价」。把空串渲染成一个空格会让「未计价」看起来像「金额忘了显示」，
      //   而把数字透传进 DOM 则等于让不可信输入决定页面上写什么。
      const rowCost = row['cost']
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
        ...(typeof rowCost === 'string' && rowCost !== '' ? { cost: rowCost } : {}),
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
  // ★ 代次只认有限数字；缺字段/脏值时**整个字段不带**，
  //   让浏览器半能区分「宿主说自己没变过（0）」与「宿主根本不认识这个协议」。
  const gen = raw['gen']
  // ★ 金额整块：只有**认得出 `cost` 是个对象**时才带。
  //   `text` 允许是 `null`（一条价都没配上），但必须真的是 `null` 或字符串 ——
  //   脏值一律当成「没有金额」而不是渲染到页面上。
  const rawCost = record(raw['cost'])
  const cost = rawCost === undefined ? undefined : {
    text: typeof rawCost['text'] === 'string' ? rawCost['text'] : null,
    note: typeof rawCost['note'] === 'string' && rawCost['note'] !== '' ? rawCost['note'] : null,
  }
  const rawPage = record(raw['pagination'])
  const pagination = rawPage !== undefined && UI_GROUP_BY.includes(rawPage['by'] as UiGroupBy)
    && Number.isSafeInteger(rawPage['page']) && Number(rawPage['page']) >= 1
    && Number.isSafeInteger(rawPage['pageSize']) && Number(rawPage['pageSize']) >= 1
    && Number.isSafeInteger(rawPage['totalRows']) && Number(rawPage['totalRows']) >= 0
    ? { by: rawPage['by'] as UiGroupBy, page: Number(rawPage['page']),
      pageSize: Number(rawPage['pageSize']), totalRows: Number(rawPage['totalRows']) }
    : undefined
  if (raw['view'] === 'detail' && pagination === undefined) {
    return { ok: false, error: '响应格式不认识（缺少有效分页信息）' }
  }

  return {
    ok: true,
    payload: {
      ...(raw['view'] === 'summary' || raw['view'] === 'detail' ? { view: raw['view'] } : {}),
      ...(pagination ? { pagination } : {}),
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
      ...(cost !== undefined ? { cost } : {}),
      ...(typeof gen === 'number' && Number.isFinite(gen) ? { gen } : {}),
    },
  }
}

/**
 * 配置页的**读取**载荷（`GET /api/tokenReport.settings`）。
 *
 * ⚠️ 这里永远不含 appKey 本身，只有「填过没有」（`hasAppKey`）。
 *   GET 还回一次 appKey 就等于把凭证发进浏览器历史与缓存。
 */
export interface UiSettingsPayload {
  signed: boolean
  name: string
  /** 分组名（原 `dept`）—— 内部分组契约，宿主半与浏览器半同版本改。 */
  group?: string
  baseUrl: string
  hasAppKey: boolean
  locked: boolean
  /** 旧宿主字段：`true` 表示保存后必须重启 DSH。新宿主固定 `false`（就地生效）。 */
  restartRequired: boolean
  /** 定时冲刷间隔（毫秒）。 */
  flushIntervalMillis: number
  /** 面板落点（保存后无需刷新页面即切换）。 */
  position: UiPosition
  /** 上报此刻是否真的在跑，以及没跑的原因。 */
  reporting: UiReportingStatus
  /**
   * ★ 面板里存过的**会话日志根**（输入框回填值）。空数组 = 没设过覆盖，
   *   跟随部署配置 / 自动发现。
   *
   * 🚨 这一项与 `effectiveRoots` 是**两件事**，不能只留一个：
   *   前者是「我填了什么」，后者是「现在真的在读哪几处」。
   *   只给前者，用户改完不知道有没有生效；只给后者，输入框会被自动发现的结果填满，
   *   于是「留空 = 自动发现」这条语义在界面上消失。
   */
  dshHomes: string[]
  /**
   * ★ 此刻**真正生效**的会话日志根，逐项带存在性（`<home>/sessions` 在不在）。
   *
   * `exists: false` 必须显式显示：那是「这个根白写了」的唯一线索，
   * 缺了它，一个不存在的 home 与一个空 home 在界面上长得一模一样。
   */
  effectiveRoots: { path: string; exists: boolean }[]
  /** 生效的日志根来自哪一级（面板 / 部署配置 / 环境变量 / 自动发现）。 */
  rootsSource: UiRootsSource
}

/** 生效日志根的来源。与宿主 `settings.ts` 的 `DshHomesSource` 同义。 */
export type UiRootsSource = 'panel' | 'config' | 'env' | 'auto'

/** 配置页的**保存**结果（`POST /api/tokenReport.settings`）。 */
export interface UiSettingsSavePayload {
  ok: boolean
  reason?: string
  /** 服务端认下的姓名（只可能来自服务端，绝不是客户端提交的内容）。 */
  name?: string
  position?: UiPosition
  flushIntervalMillis?: number
  dshHomes?: string[]
  effectiveRoots?: { path: string; exists: boolean }[]
  rootsSource?: UiRootsSource
  reporting?: UiReportingStatus
  restartRequired?: boolean
}

/** 上报是否在跑 + 为什么没跑。 */
export interface UiReportingStatus {
  enabled: boolean
  endpoint: string
  reason?: string
}

/** 一次真实上报尝试的实录。**只有请求体，没有请求头。** */
export interface UiReportAttempt {
  /** 该次请求的发起时刻（epoch 毫秒）。 */
  at: number
  ok: boolean
  /** 这批记录来自内存队列还是磁盘 outbox。 */
  source: 'queue' | 'outbox'
  records: number
  /** 请求体字节数（未截断前的真实大小）。 */
  bytes: number
  accepted: number
  duplicates: number
  rejected: number
  httpStatus: number | null
  error: string | null
  /** 请求体原文；超过上限只留开头并置 `truncated`。 */
  payload: string
  truncated: boolean
}

/** 上报调试页的载荷（`GET /api/tokenReport.reports`）。 */
export interface UiReportsPayload {
  reporting: UiReportingStatus
  /** 插件实例名（上报 `client.name`）。 */
  name: string
  flushIntervalMillis: number
  maxRecords: number
  timeoutMillis: number
  outboxEnabled: boolean
  /** 当前署名（服务端认下的那个），未署名为 `null`。 */
  identity: { name: string; group?: string } | null
  /** 运行计数；上报未启用时为 `null`。 */
  stats: {
    enqueued: number
    delivered: number
    duplicates: number
    rejected: number
    queueLength: number
    requests: number
    failures: number
    lastSuccessAt: number
    lastError: string | null
    /** 磁盘 outbox 状态。**保持嵌套**：与宿主 `ReporterStats` 同形，少一层搬运。 */
    outbox: {
      pendingBatches: number
      pendingRecords: number
      pendingBytes: number
      droppedBatches: number
    }
  } | null
  backfill: {
    status: string
    filesTotal: number
    filesProcessed: number
    confirmed: number
    accepted: number
    duplicates: number
    lastError: string | null
  } | null
  /** 最近若干次上报，**最新的在前**。 */
  recent: UiReportAttempt[]
}

/** 调试页动作的响应体。 */
export interface UiReportActionResult {
  ok: boolean
  reason?: string
  /** `preview` 动作回的内容（`flush` 不回）。 */
  preview?: { body: string; records: number; source: 'queue' | 'outbox'; bytes: number }
}

function bool(value: unknown): boolean {
  return value === true
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析上报状态块。
 *
 * ★ `enabled` **只在明确为 `true` 时才认**：少一个字段必须是「未启用」。
 *   反向缺省（把缺字段当成已上报）会让页面显示「一切正常」而数据其实没发出去。
 */
export function readUiReporting(value: unknown): UiReportingStatus {
  const raw = record(value) ?? {}
  return {
    enabled: bool(raw['enabled']),
    endpoint: text(raw['endpoint'], ''),
    ...(optionalText(raw['reason']) ? { reason: text(raw['reason'], '') } : {}),
  }
}

/** 只认四个已知来源；不认识（含旧宿主缺字段）一律当「自动发现」。 */
export function coerceRootsSource(value: unknown): UiRootsSource {
  return value === 'panel' || value === 'config' || value === 'env' ? value : 'auto'
}

/**
 * 解析「会话日志根」三件套 —— **读取载荷与保存响应共用同一份形状**，
 * 所以解析也只能有一处：各写一遍会出现「读取时认得、保存后回填错」这种偏一半的 bug。
 *
 * 与 `readUiResponse` 同一套规矩：逐字段重建，脏值一律丢弃或回落，
 * **绝不抛错** —— 一个字段读不动不该让配置页整页失败。
 */
export function readUiRootsView(value: unknown): {
  dshHomes: string[]
  effectiveRoots: { path: string; exists: boolean }[]
  rootsSource: UiRootsSource
} {
  const raw = record(value) ?? {}
  const dshHomes: string[] = []
  for (const item of Array.isArray(raw['dshHomes']) ? raw['dshHomes'] : []) {
    if (typeof item === 'string' && item.trim() !== '') dshHomes.push(item.trim())
  }
  const effectiveRoots: { path: string; exists: boolean }[] = []
  for (const item of Array.isArray(raw['effectiveRoots']) ? raw['effectiveRoots'] : []) {
    const entry = record(item)
    const path = entry === undefined ? undefined : optionalText(entry['path'])
    if (path !== undefined) effectiveRoots.push({ path, exists: bool(entry!['exists']) })
  }
  return { dshHomes, effectiveRoots, rootsSource: coerceRootsSource(raw['rootsSource']) }
}

/** 解析配置读取载荷。任何缺字段都回退到「未署名 + 默认位置」，绝不抛错。 */
export function readUiSettings(value: unknown): UiSettingsPayload {
  const raw = record(value) ?? {}
  const group = optionalText(raw['group'])
  const interval = count(raw['flushIntervalMillis'])
  return {
    signed: bool(raw['signed']),
    name: text(raw['name'], ''),
    ...(group ? { group } : {}),
    baseUrl: text(raw['baseUrl'], ''),
    hasAppKey: bool(raw['hasAppKey']),
    locked: bool(raw['locked']),
    restartRequired: bool(raw['restartRequired']),
    // 0 / 缺字段一律当没给：面板只在拿到正整数时才把它当间隔显示。
    flushIntervalMillis: interval > 0 ? interval : 0,
    position: parseUiPosition(raw['position']) ?? UI_DEFAULT_POSITION,
    reporting: readUiReporting(raw['reporting']),
    ...readUiRootsView(raw),
  }
}

/** 解析一次上报实录。坏条目返回 `null`，由调用方跳过（一条坏数据不该让整页白屏）。 */
function readUiAttempt(value: unknown): UiReportAttempt | null {
  const raw = record(value)
  if (raw === undefined) return null
  const status = raw['httpStatus']
  const source = raw['source'] === 'outbox' ? 'outbox' : 'queue'
  return {
    at: count(raw['at']),
    ok: bool(raw['ok']),
    source,
    records: count(raw['records']),
    bytes: count(raw['bytes']),
    accepted: count(raw['accepted']),
    duplicates: count(raw['duplicates']),
    rejected: count(raw['rejected']),
    httpStatus: typeof status === 'number' && Number.isFinite(status) ? status : null,
    error: optionalText(raw['error']) ?? null,
    payload: text(raw['payload'], ''),
    truncated: bool(raw['truncated']),
  }
}

/** 解析计数块（`stats` / `backfill`）。缺字段一律当 0，但**整块缺失时回 `null`**。 */
function readUiStats(value: unknown): UiReportsPayload['stats'] {
  const raw = record(value)
  if (raw === undefined) return null
  const outbox = record(raw['outbox']) ?? {}
  return {
    enqueued: count(raw['enqueued']),
    delivered: count(raw['delivered']),
    duplicates: count(raw['duplicates']),
    rejected: count(raw['rejected']),
    queueLength: count(raw['queueLength']),
    requests: count(raw['requests']),
    failures: count(raw['failures']),
    lastSuccessAt: count(raw['lastSuccessAt']),
    lastError: optionalText(raw['lastError']) ?? null,
    outbox: {
      pendingBatches: count(outbox['pendingBatches']),
      pendingRecords: count(outbox['pendingRecords']),
      pendingBytes: count(outbox['pendingBytes']),
      droppedBatches: count(outbox['droppedBatches']),
    },
  }
}

function readUiBackfill(value: unknown): UiReportsPayload['backfill'] {
  const raw = record(value)
  if (raw === undefined) return null
  return {
    status: text(raw['status'], 'idle'),
    filesTotal: count(raw['filesTotal']),
    filesProcessed: count(raw['filesProcessed']),
    confirmed: count(raw['confirmed']),
    accepted: count(raw['accepted']),
    duplicates: count(raw['duplicates']),
    lastError: optionalText(raw['lastError']) ?? null,
  }
}

/**
 * 解析上报调试载荷 —— 与 `readUiResponse` 同一套「逐字段重建」的规矩。
 *
 * 这里**不设「缺少某字段就报错」**：调试页本身就是要看「哪一项是空的」，
 * 一个缺字段的旧宿主响应应当渲染成「该项暂无数据」而不是整页失败。
 */
export function readUiReports(value: unknown): UiReportsPayload {
  const raw = record(value) ?? {}
  const identity = record(raw['identity'])
  const identityName = identity === undefined ? undefined : optionalText(identity['name'])
  const group = identity === undefined ? undefined : optionalText(identity['group'])
  const recent: UiReportAttempt[] = []
  for (const entry of Array.isArray(raw['recent']) ? raw['recent'] : []) {
    const attempt = readUiAttempt(entry)
    if (attempt !== null) recent.push(attempt)
  }
  const interval = count(raw['flushIntervalMillis'])
  return {
    reporting: readUiReporting(raw['reporting']),
    name: text(raw['name'], 'ai-token-report'),
    flushIntervalMillis: interval > 0 ? interval : 0,
    maxRecords: count(raw['maxRecords']),
    timeoutMillis: count(raw['timeoutMillis']),
    outboxEnabled: bool(raw['outboxEnabled']),
    identity: identityName === undefined ? null : { name: identityName, ...(group ? { group } : {}) },
    stats: readUiStats(raw['stats']),
    backfill: readUiBackfill(raw['backfill']),
    recent,
  }
}

/** 解析调试动作结果。 */
export function readUiReportAction(value: unknown): UiReportActionResult {
  const raw = record(value) ?? {}
  const preview = record(raw['preview'])
  if (preview === undefined) {
    return { ok: bool(raw['ok']), ...(optionalText(raw['reason']) ? { reason: text(raw['reason'], '') } : {}) }
  }
  return {
    ok: bool(raw['ok']),
    ...(optionalText(raw['reason']) ? { reason: text(raw['reason'], '') } : {}),
    preview: {
      body: text(preview['body'], ''),
      records: count(preview['records']),
      source: preview['source'] === 'outbox' ? 'outbox' : 'queue',
      bytes: count(preview['bytes']),
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
