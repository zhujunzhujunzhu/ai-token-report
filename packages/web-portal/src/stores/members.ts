/** 数据库人员与凭证状态。会话切换丢弃迟到响应，退出立即清空一次性秘密。 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  PortalAppKeyEntry, PortalMember, PortalRole, PortalPermission, PortalGroup, PortalStorageResponse,
  PortalMutationResult, PortalTokenResult, PortalAuditEntry,
} from '@ai-token-report/shared'
import * as api from '../api/admin.js'
import type { ApiResult } from '../api/request.js'
import { useSessionStore } from './session.js'

export type ManagementSection = 'members' | 'roles' | 'groups'

export const useMembersStore = defineStore('portal-members', () => {
  const session = useSessionStore()
  const members = ref<PortalMember[]>([])
  const roles = ref<PortalRole[]>([])
  /**
   * 可授予的权限目录，随角色目录一起下发。
   *
   * ★ 它只用于**渲染勾选项**，不参与任何鉴权判断：真正的门禁是服务端
   *   `subset()`（授予不得超出操作者本次权限）。页面按它勾出来的集合
   *   如果超权，服务端会明确拒绝，而不是静默截断。
   */
  const permissions = ref<PortalPermission[]>([])
  /**
   * 分组目录（管理接口 `/api/v1/groups`）。
   *
   * ★ 与看板的 `dashboard.groupOptions`（`/api/v1/stats/groups`）**不是同一份**：
   *   这里带版本号与启停状态，供人员建档 / 改归属时选择；那里只有候选项。
   *   能读人员的人未必有 `groups:read`，两处权限各自独立，所以两处都读各自的接口。
   */
  const groups = ref<PortalGroup[]>([])
  /**
   * appKey 管理页的主体列表：跨人员，一行一把凭证。
   *
   * ★ 凭证只有这一份视图了 —— 人员页不再展示或签发凭证（那里只管
   *   资料、角色与登录账号）。按人查凭证改用本列表的搜索框。
   */
  const appKeys = ref<PortalAppKeyEntry[]>([])
  const audits = ref<PortalAuditEntry[]>([])
  const storage = ref<PortalStorageResponse | null>(null)
  const loading = ref(false)
  const appKeysLoading = ref(false)
  const busyId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const forbidden = ref<string | null>(null)
  const issuedSecret = ref<string | null>(null)
  let revision = 0
  let loadSeq = 0
  let appKeySeq = 0
  let activeSection: ManagementSection = 'members'
  function dismissSecret(): void { issuedSecret.value = null }
  function clear(): void {
    revision++; loadSeq++; appKeySeq++
    members.value = []; roles.value = []; groups.value = []; appKeys.value = []; audits.value = []
    permissions.value = []
    storage.value = null; loading.value = false; appKeysLoading.value = false
    busyId.value = null; error.value = null; forbidden.value = null; dismissSecret()
    activeSection = 'members'
  }
  /**
   * `409` 有两种含义，只有带 `version_conflict` 的才是「本地这一行过期了」。
   *
   * ⚠️ 另一类是**状态不允许这个动作**：最后管理员护栏、已上报过的凭证不能删除。
   *   把它们一起渲染成「资料已被其他操作更新，请刷新后重新确认」，等于让使用者
   *   照着一句永远不成立的提示反复刷新 —— 而真正的原因（该改用吊销）就在
   *   服务端的 `reason` 里，白白丢掉。
   */
  function isVersionConflict(result: { status: number; code?: string }): boolean {
    return result.status === 409 && result.code === 'version_conflict'
  }
  function failure(result: { status: number; error: string; code?: string }): void {
    if (result.status === 401) session.expire('登录已失效，请重新登录')
    else {
      error.value = isVersionConflict(result) ? '资料已被其他操作更新，请刷新后重新确认。' : result.error
      if (result.status === 403) forbidden.value = result.error
    }
  }
  async function load(section: ManagementSection = activeSection): Promise<void> {
    activeSection = section
    const current = revision, seq = ++loadSeq
    // 每页只读自身所需目录；独立查看角色或分组不应触发人员、数据库权限校验。
    if (!session.can(`${section}:read`)) { loading.value = false; return }
    const readMembers = section !== 'groups' && session.can('members:read')
    const readRoles = section !== 'groups' && session.can('roles:read')
    const readGroups = section !== 'roles' && session.can('groups:read')
    const readStorage = section === 'members' && session.can('members:read')
    loading.value = true
    const results = await Promise.all([
      readMembers ? api.fetchMembers() : null,
      readRoles ? api.fetchRoles() : null,
      readGroups ? api.fetchGroups() : null,
      readStorage ? api.fetchStorage() : null,
    ])
    if (current !== revision || seq !== loadSeq) return
    loading.value = false
    const [people, catalog, groupList, db] = results
    // 并发接口中任意一个发现会话失效，就丢弃这一轮全部数据，不能在清理后又回填名单。
    const expired = results.find((result) => result && !result.ok && result.status === 401)
    if (expired && !expired.ok) { failure(expired); return }
    for (const result of results) if (result && !result.ok) failure(result)
    if (people?.ok) members.value = people.data.members
    if (catalog?.ok) { roles.value = catalog.data.roles; permissions.value = catalog.data.permissions ?? [] }
    if (groupList?.ok) groups.value = groupList.data.groups
    if (db?.ok) storage.value = db.data
  }
  async function loadAppKeys(): Promise<void> {
    // ⚠️ 没有 `tokens:manage` 就不发请求：服务端一定回 403，把它渲染成
    //   一条错误提示，只会让人以为「系统坏了」而不是「这个入口不该给我」。
    if (!session.can('tokens:manage')) return
    const current = revision, seq = ++appKeySeq
    appKeysLoading.value = true
    const result = await api.fetchAppKeys()
    if (current !== revision || seq !== appKeySeq) return
    appKeysLoading.value = false
    if (result.ok) appKeys.value = result.data.appkeys
    else failure(result)
  }
  async function loadAudit(): Promise<void> {
    const current = revision
    const result = await api.fetchAudit()
    if (current !== revision) return
    if (result.ok) audits.value = result.data.rows
    else failure(result)
  }
  async function mutate<T extends PortalMutationResult>(action: () => Promise<ApiResult<T>>, id: string): Promise<T | null> {
    if (!session.signedIn || busyId.value) return null
    const current = revision
    busyId.value = id; error.value = null; forbidden.value = null
    const result = await action()
    if (current !== revision) return null
    busyId.value = null
    if (!result.ok) {
      failure(result)
      // 版本冲突意味着本地这一行已经过期，重载列表后才能再试。
      // ⚠️ 只对 `version_conflict` 重载：另一类 409（护栏、被引用的凭证）
      //    重载也改变不了结果，只会白读一次。
      if (isVersionConflict(result)) await load()
      return null
    }
    if (!result.data.ok) { error.value = result.data.reason ?? '操作失败'; return null }
    await load()
    return current === revision ? result.data : null
  }
  /**
   * 签发 / 轮换 / 吊销 appKey 的共同路径。
   *
   * ★ 明文只在成功的这一次响应里：Store 把它存进 `issuedSecret`，
   *   页面必须在同一轮把它展示并给出复制入口，关掉就只能轮换。
   */
  async function appKeyAction(action: () => Promise<ApiResult<PortalTokenResult>>, id: string): Promise<boolean> {
    dismissSecret()
    const result = await mutate(action, id)
    if (result) issuedSecret.value = result.token_secret ?? null
    // 成功要刷新列表；409 版本冲突也要刷新后才能重试。其余失败多读一次无害，
    // 不值得为省它再分一条分支 —— 那才是下次改错的地方。
    if (session.signedIn) await loadAppKeys()
    return result !== null
  }
  watch(() => session.generation, clear, { flush: 'sync' })
  return { members, roles, permissions, groups, appKeys, audits, storage, loading, appKeysLoading, busyId, error, forbidden,
    issuedSecret, load, loadAppKeys, loadAudit, mutate, appKeyAction, dismissSecret, clear }
})