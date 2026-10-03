/** 人员 / 分组身份的数据库真值；与用量写入共用连接、锁顺序和提交边界。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { openPortalStore, PORTAL_SCHEMA_VERSION, aliasNameError, providerNameError, modelNameError, ANY_PROVIDER, projectAliasNameError, projectPrefixError, normalizeProjectPrefix, type PortalProviderAlias, type PortalProjectAlias, type PortalStore, type PortalTarget } from '@ai-token-report/core/db'
import { hashPassword, normalizeUsername, passwordError, usernameError } from '../auth/password.js'
import type { CredentialInput } from '../credentials.js'
import { APP_KEY_LABEL, APP_KEY_SCOPES, BUILTIN_PRICES, findPriceConflicts, isAnyProvider, isValidPriceRates, normalizeCurrency, offpeakConfigError, MAX_MICRO_PER_KTOK, type ModelPrice, type PortalAppKeyEntry, type PortalAppKeyOwner, type PortalMember, type PortalMemberGroupRef, type PortalRole, type PortalGroup, type PortalReportToken, type PortalAuditResponse, type PortalStorageResponse, type PortalLegacyAttribution, type PortalModelPrice, type PriceRates } from '@ai-token-report/shared'
import { ADMIN_ROLE_ID, MEMBER_ROLE_ID, DEFAULT_SCOPES, RECOVERY_PERMISSIONS, PERMISSIONS, IdentityError, requirePermission, subset, str, num, textField, nullableTextField, idField, intField, nullableIntField, listField, displayName, roleCode, type Principal, type Row, type MutationInput } from './types.js'
// ★ 单价的两种行映射都在这个模块里（`repository.ts` 与 `stats-route.ts` 共用一份）。
import { modelPriceFromRow, priceShapeFromRow } from './model-price-row.js'

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export const randomSecret = (): string => randomBytes(32).toString('base64url')
export interface BootstrapOptions { adminToken?: string; adminName?: string; adminUsername?: string; adminPassword?: string }
export type LegacyCredentialInput = CredentialInput & { loginEnabled?: boolean }

/**
 * 把一个生效区间说成人话。
 *
 * ★ 只用于 **409 的提示文案**，不参与任何计算 —— 重叠判定完全由
 *   `shared/price.ts` 的 `findPriceConflicts()` 做。
 * ⚠️ 用 UTC 日期截断而不是本地时间：这里只是让人认出「是哪一条」，
 *   而本地时区在这里会引入第二个时间口径，提示里差一天反而更难找。
 */
const describePriceSpan = (price: ModelPrice): string =>
  `${price.currency} ${new Date(price.effectiveFromMs).toISOString().slice(0, 10)} ~ ${price.effectiveToMs === null ? '至今' : new Date(price.effectiveToMs).toISOString().slice(0, 10)}`

/**
 * 冲突提示里给这条价一个**能认出来**的名字。
 *
 * ★ 基础价（`'*'`）必须显式说成「不限供应商」，否则使用者看到的是
 *   `* / deepseek-flash …` —— 一个看起来像乱码、于是被当成「另一条无关的价」的东西，
 *   而它恰恰就是挡住这次保存的那条。
 */
const describePriceTarget = (price: ModelPrice): string =>
  `${isAnyProvider(price.provider) ? '不限供应商' : price.provider} / ${price.model}`

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
    // ★ 认的是「能署名的凭证」：`identity:read`（专门用来核对身份）
    //   或 `usage:write`（上报凭证 appKey）。
    //   ⚠️ 后者不是放宽边界：上报凭证按定义就是「以某人的名义写入用量」，
    //      而本接口是**纯查询**且只回调用者自己的姓名/部门 ——
    //      归属仍然只来自 token 在服务端的解析结果，客户端提交的姓名照旧被忽略。
    //      反面理由同样硬：appKey 刻意只有「上报 + 统计」两项接口权限
    //      （`APP_KEY_SCOPES`），若这里只认 `identity:read`，插件面板填完
    //      appKey 就永远拿不到自己的署名，用户看到的是「Key 无效」。
    const canVerify = p !== null && (p.permissions.includes('identity:read') || p.permissions.includes('usage:write'))
    if (!canVerify) return { ok: false, registered, reason: 'token 无效，请向管理员确认' }
    // ★ `dept` 是**刻意的兼容别名**（与 `group` 同值）：已部署的旧插件 / 旧 CLI
    //   读的是 `dept`，去掉它会让那些客户端把「服务端返回了署名但字段不认识」
    //   显示成「Key 无效」。新代码一律读 `group`。
    const group = p.groupNames[0]
    return { ok: true, registered, name: p.name, member_id: p.memberId, role: p.roleCodes.includes('admin') ? 'admin' as const : 'member' as const, ...(group ? { group, dept: group } : {}) }
  }
  async getViewer(actor: Principal) {
    return this.read(async (tx) => {
      const p = await this.reauthenticate(tx, actor)
      if (!p) throw new IdentityError(401, '登录已失效，请重新登录')
      const account = await tx.get<Row>('SELECT username_normalized FROM login_accounts WHERE member_id = $id', { $id: p.memberId })
      const roles = await this.memberRoles(tx, p.memberId)
      // ⚠️ `group` 是兼容别名（与第一个分组名同值），页面新代码读 `group_names`。
      return { member_id: p.memberId, name: p.name, username: account ? str(account, 'username_normalized') : '', role: p.roleCodes.includes('admin') ? 'admin' as const : 'member' as const, roles, permissions: p.permissions, group_ids: p.groupIds, group_names: p.groupNames, ...(p.groupNames[0] ? { group: p.groupNames[0] } : {}) }
    })
  }
  private async memberRoles(tx: PortalStore, memberId: string): Promise<PortalRole[]> {
    const rows = await tx.all<Row>('SELECT r.role_id,r.code,r.name,r.is_builtin,r.status,r.version FROM roles r JOIN member_roles mr ON mr.role_id = r.role_id WHERE mr.member_id = $id AND r.status = $status ORDER BY r.code', { $id: memberId, $status: 'active' })
    return Promise.all(rows.map((r) => this.roleView(tx, r)))
  }
  /**
   * 角色行 → 契约对象。
   *
   * ★ 人员身上的角色与角色目录共用这一个映射：两处各写一遍的结果是
   *   「列表里能看到内置标记，人员详情里看不到」，而页面会因此多出一个编辑入口。
   * ⚠️ 权限单独查一次，不用 `group_concat` 拼串 —— 拼接规则会变成第二处
   *   「权限怎么解析」的实现，而它在 SQLite 与 MySQL 上还不一样。
   */
  private async roleView(tx: PortalStore, row: Row): Promise<PortalRole> {
    const roleId = str(row, 'role_id')
    return {
      role_id: roleId, code: str(row, 'code'), name: str(row, 'name'),
      is_builtin: num(row, 'is_builtin') === 1,
      status: str(row, 'status') as PortalRole['status'],
      version: num(row, 'version'),
      permissions: await this.permissionsForRole(tx, roleId),
    }
  }
  private async rolePermissions(tx: PortalStore, memberId: string): Promise<string[]> {
    const rows = await tx.all<Row>('SELECT DISTINCT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.permission_id JOIN roles r ON r.role_id = rp.role_id JOIN member_roles mr ON mr.role_id = r.role_id WHERE mr.member_id = $id AND r.status = $status ORDER BY p.code', { $id: memberId, $status: 'active' })
    return rows.map((r) => str(r, 'code'))
  }
  /**
   * 查一个人当前所属的全部分组。
   *
   * ★ 归属的**唯一权威**是 `member_group_assignments`：
   *   `usage_event.group_name` 只是上报当时的文本快照，不能拿来判归属
   *   （人换了分组、改了名，快照都不会跟着变）。
   * ⚠️ 用 JOIN 一次取回 ID + 名称，按 name 排序：排序规则写在这里，
   *   列表与详情才不会是两种顺序。
   */
  private async memberGroups(tx: PortalStore, memberId: string): Promise<PortalMemberGroupRef[]> {
    const rows = await tx.all<Row>('SELECT g.group_id,g.name FROM member_group_assignments a JOIN member_groups g ON g.group_id = a.group_id WHERE a.member_id = $id ORDER BY g.name,g.group_id', { $id: memberId })
    return rows.map((r) => ({ group_id: str(r, 'group_id'), name: str(r, 'name') }))
  }
  /**
   * 批量查「哪些人属于哪些分组」，供**列表**场景使用。
   *
   * 🚨 必须批量：人员列表若逐人查一次，就是 N+1 条查询 ——
   *   50 个人 = 51 次库往返，而响应体里看不出任何异常，只表现为「页面慢」。
   * ⚠️ 结果按 member_id 归并，同一个人多条关联只出现一次（列表按 name 排序）。
   */
  private async memberGroupsByMember(tx: PortalStore, memberIds: string[]): Promise<Map<string, PortalMemberGroupRef[]>> {
    const grouped = new Map<string, PortalMemberGroupRef[]>()
    if (!memberIds.length) return grouped
    // 参数数量有上限（历史上 SQLite 是 999），分批查；一批 200 个 ID 足够且不会触碰任何后端上限。
    for (let i = 0; i < memberIds.length; i += 200) {
      const batch = memberIds.slice(i, i + 200)
      const params: Row = {}
      const placeholders = batch.map((id, index) => { params[`$m${index}`] = id; return `$m${index}` })
      const rows = await tx.all<Row>(
        `SELECT a.member_id,g.group_id,g.name FROM member_group_assignments a JOIN member_groups g ON g.group_id = a.group_id WHERE a.member_id IN (${placeholders.join(',')}) ORDER BY g.name,g.group_id`,
        params,
      )
      for (const r of rows) {
        const id = str(r, 'member_id')
        const list = grouped.get(id) ?? []
        list.push({ group_id: str(r, 'group_id'), name: str(r, 'name') })
        grouped.set(id, list)
      }
    }
    return grouped
  }
  private async principal(tx: PortalStore, memberId: string, auth: Principal['auth']): Promise<Principal | null> {
    const row = await tx.get<Row>('SELECT * FROM members WHERE member_id = $id AND status = $status', { $id: memberId, $status: 'active' })
    if (!row) return null
    const groups = await this.memberGroups(tx, memberId)
    return { memberId, name: str(row, 'display_name'), groupIds: groups.map((g) => g.group_id), groupNames: groups.map((g) => g.name), roleCodes: (await this.memberRoles(tx, memberId)).map((r) => r.code), permissions: await this.rolePermissions(tx, memberId), auth }
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
      if (e.group) displayName(e.group, 64)
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
        // ★ 一个人可以有多个分组，但凭证文件里只能写一个名字 ——
        //   这里按「名字 → 分组」逐个建关联（导入是显式离线动作，重复名字复用同一行）。
        let groupId: string | null = null
        if (entry.group?.trim()) {
          const name = displayName(entry.group, 64)
          const g = await tx.get<Row>('SELECT group_id FROM member_groups WHERE name = $name', { $name: name })
          groupId = g ? str(g, 'group_id') : randomUUID()
          if (!g) await tx.run('INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: groupId, $name: name, $now: now })
        }
        const memberId = randomUUID()
        await tx.run('INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: memberId, $name: displayName(entry.name), $now: now })
        // 归属写进关联表（权威），事件快照列不参与归属。
        if (groupId) await tx.run('INSERT INTO member_group_assignments (member_id,group_id,created_at_ms) VALUES ($member,$group,$now)', { $member: memberId, $group: groupId, $now: now })
        const admin = entry.role === 'admin'
        await tx.run('INSERT INTO member_roles (member_id,role_id,granted_at_ms) VALUES ($id,$role,$now)', { $id: memberId, $role: admin ? ADMIN_ROLE_ID : MEMBER_ROLE_ID, $now: now })
        if (admin && !firstAdmin) firstAdmin = memberId
        if (entry.username) await tx.run('INSERT INTO login_accounts (account_id,member_id,username_normalized,password_hash,enabled,created_at_ms,updated_at_ms) VALUES ($id,$member,$username,$hash,$enabled,$now,$now)', { $id: randomUUID(), $member: memberId, $username: normalizeUsername(entry.username), $hash: entry.passwordHash!, $enabled: entry.loginEnabled === false ? 0 : 1, $now: now })
        if (!accountOnlyBootstrap) await this.insertToken(tx, memberId, entry.token.trim(), '迁移凭证', admin ? PERMISSIONS : ['identity:read', 'usage:write', 'stats:read', 'groups:read'], null)
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
  /**
   * 人员行 → 契约对象。
   *
   * ★ `groups` 可以由调用方**预先批量查好**传进来（列表场景），缺省才单人查一次。
   *   这就是「列表不要 N+1」的落点：查询规则只有这一份，批量与单查的结果必然一致。
   */
  private async member(tx: PortalStore, id: string, groups?: PortalMemberGroupRef[]): Promise<PortalMember> {
    const r = await tx.get<Row>('SELECT * FROM members WHERE member_id = $id', { $id: id })
    if (!r) throw new IdentityError(404, '人员不存在')
    const a = await tx.get<Row>('SELECT username_normalized,enabled FROM login_accounts WHERE member_id = $id', { $id: id })
    const count = await tx.get<Row>('SELECT COUNT(*) AS c FROM report_tokens WHERE member_id = $id AND status = $active AND (expires_at_ms IS NULL OR expires_at_ms > $now)', { $id: id, $active: 'active', $now: this.now() })
    return { member_id: id, name: str(r, 'display_name'), status: str(r, 'status') as PortalMember['status'], groups: groups ?? await this.memberGroups(tx, id), roles: await this.memberRoles(tx, id), account: a ? { username: str(a, 'username_normalized'), enabled: num(a, 'enabled') === 1 } : null, active_token_count: num(count ?? {}, 'c'), version: num(r, 'version'), created_at_ms: num(r, 'created_at_ms'), updated_at_ms: num(r, 'updated_at_ms') }
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
    return this.securedRead(actor, 'members:read', async (tx) => ({ kind: tx.kind, schema_version: PORTAL_SCHEMA_VERSION, available: true, initialized: (await tx.get<Row>('SELECT initialized_at_ms FROM portal_identity_state WHERE singleton_key = 1'))?.initialized_at_ms != null }))
  }
  async listMembers(actor: Principal) {
    return this.securedRead(actor, 'members:read', async (tx) => {
      const rows = await tx.all<Row>('SELECT member_id FROM members ORDER BY display_name,member_id')
      // ★ 分组一次批量查完再在内存里归并（见 memberGroupsByMember 的注释）。
      const groupsByMember = await this.memberGroupsByMember(tx, rows.map((r) => str(r, 'member_id')))
      const members: PortalMember[] = []
      for (const row of rows) {
        const id = str(row, 'member_id')
        members.push(await this.member(tx, id, groupsByMember.get(id) ?? []))
      }
      return { members }
    })
  }
  /**
   * ★ 角色目录 + 权限目录（角色管理页的唯一读取口）。
   *
   * ⚠️ **包含已停用角色**：页面要能看见并重新启用它们；若这里过滤掉，
   *   停用就变成「角色凭空消失」，管理员再也找不到它。
   *   代价是「分配角色」的下拉必须自己按 `status === 'active'` 过滤 ——
   *   服务端 `setRoleRows` 会拒绝停用角色，所以那只是把必然失败藏起来。
   * ★ 权限目录随角色一起下发：勾选清单必须来自 `permissions` 表，
   *   页面自己写一份就会漏掉数据库里真实存在的权限，而它看起来「就这些」。
   */
  async listRoles(actor: Principal) {
    return this.securedRead(actor, 'roles:read', async (tx) => ({
      roles: await Promise.all((await tx.all<Row>('SELECT role_id,code,name,is_builtin,status,version FROM roles ORDER BY is_builtin DESC,code')).map((r) => this.roleView(tx, r))),
      permissions: (await tx.all<Row>('SELECT code,description FROM permissions ORDER BY code')).map((r) => ({ code: str(r, 'code'), description: str(r, 'description') })),
    }))
  }
  private async role(tx: PortalStore, id: string): Promise<PortalRole> {
    const row = await tx.get<Row>('SELECT role_id,code,name,is_builtin,status,version FROM roles WHERE role_id = $id', { $id: id })
    if (!row) throw new IdentityError(404, '角色不存在')
    return this.roleView(tx, row)
  }
  /**
   * 🚨 内置角色（`admin` / `member`）不接受任何改写。
   *
   *   理由不是「保守」：`admin` 是兼容字段 `role: 'admin' | 'member'` 的来源，
   *   也是 `RECOVERY_PERMISSIONS` 与「最后一个管理员」护栏所依托的恒满角色。
   *   一旦它可被改写，一次误操作就能把整套管理权限删干净 ——
   *   而那时**没有任何界面还能把它改回来**。
   */
  private assertEditableRole(role: PortalRole): void {
    if (role.is_builtin) throw new IdentityError(409, '系统内置角色由服务端维护，不能改名、改权限或停用', 'builtin_role')
  }
  /**
   * 整组替换角色的权限集合。
   *
   * ★ 两道约束缺一不可：权限码必须真实存在（否则写进 `role_permissions` 的
   *   外键会失败，错误信息还看不出是哪个码），且**必须是操作者本次有效权限的子集**
   *   —— 否则一枚只有 `roles:assign` 的窄凭证就能给自己造一个高权限角色。
   */
  private async setRolePermissions(tx: PortalStore, actor: Principal, roleId: string, codes: string[]): Promise<void> {
    // ⚠️ 先查存在性、再查子集：未知权限码对**任何人**都不在自己权限里，
    //   若先查子集，使用者看到的是「超出你本次身份权限」，而真正的原因是「这个码不存在」。
    const permissionIds: string[] = []
    // 去重：`role_permissions` 主键是 (role_id, permission_id)，重复码会在写库时炸成 500。
    for (const code of [...new Set(codes)]) {
      const row = await tx.get<Row>('SELECT permission_id FROM permissions WHERE code = $code', { $code: code })
      if (!row) throw new IdentityError(400, `未知权限：${code}`)
      permissionIds.push(str(row, 'permission_id'))
    }
    subset(codes, actor.permissions)
    await tx.run('DELETE FROM role_permissions WHERE role_id = $id', { $id: roleId })
    for (const permissionId of permissionIds) await tx.run('INSERT INTO role_permissions (role_id,permission_id) VALUES ($id,$permission)', { $id: roleId, $permission: permissionId })
  }
  async createRole(actor: Principal, input: MutationInput) {
    const code = roleCode(textField(input, 'code')), name = displayName(textField(input, 'name'), 128)
    const codes = listField(input, 'permission_codes'), id = randomUUID()
    return this.mutate(actor, 'roles:assign', 'role.create', 'role', id, async (tx, fresh) => {
      if (await tx.get<Row>('SELECT role_id FROM roles WHERE code = $code', { $code: code })) throw new IdentityError(409, '角色标识已存在，请换一个')
      const now = this.now()
      // ★ 固定 is_builtin = 0：内置标记只能由 schema seed 产生。
      //   若它来自请求体，页面就能造出一个「系统内置、谁都改不动」的角色。
      await tx.run('INSERT INTO roles (role_id,code,name,is_builtin,status,version,created_at_ms,updated_at_ms) VALUES ($id,$code,$name,0,$status,1,$now,$now)', { $id: id, $code: code, $name: name, $status: 'active', $now: now })
      await this.setRolePermissions(tx, fresh, id, codes)
      return { ok: true as const, role: await this.role(tx, id) }
    })
  }
  async updateRole(actor: Principal, input: MutationInput) {
    const roleId = idField(input, 'role_id')
    return this.mutate(actor, 'roles:assign', 'role.update', 'role', roleId, async (tx, fresh) => {
      const current = await this.role(tx, roleId)
      this.assertEditableRole(current)
      this.checkVersion(input, current.version)
      const name = input.name === undefined ? current.name : displayName(textField(input, 'name'), 128)
      await tx.run('UPDATE roles SET name = $name,version = version + 1,updated_at_ms = $now WHERE role_id = $id', { $name: name, $now: this.now(), $id: current.role_id })
      if (input.permission_codes !== undefined) await this.setRolePermissions(tx, fresh, current.role_id, listField(input, 'permission_codes'))
      return { ok: true as const, role: await this.role(tx, current.role_id) }
    })
  }
  /**
   * 停用 / 启用角色。
   *
   * ★ 这里只做软删除（`status`）：`member_roles` 与 `role_permissions` 都是
   *   RESTRICT 外键，物理删除本来就会被数据库拒绝，而硬删还会抹掉
   *   「这个人曾经是什么角色」的历史。
   * 🚨 停用前必须确认没有在职成员还持有它：`setRoleRows` 只挡得住**分配那一刻**，
   *   停用发生在它之后，于是会出现「零角色人员」—— 他能登录，却什么权限都没有，
   *   而页面上看不出原因。
   */
  async setRoleStatus(actor: Principal, input: MutationInput) {
    const status = textField(input, 'status')
    if (!['active', 'disabled'].includes(status)) throw new IdentityError(400, '角色状态无效')
    const roleId = idField(input, 'role_id')
    return this.mutate(actor, 'roles:assign', 'role.status', 'role', roleId, async (tx) => {
      const current = await this.role(tx, roleId)
      this.assertEditableRole(current)
      this.checkVersion(input, current.version)
      if (status === 'disabled') {
        const used = await tx.get<Row>("SELECT COUNT(*) AS c FROM member_roles mr JOIN members m ON m.member_id = mr.member_id WHERE mr.role_id = $id AND m.status = 'active'", { $id: current.role_id })
        if (num(used ?? {}, 'c') > 0) throw new IdentityError(409, `仍有 ${num(used ?? {}, 'c')} 名在职成员使用该角色，请先为他们调整角色`)
      }
      await tx.run('UPDATE roles SET status = $status,version = version + 1,updated_at_ms = $now WHERE role_id = $id', { $status: status, $now: this.now(), $id: current.role_id })
      return { ok: true as const, role: await this.role(tx, current.role_id) }
    })
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
  /**
   * 校验并归一化请求体里的 `group_ids`。
   *
   * ## 🚨 `undefined` 与 `[]` 必须分开
   *
   * - `undefined` = 「本次请求**不动**分组」
   * - `[]` = 「**清空**分组」
   *
   * 两者若归一成同一个值，页面上「只改姓名」会静默把人的分组清空 ——
   * 而响应看起来完全成功（`member.groups` 变成 `[]`），没人会发现。
   *
   * ⚠️ 多对多是**全量替换**语义：给了列表就是把关联集合设成它，
   *   没有「追加 / 移除某一个」的增量语义（增量与「没给全」在请求体里长得一样）。
   * ⚠️ 不存在或已停用的分组直接 400：静默丢掉非法 ID 会让调用方
   *   以为「挂上了」，而人员列表里那行永远是空的。
   */
  private async groupIds(tx: PortalStore, input: MutationInput): Promise<string[] | undefined> {
    if (input.group_ids === undefined) return undefined
    const ids = listField(input, 'group_ids')
    for (const id of ids) {
      const row = await tx.get<Row>('SELECT group_id FROM member_groups WHERE group_id = $id AND status = $active', { $id: id, $active: 'active' })
      if (!row) throw new IdentityError(400, '分组不存在或已停用')
    }
    return ids
  }
  /**
   * 整组替换某人的分组关联（差异增删，不整表删除再重建）。
   *
   * ★ 只删「不在新列表里」的、只插「原来没有的」：整删整插会把未变动的
   *   `created_at_ms` 全部刷新成现在，让「他什么时候进这个组的」永久失真。
   */
  private async setMemberGroups(tx: PortalStore, memberId: string, groupIds: string[]): Promise<void> {
    const now = this.now()
    const current = (await tx.all<Row>('SELECT group_id FROM member_group_assignments WHERE member_id = $id', { $id: memberId })).map((r) => str(r, 'group_id'))
    const existing = new Set(current), wanted = new Set(groupIds)
    for (const id of current) if (!wanted.has(id)) await tx.run('DELETE FROM member_group_assignments WHERE member_id = $member AND group_id = $group', { $member: memberId, $group: id })
    for (const id of groupIds) if (!existing.has(id)) await tx.run('INSERT INTO member_group_assignments (member_id,group_id,created_at_ms) VALUES ($member,$group,$now)', { $member: memberId, $group: id, $now: now })
  }
  async createMember(actor: Principal, input: MutationInput) {
    const name = displayName(textField(input, 'name')), roles = listField(input, 'role_ids'), id = randomUUID()
    return this.mutate(actor, 'members:manage', 'member.create', 'member', id, async (tx, fresh) => {
      // 建人时不给分组就是「未分组」——不是错误，页面允许先建人不分组。
      const groups = await this.groupIds(tx, input) ?? [], now = this.now()
      await tx.run('INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: id, $name: name, $now: now })
      await this.setMemberGroups(tx, id, groups)
      await this.setRoleRows(tx, fresh, id, roles)
      return { ok: true as const, member: await this.member(tx, id) }
    })
  }
  async updateMember(actor: Principal, input: MutationInput) {
    return this.mutate(actor, 'members:manage', 'member.update', 'member', idField(input, 'member_id'), async (tx) => {
      const m = await this.checkedMember(tx, input)
      // 先校验再写：非法 group_ids 不该在执行到一半时才失败（虽然事务会回滚）。
      const groups = await this.groupIds(tx, input)
      const name = input.name === undefined ? m.name : displayName(textField(input, 'name'))
      await tx.run('UPDATE members SET display_name = $name WHERE member_id = $id', { $name: name, $id: m.member_id })
      if (groups !== undefined) await this.setMemberGroups(tx, m.member_id, groups)
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
    // ⚠️ 存的是**裸摘要前缀**（12 位十六进制），刻意不带「…」：
    //   「这串被截断了」是展示提示，由页面按中间省略号渲染
    //   （`web-portal/src/utils/credential.ts` 的 `tokenHint`）。
    //   把展示符号写进库，等于让「列表里那一列长什么样」变成一次存储决定，
    //   以后改版还得迁移数据。历史行里带 `…` 的旧格式由展示层先剥掉再重排。
    await tx.run('INSERT INTO report_tokens (token_id,member_id,token_hash,token_prefix,label,created_at_ms,expires_at_ms) VALUES ($id,$member,$hash,$prefix,$label,$now,$expires)', { $id: id, $member: memberId, $hash: digest(secret), $prefix: digest(secret).slice(0, 12), $label: label, $now: this.now(), $expires: expires })
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

  /**
   * ★ 列出全部上报凭证 —— appKey 管理页的主体列表。
   *
   * 页面要回答的第一个问题是「这把 key 发给了谁」，而归属只能来自
   * `report_tokens.member_id` 这条数据库关系：`label` 是自由文本，
   * 人员改名也不该让历史凭证失去归属。
   *
   * ⚠️ 权限用 `tokens:manage` 而不是 `members:read`：响应体里带
   *   `token_prefix` 与 `scopes`，属于凭证管理面。能读人员名单的人
   *   未必该看到谁手里有哪些凭证（人员页已不再展示凭证）。
   */
  async listAppKeys(actor: Principal) {
    return this.securedRead(actor, 'tokens:manage', async (tx) => {
      const rows = await tx.all<Row>(
        'SELECT t.token_id,m.member_id,m.display_name,m.status AS member_status FROM report_tokens t JOIN members m ON m.member_id = t.member_id ORDER BY t.created_at_ms DESC,t.token_id',
      )
      // ★ 归属按人员批量查出（同一人可能持多把 key，去重后只查一次）。
      const groupsByMember = await this.memberGroupsByMember(tx, [...new Set(rows.map((row) => str(row, 'member_id')))])
      const appkeys: PortalAppKeyEntry[] = []
      for (const row of rows) {
        const owner: PortalAppKeyOwner = {
          member_id: str(row, 'member_id'),
          name: str(row, 'display_name'),
          status: str(row, 'member_status') as PortalAppKeyOwner['status'],
          groups: groupsByMember.get(str(row, 'member_id')) ?? [],
        }
        appkeys.push({ token: await this.token(tx, str(row, 'token_id')), member: owner })
      }
      return { appkeys }
    })
  }

  async issueToken(actor: Principal, input: MutationInput) {
    const memberId = idField(input, 'member_id'), label = displayName(textField(input, 'label'), 128)
    const codes = input.scopes === undefined ? DEFAULT_SCOPES : listField(input, 'scopes')
    const expires = input.expires_at_ms ?? null
    return this.issueWithScopes(actor, 'token.issue', memberId, label, codes, expires as number | null)
  }

  /**
   * ★ 签发 appKey —— 供插件 / CLI 上报用的窄凭证。
   *
   * 🚨 **权限范围由服务端固定为 `APP_KEY_SCOPES`（上报 + 获取统计）**，
   *   不从请求体读。若照 `issueToken` 那样接受 `scopes`，那么「页面上只能选两项」
   *   就只是 UI 约定：一个手工请求就能签出带 `members:manage` 的 appKey，
   *   而它在列表里长得和正常的 appKey 一模一样。
   */
  async issueAppKey(actor: Principal, input: MutationInput) {
    const memberId = idField(input, 'member_id')
    const label = input.label === undefined ? APP_KEY_LABEL : displayName(textField(input, 'label'), 128)
    const expires = input.expires_at_ms ?? null
    return this.issueWithScopes(actor, 'appkey.issue', memberId, label, [...APP_KEY_SCOPES], expires as number | null)
  }

  /** 签发共同路径：有效期校验 → 重鉴权与授权 → 写库 → 一次性返回明文。 */
  private async issueWithScopes(actor: Principal, action: string, memberId: string, label: string, codes: string[], expires: number | null) {
    if (expires !== null && (!Number.isSafeInteger(expires) || Number(expires) <= this.now())) throw new IdentityError(400, '凭证有效期需要是未来时间')
    return this.mutate(actor, 'tokens:manage', action, 'member', memberId, async (tx, fresh) => {
      await this.grantScopes(tx, fresh, memberId, codes)
      const secret = 'atr-' + randomSecret()
      return { ok: true as const, token: await this.insertToken(tx, memberId, secret, label, codes, expires), token_secret: secret }
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
  /**
   * ★ 改已有凭证的有效期（`null` = 长期有效）。
   *
   * 与签发共用同一条校验：**只能是未来时刻或长期有效**。不能把有效期设成
   * 过去，否则「设一个过去的时间」就成了另一种形式的吊销 —— 而吊销有它
   * 自己的动作、审计与护栏（到期不是吊销，历史用量也照旧保留）。
   * 表上本来也有 `CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms)`：
   * 「已过期」只能是时间往前走出来的结果，改不出来。
   *
   * ⚠️ `expires_at_ms` **必须显式给**（可以是 `null`）。缺字段按「没说要改成
   *   什么」拒绝，而不是当成「清空到期时间」—— 后者会把一把短效 key 悄悄
   *   变成长效 key，而调用方以为自己只是发了个不完整的请求。
   *
   * ⚠️ `checkedToken` 只拒已吊销的凭证，到期只是时间比较，所以**过期 key
   *   可以在这里续期**（这正是页面要「修改有效期」的原因之一）。
   * ⚠️ 最后管理入口护栏照常生效：`mutate` 提交前会重算可恢复管理员，
   *   把唯一那把长期管理凭证改成会过期会被 409 挡下并整体回滚。
   */
  async setTokenExpiry(actor: Principal, input: MutationInput) {
    if (!('expires_at_ms' in input)) throw new IdentityError(400, '缺少 expires_at_ms，无法判断是长期有效还是具体到期时间')
    const raw = input.expires_at_ms
    const expires = raw === null ? null : Number(raw)
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= this.now())) throw new IdentityError(400, '凭证有效期需要是未来时间')
    return this.mutate(actor, 'tokens:manage', 'token.expiry', 'token', idField(input, 'token_id'), async (tx) => {
      const t = await this.checkedToken(tx, input)
      await tx.run('UPDATE report_tokens SET expires_at_ms = $expires,version = version + 1 WHERE token_id = $id', { $expires: expires, $id: t.token_id })
      return { ok: true as const, token: await this.token(tx, t.token_id) }
    })
  }
  /**
   * ★ 物理删除一把凭证 —— **仅限从未被引用过**的凭证。
   *
   * 与「吊销」是两件事：吊销保留整行（`status = 'revoked'`），历史用量仍指向它，
   * 页面照旧看得到「谁被吊销过」；删除让这一行彻底消失，只留一条 `token.delete` 审计。
   * 所以它回答的是「这把 key 发错了、从没被用过，把它清掉」，而不是「让它失效」——
   * 后者任何情况下都该用吊销。
   *
   * 🚨 引用者不是「顺带检查」，而是**库层面删不掉**：`usage_event.report_token_id`
   *   与 `admin_audit_log.actor_token_id` 都是 RESTRICT 外键，硬删会让历史用量失去
   *   归属、让审计指向空号。所以这里先查引用再决定，把「删不掉」变成一条说明原因的
   *   409，而不是等数据库抛一句外键约束错误（那句话在 SQLite 与 MySQL 上还不一样，
   *   页面只会渲染成没有内容的「操作失败」）。
   *
   * ⚠️ 已**吊销**或已**到期**的凭证照旧可删：发错之后先吊销、再清掉这一行是最常见的
   *   顺序，所以这里不用 `checkedToken`（它会以「凭证已经吊销」拒掉吊销后的行）。
   * ⚠️ 操作者正在使用的那把凭证不能删：本事务随后要写的审计行指向 `actor_token_id`，
   *   而它同样是 RESTRICT —— 删了自曝身份，整笔事务会在最后一步才失败。
   * ⚠️ 最后管理入口护栏照常生效（`mutate` 提交前重算可恢复管理员），但它排在上面两条
   *   引用检查**之后**：唯一那把长期管理凭证通常正是刚刚签发过东西的那把，于是先看到的
   *   是「已经执行过管理操作」。两条都不是误报，只是谁先说话。
   */
  async deleteToken(actor: Principal, input: MutationInput) {
    const tokenId = idField(input, 'token_id'), memberId = idField(input, 'member_id')
    if (actor.auth.kind === 'token' && actor.auth.tokenId === tokenId) {
      throw new IdentityError(409, '不能删除当前正在使用的凭证，请换一个管理身份，或先吊销它')
    }
    return this.mutate(actor, 'tokens:manage', 'token.delete', 'token', tokenId, async (tx) => {
      const t = await this.token(tx, tokenId)
      if (t.member_id !== memberId) throw new IdentityError(404, '凭证不属于指定人员')
      this.checkVersion(input, t.version)
      const reported = num((await tx.get<Row>('SELECT COUNT(*) AS c FROM usage_event WHERE report_token_id = $id', { $id: tokenId })) ?? {}, 'c')
      if (reported > 0) throw new IdentityError(409, `这把凭证已经上报过 ${reported} 条用量，删除会让这些记录失去归属；请改用「吊销」`, 'token_referenced')
      const acted = num((await tx.get<Row>('SELECT COUNT(*) AS c FROM admin_audit_log WHERE actor_token_id = $id', { $id: tokenId })) ?? {}, 'c')
      if (acted > 0) throw new IdentityError(409, `这把凭证执行过 ${acted} 次管理操作，审计需要保留指向；请改用「吊销」`, 'token_referenced')
      // 先删范围行：`report_token_scopes.token_id` 也是 RESTRICT，不先删就删不掉本体。
      await tx.run('DELETE FROM report_token_scopes WHERE token_id = $id', { $id: tokenId })
      await tx.run('DELETE FROM report_tokens WHERE token_id = $id', { $id: tokenId })
      return { ok: true as const }
    })
  }
  private async group(tx: PortalStore, id: string): Promise<PortalGroup> {
    const r = await tx.get<Row>('SELECT * FROM member_groups WHERE group_id = $id', { $id: id })
    if (!r) throw new IdentityError(404, '分组不存在')
    return { group_id: id, name: str(r, 'name'), status: str(r, 'status') as PortalGroup['status'], version: num(r, 'version'), created_at_ms: num(r, 'created_at_ms'), updated_at_ms: num(r, 'updated_at_ms') }
  }
  async listGroups(actor: Principal) {
    return this.securedRead(actor, 'groups:read', async (tx) => ({ groups: await Promise.all((await tx.all<Row>('SELECT group_id FROM member_groups ORDER BY name,group_id')).map((r) => this.group(tx, str(r, 'group_id')))) }))
  }
  async createGroup(actor: Principal, input: MutationInput) {
    const id = randomUUID(), name = displayName(textField(input, 'name'), 64)
    return this.mutate(actor, 'groups:manage', 'group.create', 'group', id, async (tx) => {
      if (await tx.get<Row>('SELECT group_id FROM member_groups WHERE name = $name', { $name: name })) throw new IdentityError(409, '分组名称已存在')
      await tx.run('INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,$name,$now,$now)', { $id: id, $name: name, $now: this.now() })
      return { ok: true as const, group: await this.group(tx, id) }
    })
  }
  async updateGroup(actor: Principal, input: MutationInput) {
    const id = idField(input, 'group_id'), name = displayName(textField(input, 'name'), 64)
    return this.mutate(actor, 'groups:manage', 'group.update', 'group', id, async (tx) => {
      const g = await this.group(tx, id); this.checkVersion(input, g.version)
      const conflict = await tx.get<Row>('SELECT group_id FROM member_groups WHERE name = $name', { $name: name })
      if (conflict && str(conflict, 'group_id') !== id) throw new IdentityError(409, '分组名称已存在')
      await tx.run('UPDATE member_groups SET name = $name,version = version + 1,updated_at_ms = $now WHERE group_id = $id', { $name: name, $now: this.now(), $id: id })
      return { ok: true as const, group: await this.group(tx, id) }
    })
  }
  /**
   * 停用 / 启用分组。
   *
   * ⚠️ **不解除人员关联**：停用是「不再往这里挂新人」，
   *   不是「把这些人移出去」。关联一旦被删，历史按分组筛选的结果会
   *   立刻变化 —— 那是数据被改写，而不是一次启停。
   */
  async setGroupStatus(actor: Principal, input: MutationInput) {
    const id = idField(input, 'group_id'), status = textField(input, 'status')
    if (!['active', 'disabled'].includes(status)) throw new IdentityError(400, '分组状态无效')
    return this.mutate(actor, 'groups:manage', 'group.status', 'group', id, async (tx) => {
      this.checkVersion(input, (await this.group(tx, id)).version)
      await tx.run('UPDATE member_groups SET status = $status,version = version + 1,updated_at_ms = $now WHERE group_id = $id', { $status: status, $now: this.now(), $id: id })
      return { ok: true as const, group: await this.group(tx, id) }
    })
  }
  /**
   * 供应商归一化规则（`provider_alias`）—— 列表。
   *
   * ★ 权限是 `providers:read`：看板本身不读管理接口（它走 `stats:read` 的
   *   `loadProviderAliases()`），所以「能看数据」与「能看规则目录」是两件事。
   *   `member_name` 顺带 JOIN 出来，免得页面为了显示一个归属人再调一次人员接口。
   */
  async listProviderAliases(actor: Principal) {
    return this.securedRead(actor, 'providers:read', async (tx) => ({
      aliases: (await tx.all<Row>(
        `SELECT a.*, m.display_name AS member_name
           FROM provider_alias a LEFT JOIN members m ON m.member_id = a.member_id
          ORDER BY a.scope, m.display_name, a.provider`,
      )).map((row) => this.providerAlias(row)),
    }))
  }

  private providerAlias(row: Row): PortalProviderAlias {
    const scope = str(row, 'scope') === 'member' ? 'member' as const : 'global' as const
    return {
      alias_id: str(row, 'alias_id'),
      scope,
      member_id: row.member_id == null ? null : str(row, 'member_id'),
      member_name: row.member_name == null ? null : str(row, 'member_name'),
      provider: str(row, 'provider'),
      alias: str(row, 'alias'),
      enabled: num(row, 'enabled') === 1,
      created_at_ms: num(row, 'created_at_ms'),
      updated_at_ms: num(row, 'updated_at_ms'),
    }
  }

  /**
   * 新建或修改一条归一化规则。
   *
   * ★ **upsert 语义**：`(scope, member_id, provider)` 就是这条规则的业务主键，
   *   页面上「把 dashscope 改成 bailian-tpp」是一次设置，不是一次「查了再改」。
   *   让调用方自己拿 alias_id 来更新，会把「我看到的规则已经被别人删了」
   *   这种事变成一次报错，而对一个展示口径的配置来说，
   *   重新设置一遍就是使用者本来想做的事。
   *
   * 🚨 **同一原始名 + 同一作用域只能有一条规则**：两个目标会让
   *   `CASE` 的命中结果取决于分支顺序 —— 一个「同样输入、不同结果」的配置。
   *   MySQL 的 `(member_id, provider)` 唯一索引会挡住它，
   *   SQLite 允许多条 NULL，所以两种后端都在这里显式查重
   *   （见 `assertAliasFree()`），不能只靠索引。
   */
  async setProviderAlias(actor: Principal, input: MutationInput) {
    const scope = textField(input, 'scope')
    if (scope !== 'global' && scope !== 'member') throw new IdentityError(400, '作用域只支持 global 或 member')
    const provider = textField(input, 'provider')
    const providerReason = providerNameError(provider)
    if (providerReason) throw new IdentityError(400, `原始供应商名无效：${providerReason}`)
    const alias = textField(input, 'alias')
    // ★ 展示名与原始名用**两套**校验：展示名允许中文（`dashscope` → `阿里百炼`
    //   显然比 `bailian-tpp` 更好读），原始名必须与上报值逐字一致，所以只收 ASCII。
    const aliasReason = aliasNameError(alias)
    if (aliasReason) throw new IdentityError(400, `归一化名无效：${aliasReason}`)
    const memberId = scope === 'member' ? idField(input, 'member_id') : null
    const inputEnabled = input.enabled === undefined ? true : input.enabled
    if (typeof inputEnabled !== 'boolean') throw new IdentityError(400, 'enabled 需要是布尔值')

    return this.mutate(actor, 'providers:manage', 'provider_alias.set', 'provider_alias', null, async (tx) => {
      if (memberId) {
        // 人员必须真实存在：外键在两种后端上都会拦，但拦下来的报错是驱动原文，
        // 使用者看到的应该是「人员不存在」。
        const exists = await tx.get<Row>('SELECT member_id FROM members WHERE member_id = $id', { $id: memberId })
        if (!exists) throw new IdentityError(404, '人员不存在')
      }
      const existing = await this.findProviderAlias(tx, memberId, provider)
      if (existing) {
        await tx.run('UPDATE provider_alias SET alias = $alias,enabled = $enabled,updated_at_ms = $now WHERE alias_id = $id', {
          $alias: alias, $enabled: inputEnabled ? 1 : 0, $now: this.now(), $id: str(existing, 'alias_id'),
        })
        return { ok: true as const, alias: await this.providerAliasById(tx, str(existing, 'alias_id')) }
      }
      const id = randomUUID()
      await tx.run('INSERT INTO provider_alias (alias_id,scope,member_id,provider,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,$scope,$member,$provider,$alias,$enabled,$now,$now)', {
        $id: id, $scope: scope, $member: memberId, $provider: provider, $alias: alias, $enabled: inputEnabled ? 1 : 0, $now: this.now(),
      })
      return { ok: true as const, alias: await this.providerAliasById(tx, id) }
    })
  }

  /** 删除一条规则（按 `alias_id`）。删除后该 provider 立刻回到原值。 */
  async deleteProviderAlias(actor: Principal, input: MutationInput) {
    const id = idField(input, 'alias_id')
    return this.mutate(actor, 'providers:manage', 'provider_alias.delete', 'provider_alias', id, async (tx) => {
      const row = await tx.get<Row>('SELECT alias_id FROM provider_alias WHERE alias_id = $id', { $id: id })
      if (!row) throw new IdentityError(404, '规则不存在')
      await tx.run('DELETE FROM provider_alias WHERE alias_id = $id', { $id: id })
      return { ok: true as const, deleted: id }
    })
  }

  /**
   * 启用 / 停用一条规则。
   *
   * ⚠️ 停用**不等于**「映射到原名」：停用后这条 provider 回到**未配置**状态，
   *   也就是显示上报原值。与 `setGroupStatus` 里「停用不解除人员关联」
   *   是同一类取舍 —— 停用是「不再应用这条口径」，不是改写数据。
   */
  async setProviderAliasStatus(actor: Principal, input: MutationInput) {
    const id = idField(input, 'alias_id'), enabled = input.enabled
    if (typeof enabled !== 'boolean') throw new IdentityError(400, 'enabled 需要是布尔值')
    return this.mutate(actor, 'providers:manage', 'provider_alias.status', 'provider_alias', id, async (tx) => {
      const row = await tx.get<Row>('SELECT alias_id FROM provider_alias WHERE alias_id = $id', { $id: id })
      if (!row) throw new IdentityError(404, '规则不存在')
      await tx.run('UPDATE provider_alias SET enabled = $enabled,updated_at_ms = $now WHERE alias_id = $id', { $enabled: enabled ? 1 : 0, $now: this.now(), $id: id })
      return { ok: true as const, alias: await this.providerAliasById(tx, id) }
    })
  }

  /**
   * 按 `(member_id, provider)` 查一条规则；全局限定 `member_id IS NULL`。
   *
   * ⚠️ 必须带 `ORDER BY`：唯一索引只对**整行非 NULL** 的组合去重，
   *   `(NULL, provider)` 在 SQLite 与 MySQL 上都能插进两行（实测见
   *   `verify-database-design.ts`），所以「同一原始名只有一条全局规则」
   *   是**这道应用层查重**在保证，而不是数据库。真出现重复行时，
   *   不带排序的 `get()` 会让每一次「改这条规则」随机命中其中一行 ——
   *   取最早的一条，至少让结果是确定的（`provider-alias.ts` 读取侧同款）。
   */
  private async findProviderAlias(tx: PortalStore, memberId: string | null, provider: string): Promise<Row | null> {
    return memberId
      ? await tx.get<Row>('SELECT alias_id FROM provider_alias WHERE member_id = $member AND provider = $provider ORDER BY created_at_ms, alias_id LIMIT 1', { $member: memberId, $provider: provider })
      : await tx.get<Row>('SELECT alias_id FROM provider_alias WHERE member_id IS NULL AND provider = $provider ORDER BY created_at_ms, alias_id LIMIT 1', { $provider: provider })
  }

  private async providerAliasById(tx: PortalStore, id: string): Promise<PortalProviderAlias> {
    const row = await tx.get<Row>(
      `SELECT a.*, m.display_name AS member_name
         FROM provider_alias a LEFT JOIN members m ON m.member_id = a.member_id
        WHERE a.alias_id = $id`, { $id: id },
    )
    if (!row) throw new IdentityError(404, '规则不存在')
    return this.providerAlias(row)
  }

  /**
   * 模型单价（`model_price`）—— 列表。
   *
   * ★ 权限是 `pricing:manage`：单价直接决定每一笔费用怎么算，它是**配置**，
   *   不是「看一眼的数字」。所以「费用可见」（`cost:read`）与「单价可看可改」
   *   是两件事 —— 能看金额的人不必能改计价，而改计价的人本来就看得见金额。
   * ⚠️ 排序按 `(provider, model, effective_from_ms)`：页面正是按这个顺序
   *   分组渲染（供应商 → 模型 → 历任价格）。乱序会让「同一模型的历史价」
   *   在表格里跳来跳去，而使用者只会以为自己在看不同的模型。
   */
  async listModelPrices(actor: Principal) {
    return this.securedRead(actor, 'pricing:manage', async (tx) => ({
      prices: (await tx.all<Row>('SELECT * FROM model_price ORDER BY provider, model, effective_from_ms, price_id')).map(modelPriceFromRow),
    }))
  }

  private async modelPriceById(tx: PortalStore, id: string): Promise<PortalModelPrice> {
    const row = await tx.get<Row>('SELECT * FROM model_price WHERE price_id = $id', { $id: id })
    if (!row) throw new IdentityError(404, '单价不存在')
    return modelPriceFromRow(row)
  }

  /**
   * 新建或修改一条单价。
   *
   * ★ **upsert 语义**：`(provider, model, effective_from_ms)` 就是业务主键 ——
   *   页面上「把这个模型从今天起的价改成 X」是一次设置，不是「查了再改」。
   *   要求调用方先拿到 `price_id` 再更新，会把「我看到的价已经被别人改了」
   *   变成一次报错，而对一份计价配置来说，重新设置一遍正是使用者想做的事
   *   （与 `setProviderAlias` 同一取舍）。
   * 🚨 **区间重叠必须在这里拒掉**：库里那条 UNIQUE 索引只认**完全相同**的
   *   `effective_from_ms`，拦不住 `[1, 100]` 与 `[50, 200]` 这种重叠。
   *   重叠的后果不是报错，而是**结果取决于读取顺序** ——
   *   同一段时间的用量有时按这个价、有时按那个价，且两次查询都能自圆其说。
   *   所以这里显式查重并回 `409`，并把撞上的区间一并说清楚（使用者才知道去改哪条）。
   */
  async setModelPrice(actor: Principal, input: MutationInput) {
    const provider = textField(input, 'provider')
    // ★ `'*'` 是**保留值**（不限供应商的基础价）：它刻意不满足供应商名的字符集
    //   （那条规则要求以字母 / 数字开头结尾），所以要在这里放行 ——
    //   界面上的「基础价」选项写的就是它。
    if (!isAnyProvider(provider)) {
      const providerReason = providerNameError(provider)
      if (providerReason) throw new IdentityError(400, `供应商名无效：${providerReason}`)
    }
    // ⚠️ 模型名**不复用** `providerNameError`：模型 ID 里带 `/` 是常态
    //   （网关前缀），而那条规则恰好禁止 `/`。形状校验在 zod 层，这里只兜长度与首尾空格。
    const model = textField(input, 'model')
    if (!model.trim() || model !== model.trim() || model.length > 255) throw new IdentityError(400, '模型名需要为 1～255 个字符且首尾不能是空格')
    const currency = normalizeCurrency(input.currency)
    if (!currency) throw new IdentityError(400, '币种需要是三位大写字母的 ISO 4217 代码（如 USD、CNY）')
    const rates = {
      inputMicroPerKtok: intField(input, 'input_micro_per_ktok'),
      outputMicroPerKtok: intField(input, 'output_micro_per_ktok'),
      cacheReadMicroPerKtok: intField(input, 'cache_read_micro_per_ktok'),
      cacheWriteMicroPerKtok: intField(input, 'cache_write_micro_per_ktok'),
    }
    if (!isValidPriceRates(rates)) throw new IdentityError(400, `四类单价都必须是 0 到 ${MAX_MICRO_PER_KTOK} 之间的整数微元/千 token`)
    const effectiveFromMs = intField(input, 'effective_from_ms')
    const effectiveToMs = nullableIntField(input, 'effective_to_ms')
    if (effectiveToMs !== null && effectiveToMs < effectiveFromMs) throw new IdentityError(400, '生效终点不能早于生效起点')
    const note = input.note == null ? null : (typeof input.note === 'string' ? input.note.trim().slice(0, 255) || null : (() => { throw new IdentityError(400, '备注需要是字符串') })())
    /**
     * v10 闲时档：**五个字段同进同出**（时段表 + 四类单价）。
     *
     * 🚨 校验落在 `shared/price.ts` 的 `offpeakConfigError()` —— 管理页提交前调的是
     *   同一个函数。各写一份的话，「页面放行、接口拒绝」或者更糟的
     *   「两边都放行、库里存了一行永远不生效的闲时价」都会出现。
     */
    const offpeakRates = {
      inputMicroPerKtok: nullableIntField(input, 'offpeak_input_micro_per_ktok'),
      outputMicroPerKtok: nullableIntField(input, 'offpeak_output_micro_per_ktok'),
      cacheReadMicroPerKtok: nullableIntField(input, 'offpeak_cache_read_micro_per_ktok'),
      cacheWriteMicroPerKtok: nullableIntField(input, 'offpeak_cache_write_micro_per_ktok'),
    }
    const offpeakAllNull = Object.values(offpeakRates).every((value) => value === null)
    const offpeakAnyNull = Object.values(offpeakRates).some((value) => value === null)
    if (!offpeakAllNull && offpeakAnyNull) throw new IdentityError(400, '闲时四类单价要一起填：缺一个就会有一档按 0 元算')
    const offpeakSchedule = input.offpeak_schedule == null || input.offpeak_schedule === ''
      ? null
      : input.offpeak_schedule
    if (offpeakSchedule !== null && typeof offpeakSchedule !== 'string') throw new IdentityError(400, '闲时时段表 id 需要是字符串')
    const offpeakRatesOrNull: PriceRates | null = offpeakAllNull ? null : (offpeakRates as PriceRates)
    const offpeakReason = offpeakConfigError({ offpeakRates: offpeakRatesOrNull, offpeakSchedule })
    if (offpeakReason) throw new IdentityError(400, offpeakReason)

    return this.mutate(actor, 'pricing:manage', 'model_price.set', 'model_price', null, async (tx) => {
      /**
       * ⚠️ 这里取的是**同一个模型的全部价行**（不再只是同一供应商）：
       *   基础价（`'*'`）与同名的专属价互相冲突是 `findPriceConflicts()` 的判定，
       *   而它需要看到两侧的行。查询放宽的代价可以忽略（单价只有几十行），
       *   漏看的代价是「两行覆盖同一时刻」—— 那是重复计价。
       */
      const rows = await tx.all<Row>('SELECT * FROM model_price WHERE model = $model ORDER BY effective_from_ms, price_id', { $model: model })
      // ⚠️ 自身那条要先摘掉 —— 它是这次要改的行，不是「冲突」。
      //   业务主键是 `(provider, model, effective_from_ms)`，所以按起点排除时要**同时**
      //   比供应商：放宽查询之后，另一个供应商在同一个起点上的价会跟着被误摘掉。
      const candidate: ModelPrice = {
        provider, model, currency, ...rates, effectiveFromMs, effectiveToMs,
        offpeakRates: offpeakRatesOrNull, offpeakSchedule: offpeakRatesOrNull === null ? null : offpeakSchedule,
      }
      const clashes = findPriceConflicts(
        rows.filter((row) => !(num(row, 'effective_from_ms') === effectiveFromMs && str(row, 'provider') === provider)).map((row) => priceShapeFromRow(row)),
        candidate,
      )
      if (clashes.length > 0) {
        throw new IdentityError(409, `这个生效区间与已有的 ${clashes.length} 条单价重叠：${clashes.map((row) => `${describePriceTarget(row)}（${describePriceSpan(row)}）`).join('、')}。请先改掉那条的生效终点，或把这次的起点挪到它之后`)
      }
      const existing = rows.find((row) => num(row, 'effective_from_ms') === effectiveFromMs && str(row, 'provider') === provider)
      const values = {
        $currency: currency,
        $input: rates.inputMicroPerKtok,
        $output: rates.outputMicroPerKtok,
        $cacheRead: rates.cacheReadMicroPerKtok,
        $cacheWrite: rates.cacheWriteMicroPerKtok,
        $opSchedule: candidate.offpeakSchedule,
        $opInput: offpeakRatesOrNull?.inputMicroPerKtok ?? null,
        $opOutput: offpeakRatesOrNull?.outputMicroPerKtok ?? null,
        $opCacheRead: offpeakRatesOrNull?.cacheReadMicroPerKtok ?? null,
        $opCacheWrite: offpeakRatesOrNull?.cacheWriteMicroPerKtok ?? null,
        $to: effectiveToMs, $note: note, $now: this.now(),
      }
      if (existing) {
        await tx.run(
          `UPDATE model_price SET currency = $currency,
             input_micro_per_ktok = $input,output_micro_per_ktok = $output,
             cache_read_micro_per_ktok = $cacheRead,cache_write_micro_per_ktok = $cacheWrite,
             offpeak_schedule = $opSchedule,
             offpeak_input_micro_per_ktok = $opInput,offpeak_output_micro_per_ktok = $opOutput,
             offpeak_cache_read_micro_per_ktok = $opCacheRead,offpeak_cache_write_micro_per_ktok = $opCacheWrite,
             effective_to_ms = $to,note = $note,updated_at_ms = $now WHERE price_id = $id`,
          { ...values, $id: str(existing, 'price_id') },
        )
        return { ok: true as const, price: await this.modelPriceById(tx, str(existing, 'price_id')) }
      }
      const id = randomUUID()
      await tx.run(
        `INSERT INTO model_price (price_id,provider,model,currency,input_micro_per_ktok,output_micro_per_ktok,
           cache_read_micro_per_ktok,cache_write_micro_per_ktok,offpeak_schedule,
           offpeak_input_micro_per_ktok,offpeak_output_micro_per_ktok,
           offpeak_cache_read_micro_per_ktok,offpeak_cache_write_micro_per_ktok,
           effective_from_ms,effective_to_ms,note,created_at_ms,updated_at_ms)
         VALUES ($id,$provider,$model,$currency,$input,$output,$cacheRead,$cacheWrite,$opSchedule,
           $opInput,$opOutput,$opCacheRead,$opCacheWrite,$from,$to,$note,$now,$now)`,
        { ...values, $id: id, $provider: provider, $model: model, $from: effectiveFromMs },
      )
      return { ok: true as const, price: await this.modelPriceById(tx, id) }
    })
  }

  /**
   * 删除一条单价（按 `price_id`）。
   *
   * ⚠️ 删除**不改写任何历史用量**，但会改变历史费用的算法：那条区间里的用量
   *   从此变成「无价」而不是「不要钱」（见 `shared/price.ts` 的 `unpricedRate`）。
   *   页面必须把这件事说清楚 —— 「删掉一条价」看起来像省事，
   *   实际效果是那段区间的金额从「有数」变成「未计价」。
   */
  async deleteModelPrice(actor: Principal, input: MutationInput) {
    const id = idField(input, 'price_id')
    return this.mutate(actor, 'pricing:manage', 'model_price.delete', 'model_price', id, async (tx) => {
      const row = await tx.get<Row>('SELECT price_id FROM model_price WHERE price_id = $id', { $id: id })
      if (!row) throw new IdentityError(404, '单价不存在')
      await tx.run('DELETE FROM model_price WHERE price_id = $id', { $id: id })
      return { ok: true as const, deleted: id }
    })
  }

  /**
   * 用内置种子价初始化单价表。
   *
   * ★ **只在表为空时放行**：它存在的意义是「刚部署完、一条价都没有」那一步。
   *   允许它对非空表执行，等于把「覆盖我调好的价」做成一个按钮 ——
   *   而使用者点它的时候，多半以为自己在做别的事。
   * 🚨 种子价是**内置常量**（`BUILTIN_PRICES`），不是抓来的现价：
   *   它只是让人不必从零开始填，**必须逐条核对后再用**。
   *   这也是「自建计价永远不等于财务账单」那条的第一道提醒。
   */
  async seedModelPrices(actor: Principal, input: MutationInput) {
    if (input.confirm !== true) throw new IdentityError(400, '需要显式确认（confirm: true）才能写入种子价')
    return this.mutate(actor, 'pricing:manage', 'model_price.seed', 'model_price', null, async (tx) => {
      const existing = num((await tx.get<Row>('SELECT COUNT(*) AS c FROM model_price')) ?? {}, 'c')
      if (existing > 0) throw new IdentityError(409, `单价表里已经有 ${existing} 条，不能再用种子价初始化；请逐条修改或删除后再试`)
      const now = this.now()
      for (const price of BUILTIN_PRICES) {
        // ★ 闲时档（v10）也一起落库：内置种子价里带了官方空闲档（高峰价的一半），
        //   不写就等于把「官方两档价」静默降级成单一价 —— 空闲时段的费用会虚高一倍。
        const offpeak = price.offpeakRates ?? null
        await tx.run(
          `INSERT INTO model_price (price_id,provider,model,currency,input_micro_per_ktok,output_micro_per_ktok,
             cache_read_micro_per_ktok,cache_write_micro_per_ktok,offpeak_schedule,
             offpeak_input_micro_per_ktok,offpeak_output_micro_per_ktok,
             offpeak_cache_read_micro_per_ktok,offpeak_cache_write_micro_per_ktok,
             effective_from_ms,effective_to_ms,note,created_at_ms,updated_at_ms)
           VALUES ($id,$provider,$model,$currency,$input,$output,$cacheRead,$cacheWrite,$opSchedule,
             $opInput,$opOutput,$opCacheRead,$opCacheWrite,$from,$to,$note,$now,$now)`,
          {
            $id: randomUUID(), $provider: price.provider, $model: price.model, $currency: price.currency,
            $input: price.inputMicroPerKtok, $output: price.outputMicroPerKtok,
            $cacheRead: price.cacheReadMicroPerKtok, $cacheWrite: price.cacheWriteMicroPerKtok,
            $opSchedule: offpeak === null ? null : (price.offpeakSchedule ?? null),
            $opInput: offpeak?.inputMicroPerKtok ?? null, $opOutput: offpeak?.outputMicroPerKtok ?? null,
            $opCacheRead: offpeak?.cacheReadMicroPerKtok ?? null, $opCacheWrite: offpeak?.cacheWriteMicroPerKtok ?? null,
            $from: price.effectiveFromMs, $to: price.effectiveToMs,
            // ⚠️ 给种子行打上来源标记：页面要能一眼分出「内置种子价」与「人工调过的价」，
            //   否则使用者会把一屏没核对过的数字当成已经确认过的计价。
            //   `ModelPrice` 本身没有 `note` 字段（那是库里的列，不是计价形状的一部分），
            //   所以这里写死一句固定说明。
            $note: '内置种子价，请核对后再用', $now: now,
          },
        )
      }
      return { ok: true as const, prices: (await tx.all<Row>('SELECT * FROM model_price ORDER BY provider, model, effective_from_ms')).map(modelPriceFromRow) }
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
