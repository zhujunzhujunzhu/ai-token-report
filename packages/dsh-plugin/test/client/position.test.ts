/**
 * 面板落点信号总线（浏览器半）。
 *
 * 它是「设置页保存位置 → 面板就地换地方」的唯一通路，而这条通路**断了是静默的**：
 * 页面看起来一切正常，只是位置没变。所以这里把它的语义钉死：
 * 先记后播、退订幂等、单个订阅者抛错不影响别人。
 */
import { beforeEach, expect, test } from 'bun:test'

import {
  applyPosition,
  currentPosition,
  onPositionApplied,
  resetPositionBus,
} from '../../src/client/position.js'
import type { UiPosition } from '../../src/client/protocol.js'

beforeEach(() => resetPositionBus())

test('广播新位置，并且**先记后播**（回调里问到的就是新值）', () => {
  const seen: (UiPosition | null)[] = []
  onPositionApplied(() => seen.push(currentPosition()))
  applyPosition('header')
  expect(seen).toEqual(['header'])
  expect(currentPosition()).toBe('header')
})

test('一次都没应用过时是 null（而不是假装成了默认值）', () => {
  expect(currentPosition()).toBeNull()
})

test('退订后不再收到通知，且重复退订不炸', () => {
  let count = 0
  const off = onPositionApplied(() => { count += 1 })
  applyPosition('dock')
  off()
  off()
  applyPosition('both')
  expect(count).toBe(1)
})

test('多个订阅者都收到；其中一个抛错不妨碍其余的（一个面板坏了不该拖垮整条通知）', () => {
  const seen: string[] = []
  onPositionApplied(() => { throw new Error('boom') })
  onPositionApplied((position) => seen.push(position))
  applyPosition('both')
  expect(seen).toEqual(['both'])
})

test('遍历期间退订不会漏掉后面的订阅者（回调里就地退订是常见写法）', () => {
  const seen: string[] = []
  const off = onPositionApplied((position) => { seen.push(`a:${position}`); off() })
  onPositionApplied((position) => seen.push(`b:${position}`))
  applyPosition('header')
  expect(seen).toEqual(['a:header', 'b:header'])
})