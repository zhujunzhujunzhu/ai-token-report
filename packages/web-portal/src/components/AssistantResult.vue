<script setup lang="ts">
/** 工具数据的指标卡片、图表和分页表格；图表配置由应用生成，不执行模型提供的代码。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init, use, type ECharts } from 'echarts/core'
import { LineChart, BarChart, PieChart, ScatterChart } from 'echarts/charts'
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { DataAnalysis, Grid, Download } from '@element-plus/icons-vue'
import type { AssistantResult } from '@ai-token-report/shared'
import { assistantChartData, buildAssistantEchartsOption } from '../utils/assistantEcharts.js'
import { formatCount, formatPercent, formatFullDateTime } from '../utils/format.js'
import { assistantTableCsv } from '../utils/assistantCsv.js'
use([LineChart, BarChart, PieChart, ScatterChart, DatasetComponent, GridComponent, LegendComponent, TooltipComponent, AriaComponent, SVGRenderer])
const props = defineProps<{ result: AssistantResult }>()
const mode = ref<'chart' | 'table'>(props.result.display === 'echarts' || (!props.result.display && props.result.chart) ? 'chart' : 'table')
const metric = ref(props.result.chart?.series[0]?.key ?? '')
const page = ref(1)
const pageSize = 8
const plot = ref<HTMLDivElement>()
let chart: ECharts | undefined
let resize: ResizeObserver | undefined
const prepared = computed(() => assistantChartData(props.result, metric.value))
const chartNames = { line: '折线图', bar: '柱状图', pie: '饼图', scatter: '散点图' }
const rows = computed(() => props.result.table?.rows.slice((page.value - 1) * pageSize, page.value * pageSize) ?? [])
const pages = computed(() => Math.max(1, Math.ceil((props.result.table?.rows.length ?? 0) / pageSize)))
function draw() {
  resize?.disconnect(); chart?.dispose(); chart = undefined
  const option = buildAssistantEchartsOption(props.result, metric.value)
  if (!plot.value || mode.value !== 'chart' || !option) return
  chart = init(plot.value, undefined, { renderer: 'svg' }); chart.setOption(option)
  resize = new ResizeObserver(() => chart?.resize()); resize.observe(plot.value)
}
onMounted(draw)
watch(() => [mode.value, metric.value, props.result], draw, { flush: 'post' })
onBeforeUnmount(() => { resize?.disconnect(); chart?.dispose() })
function display(value: string | number | null | undefined, format?: string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'number') return value
  if (format === 'percent') return formatPercent(value)
  if (format === 'datetime') return formatFullDateTime(value)
  return formatCount(value)
}
function download() {
  const table = props.result.table
  if (!table) return
  const url = URL.createObjectURL(new Blob([assistantTableCsv(table)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `assistant-${props.result.result_id}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section class="assistant-result" :aria-label="result.title">
    <header><div><strong>{{ result.title }}</strong><small>{{ result.description }} · {{ new Date(result.captured_at_ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }} 查询快照</small></div><button v-if="result.table?.rows.length" class="result-download" aria-label="导出这份查询结果为 CSV" title="导出 CSV" @click="download"><Download /></button></header>
    <div v-if="result.cards?.length" class="result-cards"><div v-for="card in result.cards" :key="card.label"><span>{{ card.label }}</span><strong>{{ card.value }}</strong></div></div>
    <div v-if="prepared || result.table?.columns.length" class="result-toolbar">
      <div class="result-tabs" aria-label="查询结果展示方式"><button v-if="prepared" :class="{ selected: mode === 'chart' }" :aria-pressed="mode === 'chart'" @click="mode = 'chart'"><DataAnalysis />图表</button><button v-if="result.table" :class="{ selected: mode === 'table' }" :aria-pressed="mode === 'table'" @click="mode = 'table'"><Grid />表格</button></div>
      <span v-if="mode === 'chart' && result.echarts" class="result-chart-kind">ECharts · {{ chartNames[result.echarts.kind] }}</span>
      <select v-if="mode === 'chart' && result.chart" v-model="metric" aria-label="图表指标"><option v-for="series in result.chart.series" :key="series.key" :value="series.key">{{ series.label }}</option></select>
    </div>
    <div v-if="mode === 'chart' && prepared" ref="plot" class="result-plot" role="img" :aria-label="`${result.title}：${chartNames[prepared.spec.kind]}，${prepared.table.rows.length} 个数据点；可以查看数值或切换表格`" />
    <div v-else-if="result.table?.rows.length" class="result-table-scroll" tabindex="0" aria-label="查询数据表，可横向滚动"><table><thead><tr><th v-for="column in result.table.columns" :key="column.key" scope="col">{{ column.label }}</th></tr></thead><tbody><tr v-for="(row, index) in rows" :key="index"><td v-for="column in result.table.columns" :key="column.key" :class="{ numeric: column.format === 'number' || column.format === 'percent' }">{{ display(row[column.key], column.format) }}</td></tr></tbody></table></div>
    <p v-else-if="!result.cards?.length" class="result-empty">这个查询范围内没有数据</p>
    <div v-if="mode === 'table' && result.table?.rows.length" class="result-pagination"><span>{{ result.table.total_rows }} 行 · 已返回 {{ result.table.rows.length }} 行</span><div><button :disabled="page <= 1" aria-label="查询表格上一页" @click="page--">‹</button><span>{{ page }} / {{ pages }}</span><button :disabled="page >= pages" aria-label="查询表格下一页" @click="page++">›</button></div></div>
    <p v-if="result.note" class="result-note">{{ result.note }}</p>
  </section>
</template>

<style scoped>
.assistant-result { margin: 12px 0; border: 1px solid #e2eaf7; border-radius: 13px; background: #fff; overflow: hidden; min-width: 0; }
.assistant-result > header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 13px 14px; border-bottom: 1px solid #edf1f8; }
.assistant-result > header strong { display: block; font-size: 12px; font-weight: 600; color: #355681; }
.assistant-result > header small { display: block; margin-top: 5px; font-size: 10px; color: #8b99ad; line-height: 1.5; }
.result-download { flex-shrink: 0; display: grid; place-items: center; width: 27px; height: 27px; border: 0; border-radius: 7px; color: #8299b9; background: #f3f7fd; }
.result-download svg { width: 15px; height: 15px; }
.result-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: #edf1f8; border-bottom: 1px solid #edf1f8; }
.result-cards > div { padding: 14px; background: #f8faff; min-width: 0; }
.result-cards span { display: block; font-size: 10px; color: #7c8aa0; }
.result-cards strong { display: block; font-size: 18px; color: #355681; margin-top: 7px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.result-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; }
.result-tabs { display: flex; gap: 3px; background: #f1f5fc; padding: 3px; border-radius: 8px; }
.result-tabs button { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: #8b99ad; font-size: 10px; padding: 4px 7px; border-radius: 5px; }
.result-tabs button.selected { background: #fff; color: #3275ed; box-shadow: 0 1px 3px #24334b09; }
.result-tabs svg { width: 12px; height: 12px; }
.result-toolbar select { max-width: 130px; padding: 4px 6px; border: 1px solid #e7edf7; border-radius: 6px; color: #68778b; font-size: 10px; background: #fff; }
.result-chart-kind { font-size: 10px; color: #8b99ad; }
.result-plot { position: relative; height: 250px; margin: 0 12px 12px; }
.result-table-scroll { overflow: auto; max-height: 320px; scrollbar-width: thin; overscroll-behavior: contain; }
.result-table-scroll table { width: 100%; border-collapse: collapse; font-size: 11px; }
.result-table-scroll th { padding: 9px 11px; background: #f6f9ff; color: #8190a6; font-weight: 500; text-align: left; white-space: nowrap; }
.result-table-scroll td { padding: 10px 11px; border-bottom: 1px solid #eef2f8; color: #53637a; white-space: nowrap; max-width: 250px; overflow: hidden; text-overflow: ellipsis; }
.result-table-scroll tbody tr:hover { background: #f8faff; }
.result-table-scroll td.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.result-pagination { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; color: #8b99ad; font-size: 10px; }
.result-pagination > div { display: flex; align-items: center; gap: 8px; }
.result-pagination button { width: 22px; height: 22px; border: 1px solid #e6edf7; border-radius: 5px; background: #fff; color: #68778b; }
.result-pagination button:disabled { opacity: .4; cursor: not-allowed; }
.result-empty { padding: 20px; margin: 0; text-align: center; color: #8b99ad; font-size: 12px; }
.result-note { margin: 0; padding: 10px 12px; font-size: 10px; color: #8b99ad; line-height: 1.8; background: #f8faff; border-top: 1px solid #edf1f8; }
</style>
