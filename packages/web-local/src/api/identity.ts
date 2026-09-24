/**
 * 本地服务 API 客户端 —— 署名相关。
 *
 * 所有请求打到本地服务（`dsh-token --web` 起的那个）。
 */

import type {
  LocalIdentityResponse,
  LocalIdentitySubmit,
  LocalIdentitySubmitResponse,
} from '@ai-token-report/shared'

import { request, type ApiResult } from './request'

/** 读取当前署名状态。 */
export function fetchIdentity(): Promise<ApiResult<LocalIdentityResponse>> {
  return request<LocalIdentityResponse>('/api/local/identity')
}

/**
 * 提交署名。
 *
 * ⚠️ 服务端会拿 token 向部门服务端校验，通过才落盘。
 *   所以这里返回 `ok: true` 但 `data.ok: false` 是正常情况（token 填错了），
 *   页面应当展示 `data.reason` 而不是「保存成功」。
 */
export function submitIdentity(
  input: LocalIdentitySubmit,
): Promise<ApiResult<LocalIdentitySubmitResponse>> {
  return request<LocalIdentitySubmitResponse>('/api/local/identity', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 清除署名（换人 / 退出）。 */
export function clearIdentity(): Promise<ApiResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>('/api/local/identity', { method: 'DELETE' })
}