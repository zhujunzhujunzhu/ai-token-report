/** 趋势图只展示宿主已算好的序列；按需注册 Chart.js，卸载时释放画布与监听。 */
import { createElement as h, useEffect, useRef, useState } from 'react'
import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  CategoryScale, LinearScale, Tooltip, Filler, type ChartConfiguration,
} from 'chart.js'
import { fmtCompact, fmtInt, fmtPct, shortBucket } from './format.js'
import type { UiSeriesPoint } from './protocol.js'

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler)

export type TrendMetric = 'total' | 'calls' | 'cacheHitRate'
const LABELS = { total: 'Token 总量', calls: '调用数', cacheHitRate: '命中率' }

export function Trend(props: { series: UiSeriesPoint[]; metric: TrendMetric }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart<'bar' | 'line'>>()
  const { series, metric } = props
  const [dataOpen, setDataOpen] = useState(false)
  const [dataPage, setDataPage] = useState(1)
  const dataPageSize = 50
  const dataPages = Math.max(1, Math.ceil(series.length / dataPageSize))
  const currentDataPage = Math.min(dataPage, dataPages)
  useEffect(() => setDataPage(1), [series])
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const draw = () => {
      const css = getComputedStyle(element)
      const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
      const accent = color('--atr-accent', '#536de5')
      const text = color('--dsw-alias-label-secondary', '#667085')
      const grid = color('--dsw-alias-border-l1', '#e8ecf2')
      const surface = color('--dsw-alias-bg-base', '#ffffff')
      const primary = color('--dsw-alias-label-primary', '#182230')
      const isRate = metric === 'cacheHitRate'
      const config: ChartConfiguration<'bar' | 'line'> = {
        type: isRate ? 'line' : 'bar',
        data: {
          labels: series.map(point => point.bucket),
          datasets: [{
            label: LABELS[metric], data: series.map(point => point[metric]),
            backgroundColor: isRate ? color('--atr-chart-fill', 'rgba(83,109,229,.12)') : accent,
            borderColor: accent, borderWidth: isRate ? 2 : 0,
            borderRadius: 5, maxBarThickness: 36,
            // 直线连接实际采样点，避免平滑插值画出超过 100% 的命中率。
            tension: 0, fill: isRate, pointRadius: series.length > 40 ? 0 : 3, pointHoverRadius: 5,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          layout: { padding: { top: 8, right: 8 } },
          scales: {
            x: {
              grid: { display: false }, border: { display: false },
              ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 10,
                callback: (_value, index) => shortBucket(series[index]?.bucket ?? '') },
            },
            y: {
              beginAtZero: true, ...(isRate ? { max: 1 } : {}),
              border: { display: false }, grid: { color: grid, drawTicks: false },
              ticks: { color: text, padding: 12, maxTicksLimit: 5,
                ...(metric === 'calls' ? { precision: 0 } : {}),
                callback: value => isRate ? fmtPct(Number(value), 0) : fmtCompact(Number(value)) },
            },
          },
          plugins: {
            tooltip: {
              backgroundColor: surface, titleColor: primary, bodyColor: text,
              borderColor: grid, borderWidth: 1, cornerRadius: 10, padding: 14,
              displayColors: false, titleMarginBottom: 8,
              callbacks: {
                title: items => series[items[0]?.dataIndex ?? 0]?.bucket.replace('T', ' ') ?? '',
                label: item => {
                  const point = series[item.dataIndex]
                  return point ? [`Token 总量  ${fmtInt(point.total)}`, `调用数  ${fmtInt(point.calls)}`, `命中率  ${fmtPct(point.cacheHitRate)}`] : ''
                },
              },
            },
          },
        },
      }
      if (chart.current) {
        // 复用同一画布与实例，在一帧内替换数据，避免切范围时先清空再重建。
        if ('type' in chart.current.config) chart.current.config.type = config.type
        chart.current.data = config.data
        chart.current.options = config.options ?? {}
        chart.current.setActiveElements([])
        chart.current.tooltip?.setActiveElements([], { x: 0, y: 0 })
        chart.current.update('none')
      } else {
        chart.current = new Chart(element, config)
      }
    }
    draw()
    // 主题可挂在任一祖先上，只监听祖先属性，避免图表自身重绘触发循环。
    const observer = new MutationObserver(draw)
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    }
    return () => observer.disconnect()
  }, [series, metric])
  useEffect(() => () => { chart.current?.destroy(); chart.current = undefined }, [])

  return h('div', null,
    h('div', { className: 'atr-chart' }, h('canvas', {
      ref: canvas, role: 'img', 'aria-label': `${LABELS[metric]}趋势图，${series.length} 个时间点；精确值见图表数据`,
    })),
    h('details', { className: 'atr-chart-data', onToggle: (event: { currentTarget: HTMLDetailsElement }) => setDataOpen(event.currentTarget.open) },
      h('summary', null, '查看图表数据'),
      // 原生 details 只隐藏内容，不延迟创建 DOM；展开后才挂载一页精确值。
      dataOpen ? h('div', null,
      h('div', { className: 'atr-chart-table' }, h('table', null,
        h('thead', null, h('tr', null, ...['时间', 'Token 总量', '调用数', '命中率'].map(label => h('th', { key: label }, label)))),
        h('tbody', null, ...series.slice((currentDataPage - 1) * dataPageSize, currentDataPage * dataPageSize).map(point => h('tr', { key: point.bucket },
          h('th', { scope: 'row' }, point.bucket.replace('T', ' ') + (point.bucket.includes('T') ? '时' : '')),
          h('td', null, fmtInt(point.total)), h('td', null, fmtInt(point.calls)), h('td', null, fmtPct(point.cacheHitRate))))))),
      dataPages > 1 ? h('nav', { className: 'atr-pagination', 'aria-label': '图表数据分页' },
        h('button', { type: 'button', className: 'atr-btn', disabled: currentDataPage === 1,
          onClick: () => setDataPage(currentDataPage - 1) }, '上一页'),
        h('span', { role: 'status' }, `${currentDataPage} / ${dataPages} · 共 ${series.length} 个时间点`),
        h('button', { type: 'button', className: 'atr-btn', disabled: currentDataPage === dataPages,
          onClick: () => setDataPage(currentDataPage + 1) }, '下一页')) : null) : null))
}
