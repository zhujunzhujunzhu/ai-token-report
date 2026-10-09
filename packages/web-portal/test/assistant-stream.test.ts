/** SSE 网络边界：中文字符和事件可以被网络任意拆开，心跳不能变成消息。 */
import { expect, test } from 'bun:test'
import { consumeAssistantStream } from '../src/api/assistant.js'
test('逐字节拆分的中文与心跳仍生成完整事件', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\n\ndata: {"type":"text","text":"中文回答"}\n\ndata: {"type":"done"}\n\n')
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close() } })
  const events: unknown[] = []
  await consumeAssistantStream(stream, event => events.push(event))
  expect(events).toEqual([{ type: 'text', text: '中文回答' }, { type: 'done' }])
})
test('连接中途断开需要显示失败，不能当成回答完成', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"text","text":"半段"}\n\n')); c.close() } })
  await expect(consumeAssistantStream(stream, () => {})).rejects.toThrow('连接中断')
})
