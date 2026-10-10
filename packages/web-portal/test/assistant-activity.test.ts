/** 开始、失败、重试与旧事件混合时，工具进度不能重复或回退。 */
import { expect, test } from 'bun:test'
import type { AssistantToolEvent } from '@ai-token-report/shared'
import { assistantNavigationActivity, finishAssistantTools, recordAssistantTool } from '../src/utils/assistantActivity.js'
test('同次调用替换为最终状态，失败后重试仍各有一行，迟到开始事件不回退状态', () => {
  const events: AssistantToolEvent[] = []
  const first: AssistantToolEvent = { type: 'tool', tool: 'stats_series', query: '', status: 202, call_id: '第一轮', state: 'running' }
  recordAssistantTool(events, first)
  recordAssistantTool(events, { ...first, status: 400, state: 'failed' })
  recordAssistantTool(events, first)
  recordAssistantTool(events, { ...first, call_id: '重试', state: 'running' })
  recordAssistantTool(events, { ...first, call_id: '重试', status: 200, state: 'completed' })
  expect(events.map(event => event.state)).toEqual(['failed', 'completed'])
  recordAssistantTool(events, { type: 'tool', tool: 'stats_overview', query: '', status: 200 })
  expect(events).toHaveLength(3)
  recordAssistantTool(events, { ...first, call_id: '被取消的调用' })
  finishAssistantTools(events)
  expect(events.at(-1)).toMatchObject({ state: 'failed', status: 499 })
  expect(events[1]).toMatchObject({ state: 'completed', status: 200 })
})

test('导航来源区分条件、权限和其它失败，保持未完成且只显示业务说明', () => {
  const source: AssistantToolEvent = { type: 'tool', tool: 'portal_navigate', query: '/appkeys', status: 202, call_id: '导航', state: 'running' }
  const cases = [
    [400, 'appKey 管理 · 导航条件无效，管理页只支持搜索'],
    [403, 'appKey 管理 · 没有该页面的访问权限'],
    [500, 'appKey 管理 · 导航失败，请重试或从导航栏打开目标页面'],
  ] as const
  for (const [status, description] of cases) {
    const events: AssistantToolEvent[] = []
    recordAssistantTool(events, source)
    recordAssistantTool(events, { ...source, status, state: 'failed' })
    expect(events).toHaveLength(1)
    expect(assistantNavigationActivity(events[0]!)).toEqual({ description, label: '未完成' })
  }
  const unknown = assistantNavigationActivity({ ...source, status: 500, state: 'failed', query: 'SDK Error: secret-key=not-for-ui' })!
  expect(unknown.description).toStartWith('站内页面 · 导航失败')
  expect(unknown.description).not.toContain('SDK')
  expect(unknown.description).not.toContain('secret-key')
  expect(assistantNavigationActivity({ ...source, tool: 'stats_series', status: 403 })).toBeUndefined()
})

test('导航202完成保持已请求，缺结束事件显示停止或连接中断', () => {
  const source: AssistantToolEvent = { type: 'tool', tool: 'portal_navigate', query: '/appkeys', status: 202, call_id: '导航', state: 'running' }
  const completed: AssistantToolEvent[] = []
  recordAssistantTool(completed, source)
  expect(assistantNavigationActivity(completed[0]!)?.label).toBe('进行中')
  recordAssistantTool(completed, { ...source, state: 'completed' })
  finishAssistantTools(completed)
  expect(assistantNavigationActivity(completed[0]!)).toEqual({ description: 'appKey 管理', label: '已请求' })
  const interrupted = [source]
  finishAssistantTools(interrupted)
  expect(assistantNavigationActivity(interrupted[0]!)).toEqual({ description: 'appKey 管理 · 导航被停止或连接中断', label: '未完成' })
})

test('打开表单始终说明等待填写保存，不把202说成保存成功或显示预填值', () => {
  const source: AssistantToolEvent = { type: 'tool', tool: 'portal_open_form', query: 'provider-aliases', status: 202, state: 'completed' }
  expect(assistantNavigationActivity(source)).toEqual({ description: '供应商模型归一化 · 填写后点击保存才会生效', label: '已请求打开' })
  expect(assistantNavigationActivity({ ...source, query: 'secret-name=内部人员' })?.description).not.toContain('内部人员')
  expect(assistantNavigationActivity({ ...source, status: 403, state: 'failed' })?.label).toBe('未完成')
})
