/**
 * 部门看板趋势图的 Chart.js 配置（**纯函数，不碰 DOM 之外的东西**）。
 *
 * ## 为什么单独一个文件
 *
 * 图表配置里最容易悄悄退化的东西是「悬浮提示到底还连不连着数据」——
 * 它不会报错，只会让鼠标移上去什么都不出现。把配置构造抽成不依赖浏览器的
 * 纯函数之后，`verify/verify-charts.ts` 就能直接断言提示框的回调，
 * 不必为此装一个 Playwright。
 *
 * ## 两条与插件侧共享的做法
 *
 * - **按需注册**：只用「柱 / 线 / 点 + 类目轴 + 提示框 + 面积填充」这几件，
 *   由 `TrendChart.vue` 在模块顶层 `Chart.register()`（与
 *   `packages/dsh-plugin/src/client/chart.tsx` 同一套写法，两个界面因此长得一样）。
 * - **`interaction: { mode: 'index', intersect: false }`**：整条时间槽都可命中，
 *   0 值和很矮的柱子同样能悬浮出数值。默认的 `intersect: true` 要求鼠标
 *   精确压在图形上，矮柱子几乎点不到。
 *
 * ## ★ 分层（堆叠柱 / 多条折线）
 *
 * 传了 `series` 时每个分层是一条 dataset：
 *
 * | 图形 | 堆叠 | 为什么 |
 * |---|---|---|
 * | 柱状 | **堆叠**（`stack: 'total'` + `y.stacked`） | 柱高代表总量，各层之和 ≡ 总量 |
 * | 折线 / 面积 | **不堆叠**，多条独立折线 | 折线堆叠之后只有最上面那条的高度可读，下面几条的值要靠相邻两条相减才能得到 —— 那是一个不会报错的读图陷阱 |
 *
 * 两种图形都靠 `interaction.mode: 'index'` 让**同一横坐标上的每一层**一起进提示框，
 * 这就是「鼠标移上去看到每个用户 / 每个模型的用量」的全部实现。
 *
 * ⚠️ canvas **不认 `var(--c-chart-bar)`**：把 CSS 变量名直接当颜色传进去会得到
 *   一块黑。所以颜色必须先经 `readTrendChartTheme()` 解析成具体色值。
 *
 * ★ 本模块唯一的算术是排版（配色 / 圆角 / 刻度上限）。数值一律由服务端算好透传，
 *   这里只做 `formatCount()` / `formatCompact()` 格式化 —— 在图表配置里再除一次
 *   就是第二个口径实现，而它不会报错。
 */
import type { ChartConfiguration } from 'chart.js'

import { formatCompact, formatCount } from '@/utils/format'
import type { TrendChartSeries } from '@/utils/trend'

export type { TrendChartSeries }

/** 从页面上解析出来的具体色值。 */
export interface TrendChartTheme {
  bar: string
  barHover: string
  areaStroke: string
  areaFill: string
  text: string
  grid: string
  surface: string
  border: string
  title: string
  fontFamily: string
  /**
   * 分层配色（按顺序取，超出就循环）。
   *
   * ★ 必须与「合计」那一条的蓝色明显不同：堆叠图的第一层如果和单序列同色，
   *   使用者在两个模式之间切换时会以为图没变。
   */
  series: string[]
}

/**
 * 分层配色的兜底表。
 *
 * ⚠️ 顺序即「哪一层先出现」：排在最前的是用量最大的那一层，
 *   所以第一个颜色是主蓝色（与单序列的 `--c-chart-bar` 同族但更深，免得被
 *   当成没切换）。相邻两色刻意在明度上拉开，灰度打印时也分得开。
 *
 * ★ 前 8 个是**原有顺序**（CSS 里那份与这里逐位对应，别只改一处）。
 *   第 9~16 个是为「按用户展开全部」补的：只有 8 色时按 `% length` 循环，
 *   第 9 个人会拿到与第 1 个人**完全相同**的颜色 —— 图例里两行色块一样，
 *   看起来像同一个人出现了两次，而图上不会有任何提示。
 *   超过 16 层仍会循环（`colorAt`），那时人眼本来也分不清这么多颜色。
 */
const SERIES_FALLBACK = [
  '#3275ed',
  '#21a68e',
  '#9274df',
  '#c78b27',
  '#37a5c3',
  '#dc5961',
  '#5b7ba6',
  '#8cc152',
  '#d4719f',
  '#8a6d3b',
  '#2f9e44',
  '#e8590c',
  '#0c8599',
  '#a61e4d',
  '#495057',
  '#b197fc',
] as const

/**
 * 读 CSS 变量并给出兜底色值。
 *
 * 每个变量都带兜底：某个令牌被改名时图还得画得出来 —— 一块全黑的图表
 * 会被当成「数据坏了」，比配色不对难查得多。
 */
export function readTrendChartTheme(el: HTMLElement): TrendChartTheme {
  const css = getComputedStyle(el)
  const read = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback

  return {
    bar: read('--c-chart-bar', '#a0dcfd'),
    barHover: read('--c-chart-bar-strong', '#0c70f3'),
    areaStroke: read('--c-chart-area-stroke', '#0c70f3'),
    areaFill: read('--c-chart-area-fill', '#98c7fd'),
    text: read('--c-text-tertiary', '#8c8c8c'),
    grid: read('--c-divider', '#ebebeb'),
    surface: read('--c-bg-page', '#ffffff'),
    border: read('--c-border', '#e8e8e8'),
    title: read('--c-text-primary', '#1a1a1a'),
    // 图表文字要跟随页面字体，否则提示框里的中文会掉进 Helvetica 的兜底字形
    fontFamily: css.fontFamily || 'sans-serif',
    series: SERIES_FALLBACK.map((fallback, index) =>
      read(`--c-chart-series-${index + 1}`, fallback),
    ),
  }
}

/**
 * 给十六进制色值加透明度。
 *
 * ⚠️ canvas 没有 CSS 的 `opacity`，面积填充要半透明只能自己拼 `rgba()`。
 *   非六位十六进制（`rgba(...)`、命名色）原样返回，不做猜测。
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color
  const value = Number.parseInt(hex, 16)
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`
}

/** 堆叠柱共用的 stack id；名字本身无意义，只要所有层一致。 */
const STACK_ID = 'total'

export interface TrendChartInput {
  /** 每个点的标签（已格式化，如 `09-21` / `14:00`）。 */
  labels: string[]
  /**
   * 每个点的**合计**数值（服务端算好，本模块不重算）。
   *
   * ★ 它同时是「合计」那条线的数据、以及分层模式下提示框尾行的合计值 ——
   *   后者正是「各层之和 ≡ 总量」在页面上的可见证据。
   */
  values: number[]
  kind: 'bar' | 'area'
  /** 提示框里的指标名，如「计费总量」。 */
  metricLabel: string
  theme: TrendChartTheme
  /**
   * 分层序列（堆叠柱 / 多条折线）。空数组或省略 = 单序列。
   *
   * ⚠️ 空数组与省略必须走**同一条**分支：服务端没给 `stack`（旧版）、
   *   以及给了但金额整块缺席，都会走到这里，两者都该退回单序列。
   */
  series?: TrendChartSeries[]
  /**
   * 数值的**逐点**格式化（悬浮提示用），缺省千分位。
   *
   * ★ 画金额时曲线的数值仍然是**服务端给的整数微元原值**：本模块只换
   *   显示用的格式化函数，绝不在画图这一层做「微元 ÷ 1e6」这类换算 ——
   *   那会在前端造出第二个「1 微是多少」的口径实现，而且它不会报错。
   */
  valueFormatter?: (value: number) => string
  /** 刻度的紧凑格式化，缺省「万 / 亿」。 */
  tickFormatter?: (value: number) => string
}

export function buildTrendChartConfig(
  input: TrendChartInput,
): ChartConfiguration<'bar' | 'line'> {
  const { labels, values, kind, metricLabel, theme } = input
  const valueFormatter = input.valueFormatter ?? formatCount
  const tickFormatter = input.tickFormatter ?? formatCompact
  const isArea = kind === 'area'
  const series = input.series ?? []
  const layered = series.length > 0
  const colorAt = (index: number): string =>
    theme.series[index % theme.series.length] ?? theme.areaStroke

  const datasets = layered
    ? series.map((entry, index) => {
        const color = colorAt(index)
        return isArea
          ? {
              label: entry.label,
              data: entry.values,
              borderColor: color,
              backgroundColor: color,
              borderWidth: 2,
              // ★ 多条折线**不填充**：一层叠一层的半透明色块会让「哪条线在上面」
              //   变成比高度还显眼的信息，而填充本身不表达任何东西。
              fill: false,
              // ★ 直线连接真实采样点：平滑插值会在两个低点之间鼓出不存在的峰值
              tension: 0,
              pointRadius: 0,
              pointHoverRadius: 4,
              pointHoverBackgroundColor: color,
              pointHoverBorderColor: theme.surface,
              pointHoverBorderWidth: 2,
            }
          : {
              label: entry.label,
              data: entry.values,
              backgroundColor: color,
              // ⚠️ 刻意**不设** `hoverBackgroundColor`：单序列时它是「这一槽被选中」
              //   的反馈，而堆叠图里 `mode: 'index'` 会把**整槽**都算作 active，
              //   于是所有层一起变成同一个深蓝 —— 颜色与层名的对应关系在悬浮的
              //   那一刻反而丢了。悬浮的反馈交给提示框（它同时列出每一层与色块）。
              borderWidth: 0,
              borderRadius: 2,
              // ★ 堆叠柱必须同属一个 stack，否则它们会并排成 n 根细柱 ——
              //   图上看起来完全正常，只是「柱高 = 总量」这件事悄悄没了
              stack: STACK_ID,
              maxBarThickness: 28,
              barPercentage: 0.75,
            }
      })
    : [
        {
          label: metricLabel,
          data: values,
          backgroundColor: isArea ? withAlpha(theme.areaFill, 0.55) : theme.bar,
          // 悬浮反馈：柱变深、面积变实，让「现在看的是哪一个点」一眼可见
          hoverBackgroundColor: isArea
            ? withAlpha(theme.areaFill, 0.75)
            : theme.barHover,
          borderColor: theme.areaStroke,
          borderWidth: isArea ? 2 : 0,
          borderRadius: isArea ? 0 : 3,
          // 与手绘版一致：柱子最宽 28px、约占槽位 60%，点少时不会变成一块粗砖
          maxBarThickness: 28,
          barPercentage: 0.75,
          // ★ 直线连接真实采样点：平滑插值会在两个低点之间鼓出一个不存在的峰值
          tension: 0,
          fill: isArea,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: theme.areaStroke,
          pointHoverBorderColor: theme.surface,
          pointHoverBorderWidth: 2,
        },
      ]

  return {
    type: isArea ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // 关掉入场动画：轮询刷新时每次都重放一遍，图会一直「跳」
      animation: false,
      // ★ 关键的一行：没有它就只有「精确压中柱子」才能触发提示
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 8, right: 4 } },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: theme.text,
            maxRotation: 0,
            autoSkip: true,
            // 原本手写的「隔一个显示」在点数变化时容易挤成一团，交给 Chart.js 自动抽稀
            maxTicksLimit: 8,
            font: { size: 11, family: theme.fontFamily },
          },
        },
        y: {
          beginAtZero: true,
          // ★ 只有堆叠柱需要 `stacked`：折线是各画各的，堆叠折线会让
          //   「最上面那条 = 合计、下面几条 = 各自的值」这件事不再成立
          ...(layered && !isArea ? { stacked: true } : {}),
          border: { display: false },
          grid: { color: theme.grid, drawTicks: false },
          ticks: {
            color: theme.text,
            padding: 8,
            maxTicksLimit: 4,
            font: { size: 11, family: theme.fontFamily },
            // 刻度用「万 / 亿」紧凑写法，完整数值留给悬浮提示
            callback: (value) => tickFormatter(Number(value)),
          },
        },
      },
      plugins: {
        // ★ 多序列必须有图例：没有它，提示框里的名字和柱子颜色的对应关系
        //   只能靠鼠标一个个试出来。单序列不显示（一个色块纯属噪音）。
        legend: {
          display: layered,
          position: 'bottom',
          labels: {
            color: theme.text,
            boxWidth: 9,
            boxHeight: 9,
            usePointStyle: true,
            pointStyle: isArea ? 'line' : 'rectRounded',
            padding: 14,
            font: { size: 11, family: theme.fontFamily },
          },
        },
        tooltip: {
          backgroundColor: theme.surface,
          titleColor: theme.title,
          bodyColor: theme.text,
          borderColor: theme.border,
          borderWidth: 1,
          cornerRadius: 10,
          padding: 12,
          // 单序列时色块纯属噪音；分层时色块是**唯一**把提示行与柱子对上的线索
          displayColors: layered,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 4,
          usePointStyle: true,
          titleMarginBottom: 6,
          titleFont: { size: 12, family: theme.fontFamily, weight: 600 },
          bodyFont: { size: 12, family: theme.fontFamily },
          footerFont: { size: 12, family: theme.fontFamily, weight: 600 },
          footerColor: theme.title,
          footerMarginTop: 6,
          callbacks: {
            // 标签与数值都取自父组件透传的原始数组：显示的是**服务端的数**，
            // 不经过 Chart.js 的解析结果，少一次可能出偏差的转换
            title: (items) => labels[items[0]?.dataIndex ?? 0] ?? '',
            label: (item) => {
              if (!layered)
                return `${metricLabel}  ${valueFormatter(values[item.dataIndex] ?? 0)}`
              // ⚠️ 按 `datasetIndex` 取回**服务端那一列**，而不是读 Chart.js 解析后的
              //   `item.parsed`：两者在本仓的取值路径上必须只有一条。
              const row = series[item.datasetIndex]
              return `${row?.label ?? ''}  ${valueFormatter(row?.values[item.dataIndex] ?? 0)}`
            },
            // ★ 尾行的合计就是「各层之和 ≡ 总量」在页面上的可见证据。
            //   它取自 `values`（服务端算的合计），不是把各层相加算出来的 ——
            //   相加在数学上一样，但它会成为前端第二个合计口径。
            ...(layered
              ? {
                  footer: (items) =>
                    items.length === 0
                      ? ''
                      : `合计  ${valueFormatter(values[items[0]?.dataIndex ?? 0] ?? 0)}`,
                }
              : {}),
          },
        },
      },
    },
  }
}
