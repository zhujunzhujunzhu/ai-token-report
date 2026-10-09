/**
 * 趋势图展开成「按用户 / 按模型」时**保留多少层**（本机记忆，不落库）。
 *
 * ## 为什么需要这个开关
 *
 * 服务端默认只留用量最大的 8 层，其余折成一项 `merged: true` 的「其余 N 人」
 * （见 `server/src/stats-route.ts` 的 `SERIES_STACK_DEFAULT_TOP`）。那个默认值
 * 是为「几十个人各占一条线，每一条都细到看不见」准备的，但它有一个代价：
 * **「其余 7 人」恰恰是使用者最想核对的那部分** —— 他在筛选项里明明看得到
 * 这些人，图上却只能看到一坨合计。
 *
 * 所以层数交给看的人自己定：默认 `'all'`（每个人都在图上），需要看清主要几层时
 * 切回前 8 / 前 20 名。服务端那侧只是多一个 `stack_top` 参数，默认行为不变。
 *
 * ## 为什么记在本机
 *
 * 它是**看图的习惯**，与登录身份、数据范围、金额都没有关系，也与别人无关：
 * 记在 `localStorage` 就够了，不写库（库里没有「谁的图该画几层」这回事）。
 * ⚠️ 无 `localStorage`（SSR / Node / 隐私模式）或内容损坏时一律回默认值 ——
 * 一个画图偏好不该把整页打成白屏。
 */

/** 存储键。带版本号：将来形状变了不会把旧数据读成新形状。 */
export const TREND_DEPTH_KEY = 'atr.portal.trendDepth.v1'

/**
 * 保留层数。
 *
 * ⚠️ 值是**字符串**而不是数字：`'all'` 与服务端 `stack_top` 的线上取值逐字对应
 *   （`'8'` / `'20'` / `'all'`），页面这一层不做任何翻译 —— 中间加一次
 *   `number | 'all'` 的转换，早晚会出现「选了全部却发了 8」而两边都不报错。
 */
export type TrendDepth = '8' | '20' | 'all'

/**
 * 默认值：**全部**。
 *
 * ★ 它是刻意选的，不是偷懒：默认前 8 名时，页面上一眼看不到的正是「其余 N 人」，
 *   而人多到需要截断时，使用者至少能自己切回去。
 */
export const DEFAULT_TREND_DEPTH: TrendDepth = 'all'

/** 开关上的三个选项（顺序 = 从少到多）。 */
export const TREND_DEPTH_OPTIONS: readonly { value: TrendDepth; label: string }[] = [
  { value: '8', label: '前 8 名' },
  { value: '20', label: '前 20 名' },
  { value: 'all', label: '全部' },
] as const

/** 认不出来的值一律回默认值（旧版本存过的形状不该让页面选不中任何一项）。 */
export function normalizeTrendDepth(value: unknown): TrendDepth {
  return value === '8' || value === '20' || value === 'all' ? value : DEFAULT_TREND_DEPTH
}

/** 读出本机记住的层数；没记过 / 读不了就是默认值。 */
export function readTrendDepth(): TrendDepth {
  try {
    // ⚠️ SSR（`verify-render.ts`）里没有 `localStorage`：必须先判存在，
    //   不能在模块顶层直接取。
    if (typeof localStorage === 'undefined') return DEFAULT_TREND_DEPTH
    return normalizeTrendDepth(localStorage.getItem(TREND_DEPTH_KEY))
  } catch {
    // 存储被禁用 / 读取抛错：当成「还没记过」。
    return DEFAULT_TREND_DEPTH
  }
}

/** 写回本机记忆。写失败（配额满 / 隐私模式）静默忽略：它只是看图习惯。 */
export function writeTrendDepth(value: TrendDepth): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TREND_DEPTH_KEY, value)
  } catch {
    /* 记不住不影响这一次看图 */
  }
}
