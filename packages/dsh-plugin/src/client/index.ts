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
 *
 * ## 位置是「挂载前」决定的
 *
 * 用量面板挂在哪儿（输入框上方 / 标题栏右上角）来自宿主半的
 * `GET /api/tokenReport.config` —— **DSH 的客户端插件条目拿不到插件 config**
 * （`WebBootEntry` 里没有 config 字段，壳层组装条目时只传 `name`），
 * 所以部署 YAML 里的 `config.ui.position` 到不了页面，只能由宿主半经 HTTP 送过来。
 *
 * ⚠️ 取配置失败 / 超时 / 旧宿主 404 一律**回退默认位置并照常挂载**：
 *   「问不到位置」绝不能让面板消失 —— 那正是本项目最难排查的一类故障。
 */

import {
  UI_CONFIG_PATH,
  UI_DEFAULT_POSITION,
  readUiConfig,
  type UiPosition,
} from './protocol.js'
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

/**
 * 取「面板位置」的最长等待（毫秒）。
 *
 * 这条请求只回一个常量对象（宿主侧不查库、不读文件），正常在毫秒级返回。
 * 上限是给「路由挂上了但被中间层吞掉」这类异常兜底的：位置不值得
 * 让面板晚出现十几秒，超过上限就按默认位置挂载。
 */
export const UI_CONFIG_TIMEOUT_MS = 1_500

/**
 * 位置 → 要注册的挂载点。
 *
 * **纯函数**，所以三种位置各有单测钉住（`test/client/mounting.test.ts`）——
 * 顺序即注册顺序，`both` 与 0.2.0 的既有顺序一致（dock 在前）。
 */
export function resolveSurfaces(position: UiPosition): readonly string[] {
  if (position === 'header') return [HEADER_SLOT]
  if (position === 'both') return [DOCK_SLOT, HEADER_SLOT]
  // 'dock'（默认）以及任何意外的值：只挂输入框上方的用量条
  return [DOCK_SLOT]
}

/** 每个挂载点的注册参数（order 与组件）。 */
function surfaceSpec(slot: string): { order: number; component: unknown } {
  return slot === HEADER_SLOT
    ? { order: BADGE_ORDER, component: UsageBadge }
    : { order: DOCK_ORDER, component: UsageDock }
}

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

/**
 * 浏览器半的注入点。
 *
 * 与 `store.ts` 同一个思路：**能注入才可单测** —— 挂载点的位置来自一条 HTTP，
 * 而这条 HTTP 正是本模块最需要被测的分支（成功 / 404 / 超时 / 垃圾载荷）。
 */
export interface ClientDeps {
  /** 取数与取配置共用的 fetch；默认全局 `fetch`。 */
  fetch?: UsageStoreDeps['fetch']
  /** 取配置的超时上限（毫秒）。 */
  configTimeoutMs?: number
}

/** 浏览器半的入口。 */
export async function apply(ctx: ClientContext, deps: ClientDeps = {}): Promise<void> {
  // 两条取服务的路子都认：`ctx.slots` 是 cordis 的服务代理，
  // `ctx.get('slots')` 是老写法（已安装的第三方插件 dsh-git-rollback 用的就是它）。
  const slots = ctx.slots ?? (ctx.get?.('slots') as SlotsLike | undefined)
  if (slots === undefined || typeof slots.inject !== 'function') {
    ctx.logger?.warn?.('token-report: 客户端 slots 服务不可用，用量面板未挂载')
    return
  }

  // ★ 位置必须在**注册之前**定下来：注册是一次性的，注册完再改就等于先挂错地方
  //   （`both` 模式下渲染 null 能不能不占位，list 类 slot 并没有承诺）。
  //
  // ⚠️ 但 store 与清理必须在 **await 之前**就绪：取配置期间 fiber 有可能被卸载
  //   （HMR 重新装载就是这么干的），先 await 再 `ctx.effect(...)` 会让那次卸载
  //   拿不到清理函数，把轮询定时器留在页面里。
  const store = createUsageStore({ fetch: deps.fetch ?? defaultFetch() })
  const teardownStyles = installStyles()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // 面板卸载后不该还有定时器在解码日志
      store.dispose()
      teardownStyles()
    })
  }

  const position = await loadPosition(ctx, deps)

  const surfaces = resolveSurfaces(position)
  for (const slot of surfaces) {
    const spec = surfaceSpec(slot)
    registerSurface(slots, slot, spec.order, store, spec.component)
  }

  ctx.logger?.info?.(`token-report: 用量面板已挂载（${surfaces.join(' + ')}）`)
}

/**
 * 取面板位置。
 *
 * ★ **任何失败都回退 `UI_DEFAULT_POSITION` 并告警，绝不抛错、绝不中止挂载**：
 *   客户端插件条目拿不到插件 config，这条 HTTP 是唯一来源，而
 *   「读配置失败 → 面板不出现」是本项目最不可诊断的一类故障。
 *   回退值与宿主半 `installUiRoute()` 的缺省值**是同一个常量**。
 */
async function loadPosition(ctx: ClientContext, deps: ClientDeps): Promise<UiPosition> {
  const request = deps.fetch ?? defaultFetch()
  const timeoutMs = deps.configTimeoutMs ?? UI_CONFIG_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await request(UI_CONFIG_PATH, { signal: controller.signal })
    if (!res.ok) return fallbackPosition(ctx, `HTTP ${res.status}`)
    // 非 JSON（SPA 兜底页）不该抛到这里：readUiConfig 对垃圾输入回退默认值
    const body = await res.json().catch(() => undefined)
    return readUiConfig(body)
  } catch (err) {
    return fallbackPosition(ctx, err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
}

/** 回退到默认位置，并把原因说清楚（面板照常出现，只是位置是默认的）。 */
function fallbackPosition(ctx: ClientContext, reason: string): UiPosition {
  ctx.logger?.warn?.(
    `token-report: 读取面板位置失败（${reason}），按默认位置 ${UI_DEFAULT_POSITION} 显示`,
  )
  return UI_DEFAULT_POSITION
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
