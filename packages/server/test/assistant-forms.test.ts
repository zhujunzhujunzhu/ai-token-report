/** 助手表单只产生预填事件，数据库写入仍由用户在管理页面保存完成。 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AssistantEvent, AssistantForm, AssistantFormRequest, AssistantFormResource } from '@ai-token-report/shared'
import { MEMBER_ROLE_ID } from '../src/identity/types.js'
import { DatabaseAdminRoute } from '../src/admin-route.js'
import { AssistantActions } from '../src/assistant/actions.js'
import { AssistantStore } from '../src/assistant/store.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const ADMIN_TOKEN = 'assistant-forms-admin'
const MEMBER_TOKEN = 'assistant-forms-member'
type Fixture = Awaited<ReturnType<typeof fixture>>
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'atr-assistant-forms-'))
  const repository = await seedDatabaseIdentity({ sqlitePath: join(directory, 'portal.sqlite') }, [
    { token: ADMIN_TOKEN, name: '表单管理员', role: 'admin' },
    { token: MEMBER_TOKEN, name: '普通成员', role: 'member' },
  ])
  const admin = new DatabaseAdminRoute(repository), store = new AssistantStore(join(directory, 'assistant'))
  const principal = (await repository.resolveBearer(ADMIN_TOKEN))!, member = (await repository.resolveBearer(MEMBER_TOKEN))!
  const session = (await store.create(principal.memberId)).session.session_id
  const actions = new AssistantActions(admin, store), events: AssistantEvent[] = []
  return { directory, repository, admin, store, principal, member, session, actions, events, emit: (event: AssistantEvent) => events.push(event) }
}
async function using(work: (f: Fixture) => Promise<void>) {
  const f = await fixture()
  try { await work(f) } finally { await rm(f.directory, { recursive: true, force: true }) }
}
async function call(f: Fixture, method: string, path: string, body?: unknown): Promise<any> {
  const response = await f.admin.handle(method, path, f.principal, body, new URLSearchParams())
  expect(response.status).toBe(200)
  return response.body
}
async function form(f: Fixture, args: AssistantFormRequest): Promise<AssistantForm> {
  const result = await f.actions.prepareForm(f.principal, f.session, args, f.emit) as { requested: boolean; executed: boolean; form: AssistantForm; message: string }
  expect(result.requested).toBe(true)
  expect(result.executed).toBe(false)
  expect(result.message).toContain('尚未保存')
  expect(f.events.at(-1)).toEqual({ type: 'open_form', form: result.form })
  return result.form
}
async function snapshot(f: Fixture) {
  return f.repository.read(async tx => ({
    audits: await tx.all('SELECT audit_id FROM admin_audit_log ORDER BY audit_id'),
    members: await tx.all('SELECT member_id,display_name,version FROM members ORDER BY member_id'),
    groups: await tx.all('SELECT group_id,name,version FROM member_groups ORDER BY group_id'),
    providers: await tx.all('SELECT * FROM provider_alias ORDER BY alias_id'),
    projects: await tx.all('SELECT * FROM project_alias ORDER BY alias_id'),
    prices: await tx.all('SELECT * FROM model_price ORDER BY price_id'),
  }))
}
async function revoke(f: Fixture, permission: string) {
  await f.repository.systemWrite(tx => tx.run('DELETE FROM report_token_scopes WHERE token_id = $token AND permission_id IN (SELECT permission_id FROM permissions WHERE code = $code)', {
    $token: f.principal.auth.kind === 'token' ? f.principal.auth.tokenId : '', $code: permission,
  }))
}
const priceValues = {
  provider: 'sample-provider', model: 'sample-model', currency: 'CNY', input_micro_per_ktok: 100,
  output_micro_per_ktok: 200, cache_read_micro_per_ktok: 10, cache_write_micro_per_ktok: 50,
  effective_from_ms: 1000, effective_to_ms: 2000, note: '原备注',
}

describe('助手预填表单', () => {
  test('五种新建表单允许部分字段，固定路径且重复请求没有数据库写入', () => using(async f => {
    const before = await snapshot(f)
    const examples: Array<[AssistantFormResource, string, AssistantFormRequest['values']]> = [
      ['members', '/members', { name: '新同事' }],
      ['groups', '/groups', {}],
      ['provider-aliases', '/providers', { alias: '阿里云' }],
      ['project-aliases', '/projects', { prefix: '示例仓库' }],
      ['pricing', '/pricing', { model: '待配模型', input_micro_per_ktok: 25 }],
    ]
    const ids = new Set<string>()
    for (const [resource, path, values] of examples) {
      for (let repeat = 0; repeat < 2; repeat++) {
        const opened = await form(f, { resource, operation: 'create', values })
        expect(opened.path).toBe(path)
        expect(opened.values).toEqual(values ?? {})
        expect(opened.target_id).toBeUndefined()
        expect(ids.has(opened.request_id)).toBe(false)
        ids.add(opened.request_id)
      }
    }
    expect(await snapshot(f)).toEqual(before)
    expect((await f.store.get(f.principal.memberId, f.session)).messages).toEqual([])
    expect(await readdir(f.store.sessionPath(f.principal.memberId, f.session))).not.toContain('actions')
  }))
  test('完整预填也不自动保存，用户保存后才生成规则与审计', () => using(async f => {
    const before = await snapshot(f)
    const opened = await form(f, { resource: 'provider-aliases', operation: 'create', values: { scope: 'global', provider: 'dashscope', alias: '阿里云' } })
    expect(await snapshot(f)).toEqual(before)
    const saved = await call(f, 'POST', 'provider-aliases', opened.values)
    expect(saved.alias.provider).toBe('dashscope')
    expect(saved.alias.alias).toBe('阿里云')
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
    expect((await snapshot(f)).audits).toHaveLength(before.audits.length + 1)
  }))
  test('编辑精确读取真实目标并保留业务字段，不泄露人员角色或账号', () => using(async f => {
    const group = (await call(f, 'POST', 'groups', { name: '表单组' })).group
    const member = (await call(f, 'POST', 'members', { name: '原姓名', group_ids: [group.group_id], role_ids: [MEMBER_ROLE_ID] })).member
    const provider = (await call(f, 'POST', 'provider-aliases', { scope: 'global', provider: '*', model: 'raw-model', alias: '原模型名' })).alias
    const project = (await call(f, 'POST', 'project-aliases', { scope: 'member', member_id: member.member_id, prefix: 'example-repository', alias: '原项目名' })).alias
    const price = (await call(f, 'POST', 'pricing', priceValues)).price
    const before = await snapshot(f)
    const memberForm = await form(f, { resource: 'members', operation: 'update', target_id: member.member_id, values: { name: '预填新姓名' } })
    expect(memberForm.values).toEqual({ name: '预填新姓名', group_ids: [group.group_id] })
    expect(JSON.stringify(memberForm)).not.toMatch(/roles|role_ids|account|token|credential|password/)
    const groupForm = await form(f, { resource: 'groups', operation: 'update', target_id: group.group_id })
    expect(groupForm.values).toEqual({ name: '表单组' })
    const providerForm = await form(f, { resource: 'provider-aliases', operation: 'update', target_id: provider.alias_id, values: { alias: '预填模型名' } })
    expect(providerForm.values).toEqual({ scope: 'global', provider: '*', model: 'raw-model', alias: '预填模型名' })
    const projectForm = await form(f, { resource: 'project-aliases', operation: 'update', target_id: project.alias_id })
    expect(projectForm.values).toMatchObject({ scope: 'member', member_id: member.member_id, prefix: 'example-repository', alias: '原项目名' })
    const priceForm = await form(f, { resource: 'pricing', operation: 'update', target_id: price.price_id, values: { input_micro_per_ktok: 150, note: null } })
    expect(priceForm.values).toMatchObject({ ...priceValues, input_micro_per_ktok: 150, note: null })
    expect(await snapshot(f)).toEqual(before)
  }))
  test('编辑不能替换归属、原值、币种或生效起点', () => using(async f => {
    const provider = (await call(f, 'POST', 'provider-aliases', { scope: 'global', provider: 'sample-provider', alias: '供应商' })).alias
    const project = (await call(f, 'POST', 'project-aliases', { scope: 'global', prefix: 'example-repository', alias: '项目' })).alias
    const price = (await call(f, 'POST', 'pricing', priceValues)).price
    const before = await snapshot(f)
    const bad: AssistantFormRequest[] = [
      { resource: 'provider-aliases', operation: 'update', target_id: provider.alias_id, values: { scope: 'member' } },
      { resource: 'provider-aliases', operation: 'update', target_id: provider.alias_id, values: { member_id: f.member.memberId } },
      { resource: 'provider-aliases', operation: 'update', target_id: provider.alias_id, values: { provider: 'other-provider' } },
      { resource: 'provider-aliases', operation: 'update', target_id: provider.alias_id, values: { model: 'other-model' } },
      { resource: 'project-aliases', operation: 'update', target_id: project.alias_id, values: { scope: 'member' } },
      { resource: 'project-aliases', operation: 'update', target_id: project.alias_id, values: { member_id: f.member.memberId } },
      { resource: 'project-aliases', operation: 'update', target_id: project.alias_id, values: { prefix: 'another-repository' } },
      ...['provider', 'model', 'currency', 'effective_from_ms'].map(key => ({ resource: 'pricing' as const, operation: 'update' as const, target_id: price.price_id, values: { [key]: key === 'effective_from_ms' ? 1001 : key === 'currency' ? 'USD' : 'another-value' } })),
    ]
    for (const args of bad) await expect(f.actions.prepareForm(f.principal, f.session, args, f.emit)).rejects.toMatchObject({ status: 400 })
    expect(f.events).toHaveLength(0)
    expect(await snapshot(f)).toEqual(before)
  }))
  test('缺少、伪造或多余目标与任意路径、安全字段一律拒绝', () => using(async f => {
    const bad = [
      { resource: 'members', operation: 'update' },
      { resource: 'groups', operation: 'update', target_id: '研发组' },
      { resource: 'groups', operation: 'create', target_id: randomUUID() },
      { resource: 'members', operation: 'delete', target_id: f.member.memberId },
      { resource: 'roles', operation: 'create' },
      { resource: '../members', operation: 'create' },
      { resource: 'groups', operation: 'create', path: '/roles' },
      { resource: 'members', operation: 'create', values: { role_ids: [MEMBER_ROLE_ID] } },
      { resource: 'members', operation: 'create', values: { password: 'secret' } },
      { resource: 'groups', operation: 'create', values: { permissions: ['groups:manage'] } },
      { resource: 'provider-aliases', operation: 'create', values: { enabled: false } },
    ]
    for (const args of bad) await expect(f.actions.prepareForm(f.principal, f.session, args as AssistantFormRequest, f.emit)).rejects.toMatchObject({ status: 400 })
    await expect(f.actions.prepareForm(f.principal, f.session, { resource: 'groups', operation: 'update', target_id: randomUUID() }, f.emit)).rejects.toMatchObject({ status: 404 })
    expect(f.events).toHaveLength(0)
  }))
  test('所有已给字段使用保存接口校验，非法类型与超长值不能进入弹框', () => using(async f => {
    const bad = [
      { resource: 'members', values: { name: '姓名\n换行' } },
      { resource: 'members', values: { group_ids: [12] } },
      { resource: 'members', values: { group_ids: Array.from({ length: 65 }, () => randomUUID()) } },
      { resource: 'groups', values: { name: 'a'.repeat(65) } },
      { resource: 'provider-aliases', values: { scope: 'everyone' } },
      { resource: 'provider-aliases', values: { provider: ['one', 'two'] } },
      { resource: 'provider-aliases', values: { alias: 'a'.repeat(129) } },
      { resource: 'provider-aliases', values: { provider: '*', model: null } },
      { resource: 'provider-aliases', values: { scope: 'global', member_id: f.member.memberId } },
      { resource: 'project-aliases', values: { prefix: 'D:' } },
      { resource: 'project-aliases', values: { prefix: 'a'.repeat(513) } },
      { resource: 'pricing', values: { currency: 'cny' } },
      { resource: 'pricing', values: { input_micro_per_ktok: -1 } },
      { resource: 'pricing', values: { output_micro_per_ktok: 0.5 } },
      { resource: 'pricing', values: { output_micro_per_ktok: 10_000_001 } },
      { resource: 'pricing', values: { effective_from_ms: Number.MAX_SAFE_INTEGER + 1 } },
      { resource: 'pricing', values: { note: 'a'.repeat(256) } },
      { resource: 'pricing', values: { note: { html: '<script>ignored</script>' } } },
    ]
    for (const args of bad) await expect(f.actions.prepareForm(f.principal, f.session, { ...args, operation: 'create' } as AssistantFormRequest, f.emit)).rejects.toMatchObject({ status: 400 })
    expect(f.events).toHaveLength(0)
  }))
  test('开表单实时检查管理权限，旧Principal不能绕过撤权', () => using(async f => {
    const session = (await f.store.create(f.member.memberId)).session.session_id
    for (const resource of ['members', 'groups', 'provider-aliases', 'project-aliases', 'pricing'] as const) {
      await expect(f.actions.prepareForm(f.member, session, { resource, operation: 'create' }, f.emit)).rejects.toMatchObject({ status: 403 })
    }
    await form(f, { resource: 'provider-aliases', operation: 'create' })
    await revoke(f, 'providers:manage')
    await expect(f.actions.prepareForm(f.principal, f.session, { resource: 'provider-aliases', operation: 'create' }, f.emit)).rejects.toMatchObject({ status: 403 })
    expect(f.events).toHaveLength(1)
  }))
  test('新建人员沿用roles:assign门禁，编辑基础资料不提升角色权限', () => using(async f => {
    await revoke(f, 'roles:assign')
    await expect(f.actions.prepareForm(f.principal, f.session, { resource: 'members', operation: 'create', values: { name: '新成员' } }, f.emit)).rejects.toMatchObject({ status: 403 })
    const opened = await form(f, { resource: 'members', operation: 'update', target_id: f.member.memberId, values: { name: '预填姓名' } })
    expect(opened.values.name).toBe('预填姓名')
    expect(opened.values).not.toHaveProperty('role_ids')
    expect((await f.repository.resolveBearer(MEMBER_TOKEN))?.roleCodes).toEqual(['member'])
  }))
  test('其他owner、删除会话或会话权限范围变化后不能打开旧表单', () => using(async f => {
    const otherSession = (await f.store.create(f.member.memberId)).session.session_id
    await expect(f.actions.prepareForm(f.principal, otherSession, { resource: 'groups', operation: 'create' }, f.emit)).rejects.toMatchObject({ status: 404 })
    await form(f, { resource: 'groups', operation: 'create' })
    const group = (await call(f, 'POST', 'groups', { name: '新权限范围' })).group
    const current = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.principal.memberId)
    await call(f, 'POST', 'members/update', { member_id: f.principal.memberId, expected_version: current.version, group_ids: [group.group_id] })
    await expect(f.actions.prepareForm(f.principal, f.session, { resource: 'groups', operation: 'create' }, f.emit)).rejects.toMatchObject({ status: 403 })
    await f.store.delete(f.principal.memberId, f.session)
    await expect(f.actions.prepareForm(f.principal, f.session, { resource: 'groups', operation: 'create' }, f.emit)).rejects.toMatchObject({ status: 404 })
    expect(f.events).toHaveLength(1)
  }))
})
