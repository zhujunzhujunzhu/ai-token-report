/** 真实 API 值到图表/表格的契约：不漏缓存、不合并币种、不伪造缺席指标。 */
import { expect, test } from 'bun:test'
import { presentAssistantResult } from '../src/assistant/presentation.js'

test('趋势图与表格逐点使用 API 值；零值保留，缺字段不补成零', () => {
  const result = presentAssistantResult('series', 'period=last7d', { points: [
    { bucket: '2026-10-01', totalTokens: 99, inputTokens: 1, cacheReadTokens: 98, calls: 3 },
    { bucket: '2026-10-02', totalTokens: 0, inputTokens: 0, cacheReadTokens: 0, calls: 0 },
  ] })
  expect(result.chart?.series.find(series => series.key === 'total_tokens')?.values).toEqual([99, 0])
  expect(result.table?.rows.map(row => row.cache_read_tokens)).toEqual([98, 0])
  expect(result.table?.columns.some(column => column.key === 'cache_write_tokens')).toBe(false)
  expect(result.table?.columns.some(column => column.key === 'cost')).toBe(false)
})
test('展示保留服务端比率与总量，不用各行重新汇总，分组多对多附说明', () => {
  const result = presentAssistantResult('breakdown', '', { by: 'group', rows: [{ key: '分组甲', totalTokens: 800, calls: 2, cacheHitRate: .92 }, { key: '分组乙', totalTokens: 800, calls: 2, cacheHitRate: .71 }] })
  expect(result.chart?.series[0]?.values).toEqual([800, 800])
  expect(result.table?.rows[1]?.cache_hit_rate).toBe(.71)
  expect(result.note).toContain('可能大于')
})
test('费用权限缺席、未计价和不同币种展示分别保持原语义', () => {
  expect(presentAssistantResult('overview', '', { totalTokens: 42 }).cards?.some(card => card.label === '费用（估算）')).toBe(false)
  const cost = { pricing: { source: 'server' }, costs: [] }
  expect(presentAssistantResult('overview', '', { cost }).cards?.at(-1)?.value).toBe('未计价')
  const multi = presentAssistantResult('overview', '', { cost: { ...cost, costs: [{ currency: 'CNY', amountMicro: 1_000_000 }, { currency: 'USD', amountMicro: 2_000_000 }] } })
  expect(multi.cards?.at(-1)?.value).toContain(' + ')
  expect(multi.note).toContain('不同币种')
  const records = presentAssistantResult('records', '', { total: 2, rows: [{ ts: 123, cost: { currency: null, amountMicro: 0 } }, { ts: 456, cost: { currency: 'CNY', amountMicro: 0 } }] })
  expect(records.table?.rows[0]?.cost).toBe('未计价')
  expect(records.table?.rows[1]?.cost).not.toBe('未计价')
})
test('大结果只展示有限真值并明确标识，不把截断当作完整数据', () => {
  const points = Array.from({ length: 130 }, (_, index) => ({ bucket: String(index), totalTokens: index }))
  const result = presentAssistantResult('series', '', { points })
  expect(result.chart?.labels.length).toBe(100)
  expect(result.table?.rows.length).toBe(100)
  expect(result.table?.total_rows).toBe(130)
  expect(result.note).toContain('共 130 行')
})

test('诊断保持事件新鲜度的语义；厂商目录保留配置来源，不冒充用量', () => {
  const result = presentAssistantResult('diagnostics', 'period=today', { totalEvents: 10, identityViolations: 0, sources: [{ source: 'dsh', calls: 10, totalTokens: 500, latestEventTs: 123, silentForMs: 456 }] })
  expect(result.cards?.find(card => card.label === '口径校验异常')?.value).toBe('0')
  expect(result.table?.rows[0]?.latest_event).toBe(123)
  expect(result.table?.rows[0]?.silent_for_ms).toBe(456)
  expect(result.chart?.series[0]?.values).toEqual([500])
  expect(result.note).toContain('不等于最近上报时间')
  expect(presentAssistantResult('providers', '', { providers: ['用量厂商'], aliases: ['配置厂商'] }).table?.rows).toEqual([{ provider: '用量厂商', origin: '用量数据' }, { provider: '配置厂商', origin: '归一化配置' }])
})
