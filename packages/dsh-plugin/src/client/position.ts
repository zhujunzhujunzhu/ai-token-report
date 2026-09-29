/**
 * 面板落点的**进程内广播**（浏览器半）。
 *
 * ## 为什么需要一个模块级的信号总线
 *
 * 设置页改完位置后，面板要**就地**换地方（不必刷新页面、不必重启 DSH）。
 * 但这两件事在组件树上离得很远：
 *
 * ```
 * apply()（挂载逻辑，决定注册哪些 slot）
 *    └─ UsageDock / UsageBadge（slot 组件）
 *         └─ UsageDialog → SettingsPanel（设置页，用户点「保存」的地方）
 * ```
 *
 * 把回调一层层透传下去意味着给三个组件加一个纯管道性质的 prop，
 * 而且 `UsageDock` 与 `UsageBadge` 是**两个**入口（`both` 模式下同时存在），
 * 任何一条链路漏了就变成「改了位置但界面没动」——又一个静默失败。
 *
 * 所以这里用一个极小的模块级总线：`apply()` 订阅一次，
 * 设置页保存成功后 `applyPosition()` 一次。同一份产物内必然连通。
 *
 * ## 边界
 *
 * - 只存「最近一次生效的位置」，不存历史、不做持久化 ——
 *   真值在宿主的 `plugin-connection.json` 里，这里只是回声。
 * - 订阅者抛错不影响其它订阅者（一个面板组件坏了不该拖垮整条通知）。
 */

import type { UiPosition } from './protocol.js'

type Listener = (position: UiPosition) => void

const listeners = new Set<Listener>()

/** 最近一次被应用的位置（用于诊断与「刚刚切换过」的提示）。 */
let applied: UiPosition | null = null

/**
 * 订阅位置变更。
 *
 * @returns 退订函数（**幂等**：重复调用不会重复减计数）。
 */
export function onPositionApplied(listener: Listener): () => void {
  listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
  }
}

/**
 * 广播一个新的落点，并记下它。
 *
 * ★ **先记后播**：这样即使某个订阅者（比如刚挂载完的那个）在回调里
 *   反过来问「现在是什么位置」，它读到的也是新值而不是旧值。
 */
export function applyPosition(position: UiPosition): void {
  applied = position
  for (const listener of [...listeners]) {
    try {
      listener(position)
    } catch {
      // 单个订阅者出问题不该让其它面板收不到通知
    }
  }
}

/** 最近一次生效的落点；一次都没应用过时为 `null`。 */
export function currentPosition(): UiPosition | null {
  return applied
}

/** 仅供测试：清空订阅者与已记录的位置。 */
export function resetPositionBus(): void {
  listeners.clear()
  applied = null
}