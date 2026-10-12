/** 管理报表复用真实统计链路，钉住同窗同筛选、私有多节导出与任何章节失败时不生成文件。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePeriod } from '@ai-token-report/core'
import type { AssistantEvent } from '@ai-token-report/shared'
import { seedDatabaseIdentity } from './database-fixture.js'
import { createHandlerFor } from '../src/index.js'
import { StatsRoute } from '../src/stats-route.js'
import { IdentityError, MEMBER_ROLE_ID, type Principal } from '../src/identity/types.js'
import { AssistantStore } from '../src/assistant/store.js'
import { AssistantArtifacts } from '../src/assistant/artifacts.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { generateManagementReport } from '../src/assistant/reports.js'

const root = mkdtempSync(join(tmpdir(), 'atr-reports-')), dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'report-admin', name: '管理员', role: 'admin' },
  { token: 'report-member', name: '甲成员', role: 'member' },
  { token: 'report-other', name: '乙成员', role: 'member' },
])
const admin = (await identity.resolveBearer('report-admin'))!, member = (await identity.resolveBearer('report-member'))!
const bundle = await createHandlerFor({ dataDir: root, dshHome: root, dbPath, requestLog: false })
const now = new Date(), year = now.getFullYear(), month = now.getMonth()
for (const token of ['report-member', 'report-other']) {
  const response = await bundle.handler(new Request('http://localhost/api/v1/token-usage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, client: {}, generatedAt: now.toISOString(), records: [
      { seq: 1, ts: new Date(year, month - 1, 5).getTime(), model: '模型甲' },
      { seq: 2, ts: new Date(year, month - 1, 15).getTime(), model: '模型乙' },
      { seq: 3, ts: now.getTime() - 1000, model: '模型甲' },
    ].map(record => ({ ...record, event_id: `${token}:${record.seq}`, session_id: token, provider: '供应商甲', source: 'codex', cwd: 'D:\\Coding\\项目甲', input_tokens: 137, output_tokens: 13, cache_read_tokens: 900, cache_write_tokens: 50, reasoning_tokens: 0 })) }),
  }))
  expect(response.status).toBe(200)
}
afterAll(async () => { await bundle.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })

class RecordingStats extends StatsRoute {
  calls: Array<{ endpoint: string; params: URLSearchParams; principal: Principal }> = []
  failure?: string
  override async handle(...args: Parameters<StatsRoute['handle']>) {
    const [endpoint, params, principal] = args
    this.calls.push({ endpoint, params: new URLSearchParams(params), principal: principal! })
    if (endpoint === this.failure) return { status: 503, body: { ok: false, reason: '模拟一个章节失败' } }
    return super.handle(...args)
  }
}
async function fixture(principal = admin) {
  const artifactRoot = join(root, `assistant-${crypto.randomUUID()}`), store = new AssistantStore(artifactRoot)
  const session = (await store.create(principal.memberId)).session.session_id
  const stats = new RecordingStats({ identityStore: identity, dbPath }), datasets = new AssistantDatasets(), artifacts = new AssistantArtifacts(artifactRoot)
  const events: AssistantEvent[] = []
  return { stats, datasets, artifacts, events, session, run: (input: unknown, authorize: () => Promise<Principal> = async () => principal, signal?: AbortSignal) => generateManagementReport(stats, datasets, input, authorize, event => events.push(event), { artifacts, sessionId: session, signal }) }
}
function completed(output: Awaited<ReturnType<typeof generateManagementReport>>) {
  if (!('sections' in output)) throw new Error(`报表未完成：${output.status}`)
  return output
}

test('完整上月默认报表同窗查询五节，导出只含真实授权数据与证据边界', async () => {
  const f = await fixture(), output = completed(await f.run({ preset: 'monthly' }))
  expect(output.sections).toHaveLength(5)
  expect(output.artifact.format).toBe('html')
  expect(output.artifact.share).toBeUndefined()
  expect(output.range.from).toBe(resolvePeriod('lastmonth', new Date(output.frozen_at_ms))!.sinceMs)
  expect(output.range.to).toBe(resolvePeriod('lastmonth', new Date(output.frozen_at_ms))!.untilMs!)
  expect(new Set(f.stats.calls.map(call => `${call.params.get('from')}:${call.params.get('to')}`)).size).toBe(1)
  expect(f.stats.calls.every(call => call.params.get('identity_view') === 'member')).toBe(true)
  expect(output.sections[0]!.rows[0]?.total_tokens).toBe(4400)
  expect(output.sections[0]!.rows[0]?.sessions).toBe(2)
  expect(output.sections[0]!.metrics_display.some(card => card.label === '会话数')).toBe(true)
  const html = await (await f.artifacts.download(admin.memberId, output.artifact.artifact_id, admin)).text()
  for (const section of output.sections) expect(html).toContain(section.title)
  expect(html).toContain('授权范围')
  expect(html).toContain('不能代表人员绩效')
  expect(html).toContain('没有应采人员名单')
  expect(html).toContain('未计价不等于零')
  expect(html).toContain('冻结窗口')
  expect(output.comparison).toBeNull()
  expect(f.events.filter(event => event.type === 'artifact')).toHaveLength(1)
})

test('显式日期、精确成员与来源模型筛选传播到每节和比较期，不推断增长率', async () => {
  const f = await fixture()
  const first = new Date(year, month - 1, 1).toLocaleDateString('sv-SE'), last = new Date(year, month, 0).toLocaleDateString('sv-SE')
  const output = completed(await f.run({ preset: 'weekly', from_date: first, to_date: last, member_name: member.name, source: 'codex', provider: '供应商甲', model: '模型甲', dimensions: ['source', 'model'], compare_period: 'last7d', format: 'xlsx' }))
  expect(output.sections).toHaveLength(5)
  expect(output.artifact.format).toBe('xlsx')
  expect(output.scope.data_scope).toBe('selected_member')
  expect(output.sections[0]!.rows[0]?.total_tokens).toBe(1100)
  const usageCalls = f.stats.calls.filter(call => ['overview', 'series', 'breakdown'].includes(call.endpoint))
  for (const call of usageCalls) {
    expect(call.params.get('member_id')).toBe(member.memberId)
    expect(call.params.get('source')).toBe('codex')
    expect(call.params.get('provider')).toBe('供应商甲')
    expect(call.params.get('model')).toBe('模型甲')
  }
  expect(output.comparison?.growth_rates_calculated).toBe(false)
  expect(output.sections.at(-1)!.title).toContain('比较期总览')
  expect(output.comparison?.range.from).toBe(resolvePeriod('last7d', new Date(output.frozen_at_ms))!.sinceMs)
})

test('成员报表始终只有本人且金额无权限明确说明，不能点名别人', async () => {
  const f = await fixture(member), output = completed(await f.run({ preset: 'cost', dimensions: ['user', 'model'], format: 'md' }))
  expect(output.sections[0]!.rows[0]?.total_tokens).toBe(2200)
  expect(output.sections.flatMap(section => section.columns).some(column => column.key === 'cost')).toBe(false)
  expect(output.limitations).toContain('当前身份没有金额读取权限，本报表仅包含授权用量。')
  expect(f.stats.calls.every(call => call.params.get('member_id') === member.memberId)).toBe(true)
  const denied = await fixture(member)
  expect((await denied.run({ member_name: '乙成员' })).status).toBe('forbidden')
  expect(denied.stats.calls).toHaveLength(0)
  expect(await denied.artifacts.list(member.memberId, denied.session, member)).toEqual([])
})

test('数据质量含授权诊断与可见真值卡，最近用量不冒充最近上报', async () => {
  const f = await fixture(member), output = completed(await f.run({ preset: 'quality', format: 'docx' }))
  const diagnostics = output.sections.find(section => section.title === '采集诊断与数据边界')!
  expect(diagnostics.metrics_display.some(card => card.label === '已入库事件')).toBe(true)
  expect(diagnostics.columns.some(column => column.label === '最近用量时间')).toBe(true)
  expect(output.limitations.join('\n')).toContain('结构性口径恒值不代表已逐条审计通过')
  expect(output.artifact.note).toContain('最近用量时间不等于最近上报时间')
  expect(f.stats.calls.find(call => call.endpoint === 'diagnostics')!.params.get('member_id')).toBe(member.memberId)
})

test('任何一节失败时不生成部分文件，也不发送部分展示', async () => {
  const f = await fixture(); f.stats.failure = 'breakdown'
  await expect(f.run({ preset: 'monthly' })).rejects.toThrow('统计查询失败')
  expect(await f.artifacts.list(admin.memberId, f.session, admin)).toEqual([])
  expect(f.events.filter(event => ['result', 'artifact'].includes(event.type))).toEqual([])
})

test('非法维度、比较日期与未知参数在任何查询前拒绝', async () => {
  for (const input of [
    { preset: 'nope' }, { preset: null }, { dimensions: null }, { format: null }, { period: null }, { compare_period: null }, { constructor: 'invalid' },
    { dimensions: [] }, { dimensions: ['user', 'user'] }, { dimensions: ['user', 'source', 'model', 'project'] }, { dimensions: ['not-a-dimension'] },
    { format: 'csv' }, { provider: 1 }, { compare_period: 'lastmonth', compare_from_date: '2026-01-01', compare_to_date: '2026-01-31' },
    { compare_from_date: '2026-01-01' }, { from_date: '2026-02-31', to_date: '2026-03-01' }, { from_date: '2026-03-01', to_date: '2026-02-01' }, { content: '模型正文' },
  ]) {
    const f = await fixture()
    await expect(f.run(input)).rejects.toBeInstanceOf(IdentityError)
    expect(f.stats.calls).toHaveLength(0)
  }
})

test('显式比较绝对日期保留实际窗口，不把原期筛选替换成默认期', async () => {
  const f = await fixture(), output = completed(await f.run({ period: 'lastmonth', compare_from_date: '2025-01-01', compare_to_date: '2025-01-31', dimensions: ['model'] }))
  expect(output.comparison?.range.from).toBe(new Date(2025, 0, 1).getTime())
  expect(output.comparison?.range.to).toBe(new Date(2025, 0, 31, 23, 59, 59, 999).getTime())
  expect(output.sections.at(-1)!.rows[0]?.total_tokens).toBe(0)
})

test('中途权限变化导致整份拒绝，文件不能混合前后身份的数据', async () => {
  const f = await fixture(), narrowed = { ...admin, permissions: admin.permissions.filter(permission => permission !== 'cost:read') }
  let calls = 0
  await expect(f.run({ dimensions: ['model'] }, async () => ++calls < 5 ? admin : narrowed)).rejects.toThrow('权限已变化')
  expect(await f.artifacts.list(admin.memberId, f.session, admin)).toEqual([])
  expect(f.events.filter(event => event.type === 'artifact')).toEqual([])
})

test('未知或同名成员不能以其他人的报表代替，已取消任务不执行查询', async () => {
  await identity.createMember(admin, { name: '报表同名', role_ids: [MEMBER_ROLE_ID] })
  await identity.createMember(admin, { name: '报表同名', role_ids: [MEMBER_ROLE_ID] })
  for (const [name, status] of [['不存在人员', 'not_found'], ['报表同名', 'ambiguous']]) {
    const f = await fixture(); expect((await f.run({ member_name: name })).status).toBe(status)
    expect(await f.artifacts.list(admin.memberId, f.session, admin)).toEqual([])
  }
  const f = await fixture(), abort = new AbortController(); abort.abort()
  await expect(f.run({}, undefined, abort.signal)).rejects.toThrow('已取消')
  expect(f.stats.calls).toHaveLength(0)
})
