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
} from '@ai-token-report/shared'
import {
  fetchBreakdown,
  fetchDiagnostics,
  fetchOverview,
  fetchRecords,
  fetchSeries,
  type PortalFilter,
} from '../api/portal.js'
import { bucketFor, CUSTOM_PERIOD } from '../types/portal.js'
import { useSessionStore } from './session.js'

export type StatsSection = 'overview' | 'analysis' | 'records' | 'diagnostics'
export interface DashboardFilters {
  period: string
  provider: string
  model: string
  users: string[]
  customFrom: string
  customTo: string
}
export interface UserDetail {
  userId: string
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
  const userOptions = ref<BreakdownRow[]>([])
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
        filters.value.users.length
      ),
  )
  let requestSeq = 0
  let detailSeq = 0
  let pending = false
  let dataKey = ''

  function clearData(): void {
    overview.value = null
    series.value = null
    ranking.value = []
    breakdown.value = null
    diagnostics.value = null
    records.value = []
    recordTotal.value = 0
    fetchedAt.value = null
  }
  function closeUser(): void {
    ++detailSeq
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
    const [ov, opts, se, rank, bd, rec, diag] = await Promise.all([
      fetchOverview(filter),
      // ★ 候选不能带人员筛选，否则选择一个人后再也选不到其他人。
      fetchBreakdown(built.filter, 'user'),
      active === 'overview' || active === 'analysis'
        ? fetchSeries(filter, granularity.value)
        : null,
      active === 'overview' ? fetchBreakdown(filter, 'user') : null,
      active === 'analysis' ? fetchBreakdown(filter, breakdownBy.value) : null,
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
    const failures = [ov, opts, se, rank, bd, rec, diag].filter(
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
    if (se?.ok) series.value = se.data
    if (rank?.ok) ranking.value = rank.data.rows
    if (bd?.ok) breakdown.value = bd.data
    if (rec?.ok) {
      records.value = rec.data.rows
      recordTotal.value = rec.data.total
    }
    if (diag?.ok) diagnostics.value = diag.data
    fetchedAt.value = Date.now()
  }

  async function applyFilters(next: DashboardFilters): Promise<boolean> {
    const built = buildFilter(next)
    rangeError.value = built.error
    if (built.error) return false
    filters.value = { ...next, users: [...next.users] }
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

  async function openUser(userId: string): Promise<void> {
    const built = buildFilter(filters.value)
    if (!session.signedIn || built.error) return
    const seq = ++detailSeq
    const generation = session.generation
    detail.value = { userId, overview: null, series: null, models: [] }
    detailLoading.value = true
    detailError.value = null
    const filter = { ...built.filter, users: [userId] }
    const [ov, se, bd] = await Promise.all([
      fetchOverview(filter),
      fetchSeries(filter, granularity.value),
      fetchBreakdown(filter, 'provider-model'),
    ])
    if (seq !== detailSeq || generation !== session.generation) return
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
    userOptions,
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
