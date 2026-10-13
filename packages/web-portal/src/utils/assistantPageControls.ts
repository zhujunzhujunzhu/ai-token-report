/**
 * 页面操作桥只公开当前可见控件的标签和短期标识；真实元素留在浏览器。
 * 模型不能传选择器、脚本或绕开页面鉴权，也不能接触凭证和人工确认按钮。
 */
import { nextTick } from 'vue'
import type { AssistantFormContext, AssistantPageActionResult, AssistantPageContext, AssistantPageControl, AssistantPageOperation } from '@ai-token-report/shared'

const LIMIT = 80, REGISTRY_LIMIT = 512
const EXCLUDED = '.assistant-layer, #global-assistant, .assistant-page, .assistant-layer-popup, .el-message-box, .action-card, .appkey-delivery'
const MODAL = '.el-dialog,.el-drawer'
const FILTER_CONTAINERS = '.filter-form,.filter-card,.member-filters'
const READ_SELECTION_CLICKS = '[role="option"],[role="combobox"],.el-select__wrapper,.sort-caret,.el-tabs__item,.el-pager li,.el-date-editor .el-input__wrapper,.el-input__clear,.el-select__clear,.el-tag__close,.el-input-number__increase,.el-input-number__decrease'
const CANDIDATES = [
  'button', 'input', 'textarea', 'select', '[role="button"]', '[role="combobox"]', '[role="option"]',
  '.el-checkbox', '.el-radio', '.el-switch', '.el-tabs__item', '.el-pager li', '.sort-caret', '.el-table__expand-icon',
  '.el-select__wrapper', '.el-date-editor .el-input__wrapper', '.el-input__clear', '.el-select__clear', '.el-tag__close',
  '.el-input-number__increase', '.el-input-number__decrease', '.el-date-table td.available', '.el-month-table td',
  '.el-year-table td.available', '.el-time-spinner__item',
].join(',')
type Kind = AssistantPageControl['kind']
interface Description { element: HTMLElement; control: Omit<AssistantPageControl, 'id'>; dialog?: HTMLElement | null }
interface Binding extends Description {
  fingerprint: string
  dialog: HTMLElement | null
  dialogEpoch: number
  form: AssistantFormContext | null | undefined
}
export interface AssistantPageControllerOptions {
  path: () => string
  getForm: () => AssistantFormContext | null | undefined
  root?: Document
}

const clean = (value: string | null | undefined, limit = 120) => (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
function safeMetadata(value: string): boolean {
  return !!value && !/(?:^[A-Za-z]:[\\/]|\\\\|https?:\/\/|\/[^\s/]+\/)|(?:sk-|atr_|bearer\s|api[_-]?key\s*[:=]|token\s*[:=])|[A-Za-z0-9_-]{32,}/i.test(value)
}
function nativeInput(element: HTMLElement): HTMLInputElement | undefined {
  return element.tagName === 'INPUT' ? element as HTMLInputElement : element.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]') ?? undefined
}
function visible(element: HTMLElement, document: Document): boolean {
  if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = document.defaultView?.getComputedStyle(current)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
  }
  return element.getClientRects().length > 0
}
function unavailable(element: HTMLElement): boolean {
  return !!element.closest('[disabled],[aria-disabled="true"],.is-disabled,fieldset[disabled]') || !!nativeInput(element)?.disabled
}
function fieldLabel(element: HTMLElement, document: Document): string {
  const input = element.matches('input,textarea,select') ? element : element.querySelector<HTMLElement>('input,textarea,select')
  for (const target of [element, input]) {
    if (!target) continue
    const aria = clean(target.getAttribute('aria-label'))
    if (aria) return aria
    const labelled = clean((target.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
    if (labelled) return labelled
    if (target.id) {
      const label = Array.from(document.querySelectorAll<HTMLLabelElement>('label[for]')).find(item => item.htmlFor === target.id)
      if (label) return clean(label.textContent)
    }
  }
  const formLabel = clean(element.closest('.el-form-item')?.querySelector('.el-form-item__label')?.textContent)
  if (formLabel) return formLabel
  const wrappingLabel = element.closest('label')
  if (wrappingLabel) return clean(wrappingLabel.textContent)
  const placeholder = clean(input?.getAttribute('placeholder') ?? element.getAttribute('placeholder'))
  if (placeholder) return placeholder
  return ''
}
function labelOf(element: HTMLElement, document: Document): string {
  const field = fieldLabel(element, document)
  if (field) return field
  const title = clean(element.getAttribute('title'))
  if (title) return title
  if (element.matches('.sort-caret')) {
    const header = element.closest('th')?.querySelector('.cell')
    return `${clean(header?.textContent)}${element.classList.contains('ascending') ? '升序' : '降序'}`
  }
  if (element.matches('.el-table__expand-icon')) return element.classList.contains('el-table__expand-icon--expanded') ? '收起明细' : '展开明细'
  if (element.matches('.el-input__clear,.el-select__clear,.el-tag__close')) return '清除选项'
  if (element.matches('.el-input-number__increase')) return '增加数值'
  if (element.matches('.el-input-number__decrease')) return '减少数值'
  return clean(element.textContent)
}
function secretField(element: HTMLElement, label: string): boolean {
  const input = element.matches('input') ? element as HTMLInputElement : element.querySelector<HTMLInputElement>('input')
  const description = `${label} ${input?.name ?? ''} ${input?.autocomplete ?? ''}`.replace(/(?:百万|千|million|thousand)\s*tokens?/gi, '')
  return input?.type === 'password' || /密码|密钥|凭证|用户名|password|secret|token|appkey|username/i.test(description)
}
function protectedRoleField(element: HTMLElement, label: string): boolean {
  return !!element.closest(MODAL) && /角色|权限/.test(label)
}
function rowLabel(element: HTMLElement): string {
  const row = element.closest<HTMLTableRowElement>('tbody tr')
  if (!row) return ''
  const rows = Array.from(row.parentElement?.querySelectorAll('tr') ?? [])
  const index = rows.indexOf(row) + 1
  // ⚠️ 展开内容那一行（`td.el-table__expanded-cell`）自己**没有任何列**，
  //   名称只能从它上面那条数据行借 —— 否则展开区里的按钮全都只剩「第 N 行」，
  //   助手分不清它属于哪个项目 / 哪个人。
  //   ★ 行号仍取**展开行自己的位置**：同一个项目下多条规则的操作按钮必须靠行号
  //   区分（路径是敏感值，不发给模型），换成父行号会让它们长得一模一样。
  const named = row.querySelector('.el-table__expanded-cell') ? rows[index - 2] ?? row : row
  const table = named.closest('.el-table,table')
  let name = ''
  for (const cell of Array.from(named.querySelectorAll('td'))) {
    const column = Array.from(cell.classList).find(item => /^el-table_\w+_column_\w+$/.test(item))
    const header = column ? clean(table?.querySelector(`th.${column}`)?.textContent) : ''
    // ⚠️ 表头文案是**展示层**的字符串，两页各有各的叫法（项目页「归一化后的项目」、
    //   供应商页「归一化后的名字」），所以这里列的是白名单而不是一条模糊匹配 ——
    //   多认一列等于把那一列的单元格内容（可能是路径 / 凭证）发给模型。
    if (!/^(姓名|成员|人员|署名|分组名称|角色名称|模型|归一化后的项目|归一化后的名字|供应商)$/.test(header)) continue
    const candidate = clean(cell.querySelector('strong')?.textContent ?? cell.textContent, 48)
    if (safeMetadata(candidate) && !/[\\/]/.test(candidate) && !cell.querySelector('input,button,code')) { name = candidate; break }
  }
  return `第 ${index} 行${name ? `（${name}）` : ''} · `
}
export function assistantControlEffect(kind: Kind, label: string, inDialog: boolean, submit: boolean, selection = false): AssistantPageControl['effect'] {
  if (kind === 'fill') return 'read'
  if (kind === 'toggle') return !inDialog && !selection && /启用|停用|禁用|恢复|归档|删除|吊销|撤销/.test(label) ? 'write' : 'read'
  if (submit && !/查询|搜索|筛选|应用条件/.test(label)) return 'write'
  if (/删除|移除|停用|启用|恢复|归档|吊销|撤销|发放|签发|保存|提交/.test(label) && !/打开|查看|只看|筛选|搜索/.test(label)) return 'write'
  return 'read'
}
function blockedSubmit(element: HTMLElement, effect: AssistantPageControl['effect'], path: string): boolean {
  if (effect !== 'write') return false
  if (path === '/appkeys') return true
  const dialog = element.closest(MODAL)
  const title = clean(dialog?.querySelector('.el-dialog__title,.el-drawer__title')?.textContent)
  if (/登录|appkey|凭证|角色|权限/i.test(title)) return true
  if (element.matches('button[type="submit"]')) {
    if (path === '/roles' || path === '/appkeys') return true
    if (path === '/members') return element.closest('form')?.getAttribute('data-assistant-submit-safe') !== 'true'
    if (dialog?.querySelector('input[type="password"]')) return true
  }
  return false
}

function describe(element: HTMLElement, document: Document, path: string): Description[] {
  if (element.closest(EXCLUDED) || unavailable(element) || !visible(element, document)) return []
  let target = element
  const result: Description[] = []
  const input = nativeInput(element)
  if (input && ['checkbox', 'radio'].includes(input.type)) {
    target = input.closest<HTMLElement>('.el-checkbox,.el-radio,.el-switch') ?? input
    if (unavailable(target) || !visible(target, document)) return []
    const label = labelOf(target, document) || clean(input.getAttribute('aria-label'))
    if (secretField(target, label) || protectedRoleField(target, label) || !safeMetadata(label)) return []
    const filterToggle = !target.closest('tbody tr') && !!target.closest(FILTER_CONTAINERS)
    const effect = assistantControlEffect('toggle', label, !!target.closest(MODAL), false, filterToggle || !!target.closest('.el-table-column--selection'))
    return [{ element: target, control: { kind: 'toggle', label: rowLabel(target) + label, effect, value: input.checked } }]
  }
  if (element.matches('input,textarea,select')) {
    const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    const label = fieldLabel(element, document)
    if (secretField(element, label) || protectedRoleField(element, label) || !safeMetadata(label)) return []
    if (element.tagName === 'SELECT') return []
    if (element.tagName !== 'INPUT' || !['hidden', 'file', 'button', 'submit', 'reset', 'image'].includes((field as HTMLInputElement).type)) {
      if (!(field as HTMLInputElement).readOnly) result.push({ element, control: { kind: 'fill', label, effect: 'read' } })
    }
    if (element.getAttribute('role') === 'combobox') target = element.closest('.el-select')?.querySelector<HTMLElement>('.el-select__wrapper') ?? element
    else return result
  }
  const label = labelOf(target, document)
  if (!safeMetadata(label) || protectedRoleField(target, label)) return result
  const openCredentialForm = !target.closest(MODAL) && /^(发放|签发)\s*appkey$/i.test(label)
  if (secretField(target, label) && !openCredentialForm) return result
  const submit = target.matches('button[type="submit"]') && !target.closest('.filter-form,.filter-card')
  // ★ 下拉选项“停用/启用”是筛选值，日期、排序和分页也只改展示或草稿，不能按字面认成写入。
  const selectionClick = !submit && (target.matches(READ_SELECTION_CLICKS) || !!target.closest('.el-picker-panel,.el-time-panel'))
  const effect = openCredentialForm || selectionClick ? 'read' : assistantControlEffect('click', label, !!target.closest(MODAL), submit)
  if (!blockedSubmit(target, effect, path)) result.push({ element: target, control: { kind: 'click', label: rowLabel(target) + label, effect } })
  return result
}

/** 只有页面控件声明的关联浮层可供操作，body 中的其它内容与确认框不可寻址。 */
interface Scope { element: HTMLElement; dialog: HTMLElement | null }
function controlScopes(document: Document): Scope[] {
  if (Array.from(document.querySelectorAll<HTMLElement>('.el-message-box')).some(element => visible(element, document))) return []
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(MODAL)).filter(element => visible(element, document) && !element.closest(EXCLUDED))
  // 弹框打开时只能操作当前草稿，后台列表不能暗中换行、重置或重开它。
  dialogs.sort((left, right) => Number(document.defaultView?.getComputedStyle(left.closest('.el-overlay') ?? left).zIndex || 0) - Number(document.defaultView?.getComputedStyle(right.closest('.el-overlay') ?? right).zIndex || 0))
  const roots = dialogs.length ? [dialogs[dialogs.length - 1]!] : []
  if (roots[0]?.querySelector('.appkey-delivery')) return []
  const main = document.getElementById('main-content')
  if (!roots.length && main) roots.push(main)
  const popups: Scope[] = []
  for (const source of roots) for (const control of source.querySelectorAll<HTMLElement>('[aria-controls],[aria-owns],[aria-describedby]')) {
    const label = fieldLabel(control, document)
    if (!visible(control, document) || unavailable(control) || secretField(control, label) || protectedRoleField(control, label) || control.closest(EXCLUDED)) continue
    for (const attribute of ['aria-controls', 'aria-owns', 'aria-describedby']) for (const id of (control.getAttribute(attribute) ?? '').split(/\s+/)) {
      const popup = id && document.getElementById(id)
      if (!popup || popup.closest(EXCLUDED)) continue
      const container = popup.closest<HTMLElement>('.el-popper,.el-picker-panel,.el-select-dropdown') ?? popup
      if (visible(container, document)) popups.push({ element: container, dialog: source.closest<HTMLElement>(MODAL) })
    }
  }
  const seen = new Set<HTMLElement>()
  return [...popups, ...roots.map(element => ({ element, dialog: element.closest<HTMLElement>(MODAL) }))].filter(scope => {
    if (seen.has(scope.element)) return false
    seen.add(scope.element); return true
  })
}
const scopes = (document: Document) => controlScopes(document).map(scope => scope.element)
function fingerprint(description: Description): string {
  // 行文本只在浏览器内算指纹；同名行换位或节点被列表复用时旧标识必须失效。
  const row = description.element.closest('tbody tr')?.textContent ?? ''
  let rowHash = 2166136261
  for (let index = 0; index < row.length; index++) rowHash = Math.imul(rowHash ^ row.charCodeAt(index), 16777619)
  return [description.control.kind, description.control.label, description.control.effect, description.element.tagName, description.element.getAttribute('type'), description.element.getAttribute('name'), rowHash >>> 0].join('|')
}
function hiddenMutation(value: string | null): boolean { return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(value ?? '') }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('页面操作已取消'))
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('页面操作已取消')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}
async function settleBusy(document: Document, signal: AbortSignal): Promise<boolean> {
  await nextTick()
  const deadline = Date.now() + 4500
  while (true) {
    if (signal.aborted) throw new Error('页面操作已取消')
    if (Date.now() >= deadline) return false
    if (!scopes(document).some(scope => Array.from(scope.querySelectorAll<HTMLElement>('.el-loading-mask,.is-loading,[aria-busy="true"]')).some(element => visible(element, document)))) return true
    await delay(Math.min(100, Math.max(0, deadline - Date.now())), signal); await nextTick()
  }
}

export function createAssistantPageController(options: AssistantPageControllerOptions) {
  const document = options.root ?? (typeof window === 'undefined' ? undefined : window.document)
  let originPath = options.path()
  const registry = new Map<string, Binding>()
  let identifiers = new WeakMap<HTMLElement, Map<Kind, { id: string; fingerprint: string }>>()
  const dialogEpochs = new WeakMap<HTMLElement, number>(), dialogs = new Set<HTMLElement>()
  // ★ 线上 HTTP 页面没有 randomUUID；getRandomValues 仍可用，保留每轮控件标识的随机隔离。
  const prefix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  let main = document?.getElementById('main-content'), page = main?.firstElementChild
  let sequence = 0, disposed = false
  function processMutations(records: MutationRecord[]) {
    for (const record of records) for (const dialog of dialogs) {
      const changed = record.target as HTMLElement
      const affectsDialog = changed === dialog || changed.contains?.(dialog)
      const changedVisibility = record.type === 'attributes' && affectsDialog && (
        record.attributeName === 'hidden' || record.attributeName === 'aria-hidden' ||
        hiddenMutation(record.oldValue) || hiddenMutation(changed.getAttribute('style'))
      )
      const removed = record.type === 'childList' && Array.from(record.removedNodes).some(node => node === dialog || node.contains(dialog))
      if (changedVisibility || removed) dialogEpochs.set(dialog, (dialogEpochs.get(dialog) ?? 0) + 1)
    }
  }
  const Observer = document?.defaultView?.MutationObserver
  const observer = Observer ? new Observer(processMutations) : undefined
  if (document?.body) observer?.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'hidden', 'aria-hidden'] })
  const processPending = () => { if (observer) processMutations(observer.takeRecords()) }
  function stalePage(): string | undefined {
    if (disposed) return '本次页面操作已结束，请重新发送请求'
    if (options.path() !== originPath) return '页面已切换，请在当前页面重新发送请求'
    if (main && (!main.isConnected || main !== document?.getElementById('main-content') || page !== main.firstElementChild)) return '原页面已关闭或重新加载，请重新发送请求'
  }
  function capture(): AssistantPageContext {
    processPending()
    const controls: AssistantPageControl[] = [], seenKinds = new Map<HTMLElement, Set<Kind>>()
    if (!document || stalePage()) return { path: options.path(), controls }
    const descriptions = controlScopes(document).flatMap(scope => Array.from(scope.element.querySelectorAll<HTMLElement>(CANDIDATES)).flatMap(candidate => describe(candidate, document, originPath).map(description => ({ ...description, dialog: scope.dialog }))))
    descriptions.sort((left, right) => {
      const priority = (item: Description) => item.element.closest('tbody tr') ? 4 : item.control.kind !== 'click' ? 0 : item.element.closest('.el-popper,.el-picker-panel,.el-select-dropdown') ? 1 : 2
      return priority(left) - priority(right)
    })
    let popupOptions = 0
    for (const description of descriptions) {
      if (description.element.matches('[role="option"]') && popupOptions++ >= 40) continue
      const { element, control } = description
      const kinds = seenKinds.get(element) ?? new Set<Kind>()
      if (kinds.has(control.kind)) continue
      kinds.add(control.kind); seenKinds.set(element, kinds)
      const currentFingerprint = fingerprint(description), prior = identifiers.get(element)?.get(control.kind)
      const previousBinding = prior && registry.get(prior.id)
      const dialog = description.dialog ?? element.closest<HTMLElement>(MODAL)
      const sameDraft = previousBinding && (!dialog || (previousBinding.dialogEpoch === (dialogEpochs.get(dialog) ?? 0) && previousBinding.form === options.getForm()))
      let id = prior?.fingerprint === currentFingerprint && sameDraft ? prior.id : undefined
      if (!id) {
        id = `${prefix}:${++sequence}`
        const entries = identifiers.get(element) ?? new Map()
        entries.set(control.kind, { id, fingerprint: currentFingerprint }); identifiers.set(element, entries)
        if (dialog) { dialogs.add(dialog); if (dialogs.size > 128) dialogs.delete(dialogs.values().next().value!) }
        registry.set(id, { ...description, fingerprint: currentFingerprint, dialog, dialogEpoch: dialog ? dialogEpochs.get(dialog) ?? 0 : 0, form: dialog ? options.getForm() : undefined })
        while (registry.size > REGISTRY_LIMIT) registry.delete(registry.keys().next().value!)
      }
      controls.push({ id, ...control })
      if (controls.length === LIMIT) return { path: originPath, controls }
    }
    return { path: originPath, controls }
  }
  function outcome(ok: boolean, reason?: string): AssistantPageActionResult {
    return { ok, ...(reason ? { reason } : {}), page_context: capture(), form_context: options.getForm() ?? null }
  }
  async function execute(operation: AssistantPageOperation, allowWrite: boolean, signal: AbortSignal): Promise<AssistantPageActionResult> {
    try {
      processPending()
      if (signal.aborted) return outcome(false, '页面操作已取消')
      const stale = stalePage()
      if (stale) return outcome(false, stale)
      if (!document) return outcome(false, '当前浏览器没有可操作的页面')
      if (operation.operation === 'inspect') {
        // 导航完成只代表页面已挂载；目录还在读取时不能把暂时禁用的按钮当作缺失。
        if (!await settleBusy(document, signal)) return outcome(false, '页面仍在加载，请稍后重新查看控件')
        const changed = stalePage()
        return changed ? outcome(false, changed) : outcome(true)
      }
      const binding = registry.get(operation.control_id)
      if (!binding || binding.control.kind !== operation.operation) return outcome(false, '控件不存在或操作类型不匹配，请重新查看页面')
      if (binding.dialog && ((dialogEpochs.get(binding.dialog) ?? 0) !== binding.dialogEpoch || binding.form !== options.getForm())) return outcome(false, '原表单已关闭、重开或切换，请重新查看当前表单')
      const current = describe(binding.element, document, originPath).find(description => description.control.kind === binding.control.kind)
      if (!current || fingerprint(current) !== binding.fingerprint) return outcome(false, '控件已移除、禁用或内容变化，请重新查看页面')
      if (!controlScopes(document).some(scope => scope.element.contains(binding.element) && scope.dialog === binding.dialog)) return outcome(false, '原控件已离开当前页面或表单，请重新查看页面')
      if (current.control.effect === 'write' && !allowWrite) return outcome(false, '本次请求没有明确授权保存或修改数据，请先明确要执行的操作')
      const target = binding.element
      if (operation.operation === 'fill') {
        if (typeof operation.value !== 'string' || operation.value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(operation.value)) return outcome(false, '填写内容必须是不超过 2000 字的文本')
        const window = document.defaultView
        const prototype = target.tagName === 'TEXTAREA' ? window?.HTMLTextAreaElement.prototype : window?.HTMLInputElement.prototype
        const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter || !target.matches('input,textarea')) return outcome(false, '此控件不支持文本填写，请选择当前可见输入框')
        target.focus({ preventScroll: true })
        setter.call(target, operation.value)
        if ((target as HTMLInputElement).value !== operation.value) return outcome(false, '输入框不接受此格式，请按控件要求填写')
        target.dispatchEvent(new window!.Event('input', { bubbles: true }))
        target.dispatchEvent(new window!.Event('change', { bubbles: true }))
        target.blur()
      } else if (operation.operation === 'toggle') {
        if (typeof operation.value !== 'boolean') return outcome(false, '勾选或开关操作必须明确指定 true 或 false')
        const input = nativeInput(target)
        if (!input || !['checkbox', 'radio'].includes(input.type)) return outcome(false, '此控件没有可切换的原生输入')
        if (input.type === 'radio' && !operation.value) return outcome(false, '单选项不能直接取消，请选择同组的另一项')
        if (input.checked !== operation.value) {
          // Element Plus switch 在外层处理点击，点隐藏 input 会同时触发 change 而翻转两次。
          if (target.classList.contains('el-switch')) target.click()
          else input.click()
        }
      } else target.click()
      await nextTick()
      // 看板多选会等待 250ms 合并查询；先越过这个窗口再判断页面是否还在加载。
      await delay(300, signal)
      if (!await settleBusy(document, signal)) return outcome(false, '已操作控件，页面仍在处理；请稍后检查结果，不代表数据已经保存')
      const after = stalePage()
      if (after) return outcome(false, after)
      if (operation.operation === 'toggle' && nativeInput(target)?.checked !== operation.value) return outcome(false, '页面未接受这次切换，请检查控件提示后重试')
      const confirmation = Array.from(document.querySelectorAll<HTMLElement>('.el-message-box')).some(element => visible(element, document))
      if (confirmation) return outcome(true, '已打开人工确认框，请由用户核对并确认；尚未执行最终修改')
      const errors = scopes(document).flatMap(scope => Array.from(scope.querySelectorAll<HTMLElement>('.el-form-item__error,[role="alert"]'))).filter(element => visible(element, document))
      if (operation.operation === 'click' && current.control.effect === 'write' && errors.length) return outcome(false, '页面仍有校验或请求错误，请查看页面提示；未确认保存成功')
      return outcome(true, operation.operation === 'click' && current.control.effect === 'write' ? '已点击页面提交按钮；请以页面显示的实际结果为准' : undefined)
    } catch (error) { return outcome(false, error instanceof Error ? error.message : '页面操作失败，请检查当前页面') }
  }
  return {
    capture, execute,
    followNavigation() {
      if (disposed) return
      originPath = options.path(); main = document?.getElementById('main-content'); page = main?.firstElementChild
      registry.clear(); dialogs.clear(); identifiers = new WeakMap()
    },
    dispose() { disposed = true; observer?.disconnect(); registry.clear(); dialogs.clear() },
  }
}
