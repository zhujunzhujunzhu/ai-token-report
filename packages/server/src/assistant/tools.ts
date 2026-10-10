/** 助手工具桥：只读端点白名单，沿用 StatsRoute 的实时鉴权、数据范围与金额门禁。 */
import { createHash, randomUUID } from 'node:crypto'
import type { Principal } from '../identity/types.js'
import { IdentityError } from '../identity/types.js'
import type { StatsRoute } from '../stats-route.js'
import type { AssistantEvent } from '@ai-token-report/shared'
import type { AssistantDatasets } from './datasets.js'
import { resolvePeriod } from '@ai-token-report/core'

export const ASSISTANT_ENDPOINTS = ['overview', 'series', 'breakdown', 'records', 'diagnostics', 'pricing', 'providers', 'sources'] as const
const KEYS = new Set(['period', 'from', 'to', 'provider', 'model', 'source', 'member_id', 'group_id', 'bucket', 'by', 'limit', 'offset'])

/** 开始事件让长耗时查询可见；错误仍交给 DSH 决定重试，不把失败伪装成完成。 */
export async function runAssistantTool<T>(tool: string, query: string, emit: (event: AssistantEvent) => void, work: (emit: (event: AssistantEvent) => void) => Promise<T>): Promise<T> {
  const call_id = randomUUID()
  emit({ type: 'tool', tool, query, status: 202, call_id, state: 'running' })
  let completed = false
  const forward = (event: AssistantEvent) => {
    if (event.type === 'tool' && event.tool === tool) {
      completed = true
      emit({ ...event, call_id, state: event.status < 400 ? 'completed' : 'failed' })
    } else emit(event)
  }
  try {
    const value = await work(forward)
    if (!completed) emit({ type: 'tool', tool, query, status: 200, call_id, state: 'completed' })
    return value
  } catch (error) {
    emit({ type: 'tool', tool, query, status: error instanceof IdentityError ? error.status : 500, call_id, state: 'failed' })
    throw error
  }
}

/** 去除原始目录与人员姓名；别名稳定，模型可以跨查询比对同一成员。 */
export function projectToolResult(value: unknown, memberDimension = false, visibleNames = false): unknown {
  if (Array.isArray(value)) return value.map(v => projectToolResult(v, memberDimension, visibleNames))
  if (!value || typeof value !== 'object') return value
  const projected: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/cwd|path|credential|secret/i.test(key) || key === 'token') continue
    if (['user_id', 'userId', 'user_name', 'userName', 'user_name_snapshot', 'member_name', 'memberName', 'group_name', 'groupName', 'group_name_snapshot', 'group_names', 'groupNames', 'name'].includes(key) || (memberDimension && ['key', 'label'].includes(key))) {
      projected[key] = visibleNames ? item : `成员-${createHash('sha256').update(JSON.stringify(item) ?? '').digest('hex').slice(0, 8)}`
    } else projected[key] = projectToolResult(item, memberDimension || key === 'reporters', visibleNames)
  }
  return projected
}

export async function queryAssistantStats(stats: StatsRoute, principal: Principal, endpoint: string, query: string, emit: (event: AssistantEvent) => void, datasets?: AssistantDatasets, visibleNames = false): Promise<unknown> {
  if (!ASSISTANT_ENDPOINTS.includes(endpoint as typeof ASSISTANT_ENDPOINTS[number])) throw new IdentityError(400, '助手不支持这个 API')
  if (query.length > 2048) throw new IdentityError(400, '查询参数过长')
  const params = new URLSearchParams(query)
  for (const key of params.keys()) if (!KEYS.has(key)) throw new IdentityError(400, `不支持查询参数 ${key}`)
  if (params.has('from') || params.has('to')) {
    const from = Number(params.get('from')), to = Number(params.get('to'))
    const maxDays = endpoint === 'records' || params.get('bucket') === 'hour' ? 31 : 366
    if (!params.has('from') || !params.has('to') || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > maxDays * 86_400_000)
      throw new IdentityError(400, `自定义时间窗需要完整起止时间，且不能超过 ${maxDays} 天`)
    if (params.has('period')) throw new IdentityError(400, 'period 与自定义时间窗不能同时使用')
  } else {
    if (!params.has('period')) params.set('period', 'last7d')
    const period = resolvePeriod(params.get('period')!)
    if (!period) throw new IdentityError(400, '时间范围无效，请使用今天、昨天、本周、上周、本月、上月、今年或最近 7/30/90 天')
    if ((endpoint === 'records' || params.get('bucket') === 'hour') && Date.now() - period.sinceMs > 31 * 86_400_000) throw new IdentityError(400, '逐条明细与小时趋势最多查询 31 天，请改用汇总或日趋势')
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
  // ★ 仅人员/分组排行需要展示授权结果里的名称，绝不从全量名册推导用量归属。
  const projected = projectToolResult(result.body, params.get('by') === 'user' || params.get('by') === 'group', visibleNames && endpoint === 'breakdown' && ['user', 'group'].includes(params.get('by') ?? ''))
  if (!datasets && Buffer.byteLength(JSON.stringify(projected)) > 64_000) return { truncated: true, reason: '结果超过 64 KB，请缩短时间窗或改用分布查询' }
  const snapshot = datasets?.capture(endpoint, params.toString(), projected, principal)
  const output = { query: params.toString(), data: projected, truncated: false, ...(snapshot ? { dataset_id: snapshot.dataset_id!, columns: snapshot.table!.columns, rows: snapshot.table!.rows, total_rows: snapshot.table!.total_rows, card_names: snapshot.cards?.map(card => card.label) ?? [], render_hint: '选择 render_table / render_echarts / render_cards 展示这个数据集；也可只用文字回答。' } : {}) }
  // ★ 同时返回原始 API 和展示列时避免重复放大；展示数据保留，明确省略原始响应。
  if (Buffer.byteLength(JSON.stringify(output)) > 64_000 && snapshot) {
    const compact = { ...output, data: null, raw_data_omitted: true }
    if (Buffer.byteLength(JSON.stringify(compact)) > 64_000) return { ...compact, rows: [], rows_omitted: true, render_hint: '完整数据已保存在本会话，请用 render_table 展示；需要分析行内容时缩小查询范围。' }
    return compact
  }
  return output
}
