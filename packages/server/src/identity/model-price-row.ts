/**
 * `model_price` 表的一行 → 两种内存形状。
 *
 * ## ★ 为什么单独一个文件
 *
 * 同一行数据有两个消费者，而它们要的形状不同：
 *
 * | 消费者 | 形状 | 用途 |
 * |---|---|---|
 * | 管理接口 `/api/v1/admin/pricing*` 与统计快照 `/api/v1/stats/pricing` | `PortalModelPrice`（**snake_case**，线上契约） | 页面表格逐列展示 |
 * | 冲突校验 / 金额计算 | `ModelPrice`（**camelCase**，`shared/price.ts`） | 交给 `findPriceConflicts()` / `resolvePrice()` |
 *
 * 两份映射都只该有一处实现。放在这里而不是 `repository.ts` 的私有方法里，
 * 是因为统计快照（`stats-route.ts`）也要发同一份 `PortalModelPrice` ——
 * 让它自己再写一遍列映射，就会多出第二份「NULL 怎么处理」的判断，
 * 而两份的分叉**不会报错**：一边把 `effective_to_ms = NULL` 读成 0，
 * 那份价在页面上就显示成「1970 年就结束了」，且从此再也用不上。
 */

import type { ModelPrice, PortalModelPrice } from '@ai-token-report/shared'
import { modelPriceFromWire } from '@ai-token-report/shared'
import { num, str, type Row } from './types.js'

/** 线上契约形状（snake_case，逐列照搬契约字段名）。 */
export function modelPriceFromRow(row: Row): PortalModelPrice {
  return {
    price_id: str(row, 'price_id'),
    provider: str(row, 'provider'),
    model: str(row, 'model'),
    currency: str(row, 'currency'),
    input_micro_per_ktok: num(row, 'input_micro_per_ktok'),
    output_micro_per_ktok: num(row, 'output_micro_per_ktok'),
    cache_read_micro_per_ktok: num(row, 'cache_read_micro_per_ktok'),
    cache_write_micro_per_ktok: num(row, 'cache_write_micro_per_ktok'),
    effective_from_ms: num(row, 'effective_from_ms'),
    // ⚠️ 必须显式判 `null`，不能 `num()` 了事：`num()` 会把 NULL 变成 `0`，
    //   而 `0` 是一个**合法的、早已过去的生效终点** —— 于是「至今有效」
    //   会渲染成 1970 年，且这条价从此再也用不上。
    effective_to_ms: row.effective_to_ms == null ? null : num(row, 'effective_to_ms'),
    note: row.note == null ? null : str(row, 'note'),
    created_at_ms: num(row, 'created_at_ms'),
    updated_at_ms: num(row, 'updated_at_ms'),
  }
}

/**
 * `shared/price.ts` 的内存形状（camelCase）。
 *
 * 🚨 「两个区间是否重叠」这条规则**只在 `shared/price.ts` 的
 *   `findPriceConflicts()` 里实现一次**，这里只负责改名，绝不顺手比较：
 *   两边一旦漂移，页面会拒掉一个合法区间、却放行一个重叠区间，
 *   而两边都不报错 —— 只有对账时才会发现某段时间的金额对不上。
 *
 * ★ 改名这一步**复用 `modelPriceFromWire()`**（CLI 从 HTTP 取价时也走它）：
 *   自己再写一遍列映射，就等于把「`effective_to_ms` 为 NULL 怎么处理」
 *   变成两处判断 —— 而分叉的表现只是「这条价再也匹配不上」，不会报错。
 *   这里先经 `modelPriceFromRow()` 把驱动返回值（MySQL 的 SUM/BIGINT 是字符串、
 *   列可能是 `unknown`）归一成契约形状，再交给那条唯一的改名实现。
 */
export function priceShapeFromRow(row: Row): ModelPrice {
  return modelPriceFromWire(modelPriceFromRow(row))
}