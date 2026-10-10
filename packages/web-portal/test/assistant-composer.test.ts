/** 快捷键回归：输入法确认选字不能意外发送，换行也不能触发请求。 */
import { expect, test } from 'bun:test'
import { handleAssistantComposerKeydown } from '../src/utils/assistantComposer.js'

function press(overrides: Partial<Parameters<typeof handleAssistantComposerKeydown>[0]> = {}) {
  let sent = 0, lines = 0, prevented = false
  handleAssistantComposerKeydown({
    key: 'Enter', altKey: false, isComposing: false, keyCode: 13, repeat: false,
    preventDefault: () => { prevented = true }, ...overrides,
  }, { send: () => { sent++ }, newline: () => { lines++ } })
  return { sent, lines, prevented }
}
test('回车发送并阻止默认换行；Alt+Enter 只插入换行', () => {
  expect(press()).toEqual({ sent: 1, lines: 0, prevented: true })
  expect(press({ altKey: true })).toEqual({ sent: 0, lines: 1, prevented: true })
})
test('中文输入法选字与结束选字的 229 事件都交给输入法', () => {
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { altKey: true, isComposing: true }]) {
    expect(press(event)).toEqual({ sent: 0, lines: 0, prevented: false })
  }
})
test('按住回车不重复发送，其它按键正常编辑', () => {
  expect(press({ repeat: true })).toEqual({ sent: 0, lines: 0, prevented: true })
  expect(press({ key: 'a' })).toEqual({ sent: 0, lines: 0, prevented: false })
})
