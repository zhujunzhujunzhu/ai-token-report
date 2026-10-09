/** 部门助手 HTTP 边界：按当前登录人员隔离空间，整个运行期间保持用户单写者锁。 */
import { ASSISTANT_PAGES, type AssistantEvent, type AssistantResult } from '@ai-token-report/shared'
import { IdentityError, type IdentityRepository } from './identity/index.js'
import { authorizeDatabase, type Authentication } from './http/auth.js'
import { AssistantStore } from './assistant/store.js'
import type { AssistantEngine } from './assistant/runtime.js'

export class AssistantRoute {
  private busy = new Set<string>()
  private controllers = new Set<AbortController>()
  private tasks = new Set<Promise<void>>()
  private cleanup: ReturnType<typeof setInterval> | undefined
  constructor(private identity: IdentityRepository, readonly store: AssistantStore, private engine?: AssistantEngine) {
    if (engine) {
      const prune = () => { void store.prune(this.busy).catch(() => console.warn('[assistant] 过期会话清理失败')) }
      prune()
      this.cleanup = setInterval(prune, 3_600_000)
      this.cleanup.unref()
    }
  }
  async close(): Promise<void> {
    clearInterval(this.cleanup)
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.tasks])
  }
  async handle(method: string, action: string, auth: Authentication, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const authorized = await authorizeDatabase(this.identity, auth, 'stats:read', { unregistered: '服务端尚未初始化人员', missingToken: '请先登录' })
    if (!authorized.ok) return Response.json({ ok: false, reason: authorized.reason }, { status: authorized.status })
    const principal = authorized.viewer
    const memberId = principal.memberId
    const result = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
    try {
      if (action === 'status' && method === 'GET') return result({ enabled: !!this.engine, retains_history: true, retention_days: this.store.retentionDays })
      if (!this.engine) return result({ ok: false, reason: '管理员尚未启用 DSH 助手' }, 503)
      if (action === 'sessions' && method === 'GET') return result({ sessions: await this.store.list(memberId) })
      if (action.startsWith('sessions/')) {
        const id = action.slice('sessions/'.length)
        if (method === 'GET') return result(await this.store.get(memberId, id))
        if (this.busy.has(memberId)) return result({ ok: false, reason: '当前对话正在运行，请停止后再删除' }, 409)
        if (method === 'DELETE') { await this.store.delete(memberId, id); return result({ ok: true }) }
      }
      if (action !== 'chat' || method !== 'POST') return result({ ok: false, reason: '助手接口不存在' }, 404)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError(400, '请求体需要是对象')
      const input = body as Record<string, unknown>
      if (Object.keys(input).some(k => !['prompt', 'session_id', 'page'].includes(k))) throw new IdentityError(400, '仅支持 prompt、session_id 与 page')
      if (input.page !== undefined && !ASSISTANT_PAGES.some(page => page.path === input.page)) throw new IdentityError(400, '当前页面无效')
      if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4096) throw new IdentityError(400, '问题需要为 1～4096 个字符')
      if (input.session_id !== undefined && typeof input.session_id !== 'string') throw new IdentityError(400, 'session_id 必须是字符串')
      if (this.busy.has(memberId)) return result({ ok: false, reason: '你已有一个对话正在运行' }, 409)
      if (this.busy.size >= 4) return result({ ok: false, reason: '助手繁忙，请稍后重试' }, 429)
      this.busy.add(memberId)
      let detail
      try {
        detail = input.session_id ? await this.store.get(memberId, input.session_id as string) : await this.store.create(memberId)
        if (detail.session.turn_count >= 50) throw new IdentityError(409, '本会话已达 50 轮，请新建对话')
      } catch (err) { this.busy.delete(memberId); throw err }
      const controller = new AbortController()
      this.controllers.add(controller)
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const encoder = new TextEncoder()
      const engine = this.engine
      const prompt = input.prompt.trim()
      const stream = new ReadableStream<Uint8Array>({
        start: sink => {
          let disconnected = false
          let responseText = ''
          const responseResults: AssistantResult[] = []
          const emit = (event: AssistantEvent) => {
            if (event.type === 'result') responseResults.push(event.result)
            if (event.type === 'text') {
              responseText += event.text
              if (responseText.length > 128_000) controller.abort()
            }
            if (!disconnected) try { sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { disconnected = true; controller.abort() }
          }
          const heartbeat = setInterval(() => {
            if (!disconnected) try { sink.enqueue(encoder.encode(': heartbeat\n\n')) } catch { disconnected = true; controller.abort() }
          }, 15_000)
          const timeout = setTimeout(abort, 120_000)
          let completed = false
          const task = (async () => {
            try {
              detail.session.turn_count++
              detail.session.updated_at_ms = Date.now()
              if (detail.session.title === '新对话') detail.session.title = prompt.slice(0, 40)
              detail.messages.push({ role: 'user', text: prompt })
              await this.store.save(memberId, detail)
              emit({ type: 'session', session: detail.session })
              await engine.run({ sessionId: detail.session.session_id, directory: this.store.sessionPath(memberId, detail.session.session_id), prompt, page: input.page as string | undefined, principal, signal: controller.signal, emit })
              completed = true
            } catch (err) {
              console.warn('[assistant] 对话未完成', { member_id: memberId, session_id: detail.session.session_id, error: err instanceof Error ? err.name : 'Unknown', aborted: controller.signal.aborted })
              emit({ type: 'error', reason: controller.signal.aborted ? '对话已停止或超过两分钟，请重试' : 'DSH 助手运行失败，请管理员检查模型配置与服务日志' })
            } finally {
              clearInterval(heartbeat); clearTimeout(timeout)
              signal?.removeEventListener('abort', abort)
              if (responseText || responseResults.length) detail.messages.push({ role: 'assistant', text: responseText.slice(0, 128_000), ...(responseResults.length ? { results: responseResults } : {}) })
              detail.session.updated_at_ms = Date.now()
              try {
                await this.store.save(memberId, detail)
                if (completed) emit({ type: 'done' })
              } catch {
                emit({ type: 'error', reason: '助手记录保存失败，请管理员检查磁盘空间' })
              } finally {
                this.busy.delete(memberId)
                this.controllers.delete(controller)
                if (!disconnected) try { sink.close() } catch { /* 浏览器已关闭消费端。 */ }
              }
            }
          })().catch(() => { this.busy.delete(memberId); this.controllers.delete(controller); try { sink.error(new Error('助手记录保存失败')) } catch { /* 流已经结束。 */ } })
          this.tasks.add(task)
          void task.finally(() => this.tasks.delete(task))
        },
        cancel: abort,
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
    } catch (err) {
      return result({ ok: false, reason: err instanceof IdentityError ? err.message : '助手存储暂时不可用' }, err instanceof IdentityError ? err.status : 503)
    }
  }
}
