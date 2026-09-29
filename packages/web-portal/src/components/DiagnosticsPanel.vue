<script setup lang="ts">
/**
 * 采集诊断：把「已有记录的归属覆盖」与「数据时间边界」两件事讲清楚。
 *
 * ★ 展示层只格式化服务端结果，不重算任何口径。
 * ★ 页面主体保持克制：结论（有没有未归属）用一条状态行表达，
 *   口径与免责说明集中到底部「指标口径说明」，不在正文里堆灰字。
 */
import { ElCard, ElIcon, ElTag } from 'element-plus'
import { computed } from 'vue'
import {
  CircleCheck,
  PieChart,
  Tickets,
  User,
  Warning,
} from '@element-plus/icons-vue'
import type { DiagnosticsResponse } from '@ai-token-report/shared'
import {
  formatCount,
  formatFullDateTime,
  formatPercent,
  formatTimeGap,
} from '../utils/format.js'
const props = defineProps<{
  diagnostics: DiagnosticsResponse | null
  fetchedAt: number | null
}>()
const unattributed = computed(() => props.diagnostics?.unattributedEvents ?? 0)
const cards = computed(() => {
  const d = props.diagnostics
  const warn = Boolean(d?.unattributedEvents)
  return [
    {
      label: '署名键组数',
      // ⚠️ 卡片名**刻意不叫**「分组数」：「分组」在产品里只有一个含义
      //   （人员分组实体，权威在 `member_group_assignments`）。本卡片数的是
      //   **署名键**的组数（每个稳定人员 + 每条待确认历史身份各算一组），
      //   与分组目录里的分组个数无关 —— 两者同名会让人拿看板数字去对
      //   分组管理页，然后把正确的数字当成数据 bug 排查。
      title: '人员与尚未关联成员的历史身份分别各计一组，不等同实际成员人数',
      value: d ? formatCount(d.distinctUsers) : '—',
      unit: '组',
      icon: User,
      tone: 'blue',
    },
    {
      label: '落库事件数',
      title: '当前范围内已经入库的计费事件',
      value: d ? formatCount(d.totalEvents) : '—',
      unit: '条',
      icon: Tickets,
      tone: 'violet',
    },
    {
      label: '未署名事件',
      title: '未署名既不采集也不上报',
      value: d ? formatCount(d.unattributedEvents) : '—',
      unit: '条',
      icon: Warning,
      tone: warn ? 'amber' : 'green',
    },
    {
      label: '未署名占比',
      title: '未归属事件占当前范围全部事件的比重',
      value: d ? formatPercent(d.unattributedRate) : '—',
      unit: '',
      icon: PieChart,
      tone: warn ? 'amber' : 'green',
    },
  ]
})
/** 时间边界；新鲜度以**本次取数时刻**为基准，避免浏览器时钟偏差。 */
const boundaries = computed(() => {
  const d = props.diagnostics
  const fetched = props.fetchedAt
  return [
    { label: '最早事件', value: d?.earliestTs ?? null, gap: '' },
    {
      label: '最新事件',
      value: d?.latestTs ?? null,
      gap: formatTimeGap(d?.latestTs ?? null, fetched),
    },
    {
      label: '最近一次上报',
      value: d?.lastIngestAt ?? null,
      gap: formatTimeGap(d?.lastIngestAt ?? null, fetched),
    },
    { label: '本次取数时刻', value: fetched, gap: '' },
  ]
})
</script>
<template>
  <template v-if="diagnostics">
    <div class="diagnostic-cards">
      <el-card
        v-for="card in cards"
        :key="card.label"
        shadow="never"
        class="metric-card diagnostic-card"
      >
        <div class="metric-card-top">
          <span :title="card.title">{{ card.label }}</span
          ><span class="metric-icon" :class="card.tone"
            ><el-icon><component :is="card.icon" /></el-icon
          ></span>
        </div>
        <div class="metric-value tabular">
          {{ card.value }}<small v-if="card.unit">{{ card.unit }}</small>
        </div>
      </el-card>
    </div>
    <div
      class="diagnostic-status"
      :class="unattributed ? 'is-warning' : 'is-ok'"
    >
      <span class="diagnostic-status-icon"
        ><el-icon
          ><Warning v-if="unattributed" /><CircleCheck v-else /></el-icon
      ></span>
      <strong>{{
        unattributed
          ? `存在 ${formatCount(unattributed)} 条未归属记录`
          : '当前范围内未发现未归属记录'
      }}</strong>
      <el-tag v-if="unattributed" type="warning" effect="light" size="small"
        >需核查</el-tag
      >
    </div>
    <el-card shadow="never"
      ><template #header
        ><div class="panel-heading">
          <h2>数据时间边界</h2>
        </div></template
      >
      <div class="boundary-grid">
        <div v-for="item in boundaries" :key="item.label" class="boundary-item">
          <span>{{ item.label }}</span>
          <strong class="tabular">{{
            formatFullDateTime(item.value)
          }}</strong>
          <small v-if="item.gap">{{ item.gap }}</small>
        </div>
      </div>
    </el-card>
    <el-card shadow="never" class="spec-card"
      ><h2>指标口径说明</h2>
      <dl class="spec-list">
        <div>
          <dt>署名键组数</dt>
          <dd>
            人员与尚未关联成员的历史身份分别计数，署名键组数不等同实际成员人数。未归属记录不计入署名键组数。
          </dd>
        </div>
        <div>
          <dt>未署名</dt>
          <dd>
            未署名不采集也不上报。这里仅反映已经入库的记录，不能据此判断尚未上报的人员或设备。
          </dd>
        </div>
        <div>
          <dt>计费总量</dt>
          <dd>
            包含未缓存输入、输出、缓存读与缓存写。推理 Token 属于输出的子集，不重复计入。
          </dd>
        </div>
        <div>
          <dt>恒等式校验</dt>
          <dd>
            失败值为 {{ diagnostics.identityViolations }}：上报库不存储独立 total
            列，总量由四项原始值派生，因此该值结构性恒为 0，并非一次扫描检查结果。
          </dd>
        </div>
      </dl></el-card
    >
  </template>
</template>