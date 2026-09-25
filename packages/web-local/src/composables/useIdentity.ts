/**
 * 署名状态编排。
 *
 * ## 页面启动流程
 *
 * ```
 * 打开页面
 *    │
 *    ├─ GET /api/local/identity
 *    │     │
 *    │     ├─ signed=true  → 直接进统计页
 *    │     └─ signed=false → 直接看本机统计，主动点击署名才显示引导页
 *    │            │
 *    │            ├─ 提交署名 → 服务端校验 token → 通过则进统计页
 *    │            └─ 跳过     → 进统计页，但**不采集也不上报**
 *    │
 *    └─ 请求失败（服务未启动）→ 显示错误，不显示引导页
 * ```
 *
 * ★ 最后一条很重要：如果本地服务没起来，显示引导页会让用户填完才发现
 *   「保存失败」。先确认服务可达，再决定展示什么。
 */

import { onMounted, ref } from 'vue'

import { fetchIdentity } from '@/api/identity'

/** 页面当前应该展示什么。 */
export type GateState =
  | { kind: 'loading' }
  /** 引导页。hint 来自服务端，便于统一措辞。 */
  | { kind: 'signin'; hint: string | null }
  /** 已署名，进统计页 */
  | { kind: 'ready'; name: string; dept: string | null }
  /** 用户选择跳过 —— 统计页可用，但不采集不上报 */
  | { kind: 'skipped' }
  /** 无法连接本地服务 */
  | { kind: 'error'; message: string }

export function useIdentity() {
  const state = ref<GateState>({ kind: 'loading' })

  /** 默认直接查看本机统计，署名仅在用户主动打开时展示。 */
  let skippedThisSession = true

  async function load(): Promise<void> {
    const res = await fetchIdentity()

    if (!res.ok) {
      state.value = { kind: 'error', message: res.error }
      return
    }

    if (res.data.signed && res.data.name) {
      state.value = { kind: 'ready', name: res.data.name, dept: res.data.dept }
      return
    }

    // 用户已跳过 → 保持跳过状态，不再重复弹引导
    if (skippedThisSession) {
      state.value = { kind: 'skipped' }
      return
    }

    state.value = { kind: 'signin', hint: res.data.hint }
  }

  /** 引导页提交成功 */
  function onSigned(payload: { name: string; dept?: string }): void {
    if (!payload.name) {
      // name 为空 = 用户点了「跳过」
      skippedThisSession = true
      state.value = { kind: 'skipped' }
      return
    }
    state.value = { kind: 'ready', name: payload.name, dept: payload.dept ?? null }
  }

  /** 重新检查（用户在别处改了署名后） */
  async function refresh(): Promise<void> {
    skippedThisSession = false
    state.value = { kind: 'loading' }
    await load()
  }

  onMounted(() => {
    void load()
  })

  return { state, onSigned, refresh }
}
