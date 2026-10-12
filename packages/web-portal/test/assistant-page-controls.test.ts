/** 页面桥以注入的 DOM 验证实际控件引用、输入事件、写授权与草稿失效，不新增浏览器依赖。 */
import { expect, test } from 'bun:test'
import type { AssistantFormContext } from '@ai-token-report/shared'
import { assistantControlEffect, createAssistantPageController } from '../src/utils/assistantPageControls.js'

/** 夹具只实现桥使用的 DOM 接口；浏览器渲染与 Element Plus 事件链另做真实页面验收。 */
class ElementFixture extends EventTarget {
  children: ElementFixture[] = []
  parentElement: ElementFixture | null = null
  attributes = new Map<string, string>()
  ownText = ''
  clicks = 0
  checked = false
  disabled = false
  readOnly = false
  constructor(readonly tagName: string, readonly ownerDocument: DocumentFixture) { super() }
  get classList() {
    const values = new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
    return { contains: (value: string) => values.has(value), [Symbol.iterator]: () => values.values() }
  }
  get id() { return this.getAttribute('id') ?? '' }
  get htmlFor() { return this.getAttribute('for') ?? '' }
  get type() { return this.getAttribute('type') ?? (this.tagName === 'INPUT' ? 'text' : '') }
  get name() { return this.getAttribute('name') ?? '' }
  get autocomplete() { return this.getAttribute('autocomplete') ?? '' }
  get firstElementChild() { return this.children[0] ?? null }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(' ') }
  get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parentElement?.isConnected }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  append(...children: ElementFixture[]) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  contains(node: ElementFixture): boolean { return node === this || this.children.some(child => child.contains(node)) }
  getClientRects() { return this.isConnected ? [{}] : [] }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const chain = part.trim().split(/\s+(?![^\[]*\])/)
      const simple = (element: ElementFixture, token: string): boolean => {
        const tag = token.match(/^[A-Za-z]+/)?.[0]
        if (tag && element.tagName !== tag.toUpperCase()) return false
        if ([...token.matchAll(/\.([\w-]+)/g)].some(match => !element.classList.contains(match[1]!))) return false
        if ([...token.matchAll(/#([\w-]+)/g)].some(match => element.id !== match[1])) return false
        return [...token.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(match => element.getAttribute(match[1]!) !== null && (match[2] === undefined || element.getAttribute(match[1]!) === match[2]))
      }
      if (!simple(this, chain.at(-1)!)) return false
      let parent = this.parentElement
      for (let index = chain.length - 2; index >= 0; index--) {
        while (parent && !simple(parent, chain[index]!)) parent = parent.parentElement
        if (!parent) return false
        parent = parent.parentElement
      }
      return true
    })
  }
  closest(selector: string): ElementFixture | null { for (let node: ElementFixture | null = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
  querySelectorAll(selector: string): ElementFixture[] { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)) }
  querySelector(selector: string): ElementFixture | null { return this.querySelectorAll(selector)[0] ?? null }
  focus() {}
  blur() { this.dispatchEvent(new Event('blur')) }
  click() { this.clicks++; this.dispatchEvent(new Event('click')) }
}
class InputFixture extends ElementFixture {
  private currentValue = ''
  get value() { return this.currentValue }
  set value(value: string) { this.currentValue = String(value) }
  override click() {
    if (this.disabled) return
    if (this.type === 'checkbox' || this.type === 'radio') { this.checked = this.type === 'radio' || !this.checked; this.dispatchEvent(new Event('change')) }
    super.click()
  }
}
class TextareaFixture extends InputFixture {}
class DocumentFixture {
  body = new ElementFixture('BODY', this)
  defaultView = {
    HTMLInputElement: InputFixture, HTMLTextAreaElement: TextareaFixture, Event,
    getComputedStyle: (element: ElementFixture) => {
      const style = element.getAttribute('style') ?? ''
      return { display: /display\s*:\s*none/.test(style) ? 'none' : 'block', visibility: /visibility\s*:\s*hidden/.test(style) ? 'hidden' : 'visible', zIndex: style.match(/z-index\s*:\s*(\d+)/)?.[1] ?? '0' }
    },
  }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector) }
  getElementById(id: string) { return id ? this.body.querySelectorAll('*').find(element => element.id === id) ?? null : null }
  element(tag: string, attributes: Record<string, string> = {}, text = '') {
    const element = tag === 'input' ? new InputFixture('INPUT', this) : tag === 'textarea' ? new TextareaFixture('TEXTAREA', this) : new ElementFixture(tag.toUpperCase(), this)
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
    element.ownText = text
    return element
  }
}
function fixture(initialPath = '/groups') {
  const document = new DocumentFixture(), main = document.element('main', { id: 'main-content' }), page = document.element('section')
  document.body.append(main); main.append(page)
  let path = initialPath, form: AssistantFormContext | null = null
  const controller = createAssistantPageController({ root: document as unknown as Document, path: () => path, getForm: () => form })
  return { document, page, main, controller, signal: new AbortController().signal, setPath: (value: string) => { path = value }, setForm: (value: AssistantFormContext | null) => { form = value } }
}
const control = (context: ReturnType<ReturnType<typeof createAssistantPageController>['capture']>, label: string, kind?: string) => context.controls.find(item => item.label === label && (!kind || item.kind === kind))!

test('HTTP 环境没有 randomUUID 仍能捕获和操作控件，各轮标识互不复用', async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  const controllers: ReturnType<typeof createAssistantPageController>[] = []
  // ★ 仅保留 HTTP 浏览器实际公开的随机接口，避免 Bun 的 randomUUID 掩盖线上发送故障。
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })
  try {
    expect('randomUUID' in globalThis.crypto).toBe(false)
    const f = fixture(), input = f.document.element('input', { 'aria-label': '搜索分组' }) as InputFixture
    const refresh = f.document.element('button', {}, '刷新分组')
    controllers.push(f.controller)
    let draft = ''
    input.addEventListener('input', () => { draft = input.value })
    f.page.append(input, refresh)
    const firstContext = f.controller.capture(), firstInputId = control(firstContext, '搜索分组').id
    const second = createAssistantPageController({ root: f.document as unknown as Document, path: () => '/groups', getForm: () => null })
    controllers.push(second)
    const secondInputId = control(second.capture(), '搜索分组').id
    expect(secondInputId).not.toBe(firstInputId)
    const stale = await second.execute({ operation: 'fill', control_id: firstInputId, value: '错误草稿' }, false, f.signal)
    expect(stale.ok).toBe(false); expect(draft).toBe('')
    expect((await f.controller.execute({ operation: 'fill', control_id: firstInputId, value: '研发' }, false, f.signal)).ok).toBe(true)
    expect(draft).toBe('研发')
    expect((await f.controller.execute({ operation: 'click', control_id: control(firstContext, '刷新分组').id }, false, f.signal)).ok).toBe(true)
    expect(refresh.clicks).toBe(1)
    f.controller.dispose()
    expect((await f.controller.execute({ operation: 'fill', control_id: firstInputId, value: '过期草稿' }, false, f.signal)).ok).toBe(false)
    expect((await second.execute({ operation: 'fill', control_id: secondInputId, value: '产品' }, false, f.signal)).ok).toBe(true)
    expect(draft).toBe('产品')
  } finally {
    for (const controller of controllers) controller.dispose()
    Object.defineProperty(globalThis, 'crypto', originalCrypto)
  }
})

test('捕获仅包含可见安全标签，隐藏、禁用、助手、秘密值和人工确认均不发送', () => {
  const f = fixture(), input = f.document.element('input', { 'aria-label': '分组名称' }) as InputFixture
  input.value = '不应发送的草稿值'
  f.page.append(input, f.document.element('input', { type: 'password', 'aria-label': '密码' }), f.document.element('input', { 'aria-label': '用户名' }), f.document.element('button', { disabled: '' }, '保存'), f.document.element('button', { style: 'display:none' }, '隐藏按钮'))
  const assistant = f.document.element('section', { class: 'assistant-page' }); assistant.append(f.document.element('button', {}, '发消息')); f.page.append(assistant)
  const context = f.controller.capture()
  expect(context.controls.map(item => item.label)).toEqual(['分组名称'])
  expect(JSON.stringify(context)).not.toContain(input.value)
  const message = f.document.element('div', { class: 'el-message-box' }); message.append(f.document.element('button', {}, '确认删除')); f.document.body.append(message)
  expect(f.controller.capture().controls).toEqual([])
  f.controller.dispose()
})

test('原生 setter 触发 input/change/blur，更新页面模型且不提交表单', async () => {
  const f = fixture(), input = f.document.element('input', { 'aria-label': '搜索分组' }) as InputFixture
  let draft = '', changes = 0, blurs = 0
  input.addEventListener('input', () => { draft = input.value }); input.addEventListener('change', () => { changes++ }); input.addEventListener('blur', () => { blurs++ })
  f.page.append(input)
  const id = control(f.controller.capture(), '搜索分组').id
  const result = await f.controller.execute({ operation: 'fill', control_id: id, value: '研发' }, false, f.signal)
  expect(result.ok).toBe(true); expect(draft).toBe('研发'); expect(changes).toBe(1); expect(blurs).toBe(1); expect(input.clicks).toBe(0)
  f.controller.dispose()
})

test('填写单价单位允许斜线和 token 字样，真实 token 凭证输入不捕获', () => {
  const f = fixture('/pricing')
  f.page.append(f.document.element('input', { 'aria-label': '输入（元/百万 token）' }), f.document.element('input', { 'aria-label': 'API token' }))
  expect(f.controller.capture().controls.map(item => item.label)).toEqual(['输入（元/百万 token）'])
  f.controller.dispose()
})

test('实际提交必须有本次写授权，点击结果不假称数据库已保存', async () => {
  const f = fixture(), save = f.document.element('button', { type: 'submit' }, '保存分组'); f.page.append(save)
  const id = control(f.controller.capture(), '保存分组').id
  expect((await f.controller.execute({ operation: 'click', control_id: id }, false, f.signal)).ok).toBe(false)
  expect(save.clicks).toBe(0)
  const accepted = await f.controller.execute({ operation: 'click', control_id: id }, true, f.signal)
  expect(accepted.ok).toBe(true); expect(save.clicks).toBe(1); expect(accepted.reason).toContain('已点击'); expect(accepted.reason).not.toContain('已保存')
  f.controller.dispose()
})

test('弹框或抽屉打开时只操作最高层草稿；成员角色改变使旧安全提交失效', async () => {
  const f = fixture('/members'), dialog = f.document.element('div', { class: 'el-dialog' }), form = f.document.element('form', { 'data-assistant-submit-safe': 'true' }), save = f.document.element('button', { type: 'submit' }, '保存资料')
  form.append(f.document.element('input', { 'aria-label': '姓名' }), f.document.element('input', { 'aria-label': '选择角色' }), save); dialog.append(form); f.document.body.append(dialog)
  f.page.append(f.document.element('button', {}, '后台刷新'))
  const context = f.controller.capture(); expect(context.controls.some(item => item.label === '后台刷新' || item.label === '选择角色')).toBe(false)
  const id = control(context, '保存资料').id
  form.setAttribute('data-assistant-submit-safe', 'false')
  expect((await f.controller.execute({ operation: 'click', control_id: id }, true, f.signal)).ok).toBe(false); expect(save.clicks).toBe(0)
  const drawer = f.document.element('div', { class: 'el-drawer', style: 'z-index:9000' }); drawer.append(f.document.element('button', {}, '关闭人员明细')); f.document.body.append(drawer)
  expect(f.controller.capture().controls.map(item => item.label)).toEqual(['关闭人员明细'])
  f.controller.dispose()
})

test('关联 body 下拉选项绑定原草稿；关闭重开后旧 ID 不得点击复用选项', async () => {
  const f = fixture(), dialog = f.document.element('div', { class: 'el-dialog' }), input = f.document.element('input', { 'aria-label': '选择分组', role: 'combobox', 'aria-controls': 'groups-list' })
  dialog.append(input); f.document.body.append(dialog)
  const popup = f.document.element('div', { class: 'el-popper', id: 'groups-list' }), option = f.document.element('li', { role: 'option' }, '研发组'); popup.append(option); f.document.body.append(popup)
  f.setForm({ resource: 'groups', operation: 'create' })
  const id = control(f.controller.capture(), '研发组').id
  f.setForm({ resource: 'groups', operation: 'create' })
  const result = await f.controller.execute({ operation: 'click', control_id: id }, false, f.signal)
  expect(result.ok).toBe(false); expect(result.reason).toContain('重开'); expect(option.clicks).toBe(0)
  expect(control(f.controller.capture(), '研发组').id).not.toBe(id)
  f.controller.dispose()
})

test('筛选下拉的“停用”选项是 read，服务端无写授权时仍可真实选中', async () => {
  const f = fixture(), select = f.document.element('input', { role: 'combobox', 'aria-label': '筛选分组状态', 'aria-controls': 'status-options' }) as InputFixture
  select.readOnly = true; f.page.append(select)
  const popup = f.document.element('div', { class: 'el-popper', id: 'status-options' }), disabledOption = f.document.element('li', { role: 'option' }, '停用')
  let selected = ''
  disabledOption.addEventListener('click', () => { selected = 'disabled' }); popup.append(disabledOption); f.document.body.append(popup)
  const captured = control(f.controller.capture(), '停用')
  expect(captured.effect).toBe('read')
  const result = await f.controller.execute({ operation: 'click', control_id: captured.id }, false, f.signal)
  expect(result.ok).toBe(true); expect(disabledOption.clicks).toBe(1); expect(selected).toBe('disabled')
  f.controller.dispose()
})

test('日期选值与启用状态排序不要求写授权，真实行状态开关仍要求写授权', async () => {
  const f = fixture(), date = f.document.element('input', { 'aria-label': '生效起点', 'aria-controls': 'date-options' }), popup = f.document.element('div', { class: 'el-popper el-picker-panel', id: 'date-options' }), choice = f.document.element('button', {}, '保存选择')
  popup.append(choice); f.page.append(date); f.document.body.append(popup)
  const table = f.document.element('table'), header = f.document.element('th'), cell = f.document.element('div', { class: 'cell' }, '启用'), sort = f.document.element('i', { class: 'sort-caret descending' }), body = f.document.element('tbody'), row = f.document.element('tr'), column = f.document.element('td'), state = f.document.element('input', { type: 'checkbox', 'aria-label': '启用规则' }) as InputFixture
  cell.append(sort); header.append(cell); column.append(state); row.append(column); body.append(row); table.append(header, body); f.page.append(table)
  const context = f.controller.capture(), dateChoice = control(context, '保存选择'), sorter = control(context, '启用降序'), stateToggle = control(context, '第 1 行 · 启用规则')
  expect(dateChoice.effect).toBe('read'); expect(sorter.effect).toBe('read'); expect(stateToggle.effect).toBe('write')
  expect((await f.controller.execute({ operation: 'click', control_id: dateChoice.id }, false, f.signal)).ok).toBe(true)
  expect((await f.controller.execute({ operation: 'click', control_id: sorter.id }, false, f.signal)).ok).toBe(true)
  expect((await f.controller.execute({ operation: 'toggle', control_id: stateToggle.id, value: true }, false, f.signal)).ok).toBe(false); expect(state.clicks).toBe(0)
  f.controller.dispose()
})

test('明确筛选容器内启用/停用复选与单选是 read，行状态不因外层筛选卡而降权', async () => {
  const f = fixture(), filter = f.document.element('form', { class: 'filter-form' }), checkbox = f.document.element('input', { type: 'checkbox', 'aria-label': '启用' }) as InputFixture, radio = f.document.element('input', { type: 'radio', 'aria-label': '停用' }) as InputFixture
  filter.append(checkbox, radio); f.page.append(filter)
  const table = f.document.element('table'), body = f.document.element('tbody'), row = f.document.element('tr'), cell = f.document.element('td'), state = f.document.element('input', { type: 'checkbox', 'aria-label': '停用规则' }) as InputFixture
  cell.append(state); row.append(cell); body.append(row); table.append(body); filter.append(table)
  const context = f.controller.capture(), enabledFilter = control(context, '启用'), disabledFilter = control(context, '停用')
  expect(enabledFilter.effect).toBe('read'); expect(disabledFilter.effect).toBe('read'); expect(control(context, '第 1 行 · 停用规则').effect).toBe('write')
  expect((await f.controller.execute({ operation: 'toggle', control_id: enabledFilter.id, value: true }, false, f.signal)).ok).toBe(true)
  expect((await f.controller.execute({ operation: 'toggle', control_id: disabledFilter.id, value: true }, false, f.signal)).ok).toBe(true)
  expect(checkbox.checked).toBe(true); expect(radio.checked).toBe(true)
  f.controller.dispose()
})

test('凭证交付弹框和复制秘密按钮不可寻址，appKey 写入始终由用户完成', () => {
  const f = fixture('/appkeys')
  f.page.append(f.document.element('button', {}, '发放 appKey'), f.document.element('button', {}, '复制凭证'), f.document.element('button', {}, '保存有效期'))
  expect(f.controller.capture().controls.map(item => item.label)).toEqual(['发放 appKey'])
  const dialog = f.document.element('div', { class: 'el-dialog' }), delivery = f.document.element('div', { class: 'appkey-delivery' })
  delivery.append(f.document.element('button', {}, '复制 appKey'), f.document.element('button', {}, '复制交付信息'), f.document.element('button', {}, '已保存，关闭')); dialog.append(delivery); f.document.body.append(dialog)
  expect(f.controller.capture().controls).toEqual([])
  f.controller.dispose()
})

test('切换遵循实际 checkbox/switch 事件与目标布尔值，单选不能直接取消', async () => {
  const f = fixture(), checkbox = f.document.element('input', { type: 'checkbox', 'aria-label': '只看当前生效' }) as InputFixture
  f.page.append(checkbox)
  const id = control(f.controller.capture(), '只看当前生效').id
  expect((await f.controller.execute({ operation: 'toggle', control_id: id, value: true }, false, f.signal)).ok).toBe(true)
  expect(checkbox.checked).toBe(true); expect(checkbox.clicks).toBe(1)
  await f.controller.execute({ operation: 'toggle', control_id: id, value: true }, false, f.signal); expect(checkbox.clicks).toBe(1)
  const switchRoot = f.document.element('div', { class: 'el-switch' }), switchInput = f.document.element('input', { type: 'checkbox', 'aria-label': '筛选生效', style: 'display:none' }) as InputFixture
  switchRoot.append(switchInput); switchRoot.addEventListener('click', () => { switchInput.checked = !switchInput.checked }); f.page.append(switchRoot)
  const switchId = control(f.controller.capture(), '筛选生效').id
  expect((await f.controller.execute({ operation: 'toggle', control_id: switchId, value: true }, false, f.signal)).ok).toBe(true)
  expect(switchRoot.clicks).toBe(1); expect(switchInput.clicks).toBe(0)
  const radio = f.document.element('input', { type: 'radio', 'aria-label': '供应商规则' }) as InputFixture; f.page.append(radio)
  expect((await f.controller.execute({ operation: 'toggle', control_id: control(f.controller.capture(), '供应商规则').id, value: false }, false, f.signal)).ok).toBe(false)
  f.controller.dispose()
})

test('80 控件预算优先保留筛选、表头排序和底部分页，大表不会挤掉翻页按钮', () => {
  const f = fixture(), table = f.document.element('table'), header = f.document.element('th'), cell = f.document.element('div', { class: 'cell' }, '姓名'), caret = f.document.element('i', { class: 'sort-caret ascending' }), body = f.document.element('tbody')
  cell.append(caret); header.append(cell); table.append(header, body)
  for (let row = 0; row < 100; row++) { const line = f.document.element('tr'), data = f.document.element('td'); for (const label of ['编辑', '停用', '删除']) data.append(f.document.element('button', {}, label)); line.append(data); body.append(line) }
  f.page.append(table, f.document.element('input', { 'aria-label': '搜索分组' }), f.document.element('button', {}, '下一页'))
  const context = f.controller.capture()
  expect(context.controls).toHaveLength(80); expect(context.controls.some(item => item.label === '搜索分组')).toBe(true); expect(context.controls.some(item => item.label === '下一页')).toBe(true); expect(context.controls.some(item => item.label === '姓名升序')).toBe(true)
  f.controller.dispose()
})

test('删除、换页、模型错指控件与取消均拒绝；只有助手导航显式更新页面绑定', async () => {
  const f = fixture(), button = f.document.element('button', {}, '刷新'); f.page.append(button)
  const id = control(f.controller.capture(), '刷新').id
  expect((await f.controller.execute({ operation: 'fill', control_id: id, value: '错误操作' }, false, f.signal)).ok).toBe(false)
  button.remove(); expect((await f.controller.execute({ operation: 'click', control_id: id }, false, f.signal)).ok).toBe(false)
  f.page.append(button); f.setPath('/projects')
  expect((await f.controller.execute({ operation: 'inspect' }, false, f.signal)).ok).toBe(false)
  f.controller.followNavigation(); const newId = control(f.controller.capture(), '刷新').id
  expect(newId).not.toBe(id)
  const cancelled = new AbortController(); cancelled.abort()
  expect((await f.controller.execute({ operation: 'click', control_id: newId }, false, cancelled.signal)).ok).toBe(false)
  expect(button.clicks).toBe(0); f.controller.dispose()
})

test('导航后立即 inspect 等目录加载结束，返回刚启用的新建按钮', async () => {
  const f = fixture(), create = f.document.element('button', { disabled: '' }, '添加分组'), loading = f.document.element('button', { class: 'is-loading', disabled: '' }, '刷新')
  f.page.append(create, loading)
  expect(f.controller.capture().controls).toEqual([])
  const timer = setTimeout(() => { create.removeAttribute('disabled'); loading.setAttribute('class', ''); loading.removeAttribute('disabled') }, 120)
  try {
    const result = await f.controller.execute({ operation: 'inspect' }, false, f.signal)
    expect(result.ok).toBe(true); expect(result.page_context?.controls.some(item => item.label === '添加分组')).toBe(true)
  } finally { clearTimeout(timer); f.controller.dispose() }
})

test('inspect 等待加载期间取消或用户切页，明确失败且不操作迟到按钮', async () => {
  for (const change of ['abort', 'navigate']) {
    const f = fixture(), loading = f.document.element('button', { class: 'is-loading' }, '刷新'), cancelled = new AbortController()
    f.page.append(loading)
    const timer = setTimeout(() => {
      if (change === 'abort') cancelled.abort()
      else { f.setPath('/projects'); loading.setAttribute('class', '') }
    }, 20)
    try {
      const result = await f.controller.execute({ operation: 'inspect' }, false, cancelled.signal)
      expect(result.ok).toBe(false); expect(result.reason).toContain(change === 'abort' ? '取消' : '切换'); expect(loading.clicks).toBe(0)
    } finally { clearTimeout(timer); f.controller.dispose() }
  }
})

test('表格只发送安全名称与行号，原始目录和凭证提示不发送且行复用让旧按钮失效', async () => {
  const f = fixture('/projects'), table = f.document.element('table'), header = f.document.element('thead'), names = f.document.element('th', { class: 'el-table_1_column_1' }, '归一化后的项目'), paths = f.document.element('th', { class: 'el-table_1_column_2' }, '仓库名 / 目录前缀'), body = f.document.element('tbody'), row = f.document.element('tr'), name = f.document.element('td', { class: 'el-table_1_column_1' }, '项目甲'), privateCell = f.document.element('td', { class: 'el-table_1_column_2' }, 'D:\\秘密目录\\项目 atr_secret_token_prefix'), actions = f.document.element('td'), edit = f.document.element('button', {}, '编辑')
  header.append(names, paths); table.append(header, body); row.append(name, privateCell, actions); actions.append(edit); body.append(row); f.page.append(table)
  const context = f.controller.capture(), id = control(context, '第 1 行（项目甲） · 编辑').id
  expect(JSON.stringify(context)).not.toContain('秘密目录'); expect(JSON.stringify(context)).not.toContain('token_prefix')
  privateCell.ownText = 'D:\\另一个目录\\同名项目'
  expect((await f.controller.execute({ operation: 'click', control_id: id }, false, f.signal)).ok).toBe(false)
  expect(edit.clicks).toBe(0); expect(control(f.controller.capture(), '第 1 行（项目甲） · 编辑').id).not.toBe(id)
  f.controller.dispose()
})

test('超过 512 个历史绑定会淘汰旧标识，重新出现的旧元素得到新 ID', async () => {
  const f = fixture(), original = f.document.element('button', {}, '原入口'), shelf = f.document.element('div')
  shelf.append(original); f.page.append(shelf)
  const oldId = control(f.controller.capture(), '原入口').id
  shelf.setAttribute('style', 'display:none')
  let batch: ElementFixture[] = []
  for (let round = 0; round < 7; round++) {
    for (const element of batch) element.remove()
    batch = Array.from({ length: 80 }, (_, index) => f.document.element('button', {}, `入口 ${round}-${index}`))
    f.page.append(...batch); expect(f.controller.capture().controls).toHaveLength(80)
  }
  for (const element of batch) element.remove()
  shelf.setAttribute('style', 'display:block')
  const newId = control(f.controller.capture(), '原入口').id
  expect(newId).not.toBe(oldId)
  expect((await f.controller.execute({ operation: 'click', control_id: oldId }, false, f.signal)).ok).toBe(false)
  expect(original.clicks).toBe(0); f.controller.dispose()
})

test('保存遇到可见校验错误只回报失败；删除打开人工确认不自动确认', async () => {
  const f = fixture(), save = f.document.element('button', { type: 'submit' }, '保存分组'), error = f.document.element('div', { class: 'el-form-item__error' }, '名称不能为空')
  save.addEventListener('click', () => f.page.append(error)); f.page.append(save)
  const response = await f.controller.execute({ operation: 'click', control_id: control(f.controller.capture(), '保存分组').id }, true, f.signal)
  expect(response.ok).toBe(false); expect(response.reason).toContain('校验'); expect(response.reason).not.toContain('名称不能为空')
  error.remove()
  const remove = f.document.element('button', {}, '删除'), confirmation = f.document.element('div', { class: 'el-message-box' }), confirm = f.document.element('button', {}, '确认删除')
  confirmation.append(confirm); remove.addEventListener('click', () => f.document.body.append(confirmation)); f.page.append(remove)
  const pending = await f.controller.execute({ operation: 'click', control_id: control(f.controller.capture(), '删除').id }, true, f.signal)
  expect(pending.ok).toBe(true); expect(pending.reason).toContain('人工确认'); expect(confirm.clicks).toBe(0); expect(pending.page_context?.controls).toEqual([])
  f.controller.dispose()
})

test('效果分类只把真实写入与立即启停标记为 write，填草稿和查询保持 read', () => {
  expect(assistantControlEffect('fill', '姓名', true, false)).toBe('read')
  expect(assistantControlEffect('click', '查询', false, true)).toBe('read')
  expect(assistantControlEffect('click', '保存单价', true, true)).toBe('write')
  expect(assistantControlEffect('toggle', '启用规则', false, false)).toBe('write')
  expect(assistantControlEffect('toggle', '只看当前生效', false, false)).toBe('read')
})
