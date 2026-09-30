/**
 * 趋势图校验（人工跑，不进 CI）：`bun run --filter '@ai-token-report/web-portal' verify`
 *
 * ## 它防的是什么
 *
 * 换成 Chart.js 之后，图变成一块 canvas —— 里面画了什么，SSR 出来的 HTML 里
 * **一个字都看不见**。于是「悬浮提示没了」这类退化不会有任何测试变红，
 * 只会表现为「鼠标移上去什么也不出现」。
 *
 * 所以这里分两层断言：
 *
 * 1. **配置层**（能精确断言）：直接调 `buildTrendChartConfig()`，钉住
 *    `interaction.mode === 'index'`、`intersect === false`、提示框回调真的取到了
 *    服务端数值。这几行是悬浮效果的**全部**实现，丢一行这里就红。
 * 2. **渲染层**（只能粗断言）：SSR 真执行组件树，确认有数据时渲染出带无障碍名的
 *    canvas、没数据时渲染空态文案 —— 至少保证「组件没在渲染期炸掉」。
 *
 * ⚠️ 它经 Vite 启动，因此会加载 `node:http`。宿主环境的 `HTTP_PROXY` 之类变量
 *   带尾随换行时 Node 会抛 `ERR_PROXY_INVALID_CONFIG`（见 AGENTS.md 里
 *   `serve-node.ts` 那条实测）—— 那是宿主环境问题，清掉该变量即可。
 */
import { createServer } from 'vite'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  // 关闭依赖预构建，避免与 dev server 争抢临时目录句柄
  optimizeDeps: { noDiscovery: true },
})

const failures: string[] = []
function check(label: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) failures.push(label)
}

/** 配置对象是 Chart.js 的深度 Partial 类型，这里只按用到的字段读，避免与类型定义缠斗。 */
type LooseConfig = {
  type?: string
  data?: { datasets?: Array<Record<string, unknown>> }
  options?: Record<string, any>
}

/** 一份固定的"主题"，让断言与真实 CSS 变量解耦。 */
const theme = {
  bar: '#a0dcfd',
  barHover: '#0c70f3',
  areaStroke: '#0c70f3',
  areaFill: '#98c7fd',
  text: '#8c8c8c',
  grid: '#ebebeb',
  surface: '#ffffff',
  border: '#e8e8e8',
  title: '#1a1a1a',
  series: ['#111111', '#222222', '#333333'],
  fontFamily: 'sans-serif',
}

try {
  // ── 1. 配置层 ────────────────────────────────────────────────────
  const { buildTrendChartConfig } = (await server.ssrLoadModule(
    '/src/components/trendChartConfig.ts',
  )) as { buildTrendChartConfig: (input: unknown) => LooseConfig }

  const labels = ['09-25 00:00', '09-25 01:00', '09-25 02:00']
  const values = [1234, 0, 567890]
  const common = { labels, values, metricLabel: '计费总量', theme }

  const bar = buildTrendChartConfig({ ...common, kind: 'bar' })
  const area = buildTrendChartConfig({ ...common, kind: 'area' })

  check('柱状图用 bar 控制器', bar.type === 'bar')
  check('面积图用 line 控制器', area.type === 'line')

  const barOptions = bar.options ?? {}
  check(
    '★ 悬浮触发方式为 index + intersect:false（整条时间槽都可命中）',
    barOptions.interaction?.mode === 'index' && barOptions.interaction?.intersect === false,
  )
  check('画布按父容器尺寸自适应', barOptions.responsive === true && barOptions.maintainAspectRatio === false)

  const tooltip = barOptions.plugins?.tooltip ?? {}
  check('提示框已配置（不是只有个 canvas）', Object.keys(tooltip).length > 0)
  check('提示框标题取标签本身', tooltip.callbacks?.title?.([{ dataIndex: 1 }]) === '09-25 01:00')
  check(
    '提示框数值取服务端原值并做千分位格式化',
    tooltip.callbacks?.label?.({ dataIndex: 2 }) === '计费总量  567,890',
  )
  check('零值点同样能给出数值', tooltip.callbacks?.label?.({ dataIndex: 1 }) === '计费总量  0')
  check('提示框配色来自主题而不是 Chart.js 默认黑框', tooltip.backgroundColor === theme.surface)

  const yTicks = barOptions.scales?.y?.ticks ?? {}
  check('Y 轴刻度用「万」紧凑写法', String(yTicks.callback?.(37500000)).includes('万'))
  check('Y 轴从 0 起（否则柱高比例会骗人）', barOptions.scales?.y?.beginAtZero === true)

  const barSet = bar.data?.datasets?.[0] ?? {}
  check('悬浮时柱子变色', barSet.hoverBackgroundColor === theme.barHover)
  check('柱子宽度有上限（点少时不会变成粗砖）', barSet.maxBarThickness === 28)

  const areaSet = area.data?.datasets?.[0] ?? {}
  check('面积图开启填充', areaSet.fill === true)
  check('面积填充为半透明（canvas 没有 CSS opacity）', String(areaSet.backgroundColor).startsWith('rgba('))
  check('数据点默认不画，悬浮时出现', areaSet.pointRadius === 0 && Number(areaSet.pointHoverRadius) > 0)
  check(
    '⚠️ 折线不做平滑插值（平滑会在两个低点之间鼓出不存在的峰值）',
    areaSet.tension === 0,
  )
  // ── 1b. 分层（堆叠柱 / 多条折线）────────────────────────────────
  //
  // ★ 这一节验的是「按用户 / 按模型展开」的全部实现：柱状图必须**堆叠**，
  //   折线图必须**不堆叠**，两种图形的提示框都要把同一横坐标上的每一层都列出来。
  const { trendSeriesOf } = (await server.ssrLoadModule('/src/utils/trend.ts')) as {
    trendSeriesOf: (stack: unknown, metric: string) => Array<{ label: string; values: number[]; merged?: boolean }>
  }

  const stack = {
    by: 'user',
    mergedCount: 1,
    items: [
      { key: 'm-1', label: '张三', values: [10, 20, 30], calls: [1, 2, 3], cost: [100, 200, 300] },
      { key: 'm-2', label: '李四', values: [1, 2, 3], calls: [4, 5, 6], cost: [7, 8, 9] },
      { key: '__other__', label: '其余 2 人', merged: true, values: [0, 0, 5], calls: [0, 0, 1], cost: [0, 0, 50] },
    ],
  }

  check('分层映射：token 取 values 列', JSON.stringify(trendSeriesOf(stack, 'totalTokens').map((s) => s.values)) === JSON.stringify([[10, 20, 30], [1, 2, 3], [0, 0, 5]]))
  check('分层映射：调用次数取 calls 列', trendSeriesOf(stack, 'calls')[0]!.values[2] === 3)
  check('分层映射：金额取 cost 列（整数微元原值，不换算）', trendSeriesOf(stack, 'cost')[0]!.values[0] === 100)
  check('分层映射：合并项带上标记，图例与提示框能认出它不是某个人', trendSeriesOf(stack, 'totalTokens')[2]!.merged === true)
  // 🚨 金额整块缺席（多币种 / 没算过）时必须回落成单序列，而不是补一串 0
  check('分层映射：缺金额那一列时整块回落（不补 0）',
    trendSeriesOf({ by: 'user', mergedCount: 0, items: [
      { key: 'm-1', label: '张三', values: [1], calls: [1],
        cost: undefined },
    ] }, 'cost').length === 0)
  check('分层映射：金额列逐层齐全时才可用', trendSeriesOf(stack, 'cost').length === 3)
  check('分层映射：没有 stack 字段时返回空（退回单序列）', trendSeriesOf(undefined, 'totalTokens').length === 0)

  const layered = trendSeriesOf(stack, 'totalTokens')
  const stackedBar = buildTrendChartConfig({ ...common, kind: 'bar', series: layered })
  const stackedBarSets = stackedBar.data?.datasets ?? []
  check('堆叠柱：一层一条 dataset（图例才对得上）', stackedBarSets.length === 3)
  check('★ 堆叠柱：所有层同属一个 stack（否则会并排成 n 根细柱，柱高不再等于总量）',
    stackedBarSets.every((set) => set['stack'] === 'total'))
  check('★ 堆叠柱：Y 轴开启 stacked', stackedBar.options?.scales?.y?.stacked === true)
  check('堆叠柱：多序列显示图例', stackedBar.options?.plugins?.legend?.display === true)
  check('堆叠柱：配色按顺序取自主题的分层色板', stackedBarSets[0]!['backgroundColor'] === theme.series[0] && stackedBarSets[1]!['backgroundColor'] === theme.series[1])
  check('堆叠柱：数值取自服务端那一列，不再乘任何东西', JSON.stringify(stackedBarSets[1]!['data']) === JSON.stringify([1, 2, 3]))

  const stackedTooltip = stackedBar.options?.plugins?.tooltip ?? {}
  check('堆叠柱：提示框列出每一层的色块（否则分不清颜色与名字）', stackedTooltip.displayColors === true)
  check('★ 堆叠柱：提示框按 datasetIndex 取回该层的服务端数值',
    stackedTooltip.callbacks?.label?.({ datasetIndex: 0, dataIndex: 2 }) === '张三  30')
  check('★ 堆叠柱：提示框尾行给出该点的合计（服务端的数，不是前端相加）',
    stackedTooltip.callbacks?.footer?.([{ dataIndex: 2 }]) === '合计  567,890')
  check('★ 堆叠柱：整条时间槽可命中（矮柱子也能悬浮）',
    stackedBar.options?.interaction?.mode === 'index' && stackedBar.options?.interaction?.intersect === false)

  const layeredArea = buildTrendChartConfig({ ...common, kind: 'area', series: layered })
  const areaSets = layeredArea.data?.datasets ?? []
  check('折线图：一层一条折线', areaSets.length === 3)
  check('★ 折线图不堆叠（堆叠折线只有最上面那条的高度可读）',
    layeredArea.options?.scales?.y?.stacked === undefined &&
    areaSets.every((set) => set['stack'] === undefined))
  check('★ 多条折线不填充（色块不表达任何信息，还会盖住下层）',
    areaSets.every((set) => set['fill'] === false))
  check('折线图同样按 index 命中并能列出每一层',
    layeredArea.options?.plugins?.tooltip?.displayColors === true &&
    layeredArea.options?.plugins?.tooltip?.callbacks?.label?.({ datasetIndex: 2, dataIndex: 2 }) === '其余 2 人  5')

  // 单序列的回落：分层为空数组时，图上必须还是原来那一条
  const fallback = buildTrendChartConfig({ ...common, kind: 'bar', series: [] })
  check('★ 分层为空时回落成单序列（旧接口 / 金额缺席都走这条路）',
    fallback.data?.datasets?.length === 1 &&
    fallback.options?.plugins?.legend?.display === false &&
    fallback.options?.plugins?.tooltip?.displayColors === false &&
    fallback.options?.scales?.y?.stacked === undefined)


  // ── 2. 渲染层 ────────────────────────────────────────────────────
  const { default: TrendChart } = (await server.ssrLoadModule('/src/components/TrendChart.vue')) as {
    default: unknown
  }

  const props = {
    labels,
    values,
    kind: 'bar' as const,
    total: '569,124',
    hint: '计费总量（按小时）',
    metricLabel: '计费总量',
  }
  const withData: string = await renderToString(
    createSSRApp({ render: () => h(TrendChart as never, props) }),
  )
  const empty: string = await renderToString(
    createSSRApp({ render: () => h(TrendChart as never, { ...props, values: [], labels: [] }) }),
  )

  check('有数据时渲染出 canvas', withData.includes('<canvas'))
  check('canvas 带无障碍名（含点数与悬浮说明）', withData.includes('3 个时间点'))
  check('有数据时不显示空态', !withData.includes('这段时间没有数据'))
  check('无数据时显示空态文案', empty.includes('这段时间没有数据'))
  check('无数据时不渲染 canvas', !empty.includes('<canvas'))
  check('合计值原样展示（口径不由前端算）', withData.includes('569,124'))
  const layeredHtml: string = await renderToString(
    createSSRApp({ render: () => h(TrendChart as never, { ...props, series: layered }) }),
  )
  check('分层模式的 canvas 无障碍名说明按几层展开',
    layeredHtml.includes('3 个分层堆叠'))
  check('单序列的无障碍名不提分层', !withData.includes('个分层堆叠'))


  console.log('')
  if (failures.length > 0) {
    console.error(`共 ${failures.length} 项断言失败：`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('图表断言全部通过。')
  }
} finally {
  await server.close()
}
