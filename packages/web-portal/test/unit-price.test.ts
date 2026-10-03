/**
 * 模型单价的输入 / 展示边界（`src/utils/unitPrice.ts`）。
 *
 * 🚨 这些断言守的是一个**不会报错**的错误：界面单位是「元 / 百万 token」，
 *   而库里存的是「整数微元 / 千 token」，两者差 1000 倍。
 *   倍数写错一位就是 1000 倍误差，而页面上只显示一个看起来很正常的数字。
 */
import { describe, expect, test } from 'bun:test'
import { ANY_PROVIDER, MAX_MICRO_PER_KTOK, formatUnitPriceMicro } from '@ai-token-report/shared'
import type { PortalModelPrice } from '@ai-token-report/shared'
import {
  BASE_PROVIDER_LABEL, DEFAULT_CURRENCY, PRICE_STATUS_TEXT, defaultCurrencyForFilter, defaultCurrencyForNewPrice,
  groupPricesByProvider, hasOffpeak, isBasePrice, microToRateText, offpeakRatesOf, priceSpanText, priceStatusOf,
  providerLabel, rateTextToMicro, scheduleHint, scheduleLabel,
} from '../src/utils/unitPrice.js'

const price = (over: Partial<PortalModelPrice> = {}): PortalModelPrice => ({
  price_id: 'p1', provider: 'deepseek-official', model: 'deepseek-v4.1-flash', currency: 'CNY',
  input_micro_per_ktok: 2_000, output_micro_per_ktok: 8_000,
  cache_read_micro_per_ktok: 40, cache_write_micro_per_ktok: 0,
  effective_from_ms: 0, effective_to_ms: null, note: null,
  offpeak_schedule: null,
  offpeak_input_micro_per_ktok: null, offpeak_output_micro_per_ktok: null,
  offpeak_cache_read_micro_per_ktok: null, offpeak_cache_write_micro_per_ktok: null,
  created_at_ms: 1, updated_at_ms: 1, ...over,
})

describe('单价文本（元 / 百万 token）→ 整数微元/千', () => {
  test('常见值逐位正确（一位小数都不能错）', () => {
    // 官方 Flash 高峰价就是这三个数，框里填什么、库里存什么必须一目了然。
    expect(rateTextToMicro('2')).toBe(2_000)
    expect(rateTextToMicro('8')).toBe(8_000)
    expect(rateTextToMicro('0.2')).toBe(200)
    expect(rateTextToMicro('0.04')).toBe(40)
    expect(rateTextToMicro('0')).toBe(0)
    // 允许 6 位小数（= 1 微元/千，最小的可表达增量）；再细就无法用整数微元表示，
    // 宁可拒绝也不静默四舍五入。
    expect(rateTextToMicro('0.001')).toBe(1)
    expect(rateTextToMicro('0.0000004')).toBeNull()
  })

  test('非法输入返回 null，**绝不夹到 0**', () => {
    // 夹到 0 会让一个填错的价变成「免费」—— 那正是最危险的静默错误。
    for (const bad of ['', ' ', '-1', '-0.001', 'abc', '1e-3', '0.002元', ' 0. 5', '1.2.3', '.5']) {
      expect(rateTextToMicro(bad)).toBeNull()
    }
  })

  test('第 7 位小数被拒绝，恰好 6 位通过', () => {
    // 6 位小数就是整数微元能表达的最小增量（= 1 微元/千 token）。
    expect(rateTextToMicro('0.001000')).toBe(1)
    expect(rateTextToMicro('0.0000004')).toBeNull()
    expect(rateTextToMicro('10000.0000001')).toBeNull()
  })

  test('超过上限返回 null，恰好等于上限通过', () => {
    // 上限是 10000 元/百万 token（= MAX_MICRO_PER_KTOK 微元/千）
    expect(rateTextToMicro('10000')).toBe(MAX_MICRO_PER_KTOK)
    // ⚠️ 用显式的 max 验「超上限」这件事本身：在真实上限下，任何能过 6 位小数
    //   正则的输入都 ≤ 10000.000001 元/百万，向下取整后恰好还是上限，
    //   所以「超过数据库上限」这条分支只能这样直接打到。
    expect(rateTextToMicro('10001')).toBeNull()
    expect(rateTextToMicro('2000', 1_999)).toBeNull()
  })

  test('往返一次不丢精度（编辑已有单价时预填的那个值）', () => {
    for (const micro of [0, 1, 40, 200, 2_000, 8_000, 9_000, 27_000, MAX_MICRO_PER_KTOK]) {
      expect(rateTextToMicro(microToRateText(micro))).toBe(micro)
    }
    // 预填的是「元 / 百万 token」，与页面上显示的那个数字逐字相同。
    expect(microToRateText(2_000)).toBe('2')
    expect(microToRateText(40)).toBe('0.04')
    expect(microToRateText(27_000)).toBe('27')
  })

  test('★ 单价格式化不能用总额那个函数（50 微元/千 不是 ¥0.0001）', () => {
    // `formatUnitPriceMicro` 按「元 / 百万 token」呈现：50 微元/千 = ¥0.05 / 百万。
    // 用 `formatCostMicro` 会显示成 `¥0.0001` —— 一个差 500 倍、且看起来正常的数字。
    expect(formatUnitPriceMicro(50, 'CNY')).toBe('¥0.05 / 百万 token')
    expect(formatUnitPriceMicro(2_000, 'CNY')).toBe('¥2 / 百万 token')
  })
})

describe('默认币种是人民币（CNY）', () => {
  test('两处默认值同口径：有 CNY 就选 CNY', () => {
    expect(DEFAULT_CURRENCY).toBe('CNY')
    expect(defaultCurrencyForNewPrice(['CNY', 'USD'])).toBe('CNY')
    expect(defaultCurrencyForFilter(['CNY', 'USD'])).toBe('CNY')
    // 只有 CNY 时也照旧（现实里最多的一种）。
    expect(defaultCurrencyForNewPrice(['CNY'])).toBe('CNY')
    expect(defaultCurrencyForFilter(['CNY'])).toBe('CNY')
  })

  test('★ 表里一条 CNY 都没有时不硬套：新增跟随已有币种，筛选留在「全部币种」', () => {
    // 新增时套 CNY 会让人不假思索地存进一条与其余价目不同币种的价；
    // 筛选时套 CNY 会**把整张表筛空**，看起来像「价都没了」。
    expect(defaultCurrencyForNewPrice(['EUR', 'USD'])).toBe('EUR')
    expect(defaultCurrencyForFilter(['EUR', 'USD'])).toBe('')
    // 一条价都没有（空表）时新增回到 CNY —— 那正是首次录入的场景。
    expect(defaultCurrencyForNewPrice([])).toBe('CNY')
    expect(defaultCurrencyForFilter([])).toBe('')
  })

  test('输入顺序不影响判定（币种集合来自接口，不保证有序）', () => {
    expect(defaultCurrencyForNewPrice(['USD', 'CNY'])).toBe('CNY')
    expect(defaultCurrencyForFilter(['USD', 'CNY'])).toBe('CNY')
  })
})

describe('按供应商分组（同一供应商下不同模型各自定价）', () => {
  test('分组键是上报原值，节内保留每一行（一个模型可以有多条生效区间）', () => {
    const groups = groupPricesByProvider([
      price({ price_id: 'a', provider: 'deepseek-official', model: 'flash', effective_from_ms: 0, effective_to_ms: 100 }),
      price({ price_id: 'b', provider: 'deepseek-official', model: 'flash', effective_from_ms: 101, effective_to_ms: null }),
      price({ price_id: 'c', provider: 'dashscope', model: 'qwen-max' }),
    ], { nowMs: 1_000 })
    expect(groups.map((g) => g.provider)).toEqual(['dashscope', 'deepseek-official'])
    const deepseek = groups.find((g) => g.provider === 'deepseek-official')!
    // 两行，但只有一个模型 —— 「几条价」与「几个模型」是两件事，页面上分开显示。
    expect(deepseek.rows.length).toBe(2)
    expect(deepseek.models).toBe(1)
  })

  test('搜索命中供应商 / 模型 / 备注，大小写不敏感', () => {
    const rows = [price({ model: 'Flash-X', note: '促销价' }), price({ price_id: 'p2', provider: 'openai', model: 'gpt' })]
    expect(groupPricesByProvider(rows, { search: 'flash', nowMs: 0 }).map((g) => g.provider)).toEqual(['deepseek-official'])
    expect(groupPricesByProvider(rows, { search: '促销', nowMs: 0 }).map((g) => g.provider)).toEqual(['deepseek-official'])
    expect(groupPricesByProvider(rows, { search: 'OPENAI', nowMs: 0 }).map((g) => g.provider)).toEqual(['openai'])
    expect(groupPricesByProvider(rows, { search: '查不到', nowMs: 0 })).toEqual([])
  })

  test('币种筛选是精确匹配（不跨币种混算的前提）', () => {
    const rows = [price({ currency: 'CNY' }), price({ price_id: 'p2', currency: 'USD' })]
    expect(groupPricesByProvider(rows, { currency: 'USD', nowMs: 0 }).flatMap((g) => g.rows).map((r) => r.price_id)).toEqual(['p2'])
    expect(groupPricesByProvider(rows, { nowMs: 0 }).flatMap((g) => g.rows).length).toBe(2)
  })

  test('★「只看当前生效」走共享的区间判定（两端都是含的）', () => {
    const rows = [
      price({ price_id: 'past', effective_from_ms: 0, effective_to_ms: 100 }),
      price({ price_id: 'now', effective_from_ms: 101, effective_to_ms: 200 }),
      price({ price_id: 'future', effective_from_ms: 201, effective_to_ms: null }),
    ]
    const only = (nowMs: number) => groupPricesByProvider(rows, { onlyEffective: true, nowMs }).flatMap((g) => g.rows).map((r) => r.price_id)
    // 边界值 100 / 101 / 200 / 201 逐个钉死：差一个边界就会让「换价当天」算错。
    expect(only(100)).toEqual(['past'])
    expect(only(101)).toEqual(['now'])
    expect(only(200)).toEqual(['now'])
    expect(only(201)).toEqual(['future'])
  })
})

describe('生效区间的展示', () => {
  const fmt = (ms: number | null): string => (ms === null ? '—' : `T${ms}`)
  test('`effective_from_ms === 0` 是「自始」而不是缺失值', () => {
    // 内置种子价就是这么标的；渲染成 `—` 会让人以为这条价没填起点。
    expect(priceSpanText({ effective_from_ms: 0, effective_to_ms: null }, fmt)).toBe('自始 → 至今')
    expect(priceSpanText({ effective_from_ms: 5, effective_to_ms: 9 }, fmt)).toBe('T5 → T9')
  })

  test('状态三态，且「未来」不会被说成「已结束」', () => {
    const span = { effective_from_ms: 100, effective_to_ms: 200 }
    expect(priceStatusOf(span, 150)).toBe('active')
    expect(priceStatusOf(span, 99)).toBe('future')
    expect(priceStatusOf(span, 201)).toBe('past')
    expect(PRICE_STATUS_TEXT).toEqual({ active: '生效中', future: '未开始', past: '已结束' })
    // 至今有效的那条永远是「生效中」，不会因为没写终点就被判成已结束。
    expect(priceStatusOf({ effective_from_ms: 0, effective_to_ms: null }, 10 ** 15)).toBe('active')
  })
})

describe('基础价（不限供应商）★ v10', () => {
  test('保留值 `*` 在界面上说成「不限供应商（基础价）」——绝不把 `*` 直接显示给人看', () => {
    expect(isBasePrice(price({ provider: ANY_PROVIDER }))).toBe(true)
    expect(isBasePrice(price({ provider: 'dashscope' }))).toBe(false)
    expect(providerLabel(ANY_PROVIDER)).toBe(BASE_PROVIDER_LABEL)
    expect(providerLabel(ANY_PROVIDER)).not.toContain('*')
    // 真实供应商名原样显示（归一化是另一条链路的事，这一页只认上报原值）
    expect(providerLabel('dashscope')).toBe('dashscope')
  })

  test('★ 基础价那一组排在最前（它是兜底，夹在供应商中间会被误读成只作用于相邻的两个）', () => {
    const groups = groupPricesByProvider([
      price({ price_id: 'a', provider: 'dashscope', model: 'm' }),
      price({ price_id: 'b', provider: ANY_PROVIDER, model: 'm' }),
      price({ price_id: 'c', provider: 'bailian-tpp', model: 'm' }),
    ], { nowMs: 0 })
    expect(groups.map((g) => g.provider)).toEqual([ANY_PROVIDER, 'bailian-tpp', 'dashscope'])
  })
})

describe('闲时（低谷）档 ★ v10', () => {
  const offpeak = (over: Partial<PortalModelPrice> = {}): PortalModelPrice => price({
    offpeak_schedule: 'deepseek-cn',
    offpeak_input_micro_per_ktok: 1_000,
    offpeak_output_micro_per_ktok: 4_000,
    offpeak_cache_read_micro_per_ktok: 20,
    offpeak_cache_write_micro_per_ktok: 0,
    ...over,
  })

  test('五个字段齐全才算「有闲时档」', () => {
    expect(hasOffpeak(offpeak())).toBe(true)
    expect(hasOffpeak(price())).toBe(false)
    // ★ 半套配置（只可能来自直接改库）必须判成「没有闲时档」：
    //   把它当成有，会让缺的那几档按 0 元算，而页面上看不出来。
    expect(hasOffpeak(offpeak({ offpeak_schedule: null }))).toBe(false)
    expect(hasOffpeak(offpeak({ offpeak_input_micro_per_ktok: null }))).toBe(false)
    expect(hasOffpeak(offpeak({ offpeak_cache_write_micro_per_ktok: null }))).toBe(false)
  })

  test('闲时四类价原样取出（不换算、不打折）', () => {
    expect(offpeakRatesOf(offpeak())).toEqual({ input: 1_000, output: 4_000, cacheRead: 20, cacheWrite: 0 })
    expect(offpeakRatesOf(price())).toBeNull()
  })

  test('时段的说明文本由时段表算出来（不是手写的一段话）', () => {
    const hint = scheduleHint('deepseek-cn')
    expect(hint).toContain('北京时间')
    expect(hint).toContain('09:00–12:00')
    expect(hint).toContain('14:00–18:00')
    expect(hint).toContain('节假日表覆盖到 2026-12-31')
    expect(scheduleLabel('deepseek-cn')).toContain('DeepSeek')
    expect(scheduleLabel(null)).toBe('不分时段')
    // 未知 id 原样显示，绝不假装成某一个时段表
    expect(scheduleLabel('未来时段表')).toBe('未知时段表（未来时段表）')
    expect(scheduleHint('未来时段表')).toContain('未知时段表')
  })
})