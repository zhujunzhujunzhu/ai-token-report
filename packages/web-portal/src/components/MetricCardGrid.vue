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
} from '@element-plus/icons-vue'
import type { OverviewResponse } from '@ai-token-report/shared'
import { formatCompact, formatCount, formatPercent } from '../utils/format.js'
const props = defineProps<{ overview: OverviewResponse | null }>()
const cards = computed(() => {
  const o = props.overview
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
