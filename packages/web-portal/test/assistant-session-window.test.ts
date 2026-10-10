/** 虚拟窗口须覆盖首尾与缩短后的视口；隐藏面板不能触发分页风暴。 */
import { expect, test } from 'bun:test'
import { assistantSessionWindow, assistantSessionsNearEnd } from '../src/utils/assistantSessionWindow.js'

test('万条历史只渲染视口与缓冲区，滚到末尾仍包含最后一条', () => {
  expect(assistantSessionWindow(10_000, 0, 400)).toEqual({ start: 0, end: 10, height: 640_000, offset: 0 })
  const middle = assistantSessionWindow(10_000, 320_000, 400)
  expect(middle.start).toBe(4997)
  expect(middle.end - middle.start).toBe(13)
  const end = assistantSessionWindow(10_000, 640_000, 400)
  expect(end.end).toBe(10_000)
  expect(end.start).toBe(9990)
})
test('空列表、短列表与尾部删除都产生有效窗口', () => {
  expect(assistantSessionWindow(0, 0, 400)).toEqual({ start: 0, end: 0, height: 0, offset: 0 })
  expect(assistantSessionWindow(2, 9999, 400)).toEqual({ start: 0, end: 2, height: 128, offset: 0 })
  const shortened = assistantSessionWindow(50, 6300, 400)
  expect(shortened.end).toBe(50)
  expect(shortened.start).toBeLessThan(shortened.end)
})
test('触底与视口未填满自动补页，隐藏面板和远离底部不加载', () => {
  expect(assistantSessionsNearEnd(50, 0, 400)).toBe(false)
  expect(assistantSessionsNearEnd(50, 2740, 400)).toBe(true)
  expect(assistantSessionsNearEnd(2, 0, 400)).toBe(true)
  expect(assistantSessionsNearEnd(50, 3200, 0)).toBe(false)
})
