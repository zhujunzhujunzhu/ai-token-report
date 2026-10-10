/** 撤权必须覆盖历史文本和模型事件，不能只禁止新查询或旧文件下载。 */
import { expect, test, afterAll } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AssistantStore } from '../src/assistant/store.js'
import type { Principal } from '../src/identity/types.js'
const root = await mkdtemp(join(tmpdir(), 'atr-assistant-access-'))
const store = new AssistantStore(root)
const principal = { memberId: randomUUID(), roleCodes: ['admin'], permissions: ['stats:read', 'members:manage'], groupIds: [] } as unknown as Principal
afterAll(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
test('新会话绑定scope，降权后历史读取及续聊拒绝，但owner仍可删除', async () => {
  const detail = await store.create(principal.memberId)
  await store.assertAccess(principal, detail.session.session_id)
  detail.messages.push({ role: 'assistant', text: '授权时保存的部门数据' })
  await store.save(principal.memberId, detail)
  await expect(store.assertAccess({ ...principal, permissions: ['stats:read'], roleCodes: ['member'] }, detail.session.session_id)).rejects.toThrow('权限')
  await store.assertAccess(principal, detail.session.session_id)
  await store.delete(principal.memberId, detail.session.session_id)
})
test('旧会话仅可从一致的权威数据集权限迁移，没有证据时拒绝', async () => {
  const detail = await store.create(principal.memberId)
  detail.messages.push({ role: 'assistant', text: '旧记录' })
  await store.save(principal.memberId, detail)
  await expect(store.assertAccess(principal, detail.session.session_id)).rejects.toThrow('缺少')
  const directory = join(store.sessionPath(principal.memberId, detail.session.session_id), 'dsh')
  await mkdir(directory)
  const access = JSON.stringify([principal.memberId, [...principal.roleCodes].sort(), [...principal.permissions].sort(), []])
  await writeFile(join(directory, 'datasets.json'), JSON.stringify({ version: 1, datasets: [{ access }] }))
  await store.assertAccess(principal, detail.session.session_id)
  await expect(store.assertAccess({ ...principal, groupIds: [randomUUID()] }, detail.session.session_id)).rejects.toThrow('权限')
})
