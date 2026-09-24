<script setup lang="ts">
/**
 * 指标图表：支持堆叠柱状、面积、浅色柱状三种形态。
 *
 * 用原生 SVG 绘制，坐标采用「按数值直接换算像素」的方式，
 * 因此不需要引入任何图表库。
 */
import { computed } from 'vue'

import type { ChartSeries } from '@/types/usage'

const props = withDefaults(
  defineProps<{
    series: ChartSeries
    /** 绘图区高度（px），不含坐标轴文字 */
    plotHeight?: number
    /** Y 轴刻度文案，自下而上 */
    ticks: string[]
  }>(),
  { plotHeight: 200 },
)

/**
 * 坐标系采用「逻辑宽度」而非实测像素宽度：
 * viewBox 固定为一个窄坐标，配合 preserveAspectRatio="none" 横向拉伸铺满卡片。
 * 这样无需 ResizeObserver，首屏与 SSR 的几何就是正确的。
 */
const VIEW_WIDTH = 480
const PAD_X = 6

const count = computed(() => props.series.labels.length)

/** 绘图区逻辑宽度 */
const plotWidth = computed(() => VIEW_WIDTH - PAD_X * 2)

/** 每个槽位逻辑宽度 */
const slot = computed(() => plotWidth.value / Math.max(count.value, 1))

/**
 * 柱子逻辑宽度。由于整体会被横向拉伸，
 * 这里按槽宽比例取，保证柱与间隙的视觉比例在任何卡片宽度下都一致。
 */
const BAR_RATIO = 0.62
const barWidth = computed(() => slot.value * BAR_RATIO)

/** viewBox 宽度 */
const viewWidth = VIEW_WIDTH

/** 数值上限：留 15% 顶部余量，堆叠图按各层合计取最大值 */
const maxValue = computed(() => {
  const stacked = props.series.kind === 'stackedBar'
  const totals = props.series.labels.map((_, index) => {
    if (!stacked) {
      return props.series.values[index] ?? 0
    }
    return props.series.layers.reduce((sum, layer) => sum + (layer.values[index] ?? 0), 0)
  })
  const max = Math.max(...totals, 0)
  return max === 0 ? 1 : max * 1.15
})

/** 第 index 个槽位的中心 X 坐标 */
function centerX(index: number): number {
  return PAD_X + slot.value * index + slot.value / 2
}

/** 数值 → 像素高度 */
function heightOf(value: number): number {
  return (value / maxValue.value) * props.plotHeight
}

/** 数值 → 柱顶 Y 坐标（基线之上） */
function topY(value: number): number {
  return props.plotHeight - heightOf(value)
}

interface BarSegment {
  x: number
  y: number
  height: number
  color: string
  /** 是否为堆叠的最顶层（顶层需要有圆角） */
  rounded: boolean
}

/** 堆叠柱的分段 */
const stackedSegments = computed<BarSegment[]>(() => {
  if (props.series.kind !== 'stackedBar') {
    return []
  }
  const segments: BarSegment[] = []

  props.series.labels.forEach((_, index) => {
    let cursor = props.plotHeight
    const layers = props.series.layers
    layers.forEach((layer, layerIndex) => {
      const value = layer.values[index] ?? 0
      if (value <= 0) {
        return
      }
      const height = heightOf(value)
      cursor -= height
      segments.push({
        x: centerX(index) - barWidth.value / 2,
        y: cursor,
        height,
        color: layer.color,
        rounded: layerIndex === layers.length - 1,
      })
    })
  })

  return segments
})

/** 单序列柱状（Tokens） */
const bars = computed<BarSegment[]>(() => {
  if (props.series.kind !== 'bar') {
    return []
  }
  return props.series.labels.flatMap((_, index) => {
    const value = props.series.values[index] ?? 0
    if (value <= 0) {
      return []
    }
    return [
      {
        x: centerX(index) - barWidth.value / 2,
        y: topY(value),
        height: heightOf(value),
        color: props.series.color,
        rounded: true,
      },
    ]
  })
})

/**
 * 面积图的平滑路径。
 * 用 Catmull-Rom 转三次贝塞尔，得到参考图中那种圆滑的双峰轮廓。
 */
const areaPath = computed(() => {
  if (props.series.kind !== 'area') {
    return ''
  }
  const pts = props.series.values.map((value, index) => ({
    x: centerX(index),
    y: topY(value),
  }))
  if (pts.length === 0) {
    return ''
  }

  let d = `M${pts[0]!.x},${pts[0]!.y}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`
  }
  return d
})

/** 面积图的闭合填充路径 */
const areaFillPath = computed(() => {
  if (!areaPath.value) {
    return ''
  }
  const first = centerX(0)
  const last = centerX(count.value - 1)
  return `${areaPath.value} L${last},${props.plotHeight} L${first},${props.plotHeight} Z`
})

/**
 * 网格线的 Y 坐标（等分 ticks 数量）。
 *
 * ⚠️ `ticks` 是**自下而上**的（`['0', '50%', '100%']`），而屏幕坐标是从上往下增大的。
 *   所以第 i 个刻度的位置是 `plotHeight * (n - 1 - i) / (n - 1)`，
 *   不是 `plotHeight * i / (n - 1)`。
 *   按后者渲染会得到一个**上下颠倒的 Y 轴**：最大值标在底部、0 标在顶部，
 *   而柱子仍然从下往上长 —— 于是「柱子顶端远超它自己那一档刻度」，
 *   图形与刻度互相矛盾。这种错误在截图里看着像「图坏了」，
 *   但代码完全跑得通，不盯着看根本发现不了。
 */
const gridLines = computed(() => {
  const n = props.ticks.length
  const divisions = Math.max(n - 1, 1)
  return props.ticks.map((_, index) => (props.plotHeight / divisions) * (n - 1 - index))
})

/** 只保留首、中、尾三个刻度，避免文字拥挤 */
const visibleTicks = computed(() => {
  const total = props.ticks.length
  return props.ticks.map((label, index) => ({
    label,
    top: gridLines.value[index] ?? 0,
    show: index === 0 || index === total - 1 || index === Math.floor(total / 2),
  }))
})

/**
 * X 轴刻度：从真实标签里取首、中、尾三个。
 *
 * 早期版本这里写死 `00:00 / 08:00 / 15:00 / 23:00`，
 * 接上真实数据后那组标签与图表内容毫无关系 —— 按天看时
 * 横轴标着小时，是最容易被误读成「数据错了」的那种 bug。
 */
const visibleXLabels = computed(() => {
  const labels = props.series.labels
  if (labels.length === 0) return []
  if (labels.length <= 3) return labels

  const mid = Math.floor(labels.length / 2)
  return [labels[0]!, labels[mid]!, labels[labels.length - 1]!]
})
</script>

<template>
  <div class="metric-chart">
    <div class="metric-chart__body" :style="{ height: `${plotHeight}px` }">
      <!-- Y 轴刻度 -->
      <div class="metric-chart__yaxis">
        <span
          v-for="tick in visibleTicks"
          :key="tick.label"
          class="metric-chart__ytick"
          :class="{ 'is-hidden': !tick.show }"
          :style="{ top: `${tick.top}px` }"
        >
          {{ tick.label }}
        </span>
      </div>

      <div class="metric-chart__plot">
        <!-- 网格线 -->
        <span
          v-for="(y, index) in gridLines"
          :key="`grid-${index}`"
          class="metric-chart__grid"
          :style="{ top: `${y}px` }"
        />

        <div class="metric-chart__scroll">
          <svg
            class="metric-chart__svg"
            :viewBox="`0 0 ${viewWidth} ${plotHeight}`"
            :height="plotHeight"
            preserveAspectRatio="none"
            role="img"
          >
            <!-- 面积图 -->
            <template v-if="series.kind === 'area'">
              <path :d="areaFillPath" :fill="series.fillColor" />
              <path
                :d="areaPath"
                fill="none"
                :stroke="series.color"
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
              />
            </template>

            <!-- 堆叠柱 -->
            <template v-else-if="series.kind === 'stackedBar'">
              <rect
                v-for="(seg, index) in stackedSegments"
                :key="`seg-${index}`"
                :x="seg.x"
                :y="seg.y"
                :width="barWidth"
                :height="seg.height"
                :fill="seg.color"
                :rx="seg.rounded ? 3 : 0"
              />
            </template>

            <!-- 浅色柱状 -->
            <template v-else>
              <rect
                v-for="(bar, index) in bars"
                :key="`bar-${index}`"
                :x="bar.x"
                :y="bar.y"
                :width="barWidth"
                :height="bar.height"
                :fill="bar.color"
                rx="3"
              />
            </template>
          </svg>
        </div>
      </div>
    </div>

    <!-- X 轴刻度：来自真实标签的首/中/尾 -->
    <div class="metric-chart__xaxis">
      <span
        v-for="label in visibleXLabels"
        :key="label"
        class="metric-chart__xtick"
      >
        {{ label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.metric-chart {
  width: 100%;
}

.metric-chart__body {
  position: relative;
  display: flex;
  gap: 10px;
}

.metric-chart__yaxis {
  position: relative;
  flex: 0 0 34px;
  /* 刻度右对齐到绘图区左边缘，留出一点视觉间隙 */
  padding-right: 8px;
}

.metric-chart__ytick {
  position: absolute;
  right: 0;
  font-size: 11px;
  color: var(--c-text-tertiary);
  transform: translateY(-50%);
  white-space: nowrap;
}

.metric-chart__ytick.is-hidden {
  visibility: hidden;
}

.metric-chart__plot {
  position: relative;
  flex: 1;
  min-width: 0;
}

.metric-chart__grid {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background-color: #e6e8ea;
}

.metric-chart__scroll {
  position: relative;
  overflow: hidden;
}

.metric-chart__svg {
  display: block;
  width: 100%;
}

/* X 轴刻度与绘图区左边缘对齐：向左让出 Y 轴宽度 + 间隙 */
.metric-chart__xaxis {
  display: flex;
  justify-content: space-between;
  margin-left: 44px;
  padding-top: 6px;
}

.metric-chart__xtick {
  font-size: 11px;
  color: var(--c-text-tertiary);
}
</style>