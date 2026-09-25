<script setup lang="ts">
/**
 * 趋势图 —— 用 **Chart.js** 绘制（与 DSH 插件界面同一个图表库）。
 *
 * ## 为什么从手绘 SVG 换成图表库
 *
 * 手绘 SVG 只能靠 `<title>` 给出浏览器原生的延迟提示：要悬停一两秒、
 * 样式无法控制、且**必须精确压在柱子上**。看板上最需要读出「这一刻用了多少」
 * 的场景恰好是柱子很矮的时候，原生提示在那时基本等于不存在。
 *
 * 换成 Chart.js 之后，`interaction: { mode: 'index', intersect: false }`
 * 让鼠标落在任意横坐标上都能弹出提示框（见 `trendChartConfig.ts`），
 * 并且悬浮的柱子/数据点会变色 —— 这就是「鼠标移上去有悬浮效果」。
 *
 * ★ 本组件**只做坐标与配色**：数值由服务端算好后透传，唯一的算术是
 *   「值 / 最大值 → 像素」，由 Chart.js 完成，不参与任何数字的展示。
 *   数字全部走 `formatCount()` / `formatCompact()` 格式化。
 *
 * ⚠️ Chart.js 需要真实 DOM，因此 `new Chart()` 只发生在 `onMounted` / `watch`
 *   （`flush: 'post'`）里 —— SSR（`verify/verify-render.ts` 真跑组件树）
 *   只渲染出一个空 `<canvas>`，不会碰到浏览器 API。
 */
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js'
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'

import {
  buildTrendChartConfig,
  readTrendChartTheme,
} from './trendChartConfig.js'

/**
 * 只注册用得到的部件（Chart.js 4 的 tree-shaking 方式）。
 *
 * ⚠️ 少注册一个控制器，图会**静默地什么都不画**（不报错、控制台也不一定有提示），
 *   所以这里列的都是实际用到的：柱 / 线 / 点 + 类目轴 + 提示框 + 面积填充。
 *   没注册 `Legend` 是刻意的 —— 单序列图不需要图例。
 */
Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Filler,
)

const props = withDefaults(
  defineProps<{
    /** 每个点的标签（已格式化，如 `09-21`）。 */
    labels: string[]
    /** 每个点的数值。 */
    values: number[]
    kind?: 'bar' | 'area'
    /** 合计值文案（右上角）。 */
    total: string
    /** 数据说明，作为标题与无障碍名。 */
    hint?: string
    /** 悬浮提示里的指标名，如「计费总量」。 */
    metricLabel: string
  }>(),
  { kind: 'bar', hint: '' },
)

const canvas = ref<HTMLCanvasElement | null>(null)

/**
 * ⚠️ 用 `shallowRef` 而不是 `ref`：Chart 实例内部持有大量互相引用的状态，
 *   被 Vue 深度代理之后每次 `update()` 都要穿过一层 Proxy，刷新会肉眼可见地变卡。
 */
const chart = shallowRef<Chart<'bar' | 'line'> | null>(null)

const hasData = computed(() => props.values.length > 0)

/** 建立或就地更新图表；没有数据时销毁实例（`v-if` 会同时把 canvas 摘掉）。 */
function draw(): void {
  const el = canvas.value

  if (!el || !hasData.value) {
    chart.value?.destroy()
    chart.value = null
    return
  }

  const config = buildTrendChartConfig({
    labels: props.labels,
    values: props.values,
    kind: props.kind,
    metricLabel: props.metricLabel,
    theme: readTrendChartTheme(el),
  })

  if (chart.value) {
    // 复用同一画布：轮询刷新时只换数据，避免「先清空再重建」造成的闪烁，
    // 也顺带保住鼠标当前停留的那个点的悬浮状态。
    chart.value.data = config.data
    chart.value.options = config.options ?? {}
    chart.value.update('none')
    return
  }

  chart.value = new Chart(el, config)
}

onMounted(draw)

/**
 * ⚠️ `flush: 'post'`：默认的 `pre` 在本组件重新渲染**之前**触发，
 *   那时 `v-if` 刚创建的 canvas 还不存在，`canvas.value` 仍是 null，
 *   于是「从没有数据变成有数据」的第一次绘制会被静默跳过。
 */
watch(
  () => [props.labels, props.values, props.kind, props.metricLabel] as const,
  draw,
  { flush: 'post' },
)

onBeforeUnmount(() => {
  chart.value?.destroy()
  chart.value = null
})
</script>

<template>
  <div class="trend">
    <div class="trend__head">
      <span class="trend__title">{{ hint }}</span>
      <span class="trend__total tabular">合计 {{ total }}</span>
    </div>

    <div v-if="hasData" class="trend__plot">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="`${hint}趋势图，共 ${labels.length} 个时间点；鼠标移上去可查看每个点的数值`"
      />
    </div>

    <p v-else class="trend__empty">这段时间没有数据</p>
  </div>
</template>

<style scoped>
.trend {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trend__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.trend__title {
  font-size: 13px;
  color: var(--c-text-secondary);
}

.trend__total {
  font-size: 13px;
  color: var(--c-text-tertiary);
}

/*
 * Chart.js 在 `maintainAspectRatio: false` 下按**父元素的尺寸**铺满画布，
 * 所以这里必须给出确定的高度：换成 `height: auto` 会得到一张 0 高度的空图。
 */
.trend__plot {
  position: relative;
  height: 260px;
}

.trend__empty {
  margin: 0;
  padding: 40px 0;
  font-size: 13px;
  color: var(--c-text-tertiary);
  text-align: center;
}
</style>
