/** 流中的一次工具调用只显示一行；重试保留独立记录，旧事件仍可显示。 */
import { ASSISTANT_FORMS, ASSISTANT_PAGES, type AssistantToolEvent } from '@ai-token-report/shared'
export function recordAssistantTool(sources: AssistantToolEvent[], event: AssistantToolEvent): void {
  const index = event.call_id ? sources.findIndex(source => source.call_id === event.call_id) : -1
  if (index < 0) sources.push(event)
  else if (!(event.state === 'running' && sources[index]?.state !== 'running')) sources.splice(index, 1, event)
}
/** 停止或断网后不会再收到完成事件，界面应明确显示这些调用未完成。 */
export function finishAssistantTools(sources: AssistantToolEvent[]): void {
  for (let index = 0; index < sources.length; index++) if (sources[index]?.state === 'running') sources[index] = { ...sources[index]!, state: 'failed', status: 499 }
}

/** 导航错误只展示固定业务原因，不能把 SDK 异常或未知路径透传给页面。 */
export function assistantNavigationActivity(source: AssistantToolEvent): { description: string; label: string } | undefined {
  if (source.tool === 'portal_open_form') {
    const definition = ASSISTANT_FORMS.find(item => item.resource === source.query || item.path === source.query)
    const title = ASSISTANT_PAGES.find(item => item.path === definition?.path)?.title ?? '管理表单'
    const failed = source.state === 'failed' || source.status >= 400
    return { description: failed ? `${title} · 未能请求打开表单，请检查填写权限后重试` : `${title} · 填写后点击保存才会生效`, label: source.state === 'running' ? '进行中' : failed ? '未完成' : '已请求打开' }
  }
  if (source.tool !== 'portal_navigate') return undefined
  const page = ASSISTANT_PAGES.find(page => page.path === source.query)
  const title = page?.title ?? '站内页面'
  const failed = source.state === 'failed' || source.status >= 400
  const label = source.state === 'running' ? '进行中' : failed ? '未完成' : source.status === 202 ? '已请求' : '已完成'
  if (!failed) return { description: title, label }
  const reason = source.status === 400
    ? page && page.permission !== 'stats:read' ? '导航条件无效，管理页只支持搜索' : '导航条件无效，请检查页面、时间和筛选条件'
    : source.status === 403 ? '没有该页面的访问权限'
    : source.status === 499 ? '导航被停止或连接中断'
    : '导航失败，请重试或从导航栏打开目标页面'
  return { description: `${title} · ${reason}`, label }
}
