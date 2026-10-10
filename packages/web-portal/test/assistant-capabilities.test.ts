/** 删除确认与分享链接的历史状态、过期边界和可执行协议约束。 */
import { expect, test } from 'bun:test'
import type { AssistantArtifact, AssistantPendingAction } from '@ai-token-report/shared'
import { assistantActionStatus, canConfirmAssistantAction, assistantShareActive, assistantShareUrl, ASSISTANT_SHARE_HOURS } from '../src/utils/assistantCapabilities.js'
const action: AssistantPendingAction = { action_id: 'a', session_id: 's', title: '删除规则', description: '删除查询期映射', resource: 'projects', operation: 'delete', target_label: '项目甲', expires_at_ms: 1000, status: 'pending' }
const artifact: AssistantArtifact = { artifact_id: 'f', session_id: 's', title: '报告', format: 'html', file_name: '报告.html', size_bytes: 10, created_at_ms: 0, download_path: '/api/v1/assistant/artifacts/f/download' }
test('删除只可确认未过期的待处理动作，边界时刻立即过期', () => {
  expect(canConfirmAssistantAction(action, 999)).toBe(true)
  expect(canConfirmAssistantAction(action, 1000)).toBe(false)
  expect(assistantActionStatus(action, 1000)).toBe('已过期')
  for (const status of ['confirmed', 'cancelled', 'expired', 'failed'] as const) expect(canConfirmAssistantAction({ ...action, status }, 0)).toBe(false)
})
test('生成私有HTML不自动具有公开分享，撤销和到期都停止显示可用链接', () => {
  expect(assistantShareActive(artifact, 0)).toBe(false)
  const shared = { ...artifact, share: { url: 'https://example.test/share/random', expires_at_ms: 1000 } }
  expect(assistantShareActive(shared, 999)).toBe(true)
  expect(assistantShareActive(shared, 1000)).toBe(false)
  expect(ASSISTANT_SHARE_HOURS.map(item => item.hours)).toEqual([1, 24, 168, 720])
})
test('分享链接不接受脚本协议、协议相对地址、凭证与反斜线', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//evil.test/x', 'https://user:secret@example.test/x', '/\\evil.test/x', '/share/with\ncontrol']) expect(assistantShareUrl(url)).toBe('')
  expect(assistantShareUrl('/api/v1/assistant/shares/random')).toBe('/api/v1/assistant/shares/random')
  expect(assistantShareUrl('https://example.test/share/random')).toBe('https://example.test/share/random')
})
