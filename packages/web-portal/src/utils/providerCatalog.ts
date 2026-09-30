/**
 * 使用者自建的供应商名（**只存在本机浏览器里**，不落库）。
 *
 * ## 为什么需要它
 *
 * 库里出现过哪些供应商由用量决定（`GET /api/v1/stats/providers`）。但使用者
 * 可能要看一个**库里的候选里还没有**的名字：新接入的网关、还没产生用量、
 * 或者他要的本来就是一个子串（服务端的匹配是子串）。让下拉支持 `allow-create`
 * 之后，那个名字需要一个地方待着 —— 否则每刷新一次页面就要重新输一遍。
 *
 * ## 🚨 为什么不写数据库
 *
 * 供应商名是**用量行上的事实**（`usage_event.provider`），不是一份可编辑的目录。
 * 往库里插一条「供应商」等于发明了一个没有用量、没有价格的幽灵维度 ——
 * 它会出现在候选里、却永远查不出数据，而且没有任何地方能删掉它。
 * 归一化规则（`provider_alias`）才是库里那份配置，那是管理面的事。
 *
 * 所以这里只做**本机记忆**：与登录身份、数据范围、金额全都无关，
 * 换台机器/换个浏览器就是另一份列表 —— 页面必须把这件事说出来。
 *
 * ## 读失败一律当空
 *
 * 无 `localStorage`（SSR / Node / 隐私模式）或内容损坏时返回 `[]`：
 * 一个筛选下拉的记忆不该把整页打成白屏，也不该阻止查询。
 */

/** 存储键。带版本号：将来形状变了不会把旧数据读成新形状。 */
export const CUSTOM_PROVIDERS_KEY = 'atr.portal.customProviders.v1'

/** 最多记这么多条：一份筛选下拉的记忆不该无限增长。 */
export const CUSTOM_PROVIDERS_LIMIT = 50

/** 读出本机记录的自定义供应商名（去重、去空、保持原顺序）。 */
export function readCustomProviders(): string[] {
  try {
    // ⚠️ SSR（`verify-render.ts`）里没有 `localStorage`：必须先判存在，
    //   不能在模块顶层直接取。
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(CUSTOM_PROVIDERS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const names: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const value = item.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      names.push(value)
      if (names.length >= CUSTOM_PROVIDERS_LIMIT) break
    }
    return names
  } catch {
    // 存储被禁用 / 内容不是 JSON：当成「还没记过」。
    return []
  }
}

/** 写回本机记录。写失败（配额满 / 隐私模式）静默忽略：它只是记忆。 */
export function writeCustomProviders(names: readonly string[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CUSTOM_PROVIDERS_KEY, JSON.stringify(names.slice(0, CUSTOM_PROVIDERS_LIMIT)))
  } catch {
    /* 记不住不影响这一次筛选 */
  }
}
