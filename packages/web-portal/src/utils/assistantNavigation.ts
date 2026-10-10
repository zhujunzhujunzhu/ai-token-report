/** 助手导航只传白名单页面与结构化条件，日期快照保持查询窗口逐毫秒一致。 */
import { ASSISTANT_PAGES } from '@ai-token-report/shared'
import type { AssistantEvent } from '@ai-token-report/shared'
import { isNavigationFailure, NavigationFailureType, type Router } from 'vue-router'
import type { DashboardFilters } from '../stores/dashboard.js'
import { TIME_RANGES } from '../types/portal.js'

type NavigationEvent = Extract<AssistantEvent, { type: 'navigate' }>
const FILTER_KEYS = ['period', 'from', 'to', 'provider', 'model', 'source', 'member_id', 'group_id'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOURCES = ['dsh', 'codex', 'claude-code', 'trae', 'trae-cn', 'workbuddy']
const clean = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)

/** 页面搜索的内容只交给 Vue 文本绑定，不拼入 HTML 或外部地址。 */
export function assistantSearch(value: unknown): string {
  return clean(value, 200) ? value.trim() : ''
}
export function assistantNavigationTarget(event: NavigationEvent): { path: string; query: Record<string, string> } {
  if (!ASSISTANT_PAGES.some(page => page.path === event.path)) throw new Error('助手请求了未知页面')
  const query: Record<string, string> = {}
  if (event.filters) {
    for (const key of Object.keys(event.filters)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) throw new Error('助手导航包含未知筛选条件')
      const value = event.filters[key]
      if (!clean(value, 200)) throw new Error('助手导航筛选条件无效')
      if (value) query[key] = value
    }
    assistantDashboardFilters(query)
  }
  if (event.search !== undefined) {
    if (!clean(event.search, 200)) throw new Error('页面搜索内容过长或包含控制字符')
    query.search = event.search.trim()
  }
  return { path: event.path, query }
}

function localMinute(ms: number): string {
  const value = new Date(ms), pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}
/** 没有助手条件的普通切页保留现有筛选；有条件时清理未指定维度，避免继承冲突。 */
export function assistantDashboardFilters(query: Record<string, unknown>): DashboardFilters | undefined {
  if (!FILTER_KEYS.some(key => query[key] !== undefined)) return undefined
  const values: Record<string, string> = {}
  for (const key of FILTER_KEYS) {
    const value = query[key]
    if (value === undefined) continue
    if (!clean(value, 200) || !value) throw new Error('页面筛选条件无效')
    values[key] = value
  }
  const filters: DashboardFilters = { period: values.period ?? 'last7d', providers: values.provider ? [values.provider] : [], sources: values.source ? [values.source] : [], model: values.model ?? '', users: values.member_id ? [values.member_id] : [], groups: values.group_id ? [values.group_id] : [], customFrom: '', customTo: '' }
  if (values.member_id && !UUID.test(values.member_id) || values.group_id && !UUID.test(values.group_id)) throw new Error('人员或分组筛选 ID 无效')
  if (values.source && !SOURCES.includes(values.source)) throw new Error('来源筛选无效')
  if (values.from !== undefined || values.to !== undefined) {
    if (values.period || !values.from || !values.to || !/^\d+$/.test(values.from) || !/^\d+$/.test(values.to)) throw new Error('时间范围需要完整的起止时间，且不能同时指定周期')
    const from = Number(values.from), to = Number(values.to)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || !Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime())) throw new Error('时间范围无效')
    filters.period = 'custom'
    filters.customFrom = localMinute(from)
    filters.customTo = localMinute(to)
    filters.exactRange = { from, to, fromInput: filters.customFrom, toInput: filters.customTo }
  } else if (!TIME_RANGES.some(range => range.value === filters.period && range.value !== 'custom')) throw new Error('时间周期无效')
  return filters
}

/** 同一 SSE 事件重复抵达时不重新触发页面加载；不同条件仍能再次跳转。 */
export function createAssistantNavigator() {
  let last = ''
  return (event: NavigationEvent) => {
    const target = assistantNavigationTarget(event)
    const signature = JSON.stringify([target.path, Object.entries(target.query).sort(([a], [b]) => a.localeCompare(b))])
    if (signature === last) return undefined
    last = signature
    return target
  }
}

/** Router 的取消/中止会 resolve，守卫重定向也不会抛错，必须核对实际页面与查询。 */
export async function navigateAssistantPage(router: Router, target: ReturnType<typeof assistantNavigationTarget>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('页面跳转已取消')
  // 等异步权限守卫期间可能切会话或停止；临提交前再次检查，防止迟到导航抢走当前页面。
  const removeGuard = signal ? router.beforeResolve(to => to.path === target.path && signal.aborted ? false : undefined) : undefined
  let failure
  try { failure = await router.push(target) }
  catch { throw new Error('页面跳转失败，请重试或从导航栏打开目标页面') }
  finally { removeGuard?.() }
  if (isNavigationFailure(failure) && !isNavigationFailure(failure, NavigationFailureType.duplicated))
    throw new Error('页面跳转被取消或中止，请重试或从导航栏打开目标页面')
  const expected = router.resolve(target), actual = router.currentRoute.value
  const query = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  if (actual.path !== expected.path || query(actual.query) !== query(expected.query))
    throw new Error('未能打开目标页面或应用搜索条件，请检查登录和访问权限')
}
