/** 统计查询状态：共享筛选，按页面取数；任何指标都直接采用服务端结果。 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  BreakdownResponse,
  BreakdownRow,
  DiagnosticsResponse,
  GroupBy,
  OverviewResponse,
  RecordRow,
  SeriesResponse,
  StatsGroupOption,
  StatsMemberOption,
} from '@ai-token-report/shared'
import {
  fetchBreakdown,
  fetchDiagnostics,
  fetchGroupOptions,
  fetchMemberOptions,
  fetchOverview,
  fetchProviderOptions,
  fetchSourceOptions,
  fetchRecords,
  fetchSeries,
  type PortalFilter,
} from '../api/portal.js'
import {
  bucketFor,
  CUSTOM_PERIOD,
  memberFilterOptions,
  newCustomProviders,
  providerFilterOptions,
  userLabel,
  type MemberFilterOption,
  type ProviderFilterOption,
} from '../types/portal.js'
import {
  CUSTOM_PROVIDERS_LIMIT,
  readCustomProviders,
  writeCustomProviders,
} from '../utils/providerCatalog.js'
import { costSeriesOf } from '../utils/cost.js'
import { trendSeriesOf } from '../utils/trend.js'
import {
  readTrendDepth,
  writeTrendDepth,
  type TrendDepth,
} from '../utils/trendDepth.js'
import { useSessionStore } from './session.js'

export type StatsSection = 'overview' | 'analysis' | 'records' | 'diagnostics'
/**
 * 趋势图的分层维度。
 *
 * ★ `'none'` 不是「另一个维度」，而是**不展开**：此时服务端连 `stack` 字段
 *   都不下发，页面画的是原来那条合计。用 `''` / `null` 之类当哨兵会让
 *   「参数没给」与「参数给空」两种请求在日志里长得一样。
 */
export type TrendStack = 'none' | 'user' | 'model'
/** 趋势图上看哪个指标。 */
export type TrendMetric = 'totalTokens' | 'cost' | 'calls'
export interface DashboardFilters {
  period: string
  /**
   * 供应商筛选（多选 = OR）。
   *
   * ⚠️ 与 `users` / `groups` 不同，它**没有候选项约束**：服务端是子串匹配，
   *   页面允许使用者手输一个新名字（`allow-create`），所以这里的值可能
   *   完全不在任何目录里 —— 那是合法的筛选条件，不是脏数据。
   */
  providers: string[]
  /**
   * 来源筛选（多选 = OR）：`dsh` / `codex` / `claude-code` / `trae` /
   * `trae-cn` / `workbuddy`。
   *
   * 🚨 与 `providers` 的语义**刻意相反**：服务端对来源是**精确匹配**
   *   （`source = ?`），因为它是受控枚举 —— 子串匹配会让 `trae` 命中 `trae-cn`。
   *   所以值的来源只能是目录（`/api/v1/stats/sources`），**不允许自建**
   *   （与分组 / 人员同样是「有候选项约束」的维度）。
   */
  sources: string[]
  model: string
  users: string[]
  /**
   * 分组筛选（`group_id`，多选 = OR）。
   *
   * ⚠️ 与 `users` 是**两个独立维度**：人员筛的是「哪个人」，分组筛的是
   *   「归属该分组的人」，两者同时给出时服务端按 AND 叠加。
   */
  groups: string[]
  customFrom: string
  customTo: string
  /** 助手的绝对窗口绑定输入值；手工改日期后自动恢复整分钟结束边界。 */
  exactRange?: { from: number; to: number; fromInput: string; toInput: string }
}
export interface UserDetail {
  userId: string
  label?: string
  overview: OverviewResponse | null
  series: SeriesResponse | null
  models: BreakdownRow[]
}
export const PAGE_SIZE = 20
const initialFilters = (): DashboardFilters => ({
  period: 'last7d',
  providers: [],
  sources: [],
  model: '',
  users: [],
  groups: [],
  customFrom: '',
  customTo: '',
})

/** 日期输入仅转换用户明确选择的墙上时间；具名周期始终由服务端解析。 */
export function buildFilter(input: DashboardFilters): {
  filter: PortalFilter
  error: string | null
  span?: number
} {
  const filter: PortalFilter = {
    // 供应商是多选 OR：去重 + 去空，语义原样交给服务端（仍是子串匹配）。
    providers: [...new Set(input.providers.map((name) => name.trim()).filter(Boolean))],
    // ★ 来源是多选 OR（见 `PortalFilter.sources`）：**精确匹配**，所以这里
    //   只去重、不 trim 成别的值 —— 服务端按原值比，页面改一个字符就筛不到。
    sources: [...new Set(input.sources.map((name) => name.trim()).filter(Boolean))],
    model: input.model.trim(),
    // 分组是多选 OR（见 PortalFilter.groups）：这里只做去重，不改变语义。
    groups: [...new Set(input.groups)],
  }
  if (input.period === CUSTOM_PERIOD) {
    if (input.exactRange && input.customFrom === input.exactRange.fromInput && input.customTo === input.exactRange.toInput)
      return { filter: { ...filter, from: input.exactRange.from, to: input.exactRange.to }, error: null, span: input.exactRange.to - input.exactRange.from }
    const from = input.customFrom ? new Date(input.customFrom).getTime() : NaN
    const to = input.customTo ? new Date(input.customTo).getTime() : NaN
    if (!Number.isFinite(from) || !Number.isFinite(to))
      return { filter, error: '请选择开始与结束时间' }
    if (from > to) return { filter, error: '开始时间不能晚于结束时间' }
    // 结束边界包含用户选择的整分钟，避免漏掉该分钟后 59 秒的事件。
    return {
      filter: { ...filter, from, to: to + 59_999 },
      error: null,
      span: to - from,
    }
  }
  return { filter: { ...filter, period: input.period }, error: null }
}

export const useDashboardStore = defineStore('portal-dashboard', () => {
  const session = useSessionStore()
  const filters = ref(initialFilters())
  const section = ref<StatsSection | null>(null)
  const breakdownBy = ref<GroupBy>('provider-model')
  /**
   * 趋势图的**分层维度**（合计 / 按用户 / 按模型）。
   *
   * ★ 放在 store 而不是某个页面里：总览与分析是同一个问题的两种看法，
   *   使用者在总览选了「按用户」，跳到分析页时不该被重置回合计。
   */
  const stackBy = ref<TrendStack>('none')
  /**
   * 趋势图展开时**保留多少层**（前 8 / 前 20 / 全部）。
   *
   * ★ 与 `stackBy` 一样放在 store：总览与分析是同一张图的两种看法，
   *   在总览切到「全部」，跳到分析页不该又被折回前 8 名。
   * ⚠️ 初值来自**本机记忆**（`utils/trendDepth.ts`），换身份不清空 ——
   *   它是看图的习惯，与登录身份 / 数据范围无关（与自定义供应商同理）。
   */
  const trendDepth = ref<TrendDepth>(readTrendDepth())
  /** 趋势图的指标（token / 元 / 调用次数），同样跨页保留。 */
  const trendMetric = ref<TrendMetric>('totalTokens')
  const overview = ref<OverviewResponse | null>(null)
  const series = ref<SeriesResponse | null>(null)
  const ranking = ref<BreakdownRow[]>([])
  /**
   * 分组排行（`breakdown?by=group`）。
   *
   * ★ 与人员排行榜并列而不是替换它：多对多下一条用量会同时计入所属的每个分组，
   *   所以「各分组之和 > 总量」是定义；两个榜回答的是不同问题。
   */
  const groupRanking = ref<BreakdownRow[]>([])
  /**
   * 人员**名册**（`GET /api/v1/stats/members`，`stats:read`）。
   *
   * ★ 它是「窗口内没有用量的人」唯一的来源：只从用量行里取候选时，
   *   选中分组之后人员下拉会整个空掉（见协议里的注释）。
   * ⚠️ 刻意**不带任何筛选**：候选必须是完整名册，否则选中一项后
   *   下拉会塌缩（自锁定）。按分组收窄是页面用 `group_ids` 自己做的展示过滤，
   *   与查询无关 —— 它不参与任何数值计算。
   */
  const memberDirectory = ref<StatsMemberOption[]>([])
  /**
   * 用量派生的人员候选（`breakdown?by=user`，**不含人员筛选**）。
   *
   * ⚠️ 它仍然是「未署名 / 待确认历史」唯一的来源：那两种归属状态在人员
   *   目录里根本表达不出来（见 `docs/数据库重设计-接口与验收.md`）。
   */
  const usageUsers = ref<BreakdownRow[]>([])
  /**
   * 分组候选项，来自看板接口 `GET /api/v1/stats/groups`（`stats:read`）。
   *
   * ⚠️ 刻意不用管理接口 `/api/v1/admin/groups`：那是 `groups:read`，
   *   而看板使用者不一定有管理目录的权限。也刻意**不带筛选**，
   *   否则选中一个分组后下拉会塌缩成一项（自锁定）。
   */
  const groupOptions = ref<StatsGroupOption[]>([])
  /**
   * 供应商目录（`GET /api/v1/stats/providers`，`stats:read`）。
   *
   * ★ 名字已经是**归一化后**的展示名 —— 它就是筛选时该用的名字（同一份映射）。
   * ⚠️ 与分组 / 人员候选同样**不带筛选**：候选必须始终是完整集合，
   *   否则选中一个供应商之后下拉会塌缩成一项（自锁定）。
   * ⚠️ 它是**候选来源**，不是数字来源：请求失败不能拖垮看板（见 `load()`），
   *   回落成「只有使用者自建的项 + 现敲现用」。
   */
  const providerOptions = ref<string[]>([])
  /**
   * 归一化规则里配的**归一化名**（同一条响应的 `aliases`，`stats:read`）。
   *
   * ★ 与 `providerOptions` 的差别是**来源**而不是形状：那一份来自用量
   *   （数据里出现过的原值经映射后的展示名），这一份来自**配置**
   *   （`provider_alias`，按查看者解析）。只从用量取候选时，一条规则配好了、
   *   对应原值却还没有用量时，那个规范化名字**根本不会出现在下拉里** ——
   *   而它正是使用者在 `/providers` 页配出来、想在看板上筛的那个名字。
   * ⚠️ 它**可能没有任何用量指向**（选中即 0 行 —— 那是如实的答案，与来源候选里
   *   「本机还没跑过 Codex」同一件事），所以下拉里必须单独成组、不能与数据
   *   派生的那一档混在一起。
   * ⚠️ **老服务端没有这个字段**（`undefined`）：按空数组处理，退化成本次改动
   *   之前的行为，绝不因为它缺席把下拉打成空的。
   */
  const providerAliasOptions = ref<string[]>([])
  /**
   * 来源目录（`GET /api/v1/stats/sources`，`stats:read`）。
   *
   * ★ 它带回「本进程注册的全部来源 ∪ 库里出现过的值」：所以本机还没跑过
   *   Codex 时，下拉里也有 Codex（选中即 0 行 —— 那是如实的答案）。
   * ⚠️ 与供应商目录同样是**候选来源**、不是数字来源：请求失败不能拖垮看板，
   *   回落成「没有候选」——此时筛选栏里那一项不出现（而不是画一个空下拉）。
   */
  const sourceOptions = ref<string[]>([])
  /**
   * 使用者自建的供应商名（**只存在本机浏览器**，见 `utils/providerCatalog.ts`）。
   *
   * 🚨 绝不写上报库：供应商名是**用量行上的事实**，库里那份可编辑配置是
   *   归一化规则（`provider_alias`），属于管理面。往库里插一个「供应商」
   *   只会得到一个永远查不出数据的幽灵选项，而且没有地方能删掉它。
   */
  const customProviders = ref<string[]>(readCustomProviders())
  /**
   * 供应商下拉的候选 = 数据里的目录 ∪ 归一化规则里的名字 ∪ 使用者自建的
   * （唯一实现见 `providerFilterOptions`）。
   *
   * ⚠️ 页面只负责渲染这一份：自己在模板里拼接会把「同名以靠前的为准」
   *   这条规则复制到第二个地方。
   */
  const providerChoices = computed<ProviderFilterOption[]>(() =>
    providerFilterOptions(
      providerOptions.value,
      providerAliasOptions.value,
      customProviders.value,
    ),
  )
  /**
   * 人员下拉的选项 = 名册 ∪ 用量派生键，再按所选分组收窄。
   *
   * ★ 联动规则只有这一处实现（`memberFilterOptions`）：未选分组 = 全部人员；
   *   选中分组 = 只列该分组的成员。页面只负责渲染，不自己再筛一遍。
   */
  const userOptions = computed<MemberFilterOption[]>(() =>
    memberFilterOptions(
      memberDirectory.value,
      usageUsers.value,
      filters.value.groups,
      groupOptions.value,
    ),
  )
  const breakdown = ref<BreakdownResponse | null>(null)
  const diagnostics = ref<DiagnosticsResponse | null>(null)
  const records = ref<RecordRow[]>([])
  const recordTotal = ref(0)
  const page = ref(1)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const rangeError = ref<string | null>(null)
  const fetchedAt = ref<number | null>(null)
  const detail = ref<UserDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref<string | null>(null)
  const granularity = computed(() =>
    bucketFor(filters.value.period, buildFilter(filters.value).span),
  )
  /**
   * 服务端请求用的 `stack` 参数：`'none'` → **不传**。
   *
   * ★ 传空串或 `all` 会让服务端多一条「未知取值」的分支，而它在日志里
   *   与「没传」长得一模一样 —— 这一层刻意只做「有没有」的翻译。
   */
  const trendStackParam = computed<'user' | 'model' | undefined>(() =>
    stackBy.value === 'none' ? undefined : stackBy.value,
  )
  /**
   * 服务端请求用的 `stack_top`：不展开时**不传**。
   *
   * ★ 数值与线上取值逐字对应（`'8'` / `'20'` / `'all'`），页面不做任何翻译：
   *   中间加一次转换，早晚会出现「选了全部却发了 8」而两边都不报错。
   */
  const trendDepthParam = computed<TrendDepth | undefined>(() =>
    stackBy.value === 'none' ? undefined : trendDepth.value,
  )
  /**
   * 趋势点上的金额序列（`utils/cost.ts` 的唯一实现）。
   *
   * ★ `null` = 整段连 `cost` 字段都没有（没有 `cost:read`）：此时页面上
   *   连金额这个指标选项都不该出现。非空但带 `disabledReason` = 多币种 /
   *   一条价都没配 —— 指标**在，但点不动**，并说明原因。
   */
  const costSeries = computed(() => costSeriesOf(series.value?.points ?? []))
  /**
   * 分层载荷里是否**逐层**带了金额（金额口径的可用性，不是数值是否为 0）。
   *
   * ★ 缺这一列的原因只有两个：没有 `cost:read`，或区间内不止一种币种 ——
   *   两者都绝不允许页面自己挑一个币种去画。
   */
  const stackCostAvailable = computed(() => {
    const items = series.value?.stack?.items ?? []
    return items.length > 0 && items.every((item) => item.cost)
  })
  /**
   * 实际生效的指标。
   *
   * 🚨 三种情况必须**自动退回 token**，否则页面会画出一张假图：
   *   - 指标是金额但整个字段缺席（无 `cost:read`）；
   *   - 金额不可用（多币种 / 一条价都没配）；
   *   - 展开成按用户 / 按模型，而分层载荷里**没有**金额那一列。
   * 数据刷新（例如从单币种变成多币种）时使用者可能正停在金额上，所以这必须
   * 是 computed 而不是切换时判一次。
   */
  const activeMetric = computed<TrendMetric>(() => {
    if (trendMetric.value !== 'cost') return trendMetric.value
    if (!costSeries.value || costSeries.value.disabledReason) return 'totalTokens'
    if (stackBy.value !== 'none' && !stackCostAvailable.value) return 'totalTokens'
    return 'cost'
  })
  /** 图上的分层序列；空数组 = 单序列（含金额整块缺席的回落）。 */
  const trendSeries = computed(() =>
    stackBy.value === 'none' ? [] : trendSeriesOf(series.value?.stack, activeMetric.value),
  )
  /**
   * 选了「按用户 / 按模型」，但这次响应里**根本没有** `stack` 字段。
   *
   * ★ 这是旧版服务端的形状。它必须被说出来：静默画一条合计线会让使用者
   *   以为自己看到的就是「按用户展开」，而图上没有任何迹象说明它没展开。
   * ⚠️ 判据是**字段在不在**，不是「items 空不空」：窗口里确实没有用量时
   *   `stack` 仍然在（只是 `items` 为空），那种情况该显示的是空态而不是这条告警。
   */
  const stackUnavailable = computed(
    () => stackBy.value !== 'none' && series.value !== null && !series.value.stack,
  )
  /** 被合并进「其余」的层数；`0` = 没有截断。只喂 `stackDepthNote`（页面不直接读它）。 */
  const stackMergedCount = computed(() =>
    stackBy.value === 'none' ? 0 : (series.value?.stack?.mergedCount ?? 0),
  )
  /**
   * 分层被截断时拼在图表标题里的那句说明（没有截断就是空串）。
   *
   * ★ 只有一个实现：总览与分析是同一张图，两边各拼一次早晚会出现
   *   「一边说前 8 名、另一边说全部」。层数取**请求时选的那个**，
   *   而不是写死 8 —— 使用者选了「全部」却仍被服务端折掉尾巴时（层数超过
   *   服务端上限、或对面还是旧版本），这句话必须如实说「其余 N 个合并」，
   *   否则图上那一层就成了没人解释的东西。
   * ⚠️ 这里不重算任何数值，只描述**服务端已经做过的那次截断**（`mergedCount`）。
   */
  const stackDepthNote = computed(() => {
    if (stackBy.value === 'none') return ''
    const merged = stackMergedCount.value
    if (merged <= 0) return ''
    // 只有「要了全部却还是被折掉」才需要在这里说明 —— 层数超过服务端上限
    // （`SERIES_STACK_MAX_TOP`）或对面还是旧版本时都会走到这里。
    if (trendDepth.value === 'all')
      return `（其余 ${merged} ${stackBy.value === 'user' ? '人' : '个模型'}合并显示）`
    return `（按用量取前 ${trendDepth.value} 名，其余合并）`
  })
  const dirty = computed(
    () =>
      !!(
        filters.value.providers.length ||
        filters.value.model ||
        filters.value.users.length ||
        filters.value.groups.length
      ),
  )
  let requestSeq = 0
  let detailSeq = 0
  let pending = false
  let detailPending = false
  let dataKey = ''
  /**
   * 四份纯目录（分组 / 人册 / 供应商 / 来源）是否**已经取到过**。
   *
   * ⚠️ 只有四份**全部成功**才置真：后端还是老版本（404）或某一次失败时保持假，
   *   下一次前台 `load()` 会重试 —— 否则下拉会永久空着，而页面上看不出原因。
   * ⚠️ 退出 / 换身份时必须归假（见 `watch(session.generation)`）：新身份的
   *   数据范围与可见人员都变了，沿用旧目录会拿旧名册去收窄新筛选。
   */
  let catalogsLoaded = false

  function clearData(): void {
    overview.value = null
    series.value = null
    ranking.value = []
    groupRanking.value = []
    breakdown.value = null
    diagnostics.value = null
    records.value = []
    recordTotal.value = 0
    fetchedAt.value = null
  }
  function closeUser(): void {
    ++detailSeq
    detailPending = false
    detail.value = null
    detailLoading.value = false
    detailError.value = null
  }
  function handleFailure(result: { status: number; error: string }): void {
    if (result.status === 401) session.expire('登录已失效，请重新登录')
    else
      error.value =
        result.status === 503 ? `服务端暂未就绪：${result.error}` : result.error
  }

  /**
   * `refreshCatalogs`：**显式刷新**（「刷新数据」按钮）才重取四份纯目录。
   *
   * ★ 为什么需要这个开关：那四份目录（分组 / 人员名册 / 供应商 / 来源）只在
   *   管理员改配置时才变，而 `load()` 是**所有**交互的收敛点（切换区块 / 改筛选 /
   *   翻页都会调它），一次 12 个请求里有 4 个是重复取同一份内容 —— 线上实测这四类
   *   占全部请求 37%、每个平均 0.82–0.92 秒，且每个都要付一遍服务端闸门。
   *   现在：**首帧取一次**（或没取到过时重试），之后改筛选 / 切区块直接复用；
   *   只有点「刷新数据」才强制重取。
   *   ⚠️ 后台轮询（5 秒定时器 / 回到标签页）永远不取 —— 见下面的 `skipCatalogs`。
   */
  async function load(background = false, refreshCatalogs = false): Promise<void> {
    if (!session.signedIn || !section.value) return
    if (
      background &&
      (pending || (typeof document !== 'undefined' && document.hidden))
    )
      return
    const seq = ++requestSeq
    const built = buildFilter(filters.value)
    rangeError.value = built.error
    if (built.error) {
      pending = false
      loading.value = false
      return
    }
    const key = JSON.stringify([
      filters.value,
      section.value,
      breakdownBy.value,
      // ★ 分层维度必须进 key：切换「合计 / 按用户」时合计值往往**一模一样**，
      //   不进 key 就会沿用上一份载荷，于是「点了切换但图和表都没变」。
      stackBy.value,
      // ★ 层数同理：切到「全部」时**合计值一模一样**，只有分层多寡变了 ——
      //   不进 key 就会沿用上一份「前 8 名 + 其余」的载荷。
      trendDepth.value,
      trendMetric.value,
      page.value,
    ])
    if (key !== dataKey) {
      clearData()
      closeUser()
      dataKey = key
    }
    const active = section.value
    const generation = session.generation
    const filter = { ...built.filter, users: [...filters.value.users] }
    pending = true
    if (!background) loading.value = true
    error.value = null
    /**
     * ★ **纯目录只在「没取到过」或「显式刷新」时取**（后台轮询永远不取）。
     *
     * 它们是四个下拉的候选项（分组 / 人员名册 / 供应商 / 来源），只在管理员改配置时
     * 才会变，而统计页是**每 5 秒**轮询一次整页（`StatsLayout.vue` 的 `setInterval`）、
     * 每次切换区块 / 改筛选 / 翻页也都会走 `load()`。线上实测（2026-10-07，
     * 2 天 20.7 万请求）：这四类合计 **7.6 万次（37%）**，每个平均 **0.82–0.92 秒**，
     * 而且每个请求都要在服务端付一遍版本闸门的固定开销 —— 却几乎总是同一份内容。
     *
     * 人员排行仍按当前筛选刷新；名册可用时不再为了候选单独聚合全年用量。
     * ⚠️ 只有四份目录**全部成功**才算「取到过」：否则后端还是老版本（404）时
     *   就再也不会重试，下拉会永久空着。
     */
    const skipCatalogs = !refreshCatalogs && (background || catalogsLoaded)
    // ★ 分组候选同样不能带筛选（含分组筛选本身）：从已筛选结果里取候选，
    //   选中一个分组之后下拉会塌缩成一个选项，使用者再也加不回别的分组。
    const groupCandidates = skipCatalogs ? null : fetchGroupOptions()
    // ★ 人员名册：下拉里「窗口内没有用量的人」唯一的来源，同样不带筛选。
    //   它只喂候选，不参与任何数字；失败也不能拖垮整页（见下面的处理）。
    const memberCandidates = skipCatalogs ? null : fetchMemberOptions()
    // ★ 供应商目录：同样是**不带任何筛选**的完整集合（否则选中一项后下拉会塌缩）。
    //   它只喂候选，不参与任何数字；失败也不能拖垮整页。
    const providerCandidates = skipCatalogs ? null : fetchProviderOptions()
    // ★ 来源目录：同样是**不带任何筛选**的完整集合（受控枚举 ∪ 库里出现过的值）。
    //   只喂候选，不参与任何数字；失败也不能拖垮整页。
    const sourceCandidates = skipCatalogs ? null : fetchSourceOptions()
    // ★ 只有页面实际展示全员排行时才取这份数字；其它页面优先使用名册。
    // 已取得的历史归属候选保留，名册失败或旧部署返回空名册时才回落聚合。
    const needsAllUsers = !filter.users.length &&
      (active === 'overview' || (active === 'analysis' && breakdownBy.value === 'user'))
    const candidates = needsAllUsers
      ? fetchBreakdown(built.filter, 'user')
      : (async () => {
          const directory = memberCandidates ? await memberCandidates : null
          if (directory && !directory.ok && directory.status === 401) return null
          const available = directory?.ok
            ? directory.data.members.length > 0
            : memberDirectory.value.length > 0
          return available ? null : fetchBreakdown(built.filter, 'user')
        })()
    const [ov, opts, gopts, mo, pv, sv, se, rank, groupRank, bd, rec, diag] =
      await Promise.all([
        fetchOverview(filter),
        // ★ 候选不能带人员筛选，否则选择一个人后再也选不到其他人。
        candidates,
        groupCandidates,
        memberCandidates,
        providerCandidates,
        sourceCandidates,
        active === 'overview' || active === 'analysis'
          ? fetchSeries(
              filter,
              granularity.value,
              trendStackParam.value,
              trendDepthParam.value,
            )
          : null,
        active === 'overview'
          ? filter.users.length ? fetchBreakdown(filter, 'user') : candidates
          : null,
        // ★ 分组排行按**当前筛选**取（含分组筛选本身）：「只看这两个分组时各占多少」
        //   正是使用者下一步要问的问题。数值全部来自服务端，前端不做任何换算。
        active === 'overview' ? fetchBreakdown(filter, 'group') : null,
        active === 'analysis'
          ? breakdownBy.value === 'user' && !filter.users.length
            ? candidates
            : fetchBreakdown(filter, breakdownBy.value)
          : null,
        active === 'records'
          ? fetchRecords(filter, {
              limit: PAGE_SIZE,
              offset: (page.value - 1) * PAGE_SIZE,
            })
          : null,
        active === 'diagnostics' ? fetchDiagnostics(filter) : null,
      ])
    if (seq !== requestSeq || generation !== session.generation) return
    pending = false
    loading.value = false
    const failures = [ov, opts, gopts, se, rank, groupRank, bd, rec, diag].filter(
      (r) => r && !r.ok,
    )
    const failure =
      failures.find((r) => r && !r.ok && r.status === 401) ?? failures[0]
    if (failure && !failure.ok) {
      handleFailure(failure)
      return
    }
    // ★ 人员名册刻意**不并进 failures**：它是候选来源，不是数字来源。
    //   旧版服务端还没有这个接口（404），却要为它把整个看板变成一片错误提示，
    //   那是拿一个下拉的可用性去换所有数字的可读性。回落行为就是以前的样子：
    //   下拉只列用量里出现过的人（`canNarrow` 为假时不做任何收窄）。
    //   ⚠️ 但 401 与数据无关，仍然必须让会话过期 —— 否则页面会一直转圈。
    //   ★ 后台轮询跳过目录时它们是 `null`：跳过不等于失败，什么都不做才是对的。
    if (mo && !mo.ok && mo.status === 401) {
      handleFailure(mo)
      return
    }
    // ★ 供应商目录同款：它只是下拉的候选，失败时回落成「使用者自建的 + 现敲现用」，
    //   绝不因为一个下拉把整页数字变成错误提示。
    //   ⚠️ 401 同样必须让会话过期（同 `/api/v1/stats/members`）。
    if (pv && !pv.ok && pv.status === 401) {
      handleFailure(pv)
      return
    }
    // ★ 来源目录同款：候选失败只影响那个下拉，不影响任何数字。
    //   ⚠️ 401 仍要让会话过期。
    if (sv && !sv.ok && sv.status === 401) {
      handleFailure(sv)
      return
    }
    if (ov.ok) overview.value = ov.data
    if (opts?.ok) usageUsers.value = opts.data.rows
    // ★ 先分组目录后人员名册：人员选项的展示名要用分组 ID 翻名字，
    //   反过来的话首帧会闪一次「未知分组」。
    if (gopts?.ok) groupOptions.value = gopts.data.groups ?? []
    if (mo?.ok) memberDirectory.value = mo.data.members ?? []
    if (pv?.ok) {
      providerOptions.value = pv.data.providers ?? []
      // ★ 归一化规则里的名字：缺字段 = **老服务端**（那时只有数据派生的候选），
      //   按空数组处理 —— 退化成本次改动之前的行为，而不是让下拉空掉。
      providerAliasOptions.value = pv.data.aliases ?? []
    }
    if (sv?.ok) sourceOptions.value = sv.data.sources ?? []
    // ★ 四份都到了才记「取到过」：任何一份失败都保持假，下一次前台 load() 重试
    //   （旧后端 404、或一次网络抖动，都不该让那个下拉永久空着）。
    if (gopts?.ok && mo?.ok && pv?.ok && sv?.ok) catalogsLoaded = true
    if (se?.ok) series.value = se.data
    if (rank?.ok) ranking.value = rank.data.rows
    if (groupRank?.ok) groupRanking.value = groupRank.data.rows
    if (bd?.ok) breakdown.value = bd.data
    if (rec?.ok) {
      records.value = rec.data.rows
      recordTotal.value = rec.data.total
    }
    if (diag?.ok) diagnostics.value = diag.data
    fetchedAt.value = Date.now()
    // 抽屉继续继承同一筛选窗口，不能停留在第一次打开时的旧快照。
    if (detail.value) await openUser(detail.value.userId, true)
  }

  async function applyFilters(next: DashboardFilters, preserveRequestedUsers = false): Promise<boolean> {
    const built = buildFilter(next)
    rangeError.value = built.error
    if (built.error) return false
    const groups = [...new Set(next.groups)]
    filters.value = {
      ...next,
      groups,
      // 🚨 只看自己的身份**永远不带人员筛选**：服务端一律把它收窄成本人，
      //   所以这里留着一个「别人」的键只会在下一轮查询里变成 403（见
      //   `stats-route.ts` 的 `applyDataScope()`）。人员下拉本来就没画
      //   （`FilterBar.vue`），这里是第二道：从别处（旧链接 / 残留状态）
      //   塞进来的键同样清掉。
      users: session.scopedToSelf
        ? []
        : // ★ 选了分组之后，把**分组外**的人员从筛选里去掉。
          //   服务端按 AND 叠加：留下一个不在所选分组里的人，查询必然是 0，
          //   而页面上只看到一片空数字 —— 看不出是筛选条件在打架。
          //   ⚠️ 只在名册可用时收窄。名册取不到（旧服务端 / 请求失败）时我们
          //   并不知道谁属于哪个分组，此时按原样保留 —— 不能凭一份空名册
          //   删掉使用者的选择。
          !preserveRequestedUsers && memberDirectory.value.length > 0
          ? pruneUsers(next.users, groups)
          : [...next.users],
    }
    // ★ 手输出来的供应商名记进本机目录（下次打开下拉直接可选）。
    //   在这里而不是在组件的 change 回调里：`applyFilters` 是**所有**筛选
    //   入口的收敛点（按钮 / 回车 / 其它调用方），只挂在组件上早晚会漏一条。
    rememberProviders(next.providers)
    page.value = 1
    await load()
    return true
  }
  /**
   * 把「手输出来的」供应商名记进本机目录，并写回 `localStorage`。
   *
   * 🚨 **不写数据库**（理由见 `utils/providerCatalog.ts` 的文件头）：
   *   供应商名是用量行上的事实，库里那份可编辑配置是归一化规则。
   * ⚠️ 记满了（{@link CUSTOM_PROVIDERS_LIMIT}）就**不再记新的**，但**不改动**
   *   使用者的选择：筛选照旧生效，只是这个名字下次不在候选里。
   *   悄悄丢掉他刚选的筛选项是绝对不能做的。
   */
  function rememberProviders(selected: readonly string[]): void {
    const added = newCustomProviders(
      selected,
      providerOptions.value,
      providerAliasOptions.value,
      customProviders.value,
    )
    if (added.length === 0) return
    customProviders.value = [...customProviders.value, ...added].slice(
      0,
      CUSTOM_PROVIDERS_LIMIT,
    )
    writeCustomProviders(customProviders.value)
  }
  /**
   * 清掉本机记下的自定义供应商名（已选中的筛选值**照旧生效**）。
   *
   * ★ 这是「记错了 / 不想再看到它」唯一的出口：没有它，下拉里会永久留着
   *   一个再也不会用到的名字，而页面不提供任何删除方式。
   */
  function clearCustomProviders(): void {
    customProviders.value = []
    writeCustomProviders([])
  }
  /**
   * 去掉在当前分组下选不到的归属键（分组外的成员、以及不属于任何分组的
   * 未署名 / 待确认历史）。
   *
   * ⚠️ 判据必须与下拉**共用** `memberFilterOptions`：各写一份过滤逻辑，
   *   早晚会出现「下拉里看不到、筛选里还留着」的幽灵条件。
   */
  function pruneUsers(users: readonly string[], groups: readonly string[]): string[] {
    const visible = new Set(
      memberFilterOptions(
        memberDirectory.value,
        usageUsers.value,
        groups,
        groupOptions.value,
      ).map((option) => option.key),
    )
    return users.filter((key) => visible.has(key))
  }
  async function setPage(value: number): Promise<void> {
    page.value = Math.min(
      Math.max(1, value),
      Math.max(1, Math.ceil(recordTotal.value / PAGE_SIZE)),
    )
    await load()
  }
  async function setBreakdown(value: GroupBy): Promise<void> {
    breakdownBy.value = value
    await load()
  }
  /**
   * 切换趋势的分层维度。
   *
   * ⚠️ 切回「合计」也要重新取数：载荷里 `stack` 的**有无**本身就是状态，
   *   沿用上一份会让图上留着上一次的堆叠层。
   */
  async function setStack(value: TrendStack): Promise<void> {
    if (stackBy.value === value) return
    stackBy.value = value
    await load()
  }
  /**
   * 切换「保留多少层」（前 8 / 前 20 / 全部）。
   *
   * ★ 必须重新取数：截断发生在**服务端**（`stack_top`），前 8 名那趟响应里
   *   根本没有第 9 名以后的数据 —— 在页面上把「其余」拆开是不可能的。
   * ⚠️ 选择要写回本机记忆：它是看图的习惯，下次打开还该是它。
   */
  async function setTrendDepth(value: TrendDepth): Promise<void> {
    if (trendDepth.value === value) return
    trendDepth.value = value
    writeTrendDepth(value)
    await load()
  }
  /**
   * 切换趋势指标。
   *
   * ★ 不用重新取数：三种指标的值都在同一份 `series` 载荷里
   *   （金额在 `points[].cost`、分层金额在 `stack.items[].cost`）——
   *   再发一次请求只会让切换变慢，还会多一次可能失败的往返。
   */
  function setTrendMetric(value: TrendMetric): void {
    trendMetric.value = value
  }
  async function activate(value: StatsSection, next?: DashboardFilters): Promise<void> {
    section.value = value
    // 助手带来的显式人员/分组是查询条件；冲突交给服务端，不能删掉人员扩大范围。
    if (next) await applyFilters(next, true)
    else await load()
  }
  function deactivate(): void {
    section.value = null
    ++requestSeq
    pending = false
    loading.value = false
    closeUser()
  }

  async function openUser(userId: string, background = false): Promise<void> {
    const built = buildFilter(filters.value)
    if (!session.signedIn || built.error) return
    if (background && detailPending) return
    const seq = ++detailSeq
    const generation = session.generation
    const candidate = userOptions.value.find((row) => row.key === userId)
    // 下拉里翻不到（例如名册接口失败、或这个键已不在当前分组下）时保留原始
    // 归属键：宁可让人看见一个 UUID，也不要把抽屉标题显示成空白。
    const label = candidate?.label ?? userLabel(userId)
    // 后台刷新保留已展示的数据，避免每五秒闪回骨架屏。
    if (!background) {
      detail.value = { userId, label, overview: null, series: null, models: [] }
      detailLoading.value = true
    }
    detailPending = true
    detailError.value = null
    const filter = { ...built.filter, users: [userId] }
    const [ov, se, bd] = await Promise.all([
      fetchOverview(filter),
      fetchSeries(filter, granularity.value),
      fetchBreakdown(filter, 'provider-model'),
    ])
    if (seq !== detailSeq || generation !== session.generation) return
    detailPending = false
    detailLoading.value = false
    for (const result of [ov, se, bd]) {
      if (!result.ok) {
        if (result.status === 401) handleFailure(result)
        else detailError.value = result.error
        return
      }
    }
    if (ov.ok && se.ok && bd.ok)
      detail.value = {
        userId,
        label,
        overview: ov.data,
        series: se.data,
        models: bd.data.rows,
      }
  }

  watch(
    () => session.generation,
    () => {
      ++requestSeq
      closeUser()
      pending = false
      loading.value = false
      clearData()
      usageUsers.value = []
      memberDirectory.value = []
      groupOptions.value = []
      providerOptions.value = []
      providerAliasOptions.value = []
      sourceOptions.value = []
      // ★ 换身份 / 重新登录后名字与数据范围都变了，目录必须重取一次
      //   （否则会拿上一身份的名册去收窄这一身份的筛选）。
      catalogsLoaded = false
      // ⚠️ 自定义供应商**刻意不清**：它是「这台机器上的使用习惯」，
      //   与登录身份 / 数据范围无关（退出登录后重进，候选应该还在）。
      // ⚠️ 趋势图的层数（`trendDepth`）同理**刻意不清**：它是看图的习惯，
      //   不是任何人的数据；退出登录后重进还该是「全部」。
      filters.value = initialFilters()
      page.value = 1
      breakdownBy.value = 'provider-model'
      stackBy.value = 'none'
      trendMetric.value = 'totalTokens'
      error.value = null
      rangeError.value = null
      dataKey = ''
    },
    { flush: 'sync' },
  )

  return {
    filters,
    section,
    breakdownBy,
    stackBy,
    trendDepth,
    trendMetric,
    activeMetric,
    costSeries,
    trendSeries,
    stackDepthNote,
    stackUnavailable,
    overview,
    series,
    ranking,
    groupRanking,
    userOptions,
    groupOptions,
    providerOptions,
    providerAliasOptions,
    providerChoices,
    sourceOptions,
    customProviders,
    breakdown,
    diagnostics,
    records,
    recordTotal,
    page,
    loading,
    error,
    rangeError,
    fetchedAt,
    detail,
    detailLoading,
    detailError,
    granularity,
    dirty,
    load,
    applyFilters,
    clearCustomProviders,
    setPage,
    setBreakdown,
    setStack,
    setTrendDepth,
    setTrendMetric,
    activate,
    deactivate,
    openUser,
    closeUser,
  }
})
