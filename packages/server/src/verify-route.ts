/**
 * 身份校验路由 —— 部门服务端回答「这个 token 是谁」。
 *
 * ## 端点
 *
 * ```http
 * POST /api/v1/identity/verify
 * Authorization: Bearer <token>
 * { "token": "<token>" }
 * → { "ok": true, "name": "张三", "dept": "研发一部", "registered": true }
 * ```
 *
 * ## 为什么同时接受 header 和 body 里的 token
 *
 * - **header**：正式路径。客户端本来就要带它，避免 token 出现在请求体里
 *   （请求体会进日志、进追踪、进错误报告）。
 * - **body**：兼容用。某些 HTTP 客户端/代理对 Authorization 头处理不一致，
 *   留一条退路能减少「我们这里就是填不进去」的支持成本。
 *
 * 两者都存在时以 **header 为准**，因为它的语义更明确。
 *
 * ## 这个端点是纯查询
 *
 * 它**不写数据库、不落任何日志**（除了失败计数）。把它做成有副作用的接口，
 * 会让「验证一下 token」这个无害动作产生审计噪音。
 */

import { ROLE_MEMBER, type UserRole, type VerifyTokenResponse } from '@ai-token-report/shared'

import type { CredentialStore } from './credentials.js'
import type { IdentityRepository } from './identity/index.js'

/** 保持旧身份校验 wire 形状；新凭证的范围也由数据库判定。 */
export async function verifyDatabaseToken(store: IdentityRepository, input: VerifyTokenInput): Promise<VerifyTokenResponse> {
  const token = tokenFromHeader(input.authorization) ?? input.bodyToken?.trim() ?? ''
  return store.verifyIdentity(token)
}

/**
 * 上报方向的两句失败文案。
 *
 * ★ 与看板方向**刻意不同**：看板没 token 时要说「去看板填 token」，
 *   而上报没 token 时要说「上报请求缺少 Authorization 头」——
 *   后者是给运维看的（插件/CLI 配错了），把两者的文案统一
 *   等于把排障方向带偏。文案本身是**线上契约**（前端直接展示）。
 */
export const INGEST_AUTH_MESSAGES = {
  unregistered: '服务端尚未配置任何凭证，无法归属上报数据',
  missingToken: '上报请求缺少 Authorization 头',
}

/** 看板方向的两句失败文案（同上，刻意的措辞差异）。 */
export const VIEWER_AUTH_MESSAGES = {
  unregistered: '服务端尚未配置任何凭证，部门看板暂无数据可看，请让管理员先发放 token',
  missingToken: '部门看板需要身份 token：请在页面顶部填入管理员发放的 token',
}

/**
 * 凭证表的校验结果 → 查看者身份。
 *
 * ★ **角色缺省 = member 只在这里写一次**。重构前它在 `verifyToken` 与
 *   `resolveIdentity` 各写了一遍（`role ?? ROLE_MEMBER`）——
 *   两处里只要有一处写成 `?? 'admin'`，「服务端少返回一个字段」
 *   就变成「人人可发 token」。这类默认值必须只有一个落点。
 */
function viewerFrom(verified: { name?: string; role?: UserRole; dept?: string }): {
  name: string
  role: UserRole
  dept?: string
} {
  return {
    name: verified.name!,
    // ★ 角色只可能来自凭证表；缺省（老客户端/字段改名）一律按普通成员处理
    role: verified.role ?? ROLE_MEMBER,
    ...(verified.dept ? { dept: verified.dept } : {}),
  }
}

/** 从 Authorization 头里取出裸 token。 */
export function tokenFromHeader(header: string | null | undefined): string | null {
  if (!header) return null
  const h = header.trim()
  if (!h) return null

  // 兼容 `Bearer xxx` 与裸 token。
  // ⚠️ 必须先判断前缀再取值：若写成 /^Bearer\s+(.+)$/，
  //    那么 `Bearer` 和 `Bearer   `（只有前缀没有 token）会落进「裸 token」分支，
  //    结果把 "Bearer" 本身当成 token 去校验，报出误导性的「token 无效」。
  const m = /^Bearer\b\s*(.*)$/i.exec(h)
  const raw = m ? m[1]! : h
  const token = raw.trim()
  return token || null
}

export interface VerifyTokenInput {
  /** Authorization 头原值。 */
  authorization?: string | null
  /** 请求体里可能带的 token（兼容路径）。 */
  bodyToken?: string | null
}

/**
 * 执行校验。
 *
 * ★ 返回值里的 `name` **只可能来自凭证表**，绝不回显客户端提交的内容。
 *   这是身份可信边界的关键一行 —— 若这里回显了客户端输入，
 *   前面所有「服务端为准」的设计都会失效。
 */
export function verifyToken(
  store: CredentialStore,
  input: VerifyTokenInput,
): VerifyTokenResponse {
  const fromHeader = tokenFromHeader(input.authorization)
  const token = fromHeader ?? (input.bodyToken?.trim() || null)

  if (!token) {
    // 未配置凭证时，这个区分尤其重要：用户做什么都没用，得让管理员先发凭证
    if (!store.registered) {
      return {
        ok: false,
        registered: false,
        reason: '服务端尚未配置任何凭证，请让管理员先发放 token',
      }
    }
    return { ok: false, registered: true, reason: '请求未携带 token' }
  }

  const result = store.verify(token)

  if (!result.ok) {
    return { ok: false, registered: result.registered, reason: result.reason }
  }

  return {
    ok: true,
    registered: true,
    // ★ name 只来自凭证表（store.verify 的返回值），绝不回显客户端输入
    ...viewerFrom(result),
  }
}

/**
 * 从上报请求中解析出**可信身份**。
 *
 * 上报接口用它决定「这条数据算谁的」。
 * 客户端在 body 里声明的 `client.userName` 一律忽略 ——
 * 那只是客户端自称，不构成身份证明。
 */
export function resolveIngestIdentity(
  store: CredentialStore,
  authorization: string | null | undefined,
): IdentityResolution {
  return resolveIdentity(store, authorization, INGEST_AUTH_MESSAGES)
}

/**
 * 从看板请求中解析出**查看者身份**（`/api/v1/stats/*`）。
 *
 * ★ 与 `resolveIngestIdentity` 是**同一套可信边界**（token → 凭证表 → 姓名 + 角色），
 *   只是失败文案不同：看板没有 token 时要说「去看板填 token」，
 *   而不是「上报请求缺少 Authorization 头」—— 后者会把运维引到错误的方向。
 *
 * ⚠️ **角色由凭证表决定**（`role` 列，见 `credentials.ts`），
 *   而**不是**由姓名白名单决定 —— 姓名是可以随便改的显示值。
 *   数据范围上：任何有效 token 都能查看**全部门**（部门看板是组内公开的用量页），
 *   角色只决定「能不能进管理页发 token」（见 `admin-route.ts`）。
 */
export function resolveViewerIdentity(
  store: CredentialStore,
  authorization: string | null | undefined,
): IdentityResolution {
  return resolveIdentity(store, authorization, VIEWER_AUTH_MESSAGES)
}

/** 身份解析结果。失败时 `registered` 区分「没配凭证」与「token 不对」。 */
export type IdentityResolution =
  | { ok: true; name: string; dept?: string; role: UserRole }
  | { ok: false; reason: string; registered: boolean }

/**
 * 身份解析的**唯一实现**。
 *
 * 上报（写）、看板（读）、人员管理（管理）三处共用它，只把两句失败文案
 * 作为参数传进来 —— 若各写一份，「token 有效性判定」就有两个实现，
 * 而其中一个松一点的那个不会报错，只会让不该进来的人进来。
 *
 * 对外可直接使用；`http/auth.ts` 的 `authorize()` 在它的结果上
 * 加「401/503/403 怎么回」这一层（那一层也只该有一处）。
 */
export function resolveIdentity(
  store: CredentialStore,
  authorization: string | null | undefined,
  messages: { unregistered: string; missingToken: string },
): IdentityResolution {
  const token = tokenFromHeader(authorization)

  if (!store.registered) {
    return { ok: false, registered: false, reason: messages.unregistered }
  }
  if (!token) {
    return { ok: false, registered: true, reason: messages.missingToken }
  }

  const r = store.verify(token)
  if (!r.ok) {
    return { ok: false, registered: true, reason: r.reason ?? 'token 无效' }
  }

  return { ok: true, ...viewerFrom(r) }
}
