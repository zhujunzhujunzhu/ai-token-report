/** 会话分页必须走通用请求边界，默认页大小和不透明游标均保留同源鉴权。 */
import { afterEach, expect, test } from 'bun:test'
import { assistantSessions } from '../src/api/assistant.js'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('会话 API 默认每页 50 条，游标按原值编码并返回分页元数据', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const page = { sessions: [], next_cursor: '服务端游标', total: 123 }
  globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), init }); return Response.json(page) }) as typeof fetch
  expect(await assistantSessions()).toEqual({ ok: true, data: page })
  await assistantSessions({ cursor: '不透明+/=? 中文' })
  await assistantSessions({ limit: 20, cursor: '下一页' })
  const urls = requests.map(item => new URL(item.url, 'https://portal.test'))
  expect(urls[0]?.searchParams.get('limit')).toBe('50')
  expect(urls[0]?.searchParams.has('cursor')).toBe(false)
  expect(urls[1]?.searchParams.get('cursor')).toBe('不透明+/=? 中文')
  expect(urls[1]?.searchParams.get('limit')).toBe('50')
  expect(urls[2]?.searchParams.get('limit')).toBe('20')
  expect(requests[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Portal-Request': '1' } })
})
