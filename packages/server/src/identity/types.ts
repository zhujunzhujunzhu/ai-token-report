/** 服务端可信身份、业务错误与数据库边界校验，不向浏览器暴露秘密。 */
import type { PortalStore } from '@ai-token-report/core/db'

/** 只在服务端产生；认证记录 ID 允许事务内重验，不携带原始秘密。 */
export interface Principal {
  memberId: string
  name: string
  /**
   * 该身份当前所属的全部分组。
   *
   * ★ **多对多**：一个人可以同时在多个分组里，所以这里是数组而不是单个 ID
   *   （v5 起 `members.department_id` 已删除，归属只由
   *   `member_group_assignments` 承载）。未分组时是空数组。
   *
   * ⚠️ 两个字段都带上：`groupIds` 供按分组筛选/归属展开，`groupNames` 供展示，
   *   避免每个调用方各自 JOIN 一次（那会变成第二处「谁属于哪些组」的实现）。
   */
  groupIds: string[]
  groupNames: string[]
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
/**
 * 可授予的权限码目录（服务端侧的一份镜像）。
 *
 * ⚠️ 权限码**不做兼容别名**：v5 迁移原地改写了 `permissions.code`，
 *   库里只有 `groups:*`。同时保留两套写法会让「这个人到底有没有分组管理权」
 *   取决于哪一处代码在读，而两处都不会报错。
 */
export const PERMISSIONS = ['identity:read', 'usage:write', 'stats:read', 'members:read', 'members:manage', 'tokens:manage', 'accounts:manage', 'roles:read', 'roles:assign', 'audit:read', 'groups:read', 'groups:manage']
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
/**
 * 角色标识（`roles.code`）。
 *
 * ★ 建后不可改，所以格式必须在这里一次卡死：它会被写进审计与日志，
 *   将来若允许大写或中文，「同一个角色」在记录里就有两种写法。
 * ⚠️ 不复用 `displayName`：那是显示值，允许中文与空格，而这里要的是稳定标识。
 */
export function roleCode(raw: string): string {
  const value = raw.trim()
  if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(value)) throw new IdentityError(400, '角色标识需要以字母开头，只能使用小写字母、数字与 _ . : - ，长度不超过 64')
  return value
}
