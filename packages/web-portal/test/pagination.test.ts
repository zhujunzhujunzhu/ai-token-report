/**
 * 列表分页的回归：**切片与页码出自同一次修正**。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ 页码越界（删掉最后一页最后一行、筛选后条数骤减）必须夹回有效页，
 *    并且给出**那一页的行** —— 而不是一张空表配一个不存在的页码。
 * 2. ★ 空列表是「第 1 / 1 页」，不是 0 页：页脚会拿 `pageCount` 直接写
 *    「第 x / y 页」，0 页会显示成「第 1 / 0 页」。
 * 3. ★ 非法页码 / 页长归一，不许抛异常也不许返回空表：页码来自组件事件、
 *    页长来自常量，它们不该有能力把一张表打成空白。
 * 4. ★ 不改动入参（`slice` 出副本）：分页是展示，不是对数据的编辑。
 *
 * 至于「页脚长什么样」（`第 1 / 2 页 · 每页 10 把`）由 `verify/verify-render.ts`
 * 在真渲染里钉住 —— 这里只测纯逻辑。
 */
import { describe, expect, test } from 'bun:test'
import { APP_KEY_PAGE_SIZE, paginate } from '../src/utils/pagination.js'

/** 1..n：用行号当行内容，切片错了能一眼看出来是「漏了第 11 行」还是「多切了一行」。 */
const numbered = (n: number): number[] => Array.from({ length: n }, (_, index) => index + 1)

describe('分页切片', () => {
  test('21 条按每页 10 切成 3 页，最后一行落在第 3 页', () => {
    const all = numbered(21)
    expect(paginate(all, 1, 10).rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(paginate(all, 2, 10).rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    const last = paginate(all, 3, 10)
    expect(last.page).toBe(3)
    expect(last.pageCount).toBe(3)
    expect(last.total).toBe(21)
    // 最后一页只有 1 行（整页切片的边界：`start` 之后没有第 22 行可切）。
    expect(last.rows).toEqual([21])
  })

  test('页长整除时不多出一个空页', () => {
    // 20 条 / 每页 10 = 正好 2 页。多算一页会让分页条上出现一个永远点不开的「3」。
    const paged = paginate(numbered(20), 2, 10)
    expect(paged.pageCount).toBe(2)
    expect(paged.rows).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })

  test('空列表是「第 1 / 1 页」，不是 0 页', () => {
    const empty = paginate([], 1, 10)
    expect(empty).toEqual({ page: 1, pageCount: 1, total: 0, rows: [] })
  })

  test('★ 越界页码夹到最后一页，并给出那一页的行（而不是空表）', () => {
    const all = numbered(21)
    for (const page of [4, 99, Number.MAX_SAFE_INTEGER]) {
      const paged = paginate(all, page, 10)
      expect(paged.page).toBe(3)
      expect(paged.rows).toEqual([21])
    }
    // 条数骤减到 3 条时，原本的第 2 页也越界了。
    const shrunk = paginate(numbered(3), 2, 10)
    expect(shrunk.page).toBe(1)
    expect(shrunk.rows).toEqual([1, 2, 3])
  })

  test('★ 非法页码 / 页长归一：不抛异常，也不返回空表', () => {
    const all = numbered(3)
    // 页码：0 / 负数 / 小数 / NaN 都按第 1 页算（小数向下取整）。
    for (const page of [0, -5, 1.7, Number.NaN]) {
      const paged = paginate(all, page, 10)
      expect(paged.page).toBe(1)
      expect(paged.rows).toEqual([1, 2, 3])
    }
    // 页长：0 / 负数 / NaN 按「每页 1 条」算 —— 而不是拿 0 去除（那会得到 Infinity 页）。
    for (const size of [0, -1, Number.NaN]) {
      const paged = paginate(all, 1, size)
      expect(paged.pageCount).toBe(3)
      expect(paged.rows).toEqual([1])
    }
    // 页长为小数时向下取整：2.9 与 2 是同一个页长（否则会切出半行）。
    expect(paginate(numbered(6), 2, 2.9).rows).toEqual([3, 4])
  })

  test('★ 不改动入参，返回的是切片出来的副本', () => {
    const all = numbered(21)
    const snapshot = [...all]
    const paged = paginate(all, 2, 10)
    expect(all).toEqual(snapshot)
    expect(paged.rows).not.toBe(all)
    paged.rows.push(999)
    expect(all).toHaveLength(21)
  })

  test('页长常量就是这一页的页长策略（10 把一屏看得满）', () => {
    // ⚠️ 它同时是「改页长」这件事的显式落点：页长与切片挨着写在 `utils/pagination.ts`，
    //   而 `verify/verify-render.ts` 的分页断言按这个常量生成夹具（不写死条数），
    //   所以改这里不会留下一堆假失败 —— 但会真的改变一屏能看几把。
    expect(APP_KEY_PAGE_SIZE).toBe(10)
  })
})
