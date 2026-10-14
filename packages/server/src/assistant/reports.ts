/** 管理报表的确定性编排：共享授权筛选与冻结时间窗，完整查询成功后才生成私有多节文件。 */
import { ASSISTANT_SKILLS, type AssistantEvent, type AssistantSkillId } from '@ai-token-report/shared'
import { IdentityError, type Principal } from '../identity/types.js'
import type { StatsRoute } from '../stats-route.js'
import type { AssistantArtifacts } from './artifacts.js'
import type { AssistantDatasets } from './datasets.js'
import { queryAssistantStats } from './tools.js'
import { queryUsage, usageParameters, usageRange, USAGE_PERIODS } from './usage.js'

const DIMENSIONS = ['user', 'group', 'project', 'model', 'provider', 'source', 'day'] as const
type Dimension = typeof DIMENSIONS[number]
const FORMATS = ['html', 'md', 'xlsx', 'docx'] as const
const defaults: Record<AssistantSkillId, { period: typeof USAGE_PERIODS[number]; dimensions: Dimension[] }> = {
  report: { period: 'last7d', dimensions: ['user', 'project', 'model'] },
  weekly: { period: 'lastweek', dimensions: ['user', 'project', 'source'] },
  monthly: { period: 'lastmonth', dimensions: ['group', 'project', 'model'] },
  cost: { period: 'lastmonth', dimensions: ['provider', 'model', 'project'] },
  adoption: { period: 'last30d', dimensions: ['user', 'group', 'source'] },
  cache: { period: 'last7d', dimensions: ['model', 'provider', 'source'] },
  quality: { period: 'last7d', dimensions: ['source'] },
}
export const reportParameters = {
  type: 'object', properties: {
    preset: { type: 'string', enum: ASSISTANT_SKILLS.map(skill => skill.id), description: '管理报表模板；省略为 report，用户指定的条件优先于模板' },
    period: usageParameters.properties.period,
    from_date: usageParameters.properties.from_date,
    to_date: usageParameters.properties.to_date,
    member_name: usageParameters.properties.member_name,
    group_name: usageParameters.properties.group_name,
    model: usageParameters.properties.model, provider: usageParameters.properties.provider, source: usageParameters.properties.source,
    dimensions: { type: 'array', items: { type: 'string', enum: DIMENSIONS }, minItems: 1, maxItems: 3, uniqueItems: true, description: '最多3个独立分布维度；章节不可相加' },
    compare_period: { type: 'string', enum: USAGE_PERIODS, description: '明确指定比较期；返回两期真值，不自行计算增长率' },
    compare_from_date: { type: 'string', description: '比较期起日 YYYY-MM-DD，与 compare_to_date 一起给出，不能混用 compare_period' },
    compare_to_date: { type: 'string', description: '比较期止日 YYYY-MM-DD，包含该日' },
    format: { type: 'string', enum: FORMATS, description: '私有多节报告格式，默认 html' },
  }, additionalProperties: false,
} as const

const fail = (message: string): never => { throw new IdentityError(400, message) }
/**
 * 报表窗口的写法：`2026-10-05 00:00:00 — 2026-10-11 23:59:59`（年月日时分秒）。
 *
 * ★ 与页面其它时刻（采集时间 / 冻结时刻）**同一形状**：窗口边界写成本地
 *   `YYYY-MM-DD HH:mm:ss`，才看得出报表究竟覆盖到哪一秒；只写日期时
 *   「23:59 是否含 23:59:59」要靠读者自己猜。
 * ★ 用服务器本地时区（`sv-SE` 恰好给出这个形状），与 `stats-route.ts` 的
 *   `describeAbs()` 同源 —— 两边时区不同会让同一窗口在页面上差几小时。
 */
const stamp = (ms: number): string => new Date(ms).toLocaleString('sv-SE')
const rangeOf = (params: URLSearchParams) => {
  const from = Number(params.get('from')), to = Number(params.get('to'))
  return { from, to, label: `${stamp(from)} — ${stamp(to)}`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
}
function validateRange(params: URLSearchParams): void {
  const { from, to } = rangeOf(params)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from > 366 * 86_400_000) fail('报表时间窗需要完整起止时间，且不能超过 366 天')
}
function parse(input: unknown, now: Date) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('报表参数需要是对象')
  const args = input as Record<string, unknown>
  if (Object.keys(args).some(key => !Object.hasOwn(reportParameters.properties, key))) return fail('不支持该报表参数')
  const preset = args.preset === undefined ? 'report' : args.preset
  if (typeof preset !== 'string' || !ASSISTANT_SKILLS.some(skill => skill.id === preset)) return fail('报表模板无效')
  const selected = defaults[preset as AssistantSkillId]
  const dimensions = args.dimensions === undefined ? selected.dimensions : args.dimensions
  if (!Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 3 || dimensions.some(d => !DIMENSIONS.includes(d)) || new Set(dimensions).size !== dimensions.length) return fail('报表维度需要为 1～3 个不重复的支持维度')
  const format = args.format === undefined ? 'html' : args.format
  if (!FORMATS.includes(format as typeof FORMATS[number])) return fail('报表格式支持 html、md、xlsx、docx')
  for (const key of ['period', 'compare_period']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !USAGE_PERIODS.includes(args[key] as typeof USAGE_PERIODS[number]))) fail('不支持该时间范围')
  for (const key of ['member_name', 'group_name', 'model', 'provider', 'source']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > (key === 'member_name' ? 32 : 256) || /[\u0000-\u001f\u007f]/.test(args[key]))) fail(`${key} 需要是完整的非空名称`)
  const base: Record<string, unknown> = Object.fromEntries(['period', 'from_date', 'to_date', 'member_name', 'group_name', 'model', 'provider', 'source'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
  if (base.period === undefined && base.from_date === undefined && base.to_date === undefined) base.period = selected.period
  validateRange(usageRange(base, now))
  let comparison: URLSearchParams | undefined
  if (args.compare_period !== undefined || args.compare_from_date !== undefined || args.compare_to_date !== undefined) {
    const compareArgs = { ...(args.compare_period !== undefined ? { period: args.compare_period } : {}), ...(args.compare_from_date !== undefined ? { from_date: args.compare_from_date } : {}), ...(args.compare_to_date !== undefined ? { to_date: args.compare_to_date } : {}) }
    comparison = usageRange(compareArgs, now); validateRange(comparison)
  }
  return { preset: preset as AssistantSkillId, dimensions: dimensions as Dimension[], format: format as typeof FORMATS[number], base, comparison }
}

export async function generateManagementReport(stats: StatsRoute, datasets: AssistantDatasets, input: unknown, authorize: () => Promise<Principal>, emit: (event: AssistantEvent) => void, services: { artifacts?: AssistantArtifacts; sessionId: string; signal?: AbortSignal }) {
  // ★ 先校验所有时间与维度，避免非法比较期产生半份报表或先执行有效的前半段查询。
  const frozen = new Date(), args = parse(input, frozen)
  if (!services.artifacts) throw new IdentityError(503, '报表文件服务暂时不可用')
  const alive = () => { if (services.signal?.aborted) throw new IdentityError(409, '报表生成已取消') }
  alive()
  const overview = await queryUsage(stats, datasets, { ...args.base, view: 'overview' }, authorize, emit, frozen)
  if (overview.status !== 'ok' || !('dataset_id' in overview)) return overview
  const principal = await authorize()
  const catalog = datasets.list(principal).find(item => item.dataset_id === overview.dataset_id)
  if (!catalog) throw new IdentityError(403, '报表所属身份或权限已变化，请重新生成')
  const params = new URLSearchParams(catalog.query)
  // ★ 最终快照含路由内部的 identity_view；每次工具查询会自行补回，不能作为外部参数重新传入。
  params.delete('identity_view')
  const range = rangeOf(params)
  const selectedMember = params.has('member_id')
  const scope = {
    data_scope: selectedMember ? 'selected_member' : 'authorized_department',
    label: selectedMember ? `人员：${'member' in overview ? overview.member : principal.name}` : '当前身份可访问的部门数据',
    ...(args.base.group_name ? { group_name: args.base.group_name } : {}),
    filters: Object.fromEntries(['model', 'provider', 'source'].filter(key => params.has(key)).map(key => [key, params.get(key)])),
  }
  const limitations = [
    '各节是独立读取快照，共享时间窗和授权筛选，采集时间可能不同。',
    '不同分布章节含同一用量，不能相加；人员可属于多个分组，分组用量之和可能超过总量。',
    '无数据仅表示此时间窗没有已入库记录；没有应采人员名单，不能计算团队覆盖率。',
    'Token 规模不能代表人员绩效、任务质量或 ROI；没有预算基准，不能判断预算超支。',
    '费用按服务端单价估算；多币种分别展示，未计价不等于零。',
    '低缓存率和用量峰值只是排查线索，不能据此认定浪费或故障。',
    ...(args.preset === 'quality' ? ['最近用量时间不等于最近上报时间；结构性口径恒值不代表已逐条审计通过。'] : []),
    ...(!args.comparison ? ['未指定比较期，本报表不计算增长率或宣称同比、环比。'] : ['比较期为用户明确选择的独立窗口，不计算未定义的增长率；评估变化前核对两期长度。']),
  ]
  if (!principal.permissions.includes('cost:read')) limitations.push('当前身份没有金额读取权限，本报表仅包含授权用量。')
  const ids: string[] = [overview.dataset_id as string]
  const sectionRanges = new Map<string, ReturnType<typeof rangeOf>>([[ids[0]!, range]])
  const notes = [`授权范围：${scope.label}${scope.group_name ? `；分组：${scope.group_name}` : ''}`, `冻结窗口：${range.label}（${range.timezone}）；冻结时刻：${frozen.toISOString()}`, ...limitations].join('\n')
  datasets.annotate(ids[0]!, { title: '用量总览', note: notes }, principal)
  async function section(endpoint: string, query: URLSearchParams, title?: string) {
    alive()
    const result = await queryAssistantStats(stats, await authorize(), endpoint, query.toString(), emit, datasets, true) as { dataset_id?: string }
    if (!result.dataset_id) throw new IdentityError(500, '报表章节没有生成授权数据集')
    const current = await authorize()
    datasets.annotate(result.dataset_id, { ...(title ? { title } : {}), note: `授权范围：${scope.label}；各节为独立快照，分布不可相加。` }, current)
    ids.push(result.dataset_id); sectionRanges.set(result.dataset_id, rangeOf(query))
  }
  const series = new URLSearchParams(params); series.set('bucket', 'day')
  await section('series', series, '日用量趋势')
  for (const dimension of args.dimensions) { const query = new URLSearchParams(params); query.set('by', dimension); await section('breakdown', query) }
  if (args.preset === 'quality') await section('diagnostics', new URLSearchParams(params), '采集诊断与数据边界')
  if (args.comparison) {
    for (const [key, value] of params) if (!['from', 'to'].includes(key)) args.comparison.set(key, value)
    await section('overview', args.comparison, `比较期总览（${rangeOf(args.comparison).label}）`)
  }
  alive()
  const owner = await authorize()
  const sections = ids.map(datasetId => {
    const snapshot = datasets.render('table', { dataset_id: datasetId }, owner)
    const entry = datasets.list(owner).find(item => item.dataset_id === datasetId)!
    const cards = entry.card_names.length ? datasets.render('cards', { dataset_id: datasetId }, owner).cards! : []
    return { dataset_id: datasetId, title: snapshot.title, range: sectionRanges.get(datasetId)!, captured_at_ms: snapshot.captured_at_ms, columns: snapshot.table!.columns, rows: snapshot.table!.rows.slice(0, 12), total_rows: snapshot.table!.total_rows, saved_rows: snapshot.table!.rows.length, analysis_rows_limited: snapshot.table!.rows.length > 12, truncated: snapshot.table!.rows.length < snapshot.table!.total_rows, metrics_display: cards, note: snapshot.note ?? '' }
  })
  const title = `${ASSISTANT_SKILLS.find(skill => skill.id === args.preset)!.title} · ${range.label}`
  // ★ 文件只读授权数据集，模型不能填写正文或数字；任何章节失败都不会走到文件写入。
  const artifact = await services.artifacts.create(owner.memberId, services.sessionId, { format: args.format, title, dataset_ids: ids }, datasets, owner)
  for (const [index, datasetId] of ids.entries()) {
    const mode = index === 0 ? 'cards' : 'table'
    emit({ type: 'result', result: datasets.render(mode, { dataset_id: datasetId }, owner) })
  }
  emit({ type: 'artifact', artifact })
  return { status: 'ok', preset: args.preset, range, frozen_at_ms: frozen.getTime(), scope, sections, limitations, artifact, comparison: args.comparison ? { range: rangeOf(args.comparison), growth_rates_calculated: false } : null, render_hint: '完整多节私有报告和展示已生成。依据各节真实数值给出发现、限制与建议；只分析预览行时注明限制。不要重复生成、假定增长率、绩效、覆盖率或 ROI。' }
}
