/** 数据库人员状态。会话切换丢弃迟到响应，退出立即清空一次性秘密。 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  PortalMember, PortalRole, PortalDepartment, PortalReportToken, PortalStorageResponse,
  PortalMutationResult, PortalTokenResult, PortalAuditEntry,
} from '@ai-token-report/shared'
import * as api from '../api/admin.js'
import type { ApiResult } from '../api/request.js'
import { useSessionStore } from './session.js'

export const useMembersStore = defineStore('portal-members', () => {
  const session = useSessionStore()
  const members = ref<PortalMember[]>([])
  const roles = ref<PortalRole[]>([])
  const departments = ref<PortalDepartment[]>([])
  const tokens = ref<PortalReportToken[]>([])
  const audits = ref<PortalAuditEntry[]>([])
  const storage = ref<PortalStorageResponse | null>(null)
  const loading = ref(false)
  const busyId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const forbidden = ref<string | null>(null)
  const tokenMemberId = ref<string | null>(null)
  const issuedSecret = ref<string | null>(null)
  let revision = 0
  let loadSeq = 0
  let tokenSeq = 0
  function dismissSecret(): void { issuedSecret.value = null }
  function clear(): void {
    revision++; loadSeq++; tokenSeq++
    members.value = []; roles.value = []; departments.value = []; tokens.value = []; audits.value = []
    tokenMemberId.value = null; storage.value = null; loading.value = false
    busyId.value = null; error.value = null; forbidden.value = null; dismissSecret()
  }
  function failure(result: { status: number; error: string }): void {
    if (result.status === 401) session.expire('登录已失效，请重新登录')
    else {
      error.value = result.status === 409 ? '资料已被其他操作更新，请刷新后重新确认。' : result.error
      if (result.status === 403) forbidden.value = result.error
    }
  }
  async function load(): Promise<void> {
    if (!session.can('members:read')) return
    const current = revision, seq = ++loadSeq
    loading.value = true
    const results = await Promise.all([api.fetchMembers(), api.fetchRoles(), api.fetchDepartments(), api.fetchStorage()])
    if (current !== revision || seq !== loadSeq) return
    loading.value = false
    const [people, catalog, depts, db] = results
    // 并发接口中任意一个发现会话失效，就丢弃这一轮全部数据，不能在清理后又回填名单。
    const expired = results.find((result) => !result.ok && result.status === 401)
    if (expired && !expired.ok) { failure(expired); return }
    for (const result of results) if (!result.ok) failure(result)
    if (people.ok) members.value = people.data.members
    if (catalog.ok) roles.value = catalog.data.roles
    if (depts.ok) departments.value = depts.data.departments
    if (db.ok) storage.value = db.data
  }
  async function loadTokens(memberId: string): Promise<void> {
    const current = revision, seq = ++tokenSeq
    tokenMemberId.value = memberId; tokens.value = []
    const result = await api.fetchTokens(memberId)
    if (current !== revision || seq !== tokenSeq) return
    if (result.ok) tokens.value = result.data.tokens
    else failure(result)
  }
  function closeTokens(): void {
    tokenSeq++; tokenMemberId.value = null; tokens.value = []; dismissSecret()
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
      if (result.status === 409) {
        await load()
        if (tokenMemberId.value) await loadTokens(tokenMemberId.value)
      }
      return null
    }
    if (!result.data.ok) { error.value = result.data.reason ?? '操作失败'; return null }
    await load()
    return current === revision ? result.data : null
  }
  async function tokenAction(action: () => Promise<ApiResult<PortalTokenResult>>, memberId: string): Promise<boolean> {
    dismissSecret()
    const result = await mutate(action, memberId)
    if (!result) return false
    if (tokenMemberId.value === memberId) {
      issuedSecret.value = result.token_secret ?? null
      await loadTokens(memberId)
    }
    return true
  }
  watch(() => session.generation, clear, { flush: 'sync' })
  return { members, roles, departments, tokens, audits, storage, loading, busyId, error, forbidden,
    tokenMemberId, issuedSecret, load, loadTokens, closeTokens, loadAudit, mutate, tokenAction, dismissSecret, clear }
})
