<script setup lang="ts">
/** 指标卡只格式化服务端结果，禁止在展示层重新计算总量、比率与平均数。 */
import { ElCard, ElIcon } from 'element-plus'
import { computed } from 'vue'
import {
  Coin,
  PieChart,
  Connection,
  ChatDotRound,
  DataLine,
  Warning,
  Wallet,
} from '@element-plus/icons-vue'
import type { OverviewResponse } from '@ai-token-report/shared'
import { formatCompact, formatCount, formatPercent } from '../utils/format.js'
import { UNPRICED_TEXT, costText, pricingHint } from '../utils/cost.js'
const props = defineProps<{ overview: OverviewResponse | null }>()
const cards = computed(() => {
  const o = props.overview
  /**
   * ★ 费用卡片**只在服务端下发了 `cost` 时才出现**。
   *
   *   没有 `cost:read` 时该字段整个缺席 —— 这与「金额是 0」是两件不同的事，
   *   所以这里判的是字段在不在，而不是数值大不大：一张 `¥0.00` 的卡片会让
   *   「你没权限看金额」与「这段时间没花钱」长得一模一样。
   *
   * ⚠️ 金额是**估算**（自建计价 ≠ 财务账单：折扣 / 预付 / 赠送额度都不在单价里），
   *   标题里必须带这两个字，页面上不能出现任何看起来像账单的数。
   */
  const costCards = o?.cost
    ? [
        {
          label: '费用（估算）',
          value: costText(o.cost) ?? UNPRICED_TEXT,
          exact: costText(o.cost) ?? '',
          unit: '',
          // ⚠️ 未计价比例必须与金额同时出现在视野里：它决定这个数能信几分。
          hint: pricingHint(o.cost),
          icon: Wallet,
          // 有未计费用量时用琥珀色：它不是错误，但绝不该看起来像「一切正常」。
          tone: o.cost.unpricedTokens > 0 ? 'amber' : 'green',
        },
      ]
    : []
  return [
    {
      label: '计费总量',
      value: o ? formatCompact(o.totalTokens) : '—',
      exact: o ? formatCount(o.totalTokens) : '',
      unit: 'Token',
      hint: '包含未缓存输入、输出、缓存读与缓存写',
      icon: Coin,
      tone: 'blue',
    },
    ...costCards,
    {
      label: '缓存命中率',
      value: o ? formatPercent(o.cacheHitRate) : '—',
      exact: '',
      unit: '',
      hint: '缓存读取占全部输入的比例',
      icon: PieChart,
      tone: 'green',
    },
    {
      label: '调用次数',
      value: o ? formatCount(o.calls) : '—',
      exact: '',
      unit: '次',
      hint: '当前时间范围内的计费事件',
      icon: Connection,
      tone: 'violet',
    },
    {
      label: '会话数',
      value: o ? formatCount(o.sessions) : '—',
      exact: '',
      unit: '个',
      hint: '包含实际调用的独立会话',
      icon: ChatDotRound,
      tone: 'cyan',
    },
    {
      label: '平均每次调用',
      value: o ? formatCompact(Math.round(o.avgTokensPerCall)) : '—',
      exact: o ? formatCount(Math.round(o.avgTokensPerCall)) : '',
      unit: 'Token',
      hint: '每次调用的平均 Token 用量',
      icon: DataLine,
      tone: 'blue',
    },
    {
      label: '未署名占比',
      value: o ? formatPercent(o.unattributedRate) : '—',
      exact: '',
      unit: '',
      hint: o?.unattributedRate
        ? '存在未归属记录，请查看采集诊断'
        : '当前范围内未归属调用的比例',
      icon: Warning,
      tone: o?.unattributedRate ? 'amber' : 'green',
    },
  ]
})
</script>
<template>
  <div class="metric-grid">
    <el-card
      v-for="card in cards"
      :key="card.label"
      shadow="never"
      class="metric-card"
    >
      <div class="metric-card-top">
        <span>{{ card.label }}</span
        ><span class="metric-icon" :class="card.tone"
          ><el-icon><component :is="card.icon" /></el-icon
        ></span>
      </div>
      <div class="metric-value tabular" :title="card.exact">
        {{ card.value }}<small>{{ card.unit }}</small>
      </div>
      <p>{{ card.hint }}</p>
    </el-card>
  </div>
</template>
