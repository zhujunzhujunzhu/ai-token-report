/** 真实 ECharts SVG 与字段映射验证；不同图形共享 API 原始数值。 */
import { expect, test } from 'bun:test'
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { AssistantResult } from '@ai-token-report/shared'
import { buildAssistantEchartsOption } from '../src/utils/assistantEcharts.js'
use([BarChart, LineChart, PieChart, ScatterChart, DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])
const result: AssistantResult = { result_id: '验收', dataset_id: '数据集', tool: 'stats_breakdown', query: 'by=model', title: '同一查询', description: '验收', captured_at_ms: 1, display: 'echarts', table: { columns: [{ key: 'model', label: '模型' }, { key: 'tokens', label: 'Token', format: 'number' }], rows: [{ model: '模型甲', tokens: 500 }, { model: '模型乙', tokens: 100 }], total_rows: 2 } }
/** 逐小时趋势：服务端给的是 `aggregate.ts` 的 `toHourKey()`，人读不出来。 */
const hourly: AssistantResult = { ...result, table: { columns: [{ key: 'bucket', label: '时间' }, { key: 'total_tokens', label: '计费总量', format: 'number' }], rows: [{ bucket: '2026-10-13T10', total_tokens: 1 }, { bucket: '2026-10-13T11', total_tokens: 135_166_647 }], total_rows: 2 }, echarts: { kind: 'line', x_key: 'bucket', y_keys: ['total_tokens'] } }
test('同一数据可渲染为 ECharts 柱状图和饼图，实际生成 SVG，并保持数值不变', () => {
  for (const kind of ['bar', 'pie'] as const) {
    const option = buildAssistantEchartsOption({ ...result, echarts: { kind, x_key: 'model', y_keys: ['tokens'] } })!
    expect((option.dataset as { source: unknown }).source).toEqual(result.table!.rows)
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 450, height: 250 })
    chart.setOption({ ...option, animation: false })
    expect(chart.renderToSVGString()).toContain('<svg')
    expect(chart.renderToSVGString()).toContain('<path')
    chart.dispose()
  }
})
test('折线图的缺席数值保留 null；数据文字不能成为可执行 HTML', () => {
  const option = buildAssistantEchartsOption({ ...result, table: { ...result.table!, rows: [{ model: '<script>危险内容</script>', tokens: null }] }, echarts: { kind: 'line', x_key: 'model', y_keys: ['tokens'] } })!
  expect((option.dataset as { source: unknown }).source).toEqual([{ model: '<script>危险内容</script>', tokens: null }])
  expect(option.tooltip).toMatchObject({ renderMode: 'richText' })
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 450, height: 250 })
  chart.setOption({ ...option, animation: false })
  expect(chart.renderToSVGString()).not.toContain('<script>')
  chart.dispose()
})
test('★ 分桶键在轴上短写、在提示框标题上写全（两条取值路径都要接）', async () => {
  const option = buildAssistantEchartsOption(hourly)!
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 450, height: 250 })
  chart.setOption({ ...option, animation: false })
  const svg = chart.renderToSVGString()
  expect(svg).toContain('11:00')
  expect(svg).not.toContain('2026-10-13T11')

  // 🚨 提示框的**标题行**不读 `axisLabel.formatter` —— ECharts 走
  //   `axisPointer/viewHelper.getValueLabel()`，formatter 取自轴自己的 `axisPointer.label`。
  //   这里调的就是生产上那条路径：拿到轴模型、用它的 axisPointer 配置去取标签。
  //   ★ ECharts 换版后这条断言会先炸（说明取值路径变了），此时必须重新确认标题怎么格式化。
  const ecModel = (chart as unknown as { getModel: () => { getComponent: (type: string, index: number) => { axis: unknown; getModel: (name: string) => { get: (path: string[]) => unknown } } } }).getModel()
  const axisModel = ecModel.getComponent('xAxis', 0)
  const axisPointerModel = axisModel.getModel('axisPointer')
  const { getValueLabel } = await import('echarts/lib/component/axisPointer/viewHelper.js')
  const header = getValueLabel('2026-10-13T11', axisModel.axis, ecModel, [], {
    precision: axisPointerModel.get(['label', 'precision']),
    formatter: axisPointerModel.get(['label', 'formatter']),
  })
  expect(header).toBe('2026-10-13 11:00')
  chart.dispose()
})
test('轴触发的提示框不再重复时间维度；饼图仍带切片名', () => {
  const axis = buildAssistantEchartsOption({ ...hourly, echarts: { kind: 'bar', x_key: 'bucket', y_keys: ['total_tokens'] } })!
  expect((axis.series as Array<{ encode: { tooltip: string[] } }>)[0]!.encode.tooltip).toEqual(['total_tokens'])
  const pie = buildAssistantEchartsOption({ ...result, echarts: { kind: 'pie', x_key: 'model', y_keys: ['tokens'] } })!
  expect((pie.series as Array<{ encode: { tooltip: string[] } }>)[0]!.encode.tooltip).toEqual(['model', 'tokens'])
})
test('不是分桶的 x 列一位都不动；历史快照里的分桶键同样被格式化', () => {
  const plain = buildAssistantEchartsOption({ ...result, echarts: { kind: 'bar', x_key: 'model', y_keys: ['tokens'] } })!
  const plainAxis = plain.xAxis as { axisLabel: { formatter?: unknown }, axisPointer?: unknown }
  expect(plainAxis.axisLabel.formatter).toBeUndefined()
  expect(plainAxis.axisPointer).toBeUndefined()

  // 旧快照（升级前的 `chart` 载荷）的 labels 就是分桶键，历史记录打开时也要跟着修好。
  const legacy: AssistantResult = { ...result, chart: { kind: 'line', labels: ['2026-10-13T10', '2026-10-13T11'], series: [{ key: 'total_tokens', label: '计费总量', values: [1, 2] }] } }
  const legacyAxis = buildAssistantEchartsOption(legacy)!.xAxis as { axisLabel: { formatter: (value: string) => string } }
  expect(legacyAxis.axisLabel.formatter('2026-10-13T11')).toBe('11:00')
})
test('日分桶：轴上省年份，提示框标题保留完整日期', () => {
  const daily: AssistantResult = { ...result, table: { columns: [{ key: 'bucket', label: '时间' }, { key: 'total_tokens', label: '计费总量', format: 'number' }], rows: [{ bucket: '2026-10-12', total_tokens: 1 }, { bucket: '2026-10-13', total_tokens: 2 }], total_rows: 2 }, echarts: { kind: 'line', x_key: 'bucket', y_keys: ['total_tokens'] } }
  const axis = buildAssistantEchartsOption(daily)!.xAxis as { axisLabel: { formatter: (value: string) => string }, axisPointer: { label: { formatter: (params: { value: unknown }) => string } } }
  expect(axis.axisLabel.formatter('2026-10-13')).toBe('10-13')
  expect(axis.axisPointer.label.formatter({ value: '2026-10-13' })).toBe('2026-10-13')
})