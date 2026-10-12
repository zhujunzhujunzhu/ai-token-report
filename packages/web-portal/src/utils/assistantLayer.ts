/**
 * 全局助手的层级与焦点协作：业务弹框继续约束自己的键盘焦点，
 * 用户切到助手时暂停该约束，回到表单后恢复，避免浮窗看得见却输不了字。
 */
import type { FocusLayer } from 'element-plus/es/components/focus-trap/index.mjs'

// ★ 与普通业务浮层预留独立层级；助手自己的下拉和确认框必须再高一层。
export const ASSISTANT_Z_INDEX = 1_000_000
export const ASSISTANT_POPUP_Z_INDEX = ASSISTANT_Z_INDEX + 10

type FocusStack = { push: (layer: FocusLayer) => void; remove: (layer: FocusLayer) => void }

export function createAssistantFocusLayer(stack: FocusStack) {
  let active = false
  const layer: FocusLayer = {
    paused: false,
    pause() { layer.paused = true },
    resume() { layer.paused = false },
  }
  return {
    enter() {
      if (active && !layer.paused) return
      layer.resume()
      stack.push(layer)
      active = true
    },
    leave() {
      if (!active) return
      stack.remove(layer)
      active = false
    },
  }
}

export function assistantFocusTarget(target: EventTarget | null, root: HTMLElement | undefined): 'surface' | 'popup' | undefined {
  if (!root || !(target instanceof Node)) return
  if (root.contains(target)) return 'surface'
  const element = target instanceof Element ? target : target.parentElement
  if (element?.closest('.assistant-layer-popup')) return 'popup'
  // ⚠️ Element Plus 下拉默认 Teleport 到 body，不能只按 DOM 父子关系判断归属。
  for (const control of root.querySelectorAll('[aria-controls], [aria-owns], [aria-describedby]')) {
    for (const attribute of ['aria-controls', 'aria-owns', 'aria-describedby']) {
      for (const id of (control.getAttribute(attribute) ?? '').split(/\s+/)) {
        if (id && root.ownerDocument.getElementById(id)?.contains(target)) return 'popup'
      }
    }
  }
}
