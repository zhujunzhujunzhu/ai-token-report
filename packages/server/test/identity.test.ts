/**
 * 身份链路端到端测试。
 *
 * 覆盖最关键的安全属性：
 * 1. **客户端提交的姓名不能覆盖服务端认定的姓名**（防冒用）
 * 2. token 无效 / 未配置凭证时**不落盘**
 * 3. 服务端不可达时**不落盘**（避免存下永不被承认的凭证）
 * 4. GET 响应**不含 token**
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { identityPath, readIdentity } from '@ai-token-report/core'
import type { VerifyTokenResponse } from '@ai-token-report/shared'

import { CredentialStore } from '../src/credentials.js'
import { IdentityRoute } from '../src/identity-route.js'
import { resolveIngestIdentity, tokenFromHeader, verifyToken } from '../src/verify-route.js'

let home: string
let credPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-identity-e2e-'))
  credPath = join(home, 'token-report', 'credentials.json')
  // 凭证文件所在目录由管理员创建，测试里显式建好
  mkdirSync(join(home, 'token-report'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 造一个「部门服务端」的假 fetch。 */
function fakePortal(
  response: VerifyTokenResponse | (() => never),
): typeof fetch {
  return (async () => {
    if (typeof response === 'function') response()
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch
}

describe('凭证表', () => {
  test('数组格式', () => {
    const store = CredentialStore.from([
      { token: 'tok-zhang', name: '张三', dept: '研发一部' },
      { token: 'tok-li', name: '李四' },
    ])
    expect(store.size).toBe(2)
    expect(store.verify('tok-zhang').name).toBe('张三')
    expect(store.verify('tok-zhang').dept).toBe('研发一部')
    expect(store.verify('tok-li').dept).toBeUndefined()
  })

  test('未知 token 被拒绝', () => {
    const store = CredentialStore.from([{ token: 'tok-zhang', name: '张三' }])
    const r = store.verify('tok-wrong')
    expect(r.ok).toBe(false)
    expect(r.registered).toBe(true)
    expect(r.reason).toContain('无效')
  })

  test('空表时 registered=false，且提示与「无效」不同', () => {
    const store = CredentialStore.empty()
    const r = store.verify('anything')
    expect(r.ok).toBe(false)
    expect(r.registered).toBe(false)
    // ★ 这个区分很重要：用户做什么都没用，得先让管理员发凭证
    expect(r.reason).toContain('管理员')
  })

  test('从 {姓名: token} 映射加载', () => {
    writeFileSync(credPath, JSON.stringify({ 张三: 'tok-a', 李四: 'tok-b' }), 'utf8')
    const { store, error } = CredentialStore.load(credPath)
    expect(error).toBeUndefined()
    expect(store.size).toBe(2)
    expect(store.verify('tok-a').name).toBe('张三')
  })

  test('文件损坏 → 空表 + error，不抛错', () => {
    writeFileSync(credPath, '{ 坏 JSON', 'utf8')
    const { store, error } = CredentialStore.load(credPath)
    expect(store.size).toBe(0)
    expect(error).toContain('JSON')
  })

  test('格式不对 → 空表 + error', () => {
    writeFileSync(credPath, JSON.stringify([{ token: 'x' }]), 'utf8')
    const { store, error } = CredentialStore.load(credPath)
    expect(store.size).toBe(0)
    expect(error).toContain('格式')
  })

  test('文件不存在 → 空表且无 error（正常情况）', () => {
    const { store, error } = CredentialStore.load(credPath)
    expect(store.size).toBe(0)
    expect(error).toBeUndefined()
  })
})

describe('Authorization 头解析', () => {
  test('Bearer 前缀', () => {
    expect(tokenFromHeader('Bearer tok-abc')).toBe('tok-abc')
    expect(tokenFromHeader('bearer tok-abc')).toBe('tok-abc')
  })

  test('裸 token', () => {
    expect(tokenFromHeader('tok-abc')).toBe('tok-abc')
  })

  test('空值', () => {
    expect(tokenFromHeader(null)).toBeNull()
    expect(tokenFromHeader('')).toBeNull()
    expect(tokenFromHeader('Bearer   ')).toBeNull()
  })

  test('★ 只有 Bearer 前缀不算 token（回归：曾把 "Bearer" 当成 token）', () => {
    // 若实现写成 /^Bearer\s+(.+)$/，「Bearer」会落进裸 token 分支，
    // 于是用户会被报「token 无效」而不是「请填写 token」，非常误导。
    expect(tokenFromHeader('Bearer')).toBeNull()
    expect(tokenFromHeader('Bearer ')).toBeNull()
    expect(tokenFromHeader('bearer')).toBeNull()
  })
})

describe('verifyToken —— 身份不可冒用', () => {
  const store = CredentialStore.from([{ token: 'tok-zhang', name: '张三', dept: '研发一部' }])

  test('正确 token → 返回凭证表里的姓名', () => {
    const r = verifyToken(store, { authorization: 'Bearer tok-zhang' })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('张三')
    expect(r.dept).toBe('研发一部')
  })

  test('★ 即使 body 里塞了别人的名字，也以凭证表为准', () => {
    const r = verifyToken(store, {
      authorization: 'Bearer tok-zhang',
      bodyToken: 'tok-someone-else',
    })
    // header 优先，且 name 来自凭证表
    expect(r.name).toBe('张三')
  })

  test('缺 token 且未配置凭证 → registered=false', () => {
    const r = verifyToken(CredentialStore.empty(), {})
    expect(r.ok).toBe(false)
    expect(r.registered).toBe(false)
  })

  test('缺 token 但已配置凭证 → registered=true', () => {
    const r = verifyToken(store, {})
    expect(r.ok).toBe(false)
    expect(r.registered).toBe(true)
  })
})

describe('resolveIngestIdentity —— 上报归属', () => {
  const store = CredentialStore.from([{ token: 'tok-zhang', name: '张三' }])

  test('有效 token → 归属到该人', () => {
    const r = resolveIngestIdentity(store, 'Bearer tok-zhang')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('张三')
  })

  test('无 token → 拒绝，不静默记为 unknown', () => {
    const r = resolveIngestIdentity(store, null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Authorization')
  })

  test('★ 未配置凭证 → 拒绝上报（而不是全部记成 unknown）', () => {
    const r = resolveIngestIdentity(CredentialStore.empty(), 'Bearer anything')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.registered).toBe(false)
  })
})

describe('IdentityRoute —— 引导页读写', () => {
  test('未署名时 GET 返回 signed=false 与提示', () => {
    const route = new IdentityRoute({ dshHome: home })
    const r = route.get()
    expect(r.signed).toBe(false)
    expect(r.name).toBeNull()
    expect(r.hint).toBeTruthy()
  })

  test('★ GET 响应绝不含 token', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: fakePortal({ ok: true, registered: true, name: '张三' }),
    })
    await route.submit({ name: '张三', token: 'tok-secret-value' })

    const r = route.get()
    expect(r.signed).toBe(true)
    expect(r.name).toBe('张三')
    // 序列化后也不应出现 token
    expect(JSON.stringify(r)).not.toContain('tok-secret-value')
  })

  test('提交成功 → 落盘，且以服务端返回的姓名为准', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      // 用户填「张三三」，服务端认定「张三」
      fetchImpl: fakePortal({ ok: true, registered: true, name: '张三', dept: '研发一部' }),
    })

    const r = await route.submit({ name: '张三三', token: 'tok-abc' })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('张三')

    const stored = readIdentity(identityPath(home)).identity
    expect(stored?.name).toBe('张三')
    expect(stored?.dept).toBe('研发一部')
    expect(stored?.token).toBe('tok-abc')
  })

  test('★ token 无效 → 不落盘', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: fakePortal({ ok: false, registered: true, reason: 'token 无效，请向管理员确认' }),
    })

    const r = await route.submit({ name: '张三', token: 'tok-bad' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('无效')
    expect(existsSync(identityPath(home))).toBe(false)
  })

  test('★ 服务端不可达 → 不落盘', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: (() => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })

    const r = await route.submit({ name: '张三', token: 'tok-abc' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('无法连接')
    expect(existsSync(identityPath(home))).toBe(false)
  })

  test('未配置 portalUrl → 明确提示，不落盘', async () => {
    const route = new IdentityRoute({ dshHome: home })
    const r = await route.submit({ name: '张三', token: 'tok-abc' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('部门服务端')
    expect(existsSync(identityPath(home))).toBe(false)
  })

  test('空姓名 / 空 token 在发请求前就被挡住', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: (() => {
        throw new Error('不该被调用')
      }) as unknown as typeof fetch,
    })

    expect((await route.submit({ name: '', token: 'tok' })).ok).toBe(false)
    expect((await route.submit({ name: '张三', token: '' })).ok).toBe(false)
  })

  test('current() 未署名返回 null —— 上报流程据此停止', () => {
    const route = new IdentityRoute({ dshHome: home })
    expect(route.current()).toBeNull()
  })

  test('清除后回到未署名', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: fakePortal({ ok: true, registered: true, name: '张三' }),
    })
    await route.submit({ name: '张三', token: 'tok-abc' })
    expect(route.current()).not.toBeNull()

    route.clear()
    expect(route.current()).toBeNull()
    expect(route.get().signed).toBe(false)
  })

  test('落盘文件权限不含明文以外的额外字段', async () => {
    const route = new IdentityRoute({
      dshHome: home,
      portalUrl: 'http://portal.test',
      fetchImpl: fakePortal({ ok: true, registered: true, name: '张三' }),
    })
    await route.submit({ name: '张三', token: 'tok-abc' })

    const raw = JSON.parse(readFileSync(identityPath(home), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['createdAt', 'name', 'token', 'updatedAt'])
  })
})