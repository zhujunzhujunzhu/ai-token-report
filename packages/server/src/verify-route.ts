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

import type { VerifyTokenResponse } from '@ai-token-report/shared'

import type { CredentialStore } from './credentials.js'

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
    name: result.name,
    ...(result.dept ? { dept: result.dept } : {}),
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
): { ok: true; name: string; dept?: string } | { ok: false; reason: string; registered: boolean } {
  const token = tokenFromHeader(authorization)

  if (!store.registered) {
    return {
      ok: false,
      registered: false,
      reason: '服务端尚未配置任何凭证，无法归属上报数据',
    }
  }
  if (!token) {
    return { ok: false, registered: true, reason: '上报请求缺少 Authorization 头' }
  }

  const r = store.verify(token)
  if (!r.ok) {
    return { ok: false, registered: true, reason: r.reason ?? 'token 无效' }
  }

  return { ok: true, name: r.name!, ...(r.dept ? { dept: r.dept } : {}) }
}