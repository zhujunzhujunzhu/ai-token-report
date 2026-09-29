/** 状态回归：真实 Store + 可控 HTTP 响应，覆盖权限、会话竞态和查询契约。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useSessionStore } from '../src/stores/session.js'
import { buildFilter, useDashboardStore } from '../src/stores/dashboard.js'
import { useMembersStore } from '../src/stores/members.js'
import { periodReadyForQuery } from '../src/types/portal.js'
import { createGroup, issueMember, updateMember, updateRoles } from '../src/api/admin.js'

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
    permissions: role === 'admin' ? ['members:read', 'members:manage', 'tokens:manage', 'roles:read', 'groups:read'] : ['stats:read'] }
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
  test('全员排行复用候选请求，筛人后仍保留完整候选', async () => {
    signIn()
    const urls: URL[] = []
    respond((raw) => {
      const url = new URL(raw, 'http://test')
      urls.push(url)
      if (url.pathname.endsWith('overview')) return json(overview)
      if (url.pathname.endsWith('series')) return json({ points: [] })
      return json({ rows: url.searchParams.has('member_id')
        ? [{ key: 'selected' }]
        : [{ key: 'selected' }, { key: 'other' }] })
    })
    const dashboard = useDashboardStore()
    await dashboard.activate('overview')
    // 总览一轮 5 个请求：指标、人员候选、分组候选、趋势、分组排行。
    // ★ 分组候选走看板接口 `/api/v1/stats/groups`（`stats:read`），
    //   不是管理接口 `/api/v1/admin/groups`（那是 `groups:read`）。
    expect(urls).toHaveLength(5)
    expect(urls.filter((url) => url.pathname.endsWith('/api/v1/stats/groups'))).toHaveLength(1)
    const by = (url: URL, value: string) =>
      url.pathname.endsWith('breakdown') && url.searchParams.get('by') === value
    // ★ 全员排行复用候选请求：`by=user` 只发一次；另一次是分组排行 `by=group`。
    expect(urls.filter((url) => by(url, 'user'))).toHaveLength(1)
    expect(urls.filter((url) => by(url, 'group'))).toHaveLength(1)
    expect(dashboard.ranking).toEqual(dashboard.userOptions)
    urls.length = 0
    await dashboard.applyFilters({ ...dashboard.filters, users: ['selected'] })
    // 筛人后 `by=user` 变成两次（不带筛选的候选 + 带筛选的排行），
    // 分组排行仍是一次 —— 两个维度各自取数，互不吞掉对方的候选。
    expect(urls.filter((url) => by(url, 'user'))).toHaveLength(2)
    expect(urls.filter((url) => by(url, 'group'))).toHaveLength(1)
    expect(dashboard.ranking.map((row) => row.key)).toEqual(['selected'])
    expect(dashboard.userOptions.map((row) => row.key)).toEqual(['selected', 'other'])
  })
  test('后台刷新在前次查询未结束时不堆积请求', async () => {
    signIn()
    const first = deferred<Response>()
    let calls = 0
    respond((url) => {
      calls++
      return url.includes('overview') ? first.promise : json({ rows: [], points: [] })
    })
    const dashboard = useDashboardStore()
    const initial = dashboard.activate('overview')
    const before = calls
    await dashboard.load(true)
    expect(calls).toBe(before)
    first.resolve(json(overview))
    await initial
    expect(dashboard.overview?.totalTokens).toBe(101)
  })
  test('看板刷新同步更新打开的人员详情并保留服务端数值', async () => {
    signIn()
    let totalTokens = 101
    respond((url) => url.includes('overview')
      ? json({ ...overview, totalTokens })
      : json({ rows: [], points: [] }))
    const dashboard = useDashboardStore()
    await dashboard.activate('overview')
    await dashboard.openUser('selected')
    expect(dashboard.detail?.overview?.totalTokens).toBe(101)
    totalTokens = 303
    await dashboard.load(true)
    expect(dashboard.overview?.totalTokens).toBe(303)
    expect(dashboard.detail?.overview?.totalTokens).toBe(303)
    expect(dashboard.detailLoading).toBe(false)
  })
  test('详情后台刷新保留旧数据、不重叠，关闭后拒绝迟到响应', async () => {
    signIn()
    respond((url) => url.includes('overview') ? json(overview) : json({ rows: [], points: [] }))
    const dashboard = useDashboardStore()
    await dashboard.activate('overview')
    await dashboard.openUser('selected')
    const waiting = deferred<Response>()
    const started = deferred<void>()
    let detailCalls = 0
    respond((raw) => {
      const url = new URL(raw, 'http://test')
      if (url.searchParams.has('member_id')) {
        detailCalls++
        if (url.pathname.endsWith('overview')) {
          started.resolve()
          return waiting.promise
        }
      }
      return url.pathname.endsWith('overview') ? json(overview) : json({ rows: [], points: [] })
    })
    const pending = dashboard.load(true)
    await started.promise
    expect(dashboard.detail?.overview?.totalTokens).toBe(101)
    expect(dashboard.detailLoading).toBe(false)
    await dashboard.load(true)
    expect(detailCalls).toBe(3)
    dashboard.closeUser()
    waiting.resolve(json({ ...overview, totalTokens: 404 }))
    await pending
    expect(dashboard.detail).toBeNull()
    expect(dashboard.detailLoading).toBe(false)
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
    // 一轮请求的实际发出顺序是「候选 → 分组候选 → 指标 → 本页数据」，
    // 所以取末尾 4 条来覆盖这一轮（多了分组候选这一条）。
    const last = urls.slice(-4)
    expect(
      last
        .find((u) => u.pathname.endsWith('breakdown'))
        ?.searchParams.has('member_id'),
    ).toBe(false)
    // ★ 分组候选必须始终是完整集合：带上筛选就会让下拉在选中后塌缩成一项。
    expect(urls.find((u) => u.pathname.endsWith('/api/v1/stats/groups'))?.searchParams.size).toBe(0)
    expect(
      last
        .find((u) => u.pathname.endsWith('records'))
        ?.searchParams.get('member_id'),
    ).toBe('00000000-0000-4000-8000-000000000003')
    expect(
      // 分组候选是唯一**完全不带查询参数**的请求：它只回答「有哪些分组」，
      // 一旦带上筛选就会自锁定，所以把它排除在「都带 identity_view」之外。
      urls
        .filter((u) => !u.pathname.endsWith('/api/v1/stats/groups'))
        .every((u) => u.searchParams.get('identity_view') === 'member'),
    ).toBe(true)
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
  test('下拉选中即筛：具名周期随时可查，自定义区间要等起止填齐', () => {
    // 时间范围 / 人员是离散选择，选中即应用，不再依赖「查询」按钮。
    for (const period of ['today', 'last7d', 'month']) {
      expect(periodReadyForQuery(period, '', '')).toBe(true)
      expect(periodReadyForQuery(period, '2026-09-20T10:00', '')).toBe(true)
    }
    // 切到自定义区间的瞬间两个输入框必然为空：此刻查询只会报「请选择开始与结束时间」。
    expect(periodReadyForQuery('custom', '', '')).toBe(false)
    expect(periodReadyForQuery('custom', '2026-09-20T10:00', '')).toBe(false)
    expect(periodReadyForQuery('custom', '', '2026-09-20T11:00')).toBe(false)
    expect(
      periodReadyForQuery('custom', '2026-09-20T10:00', '2026-09-20T11:00'),
    ).toBe(true)
  })
})

describe('人员管理状态', () => {
  function directoryResponse(url: string): Response {
    if (url.endsWith('/members')) return json({ members: [] })
    if (url.endsWith('/roles')) return json({ roles: [] })
    if (url.endsWith('/groups')) return json({ groups: [] })
    return json({ kind: 'sqlite', available: true })
  }
  test('三个管理页各自请求所需目录，刷新沿用当前页，清理后回到人员页', async () => {
    signIn('admin')
    const calls: string[] = []
    respond((url) => { calls.push(url); return directoryResponse(url) })
    const admin = useMembersStore()
    // 人员页一轮要读四份目录：人员、角色、分组、数据库状态（分组走 /api/v1/groups）。
    const memberRequests = ['/api/v1/admin/members', '/api/v1/admin/roles', '/api/v1/groups', '/api/v1/admin/storage']
    await admin.load()
    expect(calls).toEqual(memberRequests)
    calls.length = 0
    await admin.load('roles')
    expect(calls).toEqual(['/api/v1/admin/members', '/api/v1/admin/roles'])
    calls.length = 0
    await admin.load()
    expect(calls).toEqual(['/api/v1/admin/members', '/api/v1/admin/roles'])
    calls.length = 0
    await admin.load('groups')
    expect(calls).toEqual(['/api/v1/groups'])
    calls.length = 0
    admin.clear()
    await admin.load()
    expect(calls).toEqual(memberRequests)
  })
  test('目录只读权限不会额外请求无权访问的人员、角色、分组或数据库状态', async () => {
    const scenarios = [
      { section: 'members', permission: 'members:read', urls: ['/api/v1/admin/members', '/api/v1/admin/storage'] },
      { section: 'roles', permission: 'roles:read', urls: ['/api/v1/admin/roles'] },
      { section: 'groups', permission: 'groups:read', urls: ['/api/v1/groups'] },
    ] as const
    for (const scenario of scenarios) {
      signIn('admin')
      useSessionStore().identity!.permissions = [scenario.permission]
      const calls: string[] = []
      respond((url) => { calls.push(url); return directoryResponse(url) })
      await useMembersStore().load(scenario.section)
      expect(calls).toEqual([...scenario.urls])
      expect(useMembersStore().error).toBeNull()
    }
  })
  test('目录变更成功只刷新当前角色页或分组页', async () => {
    signIn('admin')
    const calls: string[] = []
    respond((url, init) => {
      calls.push(`${init?.method} ${url}`)
      return init?.method === 'POST' ? json({ ok: true }) : directoryResponse(url)
    })
    const admin = useMembersStore()
    await admin.load('roles')
    calls.length = 0
    await admin.mutate(() => updateRoles({ member_id: 'person', expected_version: 1, role_ids: ['member'] }), 'person')
    expect(calls).toEqual(['POST /api/v1/admin/members/roles', 'GET /api/v1/admin/members', 'GET /api/v1/admin/roles'])
    await admin.load('groups')
    calls.length = 0
    await admin.mutate(() => createGroup('研发组'), 'new-group')
    expect(calls).toEqual(['POST /api/v1/admin/groups', 'GET /api/v1/groups'])
  })
  /**
   * ★ 人员与分组是多对多，`group_ids` 是**全量替换**语义。
   *
   * 这条断言钉住的是「请求体里给的就是最终的完整集合」：页面把多选框的
   * 当前值整份提交，而不是发一个「新增了谁 / 移除了谁」的增量 ——
   * 增量语义下两个人同时改同一个人会各自成功、结果却谁也没想到。
   */
  test('人员分组归属按全量替换提交，请求体给出完整集合', async () => {
    signIn('admin')
    const bodies: Array<Record<string, unknown>> = []
    respond((url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json({ ok: true })
      }
      return directoryResponse(url)
    })
    const admin = useMembersStore()
    const groupIds = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2']
    await admin.mutate(() => updateMember({
      member_id: '00000000-0000-4000-8000-000000000001', expected_version: 3, group_ids: groupIds,
    }), 'person')
    // 两个分组一起提交（多对多），且是整份替换：空数组代表「移出全部分组」。
    expect(bodies[0]?.group_ids).toEqual(groupIds)
    bodies.length = 0
    await admin.mutate(() => updateMember({
      member_id: '00000000-0000-4000-8000-000000000001', expected_version: 4, group_ids: [],
    }), 'person')
    expect(bodies[0]?.group_ids).toEqual([])
  })
  test('切换管理页后旧人员查询不能覆盖新页数据', async () => {
    signIn('admin')
    const old = deferred<Response>()
    let memberReads = 0
    respond((url) => {
      if (url.endsWith('/members')) {
        memberReads++
        return memberReads === 1 ? old.promise : json({ members: [{ member_id: 'fresh', name: '当前成员' }] })
      }
      return directoryResponse(url)
    })
    const admin = useMembersStore()
    const pending = admin.load('members')
    await admin.load('roles')
    old.resolve(json({ members: [{ member_id: 'old', name: '旧成员' }] }))
    await pending
    expect(admin.members.map((member) => member.member_id)).toEqual(['fresh'])
    expect(admin.storage).toBeNull()
    expect(admin.loading).toBe(false)
  })
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
    respond((url) => url.endsWith('/members') ? old.promise : json({ roles: [], groups: [] }))
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
      : url.endsWith('/groups') ? json({ groups: [{ group_id: 'old', name: '旧分组' }] })
      : json({ kind: 'mysql', available: true }))
    const admin = useMembersStore()
    await admin.load()
    expect(useSessionStore().signedIn).toBe(false)
    expect(admin.members).toEqual([])
    expect(admin.groups).toEqual([])
    expect(admin.roles).toEqual([])
    expect(admin.storage).toBeNull()
  })
})
