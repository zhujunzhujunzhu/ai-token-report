/** 页面动作仅在当前 SSE 轮次内往返；超时、取消或完成后迟到的浏览器回复不能再执行。 */
import { randomUUID } from 'node:crypto'
import type { AssistantEvent, AssistantPageActionResult, AssistantPageContext, AssistantPageOperation } from '@ai-token-report/shared'
import { IdentityError, type Principal } from '../identity/types.js'
import { validateAssistantPageActionResult, validateAssistantPageContext, validateAssistantPageOperation } from './page-context.js'

export class AssistantPageBridge {
  private pending = new Map<string, (result: AssistantPageActionResult) => void>()
  private requests = 0
  private closed = false
  constructor(private context: AssistantPageContext | undefined, private page: string | undefined, private signal: AbortSignal, private emit: (event: AssistantEvent) => void, private authorize: () => Promise<Principal>, private allowWrite: boolean, private timeoutMs = 15_000) {}

  async operate(value: AssistantPageOperation): Promise<AssistantPageActionResult> {
    if (this.closed) throw new IdentityError(409, '这一轮的页面操作已经结束')
    this.signal.throwIfAborted()
    const principal = await this.authorize()
    this.signal.throwIfAborted()
    this.context = validateAssistantPageContext(this.context, undefined, principal)
    const action = validateAssistantPageOperation(value, this.context, this.allowWrite)
    if (this.pending.size) throw new IdentityError(409, '上一项页面操作尚未确认，请按顺序操作')
    if (++this.requests > 24) throw new IdentityError(429, '本轮页面操作已达上限，请发送下一条消息')
    const requestId = randomUUID()
    return await new Promise(resolve => {
      const finish = (result: AssistantPageActionResult) => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timeout)
        this.signal.removeEventListener('abort', abort)
        if (result.page_context) { this.context = result.page_context; this.page = result.page_context.path }
        resolve(result)
      }
      const abort = () => finish({ ok: false, reason: '本轮已停止，页面操作已取消' })
      const timeout = setTimeout(() => finish({ ok: false, reason: '浏览器未及时确认页面操作，请检查页面后重试' }), Math.min(15_000, Math.max(1, this.timeoutMs)))
      this.pending.set(requestId, finish)
      this.signal.addEventListener('abort', abort, { once: true })
      if (this.signal.aborted) abort()
      else {
        try { this.emit({ type: 'page_action', request_id: requestId, action }) }
        catch { finish({ ok: false, reason: '页面连接已关闭，操作未确认' }) }
      }
    })
  }

  respond(requestId: string, value: unknown, principal: Principal): void {
    const respond = this.pending.get(requestId)
    if (!respond || this.signal.aborted || this.closed) throw new IdentityError(409, '页面请求已结束或过期')
    const result = validateAssistantPageActionResult(value, principal, this.page)
    respond(result)
  }
  close(): void {
    this.closed = true
    for (const respond of [...this.pending.values()]) respond({ ok: false, reason: '本轮已结束，页面操作未确认' })
  }
}
