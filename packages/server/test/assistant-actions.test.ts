/** 助手动作桥的真实 SQLite 验收：确认状态持久化，权限与目标快照在写事务内重验。 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AssistantEvent, AssistantPendingAction } from '@ai-token-report/shared'
import { DatabaseAdminRoute } from '../src/admin-route.js'
import { AssistantActions } from '../src/assistant/actions.js'
import { AssistantStore } from '../src/assistant/store.js'
import { IdentityError, type Principal } from '../src/identity/types.js'
import { seedDatabaseIdentity } from './database-fixture.js'

const ADMIN_TOKEN = 'assistant-actions-primary-admin'
const SECOND_TOKEN = 'assistant-actions-secondary-admin'
const MEMBER_TOKEN = 'assistant-actions-member-token'
type Fixture = Awaited<ReturnType<typeof fixture>>
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'atr-assistant-actions-'))
  const repository = await seedDatabaseIdentity({ sqlitePath: join(directory, 'portal.sqlite') }, [
    { token: ADMIN_TOKEN, name: '主要管理员', role: 'admin' },
    { token: SECOND_TOKEN, name: '备用管理员', role: 'admin' },
    { token: MEMBER_TOKEN, name: '普通成员', role: 'member' },
  ])
  const admin = new DatabaseAdminRoute(repository), store = new AssistantStore(join(directory, 'assistant'))
  const principal = (await repository.resolveBearer(ADMIN_TOKEN))!, second = (await repository.resolveBearer(SECOND_TOKEN))!, member = (await repository.resolveBearer(MEMBER_TOKEN))!
  const session = (await store.create(principal.memberId)).session.session_id
  let time = Date.now()
  const actions = new AssistantActions(admin, store, { now: () => time })
  const events: AssistantEvent[] = []
  return { directory, repository, admin, store, principal, second, member, session, actions, events, emit: (event: AssistantEvent) => events.push(event), advance: (ms: number) => { time += ms }, now: () => time }
}
async function using(work: (f: Fixture) => Promise<void>) {
  const f = await fixture()
  try { await work(f) } finally { await rm(f.directory, { recursive: true, force: true }) }
}
async function call(f: Fixture, method: string, path: string, body?: unknown, principal = f.principal): Promise<any> {
  const response = await f.admin.handle(method, path, principal, body, new URLSearchParams())
  expect(response.status).toBe(200)
  return response.body
}
async function rule(f: Fixture, resource = 'provider-aliases'): Promise<string> {
  const values = resource === 'project-aliases' ? { scope: 'global', prefix: 'example-repository', alias: '示例项目' } : { scope: 'global', provider: 'sample-provider', alias: '示例供应商' }
  const result: any = await f.actions.mutate(f.principal, f.session, { resource, operation: 'create', values }, f.emit)
  return result.data.alias.alias_id
}
async function pending(f: Fixture, target: string, resource = 'provider-aliases', operation = 'delete'): Promise<AssistantPendingAction> {
  const result: any = await f.actions.mutate(f.principal, f.session, { resource, operation, target_id: target }, f.emit)
  expect(result.pending_confirmation).toBe(true)
  expect(result.action.status).toBe('pending')
  return result.action
}

describe('助手有限管理资源', () => {
  test('管理查询实时鉴权并隐藏登录、角色权限和凭证信息', () => using(async f => {
    const listed: any = await f.actions.query(f.principal, { resource: 'members', search: '普通成员' })
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0].name).toBe('普通成员')
    expect(JSON.stringify(listed)).not.toMatch(/token|account|password|permissions/)
    await expect(f.actions.query(f.member, { resource: 'members' })).rejects.toMatchObject({ status: 403 })
    await expect(f.actions.query(f.principal, { resource: 'members/login' })).rejects.toMatchObject({ status: 400 })
  }))
  test('普通成员创建和基础编辑复用管理业务校验', () => using(async f => {
    const group: any = await f.actions.mutate(f.principal, f.session, { resource: 'groups', operation: 'create', values: { name: '研发组' } }, f.emit)
    const created: any = await f.actions.mutate(f.principal, f.session, { resource: 'members', operation: 'create', values: { name: '新同事', group_ids: [group.data.group.group_id] } }, f.emit)
    const target = created.data.member.member_id
    const edited: any = await f.actions.mutate(f.principal, f.session, { resource: 'members', operation: 'update', target_id: target, values: { name: '新同事乙', group_ids: [] } }, f.emit)
    expect(edited.data.member.name).toBe('新同事乙')
    const full = (await call(f, 'GET', 'members')).members.find((member: any) => member.member_id === target)
    expect(full.roles.map((role: any) => role.code)).toEqual(['member'])
    expect(full.groups).toHaveLength(0)
    expect(JSON.stringify(edited)).not.toMatch(/token|account|password/)
  }))
  test('禁止模型改安全字段、任意路径、角色权限或自称已确认', () => using(async f => {
    const bad = [
      { resource: 'roles', operation: 'update', target_id: randomUUID(), values: { name: '篡改角色' } },
      { resource: 'members', operation: 'create', values: { name: '越权成员', role_ids: [randomUUID()] } },
      { resource: 'members', operation: 'update', target_id: f.member.memberId, values: { password: 'do-not-accept' } },
      { resource: '../members', operation: 'delete', target_id: f.member.memberId },
      { resource: 'members', operation: 'disable', target_id: f.member.memberId, confirmed: true },
      { resource: 'members', operation: 'delete', target_id: f.member.memberId },
      { resource: 'groups', operation: 'delete', target_id: randomUUID() },
    ]
    for (const args of bad) await expect(f.actions.mutate(f.principal, f.session, args, f.emit)).rejects.toMatchObject({ status: 400 })
    expect(await f.repository.resolveBearer(MEMBER_TOKEN)).not.toBeNull()
  }))
  test('规则新建不能覆盖已有目标，编辑不能替换业务键', () => using(async f => {
    const id = await rule(f)
    const edited: any = await f.actions.mutate(f.principal, f.session, { resource: 'provider-aliases', operation: 'update', target_id: id, values: { alias: '更新供应商' } }, f.emit)
    expect(edited.data.alias.alias_id).toBe(id)
    expect(edited.data.alias.alias).toBe('更新供应商')
    await expect(rule(f)).rejects.toMatchObject({ status: 409 })
    await expect(f.actions.mutate(f.principal, f.session, { resource: 'provider-aliases', operation: 'update', target_id: id, values: { provider: 'another-provider' } }, f.emit)).rejects.toMatchObject({ status: 400 })
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('模型单价可以新建和编辑，非法单价无写入', () => using(async f => {
    const values = { provider: 'sample-provider', model: 'sample-model', currency: 'CNY', input_micro_per_ktok: 100, output_micro_per_ktok: 200, cache_read_micro_per_ktok: 10, cache_write_micro_per_ktok: 50, effective_from_ms: 0 }
    const created: any = await f.actions.mutate(f.principal, f.session, { resource: 'pricing', operation: 'create', values }, f.emit)
    const id = created.data.price.price_id
    const edited: any = await f.actions.mutate(f.principal, f.session, { resource: 'pricing', operation: 'update', target_id: id, values: { input_micro_per_ktok: 150 } }, f.emit)
    expect(edited.data.price.input_micro_per_ktok).toBe(150)
    await expect(f.actions.mutate(f.principal, f.session, { resource: 'pricing', operation: 'update', target_id: id, values: { output_micro_per_ktok: -1 } }, f.emit)).rejects.toMatchObject({ status: 400 })
    const action = await pending(f, id, 'pricing')
    expect((await call(f, 'GET', 'pricing')).prices).toHaveLength(1)
    expect((await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)).ok).toBe(true)
    expect((await call(f, 'GET', 'pricing')).prices).toHaveLength(0)
  }))
  test('只读memberAccess不包含认证能力，跟随撤权和停用', () => using(async f => {
    const access = await f.repository.memberAccess(f.member.memberId)
    expect(access).not.toBeNull()
    expect(access).not.toHaveProperty('auth')
    expect(access?.permissions).toContain('stats:read')
    const current = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.member.memberId)
    await call(f, 'POST', 'members/status', { member_id: f.member.memberId, expected_version: current.version, status: 'disabled' })
    expect(await f.repository.memberAccess(f.member.memberId)).toBeNull()
  }))
})

describe('助手确认与不可重放', () => {
  test('删除只生成卡片，重启后确认一次，管理审计只有一次删除', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    expect(f.events.some(event => event.type === 'action' && event.action.action_id === action.action_id)).toBe(true)
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
    const restarted = new AssistantActions(f.admin, f.store)
    const result = await restarted.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(result.ok).toBe(true)
    expect(result.action.status).toBe('confirmed')
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(0)
    expect((await restarted.confirm(f.principal, action.action_id, 'confirm', f.session)).status).toBe(409)
    const audit = await f.repository.read(tx => tx.all<{ action: string }>('SELECT action FROM admin_audit_log WHERE action = $action', { $action: 'provider_alias.delete' }))
    expect(audit).toHaveLength(1)
    expect((await restarted.list(f.principal, f.session))[0]?.status).toBe('confirmed')
  }))
  test('拒绝与过期都不删除，状态恢复正确', () => using(async f => {
    const id = await rule(f), cancelled = await pending(f, id)
    expect((await f.actions.confirm(f.principal, cancelled.action_id, 'cancel', f.session)).action.status).toBe('cancelled')
    expect((await f.actions.confirm(f.principal, cancelled.action_id, 'confirm', f.session)).status).toBe(409)
    const expired = await pending(f, id)
    f.advance(600_001)
    expect((await f.actions.list(f.principal, f.session)).find(action => action.action_id === expired.action_id)?.status).toBe('expired')
    expect((await f.actions.confirm(f.principal, expired.action_id, 'confirm', f.session)).status).toBe(410)
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('确认时被撤权，旧Principal不能写入', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    await f.repository.systemWrite(tx => tx.run('DELETE FROM report_token_scopes WHERE token_id = $token AND permission_id IN (SELECT permission_id FROM permissions WHERE code = $code)', { $token: f.principal.auth.kind === 'token' ? f.principal.auth.tokenId : '', $code: 'providers:manage' }))
    const result = await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(result.status).toBe(403)
    expect(result.action.status).toBe('failed')
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('目标在用户查看后改变，确认拒绝且保留新对象', () => using(async f => {
    const id = await rule(f, 'project-aliases'), action = await pending(f, id, 'project-aliases')
    await call(f, 'POST', 'project-aliases', { scope: 'global', prefix: 'example-repository', alias: '其他管理员的新设置' })
    const result = await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(result.status).toBe(409)
    expect((await call(f, 'GET', 'project-aliases')).aliases[0].alias).toBe('其他管理员的新设置')
  }))
  test('紧贴删除前的并发修改仍由事务内快照拦截', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    const original = f.admin.handle.bind(f.admin)
    let intercepted = false
    f.admin.handle = async (...args) => {
      if (args[0] === 'POST' && args[1] === 'provider-aliases/delete' && args[5] && !intercepted) {
        intercepted = true
        await original('POST', 'provider-aliases', f.second, { scope: 'global', provider: 'sample-provider', alias: '并发改名' }, new URLSearchParams())
      }
      return original(...args)
    }
    const result = await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(intercepted).toBe(true)
    expect(result.status).toBe(409)
    expect((await call(f, 'GET', 'provider-aliases')).aliases[0].alias).toBe('并发改名')
  }))
  test('不同owner、对话或认证会话都不能确认其他动作', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    const otherSession = (await f.store.create(f.second.memberId)).session.session_id
    await expect(f.actions.confirm(f.second, action.action_id, 'confirm', otherSession)).rejects.toMatchObject({ status: 404 })
    const sameOwnerOtherSession = (await f.store.create(f.principal.memberId)).session.session_id
    await expect(f.actions.confirm(f.principal, action.action_id, 'confirm', sameOwnerOtherSession)).rejects.toMatchObject({ status: 404 })
    const changedAuth: Principal = { ...f.principal, auth: { kind: 'session', accountId: randomUUID(), sessionId: randomUUID() } }
    await expect(f.actions.confirm(changedAuth, action.action_id, 'confirm', f.session)).rejects.toMatchObject({ status: 404 })
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('两个实例并发确认，只写入一次', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    const other = new AssistantActions(f.admin, f.store)
    const results = await Promise.allSettled([f.actions.confirm(f.principal, action.action_id, 'confirm', f.session), other.confirm(f.principal, action.action_id, 'confirm', f.session)])
    expect(results.filter(result => result.status === 'fulfilled' && result.value.ok)).toHaveLength(1)
    const audit = await f.repository.read(tx => tx.all('SELECT audit_id FROM admin_audit_log WHERE action = $action', { $action: 'provider_alias.delete' }))
    expect(audit).toHaveLength(1)
  }))
  test('执行中断的持久状态不能在重启后重放', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    const path = join(f.store.sessionPath(f.principal.memberId, f.session), 'actions', `${action.action_id}.json`)
    const record = JSON.parse(await readFile(path, 'utf8')); record.state = 'executing'
    await writeFile(path, JSON.stringify(record))
    const restarted = new AssistantActions(f.admin, f.store)
    expect((await restarted.confirm(f.principal, action.action_id, 'confirm', f.session)).status).toBe(409)
    expect((await restarted.list(f.principal, f.session))[0]?.status).toBe('failed')
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('删除会话同时删除待确认计划，不能继续确认', () => using(async f => {
    const id = await rule(f), action = await pending(f, id)
    await f.store.delete(f.principal.memberId, f.session)
    await expect(f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)).rejects.toMatchObject({ status: 404 })
    expect((await call(f, 'GET', 'provider-aliases')).aliases).toHaveLength(1)
  }))
  test('停用成员必须确认，确认后吊销凭证而保留成员历史', () => using(async f => {
    const action = await pending(f, f.member.memberId, 'members', 'disable')
    expect(action.description).toContain('吊销')
    expect(await f.repository.resolveBearer(MEMBER_TOKEN)).not.toBeNull()
    const result = await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(result.ok).toBe(true)
    expect(await f.repository.resolveBearer(MEMBER_TOKEN)).toBeNull()
    const member = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.member.memberId)
    expect(member.status).toBe('disabled')
  }))
  test('最后管理员护栏在确认事务内拒绝并回滚', () => using(async f => {
    const second = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.second.memberId)
    await call(f, 'POST', 'members/status', { member_id: second.member_id, expected_version: second.version, status: 'disabled' })
    const action = await pending(f, f.principal.memberId, 'members', 'disable')
    const result = await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(await f.repository.resolveBearer(ADMIN_TOKEN)).not.toBeNull()
    expect((await f.repository.memberAccess(f.principal.memberId))?.permissions).toContain('members:manage')
  }))
  test('update中隐藏停用字段也需要确认，取消后未更新', () => using(async f => {
    const id = await rule(f)
    const result: any = await f.actions.mutate(f.principal, f.session, { resource: 'provider-aliases', operation: 'update', target_id: id, values: { enabled: false, alias: '准备停用' } }, f.emit)
    expect(result.pending_confirmation).toBe(true)
    expect(result.action.description).toContain('准备停用')
    expect((await call(f, 'GET', 'provider-aliases')).aliases[0].enabled).toBe(true)
    await f.actions.confirm(f.principal, result.action.action_id, 'cancel', f.session)
    expect((await call(f, 'GET', 'provider-aliases')).aliases[0].alias).toBe('示例供应商')
  }))
  test('规则和分组启停只有停用需要确认，现有分组关联保留', () => using(async f => {
    const id = await rule(f, 'project-aliases')
    const action = await pending(f, id, 'project-aliases', 'disable')
    expect((await call(f, 'GET', 'project-aliases')).aliases[0].enabled).toBe(true)
    expect((await f.actions.confirm(f.principal, action.action_id, 'confirm', f.session)).ok).toBe(true)
    expect((await call(f, 'GET', 'project-aliases')).aliases[0].enabled).toBe(false)
    const enabled: any = await f.actions.mutate(f.principal, f.session, { resource: 'project-aliases', operation: 'enable', target_id: id }, f.emit)
    expect(enabled.pending_confirmation).toBeUndefined()
    expect((await call(f, 'GET', 'project-aliases')).aliases[0].enabled).toBe(true)
    const group = (await call(f, 'POST', 'groups', { name: '保留关联组' })).group
    const member = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.member.memberId)
    await call(f, 'POST', 'members/update', { member_id: f.member.memberId, expected_version: member.version, group_ids: [group.group_id] })
    const groupAction = await pending(f, group.group_id, 'groups', 'disable')
    expect((await f.actions.confirm(f.principal, groupAction.action_id, 'confirm', f.session)).ok).toBe(true)
    const updated = (await call(f, 'GET', 'members')).members.find((row: any) => row.member_id === f.member.memberId)
    expect(updated.groups.map((item: any) => item.group_id)).toContain(group.group_id)
  }))
  test('确认摘要区分同名人员、个人规则归属与同模型多个单价区间', () => using(async f => {
    const group = (await call(f, 'POST', 'groups', { name: '另一组' })).group
    const sameName = (await call(f, 'POST', 'members', { name: f.member.name, group_ids: [group.group_id], role_ids: ['00000000-0000-4000-8000-000000000002'] })).member
    const first = await pending(f, f.member.memberId, 'members', 'disable')
    const second = await pending(f, sameName.member_id, 'members', 'disable')
    expect(first.target_label).toContain('未分组')
    expect(first.target_label).toContain(f.member.memberId.slice(0, 8))
    expect(second.target_label).toContain('另一组')
    expect(second.target_label).toContain(sameName.member_id.slice(0, 8))
    expect(first.target_label).not.toBe(second.target_label)
    const ownerRule = (await call(f, 'POST', 'provider-aliases', { scope: 'member', member_id: sameName.member_id, provider: 'sample-provider', alias: '个人供应商' })).alias
    expect((await pending(f, ownerRule.alias_id)).target_label).toContain(sameName.member_id.slice(0, 8))
    const values = { provider: 'sample-provider', model: 'sample-model', currency: 'CNY', input_micro_per_ktok: 100, output_micro_per_ktok: 200, cache_read_micro_per_ktok: 10, cache_write_micro_per_ktok: 50 }
    const earlier = (await call(f, 'POST', 'pricing', { ...values, effective_from_ms: 0, effective_to_ms: 1000 })).price
    const later = (await call(f, 'POST', 'pricing', { ...values, effective_from_ms: 2000 })).price
    const earlierAction = await pending(f, earlier.price_id, 'pricing'), laterAction = await pending(f, later.price_id, 'pricing')
    expect(earlierAction.target_label).toContain('1970-01-01 08:00:00')
    expect(earlierAction.target_label).toContain('1970-01-01 08:00:01')
    expect(laterAction.target_label).toContain('1970-01-01 08:00:02')
    expect(laterAction.target_label).toContain('长期有效')
    expect(laterAction.target_label).toContain('北京时间 UTC+8')
    expect(earlierAction.target_label).not.toBe(laterAction.target_label)
  }))
})
