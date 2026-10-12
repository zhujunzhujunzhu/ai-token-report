/** 流式输出只在用户愿意跟随时滚底；隐藏与布局变化不伪装成用户上翻。 */
import { expect, test } from 'bun:test'
import { createAssistantScrollState } from '../src/utils/assistantScroll.js'

test('初始跟随，短内容与离底四十像素都视为最新位置', () => {
  const scroll = createAssistantScrollState()
  expect(scroll.state()).toEqual({ following: true, away: false })
  expect(scroll.observe({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toEqual({ following: true, away: false })
  expect(scroll.observe({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('流式内容增高不会暂停跟随，程序回最新记录实际底部', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 700, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: true, away: true })
  expect(scroll.jumpToLatest({ scrollTop: 700, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: true, away: false })
  expect(scroll.observe({ scrollTop: 900, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: true, away: false })
  // 跳转后的新一帧先增高，当前位置不变仍是跟随，不受旧位置干扰。
  expect(scroll.observe({ scrollTop: 900, scrollHeight: 1400, clientHeight: 300 })).toEqual({ following: true, away: true })
})

test('上翻暂停，继续输出与向下翻但未到底都保留阅读位置', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 640, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 640, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 800, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 860, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('容忍一像素布局抖动，更明显的上移才暂停', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  scroll.observe({ scrollTop: 700, scrollHeight: 1300, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 699, scrollHeight: 1300, clientHeight: 300 }).following).toBe(true)
  expect(scroll.observe({ scrollTop: 697.9, scrollHeight: 1300, clientHeight: 300 }).following).toBe(false)
})

test('用户上滚意图可在流式布局变化之前即刻暂停', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.pause()).toEqual({ following: false, away: false })
  // 布局回调可能早于原生滚动动画，静止的旧底部不能抹掉上滚意图。
  expect(scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: false })
  expect(scroll.observe({ scrollTop: 700, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.jumpToLatest({ scrollTop: 700, scrollHeight: 1200, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('底部四十像素内明确上移也暂停，停留不恢复，慢速向下也恢复', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 680, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: false })
  expect(scroll.observe({ scrollTop: 680, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: false })
  expect(scroll.observe({ scrollTop: 680.5, scrollHeight: 1000, clientHeight: 300 }).following).toBe(true)
  expect(scroll.observe({ scrollTop: 690, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('暂停后逐次半像素向下，慢速进入底部阈值即可恢复', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  scroll.observe({ scrollTop: 659, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 659.5, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('隐藏浮窗不改状态与上次位置，重新显示仍能识别上翻', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toEqual({ following: true, away: false })
  expect(scroll.observe({ scrollTop: 650, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toEqual({ following: false, away: true })
  expect(scroll.observe({ scrollTop: 650, scrollHeight: 1000, clientHeight: 300 })).toEqual({ following: false, away: true })
})

test('布局缩小不会暂停跟随，内容收缩夹到新底部恢复跟随', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 })).toEqual({ following: true, away: true })
  scroll.pause()
  expect(scroll.observe({ scrollTop: 700, scrollHeight: 800, clientHeight: 300 })).toEqual({ following: true, away: false })
})

test('切换会话重置跟随，新会话不与旧滚动位置比较', () => {
  const scroll = createAssistantScrollState()
  scroll.observe({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })
  scroll.observe({ scrollTop: 500, scrollHeight: 1000, clientHeight: 300 })
  expect(scroll.reset()).toEqual({ following: true, away: false })
  expect(scroll.observe({ scrollTop: 0, scrollHeight: 1400, clientHeight: 300 })).toEqual({ following: true, away: true })
})

test('状态快照不能由调用者修改，隐藏时回最新不记录虚假几何', () => {
  const scroll = createAssistantScrollState()
  const snapshot = scroll.state()
  snapshot.following = false; snapshot.away = true
  expect(scroll.state()).toEqual({ following: true, away: false })
  scroll.jumpToLatest({ scrollTop: 0, scrollHeight: 1400, clientHeight: 0 })
  expect(scroll.observe({ scrollTop: 500, scrollHeight: 1400, clientHeight: 300 })).toEqual({ following: true, away: true })
})
