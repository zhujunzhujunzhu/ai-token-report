/**
 * 插件的**浏览器半**（DSH Web 前端里的用量面板）。
 *
 * ## 它是一个 cordis 插件
 *
 * DSH 把 `__DSH_BOOT__` 里的每一条都变成一个客户端 cordis 条目，
 * 所以本模块就是一个普通插件：导出 `apply(ctx)` 与 `inject`。
 * 与宿主半的差别只有一条 —— **它不能 import 宿主半的任何东西**
 * （模块表只预置了 9 个模块，见 `build-client.ts` 的纯度校验）。
 * 两边靠 `/api/tokenReport.stats` 这条 HTTP 路由对话，
 * 契约类型放在 `./protocol.js`，两边都 import 它。
 *
 * ## 为什么 `apply` 里处处都在「先问有没有」
 *
 * 宿主（Node 侧）缺服务时插件整个不激活是可接受的；但**页面里缺服务时
 * 静默消失是不可接受的** —— 用户只会看到「装了插件但界面上什么都没有」。
 * 所以这里每个可选能力都降级成一条告警，而不是让 fiber 卡死。
 *
 * ## 已知的静默失败模式（做诊断时先看这两条）
 *
 * 1. **slot 名字写错** → `slots.inject()` 永不回调 → 面板不出现、无任何报错。
 * 2. **`/api/tokenReport.stats` 没挂上**（宿主缺 `connection`）→
 *    面板会出现但显示「宿主未提供用量数据通道（404）」。
 *    这个提示是刻意写清楚的，见 `store.ts` 的 `describeFetchFailure()`。
 */

import { UsageBadge, UsageDock } from './components.js'
import { createUsageStore, type UsageStore, type UsageStoreDeps } from './store.js'
import { installStyles } from './styles.js'

/**
 * 需要的客户端服务。
 *
 * ⚠️ 名字 `'slots'` 是 DSH 前端注册 slot 服务的**服务名**，
 *   不是包名。写成包名（`@deepseek-ai/dsh-client-ui-slots`）会让 fiber
 *   永远等不到依赖 → 面板静默消失。
 */
export const inject = ['slots'] as const

/**
 * 常驻用量条的挂载点（输入框上方整条）。
 *
 * 与官方 GoalBar 同一个 slot —— 都是 `kind: 'list'`，
 * 谁都能往里加一条，靠 `order` 决定上下顺序。
 */
export const DOCK_SLOT = 'conversation.input.dock'

/** 会话标题栏右侧的挂载点（一排小控件里的一个）。 */
export const HEADER_SLOT = 'conversation.session.header.utilities'

/** 排在官方条目之后：GoalBar 是「当前目标」，比用量更要紧，应该在更上面。 */
export const DOCK_ORDER = 20

/** 徽章排在默认位置。 */
export const BADGE_ORDER = 0

/** 一条 slot 注册所需的字段（DSH 的 `BaseOptions` 里我们用到的那些）。 */
interface SlotRegistration {
  name: string
  /** list 类 slot 必填：同 id 的注册是同一个「格子」。 */
  id: string
  order?: number
  /** 业务面工厂。返回值会作为 props 交给组件。 */
  inject?: () => Record<string, unknown>
}

/**
 * 浏览器半真正依赖的那一小块 slots 能力。
 *
 * 与宿主半同样的思路：**结构化窄接口**而不是 import 第一方的类型包。
 * 好处是不必为了一个 `register` 的类型把 `@deepseek-ai/dsh-client-ui-slots`
 * 及其整条类型依赖（cordis / client-store / react）拖进本包的编译期。
 *
 * ⚠️ `inject` 的语义是「等这个 slot 被声明出来再注册」—— 注册到未声明的
 *   slot 会**直接抛错**（`SlotCore.register` 的文档明写），所以不能直接
 *   `register`，必须先 `inject`。
 */
interface SlotsLike {
  inject(name: string, callback: () => unknown): unknown
  register(options: SlotRegistration, component: unknown): () => void
}

/** 浏览器半真正依赖的那一小块客户端 Context。 */
export interface ClientContext {
  slots?: SlotsLike
  logger?: { info?(message: string): void; warn?(message: string): void }
  /** cordis 的 fiber 作用域清理。 */
  effect?(callback: () => (() => void) | void): void
  /** 按名字取服务（`ctx.get('slots')` 的老写法，第三方插件常见）。 */
  get?(name: string): unknown
}

/** 插件在浏览器里的名字（与宿主半同名，便于排障时对上号）。 */
export const name = 'token-report'

/** 浏览器半的入口。 */
export function apply(ctx: ClientContext): void {
  // 两条取服务的路子都认：`ctx.slots` 是 cordis 的服务代理，
  // `ctx.get('slots')` 是老写法（已安装的第三方插件 dsh-git-rollback 用的就是它）。
  const slots = ctx.slots ?? (ctx.get?.('slots') as SlotsLike | undefined)
  if (slots === undefined || typeof slots.inject !== 'function') {
    ctx.logger?.warn?.('token-report: 客户端 slots 服务不可用，用量面板未挂载')
    return
  }

  const store = createUsageStore({ fetch: defaultFetch() })
  const teardownStyles = installStyles()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // 面板卸载后不该还有定时器在解码日志
      store.dispose()
      teardownStyles()
    })
  }

  registerSurface(slots, DOCK_SLOT, DOCK_ORDER, store, UsageDock)
  registerSurface(slots, HEADER_SLOT, BADGE_ORDER, store, UsageBadge)

  ctx.logger?.info?.(`token-report: 用量面板已挂载（${DOCK_SLOT} + ${HEADER_SLOT}）`)
}

/** 两个挂载点共用一条注册路径：只差 slot 名、顺序与组件。 */
function registerSurface(
  slots: SlotsLike,
  slot: string,
  order: number,
  store: UsageStore,
  component: unknown,
): void {
  slots.inject(slot, () =>
    slots.register(
      {
        name: slot,
        // list 类 slot 的「格子」id：同一个 slot 里再插一个同 id 的会按 priority 分胜负
        id: 'token-report',
        order,
        // ★ 两个面板共用**同一个 store**：取数只做一次，两边数字必然一致
        inject: () => ({ usage: store }),
      },
      component,
    ),
  )
}

/**
 * 取数用的 `fetch`。
 *
 * 同源请求默认带 cookie，而 `/api` 前缀由 DSH 的 connection 服务加了
 * Host/Origin 栅栏 + 浏览器会话鉴权 —— 所以这里**不需要**（也**不应该**）
 * 自己塞任何凭证：插件的 `appKey` 是上报给部门服务端用的，与面板无关。
 */
function defaultFetch(): UsageStoreDeps['fetch'] {
  return (input, init) => globalThis.fetch(input, init)
}
