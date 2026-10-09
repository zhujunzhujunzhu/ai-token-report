/**
 * 人员「编辑资料」的提交计划与执行顺序。
 *
 * ★ 抽成模块（而不是写在 `AdminView.vue` 的提交处理里）有一个具体原因：
 *   姓名 / 分组与角色是**两个端点**（`POST members/update` 要 `members:manage`，
 *   `POST members/roles` 要 `roles:assign`），而每次成功写入都会把该人员的
 *   `version` 加一。**用同一个 `expected_version` 连发两条，第二条必然 409**
 *   （`version_conflict`）——页面上的表现只是「角色没保存上」。
 *   这类顺序错误写在模板里既看不出来、SSR 也断言不到，所以放在这里用 `bun test` 钉住。
 *
 * ★ 两处权限是**分开**的：没有 `roles:assign` 的人根本不该提交角色
 *   （服务端会 403，而页面看起来像「保存失败」）。所以计划里角色那一维直接缺席，
 *   而不是先发出去再补救。
 */
import {
  validateName, type PortalMember, type PortalMemberResult, type PortalMemberRolesRequest,
  type PortalMutationResult, type PortalUpdateMemberRequest,
} from '@ai-token-report/shared'
import type { ApiResult } from '../api/request.js'

/**
 * 编辑弹框收集到的草稿。
 *
 * ⚠️ 三项都是**全量集合**（全量替换），不是增量：给的就是保存后该人员应有的
 *   完整归属。增量语义下「移除最后一个分组」与「没填这项」在请求体里长得一模一样。
 */
export interface MemberEditDraft {
  name: string
  group_ids: string[]
  role_ids: string[]
}

export type MemberEditPlan =
  | { ok: true; changed: boolean; profile: boolean; roles: boolean; name: string; group_ids: string[] }
  | { ok: false; reason: string }

/**
 * 集合比较。
 *
 * ★ 多选框的**选中顺序不是语义**：同一个人的同一批分组，换个顺序仍是「没改」，
 *   按数组逐位比较会平白多发一次请求、把版本号推高一次。
 */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left), b = new Set(right)
  return a.size === b.size && [...a].every((value) => b.has(value))
}

/**
 * 算出「这次到底要改哪几维」。
 *
 * - `profile` = 姓名或分组有变（走 `members:manage` 那条端点）
 * - `roles` = 角色有变**且**这个操作者有权分配角色
 */
export function planMemberEdit(member: PortalMember, draft: MemberEditDraft, canAssignRoles: boolean): MemberEditPlan {
  const name = draft.name.trim()
  const validation = validateName(name)
  if (!validation.ok) return { ok: false, reason: validation.reason ?? '姓名不合法' }
  // ★ 服务端 `setRoleRows` 拒绝空角色（「人员至少需要一个角色」）：
  //   这里先拦一道，让「把角色清空了」在页面上是一句能看懂的话，而不是一次 400。
  if (canAssignRoles && !draft.role_ids.length) return { ok: false, reason: '人员至少需要一个角色' }
  const profile = name !== member.name || !sameSet(draft.group_ids, member.groups.map((group) => group.group_id))
  const roles = canAssignRoles && !sameSet(draft.role_ids, member.roles.map((role) => role.role_id))
  return { ok: true, changed: profile || roles, profile, roles, name, group_ids: [...draft.group_ids] }
}

/**
 * 提交所需的三个动作，由调用方注入（`store.mutate` 与 `api/*`）。
 *
 * ★ 这里不直接 import store：注入之后这段顺序逻辑能用**真实 store + 假 HTTP** 断言，
 *   而那正是能发现「第二条拿了旧版本号」的唯一办法。
 */
export interface MemberEditActions {
  mutate: <T extends PortalMutationResult>(action: () => Promise<ApiResult<T>>, id: string) => Promise<T | null>
  updateProfile: (input: PortalUpdateMemberRequest) => Promise<ApiResult<PortalMemberResult>>
  updateRoles: (input: PortalMemberRolesRequest) => Promise<ApiResult<PortalMemberResult>>
}

/**
 * 结果里的 `reason` 有两种含义，调用方必须分开处理：
 * - **字符串** = 本地判断拦下的（姓名非法、角色被清空），页面要把它显示出来；
 * - **`null`** = 请求失败，原因已经由 store 写在 `error` 上（版本冲突还有专门文案），
 *   页面**不要覆盖**它 —— 覆盖等于把「这一行过期了，请刷新」换成一句更没用的话。
 */
export type MemberEditOutcome = { ok: true; changed: boolean } | { ok: false; reason: string | null }

export async function submitMemberEdit(
  actions: MemberEditActions,
  member: PortalMember,
  draft: MemberEditDraft,
  canAssignRoles: boolean,
): Promise<MemberEditOutcome> {
  const plan = planMemberEdit(member, draft, canAssignRoles)
  if (!plan.ok) return { ok: false, reason: plan.reason }
  // 一个字段都没改就不发请求：白写一次会平白推高 `version`，
  // 让正在编辑同一行的另一个人下一次保存撞 409。
  if (!plan.changed) return { ok: true, changed: false }
  let version = member.version
  if (plan.profile) {
    const saved = await actions.mutate(() => actions.updateProfile({
      member_id: member.member_id, expected_version: version, name: plan.name, group_ids: plan.group_ids,
    }), member.member_id)
    if (!saved) return { ok: false, reason: null }
    // 🚨 第二条必须用**服务端返回的**新版本号：写入成功即 `version + 1`（`touchMember`）。
    version = saved.member?.version ?? version
  }
  if (plan.roles) {
    const saved = await actions.mutate(() => actions.updateRoles({
      member_id: member.member_id, expected_version: version, role_ids: [...draft.role_ids],
    }), member.member_id)
    if (!saved) return { ok: false, reason: null }
  }
  return { ok: true, changed: true }
}
