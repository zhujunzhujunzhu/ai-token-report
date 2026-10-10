/** 有效 HTML 分享目录跨历史会话查询，权限与失效判定必须和匿名访问一致，查询不能续期或创建链接。 */
import { afterAll, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AssistantArtifactShare } from '@ai-token-report/shared'
import { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { AssistantStore } from '../src/assistant/store.js'
import { IdentityError, type Principal } from '../src/identity/types.js'

const roots: string[] = []
const owner: Principal = { memberId: '分享目录管理员', name: '甲', groupIds: ['一组'], groupNames: ['一组'], roleCodes: ['admin'], permissions: ['stats:read', 'cost:read'], auth: { kind: 'session', sessionId: randomUUID(), accountId: randomUUID() } }
const other: Principal = { ...owner, memberId: '分享目录其他用户', name: '乙', roleCodes: ['member'] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenOf = (share: AssistantArtifactShare) => share.url.slice(share.url.lastIndexOf('/') + 1)
afterAll(async () => {
  for (const root of roots) {
    if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-shared-html-'))) throw new Error('临时目录超出测试边界')
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atr-shared-html-')); roots.push(root)
  let now = 1_790_000_000_000
  const store = new AssistantStore(root)
  const session = (await store.create(owner.memberId)).session.session_id
  const artifacts = new AssistantArtifacts(root, 'https://example.test/ai-token', () => now)
  const datasets = new AssistantDatasets()
  const create = (title: string, sessionId = session, principal = owner, format: 'html' | 'md' = 'html') => artifacts.create(principal.memberId, sessionId, { format, title, content: '公开统计快照' }, datasets, principal)
  const shared = async (title: string, sessionId = session, principal = owner, hours = 24) => {
    const artifact = await create(title, sessionId, principal)
    const share = await artifacts.share(principal.memberId, artifact.artifact_id, { expires_in_hours: hours }, principal)
    return { artifact, share }
  }
  const pointerPath = (share: AssistantArtifactShare) => join(root, '.shares', `${hash(tokenOf(share))}.json`)
  return { root, store, session, artifacts, create, shared, pointerPath, setNow: (value: number) => { now = value }, now: () => now }
}

test('默认分享列表覆盖当前用户全部历史会话，只含有效 HTML，并提供北京时间有效期', async () => {
  const f = await fixture()
  const old = await f.shared('旧会话/报告')
  await f.create('未分享 HTML')
  await f.create('Markdown 附件', f.session, owner, 'md')
  const historical = (await f.store.create(owner.memberId)).session.session_id
  f.setNow(f.now() + 1000)
  const recent = await f.shared('另一会话报告', historical)
  const page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page).toEqual({
    scope: 'current_member', captured_at_ms: f.now(), total: 2, offset: 0, limit: 50, next_offset: null,
    shares: [recent, old].map(({ artifact, share }) => ({
      artifact_id: artifact.artifact_id, session_id: artifact.session_id, title: artifact.title, file_name: artifact.file_name,
      created_at_ms: artifact.created_at_ms, url: share.url, expires_at_ms: share.expires_at_ms,
      expires_at_label: `${new Date(share.expires_at_ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（北京时间）`,
    })),
  })
  expect(JSON.stringify(page)).not.toContain(owner.memberId)
  expect(page.shares[1]!.file_name).toBe('旧会话_报告.html')
})

test('管理员只能查自己的目录；传入他人归属拒绝 403，空目录返回明确的空页', async () => {
  const f = await fixture()
  const otherSession = (await f.store.create(other.memberId)).session.session_id
  const foreign = await f.shared('他人报告', otherSession, other)
  expect(await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).toEqual({ scope: 'current_member', captured_at_ms: f.now(), total: 0, offset: 0, limit: 50, next_offset: null, shares: [] })
  await expect(f.artifacts.listSharedHtml(other.memberId, {}, owner)).rejects.toMatchObject({ status: 403 })
  await expect(f.artifacts.listSharedHtml(owner.memberId, {}, other)).rejects.toMatchObject({ status: 403 })
  const own = await f.shared('管理员自己的报告')
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares.map(share => share.artifact_id)).toEqual([own.artifact.artifact_id])
  expect((await f.artifacts.listSharedHtml(other.memberId, {}, other)).shares.map(share => share.artifact_id)).toEqual([foreign.artifact.artifact_id])
})

test('分享有效期按毫秒精确排除，到期后列表和匿名访问都不再返回页面', async () => {
  const f = await fixture(); const { artifact, share } = await f.shared('即将到期', f.session, owner, 1)
  f.setNow(share.expires_at_ms - 1)
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares[0]?.artifact_id).toBe(artifact.artifact_id)
  expect((await f.artifacts.publicShare(tokenOf(share), async () => owner)).status).toBe(200)
  f.setNow(share.expires_at_ms)
  const page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page.total).toBe(0); expect(page.shares).toEqual([])
  expect((await f.artifacts.publicShare(tokenOf(share), async () => owner)).status).toBe(410)
})

test('重建分享仅列出最新链接，撤销立刻移除，重新分享可再次列出', async () => {
  const f = await fixture(); const { artifact, share: first } = await f.shared('重建分享')
  const second = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 48 }, owner)
  let page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page.total).toBe(1); expect(page.shares[0]?.url).toBe(second.url)
  expect((await f.artifacts.publicShare(tokenOf(first))).status).toBe(410)
  await f.artifacts.revoke(owner.memberId, artifact.artifact_id)
  page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page.total).toBe(0); expect(page.shares).toEqual([])
  const third = await f.artifacts.share(owner.memberId, artifact.artifact_id, { expires_in_hours: 1 }, owner)
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares[0]?.url).toBe(third.url)
  expect(third.url).not.toBe(second.url)
})

test('会话删除后残留文件索引不能复活分享，其他会话的有效分享继续可见', async () => {
  const f = await fixture(); const removed = await f.shared('待删除会话')
  const retainedSession = (await f.store.create(owner.memberId)).session.session_id
  const retained = await f.shared('保留会话', retainedSession)
  await f.store.delete(owner.memberId, f.session)
  const page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page.total).toBe(1)
  expect(page.shares.map(share => share.artifact_id)).toEqual([retained.artifact.artifact_id])
  expect((await f.artifacts.publicShare(tokenOf(removed.share))).status).toBe(410)
})

test('权限、角色或分组变化排除旧分享，姓名变化和权限数组重排不导致失效', async () => {
  const f = await fixture(); const { artifact } = await f.shared('受权限保护的分享')
  for (const principal of [{ ...owner, permissions: ['stats:read'] }, { ...owner, roleCodes: ['member'] }, { ...owner, groupIds: ['二组'] }]) {
    const page = await f.artifacts.listSharedHtml(owner.memberId, {}, principal)
    expect(page.total).toBe(0); expect(page.shares).toEqual([])
  }
  const renamed = { ...owner, name: '重命名人员', groupNames: ['重命名分组'], permissions: [...owner.permissions].reverse() }
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, renamed)).shares[0]?.artifact_id).toBe(artifact.artifact_id)
})

test('查询与匿名访问都复验当前权威人员权限，较窄的调用凭证不能把已失效分享列为有效', async () => {
  const f = await fixture(); const { artifact, share } = await f.shared('权威身份复验')
  let currentOwner: Omit<Principal, 'auth'> | null = { ...owner, permissions: [...owner.permissions, 'identity:read'] }
  const restored = new AssistantArtifacts(f.root, '', f.now, async () => currentOwner)
  // ★ 调用凭证仍匹配旧快照，权威人员权限已变；列表必须与公开链接的实际可访问状态一致。
  expect((await restored.listSharedHtml(owner.memberId, {}, owner)).total).toBe(0)
  expect((await restored.publicShare(tokenOf(share))).status).toBe(410)
  currentOwner = null
  const disabled = await restored.listSharedHtml(owner.memberId, {}, owner)
  expect(disabled.total).toBe(0); expect(disabled.shares).toEqual([])
  expect((await restored.publicShare(tokenOf(share))).status).toBe(410)
  currentOwner = owner
  expect((await restored.listSharedHtml(owner.memberId, {}, owner)).shares[0]?.artifact_id).toBe(artifact.artifact_id)
  expect((await restored.publicShare(tokenOf(share))).status).toBe(200)
})

test('权威身份查询发生系统错误时应向上抛出，不能伪装成空分享目录或已过期链接', async () => {
  const f = await fixture(); const { share } = await f.shared('身份服务错误')
  const failure = new Error('身份目录暂不可用')
  const restored = new AssistantArtifacts(f.root, '', f.now, async () => { throw failure })
  await expect(restored.listSharedHtml(owner.memberId, {}, owner)).rejects.toBe(failure)
  await expect(restored.publicShare(tokenOf(share))).rejects.toBe(failure)
})

test('分享指针移除、到期或与元数据有效期不一致都被排除', async () => {
  const f = await fixture()
  const missing = await f.shared('缺失指针'); const expired = await f.shared('过期指针'); const mismatch = await f.shared('有效期不一致'); const retained = await f.shared('仍然有效')
  await rm(f.pointerPath(missing.share))
  for (const [entry, expiresAtMs] of [[expired, f.now()], [mismatch, mismatch.share.expires_at_ms + 1000]] as const) {
    const path = f.pointerPath(entry.share)
    const pointer = JSON.parse(await readFile(path, 'utf8')) as { expiresAtMs: number }
    await writeFile(path, JSON.stringify({ ...pointer, expiresAtMs }))
  }
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares.map(share => share.artifact_id)).toEqual([retained.artifact.artifact_id])
  for (const entry of [missing, expired, mismatch]) expect((await f.artifacts.publicShare(tokenOf(entry.share))).status).toBe(410)
})

test('指针误指其他人员或其他文件时，不能将错误页面链接列为有效分享', async () => {
  const f = await fixture(); const invalid = await f.shared('错误指针'); const retained = await f.shared('正确指针')
  const path = f.pointerPath(invalid.share)
  const pointer = JSON.parse(await readFile(path, 'utf8')) as { memberId: string; artifactId: string; expiresAtMs: number }
  await writeFile(path, JSON.stringify({ ...pointer, artifactId: retained.artifact.artifact_id }))
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares.map(share => share.artifact_id)).toEqual([retained.artifact.artifact_id])
  await writeFile(path, JSON.stringify({ ...pointer, memberId: other.memberId }))
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares.map(share => share.artifact_id)).toEqual([retained.artifact.artifact_id])
})

test('元数据中的分享 URL 被置换令牌后，列表与原链接访问都不能复用旧指针', async () => {
  const f = await fixture(); const invalid = await f.shared('令牌被置换'); const retained = await f.shared('正常分享')
  const path = join(f.store.sessionPath(owner.memberId, f.session), 'artifacts', `${invalid.artifact.artifact_id}.json`)
  const stored = JSON.parse(await readFile(path, 'utf8')) as { metadata: { share: AssistantArtifactShare } }
  // ★ 替换为另一条真实存在的能力链接，也不能借该链接的有效指针复活原文件。
  stored.metadata.share.url = retained.share.url
  await writeFile(path, JSON.stringify(stored))
  expect((await f.artifacts.listSharedHtml(owner.memberId, {}, owner)).shares.map(share => share.artifact_id)).toEqual([retained.artifact.artifact_id])
  expect((await f.artifacts.publicShare(tokenOf(invalid.share))).status).toBe(410)
  expect((await f.artifacts.publicShare(tokenOf(retained.share))).status).toBe(200)
})

test('HTML 实体文件删除后，仍有元数据和分享指针也不会显示为开放页面', async () => {
  const f = await fixture(); const missing = await f.shared('实体文件丢失'); const retained = await f.shared('正常页面')
  await rm(join(f.store.sessionPath(owner.memberId, f.session), 'artifacts', `${missing.artifact.artifact_id}.html`))
  const page = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(page.total).toBe(1); expect(page.shares[0]?.artifact_id).toBe(retained.artifact.artifact_id)
  expect((await f.artifacts.publicShare(tokenOf(missing.share))).status).toBe(410)
})

test('恢复持久化目录后仍能查询历史分享，反复查询不改链接、有效期或持久化文件', async () => {
  const f = await fixture(); const { artifact, share } = await f.shared('持久化分享', f.session, owner, 1)
  const metadataPath = join(f.store.sessionPath(owner.memberId, f.session), 'artifacts', `${artifact.artifact_id}.json`)
  const before = [await readFile(metadataPath, 'utf8'), await readFile(f.pointerPath(share), 'utf8')]
  const restored = new AssistantArtifacts(f.root, 'https://changed.test', f.now)
  const first = await restored.listSharedHtml(owner.memberId, {}, owner)
  f.setNow(f.now() + 600_000)
  const second = await restored.listSharedHtml(owner.memberId, {}, owner)
  expect(first.shares).toEqual(second.shares)
  expect(second.shares[0]?.url).toBe(share.url)
  expect(second.shares[0]?.expires_at_ms).toBe(share.expires_at_ms)
  expect(second.captured_at_ms - first.captured_at_ms).toBe(600_000)
  expect([await readFile(metadataPath, 'utf8'), await readFile(f.pointerPath(share), 'utf8')]).toEqual(before)
  f.setNow(share.expires_at_ms)
  expect((await restored.listSharedHtml(owner.memberId, {}, owner)).total).toBe(0)
})

test('分页默认 50、上限 100，同毫秒稳定排序且连续分页不重复，边界返回空页', async () => {
  const f = await fixture()
  const sessions = [f.session, (await f.store.create(owner.memberId)).session.session_id, (await f.store.create(owner.memberId)).session.session_id]
  const created: Awaited<ReturnType<typeof f.shared>>[] = []
  for (let index = 0; index < 105; index++) {
    f.setNow(1_790_000_000_000 + Math.floor(index / 10))
    created.push(await f.shared(`分页报告 ${index}`, sessions[Math.floor(index / 35)]!))
  }
  // ★ 失效条目先过滤再分页，否则中间夹着撤销记录会造成空洞和错误总数。
  await f.artifacts.revoke(owner.memberId, created[50]!.artifact.artifact_id)
  const expected = created.filter((_, index) => index !== 50).sort((a, b) => b.artifact.created_at_ms - a.artifact.created_at_ms || a.artifact.artifact_id.localeCompare(b.artifact.artifact_id)).map(entry => entry.artifact.artifact_id)
  const first = await f.artifacts.listSharedHtml(owner.memberId, {}, owner)
  expect(first.shares).toHaveLength(50); expect(first.total).toBe(104); expect(first.next_offset).toBe(50)
  expect(first.shares.map(share => share.artifact_id)).toEqual(expected.slice(0, 50))
  const maximum = await f.artifacts.listSharedHtml(owner.memberId, { limit: 100 }, owner)
  expect(maximum.shares).toHaveLength(100); expect(maximum.next_offset).toBe(100)
  const ids: string[] = []
  let offset: number | null = 0
  do {
    const page = await f.artifacts.listSharedHtml(owner.memberId, { limit: 26, offset }, owner)
    expect(page.total).toBe(104); expect(page.shares.length).toBeLessThanOrEqual(26)
    ids.push(...page.shares.map(share => share.artifact_id)); offset = page.next_offset
  } while (offset !== null)
  expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(104)
  for (const boundary of [104, 105, Number.MAX_SAFE_INTEGER]) {
    const page = await f.artifacts.listSharedHtml(owner.memberId, { limit: 100, offset: boundary }, owner)
    expect(page.total).toBe(104); expect(page.offset).toBe(boundary); expect(page.shares).toEqual([]); expect(page.next_offset).toBeNull()
  }
}, 20_000)

test('非法分页值或指定 member_id/session_id 都返回 400，不能变成默认值或扩大查询范围', async () => {
  const f = await fixture()
  const invalid: unknown[] = [null, undefined, [], '', 50, { member_id: other.memberId }, { session_id: f.session }, { query: '全部' }]
  for (const limit of [null, 0, -1, 101, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '50', false, [], {}]) invalid.push({ limit })
  for (const offset of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', false, [], {}]) invalid.push({ offset })
  for (const input of invalid) {
    await expect(f.artifacts.listSharedHtml(owner.memberId, input, owner)).rejects.toBeInstanceOf(IdentityError)
    await expect(f.artifacts.listSharedHtml(owner.memberId, input, owner)).rejects.toMatchObject({ status: 400 })
  }
  expect((await f.artifacts.listSharedHtml(owner.memberId, { limit: 1, offset: 0 }, owner)).limit).toBe(1)
})
