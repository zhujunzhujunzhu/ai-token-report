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
 *
 * ## v10 新增的两件事（都在这一页上）
 *
 * - **不限供应商的基础价**（`provider = '*'`）：没有专属价时用它兜底。
 *   页面把 `*` 渲染成「不限供应商（基础价）」，**绝不把 `*` 直接显示出来** ——
 *   它看起来像通配符，而使用者只会以为页面坏了。
 * - **闲时（低谷）价**：一条价可以带另一套「闲时四类单价」+ 一个时段表
 *   （`shared/price.ts` 的 `PRICE_SCHEDULES`，当前是 DeepSeek 官方口径）。
 *   🚨 五个字段**同生共死**：要么都不填（这条价全天一个价），要么时段表 + 四个价齐全。
 *   半套配置会让缺的那一档按 **0 元**算 —— 0 是合法单价，不会有任何报错。
 *
 * ## 默认币种是人民币
 *
 * 筛选下拉与新增 / 编辑弹框都默认 **CNY**（`utils/unitPrice.ts` 的
 * `DEFAULT_CURRENCY`）—— 本部门按元结算，内置种子价也是人民币官方价。
 * ⚠️ 默认只在**表里确实有 CNY 的价**时才套到筛选上，且**只在首次取数后套一次**：
 *    否则要么把一张全是别的币种的目录筛空（看起来像「价都没了」），要么把使用者
 *    手动切回的「全部币种」反复改掉。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { Delete, Edit, Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  ElAlert, ElButton, ElCard, ElDatePicker, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput,
  ElMessage, ElMessageBox, ElOption, ElSelect, ElSkeleton, ElSwitch, ElTable, ElTableColumn, ElTag,
} from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { ANY_PROVIDER, PRICE_SCHEDULES, formatUnitPriceMicro, offpeakConfigError } from '@ai-token-report/shared'
import type { PortalModelPrice } from '@ai-token-report/shared'
import * as api from '../api/admin.js'
import { useSessionStore } from '../stores/session.js'
import { formatFullDateTime } from '../utils/format.js'
import {
  BASE_PROVIDER_LABEL, DEFAULT_CURRENCY, PRICE_STATUS_TEXT, defaultCurrencyForFilter, defaultCurrencyForNewPrice,
  groupPricesByProvider, hasOffpeak, microToRateText, offpeakRatesOf, priceSpanText, priceStatusOf, providerLabel,
  rateTextToMicro, scheduleHint, scheduleLabel,
} from '../utils/unitPrice.js'

const session = useSessionStore()
const prices = ref<PortalModelPrice[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const search = ref('')
/**
 * 币种筛选：**默认 CNY**（见 `utils/unitPrice.ts` 的 `DEFAULT_CURRENCY`）。
 *
 * ⚠️ 默认值在**首次成功取数之后**才套一次（`currencyFilterInitialized`）：
 *   一开始就写死 `'CNY'`，在「一条 CNY 的价都没有」的库上会让表格空掉；
 *   而每次 `load()` 都套一遍，会把使用者手动切回的「全部币种」反复改掉。
 */
const currencyFilter = ref('')
let currencyFilterInitialized = false
const onlyEffective = ref(false)
const showForm = ref(false)
const selected = ref<PortalModelPrice | null>(null)
const form = ref<FormInstance>()
/** 「当前生效」的判定基准在**加载时**取一次：渲染过程中反复读 `Date.now()` 会让同一屏里两行用不同的基准。 */
const nowMs = ref(Date.now())

const canManage = computed(() => session.can('pricing:manage'))

const draft = reactive({
  provider: '', model: '', currency: DEFAULT_CURRENCY,
  input: '', output: '', cacheRead: '', cacheWrite: '',
  /** v10：基础价开关（打开时 `provider` 写保留值 `'*'`，输入框交给它，不让手打）。 */
  basePrice: false,
  /** v10：闲时档 —— 时段表为空 = 这条价不分时段。 */
  offpeakSchedule: '',
  offpeakInput: '', offpeakOutput: '', offpeakCacheRead: '', offpeakCacheWrite: '',
  from: '', to: '', note: '',
})

/** 可选时段表（名称 + id）；「不分时段」由空串表示。 */
const SCHEDULES = PRICE_SCHEDULES.map((schedule) => ({ id: schedule.id, label: schedule.label }))
const scheduleTip = computed(() => (draft.offpeakSchedule ? scheduleHint(draft.offpeakSchedule) : ''))

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
/**
 * 筛完之后真正列出来的行数。
 *
 * ★ 必须与「共 N 条价」一起显示：币种筛选**默认就选着 CNY**，所以「表里有几条」
 *   与「现在看到几条」从打开这一页起就可能不是同一个数 —— 只报总数会让人以为
 *   自己看到的就是全部，而少掉的那些恰好是别的币种的价。
 */
const visibleCount = computed(() => groups.value.reduce((total, group) => total + group.rows.length, 0))
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
  else {
    prices.value = result.data.prices
    // 默认币种只套一次（见 `currencyFilterInitialized` 的注释），且只在**真取到数**之后。
    if (!currencyFilterInitialized) {
      currencyFilterInitialized = true
      const preferred = defaultCurrencyForFilter(currenciesInUse.value)
      if (preferred) currencyFilter.value = preferred
    }
  }
  loading.value = false
}

function openForm(row: PortalModelPrice | null = null): void {
  selected.value = row
  draft.basePrice = row?.provider === ANY_PROVIDER
  draft.provider = row?.provider ?? ''
  draft.model = row?.model ?? ''
  // 编辑时用这条价自己的币种；新增时默认 CNY（见 `defaultCurrencyForNewPrice`）。
  draft.currency = row?.currency ?? defaultCurrencyForNewPrice(currenciesInUse.value)
  draft.input = row ? microToRateText(row.input_micro_per_ktok) : ''
  draft.output = row ? microToRateText(row.output_micro_per_ktok) : ''
  draft.cacheRead = row ? microToRateText(row.cache_read_micro_per_ktok) : ''
  draft.cacheWrite = row ? microToRateText(row.cache_write_micro_per_ktok) : ''
  // 闲时档：**只有五个字段齐全**才回填（半套配置只可能来自直接改库，
  // 回填一半会让使用者一保存就把它变成一套「看起来完整」的配置）。
  const offpeak = row ? offpeakRatesOf(row) : null
  draft.offpeakSchedule = offpeak === null ? '' : (row?.offpeak_schedule ?? '')
  draft.offpeakInput = offpeak ? microToRateText(offpeak.input) : ''
  draft.offpeakOutput = offpeak ? microToRateText(offpeak.output) : ''
  draft.offpeakCacheRead = offpeak ? microToRateText(offpeak.cacheRead) : ''
  draft.offpeakCacheWrite = offpeak ? microToRateText(offpeak.cacheWrite) : ''
  draft.from = row && row.effective_from_ms > 0 ? localInput(row.effective_from_ms) : ''
  draft.to = row?.effective_to_ms ? localInput(row.effective_to_ms) : ''
  draft.note = row?.note ?? ''
  error.value = null
  showForm.value = true
}

/** 基础价开关：打开就把 `provider` 置成保留值（输入框不再参与），关掉就交回手填。 */
function toggleBasePrice(): void {
  draft.provider = draft.basePrice ? ANY_PROVIDER : ''
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

/**
 * 闲时四类价按**高峰价的一半**填满（DeepSeek 官方口径），四类各自减半。
 *
 * ⚠️ 减半在「微元 / 千 token」这个整数上做，**不经过元**：先转成十进制文本再除 2
 *   会引入一轮浮点，而四类分价恰恰是最经不起「一点点误差」的地方。
 *   奇数微元的一半取整到最近的整数（官方价目里都是偶数，取整只是兜底）。
 */
function fillOffpeakSame(): void {
  const half = (text: string): string => {
    const micro = rateTextToMicro(text)
    if (micro === null) return ''
    return microToRateText(Math.round(micro / 2))
  }
  draft.offpeakInput = half(draft.input)
  draft.offpeakOutput = half(draft.output)
  draft.offpeakCacheRead = half(draft.cacheRead)
  draft.offpeakCacheWrite = half(draft.cacheWrite)
}

/**
 * 清空全部筛选条件（含**默认就选着的币种**）。
 *
 * ⚠️ 清空后不再套回默认币种：这是使用者刚做的显式选择，重新选上等于把
 *   「我要看全部」改回「只看 CNY」，而页面不会有任何提示。
 */
function clearFilters(): void {
  search.value = ''
  currencyFilter.value = ''
  onlyEffective.value = false
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
  /**
   * 闲时档（v10）：**要么全空、要么四类价 + 时段表齐全**。
   *
   * ⚠️ 判定调的是 `shared/price.ts` 的 `offpeakConfigError()` —— 服务端写入前调的是
   *   同一个函数。这里再判一次只是为了即时反馈（不必等一个来回），而不是第二套规则。
   */
  const anyOffpeakFilled = [draft.offpeakInput, draft.offpeakOutput, draft.offpeakCacheRead, draft.offpeakCacheWrite]
    .some((text) => text.trim() !== '')
  const allOffpeakFilled = [draft.offpeakInput, draft.offpeakOutput, draft.offpeakCacheRead, draft.offpeakCacheWrite]
    .every((text) => text.trim() !== '')
  let offpeak = { schedule: null as string | null, rates: null as Record<string, number> | null }
  if (anyOffpeakFilled || draft.offpeakSchedule) {
    if (!allOffpeakFilled) { error.value = '闲时四类单价要一起填：缺一个就会有一档按 0 元算'; return }
    const parsed = {
      input_micro_per_ktok: rateTextToMicro(draft.offpeakInput),
      output_micro_per_ktok: rateTextToMicro(draft.offpeakOutput),
      cache_read_micro_per_ktok: rateTextToMicro(draft.offpeakCacheRead),
      cache_write_micro_per_ktok: rateTextToMicro(draft.offpeakCacheWrite),
    }
    if (Object.values(parsed).some((value) => value === null)) {
      error.value = '闲时四类单价都要填：非负数字、最多 6 位小数；超过上限（10000 元/百万 token）请先确认单价是否录错'
      return
    }
    offpeak = { schedule: draft.offpeakSchedule || null, rates: parsed as Record<string, number> }
  }
  // 与服务端同一份校验（时段表是否存在 / 五个字段是否配套）—— 只为即时反馈
  const offpeakReason = offpeakConfigError({
    offpeakRates: offpeak.rates === null ? null : {
      inputMicroPerKtok: offpeak.rates.input_micro_per_ktok!,
      outputMicroPerKtok: offpeak.rates.output_micro_per_ktok!,
      cacheReadMicroPerKtok: offpeak.rates.cache_read_micro_per_ktok!,
      cacheWriteMicroPerKtok: offpeak.rates.cache_write_micro_per_ktok!,
    },
    offpeakSchedule: offpeak.schedule,
  })
  if (offpeakReason) { error.value = offpeakReason; return }
  const from = draft.from ? new Date(draft.from).getTime() : 0
  const to = draft.to ? new Date(draft.to).getTime() : null
  if (!Number.isSafeInteger(from) || from < 0) { error.value = '生效起点无效'; return }
  if (to !== null && (!Number.isSafeInteger(to) || to < 0)) { error.value = '生效终点无效'; return }
  if (to !== null && to < from) { error.value = '生效终点不能早于生效起点'; return }
  busy.value = true
  const result = await api.setModelPrice({
    provider: draft.basePrice ? ANY_PROVIDER : draft.provider.trim(),
    model: draft.model.trim(),
    currency,
    ...(rates as Record<keyof typeof rates, number>),
    // 不分时段时五个字段一个都不发（服务端与旧客户端同一条语义：缺席 = 全天一个价）
    ...(offpeak.rates === null ? {} : {
      offpeak_schedule: offpeak.schedule,
      ...(offpeak.rates as Record<string, number>),
    }),
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

onMounted(() => { void load() })
</script>

<template>
  <div class="page-stack">
    <div class="page-heading">
      <div>
        <div class="eyebrow">MODEL PRICING</div>
        <h1>模型单价</h1>
        <p>
          费用按「<strong>供应商 + 模型</strong>」精确匹配单价后现场计算：<strong>四类 token 各乘各自的价</strong>
          （<code>输入 / 输出 / 缓存读 / 缓存写</code>），按<strong>事件发生时刻</strong>取当时生效的那条价，
          分<strong>高峰 / 闲时</strong>两档（闲时价是同一行的另一套四个数，不是乘折扣系数）；
          同一供应商下不同模型可以各不相同。
        </p>
        <p class="muted">
          没有为某个供应商单独配价时会落到那条<strong>不限供应商的基础价</strong>（兜底价）。
          库里只存单价、不存金额，改价即时生效而历史用量一个字节都不会被动；
          没配单价的用量是「<strong>未计价</strong>」，不是 0 元。
          多币种各自累加，绝不换算也绝不相加；自建计价永远不会等于财务账单（折扣、预付、赠送额度不在单价里）。
        </p>
      </div>
      <div class="heading-actions">
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
              单价按「<strong>货币单位 / 百万 token</strong>」录入，库里存<strong>整数微元</strong>（1 微 = 0.000001 货币单位）：
              填 2 就是每百万 token 2 元。每个模型各有一条或多条<strong>生效区间</strong>，
              区间不得重叠 —— 服务端会直接拒绝并说明撞上了哪一条。
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
        <span class="muted">
          共 {{ prices.length }} 条价 · {{ groups.length }} 个分组<template v-if="visibleCount !== prices.length">（当前筛选出 {{ visibleCount }} 条）</template>
        </span>
      </div>
      <el-skeleton v-if="loading && !prices.length" :rows="5" animated />
      <template v-else-if="groups.length">
        <!-- ★ 一个供应商一张表：这就是「同一供应商下不同模型各自定价」的可读形态。
             基础价（`*`）单独成一组并排在最前 —— 它是没有专属价时的兜底。 -->
        <section v-for="group in groups" :key="group.provider" class="provider-group">
          <h3>
            <code>{{ providerLabel(group.provider) }}</code>
            <el-tag v-if="group.provider === ANY_PROVIDER" type="warning" size="small">兜底</el-tag>
            <span class="muted"> · {{ group.rows.length }} 条价 · {{ group.models }} 个模型</span>
          </h3>
          <p v-if="group.provider === ANY_PROVIDER" class="muted base-price-hint">
            这一组是<strong>不限供应商</strong>的价：只有当某个供应商<strong>没有</strong>自己那条专属价时才用它。
            给某个网关单独配一条同名模型的价即可覆盖它 —— 两条可以共存，专属价优先。
          </p>
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
            <el-table-column label="闲时（低谷）" min-width="240">
              <template #default="{ row }">
                <template v-if="hasOffpeak(rowPrice(row))">
                  <div class="muted">{{ scheduleLabel(rowPrice(row).offpeak_schedule) }}</div>
                  <div>
                    输入 {{ formatUnitPriceMicro(rowPrice(row).offpeak_input_micro_per_ktok, row.currency) }} ·
                    输出 {{ formatUnitPriceMicro(rowPrice(row).offpeak_output_micro_per_ktok, row.currency) }}
                  </div>
                  <div class="muted">
                    缓存读 {{ formatUnitPriceMicro(rowPrice(row).offpeak_cache_read_micro_per_ktok, row.currency) }} ·
                    缓存写 {{ formatUnitPriceMicro(rowPrice(row).offpeak_cache_write_micro_per_ktok, row.currency) }}
                  </div>
                </template>
                <span v-else class="muted">不分时段（全天一个价）</span>
              </template>
            </el-table-column>
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
      <el-empty v-else-if="prices.length" description="当前筛选条件下没有单价：表里是有价的，只是被搜索、币种或「只看当前生效」滤掉了">
        <el-button @click="clearFilters">清除筛选条件</el-button>
      </el-empty>
      <el-empty v-else description="还没有任何单价：费用统计会把全部用量标成「未计价」，而不是 0 元">
        <el-button v-if="canManage" type="primary" :icon="Plus" :disabled="busy" @click="openForm()">新增第一条单价</el-button>
      </el-empty>
    </el-card>
    <el-dialog v-model="showForm" :title="selected ? '编辑单价' : '新增单价'" width="min(760px, 94vw)" destroy-on-close :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form ref="form" :model="draft" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="save">
        <div class="form-grid">
          <el-form-item label="供应商" prop="provider">
            <el-switch
              v-model="draft.basePrice"
              active-text="不限供应商（基础价）"
              aria-label="不限供应商的基础价"
              @change="toggleBasePrice"
            />
            <el-input
              v-model="draft.provider"
              :disabled="draft.basePrice"
              maxlength="128"
              :placeholder="draft.basePrice ? '不限供应商' : '例如 deepseek-official'"
              autocomplete="off"
            />
            <p class="muted">
              必须与上报值逐字一致（区分大小写）；归一化只影响展示口径，不改变这里的匹配。
              <strong>不限供应商</strong>那条是兜底价：某个供应商没有自己的价时才用它（用于同一个模型被多个网关转售的情形）。
            </p>
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
            <p class="muted">默认人民币（CNY），按别的币种结算的供应商请在这里改。币种只用来分组呈现，绝不换算、绝不相加。</p>
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
        <p class="muted">
          从某天起改用新价：把旧价的<strong>生效终点</strong>设到那天，再新增一条 —— 直接改旧价会让历史费用一起重算。
        </p>
        <el-card shadow="never" class="offpeak-card">
          <template #header>
            <div class="panel-heading">
              <div>
                <h3>闲时（低谷）价 · 可选</h3>
                <p class="muted">
                  留空 = 这条价<strong>不分时段</strong>（全天一个价）。填了时段表就必须把四类闲时单价一起填 ——
                  🚨 <strong>缺一个就会让那一档按 0 元算</strong>，而 0 元是合法单价，费用只会悄悄偏低。
                </p>
              </div>
            </div>
          </template>
          <div class="form-grid">
            <el-form-item label="闲时时段表">
              <el-select v-model="draft.offpeakSchedule" clearable placeholder="不分时段" aria-label="闲时时段表">
                <el-option v-for="schedule in SCHEDULES" :key="schedule.id" :label="schedule.label" :value="schedule.id" />
              </el-select>
              <p class="muted">{{ scheduleTip || '时段表定义在 shared/price.ts 里，全平台只有一份。' }}</p>
            </el-form-item>
            <el-form-item label="闲时四类单价">
              <el-button :disabled="busy || !draft.input.trim()" @click="fillOffpeakSame">按高峰价的一半填满</el-button>
              <p class="muted">官方空闲档通常就是高峰档的一半；这里只是省一次手算，**不作数**，请按自己的价目核对。</p>
            </el-form-item>
          </div>
          <div class="form-grid">
            <el-form-item :label="`闲时输入（${draft.currency || '货币单位'} / 百万 token）`">
              <el-input v-model="draft.offpeakInput" placeholder="例如 1" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="`闲时输出（${draft.currency || '货币单位'} / 百万 token）`">
              <el-input v-model="draft.offpeakOutput" placeholder="例如 4" autocomplete="off" />
            </el-form-item>
          </div>
          <div class="form-grid">
            <el-form-item :label="`闲时缓存读（${draft.currency || '货币单位'} / 百万 token）`">
              <el-input v-model="draft.offpeakCacheRead" placeholder="例如 0.02" autocomplete="off" />
            </el-form-item>
            <el-form-item :label="`闲时缓存写（${draft.currency || '货币单位'} / 百万 token）`">
              <el-input v-model="draft.offpeakCacheWrite" placeholder="例如 0（不单列就填 0）" autocomplete="off" />
            </el-form-item>
          </div>
        </el-card>
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
.base-price-hint { margin: 0 0 10px; }
.offpeak-card { margin: 4px 0 18px; }
.offpeak-card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
.heading-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 18px; }
</style>