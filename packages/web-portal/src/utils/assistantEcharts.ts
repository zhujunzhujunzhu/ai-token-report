/**
 * 根据 Agent 的有限字段映射生成 ECharts；不接受模型生成的脚本或任意 option。
 *
 * ## 时间分桶要接两条格式化入口
 *
 * 服务端给的分桶键是 `2026-10-13T11`（`aggregate.ts` 的 `toHourKey()`），
 * 直接在图上出会得到「轴上与提示框里都是一串机器格式」。ECharts 取这两个位置的值
 * 走的是**两条不同的路径**：
 *
 * - 轴刻度 → `axisLabel.formatter`；
 * - 提示框的**标题行** → 轴指针的 `axisPointer.label.formatter`
 *   （`axisPointer/viewHelper.getValueLabel()` 只认它，`axisLabel.formatter` 管不到）。
 *
 * ⚠️ 两条缺一，就会出现「轴上写着 `11:00`、提示框里仍是 `2026-10-13T11`」这种
 *   半修状态。分桶键一律**按字符串切**，绝不 `new Date(bucket)`：它是服务端本地时区
 *   的「哪一小时」，用浏览器时区解析会整体位移，而位移出来的图看起来完全正常。
 *
 * ⚠️ 轴触发的提示框**不带 x 维度**（`encode.tooltip` 只列 y）：标题行已经写着这个
 *   时间，带上 x 会让同一行变成「时间  时间  数值」。饼图仍要带 —— 那里 x 就是切片名。
 */
import type { EChartsOption } from 'echarts'
import type { AssistantResult, AssistantChartSpec } from '@ai-token-report/shared'
import { bucketGranularityOf, formatBucket, formatBucketFull } from './format.js'

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
  // 粒度只从值上认；认不出来（模型 / 厂商 / 项目）就是 null，那时一位也不动。
  const granularity = bucketGranularityOf(table.rows.map(row => row[spec.x_key]))
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
  const axisTrigger = spec.kind === 'line' || spec.kind === 'bar'
  const isPercent = table.columns.find(column => column.key === spec.y_keys[0])?.format === 'percent'
  const valueAxis = { type: 'value' as const, axisLabel: { fontSize: 10, color: '#8b99ad', ...(isPercent ? { formatter: (value: number) => `${(value * 100).toFixed(0)}%` } : {}) }, splitLine: { lineStyle: { color: '#eef2f8' } } }
  // ⚠️ `type` 必须写成**字面量**（三条分支各一个），不能写成一个联合再拼公共属性：
  //   ECharts 的轴选项是按 `type` 判别的联合，字段里一旦挂上 formatter，联合分布就失败。
  const axisChrome = { axisLine: { lineStyle: { color: '#e6edf7' } }, axisTick: { show: false } }
  const labelStyle = { fontSize: 9, color: '#8b99ad', hideOverlap: true }
  const labelAxis = spec.kind === 'scatter'
    ? { type: 'value' as const, axisLabel: labelStyle, ...axisChrome }
    : xColumn?.format === 'datetime'
      ? { type: 'time' as const, axisLabel: labelStyle, ...axisChrome }
      : {
          type: 'category' as const,
          // 轴刻度要短（`11:00` / `10-13`），与部门看板、本地页同一套约定（`formatBucket`）。
          axisLabel: { ...labelStyle, ...(granularity ? { formatter: (value: string) => formatBucket(value, granularity) } : {}) },
          ...axisChrome,
          // ★ 提示框的**标题行**走这里（`axisLabel.formatter` 管不到它）：写全
          //   `2026-10-13 11:00`，别让人去猜是哪一天。取数路径见文件头。
          ...(granularity ? { axisPointer: { label: { formatter: (params: { value: unknown }) => formatBucketFull(String(params.value)) } } } : {}),
        }
  return { ...base,
    grid: { top: 15, right: 15, bottom: 45, left: 10, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    xAxis: horizontal ? valueAxis : labelAxis,
    yAxis: horizontal ? { ...labelAxis, inverse: true } : valueAxis,
    series: spec.y_keys.map(key => ({ type: spec.kind as 'line' | 'bar' | 'scatter', name: labelOf(key), encode: { x: horizontal ? key : spec.x_key, y: horizontal ? spec.x_key : key, tooltip: axisTrigger ? [key] : [spec.x_key, key] }, ...(spec.kind === 'line' ? { connectNulls: false, symbolSize: 5, ...(spec.area ? { areaStyle: { opacity: .12 } } : {}) } : spec.kind === 'bar' ? { barMaxWidth: 32 } : { symbolSize: 10 }) })),
  }
}