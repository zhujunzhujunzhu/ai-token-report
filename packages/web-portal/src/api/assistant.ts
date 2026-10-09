/** 助手的 POST SSE 客户端，沿用 Cookie、自定义同源请求头与部署前缀。 */
import type { AssistantDetail, AssistantEvent, AssistantSession, AssistantStatus } from '@ai-token-report/shared'
import { request, withBase } from './request.js'

export const assistantStatus = () => request<AssistantStatus>('/api/v1/assistant/status')
export const assistantSessions = () => request<{ sessions: AssistantSession[] }>('/api/v1/assistant/sessions')
export const assistantDetail = (id: string) => request<AssistantDetail>(`/api/v1/assistant/sessions/${encodeURIComponent(id)}`)

async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { reason?: string }
    throw new Error(body.reason ?? '助手请求失败')
  }
  return response
}
export async function deleteAssistantSession(id: string): Promise<void> {
  await checked(await fetch(withBase(`/api/v1/assistant/sessions/${encodeURIComponent(id)}`), {
    method: 'DELETE', headers: { 'X-Portal-Request': '1' }, credentials: 'same-origin', signal: AbortSignal.timeout(20_000),
  }))
}

/** 增量解析保留跨网络块的 UTF-8 与帧边界；测试可以按任意字节切块。 */
export async function consumeAssistantStream(stream: ReadableStream<Uint8Array>, onEvent: (event: AssistantEvent) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = '', terminal = false
  try {
    while (true) {
      const chunk = await reader.read()
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        if (data) {
          const event = JSON.parse(data) as AssistantEvent
          if (event.type === 'done' || event.type === 'error') terminal = true
          onEvent(event)
        }
      }
      if (pending.length > 256_000) throw new Error('助手响应帧过大')
      if (chunk.done) break
    }
    if (!terminal) throw new Error('助手连接中断，请重新打开会话查看已保存的回答')
  } finally { reader.releaseLock() }
}
export async function chatAssistant(prompt: string, sessionId: string | undefined, signal: AbortSignal, onEvent: (event: AssistantEvent) => void, page?: string): Promise<void> {
  const response = await checked(await fetch(withBase('/api/v1/assistant/chat'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1' },
    credentials: 'same-origin', signal, body: JSON.stringify({ prompt, session_id: sessionId, page }),
  }))
  if (!response.body) throw new Error('浏览器无法读取助手响应')
  await consumeAssistantStream(response.body, onEvent)
}
