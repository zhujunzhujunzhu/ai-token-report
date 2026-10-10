/** 动作与产物卡的状态判断集中在此，历史过期内容不能因为重渲染恢复操作。 */
import type { AssistantPendingAction, AssistantArtifact } from '@ai-token-report/shared'

export function canConfirmAssistantAction(action: AssistantPendingAction, now = Date.now()): boolean {
  return action.status === 'pending' && action.expires_at_ms > now
}
export function assistantActionStatus(action: AssistantPendingAction, now = Date.now()): string {
  if (action.status === 'pending' && action.expires_at_ms <= now) return '已过期'
  return ({ pending: '等待你确认', confirmed: '已执行', cancelled: '已取消', expired: '已过期', failed: '执行失败' })[action.status]
}
export function assistantShareActive(artifact: AssistantArtifact, now = Date.now()): boolean {
  return !!artifact.share && artifact.share.expires_at_ms > now
}
export const ASSISTANT_SHARE_HOURS = [{ hours: 1, label: '1 小时' }, { hours: 24, label: '24 小时' }, { hours: 168, label: '7 天' }, { hours: 720, label: '30 天' }] as const

/** 服务端链接也需校验，卡片不得变成可执行协议或跨站导航入口。 */
export function assistantShareUrl(value: string): string {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return ''
  if (/^\/(?!\/)/.test(value)) return value
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
