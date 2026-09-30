/**
 * 趋势图分层的**展示层映射**（纯函数，与图表库无关）。
 *
 * ## 为什么单独一个文件，而不是写进页面里
 *
 * 「哪个指标取服务端的哪一列」只该有一处实现：`totalTokens` → `values`、
 * `calls` → `calls`、金额 → `cost`（**整数微元原值**，格式化交给
 * `valueFormatter`）。两个页面各写一遍的结果是：同一份数据在两个图上取了
 * 不同的列，而两边都不会报错。
 *
 * ★ 这里**只搬列、不做任何算术**：数值一律是服务端下发的原值。
 *   把「各层相加」写在这里就等于造出第二个合计口径。
 */

import type { SeriesStack } from '@ai-token-report/shared'

/**
 * 图上的一个分层（一个用户 / 一个模型）。
 *
 * ★ 数值是服务端给的原值（token 数 / 调用次数 / **整数微元**），
 *   单位换算只发生在显示层（`valueFormatter`）。
 */
export interface TrendChartSeries {
  label: string
  values: number[]
  /** 「其余 N 个」那一层：提示框与图例里要能看出它不是某个人 / 某个模型。 */
  merged?: boolean
}

/**
 * 服务端的堆叠载荷 → 图上的分层序列。
 *
 * ⚠️ 金额那一列**可能整块缺席**（没有 `cost:read`，或区间内多币种）：
 *   此时返回空数组，调用方据此回落成单序列 —— 绝不挑一个币种硬画，
 *   也绝不给缺列的那一层补一串 0（那会让「没算金额」看起来像「没花钱」）。
 *
 * @param metric 与 `SeriesStackItem` 上的列一一对应（`cost` 即金额微元）。
 */
export function trendSeriesOf(
  stack: SeriesStack | undefined,
  metric: 'totalTokens' | 'calls' | 'cost',
): TrendChartSeries[] {
  if (!stack || stack.items.length === 0) return []
  const series: TrendChartSeries[] = []
  for (const item of stack.items) {
    const column =
      metric === 'calls' ? item.calls : metric === 'cost' ? item.cost : item.values
    if (!column) return []
    series.push({
      label: item.label,
      values: column,
      ...(item.merged ? { merged: true } : {}),
    })
  }
  return series
}
