/**
 * 「用量分布」表的搜索 + 分页回归（`utils/breakdownView.ts`）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **先匹配、后分页**：搜索框是对**全部行**生效的。反过来写（先切片再
 *    filter）会让它静默变成「只搜当前页」—— 表现是「明明有这一行，翻到第 2 页
 *    才出现」，而页面上没有任何迹象。
 * 2. ★ **匹配范围 = 第一列真的画出来的东西**：原始键、展示名、分组标签。
 *    只认一半就会出现「明明有这个来源却搜不到」（`trae-cn` 与 `Trae CN`）。
 * 3. 🚨 **数值列不参与**：搜「14690」这种数字若命中行，那不是搜索 ——
 *    任何一个数字都会命中一大片，使用者却会以为筛得很准。
 * 4. ★ **页码越界夹回**（换时间窗 / 换维度之后条数骤减），并且给出**那一页的行**
 *    而不是一张空表；这条走的是 `pagination.ts`，这里钉的是「分布表也用上了它」。
 * 5. ★ **工具条的出现条件**：装得下一屏且没有关键词时不出现；有关键词时
 *    **必须**留着 —— 否则使用者没有地方清掉它，表会一直空着。
 *
 * 至于「页脚长什么样」（`第 1 / 2 页 · 每页 10 行`）与「搜索框真的渲染出来了」
 * 由 `verify/verify-render.ts` 在真渲染里钉住 —— 这里只测纯逻辑。
 */
import { describe, expect, test } from 'bun:test'
import type { BreakdownRow } from '@ai-token-report/shared'
import {
  BREAKDOWN_PAGE_SIZE,
  breakdownSearchText,
  breakdownViewOf,
  matchBreakdownRows,
} from '../src/utils/breakdownView.js'

/** 一行分布：默认值只为了形状完整，用例关心的字段逐个覆盖。 */
const row = (key: string, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  totalTokens: 10,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 8,
  cacheWriteTokens: 0,
  calls: 1,
  cacheHitRate: 0.9,
  ...extra,
})

/** 1..n 的模型键：用行号当键，切片错了能一眼看出是「漏了第 11 行」还是「多切了一行」。 */
const numbered = (n: number): BreakdownRow[] =>
  Array.from({ length: n }, (_, index) => row(`m-${String(index + 1).padStart(2, '0')}`))

describe('分布表搜索', () => {
  test('原始键参与匹配，大小写不敏感、前后空白忽略', () => {
    const rows = [row('deepseek-official/deepseek-flash'), row('bailian-tpp/deepseek-v4.1-flash')]
    expect(matchBreakdownRows(rows, 'DEEPSEEK')).toHaveLength(2)
    expect(matchBreakdownRows(rows, '  bailian  ')).toEqual([rows[1]!])
    expect(matchBreakdownRows(rows, 'flash')).toHaveLength(2)
    expect(matchBreakdownRows(rows, 'v4.1')).toEqual([rows[1]!])
  })

  test('★ 展示名也参与匹配：`trae-cn` 与「Trae CN」是同一个来源的两种写法', () => {
    const rows = [row('trae-cn'), row('codex')]
    const labelOf = (target: BreakdownRow): string => ({ 'trae-cn': 'Trae CN' })[target.key] ?? target.key
    // 记得原值 / 记得展示名，两种人都要搜得到。
    expect(matchBreakdownRows(rows, 'trae-cn', labelOf)).toEqual([rows[0]!])
    expect(matchBreakdownRows(rows, 'trae cn', labelOf)).toEqual([rows[0]!])
    expect(matchBreakdownRows(rows, 'codex', labelOf)).toEqual([rows[1]!])
    // 展示名与键相同时不重复拼一遍（大部分维度都是这样）。
    expect(breakdownSearchText(rows[1]!, labelOf)).toBe('codex')
  })

  test('★ 分组标签参与匹配（它在第一列是渲染出来的标签，看得见就该搜得到）', () => {
    const rows = [row('u-zhang', { group_names: ['研发', '数字建造中心'] }), row('u-li', { group_names: [] })]
    expect(matchBreakdownRows(rows, '研发')).toEqual([rows[0]!])
    expect(matchBreakdownRows(rows, '数字建造')).toEqual([rows[0]!])
  })

  test('🚨 数值列不参与：搜一个金额 / 用量数字不该命中任何行', () => {
    const rows = [row('m-01', { totalTokens: 14_690, calls: 3 })]
    expect(matchBreakdownRows(rows, '14690')).toEqual([])
    expect(matchBreakdownRows(rows, '3')).toEqual([])
  })

  test('空关键词（含纯空白）返回全部行，不是空表', () => {
    const rows = numbered(3)
    for (const keyword of ['', '   ']) expect(matchBreakdownRows(rows, keyword)).toEqual(rows)
    // ⚠️ 归一化后的关键词进 `BreakdownView.keyword`：空态文案与「匹配 N / 共 M 行」
    //   都读它，留着前后空白会让空态显示成「没有匹配「 」的维度」。
    expect(breakdownViewOf(rows, '  m-01  ', 1).keyword).toBe('m-01')
    expect(breakdownViewOf(rows, '   ', 1).keyword).toBe('')
  })

  test('不命中时是空数组（空态文案由组件按「有没有关键词」分开写）', () => {
    expect(matchBreakdownRows(numbered(3), 'zzz')).toEqual([])
    const view = breakdownViewOf(numbered(3), 'zzz', 1)
    expect(view.matched).toEqual([])
    expect(view.paged).toEqual({ page: 1, pageCount: 1, total: 0, rows: [] })
  })

  test('★ 不改动入参，返回的是新数组', () => {
    const rows = numbered(3)
    const snapshot = [...rows]
    const matched = matchBreakdownRows(rows, 'm')
    expect(rows).toEqual(snapshot)
    expect(matched).not.toBe(rows)
  })
})

describe('分布表分页', () => {
  test('每页 10 行，第 11 行落在第 2 页', () => {
    const view = breakdownViewOf(numbered(11), '', 1)
    expect(view.paged.rows.map((item) => item.key)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m-${String(index + 1).padStart(2, '0')}`),
    )
    const second = breakdownViewOf(numbered(11), '', 2)
    expect(second.paged.page).toBe(2)
    expect(second.paged.pageCount).toBe(2)
    expect(second.paged.rows.map((item) => item.key)).toEqual(['m-11'])
  })

  test('★ 先匹配、后分页：命中最后两行时第 1 页就能看到它们', () => {
    // 🚨 反过来写（先切第 1 页那 10 行，再 filter）这里会得到 0 行 ——
    //   而搜索框看起来完全正常，只是「搜不到」。
    const rows = [...numbered(10), row('zz-1'), row('zz-2')]
    const view = breakdownViewOf(rows, 'zz', 1)
    expect(view.matched).toHaveLength(2)
    expect(view.paged.rows.map((item) => item.key)).toEqual(['zz-1', 'zz-2'])
    expect(view.paged.pageCount).toBe(1)
    // 命中数与总数是两件事：「匹配 2 / 共 12 行」。
    expect(view.paged.total).toBe(2)
    expect(rows).toHaveLength(12)
  })

  test('★ 越界页码夹回最后一页，并给出那一页的行（而不是空表）', () => {
    for (const page of [3, 99, Number.MAX_SAFE_INTEGER]) {
      const view = breakdownViewOf(numbered(12), '', page)
      expect(view.paged.page).toBe(2)
      expect(view.paged.rows.map((item) => item.key)).toEqual(['m-11', 'm-12'])
    }
    // 条数骤减到 3 条（换了个更窄的时间窗）时原本的第 2 页也越界了。
    const shrunk = breakdownViewOf(numbered(3), '', 2)
    expect(shrunk.paged.page).toBe(1)
    expect(shrunk.paged.rows).toHaveLength(3)
  })

  test('页长常量就是这一屏的页长策略（10 行一屏看得满）', () => {
    // ⚠️ 它同时是「改页长」这件事的显式落点，而 `verify/verify-render.ts`
    //   按这个常量生成夹具（不写死条数），所以改这里不会留下一堆假失败。
    expect(BREAKDOWN_PAGE_SIZE).toBe(10)
  })
})

describe('分布表工具条的出现条件', () => {
  test('★ 装得下一屏且没有关键词时，搜索框与页码条都不出现', () => {
    expect(breakdownViewOf(numbered(BREAKDOWN_PAGE_SIZE), '', 1).showToolbar).toBe(false)
    expect(breakdownViewOf([], '', 1).showToolbar).toBe(false)
  })

  test('多出一行就出现（页码条此时才有意义）', () => {
    expect(breakdownViewOf(numbered(BREAKDOWN_PAGE_SIZE + 1), '', 1).showToolbar).toBe(true)
  })

  test('★ 有关键词时必须留着：命中数装得下一屏也一样（否则没法清掉它）', () => {
    const view = breakdownViewOf(numbered(3), 'm-01', 1)
    expect(view.showToolbar).toBe(true)
    expect(view.paged.pageCount).toBe(1) // 页码条不画，搜索框照旧在。
    // 一个都没命中时同理：表是空的，但清掉关键词的入口必须在。
    expect(breakdownViewOf(numbered(3), 'zzz', 1).showToolbar).toBe(true)
  })
})