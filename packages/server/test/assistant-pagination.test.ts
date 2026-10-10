/** 真 HTTP 分发和私有目录验证会话游标：同毫秒顺序、跨页变更与保留期均不依赖模型请求。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ASSISTANT_SESSION_PAGE_SIZE, type AssistantSessionPage } from '@ai-token-report/shared'
import { createHandlerFor } from '../src/index.js'
import { AssistantStore } from '../src/assistant/store.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const root = await mkdtemp(join(tmpdir(), 'atr-assistant-pagination-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'pagination-owner', name: '分页用户', role: 'admin' },
  { token: 'pagination-other', name: '隔离用户', role: 'member' },
  { token: 'pagination-changing', name: '变更用户', role: 'member' },
  { token: 'pagination-empty', name: '空目录用户', role: 'member' },
])
const owner = (await identity.resolveBearer('pagination-owner'))!
const other = (await identity.resolveBearer('pagination-other'))!
const changing = (await identity.resolveBearer('pagination-changing'))!
const store = new AssistantStore(join(root, 'assistant'))
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, assistantEngine: { async run() {} }, requestLog: false })
const sessionId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
const timestamp = Date.now()
const save = (memberId: string, index: number, updatedAtMs: number) => store.save(memberId, {
  session: { session_id: sessionId(index), title: `对话 ${index}`, created_at_ms: updatedAtMs, updated_at_ms: updatedAtMs, turn_count: 1 }, messages: [],
})
for (let index = 0; index < 65; index++) await save(owner.memberId, index, index < 57 ? timestamp : timestamp - 1000)
await save(other.memberId, 100, timestamp + 1000)
const expected = [...Array.from({ length: 57 }, (_, index) => sessionId(56 - index)), ...Array.from({ length: 8 }, (_, index) => sessionId(64 - index))]
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-assistant-pagination-'))) throw new Error('临时目录超出测试边界')
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
const call = (query = '', token = 'pagination-owner', method = 'GET', path = 'sessions') => bundle.handler(new Request(`http://localhost/api/v1/assistant/${path}${query ? `?${query}` : ''}`, {
  method, headers: { Authorization: `Bearer ${token}` },
}))
async function page(query = '', token = 'pagination-owner'): Promise<AssistantSessionPage> {
  const response = await call(query, token)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return await response.json() as AssistantSessionPage
}

test('会话 HTTP 默认一次 50 条，返回当前用户总数和下一页游标，末页不再给游标', async () => {
  expect(ASSISTANT_SESSION_PAGE_SIZE).toBe(50)
  const first = await page()
  expect(first.sessions).toHaveLength(50)
  expect(first.total).toBe(65)
  expect(first.sessions.map(session => session.session_id)).toEqual(expected.slice(0, 50))
  expect(first.next_cursor).toBeString()
  const last = await page(`cursor=${first.next_cursor}`)
  expect(last.sessions.map(session => session.session_id)).toEqual(expected.slice(50))
  expect(last.total).toBe(65)
  expect(last.next_cursor).toBeNull()
  const all = await page('limit=100')
  expect(all.sessions).toHaveLength(65)
  expect(all.next_cursor).toBeNull()
})

test('更新时间相同也按 UUID 降序稳定分页，连续加载不重复或漏掉会话', async () => {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const current = await page(`limit=7${cursor ? `&cursor=${cursor}` : ''}`)
    expect(current.sessions.length).toBeLessThanOrEqual(7)
    ids.push(...current.sessions.map(session => session.session_id))
    cursor = current.next_cursor
  } while (cursor)
  expect(ids).toEqual(expected)
  expect(new Set(ids).size).toBe(65)
})

test('跨页插入、更新或删除，包括删除游标记录，下一页边界仍然正确', async () => {
  for (let index = 1; index <= 10; index++) await save(changing.memberId, 200 + index, timestamp + index)
  const first = await page('limit=3', 'pagination-changing')
  expect(first.sessions.map(session => session.session_id)).toEqual([210, 209, 208].map(sessionId))
  await save(changing.memberId, 211, timestamp + 11)
  expect((await call('', 'pagination-changing', 'DELETE', `sessions/${sessionId(210)}`)).status).toBe(200)
  expect((await call('', 'pagination-changing', 'DELETE', `sessions/${sessionId(208)}`)).status).toBe(200)
  expect((await call('', 'pagination-changing', 'DELETE', `sessions/${sessionId(206)}`)).status).toBe(200)
  await save(changing.memberId, 209, timestamp + 20)
  await save(changing.memberId, 203, timestamp + 15)
  // ★ 被续聊的旧对话移到首屏；继续原游标时不重复它，刷新首屏仍能找回最新元数据。
  expect((await page('limit=3', 'pagination-changing')).sessions.map(session => session.session_id)).toEqual([209, 203, 211].map(sessionId))
  const second = await page(`limit=3&cursor=${first.next_cursor}`, 'pagination-changing')
  expect(second.sessions.map(session => session.session_id)).toEqual([207, 205, 204].map(sessionId))
  expect(second.total).toBe(8)
  const last = await page(`limit=3&cursor=${second.next_cursor}`, 'pagination-changing')
  expect(last.sessions.map(session => session.session_id)).toEqual([202, 201].map(sessionId))
  expect(last.next_cursor).toBeNull()
})

test('分页只读取登录者私有空间，复制他人游标不能读取其记录，空目录和越过末尾均为空页', async () => {
  const first = await page('limit=3')
  const own = await page('', 'pagination-other')
  expect(own.sessions.map(session => session.session_id)).toEqual([sessionId(100)])
  expect(own.total).toBe(1)
  const copied = await page(`cursor=${first.next_cursor}`, 'pagination-other')
  expect(copied).toEqual({ sessions: [], next_cursor: null, total: 1 })
  expect(await page('', 'pagination-empty')).toEqual({ sessions: [], next_cursor: null, total: 0 })
  const endCursor = Buffer.from(JSON.stringify([1, timestamp - 1000, sessionId(57)])).toString('base64url')
  expect(await page(`cursor=${endCursor}`)).toEqual({ sessions: [], next_cursor: null, total: 65 })
  expect((await call('', 'pagination-other', 'GET', `sessions/${first.sessions[0]!.session_id}`)).status).toBe(404)
})

test('错误分页参数在 HTTP 边界返回 400，不能静默变成默认分页', async () => {
  for (const limit of ['', '0', '101', '-1', '1.5', 'Infinity', '50foo', '5e1', ' 50', '01']) expect((await call(`limit=${encodeURIComponent(limit)}`)).status).toBe(400)
  const cursors = ['', '%', 'not-json', Buffer.from('null').toString('base64url'), ...[
    [2, timestamp, sessionId(1)], [1, -1, sessionId(1)], [1, 1.5, sessionId(1)], [1, timestamp, '../escape'], [1, timestamp], [1, timestamp, sessionId(1), 'extra'],
  ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url'))]
  for (const cursor of cursors) expect((await call(`cursor=${encodeURIComponent(cursor)}`)).status).toBe(400)
  for (const query of ['limit=2&limit=3', 'cursor=a&cursor=b', 'member_id=another-user', 'limit=2&offset=50']) expect((await call(query)).status).toBe(400)
  expect((await call('limit=1')).status).toBe(200)
})

test('列表分页保留活动会话的过期保护，内部全量列表继续维护 100 个会话配额', async () => {
  const retained = new AssistantStore(join(root, 'retained'), 1)
  const old = await retained.create(owner.memberId)
  old.session.updated_at_ms -= 2 * 86_400_000
  await retained.save(owner.memberId, old)
  expect(await retained.listPage(owner.memberId, {}, new Set([old.session.session_id]))).toEqual({ sessions: [old.session], next_cursor: null, total: 1 })
  expect(await retained.listPage(owner.memberId)).toEqual({ sessions: [], next_cursor: null, total: 0 })
  const capped = new AssistantStore(join(root, 'capped'))
  for (let index = 0; index < 100; index++) await capped.save(owner.memberId, { session: { session_id: sessionId(300 + index), title: '配额对话', created_at_ms: timestamp, updated_at_ms: timestamp, turn_count: 0 }, messages: [] })
  expect((await capped.listPage(owner.memberId)).sessions).toHaveLength(50)
  expect(await capped.list(owner.memberId)).toHaveLength(100)
  await expect(capped.create(owner.memberId)).rejects.toThrow('100')
})
