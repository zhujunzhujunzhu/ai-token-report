/**
 * 部门看板 API 客户端。
 *
 * ★ 这里的接口全部对应 `shared/src/protocol.ts` 里的类型，两端共用契约：
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
  StatsGroupsResponse,
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
  /** 服务端返回的不透明归属键：人员 UUID / legacy:… / unknown。 */
  users?: string[]
  /**
   * 分组筛选：稳定 `group_id` 列表（多选 = OR）。
   *
   * ★ 与 `users` 是**两个独立参数**（`member_id` 与 `group_id` 同时出现时服务端按 AND 叠加），
   *   且语义不同：人员是精确匹配某个人，分组是把「归属该分组的人」的事件整体取出来。
   * ⚠️ 多对多下多选是 OR / 展开：同一条事件会同时计入它的人员所属的每个分组，
   *   所以两个分组筛出来的合计大于全量合计是**定义**，不是重复计数。
   */
  groups?: string[]
}

/** 把筛选条件拼成查询串（省略空值，避免发出 `?provider=` 这种噪声）。 */
function toQuery(filter: PortalFilter): string {
  const params = new URLSearchParams()
  params.set('identity_view', 'member')
  if (filter.period) params.set('period', filter.period)
  if (filter.from !== undefined) params.set('from', String(filter.from))
  if (filter.to !== undefined) params.set('to', String(filter.to))
  if (filter.provider) params.set('provider', filter.provider)
  if (filter.model) params.set('model', filter.model)
  for (const key of new Set(filter.users ?? [])) {
    if (key === 'unknown') params.set('unattributed', 'true')
    else params.append(key.startsWith('legacy:') ? 'legacy_user' : 'member_id', key)
  }
  // 分组是多选：同一参数重复出现，服务端按 OR 展开（协议里的 `group_id?: string[]`）。
  for (const groupId of new Set(filter.groups ?? [])) params.append('group_id', groupId)
  return params.toString()
}

/**
 * 分组候选项（`GET /api/v1/stats/groups`）。
 *
 * ★ 刻意走**看板接口**而不是管理接口 `/api/v1/admin/groups`：筛选栏与分组排行
 *   只需要知道「有哪些分组」，而能看数据的人不一定有 `groups:read`。
 * ⚠️ 它不接受筛选参数：候选必须始终是**完整的分组集合**，否则选中一个分组后
 *   下拉会塌缩成一项（自锁定），使用者再也加不回别的分组。
 */
export function fetchGroupOptions(): Promise<ApiResult<StatsGroupsResponse>> {
  return request<StatsGroupsResponse>('/api/v1/stats/groups')
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
