/** 自定义技能目录：可见范围、归属、上限、查重、坏文件与并发创建都必须按契约表现。 */
import { afterAll, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantSkillStore, type StoredCustomSkill } from '../src/assistant/skill-store.js'
import type { Principal } from '../src/identity/types.js'

const root = mkdtempSync(join(tmpdir(), 'atr-skill-store-'))
afterAll(async () => {
  if (!root.startsWith(join(tmpdir(), 'atr-skill-store-'))) throw new Error('临时目录超出测试边界')
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const memberA = '11111111-1111-4111-8111-111111111111'
const memberB = '22222222-2222-4222-8222-222222222222'
const principal = (memberId: string, name: string, roleCodes: string[] = []): Principal =>
  ({ memberId, name, groupIds: [], groupNames: [], roleCodes, permissions: ['stats:read'], auth: { kind: 'token', tokenId: 'token' } })
const alice = principal(memberA, '成员甲')
const bob = principal(memberB, '成员乙')
const admin = principal('33333333-3333-4333-8333-333333333333', '管理员', ['admin'])

let sequence = 0
function record(overrides: Partial<StoredCustomSkill> = {}): StoredCustomSkill {
  sequence += 1
  return {
    skill_id: randomUUID(), command: `/seed-${sequence}`, title: '标题', description: '说明', prompt: '默认请求',
    visibility: 'private', owner_member_id: memberA, owner_name: '成员甲', created_at_ms: 1, updated_at_ms: 1, ...overrides,
  }
}
function store(): { skills: AssistantSkillStore; root: string } {
  const directory = join(root, `case-${randomUUID()}`)
  return { skills: new AssistantSkillStore(directory), root: directory }
}
const input = (overrides: Record<string, unknown> = {}) => ({ command: '/weekly-cost', title: '上周费用', description: '按供应商看上周费用', prompt: '生成上周的费用分析报表，按供应商分布，导出 Excel', visibility: 'private', ...overrides })

test('私有技能只有本人可见，公开技能对所有人可见且不暴露创建者姓名', async () => {
  const { skills } = store()
  const mine = await skills.create(alice, input({ command: '/my-cost' }))
  const shared = await skills.create(alice, input({ command: '/team-cost', visibility: 'public' }))

  const aliceCatalog = await skills.list(alice)
  expect(aliceCatalog.skills.map(skill => skill.command)).toEqual(['/my-cost', '/team-cost'])
  expect(aliceCatalog.skills.every(skill => skill.mine && skill.can_delete)).toBe(true)
  // ★ 创建者姓名只给本人与管理员：公开技能发给全体，不代表「谁建的」也要发给全体。
  expect(aliceCatalog.skills.map(skill => skill.owner_name)).toEqual(['成员甲', '成员甲'])

  const bobCatalog = await skills.list(bob)
  expect(bobCatalog.skills.map(skill => skill.command)).toEqual(['/team-cost'])
  expect(bobCatalog.skills[0]).toMatchObject({ mine: false, can_delete: false })
  expect('owner_name' in bobCatalog.skills[0]!).toBe(false)
  expect(shared.skill_id).toBe(bobCatalog.skills[0]!.skill_id)
  expect(mine.visibility).toBe('private')
  expect(aliceCatalog.private_limit).toBeGreaterThan(0)
})

test('删除权限：创建者可删自己的，管理员可清理公开技能，别人的私有技能谁都动不了', async () => {
  const { skills } = store()
  const privateSkill = await skills.create(alice, input({ command: '/private-one' }))
  const publicSkill = await skills.create(alice, input({ command: '/public-one', visibility: 'public' }))
  expect((await skills.list(admin)).skills.find(skill => skill.skill_id === publicSkill.skill_id)?.can_delete).toBe(true)
  expect((await skills.list(admin)).skills.some(skill => skill.skill_id === privateSkill.skill_id)).toBe(false)

  await expect(skills.remove(bob, publicSkill.skill_id)).rejects.toThrow('只有创建者或管理员')
  await expect(skills.remove(bob, privateSkill.skill_id)).rejects.toThrow('技能不存在')
  await expect(skills.remove(admin, 'not-a-uuid')).rejects.toThrow('技能 ID 无效')
  await skills.remove(alice, privateSkill.skill_id)
  expect((await skills.list(alice)).skills.map(skill => skill.command)).toEqual(['/public-one'])
  await skills.remove(admin, publicSkill.skill_id)
  expect((await skills.list(alice)).skills).toEqual([])
})

test('命令格式、保留命令、字段长度与可见范围逐项拒绝', async () => {
  const { skills } = store()
  for (const [bad, reason] of [
    [{ command: '' }, '命令需要形如'],
    [{ command: 'weekly-cost' }, '命令需要形如'],
    [{ command: '/Weekly_Cost' }, '命令需要形如'],
    [{ command: '/report' }, '已被平台内置技能占用'],
    [{ command: '/create-skill' }, '已被平台内置技能占用'],
    [{ title: '' }, '技能标题'],
    [{ title: 'x'.repeat(25) }, '技能标题'],
    [{ description: 'x'.repeat(81) }, '技能说明'],
    [{ prompt: 'x'.repeat(1001) }, '指令草稿'],
    [{ title: '带\t制表符' }, '不能包含换行或制表符'],
    [{ visibility: 'everyone' }, '可见范围只能是仅自己或所有人'],
    [{ extra: 1 }, '需要提供命令、标题、说明、指令与可见范围'],
  ] as const) await expect(skills.create(alice, input(bad as Record<string, unknown>))).rejects.toThrow(reason)
})

test('命令统一小写入库，重复命令（含内置与公开）在写入前被拒绝', async () => {
  const { skills } = store()
  const created = await skills.create(alice, input({ command: ' /Weekly-Cost ' }))
  expect(created.command).toBe('/weekly-cost')
  await expect(skills.create(alice, input({ command: '/WEEKLY-COST' }))).rejects.toThrow('已被你的另一个技能占用')
  await skills.create(alice, input({ command: '/shared-cost', visibility: 'public' }))
  await expect(skills.create(bob, input({ command: '/shared-cost', visibility: 'public' }))).rejects.toThrow('已被一个公开技能占用')
  await expect(skills.create(bob, input({ command: '/shared-cost' }))).rejects.toThrow('已被一个公开技能占用')
})

test('同一身份同时创建同名命令只成功一条，串行写在原子替换之上生效', async () => {
  const { skills } = store()
  const results = await Promise.allSettled([
    skills.create(alice, input({ command: '/race', visibility: 'public' })),
    skills.create(alice, input({ command: '/race', visibility: 'public' })),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect((await skills.list(alice)).skills.filter(skill => skill.command === '/race')).toHaveLength(1)
})

test('私有与公开技能各自有上限，达到上限后拒绝新建', async () => {
  const { skills, root: directory } = store()
  await mkdir(join(directory, '.skills', 'members'), { recursive: true })
  await writeFile(join(directory, '.skills', 'members', `${createHash('sha256').update(memberA).digest('hex')}.json`),
    JSON.stringify({ version: 1, skills: Array.from({ length: 50 }, () => record({ visibility: 'private', owner_member_id: memberA })) }))
  await expect(skills.create(alice, input({ command: '/one-more' }))).rejects.toThrow('私有技能最多 50 个')
  // 公开技能的上限不看私有文件，用一份满额的公开目录验证。
  await mkdir(join(directory, '.skills'), { recursive: true })
  await writeFile(join(directory, '.skills', 'public.json'),
    JSON.stringify({ version: 1, skills: Array.from({ length: 100 }, () => record({ visibility: 'public', owner_member_id: memberB, owner_name: '成员乙' })) }))
  await expect(skills.create(alice, input({ command: '/public-more', visibility: 'public' }))).rejects.toThrow('公开技能最多 100 个')
})

test('技能目录按身份哈希落盘、可被新实例读回；坏文件明确失败而不是静默丢掉', async () => {
  const { skills, root: directory } = store()
  await skills.create(alice, input({ command: '/persisted' }))
  const path = join(directory, '.skills', 'members', `${createHash('sha256').update(memberA).digest('hex')}.json`)
  const stored = JSON.parse(await readFile(path, 'utf8')) as { version: number; skills: StoredCustomSkill[] }
  expect(stored.version).toBe(1)
  expect(stored.skills[0]!.command).toBe('/persisted')
  expect(stored.skills[0]!.owner_member_id).toBe(memberA)
  // 目录名不是原始身份：把 memberId 当目录名会让改名/迁移后的归属对不上。
  expect(path).not.toContain(memberA)
  const reopened = new AssistantSkillStore(directory)
  expect((await reopened.list(alice)).skills.map(skill => skill.command)).toEqual(['/persisted'])

  await writeFile(path, '{ not json')
  await expect(reopened.list(alice)).rejects.toThrow('技能目录文件解析失败')
  await writeFile(path, JSON.stringify({ version: 2, skills: [] }))
  await expect(reopened.list(alice)).rejects.toThrow('技能目录文件格式不兼容')
  await writeFile(path, JSON.stringify({ version: 1, skills: [{ skill_id: 'nope' }] }))
  await expect(reopened.list(alice)).rejects.toThrow('技能目录包含无效记录')
})

test('目录按「自己的私有在前、更新时间倒序」返回，解析时私有同名优先', async () => {
  const { skills } = store()
  await skills.create(alice, input({ command: '/public-one', visibility: 'public' }))
  await skills.create(alice, input({ command: '/private-old' }))
  const fresh = await skills.create(alice, input({ command: '/private-new' }))
  const snapshot = await skills.snapshot(memberA)
  expect(snapshot.map(skill => skill.command)).toEqual(['/private-new', '/private-old', '/public-one'])
  expect(snapshot[0]!.skill_id).toBe(fresh.skill_id)
  // 同名时私有那份排在前面：解析用 find 取第一条，因此自己保存的命令永远胜出。
  const duplicated = snapshot.filter(skill => skill.command === '/public-one')
  expect(duplicated).toHaveLength(1)
  expect((await skills.snapshot(memberB)).map(skill => skill.command)).toEqual(['/public-one'])
})