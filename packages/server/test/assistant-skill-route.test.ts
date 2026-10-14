/** 自定义技能走正式 HTTP：目录隔离、创建/删除权限、命令解析与授权边界。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHandlerFor } from '../src/index.js'
import { seedDatabaseIdentity } from './database-fixture.js'
import type { AssistantEngine } from '../src/assistant/runtime.js'
import { resolveAssistantSkill, type ResolvedCustomSkill } from '../src/assistant/skills.js'

const root = mkdtempSync(join(tmpdir(), 'atr-skill-route-'))
const dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'skill-admin', name: '技能管理员', role: 'admin' },
  { token: 'skill-a', name: '成员甲', role: 'member' },
  { token: 'skill-b', name: '成员乙', role: 'member' },
])
/** 夹具引擎只回答，不调用模型；它按运行时同一条解析规则还原「本轮请求」。 */
let captured: { prompt: string; request: string; intent: string; custom?: string; skills: string[]; hasScript?: boolean } | undefined
const engine: AssistantEngine = { async run(input) {
  const resolved = resolveAssistantSkill(input.prompt, input.skills ?? [])
  captured = { prompt: input.prompt, request: resolved.request, intent: resolved.intent, ...(resolved.custom ? { custom: resolved.custom.command, hasScript: !!resolved.custom.script } : {}), skills: (input.skills ?? []).map((skill: ResolvedCustomSkill) => skill.command) }
  input.emit({ type: 'text', text: '已收到' })
} }
const bundle = await createHandlerFor({ dshHome: root, dataDir: root, dbPath, assistantEngine: engine, requestLog: false })
const admin = (await identity.resolveBearer('skill-admin'))!
afterAll(async () => {
  await bundle.close()
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'atr-skill-route-'))) throw new Error('临时目录超出测试边界')
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
function call(method: string, path: string, token?: string, body?: unknown) {
  return bundle.handler(new Request(`http://localhost/api/v1/assistant/${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'X-Portal-Request': '1' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
}
const catalog = async (token: string) => {
  const response = await call('GET', 'skills', token)
  expect(response.status).toBe(200)
  return await response.json() as { skills: Array<{ skill_id: string; command: string; mine: boolean; can_delete: boolean; owner_name?: string; visibility: string }>; private_limit: number; public_limit: number }
}
const create = (token: string, body: Record<string, unknown>) => call('POST', 'skills', token, body)
const skillBody = (overrides: Record<string, unknown> = {}) => ({ command: '/team-cost', title: '部门费用', description: '按供应商看费用', prompt: '生成上月的费用分析报表，按供应商分布，导出 Excel', visibility: 'public', ...overrides })
const sessionTotal = async (token: string) => (await (await call('GET', 'sessions', token)).json() as { total: number }).total

test('技能目录要求登录，方法不匹配回 405，请求体逐项校验', async () => {
  expect((await call('GET', 'skills')).status).toBe(401)
  expect((await call('POST', 'skills', undefined, skillBody())).status).toBe(401)
  const wrongMethod = await call('PUT', 'skills', 'skill-a')
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('Allow')).toBe('GET, POST')
  expect((await create('skill-a', {})).status).toBe(400)
  expect((await create('skill-a', skillBody({ command: '/report' }))).status).toBe(409)
  expect((await create('skill-a', skillBody({ visibility: 'department' }))).status).toBe(400)
  expect((await call('DELETE', 'skills/not-a-uuid', 'skill-a')).status).toBe(400)
  expect((await call('DELETE', 'skills/' + crypto.randomUUID(), 'skill-a')).status).toBe(404)
})

test('公开技能全部门可见，私有技能只有本人可见，创建者姓名只给本人与管理员', async () => {
  const initial = await catalog('skill-a')
  expect(initial.skills).toEqual([])
  expect(initial.private_limit).toBeGreaterThan(0)
  expect(initial.public_limit).toBeGreaterThan(0)

  const created = await create('skill-a', skillBody())
  expect(created.status).toBe(200)
  const skill = (await created.json() as { skill: { skill_id: string } }).skill

  const own = await catalog('skill-a')
  expect(own.skills.map(item => item.command)).toEqual(['/team-cost'])
  expect(own.skills[0]).toMatchObject({ mine: true, can_delete: true, owner_name: '成员甲', visibility: 'public' })

  const other = await catalog('skill-b')
  expect(other.skills.map(item => item.command)).toEqual(['/team-cost'])
  expect(other.skills[0]).toMatchObject({ mine: false, can_delete: false })
  expect(other.skills[0]!.owner_name).toBeUndefined()

  expect((await create('skill-b', skillBody({ command: '/team-cost' }))).status).toBe(409)
  expect((await create('skill-b', skillBody({ command: '/team-cost', visibility: 'private' }))).status).toBe(409)
  const privateSkill = await create('skill-b', skillBody({ command: '/my-only', visibility: 'private' }))
  expect(privateSkill.status).toBe(200)
  expect((await catalog('skill-a')).skills.map(item => item.command)).toEqual(['/team-cost'])
  expect((await catalog('skill-b')).skills.map(item => item.command)).toEqual(['/my-only', '/team-cost'])
  expect(skill.skill_id).toBe(own.skills[0]!.skill_id)
})

test('删除公开技能只放行创建者与管理员，别人的私有技能谁都删不掉', async () => {
  const publicSkill = (await catalog('skill-a')).skills.find(item => item.command === '/team-cost')!
  const privateSkill = (await catalog('skill-b')).skills.find(item => item.command === '/my-only')!
  expect((await call('DELETE', `skills/${publicSkill.skill_id}`, 'skill-b')).status).toBe(403)
  expect((await call('DELETE', `skills/${privateSkill.skill_id}`, 'skill-a')).status).toBe(404)
  expect((await call('DELETE', `skills/${privateSkill.skill_id}`, 'skill-admin')).status).toBe(404)
  expect((await call('DELETE', `skills/${publicSkill.skill_id}`, 'skill-admin')).status).toBe(200)
  expect((await catalog('skill-b')).skills.map(item => item.command)).toEqual(['/my-only'])
  expect((await catalog('skill-a')).skills).toEqual([])
  expect(admin.roleCodes).toContain('admin')
})

test('发送自定义技能时按服务端目录解析：草稿进请求、技能清单传给引擎', async () => {
  await create('skill-b', skillBody({ command: '/weekly-cost', title: '上周费用', visibility: 'private', prompt: '生成上周的费用分析报表，按供应商分布' }))
  const before = await sessionTotal('skill-b')
  const response = await call('POST', 'chat', 'skill-b', { prompt: '/weekly-cost' })
  expect(response.status).toBe(200)
  await response.text()
  expect(captured).toMatchObject({ prompt: '/weekly-cost', request: '生成上周的费用分析报表，按供应商分布', intent: '', custom: '/weekly-cost' })
  // 引擎拿到的是**服务端算出的可见清单**，与目录接口逐项一致。
  expect(captured!.skills).toEqual((await catalog('skill-b')).skills.map(item => item.command))
  expect(await sessionTotal('skill-b')).toBe(before + 1)

  // 用户自己补的正文优先于草稿，并且构成本轮的授权文本。
  const explicit = await call('POST', 'chat', 'skill-b', { prompt: '/weekly-cost 只看模型分布' })
  await explicit.text()
  expect(captured).toMatchObject({ request: '只看模型分布', intent: '只看模型分布' })

  // ★ 别人的私有技能不可见：不能在创建会话或调用模型之前被「猜」出来。
  const visibleBefore = await sessionTotal('skill-a')
  const foreign = await call('POST', 'chat', 'skill-a', { prompt: '/weekly-cost' })
  expect(foreign.status).toBe(400)
  expect(await foreign.json()).toMatchObject({ reason: expect.stringContaining('这个技能不存在') })
  expect(await sessionTotal('skill-a')).toBe(visibleBefore)
})

test('带脚本的技能经 HTTP 往返：脚本落目录、下发给可见者、并进入本轮运行', async () => {
  const script = 'return { total: input.rows.reduce((sum, row) => sum + row.tokens, 0) }'
  const created = await create('skill-b', skillBody({ command: '/sum-tokens', title: '汇总', visibility: 'private', script }))
  expect(created.status).toBe(200)
  const catalogB = await catalog('skill-b')
  expect(catalogB.skills.find(item => item.command === '/sum-tokens')).toMatchObject({ script })
  // 私有技能不进别人的目录；公开技能才随目录发给全部门（能运行就能读到代码）。
  expect((await catalog('skill-a')).skills.some(item => item.command === '/sum-tokens')).toBe(false)
  const shared = await create('skill-b', skillBody({ command: '/team-sum', title: '部门汇总', prompt: '按供应商汇总输入数据', script }))
  expect(shared.status).toBe(200)
  expect((await catalog('skill-a')).skills.find(item => item.command === '/team-sum')).toMatchObject({ script })

  // 坏脚本在写盘前就被拒绝：HTTP 上是 400，且目录里没有它。
  const broken = await create('skill-b', skillBody({ command: '/broken', title: '坏脚本', script: 'return {' }))
  expect(broken.status).toBe(400)
  expect(await broken.json()).toMatchObject({ reason: expect.stringContaining('脚本语法错误') })
  expect((await catalog('skill-b')).skills.some(item => item.command === '/broken')).toBe(false)

  // 本轮调用带脚本的技能时，脚本按服务端身份随技能清单一起交给引擎（浏览器提交不了脚本）。
  const response = await call('POST', 'chat', 'skill-b', { prompt: '/sum-tokens' })
  expect(response.status).toBe(200)
  await response.text()
  expect(captured).toMatchObject({ custom: '/sum-tokens', hasScript: true })
  const unsigned = await call('POST', 'chat', 'skill-b', { prompt: '/sum-tokens', skills: [{ command: '/sum-tokens', script: 'return 1' }] })
  expect(unsigned.status).toBe(400)
  expect(await unsigned.json()).toMatchObject({ reason: expect.stringContaining('仅支持 prompt') })
})

test('/create-skill 不进入对话：服务端只回一句请从技能菜单处理', async () => {
  const before = await sessionTotal('skill-a')
  const response = await call('POST', 'chat', 'skill-a', { prompt: '/create-skill' })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ reason: expect.stringContaining('由技能菜单在浏览器里处理') })
  expect(await sessionTotal('skill-a')).toBe(before)
  expect(captured?.prompt).not.toBe('/create-skill')
})