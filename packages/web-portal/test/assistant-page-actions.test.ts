/** 快捷提示不能暗示读取当前筛选，也不能给未授权管理写操作提供入口。 */
import { expect, test } from 'bun:test'
import { assistantPageActions } from '../src/utils/assistantPageActions.js'

test('管理页提示按权限展示目录与表单，未知页面和凭证页没有自动填写入口', () => {
  expect(assistantPageActions('/providers', permission => permission === 'providers:read').map(item => item.label)).toEqual(['查看归一化规则', '刷新当前页面'])
  expect(assistantPageActions('/providers', () => true).map(item => item.label)).toEqual(['查看归一化规则', '刷新当前页面', '新建供应商模型规则表单'])
  expect(assistantPageActions('/members', permission => permission !== 'roles:assign').map(item => item.label)).toEqual(['查看人员目录', '刷新当前页面'])
  expect(assistantPageActions('/appkeys', () => true).map(item => item.label)).toEqual(['刷新当前页面'])
  expect(assistantPageActions('/unknown', () => true)).toEqual([])
  expect(assistantPageActions('/groups', () => false)).toEqual([])
})

test('当前草稿提供续填提示而非新建，提示保留手工输入并等待用户保存', () => {
  const actions = assistantPageActions('/groups', () => true, { resource: 'groups', operation: 'create' })
  expect(actions.map(item => item.label)).toEqual(['查看分组目录', '继续填写此表单'])
  expect(actions[1]!.prompt).toContain('其他内容保持不变')
  expect(actions[1]!.prompt).toContain('点击保存')
  expect(actions.some(item => item.prompt.includes('当前筛选'))).toBe(false)
})
