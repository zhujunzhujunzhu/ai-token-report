/** 统计结果的安全展示边界：只复制 API 真值，格式化不改变指标或费用口径。 */
import { randomUUID } from 'node:crypto'
import { formatCostMicro, formatCostSummary, type AssistantResult, type StatsCostTotals } from '@ai-token-report/shared'

type Row = Record<string, unknown>
type Column = NonNullable<AssistantResult['table']>['columns'][number]
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown) => typeof value === 'string' ? value : null
const cell = (value: unknown): string | number | null => numeric(value) ? value : text(value)
const count = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 })
const metricColumns: Array<Column & { source: string }> = [
  { key: 'total_tokens', source: 'totalTokens', label: '计费总量', format: 'number' },
  { key: 'calls', source: 'calls', label: '调用次数', format: 'number' },
  { key: 'input_tokens', source: 'inputTokens', label: '未缓存输入', format: 'number' },
  { key: 'output_tokens', source: 'outputTokens', label: '输出', format: 'number' },
  { key: 'cache_read_tokens', source: 'cacheReadTokens', label: '缓存读', format: 'number' },
  { key: 'cache_write_tokens', source: 'cacheWriteTokens', label: '缓存写', format: 'number' },
  { key: 'cache_hit_rate', source: 'cacheHitRate', label: '缓存命中率', format: 'percent' },
]
const titles: Record<string, string> = { overview: '用量总览', series: '用量趋势', breakdown: '用量分布', records: '调用明细', pricing: '模型单价', diagnostics: '采集诊断', providers: '厂商目录', sources: '来源目录' }

/** 汇总金额保留单价出处；明细金额遵循 RecordCost 的币种空值契约。 */
function costOf(value: unknown): string | null {
  const cost = object(value)
  if (numeric(cost.amountMicro) && (typeof cost.currency === 'string' || cost.currency === null)) return cost.currency === null ? '未计价' : formatCostMicro(cost.amountMicro, cost.currency)
  if (!Array.isArray(cost.costs) || !cost.pricing) return null
  return formatCostSummary((cost as unknown as StatsCostTotals).costs) ?? '未计价'
}
function tableOf(rows: Row[], leading: Column[], sourceOf: (row: Row) => Record<string, string | number | null>) {
  const metrics = metricColumns.filter(column => rows.some(row => numeric(row[column.source])))
  const columns = [...leading, ...metrics.map(({ source: _source, ...column }) => column)]
  if (rows.some(row => costOf(row.cost) !== null)) columns.push({ key: 'cost', label: '费用（估算）' })
  return {
    columns,
    rows: rows.slice(0, 400).map(row => ({
      ...sourceOf(row),
      ...Object.fromEntries(metrics.map(column => [column.key, cell(row[column.source])])),
      ...(columns.some(column => column.key === 'cost') ? { cost: costOf(row.cost) } : {}),
    })),
    total_rows: rows.length,
  }
}
export function presentAssistantResult(endpoint: string, query: string, value: unknown): AssistantResult {
  const body = object(value), params = new URLSearchParams(query)
  const periods: Record<string, string> = { today: '今天', yesterday: '昨天', week: '本周', lastweek: '上周', last7d: '最近 7 天', last30d: '最近 30 天', last90d: '最近 90 天', month: '本月', lastmonth: '上月', year: '今年' }
  const from = Number(params.get('from')), to = Number(params.get('to'))
  const range = params.has('from') && params.has('to') ? `${new Date(from).toLocaleDateString('zh-CN')} — ${new Date(to).toLocaleDateString('zh-CN')}` : periods[params.get('period') ?? ''] ?? '当前查询范围'
  const result: AssistantResult = { result_id: randomUUID(), tool: `stats_${endpoint}`, query, captured_at_ms: Date.now(), title: titles[endpoint] ?? '查询结果', description: range }
  const rows = Array.isArray(body.rows) ? body.rows.map(object) : []
  if (endpoint === 'overview') {
    const cards = [
      { key: 'totalTokens', label: '计费总量', format: count },
      { key: 'calls', label: '调用次数', format: count },
      { key: 'sessions', label: '会话数', format: count },
      { key: 'cacheHitRate', label: '缓存命中率', format: (value: number) => `${(value * 100).toFixed(1)}%` },
    ]
    result.cards = cards.filter(card => numeric(body[card.key])).map(card => ({ label: card.label, value: card.format(body[card.key] as number) }))
    const cost = costOf(body.cost)
    if (cost !== null) result.cards.push({ label: '费用（估算）', value: cost })
    result.table = tableOf([body], [], () => ({}))
    if (typeof object(body.range).label === 'string') result.description = object(body.range).label as string
  } else if (endpoint === 'series') {
    const points = Array.isArray(body.points) ? body.points.map(object) : []
    result.table = tableOf(points, [{ key: 'bucket', label: '时间' }], row => ({ bucket: cell(row.bucket) }))
  } else if (endpoint === 'breakdown') {
    const dimensions: Record<string, string> = { model: '模型', provider: '厂商', source: '来源', user: '成员', group: '分组', project: '项目', day: '日期' }
    result.title = `${dimensions[text(body.by) ?? ''] ?? '维度'}用量分布`
    result.table = tableOf(rows, [{ key: 'dimension', label: dimensions[text(body.by) ?? ''] ?? '维度' }], row => ({ dimension: text(row.label) ?? text(row.key) }))
    if (body.by === 'group') result.note = '成员可属于多个分组，各分组用量之和可能大于部门总量。'
  } else if (endpoint === 'records') {
    result.table = tableOf(rows, [{ key: 'time', label: '时间', format: 'datetime' }, { key: 'model', label: '模型' }, { key: 'provider', label: '厂商' }, { key: 'source', label: '来源' }], row => ({ time: cell(row.ts), model: cell(row.model), provider: cell(row.provider), source: cell(row.source) }))
    result.table.total_rows = numeric(body.total) ? body.total : rows.length
    result.note = `本次返回 ${rows.length} 条明细${numeric(body.offset) && body.offset > 0 ? `，起始位置 ${body.offset}` : ''}；可继续请求下一页。`
  } else if (endpoint === 'diagnostics') {
    const fields = [{ key: 'totalEvents', label: '已入库事件' }, { key: 'unattributedEvents', label: '未归属事件' }, { key: 'identityViolations', label: '口径校验异常' }, { key: 'sessions', label: '会话数' }]
    result.cards = fields.filter(field => numeric(body[field.key])).map(field => ({ label: field.label, value: count(body[field.key] as number) }))
    const sources = Array.isArray(body.sources) ? body.sources.map(object) : []
    result.table = tableOf(sources, [{ key: 'source', label: '来源' }, { key: 'latest_event', label: '最近用量时间', format: 'datetime' }, { key: 'silent_for_ms', label: '距最近用量（毫秒）', format: 'number' }], row => ({ source: cell(row.source), latest_event: cell(row.latestEventTs), silent_for_ms: cell(row.silentForMs) }))
    result.note = '仅展示本次查询范围内已入库的来源；最近用量时间不等于最近上报时间。未上报人员需要结合人员名册核对。'
  } else if (endpoint === 'providers') {
    const providers = Array.isArray(body.providers) ? body.providers : []
    const aliases = Array.isArray(body.aliases) ? body.aliases : []
    const catalog = [...providers.map(provider => ({ provider: cell(provider), origin: '用量数据' })), ...aliases.map(provider => ({ provider: cell(provider), origin: '归一化配置' }))]
    result.table = { columns: [{ key: 'provider', label: '厂商' }, { key: 'origin', label: '目录来源' }], rows: catalog.slice(0, 100), total_rows: catalog.length }
    result.description = '厂商目录快照'
  } else {
    // ★ 目录、诊断、单价仅做有限的标量展开，杜绝把原始对象当作可执行 HTML。
    const array = Object.values(body).find(Array.isArray)
    const catalog: Row[] = Array.isArray(array) ? array.map(item => typeof item === 'object' ? object(item) : { value: item }) : Object.entries(body).filter(([, item]) => item === null || typeof item !== 'object').map(([key, item]) => ({ field: key, value: item }))
    const keys = endpoint === 'pricing' ? ['provider', 'model', 'currency', 'input_micro_per_ktok', 'output_micro_per_ktok', 'cache_read_micro_per_ktok', 'cache_write_micro_per_ktok', 'effective_from_ms', 'effective_to_ms', 'offpeak_schedule', 'offpeak_input_micro_per_ktok', 'offpeak_output_micro_per_ktok', 'offpeak_cache_read_micro_per_ktok', 'offpeak_cache_write_micro_per_ktok', 'note'].filter(key => catalog.some(row => key in row)) : [...new Set(catalog.flatMap(row => Object.keys(row).filter(key => row[key] === null || ['string', 'number'].includes(typeof row[key]))))].slice(0, 12)
    const labels: Record<string, string> = { value: '值', field: '字段', provider: '厂商', model: '模型', currency: '币种', input_micro_per_ktok: '未缓存输入单价', output_micro_per_ktok: '输出单价', cache_read_micro_per_ktok: '缓存读单价', cache_write_micro_per_ktok: '缓存写单价', effective_from_ms: '生效时间', effective_to_ms: '失效时间', offpeak_schedule: '闲时时段', offpeak_input_micro_per_ktok: '闲时输入单价', offpeak_output_micro_per_ktok: '闲时输出单价', offpeak_cache_read_micro_per_ktok: '闲时缓存读单价', offpeak_cache_write_micro_per_ktok: '闲时缓存写单价', note: '备注', status: '状态' }
    result.table = { columns: keys.map(key => ({ key, label: labels[key] ?? key, ...(key.endsWith('_ms') ? { format: 'datetime' as const } : key.includes('micro_per_ktok') ? { format: 'number' as const } : {}) })), rows: catalog.slice(0, 100).map(row => Object.fromEntries(keys.map(key => [key, cell(row[key])]))), total_rows: catalog.length }
    result.description = '当前配置与目录快照'
    if (endpoint === 'pricing') result.note = '单价原值为微币种单位 / 千 Token（1 个币种单位 = 1,000,000 微单位）；不代表本次查询的用量费用。'
  }
  if (result.table && result.table.total_rows > result.table.rows.length && endpoint !== 'records') result.note = `${result.note ? `${result.note} ` : ''}展示前 ${result.table.rows.length} 行，共 ${result.table.total_rows} 行；请缩小查询范围查看后续数据。`
  if (result.table?.rows.some(row => 'cost' in row) || result.cards?.some(card => card.label === '费用（估算）')) result.note = `${result.note ? `${result.note} ` : ''}费用按服务端单价估算；不同币种分别展示，未计价不等于零。`
  return result
}
