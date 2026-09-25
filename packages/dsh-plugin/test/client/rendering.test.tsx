/**
 * 组件的**真实渲染**冒烟。
 *
 * 用 `react-dom/server` 把两个挂载点渲染成静态 HTML，断言「真的画出了数字」。
 *
 * ## 为什么值得单独写一个文件
 *
 * 前面那些测试证明的是「取数对、格式对、注册对」，都**碰不到组件体**。
 * 组件体里最常见的错误恰恰是它们抓不到的：
 *
 * - 少判一个 `undefined`（`groups[0].rows` 在空数据下）
 * - 把 `metrics` 当成一定存在（旧宿主）
 * - 改了 `UsageState` 的字段名却忘了改渲染
 *
 * 这类错误的表现是**整块面板消失**（React 边界吞掉异常），
 * 在浏览器里只留一行 console。离屏渲染能在 CI 里把它变成一条红。
 *
 * ⚠️ 离屏渲染不会执行 `useEffect`，所以这里覆盖的是**首屏**；
 *   展开、浮层等交互路径靠人眼在浏览器里看（见 `verify/verify-client-bundle.ts`
 *   与 README 的「装上之后看什么」）。
 */

import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UsageBadge, UsageDetail, UsageDock } from '../../src/client/components.js'
import { UI_DEFAULT_PERIOD } from '../../src/client/protocol.js'
import { createUsageStore, type UsageStore, type UsageStoreDeps } from '../../src/client/store.js'

/** 默认载荷：与真实宿主的产出同形。 */
function defaultBody(): Record<string, unknown> {
  return {
    period: 'today',
    rangeLabel: '今天',
    source: 'scan',
    totals: {
      total: 2_392_609_771,
      input: 70_379_895,
      output: 9_754_881,
      cacheRead: 2_312_474_995,
      cacheWrite: 0,
      reasoning: 0,
      calls: 16_437,
    },
    metrics: { cacheHitRate: 0.9705, cacheLeverage: 32.85, avgTokensPerCall: 145_560 },
    groups: [
      {
        by: 'provider-model',
        rows: [
          {
            key: 'dashscope/deepseek-v4.1-flash',
            total: 1_234_567,
            input: 12_345,
            output: 678,
            cacheRead: 1_221_544,
            cacheWrite: 0,
            calls: 42,
            sessions: 3,
            cacheHitRate: 0.99,
          },
        ],
      },
    ],
    series: [
      { bucket: '2026-09-24T10', total: 100, calls: 1, cacheHitRate: 0.9 },
      { bucket: '2026-09-24T11', total: 900, calls: 2, cacheHitRate: 0.95 },
    ],
    sessions: 42,
    elapsedMs: 11_196,
    scannedAt: 1_700_000_000_000,
  }
}

/** 造一个已经取到数的 store（渲染前必须先有数据，否则只能看到「统计中」）。 */
async function readyStore(body?: unknown): Promise<UsageStore> {
  const impl: UsageStoreDeps['fetch'] = async () => ({
    ok: true,
    status: 200,
    json: async () => body ?? defaultBody(),
  })

  const store = createUsageStore({ fetch: impl })
  const unsubscribe = store.subscribe(() => {})
  for (let i = 0; i < 5; i++) await Bun.sleep(1)
  unsubscribe()
  return store
}

/** 造一个取数失败的 store。 */
async function failedStore(status: number): Promise<UsageStore> {
  const store = createUsageStore({ fetch: async () => ({ ok: false, status, json: async () => ({}) }) })
  const unsubscribe = store.subscribe(() => {})
  for (let i = 0; i < 5; i++) await Bun.sleep(1)
  unsubscribe()
  return store
}

describe('详情体', () => {
  test('明细超过一页时仅渲染前十条，少量明细隐藏分页', async () => {
    const store = await readyStore()
    const state = store.getSnapshot()
    const data = state.data!
    const row = data.groups[0]!.rows[0]!
    const small = renderToStaticMarkup(createElement(UsageDetail, { state, store }))
    expect(small).not.toContain('用量明细分页')
    const html = renderToStaticMarkup(createElement(UsageDetail, {
      store,
      state: { ...state, data: { ...data, groups: [{ by: 'provider-model',
        rows: Array.from({ length: 35 }, (_, i) => ({ ...row, key: `分页记录-${i + 1}` })),
      }] } },
    }))
    expect(html.match(/class="atr-row-detail"/g)?.length).toBe(10)
    expect(html).toContain('共 35 条')
    expect(html).toContain('1 / 4')
    expect(html).toContain('分页记录-10')
    expect(html).not.toContain('分页记录-11')
    expect(html).toContain('下一页')
  })

  test('画出总量、四个 token 列与派生指标', async () => {
    const store = await readyStore()
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))

    expect(html).toContain('DSH token 用量')
    expect(html).toContain('计费总量')
    expect(html).toContain('2.39B')
    expect(html).toContain('未缓存输入')
    expect(html).toContain('缓存读')
    expect(html).toContain('97.0%') // 命中率（0.9705 的浮点表示见 formatting.test.ts）
    expect(html).not.toContain('32.9x') // 倍数与命中率信息重复，面板不再展示。
    expect(html).toContain('dashscope/deepseek-v4.1-flash')
    expect(html).not.toContain('数据来源')
    expect(html).not.toContain('统计于')
    expect(html).not.toContain('atr-foot')
    expect(html).toContain('今天')
  })

  test('★ 口径写在 title 里（鼠标停上去能看到公式，而不是只看到一个百分数）', async () => {
    const store = await readyStore()
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))
    expect(html).toContain('cacheRead / (cacheRead + input)')
    expect(html).toContain('未命中缓存的输入 token')
  })

  test('提供趋势画布、可访问的精确数据表与排行行', async () => {
    const store = await readyStore()
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))
    expect(html).toContain('<canvas')
    expect(html).toContain('Token 总量趋势图')
    expect(html).toContain('查看图表数据')
    expect(html).toContain('10时')
    expect(html).toContain('11时')
    expect(html).toContain('1.23M')
  })

  test('没有数据且没有错误 → 说明「首次统计要十几秒」，不显示空白', () => {
    const store = createUsageStore({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
    const html = renderToStaticMarkup(
      createElement(UsageDetail, {
        state: { period: UI_DEFAULT_PERIOD, loading: true, refreshing: false },
        store,
      }),
    )
    expect(html).toContain('正在统计本机会话日志')
    expect(html).toContain('十几秒')
  })

  test('失败 → 画出原因（面板不白屏）', async () => {
    const store = await failedStore(404)
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))
    expect(html).toContain('404')
  })

  test('空数据（零调用）不抛错，且给出「没有计费事件」', async () => {
    const store = await readyStore({
      period: 'today',
      rangeLabel: '今天',
      source: 'none',
      totals: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 },
      metrics: { cacheHitRate: 0, cacheLeverage: 0, avgTokensPerCall: 0 },
      groups: [{ by: 'provider-model', rows: [] }],
      sessions: 0,
      elapsedMs: 1,
      scannedAt: 1,
    })
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))
    expect(html).toContain('没有计费事件')
    expect(html).not.toContain('atr-foot')
  })

  test('降级原因如实显示（「这次为什么慢 30 倍」必须看得见）', async () => {
    const store = await readyStore({
      period: 'today',
      rangeLabel: '今天',
      source: 'scan',
      degradedReason: '本地库不可用（SQLITE_CORRUPT），已降级为直扫日志',
      totals: { total: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1 },
      metrics: { cacheHitRate: 0, cacheLeverage: 0, avgTokensPerCall: 1 },
      groups: [{ by: 'provider-model', rows: [] }],
      sessions: 1,
      elapsedMs: 1,
      scannedAt: 1,
    })
    const html = renderToStaticMarkup(createElement(UsageDetail, { state: store.getSnapshot(), store }))
    expect(html).toContain('SQLITE_CORRUPT')
  })
})

describe('两个挂载点', () => {
  test('用量条画出摘要 + 详情按钮', async () => {
    const store = await readyStore()
    const html = renderToStaticMarkup(createElement(UsageDock, { usage: store }))
    expect(html).toContain('TOKEN 用量')
    expect(html).toContain('2.39B')
    expect(html).toContain('命中率 97.0%')
    expect(html).not.toContain('32.9x')
    expect(html).toContain('详情')
    // 默认收起：详情体不在首屏
    expect(html).not.toContain('计费总量')
  })

  test('标题栏徽章画出紧凑数字，且不画出浮层（默认关闭）', async () => {
    const store = await readyStore()
    const html = renderToStaticMarkup(createElement(UsageBadge, { usage: store }))
    expect(html).toContain('2.39B')
    expect(html).toContain('atr-badge')
    expect(html).not.toContain('atr-mask')
  })

  test('取数失败时徽章带告警点，且 title 就是失败原因', async () => {
    const store = await failedStore(401)
    const html = renderToStaticMarkup(createElement(UsageBadge, { usage: store }))
    expect(html).toContain('atr-badge-dot-warn')
    expect(html).toContain('401')
  })
})
