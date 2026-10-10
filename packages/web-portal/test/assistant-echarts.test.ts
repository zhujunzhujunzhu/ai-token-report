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
