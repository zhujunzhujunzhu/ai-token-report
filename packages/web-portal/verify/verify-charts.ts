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