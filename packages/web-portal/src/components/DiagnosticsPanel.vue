<script setup lang="ts">
/**
 * 采集诊断：回答两个问题 —— 「数据是不是少了」与「谁在采集、还活着吗」。
 *
 * ★ 展示层只格式化服务端结果，不重算任何口径。
 *   命中率、平均每次调用这些派生值都由 `shared/metrics.ts` 算好后透传，
 *   组件里一个除法都不写（在这里再除一遍就是第二个口径实现，而它不会报错）。
 *
 * ## 三层结构
 *
 * 1. **数据规模**（卡片）：这批数据有多大、覆盖了多少人、缓存用得好不好。
 * 2. **采集来源**（来源表）：每个客户端（dsh / codex / …）各自贡献了多少、
 *    最近一条数据是什么时候 —— 「掉线」这件事只有在这一层才看得见。
 * 3. **署名覆盖**（署名表）：谁在报、谁很久没报了、谁没有分组。
 *
 * ## ⚠️ 页面刻意不说的事
 *
 * - **不推断「应该有几个人」**：未上报的人在上报库里没有任何痕迹，
 *   凭空造一个分母就会把「人没上报」显示成「覆盖良好」。
 * - **不给注册表补零**：某来源在本窗口没有数据就是「没出现」，
 *   补一排 0 会让它和「数据没进来」长得一样。
 */
import { ElCard, ElIcon, ElTable, ElTableColumn, ElTag } from 'element-plus'
import { computed, type Component } from 'vue'
import {
  CircleCheck,
  Coin,
  Cpu,
  DataLine,
  Histogram,
  Monitor,
  Odometer,
  PieChart,
  Tickets,
  User,
  Warning,
} from '@element-plus/icons-vue'
import type { DiagnosticsResponse } from '@ai-token-report/shared'
import { formatCompact, formatFullDateTime, formatTimeGap } from '../utils/format.js'
// ⚠️ 判断一律走 `diagnosticsModel.ts`：那里是纯函数，能被 `bun test` 直接钉住。
//   在本组件里重写一遍静默阈值或卡片集合，等于多出一份「24 小时」的定义 ——
//   两份一旦漂移，页面上就会出现「状态行说没掉线、表格里那一行标着静默」。
import {
  cadenceCards,
  conclusionOf,
  diagnosticCards,
  silenceOf,
} from '../views/diagnosticsModel.js'
const props = defineProps<{
  diagnostics: DiagnosticsResponse | null
  fetchedAt: number | null
}>()
/** 新旧服务端兼容：新字段缺席时整块不出现，绝不用 0 冒充「没有」。 */
const sources = computed(() => props.diagnostics?.sources ?? [])
const reporters = computed(() => props.diagnostics?.reporters ?? [])
const cards = computed(() => diagnosticCards(props.diagnostics))
/**
 * 卡片的图标。
 *
 * ⚠️ 图标留在**视图层**，不进 `diagnosticsModel.ts`：那是纯数据模块，
 *   把 Vue 组件对象塞进去会让 `bun test` 也要拖上 element-plus，
 *   而图标对「这张卡该不该出现」毫无影响。
 */
const CARD_ICONS: Record<string, Component> = {
  events: Tickets,
  sessions: Monitor,
  tokens: Coin,
  hit: DataLine,
  users: User,
  unattributed: Warning,
  rate: PieChart,
  avg: Odometer,
}
const cadence = computed(() =>
  cadenceCards(props.diagnostics).map((card) => ({
    ...card,
    icon: card.key === 'span' ? Histogram : Cpu,
  })),
)

/**
 * 静默间隔的文案。
 *
 * ★ 基准刻意是**本次取数时刻**（`fetchedAt`）而不是 `Date.now()`：
 *   上报时刻来自服务端，浏览器时钟慢几分钟就会算出负数（「-3 分钟前」），
 *   把一个健康的链路显示成未来数据（理由同 `formatTimeGap`）。
 */
function gapText(silentForMs: number | null): string {
  if (silentForMs === null || props.fetchedAt === null) return ''
  return formatTimeGap(props.fetchedAt - silentForMs, props.fetchedAt)
}
const sourceRows = computed(() =>
  sources.value.map((row) => ({ ...row, silence: silenceOf(row.silentForMs, gapText(row.silentForMs)) })),
)
const reporterRows = computed(() =>
  reporters.value.map((row) => ({ ...row, silence: silenceOf(row.silentForMs, gapText(row.silentForMs)) })),
)
/** 三种异常收成一句结论；判据在 model 里，模板只按 kind 选文案与颜色。 */
const conclusion = computed(() =>
  conclusionOf(props.diagnostics?.unattributedEvents ?? 0, sourceRows.value, reporterRows.value),
)

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
        :key="card.key"
        shadow="never"
        class="metric-card diagnostic-card"
      >
        <div class="metric-card-top">
          <span :title="card.title">{{ card.label }}</span
          ><span class="metric-icon" :class="card.tone"
            ><el-icon><component :is="CARD_ICONS[card.key]" /></el-icon
          ></span>
        </div>
        <div class="metric-value tabular">
          {{ card.value }}<small v-if="card.unit">{{ card.unit }}</small>
        </div>
      </el-card>
    </div>

    <!--
      结论状态行：把三件事（未归属 / 采集方掉线 / 署名者掉线）收成一句可执行的话。
      ⚠️ 只有全部正常时才显示「常态」那一句 —— 三种异常任一存在就说明白是哪一种，
      而不是笼统地说「有问题」。
    -->
    <div
      class="diagnostic-status"
      :class="conclusion.tone === 'amber' ? 'is-warning' : 'is-ok'"
    >
      <span class="diagnostic-status-icon"
        ><el-icon
          ><Warning v-if="conclusion.tone === 'amber'" /><CircleCheck v-else /></el-icon
      ></span>
      <strong>{{ conclusion.text }}</strong>
      <el-tag
        v-if="conclusion.tone === 'amber'"
        type="warning"
        effect="light"
        size="small"
        >需核查</el-tag
      >
    </div>

    <!--
      ★ 来源表：诊断页真正回答「哪台机器掉线了」的地方。
        事件数与总量都按来源折叠，缺哪一列就少哪一行 —— **不补零**，
        补出来的 0 会让「没人用这个客户端」与「数据没进来」无法区分。
    -->
    <el-card v-if="sourceRows.length" shadow="never">
      <template #header
        ><div class="panel-heading panel-heading-stack">
          <h2>采集来源覆盖</h2>
          <p>
            按上报来源（客户端）折叠。超过 24 小时无新数据会标为静默 —— 请先确认
            该客户端是否仍在使用，再判断是不是掉线。
          </p>
        </div></template
      >
      <el-table :data="sourceRows" size="default" style="width: 100%">
        <el-table-column prop="source" label="来源" min-width="120">
          <template #default="{ row }"><code>{{ row.source || '未标注' }}</code></template>
        </el-table-column>
        <el-table-column label="事件数" min-width="100" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatCount(row.calls) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="计费总量" min-width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatCompact(row.totalTokens) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="会话数" min-width="90" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatCount(row.sessions) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近事件" min-width="170">
          <template #default="{ row }">
            <span class="tabular">{{ formatFullDateTime(row.latestEventTs) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="新鲜度" min-width="100">
          <template #default="{ row }">
            <el-tag :type="row.silence.tone === 'amber' ? 'warning' : 'success'" effect="light" size="small">
              {{ row.silence.text }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!--
      署名覆盖：按调用条数降序的前若干名。
      ⚠️ 服务端**已经截断**，所以这里不能出现「其余 N 人」——
        页面拿不到第 11 名，写「其余」就是在编数据。
    -->
    <el-card v-if="reporterRows.length" shadow="never">
      <template #header
        ><div class="panel-heading panel-heading-stack">
          <h2>署名覆盖</h2>
          <p>
            按调用条数降序取前 10 名。「历史人员」表示该署名尚未关联到成员，
            需要在人员管理页确认后归属才会生效。
          </p>
        </div></template
      >
      <el-table :data="reporterRows" size="default" style="width: 100%">
        <el-table-column prop="label" label="署名" min-width="180">
          <template #default="{ row }">
            <span class="reporter-name">{{ row.label }}</span>
            <el-tag
              v-if="row.attributionStatus === 'legacy'"
              type="warning"
              effect="light"
              size="small"
              >待确认</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column label="所属分组" min-width="160">
          <template #default="{ row }">
            <span v-if="row.groupNames.length">{{ row.groupNames.join('、') }}</span>
            <span v-else class="muted">未分组</span>
          </template>
        </el-table-column>
        <el-table-column label="事件数" min-width="100" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatCount(row.calls) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="计费总量" min-width="110" align="right">
          <template #default="{ row }">
            <span class="tabular">{{ formatCompact(row.totalTokens) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近事件" min-width="170">
          <template #default="{ row }">
            <span class="tabular">{{ formatFullDateTime(row.latestEventTs) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="新鲜度" min-width="100">
          <template #default="{ row }">
            <el-tag :type="row.silence.tone === 'amber' ? 'warning' : 'success'" effect="light" size="small">
              {{ row.silence.text }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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
      <div v-if="cadence.length" class="cadence-grid">
        <div v-for="item in cadence" :key="item.label" class="cadence-item">
          <span class="cadence-label"
            ><el-icon><component :is="item.icon" /></el-icon>{{ item.label }}</span
          >
          <strong class="tabular">{{ item.value }}</strong>
          <small>{{ item.hint }}</small>
        </div>
      </div>
    </el-card>
    <p class="muted">
      署名键组数按人员与尚未关联成员的历史身份各计一组，不等同实际成员人数，未归属记录不计入署名键组数；
      恒等式校验失败值 {{ diagnostics.identityViolations }} —— 上报库不存储独立 total 列，
      总量由四项原始值派生，因此结构性恒为 0，并非一次扫描检查结果。
      未署名的人不会在上报库里留下任何痕迹，因此本页**不推断**「应该有几个人」；
      要判断谁没上报，请对照人员管理页的名册。
    </p>
  </template>
</template>
