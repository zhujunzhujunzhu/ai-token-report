/** 图表验证直接渲染生产组件；根 App 的署名 loading 态不包含图表。 */
import { createServer } from 'vite'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { resolve } from 'node:path'
import type { ChartCard } from '../src/types/usage'

export async function renderChartFixture(includeStacked = false): Promise<string> {
  const server = await createServer({
    root: resolve(import.meta.dir, '..'), server: { middlewareMode: true }, appType: 'custom',
    logLevel: 'error', optimizeDeps: { noDiscovery: true },
  })
  try {
    const { default: Panel } = await server.ssrLoadModule('/src/components/usage/MetricChartPanel.vue')
    const labels = ['09:00', '10:00', '11:00', '12:00']
    const cards: ChartCard[] = [
      { key: 'tokens', title: '计费总量', total: '100', ticks: ['0', '20', '40'], chart: {
        kind: 'bar', labels, values: [10, 20, 30, 40], layers: [], color: 'var(--c-chart-bar-light)', fillColor: 'var(--c-chart-bar-light)',
      } },
      { key: 'calls', title: '调用次数', total: '10', ticks: ['0', '2', '4'], chart: {
        kind: 'area', labels, values: [1, 2, 3, 4], layers: [], color: 'var(--c-chart-area-line)', fillColor: 'var(--c-chart-area-fill)',
      } },
    ]
    if (includeStacked) cards.push({ key: 'stacked', title: '堆叠', total: '30', ticks: ['0', '5', '10'], chart: {
      kind: 'stackedBar', labels, values: [], color: '', fillColor: '',
      layers: ['chat', 'reasoner', 'coder'].map((name) => ({ name, values: [1, 2, 3, 4], color: `var(--c-series-${name})` })),
    } })
    return await renderToString(createSSRApp({ render: () => h('main', cards.map((card) => h(Panel, { card }))) }))
  } finally { await server.close() }
}
