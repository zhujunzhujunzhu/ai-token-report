/** 数据库人员管理客户端。对象 ID 定位、版本防覆盖，秘密只随签发响应返回。 */
import type {
  PortalMember, PortalRole, PortalDepartment, PortalReportToken, PortalStorageResponse,
  PortalAuditResponse, PortalCreateMemberRequest, PortalUpdateMemberRequest, PortalMemberRolesRequest,
  PortalMemberStatusRequest, PortalLoginAccountRequest, PortalLoginStatusRequest,
  PortalIssueTokenRequest, PortalTokenVersionRequest, PortalTokenScopesRequest,
  PortalMemberResult, PortalTokenResult, PortalDepartmentResult, PortalDepartmentVersionRequest,
  PortalLegacyAttribution, PortalConfirmLegacyRequest, PortalLegacyResult,
} from '@ai-token-report/shared'
import { post, request } from './request.js'

const root = '/api/v1/admin'
const members = root + '/members'
export const fetchMembers = () => request<{ members: PortalMember[] }>(members)
export const fetchRoles = () => request<{ roles: PortalRole[] }>(root + '/roles')
export const fetchDepartments = () => request<{ departments: PortalDepartment[] }>('/api/v1/departments')
export const fetchStorage = () => request<PortalStorageResponse>(root + '/storage')
export const fetchAudit = () => request<PortalAuditResponse>(root + '/audit?limit=30')
export const fetchLegacyAttributions = () => request<{ mappings: PortalLegacyAttribution[] }>(root + '/legacy-attributions')
export const confirmLegacyAttribution = (input: PortalConfirmLegacyRequest) => post<PortalLegacyResult>(root + '/legacy-attributions/confirm', input)
export const fetchTokens = (memberId: string) => request<{ tokens: PortalReportToken[] }>(
  members + '/tokens?' + new URLSearchParams({ member_id: memberId }),
)
export const issueMember = (input: PortalCreateMemberRequest) => post<PortalMemberResult>(members, input)
export const updateMember = (input: PortalUpdateMemberRequest) => post<PortalMemberResult>(members + '/update', input)
export const updateRoles = (input: PortalMemberRolesRequest) => post<PortalMemberResult>(members + '/roles', input)
export const updateMemberStatus = (input: PortalMemberStatusRequest) => post<PortalMemberResult>(members + '/status', input)
export const setLoginAccount = (input: PortalLoginAccountRequest) => post<PortalMemberResult>(members + '/login', input)
export const setLoginStatus = (input: PortalLoginStatusRequest) => post<PortalMemberResult>(members + '/login/status', input)
export const issueToken = (input: PortalIssueTokenRequest) => post<PortalTokenResult>(members + '/tokens', input)
export const rotateToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/rotate', input)
export const revokeToken = (input: PortalTokenVersionRequest) => post<PortalTokenResult>(members + '/tokens/revoke', input)
export const updateTokenScopes = (input: PortalTokenScopesRequest) => post<PortalTokenResult>(members + '/tokens/scopes', input)
export const createDepartment = (name: string) => post<PortalDepartmentResult>(root + '/departments', { name })
export const updateDepartment = (input: PortalDepartmentVersionRequest & { name: string }) => post<PortalDepartmentResult>(root + '/departments/update', input)
export const updateDepartmentStatus = (input: PortalDepartmentVersionRequest & { status: 'active' | 'disabled' }) => post<PortalDepartmentResult>(root + '/departments/status', input)
