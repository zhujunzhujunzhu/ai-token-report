/** 部门助手 HTTP 边界：按人员隔离空间，每个会话保持单写者，不同会话可独立运行。 */
import { randomUUID } from 'node:crypto'
import { ASSISTANT_PAGES, ASSISTANT_SESSION_PAGE_SIZE, type AssistantEvent, type AssistantResult, type AssistantArtifact, type AssistantPendingAction } from '@ai-token-report/shared'
import { IdentityError, type IdentityRepository } from './identity/index.js'
import { authorizeDatabase, type Authentication } from './http/auth.js'
import { AssistantStore } from './assistant/store.js'
import type { AssistantEngine, AssistantServices } from './assistant/runtime.js'
import { AssistantRuntimeError } from './assistant/runtime-error.js'
import { prepareAssistantAttachments, type PreparedAssistantAttachment } from './assistant/attachments.js'
import { assistantWriteIntent, assistantShareIntent } from './assistant/intents.js'

interface ActiveRun {
  memberId: string
  sessionId: string
  runId: string
  prompt: string
  controller: AbortController
  submitSteering?: (prompt: string) => void
}

export class AssistantRoute {
  private busy = new Set<string>()
  private activeMembers = new Set<string>()
  private runs = new Map<string, ActiveRun>()
  private deleting = new Set<string>()
  private controllers = new Set<AbortController>()
  private tasks = new Set<Promise<void>>()
  private cleanup: ReturnType<typeof setInterval> | undefined
  constructor(private identity: IdentityRepository, readonly store: AssistantStore, private engine?: AssistantEngine, private services: AssistantServices = {}) {
    if (engine && store.retentionDays !== null) {
      const prune = () => { void store.prune(this.activeMembers).catch(() => console.warn('[assistant] 过期会话清理失败')) }
      prune()
      this.cleanup = setInterval(prune, 3_600_000)
      this.cleanup.unref()
    }
  }
  private sessionKey(memberId: string, sessionId: string): string { return `${memberId}/${sessionId}` }
  private activeSessions(memberId: string): Set<string> { return new Set([...this.runs.values()].filter(run => run.memberId === memberId).map(run => run.sessionId)) }
  private refreshMember(memberId: string): void {
    if (this.busy.has(memberId) || [...this.runs.values()].some(run => run.memberId === memberId) || [...this.deleting].some(key => key.startsWith(memberId + '/'))) this.activeMembers.add(memberId)
    else this.activeMembers.delete(memberId)
  }
  async close(): Promise<void> {
    clearInterval(this.cleanup)
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.tasks])
  }
  async handle(method: string, action: string, auth: Authentication, body?: unknown, signal?: AbortSignal, query: URLSearchParams = new URLSearchParams()): Promise<Response> {
    // ★ 分享能力链接不依赖访客登录，访问前仍复验文件主人当前的数据权限。
    if (method === 'GET' && action.startsWith('shared/') && this.services.artifacts) {
      try { return await this.services.artifacts.publicShare(action.slice(7), memberId => this.identity.memberAccess(memberId)) }
      catch (err) { return Response.json({ ok: false, reason: err instanceof IdentityError ? err.message : '分享暂时不可用' }, { status: err instanceof IdentityError ? err.status : 503, headers: { 'Cache-Control': 'no-store' } }) }
    }
    const authorized = await authorizeDatabase(this.identity, auth, 'stats:read', { unregistered: '服务端尚未初始化人员', missingToken: '请先登录' })
    if (!authorized.ok) return Response.json({ ok: false, reason: authorized.reason }, { status: authorized.status })
    const principal = authorized.viewer
    const memberId = principal.memberId
    const result = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
    try {
      if (action === 'status' && method === 'GET') return result({ enabled: !!this.engine, supports_images: this.engine?.supportsImages === true, supports_steering: this.engine?.supportsSteering === true, retains_history: true, retention_days: this.store.retentionDays })
      const attachmentMatch = /^sessions\/([^/]+)\/attachments\/([^/]+)\/download$/.exec(action)
      if (method === 'GET' && attachmentMatch) return await this.store.downloadAttachment(principal, attachmentMatch[1]!, attachmentMatch[2]!)
      const artifactMatch = /^artifacts\/([^/]+)\/(download|share|revoke)$/.exec(action)
      if (artifactMatch && this.services.artifacts) {
        const [, id, operation] = artifactMatch
        if (method === 'GET' && operation === 'download') return await this.services.artifacts.download(memberId, id!, principal)
        if (method === 'POST' && ['share', 'revoke'].includes(operation!)) {
          if (this.activeMembers.has(memberId)) return result({ ok: false, reason: '对话正在运行，请结束后操作文件' }, 409)
          this.busy.add(memberId)
          this.refreshMember(memberId)
          try {
            if (operation === 'share') {
              const share = await this.services.artifacts.share(memberId, id!, body, principal)
              return result({ artifact: { ...await this.services.artifacts.getMetadata(memberId, id!, principal), share } })
            }
            return result({ artifact: await this.services.artifacts.revoke(memberId, id!) })
          } finally { this.busy.delete(memberId); this.refreshMember(memberId) }
        }
      }
      const confirmMatch = /^actions\/([^/]+)\/confirm$/.exec(action)
      if (method === 'POST' && confirmMatch && this.services.actions) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError(400, '确认请求需要是对象')
        const raw = body as Record<string, unknown>
        if (Object.keys(raw).some(key => !['session_id', 'decision'].includes(key)) || typeof raw.session_id !== 'string' || !['confirm', 'cancel'].includes(String(raw.decision))) throw new IdentityError(400, '请指定会话与确认或取消')
        if (this.activeMembers.has(memberId)) return result({ ok: false, reason: '对话正在运行，请结束后确认操作' }, 409)
        this.busy.add(memberId)
        this.refreshMember(memberId)
        try {
          const confirmed = await this.services.actions.confirm(principal, confirmMatch[1]!, raw.decision as 'confirm' | 'cancel', raw.session_id)
          return result(confirmed, confirmed.ok ? 200 : confirmed.status ?? 409)
        } finally { this.busy.delete(memberId); this.refreshMember(memberId) }
      }
      if (!this.engine) return result({ ok: false, reason: '管理员尚未启用 DSH 助手' }, 503)
      if (action === 'steer' && method === 'POST') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError(400, '引导请求需要是对象')
        const input = body as Record<string, unknown>
        if (Object.keys(input).some(key => !['session_id', 'run_id', 'prompt'].includes(key)) || typeof input.session_id !== 'string' || typeof input.run_id !== 'string' || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4096) throw new IdentityError(400, '请指定会话、本轮 ID 与 1～4096 个字符的引导')
        // ★ 先复验当前身份与私有会话，再查运行表，不能让跨用户请求探知他人的运行状态。
        await this.store.assertAccess(principal, input.session_id)
        const run = this.runs.get(this.sessionKey(memberId, input.session_id))
        if (!run || run.runId !== input.run_id || run.controller.signal.aborted || !run.submitSteering) return result({ ok: false, reason: '这一轮已结束，请将消息排队发送' }, 409)
        if (this.engine.supportsSteering !== true) return result({ ok: false, reason: '当前助手不支持即时引导，请将消息排队发送' }, 409)
        const prompt = input.prompt.trim()
        if ((assistantWriteIntent(prompt) && !assistantWriteIntent(run.prompt)) || (assistantShareIntent(prompt) && !assistantShareIntent(run.prompt))) return result({ ok: false, reason: '新的修改或分享请求需要独立授权，请将消息排队发送' }, 409)
        run.submitSteering(prompt)
        return result({ ok: true, session_id: run.sessionId, run_id: run.runId })
      }
      if (action === 'sessions' && method === 'GET') {
        if ([...query.keys()].some(key => !['limit', 'cursor'].includes(key)) || query.getAll('limit').length > 1 || query.getAll('cursor').length > 1) throw new IdentityError(400, '会话列表仅支持唯一的 limit 与 cursor 参数')
        const rawLimit = query.get('limit')
        if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) throw new IdentityError(400, '每页会话数需要为 1～100')
        return result(await this.store.listPage(memberId, { limit: rawLimit === null ? ASSISTANT_SESSION_PAGE_SIZE : Number(rawLimit), ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}) }, this.activeSessions(memberId)))
      }
      if (action.startsWith('sessions/')) {
        const id = action.slice('sessions/'.length)
        if (method === 'GET') {
          await this.store.assertAccess(principal, id)
          const detail = await this.store.get(memberId, id)
          const actions = await this.services.actions?.list(principal, id) ?? []
          const artifacts = await this.services.artifacts?.list(memberId, id, principal) ?? []
          for (const message of detail.messages) {
            if (message.actions) message.actions = message.actions.map(item => actions.find(current => current.action_id === item.action_id) ?? item)
            if (message.artifacts) message.artifacts = message.artifacts.flatMap(item => artifacts.find(current => current.artifact_id === item.artifact_id) ?? [])
          }
          return result(detail)
        }
        if (method === 'DELETE') {
          const key = this.sessionKey(memberId, id)
          if (this.busy.has(memberId) || this.runs.has(key) || this.deleting.has(key)) return result({ ok: false, reason: '当前对话正在运行，请停止后再删除' }, 409)
          // ★ 删除与续聊在读盘前争用同一把会话锁，否则慢磁盘下会出现先读后删的竞态。
          this.deleting.add(key); this.refreshMember(memberId)
          try { await this.store.delete(memberId, id); return result({ ok: true }) }
          finally { this.deleting.delete(key); this.refreshMember(memberId) }
        }
      }
      if (action !== 'chat' || method !== 'POST') return result({ ok: false, reason: '助手接口不存在' }, 404)
      let files: File[] = []
      if (body instanceof Request) {
        let form: Awaited<ReturnType<Request['formData']>>
        try { form = await body.formData() }
        catch { throw new IdentityError(400, '附件请求格式无效，请重新选择文件') }
        const input: Record<string, unknown> = {}
        form.forEach((value, key) => {
          if (key === 'files' && typeof value !== 'string') { files.push(value); return }
          if (!['prompt', 'session_id', 'page'].includes(key) || typeof value !== 'string' || key in input) throw new IdentityError(400, '仅支持问题、会话、页面与文件，文字字段不能重复')
          input[key] = value
        })
        body = input
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError(400, '请求体需要是对象')
      const input = body as Record<string, unknown>
      if (Object.keys(input).some(k => !['prompt', 'session_id', 'page'].includes(k))) throw new IdentityError(400, '仅支持 prompt、session_id 与 page')
      if (input.page !== undefined && !ASSISTANT_PAGES.some(page => page.path === input.page)) throw new IdentityError(400, '当前页面无效')
      if (files.length && (input.prompt === undefined || input.prompt === '')) input.prompt = '请分析上传的附件。'
      if (typeof input.prompt !== 'string' || (!input.prompt.trim() && !files.length) || input.prompt.length > 4096) throw new IdentityError(400, '问题需要为 1～4096 个字符')
      if (input.session_id !== undefined && typeof input.session_id !== 'string') throw new IdentityError(400, 'session_id 必须是字符串')
      const sessionId = input.session_id as string | undefined ?? randomUUID()
      this.store.sessionPath(memberId, sessionId)
      const key = this.sessionKey(memberId, sessionId)
      if (this.busy.has(memberId) || this.runs.has(key) || this.deleting.has(key)) return result({ ok: false, reason: '当前对话正在运行，消息可排队或即时引导' }, 409)
      if (this.runs.size >= 4) return result({ ok: false, reason: '助手繁忙，请稍后重试' }, 429)
      const controller = new AbortController()
      const prompt = input.prompt.trim() || '请分析上传的附件。'
      const run: ActiveRun = { memberId, sessionId, runId: randomUUID(), prompt, controller }
      // ★ 先预占再解析附件和读库，一会话一运行的约束不能依赖异步操作完成顺序。
      this.runs.set(key, run); this.refreshMember(memberId)
      const release = () => { this.runs.delete(key); this.controllers.delete(controller); this.refreshMember(memberId) }
      let detail
      let attachments: PreparedAssistantAttachment[]
      try {
        attachments = await prepareAssistantAttachments(files)
        if (attachments.some(item => item.metadata.kind === 'image') && this.engine.supportsImages !== true) throw new IdentityError(415, '当前助手模型未启用图片理解，请管理员配置支持视觉的模型；Office 和文本文件可正常解析')
        detail = input.session_id ? await this.store.get(memberId, sessionId) : await this.store.create(memberId, sessionId, this.activeSessions(memberId))
        await this.store.assertAccess(principal, detail.session.session_id)
        if (detail.session.turn_count >= 50) throw new IdentityError(409, '本会话已达 50 轮，请新建对话')
        await this.store.saveAttachments(memberId, detail.session.session_id, attachments)
      } catch (err) { release(); throw err }
      this.controllers.add(controller)
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const encoder = new TextEncoder()
      const engine = this.engine
      const stream = new ReadableStream<Uint8Array>({
        start: sink => {
          let disconnected = false
          let responseText = ''
          let responseChars = 0
          const responseResults: AssistantResult[] = []
          const responseActions: AssistantPendingAction[] = []
          const responseArtifacts: AssistantArtifact[] = []
          const emit = (event: AssistantEvent) => {
            if (controller.signal.aborted && ['text', 'result', 'action', 'artifact', 'navigate', 'open_form'].includes(event.type)) return
            if (event.type === 'result') responseResults.push(event.result)
            if (event.type === 'action') responseActions.push(event.action)
            if (event.type === 'artifact') {
              const index = responseArtifacts.findIndex(item => item.artifact_id === event.artifact.artifact_id)
              if (index >= 0) responseArtifacts[index] = event.artifact
              else responseArtifacts.push(event.artifact)
            }
            if (event.type === 'text') {
              responseText += event.text.slice(0, Math.max(0, 128_000 - responseChars))
              responseChars += event.text.length
              if (responseChars > 128_000) controller.abort()
            }
            if (!disconnected) try { sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { disconnected = true; controller.abort() }
          }
          const flushResponse = () => {
            if (responseText || responseResults.length || responseActions.length || responseArtifacts.length) detail.messages.push({ role: 'assistant', text: responseText.slice(0, 128_000), ...(responseResults.length ? { results: [...responseResults] } : {}), ...(responseActions.length ? { actions: [...responseActions] } : {}), ...(responseArtifacts.length ? { artifacts: [...responseArtifacts] } : {}) })
            responseText = ''; responseResults.length = 0; responseActions.length = 0; responseArtifacts.length = 0
          }
          let steeringCount = 0
          const pendingSteering: string[] = []
          let deliverSteering: ((prompt: string) => void) | undefined
          run.submitSteering = prompt => {
            if (controller.signal.aborted) throw new IdentityError(409, '这一轮已停止，请将消息排队发送')
            if (steeringCount >= 20) throw new IdentityError(429, '本轮引导已达 20 条，请将消息排队发送')
            if (deliverSteering) deliverSteering(prompt)
            else pendingSteering.push(prompt)
            steeringCount++
            // ★ 对话记录与页面用相同的消息边界，最终落盘不会把引导挤到回答之后或覆盖它。
            flushResponse()
            detail.messages.push({ role: 'user', text: prompt, delivery: 'steer' })
            detail.session.updated_at_ms = Date.now()
            emit({ type: 'steering', text: prompt })
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
              detail.messages.push({ role: 'user', text: prompt, ...(attachments.length ? { attachments: attachments.map(item => item.metadata) } : {}) })
              await this.store.save(memberId, detail)
              emit({ type: 'session', session: detail.session, run_id: run.runId })
              if (attachments.length) emit({ type: 'attachments', attachments: attachments.map(item => item.metadata) })
              await engine.run({ sessionId: detail.session.session_id, directory: this.store.sessionPath(memberId, detail.session.session_id), prompt, ...(attachments.length ? { attachments } : {}), page: input.page as string | undefined, principal, signal: controller.signal, emit, subscribeSteering: accept => {
                deliverSteering = accept
                for (const prompt of pendingSteering.splice(0)) accept(prompt)
                return () => { deliverSteering = undefined; run.submitSteering = undefined }
              }, authorize: async () => {
                const current = await authorizeDatabase(this.identity, auth, 'stats:read', { unregistered: '服务端尚未初始化人员', missingToken: '请先登录' })
                if (!current.ok) { controller.abort(); throw new IdentityError(current.status, current.reason) }
                try { await this.store.assertAccess(current.viewer, detail.session.session_id) }
                catch (error) { controller.abort(); throw error }
                return current.viewer
              } })
              completed = true
            } catch (err) {
              // ★ 终止分类足够定位输出截断；原始模型错误可能含凭证、正文或思考，不能直接写日志。
              console.warn('[assistant] 对话未完成', { member_id: memberId, session_id: detail.session.session_id, error: err instanceof Error ? err.name : 'Unknown', ...(err instanceof AssistantRuntimeError ? { code: err.code, reason_kind: err.reasonKind } : {}), aborted: controller.signal.aborted })
              emit({ type: 'error', reason: err instanceof IdentityError ? err.message : controller.signal.aborted ? '对话已停止或超过两分钟，请重试' : err instanceof AssistantRuntimeError ? err.publicMessage : 'DSH 助手运行失败，请管理员检查模型配置与服务日志' })
            } finally {
              run.submitSteering = undefined
              clearInterval(heartbeat); clearTimeout(timeout)
              signal?.removeEventListener('abort', abort)
              flushResponse()
              detail.session.updated_at_ms = Date.now()
              try {
                await this.store.save(memberId, detail)
                if (completed) emit({ type: 'done' })
              } catch {
                emit({ type: 'error', reason: '助手记录保存失败，请管理员检查磁盘空间' })
              } finally {
                release()
                if (!disconnected) try { sink.close() } catch { /* 浏览器已关闭消费端。 */ }
              }
            }
          })().catch(() => { release(); try { sink.error(new Error('助手记录保存失败')) } catch { /* 流已经结束。 */ } })
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
