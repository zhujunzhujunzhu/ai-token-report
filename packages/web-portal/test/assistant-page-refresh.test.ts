/** 助手修改与管理页旧响应并发时，新状态必须在加载后再次读取。 */
import { expect, test } from 'bun:test'
import { createAssistantRefreshQueue } from '../src/utils/assistantPageSearch.js'

test('加载中多次修改合并为结束后一次刷新，第二次加载仍能接收后续修改', () => {
  let loading = true, reads = 0
  const queue = createAssistantRefreshQueue(() => { reads++; loading = true }, () => loading)
  queue.request(); queue.request(); queue.flush()
  expect(reads).toBe(0)
  loading = false
  queue.flush()
  expect(reads).toBe(1)
  queue.request(); queue.request()
  expect(reads).toBe(1)
  loading = false
  queue.flush(); queue.flush()
  expect(reads).toBe(2)
})

test('空闲页面立即刷新，没有修改事件时不额外读取', () => {
  let reads = 0
  const queue = createAssistantRefreshQueue(() => { reads++ }, () => false)
  queue.flush()
  expect(reads).toBe(0)
  queue.request()
  expect(reads).toBe(1)
  queue.flush()
  expect(reads).toBe(1)
})
