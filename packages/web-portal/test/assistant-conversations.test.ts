/** 会话切换、网络流归属与等待队列必须在没有浏览器时也能钉住关键竞态。 */
import { expect, test } from 'bun:test'
import type { AssistantDetail, AssistantEvent, AssistantForm, AssistantSession, AssistantSessionPage } from '@ai-token-report/shared'
import type { ApiResult } from '../src/api/request.js'
import { createAssistantConversations, type AssistantConversationHooks } from '../src/utils/assistantConversations.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const session = (id: string, title = id): AssistantSession => ({ session_id: id, title, created_at_ms: 1, updated_at_ms: 2, turn_count: 1 })
const sessionPage = (sessions: AssistantSession[] = [], next_cursor: string | null = null, total = sessions.length): ApiResult<AssistantSessionPage> => ({ ok: true, data: { sessions, next_cursor, total } })
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function harness(overrides: Partial<AssistantConversationHooks> = {}) {
  const calls: Array<{ prompt: string; sessionId?: string; signal: AbortSignal; event: (event: AssistantEvent) => void; page?: string; files: File[]; result: ReturnType<typeof deferred<void>> }> = []
  const navigations: AssistantEvent[] = [], revoked: string[] = [], guided: string[][] = []
  const hooks: AssistantConversationHooks = {
    chat: (prompt, sessionId, signal, event, page, files = []) => {
      const result = deferred<void>()
      signal.addEventListener('abort', () => result.reject(new Error('aborted')), { once: true })
      calls.push({ prompt, sessionId, signal, event, page, files, result })
      return result.promise
    },
    detail: async id => ({ ok: true, data: { session: session(id), messages: [{ role: 'assistant', text: `历史:${id}` }] } }),
    sessions: async () => sessionPage(),
    steer: async (prompt, sessionId, runId) => { guided.push([prompt, sessionId, runId]) },
    navigate: event => { navigations.push(event) },
    revokePreview: url => { revoked.push(url) },
    ...overrides,
  }
  const controller = createAssistantConversations(hooks)
  function accept(index: number, id: string) { calls[index]!.event({ type: 'session', session: session(id), run_id: `run:${index}` }) }
  function finish(index: number) { calls[index]!.event({ type: 'done' }); calls[index]!.result.resolve() }
  return { controller, calls, navigations, revoked, guided, accept, finish }
}

test('上传尚未获得 session 也可以新建并返回；后台消息与新草稿各归原会话', async () => {
  const h = harness(), c = h.controller, original = c.current.value
  original.prompt = '第一轮'; original.pendingFiles.push({ id: 1, file: new File(['x'], '图.png'), preview: 'blob:upload' })
  const sending = c.submit('/overview')
  expect(original.uploading).toBe(true)
  expect(c.sessions.value[0]).toMatchObject({ session_id: original.key, local: true, title: '第一轮' })
  await c.open()
  const fresh = c.current.value
  fresh.prompt = '新会话的草稿'
  h.accept(0, '服务端第一轮')
  h.calls[0]!.event({ type: 'text', text: '后台回答' })
  h.calls[0]!.event({ type: 'navigate', path: '/records' })
  expect(c.current.value).toBe(fresh)
  expect(fresh.prompt).toBe('新会话的草稿')
  expect(fresh.messages).toHaveLength(0)
  expect(original.messages.at(-1)?.text).toBe('后台回答')
  expect(original.uploading).toBe(false)
  expect(h.revoked).toEqual(['blob:upload'])
  expect(c.sessions.value.some(item => item.session_id === '服务端第一轮')).toBe(true)
  expect(h.navigations).toHaveLength(0)
  await c.open('服务端第一轮')
  expect(c.current.value).toBe(original)
  h.calls[0]!.event({ type: 'navigate', path: '/records' })
  expect(h.navigations).toHaveLength(1)
  h.finish(0); await sending
  c.dispose()
})

test('运行时可编辑下一条草稿，session 事件不会清掉文字和附件', async () => {
  const h = harness(), c = h.controller, state = c.current.value
  state.prompt = '正在发送'
  const sending = c.submit()
  state.prompt = '新编辑的草稿'
  const file = new File(['正文'], '说明.md')
  state.pendingFiles.push({ id: 2, file })
  h.accept(0, '会话一')
  expect(state.prompt).toBe('新编辑的草稿')
  expect(state.pendingFiles[0]?.file).toBe(file)
  await c.open()
  await c.open('会话一')
  expect(c.current.value.prompt).toBe('新编辑的草稿')
  expect(c.current.value.pendingFiles[0]?.file).toBe(file)
  h.finish(0); await sending; c.dispose()
})

test('默认队列按会话 FIFO 捕获提交时的页面和附件，切换后继续原会话', async () => {
  const h = harness(), c = h.controller, first = c.current.value
  first.prompt = '第一条'
  const initial = c.submit('/overview'); h.accept(0, '会话一')
  first.prompt = '第二条'; first.pendingFiles.push({ id: 1, file: new File(['a'], '第二条.txt') })
  await c.submit('/analysis')
  first.prompt = '第三条'; await c.submit('/records')
  expect(first.queue.map(item => item.prompt)).toEqual(['第二条', '第三条'])
  expect(h.calls).toHaveLength(1)
  await c.open(); c.current.value.prompt = '另一会话'; const parallel = c.submit('/pricing'); h.accept(1, '会话二')
  expect(h.calls).toHaveLength(2)
  h.finish(0); await initial; await flush()
  expect(h.calls[2]).toMatchObject({ prompt: '第二条', sessionId: '会话一', page: '/analysis' })
  expect(h.calls[2]!.files[0]?.name).toBe('第二条.txt')
  h.accept(2, '会话一'); h.finish(2); await flush()
  expect(h.calls[3]).toMatchObject({ prompt: '第三条', sessionId: '会话一', page: '/records' })
  expect(c.current.value.sessionId).toBe('会话二')
  h.accept(3, '会话一'); h.finish(3); h.finish(1); await parallel; await flush(); c.dispose()
})

test('停止只影响选中会话，暂停队列，迟到流事件不再写入；继续按钮恢复队列', async () => {
  const h = harness(), c = h.controller, first = c.current.value
  first.prompt = '第一条'; const initial = c.submit(); h.accept(0, '会话一')
  first.prompt = '第二条'; await c.submit()
  await c.open(); c.current.value.prompt = '独立会话'; const parallel = c.submit(); h.accept(1, '会话二')
  await c.open('会话一'); c.stop()
  expect(h.calls[0]!.signal.aborted).toBe(true)
  expect(h.calls[1]!.signal.aborted).toBe(false)
  expect(first.sending).toBe(true)
  expect(first.queuePaused).toBe(true)
  h.calls[0]!.event({ type: 'text', text: '迟到文字' })
  expect(first.messages.at(-1)?.text).toBe('')
  await initial; await flush(); expect(first.sending).toBe(false); expect(h.calls).toHaveLength(2)
  const resumed = c.resume(); expect(h.calls[2]!.prompt).toBe('第二条')
  h.accept(2, '会话一'); h.finish(2); await resumed; h.finish(1); await parallel; c.dispose()
})

test('错误不自动继续；未接受的上传和后来编辑的草稿同时保留，移除队列释放预览', async () => {
  const h = harness(), c = h.controller, state = c.current.value
  state.prompt = '失败上传'; state.pendingFiles.push({ id: 1, file: new File(['x'], '图.png'), preview: 'blob:failed' })
  const sending = c.submit()
  state.prompt = '已排队'; await c.submit()
  state.prompt = '后来的草稿'
  h.calls[0]!.result.reject(new Error('附件解析失败'))
  await sending; await flush()
  expect(state.queue.map(item => item.prompt)).toEqual(['失败上传', '已排队'])
  expect(state.messages).toHaveLength(0)
  expect(state.prompt).toBe('后来的草稿')
  expect(state.error).toBe('附件解析失败')
  expect(state.queuePaused).toBe(true)
  expect(h.calls).toHaveLength(1)
  expect(h.revoked).toHaveLength(0)
  c.removeQueued(state.queue[0]!.id)
  expect(h.revoked).toEqual(['blob:failed'])
  c.dispose()
})

test('服务端接受后的 SSE 错误保留部分回答，暂停后续消息而不重发本轮', async () => {
  const h = harness(), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  state.prompt = '第二条'; await c.submit()
  h.calls[0]!.event({ type: 'text', text: '部分回答' })
  h.calls[0]!.event({ type: 'error', reason: '模型暂不可用' }); h.calls[0]!.result.resolve()
  await sending; await flush()
  expect(state.messages.at(-1)?.text).toBe('部分回答')
  expect(state.error).toBe('模型暂不可用')
  expect(state.queue.map(item => item.prompt)).toEqual(['第二条'])
  expect(state.queuePaused).toBe(true)
  expect(state.runId).toBeUndefined()
  c.dispose()
})

test('历史加载晚返回仍只写原会话，当前草稿和附件不受影响', async () => {
  const pending = deferred<ApiResult<AssistantDetail>>()
  const h = harness({ detail: () => pending.promise }), c = h.controller
  const loading = c.open('历史会话')
  const old = c.current.value
  expect(old.loading).toBe(true)
  await c.open(); const fresh = c.current.value
  fresh.prompt = '保留的新草稿'
  pending.resolve({ ok: true, data: { session: session('历史会话'), messages: [{ role: 'assistant', text: '历史回答' }] } })
  await loading
  expect(c.current.value).toBe(fresh)
  expect(fresh.prompt).toBe('保留的新草稿')
  expect(fresh.messages).toHaveLength(0)
  expect(old.messages[0]?.text).toBe('历史回答')
  await c.open('历史会话'); expect(c.current.value).toBe(old); c.dispose()
})

test('过期列表快照不能移除 session 事件刚加入的运行会话', async () => {
  const pending = deferred<ApiResult<AssistantSessionPage>>()
  const h = harness({ sessions: () => pending.promise }), c = h.controller
  const refreshing = c.refresh()
  c.current.value.prompt = '刚开始'; const sending = c.submit(); h.accept(0, '刚创建')
  pending.resolve(sessionPage()); await refreshing
  expect(c.sessions.value.map(item => item.session_id)).toContain('刚创建')
  h.finish(0); await sending; c.dispose()
})

test('会话列表默认每页 50 条，追加跨页去重且保留较新的元数据，到尾部停止加载', async () => {
  const rows = Array.from({ length: 123 }, (_, index) => ({ ...session(`会话:${index}`), updated_at_ms: 1000 - index }))
  const requests: Array<{ limit: number; cursor?: string }> = []
  const h = harness({ sessions: async params => {
    requests.push(params)
    if (!params.cursor) return sessionPage(rows.slice(0, 50), '第50条', 123)
    if (params.cursor === '第50条') return sessionPage([{ ...rows[49]!, title: '更新过的标题', turn_count: 2 }, ...rows.slice(50, 100)], '第100条', 123)
    return sessionPage(rows.slice(100), null, 123)
  } }), c = h.controller
  await c.refresh()
  expect(c.sessions.value).toHaveLength(50)
  expect(c.totalSessions.value).toBe(123)
  expect(c.hasMoreSessions.value).toBe(true)
  const page = c.loadMoreSessions()
  expect(c.loadMoreSessions()).toBe(page)
  await page
  expect(c.sessions.value).toHaveLength(100)
  expect(c.sessions.value.find(item => item.session_id === rows[49]!.session_id)?.title).toBe('更新过的标题')
  await c.loadMoreSessions(); await c.loadMoreSessions()
  expect(c.sessions.value).toHaveLength(123)
  expect(new Set(c.sessions.value.map(item => item.session_id)).size).toBe(123)
  expect(c.hasMoreSessions.value).toBe(false)
  expect(requests).toEqual([{ limit: 50 }, { limit: 50, cursor: '第50条' }, { limit: 50, cursor: '第100条' }])
  c.dispose()
})

test('刷新保留已加载旧会话与尾部边界，作废迟到分页后仍可从原游标重试', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ ...session(`会话:${index}`), updated_at_ms: 1000 - index }))
  const latePage = deferred<ApiResult<AssistantSessionPage>>()
  const requests: Array<{ limit: number; cursor?: string }> = []
  let firstPages = 0, lastPages = 0
  const h = harness({ sessions: async params => {
    requests.push(params)
    if (!params.cursor) return ++firstPages === 1 ? sessionPage(rows.slice(0, 50), '50', 120) : sessionPage([{ ...rows[0]!, updated_at_ms: 2000, title: '刷新后的标题' }, ...rows.slice(1, 50)], '刷新首屏50', 120)
    if (params.cursor === '50') return sessionPage(rows.slice(50, 100), '100', 120)
    return ++lastPages === 1 ? latePage.promise : sessionPage(rows.slice(100), null, 120)
  } }), c = h.controller
  await c.refresh(); await c.loadMoreSessions()
  const late = c.loadMoreSessions(); await flush()
  await c.refresh()
  expect(c.sessions.value).toHaveLength(100)
  expect(c.sessions.value[0]?.title).toBe('刷新后的标题')
  expect(c.loadingSessions.value).toBe(false)
  latePage.resolve(sessionPage(rows.slice(100), null, 120)); await late
  expect(c.sessions.value).toHaveLength(100)
  expect(c.hasMoreSessions.value).toBe(true)
  await c.loadMoreSessions()
  expect(c.sessions.value).toHaveLength(120)
  expect(requests.at(-1)).toEqual({ limit: 50, cursor: '100' })
  c.dispose()
})

test('已翻到末页后首屏刷新不会重开旧分页，本地草稿与新会话计数立即可见', async () => {
  const rows = Array.from({ length: 55 }, (_, index) => ({ ...session(`会话:${index}`), updated_at_ms: 1000 - index }))
  let firstPages = 0, requests = 0
  const h = harness({ sessions: async params => {
    requests++
    if (params.cursor) return sessionPage(rows.slice(50), null, 55)
    return ++firstPages === 1 ? sessionPage(rows.slice(0, 50), '50', 55) : sessionPage([{ ...session('新会话'), updated_at_ms: 2000 }, ...rows.slice(0, 49)], '新首屏50', 56)
  } }), c = h.controller
  await c.refresh(); await c.loadMoreSessions(); await c.refresh()
  expect(c.sessions.value).toHaveLength(56)
  expect(c.totalSessions.value).toBe(56)
  expect(c.hasMoreSessions.value).toBe(false)
  await c.loadMoreSessions(); expect(requests).toBe(3)
  c.current.value.prompt = '本地草稿'
  expect(c.totalSessions.value).toBe(57)
  const sending = c.submit(); h.accept(0, '刚创建的会话')
  expect(c.totalSessions.value).toBe(57)
  c.stop(); await sending; c.dispose()
})

test('首屏和后续页失败只显示列表错误；重试保持边界并抑制并发加载', async () => {
  const retry = deferred<ApiResult<AssistantSessionPage>>()
  const requests: Array<{ limit: number; cursor?: string }> = []
  const h = harness({ sessions: async params => {
    requests.push(params)
    if (requests.length === 1) return { ok: false, error: '首屏读取失败', status: 503 }
    if (requests.length === 2) return sessionPage([session('第一条')], '下一页', 2)
    if (requests.length === 3) throw new Error('后续页读取失败')
    return retry.promise
  } }), c = h.controller
  await c.refresh()
  expect(c.sessionsError.value).toBe('首屏读取失败')
  expect(c.current.value.error).toBe('')
  expect(c.loadingSessions.value).toBe(false)
  await c.loadMoreSessions()
  expect(requests[1]).toEqual({ limit: 50 })
  expect(c.sessionsError.value).toBe('')
  await c.loadMoreSessions()
  expect(c.sessions.value).toHaveLength(1)
  expect(c.sessionsError.value).toBe('后续页读取失败')
  expect(c.hasMoreSessions.value).toBe(true)
  const retrying = c.loadMoreSessions(), repeated = c.loadMoreSessions()
  expect(repeated).toBe(retrying)
  expect(c.loadingSessions.value).toBe(true)
  await flush(); expect(requests).toHaveLength(4)
  expect(requests.at(-1)).toEqual({ limit: 50, cursor: '下一页' })
  retry.resolve(sessionPage([session('第二条')], null, 2)); await retrying
  expect(c.sessionsError.value).toBe('')
  expect(c.loadingSessions.value).toBe(false)
  expect(c.hasMoreSessions.value).toBe(false)
  c.dispose()
})

for (const atEnd of [false, true]) test(`已有分页${atEnd ? '到末页' : '尚有尾页'}时首屏刷新失败，重试首屏且保留原尾部边界`, async () => {
  const rows = Array.from({ length: 110 }, (_, index) => ({ ...session(`会话:${index}`), updated_at_ms: 1000 - index }))
  const requests: Array<{ limit: number; cursor?: string }> = []
  let firstPages = 0
  const h = harness({ sessions: async params => {
    requests.push(params)
    if (params.cursor === '50') return sessionPage(rows.slice(50, 100), atEnd ? null : '100', 110)
    if (params.cursor === '100') return sessionPage(rows.slice(100), null, 110)
    if (++firstPages === 2) return { ok: false, error: '首屏刷新失败', status: 503 }
    return sessionPage(firstPages === 1 ? rows.slice(0, 50) : [{ ...rows[0]!, title: '重试刷新后的标题', updated_at_ms: 2000 }, ...rows.slice(1, 50)], firstPages === 1 ? '50' : '重试首屏50', 110)
  } }), c = h.controller
  await c.refresh(); await c.loadMoreSessions(); await c.refresh()
  expect(c.sessionsError.value).toBe('首屏刷新失败')
  const retry = c.loadMoreSessions()
  expect(c.loadMoreSessions()).toBe(retry)
  await retry
  expect(requests.at(-1)).toEqual({ limit: 50 })
  expect(c.sessionsError.value).toBe('')
  expect(c.sessions.value[0]?.title).toBe('重试刷新后的标题')
  expect(c.sessions.value).toHaveLength(100)
  expect(c.hasMoreSessions.value).toBe(!atEnd)
  await c.loadMoreSessions()
  if (atEnd) expect(requests).toHaveLength(4)
  else { expect(requests.at(-1)).toEqual({ limit: 50, cursor: '100' }); expect(c.sessions.value).toHaveLength(110) }
  c.dispose()
})

test('分页晚快照不能覆盖正在运行会话的较新 session 元数据', async () => {
  const pending = deferred<ApiResult<AssistantSessionPage>>()
  const h = harness({ sessions: async params => params.cursor ? pending.promise : sessionPage([session('旧会话')], '下一页', 2) }), c = h.controller
  await c.refresh()
  const paging = c.loadMoreSessions(); await flush()
  await c.open('运行会话')
  c.current.value.prompt = '新提问'; const sending = c.submit()
  h.calls[0]!.event({ type: 'session', session: { ...session('运行会话', '较新标题'), updated_at_ms: 2000, turn_count: 5 }, run_id: 'run:0' })
  pending.resolve(sessionPage([{ ...session('运行会话', '过期标题'), updated_at_ms: 1000, turn_count: 4 }, { ...session('运行会话', '同毫秒的旧标题'), updated_at_ms: 2000, turn_count: 5 }], null, 2)); await paging
  expect(c.sessions.value.find(item => item.session_id === '运行会话')).toMatchObject({ title: '较新标题', updated_at_ms: 2000, turn_count: 5 })
  expect(c.sessions.value).toHaveLength(2)
  expect(c.totalSessions.value).toBe(2)
  c.stop(); await sending; c.dispose()
})

test('新会话创建期间的尾页 total 已计入新会话时不会重复加一', async () => {
  const pending = deferred<ApiResult<AssistantSessionPage>>()
  const h = harness({ sessions: async params => params.cursor ? pending.promise : sessionPage([session('首屏')], '下一页', 100) }), c = h.controller
  await c.refresh()
  const paging = c.loadMoreSessions(); await flush()
  c.current.value.prompt = '新对话'; const sending = c.submit(); h.accept(0, '新会话')
  expect(c.totalSessions.value).toBe(101)
  pending.resolve(sessionPage([session('尾页')], '更旧页', 101)); await paging
  expect(c.totalSessions.value).toBe(101)
  c.stop(); await sending; c.dispose()
})

test('并发刷新只采用最新首屏，删除会话不会被迟到分页复活', async () => {
  const stale = deferred<ApiResult<AssistantSessionPage>>(), deletedPage = deferred<ApiResult<AssistantSessionPage>>()
  let calls = 0
  const h = harness({ sessions: async () => ++calls === 1 ? stale.promise : calls === 2 ? sessionPage([session('要删除'), session('保留')], '下一页', 3) : deletedPage.promise }), c = h.controller
  const older = c.refresh(); await flush()
  await c.refresh()
  stale.resolve(sessionPage([session('过时首屏')], null, 1)); await older
  expect(c.sessions.value.map(item => item.session_id)).not.toContain('过时首屏')
  const paging = c.loadMoreSessions(); await flush()
  c.forget('要删除')
  expect(c.totalSessions.value).toBe(2)
  deletedPage.resolve(sessionPage([session('要删除'), session('尾页')], null, 3)); await paging
  expect(c.sessions.value.map(item => item.session_id).sort()).toEqual(['保留', '尾页'])
  expect(c.totalSessions.value).toBe(2)
  c.dispose()
})

test('销毁后忽略迟到列表响应和列表重试，加载状态归零', async () => {
  const pending = deferred<ApiResult<AssistantSessionPage>>()
  let calls = 0
  const h = harness({ sessions: () => { calls++; return pending.promise } }), c = h.controller
  const refreshing = c.refresh(); await flush()
  expect(c.loadingSessions.value).toBe(true)
  c.dispose()
  expect(c.loadingSessions.value).toBe(false)
  pending.resolve(sessionPage([session('迟到会话')], '下一页', 10)); await refreshing
  await c.refresh(); await c.loadMoreSessions()
  expect(calls).toBe(1)
  expect(c.sessions.value).toHaveLength(0)
  expect(c.totalSessions.value).toBe(0)
  expect(c.hasMoreSessions.value).toBe(false)
})

test('引导带原 run ID，SSE 只记录一次；后续回答归引导后的 assistant 对象', async () => {
  const h = harness(), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  h.calls[0]!.event({ type: 'text', text: '原回答' })
  state.prompt = '改看本月'; await c.steer()
  expect(h.guided).toEqual([['改看本月', '会话', 'run:0']])
  expect(state.prompt).toBe('')
  expect(state.messages).toHaveLength(2)
  h.calls[0]!.event({ type: 'steering', text: '改看本月' })
  h.calls[0]!.event({ type: 'text', text: '，继续回答' })
  expect(state.messages.map(item => item.text)).toEqual(['第一条', '原回答', '改看本月', '，继续回答'])
  expect(state.messages[2]?.delivery).toBe('steer')
  state.prompt = '改看分组'; await c.submit(); const id = state.queue[0]!.id
  await c.steerQueued(id)
  expect(state.queue).toHaveLength(0)
  expect(h.guided.at(-1)).toEqual(['改看分组', '会话', 'run:0'])
  h.finish(0); await sending; c.dispose()
})

test('队列转引导先移出 FIFO，原轮结束期间不另投，成功后才继续下一条', async () => {
  const guidance = deferred<void>()
  const h = harness({ steer: () => guidance.promise }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  state.prompt = '要引导的消息'; await c.submit()
  state.prompt = '后续普通消息'; await c.submit()
  const guiding = c.steerQueued(state.queue[0]!.id)
  expect(state.queue.map(item => item.prompt)).toEqual(['后续普通消息'])
  h.finish(0); await sending; await flush()
  expect(h.calls).toHaveLength(1)
  guidance.resolve(); await guiding; await flush()
  expect(h.calls).toHaveLength(2)
  expect(h.calls[1]!.prompt).toBe('后续普通消息')
  h.accept(1, '会话'); h.finish(1); await flush(); c.dispose()
})

test('队列转引导失败后还原原位置并暂停，原轮结束不能重复投递该项', async () => {
  const guidance = deferred<void>()
  const h = harness({ steer: () => guidance.promise }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  for (const prompt of ['先排队', '要引导', '后排队']) { state.prompt = prompt; await c.submit() }
  const guiding = c.steerQueued(state.queue[1]!.id)
  h.finish(0); await sending
  guidance.reject(new Error('这一轮已结束')); await guiding; await flush()
  expect(state.queue.map(item => item.prompt)).toEqual(['先排队', '要引导', '后排队'])
  expect(state.queuePaused).toBe(true)
  expect(state.error).toBe('这一轮已结束')
  expect(h.calls).toHaveLength(1)
  c.dispose()
})

test('直接引导启动即收取草稿，等待回复时 Enter 不会把同文再次排队，新草稿仍保留', async () => {
  const guidance = deferred<void>()
  const h = harness({ steer: () => guidance.promise }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  state.prompt = '正在引导'; const guiding = c.steer()
  expect(state.prompt).toBe('')
  await c.submit(); expect(state.queue).toHaveLength(0)
  state.prompt = '新草稿'; state.pendingFiles.push({ id: 3, file: new File(['正文'], '新文件.md') })
  guidance.resolve(); await guiding
  expect(state.prompt).toBe('新草稿')
  expect(state.pendingFiles[0]?.file.name).toBe('新文件.md')
  h.finish(0); await sending; c.dispose()
})

test('直接引导失败保留原文字为暂停队列；后来输入的新草稿不会被覆盖', async () => {
  const guidance = deferred<void>()
  const h = harness({ steer: () => guidance.promise }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  state.prompt = '失败的引导'; const guiding = c.steer()
  state.prompt = '新的草稿'
  guidance.reject(new Error('引导提交失败')); await guiding
  expect(state.prompt).toBe('新的草稿')
  expect(state.queue.map(item => item.prompt)).toEqual(['失败的引导'])
  expect(state.queuePaused).toBe(true)
  c.stop(); await sending; c.dispose()
})

test('停止中断引导也还原已收取的草稿，不能把文字丢掉', async () => {
  const h = harness({ steer: (_prompt, _sessionId, _runId, signal) => new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }) }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit(); h.accept(0, '会话')
  state.prompt = '停止前的引导'; const guiding = c.steer()
  expect(state.prompt).toBe('')
  c.stop(); await Promise.all([sending, guiding])
  expect(state.prompt).toBe('停止前的引导')
  expect(state.queuePaused).toBe(true)
  expect(state.error).toBe('对话已停止')
  c.dispose()
})

test('尚未接收 session/run ID 或带附件时，引导保留原草稿，失败保留排队项', async () => {
  const h = harness({ steer: async () => { throw new Error('本轮已结束') } }), c = h.controller, state = c.current.value
  state.prompt = '第一条'; const sending = c.submit()
  state.prompt = '马上引导'; await c.steer()
  expect(state.prompt).toBe('马上引导')
  expect(state.error).toContain('尚未准备好')
  h.accept(0, '会话')
  state.pendingFiles.push({ id: 1, file: new File(['x'], '图.png') }); await c.steer()
  expect(state.attachmentError).toContain('仅支持文字')
  await c.submit(); const id = state.queue[0]!.id
  await c.steerQueued(id); expect(state.queue).toHaveLength(1)
  state.prompt = '文字引导'; await c.submit(); const textId = state.queue[1]!.id
  await c.steerQueued(textId)
  expect(state.error).toBe('本轮已结束')
  expect(state.queue).toHaveLength(2)
  h.finish(0); await sending; c.dispose()
})

test('销毁 abort 所有会话并释放草稿、队列与上传中的预览，之后流事件失效', async () => {
  const h = harness(), c = h.controller, first = c.current.value
  first.prompt = '上传'; first.pendingFiles.push({ id: 1, file: new File(['x'], '图.png'), preview: 'blob:upload' }); const one = c.submit()
  first.prompt = '排队'; first.pendingFiles.push({ id: 2, file: new File(['x'], '图.png'), preview: 'blob:queue' }); await c.submit()
  await c.open(); c.current.value.prompt = '另一会话'; const two = c.submit(); h.accept(1, '另一会话')
  c.current.value.pendingFiles.push({ id: 3, file: new File(['x'], '图.png'), preview: 'blob:draft' })
  c.dispose()
  expect(h.calls.every(item => item.signal.aborted)).toBe(true)
  expect(h.revoked.sort()).toEqual(['blob:draft', 'blob:queue', 'blob:upload'])
  h.calls[0]!.event({ type: 'text', text: '迟到事件' })
  expect(first.messages.at(-1)?.text).toBe('')
  await Promise.all([one, two])
})

const requestedForm: AssistantForm = { request_id: 'live-form', resource: 'groups', operation: 'create', path: '/groups', values: { name: '开发组' } }
test('表单只从选中会话的实时事件打开，读取历史和后台事件不会打开', async () => {
  const forms: AssistantForm[] = []
  const h = harness({ openForm: form => { forms.push(form) } }), c = h.controller, state = c.current.value
  await c.open('历史会话'); expect(forms).toHaveLength(0)
  await c.open(); c.current.value.prompt = '打开表单'
  const sending = c.submit(); h.accept(0, '实时会话')
  await c.open()
  h.calls[0]!.event({ type: 'open_form', form: requestedForm }); await flush(); expect(forms).toHaveLength(0)
  await c.open('实时会话')
  h.calls[0]!.event({ type: 'open_form', form: requestedForm }); await flush(); expect(forms).toEqual([requestedForm])
  h.finish(0); await sending; c.dispose()
})

test('切换会话取消尚未交付的表单，结束流后的表单失败仍显示在所属会话', async () => {
  const opening = deferred<void>(), signals: AbortSignal[] = []
  const h = harness({ openForm: (_form, signal) => { signals.push(signal); return opening.promise } }), c = h.controller
  c.current.value.prompt = '打开表单'; const sending = c.submit(); h.accept(0, '会话一')
  h.calls[0]!.event({ type: 'open_form', form: requestedForm }); await flush()
  expect(signals[0]?.aborted).toBe(false)
  await c.open(); expect(signals[0]?.aborted).toBe(true)
  opening.resolve(); await flush(); h.finish(0); await sending; c.dispose()

  const failure = deferred<void>()
  const retry = harness({ openForm: () => failure.promise }), d = retry.controller
  d.current.value.prompt = '打开表单'; const next = d.submit(); retry.accept(0, '失败会话')
  retry.calls[0]!.event({ type: 'open_form', form: requestedForm }); await flush()
  retry.finish(0); await next; failure.reject(new Error('已有正在填写的表单')); await flush()
  expect(d.current.value.error).toBe('已有正在填写的表单'); d.dispose()
})

test('保存成功刷新管理目录，准备确认和打开表单均不能触发保存刷新', async () => {
  let refreshes = 0
  const h = harness({ managementChanged: () => { refreshes++ } }), c = h.controller
  c.current.value.prompt = '保存规则'; const sending = c.submit(); h.accept(0, '会话')
  for (const tool of ['portal_open_form', 'portal_manage_mutate', 'portal_manage_save']) h.calls[0]!.event({ type: 'tool', tool, query: '', status: 202, state: 'completed' })
  expect(refreshes).toBe(0)
  h.calls[0]!.event({ type: 'tool', tool: 'portal_manage_save', query: '', status: 403, state: 'failed' }); expect(refreshes).toBe(0)
  h.calls[0]!.event({ type: 'tool', tool: 'portal_manage_save', query: '', status: 200, state: 'completed' }); expect(refreshes).toBe(1)
  h.finish(0); await sending; c.dispose()
})
