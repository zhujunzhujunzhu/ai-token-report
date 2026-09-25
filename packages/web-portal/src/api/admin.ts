/**
 * 人员管理 API 客户端（管理页专用）。
 *
 * ★ 这一组接口是**唯一会改凭证的**：签发 / 重置 / 吊销都在这里。
 *   页面本身不做任何权限判断 —— 它只是不显示管理页签；
 *   真正的门在服务端（`admin-route.ts`：401 / 403 / 503）。
 *
 * ## 四种失败要分开处理（页面上必须是四句不同的话）
 *
 * | 状态 | 含义 | 页面该做什么 |
 * |---|---|---|
 * | `401` | token 没了 / 不对 | 退回门禁页重新填 |
 * | `403` | token 有效但**不是管理员** | 说明「去要一个管理员 token」，重填无用 |
 * | `503` | 服务端还没配任何凭证 | 说明「让管理员先发凭证」 |
 * | `400` | 请求形状不对（前端 bug / 服务被换过） | 展示原因，别重试 |
 *
 * 业务失败（重名、最后一个管理员不能删……）**是 `200 + ok:false`**，
 * 因此必须检查 `body.ok` —— 只看 HTTP 状态会把失败当成功，
 * 而页面上会显示「已发放」，管理员把 token 发出去才发现根本不存在。
 */

import type {
  AdminIssueMemberRequest,
  AdminMemberResponse,
  AdminMembersResponse,
  AdminUpdateMemberRequest,
  UserRole,
} from '@ai-token-report/shared'

import { post, request, type ApiResult } from './request.js'

const MEMBERS_PATH = '/api/v1/admin/members'

/** 人员列表 + 凭证文件状态。 */
export function fetchMembers(): Promise<ApiResult<AdminMembersResponse>> {
  return request<AdminMembersResponse>(MEMBERS_PATH)
}

/** 签发一个新 token（新人入职）。 */
export function issueMember(
  input: AdminIssueMemberRequest,
): Promise<ApiResult<AdminMemberResponse>> {
  return post<AdminMemberResponse>(MEMBERS_PATH, input)
}

/** 改姓名 / 部门 / 角色。token 不变。 */
export function updateMember(
  input: AdminUpdateMemberRequest,
): Promise<ApiResult<AdminMemberResponse>> {
  return post<AdminMemberResponse>(`${MEMBERS_PATH}/update`, input)
}

/** 重置 token：旧 token 立即失效，新 token 在响应里返回。 */
export function rotateMember(
  memberToken: string,
): Promise<ApiResult<AdminMemberResponse>> {
  return post<AdminMemberResponse>(`${MEMBERS_PATH}/rotate`, {
    token: memberToken,
  })
}

/** 吊销：本人此后既不能上报，也不能打开看板。 */
export function revokeMember(
  memberToken: string,
): Promise<ApiResult<AdminMemberResponse>> {
  return post<AdminMemberResponse>(`${MEMBERS_PATH}/revoke`, {
    token: memberToken,
  })
}

/** 角色的展示文案（下拉与表格共用，避免两处各写一份）。 */
export const ROLE_LABELS: { value: UserRole; label: string }[] = [
  { value: 'member', label: '普通成员' },
  { value: 'admin', label: '管理员' },
]

/** 角色 → 中文名。 */
export function roleLabel(role: UserRole): string {
  return ROLE_LABELS.find((r) => r.value === role)?.label ?? role
}

/** 开通或重置后台登录账号。 */
export function setLoginAccount(
  input: import('@ai-token-report/shared').AdminLoginAccountRequest,
): Promise<ApiResult<AdminMemberResponse>> {
  return post<AdminMemberResponse>(MEMBERS_PATH + '/login', input)
}
