<script setup lang="ts">
/**
 * 模型单价（v7）—— 费用统计的**唯一**计价来源。
 *
 * ## 这一页负责什么、不负责什么
 *
 * 只负责两件事：把「货币单位 / 百万 token」换算成库里的**整数微元**（走
 * `utils/unitPrice.ts`，那一步有单测钉着小数位），以及排版。
 * 🚨 **费用怎么算完全不在这里** —— 那是 `shared/price.ts` 的口径：
 *
 * ```
 * cost = input × p_input + output × p_output + cacheRead × p_cacheRead + cacheWrite × p_cacheWrite
 * ```
 *
 * 页面自己算一遍就是第二个口径实现，而它**不会报错**，只会让两个界面的金额对不上。
 *
 * ## 为什么粒度是「供应商 → 模型」，而不是「一个供应商一个价」
 *
 * 同一个供应商下不同模型的价差常常在 10 倍以上（旗舰 vs 轻量），
 * 汇成一个价必然有一半模型算错 —— 而页面上只看得出「金额不对」，看不出是哪一半。
 * 所以这一页**按供应商分组**，每个供应商下面逐个模型列出**历任价格**
 * （一条价只在一个生效区间里有效，改价是加一条新区间，不是改掉旧的那条）。
 *
 * ## 三条必须让人一眼看到的约束
 *
 * 1. **只存单价，绝不存金额**：改价即时生效，而历史用量一个字节都不会被动 ——
 *    这正是「费用可以在事后修正」的原因，也是这一页敢于直接删改价的前提。
 * 2. **多币种各自累加，绝不换算、绝不相加**：汇率是会随时间变的外部事实，
 *    把它烧进查询结果等于给历史数字埋雷。
 * 3. **未定价 ≠ 0 元**：没有价的那部分用量是「未计价」，不是「没花钱」。
 *    把它显示成 0，会让「漏配了价」看起来像「省下了钱」。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Refresh, Search, MagicStick } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDatePicker, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElSwitch, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { formatUnitPriceMicro } from '@ai-token-report/shared'
import type { PortalModelPrice } from '@ai-token-report/shared'
import * as api from '../api/admin.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'
import {
  PRICE_STATUS_TEXT, groupPricesByProvider, microToRateText, priceSpanText, priceStatusOf, rateTextToMicro,
} from '../utils/unitPrice.js'

const session = useSessionStore()
const prices = ref<PortalModelPrice[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const search = ref('')
const currencyFilter = ref('')
const onlyEffective = ref(false)
const showForm = ref(false)
const selected = ref<PortalModelPrice | null>(null)
const form = ref<FormInstance>()
/** 「当前生效」的判定基准在**加载时**取一次：渲染过程中反复读 `Date.now()` 会让同一屏里两行用不同的基准。 */
const nowMs = ref(Date.now())

const canManage = computed(() => session.can('pricing:manage'))

const draft = reactive({
  provider: '', model: '', currency: 'CNY',
  input: '', output: '', cacheRead: '', cacheWrite: '',
  from: '', to: '', note: '',
})

const rules: FormRules = {
  provider: [{ required: true, message: '请填写供应商（与上报值逐字一致）', trigger: 'blur' }],
  model: [{ required: true, message: '请填写模型名（与上报值逐字一致）', trigger: 'blur' }],
  currency: [{ required: true, message: '请选择或填写币种', trigger: 'change' }],
}

/** 币种候选：常用几个 + 允许手填（`allow-create`），因为供应商可能用别的币种结算。 */
const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'GBP']

/**
 * 按供应商分组 —— 这就是「每个供应商下的不同模型各自定价」的落点。
 * 分组与筛选的判定都在 `utils/unitPrice.ts`（纯函数，有单测）。
 */
const groups = computed(() => groupPricesByProvider(prices.value, {
  search: search.value,
  currency: currencyFilter.value,
  onlyEffective: onlyEffective.value,
  nowMs: nowMs.value,
}))

const currenciesInUse = computed(() => [...new Set(prices.value.map((row) => row.currency))].sort())
/** `el-table` 的插槽把行给成宽类型，这里收窄回契约类型。 */
const rowPrice = (row: unknown): PortalModelPrice => row as PortalModelPrice
const spanText = (row: PortalModelPrice): string => priceSpanText(row, formatFullDateTime)
const statusOf = (row: PortalModelPrice): 'active' | 'future' | 'past' => priceStatusOf(row, nowMs.value)

const STATUS_TEXT = PRICE_STATUS_TEXT
const STATUS_TYPE: Record<'active' | 'future' | 'past', 'success' | 'warning' | 'info'> = { active: 'success', future: 'warning', past: 'info' }

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = null
  // 基准取一次，并对齐「这次读取」的时刻（见 `nowMs` 的注释）。
  nowMs.value = Date.now()
  const result = await api.fetchModelPrices()
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); loading.value = false; return }
  if (!result.ok) error.value = result.reason ?? '单价加载失败'
  else prices.value = result.data.prices
  loading.value = false
}

function openForm(row: PortalModelPrice | null = null): void {
  selected.value = row
  draft.provider = row?.provider ?? ''
  draft.model = row?.model ?? ''
  draft.currency = row?.currency ?? (currenciesInUse.value[0] ?? 'CNY')
  draft.input = row ? microToRateText(row.input_micro_per_ktok) : ''
  draft.output = row ? microToRateText(row.output_micro_per_ktok) : ''
  draft.cacheRead = row ? microToRateText(row.cache_read_micro_per_ktok) : ''
  draft.cacheWrite = row ? microToRateText(row.cache_write_micro_per_ktok) : ''
  draft.from = row && row.effective_from_ms > 0 ? localInput(row.effective_from_ms) : ''
  draft.to = row?.effective_to_ms ? localInput(row.effective_to_ms) : ''
  draft.note = row?.note ?? ''
  error.value = null
  showForm.value = true
}

/** epoch 毫秒 → `<el-date-picker value-format="YYYY-MM-DDTHH:mm">` 认的本地墙上时间。 */
function localInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 「四类同价」：低价模型常常四类一个价，逐个抄四遍既慢又容易抄错一行。 */
function fillSame(): void {
  const value = draft.input.trim()
  if (!value) return
  draft.output = value
  draft.cacheRead = value
  draft.cacheWrite = value
}

async function save(): Promise<void> {
  if (busy.value || !(await form.value?.validate().catch(() => false))) return
  const rates = {
    input_micro_per_ktok: rateTextToMicro(draft.input),
    output_micro_per_ktok: rateTextToMicro(draft.output),
    cache_read_micro_per_ktok: rateTextToMicro(draft.cacheRead),
    cache_write_micro_per_ktok: rateTextToMicro(draft.cacheWrite),
  }
  if (Object.values(rates).some((value) => value === null)) {
    error.value = '四类单价都要填：非负数字、最多 6 位小数；超过上限（10000 元/百万 token）请先确认单价是否录错'
    return
  }
  const currency = draft.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) { error.value = '币种需要是三位大写字母的 ISO 4217 代码（如 USD、CNY）'; return }
  const from = draft.from ? new Date(draft.from).getTime() : 0
  const to = draft.to ? new Date(draft.to).getTime() : null
  if (!Number.isSafeInteger(from) || from < 0) { error.value = '生效起点无效'; return }
  if (to !== null && (!Number.isSafeInteger(to) || to < 0)) { error.value = '生效终点无效'; return }
  if (to !== null && to < from) { error.value = '生效终点不能早于生效起点'; return }
  busy.value = true
  const result = await api.setModelPrice({
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    currency,
    ...(rates as Record<keyof typeof rates, number>),
    effective_from_ms: from,
    effective_to_ms: to,
    note: draft.note.trim() || null,
  })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  // 🚨 409（区间重叠）**原样呈现服务端那句话**：它点出了撞上的是哪一条区间，
  //   而「保存失败」四个字会让使用者以为是网络问题，反复重试同一件不可能成功的事。
  if (!result.ok) { error.value = result.reason ?? '保存失败'; return }
  showForm.value = false
  ElMessage.success('单价已保存，费用按事件发生时刻选用对应区间的价')
  await load()
}

async function remove(row: PortalModelPrice): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `删除后，${row.model} 在 ${spanText(row)} 这段时间里的用量会变成「未计价」——`
      + '不是变成 0 元，而是费用统计里明确标出「这段没有单价」。历史用量本身不会被改动。',
      `删除单价 · ${row.provider} / ${row.model}`,
      { type: 'warning', confirmButtonText: '删除这条价', cancelButtonText: '取消' },
    )
  } catch { return }
  busy.value = true
  const result = await api.deleteModelPrice({ price_id: row.price_id })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { ElMessage.error(result.reason ?? '删除失败'); return }
  ElMessage.success('单价已删除')
  await load()
}

/** 用内置种子价初始化 —— 只在**一条价都没有**时可用，避免把已调好的价覆盖掉。 */
async function seed(): Promise<void> {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      '种子价是**内置的参考值**，不一定等于你的实际结算价 —— 它只是让你不必从零开始填。'
      + '写入后请逐条核对。这个操作只在单价表为空时可用。',
      '用内置种子价初始化',
      { type: 'warning', confirmButtonText: '写入并逐条核对', cancelButtonText: '取消' },
    )
  } catch { return }
  busy.value = true
  const result = await api.seedModelPrices({ confirm: true })
  busy.value = false
  if (result.status === 401) { session.expire('登录已失效，请重新登录'); return }
  if (!result.ok) { error.value = result.reason ?? '初始化失败'; return }
  ElMessage.success('已写入内置种子价，请逐条核对后再用于正式统计')
  await load()
}

onMounted(() => { void load() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">MODEL PRICING</div>
        <h1>模型单价</h1>
        <p>
          费用按「<strong>供应商 + 模型</strong>」精确匹配单价后现场计算：四类 token 各乘各自的价
          （<code>输入 / 输出 / 缓存读 / 缓存写</code>），再按<strong>事件发生时刻</strong>选用当时生效的那条价。
          同一供应商下不同模型可以各不相同 —— 旗舰与轻量模型的价差常常在 10 倍以上。
        </p>
        <p class="muted">
          库里<strong>只存单价、绝不存金额</strong>：所以改价、补历史价都是即时生效的，
          而历史用量一个字节都不会被动。这也意味着<strong>未配单价的用量是「未计价」，不是 0 元</strong>。
        </p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canManage && !prices.length" :icon="MagicStick" :disabled="busy || loading" @click="seed">用内置种子价初始化</el-button>
        <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="openForm()">新增单价</el-button>
      </div>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
    <el-card shadow="never">
      <template #header>
        <div class="panel-heading">
          <div>
            <h2>计价目录</h2>
            <p>
              按供应商分组，每个模型各有一条或多条<strong>生效区间</strong>。
              区间不得重叠 —— 重叠会让「某一时刻该用哪个价」变成读取顺序问题，服务端会直接拒绝并说明撞上了哪一条。
            </p>
          </div>
          <el-button :icon="Refresh" :loading="loading" :disabled="busy" @click="load">刷新</el-button>
        </div>
      </template>
      <div class="member-filters">
        <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索供应商、模型或备注" aria-label="搜索单价" />
        <el-select v-model="currencyFilter" clearable placeholder="全部币种" aria-label="筛选币种">
          <el-option v-for="code in currenciesInUse" :key="code" :label="code" :value="code" />
        </el-select>
        <el-switch v-model="onlyEffective" active-text="只看当前生效" aria-label="只看当前生效" />
        <span class="muted">共 {{ prices.length }} 条价 · {{ groups.length }} 个供应商</span>
      </div>
      <el-skeleton v-if="loading && !prices.length" :rows="5" animated />
      <template v-else-if="groups.length">
        <!-- ★ 一个供应商一张表：这就是「同一供应商下不同模型各自定价」的可读形态。 -->
        <section v-for="group in groups" :key="group.provider" class="provider-group">
          <h3>
            <code>{{ group.provider }}</code>
            <span class="muted"> · {{ group.rows.length }} 条价 · {{ group.models }} 个模型</span>
          </h3>
          <el-table :data="group.rows" row-key="price_id">
            <el-table-column label="模型" min-width="200">
              <template #default="{ row }"><code>{{ row.model }}</code></template>
            </el-table-column>
            <el-table-column label="币种" width="90">
              <template #default="{ row }"><el-tag type="info">{{ row.currency }}</el-tag></template>
            </el-table-column>
            <el-table-column label="输入" min-width="150"><template #default="{ row }">{{ formatUnitPriceMicro(row.input_micro_per_ktok, row.currency) }}</template></el-table-column>
            <el-table-column label="输出" min-width="150"><template #default="{ row }">{{ formatUnitPriceMicro(row.output_micro_per_ktok, row.currency) }}</template></el-table-column>
            <el-table-column label="缓存读" min-width="150"><template #default="{ row }">{{ formatUnitPriceMicro(row.cache_read_micro_per_ktok, row.currency) }}</template></el-table-column>
            <el-table-column label="缓存写" min-width="150"><template #default="{ row }">{{ formatUnitPriceMicro(row.cache_write_micro_per_ktok, row.currency) }}</template></el-table-column>
            <el-table-column label="生效区间" min-width="230"><template #default="{ row }">{{ spanText(rowPrice(row)) }}</template></el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="STATUS_TYPE[statusOf(rowPrice(row))]">{{ STATUS_TEXT[statusOf(rowPrice(row))] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="备注" min-width="160">
              <template #default="{ row }"><span class="muted">{{ row.note || '—' }}</span></template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :icon="Edit" :disabled="busy" @click="openForm(rowPrice(row))">编辑</el-button>
                <el-button link type="danger" :icon="Delete" :disabled="busy" @click="remove(rowPrice(row))">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </template>
      <el-empty v-else description="还没有任何单价：费用统计会把全部用量标成「未计价」，而不是 0 元">
        <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="openForm()">新增第一条单价</el-button>
        <el-button v-if="canManage" :icon="MagicStick" :disabled="busy" @click="seed">用内置种子价初始化</el-button>
      </el-empty>
    </el-card>
    <el-card shadow="never">
      <template #header><h2>这一页的几件事，值得先知道</h2></template>
      <ul class="muted">
        <li>
          <strong>单价是「货币单位 / 百万 token」</strong>（与各家价目表同一单位），
          库里存成整数微元（1 微 = 0.000001 货币单位）：
          <code>2</code> 表示每百万 token 2 元，缓存读 <code>0.2</code> 就是每百万 token 0.2 元。
        </li>
        <li>
          <strong>四类必须分开填</strong>：缓存读价通常比输入价便宜一个数量级，
          而它占总用量的 94% 以上。把四类合成一个价，等于让绝大部分用量算错。
        </li>
        <li>
          <strong>改价 = 新增一条生效区间</strong>：从某一天起用新价，就把旧价的「生效终点」设在那一天。
          直接改旧价会让<strong>历史费用一起变</strong>——虽然用量没变，但金额会重算。
        </li>
        <li>
          <strong>多币种各自累加，绝不换算也绝不相加</strong>：页面用 <code>+</code> 连接不同币种的金额。
          汇率是随时间变的外部事实，烧进结果里等于给历史数字埋雷。
        </li>
        <li>
          <strong>自建计价永远不会等于财务账单</strong>：折扣、预付、赠送额度都不在单价里。
          对账用专门的月度对账脚本，账单金额不进页面。
        </li>
      </ul>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑单价' : '新增单价'" width="min(760px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <div class="form-grid">
          <el-form-item label="供应商" prop="provider">
            <el-input v-model="draft.provider" maxlength="128" placeholder="例如 deepseek-official" autocomplete="off" />
            <p class="muted">必须与上报值逐字一致（区分大小写）；归一化只影响展示口径，不改变这里的匹配。</p>
          </el-form-item>
          <el-form-item label="模型" prop="model">
            <el-input v-model="draft.model" maxlength="255" placeholder="例如 deepseek-v4.1-flash" autocomplete="off" />
            <p class="muted">同一个供应商下每个模型各配各的价。</p>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="币种" prop="currency">
            <el-select v-model="draft.currency" filterable allow-create default-first-option placeholder="选择或填写币种" aria-label="币种">
              <el-option v-for="code in CURRENCIES" :key="code" :label="code" :value="code" />
            </el-select>
          </el-form-item>
          <el-form-item label="四类单价">
            <el-button :disabled="busy || !draft.input.trim()" @click="fillSame">四类同价（按输入价填满）</el-button>
            <p class="muted">只在你确认这个模型四类同价时用。</p>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item :label="`输入（${draft.currency || '货币单位'} / 百万 token）`">
            <el-input v-model="draft.input" placeholder="例如 2" autocomplete="off" />
          </el-form-item>
          <el-form-item :label="`输出（${draft.currency || '货币单位'} / 百万 token）`">
            <el-input v-model="draft.output" placeholder="例如 8" autocomplete="off" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item :label="`缓存读（${draft.currency || '货币单位'} / 百万 token）`">
            <el-input v-model="draft.cacheRead" placeholder="例如 0.2" autocomplete="off" />
          </el-form-item>
          <el-form-item :label="`缓存写（${draft.currency || '货币单位'} / 百万 token）`">
            <el-input v-model="draft.cacheWrite" placeholder="例如 0（不单列就填 0）" autocomplete="off" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="生效起点">
            <el-date-picker v-model="draft.from" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" placeholder="留空 = 自始有效" aria-label="生效起点" />
          </el-form-item>
          <el-form-item label="生效终点">
            <el-date-picker v-model="draft.to" type="datetime" value-format="YYYY-MM-DDTHH:mm" format="YYYY-MM-DD HH:mm" placeholder="留空 = 至今有效" aria-label="生效终点" />
          </el-form-item>
        </div>
        <el-form-item label="备注">
          <el-input v-model="draft.note" maxlength="255" placeholder="例如：2026-01 起的官方价；或「内置种子价，未核对」" autocomplete="off" />
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showForm = false">取消</el-button>
          <el-button type="primary" native-type="submit" :loading="busy">保存单价</el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
.provider-group { margin-bottom: 22px; }
.provider-group h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.heading-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 18px; }
</style>