/** 部门身份的数据库真值；与用量写入共用连接、锁顺序和提交边界。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { openPortalStore, type PortalStore, type PortalTarget } from '@ai-token-report/core/db'
import { hashPassword, normalizeUsername, passwordError, usernameError } from '../auth/password.js'
import type { CredentialInput } from '../credentials.js'
import type { PortalMember, PortalRole, PortalDepartment, PortalReportToken, PortalAuditResponse, PortalStorageResponse, PortalLegacyAttribution } from '@ai-token-report/shared'
import { ADMIN_ROLE_ID, MEMBER_ROLE_ID, DEFAULT_SCOPES, RECOVERY_PERMISSIONS, PERMISSIONS, IdentityError, requirePermission, subset, str, num, textField, idField, listField, displayName, type Principal, type Row, type MutationInput } from './types.js'

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const randomSecret = (): string => randomBytes(32).toString('base64url')
export interface BootstrapOptions { adminToken?: string; adminName?: string; adminUsername?: string; adminPassword?: string }
export type LegacyCredentialInput = CredentialInput & { loginEnabled?: boolean }

export class IdentityRepository {
  readonly now: () => number
  private readonly afterPasswordHash?: () => Promise<void>
  constructor(readonly target: PortalTarget, options: { now?: () => number; afterPasswordHash?: () => Promise<void> } = {}) {
    this.now = options.now ?? Date.now
    // 测试可挂时序屏障；真实 KDF 与事务重鉴权始终执行，生产不配置该回调。
    this.afterPasswordHash = options.afterPasswordHash
  }

  async read<T>(fn: (store: PortalStore) => Promise<T>): Promise<T> {
    const store = await openPortalStore(this.target)
    try { return await fn(store) } finally { await store.close() }
  }

  /** 所有身份写操作都先锁同一行；不能在回调中另起事务或连接。 */
  async systemWrite<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    return this.read((store) => store.transaction(async (tx) => {
      await tx.run('UPDATE portal_identity_state SET revision = revision WHERE singleton_key = 1')
      return fn(tx)
    }))
  }

  async withWrite<T>(actor: Principal, permission: string, fn: (tx: PortalStore, fresh: Principal) => Promise<T>): Promise<T> {
    return this.systemWrite(async (tx) => {
      const fresh = await this.reauthenticate(tx, actor)
      if (!fresh) throw new IdentityError(401, '登录或凭证已失效，请重新认证')
      requirePermission(fresh, permission)
      return fn(tx, fresh)
    })
  }

  async isRegistered(): Promise<boolean> {
    return this.read(async (tx) => (await tx.get<Row>('SELECT initialized_at_ms FROM portal_identity_state WHERE singleton_key = 1'))?.initialized_at_ms != null)
  }
  async resolveBearer(secret: string): Promise<Principal | null> {
    if (!secret.trim()) return null
    return this.read(async (tx) => {
      const row = await tx.get<Row>('SELECT token_id FROM report_tokens WHERE token_hash = $hash', { $hash: digest(secret.trim()) })
      return row ? this.tokenPrincipal(tx, str(row, 'token_id')) : null
    })
  }
  async resolveSession(secret?: string): Promise<Principal | null> {
    if (!secret) return null
    return this.read(async (tx) => {
      const row = await tx.get<Row>('SELECT session_id FROM auth_sessions WHERE session_hash = $hash', { $hash: digest(secret) })
      return row ? this.sessionPrincipal(tx, str(row, 'session_id')) : null
    })
  }
  async authorize(actor: Principal, permission: string): Promise<Principal> {
    return this.read(async (tx) => {
      const fresh = await this.reauthenticate(tx, actor)
      if (!fresh) throw new IdentityError(401, '登录或凭证已失效，请重新认证')
      requirePermission(fresh, permission)
      return fresh
    })
  }
  async verifyIdentity(secret: string) {
    const registered = await this.isRegistered()
    if (!registered) return { ok: false, registered, reason: '服务端尚未配置任何凭证，请让管理员先发放 token' }
    const p = await this.resolveBearer(secret)
    if (!p || !p.permissions.includes('identity:read')) return { ok: false, registered, reason: 'token 无效，请向管理员确认' }
    return { ok: true, registered, name: p.name, member_id: p.memberId, role: p.roleCodes.includes('admin') ? 'admin' as const : 'member' as const, ...(p.dept ? { dept: p.dept } : {}) }
  }
  async getViewer(actor: Principal) {
    return this.read(async (tx) => {
      const p = await this.reauthenticate(tx, actor)
      if (!p) throw new IdentityError(401, '登录已失效，请重新登录')
      const account = await tx.get<Row>('SELECT username_normalized FROM login_accounts WHERE member_id = $id', { $id: p.memberId })
      const roles = await this.memberRoles(tx, p.memberId)
      return { member_id: p.memberId, name: p.name, username: account ? str(account, 'username_normalized') : '', role: p.roleCodes.includes('admin') ? 'admin' as const : 'member' as const, roles, permissions: p.permissions, department_id: p.departmentId ?? null, department_name: p.dept ?? null, ...(p.dept ? { dept: p.dept } : {}) }
    })
  }
  private async memberRoles(tx: PortalStore, memberId: string): Promise<PortalRole[]> {
    const rows = await tx.all<Row>('SELECT r.role_id,r.code,r.name FROM roles r JOIN member_roles mr ON mr.role_id = r.role_id WHERE mr.member_id = $id AND r.status = $status ORDER BY r.code', { $id: memberId, $status: 'active' })
    return Promise.all(rows.map(async (r) => ({ role_id: str(r, 'role_id'), code: str(r, 'code'), name: str(r, 'name'), permissions: await this.permissionsForRole(tx, str(r, 'role_id')) })))
  }
  private async rolePermissions(tx: PortalStore, memberId: string): Promise<string[]> {
    const rows = await tx.all<Row>('SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.permission_id JOIN roles r ON r.role_id = rp.role_id JOIN member_roles mr ON mr.role_id = r.role_id WHERE mr.member_id = $id AND r.status = $status ORDER BY p.code', { $id: memberId, $status: 'active' })
    return rows.map((r) => str(r, 'code'))
  }
  private async principal(tx: PortalStore, memberId: string, auth: Principal['auth']): Promise<Principal | null> {
    const row = await tx.get<Row>('SELECT m.*, d.name AS department_name FROM members m LEFT JOIN departments d ON m.department_id = d.department_id WHERE m.member_id = $id AND m.status = $status', { $id: memberId, $status: 'active' })
    if (!row) return null
    return { memberId, name: str(row, 'display_name'), departmentId: row.department_id ? str(row, 'department_id') : null, ...(row.department_id ? { dept: str(row, 'department_name') } : {}), roleCodes: (await this.memberRoles(tx, memberId)).map((r) => r.code), permissions: await this.rolePermissions(tx, memberId), auth }
  }
  private async tokenPrincipal(tx: PortalStore, tokenId: string): Promise<Principal | null> {
    const row = await tx.get<Row>('SELECT * FROM report_tokens WHERE token_id = $id AND status = $status AND (expires_at_ms IS NULL OR expires_at_ms > $now)', { $id: tokenId, $status: 'active', $now: this.now() })
    if (!row) return null
    const p = await this.principal(tx, str(row, 'member_id'), { kind: 'token', tokenId })
    if (!p) return null
    const scopes = await this.tokenScopes(tx, tokenId)
    p.permissions = p.permissions.filter((code) => scopes.includes(code))
    return p
  }
  private async sessionPrincipal(tx: PortalStore, sessionId: string): Promise<Principal | null> {
    const row = await tx.get<Row>('SELECT a.member_id,a.account_id FROM auth_sessions s JOIN login_accounts a ON a.account_id = s.account_id WHERE s.session_id = $id AND s.revoked_at_ms IS NULL AND s.expires_at_ms > $now AND a.enabled = 1 AND a.password_version = s.password_version', { $id: sessionId, $now: this.now() })
    return row ? this.principal(tx, str(row, 'member_id'), { kind: 'session', sessionId, accountId: str(row, 'account_id') }) : null
  }
  private async reauthenticate(tx: PortalStore, actor: Principal): Promise<Principal | null> {
    const p = actor.auth.kind === 'token' ? await this.tokenPrincipal(tx, actor.auth.tokenId) : await this.sessionPrincipal(tx, actor.auth.sessionId)
    return p?.memberId === actor.memberId ? p : null
  }
  private async tokenScopes(tx: PortalStore, tokenId: string): Promise<string[]> {
    return (await tx.all<Row>('SELECT p.code FROM permissions p JOIN report_token_scopes s ON s.permission_id = p.permission_id WHERE s.token_id = $id ORDER BY p.code', { $id: tokenId })).map((r) => str(r, 'code'))
  }

  async initialize(options: BootstrapOptions = {}): Promise<void> {
    if (await this.isRegistered()) return
    if (!options.adminToken && !options.adminUsername && !options.adminPassword) return
    if (!!options.adminUsername !== !!options.adminPassword) throw new IdentityError(400, '初始化管理员用户名与密码需要一起配置')
    const passwordHash = options.adminPassword ? await hashPassword(options.adminPassword) : undefined
    await this.importEntries([{ token: options.adminToken ?? '', name: options.adminName ?? '管理员', role: 'admin', ...(options.adminUsername ? { username: options.adminUsername, passwordHash } : {}) }], 'bootstrap', true, !options.adminToken)
  }

  /** 显式旧文件导入入口；调用方负责严格读取原始文件，不可传 Map 去重后的集合。 */
  async importCredentials(entries: LegacyCredentialInput[], sourceRef: string): Promise<void> {
    return this.importEntries(entries, sourceRef, false, false)
  }
  private async importEntries(entries: LegacyCredentialInput[], sourceRef: string, allowInitializedSkip: boolean, accountOnlyBootstrap: boolean): Promise<void> {
    if (!sourceRef || sourceRef.length > 128) throw new IdentityError(400, '导入来源校验标识无效')
    const tokens = new Set<string>(), usernames = new Set<string>()
    for (const e of entries) {
      if (!accountOnlyBootstrap) {
        if (!e.token?.trim() || tokens.has(digest(e.token.trim()))) throw new IdentityError(400, '导入凭证为空或存在重复 Token')
        tokens.add(digest(e.token.trim()))
      }
      displayName(e.name)
      if (e.role !== undefined && e.role !== 'admin' && e.role !== 'member') throw new IdentityError(400, '导入包含未知角色')
      if (e.dept) displayName(e.dept, 64)
      if (!!e.username !== !!e.passwordHash) throw new IdentityError(400, '导入账号与密码哈希不完整')
      if (e.loginEnabled !== undefined && typeof e.loginEnabled !== 'boolean') throw new IdentityError(400, '导入登录启用状态无效')
      if (e.username) {
        const username = normalizeUsername(e.username)
        if (usernameError(username) || usernames.has(username) || !/^\$atr-scrypt\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(e.passwordHash ?? '')) throw new IdentityError(400, '导入用户名重复或账号格式无效')
        usernames.add(username)
      }
    }
    await this.systemWrite(async (tx) => {
      const state = await tx.get<Row>('SELECT initialized_at_ms FROM portal_identity_state WHERE singleton_key = 1')
      if (state?.initialized_at_ms != null) {
        if (allowInitializedSkip) return
        const prior = await tx.all<Row>('SELECT metadata_json FROM admin_audit_log WHERE action = $action', { $action: 'identity.import' })
        if (prior.some((r) => {
          const metadata = (typeof r.metadata_json === 'string' ? JSON.parse(r.metadata_json) : r.metadata_json) as Row
          return metadata.source === sourceRef
        })) return
        throw new IdentityError(409, '身份数据库已经初始化，不能重复导入')
      }
      const existing = await tx.get<Row>('SELECT COUNT(*) AS c FROM members')
      if (num(existing ?? {}, 'c') > 0) throw new IdentityError(409, '身份库已有未完成初始化的数据，请先核查')
      const now = this.now()
      let firstAdmin: string | null = null
      for (const entry of entries) {
        let departmentId: string | null = null
        if (entry.dept?.trim()) {
          const name = displayName(entry.dept, 64)
          const d = await tx.get<Row>('SELECT department_id FROM departments WHERE name = $name', { $name: name })
          departmentId = d ? str(d, 'department_id') : randomUUID()
          if (!d) await tx.run('INSERT INTO departments (department_id,name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: departmentId, $name: name, $now: now })
        }
        const memberId = randomUUID()
        await tx.run('INSERT INTO members (member_id,display_name,department_id,created_at_ms,updated_at_ms) VALUES ($id,$name,$dept,$now,$now)', { $id: memberId, $name: displayName(entry.name), $dept: departmentId, $now: now })
        const admin = entry.role === 'admin'
        await tx.run('INSERT INTO member_roles (member_id,role_id,granted_at_ms) VALUES ($id,$role,$now)', { $id: memberId, $role: admin ? ADMIN_ROLE_ID : MEMBER_ROLE_ID, $now: now })
        if (admin && !firstAdmin) firstAdmin = memberId
        if (entry.username) await tx.run('INSERT INTO login_accounts (account_id,member_id,username_normalized,password_hash,enabled,created_at_ms,updated_at_ms) VALUES ($id,$member,$username,$hash,$enabled,$now,$now)', { $id: randomUUID(), $member: memberId, $username: normalizeUsername(entry.username), $hash: entry.passwordHash!, $enabled: entry.loginEnabled === false ? 0 : 1, $now: now })
        if (!accountOnlyBootstrap) await this.insertToken(tx, memberId, entry.token.trim(), '迁移凭证', admin ? PERMISSIONS : ['identity:read', 'usage:write', 'stats:read', 'departments:read'], null)
      }
      await this.ensureRecovery(tx)
      await tx.run('UPDATE portal_identity_state SET initialized_at_ms = $now, initialized_by_member_id = $member, updated_at_ms = $now, revision = revision + 1 WHERE singleton_key = 1', { $now: now, $member: firstAdmin })
      const legacy = await tx.all<Row>('SELECT DISTINCT user_id FROM usage_event WHERE user_id IS NOT NULL')
      for (const r of legacy) {
        if (await tx.get<Row>('SELECT mapping_id FROM legacy_attribution_map WHERE legacy_user_id = $key', { $key: r.user_id })) continue
        await tx.run('INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,source_import_ref,created_at_ms) VALUES ($id,$key,$source,$now)', { $id: randomUUID(), $key: r.user_id, $source: sourceRef.slice(0, 128), $now: now })
      }
      await this.audit(tx, null, 'identity.import', 'identity', null, { count: entries.length, source: sourceRef.slice(0, 128) })
    })
  }

  private async permissionsForRole(tx: PortalStore, roleId: string): Promise<string[]> {
    return (await tx.all<Row>('SELECT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.permission_id WHERE rp.role_id = $id ORDER BY p.code', { $id: roleId })).map((r) => str(r, 'code'))
  }
  private async member(tx: PortalStore, id: string): Promise<PortalMember> {
    const r = await tx.get<Row>('SELECT m.*,d.name AS department_name FROM members m LEFT JOIN departments d ON d.department_id = m.department_id WHERE m.member_id = $id', { $id: id })
    if (!r) throw new IdentityError(404, '人员不存在')
    const a = await tx.get<Row>('SELECT username_normalized,enabled FROM login_accounts WHERE member_id = $id', { $id: id })
    const count = await tx.get<Row>('SELECT COUNT(*) AS c FROM report_tokens WHERE member_id = $id AND status = $active AND (expires_at_ms IS NULL OR expires_at_ms > $now)', { $id: id, $active: 'active', $now: this.now() })
    return { member_id: id, name: str(r, 'display_name'), status: str(r, 'status') as PortalMember['status'], department_id: r.department_id == null ? null : str(r, 'department_id'), department_name: r.department_name == null ? null : str(r, 'department_name'), roles: await this.memberRoles(tx, id), account: a ? { username: str(a, 'username_normalized'), enabled: num(a, 'enabled') === 1 } : null, active_token_count: num(count ?? {}, 'c'), version: num(r, 'version'), created_at_ms: num(r, 'created_at_ms'), updated_at_ms: num(r, 'updated_at_ms') }
  }
  private async checkedMember(tx: PortalStore, input: MutationInput): Promise<PortalMember> {
    const m = await this.member(tx, idField(input, 'member_id'))
    this.checkVersion(input, m.version)
    return m
  }
  private checkVersion(input: MutationInput, current: number): void {
    if (!Number.isSafeInteger(input.expected_version) || Number(input.expected_version) < 1) throw new IdentityError(400, 'expected_version 需要是正整数')
    if (input.expected_version !== current) throw new IdentityError(409, '数据已被修改，请刷新后重试', 'version_conflict')
  }
  private async touchMember(tx: PortalStore, id: string): Promise<void> {
    await tx.run('UPDATE members SET version = version + 1, updated_at_ms = $now WHERE member_id = $id', { $id: id, $now: this.now() })
  }
  private async securedRead<T>(actor: Principal, permission: string, fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    return this.read(async (tx) => {
      const fresh = await this.reauthenticate(tx, actor)
      if (!fresh) throw new IdentityError(401, '登录或凭证已失效')
      requirePermission(fresh, permission)
      return fn(tx)
    })
  }
  private async mutate<T>(actor: Principal, permission: string, action: string, targetType: string, targetId: string | null, fn: (tx: PortalStore, fresh: Principal) => Promise<T>): Promise<T> {
    return this.withWrite(actor, permission, async (tx, fresh) => {
      const result = await fn(tx, fresh)
      await this.ensureRecovery(tx)
      await this.audit(tx, fresh, action, targetType, targetId, {})
      await tx.run('UPDATE portal_identity_state SET revision = revision + 1, updated_at_ms = $now WHERE singleton_key = 1', { $now: this.now() })
      return result
    })
  }
  private async audit(tx: PortalStore, actor: Principal | null, action: string, target: string, id: string | null, metadata: Row): Promise<void> {
    await tx.run('INSERT INTO admin_audit_log (audit_id,actor_member_id,actor_account_id,actor_token_id,action,target_type,target_id,request_id,metadata_json,occurred_at_ms) VALUES ($id,$actor,$account,$token,$action,$target,$targetId,$request,$metadata,$now)', { $id: randomUUID(), $actor: actor?.memberId ?? null, $account: actor?.auth.kind === 'session' ? actor.auth.accountId : null, $token: actor?.auth.kind === 'token' ? actor.auth.tokenId : null, $action: action, $target: target, $targetId: id, $request: randomUUID(), $metadata: JSON.stringify(metadata), $now: this.now() })
  }
  private async recoveryCount(tx: PortalStore): Promise<number> {
    let count = 0
    for (const row of await tx.all<Row>('SELECT member_id FROM members WHERE status = $active', { $active: 'active' })) {
      const id = str(row, 'member_id'), permissions = await this.rolePermissions(tx, id)
      if (!RECOVERY_PERMISSIONS.every((p) => permissions.includes(p))) continue
      const account = await tx.get<Row>('SELECT account_id FROM login_accounts WHERE member_id = $id AND enabled = 1', { $id: id })
      if (account) { count++; continue }
      const tokens = await tx.all<Row>('SELECT token_id FROM report_tokens WHERE member_id = $id AND status = $active AND expires_at_ms IS NULL', { $id: id, $active: 'active' })
      for (const token of tokens) {
        const scopes = await this.tokenScopes(tx, str(token, 'token_id'))
        // 恢复账号会重新授予完整角色身份；仅有管理动作权限的窄 Token 不能充当永久入口。
        if (permissions.every((p) => scopes.includes(p))) { count++; break }
      }
    }
    return count
  }
  private async ensureRecovery(tx: PortalStore): Promise<void> {
    if (await this.recoveryCount(tx) === 0) throw new IdentityError(409, '必须保留至少一个可登录或持有长期管理凭证的管理员', 'last_administrator')
  }
  async health() {
    return this.read(async (tx) => ({ initialized: (await tx.get<Row>('SELECT initialized_at_ms FROM portal_identity_state WHERE singleton_key = 1'))?.initialized_at_ms != null, member_count: num((await tx.get<Row>('SELECT COUNT(*) AS c FROM members')) ?? {}, 'c'), token_count: num((await tx.get<Row>('SELECT COUNT(*) AS c FROM report_tokens WHERE status = $active AND (expires_at_ms IS NULL OR expires_at_ms > $now)', { $active: 'active', $now: this.now() })) ?? {}, 'c'), admin_count: await this.recoveryCount(tx) }))
  }
  async storage(actor: Principal): Promise<PortalStorageResponse> {
    return this.securedRead(actor, 'members:read', async (tx) => ({ kind: tx.kind, schema_version: 4, available: true, initialized: (await tx.get<Row>('SELECT initialized_at_ms FROM portal_identity_state WHERE singleton_key = 1'))?.initialized_at_ms != null }))
  }
  async listMembers(actor: Principal) {
    return this.securedRead(actor, 'members:read', async (tx) => {
      const members: PortalMember[] = []
      for (const row of await tx.all<Row>('SELECT member_id FROM members ORDER BY display_name,member_id')) members.push(await this.member(tx, str(row, 'member_id')))
      return { members }
    })
  }
  async listRoles(actor: Principal) {
    return this.securedRead(actor, 'roles:read', async (tx) => ({ roles: await Promise.all((await tx.all<Row>('SELECT role_id,code,name FROM roles WHERE status = $active ORDER BY code', { $active: 'active' })).map(async (r): Promise<PortalRole> => ({ role_id: str(r, 'role_id'), code: str(r, 'code'), name: str(r, 'name'), permissions: await this.permissionsForRole(tx, str(r, 'role_id')) }))) }))
  }
  private async setRoleRows(tx: PortalStore, actor: Principal, id: string, roles: string[]): Promise<void> {
    requirePermission(actor, 'roles:assign')
    if (!roles.length) throw new IdentityError(400, '人员至少需要一个角色')
    for (const role of roles) {
      const r = await tx.get<Row>('SELECT role_id FROM roles WHERE role_id = $id AND status = $active', { $id: role, $active: 'active' })
      if (!r) throw new IdentityError(400, '角色不存在或已停用')
      subset(await this.permissionsForRole(tx, role), actor.permissions)
    }
    await tx.run('DELETE FROM member_roles WHERE member_id = $id', { $id: id })
    for (const role of roles) await tx.run('INSERT INTO member_roles (member_id,role_id,granted_at_ms) VALUES ($id,$role,$now)', { $id: id, $role: role, $now: this.now() })
  }
  private async departmentId(tx: PortalStore, input: MutationInput): Promise<string | null> {
    if (input.department_id == null) return null
    const id = idField(input, 'department_id')
    if (!await tx.get<Row>('SELECT department_id FROM departments WHERE department_id = $id AND status = $active', { $id: id, $active: 'active' })) throw new IdentityError(400, '部门不存在或已停用')
    return id
  }
  async createMember(actor: Principal, input: MutationInput) {
    const name = displayName(textField(input, 'name')), roles = listField(input, 'role_ids'), id = randomUUID()
    return this.mutate(actor, 'members:manage', 'member.create', 'member', id, async (tx, fresh) => {
      const dept = await this.departmentId(tx, input), now = this.now()
      await tx.run('INSERT INTO members (member_id,display_name,department_id,created_at_ms,updated_at_ms) VALUES ($id,$name,$dept,$now,$now)', { $id: id, $name: name, $dept: dept, $now: now })
      await this.setRoleRows(tx, fresh, id, roles)
      return { ok: true as const, member: await this.member(tx, id) }
    })
  }
  async updateMember(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'members:manage', 'member.update', 'member', idField(input, 'member_id'), async (tx) => {
      const m = await this.checkedMember(tx, input)
      const name = input.name === undefined ? m.name : displayName(textField(input, 'name'))
      const dept = input.department_id === undefined ? m.department_id : await this.departmentId(tx, input)
      await tx.run('UPDATE members SET display_name = $name, department_id = $dept WHERE member_id = $id', { $name: name, $dept: dept, $id: m.member_id })
      await this.touchMember(tx, m.member_id)
      return { ok: true as const, member: await this.member(tx, m.member_id) }
    })
  }
  async setRoles(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'roles:assign', 'member.roles', 'member', idField(input, 'member_id'), async (tx, fresh) => {
      const m = await this.checkedMember(tx, input)
      await this.setRoleRows(tx, fresh, m.member_id, listField(input, 'role_ids'))
      await this.touchMember(tx, m.member_id)
      return { ok: true as const, member: await this.member(tx, m.member_id) }
    })
  }
  async setMemberStatus(actor: Principal, input: MutationInput) {
    const status = textField(input, 'status')
    if (!['active', 'disabled', 'archived'].includes(status)) throw new IdentityError(400, '人员状态无效')
    return this.mutate(actor, 'members:manage', 'member.status', 'member', idField(input, 'member_id'), async (tx) => {
      const m = await this.checkedMember(tx, input)
      await tx.run('UPDATE members SET status = $status WHERE member_id = $id', { $status: status, $id: m.member_id })
      if (status !== 'active') {
        await tx.run('UPDATE report_tokens SET status = $revoked, revoked_at_ms = $now, version = version + 1 WHERE member_id = $id AND status = $active', { $revoked: 'revoked', $now: this.now(), $id: m.member_id, $active: 'active' })
        await tx.run('UPDATE login_accounts SET enabled = 0, password_version = password_version + 1, version = version + 1, updated_at_ms = $now WHERE member_id = $id', { $id: m.member_id, $now: this.now() })
        await this.revokeSessions(tx, m.member_id)
      }
      await this.touchMember(tx, m.member_id)
      return { ok: true as const, member: await this.member(tx, m.member_id) }
    })
  }
  private async revokeSessions(tx: PortalStore, id: string): Promise<void> {
    await tx.run('UPDATE auth_sessions SET revoked_at_ms = $now WHERE account_id IN (SELECT account_id FROM login_accounts WHERE member_id = $id) AND revoked_at_ms IS NULL', { $now: this.now(), $id: id })
  }
  async setLogin(actor: Principal, input: MutationInput) {
    const username = normalizeUsername(textField(input, 'username')), password = textField(input, 'password')
    const error = usernameError(username) ?? passwordError(password)
    if (error) throw new IdentityError(400, error)
    // KDF 前先挡无权请求，完成后在写事务内再查一次，不能复用此处结果。
    await this.authorize(actor, 'accounts:manage')
    const hash = await hashPassword(password)
    await this.afterPasswordHash?.()
    return this.mutate(actor, 'accounts:manage', 'account.set', 'member', idField(input, 'member_id'), async (tx, fresh) => {
      const m = await this.checkedMember(tx, input)
      subset(await this.rolePermissions(tx, m.member_id), fresh.permissions)
      const conflict = await tx.get<Row>('SELECT member_id FROM login_accounts WHERE username_normalized = $username', { $username: username })
      if (conflict && str(conflict, 'member_id') !== m.member_id) throw new IdentityError(409, '该用户名已被使用')
      const current = await tx.get<Row>('SELECT account_id FROM login_accounts WHERE member_id = $id', { $id: m.member_id })
      if (current) await tx.run('UPDATE login_accounts SET username_normalized = $username,password_hash = $hash,enabled = 1,password_version = password_version + 1,version = version + 1,updated_at_ms = $now WHERE member_id = $id', { $username: username, $hash: hash, $now: this.now(), $id: m.member_id })
      else await tx.run('INSERT INTO login_accounts (account_id,member_id,username_normalized,password_hash,created_at_ms,updated_at_ms) VALUES ($account,$member,$username,$hash,$now,$now)', { $account: randomUUID(), $member: m.member_id, $username: username, $hash: hash, $now: this.now() })
      await this.revokeSessions(tx, m.member_id)
      await this.touchMember(tx, m.member_id)
      return { ok: true as const, member: await this.member(tx, m.member_id) }
    })
  }
  async setLoginStatus(actor: Principal, input: MutationInput) {
    if (typeof input.enabled !== 'boolean') throw new IdentityError(400, 'enabled 需要是布尔值')
    return this.mutate(actor, 'accounts:manage', 'account.status', 'member', idField(input, 'member_id'), async (tx, fresh) => {
      const m = await this.checkedMember(tx, input)
      if (input.enabled) subset(await this.rolePermissions(tx, m.member_id), fresh.permissions)
      if (!await tx.get<Row>('SELECT account_id FROM login_accounts WHERE member_id = $id', { $id: m.member_id })) throw new IdentityError(404, '该成员尚未开通登录账号')
      await tx.run('UPDATE login_accounts SET enabled = $enabled,password_version = password_version + 1,version = version + 1,updated_at_ms = $now WHERE member_id = $id', { $enabled: input.enabled ? 1 : 0, $now: this.now(), $id: m.member_id })
      await this.revokeSessions(tx, m.member_id)
      await this.touchMember(tx, m.member_id)
      return { ok: true as const, member: await this.member(tx, m.member_id) }
    })
  }

  private async token(tx: PortalStore, id: string): Promise<PortalReportToken> {
    const r = await tx.get<Row>('SELECT * FROM report_tokens WHERE token_id = $id', { $id: id })
    if (!r) throw new IdentityError(404, '凭证不存在')
    return { token_id: id, member_id: str(r, 'member_id'), token_prefix: str(r, 'token_prefix'), label: str(r, 'label'), scopes: await this.tokenScopes(tx, id), status: str(r, 'status') as 'active' | 'revoked', version: num(r, 'version'), created_at_ms: num(r, 'created_at_ms'), expires_at_ms: r.expires_at_ms == null ? null : num(r, 'expires_at_ms'), revoked_at_ms: r.revoked_at_ms == null ? null : num(r, 'revoked_at_ms') }
  }
  private async scopes(tx: PortalStore, tokenId: string, codes: string[]): Promise<void> {
    await tx.run('DELETE FROM report_token_scopes WHERE token_id = $id', { $id: tokenId })
    for (const code of codes) {
      const p = await tx.get<Row>('SELECT permission_id FROM permissions WHERE code = $code', { $code: code })
      if (!p) throw new IdentityError(400, '未知权限范围')
      await tx.run('INSERT INTO report_token_scopes (token_id,permission_id) VALUES ($id,$permission)', { $id: tokenId, $permission: p.permission_id })
    }
  }
  private async insertToken(tx: PortalStore, memberId: string, secret: string, label: string, codes: string[], expires: number | null): Promise<PortalReportToken> {
    const id = randomUUID()
    await tx.run('INSERT INTO report_tokens (token_id,member_id,token_hash,token_prefix,label,created_at_ms,expires_at_ms) VALUES ($id,$member,$hash,$prefix,$label,$now,$expires)', { $id: id, $member: memberId, $hash: digest(secret), $prefix: '…' + digest(secret).slice(0, 12), $label: label, $now: this.now(), $expires: expires })
    await this.scopes(tx, id, codes)
    return this.token(tx, id)
  }
  private async grantScopes(tx: PortalStore, actor: Principal, memberId: string, codes: string[]): Promise<void> {
    const m = await this.member(tx, memberId)
    if (m.status !== 'active') throw new IdentityError(409, '停用人员不能签发或调整凭证')
    if (!codes.length) throw new IdentityError(400, '至少需要一个权限范围')
    subset(codes, actor.permissions)
    subset(codes, await this.rolePermissions(tx, memberId))
  }
  async listTokens(actor: Principal, memberId: string) {
    return this.securedRead(actor, 'tokens:manage', async (tx) => {
      await this.member(tx, memberId)
      const tokens: PortalReportToken[] = []
      for (const r of await tx.all<Row>('SELECT token_id FROM report_tokens WHERE member_id = $id ORDER BY created_at_ms,token_id', { $id: memberId })) tokens.push(await this.token(tx, str(r, 'token_id')))
      return { tokens }
    })
  }
  async issueToken(actor: Principal, input: MutationInput) {
    const memberId = idField(input, 'member_id'), label = displayName(textField(input, 'label'), 128)
    const codes = input.scopes === undefined ? DEFAULT_SCOPES : listField(input, 'scopes')
    const expires = input.expires_at_ms ?? null
    if (expires !== null && (!Number.isSafeInteger(expires) || Number(expires) <= this.now())) throw new IdentityError(400, '凭证有效期需要是未来时间')
    return this.mutate(actor, 'tokens:manage', 'token.issue', 'member', memberId, async (tx, fresh) => {
      await this.grantScopes(tx, fresh, memberId, codes)
      const secret = 'atr-' + randomSecret()
      return { ok: true as const, token: await this.insertToken(tx, memberId, secret, label, codes, expires as number | null), token_secret: secret }
    })
  }
  private async checkedToken(tx: PortalStore, input: MutationInput): Promise<PortalReportToken> {
    const t = await this.token(tx, idField(input, 'token_id'))
    if (t.member_id !== idField(input, 'member_id')) throw new IdentityError(404, '凭证不属于指定人员')
    this.checkVersion(input, t.version)
    if (t.status !== 'active') throw new IdentityError(409, '凭证已经吊销')
    return t
  }
  async rotateToken(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'tokens:manage', 'token.rotate', 'token', idField(input, 'token_id'), async (tx, fresh) => {
      const old = await this.checkedToken(tx, input)
      await this.grantScopes(tx, fresh, old.member_id, old.scopes)
      if (old.expires_at_ms !== null && old.expires_at_ms <= this.now()) throw new IdentityError(409, '凭证已经到期，请重新签发')
      await tx.run('UPDATE report_tokens SET status = $status,revoked_at_ms = $now,version = version + 1 WHERE token_id = $id', { $status: 'revoked', $now: this.now(), $id: old.token_id })
      const secret = 'atr-' + randomSecret()
      return { ok: true as const, token: await this.insertToken(tx, old.member_id, secret, old.label, old.scopes, old.expires_at_ms), token_secret: secret }
    })
  }
  async revokeToken(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'tokens:manage', 'token.revoke', 'token', idField(input, 'token_id'), async (tx) => {
      const t = await this.checkedToken(tx, input)
      await tx.run('UPDATE report_tokens SET status = $status,revoked_at_ms = $now,version = version + 1 WHERE token_id = $id', { $status: 'revoked', $now: this.now(), $id: t.token_id })
      return { ok: true as const, token: await this.token(tx, t.token_id) }
    })
  }
  async setTokenScopes(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'tokens:manage', 'token.scopes', 'token', idField(input, 'token_id'), async (tx, fresh) => {
      const t = await this.checkedToken(tx, input), codes = listField(input, 'scopes')
      await this.grantScopes(tx, fresh, t.member_id, codes)
      await this.scopes(tx, t.token_id, codes)
      await tx.run('UPDATE report_tokens SET version = version + 1 WHERE token_id = $id', { $id: t.token_id })
      return { ok: true as const, token: await this.token(tx, t.token_id) }
    })
  }
  private async department(tx: PortalStore, id: string): Promise<PortalDepartment> {
    const r = await tx.get<Row>('SELECT * FROM departments WHERE department_id = $id', { $id: id })
    if (!r) throw new IdentityError(404, '部门不存在')
    return { department_id: id, name: str(r, 'name'), status: str(r, 'status') as PortalDepartment['status'], version: num(r, 'version'), created_at_ms: num(r, 'created_at_ms'), updated_at_ms: num(r, 'updated_at_ms') }
  }
  async listDepartments(actor: Principal) {
    return this.securedRead(actor, 'departments:read', async (tx) => ({ departments: await Promise.all((await tx.all<Row>('SELECT department_id FROM departments ORDER BY name,department_id')).map((r) => this.department(tx, str(r, 'department_id')))) }))
  }
  async createDepartment(actor: Principal, input: MutationInput) {
    const id = randomUUID(), name = displayName(textField(input, 'name'), 64)
    return this.mutate(actor, 'departments:manage', 'department.create', 'department', id, async (tx) => {
      if (await tx.get<Row>('SELECT department_id FROM departments WHERE name = $name', { $name: name })) throw new IdentityError(409, '部门名称已存在')
      await tx.run('INSERT INTO departments (department_id,name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: id, $name: name, $now: this.now() })
      return { ok: true as const, department: await this.department(tx, id) }
    })
  }
  async updateDepartment(actor: Principal, input: MutationInput) {
    const id = idField(input, 'department_id'), name = displayName(textField(input, 'name'), 64)
    return this.mutate(actor, 'departments:manage', 'department.update', 'department', id, async (tx) => {
      const d = await this.department(tx, id); this.checkVersion(input, d.version)
      const conflict = await tx.get<Row>('SELECT department_id FROM departments WHERE name = $name', { $name: name })
      if (conflict && str(conflict, 'department_id') !== id) throw new IdentityError(409, '部门名称已存在')
      await tx.run('UPDATE departments SET name = $name,version = version + 1,updated_at_ms = $now WHERE department_id = $id', { $name: name, $now: this.now(), $id: id })
      return { ok: true as const, department: await this.department(tx, id) }
    })
  }
  async setDepartmentStatus(actor: Principal, input: MutationInput) {
    const id = idField(input, 'department_id'), status = textField(input, 'status')
    if (!['active', 'disabled'].includes(status)) throw new IdentityError(400, '部门状态无效')
    return this.mutate(actor, 'departments:manage', 'department.status', 'department', id, async (tx) => {
      this.checkVersion(input, (await this.department(tx, id)).version)
      await tx.run('UPDATE departments SET status = $status,version = version + 1,updated_at_ms = $now WHERE department_id = $id', { $status: status, $now: this.now(), $id: id })
      return { ok: true as const, department: await this.department(tx, id) }
    })
  }
  async listAudit(actor: Principal, input: MutationInput = {}): Promise<PortalAuditResponse> {
    const limit = input.limit === undefined ? 50 : Number(input.limit), offset = input.offset === undefined ? 0 : Number(input.offset)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new IdentityError(400, '分页参数无效')
    const clauses: string[] = [], params: Row = {}
    for (const key of ['from', 'to'] as const) {
      if (input[key] === undefined) continue
      const value = Number(input[key])
      if (!Number.isSafeInteger(value) || value < 0 || input[key] === '') throw new IdentityError(400, '审计时间需要是 epoch 毫秒整数')
      clauses.push(`occurred_at_ms ${key === 'from' ? '>=' : '<'} $${key}`)
      params['$' + key] = value
    }
    if (params.$from !== undefined && params.$to !== undefined && Number(params.$from) >= Number(params.$to)) throw new IdentityError(400, '审计起始时间必须早于结束时间')
    for (const key of ['target_type', 'action'] as const) {
      if (input[key] === undefined) continue
      const value = textField(input, key)
      if (!/^[a-z][a-z_.:-]{0,63}$/.test(value)) throw new IdentityError(400, `${key} 无效`)
      clauses.push(`${key} = $${key}`); params['$' + key] = value
    }
    if (input.target_id !== undefined) { clauses.push('target_id = $target_id'); params.$target_id = idField(input, 'target_id') }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    return this.securedRead(actor, 'audit:read', async (tx) => {
      const rows = await tx.all<Row>('SELECT * FROM admin_audit_log' + where + ' ORDER BY occurred_at_ms DESC,audit_id DESC LIMIT $limit OFFSET $offset', { ...params, $limit: limit, $offset: offset })
      return { rows: rows.map((r) => ({ audit_id: str(r, 'audit_id'), actor_member_id: r.actor_member_id == null ? null : str(r, 'actor_member_id'), action: str(r, 'action'), target_type: str(r, 'target_type'), target_id: r.target_id == null ? null : str(r, 'target_id'), result: str(r, 'result'), request_id: str(r, 'request_id'), metadata: (typeof r.metadata_json === 'string' ? JSON.parse(r.metadata_json) : r.metadata_json) as Row, created_at_ms: num(r, 'occurred_at_ms') })), total: num((await tx.get<Row>('SELECT COUNT(*) AS c FROM admin_audit_log' + where, params)) ?? {}, 'c'), limit, offset }
    })
  }
  private mapping(row: Row): PortalLegacyAttribution {
    return { mapping_id: str(row, 'mapping_id'), legacy_user_id: str(row, 'legacy_user_id'), member_id: row.member_id == null ? null : str(row, 'member_id'), status: str(row, 'status') as PortalLegacyAttribution['status'], source_import_ref: str(row, 'source_import_ref'), decision_reason: row.decision_reason == null ? null : str(row, 'decision_reason'), decided_at_ms: row.decided_at_ms == null ? null : num(row, 'decided_at_ms'), created_at_ms: num(row, 'created_at_ms') }
  }
  async listLegacyAttributions(actor: Principal) {
    return this.securedRead(actor, 'members:read', async (tx) => ({ mappings: (await tx.all<Row>('SELECT * FROM legacy_attribution_map ORDER BY legacy_user_id,mapping_id')).map((r) => this.mapping(r)) }))
  }
  async confirmLegacyAttribution(actor: Principal, input: MutationInput) {
    const id = idField(input, 'mapping_id'), memberId = idField(input, 'member_id')
    const source = textField(input, 'source_import_ref'), reason = displayName(textField(input, 'reason'), 512)
    if (input.expected_status !== 'pending') throw new IdentityError(400, '只能确认待确认的历史归属')
    return this.withWrite(actor, 'members:manage', async (tx, fresh) => {
      await this.member(tx, memberId)
      const row = await tx.get<Row>('SELECT * FROM legacy_attribution_map WHERE mapping_id = $id', { $id: id })
      if (!row) throw new IdentityError(404, '历史归属映射不存在')
      if (row.status !== 'pending' || row.source_import_ref !== source) throw new IdentityError(409, '历史映射状态或导入来源已变化，请刷新后核对', 'mapping_conflict')
      const result = await tx.run('UPDATE usage_event SET member_id = $member WHERE user_id = $legacy AND received_at_ms IS NULL AND member_id IS NULL', { $member: memberId, $legacy: row.legacy_user_id })
      await tx.run('UPDATE legacy_attribution_map SET member_id = $member,status = $mapped,decision_reason = $reason,decided_at_ms = $now,decided_by_member_id = $actor WHERE mapping_id = $id AND status = $pending', { $member: memberId, $mapped: 'mapped', $reason: reason, $now: this.now(), $actor: fresh.memberId, $id: id, $pending: 'pending' })
      await this.audit(tx, fresh, 'legacy.confirm', 'legacy_mapping', id, { member_id: memberId, legacy_user_id: row.legacy_user_id, source_import_ref: source, reason, updated_events: result.changes })
      await tx.run('UPDATE portal_identity_state SET revision = revision + 1,updated_at_ms = $now WHERE singleton_key = 1', { $now: this.now() })
      return { ok: true as const, mapping: this.mapping((await tx.get<Row>('SELECT * FROM legacy_attribution_map WHERE mapping_id = $id', { $id: id }))!), updated_events: result.changes }
    })
  }
}
export { IdentityRepository as DatabaseIdentityStore }
