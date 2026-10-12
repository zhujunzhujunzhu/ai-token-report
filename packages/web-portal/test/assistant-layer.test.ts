/** 助手与实际 Element Plus 焦点栈协作，避免提高层级后仍被弹框抢回输入。 */
import { expect, test } from 'bun:test'
import { focusableStack, type FocusLayer } from 'element-plus/es/components/focus-trap/index.mjs'
import { createAssistantFocusLayer } from '../src/utils/assistantLayer.js'

function dialogLayer(): FocusLayer {
  const layer: FocusLayer = {
    paused: false,
    pause() { layer.paused = true },
    resume() { layer.paused = false },
  }
  return layer
}

test('进入助手暂停业务弹框，离开后恢复同一个弹框的键盘约束', () => {
  const dialog = dialogLayer(), assistant = createAssistantFocusLayer(focusableStack)
  focusableStack.push(dialog)
  try {
    assistant.enter()
    expect(dialog.paused).toBe(true)
    assistant.enter()
    assistant.leave()
    expect(dialog.paused).toBe(false)
    assistant.leave()
    expect(dialog.paused).toBe(false)
  } finally {
    assistant.leave()
    focusableStack.remove(dialog)
  }
})

test('助手打开新业务弹框后，可再次进入助手且不会丢掉已有弹框栈', () => {
  const first = dialogLayer(), second = dialogLayer(), assistant = createAssistantFocusLayer(focusableStack)
  focusableStack.push(first)
  try {
    assistant.enter()
    focusableStack.push(second)
    expect(first.paused).toBe(true)
    assistant.enter()
    expect(second.paused).toBe(true)
    assistant.leave()
    expect(second.paused).toBe(false)
    expect(first.paused).toBe(true)
    focusableStack.remove(second)
    expect(first.paused).toBe(false)
  } finally {
    assistant.leave()
    focusableStack.remove(second)
    focusableStack.remove(first)
  }
})

test('助手自己的确认框拥有焦点，关闭后恢复助手，卸载恢复业务弹框', () => {
  const dialog = dialogLayer(), confirmation = dialogLayer(), assistant = createAssistantFocusLayer(focusableStack)
  focusableStack.push(dialog)
  try {
    assistant.enter()
    focusableStack.push(confirmation)
    expect(confirmation.paused).toBe(false)
    expect(dialog.paused).toBe(true)
    focusableStack.remove(confirmation)
    assistant.enter()
    expect(dialog.paused).toBe(true)
    assistant.leave()
    expect(dialog.paused).toBe(false)
  } finally {
    assistant.leave()
    focusableStack.remove(confirmation)
    focusableStack.remove(dialog)
  }
})
