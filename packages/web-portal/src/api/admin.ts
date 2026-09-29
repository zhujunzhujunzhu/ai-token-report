/** 数据库人员管理客户端。对象 ID 定位、版本防覆盖，秘密只随签发响应返回。 */
import type {
  PortalMember, PortalGroup, PortalReportToken, PortalStorageResponse,
  PortalAuditResponse, PortalCreateMemberRequest, PortalUpdateMemberRequest, PortalMemberRolesRequest,
  PortalMemberStatusRequest, PortalLoginAccountRequest, PortalLoginStatusRequest,
  PortalIssueTokenRequest, PortalTokenVersionRequest, PortalTokenScopesRequest, PortalTokenExpiryRequest,
  PortalIssueAppKeyRequest, PortalAppKeyListResponse,
  PortalMemberResult, PortalTokenResult, PortalGroupResult, PortalGroupVersionRequest,
  PortalRoleListResponse, PortalCreateRoleRequest, PortalRoleUpdateRequest,
  PortalRoleStatusRequest, PortalRoleResult,
  PortalLegacyAttribution, PortalConfirmLegacyRequest, PortalLegacyResult,
} from '@ai-token-report/shared'
import { post, request } from './request.js'

const root = '/api/v1/admin'
const members = root + '/members'
export const fetchMembers = () => request<{ members: PortalMember[] }>(members)
/**
 * ★ 角色目录 + 权限目录一次读全。
 *
 * ⚠️ 权限勾选清单必须来自这里的 `permissions`（服务端 `permissions` 表），
 *   页面自己硬编码一份就会漏掉数据库里真实存在的权限，而它看起来「就这些」。
 */
export const fetchRoles = () => request<PortalRoleListResponse>(root + '/roles')
/**
 * 角色定义管理（新建 / 改名改权限 / 启停）。
 *
 * ★ 与 `updateRoles`（给人分配角色）是两件事：那个改的是 `member_roles`，
 *   这三个改的是 `roles` 与 `role_permissions`。命名上刻意区分开。
 */
export const createRole = (input: PortalCreateRoleRequest) => post<PortalRoleResult>(root + '/roles', input)
export const updateRole = (input: PortalRoleUpdateRequest) => post<PortalRoleResult>(root + '/roles/update', input)
export const updateRoleStatus = (input: PortalRoleStatusRequest) => post<PortalRoleResult>(root + '/roles/status', input)
/**
 * 分组目录。
 *
 * ⚠️ 这是**管理**目录（`groups:read` / `groups:manage`）：人员页与分组管理页
 *   用它渲染可选项。看板侧的筛选项与分组排行候选项走
 *   `GET /api/v1/stats/groups`（`stats:read`）—— 能看数据的人不一定有分组管理权限，
 *   多读一个管理接口就多一处 403。见 `portal.ts` 的 `fetchGroups`。
 */
export const fetchGroups = () => request<{ groups: PortalGroup[] }>('/api/v1/groups')
export const fetchStorage = () => request<PortalStorageResponse>(root + '/storage')
export const fetchAudit = () => request<PortalAuditResponse>(root + '/audit?limit=30')
export const fetchLegacyAttributions = () => request<{ mappings: PortalLegacyAttribution[] }>(root + '/legacy-attributions')
export const confirmLegacyAttribution = (input: PortalConfirmLegacyRequest) => post<PortalLegacyResult>(root + '/legacy-attributions/confirm', input)
/**
 * 某位成员的凭证列表。
 *
 * ⚠️ 人员页已不再调用它（凭证统一在 appKey 管理页呈现），但服务端端点仍在
 *   且被 `e2e-admin.ts` 覆盖 —— 保留这层映射，让「把凭证视图放回人员页」
 *   只需改页面，而不必重新推导请求形状。
 */
export const fetchTokens = (memberId: string) => request<{ tokens: PortalReportToken[] }>(
  members + '/tokens?' + new URLSearchParams({ member_id: memberId }),
)
/**
 * 列出全部 appKey。
 *
 * ★ 与 `fetchTokens(memberId)` 的分工：那个是「某个人有哪些凭证」，
 *   这个是 appKey 管理页的主体列表 —— 每行一把 key，并带出它发给了谁。
 * ⚠️ 需要 `tokens:manage`：响应体含凭证提示与权限范围，不是人员名单的附属信息。
 */
export const fetchAppKeys = () => request<PortalAppKeyListResponse>(root + '/appkeys')
export const issueMember = (input: PortalCreateMemberRequest) => post<PortalMemberResult>(members, input)
export const updateMember = (input: PortalUpdateMemberRequest) => post<PortalMemberResult>(members + '/update', input)
export const updateRoles = (input: PortalMemberRolesRequest) => post<PortalMemberResult>(members + '/roles', input)
export const updateMemberStatus = (input: PortalMemberStatusRequest) => post<PortalMemberResult>(members + '/status', input)
export const setLoginAccount = (input: PortalLoginAccountRequest) => post<PortalMemberResult>(members + '/login', input)
export const setLoginStatus = (input: PortalLoginStatusRequest) => post<PortalMemberResult>(members + '/login/status', input)
/**
 * 签发通用上报 Token（自选权限范围）。
 *
 * ⚠️ 页面入口已移除：appKey 页只用范围固定的 `issueAppKey`。函数保留的理由
 *   同 `fetchTokens` —— 服务端端点仍然存在，删掉它只剩「下次重写一遍」。
 */
export const issueToken = (input: PortalIssueTokenRequest) => post<PortalTokenResult>(members + '/tokens', input)
/**
 * 签发 appKey。
 *
 * ★ 走独立端点而不是 `issueToken`：appKey 的权限范围**由服务端固定**为
 *   「上报 + 获取统计」，请求体里给不出更宽的范围（见 `APP_KEY_SCOPES`）。
 */
export const issueAppKey = (input: PortalIssueAppKeyRequest) => post<PortalTokenResult>(members + '/appkey', input)
export const rotateToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/rotate', input)
export const revokeToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/revoke', input)
export const updateTokenScopes = (input: PortalTokenScopesRequest) => post<PortalTokenResult>(members + '/tokens/scopes', input)
/**
 * 改一把已有凭证的有效期。
 *
 * ★ `expires_at_ms: null` 表示长期有效，其余必须是未来时刻 —— 与签发共用
 *   同一条服务端校验。刻意与 `updateTokenScopes` 分成两个端点：改范围与
 *   改有效期是两件事，合成一个「更新凭证」请求会让只想续期的调用顺手带上 scopes。
 */
export const setTokenExpiry = (input: PortalTokenExpiryRequest) => post<PortalTokenResult>(members + '/tokens/expiry', input)
export const createGroup = (name: string) => post<PortalGroupResult>(root + '/groups', { name })
export const updateGroup = (input: PortalGroupVersionRequest & { name: string }) => post<PortalGroupResult>(root + '/groups/update', input)
export const updateGroupStatus = (input: PortalGroupVersionRequest & { status: 'active' | 'disabled' }) => post<PortalGroupResult>(root + '/groups/status', input)
