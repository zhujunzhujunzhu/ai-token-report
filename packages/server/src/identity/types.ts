/** 服务端可信身份、业务错误与数据库边界校验，不向浏览器暴露秘密。 */
import type { PortalStore } from '@ai-token-report/core/db'

/** 只在服务端产生；认证记录 ID 允许事务内重验，不携带原始秘密。 */
export interface Principal {
  memberId: string
  name: string
  departmentId: string | null
  dept?: string
  roleCodes: string[]
  permissions: string[]
  auth: { kind: 'session'; sessionId: string; accountId: string } | { kind: 'token'; tokenId: string }
}
export class IdentityError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message)
    this.name = 'IdentityError'
  }
}
export type Row = Record<string, unknown>
export type MutationInput = Record<string, unknown>
export type IdentityTransaction = PortalStore
export const ADMIN_ROLE_ID = '00000000-0000-4000-8000-000000000001'
export const MEMBER_ROLE_ID = '00000000-0000-4000-8000-000000000002'
export const DEFAULT_SCOPES = ['identity:read', 'usage:write']
export const RECOVERY_PERMISSIONS = ['members:read', 'members:manage', 'tokens:manage', 'accounts:manage', 'roles:read', 'roles:assign']
export const PERMISSIONS = ['identity:read', 'usage:write', 'stats:read', 'members:read', 'members:manage', 'tokens:manage', 'accounts:manage', 'roles:read', 'roles:assign', 'audit:read', 'departments:read', 'departments:manage']
export const str = (r: Row, k: string): string => String(r[k] ?? '')
export const num = (r: Row, k: string): number => Number(r[k] ?? 0)
export function requirePermission(p: Principal, permission: string): void {
  if (!p.permissions.includes(permission)) throw new IdentityError(403, '当前身份没有执行此操作的权限')
}
export function subset(wanted: string[], available: string[]): void {
  if (wanted.some((code) => !available.includes(code))) throw new IdentityError(403, '不能授予超出本次身份权限的能力')
}
export function textField(input: MutationInput, key: string): string {
  if (typeof input[key] !== 'string') throw new IdentityError(400, `${key} 需要是字符串`)
  return input[key] as string
}
export function idField(input: MutationInput, key: string): string {
  const value = textField(input, key)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new IdentityError(400, `${key} 需要是有效 ID`)
  return value
}
export function listField(input: MutationInput, key: string): string[] {
  const value = input[key]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new IdentityError(400, `${key} 需要是字符串数组`)
  return [...new Set(value as string[])]
}
export function displayName(raw: string, limit = 32): string {
  const value = raw.trim()
  if (!value || value.length > limit || /[\r\n\t]/.test(raw)) throw new IdentityError(400, `名称需要为 1～${limit} 个字符，不能包含换行或制表符`)
  return value
}
