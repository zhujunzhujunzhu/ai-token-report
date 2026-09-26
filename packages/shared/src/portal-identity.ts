/**
 * 部门平台数据库身份契约。稳定人员 ID 与登录账号、上报凭证分离，
 * 普通响应只含凭证摘要提示，原始秘密仅出现在签发/轮换响应中。
 */

export type PortalMemberStatus = 'active' | 'disabled' | 'archived'
export type PortalDepartmentStatus = 'active' | 'disabled'
export type PortalAttributionStatus = 'member' | 'legacy' | 'unattributed'

export interface PortalRole {
  role_id: string
  code: string
  name: string
  permissions: string[]
}

export interface PortalDepartment {
  department_id: string
  name: string
  status: PortalDepartmentStatus
  version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface PortalMember {
  member_id: string
  name: string
  status: PortalMemberStatus
  department_id: string | null
  department_name: string | null
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

export interface PortalDepartmentResult extends PortalMutationResult {
  department?: PortalDepartment
}

export interface PortalCreateMemberRequest {
  name: string
  department_id?: string | null
  role_ids: string[]
}

export interface PortalMemberVersionRequest {
  member_id: string
  expected_version: number
}

export interface PortalUpdateMemberRequest extends PortalMemberVersionRequest {
  name?: string
  department_id?: string | null
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

export interface PortalDepartmentVersionRequest {
  department_id: string
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
