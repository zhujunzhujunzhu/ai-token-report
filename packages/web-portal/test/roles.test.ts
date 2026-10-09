/**
 * 角色定义的目录与变更路径（真实 Store + 真实 api 模块 + 可控 HTTP 响应）。
 *
 * ★ 单独成文件，不塞进 `stores.test.ts`：那份文件测的是「管理页共用目录加载」，
 *   而这里测的是**角色这一条写路径**（权限目录从哪来、变更打到哪个端点）。
 *   分开也让人一眼看出「角色目录 + 权限目录是一次请求拿回来的」。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useMembersStore } from '../src/stores/members.js'
import { useSessionStore } from '../src/stores/session.js'
import { createRole, updateRoleStatus } from '../src/api/admin.js'
import { assignableRoles, filterRoles, permissionLabel, permissionOptions, rolePickerOptions } from '../src/views/rolesModel.js'
import type { PortalRole } from '@ai-token-report/shared'

const originalFetch = globalThis.fetch
let pinia: Pinia
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const roleCatalog = {
  roles: [
    { role_id: '00000000-0000-4000-8000-000000000001', code: 'admin', name: '管理员', permissions: ['roles:assign'], is_builtin: true, status: 'active', version: 1 },
    { role_id: '00000000-0000-4000-8000-0000000000a1', code: 'ops-viewer', name: '运营查看者', permissions: ['stats:read'], is_builtin: false, status: 'active', version: 2 },
  ],
  permissions: [{ code: 'stats:read', description: 'stats:read' }],
}
function respond(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}
function signIn(): void {
  const session = useSessionStore()
  session.identity = {
    member_id: '00000000-0000-4000-8000-000000000001', name: '测试管理员', username: 'admin', role: 'admin',
    permissions: ['members:read', 'roles:read', 'roles:assign'],
  }
  session.generation++
  session.initialized = true
}
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => {
  disposePinia(pinia)
  globalThis.fetch = originalFetch
})

describe('角色页的纯判断', () => {
  const role = (code: string, name: string, status: PortalRole['status'], is_builtin = false): PortalRole => ({
    role_id: `00000000-0000-4000-8000-0000000000${code.length}${code.charCodeAt(0)}`.slice(0, 36).padEnd(36, '0'),
    code, name, permissions: [], is_builtin, status, version: 1,
  })
  const roles = [
    role('admin', '管理员', 'active', true),
    role('member', '成员', 'active', true),
    role('ops-viewer', '运营查看者', 'disabled'),
    role('audit-reader', '审计查阅', 'active'),
  ]

  test('状态与关键字过滤，关键字命中名称或标识且大小写无关', () => {
    expect(filterRoles(roles, { search: '', status: '' }).map((item) => item.code))
      .toEqual(['admin', 'member', 'ops-viewer', 'audit-reader'])
    expect(filterRoles(roles, { search: '', status: 'disabled' }).map((item) => item.code)).toEqual(['ops-viewer'])
    expect(filterRoles(roles, { search: '运营', status: '' }).map((item) => item.code)).toEqual(['ops-viewer'])
    // 标识是给人排查用的：输 `OPS` 也该找得到，否则页面看起来「这个角色不存在」。
    expect(filterRoles(roles, { search: 'OPS', status: '' }).map((item) => item.code)).toEqual(['ops-viewer'])
    expect(filterRoles(roles, { search: '  ', status: 'active' }).map((item) => item.code))
      .toEqual(['admin', 'member', 'audit-reader'])
    expect(filterRoles(roles, { search: '不存在', status: '' })).toEqual([])
  })
  test('分配下拉只列启用角色（停用角色选了也一定被服务端拒绝）', () => {
    expect(assignableRoles(roles).map((item) => item.code)).toEqual(['admin', 'member', 'audit-reader'])
  })
  /**
   * ★ 人员「编辑资料」弹框与这里**刻意不同**：那边保存是全量替换，
   *   把「已停用但仍被这个人持有」的角色从下拉里抹掉，等于保存那一刻静默摘掉它。
   */
  test('编辑弹框的角色候选：启用角色 ∪ 当前持有（含已停用，标注出来）', () => {
    expect(rolePickerOptions(roles, [])).toEqual([
      { value: roles[0]!.role_id, label: '管理员' },
      { value: roles[1]!.role_id, label: '成员' },
      { value: roles[3]!.role_id, label: '审计查阅' },
    ])
    // 持有的那个已停用角色必须留在候选里，并写明它为什么保存不上。
    expect(rolePickerOptions(roles, [roles[2]!.role_id])).toContainEqual({
      value: roles[2]!.role_id, label: '运营查看者（已停用）',
    })
    // 已停用但**没有**被这个人持有：仍然不列（选了必然 400）。
    expect(rolePickerOptions(roles, [roles[0]!.role_id]).map((option) => option.label)).toEqual(['管理员', '成员', '审计查阅'])
  })
  test('权限标签逐级回退：中文说明 → 服务端描述 → 权限码本身', () => {
    expect(permissionLabel('groups:manage')).toBe('管理分组')
    // 数据库里新增的权限码：页面必须仍然列得出来（否则「勾不上」且看不出来）
    expect(permissionLabel('billing:read', 'billing:read')).toBe('billing:read')
    expect(permissionLabel('billing:read', '查看账单')).toBe('查看账单')
    expect(permissionLabel('billing:read', '   ')).toBe('billing:read')
    expect(permissionOptions([{ code: 'groups:read', description: 'groups:read' }]))
      .toEqual([{ code: 'groups:read', label: '查看分组' }])
  })
})

describe('角色定义管理', () => {
  test('角色目录与权限目录一次读回，权限清单以服务端为准', async () => {
    signIn()
    respond((url) => url.endsWith('/roles') ? json(roleCatalog) : json({ members: [] }))
    const admin = useMembersStore()
    await admin.load('roles')
    // ★ 勾选清单必须来自服务端：页面自己硬编码一份就会漏掉数据库里真实存在的权限，
    //   而页面看起来「权限就这些」—— 这是新角色永远授不出新权限的那类静默故障。
    expect(admin.permissions).toEqual(roleCatalog.permissions)
    expect(admin.roles.map((role) => [role.code, role.is_builtin, role.version]))
      .toEqual([['admin', true, 1], ['ops-viewer', false, 2]])
  })
  test('新建与停用角色打到各自端点，停用后角色仍留在目录里', async () => {
    signIn()
    const calls: string[] = []
    respond((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return init?.method === 'POST' ? json({ ok: true }) : url.endsWith('/roles') ? json(roleCatalog) : json({ members: [] })
    })
    const admin = useMembersStore()
    await admin.load('roles')
    calls.length = 0
    expect(await admin.mutate(() => createRole({ code: 'ops2', name: '运营二', permission_codes: ['stats:read'] }), 'new-role')).not.toBeNull()
    // 变更后按当前页刷新：角色页同时依赖人员（算「关联人员」）与角色目录。
    expect(calls).toEqual(['POST /api/v1/admin/roles', 'GET /api/v1/admin/members', 'GET /api/v1/admin/roles'])
    calls.length = 0
    expect(await admin.mutate(() => updateRoleStatus({ role_id: roleCatalog.roles[1]!.role_id, expected_version: 2, status: 'disabled' }), roleCatalog.roles[1]!.role_id)).not.toBeNull()
    expect(calls[0]).toBe('POST /api/v1/admin/roles/status')
    // 停用是软删除：角色仍在目录里（否则页面再也找不到它，也没法重新启用）。
    expect(admin.roles.some((role) => role.code === 'ops-viewer')).toBe(true)
  })
  test('业务拒绝保留在页面上，且不把停用选项留在下一个会话里', async () => {
    signIn()
    respond((url) => url.endsWith('/roles') ? json(roleCatalog) : json({ members: [] }))
    const admin = useMembersStore()
    await admin.load('roles')
    respond(() => json({ ok: false, reason: '系统内置角色由服务端维护，不能改名、改权限或停用' }))
    expect(await admin.mutate(() => updateRoleStatus({ role_id: roleCatalog.roles[0]!.role_id, expected_version: 1, status: 'disabled' }), roleCatalog.roles[0]!.role_id)).toBeNull()
    expect(admin.error).toContain('内置角色')
    admin.clear()
    expect([admin.roles, admin.permissions]).toEqual([[], []])
  })
  test('角色目录是 403 时不落任何数据，也不影响会话', async () => {
    signIn()
    respond(() => json({ reason: '没有权限' }, 403))
    const admin = useMembersStore()
    await admin.load('roles')
    expect(admin.forbidden).toContain('没有权限')
    expect([admin.roles, admin.permissions]).toEqual([[], []])
    expect(useSessionStore().signedIn).toBe(true)
  })
})