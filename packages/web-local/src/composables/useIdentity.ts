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
 *    │     ├─ signed=true  → 统计页（不再弹框）
 *    │     └─ signed=false → 统计页 + ★ 自动弹出「配置」弹框
 *    │            │
 *    │            ├─ 提交配置 → 服务端校验 appKey → 通过则关闭弹框
 *    │            └─ 跳过     → 关掉弹框，**不采集也不上报**（本机用量照看）
 *    │
 *    └─ 请求失败（服务未启动）→ 显示错误，不显示配置弹框
 * ```
 *
 * ★ 最后一条很重要：如果本地服务没起来，弹出配置弹框会让用户填完才发现
 *   「保存失败」。先确认服务可达，再决定展示什么。
 *
 * ★ 未署名不再等于「整页挡住」：统计页始终渲染，弹框只是压在上面的一层
 *   （见 `IdentityGate.vue` 的说明）。
 */

import { onMounted, ref } from 'vue'

import { fetchIdentity } from '@/api/identity'

/** 页面当前应该展示什么。 */
export type GateState =
  | { kind: 'loading' }
  /** 弹出配置框。hint 来自服务端，便于统一措辞。 */
  | { kind: 'signin'; hint: string | null; baseUrl: string | null }
  /** 已署名，进统计页 */
  | { kind: 'ready'; name: string; group: string | null; baseUrl: string | null }
  /** 用户选择跳过 —— 统计页可用，但不采集不上报 */
  | { kind: 'skipped'; baseUrl: string | null }
  /** 无法连接本地服务 */
  | { kind: 'error'; message: string }

export function useIdentity() {
  const state = ref<GateState>({ kind: 'loading' })

  /**
   * 本次会话是否已经跳过配置。
   *
   * ★ 初值是 `false`：**未配置身份时首屏就弹出配置框**（与本页的形态一致 ——
   *   弹框压在统计页上方，一键「暂不填写，只看本机统计」即可关掉，
   *   关掉之后本次会话不再自动弹）。想再配就点右上角「配置」。
   *
   * ⚠️ 这个「跳过」**只记在内存里**，不落盘：它是个 UI 偏好，
   *   而落盘意味着多一份要跟身份 / 连接一起解释的状态。刷新页面会再弹一次 ——
   *   这正是我们想要的（未配置 = 还在提示）。
   */
  let skippedThisSession = false

  /**
   * 最近一次从服务端读到的生效地址。
   *
   * ★ 需要它是因为「跳过」那条路不带任何载荷：弹框关掉之后，用户再点「配置」
   *   时地址栏还应该回填同一份值，否则每开一次都要重敲一遍地址。
   */
  let baseUrlSeen: string | null = null

  async function load(): Promise<void> {
    const res = await fetchIdentity()

    if (!res.ok) {
      state.value = { kind: 'error', message: res.error }
      return
    }

    baseUrlSeen = res.data.baseUrl

    if (res.data.signed && res.data.name) {
      // `/api/local/identity` 的字段在 shared 里已改名成 `group`（无 `dept` 别名），
      // 所以本地页只认新名 —— 旧客户端的兼容读取发生在服务端与 shared，不在这里。
      state.value = { kind: 'ready', name: res.data.name, group: res.data.group, baseUrl: baseUrlSeen }
      return
    }

    // 用户已跳过 → 保持跳过状态，不再重复弹配置框
    if (skippedThisSession) {
      state.value = { kind: 'skipped', baseUrl: baseUrlSeen }
      return
    }

    state.value = { kind: 'signin', hint: res.data.hint, baseUrl: baseUrlSeen }
  }

  /** 配置弹框提交成功 */
  function onSigned(payload: { name: string; group?: string; baseUrl?: string }): void {
    if (!payload.name) {
      // name 为空 = 用户点了「跳过」/「返回我的用量」
      skippedThisSession = true
      state.value = { kind: 'skipped', baseUrl: payload.baseUrl ?? baseUrlSeen }
      return
    }
    baseUrlSeen = payload.baseUrl ?? baseUrlSeen
    state.value = { kind: 'ready', name: payload.name, group: payload.group ?? null, baseUrl: baseUrlSeen }
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
