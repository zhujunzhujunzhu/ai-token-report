/** 同一数据集的多种展示、权限隔离与跨轮恢复，防止模型用编造数值替换查询。 */
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantDatasets } from '../src/assistant/datasets.js'
import type { Principal } from '../src/identity/types.js'
const root = mkdtempSync(join(tmpdir(), 'atr-assistant-datasets-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))
const principal = { memberId: '甲', roleCodes: ['member'], permissions: ['stats:read'], groupIds: [] } as unknown as Principal
const registry = new AssistantDatasets(root)
const source = { by: 'model', rows: [{ key: '模型甲', totalTokens: 500, inputTokens: 100, cacheReadTokens: 400, calls: 2, cacheHitRate: .8 }, { key: '模型乙', totalTokens: 100, inputTokens: 100, cacheReadTokens: 0, calls: 1, cacheHitRate: 0 }] }
const captured = registry.capture('breakdown', 'period=last7d&by=model', source, principal)
const input = { dataset_id: captured.dataset_id! }
test('查询不绑定图形；同一 API 结果可展示成表格、柱图、饼图，原始值完全不变', () => {
  expect(captured.chart).toBeUndefined()
  expect(captured.display).toBeUndefined()
  const table = registry.render('table', { ...input, columns: ['dimension', 'total_tokens'] }, principal)
  const bar = registry.render('echarts', { ...input, chart: { kind: 'bar', x_key: 'dimension', y_keys: ['total_tokens'], horizontal: true } }, principal)
  const pie = registry.render('echarts', { ...input, chart: { kind: 'pie', x_key: 'dimension', y_keys: ['total_tokens'] } }, principal)
  expect([table.display, bar.display, pie.display]).toEqual(['table', 'echarts', 'echarts'])
  expect(table.table?.rows).toEqual([{ dimension: '模型甲', total_tokens: 500 }, { dimension: '模型乙', total_tokens: 100 }])
  expect(bar.table?.rows).toEqual(pie.table?.rows)
  expect(bar.dataset_id).toBe(pie.dataset_id)
  expect(bar.result_id).not.toBe(pie.result_id)
})
test('拒绝捏造数值、任意 option、未知字段、混用比率与计数，以及多对多份额', () => {
  expect(() => registry.render('table', { ...input, rows: [{ total_tokens: 999 }] }, principal)).toThrow('不支持')
  expect(() => registry.render('table', { ...input, columns: ['秘密字段'] }, principal)).toThrow('不在')
  expect(() => registry.render('echarts', { ...input, chart: { kind: 'bar', x_key: 'dimension', y_keys: ['total_tokens'], option: {} } }, principal)).toThrow('禁止')
  expect(() => registry.render('echarts', { ...input, chart: { kind: 'line', x_key: 'dimension', y_keys: ['total_tokens', 'cache_hit_rate'] } }, principal)).toThrow('分开')
  expect(() => registry.render('echarts', { ...input, chart: { kind: 'bar', x_key: 'dimension', y_keys: ['total_tokens', 'calls'] } }, principal)).toThrow('分开')
  const group = registry.capture('breakdown', 'by=group', { ...source, by: 'group' }, principal)
  expect(() => registry.render('echarts', { dataset_id: group.dataset_id, chart: { kind: 'pie', x_key: 'dimension', y_keys: ['total_tokens'] } }, principal)).toThrow('多对多')
})
test('数据集跨轮原子恢复；其他用户、角色或权限变化不能重新渲染旧数据', async () => {
  await registry.save()
  const restored = new AssistantDatasets(root); await restored.load()
  expect(restored.render('table', input, principal).table?.rows[0]?.total_tokens).toBe(500)
  const other = { ...principal, memberId: '乙' }
  expect(restored.list(other)).toEqual([])
  expect(() => restored.render('table', input, other)).toThrow('身份或权限')
  expect(() => restored.render('table', input, { ...principal, permissions: [] })).toThrow('身份或权限')
})
test('空值保留为缺席；饼图不能把缺席、负值或比率解释为份额', () => {
  const missing = registry.capture('series', '', { points: [{ bucket: '一天', calls: 1, totalTokens: 20 }, { bucket: '另一天', calls: 0 }] }, principal)
  const chart = { kind: 'line', x_key: 'bucket', y_keys: ['total_tokens'] }
  expect(registry.render('echarts', { dataset_id: missing.dataset_id, chart }, principal).table?.rows[1]?.total_tokens).toBeNull()
  expect(() => registry.render('echarts', { dataset_id: missing.dataset_id, chart: { ...chart, kind: 'pie' } }, principal)).toThrow('无空值')
  expect(() => registry.render('echarts', { ...input, chart: { kind: 'pie', x_key: 'dimension', y_keys: ['cache_hit_rate'] } }, principal)).toThrow('整体份额')
})
