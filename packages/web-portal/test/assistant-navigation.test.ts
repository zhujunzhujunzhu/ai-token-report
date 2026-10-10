/** 导航窗口与查询完全一致，非法输入不会悄悄扩大到默认范围。 */
import { expect, test } from 'bun:test'
import { createMemoryHistory, createRouter } from 'vue-router'
import { assistantDashboardFilters, assistantNavigationTarget, assistantSearch, createAssistantNavigator, navigateAssistantPage } from '../src/utils/assistantNavigation.js'
import { buildFilter } from '../src/stores/dashboard.js'
const memberId = '11111111-1111-4111-8111-111111111111'
test('绝对时间窗口保留毫秒、人员和模型，手动改日期恢复原输入语义', () => {
  const from = new Date('2026-10-01T08:00:12.123+08:00').getTime(), to = from + 12_345
  const filters = assistantDashboardFilters({ from: String(from), to: String(to), member_id: memberId, model: '模型甲', source: 'codex' })!
  expect(filters.users).toEqual([memberId])
  expect(filters.model).toBe('模型甲')
  expect(buildFilter(filters).filter.from).toBe(from)
  expect(buildFilter(filters).filter.to).toBe(to)
  const modified = { ...filters, customTo: '2026-10-02T09:10' }
  expect(buildFilter(modified).filter.to).toBe(new Date(modified.customTo).getTime() + 59_999)
})
test('周期导航清理未指定的维度，普通页面切换保留旧筛选', () => {
  expect(assistantDashboardFilters({ search: '查询' })).toBeUndefined()
  expect(assistantDashboardFilters({ period: 'month' })).toMatchObject({ period: 'month', users: [], groups: [], model: '', customFrom: '', customTo: '' })
})
test('路径、日期、来源和稳定 ID 必须通过校验', () => {
  for (const path of ['//evil.test', 'https://evil.test', '/records?model=x', '/unknown']) expect(() => assistantNavigationTarget({ type: 'navigate', path })).toThrow('未知页面')
  for (const filters of [{ from: '1' }, { from: '2', to: '1' }, { from: '1', to: '2', period: 'month' }, { period: 'custom' }, { period: 'everything' }, { member_id: '张三' }, { source: 'codx' }, { model: '\n' }, { from: '999999999999999999', to: '999999999999999999' }]) expect(() => assistantDashboardFilters(filters)).toThrow()
  expect(() => assistantNavigationTarget({ type: 'navigate', path: '/records', filters: { arbitrary: 'value' } })).toThrow('未知筛选')
})
test('管理搜索作为文本，重复导航仅应用一次，改变条件会再次导航', () => {
  const navigate = createAssistantNavigator()
  const event = { type: 'navigate' as const, path: '/projects', search: '<script>不是HTML</script>' }
  expect(navigate(event)?.query.search).toBe(event.search)
  expect(navigate(event)).toBeUndefined()
  expect(navigate({ ...event, search: '新查询' })?.query.search).toBe('新查询')
  expect(assistantSearch(['a', 'b'])).toBe('')
  expect(assistantSearch('  项目甲  ')).toBe('项目甲')
  expect(assistantSearch('a'.repeat(201))).toBe('')
})

async function navigationRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/overview', component: {} },
    { path: '/records', component: {} },
    { path: '/appkeys', component: {}, meta: { requiredPermission: 'tokens:manage' } },
  ] })
  await router.push('/overview')
  await router.isReady()
  return router
}
const appKeyTarget = () => assistantNavigationTarget({ type: 'navigate', path: '/appkeys', search: '张三 的 appKey' })

test('真实内存路由抵达授权appKey页面并应用搜索，同页同条件重复视为已到达', async () => {
  const router = await navigationRouter()
  const permissions = ['tokens:manage']
  router.beforeEach(to => typeof to.meta.requiredPermission === 'string' && !permissions.includes(to.meta.requiredPermission) ? '/overview' : undefined)
  await navigateAssistantPage(router, appKeyTarget())
  expect(router.currentRoute.value.path).toBe('/appkeys')
  expect(router.currentRoute.value.query).toEqual({ search: '张三 的 appKey' })
  await navigateAssistantPage(router, appKeyTarget())
  expect(router.currentRoute.value.query.search).toBe('张三 的 appKey')
})

test('守卫中止导航即使resolve，也明确提示而不假称到达', async () => {
  const router = await navigationRouter()
  router.beforeEach(to => to.path === '/appkeys' ? false : undefined)
  await expect(navigateAssistantPage(router, appKeyTarget())).rejects.toThrow('取消或中止')
  expect(router.currentRoute.value.path).toBe('/overview')
})

test('新导航取消尚未完成的助手导航时，明确失败并保留新页面', async () => {
  const router = await navigationRouter()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  router.beforeEach(async to => { if (to.path === '/appkeys') { entered(); await gate } })
  const outcome = navigateAssistantPage(router, appKeyTarget()).then(() => null, error => error as Error)
  await started
  await router.push('/records')
  release()
  expect((await outcome)?.message).toContain('取消或中止')
  expect(router.currentRoute.value.path).toBe('/records')
})

test('权限守卫重定向后核对目标路径，不把重定向当作助手导航成功', async () => {
  const router = await navigationRouter()
  router.beforeEach(to => to.meta.requiredPermission ? '/overview' : undefined)
  await expect(navigateAssistantPage(router, appKeyTarget())).rejects.toThrow('检查登录和访问权限')
  expect(router.currentRoute.value.path).toBe('/overview')
})

test('守卫到达同页面却去掉搜索条件时，也须明确条件未应用', async () => {
  const router = await navigationRouter()
  router.beforeEach(to => to.path === '/appkeys' && to.query.search ? { path: '/appkeys' } : undefined)
  await expect(navigateAssistantPage(router, appKeyTarget())).rejects.toThrow('应用搜索条件')
  expect(router.currentRoute.value.path).toBe('/appkeys')
  expect(router.currentRoute.value.query).toEqual({})
})
