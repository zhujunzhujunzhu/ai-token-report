/**
 * 列表分页的唯一实现（appKey 列表、用量分布表这类「一次取全、在页面上切片」的表格）。
 *
 * ★ 两个使用方各有自己的页长常量，但**切片与页码修正只有这一份**：
 *   `APP_KEY_PAGE_SIZE`（本文件，凭证行高较大）与
 *   `BREAKDOWN_PAGE_SIZE`（`utils/breakdownView.ts`，分布表连搜索一起收在那里）。
 *   各写一份 `slice()` 的结果是「一个表夹越界页码、另一个表画出空页」。
 *
 * ## 为什么这里是**客户端**分页
 *
 * `GET /api/v1/admin/appkeys` 一次返回**全部**凭证，协议里既没有 `limit`
 * 也没有 `total`（条数上限就是组织里的人头数）；`GET /api/v1/stats/breakdown`
 * 同理（窗口内的全部分组行）。为它们在服务端分页要同时动
 * 契约、路由、e2e 与页面两侧，换来的只是省下几 KB JSON —— 不划算。
 *
 * ⚠️ 与调用明细（`RecordsTable`）**刻意不同**：那里一次查询可能是几十万条事件，
 *   必须由服务端分页；在客户端截断会让「共 N 条」这句真话变成一句谎话。
 *   两种做法不是同一个问题的两种口味，而是由「一次能取回多少」决定的。
 *
 * ## 为什么返回整块（页码 + 切片），而不是只返回一个切片
 *
 * 页码越界是常态：删掉最后一页的最后一行、筛选之后条数骤减都会让当前页
 * 落到范围外。切片与页码一旦各算一次，页面就会出现「写着第 3 页、表里却是
 * 第 1 页的行」这种自相矛盾的画面 —— 而且不会报错。所以这里让
 * **切片与页码出自同一次修正**。
 */

/**
 * appKey 列表每页条数。
 *
 * ★ 这是这一页唯一的页长策略：放在这里而不是散在组件里，是为了让
 *   「页长」与「切片」这对必须一致的量挨着写。取 10 是因为凭证行的行高较大，
 *   一屏正好看满十把而不用滚动（`RecordsTable` 的 20 是给单行明细用的）。
 */
export const APP_KEY_PAGE_SIZE = 10

export interface Paged<T> {
  /** 修正后的页码（1 起）：越界时夹到 `[1, pageCount]`。 */
  page: number
  /** 总页数，**至少 1** —— 空列表也是「第 1 / 1 页」，不是 0 页。 */
  pageCount: number
  /** 入参行数原样带回，省得调用方为了一句「共 N 把」再取一次长度。 */
  total: number
  /** 当前页的行（`slice` 出来的副本，不改动入参）。 */
  rows: T[]
}

/**
 * 按页切片。
 *
 * ⚠️ `page` / `pageSize` 的非法值在这里归一，调用方不必先判一遍：页码来自
 *   组件事件、页长来自常量，两者都不该让一张表变成空白。
 *   `pageSize < 1` 按 1 条算（否则 `行数 / 0` 会得到 `Infinity` 页），
 *   小数页码向下取整（`2.7` 页与 `2` 页是同一页）。
 */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): Paged<T> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const current = Number.isFinite(page)
    ? Math.min(Math.max(1, Math.floor(page)), pageCount)
    : 1
  const start = (current - 1) * size
  return { page: current, pageCount, total: rows.length, rows: rows.slice(start, start + size) }
}
