/** 常规用量查询：在一次工具调用内完成精确人员解析、时间解析、授权查询和可选展示。 */
import { resolvePeriod } from '@ai-token-report/core'
import type { AssistantEvent, AssistantResult } from '@ai-token-report/shared'
import { IdentityError, type Principal } from '../identity/types.js'
import type { StatsRoute } from '../stats-route.js'
import { AssistantDatasets } from './datasets.js'
import { queryAssistantStats } from './tools.js'

export const USAGE_PERIODS = ['today', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth', 'year', 'lastyear', 'last7d', 'last30d', 'last90d'] as const
export const usageParameters = {
  type: 'object', properties: {
    view: { type: 'string', enum: ['overview', 'breakdown', 'series', 'records'] },
    period: { type: 'string', enum: USAGE_PERIODS },
    from_date: { type: 'string', description: '绝对日期 YYYY-MM-DD，与 period 二选一' },
    to_date: { type: 'string', description: '绝对日期 YYYY-MM-DD，包含该日，必须与 from_date 一起给出' },
    member_name: { type: 'string', description: '用户明确提到的完整姓名；“我”填“我”；不猜测人员 ID' },
    group_name: { type: 'string', description: '用户明确提到的分组完整名称' },
    model: { type: 'string', description: '保留用户给出的完整模型标识，不能删掉名称前缀；平台接口按名称包含匹配' }, provider: { type: 'string' }, source: { type: 'string' },
    by: { type: 'string', enum: ['model', 'provider', 'source', 'user', 'group', 'project', 'day'] },
    compare_period: { type: 'string', enum: USAGE_PERIODS, description: '比较另一时间段，view 必须为 overview；返回两期独立的真实数值' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    display: { type: 'string', enum: ['cards', 'table', 'line', 'bar', 'pie', 'scatter'], description: '按用户需要选择，可省略；数据接口不绑定固定图形' },
  }, required: ['view'], additionalProperties: false,
} as const

/** 日历校验避免 2 月 31 日静默溢出到三月；日期按服务端本地时区解释。 */
function calendar(value: unknown, end = false): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IdentityError(400, '日期需要为 YYYY-MM-DD')
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new IdentityError(400, '日期不存在')
  return date.getTime()
}
export function usageRange(input: Record<string, unknown>, now = new Date()): URLSearchParams {
  if (input.from_date !== undefined || input.to_date !== undefined) {
    if (input.period !== undefined) throw new IdentityError(400, '具名周期与绝对日期不能同时给出')
    return new URLSearchParams({ from: String(calendar(input.from_date)), to: String(calendar(input.to_date, true)) })
  }
  const name = input.period ?? 'last7d'
  if (!USAGE_PERIODS.includes(name as typeof USAGE_PERIODS[number])) throw new IdentityError(400, '不支持该时间范围')
  if (name === 'lastyear') return new URLSearchParams({ from: String(new Date(now.getFullYear() - 1, 0, 1).getTime()), to: String(new Date(now.getFullYear(), 0, 1).getTime() - 1) })
  const range = resolvePeriod(String(name), now)!
  return new URLSearchParams({ from: String(range.sinceMs), to: String(range.untilMs ?? now.getTime()) })
}

/** 模型不应自行将 epoch 毫秒换算成日期；给出与实际查询完全相同的本地日期。 */
function rangeLabel(params: URLSearchParams): string {
  const date = (value: string | null) => new Date(Number(value)).toLocaleDateString('sv-SE')
  return `${date(params.get('from'))} — ${date(params.get('to'))}`
}

export async function queryUsage(stats: StatsRoute, datasets: AssistantDatasets, input: unknown, authorize: () => Promise<Principal>, emit: (event: AssistantEvent) => void) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IdentityError(400, '查询参数需要是对象')
  const args = input as Record<string, unknown>
  if (Object.keys(args).some(key => !(key in usageParameters.properties))) throw new IdentityError(400, '不支持该查询参数')
  if (!['overview', 'breakdown', 'series', 'records'].includes(String(args.view))) throw new IdentityError(400, '查询类型无效')
  const principal = await authorize(), params = usageRange(args)
  let selectedName: string | undefined
  if (args.member_name !== undefined) {
    if (typeof args.member_name !== 'string' || !args.member_name.trim() || args.member_name.length > 32) throw new IdentityError(400, '请输入完整姓名')
    const name = args.member_name.trim()
    if (['我', '自己', '本人'].includes(name) || (!principal.roleCodes.includes('admin') && name === principal.name)) { params.set('member_id', principal.memberId); selectedName = principal.name }
    else {
      if (!principal.roleCodes.includes('admin')) return { status: 'forbidden', reason: '当前身份只能查看本人数据，不能查看其他人的用量。不要改查自己或全部门。' }
      const directory = await stats.handle('members', new URLSearchParams(), principal)
      if (directory.status !== 200) throw new IdentityError(directory.status, '人员查询暂时不可用')
      const members = (directory.body as { members: Array<{ member_id: string; name: string }> }).members.filter(member => member.name === name)
      if (!members.length) return { status: 'not_found', reason: `未找到“${name}”，请确认完整姓名。不能用最近用量或其他人员代替。` }
      if (members.length > 1) return { status: 'ambiguous', reason: `找到 ${members.length} 位同名人员“${name}”，请让用户在人员页面确认身份后再查询；不能合并或选第一位。` }
      params.set('member_id', members[0]!.member_id); selectedName = name
    }
  }
  if (args.group_name !== undefined) {
    if (typeof args.group_name !== 'string' || !args.group_name.trim()) throw new IdentityError(400, '分组名称无效')
    const directory = await stats.handle('groups', new URLSearchParams(), principal)
    if (directory.status !== 200) throw new IdentityError(directory.status, '分组查询暂时不可用')
    const groups = (directory.body as { groups: Array<{ group_id: string; name: string }> }).groups.filter(group => group.name === args.group_name)
    if (groups.length !== 1) return { status: groups.length ? 'ambiguous' : 'not_found', reason: '分组名称不存在或不唯一，请确认完整名称。' }
    params.set('group_id', groups[0]!.group_id)
  }
  for (const key of ['model', 'provider', 'source', 'by', 'limit']) if (args[key] !== undefined) {
    if (!['string', 'number'].includes(typeof args[key])) throw new IdentityError(400, `${key} 参数无效`)
    params.set(key, String(args[key]))
  }
  if (!principal.roleCodes.includes('admin')) params.set('member_id', principal.memberId)
  if (args.view === 'breakdown' && !params.has('by')) throw new IdentityError(400, '分布或排行需要选择 by 维度')
  if (args.view === 'series') params.set('bucket', 'day')
  const current = await authorize()
  const output = await queryAssistantStats(stats, current, String(args.view), params.toString(), emit, datasets, true) as Record<string, any>
  if (!output.dataset_id) return output
  let datasetId = output.dataset_id as string, endpoint = String(args.view)
  if (args.compare_period !== undefined) {
    if (args.view !== 'overview') throw new IdentityError(400, '比较周期请使用 overview')
    const comparison = usageRange({ period: args.compare_period })
    for (const [key, value] of params) if (!['from', 'to'].includes(key)) comparison.set(key, value)
    const previous = await queryAssistantStats(stats, await authorize(), 'overview', comparison.toString(), emit, datasets) as Record<string, any>
    if (!previous.dataset_id) return previous
    const snapshot = datasets.capture('series', params.toString(), { points: [{ ...output.data, bucket: rangeLabel(params) }, { ...previous.data, bucket: rangeLabel(comparison) }] }, await authorize())
    snapshot.title = '两期用量比较'; snapshot.note = `两期独立查询：${params.toString()}；${comparison.toString()}`
    datasetId = snapshot.dataset_id!; endpoint = 'series'
    output.columns = snapshot.table!.columns; output.rows = snapshot.table!.rows; output.total_rows = 2; output.card_names = []; delete output.data
  }
  let rendered: AssistantResult | undefined
  if (args.display !== undefined) {
    const available = datasets.list(await authorize()).find(d => d.dataset_id === datasetId)!
    const display = String(args.display), x = endpoint === 'breakdown' ? 'dimension' : 'bucket'
    if (!['cards', 'table', 'line', 'bar', 'pie', 'scatter'].includes(display)) throw new IdentityError(400, '展示方式无效')
    const mode = display === 'cards' || display === 'table' ? display : 'echarts'
    // ★ 空数据用表格明确展示，不让图表参数错误触发多轮重试。
    const emptyChart = mode === 'echarts' && !available.row_count
    rendered = datasets.render(emptyChart ? 'table' : mode, { dataset_id: datasetId, ...(mode === 'echarts' && !emptyChart ? { chart: { kind: display, x_key: x, y_keys: ['total_tokens'] } } : {}) }, await authorize())
    if (selectedName) rendered.title = `${selectedName} · ${rendered.title}`
    emit({ type: 'result', result: rendered })
  }
  // ★ 不重复发送原始 API 与展示行，完整数据留在用户自己的会话中。
  const { data, ...compact } = output
  const member = selectedName ?? (!principal.roleCodes.includes('admin') ? principal.name : null)
  const preview = datasets.render('table', { dataset_id: datasetId }, await authorize()).table!
  const overview = data && args.view === 'overview' && !args.compare_period
  const metricsDisplay = overview ? datasets.render('cards', { dataset_id: datasetId }, await authorize()).cards! : null
  const points = preview.rows.filter(row => typeof row.total_tokens === 'number')
  const ranked = args.view === 'series' ? [...points].sort((a, b) => Number(b.total_tokens) - Number(a.total_tokens)) : []
  return {
    ...compact, dataset_id: datasetId, status: 'ok', ...(member ? { member } : {}),
    range: { label: rangeLabel(params), from: Number(params.get('from')), to: Number(params.get('to')), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    ...(overview ? { summary: { total_tokens: data.totalTokens, calls: data.calls, sessions: data.sessions, cache_hit_rate: data.cacheHitRate }, metrics_display: metricsDisplay } : {}),
    ...(ranked.length ? { series_summary: { first: points[0], last: points.at(-1), highest: ranked[0], observed_points: points.length, limited: preview.total_rows > points.length } } : {}),
    ...(rendered ? { rendered: rendered.display, render_hint: '已完成用户选择的展示，请直接给出具体结论，不要重复渲染或额外查询。' } : {}),
    rows: preview.rows.slice(0, 12), total_rows: preview.total_rows, displayed_rows: preview.rows.length,
    ...(preview.rows.length > 12 ? { analysis_rows_limited: true, render_hint: '完整展示在会话中，逐行分析仅含前12行；series_summary 来自全部已保存时间点，limited=false 时可据此描述全窗峰值。' } : {}),
  }
}
