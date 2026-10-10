/** 导航同步条件必须保持边界，不接受任意路由或数据范围参数。 */
import { expect, test } from 'bun:test'
import { assistantNavigation } from '../src/assistant/navigation.js'
import type { Principal } from '../src/identity/types.js'
const principal = { permissions: ['stats:read', 'projects:read'] } as Principal
test('同步用量筛选和管理搜索', () => {
  expect(assistantNavigation({ path: '/analysis', filters: { period: 'year', model: '完整模型', member_id: '01234567-1234-1234-1234-0123456789ab' } }, principal).filters?.period).toBe('year')
  expect(assistantNavigation({ path: '/projects', search: '项目甲' }, principal).search).toBe('项目甲')
})
test('来源显示名规范成稳定代码，并保持两版Trae分离', () => {
  for (const [source, code] of [['DSH', 'dsh'], ['Claude Code', 'claude-code'], ['WorkBuddy', 'workbuddy'], ['Trae', 'trae'], ['Trae-CN', 'trae-cn']]) {
    expect(assistantNavigation({ path: '/records', filters: { source } }, principal).filters?.source).toBe(code)
  }
})
test('管理页空筛选等同未指定，非空统计条件与非法对象仍拒绝', () => {
  const admin = { permissions: ['tokens:manage', 'projects:read'] } as Principal
  for (const path of ['/appkeys', '/projects']) {
    expect(assistantNavigation({ path, filters: {}, search: '项目甲' }, admin)).toEqual({ type: 'navigate', path, search: '项目甲' })
    for (const filters of [{ period: 'yesterday' }, { member_id: '01234567-1234-1234-1234-0123456789ab' }, null, [], '']) expect(() => assistantNavigation({ path, filters }, admin)).toThrow()
  }
  expect(() => assistantNavigation({ path: '/appkeys', filters: {} }, principal)).toThrow('访问权限')
  expect(assistantNavigation({ path: '/analysis', filters: {} }, principal)).toEqual({ type: 'navigate', path: '/analysis' })
})
test('白名单、权限、时间窗和参数拒绝', () => {
  for (const args of [{ path: 'https://example.org' }, { path: '/members' }, { path: '/analysis', filters: { identity_view: 'legacy' } }, { path: '/analysis', filters: { period: 'year', from: '1', to: '2' } }, { path: '/analysis', filters: { from: '-1', to: '2' } }, { path: '/projects', filters: { period: 'year' } }, { path: '/records', filters: { from: '0', to: String(32 * 86_400_000) } }]) expect(() => assistantNavigation(args, principal)).toThrow()
})
