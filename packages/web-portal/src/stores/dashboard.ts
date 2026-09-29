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
} from '@ai-token-report/shared'
import {
  fetchBreakdown,
  fetchDiagnostics,
  fetchGroupOptions,
  fetchOverview,
  fetchRecords,
  fetchSeries,
  type PortalFilter,
} from '../api/portal.js'
import { bucketFor, CUSTOM_PERIOD, identityLabel, userLabel } from '../types/portal.js'
import { useSessionStore } from './session.js'

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
  const userOptions = ref<BreakdownRow[]>([])
  /**
   * 分组候选项，来自看板接口 `GET /api/v1/stats/groups`（`stats:read`）。
   *
   * ⚠️ 刻意不用管理接口 `/api/v1/admin/groups`：那是 `groups:read`，
   *   而看板使用者不一定有管理目录的权限。也刻意**不带筛选**，
   *   否则选中一个分组后下拉会塌缩成一项（自锁定）。
   */
  const groupOptions = ref<StatsGroupOption[]>([])
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
    const [ov, opts, gopts, se, rank, groupRank, bd, rec, diag] = await Promise.all([
      fetchOverview(filter),
      // ★ 候选不能带人员筛选，否则选择一个人后再也选不到其他人。
      candidates,
      groupCandidates,
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
    if (ov.ok) overview.value = ov.data
    if (opts.ok) userOptions.value = opts.data.rows
    if (gopts.ok) groupOptions.value = gopts.data.groups ?? []
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
    filters.value = { ...next, users: [...next.users], groups: [...next.groups] }
    page.value = 1
    await load()
    return true
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
    const label = candidate ? identityLabel(candidate) : userLabel(userId)
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
      userOptions.value = []
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
