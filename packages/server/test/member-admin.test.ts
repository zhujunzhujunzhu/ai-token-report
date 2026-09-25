/**
 * 人员管理与 token 发放（`member-admin.ts` + `admin-route.ts`）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **签发即刻生效** —— 管理页签发 / 重置的 token 必须马上能上报、
 *    能看看板。若只在文件里生效（等重启），管理员已经把 token 发给员工了，
 *    而员工那边会看到「token 无效」。
 * 2. ★ **最后一个管理员不可删、不可降级** —— 否则一次误操作后
 *    *所有人都无法再发放 token*，只能改文件恢复。
 * 3. ★ **凭证文件读不懂时拒绝一切写入** —— 按内存里的空表覆盖 =
 *    静默吊销全员（与「上报库绝不自动重建」同类事故）。
 * 4. **重名拒绝** —— 看板按姓名分组，同名会把两个人并成一个人，
 *    而且看不出任何异常。
 * 5. **鉴权三类分开**：没配凭证 503 / token 不对 401 / 不是管理员 403。
 *    合并成一个状态码，页面就只能说一句含糊的「操作失败」。
 * 6. **环境变量注入的管理员不可在页面上增删改** —— 对它执行删除在页面上
 *    看起来「什么也没发生」（重启就回来了），必须明说去改哪里。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROLE_ADMIN, ROLE_MEMBER } from '@ai-token-report/shared'

import { AdminRoute } from '../src/admin-route.js'
import { CredentialStore } from '../src/credentials.js'
import { envAdminFrom, loadMembers, type MemberAdmin } from '../src/member-admin.js'

let home: string
let credentialsPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-member-admin-'))
  credentialsPath = join(home, 'token-report', 'credentials.json')
  mkdirSync(join(home, 'token-report'), { recursive: true })
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 写一份凭证文件（数组格式）。 */
function writeCredentials(entries: unknown): void {
  writeFileSync(credentialsPath, JSON.stringify(entries, null, 2), 'utf8')
}

/** 读回文件内容（断言落盘结果用）。 */
function readCredentials(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>[]
}

/** 起一套「一个管理员 + 一个普通成员」的环境。 */
function setup(options: { envAdmin?: boolean } = {}): {
  admin: MemberAdmin
  store: CredentialStore
  route: AdminRoute
} {
  writeCredentials([
    { token: 'tok-boss', name: '李经理', role: 'admin' },
    { token: 'tok-zhang', name: '张三', dept: '研发一部' },
  ])
  const { admin, store } = loadMembers({
    credentialsPath,
    ...(options.envAdmin
      ? { envAdmin: { token: 'tok-env', name: '部署管理员', role: ROLE_ADMIN, source: 'env' } }
      : {}),
  })
  return { admin, store, route: new AdminRoute({ store, admin }) }
}

describe('凭证表：角色与来源', () => {
  test('role 缺省是普通成员（绝不默认成管理员）', () => {
    const { store } = setup()
    const zhang = store.verify('tok-zhang')
    expect(zhang.ok).toBe(true)
    expect(zhang.role).toBe(ROLE_MEMBER)
    expect(store.verify('tok-boss').role).toBe(ROLE_ADMIN)
    expect(store.adminCount).toBe(1)
  })

  test('非法 role 值降级为 member，而不是让整份文件解析失败', () => {
    writeCredentials([{ token: 'tok-a', name: '甲', role: 'root' }])
    const { store } = loadMembers({ credentialsPath })
    // 一个人写错 role 不该让全部门的 token 集体失效
    expect(store.registered).toBe(true)
    expect(store.verify('tok-a').role).toBe(ROLE_MEMBER)
  })

  test('环境变量注入的管理员带 source=env，且不落文件', () => {
    const { store, admin } = setup({ envAdmin: true })
    const env = store.findByToken('tok-env')
    expect(env?.source).toBe('env')
    expect(admin.list().some((m) => m.source === 'env' && m.role === ROLE_ADMIN)).toBe(true)
    // 它不在文件里
    expect(readCredentials().some((e) => e['token'] === 'tok-env')).toBe(false)
  })

  test('envAdminFrom 只在 ATR_ADMIN_TOKEN 非空时生效', () => {
    expect(envAdminFrom({})).toBeNull()
    expect(envAdminFrom({ ATR_ADMIN_TOKEN: '   ' })).toBeNull()
    const admin = envAdminFrom({ ATR_ADMIN_TOKEN: 'tok-x' })
    expect(admin?.role).toBe(ROLE_ADMIN)
    // 没给名字时有个能看懂的默认值
    expect(admin?.name).toBe('管理员')
    expect(envAdminFrom({ ATR_ADMIN_TOKEN: 'tok-x', ATR_ADMIN_NAME: '王工' })?.name).toBe('王工')
  })
})

describe('★ 签发 token', () => {
  test('列表：管理员在前，成员带部门，来源标明', () => {
    const { admin } = setup()
    const members = admin.list()
    expect(members.map((m) => m.name)).toEqual(['李经理', '张三'])
    expect(members[0]!.role).toBe(ROLE_ADMIN)
    expect(members[1]!.dept).toBe('研发一部')
    expect(members[1]!.source).toBe('file')
  })

  test('★ 新 token 立刻可用于校验（不必重启服务端）', () => {
    const { admin, store } = setup()
    const res = admin.issue({ name: '王五', dept: '研发二部' })
    expect(res.ok).toBe(true)
    const token = res.member!.token

    expect(token.startsWith('atr-')).toBe(true)
    // 共享的同一个 store —— 这个断言就是「即时生效」的机制保证
    const verified = store.verify(token)
    expect(verified.ok).toBe(true)
    expect(verified.name).toBe('王五')
    expect(verified.role).toBe(ROLE_MEMBER)
    expect(verified.dept).toBe('研发二部')
  })

  test('落盘：数组格式，成员不写 role 字段，带 createdAt', () => {
    const { admin } = setup()
    admin.issue({ name: '王五' })
    const file = readCredentials()
    const wang = file.find((e) => e['name'] === '王五')!
    expect(wang['token']).toMatch(/^atr-[0-9a-f]{16}$/)
    // member 是缺省值，写出来只会让手工维护的文件更长
    expect('role' in wang).toBe(false)
    expect(typeof wang['createdAt']).toBe('number')
    // 管理员那条必须保留 role，否则重启后他就不是管理员了
    expect(file.find((e) => e['name'] === '李经理')?.['role']).toBe('admin')
  })

  test('签发管理员时 role 写进文件', () => {
    const { admin, store } = setup()
    const res = admin.issue({ name: '赵主管', role: ROLE_ADMIN })
    expect(res.ok).toBe(true)
    expect(store.verify(res.member!.token).role).toBe(ROLE_ADMIN)
    expect(readCredentials().find((e) => e['name'] === '赵主管')?.['role']).toBe('admin')
    expect(store.adminCount).toBe(2)
  })

  test('重名拒绝（同名会把两个人的用量并成一个人）', () => {
    const { admin, store } = setup()
    const res = admin.issue({ name: '张三' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('同名')
    // 拒绝时不能留下半成品
    expect(store.size).toBe(2)
  })

  test('姓名为 unknown（未归属保留键）拒绝', () => {
    const { admin } = setup()
    const res = admin.issue({ name: 'unknown' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('未署名')
  })

  test('空姓名 / 超长姓名 / 超长部门由 shared 的校验拦住', () => {
    const { admin } = setup()
    expect(admin.issue({ name: '   ' }).ok).toBe(false)
    expect(admin.issue({ name: 'x'.repeat(64) }).ok).toBe(false)
    expect(admin.issue({ name: '甲', dept: 'x'.repeat(200) }).ok).toBe(false)
  })

  test('未知角色值拒绝（而不是静默当成成员）', () => {
    const { admin } = setup()
    const res = admin.issue({ name: '甲', role: 'root' as never })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('未知角色')
  })
})

describe('★ 重置与吊销', () => {
  test('重置后旧 token 立即失效，姓名与角色保留', () => {
    const { admin, store } = setup()
    const rotated = admin.rotate({ token: 'tok-zhang' })
    expect(rotated.ok).toBe(true)
    const fresh = rotated.member!.token

    expect(fresh).not.toBe('tok-zhang')
    expect(store.verify('tok-zhang').ok).toBe(false)
    expect(store.verify(fresh).name).toBe('张三')
    expect(store.findByToken(fresh)?.createdAt).toBeGreaterThan(0)
  })

  test('吊销后该 token 无法再通过校验', () => {
    const { admin, store } = setup()
    expect(admin.revoke({ token: 'tok-zhang' }).ok).toBe(true)
    expect(store.verify('tok-zhang').ok).toBe(false)
    expect(admin.list().map((m) => m.name)).toEqual(['李经理'])
  })

  test('对不存在的 token 操作给出明确原因', () => {
    const { admin } = setup()
    expect(admin.revoke({ token: 'tok-nope' }).reason).toContain('未找到')
    expect(admin.rotate({ token: 'tok-nope' }).ok).toBe(false)
    expect(admin.update({ token: 'tok-nope', name: '甲' }).ok).toBe(false)
  })
})

describe('★ 最后一个管理员护栏', () => {
  test('不能删除最后一个管理员', () => {
    const { admin, store } = setup()
    const res = admin.revoke({ token: 'tok-boss' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('最后一个管理员')
    // 没删掉才说明护栏真的生效了
    expect(store.verify('tok-boss').ok).toBe(true)
    expect(store.adminCount).toBe(1)
  })

  test('不能把最后一个管理员降级成普通成员', () => {
    const { admin, store } = setup()
    const res = admin.update({ token: 'tok-boss', role: ROLE_MEMBER })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('最后一个管理员')
    expect(store.adminCount).toBe(1)
  })

  test('有第二个管理员时就可以删 / 降级（护栏是「不能一个都不剩」而不是「不能动管理员」）', () => {
    const { admin, store } = setup()
    const second = admin.issue({ name: '赵主管', role: ROLE_ADMIN })
    expect(second.ok).toBe(true)
    expect(store.adminCount).toBe(2)

    // 两个管理员时可以删掉其中一个
    expect(admin.revoke({ token: second.member!.token }).ok).toBe(true)
    expect(store.adminCount).toBe(1)

    // 删完只剩一个，此时降级又会被拦住 —— 护栏是动态的，不是「首次之后永久放开」
    expect(admin.update({ token: 'tok-boss', role: ROLE_MEMBER }).ok).toBe(false)
    expect(store.adminCount).toBe(1)
  })
})

describe('★ 环境变量注入的管理员不可在页面维护', () => {
  test('删除 / 重置 / 降级都被拒绝，并指向 ATR_ADMIN_TOKEN', () => {
    const { admin } = setup({ envAdmin: true })

    const revoked = admin.revoke({ token: 'tok-env' })
    expect(revoked.ok).toBe(false)
    expect(revoked.reason).toContain('ATR_ADMIN_TOKEN')

    expect(admin.rotate({ token: 'tok-env' }).reason).toContain('ATR_ADMIN_TOKEN')
    expect(admin.update({ token: 'tok-env', name: '改名' }).reason).toContain('ATR_ADMIN_TOKEN')
  })
})

describe('修改人员', () => {
  test('改名 / 换部门 / 清空部门', () => {
    const { admin, store } = setup()

    const renamed = admin.update({ token: 'tok-zhang', name: '张三丰' })
    expect(renamed.ok).toBe(true)
    expect(store.verify('tok-zhang').name).toBe('张三丰')
    // token 不变：改姓名不该让本人重填 token
    expect(renamed.member!.token).toBe('tok-zhang')

    expect(admin.update({ token: 'tok-zhang', dept: '研发三部' }).member!.dept).toBe('研发三部')
    expect(admin.update({ token: 'tok-zhang', dept: '' }).member!.dept).toBeNull()
  })

  test('改成别人的名字被拒绝', () => {
    const { admin } = setup()
    const res = admin.update({ token: 'tok-zhang', name: '李经理' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('同名')
  })

  test('改成自己原来的名字不算冲突', () => {
    const { admin } = setup()
    expect(admin.update({ token: 'tok-zhang', name: '张三', dept: '研发一部' }).ok).toBe(true)
  })
})

describe('🚨 凭证文件是唯一真值', () => {
  test('文件读不懂时拒绝一切写入，且文件保持原样', () => {
    const broken = '{ "张三": "tok-zhang",, }'
    writeFileSync(credentialsPath, broken, 'utf8')

    const { admin, store, fileError } = loadMembers({ credentialsPath })
    expect(fileError).toContain('JSON')
    // 服务端照常起来（只是没人能用）
    expect(store.registered).toBe(false)

    const storage = admin.storage()
    expect(storage.writable).toBe(false)
    expect(storage.writeBlockedReason).toContain('无法解析')

    const res = admin.issue({ name: '甲' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('拒绝写入')
    // ★ 最关键的一条：原文件必须一个字节都没动过
    expect(readFileSync(credentialsPath, 'utf8')).toBe(broken)
  })

  test('落盘失败时内存镜像不变（不留「重启后消失」的 token）', () => {
    const { admin, store } = setup()
    // 让凭证文件的父路径是一个普通文件 → mkdirSync 抛 ENOTDIR
    const blocked = join(home, 'not-a-dir', 'credentials.json')
    writeFileSync(join(home, 'not-a-dir'), 'x', 'utf8')

    const isolated = loadMembers({ credentialsPath: blocked })
    const res = isolated.admin.issue({ name: '甲' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('写入凭证文件失败')
    // 失败后 store 里不该多出这个人
    expect(isolated.store.size).toBe(0)
    // 而原来的环境不受影响（共享实例没有被误改）
    expect(store.size).toBe(2)
    expect(admin.list().length).toBe(2)
  })

  test('重名检查跨来源生效（文件里的名字 + 环境变量管理员的名字）', () => {
    const { admin } = setup({ envAdmin: true })
    expect(admin.issue({ name: '李经理' }).ok).toBe(false)
    expect(admin.issue({ name: '部署管理员' }).ok).toBe(false)
  })
})

describe('管理路由：鉴权三类分开', () => {
  test('未配置凭证回 503（等管理员发凭证才有用）', () => {
    const store = CredentialStore.empty()
    const { admin } = loadMembers({ credentialsPath: join(home, 'none.json') })
    const route = new AdminRoute({ store, admin })
    const res = route.list('Bearer whatever')
    expect(res.status).toBe(503)
  })

  test('缺 token 回 401，token 不对也回 401', () => {
    const { route } = setup()
    expect(route.list(null).status).toBe(401)
    expect(route.list('Bearer tok-nope').status).toBe(401)
  })

  test('★ 普通成员回 403（重填也没用，得换管理员 token）', () => {
    const { route } = setup()
    const res = route.list('Bearer tok-zhang')
    expect(res.status).toBe(403)
    expect(String((res.body as { reason: string }).reason)).toContain('管理员')
    // 响应体里绝不能是人员名单
    expect('members' in (res.body as object)).toBe(false)
  })

  test('★ 鉴权失败绝不能是 2xx（前端会把 2xx 当数据渲染）', () => {
    const { route } = setup()
    for (const auth of [null, 'Bearer bad', 'Bearer tok-zhang']) {
      expect(route.list(auth).status).toBeGreaterThanOrEqual(400)
      expect(route.issue(auth, { name: '甲' }).status).toBeGreaterThanOrEqual(400)
      expect(route.revoke(auth, { token: 'tok-zhang' }).status).toBeGreaterThanOrEqual(400)
    }
  })

  test('管理员可以列人员，并看到凭证文件状态', () => {
    const { route } = setup()
    const res = route.list('Bearer tok-boss')
    expect(res.status).toBe(200)
    const body = res.body as {
      members: { name: string; token: string }[]
      credentialsPath: string
      writable: boolean
      writeBlockedReason: string | null
    }
    expect(body.members.map((m) => m.name)).toEqual(['李经理', '张三'])
    expect(body.credentialsPath).toBe(credentialsPath)
    expect(body.writable).toBe(true)
    expect(body.writeBlockedReason).toBeNull()
  })

  test('签发走路由：200 + ok:true + 新 token', () => {
    const { route } = setup()
    const res = route.issue('Bearer tok-boss', { name: '王五', dept: '研发二部' })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; member?: { token: string; name: string } }
    expect(body.ok).toBe(true)
    expect(body.member?.token.startsWith('atr-')).toBe(true)
  })

  test('业务失败仍是 200 + ok:false（要改的是输入，不是身份）', () => {
    const { route } = setup()
    const res = route.issue('Bearer tok-boss', { name: '张三' })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean; reason: string }).ok).toBe(false)
    expect((res.body as { reason: string }).reason).toContain('同名')
  })

  test('请求形状不对回 400（缺 name / 缺 token / body 不是对象）', () => {
    const { route } = setup()
    expect(route.issue('Bearer tok-boss', {}).status).toBe(400)
    expect(route.issue('Bearer tok-boss', null).status).toBe(400)
    expect(route.issue('Bearer tok-boss', { name: 123 }).status).toBe(400)
    expect(route.revoke('Bearer tok-boss', {}).status).toBe(400)
    expect(route.update('Bearer tok-boss', { token: '   ' }).status).toBe(400)
  })

  test('update / rotate / revoke 三个动作都能从路由走通', () => {
    const { route, store } = setup()
    const auth = 'Bearer tok-boss'

    expect(route.update(auth, { token: 'tok-zhang', dept: '研发二部' }).status).toBe(200)
    expect(store.findByToken('tok-zhang')?.dept).toBe('研发二部')

    const rotated = route.rotate(auth, { token: 'tok-zhang' })
    const fresh = (rotated.body as { member: { token: string } }).member.token
    expect(store.verify('tok-zhang').ok).toBe(false)
    expect(store.verify(fresh).ok).toBe(true)

    expect(route.revoke(auth, { token: fresh }).status).toBe(200)
    expect(store.verify(fresh).ok).toBe(false)
  })
})