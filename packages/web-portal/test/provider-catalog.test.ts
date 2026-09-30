/**
 * 供应商候选（库里的目录 ∪ 使用者自建的）与本机记忆。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ 候选的**合并规则只有一处**（`providerFilterOptions`）：同名以目录为准，
 *    目录顺序原样保留 —— 页面不自己拼，否则「同名算哪一类」会有两份答案。
 * 2. ★ 手输的名字会被记下来（`newCustomProviders`），而**判据必须与下拉一致**：
 *    下拉里能选到的都来自目录或已有自定义，剩下的才可能是刚敲进去的。
 * 3. 🚨 记在本机（`localStorage`）而**不写库**：存储不可用 / 内容损坏时当成
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

describe('供应商候选 = 目录 ∪ 自建', () => {
  test('目录在前、自建在后，并标出哪一项是自己建的', () => {
    const options = providerFilterOptions(
      ['dashscope', 'bailian-tpp'],
      ['my-gateway'],
    )
    expect(options).toEqual([
      { value: 'dashscope', label: 'dashscope', custom: false },
      { value: 'bailian-tpp', label: 'bailian-tpp', custom: false },
      { value: 'my-gateway', label: 'my-gateway', custom: true },
    ])
  })

  test('★ 同名以目录为准（库里真的有这个名字，它就不是「自定义」）', () => {
    const options = providerFilterOptions(['dashscope'], ['dashscope', 'other'])
    expect(options.map((option) => [option.value, option.custom])).toEqual([
      ['dashscope', false],
      ['other', true],
    ])
  })

  test('空串与首尾空格被清掉，重复只留一项', () => {
    expect(providerFilterOptions([' dashscope ', '', 'dashscope'], ['  ', 'x'])).toEqual([
      { value: 'dashscope', label: 'dashscope', custom: false },
      { value: 'x', label: 'x', custom: true },
    ])
  })
})

describe('手输的名字怎么算「新的」', () => {
  test('目录里已有的、已经记过的不再重记', () => {
    expect(
      newCustomProviders(
        ['dashscope', 'my-gateway', 'my-gateway'],
        ['dashscope'],
        [],
      ),
    ).toEqual(['my-gateway'])
    expect(newCustomProviders(['my-gateway'], ['dashscope'], ['my-gateway'])).toEqual([])
  })

  test('★ 输入一半的子串也照记（服务端本来就是子串匹配，页面不替使用者判断）', () => {
    expect(newCustomProviders(['dash'], ['dashscope'], [])).toEqual(['dash'])
  })

  test('空白值不进候选', () => {
    expect(newCustomProviders(['  ', ''], [], [])).toEqual([])
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
