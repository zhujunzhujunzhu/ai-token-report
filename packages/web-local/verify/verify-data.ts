/**
 * 数据层验证：直接检查视图模型的组装结果（不依赖服务端与 DOM）。
 *
 * 运行： bun run verify/verify-data.ts
 *
 * ★ 这些断言守的是「口径不许漂移」：
 *   缓存命中率必须原样来自服务端，四项 token 必须各自独立；
 *   金额**只在服务端下发了 `cost` 时才出现**，且未计价绝不显示成 ¥0。
 */

import {
  buildUsageSummary,
  bucketFor,
  describeMissingRoots,
  describeSourcePaths,
  describeSources,
  detailCell,
  showCostColumn,
} from '../src/composables/usage-view-model'
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
  // ★ 来源样本刻意给**两个根 + 一个缺失根**：页面必须能自证「读了哪几处」，
  //   并对「配了但没读到」的那个显式告警 —— 那种情况与「镜像去重」的数字看起来一样
  sources: {
    sessionsRoots: ['/home/u/.dsh/sessions', '/home/u/AppData/Roaming/dsh-desktop/harness/sessions'],
    missingRoots: ['/home/u/.dsh-vscode/sessions'],
    dataDir: '/home/u/.ai-token-report',
  },
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

check('服务端没下发 cost 时指标卡片仍是 4 项', summary.metrics.length === 4)
check('计费总量格式正确', summary.metrics[0]?.value === '521,262,657')
check('缓存命中率为 95.0%', summary.metrics[1]?.value === '95.0%', summary.metrics[1]?.value)
check('调用次数正确', summary.metrics[2]?.value === '3,026')
check('会话数正确', summary.metrics[3]?.value === '22')

// ★ 来源可见性：多套 DSH 并存时页面上的数是并集，必须能自证「读了哪几处」
check('来源原样透传（前端不加工）', summary.sources.sessionsRoots.length === 2)
check('多根文案点明按并集统计', describeSources(summary.sources).includes('并集'), describeSources(summary.sources))
check(
  '单根文案不吹并集',
  !describeSources({ ...summary.sources, sessionsRoots: ['/one'] }).includes('并集'),
)
check(
  '空来源有明确文案而不是空白',
  describeSources({ ...summary.sources, sessionsRoots: [] }) === '数据来源：未读到任何会话日志根',
)
check('缺失的根逐项列出', describeMissingRoots(summary.sources) === '/home/u/.dsh-vscode/sessions')
check('悬停能看全部根路径', describeSourcePaths(summary.sources).split('\n').length === 2)

// ★ 金额三态之一：**字段缺席**（旧服务端 / 没有金额来源）
//   —— 此时页面必须一位金额都不显示，绝不能用 ¥0.00 顶替（那会让
//   「拿不到金额」与「这段时间没花钱」长得一模一样）。
//   ⚠️ 这三条断言**保留原样**（v7 之前它们守的是「本地页不展示金额」这个决策；
//   现在守的是同一件事的另一半：**没有这个字段时**不展示）。
const allText = JSON.stringify(summary)
check('无 cost 字段时不含 CNY', !allText.includes('CNY'))
check('无 cost 字段时不含「消费金额」', !allText.includes('消费金额'))
check('无 cost 字段时不含 ¥', !allText.includes('¥'))
check('无 cost 字段时不含 cost 字段', !allText.includes('"cost"'))
check('无 cost 字段时没有费用口径那一行', summary.costNote === null)

// ★ 金额三态之二 / 之三：字段在场时的「未计价」与「有金额」。
//   金额全部由 `shared/price.ts` 的 `formatCostSummary()` 拼出来：
//   ≥1 的币种两位小数、<1 的四位小数，多币种用 ` + ` 连接（**绝不相加**）。
const withCost = buildUsageSummary(
  {
    ...overview,
    cost: {
      costs: [
        { currency: 'CNY', amountMicro: 12_345_678, tokens: 500_000_000 },
        { currency: 'USD', amountMicro: 500_000, tokens: 21_262_657 },
      ],
      pricedTokens: 521_262_657,
      unpricedTokens: 0,
      totalTokens: 521_262_657,
      pricedRate: 1,
      unpricedRate: 0,
      pricing: { pricingSource: 'snapshot', pricingSyncedAt: 1_700_000_000_000 },
    },
  },
  series,
  [
    {
      ...rows[0]!,
      cost: {
        costs: [{ currency: 'CNY', amountMicro: 12_345_678, tokens: 521_262_657 }],
        pricedTokens: 521_262_657,
        unpricedTokens: 0,
        totalTokens: 521_262_657,
        pricedRate: 1,
        unpricedRate: 0,
        pricing: { pricingSource: 'snapshot', pricingSyncedAt: 1_700_000_000_000 },
      },
    },
  ],
  'today',
)
check('有 cost 时多出一张费用卡片', withCost.metrics.length === 5)
check('费用卡片在最后且标题是「费用（估算）」', withCost.metrics[4]?.label === '费用（估算）')
check(
  '多币种用 + 连接、绝不跨币种相加',
  withCost.metrics[4]?.value === '¥12.35 + $0.5000',
  withCost.metrics[4]?.value,
)
check('费用口径那一行给出单价来源', (withCost.costNote ?? '').includes('快照'), withCost.costNote ?? '')
check('有费用列时明细单元格显示金额', detailCell(withCost.rows[0]!, 'cost') === '¥12.35')
check('有金额时明细表显示费用列', showCostColumn(withCost.rows))

// ★ 未计价绝不能显示成 ¥0.00 —— 它看起来像「省了钱」，而实际是「没配上价」。
const unpricedText = detailCell(
  {
    ...rows[0]!,
    cost: {
      costs: [],
      pricedTokens: 0,
      unpricedTokens: 1000,
      totalTokens: 1000,
      pricedRate: 0,
      unpricedRate: 1,
      pricing: { pricingSource: 'builtin', pricingSyncedAt: null },
    },
  },
  'cost',
)
check('未计价的单元格写「未计价」而不是 ¥0', unpricedText === '未计价', unpricedText)
check('字段缺席的行写「—」（与未计价区分开）', detailCell(rows[0]!, 'cost') === '—')
check('没有一行带 cost 时不显示费用列', !showCostColumn(rows))

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