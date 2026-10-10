/** 表单交付必须覆盖路由与挂载竞态，且打开、重复事件与取消都不能暗中保存。 */
import { expect, test } from 'bun:test'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AssistantForm } from '@ai-token-report/shared'
import { assistantFormTarget, assistantFormEntry, assistantMemberPrefill, assistantMemberDraft, assistantPricingPrefill, assistantPriceTime, assertAssistantFormIdentity, createAssistantFormBroker, createAssistantFormConsumer, waitForAssistantFormReady } from '../src/utils/assistantForms.js'
import { navigateAssistantPage } from '../src/utils/assistantNavigation.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const form = (request_id = 'request-1', values: AssistantForm['values'] = {}): AssistantForm => ({ request_id, resource: 'provider-aliases', operation: 'create', path: '/providers', values })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve() }
async function routerFixture() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/overview', component: {} }, { path: '/providers', component: {} }] })
  await router.push('/overview'); await router.isReady(); return router
}

test('预填值只交给内存，地址不含姓名、目录、别名或单价', () => {
  expect(assistantFormTarget(form('private', { alias: '内部供应商', provider: 'dashscope' }))).toEqual({ path: '/providers', query: {} })
  for (const invalid of [form('x', { permissions: ['members:manage'] }), { ...form(), path: '/providers?alias=secret' }, { ...form(), resource: 'roles' }, { ...form(), operation: 'update' }, { ...form(), operation: 'create', target_id: targetId }, form('x', { provider: '<script>\n' })]) expect(() => assistantFormTarget(invalid as AssistantForm)).toThrow()
})

test('跨页先等待路由确认与页面挂载，重复事件只交付一次且不保存', async () => {
  const router = await routerFixture(), broker = createAssistantFormBroker(), gate = deferred()
  let opens = 0, saves = 0
  router.beforeEach(async to => { if (to.path === '/providers') await gate.promise })
  const request = form('cross-page', { provider: 'dashscope', alias: '阿里百炼' })
  const opening = broker.request(request, target => navigateAssistantPage(router, target))
  const duplicate = broker.request(request, target => navigateAssistantPage(router, target))
  expect(duplicate).toBe(opening)
  const unsubscribe = broker.subscribe('provider-aliases', actual => { opens++; expect(actual.values).toEqual(request.values) })
  await flush(); expect(opens).toBe(0); expect(router.currentRoute.value.path).toBe('/overview')
  gate.resolve(); await opening
  expect(router.currentRoute.value.fullPath).toBe('/providers'); expect(opens).toBe(1); expect(saves).toBe(0)
  unsubscribe()
  const again = broker.subscribe('provider-aliases', () => { opens++ })
  await broker.request(request, target => navigateAssistantPage(router, target))
  expect(opens).toBe(1); again()
})

test('导航完成后才挂载页面也能消费；同页独立请求不被路由去重吞掉', async () => {
  const router = await routerFixture(), broker = createAssistantFormBroker(), seen: string[] = [], navigated = deferred()
  const first = broker.request(form('late-mount'), async target => { await navigateAssistantPage(router, target); navigated.resolve() })
  await navigated.promise; expect(router.currentRoute.value.path).toBe('/providers')
  const unsubscribe = broker.subscribe('provider-aliases', request => { seen.push(request.request_id) })
  await first; await broker.request(form('same-page'), target => navigateAssistantPage(router, target))
  expect(seen).toEqual(['late-mount', 'same-page']); unsubscribe()
})

test('路由守卫重定向的请求被移除，日后再进入目标页面不会重放', async () => {
  const router = await routerFixture(), broker = createAssistantFormBroker()
  router.beforeEach(to => to.path === '/providers' ? '/overview' : undefined)
  await expect(broker.request(form('forbidden'), target => navigateAssistantPage(router, target))).rejects.toThrow('检查登录和访问权限')
  let opens = 0; const unsubscribe = broker.subscribe('provider-aliases', () => { opens++ })
  await flush(); expect(opens).toBe(0); unsubscribe()
})

test('取消导航前的待交付请求，不会迟到打开或跳页', async () => {
  const broker = createAssistantFormBroker(), controller = new AbortController()
  let navigations = 0, opens = 0
  const unsubscribe = broker.subscribe('provider-aliases', () => { opens++ })
  const opening = broker.request(form('cancelled'), async () => { navigations++ }, controller.signal)
  controller.abort(); await expect(opening).rejects.toThrow('已取消'); await flush()
  expect(navigations).toBe(0); expect(opens).toBe(0); unsubscribe()
})

test('已经开始等待异步路由守卫时取消，也不会迟到切页或打开表单', async () => {
  const router = await routerFixture(), broker = createAssistantFormBroker(), controller = new AbortController(), entered = deferred(), gate = deferred()
  router.beforeEach(async to => { if (to.path === '/providers') { entered.resolve(); await gate.promise } })
  let opens = 0; const unsubscribe = broker.subscribe('provider-aliases', () => { opens++ })
  const opening = broker.request(form('cancel-during-navigation'), (target, signal) => navigateAssistantPage(router, target, signal), controller.signal)
  await entered.promise; controller.abort(); await expect(opening).rejects.toThrow('取消')
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0))
  expect(router.currentRoute.value.path).toBe('/overview'); expect(opens).toBe(0)
  // 取消请求的临时守卫必须释放，后续正常手工切页不能被它拦住。
  await router.push('/providers'); expect(router.currentRoute.value.path).toBe('/providers'); unsubscribe()
})

test('页面卸载会取消已开始但尚未完成的表单交付', async () => {
  const broker = createAssistantFormBroker(), started = deferred(), loading = ref(true)
  const unsubscribe = broker.subscribe('provider-aliases', async (_request, signal) => { started.resolve(); await waitForAssistantFormReady(() => loading.value, signal) })
  const opening = broker.request(form('unmounted'), async () => {})
  await started.promise; unsubscribe(); await expect(opening).rejects.toThrow('页面已关闭')
  loading.value = false; await flush()
})

test('目录读取期间等待，读取后重新检查权限，不泄漏已撤销权限的弹框', async () => {
  const loading = ref(true), permission = ref(true); let opens = 0
  const consumer = createAssistantFormConsumer(() => '/providers', { canOpen: () => permission.value, isLoading: () => loading.value, isBusy: () => false, isOpen: () => false, error: () => null, open: () => { opens++ } })
  const opening = consumer(form('waiting'), new AbortController().signal)
  await flush(); expect(opens).toBe(0)
  permission.value = false; loading.value = false
  await expect(Promise.resolve(opening)).rejects.toThrow('权限'); expect(opens).toBe(0)
})

test('已有手填草稿、忙碌、加载失败和目标页面变化时都不覆盖表单', async () => {
  let draft = '用户尚未保存的草稿'
  for (const caseOf of [{ open: true }, { busy: true }, { error: '读取失败' }, { path: '/overview' }]) {
    const consumer = createAssistantFormConsumer(() => caseOf.path ?? '/providers', { canOpen: () => true, isLoading: () => false, isBusy: () => !!caseOf.busy, isOpen: () => !!caseOf.open, error: () => caseOf.error ?? null, open: () => { draft = '助手值' } })
    await expect(Promise.resolve(consumer(form(), new AbortController().signal))).rejects.toThrow()
    expect(draft).toBe('用户尚未保存的草稿')
  }
})

test('跨页前保护原页面尚未保存的草稿，拒绝切页而非卸载后再检查', async () => {
  const broker = createAssistantFormBroker(); let navigations = 0, opens = 0
  const unsubscribe = broker.subscribe('project-aliases', () => {}, () => { throw new Error('已有正在填写的表单，请先保存或取消') })
  const target = broker.subscribe('provider-aliases', () => { opens++ })
  await expect(broker.request(form('protect-other-page'), async () => { navigations++ })).rejects.toThrow('已有正在填写')
  expect(navigations).toBe(0); expect(opens).toBe(0); unsubscribe(); target()
})

test('等待导航守卫期间用户打开手填草稿，也在提交路由前拦截', async () => {
  const router = await routerFixture(), broker = createAssistantFormBroker(), entered = deferred(), gate = deferred()
  let hasDraft = false
  router.beforeEach(async to => { if (to.path === '/providers') { entered.resolve(); await gate.promise } })
  const unsubscribe = broker.subscribe('project-aliases', () => {}, () => { if (hasDraft) throw new Error('请先保存正在填写的表单') })
  const opening = broker.request(form('late-user-draft'), (target, signal, check) => navigateAssistantPage(router, target, signal, check))
  await entered.promise; hasDraft = true; gate.resolve()
  await expect(opening).rejects.toThrow('请先保存')
  expect(router.currentRoute.value.path).toBe('/overview'); unsubscribe()
})

test('编辑只取真实 ID，已删除记录不能降级创建，相同名称不选第一条', () => {
  const rows = [{ id: targetId, name: '同名', provider: 'dashscope' }, { id: '22222222-2222-4222-8222-222222222222', name: '同名', provider: 'deepseek' }]
  expect(assistantFormEntry({ ...form(), operation: 'update', target_id: rows[1]!.id }, rows, row => row.id)).toBe(rows[1]!)
  expect(() => assistantFormEntry({ ...form(), operation: 'update', target_id: '已删除' }, rows, row => row.id)).toThrow('不存在')
  expect(assistantFormEntry(form(), rows, row => row.id)).toBeNull()
  expect(() => assertAssistantFormIdentity({ provider: 'wrong' }, rows[0]!, ['provider'])).toThrow('标识已变化')
  expect(() => assertAssistantFormIdentity({ alias: '改名' }, rows[0]!, ['provider'])).not.toThrow()
})

test('人员预填仅取姓名分组，保留真实角色且复制数组，空分组明确清空', () => {
  const ids = [targetId]
  const prefill = assistantMemberPrefill({ name: '张三', group_ids: ids, role_ids: ['admin'], password: 'secret' })
  expect(prefill).toEqual({ name: '张三', group_ids: [targetId] })
  expect(prefill.group_ids).not.toBe(ids)
  expect(assistantMemberPrefill({ group_ids: [] })).toEqual({ group_ids: [] })
  const latestProfile = { name: '当前名称', group_ids: [targetId] }
  expect(assistantMemberDraft(latestProfile, assistantMemberPrefill({ name: '新姓名' }))).toEqual({ name: '新姓名', group_ids: [targetId] })
  expect(assistantMemberDraft(latestProfile, assistantMemberPrefill({ group_ids: [] }))).toEqual({ name: '当前名称', group_ids: [] })
})

test('单价预填保持百万token单位、零单价、基础价和NULL时间语义', () => {
  expect(assistantPricingPrefill({ provider: '*', currency: 'USD', input_micro_per_ktok: 2000, cache_read_micro_per_ktok: 0, offpeak_schedule: null, offpeak_input_micro_per_ktok: null, effective_from_ms: 0, effective_to_ms: null, note: null }, ms => `date:${ms}`)).toEqual({ provider: '*', currency: 'USD', basePrice: true, input: '2', cacheRead: '0', offpeakSchedule: '', offpeakInput: '', from: '', to: '', note: '' })
  expect(assistantPricingPrefill({ effective_to_ms: 123_456 }, ms => `date:${ms}`)).toEqual({ to: 'date:123456' })
})

test('未更改的价格窗口保留原秒与毫秒，主动修改日期才解析新输入', () => {
  const original = new Date('2026-10-10T11:12:13.456').getTime(), input = '2026-10-10T11:12'
  expect(assistantPriceTime(input, original, input, 0)).toBe(original)
  expect(assistantPriceTime('2026-10-11T12:30', original, input, 0)).toBe(new Date('2026-10-11T12:30').getTime())
  expect(assistantPriceTime('', null, '', null)).toBeNull()
  expect(assistantPriceTime('', undefined, '', 0)).toBe(0)
  const epochEnd = assistantPricingPrefill({ effective_to_ms: 0 }, ms => new Date(ms).toISOString().slice(0, 16))
  expect(epochEnd.to).toBe('1970-01-01T00:00')
  expect(assistantPriceTime(String(epochEnd.to), 0, String(epochEnd.to), null)).toBe(0)
  const prefilled = assistantPricingPrefill({ effective_from_ms: original, effective_to_ms: original + 123_456 }, () => input)
  expect(assistantPriceTime(String(prefilled.from), original, input, 0)).toBe(original)
  expect(assistantPriceTime(String(prefilled.to), original + 123_456, input, null)).toBe(original + 123_456)
})
