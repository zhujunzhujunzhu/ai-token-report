/**
 * 部门看板 API 客户端。
 *
 * ★ 五个接口全部对应 `shared/src/protocol.ts` 里的类型，两端共用契约：
 *   字段对不上时 `bun run typecheck` 直接编译失败，而不是等页面上
 *   看到空图表。
 *
 * ## 时间窗由服务端解析
 *
 * 页面只传具名周期（`today` / `last7d` / …），**不做任何日期换算** ——
 * 时区口径只在 `core/range.ts` 定义一处。让浏览器自己算「本月从哪天开始」
 * 等于把口径复制到第二个地方，跨天、跨时区时页面与命令行必然对不上。
 */

import type {
  BreakdownResponse,
  DiagnosticsResponse,
  GroupBy,
  OverviewResponse,
  RecordsResponse,
  SeriesResponse,
} from '@ai-token-report/shared'

import { request, type ApiResult } from './request.js'

/**
 * 部门看板的筛选条件（全部是可选的，缺省 = 全部时间 + 不筛）。
 *
 * ## 时间两种给法，二选一
 *
 * - `period`：**具名周期**（`today` / `last7d` / …），由服务端用
 *   `core/range.ts` 解析成绝对时间 —— 页面不做任何日期换算
 * - `from` / `to`：**自定义区间**（epoch 毫秒）。页面顶部的「自定义」时间窗
 *   用它：那本来就是用户明确指定的两个绝对时刻，
 *   既没有「本月从哪天开始」这种口径，也不涉及时区推算
 *   （`<input type="datetime-local">` 给的就是本地墙上时间）。
 *
 * 两者同时出现时服务端以 `from`/`to` 为准（与 CLI 的 `--since/--until`
 * 覆盖 `--period` 同义）。
 */
export interface PortalFilter {
  /** 具名周期，与 CLI 的 `--period` 完全同义。 */
  period?: string
  /** 自定义区间起点（epoch 毫秒）。 */
  from?: number
  /** 自定义区间终点（epoch 毫秒，含）。 */
  to?: number
  provider?: string
  model?: string
  /**
   * 按署名筛选（可多选，逗号分隔发出去）。**精确匹配**；
   * {@link UNATTRIBUTED_USER} 表示只看未归属。
   *
   * ★ 与「说过的名字」无关：服务端把人名当实体，不做子串匹配 ——
   *   「张三」不会把「张三丰」并进来（`stats-api.test.ts` 钉着这条）。
   */
  users?: string[]
}

/** 把筛选条件拼成查询串（省略空值，避免发出 `?provider=` 这种噪声）。 */
function toQuery(filter: PortalFilter): string {
  const params = new URLSearchParams()
  if (filter.period) params.set('period', filter.period)
  if (filter.from !== undefined) params.set('from', String(filter.from))
  if (filter.to !== undefined) params.set('to', String(filter.to))
  if (filter.provider) params.set('provider', filter.provider)
  if (filter.model) params.set('model', filter.model)
  if (filter.users && filter.users.length > 0)
    params.set('user', filter.users.join(','))
  return params.toString()
}

/** 顶部指标卡片。 */
export function fetchOverview(
  filter: PortalFilter,
): Promise<ApiResult<OverviewResponse>> {
  return request<OverviewResponse>(`/api/v1/stats/overview?${toQuery(filter)}`)
}

/** 趋势序列。 */
export function fetchSeries(
  filter: PortalFilter,
  bucket: 'day' | 'hour',
): Promise<ApiResult<SeriesResponse>> {
  return request<SeriesResponse>(
    `/api/v1/stats/series?${toQuery(filter)}&bucket=${bucket}`,
  )
}

/** 分组排行（`by=user` 即人员排行）。 */
export function fetchBreakdown(
  filter: PortalFilter,
  by: GroupBy,
): Promise<ApiResult<BreakdownResponse>> {
  return request<BreakdownResponse>(
    `/api/v1/stats/breakdown?${toQuery(filter)}&by=${by}`,
  )
}

/** 明细（分页）。 */
export function fetchRecords(
  filter: PortalFilter,
  page: { limit: number; offset: number },
): Promise<ApiResult<RecordsResponse>> {
  const params = new URLSearchParams(toQuery(filter))
  params.set('limit', String(page.limit))
  params.set('offset', String(page.offset))
  return request<RecordsResponse>(`/api/v1/stats/records?${params.toString()}`)
}

/** 采集诊断（覆盖率 / 未归属 / 数据边界）。 */
export function fetchDiagnostics(
  filter: PortalFilter,
): Promise<ApiResult<DiagnosticsResponse>> {
  return request<DiagnosticsResponse>(
    `/api/v1/stats/diagnostics?${toQuery(filter)}`,
  )
}
