/**
 * 人员管理路由 —— `GET/POST /api/v1/admin/members*`（管理页用）。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET | `/api/v1/admin/members` | 人员列表 + 凭证文件状态 |
 * | POST | `/api/v1/admin/members` | ★ 签发 token（新人入职） |
 * | POST | `/api/v1/admin/members/update` | 改姓名 / 部门 / 角色（token 不变） |
 * | POST | `/api/v1/admin/members/rotate` | 重置 token（旧 token 立即失效） |
 * | POST | `/api/v1/admin/members/revoke` | 吊销（本人此后无法上报与看看板） |
 *
 * 响应结构来自 `shared/src/protocol.ts`，前端与之共用。
 * 请求体的**形状校验**来自 `shared/src/schemas.ts`（zod，走子路径
 * `@ai-token-report/shared/schemas`）—— 本文件里不再留一条手写 `typeof` 判断，
 * 文案（「请求体需要是一个对象」等）在那边逐字保留。
 *
 * ## 🚨 鉴权：401 / 503 / **403** 三者必须分开
 *
 * | 情况 | 状态码 | 为什么不能合并 |
 * |---|---|---|
 * | 服务端没配凭证 | `503` | 管理员发完凭证再试就有用 |
 * | 没带 token / token 不对 | `401` | 让页面退回门禁页重填 |
 * | token 有效但**不是管理员** | `403` | 重填也没用，得去要一个管理员 token |
 *
 * 全都**不能**是 `200 + ok:false`：这个响应体里装的是**人员名单和 token**，
 * 回 2xx 会让前端把「你没权限」渲染成一屏正常的数据。
 * 这与 `/api/v1/stats/*` 的 401/503 是同一条理由（见 stats-route.ts）。
 *
 * ⚠️ 业务失败（重名、最后一个管理员不能删……）**仍然回 `200 + ok:false`**：
 *   它与上面三类不是一回事 —— 那是「输入需要改」，这是「身份需要换」。
 *   把两者都做成 4xx 会让页面只有一句「操作失败」，管理员不知道改什么。
 *
 * ## 写入只有一条路
 *
 * 本路由不做任何文件操作，全部交给 `MemberAdmin`（`member-admin.ts`）——
 * 那里集中处理原子写入、拒绝覆盖不可解析的文件、最后一个管理员护栏。
 * 路由层只负责「认人、校验请求形状、转成响应」。
 */

import type { AdminMemberResponse, AdminMembersResponse, UserRole } from '@ai-token-report/shared'
import {
  parseAdminIssueBody,
  parseAdminLoginBody,
  parseAdminTokenBody,
  parseAdminUpdateBody,
} from '@ai-token-report/shared/schemas'

import type { CredentialStore } from './credentials.js'
import { authorize } from './http/auth.js'
import type { MemberAdmin, MemberResult } from './member-admin.js'
import { VIEWER_AUTH_MESSAGES } from './verify-route.js'

/** 路由处理结果：状态码 + 响应体。`index.ts` 的 `fromRoute()` 直接吃这个形状。 */
export interface AdminRouteResult {
  status: number
  body: unknown
}

export interface AdminRouteOptions {
  /** ★ 与上报/看板共享的同一个凭证表实例（签发后立刻生效）。 */
  store: CredentialStore
  admin: MemberAdmin
}

export class AdminRoute {
  readonly #store: CredentialStore
  readonly #admin: MemberAdmin

  constructor(options: AdminRouteOptions) {
    this.#store = options.store
    this.#admin = options.admin
  }

  /** `GET /api/v1/admin/members` */
  list(authorization: string | null): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const storage = this.#admin.storage()
    const body: AdminMembersResponse = {
      members: this.#admin.list(),
      credentialsPath: storage.credentialsPath,
      writable: storage.writable,
      writeBlockedReason: storage.writeBlockedReason,
    }
    return { status: 200, body }
  }

  /** `POST /api/v1/admin/members` —— 签发。 */
  issue(authorization: string | null, body: unknown): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    // 形状（含「请求体需要是一个对象」这类**逐字文案**）由 `shared/schemas.ts`
    // 的 zod schema 判定；本路由只把失败翻成 400。
    // ⚠️ 姓名是否为空、角色是不是 admin|member 都是**业务**判定，留给
    //    `member-admin.ts` —— 那些要回 `200 + ok:false`，不是 400。
    const shape = parseAdminIssueBody(body)
    if (!shape.ok) return badRequest(shape.reason)

    return fromMember(
      this.#admin.issue({
        name: shape.value.name,
        ...(shape.value.dept !== undefined ? { dept: shape.value.dept } : {}),
        ...(shape.value.role !== undefined ? { role: shape.value.role as UserRole } : {}),
      }),
    )
  }

  /** `POST /api/v1/admin/members/update` —— 改名 / 换部门 / 调角色。 */
  update(authorization: string | null, body: unknown): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const shape = parseAdminUpdateBody(body)
    if (!shape.ok) return badRequest(shape.reason)

    return fromMember(
      this.#admin.update({
        token: shape.value.token,
        ...(shape.value.name !== undefined ? { name: shape.value.name } : {}),
        ...(shape.value.dept !== undefined ? { dept: shape.value.dept } : {}),
        ...(shape.value.role !== undefined ? { role: shape.value.role as UserRole } : {}),
      }),
    )
  }

  /** `POST /api/v1/admin/members/rotate` —— 重置 token。 */
  rotate(authorization: string | null, body: unknown): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const shape = parseAdminTokenBody(body)
    if (!shape.ok) return badRequest(shape.reason)
    return fromMember(this.#admin.rotate({ token: shape.value.token }))
  }

  /** `POST /api/v1/admin/members/revoke` —— 吊销。 */
  revoke(authorization: string | null, body: unknown): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const shape = parseAdminTokenBody(body)
    if (!shape.ok) return badRequest(shape.reason)
    return fromMember(this.#admin.revoke({ token: shape.value.token }))
  }

  /** 开通 / 重置登录账号，沿用凭证落盘与角色护栏。 */
  async setLogin(authorization: string | null, body: unknown): Promise<AdminRouteResult> {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const shape = parseAdminLoginBody(body)
    if (!shape.ok) return badRequest(shape.reason)

    return fromMember(
      await this.#admin.setLogin({
        token: shape.value.token,
        username: shape.value.username,
        password: shape.value.password,
      }),
    )
  }

  /**
   * 认人 + 认角色。返回非 null 表示拒绝。
   *
   * ★ 顺序是「先认人、再认角色」：一个 token 无效的人不该被告知
   *   「这里只有管理员能进」（那等于确认了他手上是个有效 token 的另一回事）。
   */
  #authorize(authorization: string | null): AdminRouteResult | null {
    // ★ 判定顺序（「先认人、再认角色」）与 401/403/503 的映射都在
    //   `http/auth.ts` 的 `authorize()` 里 —— 全仓唯一一处。
    //   本路由只负责把结果翻译成 `{ status, body }`。
    const auth = authorize(this.#store, authorization, VIEWER_AUTH_MESSAGES, {
      requireAdmin: true,
    })
    if (!auth.ok) {
      return { status: auth.status, body: { ok: false, reason: auth.reason } }
    }

    return null
  }
}

/** 业务结果 → HTTP 响应。业务失败是 200 + ok:false（见文件头）。 */
function fromMember(result: MemberResult): AdminRouteResult {
  const body: AdminMemberResponse = {
    ok: result.ok,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.member ? { member: result.member } : {}),
  }
  return { status: 200, body }
}

/** 请求形状错误 ⇒ 400（与「业务规则不满足」区分开）。 */
function badRequest(reason: string): AdminRouteResult {
  return { status: 400, body: { ok: false, reason } }
}
