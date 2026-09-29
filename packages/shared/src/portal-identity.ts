/**
 * 平台数据库身份契约。稳定人员 ID 与登录账号、上报凭证分离，
 * 普通响应只含凭证摘要提示，原始秘密仅出现在签发/轮换响应中。
 *
 * ★ **人员与分组是多对多**（`member_group_members`）：一个人可以同时属于
 *   多个分组，因此人员身上带的是 `groups` 数组而不是单个 ID。
 *   统计因而按「人员 → 分组」关联展开，一个事件会同时计入它的人员所属的每个分组。
 */

export type PortalMemberStatus = 'active' | 'disabled' | 'archived'
export type PortalGroupStatus = 'active' | 'disabled'
export type PortalAttributionStatus = 'member' | 'legacy' | 'unattributed'

export type PortalRoleStatus = 'active' | 'disabled'

/**
 * 角色 = 一组权限的命名集合。人员的权限是**他所持全部角色权限的并集**。
 *
 * ★ `code` 是稳定标识（建后不可改），`name` 才是可改的显示值：
 *   页面上的下拉、日志与审计都指 `role_id`，改个名字不该让它们失去指向。
 * ⚠️ `is_builtin` 为真时，权限定义与启停**不接受改写**（见服务端 `assertEditableRole`）：
 *   `admin` / `member` 既是缺省角色，也是兼容字段 `role: 'admin' | 'member'` 与
 *   「最后一个管理员」护栏的依托，允许改写等于把管理入口交给一次误操作。
 */
export interface PortalRole {
  role_id: string
  code: string
  name: string
  permissions: string[]
  is_builtin: boolean
  status: PortalRoleStatus
  version: number
}

/**
 * 权限目录里的一项。
 *
 * ★ 目录的**唯一真源是服务端 `permissions` 表**，随角色目录一起下发（同一读权限）。
 *   页面若自己硬编码一份可勾选清单，数据库里新增的权限就永远勾不上，
 *   而页面看起来「权限就这些」。
 */
export interface PortalPermission {
  code: string
  description: string
}

/** `GET /api/v1/admin/roles`：角色目录 + 可授予的权限目录，一次读全。 */
export interface PortalRoleListResponse {
  roles: PortalRole[]
  permissions: PortalPermission[]
}

/**
 * 新建角色。
 *
 * ⚠️ 新角色固定为**非内置**：内置标记只能由 schema seed 产生，
 *   若能从请求体给，页面就能造出一个「系统内置、不可修改」的角色。
 */
export interface PortalCreateRoleRequest {
  code: string
  name: string
  permission_codes: string[]
}

export interface PortalRoleVersionRequest {
  role_id: string
  expected_version: number
}

/**
 * 改角色名或权限。
 *
 * ⚠️ `permission_codes` 是**全量替换**而不是增量：给了它就是把该角色的权限集合
 *   设成这个列表。用增量语义的话，「取消掉最后一个权限」与「没动权限」
 *   在请求体里长得一模一样。
 */
export interface PortalRoleUpdateRequest extends PortalRoleVersionRequest {
  name?: string
  permission_codes?: string[]
}

export interface PortalRoleStatusRequest extends PortalRoleVersionRequest {
  status: PortalRoleStatus
}

export interface PortalGroup {
  group_id: string
  name: string
  status: PortalGroupStatus
  version: number
  created_at_ms: number
  updated_at_ms: number
}

/**
 * 人员所属分组的最小引用。
 *
 * ⚠️ 只带 ID 与名称，不带分组的版本号或启停状态：人员列表要的是「他属于哪些组」，
 *   把整份 `PortalGroup` 塞进来会让每次人员列表都顺带成为第二份分组目录读取口。
 */
export interface PortalMemberGroupRef {
  group_id: string
  name: string
}

export interface PortalMember {
  member_id: string
  name: string
  status: PortalMemberStatus
  /** 该人员当前所属的全部分组；多对多，空数组表示未分组。 */
  groups: PortalMemberGroupRef[]
  roles: PortalRole[]
  account: { username: string; enabled: boolean } | null
  active_token_count: number
  version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface PortalReportToken {
  token_id: string
  member_id: string
  token_prefix: string
  label: string
  scopes: string[]
  status: 'active' | 'revoked'
  version: number
  created_at_ms: number
  expires_at_ms: number | null
  revoked_at_ms: number | null
}

/**
 * ★ appKey（插件/CLI 上报凭证）的权限**只有这两个接口**。
 *
 * | scope | 对应接口 | 用途 |
 * |---|---|---|
 * | `usage:write` | `POST /api/v1/token-usage` | 上报用量 |
 * | `stats:read` | `GET /api/v1/stats/*` | 获取统计信息 |
 *
 * 🚨 **常量而不是 UI 选项**：签发端点按它写库，页面拿它展示。
 *   若把范围交给请求体，就等于「页面写对了才有权限限制」——
 *   一个改过的请求就能签出带 `members:manage` 的 appKey。
 *
 * ⚠️ 刻意**不含** `identity:read`：appKey 的用途就是上报与取数，
 *   而 `/api/v1/identity/verify` 的校验同时接受 `usage:write`
 *   （见服务端 `verifyIdentity`），所以插件只填 appKey 也能拿到自己的署名。
 */
export const APP_KEY_SCOPES = ['usage:write', 'stats:read'] as const

/** appKey 在凭证列表里的缺省用途标签。 */
export const APP_KEY_LABEL = '上报 appKey'

/**
 * appKey 列表里的「发给谁」。
 *
 * ⚠️ 只带列表要呈现的四个字段，不塞整份 `PortalMember` ——
 *   把角色、登录账号、版本号一并带出来，等于让「凭证列表」顺带变成
 *   第二份人员档案读取口，而它的权限只校验 `tokens:manage`。
 */
export interface PortalAppKeyOwner {
  member_id: string
  name: string
  status: PortalMemberStatus
  groups: PortalMemberGroupRef[]
}

/**
 * 一行一把 appKey：凭证本体 + 它发给了谁。
 *
 * ★ 归属由服务端按 `report_tokens.member_id` 关联人员表得出，
 *   不从客户端的任何自称字段推断（与上报落库同一条原则）。
 * ⚠️ 这里**不含明文** —— 库里只有摘要，明文仅随签发 / 轮换响应返回一次。
 */
export interface PortalAppKeyEntry {
  token: PortalReportToken
  member: PortalAppKeyOwner
}

/** `GET /api/v1/admin/appkeys` 的响应体。 */
export interface PortalAppKeyListResponse {
  appkeys: PortalAppKeyEntry[]
}

/**
 * 签发 appKey。
 *
 * ⚠️ **没有 `scopes` 字段** —— 范围由服务端固定为 `APP_KEY_SCOPES`，
 *   调用方无法申请更宽的权限（与 `PortalIssueTokenRequest` 刻意区分开）。
 */
export interface PortalIssueAppKeyRequest {
  member_id: string
  label?: string
  expires_at_ms?: number | null
}

export interface PortalMutationResult {
  ok: boolean
  reason?: string
  code?: string
}

export interface PortalMemberResult extends PortalMutationResult {
  member?: PortalMember
}

export interface PortalTokenResult extends PortalMutationResult {
  token?: PortalReportToken
  /** 仅本次签发/轮换响应携带；关闭展示后无法找回，只能再次轮换。 */
  token_secret?: string
}

export interface PortalGroupResult extends PortalMutationResult {
  group?: PortalGroup
}

export interface PortalRoleResult extends PortalMutationResult {
  role?: PortalRole
}

export interface PortalCreateMemberRequest {
  name: string
  /** 建人时同时挂上的分组；缺省为未分组。 */
  group_ids?: string[]
  role_ids: string[]
}

export interface PortalMemberVersionRequest {
  member_id: string
  expected_version: number
}

/**
 * 改人名或改分组归属。
 *
 * ⚠️ `group_ids` 是**全量替换**而不是增量：给了它就是把该人员的分组集合
 *   设成这个列表。用增量语义的话，「移除最后一个分组」与「没传这个字段」
 *   在请求体里长得一模一样。
 */
export interface PortalUpdateMemberRequest extends PortalMemberVersionRequest {
  name?: string
  group_ids?: string[]
}

export interface PortalMemberRolesRequest extends PortalMemberVersionRequest {
  role_ids: string[]
}

export interface PortalMemberStatusRequest extends PortalMemberVersionRequest {
  status: PortalMemberStatus
}

export interface PortalLoginAccountRequest extends PortalMemberVersionRequest {
  username: string
  password: string
}

export interface PortalLoginStatusRequest extends PortalMemberVersionRequest {
  enabled: boolean
}

export interface PortalIssueTokenRequest {
  member_id: string
  label: string
  scopes?: string[]
  expires_at_ms?: number | null
}

export interface PortalTokenVersionRequest {
  member_id: string
  token_id: string
  expected_version: number
}

export interface PortalTokenScopesRequest extends PortalTokenVersionRequest {
  scopes: string[]
}

/**
 * 改已有凭证的有效期。
 *
 * ★ `null` 表示**长期有效**，其余必须是未来时刻 —— 与签发
 *   （`expires_at_ms?`）共用同一条校验，所以「续期」和「改成会过期」
 *   是同一个动作：`null` ⇄ 具体时刻。
 * ⚠️ 刻意与 `PortalTokenScopesRequest` 并列，而不是合成一个「更新凭证」
 *   请求：合起来就会让「只想续期」的调用顺手带上 `scopes`，而改范围与
 *   服务端固定的 appKey 范围（`APP_KEY_SCOPES`）是两件事。
 */
export interface PortalTokenExpiryRequest extends PortalTokenVersionRequest {
  expires_at_ms: number | null
}

export interface PortalGroupVersionRequest {
  group_id: string
  expected_version: number
}

export interface PortalAuditEntry {
  audit_id: string
  actor_member_id: string | null
  action: string
  target_type: string
  target_id: string | null
  result: string
  request_id: string | null
  metadata: Record<string, unknown>
  created_at_ms: number
}

export interface PortalAuditResponse {
  rows: PortalAuditEntry[]
  total: number
  limit: number
  offset: number
}

export interface PortalStorageResponse {
  kind: 'sqlite' | 'mysql'
  schema_version: number
  available: boolean
  initialized: boolean
}

export interface PortalLegacyAttribution {
  mapping_id: string
  legacy_user_id: string
  member_id: string | null
  status: 'pending' | 'mapped' | 'ignored'
  source_import_ref: string
  decision_reason: string | null
  decided_at_ms: number | null
  created_at_ms: number
}

export interface PortalConfirmLegacyRequest {
  mapping_id: string
  member_id: string
  expected_status: 'pending'
  source_import_ref: string
  reason: string
}

export interface PortalLegacyResult extends PortalMutationResult {
  mapping?: PortalLegacyAttribution
  updated_events?: number
}
