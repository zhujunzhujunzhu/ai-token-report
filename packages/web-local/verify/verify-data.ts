/**
 * 数据层验证：直接检查视图模型的组装结果（不依赖服务端与 DOM）。
 *
 * 运行： bun run verify/verify-data.ts
 *
 * ★ 这些断言守的是「口径不许漂移」：
 *   缓存命中率必须原样来自服务端，四项 token 必须各自独立，不许出现金额。
 */

import { buildUsageSummary, bucketFor } from '../src/composables/usage-view-model'
import { formatCompact, formatCount, formatPercent } from '../src/utils/format'
import type { LocalOverviewResponse, LocalSeriesResponse } from '@ai-token-report/shared'

const failures: string[] = []
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures.push(label)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}

// ── 构造一份与真实扫描结果同形的样本 ──────────────────────────────────────
const overview: LocalOverviewResponse = {
  range: { from: null, to: null, label: '今天' },
  totalTokens: 521_262_657,
  inputTokens: 25_866_328,
  outputTokens: 985_321,
  cacheReadTokens: 494_411_008,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  calls: 3026,
  sessions: 22,
  // 实测口径：cacheRead / (cacheRead + input)
  cacheHitRate: 494_411_008 / (494_411_008 + 25_866_328),
  cacheLeverage: 494_411_008 / 25_866_328,
  avgTokensPerCall: 521_262_657 / 3026,
  scannedAt: Date.now(),
  cached: false,
}

const series: LocalSeriesResponse = {
  bucket: 'hour',
  points: [
    {
      bucket: '2026-09-21T09',
      totalTokens: 1_000,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 890,
      cacheWriteTokens: 0,
      calls: 2,
      cacheHitRate: 890 / 990,
    },
    {
      bucket: '2026-09-21T10',
      totalTokens: 2_000,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 1_780,
      cacheWriteTokens: 0,
      calls: 4,
      cacheHitRate: 1780 / 1980,
    },
  ],
  scannedAt: Date.now(),
  cached: false,
}

const rows = [
  {
    key: 'dashscope/deepseek-v4.1-flash',
    totalTokens: overview.totalTokens,
    inputTokens: overview.inputTokens,
    outputTokens: overview.outputTokens,
    cacheReadTokens: overview.cacheReadTokens,
    cacheWriteTokens: 0,
    calls: overview.calls,
    cacheHitRate: overview.cacheHitRate,
  },
]

const summary = buildUsageSummary(overview, series, rows, 'today')

console.log('--- metrics ---')
for (const metric of summary.metrics) {
  console.log(`  ${metric.label.padEnd(12)} ${metric.value}`)
}
console.log(`--- freshness: ${summary.freshness}`)
console.log(`--- metricGroups: ${summary.metricGroups.length}`)
console.log(`--- rows: ${summary.rows.length}`)

check('指标卡片有 4 项', summary.metrics.length === 4)
check('计费总量格式正确', summary.metrics[0]?.value === '521,262,657')
check('缓存命中率为 95.0%', summary.metrics[1]?.value === '95.0%', summary.metrics[1]?.value)
check('调用次数正确', summary.metrics[2]?.value === '3,026')
check('会话数正确', summary.metrics[3]?.value === '22')

// ★ 铁律：不展示金额
const allText = JSON.stringify(summary)
check('视图模型不含 CNY', !allText.includes('CNY'))
check('视图模型不含「消费金额」', !allText.includes('消费金额'))
check('视图模型不含 ¥', !allText.includes('¥'))
check('视图模型不含 cost 字段', !allText.includes('"cost"'))

// ★ 铁律：cacheRead 是独立的一项，不能被并进 input
check(
  '四项之和等于计费总量',
  overview.inputTokens + overview.outputTokens + overview.cacheReadTokens + overview.cacheWriteTokens ===
    overview.totalTokens,
)
check('cacheRead 未被并进 input', summary.rows[0]?.cacheReadTokens === 494_411_008)
check(
  'cacheRead 占总用量约 94.9%',
  Math.abs(overview.cacheReadTokens / overview.totalTokens - 0.9485) < 0.001,
)

// 趋势图
check('趋势分组有卡片', (summary.metricGroups[0]?.cards.length ?? 0) === 2)
check('趋势卡片 key 为 tokens/calls', summary.metricGroups[0]?.cards.map((c) => c.key).join(',') === 'tokens,calls')

// 格式化
check('formatCount 千分位', formatCount(80_642_909) === '80,642,909')
check('formatPercent 一位小数', formatPercent(0.9503) === '95.0%')
check('formatCompact 亿', formatCompact(522_261_815) === '5.2亿')
check('formatCompact 万', formatCompact(80_642_909) === '8064.3万')
check('formatCompact 小数不变', formatCompact(1234) === '1234')

// 分桶选择
check('today 用小时桶', bucketFor('today') === 'hour')
check('week 用天桶', bucketFor('week') === 'day')

console.log('')
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('数据层断言全部通过。')
}