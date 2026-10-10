/** 常见中文用量查询的底层能力：人员不猜测、年度不缩窗、数值与既有统计 API 一致。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { seedDatabaseIdentity } from './database-fixture.js'
import { createHandlerFor } from '../src/index.js'
import { MEMBER_ROLE_ID } from '../src/identity/types.js'
import { StatsRoute } from '../src/stats-route.js'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import { queryUsage, usageRange } from '../src/assistant/usage.js'
import { resolvePeriod } from '@ai-token-report/core'
import type { AssistantEvent } from '@ai-token-report/shared'

const root = mkdtempSync(join(tmpdir(), 'atr-assistant-usage-')), dbPath = join(root, 'portal.sqlite')
const identity = await seedDatabaseIdentity({ sqlitePath: dbPath }, [
  { token: 'usage-admin', name: '管理员', role: 'admin' }, { token: 'usage-person', name: '朱俊', role: 'member' }, { token: 'usage-other', name: '李明', role: 'member' },
])
const admin = (await identity.resolveBearer('usage-admin'))!, person = (await identity.resolveBearer('usage-person'))!
await identity.createMember(admin, { name: '王同名', role_ids: [MEMBER_ROLE_ID] })
await identity.createMember(admin, { name: '王同名', role_ids: [MEMBER_ROLE_ID] })
const bundle = await createHandlerFor({ dataDir: root, dshHome: root, dbPath, requestLog: false })
const year = new Date().getFullYear()
for (const token of ['usage-person', 'usage-other']) {
  const response = await bundle.handler(new Request('http://localhost/api/v1/token-usage', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, client: {}, generatedAt: new Date().toISOString(), records: [new Date(year - 1, 11, 30).getTime(), new Date(year, 0, 1).getTime(), Date.now()].map((ts, i) => ({ event_id: token + ':' + i, session_id: token, seq: i, ts, provider: '测试', model: '模型甲', input_tokens: 137, output_tokens: 13, cache_read_tokens: 900, cache_write_tokens: 50, reasoning_tokens: 0 })) }) }))
  expect(response.status).toBe(200)
}
const stats = new StatsRoute({ identityStore: identity, dbPath })
afterAll(async () => { await bundle.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
async function run(args: unknown, principal = admin) {
  const datasets = new AssistantDatasets(), events: AssistantEvent[] = []
  const output = await queryUsage(stats, datasets, args, async () => principal, event => events.push(event))
  return { output, events, datasets }
}
test('今年指定人员：精确解析稳定 ID、复用统计口径、一次产生指标卡', async () => {
  const { output, events } = await run({ view: 'overview', period: 'year', member_name: '朱俊', display: 'cards' })
  expect(output.status).toBe('ok')
  const result = events.find(e => e.type === 'result')!
  expect(result.type).toBe('result')
  if (result.type !== 'result') throw new Error('缺少结果')
  const params = new URLSearchParams(result.result.query)
  expect(params.get('member_id')).toBe(person.memberId)
  expect(Number(params.get('from'))).toBe(resolvePeriod('year')!.sinceMs)
  expect(result.result.cards!.find(card => card.label === '计费总量')?.value).toBe('2,200')
  expect(result.result.title).toContain('朱俊')
})
test('不存在和同名人员先澄清，不产生任何用量结果', async () => {
  expect((await run({ view: 'overview', period: 'year', member_name: '不存在' })).output.status).toBe('not_found')
  const ambiguous = await run({ view: 'overview', period: 'year', member_name: '王同名', display: 'cards' })
  expect(ambiguous.output.status).toBe('ambiguous')
  expect(ambiguous.events).toEqual([])
})
test('普通成员拒绝其他人，不能把自己的数值冒充其他人的用量', async () => {
  const denied = await run({ view: 'overview', period: 'year', member_name: '李明', display: 'cards' }, person)
  expect(denied.output.status).toBe('forbidden')
  expect(denied.events).toEqual([])
  expect((await run({ view: 'overview', period: 'year', member_name: '我', display: 'cards' }, person)).output.status).toBe('ok')
})
test('具体日期包含截止日，拒绝溢出日期和混合周期', () => {
  const params = usageRange({ from_date: '2026-02-01', to_date: '2026-02-28' })
  expect(Number(params.get('to'))).toBe(new Date(2026, 1, 28, 23, 59, 59, 999).getTime())
  expect(() => usageRange({ from_date: '2026-02-31', to_date: '2026-03-01' })).toThrow('日期不存在')
  expect(() => usageRange({ period: 'year', from_date: '2026-01-01', to_date: '2026-02-01' })).toThrow('不能同时')
  expect(Number(usageRange({ period: 'lastyear' }, new Date(2026, 9, 9)).get('from'))).toBe(new Date(2025, 0, 1).getTime())
})
test('年度日趋势逐点保持 API 真值，不补出不存在的零点', async () => {
  const { events } = await run({ view: 'series', from_date: '2025-01-01', to_date: '2025-12-31', display: 'line' })
  const result = events.find(e => e.type === 'result')
  expect(result?.type).toBe('result')
  if (result?.type !== 'result') throw new Error('没有趋势')
  expect(result.result.echarts?.kind).toBe('line')
  expect(result.result.table!.rows.length).toBe(result.result.table!.total_rows)
  const truth = await stats.handle('series', new URLSearchParams(result.result.query), admin)
  expect(result.result.table!.rows.map(row => row.total_tokens)).toEqual((truth.body as { points: Array<{ totalTokens: number }> }).points.map(point => point.totalTokens))
})
test('人员排行展示授权 API 的真实姓名，不显示无意义的哈希代号', async () => {
  const { events } = await run({ view: 'breakdown', by: 'user', period: 'year', display: 'table' })
  const result = events.find(e => e.type === 'result')
  if (result?.type !== 'result') throw new Error('缺少排行')
  expect(result.result.table!.rows.map(row => row.dimension)).toContain('朱俊')
  expect(result.result.table!.rows.map(row => row.dimension)).toContain('李明')
})
test('无需指定人员的工具输出也是可持久化的纯 JSON，避免输出后触发重试', async () => {
  const { output } = await run({ view: 'overview', period: 'year', display: 'cards' })
  const check = (value: unknown): void => {
    expect(value).not.toBeUndefined()
    if (value && typeof value === 'object') for (const item of Object.values(value)) check(item)
  }
  check(output)
})
test('两个周期的真实查询合并成一个展示，不让模型填入数字', async () => {
  const { events } = await run({ view: 'overview', period: 'year', compare_period: 'lastmonth', display: 'table' })
  const results = events.filter(e => e.type === 'result')
  expect(results).toHaveLength(1)
  expect(results[0]!.result.table!.rows).toHaveLength(2)
  expect(results[0]!.result.table!.rows[0]?.total_tokens).toBe(4400)
  expect(results[0]!.result.table!.rows[1]?.total_tokens).toBe(0)
})
test('年度明细保持限量保护，提示改用汇总而不是暗中缩短时间', async () => {
  await expect(run({ view: 'records', from_date: '2025-01-01', to_date: '2025-12-31', display: 'table' })).rejects.toThrow('不能超过 31 天')
})
test('管理员自己的姓名也可能重名；点名不能隐式选择自己', async () => {
  await identity.createMember(admin, { name: admin.name, role_ids: [MEMBER_ROLE_ID] })
  expect((await run({ view: 'overview', period: 'year', member_name: admin.name })).output.status).toBe('ambiguous')
  expect((await run({ view: 'overview', period: 'year', member_name: '我' })).output.status).toBe('ok')
})
