/** 登录全链路：真实 Hono 处理器、密码 KDF、Cookie 与凭证落盘；验证码仅在测试工厂固定。 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app.js'
import { AdminRoute } from '../src/admin-route.js'
import { loadMembers } from '../src/member-admin.js'
import { CredentialStore } from '../src/credentials.js'
import { IdentityRoute } from '../src/identity-route.js'
import { IngestRoute } from '../src/ingest-route.js'
import { StatsRoute } from '../src/stats-route.js'
import { PortalAuth, SESSION_SECONDS } from '../src/auth/portal-auth.js'
import { createCaptchaImage } from '../src/auth/captcha.js'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { createHandlerFor } from '../src/index.js'

const password = 'test-password-2026'
let hash = ''
const directories: string[] = []
beforeAll(async () => {
  hash = await hashPassword(password)
})
afterEach(() => {
  for (const dir of directories.splice(0)) {
    if (
      !resolve(dir).startsWith(resolve(tmpdir()) + '\\atr-auth-') &&
      !resolve(dir).startsWith(resolve(tmpdir()) + '/atr-auth-')
    )
      throw new Error('测试目录超出预期')
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atr-auth-'))
  directories.push(dir)
  const path = join(dir, 'credentials.json')
  writeFileSync(
    path,
    JSON.stringify([
      {
        token: 'admin-token',
        name: '服务端管理员',
        role: 'admin',
        username: 'admin',
        passwordHash: hash,
      },
      {
        token: 'member-token',
        name: '服务端成员',
        username: 'member',
        passwordHash: hash,
      },
    ]),
  )
  const { admin, store } = loadMembers({ credentialsPath: path })
  let now = Date.now()
  // 测试持有自己创建的答案，不从图像识别、不提供生产绕过入口。
  const auth = new PortalAuth(
    store,
    () => now,
    () => ({ answer: '2468', image: createCaptchaImage().image }),
  )
  const app = createApp({
    credentials: store,
    portalAuth: auth,
    adminRoute: new AdminRoute({ store, admin }),
    identityRoute: new IdentityRoute({ dshHome: dir }),
    ingestRoute: new IngestRoute({
      credentials: store,
      dbPath: join(dir, 'portal.sqlite'),
    }),
    statsRoute: new StatsRoute({
      credentials: store,
      dbPath: join(dir, 'portal.sqlite'),
    }),
    localStats: null,
    enableLocalApi: false,
    requestLog: false,
  })
  const req = (path: string, init?: RequestInit) =>
    app.request('https://portal.test/api/v1/' + path, init)
  async function challenge() {
    const response = await req('auth/captcha')
    return {
      response,
      data: (await response.json()) as { captcha_id: string; image: string },
      cookie: response.headers.getSetCookie()[0]!.split(';')[0]!,
    }
  }
  async function login(username = 'admin', candidate = password) {
    const c = await challenge()
    const response = await req('auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Portal-Request': '1',
        Cookie: c.cookie,
      },
      body: JSON.stringify({
        username,
        password: candidate,
        captcha_id: c.data.captcha_id,
        captcha: '2468',
      }),
    })
    return {
      response,
      cookie:
        response.headers
          .getSetCookie()
          .find((c) => c.startsWith('atr_portal_session='))
          ?.split(';')[0] ?? '',
    }
  }
  return {
    req,
    auth,
    store,
    admin,
    path,
    dir,
    challenge,
    login,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('密码与验证码', () => {
  test('随机盐、BOM/CR 归一与前后空格保持；坏哈希不放行', async () => {
    expect(await verifyPassword('\uFEFF' + password + '\r', hash)).toBe(true)
    expect(await verifyPassword(' ' + password, hash)).toBe(false)
    expect(await verifyPassword(password, 'broken')).toBe(false)
    expect(await hashPassword(password)).not.toBe(hash)
    expect(hash).not.toContain(password)
  })
  test('返回位图 PNG，响应无答案，禁止缓存且 Cookie 受保护', async () => {
    const { response, data } = await fixture().challenge()
    expect(Object.keys(data).sort()).toEqual([
      'captcha_id',
      'expires_in',
      'image',
    ])
    const png = Buffer.from(data.image.split(',')[1]!, 'base64')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(168)
    expect(png.toString()).not.toContain('tEXt')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('Secure')
  })
  test('错误答案也消费验证码，重放、跨浏览器和过期均拒绝', async () => {
    const f = fixture()
    const issue = await f.auth.challenge()
    if (!issue.ok) throw new Error(issue.reason)
    const input = {
      username: 'admin',
      password,
      captcha_id: issue.data.captcha_id,
      captcha: '2468',
    }
    expect((await f.auth.login(input, 'wrong-browser')).ok).toBe(false)
    expect(
      (await f.auth.login({ ...input, captcha: '中文答案' }, issue.binding)).ok,
    ).toBe(false)
    expect((await f.auth.login(input, issue.binding)).ok).toBe(false)
    const next = await f.auth.challenge()
    if (!next.ok) throw new Error(next.reason)
    f.advance(120_001)
    expect(
      (
        await f.auth.login(
          { ...input, captcha_id: next.data.captcha_id },
          next.binding,
        )
      ).ok,
    ).toBe(false)
  })
  test('刷新时旧挑战立即作废', async () => {
    const f = fixture(),
      first = await f.auth.challenge()
    if (!first.ok) throw new Error(first.reason)
    await f.auth.challenge(first.binding)
    const result = await f.auth.login(
      {
        username: 'admin',
        password,
        captcha_id: first.data.captcha_id,
        captcha: '2468',
      },
      first.binding,
    )
    expect(result.ok).toBe(false)
  })
})

describe('会话与真实路由', () => {
  test('登录身份由服务端决定，普通响应不含 Token 或密码哈希', async () => {
    const f = fixture(),
      { response, cookie } = await f.login(' ADMIN ')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('服务端管理员')
    expect(body).not.toContain('admin-token')
    expect(body).not.toContain('passwordHash')
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict')
    const me = await f.req('auth/session', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(me.headers.get('cache-control')).toBe('no-store')
    expect(
      (await f.req('admin/members', { headers: { Cookie: cookie } })).status,
    ).toBe(200)
    const ingest = await f.req('token-usage', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(ingest.status).toBe(401)
  })
  test('401 未登录与 403 非管理员分开；跨站写请求被拦截', async () => {
    const f = fixture()
    expect((await f.req('auth/session')).status).toBe(401)
    expect((await f.req('admin/members')).status).toBe(401)
    const { cookie } = await f.login('member')
    const denied = await f.req('admin/members', { headers: { Cookie: cookie } })
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain('admin-token')
    expect(
      (
        await f.req('auth/logout', {
          method: 'POST',
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.req('auth/logout', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://evil.test',
            'X-Portal-Request': '1',
          },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.req('admin/members/login', {
          method: 'POST',
          headers: { Cookie: cookie, 'X-Portal-Request': '1' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
  })
  test('退出与 8 小时到期使服务端会话失效', async () => {
    const f = fixture(),
      first = await f.login()
    expect(
      (
        await f.req('auth/logout', {
          method: 'POST',
          headers: { Cookie: first.cookie, 'X-Portal-Request': '1' },
        })
      ).status,
    ).toBe(200)
    expect(
      (await f.req('auth/session', { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(401)
    const second = await f.login()
    f.advance(SESSION_SECONDS * 1000 + 1)
    expect(
      (await f.req('auth/session', { headers: { Cookie: second.cookie } }))
        .status,
    ).toBe(401)
  })
  test('角色实时重读；密码重置立即踢出旧会话且 Token 不变', async () => {
    const f = fixture(),
      { cookie } = await f.login('member')
    f.admin.update({ token: 'member-token', role: 'admin' })
    expect(
      (await f.req('admin/members', { headers: { Cookie: cookie } })).status,
    ).toBe(200)
    await f.admin.setLogin({
      token: 'member-token',
      username: 'member',
      password: 'changed-password-2026',
    })
    expect(
      (await f.req('auth/session', { headers: { Cookie: cookie } })).status,
    ).toBe(401)
    expect(f.store.verify('member-token').ok).toBe(true)
    expect((await f.login('member')).response.status).toBe(401)
    expect(
      (await f.login('member', 'changed-password-2026')).response.status,
    ).toBe(200)
  })
  test('未知用户与错误密码统一反馈，5 次失败后账号限流', async () => {
    const f = fixture()
    const a = await f.login('missing-user'),
      b = await f.login('member', 'wrong-password')
    expect(a.response.status).toBe(401)
    expect(await a.response.json()).toEqual(await b.response.json())
    for (let i = 0; i < 4; i++) await f.login('member', 'wrong-password')
    expect((await f.login('member', password)).response.status).toBe(429)
  })
  test('登录与会话路由方法契约：错误方法 405、未知地址 JSON 404', async () => {
    const f = fixture()
    const wrong = await f.req('auth/login')
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('POST')
    expect((await f.req('auth/unknown')).status).toBe(404)
  })
})

describe('登录账号持久化与迁移', () => {
  test('管理接口开通账号可立即登录；不回传哈希，重载 / 改角色 / 重置 Token 不丢失账号', async () => {
    const f = fixture(),
      { cookie } = await f.login()
    const member = f.admin.issue({ name: '新成员' }).member!
    const response = await f.req('admin/members/login', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-Portal-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: member.token,
        username: 'new.user',
        password,
      }),
    })
    expect(response.status).toBe(200)
    const data = (await response.json()) as { ok: boolean }
    expect(data.ok).toBe(true)
    expect(JSON.stringify(data)).not.toContain('passwordHash')
    expect((await f.login('new.user')).response.status).toBe(200)
    f.admin.update({ token: member.token, dept: '研发' })
    const rotated = f.admin.rotate({ token: member.token }).member!
    const loaded = CredentialStore.load(f.path).store.findByToken(
      rotated.token,
    )!
    expect(loaded.username).toBe('new.user')
    expect(await verifyPassword(password, loaded.passwordHash)).toBe(true)
    expect(readFileSync(f.path, 'utf8')).not.toContain(password)
  })
  test('重复用户名与短密码被拒绝，坏文件不能写入账号', async () => {
    const f = fixture()
    expect(
      (
        await f.admin.setLogin({
          token: 'member-token',
          username: 'admin',
          password,
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await f.admin.setLogin({
          token: 'member-token',
          username: 'member',
          password: 'short',
        })
      ).ok,
    ).toBe(false)
    writeFileSync(f.path, '{broken')
    const loaded = loadMembers({
      credentialsPath: f.path,
      envAdmin: { token: 'env', name: '环境管理员' },
    })
    expect(
      (
        await loaded.admin.setLogin({
          token: 'env',
          username: 'admin',
          password,
        })
      ).ok,
    ).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe('{broken')
  })
  test('旧凭证仍可上报但不会被当作密码，未设置账号明确返回 503', async () => {
    const store = CredentialStore.from([{ token: 'legacy', name: '旧成员' }])
    const auth = new PortalAuth(store, Date.now, () => ({
      answer: '2468',
      image: '',
    }))
    const c = await auth.challenge()
    if (!c.ok) throw new Error(c.reason)
    const result = await auth.login(
      {
        username: 'legacy',
        password: 'legacy',
        captcha_id: c.data.captcha_id,
        captcha: '2468',
      },
      c.binding,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.status).toBe(503)
    expect(store.verify('legacy').ok).toBe(true)
  })
  test('环境变量只初始化数据库一次，重启不覆盖且不读写旧凭证文件', async () => {
    const f = fixture()
    const original = readFileSync(f.path, 'utf8')
    const dbPath = join(f.dir, 'modern-portal.sqlite')
    const bundle = await createHandlerFor({
      dshHome: f.dir,
      dbPath,
      mysqlUrl: '',
      adminToken: 'env-token',
      adminName: '部署管理员',
      adminUsername: 'bootstrap',
      adminPassword: password,
      requestLog: false,
    })
    const identity = await bundle.identityStore!.resolveBearer('env-token')
    expect(identity?.roleCodes).toContain('admin')
    expect((await bundle.identityStore!.getViewer(identity!)).username).toBe('bootstrap')
    expect(bundle.credentials.size).toBe(0)
    const restarted = await createHandlerFor({ dshHome: f.dir, dbPath, mysqlUrl: '', adminToken: 'changed-env-token', adminName: '被忽略', adminUsername: 'changed', adminPassword: password, requestLog: false })
    expect((await restarted.identityStore!.resolveBearer('env-token'))?.memberId).toBe(identity!.memberId)
    expect(await restarted.identityStore!.resolveBearer('changed-env-token')).toBeNull()
    expect(readFileSync(f.path, 'utf8')).toBe(original)
    await expect(createHandlerFor({ dshHome: f.dir, dbPath, mysqlUrl: '', credentialsPath: f.path, requestLog: false })).rejects.toThrow('显式数据库迁移')
  })
})
