/** 工具状态必须在工作完成前发送；异常可供 DSH 重试且不向浏览器透传原始错误。 */
import { expect, test } from 'bun:test'
import type { AssistantEvent } from '@ai-token-report/shared'
import { runAssistantTool } from '../src/assistant/tools.js'
import { assistantNavigation } from '../src/assistant/navigation.js'
import { IdentityError } from '../src/identity/types.js'
import type { Principal } from '../src/identity/types.js'
test('长耗时工具先报告开始，结果与完成事件保持同一次调用 ID', async () => {
  const events: AssistantEvent[] = []
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const task = runAssistantTool('stats_series', 'period=last7d', event => events.push(event), async emit => {
    await gate
    emit({ type: 'tool', tool: 'stats_series', query: 'period=last7d&identity_view=member', status: 200 })
    return { total: 23 }
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ state: 'running' })
  release()
  expect(await task).toEqual({ total: 23 })
  const statuses = events.filter(event => event.type === 'tool')
  expect(statuses.map(event => event.state)).toEqual(['running', 'completed'])
  expect(statuses[0]?.call_id).toBe(statuses[1]?.call_id)
})
test('管理页导航接受空筛选并以同次202终态结束，非法条件不发跳转事件', async () => {
  const principal = { permissions: ['tokens:manage'] } as Principal
  for (const filters of [{}, { period: 'yesterday' }]) {
    const events: AssistantEvent[] = []
    const task = runAssistantTool('portal_navigate', '/appkeys', event => events.push(event), async emit => {
      const navigation = assistantNavigation({ path: '/appkeys', filters }, principal)
      emit(navigation)
      emit({ type: 'tool', tool: 'portal_navigate', query: navigation.path, status: 202 })
      return { navigation_requested: true }
    })
    if ('period' in filters) {
      await expect(task).rejects.toThrow('不要传统计筛选条件')
      expect(events.some(event => event.type === 'navigate')).toBe(false)
      expect(events.at(-1)).toMatchObject({ state: 'failed', status: 400 })
    } else {
      expect(await task).toEqual({ navigation_requested: true })
      expect(events[1]).toEqual({ type: 'navigate', path: '/appkeys' })
      expect(events.at(-1)).toMatchObject({ state: 'completed', status: 202 })
    }
    const tools = events.filter(event => event.type === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.call_id).toBe(tools[1]?.call_id)
  }
})
test('参数失败与普通异常都保留失败状态，不输出 SDK 错误中的秘密', async () => {
  for (const error of [new IdentityError(403, '机密请求头'), new Error('机密请求头')]) {
    const events: AssistantEvent[] = []
    await expect(runAssistantTool('render_echarts', '', event => events.push(event), async () => { throw error })).rejects.toThrow()
    expect(events.at(-1)).toMatchObject({ state: 'failed', status: error instanceof IdentityError ? 403 : 500 })
    expect(JSON.stringify(events)).not.toContain('机密请求头')
  }
})
