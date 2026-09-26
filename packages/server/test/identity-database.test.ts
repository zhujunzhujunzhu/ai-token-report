/** 真 SQLite 身份与权限回归：不模拟数据库、密码 KDF、事务或认证结果。 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { IdentityRepository, ADMIN_ROLE_ID, MEMBER_ROLE_ID, PERMISSIONS, RECOVERY_PERMISSIONS, IdentityError, importCredentialFile, type Principal, type BootstrapOptions } from '../src/identity/index.js'
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
  test('部门、CAS和UTF16边界真实写库', async () => {
    const { repository: r, admin } = await fixture()
    const department = (await r.createDepartment(admin, { name: '研发' })).department
    const m = (await r.createMember(admin, { name: '😀'.repeat(16), role_ids: [MEMBER_ROLE_ID], department_id: department.department_id })).member
    await expect(r.updateMember(admin, { member_id: m.member_id, expected_version: 99, name: '新名' })).rejects.toMatchObject({ status: 409 })
    await expect(r.createMember(admin, { name: '😀'.repeat(17), role_ids: [MEMBER_ROLE_ID] })).rejects.toMatchObject({ status: 400 })
    await r.setDepartmentStatus(admin, { department_id: department.department_id, expected_version: department.version, status: 'disabled' })
    await expect(r.createMember(admin, { name: '新成员', role_ids: [MEMBER_ROLE_ID], department_id: department.department_id })).rejects.toMatchObject({ status: 400 })
    expect((await r.listMembers(admin)).members.find((x) => x.member_id === m.member_id)!.department_id).toBe(department.department_id)
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
    const insert = db.prepare('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    try {
      insert.run(['legacy:1', 'legacy', 1, Date.now(), 'fixture', 'model', '旧姓名', '旧姓名', '旧部门', 10, 20, 30, 40, 5])
      insert.run(['legacy:2', 'legacy', 2, Date.now(), 'fixture', 'model', null, null, null, 1, 2, 3, 4, 1])
    } finally { insert.finalize(); db.close() }
    await migratePortalDatabase(target, { confirmOffline: true })
    const r = new IdentityRepository(target), path = join(dir, 'credentials.json')
    writeFileSync(path, JSON.stringify([{ token: 'migrated-admin', name: '旧姓名', role: 'admin', username: 'admin', passwordHash: await hashPassword(PASSWORD) }]))
    await importCredentialFile(r, path)
    const actor = (await r.resolveBearer('migrated-admin'))!
    expect((await login(auth(r))).ok).toBe(true)
    const snapshot = await r.read((tx) => tx.all('SELECT event_id,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM usage_event ORDER BY event_id'))
    const mapping = (await r.listLegacyAttributions(actor)).mappings[0]!
    expect(mapping.status).toBe('pending')
    expect(mapping.member_id).toBeNull()
    await r.systemWrite((tx) => tx.run('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,received_at_ms) VALUES ($id,$session,3,$now,$provider,$model,$name,$name,$now)', { $id: 'new:3', $session: 'new', $now: Date.now(), $provider: 'fixture', $model: 'model', $name: '旧姓名' }))
    await expect(r.confirmLegacyAttribution(actor, { mapping_id: mapping.mapping_id, member_id: actor.memberId, expected_status: 'pending', source_import_ref: 'wrong-source', reason: '确认依据' })).rejects.toMatchObject({ status: 409 })
    const result = await r.confirmLegacyAttribution(actor, { mapping_id: mapping.mapping_id, member_id: actor.memberId, expected_status: 'pending', source_import_ref: mapping.source_import_ref, reason: '已核对原始登记及事件所属' })
    expect(result.updated_events).toBe(1)
    const after = await r.read((tx) => tx.all('SELECT event_id,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM usage_event WHERE event_id IN ($a,$b) ORDER BY event_id', { $a: 'legacy:1', $b: 'legacy:2' }))
    expect(after).toEqual(snapshot)
    const owners = await r.read((tx) => tx.all<{ event_id: string; member_id: string | null }>('SELECT event_id,member_id FROM usage_event ORDER BY event_id'))
    expect(owners).toEqual([{ event_id: 'legacy:1', member_id: actor.memberId }, { event_id: 'legacy:2', member_id: null }, { event_id: 'new:3', member_id: null }])
    expect((await r.listAudit(actor, { target_type: 'legacy_mapping', target_id: mapping.mapping_id })).total).toBe(1)
  })
})
