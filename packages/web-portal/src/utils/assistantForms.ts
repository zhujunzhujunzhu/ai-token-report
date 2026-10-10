/** 助手表单仅在本次实时请求中交付；草稿不进入地址、持久存储或历史重放。 */
import { ASSISTANT_FORMS, ANY_PROVIDER, type AssistantForm, type AssistantFormResource, type AssistantFormValues } from '@ai-token-report/shared'
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, type Router } from 'vue-router'
import { navigateAssistantPage } from './assistantNavigation.js'
import { microToRateText } from './unitPrice.js'

type Consumer = (form: AssistantForm, signal: AbortSignal) => void | Promise<void>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value)

/** 服务端已经校验业务值，浏览器仍拒绝未知资源、路径和权限/凭证字段。 */
export function assistantFormTarget(form: AssistantForm): { path: string; query: Record<string, string> } {
  const definition = ASSISTANT_FORMS.find(item => item.resource === form.resource)
  if (!definition || definition.path !== form.path) throw new Error('助手请求了未知管理表单')
  if (!text(form.request_id) || !form.request_id || form.request_id.length > 128) throw new Error('表单请求标识无效')
  if (!['create', 'update'].includes(form.operation) || (form.operation === 'update' ? !form.target_id || !UUID.test(form.target_id) : form.target_id !== undefined)) throw new Error('表单操作或目标标识无效')
  if (!form.values || typeof form.values !== 'object' || Array.isArray(form.values)) throw new Error('表单预填内容无效')
  for (const [key, value] of Object.entries(form.values)) {
    if (!(definition.fields as readonly string[]).includes(key)) throw new Error('表单包含不允许填写的字段')
    if (key === 'group_ids') {
      if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('预填分组标识无效')
    } else if (key.endsWith('_micro_per_ktok') || key.endsWith('_ms')) {
      if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (key.endsWith('_ms') && !Number.isFinite(new Date(value).getTime())))) throw new Error('预填单价或日期无效')
    } else if (value !== null && !text(value)) throw new Error('表单预填文本无效')
    if (key === 'scope' && value !== 'global' && value !== 'member') throw new Error('预填作用范围无效')
    if (key === 'member_id' && value !== null && (typeof value !== 'string' || !UUID.test(value))) throw new Error('预填人员标识无效')
  }
  // ★ 地址只承载页面，预填值绝不成为 URL、浏览器历史或日志中的查询参数。
  return { path: definition.path, query: {} }
}

/** 先等路由确认，再交付给挂载的页面；同页与跨页共用一次性消费语义。 */
export function createAssistantFormBroker(timeoutMs = 20_000) {
  interface Subscription { consume: Consumer; controller: AbortController; beforeNavigate?: () => void }
  interface Pending { form: AssistantForm; ready: boolean; running: boolean; controller: AbortController; settle: (error?: unknown) => void }
  const subscriptions = new Map<AssistantFormResource, Subscription>()
  const pending = new Map<string, Pending>()
  const requests = new Map<string, Promise<void>>()
  function flush(resource: AssistantFormResource): void {
    const subscriber = subscriptions.get(resource)
    if (!subscriber) return
    for (const entry of pending.values()) {
      if (!entry.ready || entry.running || entry.form.resource !== resource) continue
      entry.running = true
      const signal = AbortSignal.any([entry.controller.signal, subscriber.controller.signal])
      const cancelled = () => entry.settle(new Error('表单请求已取消或页面已关闭'))
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) { cancelled(); continue }
      void Promise.resolve().then(() => subscriber.consume(entry.form, signal)).then(() => entry.settle(), error => entry.settle(error)).finally(() => signal.removeEventListener('abort', cancelled))
    }
  }
  function request(form: AssistantForm, navigate: (target: ReturnType<typeof assistantFormTarget>, signal: AbortSignal, beforeResolve: () => void) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const target = assistantFormTarget(form)
    const previous = requests.get(form.request_id)
    if (previous) return previous
    if (signal?.aborted) return Promise.reject(new Error('表单请求已取消'))
    const controller = new AbortController()
    let entry!: Pending
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      const abort = () => entry.settle(new Error('表单请求已取消'))
      const timer = setTimeout(() => entry.settle(new Error('打开表单超时，请重试')), timeoutMs)
      entry = { form: structuredClone(form), ready: false, running: false, controller, settle(error) {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(form.request_id)
        if (error) { controller.abort(); reject(error) } else resolve()
      } }
      pending.set(form.request_id, entry)
      signal?.addEventListener('abort', abort, { once: true })
    })
    requests.set(form.request_id, promise)
    // 只保留有限的去重标识；草稿在消费或失败后立即释放。
    if (requests.size > 512) for (const id of requests.keys()) { if (!pending.has(id)) { requests.delete(id); break } }
    const protectDrafts = () => { for (const subscriber of subscriptions.values()) subscriber.beforeNavigate?.() }
    void Promise.resolve().then(() => {
      if (!pending.has(form.request_id) || controller.signal.aborted) return
      // 当前页的草稿必须在切页前保护，目标页检查来不及挽回已经卸载的表单。
      protectDrafts()
      return navigate(target, controller.signal, protectDrafts)
    }).then(() => {
      if (!pending.has(form.request_id) || controller.signal.aborted) return
      entry.ready = true; flush(form.resource)
    }, error => entry.settle(error))
    return promise
  }
  function subscribe(resource: AssistantFormResource, consume: Consumer, beforeNavigate?: () => void): () => void {
    const subscription: Subscription = { consume, controller: new AbortController(), beforeNavigate }
    subscriptions.get(resource)?.controller.abort()
    subscriptions.set(resource, subscription); flush(resource)
    return () => { subscription.controller.abort(); if (subscriptions.get(resource) === subscription) subscriptions.delete(resource) }
  }
  return { request, subscribe }
}

const formBroker = createAssistantFormBroker()
export function openAssistantForm(router: Router, form: AssistantForm, signal?: AbortSignal): Promise<void> {
  return formBroker.request(form, (target, navigationSignal, protectDrafts) => navigateAssistantPage(router, target, navigationSignal, protectDrafts), signal)
}

/** 初次目录请求可能仍在进行；不能拿未加载的列表误判目标不存在。 */
export function waitForAssistantFormReady(isLoading: () => boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('表单请求已取消'))
  if (!isLoading()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { stop(); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve() }
    const cancel = () => finish(new Error('表单请求已取消'))
    const stop = watch(isLoading, loading => { if (!loading) finish() }, { flush: 'sync' })
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export interface AssistantFormPageOptions {
  canOpen: () => boolean; isLoading: () => boolean; isBusy: () => boolean; isOpen: () => boolean
  error: () => string | null; open: Consumer
}
/** 等待目录期间也可能停用权限或打开手填草稿，交付时重新检查全部条件。 */
export function createAssistantFormConsumer(currentPath: () => string, options: AssistantFormPageOptions): Consumer {
  return async (form, signal) => {
    await waitForAssistantFormReady(options.isLoading, signal)
    if (signal.aborted || currentPath() !== form.path) throw new Error('目标页面已关闭，请重新打开表单')
    if (!options.canOpen()) throw new Error('没有填写此管理表单的权限')
    if (options.isOpen()) throw new Error('已有正在填写的表单，请先保存或取消后再打开')
    if (options.isBusy()) throw new Error('页面正在保存，请稍后重试')
    if (options.error()) throw new Error('管理目录加载失败，请刷新页面后再打开表单')
    await options.open(form, signal)
  }
}
export function useAssistantForm(resource: AssistantFormResource, options: AssistantFormPageOptions): void {
  const route = useRoute()
  let unsubscribe: (() => void) | undefined
  onMounted(() => { unsubscribe = formBroker.subscribe(resource, createAssistantFormConsumer(() => route.path, options), () => {
    if (route.path !== ASSISTANT_FORMS.find(item => item.resource === resource)?.path) return
    if (options.isOpen()) throw new Error('已有正在填写的表单，请先保存或取消后再打开')
    if (options.isBusy()) throw new Error('页面正在保存，请稍后重试')
  }) })
  onBeforeUnmount(() => unsubscribe?.())
}

/** 人员表单仅预填资料，角色继续使用真实人员或普通成员默认值。 */
export interface AssistantMemberPrefill { name?: string; group_ids?: string[] }
export function assistantMemberPrefill(values: AssistantFormValues): AssistantMemberPrefill {
  return { ...(typeof values.name === 'string' ? { name: values.name } : {}), ...(Array.isArray(values.group_ids) ? { group_ids: [...values.group_ids] } : {}) }
}

/** 未指定的资料使用页面刚读取的现值，不能被模型先前查询的旧快照盖回去。 */
export function assistantMemberDraft(current: { name: string; group_ids: string[] }, prefill?: AssistantMemberPrefill): { name: string; group_ids: string[] } {
  return { name: prefill?.name ?? current.name, group_ids: [...(prefill?.group_ids ?? current.group_ids)] }
}

/** 编辑只认当前目录中的真实 ID；已删除的目标不能退化成创建。 */
export function assistantFormEntry<T>(form: AssistantForm, rows: readonly T[], idOf: (row: T) => string): T | null {
  if (form.operation === 'create') return null
  const entry = rows.find(row => idOf(row) === form.target_id)
  if (!entry) throw new Error('要编辑的记录已不存在或不可访问，请刷新后重新选择')
  return entry
}
/** 原页面通过业务键保存；改变键会变成新增，所以助手编辑必须保持真实标识。 */
export function assertAssistantFormIdentity(values: AssistantFormValues, row: object | null, keys: readonly string[]): void {
  if (!row) return
  const current = row as Record<string, unknown>
  if (keys.some(key => values[key] !== undefined && values[key] !== current[key])) throw new Error('这条记录的标识已变化，请刷新后重新选择')
}

/** 只在边界换算输入文本，金额计算仍由共享契约负责。 */
export function assistantPricingPrefill(values: AssistantFormValues, localInput: (ms: number) => string): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const key of ['provider', 'model', 'currency', 'note']) if (values[key] !== undefined) result[key] = String(values[key] ?? '')
  if (values.provider !== undefined) result.basePrice = values.provider === ANY_PROVIDER
  const rates = { input_micro_per_ktok: 'input', output_micro_per_ktok: 'output', cache_read_micro_per_ktok: 'cacheRead', cache_write_micro_per_ktok: 'cacheWrite', offpeak_input_micro_per_ktok: 'offpeakInput', offpeak_output_micro_per_ktok: 'offpeakOutput', offpeak_cache_read_micro_per_ktok: 'offpeakCacheRead', offpeak_cache_write_micro_per_ktok: 'offpeakCacheWrite' }
  for (const [field, draftKey] of Object.entries(rates)) if (values[field] !== undefined) result[draftKey] = typeof values[field] === 'number' ? microToRateText(values[field]) : ''
  if (values.offpeak_schedule !== undefined) result.offpeakSchedule = String(values.offpeak_schedule ?? '')
  if (values.effective_from_ms !== undefined) result.from = typeof values.effective_from_ms === 'number' && values.effective_from_ms > 0 ? localInput(values.effective_from_ms) : ''
  if (values.effective_to_ms !== undefined) result.to = typeof values.effective_to_ms === 'number' ? localInput(values.effective_to_ms) : ''
  return result
}

/** 控件只显示到分钟，未改动时保留原值，避免精度变化把编辑变成新建区间。 */
export function assistantPriceTime(input: string, originalMs: number | null | undefined, originalInput: string, empty: number | null): number | null {
  return originalMs !== undefined && input === originalInput ? originalMs : input ? new Date(input).getTime() : empty
}
