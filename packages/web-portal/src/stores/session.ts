/** 后台会话只保存公开身份；认证凭据由 HttpOnly Cookie 管理。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { post, request } from '../api/request.js'
import type {
  PortalLoginRequest,
  PortalViewer,
  PortalSessionResponse,
} from '@ai-token-report/shared'

export type PortalIdentity = PortalViewer
export const useSessionStore = defineStore('portal-session', () => {
  const identity = ref<PortalViewer | null>(null)
  const checking = ref(false)
  const initialized = ref(false)
  const error = ref<string | null>(null)
  // 每次会话更换都递增，统计与人员 Store 据此丢弃迟到响应。
  const generation = ref(0)
  const signedIn = computed(() => identity.value !== null)
  function can(permission: string): boolean { return identity.value?.permissions?.includes(permission) ?? false }
  const isAdmin = computed(() => can('members:read'))
  let revision = 0
  let restoring: Promise<void> | null = null

  function accept(data: PortalSessionResponse): boolean {
    if (!data.ok || !data.viewer?.name || !data.viewer?.username) return false
    identity.value = {
      ...data.viewer,
      role: data.viewer.role === 'admin' ? 'admin' : 'member',
    }
    generation.value++
    return true
  }
  async function signIn(input: PortalLoginRequest): Promise<boolean> {
    const current = ++revision
    checking.value = true
    error.value = null
    const result = await post<PortalSessionResponse>(
      '/api/v1/auth/login',
      input,
    )
    if (current !== revision) return false
    checking.value = false
    initialized.value = true
    if (!result.ok || !accept(result.data)) {
      identity.value = null
      error.value = result.ok
        ? (result.data.reason ?? '登录响应无效，请重试')
        : result.error
      return false
    }
    return true
  }
  async function restore(): Promise<void> {
    if (initialized.value) return
    if (restoring) return restoring
    const current = revision
    // 迁移旧版本：删除浏览器曾保存的上报 Token。
    try {
      localStorage.removeItem('atr.portal.token')
    } catch {
      /* 隐私模式 */
    }
    restoring = (async () => {
      const result = await request<PortalSessionResponse>(
        '/api/v1/auth/session',
      )
      if (current !== revision) return
      if (result.ok) accept(result.data)
      else if (result.status !== 401) error.value = result.error
      initialized.value = true
    })()
    try {
      await restoring
    } finally {
      restoring = null
    }
  }
  function expire(reason?: string): void {
    ++revision
    identity.value = null
    generation.value++
    checking.value = false
    initialized.value = true
    error.value = reason ?? null
  }
  async function signOut(): Promise<boolean> {
    const result = await post<PortalSessionResponse>('/api/v1/auth/logout', {})
    if (!result.ok) {
      error.value = '退出未完成：' + result.error
      return false
    }
    expire()
    return true
  }
  return {
    identity,
    generation,
    checking,
    initialized,
    error,
    signedIn,
    isAdmin,
    can,
    signIn,
    signOut,
    expire,
    restore,
  }
})
