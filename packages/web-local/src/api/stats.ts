/**
 * 本地服务 API 客户端 —— 用量统计。
 *
 * ★ 这些接口由本地服务提供，数据来自**本地 SQLite 增量库**
 *   （由会话日志增量派生，库不可用时服务端自动降级直扫日志）。
 *   页面上的数字与 `dsh-token-stats --period X` 完全一致
 *   （同一数据源、同一套口径公式）。
 *
 * 时间窗用 `period` 具名周期（`today` / `week` / `last7d` / …），
 * 与服务端 `core/range.ts` 的解析完全同义 —— 不在前端做任何时间换算，
 * 否则「本月」这种跨时区的口径会在两端算出不同的边界。
 */

import type {
  LocalBreakdownResponse,
  LocalDiagnosticsResponse,
  LocalGroupBy,
  LocalOverviewResponse,
  LocalRefreshResponse,
  LocalSeriesResponse,
} from '@ai-token-report/shared'

import { request, type ApiResult } from './request'

/** overview / series 共用的筛选条件。 */
export interface StatsFilter {
  period: string
  provider?: string
  model?: string
}

/** 把筛选条件拼成查询串（省略空值，避免发出 `?provider=` 这种噪声）。 */
function toQuery(filter: StatsFilter): string {
  const params = new URLSearchParams()
  if (filter.period) params.set('period', filter.period)
  if (filter.provider) params.set('provider', filter.provider)
  if (filter.model) params.set('model', filter.model)
  return params.toString()
}

/** 顶部指标卡片。 */
export function fetchOverview(
  filter: StatsFilter,
): Promise<ApiResult<LocalOverviewResponse>> {
  return request<LocalOverviewResponse>(`/api/local/stats/overview?${toQuery(filter)}`)
}

/** 趋势序列。 */
export function fetchSeries(
  filter: StatsFilter,
  bucket: 'day' | 'hour',
): Promise<ApiResult<LocalSeriesResponse>> {
  return request<LocalSeriesResponse>(
    `/api/local/stats/series?${toQuery(filter)}&bucket=${bucket}`,
  )
}

/** 分组排行。 */
export function fetchBreakdown(
  filter: StatsFilter,
  by: LocalGroupBy,
): Promise<ApiResult<LocalBreakdownResponse>> {
  return request<LocalBreakdownResponse>(
    `/api/local/stats/breakdown?${toQuery(filter)}&by=${by}`,
  )
}

/** 扫描诊断（恒等式校验失败数等）。 */
export function fetchDiagnostics(
  filter: StatsFilter,
): Promise<ApiResult<LocalDiagnosticsResponse>> {
  return request<LocalDiagnosticsResponse>(
    `/api/local/stats/diagnostics?${toQuery(filter)}`,
  )
}

/**
 * 强制失效服务端缓存，下次请求重扫日志。
 *
 * 日常使用不需要它 —— 服务端按日志文件 mtime 自动失效。
 * 这个按钮是给「我刚跑完一轮，想立刻看到」这种场景的确定性出口。
 */
export function refreshCache(): Promise<ApiResult<LocalRefreshResponse>> {
  return request<LocalRefreshResponse>('/api/local/refresh', { method: 'POST' })
}