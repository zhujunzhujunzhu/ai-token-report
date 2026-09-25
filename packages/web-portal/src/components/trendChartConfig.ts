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
 * ⚠️ canvas **不认 `var(--c-chart-bar)`**：把 CSS 变量名直接当颜色传进去会得到
 *   一块黑。所以颜色必须先经 `readTrendChartTheme()` 解析成具体色值。
 *
 * ★ 本模块唯一的算术是排版（配色 / 圆角 / 刻度上限）。数值一律由服务端算好透传，
 *   这里只做 `formatCount()` / `formatCompact()` 格式化 —— 在图表配置里再除一次
 *   就是第二个口径实现，而它不会报错。
 */
import type { ChartConfiguration } from 'chart.js'

import { formatCompact, formatCount } from '@/utils/format'

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
}

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

export interface TrendChartInput {
  /** 每个点的标签（已格式化，如 `09-21` / `14:00`）。 */
  labels: string[]
  /** 每个点的数值（服务端算好，本模块不重算）。 */
  values: number[]
  kind: 'bar' | 'area'
  /** 提示框里的指标名，如「计费总量」。 */
  metricLabel: string
  theme: TrendChartTheme
}

export function buildTrendChartConfig(
  input: TrendChartInput,
): ChartConfiguration<'bar' | 'line'> {
  const { labels, values, kind, metricLabel, theme } = input
  const isArea = kind === 'area'

  return {
    type: isArea ? 'line' : 'bar',
    data: {
      labels,
      datasets: [
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
      ],
    },
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
          border: { display: false },
          grid: { color: theme.grid, drawTicks: false },
          ticks: {
            color: theme.text,
            padding: 8,
            maxTicksLimit: 4,
            font: { size: 11, family: theme.fontFamily },
            // 刻度用「万 / 亿」紧凑写法，完整数值留给悬浮提示
            callback: (value) => formatCompact(Number(value)),
          },
        },
      },
      plugins: {
        tooltip: {
          backgroundColor: theme.surface,
          titleColor: theme.title,
          bodyColor: theme.text,
          borderColor: theme.border,
          borderWidth: 1,
          cornerRadius: 10,
          padding: 12,
          // 只有一个序列，色块纯属噪音
          displayColors: false,
          titleMarginBottom: 6,
          titleFont: { size: 12, family: theme.fontFamily, weight: 600 },
          bodyFont: { size: 12, family: theme.fontFamily },
          callbacks: {
            // 标签与数值都取自父组件透传的原始数组：显示的是**服务端的数**，
            // 不经过 Chart.js 的解析结果，少一次可能出偏差的转换
            title: (items) => labels[items[0]?.dataIndex ?? 0] ?? '',
            label: (item) =>
              `${metricLabel}  ${formatCount(values[item.dataIndex] ?? 0)}`,
          },
        },
      },
    },
  }
}
