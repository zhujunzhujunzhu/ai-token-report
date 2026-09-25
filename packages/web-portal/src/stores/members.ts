/** 管理员凭证状态。请求结果只可写回发起请求的同一会话，退出立即清空敏感数据。 */
import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  AdminIssueMemberRequest,
  AdminMember,
  AdminMemberResponse,
  UserRole,
} from '@ai-token-report/shared'
import {
  fetchMembers,
  setLoginAccount,
  issueMember,
  revokeMember,
  rotateMember,
  updateMember,
} from '../api/admin.js'
import type { ApiResult } from '../api/request.js'
import { useSessionStore } from './session.js'

export const useMembersStore = defineStore('portal-members', () => {
  const session = useSessionStore()
  const members = ref<AdminMember[]>([])
  const credentialsPath = ref('')
  const writable = ref(false)
  const writeBlockedReason = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const forbidden = ref<string | null>(null)
  const busyToken = ref<string | null>(null)
  const issuing = ref(false)
  const justIssued = ref<AdminMember | null>(null)
  let revision = 0
  let loadSeq = 0

  function clear(): void {
    ++revision
    ++loadSeq
    members.value = []
    credentialsPath.value = ''
    writable.value = false
    writeBlockedReason.value = null
    error.value = null
    forbidden.value = null
    busyToken.value = null
    issuing.value = false
    justIssued.value = null
    loading.value = false
  }
  function failure(result: { status: number; error: string }): void {
    if (result.status === 401) session.expire('登录已失效，请重新登录')
    else if (result.status === 403) {
      clear()
      forbidden.value = '当前身份没有人员管理权限，请联系管理员'
      session.identity = session.identity
        ? { ...session.identity, role: 'member' }
        : null
    } else {
      error.value =
        result.status === 503 ? `服务端暂未就绪：${result.error}` : result.error
      writable.value = false
    }
  }
  async function load(): Promise<void> {
    if (
      !session.isAdmin ||
      !session.signedIn ||
      busyToken.value ||
      issuing.value
    )
      return
    const current = revision
    const seq = ++loadSeq
    loading.value = true
    error.value = null
    const result = await fetchMembers()
    if (current !== revision || seq !== loadSeq) return
    loading.value = false
    if (!result.ok) {
      failure(result)
      return
    }
    members.value = result.data.members
    credentialsPath.value = result.data.credentialsPath
    writable.value = result.data.writable
    writeBlockedReason.value = result.data.writeBlockedReason
  }
  async function mutate(
    action: () => Promise<ApiResult<AdminMemberResponse>>,
    memberToken?: string,
    issued = false,
  ): Promise<boolean> {
    if (
      !session.isAdmin ||
      !session.signedIn ||
      !writable.value ||
      loading.value ||
      busyToken.value ||
      issuing.value
    )
      return false
    const current = revision
    ++loadSeq
    if (memberToken) busyToken.value = memberToken
    else issuing.value = true
    error.value = null
    const result = await action()
    if (current !== revision) return false
    busyToken.value = null
    issuing.value = false
    if (!result.ok) {
      failure(result)
      return false
    }
    if (!result.data.ok) {
      error.value = result.data.reason ?? '操作失败，请重试'
      return false
    }
    if (issued && result.data.member) justIssued.value = result.data.member
    await load()
    return true
  }
  const issue = (input: AdminIssueMemberRequest) =>
    mutate(() => issueMember(input), undefined, true)
  const rotate = (token: string) =>
    mutate(() => rotateMember(token), token, true)
  const revoke = (token: string) => mutate(() => revokeMember(token), token)
  const updateRole = (token: string, role: UserRole) =>
    mutate(() => updateMember({ token, role }), token)
  const setLogin = (
    input: import('@ai-token-report/shared').AdminLoginAccountRequest,
  ) => mutate(() => setLoginAccount(input), input.token)
  function dismissIssued(): void {
    justIssued.value = null
  }
  watch(() => session.generation, clear, { flush: 'sync' })

  return {
    members,
    credentialsPath,
    writable,
    writeBlockedReason,
    loading,
    error,
    forbidden,
    busyToken,
    issuing,
    justIssued,
    load,
    issue,
    rotate,
    revoke,
    updateRole,
    dismissIssued,
    setLogin,
    clear,
  }
})
