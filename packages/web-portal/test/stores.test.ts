/** 状态回归：真实 Store + 可控 HTTP 响应，覆盖权限、会话竞态和查询契约。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useSessionStore } from '../src/stores/session.js'
import { buildFilter, useDashboardStore } from '../src/stores/dashboard.js'
import { useMembersStore } from '../src/stores/members.js'
import { issueMember } from '../src/api/admin.js'

const originalFetch = globalThis.fetch
let pinia: Pinia
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
const loginInput = {
  username: 'test-user',
  password: 'test-password',
  captcha_id: 'test-captcha',
  captcha: '1234',
}
const overview = {
  range: { from: null, to: null, label: '最近 7 天' },
  totalTokens: 101,
  calls: 1,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function respond(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}
function signIn(role: 'admin' | 'member' = 'member'): void {
  const session = useSessionStore()
  session.identity = { member_id: '00000000-0000-4000-8000-000000000001', name: '测试成员', username: 'test-user', role,
    permissions: role === 'admin' ? ['members:read', 'members:manage', 'tokens:manage', 'roles:read', 'departments:read'] : ['stats:read'] }
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

describe('登录状态', () => {
  test('登录使用同源 Cookie 和防跨站请求头，不发送 Bearer Token', async () => {
    let captured: RequestInit | undefined
    respond((_url, init) => {
      captured = init
      return json({ ok: true, viewer: { name: '成员', username: 'member' } })
    })
    expect(await useSessionStore().signIn(loginInput)).toBe(true)
    expect(captured?.credentials).toBe('same-origin')
    expect(new Headers(captured?.headers).get('x-portal-request')).toBe('1')
    expect(new Headers(captured?.headers).has('authorization')).toBe(false)
    expect(JSON.parse(String(captured?.body))).toEqual(loginInput)
  })
  test('恢复会话请求去重，角色来自服务端', async () => {
    let calls = 0
    respond(() => {
      calls++
      return json({
        ok: true,
        viewer: { name: '成员', username: 'member', role: 'member' },
      })
    })
    const session = useSessionStore()
    await Promise.all([session.restore(), session.restore()])
    expect(calls).toBe(1)
    expect(session.signedIn).toBe(true)
    expect(session.isAdmin).toBe(false)
  })
  test('退出失败明确提示，服务端确认退出后才清理会话', async () => {
    signIn()
    respond(() => json({ reason: '暂时不可用' }, 503))
    const session = useSessionStore()
    expect(await session.signOut()).toBe(false)
    expect(session.signedIn).toBe(true)
    expect(session.error).toContain('退出未完成')
    respond(() => json({ ok: true }))
    expect(await session.signOut()).toBe(true)
    expect(session.signedIn).toBe(false)
  })
  test('使用服务端姓名，角色缺省为 member', async () => {
    respond(() =>
      json({ ok: true, viewer: { name: '服务端姓名', username: 'test-user' } }),
    )
    const session = useSessionStore()
    expect(await session.signIn(loginInput)).toBe(true)
    expect(session.identity).toEqual({
      name: '服务端姓名',
      username: 'test-user',
      role: 'member',
    })
    expect(session.isAdmin).toBe(false)
  })
  test('退出后到达的成功校验不能恢复会话', async () => {
    const response = deferred<Response>()
    respond(() => response.promise)
    const session = useSessionStore()
    const pending = session.signIn(loginInput)
    session.expire()
    response.resolve(
      json({
        ok: true,
        viewer: { name: '管理员', username: 'test-user', role: 'admin' },
      }),
    )
    expect(await pending).toBe(false)
    expect(session.signedIn).toBe(false)
    expect(session.checking).toBe(false)
  })
  test('HTTP 200 的业务失败与空响应都不登录', async () => {
    respond(() =>
      json({ ok: false, registered: true, reason: '用户名或密码错误' }),
    )
    const session = useSessionStore()
    expect(await session.signIn(loginInput)).toBe(false)
    expect(session.error).toBe('用户名或密码错误')
    respond(() => json(null))
    expect(await session.signIn(loginInput)).toBe(false)
  })
})

describe('统计状态', () => {
  test('未登录时不查询统计接口', async () => {
    let calls = 0
    respond(() => {
      ++calls
      return json({})
    })
    await useDashboardStore().activate('overview')
    expect(calls).toBe(0)
  })
  test('候选不含人员筛选；分页只取当前页面所需接口', async () => {
    signIn()
    const urls: URL[] = []
    respond((raw) => {
      const url = new URL(raw, 'http://test')
      urls.push(url)
      if (url.pathname.endsWith('overview')) return json(overview)
      if (url.pathname.endsWith('records')) return json({ rows: [], total: 45 })
      return json({ rows: [{ key: '00000000-0000-4000-8000-000000000003', label: '张三' }, { key: '00000000-0000-4000-8000-000000000004', label: '李四' }] })
    })
    const dashboard = useDashboardStore()
    await dashboard.activate('records')
    await dashboard.applyFilters({ ...dashboard.filters, users: ['00000000-0000-4000-8000-000000000003'] })
    await dashboard.setPage(2)
    const last = urls.slice(-3)
    expect(
      last
        .find((u) => u.pathname.endsWith('breakdown'))
        ?.searchParams.has('member_id'),
    ).toBe(false)
    expect(
      last
        .find((u) => u.pathname.endsWith('records'))
        ?.searchParams.get('member_id'),
    ).toBe('00000000-0000-4000-8000-000000000003')
    expect(urls.every((u) => u.searchParams.get('identity_view') === 'member')).toBe(true)
    expect(urls.every((u) => !u.searchParams.has('user'))).toBe(true)
    expect(
      last
        .find((u) => u.pathname.endsWith('records'))
        ?.searchParams.get('offset'),
    ).toBe('20')
    expect(urls.some((u) => /series|diagnostics|admin/.test(u.pathname))).toBe(
      false,
    )
    expect(dashboard.userOptions.map((row) => row.key)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ])
  })
  test('旧查询晚到不会覆盖新时间范围', async () => {
    signIn()
    const old = deferred<Response>()
    respond((url) => {
      if (url.includes('overview') && url.includes('last7d')) return old.promise
      if (url.includes('overview'))
        return json({ ...overview, totalTokens: 202 })
      return json({ rows: [], points: [] })
    })
    const dashboard = useDashboardStore()
    const pending = dashboard.activate('overview')
    await dashboard.applyFilters({ ...dashboard.filters, period: 'today' })
    old.resolve(json(overview))
    await pending
    expect(dashboard.overview?.totalTokens).toBe(202)
  })
  test('退出时清空数据并拒绝迟到响应', async () => {
    signIn()
    const old = deferred<Response>()
    respond((url) =>
      url.includes('overview') ? old.promise : json({ rows: [], points: [] }),
    )
    const dashboard = useDashboardStore()
    const pending = dashboard.activate('overview')
    useSessionStore().expire()
    old.resolve(json(overview))
    await pending
    expect(dashboard.overview).toBeNull()
    expect(dashboard.userOptions).toEqual([])
    expect(dashboard.loading).toBe(false)
  })
  test('401 清理会话，503 保留会话并明确报错', async () => {
    signIn()
    respond(() => json({ reason: '未配置凭证' }, 503))
    const dashboard = useDashboardStore()
    await dashboard.activate('overview')
    expect(useSessionStore().signedIn).toBe(true)
    expect(dashboard.error).toContain('服务端暂未就绪')
    respond(() => json({ reason: '失效' }, 401))
    await dashboard.load()
    expect(useSessionStore().signedIn).toBe(false)
  })
  test('自定义范围不混传 period，结束时间包含整分钟', () => {
    const result = buildFilter({
      period: 'custom',
      customFrom: '2026-09-20T10:00',
      customTo: '2026-09-20T11:00',
      provider: '',
      model: '',
      users: [],
    })
    expect(result.filter.period).toBeUndefined()
    expect(result.filter.to).toBe(
      new Date('2026-09-20T11:00').getTime() + 59_999,
    )
    expect(
      buildFilter({
        period: 'custom',
        customFrom: '',
        customTo: '',
        provider: '',
        model: '',
        users: [],
      }).error,
    ).not.toBeNull()
  })
})

describe('人员管理状态', () => {
  test('普通成员不会请求人员列表', async () => {
    signIn()
    let calls = 0
    respond(() => {
      ++calls
      return json({})
    })
    await useMembersStore().load()
    expect(calls).toBe(0)
  })
  test('退出后迟到的名单不能回填', async () => {
    signIn('admin')
    const old = deferred<Response>()
    respond((url) => url.endsWith('/members') ? old.promise : json({ roles: [], departments: [] }))
    const admin = useMembersStore()
    const pending = admin.load()
    useSessionStore().expire()
    old.resolve(
      json({ members: [{ member_id: 'old', name: '旧成员' }] }),
    )
    await pending
    expect(admin.members).toEqual([])
    expect(admin.storage).toBeNull()
    expect(admin.issuedSecret).toBeNull()
  })
  test('业务失败不得展示发放成功，403 单独处理', async () => {
    signIn('admin')
    const admin = useMembersStore()
    respond(() => json({ ok: false, reason: '最后一个管理入口不可停用' }))
    expect(await admin.mutate(() => issueMember({ name: '张三', role_ids: ['00000000-0000-4000-8000-000000000002'] }), 'new-member')).toBeNull()
    expect(admin.error).toBe('最后一个管理入口不可停用')
    expect(admin.issuedSecret).toBeNull()
    respond(() => json({ reason: '没有权限' }, 403))
    await admin.load()
    expect(admin.forbidden).toContain('没有权限')
    expect(useSessionStore().signedIn).toBe(true)
    // 单个操作被拒不等于整个管理员角色已丢失；页面不能替服务端猜角色。
    expect(useSessionStore().isAdmin).toBe(true)
  })
  test('并发目录查询中途过期，成功返回的名单也不能在退出后回填', async () => {
    signIn('admin')
    respond((url) => url.endsWith('/roles') ? json({ reason: '会话已过期' }, 401)
      : url.endsWith('/members') ? json({ members: [{ member_id: 'old', name: '旧会话成员' }] })
      : url.endsWith('/departments') ? json({ departments: [{ department_id: 'old', name: '旧部门' }] })
      : json({ kind: 'mysql', available: true }))
    const admin = useMembersStore()
    await admin.load()
    expect(useSessionStore().signedIn).toBe(false)
    expect(admin.members).toEqual([])
    expect(admin.departments).toEqual([])
    expect(admin.roles).toEqual([])
    expect(admin.storage).toBeNull()
  })
})
