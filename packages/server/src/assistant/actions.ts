/**
 * 助手管理动作桥：有限资源复用原管理路由，删除与停用只能交给浏览器确认。
 * ★ 模型永远拿不到确认工具；确认请求引用服务端保存的计划，不能附带替换目标或参数。
 */
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ASSISTANT_FORMS, type AssistantEvent, type AssistantForm, type AssistantFormRequest, type AssistantFormResource, type AssistantFormValues, type AssistantPendingAction } from '@ai-token-report/shared'
import {
  portalCreateMemberSchema, portalUpdateMemberSchema, portalMemberStatusSchema,
  portalCreateGroupSchema, portalUpdateGroupSchema, portalGroupStatusSchema,
  portalSetProviderAliasSchema, portalProviderAliasIdSchema, portalProviderAliasStatusSchema,
  portalSetProjectAliasSchema, portalProjectAliasIdSchema, portalProjectAliasStatusSchema,
  portalSetModelPriceSchema, portalModelPriceIdSchema,
} from '@ai-token-report/shared/schemas'
import type { DatabaseAdminRoute } from '../admin-route.js'
import { IdentityError, MEMBER_ROLE_ID, requirePermission, type Principal, type MutationInput } from '../identity/types.js'
import { identitySnapshotHash, type IdentityMutationPrecondition } from '../identity/repository.js'
import type { AssistantStore } from './store.js'
import { replaceAssistantFile } from './atomic-file.js'

export const ASSISTANT_ADMIN_RESOURCES = ['members', 'groups', 'roles', 'provider-aliases', 'project-aliases', 'pricing'] as const
type Resource = typeof ASSISTANT_ADMIN_RESOURCES[number]
type Operation = 'create' | 'update' | 'delete' | 'disable' | 'enable'
export interface AssistantAdminQuery { resource: string; search?: string; limit?: number }
export interface AssistantAdminMutation { resource: string; operation: string; target_id?: string; values?: MutationInput }
interface Plan { path: string; body: MutationInput; condition?: IdentityMutationPrecondition }
interface StoredAction {
  version: 1
  ownerMemberId: string
  authenticationHash: string
  sessionId: string
  action: AssistantPendingAction
  state: AssistantPendingAction['status'] | 'executing'
  plan: Plan
}
export interface AssistantConfirmation {
  ok: boolean
  action: AssistantPendingAction
  data?: unknown
  status?: number
  reason?: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDS: Record<Resource, string> = { members: 'member_id', groups: 'group_id', roles: 'role_id', 'provider-aliases': 'alias_id', 'project-aliases': 'alias_id', pricing: 'price_id' }
const COLLECTIONS: Record<Resource, string> = { members: 'members', groups: 'groups', roles: 'roles', 'provider-aliases': 'aliases', 'project-aliases': 'aliases', pricing: 'prices' }
const LABELS: Record<Resource, string> = { members: '人员', groups: '分组', roles: '角色', 'provider-aliases': '供应商模型规则', 'project-aliases': '项目规则', pricing: '模型单价' }
const ALIAS_KEYS = ['scope', 'member_id', 'provider', 'model', 'alias', 'enabled']
const PROJECT_KEYS = ['scope', 'member_id', 'prefix', 'alias', 'enabled']
const PRICE_KEYS = ['provider', 'model', 'currency', 'input_micro_per_ktok', 'output_micro_per_ktok', 'cache_read_micro_per_ktok', 'cache_write_micro_per_ktok', 'offpeak_schedule', 'offpeak_input_micro_per_ktok', 'offpeak_output_micro_per_ktok', 'offpeak_cache_read_micro_per_ktok', 'offpeak_cache_write_micro_per_ktok', 'effective_from_ms', 'effective_to_ms', 'note']
// ★ 表单允许只填一部分字段；已给字段仍复用保存接口的形状与长度校验。
const FORM_SCHEMAS = {
  members: portalCreateMemberSchema.omit({ role_ids: true }).partial(),
  groups: portalCreateGroupSchema.partial(),
  'provider-aliases': portalSetProviderAliasSchema.omit({ enabled: true }).partial(),
  'project-aliases': portalSetProjectAliasSchema.omit({ enabled: true }).partial(),
  pricing: portalSetModelPriceSchema.partial(),
}
const FORM_IMMUTABLE: Partial<Record<AssistantFormResource, readonly string[]>> = {
  'provider-aliases': ['scope', 'member_id', 'provider', 'model'],
  'project-aliases': ['scope', 'member_id', 'prefix'],
  pricing: ['provider', 'model', 'currency', 'effective_from_ms'],
}

function object(value: unknown, keys: readonly string[]): MutationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IdentityError(400, '操作参数需要是对象')
  const input = value as MutationInput
  if (Object.keys(input).some(key => !keys.includes(key))) throw new IdentityError(400, '操作包含不支持的参数；账号、凭证、角色及权限只能在管理页面修改')
  if (Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new IdentityError(400, '操作参数过长')
  return input
}
function resourceOf(value: unknown): Resource {
  if (typeof value !== 'string' || !ASSISTANT_ADMIN_RESOURCES.includes(value as Resource)) throw new IdentityError(400, '助手不支持这个管理资源')
  return value as Resource
}
function validated(schema: { safeParse(input: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } }, value: unknown): MutationInput {
  const result = schema.safeParse(value)
  if (!result.success) throw new IdentityError(400, result.error?.issues[0]?.message ?? '操作参数无效')
  return result.data as MutationInput
}
function pick(value: MutationInput, keys: readonly string[]): MutationInput {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined && !(key === 'member_id' && value[key] === null)).map(key => [key, value[key]]))
}
function targetLabel(resource: Resource, row: MutationInput): string {
  if (resource === 'members') {
    const groups = Array.isArray(row.groups) ? row.groups.map(group => String((group as MutationInput).name)).join('、') : ''
    return `${row.name}（${groups || '未分组'}；ID ${String(row.member_id).slice(0, 8)}）`
  }
  if (resource === 'groups' || resource === 'roles') return String(row.name)
  if (resource === 'pricing') {
    const at = (value: unknown) => {
      const date = new Date(Number(value))
      return Number.isFinite(date.getTime()) ? date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : String(value)
    }
    return `${row.provider} / ${row.model} (${row.currency})；${at(row.effective_from_ms)} ～ ${row.effective_to_ms == null ? '长期有效' : at(row.effective_to_ms)}（北京时间 UTC+8）`
  }
  return `${row.scope === 'global' ? '全局' : `个人 ${row.member_name ?? '未命名'}（ID ${String(row.member_id).slice(0, 8)}）`}：${resource === 'project-aliases' ? row.prefix : [row.provider, row.model].filter(Boolean).join(' / ')} → ${row.alias}`
}
/** 管理名册可以读基础信息，但不把账号、凭证摘要或认证状态转发给模型。 */
function visibleRow(resource: Resource, row: MutationInput): MutationInput {
  if (resource === 'members') return pick(row, ['member_id', 'name', 'status', 'version', 'groups', 'group_ids', 'group_names'])
  if (resource === 'roles') return pick(row, ['role_id', 'code', 'name', 'status', 'version', 'is_builtin'])
  return Object.fromEntries(Object.entries(row).filter(([key]) => !/token|secret|credential|password|account|auth/i.test(key)))
}
function visibleMutation(resource: Resource, data: unknown): unknown {
  const value = data as MutationInput
  const key = resource === 'members' ? 'member' : resource === 'groups' ? 'group' : resource === 'pricing' ? 'price' : 'alias'
  return { ok: value.ok, ...(value.deleted !== undefined ? { deleted: value.deleted } : {}), ...(value[key] && typeof value[key] === 'object' ? { [key]: visibleRow(resource, value[key] as MutationInput) } : {}) }
}

export class AssistantActions {
  private readonly now: () => number
  private readonly ttlMs: number
  constructor(private readonly admin: DatabaseAdminRoute, private readonly store: AssistantStore, options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 600_000
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 300_000 || this.ttlMs > 600_000) throw new Error('确认有效期必须为 5～10 分钟')
  }
  private async rows(principal: Principal, resource: Resource): Promise<MutationInput[]> {
    const result = await this.admin.handle('GET', resource, principal, undefined, new URLSearchParams())
    if (result.status !== 200) throw new IdentityError(result.status, String((result.body as MutationInput).reason ?? '管理查询失败'))
    const rows = (result.body as MutationInput)[COLLECTIONS[resource]]
    if (!Array.isArray(rows)) throw new IdentityError(503, '管理查询响应无效')
    return rows as MutationInput[]
  }
  async query(principal: Principal, args: AssistantAdminQuery): Promise<unknown> {
    const input = object(args, ['resource', 'search', 'limit']), resource = resourceOf(input.resource)
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 128 || /[\x00-\x1f]/.test(input.search))) throw new IdentityError(400, '搜索文本需要为 1～128 个字符')
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new IdentityError(400, '管理查询每次最多 100 行')
    const search = String(input.search ?? '').trim().toLocaleLowerCase()
    const rows = (await this.rows(principal, resource)).map(row => visibleRow(resource, row)).filter(row => !search || JSON.stringify(row).toLocaleLowerCase().includes(search))
    return { resource, rows: rows.slice(0, Number(limit)), total_rows: rows.length, truncated: rows.length > Number(limit) }
  }
  /** 只请求浏览器打开现有管理弹框；不会创建管理动作或代用户点击保存。 */
  async prepareForm(principal: Principal, sessionId: string, args: AssistantFormRequest, emit: (event: AssistantEvent) => void): Promise<unknown> {
    await this.store.get(principal.memberId, sessionId)
    const input = object(args, ['resource', 'operation', 'target_id', 'values'])
    const definition = ASSISTANT_FORMS.find(form => form.resource === input.resource)
    if (!definition) throw new IdentityError(400, '助手不支持这个填写表单')
    const resource = definition.resource
    if (input.operation !== 'create' && input.operation !== 'update') throw new IdentityError(400, '表单只支持新建或编辑')
    const operation = input.operation
    if (operation === 'create' && input.target_id !== undefined) throw new IdentityError(400, '新建表单不能指定目标 ID')
    if (operation === 'update' && (typeof input.target_id !== 'string' || !UUID.test(input.target_id))) throw new IdentityError(400, '请先查询并使用唯一目标 ID；不能按名称猜测目标')
    const values = validated(FORM_SCHEMAS[resource], object(input.values ?? {}, definition.fields))
    const current = await this.admin.authorizeAssistantMutation(principal, resource)
    await this.store.assertAccess(current, sessionId)
    if (resource === 'members' && operation === 'create') requirePermission(current, 'roles:assign')
    let merged = values
    if (operation === 'update') {
      const target = (await this.rows(principal, resource)).find(row => row[IDS[resource]] === input.target_id)
      if (!target) throw new IdentityError(404, '目标不存在或无权访问')
      for (const key of FORM_IMMUTABLE[resource] ?? []) {
        if (key in values && identitySnapshotHash(values[key] ?? null) !== identitySnapshotHash(target[key] ?? null)) throw new IdentityError(400, '目标匹配字段不能在编辑中替换；请新建另一条配置')
      }
      const base = pick(target, definition.fields)
      if (resource === 'members') base.group_ids = Array.isArray(target.groups) ? target.groups.map(group => (group as MutationInput).group_id) : []
      merged = validated(FORM_SCHEMAS[resource], { ...base, ...values })
    }
    if (resource === 'provider-aliases' || resource === 'project-aliases') {
      if (merged.scope === 'global' && merged.member_id !== undefined) throw new IdentityError(400, '全局规则不能指定人员')
      if (resource === 'provider-aliases' && merged.provider === '*' && merged.model == null) throw new IdentityError(400, '不限供应商只能用于模型规则')
    }
    const form: AssistantForm = {
      request_id: randomUUID(), resource, operation, path: definition.path,
      ...(operation === 'update' ? { target_id: String(input.target_id) } : {}),
      values: merged as AssistantFormValues,
    }
    emit({ type: 'open_form', form })
    return { ok: true, requested: true, executed: false, form, message: '已请求打开预填表单，尚未保存。用户填写后需点击管理页面的保存按钮。' }
  }
  private async plan(principal: Principal, args: AssistantAdminMutation): Promise<{ resource: Resource; operation: Operation; plan: Plan; target?: MutationInput; destructive: boolean }> {
    const input = object(args, ['resource', 'operation', 'target_id', 'values']), resource = resourceOf(input.resource)
    if (resource === 'roles') throw new IdentityError(400, '助手仅查询角色；角色与权限修改请打开角色管理页面')
    if (!['create', 'update', 'delete', 'disable', 'enable'].includes(String(input.operation))) throw new IdentityError(400, '不支持这个管理动作')
    const operation = input.operation as Operation
    if (operation === 'delete' && ['members', 'groups'].includes(resource)) throw new IdentityError(400, `${LABELS[resource]}不支持物理删除；可以使用停用，并由用户确认`)
    if (resource === 'pricing' && ['enable', 'disable'].includes(operation)) throw new IdentityError(400, '单价不支持启停，请编辑生效区间或确认删除')
    if (operation === 'create' && input.target_id !== undefined) throw new IdentityError(400, '新建不能指定目标 ID')
    if (operation !== 'create' && (typeof input.target_id !== 'string' || !UUID.test(input.target_id))) throw new IdentityError(400, '请先查询并使用唯一目标 ID；不能按名称猜测目标')
    const values = object(input.values ?? {}, operation === 'create' || operation === 'update'
      ? resource === 'members' ? ['name', 'group_ids'] : resource === 'groups' ? ['name'] : resource === 'provider-aliases' ? ALIAS_KEYS : resource === 'project-aliases' ? PROJECT_KEYS : PRICE_KEYS : [])
    if (['create', 'update'].includes(operation) && !Object.keys(values).length) throw new IdentityError(400, '请提供需要设置的字段')
    await this.admin.authorizeAssistantMutation(principal, resource)
    const rows = await this.rows(principal, resource)
    const target = operation === 'create' ? undefined : rows.find(row => row[IDS[resource]] === input.target_id)
    if (operation !== 'create' && !target) throw new IdentityError(404, '目标不存在或无权访问')
    const condition: IdentityMutationPrecondition | undefined = target ? { resource, targetId: String(input.target_id), snapshotHash: identitySnapshotHash(target) } : undefined
    let path: string = resource, body: MutationInput
    if (resource === 'members' || resource === 'groups') {
      const base = target ? { [IDS[resource]]: input.target_id, expected_version: target.version } : {}
      if (operation === 'create') body = validated(resource === 'members' ? portalCreateMemberSchema : portalCreateGroupSchema, { ...values, ...(resource === 'members' ? { role_ids: [MEMBER_ROLE_ID] } : {}) })
      else if (operation === 'update') { path += '/update'; body = validated(resource === 'members' ? portalUpdateMemberSchema : portalUpdateGroupSchema, { ...base, ...values }) }
      else { path += '/status'; body = validated(resource === 'members' ? portalMemberStatusSchema : portalGroupStatusSchema, { ...base, status: operation === 'disable' ? 'disabled' : 'active' }) }
    } else if (operation === 'delete') {
      path += '/delete'
      body = validated(resource === 'provider-aliases' ? portalProviderAliasIdSchema : resource === 'project-aliases' ? portalProjectAliasIdSchema : portalModelPriceIdSchema, { [IDS[resource]]: input.target_id })
    } else if (operation === 'enable' || operation === 'disable') {
      path += '/status'
      body = validated(resource === 'provider-aliases' ? portalProviderAliasStatusSchema : portalProjectAliasStatusSchema, { alias_id: input.target_id, enabled: operation === 'enable' })
    } else {
      const keys = resource === 'provider-aliases' ? ALIAS_KEYS : resource === 'project-aliases' ? PROJECT_KEYS : PRICE_KEYS
      const merged = { ...(target ? pick(target, keys) : {}), ...values }
      if (target) {
        // ★ 现有接口按业务键 upsert；编辑时不允许换键，否则会悄悄新建另一条配置。
        const immutable = resource === 'provider-aliases' ? ['scope', 'member_id', 'provider', 'model'] : resource === 'project-aliases' ? ['scope', 'member_id', 'prefix'] : ['provider', 'model', 'effective_from_ms']
        for (const key of immutable) if (key in values && identitySnapshotHash(values[key] ?? null) !== identitySnapshotHash(target[key] ?? null)) throw new IdentityError(400, '目标匹配字段不能在编辑中替换；请新建另一条配置')
      }
      body = validated(resource === 'provider-aliases' ? portalSetProviderAliasSchema : resource === 'project-aliases' ? portalSetProjectAliasSchema : portalSetModelPriceSchema, merged)
      if (resource !== 'pricing') {
        if ((body.scope === 'member') !== (body.member_id !== undefined)) throw new IdentityError(400, '个人规则必须填写 member_id；全局规则不能指定人员')
        if (resource === 'provider-aliases' && body.provider === '*' && body.model == null) throw new IdentityError(400, '不限供应商只能用于模型规则')
      }
    }
    const guarded = condition ?? (['provider-aliases', 'project-aliases', 'pricing'].includes(resource) ? { resource, absentKey: body } as IdentityMutationPrecondition : undefined)
    return { resource, operation, plan: { path, body, ...(guarded ? { condition: guarded } : {}) }, ...(target ? { target } : {}), destructive: operation === 'delete' || operation === 'disable' || body.enabled === false }
  }
  private async execute(principal: Principal, plan: Plan): Promise<unknown> {
    const result = await this.admin.handle('POST', plan.path, principal, plan.body, new URLSearchParams(), plan.condition)
    if (result.status !== 200 || (result.body as MutationInput).ok === false) throw new IdentityError(result.status === 200 ? 409 : result.status, String((result.body as MutationInput).reason ?? '管理操作失败'))
    return result.body
  }
  async mutate(principal: Principal, sessionId: string, args: AssistantAdminMutation, emit: (event: AssistantEvent) => void): Promise<unknown> {
    await this.store.get(principal.memberId, sessionId)
    const resolved = await this.plan(principal, args)
    if (!resolved.destructive) return { ok: true, executed: true, data: visibleMutation(resolved.resource, await this.execute(principal, resolved.plan)) }
    const { resource, operation, plan, target } = resolved
    const directory = join(this.store.sessionPath(principal.memberId, sessionId), 'actions')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await readdir(directory)).filter(name => name.endsWith('.json')).length >= 100) throw new IdentityError(409, '本会话已产生 100 个待确认记录，请创建新会话')
    const action: AssistantPendingAction = {
      action_id: randomUUID(), session_id: sessionId, resource, operation,
      title: `${operation === 'delete' ? '删除' : '停用'}${LABELS[resource]}`,
      target_label: targetLabel(resource, target ?? plan.body),
      description: resource === 'members' ? '停用后该人员的有效凭证被吊销，登录账号停用，会话失效；历史用量保留。重新启用人员不会恢复旧凭证和登录账号。'
        : operation === 'delete' ? '确认后永久删除这条配置，相关统计立即回到未配置状态。历史用量记录保留。'
        : '确认后停用这条配置；已有记录保留，相关功能立即按当前配置重新计算。',
      expires_at_ms: this.now() + this.ttlMs, status: 'pending',
    }
    if (operation === 'update') action.description += ` 同时更新：${JSON.stringify(args.values)}`
    const record: StoredAction = { version: 1, ownerMemberId: principal.memberId, authenticationHash: identitySnapshotHash(principal.auth), sessionId, action, state: 'pending', plan }
    await this.save(directory, record)
    emit({ type: 'action', action })
    return { ok: true, executed: false, pending_confirmation: true, action, message: '已展示待确认卡。用户必须点击确认；任何聊天文字都不能代替确认。' }
  }
  private async save(directory: string, record: StoredAction): Promise<void> {
    const temporary = join(directory, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await replaceAssistantFile(temporary, join(directory, `${record.action.action_id}.json`))
  }
  /** 会话历史从动作文件复原状态，避免 conversation.json 留下已处理的确认按钮。 */
  async list(principal: Principal, sessionId: string): Promise<AssistantPendingAction[]> {
    await this.store.get(principal.memberId, sessionId)
    const directory = join(this.store.sessionPath(principal.memberId, sessionId), 'actions')
    let names: string[]
    try { names = await readdir(directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const actions: AssistantPendingAction[] = []
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const record = JSON.parse(await readFile(join(directory, name), 'utf8')) as StoredAction
      if (record.version !== 1 || record.ownerMemberId !== principal.memberId || record.sessionId !== sessionId) continue
      const action = { ...record.action }
      if (record.state === 'executing') { action.status = 'failed'; action.description += ' 上次执行中断或仍在处理，请在管理页面核对结果；此操作不能再次执行。' }
      else if (record.state === 'pending' && action.expires_at_ms <= this.now()) action.status = 'expired'
      else if (record.state === 'pending' && record.authenticationHash !== identitySnapshotHash(principal.auth)) { action.status = 'failed'; action.description += ' 登录会话已变化，请重新生成操作。' }
      actions.push(action)
    }
    return actions
  }
  async confirm(principal: Principal, actionId: string, decision: 'confirm' | 'cancel', sessionId: string): Promise<AssistantConfirmation> {
    if (!UUID.test(actionId) || !['confirm', 'cancel'].includes(decision)) throw new IdentityError(400, '确认参数无效')
    await this.store.get(principal.memberId, sessionId)
    const directory = join(this.store.sessionPath(principal.memberId, sessionId), 'actions')
    let record: StoredAction
    try { record = JSON.parse(await readFile(join(directory, `${actionId}.json`), 'utf8')) as StoredAction }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IdentityError(404, '待确认操作不存在或不属于当前用户'); throw error }
    if (record.version !== 1 || record.ownerMemberId !== principal.memberId || record.sessionId !== sessionId || record.action.action_id !== actionId || record.authenticationHash !== identitySnapshotHash(principal.auth)) throw new IdentityError(404, '待确认操作不存在或不属于当前登录会话')
    let lock: Awaited<ReturnType<typeof open>>
    try { lock = await open(join(directory, `${actionId}.lock`), 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new IdentityError(409, '操作正在处理或已被消费，请勿重复确认'); throw error }
    try {
      // ★ 必须在独占锁后重读。多个服务实例都能看到文件锁，进程内 Set 不足以防重放。
      record = JSON.parse(await readFile(join(directory, `${actionId}.json`), 'utf8')) as StoredAction
      if (record.state !== 'pending') return { ok: false, status: 409, reason: '操作已处理，不能重复确认', action: record.state === 'executing' ? { ...record.action, status: 'failed', description: record.action.description + ' 上次执行中断或仍在处理，请在管理页面核对结果；此操作不能再次执行。' } : record.action }
      if (record.action.expires_at_ms <= this.now()) {
        record.state = record.action.status = 'expired'; await this.save(directory, record)
        return { ok: false, status: 410, reason: '确认已过期，请重新生成操作', action: record.action }
      }
      if (decision === 'cancel') {
        record.state = record.action.status = 'cancelled'; await this.save(directory, record)
        return { ok: true, action: record.action }
      }
      // ★ 先持久化消费状态，再触碰数据库。崩溃后的 executing 永远不能再次执行。
      record.state = 'executing'; await this.save(directory, record)
      let data: unknown
      try {
        await this.admin.authorizeAssistantMutation(principal, record.action.resource)
        data = await this.execute(principal, record.plan)
      } catch (error) {
        record.state = record.action.status = 'failed'; await this.save(directory, record)
        return { ok: false, action: record.action, status: error instanceof IdentityError ? error.status : 503, reason: error instanceof IdentityError ? error.message : '管理操作暂时不可用，请重新生成操作' }
      }
      record.state = record.action.status = 'confirmed'; await this.save(directory, record)
      return { ok: true, action: record.action, data: visibleMutation(resourceOf(record.action.resource), data) }
    } finally {
      await lock.close()
      await unlink(join(directory, `${actionId}.lock`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
  }
}
