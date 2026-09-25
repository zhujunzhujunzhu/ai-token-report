/**
 * 鉴权裁决 —— 「token 有效吗 / 他有权限吗」→ 状态码的**唯一**实现。
 *
 * ## 重构前：同一段判定写了三遍
 *
 * ```ts
 * // ingest-route.ts:109 / stats-route.ts:119 / admin-route.ts:173
 * status: identity.registered ? 401 : 503
 * ```
 *
 * 三处逐字相同（admin 另加 403）。它与 `credentials.ts` 里那句
 * 「身份可信边界的落点」是同一类东西：**判定只该有一处**。
 * 三份副本里只要有一份把 `registered` 判反，表现是「没配凭证时提示
 * token 无效」—— 用户会拿着一个完全正确的 token 反复重试，而日志里没有任何异常。
 *
 * ## ★ 先认人、再认角色
 *
 * 顺序不可颠倒：一个 token 无效的人不该被告知「这里只有管理员能进」。
 * 那等于确认了「你手上是个别的东西」，而正确回答是「你这个 token 不对」。
 *
 * ## ⚠️ 权限唯一来源是凭证表的 `role` 列
 *
 * 绝不是姓名白名单 —— 姓名是可以随便改的显示值。
 */

import type { CredentialStore } from '../credentials.js'
import { resolveIdentity, type IdentityResolution } from '../verify-route.js'

/** 非管理员访问管理接口时的统一文案（前端直接展示，别改）。 */
export const ADMIN_ONLY_REASON = '人员管理仅管理员可用：请改用管理员发放的管理员 token 登录'

/** 失败文案由调用方给：同一个判定，上报与看板的措辞不同（见 `verify-route.ts`）。 */
export interface AuthMessages {
  /** 服务端一个凭证都没配时的文案。 */
  unregistered: string
  /** 配了凭证但请求没带 token 时的文案。 */
  missingToken: string
}

export type AuthOutcome =
  | { ok: true; viewer: Extract<IdentityResolution, { ok: true }> }
  | { ok: false; status: number; reason: string }

/**
 * 裁决一次请求的身份。
 *
 * `requireAdmin` 为 true 时额外要求 `role === 'admin'`（管理接口专用）。
 */
export function authorize(
  store: CredentialStore,
  authorization: string | null | undefined,
  messages: AuthMessages,
  options: { requireAdmin?: boolean } = {},
): AuthOutcome {
  const identity = resolveIdentity(store, authorization, messages)

  if (!identity.ok) {
    // ★ 401 / 503 的唯一判定：
    //   压根没配凭证 ⇒ 503（管理员发完凭证再重试就有用）
    //   配了却对不上 ⇒ 401（重试没用，得换 token）
    return {
      ok: false,
      status: identity.registered ? 401 : 503,
      reason: identity.reason,
    }
  }

  if (options.requireAdmin && identity.role !== 'admin') {
    return { ok: false, status: 403, reason: ADMIN_ONLY_REASON }
  }

  return { ok: true, viewer: identity }
}