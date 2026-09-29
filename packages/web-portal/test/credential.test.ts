/**
 * 凭证展示形态：中间省略号是**展示**的事，不是存储的事。
 *
 * 这组断言钉住两条容易悄悄退化的行为：
 * 1. 历史行存的旧格式 `…d5788739d349`（前导省略号）也要显示成中间省略号 ——
 *    否则列表里会同时出现两种形态，而没人会为此改一次数据。
 * 2. `tokenHint` 是幂等的：对已经是中间省略号的值再调一次，结果不变。
 */
import { describe, expect, test } from 'bun:test'
import { maskSecret, tokenHint } from '../src/utils/credential.js'

describe('凭证展示', () => {
  test('摘要提示把省略号挪到中间', () => {
    expect(tokenHint('d5788739d349')).toBe('d57887…39d349')
    expect(tokenHint('d57887…39d349')).toBe('d57887…39d349')
  })
  test('旧格式的前导省略号被重排而不是保留', () => {
    expect(tokenHint('…d5788739d349')).toBe('d57887…39d349')
  })
  test('太短的值不假装被截断', () => {
    expect(tokenHint('atr')).toBe('atr')
    expect(tokenHint('')).toBe('')
  })
  test('明文遮罩保留首尾可比对，且不泄露完整值', () => {
    const secret = 'atr-' + 'a1b2c3d4'.repeat(6)
    const masked = maskSecret(secret)
    expect(masked).toBe('atr-a1b2…c3d4')
    expect(secret.startsWith(masked.slice(0, 8))).toBe(true)
    expect(masked).not.toBe(secret)
  })
  test('短到遮不出信息量的值原样返回', () => {
    expect(maskSecret('atr-演示凭证')).toBe('atr-演示凭证')
  })
})