/** 真 SQLite 身份与权限回归：不模拟数据库、密码 KDF、事务或认证结果。 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { IdentityRepository, ADMIN_ROLE_ID, MEMBER_ROLE_ID, PERMISSIONS, RECOVERY_PERMISSIONS, IdentityError, importCredentialFile, type Principal, type BootstrapOptions } from '../src/identity/index.js'
import { APP_KEY_LABEL, APP_KEY_SCOPES } from '@ai-token-report/shared'
import { DatabasePortalAuth } from '../src/identity/portal-auth.js'
import { hashPassword } from '../src/auth/password.js'
import { openDb, ensureSchema, migratePortalDatabase } from '@ai-token-report/core/db'

const roots: string[] = []
const mysqlSchemas: string[] = []
const mysqlAdminUrl = process.env.ATR_IDENTITY_TEST_MYSQL_ADMIN_URL
const PASSWORD = 'test-password-database-2026'
const KEY = 'test-only-shared-captcha-hmac-key-2026'
afterEach(async () => {
  if (mysqlAdminUrl && mysqlSchemas.length) {
    const connection = await (await import('mysql2/promise')).createConnection(mysqlAdminUrl)
    try {
      for (const schema of mysqlSchemas.splice(0)) {
        if (!/^atr_identity_test_[a-f0-9]+$/.test(schema)) throw new Error('隔离 schema 名称不合法')
        await connection.query('DROP DATABASE `' + schema + '`')
      }
    } finally { await connection.end() }
  }
  for (const dir of roots.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()))) throw new Error('临时测试目录超出范围')
    rmSync(dir, { recursive: true, force: true })
  }
})
async function fixture(bootstrap: BootstrapOptions | false = { adminToken: 'test-bootstrap-secret', adminName: '管理员', adminUsername: 'admin', adminPassword: PASSWORD }) {
  const dir = mkdtempSync(join(tmpdir(), 'atr-identity-db-')); roots.push(dir)
  let mysqlUrl: string | undefined
  if (mysqlAdminUrl) {
    const schema = 'atr_identity_test_' + randomUUID().replaceAll('-', '')
    const connection = await (await import('mysql2/promise')).createConnection(mysqlAdminUrl)
    try { await connection.query('CREATE DATABASE `' + schema + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'); mysqlSchemas.push(schema) } finally { await connection.end() }
    const url = new URL(mysqlAdminUrl); url.pathname = '/' + schema; mysqlUrl = url.toString()
  }
  const target = { sqlitePath: join(dir, 'portal.sqlite'), ...(mysqlUrl ? { mysqlUrl } : {}) }
  const repository = new IdentityRepository(target)
  if (bootstrap) await repository.initialize(bootstrap)
  const admin = bootstrap ? (await repository.resolveBearer('test-bootstrap-secret'))! : null!
  return { repository, admin, target, dir }
}
function auth(repo: IdentityRepository) { return new DatabasePortalAuth(repo, { hmacKey: KEY, makeImage: () => ({ answer: '2468', image: 'data:image/png;base64,test' }) }) }
async function login(service: DatabasePortalAuth, username = 'admin', password = PASSWORD) {
  const c = await service.challenge()
  if (!c.ok) throw new Error(c.reason)
  return service.login({ username, password, captcha_id: c.data.captcha_id, captcha: '2468' }, c.binding)
}
async function member(repository: IdentityRepository, admin: Principal, name = '同名成员', role = MEMBER_ROLE_ID) {
  return (await repository.createMember(admin, { name, role_ids: [role] })).member
}

describe('数据库权威身份', () => {
  test('仅账号初始化不制造丢失的长期Token，最后账号与角色均受保护', async () => {
    const { repository: r } = await fixture({ adminName: '仅账号管理员', adminUsername: 'admin', adminPassword: PASSWORD })
    expect((await r.health()).token_count).toBe(0)
    const signed = await login(auth(r)); if (!signed.ok) throw new Error(signed.reason)
    const actor = (await r.resolveSession(signed.sessionId))!, me = (await r.listMembers(actor)).members[0]!
    await expect(r.setLoginStatus(actor, { member_id: me.member_id, expected_version: me.version, enabled: false })).rejects.toMatchObject({ code: 'last_administrator' })
    await expect(r.setRoles(actor, { member_id: me.member_id, expected_version: me.version, role_ids: [MEMBER_ROLE_ID] })).rejects.toMatchObject({ code: 'last_administrator' })
    expect(await r.resolveSession(signed.sessionId)).not.toBeNull()
  })
  test('一次性初始化、跨仓储读取、普通DTO不含秘密', async () => {
    const { repository, admin, target } = await fixture()
    await repository.initialize({ adminToken: 'replacement-secret', adminName: '被忽略' })
    const other = new IdentityRepository(target)
    expect((await other.resolveBearer('test-bootstrap-secret'))?.memberId).toBe(admin.memberId)
    expect(await other.resolveBearer('replacement-secret')).toBeNull()
    const body = JSON.stringify(await other.listMembers(admin))
    expect(body).not.toContain('test-bootstrap-secret')
    expect(body).not.toContain('password_hash')
    const rows = await other.read((tx) => tx.all<{ token_hash: string }>('SELECT token_hash FROM report_tokens'))
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await other.health()).admin_count).toBe(1)
  })
  test('同名人员独立，改名与轮换都不改变人员ID', async () => {
    const { repository: r, admin } = await fixture()
    const a = await member(r, admin), b = await member(r, admin)
    expect(a.member_id).not.toBe(b.member_id)
    const token = await r.issueToken(admin, { member_id: a.member_id, label: 'CLI' })
    const p = (await r.resolveBearer(token.token_secret))!
    expect(p.permissions).toEqual(['identity:read', 'usage:write'])
    await expect(r.listMembers(p)).rejects.toMatchObject({ status: 403 })
    const renamed = await r.updateMember(admin, { member_id: a.member_id, expected_version: a.version, name: '新姓名' })
    expect(renamed.member.member_id).toBe(a.member_id)
    const rotated = await r.rotateToken(admin, { member_id: a.member_id, token_id: token.token.token_id, expected_version: token.token.version })
    expect(await r.resolveBearer(token.token_secret)).toBeNull()
    expect((await r.resolveBearer(rotated.token_secret))?.memberId).toBe(a.member_id)
    expect((await r.verifyIdentity(rotated.token_secret)).name).toBe('新姓名')
  })
  test('★ appKey 只签发「上报 + 获取统计」两项权限，且仍能核对自己是谁', async () => {
    const { repository: r, admin } = await fixture()
    const a = await member(r, admin, '领 appKey 的人')
    const issued = await r.issueAppKey(admin, { member_id: a.member_id })
    // 范围由服务端固定（按权限码排序返回），请求体里给不出别的
    expect(issued.token!.scopes).toEqual([...APP_KEY_SCOPES].sort())
    expect(issued.token!.label).toBe(APP_KEY_LABEL)
    const p = (await r.resolveBearer(issued.token_secret))!
    expect(p.permissions).toEqual([...APP_KEY_SCOPES].sort())
    // ★ 上报凭证按定义就是「以某人的名义写入用量」，所以它必须能问「我是谁」——
    //   否则插件面板填完 appKey 只会看到「Key 无效」（appKey 里没有 identity:read）
    expect(await r.verifyIdentity(issued.token_secret)).toMatchObject({ ok: true, name: '领 appKey 的人' })
    // 但管理面照旧进不去：appKey 不是后台登录凭证
    await expect(r.listMembers(p)).rejects.toMatchObject({ status: 403 })
    await expect(r.listTokens(p, a.member_id)).rejects.toMatchObject({ status: 403 })
    // ★ 分组目录也一样：appKey 的 scope 只有「上报 + 获取统计」，
    //   而 `groups:read` 是管理面权限。看板的候选列表走的是 `/stats/groups`。
    await expect(r.listGroups(p)).rejects.toMatchObject({ status: 403 })
    // 签发要 tokens:manage；普通成员自己的 appKey 也不行
    const plain = await member(r, admin, '普通成员')
    const plainToken = await r.issueToken(admin, { member_id: plain.member_id, label: '普通' })
    await expect(r.issueAppKey((await r.resolveBearer(plainToken.token_secret))!, { member_id: plain.member_id }))
      .rejects.toMatchObject({ status: 403 })
  })
  test('★ appKey 列表由人员关系带出归属，且不复现明文', async () => {
    const { repository: r, admin } = await fixture()
    const group = (await r.createGroup(admin, { name: '研发部' })).group!
    const owner = (await r.createMember(admin, { name: '持 key 的人', role_ids: [MEMBER_ROLE_ID], group_ids: [group.group_id] })).member!
    const issued = await r.issueAppKey(admin, { member_id: owner.member_id })
    const entryOf = async () => (await r.listAppKeys(admin)).appkeys.find((item) => item.token.token_id === issued.token!.token_id)!
    expect((await entryOf()).member).toEqual({ member_id: owner.member_id, name: '持 key 的人', status: 'active', groups: [{ group_id: group.group_id, name: '研发部' }] })
    expect((await entryOf()).token.label).toBe(APP_KEY_LABEL)
    // ★ 列表只能给摘要提示：明文仅在签发 / 轮换的响应里出现过一次
    expect(JSON.stringify(await r.listAppKeys(admin))).not.toContain(issued.token_secret!)
    // ★ 归属跟随人员关系而不是签发时的快照：改名后同一把凭证仍指向同一个人
    await r.updateMember(admin, { member_id: owner.member_id, expected_version: owner.version, name: '改名后的人' })
    expect((await entryOf()).member).toMatchObject({ member_id: owner.member_id, name: '改名后的人' })
    // ★ 多对多：换分组列表后，列表里那一行跟着变（读的是关联表，不是快照）
    const second = (await r.createGroup(admin, { name: '平台组' })).group!
    const moved = (await r.updateMember(admin, { member_id: owner.member_id, expected_version: owner.version + 1, group_ids: [second.group_id] })).member!
    expect(moved.groups).toEqual([{ group_id: second.group_id, name: '平台组' }])
    expect((await entryOf()).member.groups).toEqual([{ group_id: second.group_id, name: '平台组' }])
    // ★ 这是凭证管理面：普通上报凭证读不到（响应里装着别人的凭证提示与权限范围）
    const plain = await r.issueToken(admin, { member_id: owner.member_id, label: '普通' })
    await expect(r.listAppKeys((await r.resolveBearer(plain.token_secret))!)).rejects.toMatchObject({ status: 403 })
  })
  test('窄管理Token不能经签发、轮换、角色或密码绕过scope', async () => {
    const { repository: r, admin } = await fixture()
    const narrow = await r.issueToken(admin, { member_id: admin.memberId, label: '限制管理', scopes: ['tokens:manage', 'roles:assign', 'accounts:manage'] })
    const actor = (await r.resolveBearer(narrow.token_secret))!
    await expect(r.issueToken(actor, { member_id: admin.memberId, label: '越权', scopes: PERMISSIONS })).rejects.toMatchObject({ status: 403 })
    const original = (await r.listTokens(admin, admin.memberId)).tokens.find((t) => t.label === '迁移凭证')!
    await expect(r.rotateToken(actor, { member_id: admin.memberId, token_id: original.token_id, expected_version: original.version })).rejects.toMatchObject({ status: 403 })
    const me = (await r.listMembers(admin)).members[0]!
    await expect(r.setRoles(actor, { member_id: me.member_id, expected_version: me.version, role_ids: [ADMIN_ROLE_ID] })).rejects.toMatchObject({ status: 403 })
    await expect(r.setLogin(actor, { member_id: me.member_id, expected_version: me.version, username: 'admin', password: 'attempted-password-2026' })).rejects.toMatchObject({ status: 403 })
    expect((await login(auth(r))).ok).toBe(true)
  })
  test('自定义角色可建可改可停用，内置角色与超权授予被拒绝', async () => {
    const { repository: r, admin } = await fixture()
    const person = (await r.createMember(admin, { name: '运营', role_ids: [MEMBER_ROLE_ID] })).member!

    // 目录：内置角色带标记；权限目录来自数据库（页面不该自己硬编码一份）
    const catalog = await r.listRoles(admin)
    expect(catalog.roles.filter((role) => role.is_builtin).map((role) => role.code).sort()).toEqual(['admin', 'member'])
    expect(catalog.roles.find((role) => role.code === 'admin')).toMatchObject({ is_builtin: true, status: 'active', version: 1 })
    expect(catalog.permissions.map((permission) => permission.code)).toContain('roles:assign')
    expect(catalog.roles.find((role) => role.code === 'member')!.permissions).toContain('stats:read')

    // 新建自定义角色：内置标记只能由 schema seed 产生，请求体给不出
    const created = (await r.createRole(admin, { code: 'viewer-ops', name: '运营查看者', permission_codes: ['roles:read'] })).role!
    expect(created).toMatchObject({ code: 'viewer-ops', is_builtin: false, status: 'active', version: 1 })
    expect(created.permissions).toEqual(['roles:read'])
    await expect(r.createRole(admin, { code: 'viewer-ops', name: '重名', permission_codes: [] })).rejects.toMatchObject({ status: 409 })
    await expect(r.createRole(admin, { code: '运营', name: '中文标识', permission_codes: [] })).rejects.toMatchObject({ status: 400 })
    // 未知权限码必须明确拒绝：静默丢掉会让「我明明勾了」变成一次查不出的少授权
    await expect(r.updateRole(admin, { role_id: created.role_id, expected_version: created.version, permission_codes: ['nope:read'] })).rejects.toMatchObject({ status: 400 })

    // 改权限是整组替换；旧版本号必须被拒绝，否则两人同时编辑会互相覆盖
    const updated = (await r.updateRole(admin, { role_id: created.role_id, expected_version: created.version, name: '运营查看者（新）', permission_codes: ['members:read'] })).role!
    expect(updated).toMatchObject({ name: '运营查看者（新）', version: 2 })
    expect(updated.permissions).toEqual(['members:read'])
    await expect(r.updateRole(admin, { role_id: created.role_id, expected_version: created.version, name: '过期表单' })).rejects.toMatchObject({ status: 409 })
    // 重复权限码要在写库前去重：`role_permissions` 主键是 (role_id, permission_id)，
    // 否则一次「同一个码勾两遍」的请求会炸成 500 而不是被安静地当成一个码。
    const deduped = (await r.updateRole(admin, { role_id: created.role_id, expected_version: updated.version, permission_codes: ['members:read', 'members:read'] })).role!
    expect(deduped).toMatchObject({ version: updated.version + 1 })
    expect(deduped.permissions).toEqual(['members:read'])

    // ★ 一个人持多个角色时，有效权限是并集：members:read 来自自定义角色，stats:read 来自成员角色
    await r.setRoles(admin, { member_id: person.member_id, expected_version: person.version, role_ids: [MEMBER_ROLE_ID, created.role_id] })
    const union = await r.issueToken(admin, { member_id: person.member_id, label: '并集', scopes: ['stats:read', 'members:read'] })
    expect((await r.resolveBearer(union.token_secret!))!.permissions).toEqual(['members:read', 'stats:read'])
    // 两个角色都没给的权限仍然授予不了（授予范围 = 角色权限 ∩ 本次身份权限）
    await expect(r.issueToken(admin, { member_id: person.member_id, label: '越权', scopes: ['audit:read'] })).rejects.toMatchObject({ status: 403 })

    // 停用护栏：还有在职成员持有时不许停用，否则会出现「零角色人员」
    const bound = (await r.listRoles(admin)).roles.find((role) => role.role_id === created.role_id)!
    await expect(r.setRoleStatus(admin, { role_id: created.role_id, expected_version: bound.version, status: 'disabled' })).rejects.toMatchObject({ status: 409 })
    const afterRemove = (await r.listMembers(admin)).members.find((member) => member.member_id === person.member_id)!
    await r.setRoles(admin, { member_id: person.member_id, expected_version: afterRemove.version, role_ids: [MEMBER_ROLE_ID] })
    expect((await r.setRoleStatus(admin, { role_id: created.role_id, expected_version: bound.version, status: 'disabled' })).role).toMatchObject({ status: 'disabled', version: bound.version + 1 })

    // ★ 内置角色只读：改它等于给「最后一个管理员」护栏开口子
    await expect(r.updateRole(admin, { role_id: ADMIN_ROLE_ID, expected_version: 1, name: '改名' })).rejects.toMatchObject({ code: 'builtin_role' })
    await expect(r.setRoleStatus(admin, { role_id: MEMBER_ROLE_ID, expected_version: 1, status: 'disabled' })).rejects.toMatchObject({ code: 'builtin_role' })

    // ★ 窄凭证不能给自己造高权限角色：授予必须是自己本次有效权限的子集
    const narrow = await r.issueToken(admin, { member_id: admin.memberId, label: '窄角色管理', scopes: ['roles:assign', 'roles:read'] })
    const narrowActor = (await r.resolveBearer(narrow.token_secret!))!
    await expect(r.createRole(narrowActor, { code: 'escalate', name: '越权角色', permission_codes: ['members:manage'] })).rejects.toMatchObject({ status: 403 })
    expect((await r.listRoles(admin)).roles.some((role) => role.code === 'escalate')).toBe(false)

    // 每次角色变更都要留审计：谁把哪个角色改成了什么
    const audited = await r.listAudit(admin, { target_type: 'role' })
    expect(audited.rows.map((row) => row.action)).toContain('role.create')
    expect(audited.total).toBeGreaterThanOrEqual(3)
  })
  test('真实会话跨实例持久，轮换Token不登出，密码变更立即失效', async () => {
    const { repository: r, admin, target } = await fixture()
    const a = auth(r), b = auth(new IdentityRepository(target))
    const c = await a.challenge(); if (!c.ok) throw new Error(c.reason)
    const signed = await b.login({ username: 'admin', password: PASSWORD, captcha_id: c.data.captcha_id, captcha: '2468' }, c.binding)
    if (!signed.ok) throw new Error(signed.reason)
    const cookie = (await a.resolve(signed.sessionId))!
    expect(cookie.memberId).toBe(admin.memberId)
    const original = (await r.listTokens(admin, admin.memberId)).tokens[0]!
    await r.rotateToken(cookie, { member_id: admin.memberId, token_id: original.token_id, expected_version: original.version })
    expect((await b.resolve(signed.sessionId))?.memberId).toBe(admin.memberId)
    const me = (await r.listMembers(cookie)).members[0]!
    await r.setLogin(cookie, { member_id: me.member_id, expected_version: me.version, username: 'admin', password: 'changed-password-2026' })
    expect(await b.resolve(signed.sessionId)).toBeNull()
    expect((await login(auth(new IdentityRepository(target)), 'admin', 'changed-password-2026')).ok).toBe(true)
  })
  test('验证码并发只消费一次、限流跨实例持久', async () => {
    const { repository: r, target } = await fixture()
    const stale = randomUUID()
    await r.systemWrite(tx => tx.run('INSERT INTO auth_rate_limit_buckets (bucket_id,scope,subject_hash,window_started_at_ms,expires_at_ms,used_points) VALUES ($id,$scope,$hash,0,1,1)', { $id: stale, $scope: 'account', $hash: 'f'.repeat(64) }))
    const a = auth(r), b = auth(new IdentityRepository(target)), c = await a.challenge()
    expect(await r.read(tx => tx.get('SELECT bucket_id FROM auth_rate_limit_buckets WHERE bucket_id=$id', { $id: stale }))).toBeNull()
    if (!c.ok) throw new Error(c.reason)
    const body = { username: 'admin', password: PASSWORD, captcha_id: c.data.captcha_id, captcha: '2468' }
    const results = await Promise.all([a.login(body, c.binding), b.login(body, c.binding)])
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    for (let i = 0; i < 5; i++) expect((await login(i % 2 ? a : b, 'missing', 'bad-password')).ok).toBe(false)
    const limited = await login(auth(new IdentityRepository(target)), 'missing', PASSWORD)
    expect(limited).toMatchObject({ ok: false, status: 429 })
  })
  test('最后永久管理员护栏在事务内回滚账号与凭证变更', async () => {
    const { repository: r, admin } = await fixture()
    let me = (await r.listMembers(admin)).members[0]!
    await r.setLoginStatus(admin, { member_id: me.member_id, expected_version: me.version, enabled: false })
    const original = (await r.listTokens(admin, admin.memberId)).tokens[0]!
    await expect(r.revokeToken(admin, { member_id: admin.memberId, token_id: original.token_id, expected_version: original.version })).rejects.toMatchObject({ code: 'last_administrator' })
    expect(await r.resolveBearer('test-bootstrap-secret')).not.toBeNull()
    me = (await r.listMembers(admin)).members[0]!
    await expect(r.setMemberStatus(admin, { member_id: me.member_id, expected_version: me.version, status: 'disabled' })).rejects.toMatchObject({ code: 'last_administrator' })
    expect((await r.listMembers(admin)).members[0]!.status).toBe('active')
  })
  test('窄管理Token与短效Token不能代替唯一完整恢复入口', async () => {
    const { repository: r, admin } = await fixture()
    let me = (await r.listMembers(admin)).members[0]!
    const original = (await r.listTokens(admin, admin.memberId)).tokens[0]!
    await r.setLoginStatus(admin, { member_id: me.member_id, expected_version: me.version, enabled: false })
    await expect(r.setTokenScopes(admin, { member_id: admin.memberId, token_id: original.token_id, expected_version: original.version, scopes: RECOVERY_PERMISSIONS })).rejects.toMatchObject({ code: 'last_administrator' })
    me = (await r.listMembers(admin)).members[0]!
    await r.setLoginStatus(admin, { member_id: me.member_id, expected_version: me.version, enabled: true })
    await r.issueToken(admin, { member_id: admin.memberId, label: '短期管理', scopes: PERMISSIONS, expires_at_ms: Date.now() + 60_000 })
    await r.setTokenScopes(admin, { member_id: admin.memberId, token_id: original.token_id, expected_version: original.version, scopes: RECOVERY_PERMISSIONS })
    me = (await r.listMembers(admin)).members[0]!
    await expect(r.setLoginStatus(admin, { member_id: me.member_id, expected_version: me.version, enabled: false })).rejects.toMatchObject({ code: 'last_administrator' })
    expect((await login(auth(r))).ok).toBe(true)
    expect((await r.health()).admin_count).toBe(1)
  })
  test('凭证有效期可改且只能是未来或长期，最后管理入口不能改成短效', async () => {
    // 只给 adminToken（不开登录账号）：唯一恢复入口就是那把长期凭证，
    // 于是「把它改成会过期」必须被护栏挡下并整体回滚。
    const { repository: r, admin } = await fixture({ adminToken: 'test-bootstrap-secret', adminName: '管理员' })
    const m = await member(r, admin, '续期成员')
    const issued = await r.issueAppKey(admin, { member_id: m.member_id })
    expect(issued.token.expires_at_ms).toBeNull()
    const expires = Date.now() + 60_000
    const updated = await r.setTokenExpiry(admin, { member_id: m.member_id, token_id: issued.token.token_id, expected_version: issued.token.version, expires_at_ms: expires })
    expect(updated.token.expires_at_ms).toBe(expires)
    expect(updated.token.version).toBe(issued.token.version + 1)
    // 过去时刻、缺字段、旧版本都不能静默生效。
    await expect(r.setTokenExpiry(admin, { member_id: m.member_id, token_id: issued.token.token_id, expected_version: updated.token.version, expires_at_ms: Date.now() - 1 })).rejects.toMatchObject({ status: 400 })
    await expect(r.setTokenExpiry(admin, { member_id: m.member_id, token_id: issued.token.token_id, expected_version: updated.token.version })).rejects.toMatchObject({ status: 400 })
    await expect(r.setTokenExpiry(admin, { member_id: m.member_id, token_id: issued.token.token_id, expected_version: issued.token.version, expires_at_ms: null })).rejects.toMatchObject({ status: 409 })
    const renewed = await r.setTokenExpiry(admin, { member_id: m.member_id, token_id: issued.token.token_id, expected_version: updated.token.version, expires_at_ms: null })
    expect(renewed.token.expires_at_ms).toBeNull()
    // ★ 唯一那把长期管理凭证不能被改成会过期：护栏在同一个写事务里回滚。
    const mine = (await r.listTokens(admin, admin.memberId)).tokens[0]!
    await expect(r.setTokenExpiry(admin, { member_id: admin.memberId, token_id: mine.token_id, expected_version: mine.version, expires_at_ms: Date.now() + 60_000 })).rejects.toMatchObject({ code: 'last_administrator' })
    expect((await r.listTokens(admin, admin.memberId)).tokens[0]!.expires_at_ms).toBeNull()
  })
  test('两个实例并发互降级只允许一次，不能留零管理员', async () => {
    const { repository: r, admin, target } = await fixture()
    const b = await member(r, admin, '另一管理员', ADMIN_ROLE_ID)
    const issued = await r.issueToken(admin, { member_id: b.member_id, label: '管理', scopes: PERMISSIONS })
    const r2 = new IdentityRepository(target), other = (await r2.resolveBearer(issued.token_secret))!
    const me = (await r.listMembers(admin)).members.find((x) => x.member_id === admin.memberId)!
    const result = await Promise.allSettled([
      r.setRoles(admin, { member_id: b.member_id, expected_version: b.version, role_ids: [MEMBER_ROLE_ID] }),
      r2.setRoles(other, { member_id: me.member_id, expected_version: me.version, role_ids: [MEMBER_ROLE_ID] }),
    ])
    expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect((await r.health()).admin_count).toBe(1)
  })
  test('真实KDF完成后撤权，旧请求不能提交密码或成功审计', async () => {
    const { repository: r, admin, target } = await fixture()
    const m = await member(r, admin, '操作者', ADMIN_ROLE_ID), targetMember = await member(r, admin, '目标')
    const issued = await r.issueToken(admin, { member_id: m.member_id, label: '管理', scopes: PERMISSIONS })
    const actor = (await r.resolveBearer(issued.token_secret))!
    let release!: () => void, reached!: () => void
    const ready = new Promise<void>((resolve) => { reached = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    const delayed = new IdentityRepository(target, { afterPasswordHash: async () => { reached(); await gate } })
    const pending = delayed.setLogin(actor, { member_id: targetMember.member_id, expected_version: targetMember.version, username: 'target', password: PASSWORD }).catch((error: unknown) => error)
    await ready
    await r.setRoles(admin, { member_id: m.member_id, expected_version: m.version, role_ids: [MEMBER_ROLE_ID] })
    release()
    expect(await pending).toBeInstanceOf(IdentityError)
    expect(await pending).toMatchObject({ status: 403 })
    expect((await r.listMembers(admin)).members.find((x) => x.member_id === targetMember.member_id)!.account).toBeNull()
    expect((await r.listAudit(admin)).rows.filter((x) => x.action === 'account.set')).toHaveLength(0)
  })
  test('分组、CAS和UTF16边界真实写库', async () => {
    const { repository: r, admin } = await fixture()
    const group = (await r.createGroup(admin, { name: '研发' })).group
    const m = (await r.createMember(admin, { name: '😀'.repeat(16), role_ids: [MEMBER_ROLE_ID], group_ids: [group.group_id] })).member
    await expect(r.updateMember(admin, { member_id: m.member_id, expected_version: 99, name: '新名' })).rejects.toMatchObject({ status: 409 })
    await expect(r.createMember(admin, { name: '😀'.repeat(17), role_ids: [MEMBER_ROLE_ID] })).rejects.toMatchObject({ status: 400 })
    await r.setGroupStatus(admin, { group_id: group.group_id, expected_version: group.version, status: 'disabled' })
    // 停用分组 = 不再往这里挂新人（400），但**不解除**已有归属：
    // 解除关联会改写历史按分组筛选的结果，那是数据变更而不是一次启停。
    await expect(r.createMember(admin, { name: '新成员', role_ids: [MEMBER_ROLE_ID], group_ids: [group.group_id] })).rejects.toMatchObject({ status: 400 })
    expect((await r.listMembers(admin)).members.find((x) => x.member_id === m.member_id)!.groups).toEqual([{ group_id: group.group_id, name: '研发' }])
  })
  test('★ 人员与分组是多对多：全量替换 group_ids，缺省不动、空数组清空', async () => {
    const { repository: r, admin } = await fixture()
    const first = (await r.createGroup(admin, { name: '甲组' })).group!
    const second = (await r.createGroup(admin, { name: '乙组' })).group!
    // 一个人可以同时属于两个分组 —— 这是 v5 多对多的核心诉求，
    // 单值列（v4 的 members.department_id）在结构上就表达不了它。
    const m = (await r.createMember(admin, { name: '双组的人', role_ids: [MEMBER_ROLE_ID], group_ids: [first.group_id, second.group_id] })).member!
    // ⚠️ 顺序按**分组名**排（SQLite 下是 UTF-8 码点序：乙 U+4E59 < 甲 U+7532），
    //   不是按传入的 group_ids 顺序 —— 排序规则只有一处，列表与详情才会一致。
    expect(m.groups).toEqual([{ group_id: second.group_id, name: '乙组' }, { group_id: first.group_id, name: '甲组' }])

    // 只改姓名（不带 group_ids）→ 分组**原样不动**：请求没提这件事
    const renamed = (await r.updateMember(admin, { member_id: m.member_id, expected_version: m.version, name: '改名' })).member!
    expect(renamed.groups).toHaveLength(2)

    // 给 [] → 清空（与「没给」是两件不同的事，所以必须能区分）
    const cleared = (await r.updateMember(admin, { member_id: m.member_id, expected_version: renamed.version, group_ids: [] })).member!
    expect(cleared.groups).toEqual([])

    // 不存在的分组必须 400：静默丢掉会让调用方以为挂上了
    await expect(r.updateMember(admin, { member_id: m.member_id, expected_version: cleared.version, group_ids: [randomUUID()] })).rejects.toMatchObject({ status: 400 })
    // 同一个分组给两次不会在关联表里留下重复行
    const again = (await r.updateMember(admin, { member_id: m.member_id, expected_version: cleared.version, group_ids: [second.group_id, second.group_id] })).member!
    expect(again.groups).toEqual([{ group_id: second.group_id, name: '乙组' }])
  })
  test('审计时间与对象过滤和总数一致，已过期Token不计有效凭证', async () => {
    const { repository: r, admin, target } = await fixture()
    const start = Date.now(), a = await member(r, admin, '审计甲'), b = await member(r, admin, '审计乙')
    const result = await r.listAudit(admin, { from: start, to: Date.now() + 1, target_type: 'member', target_id: a.member_id, limit: 1, offset: 0 })
    expect(result.total).toBe(1)
    expect(result.rows[0]!.target_id).toBe(a.member_id)
    expect((await r.listAudit(admin, { target_id: b.member_id })).total).toBe(1)
    await expect(r.listAudit(admin, { from: 2, to: 1 })).rejects.toMatchObject({ status: 400 })
    const before = (await r.health()).token_count
    const later = new IdentityRepository(target, { now: () => Date.now() + 60_000 })
    await r.issueToken(admin, { member_id: a.member_id, label: '短期', expires_at_ms: Date.now() + 1000 })
    expect((await later.health()).token_count).toBe(before)
  })
  test('显式旧格式导入保留密码与禁用状态，重跑及重启不复活env管理员', async () => {
    const { repository: r, dir, target } = await fixture(false)
    const path = join(dir, 'legacy.json'), hash = await hashPassword(PASSWORD)
    const entries = [
      { token: 'legacy-admin', name: '原管理员', role: 'admin', username: 'admin', passwordHash: hash },
      { token: 'legacy-disabled', name: '已停用登录', username: 'disabled', passwordHash: hash, loginEnabled: false },
    ]
    writeFileSync(path, JSON.stringify(entries))
    const env = { token: 'legacy-env', name: '部署管理员', role: 'admin' as const }
    const imported = await importCredentialFile(r, path, { envAdmin: env })
    expect(imported.imported_entries).toBe(3)
    expect((await login(auth(r))).ok).toBe(true)
    expect((await login(auth(r), 'disabled')).ok).toBe(false)
    const actor = (await r.resolveBearer('legacy-admin'))!
    await importCredentialFile(r, path, { envAdmin: env })
    expect((await r.listMembers(actor)).members).toHaveLength(3)
    const envMember = (await r.listMembers(actor)).members.find((m) => m.name === env.name)!
    await r.setMemberStatus(actor, { member_id: envMember.member_id, expected_version: envMember.version, status: 'disabled' })
    await new IdentityRepository(target).initialize({ adminToken: env.token, adminName: env.name })
    await importCredentialFile(r, path, { envAdmin: env })
    expect(await r.resolveBearer(env.token)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(entries))
  })
  test('姓名到Token旧映射格式可显式导入，重复Token或非法角色整批拒绝', async () => {
    const { repository: r, dir } = await fixture(false), path = join(dir, 'legacy-map.json')
    writeFileSync(path, JSON.stringify([{ name: '甲', token: 'duplicate' }, { name: '乙', token: 'duplicate' }]))
    await expect(importCredentialFile(r, path)).rejects.toMatchObject({ status: 400 })
    expect(await r.isRegistered()).toBe(false)
    writeFileSync(path, JSON.stringify([{ name: '甲', token: 'one', role: 'bogus' }]))
    await expect(importCredentialFile(r, path)).rejects.toMatchObject({ status: 400 })
    writeFileSync(path, JSON.stringify({ '映射成员': 'mapped-member-token' }))
    await importCredentialFile(r, path, { envAdmin: { token: 'admin-map-token', name: '管理员', role: 'admin' } })
    expect((await r.verifyIdentity('mapped-member-token')).name).toBe('映射成员')
  })
  test('真实SQLite v3副本升级后导入，显式映射仅回填旧历史且原始列逐位不变', async () => {
    // 这是旧 SQLite 副本迁移；MySQL 的结构升级由数据库层独立脚本验证。
    const dir = mkdtempSync(join(tmpdir(), 'atr-identity-db-')); roots.push(dir)
    const target = { sqlitePath: join(dir, 'legacy.sqlite') }, db = openDb(target.sqlitePath)
    ensureSchema(db)
    // ⚠️ 这里是**迁移前**的 v3 副本：那时快照列还叫 `dept`（v5 才改名 `group_name`）。
    //   所以下面这条 INSERT 用旧列名，而迁移之后的 SELECT 用新列名 —— 同一份测试里
    //   出现两个名字是对的，判断依据是「这句 SQL 跑在迁移前还是迁移后」。
    const insert = db.prepare('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    try {
      insert.run(['legacy:1', 'legacy', 1, Date.now(), 'fixture', 'model', '旧姓名', '旧姓名', '旧分组', 10, 20, 30, 40, 5])
      insert.run(['legacy:2', 'legacy', 2, Date.now(), 'fixture', 'model', null, null, null, 1, 2, 3, 4, 1])
    } finally { insert.finalize(); db.close() }
    await migratePortalDatabase(target, { confirmOffline: true })
    const r = new IdentityRepository(target), path = join(dir, 'credentials.json')
    writeFileSync(path, JSON.stringify([{ token: 'migrated-admin', name: '旧姓名', role: 'admin', username: 'admin', passwordHash: await hashPassword(PASSWORD) }]))
    await importCredentialFile(r, path)
    const actor = (await r.resolveBearer('migrated-admin'))!
    expect((await login(auth(r))).ok).toBe(true)
    const snapshot = await r.read((tx) => tx.all('SELECT event_id,user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM usage_event ORDER BY event_id'))
    const mapping = (await r.listLegacyAttributions(actor)).mappings[0]!
    expect(mapping.status).toBe('pending')
    expect(mapping.member_id).toBeNull()
    await r.systemWrite((tx) => tx.run('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,received_at_ms) VALUES ($id,$session,3,$now,$provider,$model,$name,$name,$now)', { $id: 'new:3', $session: 'new', $now: Date.now(), $provider: 'fixture', $model: 'model', $name: '旧姓名' }))
    await expect(r.confirmLegacyAttribution(actor, { mapping_id: mapping.mapping_id, member_id: actor.memberId, expected_status: 'pending', source_import_ref: 'wrong-source', reason: '确认依据' })).rejects.toMatchObject({ status: 409 })
    const result = await r.confirmLegacyAttribution(actor, { mapping_id: mapping.mapping_id, member_id: actor.memberId, expected_status: 'pending', source_import_ref: mapping.source_import_ref, reason: '已核对原始登记及事件所属' })
    expect(result.updated_events).toBe(1)
    const after = await r.read((tx) => tx.all('SELECT event_id,user_id,user_name,group_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM usage_event WHERE event_id IN ($a,$b) ORDER BY event_id', { $a: 'legacy:1', $b: 'legacy:2' }))
    expect(after).toEqual(snapshot)
    const owners = await r.read((tx) => tx.all<{ event_id: string; member_id: string | null }>('SELECT event_id,member_id FROM usage_event ORDER BY event_id'))
    expect(owners).toEqual([{ event_id: 'legacy:1', member_id: actor.memberId }, { event_id: 'legacy:2', member_id: null }, { event_id: 'new:3', member_id: null }])
    expect((await r.listAudit(actor, { target_type: 'legacy_mapping', target_id: mapping.mapping_id })).total).toBe(1)
  })
})
