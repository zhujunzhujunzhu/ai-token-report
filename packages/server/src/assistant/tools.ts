/** 助手工具桥：只读端点白名单，沿用 StatsRoute 的实时鉴权、数据范围与金额门禁。 */
import { createHash } from 'node:crypto'
import type { Principal } from '../identity/types.js'
import { IdentityError } from '../identity/types.js'
import type { StatsRoute } from '../stats-route.js'
import type { AssistantEvent } from '@ai-token-report/shared'
import { presentAssistantResult } from './presentation.js'

export const ASSISTANT_ENDPOINTS = ['overview', 'series', 'breakdown', 'records', 'diagnostics', 'pricing', 'providers', 'sources'] as const
const KEYS = new Set(['period', 'from', 'to', 'provider', 'model', 'source', 'member_id', 'group_id', 'bucket', 'by', 'limit', 'offset'])

/** 去除原始目录与人员姓名；别名稳定，模型可以跨查询比对同一成员。 */
export function projectToolResult(value: unknown, memberDimension = false): unknown {
  if (Array.isArray(value)) return value.map(v => projectToolResult(v, memberDimension))
  if (!value || typeof value !== 'object') return value
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/cwd|path|credential|secret/i.test(key) || key === 'token') continue
    if (['user_id', 'userId', 'user_name', 'userName', 'user_name_snapshot', 'member_name', 'memberName', 'group_name', 'groupName', 'group_name_snapshot', 'group_names', 'groupNames', 'name'].includes(key) || (memberDimension && ['key', 'label'].includes(key))) {
      projected[key] = `成员-${createHash('sha256').update(JSON.stringify(item) ?? '').digest('hex').slice(0, 8)}`
    } else projected[key] = projectToolResult(item, memberDimension || key === 'reporters')
  }
  return projected
}

export async function queryAssistantStats(stats: StatsRoute, principal: Principal, endpoint: string, query: string, emit: (event: AssistantEvent) => void): Promise<unknown> {
  if (!ASSISTANT_ENDPOINTS.includes(endpoint as typeof ASSISTANT_ENDPOINTS[number])) throw new IdentityError(400, '助手不支持这个 API')
  if (query.length > 2048) throw new IdentityError(400, '查询参数过长')
  const params = new URLSearchParams(query)
  for (const key of params.keys()) if (!KEYS.has(key)) throw new IdentityError(400, `不支持查询参数 ${key}`)
  if (params.has('from') || params.has('to')) {
    const from = Number(params.get('from')), to = Number(params.get('to'))
    if (!params.has('from') || !params.has('to') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > 31 * 86_400_000)
      throw new IdentityError(400, '自定义时间窗需要完整起止时间，且不能超过 31 天')
    if (params.has('period')) throw new IdentityError(400, 'period 与自定义时间窗不能同时使用')
  } else {
    if (!params.has('period')) params.set('period', 'last7d')
    if (!['today', 'yesterday', 'last7d', 'last30d', 'month'].includes(params.get('period')!)) throw new IdentityError(400, '助手支持 today、yesterday、last7d、last30d、month，或 31 天内自定义时间窗')
  }
  if (endpoint === 'records') {
    const limit = params.has('limit') ? Number(params.get('limit')) : 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new IdentityError(400, '明细每次查询 1～50 行')
    params.set('limit', String(limit))
  }
  params.set('identity_view', 'member')
  const result = await stats.handle(endpoint, params, principal)
  emit({ type: 'tool', tool: `stats_${endpoint}`, query: params.toString(), status: result.status })
  if (result.status !== 200) throw new IdentityError(result.status, '统计查询失败，请检查参数或访问权限')
  const projected = projectToolResult(result.body, params.get('by') === 'user' || params.get('by') === 'group')
  if (JSON.stringify(projected).length > 64_000) return { truncated: true, reason: '结果超过 64 KB，请缩短时间窗或改用分布查询' }
  emit({ type: 'result', result: presentAssistantResult(endpoint, params.toString(), projected) })
  return { query: params.toString(), data: projected, truncated: false }
}
