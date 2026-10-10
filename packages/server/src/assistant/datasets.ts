/** 会话内的数据集与渲染工具：模型仅选字段与展示方式，数值始终来自授权 API。 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssistantResult, AssistantRenderRequest, AssistantChartSpec } from '@ai-token-report/shared'
import { IdentityError, type Principal } from '../identity/types.js'
import { presentAssistantResult } from './presentation.js'
import { replaceAssistantFile } from './atomic-file.js'

interface Dataset { snapshot: AssistantResult; access: string }
const MAX_DATASETS = 20
const scopeOf = (p: Principal) => JSON.stringify([p.memberId, [...p.roleCodes ?? []].sort(), [...p.permissions].sort(), [...p.groupIds ?? []].sort()])
const failure = (message: string): never => { throw new IdentityError(400, message) }
const object = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : failure('渲染参数需要是对象')
const uniqueKeys = (input: unknown, max: number): string[] => {
  if (!Array.isArray(input) || !input.length || input.length > max || input.some(key => typeof key !== 'string') || new Set(input).size !== input.length) return failure(`字段需要是 1～${max} 个不重复的名称`)
  return input as string[]
}
export class AssistantDatasets {
  private datasets = new Map<string, Dataset>()
  constructor(private directory?: string) {}
  async load(): Promise<void> {
    if (!this.directory) return
    try {
      const raw = await readFile(join(this.directory, 'datasets.json'), 'utf8')
      if (raw.length > 8_000_000) throw new Error('助手数据集快照超过上限')
      const stored = JSON.parse(raw) as { version: number; datasets: Dataset[] }
      if (stored.version !== 1 || !Array.isArray(stored.datasets) || stored.datasets.length > MAX_DATASETS) throw new Error('助手数据集快照格式不兼容')
      for (const entry of stored.datasets) {
        if (typeof entry.access !== 'string' || !entry.snapshot?.dataset_id || !entry.snapshot.table || entry.snapshot.table.rows.length > 400) throw new Error('助手数据集快照无效')
        this.datasets.set(entry.snapshot.dataset_id, entry)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async save(): Promise<void> {
    if (!this.directory) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ version: 1, datasets: [...this.datasets.values()] }), { mode: 0o600 })
    await replaceAssistantFile(temporary, join(this.directory, 'datasets.json'))
  }
  capture(endpoint: string, query: string, data: unknown, principal: Principal): AssistantResult {
    const snapshot = presentAssistantResult(endpoint, query, data)
    snapshot.dataset_id = snapshot.result_id
    // ★ 查询仅产生数据。接口种类不决定图形，旧记录仍保留兼容读取能力。
    this.datasets.set(snapshot.dataset_id, { snapshot, access: scopeOf(principal) })
    while (this.datasets.size > MAX_DATASETS) this.datasets.delete(this.datasets.keys().next().value!)
    return snapshot
  }
  list(principal: Principal) {
    return [...this.datasets.values()].filter(entry => entry.access === scopeOf(principal)).map(({ snapshot }) => ({
      dataset_id: snapshot.dataset_id, title: snapshot.title, query: snapshot.query, captured_at_ms: snapshot.captured_at_ms,
      columns: snapshot.table!.columns, row_count: snapshot.table!.rows.length, total_rows: snapshot.table!.total_rows, card_names: snapshot.cards?.map(card => card.label) ?? [],
    }))
  }
  render(mode: 'table' | 'echarts' | 'cards', input: unknown, principal: Principal): AssistantResult {
    const raw = object(input)
    if (Object.keys(raw).some(key => !['dataset_id', 'title', 'columns', 'chart', 'cards'].includes(key))) return failure('不支持渲染参数；禁止传入原始数值、HTML 或任意 ECharts option')
    if (typeof raw.dataset_id !== 'string') return failure('dataset_id 需要来自统计查询结果')
    const entry = this.datasets.get(raw.dataset_id)
    if (!entry) return failure('数据集不存在或已过期，请先查询数据；可用 list_datasets 查看当前数据集')
    if (entry.access !== scopeOf(principal)) throw new IdentityError(403, '数据集所属身份或权限已变化，请重新查询')
    if (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 80)) return failure('展示标题需要为 1～80 个字符')
    const request = raw as unknown as AssistantRenderRequest
    const result = structuredClone(entry.snapshot)
    result.result_id = randomUUID(); result.display = mode
    if (request.title) result.title = request.title.trim()
    if (mode !== 'cards') delete result.cards
    if (mode === 'table') {
      if (request.chart || request.cards) return failure('render_table 只接受列选择')
      if (request.columns) {
        const keys = uniqueKeys(request.columns, 16)
        if (keys.some(key => !result.table?.columns.some(column => column.key === key))) return failure('表格列不在数据集中')
        result.table!.columns = keys.map(key => result.table!.columns.find(column => column.key === key)!)
        result.table!.rows = result.table!.rows.map(row => Object.fromEntries(keys.map(key => [key, row[key] ?? null])))
      }
    } else if (mode === 'cards') {
      if (request.chart || request.columns) return failure('render_cards 只接受指标选择')
      if (!result.cards?.length) return failure('这个数据集没有服务端指标卡片，请选择表格或图表')
      if (request.cards) {
        const names = uniqueKeys(request.cards, 8)
        if (names.some(name => !result.cards!.some(card => card.label === name))) return failure('指标不在数据集中')
        result.cards = names.map(name => result.cards!.find(card => card.label === name)!)
      }
      delete result.table
    } else {
      if (request.columns || request.cards) return failure('render_echarts 只接受图形与字段映射')
      const spec = object(request.chart)
      if (Object.keys(spec).some(key => !['kind', 'x_key', 'y_keys', 'horizontal', 'area'].includes(key)) || !['line', 'bar', 'pie', 'scatter'].includes(String(spec.kind))) return failure('图表支持 line、bar、pie、scatter；禁止自定义脚本或 option')
      const table = result.table!
      if (typeof spec.x_key !== 'string' || !table.columns.some(column => column.key === spec.x_key)) return failure('图表横轴字段不在数据集中')
      const yKeys = uniqueKeys(spec.y_keys, 4)
      const yColumns = yKeys.map(key => table.columns.find(column => column.key === key))
      if (yColumns.some(column => !column || !['number', 'percent'].includes(column.format ?? ''))) return failure('图表数值字段必须是数据集中的数值或比率列')
      if (!table.rows.length) return failure('数据集没有行，请使用表格说明空数据')
      if (yKeys.some(key => table.rows.some(row => row[key] !== null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))))) return failure('图表数值列包含非数值内容')
      if (yColumns.some(column => column?.format === 'percent') && yColumns.some(column => column?.format !== 'percent')) return failure('比率与计数需要分开画图，不能共用数值轴')
      if (yColumns.some(column => column?.key === 'calls') && yColumns.some(column => column?.key !== 'calls')) return failure('调用次数与 Token 数需要分开画图')
      if (spec.kind === 'pie') {
        if (yKeys.length !== 1 || table.rows.some(row => typeof row[yKeys[0]!] !== 'number' || Number(row[yKeys[0]!]) < 0)) return failure('饼图需要单个无空值、非负数值字段')
        if (entry.snapshot.query.includes('by=group') || yColumns[0]?.format === 'percent') return failure('分组多对多与比率不能视为整体份额，请使用柱状图或表格')
      }
      if (spec.kind === 'scatter' && (yKeys.length !== 1 || table.rows.some(row => typeof row[spec.x_key as string] !== 'number' || !Number.isFinite(row[spec.x_key as string])))) return failure('散点图需要数值横轴与一个数值纵轴')
      for (const key of ['horizontal', 'area']) if (spec[key] !== undefined && typeof spec[key] !== 'boolean') return failure(`${key} 需要是布尔值`)
      if ((spec.horizontal && spec.kind !== 'bar') || (spec.area && spec.kind !== 'line')) return failure('horizontal 仅用于柱状图，area 仅用于折线图')
      result.echarts = { kind: spec.kind, x_key: spec.x_key, y_keys: yKeys, ...(spec.horizontal !== undefined ? { horizontal: spec.horizontal } : {}), ...(spec.area !== undefined ? { area: spec.area } : {}) } as AssistantChartSpec
    }
    return result
  }
}
