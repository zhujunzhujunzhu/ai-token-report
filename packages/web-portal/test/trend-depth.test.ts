/**
 * 趋势图「保留多少层」（`utils/trendDepth.ts` + store 的透传）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ 层数是**看图的取舍**，默认「全部」—— 默认前 8 名时，页面上唯一看不到的
 *    就是「其余 N 人」，而他们恰恰是使用者会在筛选栏里看到、却查不到的人。
 * 2. ★ 三个线上取值只有一份定义（`TREND_DEPTH_OPTIONS`），页面与请求参数
 *    逐字对应：中间加一次 `number | 'all'` 的转换，早晚会出现「选了全部却发了 8」
 *    而两边都不报错。
 * 3. ★ 选择记在**本机**（`localStorage`），读不了 / 损坏 / 没存过一律回默认值；
 *    它不该把整页打成白屏，也不该影响查询。
 * 4. ★ store 必须把 `stack_top` **真的发出去**（否则服务端照旧折前 8 名，
 *    而页面上选的是「全部」—— 一个看不见的开关）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useSessionStore } from '../src/stores/session.js'
import { useDashboardStore } from '../src/stores/dashboard.js'
import {
  DEFAULT_TREND_DEPTH,
  normalizeTrendDepth,
  readTrendDepth,
  TREND_DEPTH_KEY,
  TREND_DEPTH_OPTIONS,
  writeTrendDepth,
} from '../src/utils/trendDepth.js'

/** 极简 `localStorage` 替身（与 `provider-catalog.test.ts` 同款）。 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const storageHost = globalThis as { localStorage?: Storage }
const originalFetch = globalThis.fetch
/** 原始 `localStorage`（Bun 有、Node 没有）：用例跑完必须还原，别漏给别人。 */
const originalLocalStorage = storageHost.localStorage
let pinia: Pinia

beforeEach(() => {
  storageHost.localStorage = fakeStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  globalThis.fetch = originalFetch
  if (originalLocalStorage) storageHost.localStorage = originalLocalStorage
  else delete storageHost.localStorage
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })

function signIn(): void {
  const session = useSessionStore()
  session.identity = {
    member_id: '00000000-0000-4000-8000-000000000001',
    name: '测试成员',
    username: 'test-user',
    role: 'admin',
    permissions: ['stats:read'],
  }
  session.generation++
  session.initialized = true
}

describe('层数取值与默认值', () => {
  test('★ 默认是「全部」：默认前 8 名时看不到的正是「其余 N 人」', () => {
    expect(DEFAULT_TREND_DEPTH).toBe('all')
    expect(readTrendDepth()).toBe('all')
  })

  test('三个选项逐字对应线上取值，且覆盖所有合法值', () => {
    const values = TREND_DEPTH_OPTIONS.map((option) => option.value)
    expect(values).toEqual(['8', '20', 'all'])
    // 每个合法值都能原样存回（写进去读出来不许变形）
    for (const value of values) {
      writeTrendDepth(value)
      expect([value, readTrendDepth()]).toEqual([value, value])
    }
    // 默认值本身必须是选项之一：否则页面上没有任何一项是选中的
    expect(values).toContain(DEFAULT_TREND_DEPTH)
  })

  test('认不出来的值一律回默认值（含旧版本存过的形状）', () => {
    for (const bad of ['0', '8.0', 'ALL', '', 'all ', '16', 8, null, undefined, {}, []]) {
      expect([String(bad), normalizeTrendDepth(bad)]).toEqual([
        String(bad),
        DEFAULT_TREND_DEPTH,
      ])
    }
  })

  test('★ 存过就按存的来；没存过 / 内容损坏回默认值', () => {
    writeTrendDepth('20')
    expect(readTrendDepth()).toBe('20')
    storageHost.localStorage!.setItem(TREND_DEPTH_KEY, '这不是取值')
    expect(readTrendDepth()).toBe(DEFAULT_TREND_DEPTH)
  })

  test('★ 完全没有 localStorage（SSR / Node）时读回默认值，写也不抛', () => {
    delete storageHost.localStorage
    expect(readTrendDepth()).toBe(DEFAULT_TREND_DEPTH)
    expect(() => writeTrendDepth('8')).not.toThrow()
  })

  test('写失败（配额满 / 隐私模式）不抛错 —— 它只是看图习惯', () => {
    storageHost.localStorage!.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    expect(() => writeTrendDepth('8')).not.toThrow()
  })
})

describe('store 把 stack_top 真的发给服务端', () => {
  /** 跑一轮「分析」区块，返回所有请求过的 URL。 */
  async function analysisUrls(
    setup?: (dashboard: ReturnType<typeof useDashboardStore>) => Promise<void>,
  ): Promise<URL[]> {
    signIn()
    const urls: URL[] = []
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(String(input), 'http://test')
      urls.push(url)
      if (url.pathname.endsWith('overview'))
        return Promise.resolve(json({ range: {}, totalTokens: 1, calls: 1 }))
      return Promise.resolve(json({ rows: [], points: [], members: [], groups: [] }))
    }) as typeof fetch
    const dashboard = useDashboardStore()
    await dashboard.activate('analysis')
    if (setup) await setup(dashboard)
    return urls
  }
  const seriesUrls = (urls: URL[]): URL[] =>
    urls.filter((url) => url.pathname.endsWith('/api/v1/stats/series'))

  test('不展开时不带 stack / stack_top（合计模式与这一个开关无关）', async () => {
    const urls = await analysisUrls()
    expect(seriesUrls(urls)).toHaveLength(1)
    expect(seriesUrls(urls)[0]!.searchParams.has('stack')).toBe(false)
    expect(seriesUrls(urls)[0]!.searchParams.has('stack_top')).toBe(false)
  })

  test('★ 切到「按用户」：默认送出 stack_top=all（不是让服务端自己折前 8 名）', async () => {
    const urls = await analysisUrls((dashboard) => dashboard.setStack('user'))
    const series = seriesUrls(urls).at(-1)!
    expect(series.searchParams.get('stack')).toBe('user')
    expect(series.searchParams.get('stack_top')).toBe('all')
  })

  test('★ 切换层数要重取，并把选择写回本机', async () => {
    const urls = await analysisUrls(async (dashboard) => {
      await dashboard.setStack('user')
      await dashboard.setTrendDepth('8')
    })
    expect(seriesUrls(urls).at(-1)!.searchParams.get('stack_top')).toBe('8')
    // 写回本机：下次打开还该是它
    expect(storageHost.localStorage!.getItem(TREND_DEPTH_KEY)).toBe('8')
  })

  test('★ 本机记过「前 20 名」时，展开就发 20（记的是取值本身，不是布尔）', async () => {
    writeTrendDepth('20')
    const urls = await analysisUrls((dashboard) => dashboard.setStack('model'))
    expect(seriesUrls(urls).at(-1)!.searchParams.get('stack_top')).toBe('20')
  })

  test('切层数不改变分层维度，只想看全部/前几名时维度照旧', async () => {
    const urls = await analysisUrls(async (dashboard) => {
      await dashboard.setStack('user')
      await dashboard.setTrendDepth('20')
    })
    expect(seriesUrls(urls).at(-1)!.searchParams.get('stack')).toBe('user')
  })
})
