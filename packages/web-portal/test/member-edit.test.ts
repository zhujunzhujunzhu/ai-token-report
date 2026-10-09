/**
 * 「编辑资料」弹框的提交计划与顺序（真实 Store + 真实 api 模块 + 可控 HTTP 响应）。
 *
 * ★ 单独成文件，不塞进 `stores.test.ts` 或 `roles.test.ts`：
 *   这里钉的是**一条跨两个端点的写路径**（资料 + 角色），而它最贵的那个错误
 *   ——两条请求共用同一个 `expected_version` —— 在页面上只表现为
 *   「角色没保存上」，靠人手点一遍很难稳定复现。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import type { PortalMember, PortalMutationResult } from '@ai-token-report/shared'
import { useMembersStore } from '../src/stores/members.js'
import { useSessionStore } from '../src/stores/session.js'
import { updateMember, updateRoles } from '../src/api/admin.js'
import type { ApiResult } from '../src/api/request.js'
import { planMemberEdit, submitMemberEdit, type MemberEditActions } from '../src/views/memberEditModel.js'

const originalFetch = globalThis.fetch
let pinia: Pinia
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const memberId = '00000000-0000-4000-8000-0000000000aa'
const otherId = '00000000-0000-4000-8000-0000000000bb'
const roleAdmin = '00000000-0000-4000-8000-0000000000b1'
const roleOps = '00000000-0000-4000-8000-0000000000b2'
const groupA = '00000000-0000-4000-8000-0000000000c1'
const groupB = '00000000-0000-4000-8000-0000000000c2'

/** 一条人员行。`roles` / `groups` 只带引用字段，与 `GET /api/v1/admin/members` 一致。 */
function member(overrides: Partial<PortalMember> = {}): PortalMember {
  return {
    member_id: memberId,
    name: '田文渊',
    status: 'active',
    groups: [{ group_id: groupA, name: '数字建造中心-开发' }],
    roles: [{ role_id: roleAdmin, code: 'admin', name: '管理员', permissions: ['members:manage'], is_builtin: true, status: 'active', version: 1 }],
    account: null,
    active_token_count: 0,
    version: 5,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  }
}
function directoryResponse(url: string, rows: PortalMember[] = [member()]): Response {
  if (url.endsWith('/members')) return json({ members: rows })
  if (url.endsWith('/roles')) return json({ roles: [], permissions: [] })
  if (url.endsWith('/groups')) return json({ groups: [] })
  return json({ kind: 'sqlite', available: true })
}
function respond(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}
function signIn(): void {
  const session = useSessionStore()
  session.identity = {
    member_id: memberId, name: '测试管理员', username: 'admin', role: 'admin',
    permissions: ['members:read', 'members:manage', 'roles:read', 'roles:assign', 'groups:read'],
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

describe('编辑资料的提交计划', () => {
  test('按维度判定「改没改」：只改姓名不算改角色', () => {
    const current = member()
    expect(planMemberEdit(current, { name: '田文渊', group_ids: [groupA], role_ids: [roleAdmin] }, true))
      .toEqual({ ok: true, changed: false, profile: false, roles: false, name: '田文渊', group_ids: [groupA] })
    const renamed = planMemberEdit(current, { name: '  田文渊2  ', group_ids: [groupA], role_ids: [roleAdmin] }, true)
    expect(renamed).toEqual({ ok: true, changed: true, profile: true, roles: false, name: '田文渊2', group_ids: [groupA] })
  })
  test('多选顺序不是语义：同一批分组换个顺序仍是「没改」', () => {
    const current = member({ groups: [{ group_id: groupA, name: 'A' }, { group_id: groupB, name: 'B' }] })
    expect(planMemberEdit(current, { name: '田文渊', group_ids: [groupB, groupA], role_ids: [roleAdmin] }, true).changed).toBe(false)
    // 少一个就是真的改了：全量替换语义下这会把 B 摘掉。
    expect(planMemberEdit(current, { name: '田文渊', group_ids: [groupA], role_ids: [roleAdmin] }, true).changed).toBe(true)
  })
  test('没有 roles:assign 时角色那一维直接缺席，也不校验空角色', () => {
    const current = member()
    const plan = planMemberEdit(current, { name: '田文渊', group_ids: [groupA], role_ids: [] }, false)
    // 「把角色清空了」这件事对没有权限的人不成立：他根本没被允许提交角色。
    expect(plan).toEqual({ ok: true, changed: false, profile: false, roles: false, name: '田文渊', group_ids: [groupA] })
  })
  test('有权限却清空角色：本地先拦下，别等一次必然的 400', () => {
    expect(planMemberEdit(member(), { name: '田文渊', group_ids: [groupA], role_ids: [] }, true))
      .toEqual({ ok: false, reason: '人员至少需要一个角色' })
  })
  test('姓名非法沿用 shared 的文案', () => {
    expect(planMemberEdit(member(), { name: '   ', group_ids: [], role_ids: [roleAdmin] }, true))
      .toEqual({ ok: false, reason: '请填写你的姓名' })
  })
})

describe('编辑资料的提交顺序', () => {
  /** 记录每一条写请求；GET 一律走目录响应。 */
  function recorder(posts: Array<{ url: string; body: Record<string, unknown> }>, profile: PortalMember, roles: PortalMember) {
    respond((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        return url.endsWith('/members/update') ? json({ ok: true, member: profile }) : json({ ok: true, member: roles })
      }
      return directoryResponse(url)
    })
  }
  /** 注入真实 store 与真实 api 模块：顺序逻辑必须能在真 HTTP 边界上被断言。 */
  function harness(): { store: ReturnType<typeof useMembersStore>; actions: MemberEditActions } {
    const store = useMembersStore()
    return {
      store,
      actions: {
        mutate: <T extends PortalMutationResult>(action: () => Promise<ApiResult<T>>, id: string) => store.mutate(action, id),
        updateProfile: updateMember,
        updateRoles,
      },
    }
  }
  test('资料与角色一起改：先资料、后角色，且第二条用服务端返回的新版本号', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    recorder(posts, member({ version: 6 }), member({ version: 7 }))
    const { store, actions: act } = harness()
    await store.load('members')
    const outcome = await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊2', group_ids: [groupA, groupB], role_ids: [roleOps],
    }, true)
    expect(outcome).toEqual({ ok: true, changed: true })
    expect(posts.map((post) => post.url))
      .toEqual(['/api/v1/admin/members/update', '/api/v1/admin/members/roles'])
    expect(posts[0]!.body).toEqual({ member_id: memberId, expected_version: 5, name: '田文渊2', group_ids: [groupA, groupB] })
    // 🚨 写成功即 `version + 1`：这里若仍是 5，真实服务端一定回 409
    //    （页面上的表现只是「角色没保存上」）。
    expect(posts[1]!.body).toEqual({ member_id: memberId, expected_version: 6, role_ids: [roleOps] })
    expect(store.error).toBeNull()
  })
  test('只改角色就只发一条请求，且不带资料字段', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    recorder(posts, member(), member({ version: 6 }))
    const { store, actions: act } = harness()
    await store.load('members')
    expect(await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊', group_ids: [groupA], role_ids: [roleOps],
    }, true)).toEqual({ ok: true, changed: true })
    expect(posts.map((post) => post.url)).toEqual(['/api/v1/admin/members/roles'])
    expect(posts[0]!.body).toEqual({ member_id: memberId, expected_version: 5, role_ids: [roleOps] })
  })
  test('没有 roles:assign 时一个角色字节都不提交', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    recorder(posts, member({ version: 6 }), member({ version: 7 }))
    const { store, actions: act } = harness()
    await store.load('members')
    // 草稿里带着一份完全不同的角色（例：表单没渲染那一栏，值仍是打开时的快照）：
    // 没有权限就必须当它不存在。
    expect(await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊2', group_ids: [groupA], role_ids: [otherId],
    }, false)).toEqual({ ok: true, changed: true })
    expect(posts.map((post) => post.url)).toEqual(['/api/v1/admin/members/update'])
  })
  test('什么都没改就一条请求都不发（白写一次会平白推高版本号）', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    recorder(posts, member(), member())
    const { store, actions: act } = harness()
    await store.load('members')
    expect(await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊', group_ids: [groupA], role_ids: [roleAdmin],
    }, true)).toEqual({ ok: true, changed: false })
    expect(posts).toEqual([])
  })
  test('第一条失败就不再发第二条，且失败原因留给 store 那份文案', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    respond((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        return json({ ok: false, reason: '必须保留至少一个可登录或持有长期管理凭证的管理员', code: 'last_administrator' })
      }
      return directoryResponse(url)
    })
    const { store, actions: act } = harness()
    await store.load('members')
    const outcome = await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊2', group_ids: [groupA], role_ids: [roleOps],
    }, true)
    // `reason: null` = 「原因已经写在 store 的 error 上了，页面别覆盖」。
    expect(outcome).toEqual({ ok: false, reason: null })
    expect(posts.map((post) => post.url)).toEqual(['/api/v1/admin/members/update'])
    expect(store.error).toBe('必须保留至少一个可登录或持有长期管理凭证的管理员')
  })
  test('本地拦下的原因不经 store（它没有请求可失败）', async () => {
    signIn()
    const posts: Array<{ url: string; body: Record<string, unknown> }> = []
    recorder(posts, member(), member())
    const { store, actions: act } = harness()
    await store.load('members')
    expect(await submitMemberEdit(act, store.members[0]!, {
      name: '田文渊', group_ids: [groupA], role_ids: [],
    }, true)).toEqual({ ok: false, reason: '人员至少需要一个角色' })
    expect(posts).toEqual([])
    expect(store.error).toBeNull()
  })
})
