/**
 * 真实执行助手组件的按钮与回车发送入口：HTTP 部署没有 randomUUID，
 * 页面控制器的准备错误也必须显示给用户，并保留尚未提交的草稿。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { createSSRApp, type Component, type ComponentPublicInstance } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia, disposePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus'
import type { AssistantMessage, AssistantStatus } from '@ai-token-report/shared'

interface AssistantSetup {
  status: AssistantStatus | null
  prompt: string
  error: string
  canSend: boolean
  sending: boolean
  messages: AssistantMessage[]
  send: () => Promise<void>
  composerKeydown: (event: Event) => void
  conversations: { dispose: () => void }
}

const originalFetch = globalThis.fetch
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
const keyboardDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'KeyboardEvent')
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
let vite: ViteDevServer
let component: Component
const cleanups: (() => void)[] = []

beforeAll(async () => {
  vite = await createServer({
    root: resolve(import.meta.dir, '..'),
    base: '/ai-token/',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
  })
  component = (await vite.ssrLoadModule('/src/views/AssistantView.vue')).default
}, 20_000)

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  globalThis.fetch = originalFetch
  Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  if (keyboardDescriptor) Object.defineProperty(globalThis, 'KeyboardEvent', keyboardDescriptor)
  else Reflect.deleteProperty(globalThis, 'KeyboardEvent')
})
afterAll(async () => { await vite?.close() })

async function assistant() {
  const pinia = createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/groups', component: { render: () => null } }] })
  await router.push('/groups')
  let setup: AssistantSetup | undefined
  const app = createSSRApp(component, { floating: true }).use(pinia).use(router)
    .provide(ID_INJECTION_KEY, { prefix: 100, current: 0 })
    .provide(ZINDEX_INJECTION_KEY, { current: 0 })
  app.mixin({ created(this: ComponentPublicInstance) {
    const state = (this.$ as unknown as { setupState: Partial<AssistantSetup> }).setupState
    if (typeof state.send === 'function' && typeof state.composerKeydown === 'function') setup = state as AssistantSetup
  } })
  // SSR 不触发 onMounted，因而不访问线上 status；仍使用 SFC 编译后的真实 setup 与事件函数。
  await renderToString(app)
  if (!setup) throw new Error('未捕获助手组件的 setup 状态')
  const state = setup
  cleanups.push(() => { state.conversations.dispose(); disposePinia(pinia) })
  state.status = { enabled: true, supports_images: true, supports_steering: true }
  return state
}

function httpCrypto(random: typeof getRandomValues = getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: random } })
  expect(typeof globalThis.crypto.randomUUID).toBe('undefined')
}

function responses() {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url, init) => {
    if (String(url).startsWith('/ai-token/api/v1/assistant/sessions?')) {
      return Response.json({ sessions: [], total: 0, next_cursor: null })
    }
    if (String(url) !== '/ai-token/api/v1/assistant/chat') throw new Error(`未预期的请求：${String(url)}`)
    requests.push({ url: String(url), init: init!, body: JSON.parse(init!.body as string) })
    const session = { session_id: '测试私有会话', title: '测试发送', created_at_ms: 1, updated_at_ms: 1, turn_count: 1 }
    return new Response([
      { type: 'session', session }, { type: 'text', text: '已收到问题' }, { type: 'done' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  return requests
}

test('HTTP 环境的发送按钮入口仍请求 chat，并显示完整 SSE 回答', async () => {
  const state = await assistant(), requests = responses()
  httpCrypto()
  state.prompt = '查询分组目录，用表格展示名称和状态。'
  expect(state.canSend).toBe(true)
  await state.send()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.init.method).toBe('POST')
  expect(requests[0]!.init.credentials).toBe('same-origin')
  expect(requests[0]!.body).toEqual({ prompt: '查询分组目录，用表格展示名称和状态。', page: '/groups', page_context: { path: '/groups', controls: [] } })
  expect(state.messages.map(message => [message.role, message.text])).toEqual([
    ['user', '查询分组目录，用表格展示名称和状态。'], ['assistant', '已收到问题'],
  ])
  expect(state.prompt).toBe('')
  expect(state.error).toBe('')
  expect(state.sending).toBe(false)
})

test('HTTP 环境按 Enter 调用组件的同一发送入口', async () => {
  const state = await assistant(), requests = responses()
  httpCrypto()
  class KeyboardFixture extends Event {
    key = 'Enter'; altKey = false; isComposing = false; keyCode = 13; repeat = false
  }
  Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: KeyboardFixture })
  state.prompt = '看看用量'
  const event = new KeyboardFixture('keydown', { cancelable: true })
  state.composerKeydown(event)
  await Bun.sleep(0)
  expect(event.defaultPrevented).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body.prompt).toBe('看看用量')
  expect(state.messages.at(-1)?.text).toBe('已收到问题')
  expect(state.sending).toBe(false)
})

test('发送准备异常显示错误并保留草稿；恢复后可重新发送', async () => {
  const state = await assistant(), requests = responses()
  state.prompt = '保留这条待发送消息'
  httpCrypto(() => { throw new Error('模拟页面控制器准备失败') })
  await state.send()
  expect(requests).toHaveLength(0)
  expect(state.prompt).toBe('保留这条待发送消息')
  expect(state.messages).toEqual([])
  expect(state.error).toContain('消息未能发送')
  expect(state.canSend).toBe(true)
  expect(state.sending).toBe(false)
  httpCrypto()
  await state.send()
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body.prompt).toBe('保留这条待发送消息')
  expect(state.prompt).toBe('')
  expect(state.error).toBe('')
  expect(state.messages.at(-1)?.text).toBe('已收到问题')
})
