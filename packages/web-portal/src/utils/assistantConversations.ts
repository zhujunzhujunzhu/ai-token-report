/**
 * 助手面板的会话生命周期：编辑区、消息流与等待队列都归属于稳定的本地会话。
 * ★ 切换面板只改变选择；网络回调始终写入启动请求时的会话，避免后台回答串到新对话。
 */
import { computed, markRaw, reactive, ref, watch } from 'vue'
import { ASSISTANT_SESSION_PAGE_SIZE } from '@ai-token-report/shared'
import type { AssistantArtifact, AssistantDetail, AssistantEvent, AssistantForm, AssistantMessage, AssistantPendingAction, AssistantSession, AssistantSessionPage, AssistantToolEvent } from '@ai-token-report/shared'
import type { ApiResult } from '../api/request.js'
import { finishAssistantTools, recordAssistantTool } from './assistantActivity.js'
import { assistantAttachmentKind } from './assistantAttachments.js'

export interface AssistantPendingFile { id: number; file: File; preview?: string }
export interface AssistantQueuedMessage {
  id: number
  prompt: string
  files: AssistantPendingFile[]
  page?: string
}
export interface AssistantConversationState {
  key: string
  sessionId?: string
  runId?: string
  messages: AssistantMessage[]
  sources: AssistantToolEvent[]
  prompt: string
  pendingFiles: AssistantPendingFile[]
  attachmentError: string
  error: string
  loading: boolean
  sending: boolean
  uploading: boolean
  steering: boolean
  queuePaused: boolean
  queue: AssistantQueuedMessage[]
}
export type AssistantConversationSession = AssistantSession & { local?: boolean }
type NavigationEvent = Extract<AssistantEvent, { type: 'navigate' }>
export interface AssistantConversationHooks {
  chat: (prompt: string, sessionId: string | undefined, signal: AbortSignal, onEvent: (event: AssistantEvent) => void, page?: string, files?: File[]) => Promise<void>
  detail: (id: string) => Promise<ApiResult<AssistantDetail>>
  sessions: (params: { limit: number; cursor?: string }) => Promise<ApiResult<AssistantSessionPage>>
  steer?: (prompt: string, sessionId: string, runId: string, signal: AbortSignal) => Promise<void>
  navigate?: (event: NavigationEvent) => void | Promise<void>
  openForm?: (form: AssistantForm, signal: AbortSignal) => void | Promise<void>
  managementChanged?: () => void
  revokePreview?: (url: string) => void
}
interface Run {
  item: AssistantQueuedMessage
  user: AssistantMessage
  reply: AssistantMessage
  controller: AbortController
  accepted: boolean
  terminal: boolean
  failed: boolean
}

export function createAssistantConversations(hooks: AssistantConversationHooks) {
  let sequence = 0, queueSequence = 0, disposed = false, refreshVersion = 0, sessionMutationVersion = 0
  let sessionsInitialized = false, sessionsPaged = false, nextSessionCursor: string | null = null
  let sessionsFailedMode: 'refresh' | 'more' | undefined
  let sessionsRequest: Promise<void> | undefined
  const conversations = reactive<AssistantConversationState[]>([])
  const selected = ref('')
  const savedSessions = ref<AssistantSession[]>([])
  const loadingSessions = ref(false), hasMoreSessions = ref(false), sessionsError = ref(''), serverSessionTotal = ref(0)
  const addedSessions = new Map<string, number>(), updatedSessions = new Map<string, number>(), forgottenSessions = new Map<string, number>()
  const runs = new Map<string, Run>()
  const loads = new Map<string, Promise<void>>()
  const loaded = new Set<string>()
  const steeringControllers = new Map<string, AbortController>()
  const formControllers = new Set<AbortController>()
  const current = computed(() => conversations.find(item => item.key === selected.value)!)
  const active = computed(() => current.value.sessionId ?? current.value.key)
  const sessions = computed<AssistantConversationSession[]>(() => {
    const local = conversations.filter(item => !item.sessionId && (item.sending || item.messages.length || item.queue.length || item.prompt.trim() || item.pendingFiles.length)).map(item => ({
      session_id: item.key, title: item.messages.find(message => message.role === 'user')?.text || item.queue[0]?.prompt || item.prompt.trim() || '新对话',
      created_at_ms: 0, updated_at_ms: 0, turn_count: 0, local: true,
    }))
    return [...local, ...savedSessions.value]
  })
  const totalSessions = computed(() => Math.max(serverSessionTotal.value, savedSessions.value.length) + sessions.value.filter(item => item.local).length)

  function create(sessionId?: string): AssistantConversationState {
    const state = reactive<AssistantConversationState>({ key: `local:${++sequence}`, sessionId, messages: [], sources: [], prompt: '', pendingFiles: [], attachmentError: '', error: '', loading: false, sending: false, uploading: false, steering: false, queuePaused: false, queue: [] })
    conversations.push(state)
    return state
  }
  function sessionState(id: string): AssistantConversationState | undefined {
    return conversations.find(item => item.sessionId === id || item.key === id)
  }
  function alive(state: AssistantConversationState): boolean { return !disposed && conversations.includes(state) }
  function release(files: AssistantPendingFile[]): void {
    for (const item of files) if (item.preview) {
      ;(hooks.revokePreview ?? (url => URL.revokeObjectURL(url)))(item.preview)
      item.preview = undefined
    }
  }
  function mergeSessions(incoming: AssistantSession[], mutationVersion = Number.POSITIVE_INFINITY): void {
    const merged = new Map(savedSessions.value.map(item => [item.session_id, item]))
    for (const item of incoming) {
      if (forgottenSessions.has(item.session_id)) continue
      const previous = merged.get(item.session_id)
      // 列表与历史请求可能先于 SSE 快照：相同时间戳也不能降低已知轮次数。
      const changedDuringRequest = (updatedSessions.get(item.session_id) ?? 0) > mutationVersion
      if (!previous || item.updated_at_ms > previous.updated_at_ms || (item.updated_at_ms === previous.updated_at_ms && (item.turn_count > previous.turn_count || (item.turn_count === previous.turn_count && !changedDuringRequest)))) merged.set(item.session_id, item)
    }
    savedSessions.value = [...merged.values()].sort((a, b) => b.updated_at_ms - a.updated_at_ms || (a.session_id < b.session_id ? 1 : a.session_id > b.session_id ? -1 : 0))
  }
  function upsertSession(session: AssistantSession, created = false): void {
    if (forgottenSessions.has(session.session_id)) return
    updatedSessions.set(session.session_id, ++sessionMutationVersion)
    if (created && !savedSessions.value.some(item => item.session_id === session.session_id)) {
      addedSessions.set(session.session_id, sessionMutationVersion)
      serverSessionTotal.value++
    }
    mergeSessions([session])
  }
  function requestSessions(more: boolean): Promise<void> {
    if (disposed) return Promise.resolve()
    if (more && loadingSessions.value) return sessionsRequest ?? Promise.resolve()
    if (more && sessionsInitialized && !nextSessionCursor) return Promise.resolve()
    const append = more && sessionsInitialized
    const cursor = append ? nextSessionCursor! : undefined
    const version = ++refreshVersion, mutationVersion = sessionMutationVersion
    loadingSessions.value = true; sessionsError.value = ''; sessionsFailedMode = undefined
    // 首屏刷新使旧分页请求失效，但不重置已经走过的尾部游标；重试仍从原边界接续。
    const pending = Promise.resolve().then(async () => {
      if (disposed || version !== refreshVersion) return
      try {
        const result = await hooks.sessions({ limit: ASSISTANT_SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
        if (disposed || version !== refreshVersion) return
        if (!result.ok) { sessionsError.value = result.error; sessionsFailedMode = append ? 'more' : 'refresh'; return }
        mergeSessions(result.data.sessions, mutationVersion)
        const receivedIds = new Set(result.data.sessions.map(item => item.session_id))
        const newDuringRequest = [...addedSessions].filter(([id, mutation]) => mutation > mutationVersion && !receivedIds.has(id) && !forgottenSessions.has(id)).length
        const removedDuringRequest = [...forgottenSessions.values()].filter(mutation => mutation > mutationVersion).length
        // 新会话应在首屏；尾页本来就看不到它，不能把已经含它的 total 再加一遍。
        serverSessionTotal.value = Math.max(serverSessionTotal.value, result.data.total + (append ? 0 : newDuringRequest) - removedDuringRequest)
        // 已加载旧会话保留在列表里；首屏更新不能把尾部拉回第一页，更不能重开已到尽头的分页。
        if (append || !sessionsInitialized || !sessionsPaged) nextSessionCursor = result.data.next_cursor
        if (append) sessionsPaged = true
        sessionsInitialized = true; hasMoreSessions.value = nextSessionCursor !== null
      } catch (err) {
        if (!disposed && version === refreshVersion) { sessionsError.value = reason(err, '无法读取对话列表'); sessionsFailedMode = append ? 'more' : 'refresh' }
      }
      finally { if (!disposed && version === refreshVersion) { loadingSessions.value = false; sessionsRequest = undefined } }
    })
    sessionsRequest = pending
    return pending
  }
  function refresh(): Promise<void> { return requestSessions(false) }
  // 视口的重试与触底共用入口：失败的是首屏刷新时必须重试首屏，不能误消费尾页游标。
  function loadMoreSessions(): Promise<void> { return requestSessions(sessionsFailedMode !== 'refresh') }
  async function open(id?: string): Promise<void> {
    if (disposed) return
    const state = id ? sessionState(id) ?? create(id) : create()
    selected.value = state.key
    if (!id || !state.sessionId || loaded.has(state.key) || state.sending) return
    const existing = loads.get(state.key)
    if (existing) return existing
    state.loading = true
    const promise = (async () => {
      try {
        const result = await hooks.detail(state.sessionId!)
        if (!alive(state)) return
        if (result.ok) { state.messages = result.data.messages; upsertSession(result.data.session); loaded.add(state.key) }
        else state.error = result.error
      } catch (err) { if (alive(state)) state.error = reason(err, '无法读取对话') }
      finally { if (alive(state)) state.loading = false; loads.delete(state.key) }
    })()
    loads.set(state.key, promise)
    return promise
  }
  function snapshot(state: AssistantConversationState, page?: string): AssistantQueuedMessage | undefined {
    const prompt = state.prompt.trim()
    if (!prompt && !state.pendingFiles.length) return undefined
    const item = { id: ++queueSequence, prompt, files: state.pendingFiles, page }
    state.prompt = ''; state.pendingFiles = []; state.attachmentError = ''
    return item
  }
  function updateAction(action: AssistantPendingAction, state = current.value): void {
    for (const message of state.messages) {
      const index = message.actions?.findIndex(item => item.action_id === action.action_id) ?? -1
      if (index >= 0) message.actions![index] = action
    }
  }
  function updateArtifact(artifact: AssistantArtifact, state = current.value): void {
    for (const message of state.messages) {
      const index = message.artifacts?.findIndex(item => item.artifact_id === artifact.artifact_id) ?? -1
      if (index >= 0) message.artifacts![index] = artifact
    }
  }
  function receive(state: AssistantConversationState, run: Run, event: AssistantEvent): void {
    if (!alive(state) || runs.get(state.key) !== run || run.controller.signal.aborted) return
    if (event.type === 'session') {
      const created = !state.sessionId
      state.sessionId = event.session.session_id
      state.runId = 'run_id' in event && typeof event.run_id === 'string' ? event.run_id : undefined
      run.accepted = true; state.uploading = false; loaded.add(state.key)
      release(run.item.files); upsertSession(event.session, created)
    } else if (event.type === 'attachments') run.user.attachments = event.attachments
    else if (event.type === 'text') run.reply.text += event.text
    else if (event.type === 'result') (run.reply.results ??= []).push(event.result)
    else if (event.type === 'action') {
      const actions = run.reply.actions ??= []
      const index = actions.findIndex(item => item.action_id === event.action.action_id)
      if (index >= 0) actions[index] = event.action
      else actions.push(event.action)
      updateAction(event.action, state)
    } else if (event.type === 'artifact') {
      const artifacts = run.reply.artifacts ??= []
      const index = artifacts.findIndex(item => item.artifact_id === event.artifact.artifact_id)
      if (index >= 0) artifacts[index] = event.artifact
      else artifacts.push(event.artifact)
      updateArtifact(event.artifact, state)
    } else if (event.type === 'tool') {
      recordAssistantTool(state.sources, event)
      if (['portal_manage_mutate', 'portal_manage_save'].includes(event.tool) && event.state === 'completed' && event.status < 400 && event.status !== 202) hooks.managementChanged?.()
    } else if (event.type === 'error') { run.failed = true; run.terminal = true; state.error = event.reason }
    else if (event.type === 'done') run.terminal = true
    else if (event.type === 'steering') {
      state.messages.push({ role: 'user', text: event.text, delivery: 'steer' })
      run.reply = reactive<AssistantMessage>({ role: 'assistant', text: '' })
      state.messages.push(run.reply)
    }
    else if (event.type === 'navigate' && selected.value === state.key && hooks.navigate) {
      // 后台任务可以更新自己的内容，但不能把用户正在操作的页面抢走。
      try { void Promise.resolve(hooks.navigate(event)).catch(err => { if (alive(state) && runs.get(state.key) === run) state.error = reason(err, '页面跳转失败') }) }
      catch (err) { state.error = reason(err, '页面跳转条件无效') }
    }
    else if (event.type === 'open_form' && selected.value === state.key && hooks.openForm) {
      // 表单属于当前实时请求；切到其它会话或停止后，迟到交付必须取消。
      const controller = new AbortController(), abort = () => controller.abort()
      formControllers.add(controller)
      const stopWatching = watch(selected, key => { if (key !== state.key) abort() }, { flush: 'sync' })
      run.controller.signal.addEventListener('abort', abort, { once: true })
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) return hooks.openForm!(event.form, controller.signal)
      }).catch(err => {
        // 打开表单可能晚于 SSE done；仍应把真实失败交给所属会话，不能静默丢弃。
        if (!controller.signal.aborted && alive(state) && (!runs.has(state.key) || runs.get(state.key) === run)) state.error = reason(err, '打开填写表单失败')
      }).finally(() => { formControllers.delete(controller); stopWatching(); run.controller.signal.removeEventListener('abort', abort) })
    }
  }
  function finish(state: AssistantConversationState, run: Run): void {
    if (!alive(state) || runs.get(state.key) !== run) return
    if (!run.accepted) {
      state.messages = state.messages.filter(message => message !== run.user && message !== run.reply)
      // 本轮未入库时保留完整待发附件；后续编辑的草稿仍留在编辑区，不相互覆盖。
      state.queue.unshift(run.item)
    } else release(run.item.files)
    finishAssistantTools(state.sources)
    runs.delete(state.key); state.sending = false; state.uploading = false; state.runId = undefined
    if (run.failed || run.controller.signal.aborted) state.queuePaused = true
  }
  async function startNext(state: AssistantConversationState): Promise<void> {
    if (!alive(state) || state.sending || state.steering || state.loading || state.queuePaused || !state.queue.length) return
    const item = state.queue.shift()!
    const user = reactive<AssistantMessage>({ role: 'user', text: item.prompt || '请分析附件', ...(item.files.length ? { attachments: item.files.map(({ file }) => ({ attachment_id: '', file_name: file.name, media_type: file.type, size_bytes: file.size, kind: assistantAttachmentKind(file.name)! })) } : {}) })
    const reply = reactive<AssistantMessage>({ role: 'assistant', text: '' })
    const run: Run = { item, user, reply, controller: markRaw(new AbortController()), accepted: false, terminal: false, failed: false }
    runs.set(state.key, run); state.sending = true; state.uploading = !!item.files.length; state.error = ''; state.sources = []
    state.messages.push(user, reply)
    try {
      await hooks.chat(item.prompt, state.sessionId, run.controller.signal, event => receive(state, run, event), item.page, item.files.map(file => file.file))
      if (!run.terminal && !run.controller.signal.aborted) throw new Error('助手连接中断，请重新打开会话查看已保存的回答')
    } catch (err) {
      if (alive(state) && runs.get(state.key) === run) { run.failed = true; state.error = run.controller.signal.aborted ? '对话已停止' : reason(err, '助手请求失败') }
    } finally {
      if (alive(state) && runs.get(state.key) === run) {
        finish(state, run)
        void refresh()
        if (!state.queuePaused) void startNext(state)
      }
    }
  }
  function submit(page?: string): Promise<void> {
    const state = current.value
    if (disposed || state.loading) return Promise.resolve()
    const item = snapshot(state, page)
    if (!item) return Promise.resolve()
    state.queue.push(item)
    // 只有显式继续才解除“停止/失败”的暂停，排队提交不会悄悄重开被停止的任务。
    return startNext(state)
  }
  function removeQueued(id: number): void {
    const state = current.value, index = state.queue.findIndex(item => item.id === id)
    if (index >= 0) release(state.queue.splice(index, 1)[0]!.files)
  }
  function resume(): Promise<void> {
    const state = current.value
    state.queuePaused = false
    return startNext(state)
  }
  function stop(id = active.value): void {
    const state = sessionState(id)
    if (!state) return
    state.queuePaused = true
    const run = runs.get(state.key)
    // 请求完成清理前仍显示停止中，避免“继续发送”立刻撞上服务端尚未释放的会话锁。
    if (run) { run.controller.abort(); state.error = '对话已停止' }
    steeringControllers.get(state.key)?.abort()
  }
  async function guide(state: AssistantConversationState, item: AssistantQueuedMessage, onStart?: () => void): Promise<boolean> {
    if (!state.sending || !state.sessionId || !state.runId || !hooks.steer || runs.get(state.key)?.controller.signal.aborted) { state.error = '当前对话尚未准备好接收引导，请稍后重试或排队发送'; return false }
    if (item.files.length || !item.prompt) { state.attachmentError = '立即引导仅支持文字，附件请排队发送'; return false }
    if (state.steering) return false
    const controller = markRaw(new AbortController())
    steeringControllers.set(state.key, controller); state.steering = true; state.error = ''
    onStart?.()
    try {
      await hooks.steer(item.prompt, state.sessionId, state.runId, controller.signal)
      return alive(state) && !controller.signal.aborted
    } catch (err) {
      if (alive(state) && !controller.signal.aborted) { state.queuePaused = true; state.error = reason(err, '引导发送失败，请重试') }
      return false
    }
    finally { if (steeringControllers.get(state.key) === controller) { steeringControllers.delete(state.key); state.steering = false } }
  }
  async function steer(page?: string): Promise<void> {
    const state = current.value, prompt = state.prompt, files = state.pendingFiles
    const item: AssistantQueuedMessage = { id: ++queueSequence, prompt: prompt.trim(), files, page }
    let taken = false
    const success = await guide(state, item, () => { taken = true; state.prompt = ''; state.pendingFiles = []; state.attachmentError = '' })
    if (success) void startNext(state)
    else if (taken && alive(state)) {
      // 引导期间仍可编辑、排队：失败恢复原消息时不能覆盖后来输入的新草稿。
      if (!state.prompt && !state.pendingFiles.length) { state.prompt = prompt; state.pendingFiles = files }
      else { state.queue.unshift(item); state.queuePaused = true }
    }
  }
  async function steerQueued(id: number): Promise<void> {
    const state = current.value, index = state.queue.findIndex(item => item.id === id)
    if (index < 0) return
    const item = state.queue[index]!
    if (state.steering || item.files.length || !state.sending || !state.runId) { await guide(state, item); return }
    // 引导请求与本轮结束可同时发生，先从 FIFO 取出才不会把同一条消息投递两遍。
    state.queue.splice(index, 1)
    if (await guide(state, item)) { release(item.files); void startNext(state) }
    else if (alive(state)) { state.queue.splice(Math.min(index, state.queue.length), 0, item); state.queuePaused = true }
  }
  function releaseState(state: AssistantConversationState): void {
    runs.get(state.key)?.controller.abort(); steeringControllers.get(state.key)?.abort()
    release(state.pendingFiles)
    for (const item of state.queue) release(item.files)
    const run = runs.get(state.key)
    if (run) release(run.item.files)
    runs.delete(state.key); steeringControllers.delete(state.key); loaded.delete(state.key)
    state.sending = false; state.uploading = false; state.steering = false; state.runId = undefined
  }
  function forget(id: string): void {
    const state = sessionState(id)
    if (state) { releaseState(state); conversations.splice(conversations.indexOf(state), 1); if (selected.value === state.key) selected.value = create().key }
    if (savedSessions.value.some(item => item.session_id === id)) {
      forgottenSessions.set(id, ++sessionMutationVersion)
      serverSessionTotal.value = Math.max(0, serverSessionTotal.value - 1)
    }
    savedSessions.value = savedSessions.value.filter(item => item.session_id !== id)
  }
  function dispose(): void {
    disposed = true; refreshVersion++; loadingSessions.value = false; sessionsRequest = undefined
    for (const controller of formControllers) controller.abort()
    for (const state of conversations) releaseState(state)
  }
  selected.value = create().key
  return { current, active, sessions, loadingSessions, hasMoreSessions, sessionsError, totalSessions, conversations: computed(() => conversations), open, refresh, loadMoreSessions, submit, steer, steerQueued, removeQueued, resume, stop, dispose, sessionState, forget, updateAction, updateArtifact }
}

function reason(err: unknown, fallback: string): string { return err instanceof Error ? err.message : fallback }
