/**
 * 采集诊断页的纯判断：静默分档、结论收敛、指标卡的新旧服务端兼容。
 *
 * ★ 这些断言**必须存在**，因为 SSR 渲染层验不到它们：
 *   `el-table` 的行在服务端只输出空 `<tr>`，而指标卡又要在旧服务端时**整张消失**
 *   —— 「少了 4 张卡」在页面上是看不出来的，只会让人以为「这个环境的数据本来就少」。
 *   逻辑放在 `diagnosticsModel.ts`（纯函数）里，`verify-render.ts` 只钉表头与文案。
 */
import { describe, expect, test } from 'bun:test'
import type { DiagnosticsResponse } from '@ai-token-report/shared'
import {
  cadenceCards,
  conclusionOf,
  diagnosticCards,
  ENRICHED_CARD_KEYS,
  isEnriched,
  SILENT_WARN_MS,
  silenceOf,
  type SourceRowView,
} from '../src/views/diagnosticsModel.js'

/** v14 服务端的完整响应。 */
const full: DiagnosticsResponse = {
  totalEvents: 5,
  unattributedEvents: 1,
  unattributedRate: 0.2,
  identityViolations: 0,
  distinctUsers: 4,
  earliestTs: 1_756_000_000_000,
  latestTs: 1_757_500_000_000,
  lastIngestAt: 1_757_500_000_000,
  totalTokens: 21_756,
  sessions: 3,
  cacheHitRate: 0.943,
  avgTokensPerCall: 4351.2,
  spanMs: 6 * 86_400_000,
  eventsPerSession: 5 / 3,
  sources: [
    {
      source: 'dsh', calls: 4, totalTokens: 20_000, sessions: 2,
      earliestEventTs: 1_757_000_000_000, latestEventTs: 1_757_500_000_000,
      silentForMs: 60_000,
    },
    {
      source: 'codex', calls: 1, totalTokens: 1_756, sessions: 1,
      earliestEventTs: 1_756_000_000_000, latestEventTs: 1_756_000_000_000,
      silentForMs: 3 * 86_400_000,
    },
  ],
  reporters: [
    {
      key: 'u-zhang', label: '张三', attributionStatus: 'member', calls: 2,
      totalTokens: 12_000, groupNames: ['研发'], latestEventTs: 1_757_500_000_000,
      silentForMs: 60_000,
    },
    {
      key: 'legacy:aHR0cHM', label: '历史人员：李四（待确认）', attributionStatus: 'legacy',
      calls: 1, totalTokens: 5_000, groupNames: [], latestEventTs: 1_757_400_000_000,
      silentForMs: 3 * 86_400_000,
    },
    {
      key: 'unknown', label: '未归属', attributionStatus: 'unattributed', calls: 1,
      totalTokens: 1_756, groupNames: [], latestEventTs: 1_756_000_000_000,
      silentForMs: 3 * 86_400_000,
    },
  ],
}

/** 旧服务端：只有 v6 那七个字段。 */
const legacy = ((): DiagnosticsResponse => {
  const {
    totalTokens: _t, sessions: _s, cacheHitRate: _h, avgTokensPerCall: _a,
    spanMs: _sp, eventsPerSession: _e, sources: _so, reporters: _re,
    ...rest
  } = full
  return rest as DiagnosticsResponse
})()

/** 只带 `silentForMs` 的最小行 → 附加静默档位（结论判定只读这两个字段）。 */
const rows = (
  list: { silentForMs: number | null }[],
  text = 'x',
): SourceRowView[] =>
  list.map((row) => ({ ...row, silence: silenceOf(row.silentForMs, text) })) as SourceRowView[]

describe('静默分档', () => {
  test('间隔小于阈值不算静默；等于阈值就算（边界含在告警侧）', () => {
    expect(silenceOf(SILENT_WARN_MS - 1, '23 小时前').tone).toBe('green')
    expect(silenceOf(SILENT_WARN_MS, '1 天前').tone).toBe('amber')
  })
  test('null（没有数据可判断）不参与告警，也不显示成「刚刚」', () => {
    // 🚨 null 判成 amber 会让「这个来源没数据」被读成「这个来源掉线了」——
    //   而服务端根本不会给一个在窗口内没有数据的来源发行（不补零）。
    expect(silenceOf(null, '')).toEqual({ tone: 'green', text: '—' })
  })
  test('文案为空时回退成「刚刚」而不是留空', () => {
    expect(silenceOf(1_000, '').text).toBe('刚刚')
  })
})

describe('结论收敛', () => {
  test('未归属优先于两个静默', () => {
    const c = conclusionOf(
      7,
      rows([{ silentForMs: 3 * 86_400_000 }]),
      rows([{ silentForMs: 3 * 86_400_000 }]),
    )
    // ⚠️ 顺序钉死：未署名是「数据本身不对」，比「某客户端没在用」更该先说。
    expect(c.kind).toBe('unattributed')
    expect(c.text).toContain('7 条未归属记录')
    expect(c.text).not.toContain('采集来源')
  })
  test('来源静默优先于署名者静默（来源维度更具体，能点名是哪个客户端）', () => {
    const c = conclusionOf(0, rows([{ silentForMs: 3 * 86_400_000 }]), rows([{ silentForMs: 3 * 86_400_000 }]))
    expect(c.kind).toBe('silent-sources')
    expect(c.text).toBe('1 个采集来源已超过 24 小时没有新数据')
  })
  test('来源都新鲜、只有署名者静默时，改说署名者', () => {
    const c = conclusionOf(0, rows([{ silentForMs: 1_000 }]), rows([{ silentForMs: 3 * 86_400_000 }]))
    expect(c.kind).toBe('stale-reporters')
    expect(c.text).toBe('1 位署名者已超过 24 小时没有新数据')
  })
  // 🚨 这是最容易漏的一条：只判未归属就发绿，会让「某人三天没上报」
  //   在页面上显示成一路绿灯，而那正是这一页要抓的东西。
  test('未归属为 0 但有静默来源时**不能**显示为健康', () => {
    const c = conclusionOf(0, rows([{ silentForMs: 2 * 86_400_000 }]), rows([{ silentForMs: 1_000 }]))
    expect(c.kind).not.toBe('healthy')
    expect(c.tone).toBe('amber')
  })
  test('三种异常都不存在时才是常态绿', () => {
    const c = conclusionOf(0, rows([{ silentForMs: 1_000 }]), rows([{ silentForMs: 1_000 }]))
    expect(c.kind).toBe('healthy')
    expect(c.tone).toBe('green')
    expect(c.text).toBe('当前范围内未发现未归属记录，采集链路新鲜')
  })
  test('没有任何一行（旧服务端没有来源表）也不会误判成有静默', () => {
    expect(conclusionOf(0, [], []).kind).toBe('healthy')
  })
})

describe('指标卡的新旧服务端兼容', () => {
  test('v14 服务端：八张卡齐全', () => {
    const cards = diagnosticCards(full)
    expect(cards.length).toBe(8)
    expect(cards.map((c) => c.key)).toContain('sessions')
    expect(cards.map((c) => c.key)).toContain('hit')
  })
  // 🚨 核心断言：旧服务端时那四张卡**消失**，而不是显示 0。
  //   「查不到」与「真的是 0」在页面上长得一模一样，而前者是排障要找的东西。
  test('旧服务端：那四张卡整张消失，不是 0', () => {
    const cards = diagnosticCards(legacy)
    for (const key of ENRICHED_CARD_KEYS) expect(cards.map((c) => c.key)).not.toContain(key)
    expect(cards.length).toBe(4)
    // 老四张卡照常在，且带真实数值
    expect(cards.find((c) => c.key === 'events')?.value).toBe('5')
    expect(cards.find((c) => c.key === 'users')?.value).toBe('4')
  })
  test('响应为 null 时不抛异常，全部回落成「—」', () => {
    const cards = diagnosticCards(null)
    expect(cards.every((c) => c.value === '—')).toBe(true)
    // 无响应时那四张卡也要消失：连字段在不在都不知道
    expect(cards.length).toBe(4)
  })
  // ⚠️ 判据必须是「字段在不在」：合法的 0 不能被当成旧服务端。
  test('命中率为 0 仍算 v14（新卡照常出现）', () => {
    const zero: DiagnosticsResponse = { ...full, cacheHitRate: 0, totalTokens: 0, avgTokensPerCall: 0 }
    expect(isEnriched(zero)).toBe(true)
    const cards = diagnosticCards(zero)
    expect(cards.find((c) => c.key === 'hit')?.value).toBe('0.0%')
    expect(cards.length).toBe(8)
  })
  test('卡片名与措辞守住语义（不叫「分组数」、均量不代表效率）', () => {
    const cards = diagnosticCards(full)
    expect(cards.map((c) => c.label)).not.toContain('分组数')
    expect(cards.map((c) => c.label)).not.toContain('平均消耗')
    const avg = cards.find((c) => c.key === 'avg')
    expect(avg?.title).toContain('不代表效率')
    // 命中率低不是采集故障，所以那一格**绝不能**是警告色
    expect(cards.find((c) => c.key === 'hit')?.tone).toBe('green')
  })
  test('有未署名事件时那两张卡转警告色，否则常态绿', () => {
    expect(diagnosticCards(full).find((c) => c.key === 'rate')?.tone).toBe('amber')
    expect(diagnosticCards({ ...full, unattributedEvents: 0 }).find((c) => c.key === 'rate')?.tone).toBe('green')
  })
})

describe('节奏卡片', () => {
  test('跨度按「最晚 − 最早」算，且不是窗口长度', () => {
    expect(cadenceCards(full)[0]?.value).toBe('6 天')
  })
  test('跨度为 0 显示「不足 1 天」而不是 0 天', () => {
    expect(cadenceCards({ ...full, spanMs: 0 })[0]?.value).toBe('不足 1 天')
  })
  test('不足一天但非 0 时至少显示 1 天（不显示 0 天）', () => {
    expect(cadenceCards({ ...full, spanMs: 3_600_000 })[0]?.value).toBe('1 天')
  })
  test('旧服务端整块不出现', () => {
    expect(cadenceCards(legacy)).toEqual([])
    expect(cadenceCards(null)).toEqual([])
  })
  test('没有事件时跨度为 null —— 那才是真的「没有内容可画」', () => {
    // ⚠️ 这时 eventsPerSession 也必为 null（会话数不可加也不能凭空造）。
    expect(cadenceCards({ ...full, spanMs: null, eventsPerSession: null })).toEqual([])
  })
  test('平均每会话事件四舍五入到整数', () => {
    expect(cadenceCards(full).find((c) => c.key === 'events-per-session')?.value).toBe('2')
  })
})