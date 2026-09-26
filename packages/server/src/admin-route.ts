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
  portalConfirmLegacySchema,
  parseAdminIssueBody,
  parseAdminLoginBody,
  parseAdminTokenBody,
  parseAdminUpdateBody,
  parsePortalBody,
  portalCreateMemberSchema, portalUpdateMemberSchema, portalMemberRolesSchema, portalMemberStatusSchema,
  portalLoginAccountSchema, portalLoginStatusSchema, portalIssueTokenSchema, portalTokenVersionSchema,
  portalTokenScopesSchema, portalCreateDepartmentSchema, portalUpdateDepartmentSchema, portalDepartmentStatusSchema,
} from '@ai-token-report/shared/schemas'

import type { CredentialStore } from './credentials.js'
import { authorize, authorizeDatabase, databaseFailure, type Authentication } from './http/auth.js'
import type { IdentityRepository } from './identity/index.js'
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

/** 数据库管理入口。旧类只供旧领域单测，生产装配始终使用本类。 */
export class DatabaseAdminRoute {
  constructor(private readonly repository: IdentityRepository) {}

  async handle(method: string, path: string, authentication: Authentication, body: unknown, params: URLSearchParams): Promise<AdminRouteResult> {
    const key = `${method} ${path}`
    const permissions: Record<string, string> = {
      'GET members': 'members:read', 'POST members': 'members:manage',
      'POST members/update': 'members:manage', 'POST members/roles': 'roles:assign',
      'POST members/status': 'members:manage', 'POST members/login': 'accounts:manage',
      'POST members/login/status': 'accounts:manage', 'GET members/tokens': 'tokens:manage',
      'POST members/tokens': 'tokens:manage', 'POST members/tokens/rotate': 'tokens:manage',
      'POST members/tokens/revoke': 'tokens:manage', 'POST members/tokens/scopes': 'tokens:manage',
      'GET roles': 'roles:read', 'GET departments': 'departments:read',
      'POST departments': 'departments:manage', 'POST departments/update': 'departments:manage',
      'POST departments/status': 'departments:manage', 'GET audit': 'audit:read', 'GET storage': 'members:read',
      'GET legacy-attributions': 'members:read', 'POST legacy-attributions/confirm': 'members:manage',
    }
    const permission = permissions[key]
    if (!permission) return { status: 404, body: { ok: false, reason: '未找到管理接口' } }
    const auth = await authorizeDatabase(this.repository, authentication, permission, VIEWER_AUTH_MESSAGES)
    if (!auth.ok) return { status: auth.status, body: { ok: false, reason: auth.reason } }
    const actor = auth.viewer
    const r = this.repository
    const ok = (value: unknown): AdminRouteResult => ({ status: 200, body: value })
    const mutate = async <T>(shape: { ok: true; value: T } | { ok: false; reason: string }, action: (input: T) => Promise<unknown>): Promise<AdminRouteResult> =>
      shape.ok ? ok(await action(shape.value)) : badRequest(shape.reason)
    try {
      switch (key) {
        case 'GET members': return ok(await r.listMembers(actor))
        case 'GET roles': return ok(await r.listRoles(actor))
        case 'GET departments': return ok(await r.listDepartments(actor))
        case 'GET storage': return ok(await r.storage(actor))
        case 'GET legacy-attributions': return ok(await r.listLegacyAttributions(actor))
        case 'POST legacy-attributions/confirm': return mutate(parsePortalBody(portalConfirmLegacySchema, body), input => r.confirmLegacyAttribution(actor, input))
        case 'GET audit': {
          for (const key of ['limit', 'offset', 'from', 'to']) {
            if (params.has(key) && !/^\d+$/.test(params.get(key)!)) return badRequest(`${key} 需要是非负整数`)
          }
          const limit = params.has('limit') ? Number(params.get('limit')) : 50
          const offset = params.has('offset') ? Number(params.get('offset')) : 0
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return badRequest('limit 需要在 1~200 之间')
          if (!Number.isSafeInteger(offset) || offset < 0) return badRequest('offset 需要是非负整数')
          const from = params.has('from') ? Number(params.get('from')) : undefined
          const to = params.has('to') ? Number(params.get('to')) : undefined
          if ((from !== undefined && !Number.isSafeInteger(from)) || (to !== undefined && !Number.isSafeInteger(to))) return badRequest('审计时间需要是 epoch 毫秒整数')
          if (from !== undefined && to !== undefined && from > to) return badRequest('起始时间晚于结束时间')
          const targetType = params.get('target_type'), targetId = params.get('target_id')
          if (targetType !== null && !/^[a-z_]{1,32}$/.test(targetType)) return badRequest('target_type 无效')
          if (targetId !== null && !UUID.test(targetId)) return badRequest('target_id 需要有效 ID')
          return ok(await r.listAudit(actor, { limit, offset, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(targetType ? { target_type: targetType } : {}), ...(targetId ? { target_id: targetId } : {}) }))
        }
        case 'GET members/tokens': {
          const memberId = params.get('member_id')
          if (!memberId || !UUID.test(memberId)) return badRequest('member_id 需要有效的人员 ID')
          return ok(await r.listTokens(actor, memberId))
        }
        case 'POST members': return mutate(parsePortalBody(portalCreateMemberSchema, body), input => r.createMember(actor, input))
        case 'POST members/update': return mutate(parsePortalBody(portalUpdateMemberSchema, body), input => r.updateMember(actor, input))
        case 'POST members/roles': return mutate(parsePortalBody(portalMemberRolesSchema, body), input => r.setRoles(actor, input))
        case 'POST members/status': return mutate(parsePortalBody(portalMemberStatusSchema, body), input => r.setMemberStatus(actor, input))
        case 'POST members/login': return mutate(parsePortalBody(portalLoginAccountSchema, body), input => r.setLogin(actor, input))
        case 'POST members/login/status': return mutate(parsePortalBody(portalLoginStatusSchema, body), input => r.setLoginStatus(actor, input))
        case 'POST members/tokens': return mutate(parsePortalBody(portalIssueTokenSchema, body), input => r.issueToken(actor, input))
        case 'POST members/tokens/rotate': return mutate(parsePortalBody(portalTokenVersionSchema, body), input => r.rotateToken(actor, input))
        case 'POST members/tokens/revoke': return mutate(parsePortalBody(portalTokenVersionSchema, body), input => r.revokeToken(actor, input))
        case 'POST members/tokens/scopes': return mutate(parsePortalBody(portalTokenScopesSchema, body), input => r.setTokenScopes(actor, input))
        case 'POST departments': return mutate(parsePortalBody(portalCreateDepartmentSchema, body), input => r.createDepartment(actor, input))
        case 'POST departments/update': return mutate(parsePortalBody(portalUpdateDepartmentSchema, body), input => r.updateDepartment(actor, input))
        case 'POST departments/status': return mutate(parsePortalBody(portalDepartmentStatusSchema, body), input => r.setDepartmentStatus(actor, input))
        default: return { status: 404, body: { ok: false, reason: '未找到管理接口' } }
      }
    } catch (err) {
      const failure = databaseFailure(err)
      return { status: failure.status, body: { ok: false, reason: failure.reason, ...(failure.code ? { code: failure.code } : {}) } }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
