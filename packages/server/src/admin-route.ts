/**
 * 人员管理路由 —— `GET/POST /api/v1/admin/members*`（管理页用）。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET | `/api/v1/admin/members` | 人员列表 + 凭证文件状态 |
 * | GET | `/api/v1/admin/appkeys` | ★ appKey 列表：每行一把凭证 + 它发给了谁 |
 * | POST | `/api/v1/admin/members` | ★ 签发 token（新人入职） |
 * | POST | `/api/v1/admin/members/update` | 改姓名 / 部门 / 角色（token 不变） |
 * | POST | `/api/v1/admin/members/rotate` | 重置 token（旧 token 立即失效） |
 * | POST | `/api/v1/admin/members/revoke` | 吊销（本人此后无法上报与看看板） |
 * | POST | `/api/v1/admin/members/appkey` | ★ 签发 appKey（范围固定为上报 + 获取统计） |
 * | POST | `/api/v1/admin/members/tokens/expiry` | ★ 改凭证有效期（`null` = 长期有效，其余须是未来时刻） |
 * | POST | `/api/v1/admin/members/tokens/delete` | ★ 物理删除凭证（仅限从未上报 / 未被审计引用的） |
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
  portalTokenScopesSchema, portalIssueAppKeySchema, portalCreateGroupSchema, portalUpdateGroupSchema, portalGroupStatusSchema,
  portalCreateRoleSchema, portalUpdateRoleSchema, portalRoleStatusSchema,
  portalTokenExpirySchema,
  portalSetProviderAliasSchema, portalProviderAliasIdSchema, portalProviderAliasStatusSchema,
  portalSetProjectAliasSchema, portalProjectAliasIdSchema, portalProjectAliasStatusSchema,
  portalSetModelPriceSchema, portalModelPriceIdSchema,
} from '@ai-token-report/shared/schemas'

import type { CredentialStore } from './credentials.js'
import { authorize, authorizeDatabase, databaseFailure, type Authentication } from './http/auth.js'
import type { IdentityRepository } from './identity/index.js'
import type { IdentityMutationPrecondition } from './identity/repository.js'
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
        ...(shape.value.group !== undefined ? { group: shape.value.group } : {}),
        ...(shape.value.role !== undefined ? { role: shape.value.role as UserRole } : {}),
      }),
    )
  }

  /** `POST /api/v1/admin/members/update` —— 改名 / 换分组 / 调角色。 */
  update(authorization: string | null, body: unknown): AdminRouteResult {
    const denied = this.#authorize(authorization)
    if (denied) return denied

    const shape = parseAdminUpdateBody(body)
    if (!shape.ok) return badRequest(shape.reason)

    return fromMember(
      this.#admin.update({
        token: shape.value.token,
        ...(shape.value.name !== undefined ? { name: shape.value.name } : {}),
        ...(shape.value.group !== undefined ? { group: shape.value.group } : {}),
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

  /** 助手先校验写权限再出确认卡；仍重新读取数据库，不能采信会话开始时的权限。 */
  authorizeAssistantMutation(actor: import('./identity/types.js').Principal, resource: string) {
    const permissions: Record<string, string> = { members: 'members:manage', groups: 'groups:manage', 'provider-aliases': 'providers:manage', 'project-aliases': 'projects:manage', pricing: 'pricing:manage' }
    const permission = permissions[resource]
    if (!permission) throw new Error('不支持助手管理资源')
    return this.repository.authorize(actor, permission)
  }

  async handle(method: string, path: string, authentication: Authentication, body: unknown, params: URLSearchParams, condition?: IdentityMutationPrecondition): Promise<AdminRouteResult> {
    if (condition) return this.repository.withMutationPrecondition(condition, () => this.handle(method, path, authentication, body, params))
    const key = `${method} ${path}`
    const permissions: Record<string, string> = {
      'GET members': 'members:read', 'POST members': 'members:manage',
      'POST members/update': 'members:manage', 'POST members/roles': 'roles:assign',
      'POST members/status': 'members:manage', 'POST members/login': 'accounts:manage',
      'POST members/login/status': 'accounts:manage', 'GET members/tokens': 'tokens:manage',
      // ★ appKey 列表（页面主体）与「签发凭证」同一权限：响应里有凭证提示与
      //   权限范围，能读人员名单的人未必该知道谁手里有哪些凭证。
      'GET appkeys': 'tokens:manage',
      'POST members/tokens': 'tokens:manage', 'POST members/tokens/rotate': 'tokens:manage',
      'POST members/tokens/revoke': 'tokens:manage', 'POST members/tokens/scopes': 'tokens:manage',
      // ★ 改有效期与改范围同一权限：都是「动一把已有凭证」，而能改有效期的
      //   人本来就敢让这把 key 立刻失效。
      'POST members/tokens/expiry': 'tokens:manage',
      // ★ 删除与吊销共用权限：都是「处置一把已有凭证」，而删除比吊销更狠
      //   （吊销留痕，删除让整行消失）。能吊销的人本来就能让它立刻失效。
      'POST members/tokens/delete': 'tokens:manage',
      // ★ appKey 的权限范围由服务端固定（见 `issueAppKey`），但它们仍然是
      //   「签凭证」这件事，所以与其它签发动作共用同一个权限。
      'POST members/appkey': 'tokens:manage',
      'GET roles': 'roles:read', 'GET groups': 'groups:read',
      // ★ 角色定义（新建 / 改名 / 改权限 / 启停）复用 `roles:assign` 而不是新造一个
      //   `roles:manage` 权限码。
      //   ⚠️ 这里曾经的理由是「权限目录在 seed 里，改它会动 checksum」——
      //     那个理由在 v6 已经不成立：v6 **新增了** `providers:read` /
      //     `providers:manage` 两个权限码，并配套了显式迁移
      //     （`portalV6Statements()` 的幂等权限行 + v5→v6 迁移步骤）。
      //     也就是说「新增权限码」现在有正规路径了 —— 但要**走完整的版本升级**，
      //     而不是往 seed 里插一行就完事（那会让已部署的库 checksum 不符、
      //     `current` 判定失败、服务端直接拒绝启动）。
      'POST roles': 'roles:assign', 'POST roles/update': 'roles:assign',
      'POST roles/status': 'roles:assign',
      'POST groups': 'groups:manage', 'POST groups/update': 'groups:manage',
      'POST groups/status': 'groups:manage', 'GET audit': 'audit:read', 'GET storage': 'members:read',
      'GET legacy-attributions': 'members:read', 'POST legacy-attributions/confirm': 'members:manage',
      // ★ 供应商归一化规则：读 / 写分开。看板查询**不经过这里** ——
      //   它用 `stats:read` 自己读规则表（见 `stats-route.ts`），
      //   所以「能看数据」的人不会因为缺 `providers:read` 就看到未归一化的名字。
      'GET provider-aliases': 'providers:read',
      'POST provider-aliases': 'providers:manage',
      'POST provider-aliases/delete': 'providers:manage',
      'POST provider-aliases/status': 'providers:manage',
      // ★ 项目归一化规则（v11）：与供应商归一化逐条同形（读 / 写分开）。
      //   看板查询同样**不经过这里** —— 它用 `stats:read` 自己读规则表，
      //   所以「能看数据」的人不会因为缺 `projects:read` 就看到未归一化的项目名。
      'GET project-aliases': 'projects:read',
      'POST project-aliases': 'projects:manage',
      'POST project-aliases/delete': 'projects:manage',
      'POST project-aliases/status': 'projects:manage',
      // ★ 模型单价（v7）：读也归 `pricing:manage` —— 单价是**配置**，
      //   不是「看一眼的数字」。能看金额的人（`cost:read`）不必能看/改计价表；
      //   看板要展示金额时走的是 `stats` 侧的只读快照，不经过这里。
      'GET pricing': 'pricing:manage',
      'POST pricing': 'pricing:manage',
      'POST pricing/delete': 'pricing:manage',
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
        case 'POST roles': return mutate(parsePortalBody(portalCreateRoleSchema, body), input => r.createRole(actor, input))
        case 'POST roles/update': return mutate(parsePortalBody(portalUpdateRoleSchema, body), input => r.updateRole(actor, input))
        case 'POST roles/status': return mutate(parsePortalBody(portalRoleStatusSchema, body), input => r.setRoleStatus(actor, input))
        case 'GET groups': return ok(await r.listGroups(actor))
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
        case 'GET appkeys': return ok(await r.listAppKeys(actor))
        case 'POST members': return mutate(parsePortalBody(portalCreateMemberSchema, body), input => r.createMember(actor, input))
        case 'POST members/update': return mutate(parsePortalBody(portalUpdateMemberSchema, body), input => r.updateMember(actor, input))
        case 'POST members/roles': return mutate(parsePortalBody(portalMemberRolesSchema, body), input => r.setRoles(actor, input))
        case 'POST members/status': return mutate(parsePortalBody(portalMemberStatusSchema, body), input => r.setMemberStatus(actor, input))
        case 'POST members/login': return mutate(parsePortalBody(portalLoginAccountSchema, body), input => r.setLogin(actor, input))
        case 'POST members/login/status': return mutate(parsePortalBody(portalLoginStatusSchema, body), input => r.setLoginStatus(actor, input))
        case 'POST members/tokens': return mutate(parsePortalBody(portalIssueTokenSchema, body), input => r.issueToken(actor, input))
        case 'POST members/appkey': return mutate(parsePortalBody(portalIssueAppKeySchema, body), input => r.issueAppKey(actor, input))
        case 'POST members/tokens/rotate': return mutate(parsePortalBody(portalTokenVersionSchema, body), input => r.rotateToken(actor, input))
        case 'POST members/tokens/revoke': return mutate(parsePortalBody(portalTokenVersionSchema, body), input => r.revokeToken(actor, input))
        case 'POST members/tokens/scopes': return mutate(parsePortalBody(portalTokenScopesSchema, body), input => r.setTokenScopes(actor, input))
        case 'POST members/tokens/expiry': return mutate(parsePortalBody(portalTokenExpirySchema, body), input => r.setTokenExpiry(actor, input))
        case 'POST members/tokens/delete': return mutate(parsePortalBody(portalTokenVersionSchema, body), input => r.deleteToken(actor, input))
        case 'POST groups': return mutate(parsePortalBody(portalCreateGroupSchema, body), input => r.createGroup(actor, input))
        case 'POST groups/update': return mutate(parsePortalBody(portalUpdateGroupSchema, body), input => r.updateGroup(actor, input))
        case 'POST groups/status': return mutate(parsePortalBody(portalGroupStatusSchema, body), input => r.setGroupStatus(actor, input))
        case 'GET provider-aliases': return ok(await r.listProviderAliases(actor))
        case 'POST provider-aliases': return mutate(parsePortalBody(portalSetProviderAliasSchema, body), input => r.setProviderAlias(actor, input))
        case 'POST provider-aliases/delete': return mutate(parsePortalBody(portalProviderAliasIdSchema, body), input => r.deleteProviderAlias(actor, input))
        case 'POST provider-aliases/status': return mutate(parsePortalBody(portalProviderAliasStatusSchema, body), input => r.setProviderAliasStatus(actor, input))
        case 'GET project-aliases': return ok(await r.listProjectAliases(actor))
        case 'POST project-aliases': return mutate(parsePortalBody(portalSetProjectAliasSchema, body), input => r.setProjectAlias(actor, input))
        case 'POST project-aliases/delete': return mutate(parsePortalBody(portalProjectAliasIdSchema, body), input => r.deleteProjectAlias(actor, input))
        case 'POST project-aliases/status': return mutate(parsePortalBody(portalProjectAliasStatusSchema, body), input => r.setProjectAliasStatus(actor, input))
        case 'GET pricing': return ok(await r.listModelPrices(actor))
        case 'POST pricing': return mutate(parsePortalBody(portalSetModelPriceSchema, body), input => r.setModelPrice(actor, input))
        case 'POST pricing/delete': return mutate(parsePortalBody(portalModelPriceIdSchema, body), input => r.deleteModelPrice(actor, input))
        default: return { status: 404, body: { ok: false, reason: '未找到管理接口' } }
      }
    } catch (err) {
      const failure = databaseFailure(err)
      return { status: failure.status, body: { ok: false, reason: failure.reason, ...(failure.code ? { code: failure.code } : {}) } }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
