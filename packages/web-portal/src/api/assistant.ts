/** 助手的 POST SSE 客户端，沿用 Cookie、自定义同源请求头与部署前缀。 */
import { ASSISTANT_SESSION_PAGE_SIZE } from '@ai-token-report/shared'
import type { AssistantArtifact, AssistantAttachment, AssistantPendingAction, AssistantDetail, AssistantEvent, AssistantSessionPage, AssistantStatus } from '@ai-token-report/shared'
import { post, request, withBase } from './request.js'

export const assistantStatus = () => request<AssistantStatus>('/api/v1/assistant/status')
export function assistantSessions(params: { limit?: number; cursor?: string } = {}) {
  const query = new URLSearchParams({ limit: String(params.limit ?? ASSISTANT_SESSION_PAGE_SIZE) })
  if (params.cursor) query.set('cursor', params.cursor)
  return request<AssistantSessionPage>(`/api/v1/assistant/sessions?${query}`)
}
export const assistantDetail = (id: string) => request<AssistantDetail>(`/api/v1/assistant/sessions/${encodeURIComponent(id)}`)
/** 引导当前运行通过原 SSE 回显，不能另开一条对话或重复插入消息。 */
export async function steerAssistant(prompt: string, sessionId: string, runId: string, signal: AbortSignal): Promise<void> {
  await checked(await fetch(withBase('/api/v1/assistant/steer'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Portal-Request': '1' },
    credentials: 'same-origin', signal, body: JSON.stringify({ session_id: sessionId, run_id: runId, prompt }),
  }))
}
export const confirmAssistantAction = (id: string, sessionId: string, decision: 'confirm' | 'cancel') => post<{ action: AssistantPendingAction }>(`/api/v1/assistant/actions/${encodeURIComponent(id)}/confirm`, { session_id: sessionId, decision })
export const shareAssistantArtifact = (id: string, hours: number) => post<{ artifact: AssistantArtifact }>(`/api/v1/assistant/artifacts/${encodeURIComponent(id)}/share`, { expires_in_hours: hours })
export const revokeAssistantArtifact = (id: string) => post<{ artifact: AssistantArtifact }>(`/api/v1/assistant/artifacts/${encodeURIComponent(id)}/revoke`, {})

/** 只按产物 ID 下载，响应体先完成鉴权校验，再建立浏览器下载对象。 */
export async function downloadAssistantArtifact(artifact: AssistantArtifact): Promise<void> {
  const response = await checked(await fetch(withBase(`/api/v1/assistant/artifacts/${encodeURIComponent(artifact.artifact_id)}/download`), {
    headers: { 'X-Portal-Request': '1' }, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  }))
  saveDownload(await response.blob(), artifact.file_name)
}

/** 附件 ID 只在所属私有会话下解析，下载同样带 Cookie 与同源请求头。 */
export async function downloadAssistantAttachment(sessionId: string, attachment: AssistantAttachment): Promise<void> {
  const response = await checked(await fetch(withBase(`/api/v1/assistant/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.attachment_id)}/download`), {
    headers: { 'X-Portal-Request': '1' }, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  }))
  saveDownload(await response.blob(), attachment.file_name)
}

function saveDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 浏览器须先消费下载 URL；立即 revoke 会让部分浏览器丢失下载内容。
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

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
export async function chatAssistant(prompt: string, sessionId: string | undefined, signal: AbortSignal, onEvent: (event: AssistantEvent) => void, page?: string, files: File[] = []): Promise<void> {
  let body: BodyInit
  const headers: Record<string, string> = { 'X-Portal-Request': '1' }
  if (files.length) {
    const form = new FormData()
    form.set('prompt', prompt)
    if (sessionId) form.set('session_id', sessionId)
    if (page) form.set('page', page)
    for (const file of files) form.append('files', file, file.name)
    body = form
    // 浏览器必须自行生成 multipart 的 boundary，显式 Content-Type 会让附件无法解析。
  } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify({ prompt, session_id: sessionId, page }) }
  const response = await checked(await fetch(withBase('/api/v1/assistant/chat'), {
    method: 'POST', headers,
    credentials: 'same-origin', signal, body,
  }))
  if (!response.body) throw new Error('浏览器无法读取助手响应')
  await consumeAssistantStream(response.body, onEvent)
}
