/** 根据 Agent 的有限字段映射生成 ECharts；不接受模型生成的脚本或任意 option。 */
import type { EChartsOption } from 'echarts'
import type { AssistantResult, AssistantChartSpec } from '@ai-token-report/shared'

export function assistantChartData(result: AssistantResult, legacyMetric?: string) {
  if (result.echarts && result.table) return { table: result.table, spec: result.echarts }
  const legacy = result.chart
  const series = legacy?.series.find(item => item.key === legacyMetric) ?? legacy?.series[0]
  if (!legacy || !series) return undefined
  // ★ 升级后历史记录仍能打开，数值直接取旧快照，不重新查询或计算。
  return { table: { columns: [{ key: '__label', label: '维度' }, { key: series.key, label: series.label, format: 'number' as const }], rows: legacy.labels.map((label, index) => ({ __label: label, [series.key]: series.values[index] ?? null })), total_rows: legacy.labels.length }, spec: { kind: legacy.kind, x_key: '__label', y_keys: [series.key] } as AssistantChartSpec }
}
export function buildAssistantEchartsOption(result: AssistantResult, legacyMetric?: string): EChartsOption | undefined {
  const prepared = assistantChartData(result, legacyMetric)
  if (!prepared) return undefined
  const { table, spec } = prepared
  const xColumn = table.columns.find(column => column.key === spec.x_key)
  const labelOf = (key: string) => table.columns.find(column => column.key === key)?.label ?? key
  const colors = ['#74a2f6', '#67c1b2', '#ae92e2', '#e9b777']
  const base: EChartsOption = {
    color: colors, animationDuration: 250,
    aria: { enabled: true },
    // ★ richText 避免把模型名等数据当作 HTML 插入提示框。
    tooltip: { trigger: spec.kind === 'pie' || spec.kind === 'scatter' ? 'item' : 'axis', renderMode: 'richText', confine: true },
    legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 10, color: '#68778b' } },
    dataset: { dimensions: table.columns.map(column => ({ name: column.key, displayName: column.label })), source: table.rows },
  }
  if (spec.kind === 'pie') return { ...base, series: [{ type: 'pie', radius: ['35%', '67%'], center: ['50%', '43%'], encode: { itemName: spec.x_key, value: spec.y_keys[0]!, tooltip: [spec.x_key, spec.y_keys[0]!] }, label: { show: table.rows.length <= 8, fontSize: 10 }, avoidLabelOverlap: true }] }
  const horizontal = spec.kind === 'bar' && spec.horizontal
  const isPercent = table.columns.find(column => column.key === spec.y_keys[0])?.format === 'percent'
  const valueAxis = { type: 'value' as const, axisLabel: { fontSize: 10, color: '#8b99ad', ...(isPercent ? { formatter: (value: number) => `${(value * 100).toFixed(0)}%` } : {}) }, splitLine: { lineStyle: { color: '#eef2f8' } } }
  const labelAxis = { type: (spec.kind === 'scatter' ? 'value' : xColumn?.format === 'datetime' ? 'time' : 'category') as 'category' | 'time' | 'value', axisLabel: { fontSize: 9, color: '#8b99ad', hideOverlap: true }, axisLine: { lineStyle: { color: '#e6edf7' } }, axisTick: { show: false } }
  return { ...base,
    grid: { top: 15, right: 15, bottom: 45, left: 10, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    xAxis: horizontal ? valueAxis : labelAxis,
    yAxis: horizontal ? { ...labelAxis, inverse: true } : valueAxis,
    series: spec.y_keys.map(key => ({ type: spec.kind as 'line' | 'bar' | 'scatter', name: labelOf(key), encode: { x: horizontal ? key : spec.x_key, y: horizontal ? spec.x_key : key, tooltip: [spec.x_key, key] }, ...(spec.kind === 'line' ? { connectNulls: false, symbolSize: 5, ...(spec.area ? { areaStyle: { opacity: .12 } } : {}) } : spec.kind === 'bar' ? { barMaxWidth: 32 } : { symbolSize: 10 }) })),
  }
}
