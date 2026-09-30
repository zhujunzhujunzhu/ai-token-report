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
  fetchRecords,
  fetchSeries,
  type PortalFilter,
} from '../api/portal.js'
import {
  bucketFor,
  CUSTOM_PERIOD,
  memberFilterOptions,
  userLabel,
  type MemberFilterOption,
} from '../types/portal.js'
import { useSessionStore } from './session.js'

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
export type StatsSection = 'overview' | 'analysis' | 'records' | 'diagnostics'
export interface DashboardFilters {
  period: string
  provider: string
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
  provider: '',
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
    provider: input.provider.trim(),
    model: input.model.trim(),
    // 分组是多选 OR（见 PortalFilter.groups）：这里只做去重，不改变语义。
    groups: [...new Set(input.groups)],
  }
  if (input.period === CUSTOM_PERIOD) {
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
  /**
   * 趋势图的**分层维度**（合计 / 按用户 / 按模型）。
   *
   * ★ 放在 store 而不是某个页面里：总览与分析是同一个问题的两种看法，
   *   使用者在总览选了「按用户」，跳到分析页时不该被重置回合计。
   */
  const stackBy = ref<TrendStack>('none')
  /** 趋势图的指标（token / 元 / 调用次数），同样跨页保留。 */
  const trendMetric = ref<TrendMetric>('totalTokens')
  const breakdownBy = ref<GroupBy>('provider-model')
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
   * 使用者自建的供应商名（**只存在本机浏览器**，见 `utils/providerCatalog.ts`）。
   *
   * 🚨 绝不写上报库：供应商名是**用量行上的事实**，库里那份可编辑配置是
   *   归一化规则（`provider_alias`），属于管理面。往库里插一个「供应商」
   *   只会得到一个永远查不出数据的幽灵选项，而且没有地方能删掉它。
   */
  const customProviders = ref<string[]>(readCustomProviders())
  /**
   * 供应商下拉的候选 = 库里的目录 ∪ 使用者自建的（唯一实现见 `providerFilterOptions`）。
   *
   * ⚠️ 页面只负责渲染这一份：自己在模板里拼接会把「同名以目录为准」
   *   这条规则复制到第二个地方。
   */
  const providerChoices = computed<ProviderFilterOption[]>(() =>
    providerFilterOptions(providerOptions.value, customProviders.value),
  )
  const groupOptions = ref<StatsGroupOption[]>([])
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
  const dirty = computed(
    () =>
      !!(
        filters.value.provider ||
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

  async function load(background = false): Promise<void> {
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
    // 候选始终不带人员筛选；全员排行可复用同一请求，避免每轮重复聚合。
    const candidates = fetchBreakdown(built.filter, 'user')
    // ★ 分组候选同样不能带筛选（含分组筛选本身）：从已筛选结果里取候选，
    //   选中一个分组之后下拉会塌缩成一个选项，使用者再也加不回别的分组。
    const groupCandidates = fetchGroupOptions()
    // ★ 人员名册：下拉里「窗口内没有用量的人」唯一的来源，同样不带筛选。
    //   它只喂候选，不参与任何数字；失败也不能拖垮整页（见下面的处理）。
    const memberCandidates = fetchMemberOptions()
    // ★ 供应商目录：同样是**不带任何筛选**的完整集合（否则选中一项后下拉会塌缩）。
    //   它只喂候选，不参与任何数字；失败也不能拖垮整页。
    const providerCandidates = fetchProviderOptions()
    const [ov, opts, gopts, mo, pv, se, rank, groupRank, bd, rec, diag] =
      await Promise.all([
        fetchOverview(filter),
        // ★ 候选不能带人员筛选，否则选择一个人后再也选不到其他人。
        candidates,
        groupCandidates,
        memberCandidates,
        active === 'overview' || active === 'analysis'
          ? fetchSeries(filter, granularity.value)
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
    if (!mo.ok && mo.status === 401) {
      handleFailure(mo)
      return
    }
    if (ov.ok) overview.value = ov.data
    if (opts.ok) usageUsers.value = opts.data.rows
    // ★ 先分组目录后人员名册：人员选项的展示名要用分组 ID 翻名字，
    //   反过来的话首帧会闪一次「未知分组」。
    if (gopts.ok) groupOptions.value = gopts.data.groups ?? []
    if (mo.ok) memberDirectory.value = mo.data.members ?? []
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

  async function applyFilters(next: DashboardFilters): Promise<boolean> {
    const built = buildFilter(next)
    rangeError.value = built.error
    if (built.error) return false
    const groups = [...new Set(next.groups)]
    filters.value = {
      ...next,
      groups,
      // ★ 选了分组之后，把**分组外**的人员从筛选里去掉。
      //   服务端按 AND 叠加：留下一个不在所选分组里的人，查询必然是 0，
      //   而页面上只看到一片空数字 —— 看不出是筛选条件在打架。
      //   ⚠️ 只在名册可用时收窄。名册取不到（旧服务端 / 请求失败）时我们
      //   并不知道谁属于哪个分组，此时按原样保留 —— 不能凭一份空名册
      //   删掉使用者的选择。
      users: memberDirectory.value.length > 0
        ? pruneUsers(next.users, groups)
        : [...next.users],
    }
    page.value = 1
    await load()
    return true
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
  async function activate(value: StatsSection): Promise<void> {
    section.value = value
    await load()
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
      filters.value = initialFilters()
      page.value = 1
      breakdownBy.value = 'provider-model'
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
    overview,
    series,
    ranking,
    groupRanking,
    userOptions,
    groupOptions,
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
    setPage,
    setBreakdown,
    activate,
    deactivate,
    openUser,
    closeUser,
  }
})

