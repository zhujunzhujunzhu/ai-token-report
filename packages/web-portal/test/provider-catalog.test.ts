/**
 * 供应商候选（数据里的 ∪ 归一化规则里的 ∪ 使用者自建的）与本机记忆。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ 候选的**合并规则只有一处**（`providerFilterOptions`）：同名以靠前的
 *    一档为准（数据 > 规则 > 自建），各档顺序原样保留 —— 页面不自己拼，
 *    否则「同名算哪一类」会有两份答案。
 * 2. ★ 归一化规则里配的名字**必须进候选**（`alias` 那一档）：只在
 *    `usage_event.provider` 里找候选时，一条规则配好了、原值还没上报时，
 *    那个规范化名字在下拉里根本不存在 —— 而它正是看板上要筛的名字。
 * 3. ★ 手输的名字会被记下来（`newCustomProviders`），而**判据必须与下拉一致**：
 *    下拉里能选到的都来自三档候选或已有自定义，剩下的才可能是刚敲进去的。
 * 4. 🚨 记在本机（`localStorage`）而**不写库**：存储不可用 / 内容损坏时当成
 *    「还没记过」，绝不让一个筛选下拉的记忆把整页打成白屏。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  newCustomProviders,
  providerFilterOptions,
} from '../src/types/portal.js'
import {
  CUSTOM_PROVIDERS_KEY,
  CUSTOM_PROVIDERS_LIMIT,
  readCustomProviders,
  writeCustomProviders,
} from '../src/utils/providerCatalog.js'

/**
 * 极简 `localStorage` 替身。
 *
 * ★ 必须自己造：测试环境（Bun）里**没有** `localStorage`，而浏览器里有 ——
 *   这正是 `providerCatalog.ts` 要判 `typeof localStorage === 'undefined'`
 *   的原因（页面在 SSR 下也要能构造 store）。拿它当「存储一定可用」来写断言，
 *   测的就不是真实形状了。
 */
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

beforeEach(() => {
  storageHost.localStorage = fakeStorage()
})

describe('供应商候选 = 数据里的 ∪ 归一化规则里的 ∪ 自建的', () => {
  test('三档依次排列，并标出每一项从哪来', () => {
    const options = providerFilterOptions(
      ['dashscope', 'bailian-tpp'],
      ['未来网关'],
      ['my-gateway'],
    )
    expect(options).toEqual([
      { value: 'dashscope', label: 'dashscope', source: 'data' },
      { value: 'bailian-tpp', label: 'bailian-tpp', source: 'data' },
      { value: '未来网关', label: '未来网关', source: 'alias' },
      { value: 'my-gateway', label: 'my-gateway', source: 'custom' },
    ])
  })

  test('★ 同名以靠前的一档为准（数据 > 规则 > 自建）', () => {
    // 三档里都有 `dashscope`，后两档都有「未来网关」：每一档只在该名字
    // **还没出现过**时才贡献一项 —— 否则下拉里会出现两个逐字相同的选项，
    // 而发出去的筛选值一模一样（使用者只会以为自己看花了眼）。
    const options = providerFilterOptions(
      ['dashscope'],
      ['dashscope', '未来网关'],
      ['dashscope', '未来网关', 'other'],
    )
    expect(options.map((option) => [option.value, option.source])).toEqual([
      ['dashscope', 'data'],
      ['未来网关', 'alias'],
      ['other', 'custom'],
    ])
  })

  test('空串与首尾空格被清掉，重复只留一项', () => {
    expect(
      providerFilterOptions(
        [' dashscope ', '', 'dashscope'],
        [' 未来网关 ', '未来网关'],
        ['  ', 'x'],
      ),
    ).toEqual([
      { value: 'dashscope', label: 'dashscope', source: 'data' },
      { value: '未来网关', label: '未来网关', source: 'alias' },
      { value: 'x', label: 'x', source: 'custom' },
    ])
  })

  test('★ 老服务端没有规则候选（`aliases` 缺席）时退化成本次改动之前的行为', () => {
    // 调用方把缺字段折成空数组（见 store 的 `pv.data.aliases ?? []`）。
    expect(providerFilterOptions(['dashscope'], [], ['my-gateway'])).toEqual([
      { value: 'dashscope', label: 'dashscope', source: 'data' },
      { value: 'my-gateway', label: 'my-gateway', source: 'custom' },
    ])
  })
})

describe('手输的名字怎么算「新的」', () => {
  test('三档候选里已有的、已经记过的不再重记', () => {
    expect(
      newCustomProviders(
        ['dashscope', '未来网关', 'my-gateway', 'my-gateway'],
        ['dashscope'],
        ['未来网关'],
        [],
      ),
    ).toEqual(['my-gateway'])
    expect(
      newCustomProviders(['my-gateway'], ['dashscope'], ['未来网关'], ['my-gateway']),
    ).toEqual([])
  })

  test('★ 归一化规则里配的名字不算「刚敲进去的」（否则本机记忆里多一条幽灵项）', () => {
    expect(newCustomProviders(['未来网关'], [], ['未来网关'], [])).toEqual([])
  })

  test('★ 输入一半的子串也照记（服务端本来就是子串匹配，页面不替使用者判断）', () => {
    expect(newCustomProviders(['dash'], ['dashscope'], [], [])).toEqual(['dash'])
  })

  test('空白值不进候选', () => {
    expect(newCustomProviders(['  ', ''], [], [], [])).toEqual([])
  })
})

describe('本机记忆（localStorage，不写库）', () => {
  test('写入后能读回，去重去空', () => {
    writeCustomProviders(['my-gateway', 'my-gateway', ' ', 'other'])
    expect(readCustomProviders()).toEqual(['my-gateway', 'other'])
  })

  test('★ 内容损坏 / 不是数组时当成「还没记过」，而不是抛错', () => {
    storageHost.localStorage!.setItem(CUSTOM_PROVIDERS_KEY, '{ 这不是 JSON')
    expect(readCustomProviders()).toEqual([])
    storageHost.localStorage!.setItem(CUSTOM_PROVIDERS_KEY, JSON.stringify({ a: 1 }))
    expect(readCustomProviders()).toEqual([])
    // 数组里混进非字符串：跳过它，其余照读
    storageHost.localStorage!.setItem(
      CUSTOM_PROVIDERS_KEY,
      JSON.stringify(['ok', 42, null]),
    )
    expect(readCustomProviders()).toEqual(['ok'])
  })

  test('★ 完全没有 localStorage（SSR / Node）时读回空，写也不抛', () => {
    delete storageHost.localStorage
    expect(readCustomProviders()).toEqual([])
    expect(() => writeCustomProviders(['x'])).not.toThrow()
  })

  test('条数有上限（一份筛选下拉的记忆不该无限增长）', () => {
    const many = Array.from({ length: CUSTOM_PROVIDERS_LIMIT + 10 }, (_, i) => `p${i}`)
    writeCustomProviders(many)
    expect(readCustomProviders()).toHaveLength(CUSTOM_PROVIDERS_LIMIT)
  })

  test('写失败（存储不可用）不抛错 —— 它只是记忆', () => {
    const original = storageHost.localStorage!.setItem
    // 模拟配额满 / 隐私模式：setItem 直接抛
    storageHost.localStorage!.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => writeCustomProviders(['x'])).not.toThrow()
    } finally {
      storageHost.localStorage!.setItem = original
    }
  })
})
