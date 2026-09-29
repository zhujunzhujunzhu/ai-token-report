/**
 * DSH token 上报插件 —— 团队统一铺开的入口。
 *
 * ## 一句话职责
 *
 * 装在 DSH 里，**无人值守地**把本机产生的计费级 token 用量实时上报到部门服务端，
 * 同时给同事一个「问一句就能看到自己用量」的工具。
 *
 * ## 三种形态，一份内核
 *
 * ```
 * ① 实时上报   SessionTelemetryBackend.emit(record)   ← 会话进行中，秒级
 * ② 统计工具   token_usage（Agent 可调用）             ← "我今天用了多少 token"
 * ③ 统计服务   ctx.tokenReport（其它插件可调用）
 * ```
 *
 * ②③ 与 CLI `dsh-token`、本地页面走的是**同一套聚合与同一套口径**，
 * 所以「工具报的数」与「页面上的数」必然一致（`ARCHITECTURE.md` §3）。
 *
 * ## 挂载点：一个 `SessionTelemetryBackend`
 *
 * 复用 DSH 已有的捕获链路，不自建事件监听与 token 计量（见 `docs/插件方案.md` §1）：
 *
 * ```
 * session/event (同步热路径)
 *       ↓
 * SessionTelemetryCoordinator（过滤 + 深拷贝 + 脱敏瀑布）
 *       ↓
 * emit(record)  ← 🚨 必须非阻塞入队（同步调用，不能 await fetch）
 *       ↓
 * 内存队列 → 批量 → 磁盘 outbox → HTTP POST → 部门服务端
 * ```
 *
 * ## 四个硬约束（违反即事故）
 *
 * 1. 🚨 **`emit()` 在热路径同步执行，只能入队**。
 *    任何 `await fetch` 都会拖慢 agent loop —— 用户会直接感觉到卡顿。
 * 2. 🚨 **同一时刻只能挂载一个 telemetry 后端**（cordis 重复注册同名服务会抛错）。
 *    本插件与官方 `dsh-session-telemetry-otel` **互斥**，两者只能装一个。
 * 3. 🚨 **投递是 best-effort**：游标记的是「已交出」不是「已送达」
 *    → 必须自建磁盘 outbox（`outbox.ts`），否则崩溃会丢数据。
 * 4. 🚨 **`session-telemetry/record` 瀑布默认不脱敏**，记录会原样带出文件内容与命令输出
 *    → 必须自己挂脱敏规则，并保证 `includeContent: false`。
 *
 * ## 未署名 / 未配凭证 = 不采集也不上报
 *
 * ★ 这是合规底线。判定在 `evaluateStatus()` 这个纯函数里，测试钉死在
 *   `test/status.test.ts` —— 判错了就是「偷偷上报」或「永远不上报」。
 *   宁可数据缺失（看板上能看到缺口），也不要未授权采集。
 */

import { resolvePaths } from '@ai-token-report/core'
import type { Context } from '@deepseek-ai/cordis'
import { SessionTelemetryBackend, SessionTelemetryCoordinator } from '@deepseek-ai/dsh-session-telemetry'

import {
  canReport,
  resolveConfig,
  validateConfig,
  type EffectiveConfig,
  type RawConfig,
} from './config.js'
import { IdentityResolver, type IdentityState } from './identity.js'
import type { ReporterStats } from './reporter.js'
import type { BackfillStats } from './backfill-runner.js'
import {
  createSettingsHandler,
  readConnection,
  withSavedConnection,
} from './settings.js'
import { createReportsHandler } from './reports.js'
import {
  evaluateStatus,
  ReportRuntime,
  type BackendRefs,
  type PluginStatus,
} from './runtime.js'
import { installUiRoute, type UiHostContext } from './ui-bridge.js'
import type { UiRouteInstall } from './client/protocol.js'
import { closeStatsWorker } from './stats-worker-client.js'
import {
  formatUsage,
  queryUsage,
  TOOL_DIMENSIONS,
  type StatsContext,
  type UsageQuery,
  type UsageResult,
} from './stats.js'

export const name = 'token-report'

/** 工具名。团队同事在对话里就是这么问的。 */
export const TOOL_NAME = 'token_usage'

/** 服务名（`ctx.tokenReport`）。 */
export const SERVICE_NAME = 'tokenReport'

/** 插件对外暴露的配置（与 `config.ts` 的 `RawConfig` 同构）。 */
export type Config = RawConfig

/**
 * 上报与装配的判定留在 `runtime.ts`，这里只做**再导出**。
 *
 * ⚠️ 测试与文档一直从 `index.js` 取它们（`evaluateStatus` / `PluginStatus`），
 *   所以搬家之后必须保留这条入口 —— 否则「判定逻辑只有一份」会变成
 *   「判定逻辑有两份，其中一份是空 import」。
 */
export { evaluateStatus, type PluginStatus } from './runtime.js'

/**
 * 组装提示文案（未启用上报时）。
 *
 * 同样抽成纯函数，措辞是这个功能能否被接受的关键：
 * 必须说明「怎么启用」，而不只是「没启用」。
 */
export function describeDisabled(status: PluginStatus, resolver: IdentityResolver): string {
  if (status.reportingEnabled) return ''

  if (!status.identityReady) {
    return resolver.describeProblem()
  }

  if (status.disabledReason?.includes('appKey')) {
    return [
      '⚠ token 上报未启用：未配置上报凭证 appKey。',
      '  ★ 在你完成配置之前，本插件不采集、也不上报任何数据。',
      '  配置方式（任选其一）：',
      '    1. 在用量面板右上角点齿轮「配置」，填服务端地址与管理员发放的 appKey',
      '    2. 插件 config 里写 appKey: <管理员发放的凭证>',
      '    3. 设置环境变量 DSH_TOKEN_REPORT_APP_KEY',
    ].join('\n')
  }

  return [
    `⚠ token 上报未启用：${status.disabledReason ?? '未知原因'}。`,
    '  请在 DSH 配置中为 token-report 插件设置 config.endpoint，',
    '  例如：endpoint: https://your-portal.example.com/api/v1/token-usage',
  ].join('\n')
}

/**
 * 探针后端的契约形状。
 *
 * ⚠️ 从类上 `Pick` 出来的类型，装进这个文件是为了让测试能传一个假后端，
 *   而**不必** import cordis、更不必起一个真实 Context。
 */
type BackendPort = Pick<SessionTelemetryBackend, 'emit' | 'flush' | 'shutdown'>

/**
 * 本插件真正依赖的宿主能力。
 *
 * 刻意**收窄**而不是直接写 cordis 的 `Context`：这样「插件依赖了什么」
 * 在类型上一眼可见，而测试也能传一个几行的假 ctx 而不必搭起整个 cordis 运行时。
 * 真实的 cordis Context 结构上满足这个接口。
 */
export interface BackendContext {
  logger: { info(message: string): void; warn(message: string): void }
  effect(callback: () => (() => void) | void): void
  /**
   * 注册事件监听。
   *
   * ⚠️ 参数类型刻意放宽成 `unknown[]`：cordis 的 `ctx.on` 是按事件名做重载的，
   *   在这里精确还原会引入一整套对 `@deepseek-ai/cordis` 事件表的类型依赖。
   *   我们只挂 `session-telemetry/record` 一条瀑布，形状在 `installRedaction`
   *   里就地收窄 —— 收益是插件不必跟着宿主的事件表版本走。
   */
  on(event: string, listener: (...args: never[]) => unknown): () => void
  /** 会话服务 —— coordinator 会 `ctx.sessions.list()` 扫已在跑的会话。 */
  sessions: { list(): Iterable<unknown> }
}

/**
 * 挂上脱敏规则。
 *
 * 🚨 这是「`includeContent` 必须为 false」在**代码层面**的保证，
 *   而不是靠配置自觉：DSH 的瀑布默认不带规则，记录会原样带出
 *   文件内容与命令输出。这里用白名单把 body 裁到只剩计费字段。
 */
function installRedaction(ctx: BackendContext): void {
  ctx.effect(() => {
    const dispose = ctx.on('session-telemetry/record', ((record: unknown, next: () => unknown) => {
      const passed = next()
      if (passed === null || typeof passed !== 'object') return passed
      const body = (passed as { body?: unknown }).body
      if (body === null || typeof body !== 'object') return passed
      return { ...(passed as object), body: stripToBillingFields(body as Record<string, unknown>) }
    }) as never)
    return dispose
  })
}

/**
 * 上报后端本体 —— **薄适配器**。
 *
 * 它只把 coordinator 的三个回调转发给运行时给的那组闭包，并暴露两个诊断入口。
 * 「往哪发、以谁的名义、多久发一次」全都在 `ReportRuntime` 里，可以被就地替换
 * （设置页保存后立刻生效，不必重启 DSH）。
 *
 * `emit()` 链路上只有一次纯函数折叠 + 一次数组 push —— 这是本类最重要的性质，
 * 任何改动都要重新确认它没有引入 IO。
 */
export class TokenReportBackend extends SessionTelemetryBackend implements BackendPort {
  /**
   * 部署选定的共享模式，**不是**投递回执。
   *
   * `full` 表示「本部署全量共享会话遥测」—— 团队统一安装、员工已知情的前提下
   * 才应写这个值。合规评审会问到这里，改它之前先在内部文档里说清楚。
   */
  readonly sharing = 'full' as const

  static inject = ['sessions']

  /**
   * 热路径与诊断入口，挂成**自有属性**而不是私有字段。
   *
   * 🚨 原因是 cordis 的 `ctx.get('sessionTelemetry')` 返回**服务代理**，
   *   而 JS 的私有字段（`#x`）穿不过 Proxy —— 任何 `emit()` 方法体里的
   *   `this.#reporter` 都会抛 `TypeError: Cannot access invalid private field`。
   *
   *   这一点在生产里是致命的：coordinator 通过 `this.backend.emit(record)`
   *   调用后端，而它拿到的正是代理对象 —— 也就是说**每一次会话事件都会炸**。
   *   实例内部自调用（`this.emit(...)`）拿到的是真实例，所以单测全绿、
   *   只有真实装载才会暴露。这是 `verify/verify-cordis-load.ts` 存在的全部理由。
   */
  readonly reporterStats: (() => ReporterStats) & ReporterStats

  /** 历史补报独立于实时队列；自有闭包入口可安全经 cordis 代理读取。 */
  readonly backfillStats: () => BackfillStats

  /**
   * 热路径接收器：由运行时给的闭包（折叠 + 入队到**当前**投递单元）。
   *
   * ★ 闭包实现没有任何 `this` 依赖，因此在代理与原对象上行为完全一致 ——
   *   并且**顺带保证了热路径不做 IO**（它只碰内存数组）。
   */
  readonly sink: BackendRefs

  /**
   * @param ctx - DSH 的插件上下文（cordis Context）。
   * @param refs - 运行时给的闭包组（热路径 + 诊断入口）。
   *
   * ⚠️ 类型上刻意收成 `BackendContext` 而不是 cordis 的 `Context`：
   *   本文件只用到 `logger` / `effect` / `on` / `sessions` 四个能力，
   *   用宽接口能让 `apply()` 的契约一眼看清「这个插件到底依赖什么」。
   *   真实的 Context 结构上满足它，所以装配时无需任何断言。
   */
  constructor(ctx: BackendContext, refs: BackendRefs) {
    super(ctx as Context)

    this.sink = refs
    this.reporterStats = refs.reporterStats
    this.backfillStats = refs.backfillStats

    // 装配捕获侧：本后端是热路径的唯一消费者。
    //
    // ⚠️ 三个回调都用**闭包**而不是 `this.sink.x` —— 因为 coordinator 拿到的是
    //   服务代理，走 `this.#x` 会炸（见字段注释）。
    new SessionTelemetryCoordinator(
      ctx as Context,
      {
        emit: (record) => refs.emit(record),
        // turn 结束时提示冲刷 —— 长会话的延迟从「一个周期」降到「每轮」
        flush: () => refs.flush(),
        shutdown: () => refs.shutdown(),
      },
      { capture: 'live', includeHistory: true },
    )

    // ★ 脱敏兜底：DSH 的 `session-telemetry/record` 瀑布**默认不带任何规则**，
    //   记录会原样带出文件内容与命令输出。本插件只上报 token 数值与模型名，
    //   所以即便宿主没装配规则，这里也把话题正文剥掉。
    //   放在本插件自己的 fiber 上，卸载时自动解除。
    installRedaction(ctx)
  }

  /**
   * 🚨 同步热路径：只做折叠 + 入队。
   *
   * 这里**不能**访问 `this.#私有字段`（见上方字段注释），
   * 所以状态与实现都通过自有属性/闭包取。
   * 实例被 cordis 代理后调用本方法时，`this` 上仍能读到这个自有属性。
   */
  emit(record: Parameters<SessionTelemetryBackend['emit']>[0]): void {
    this.sink.emit(record)
  }

  /** turn 结束的冲刷提示（fire-and-forget，不阻塞调用方）。 */
  flush(): void {
    this.sink.flush()
  }

  /** 排空并停止。抛错只会被 coordinator 记一条 warning，不会阻断退出。 */
  async shutdown(): Promise<void> {
    await this.sink.shutdown()
  }
}

/**
 * 把事件体裁剪到「只含计费字段」。
 *
 * 🚨 保留白名单而不是黑名单：新增事件类型时，凡是没在白名单里的字段
 *   一律不会外发。用黑名单的话，DSH 加一个新字段就可能悄悄带出内容。
 */
function stripToBillingFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const usage = body['usage']
  if (usage !== null && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    const picked: Record<string, unknown> = {}
    for (const key of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ]) {
      const v = u[key]
      if (typeof v === 'number' && Number.isFinite(v)) picked[key] = v
    }
    out['usage'] = picked
  }

  const message = body['message']
  if (message !== null && typeof message === 'object') {
    const source = (message as Record<string, unknown>)['source']
    if (source !== null && typeof source === 'object') {
      const s = source as Record<string, unknown>
      out['message'] = {
        source: {
          ...(typeof s['kind'] === 'string' ? { kind: s['kind'] } : {}),
          ...(typeof s['provider'] === 'string' ? { provider: s['provider'] } : {}),
          ...(typeof s['model'] === 'string' ? { model: s['model'] } : {}),
        },
      }
    }
  }

  for (const key of ['turn', 'step']) {
    const v = body[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }

  return out
}

/** `apply()` 的依赖注入形状 —— 只为让测试能覆盖身份解析结果。 */
export interface ApplyDeps {
  /** 直接给定身份解析结果，跳过文件读取。 */
  identityState?: IdentityState
}

/**
 * DSH 会在 apply 阶段调用。
 *
 * 顺序很重要：
 * 1. **先判身份与配置** —— 不满足就什么都不注册（安全默认值）。
 * 2. 再注册上报后端（唯一会往外发数据的东西）。
 * 3. 最后注册工具与服务 —— 它们是纯粹的本地读取，即使上报关掉也应该可用
 *    （同事仍能查自己的用量），所以放在最外层、不受 `reportingEnabled` 影响。
 */
export function apply(
  ctx: ApplyContext,
  rawConfig: RawConfig = {},
  deps: ApplyDeps = {},
): { status: PluginStatus; backend: TokenReportBackend | null } {
  const merged = withSavedConnection(rawConfig)
  const config = resolveConfig(merged)

  // 配置问题要在启动时说清楚，但**不能**因此让 DSH 起不来。
  // ⚠️ 必须把 raw 一起传进去：`EffectiveConfig` 里的非法值已经被抹平，
  //   光看它分不出「没配」与「配错了」（见 validateConfig 的注释）。
  for (const problem of validateConfig(config, merged)) {
    ctx.logger.warn(`token-report: ${problem}`)
  }

  const resolver = buildResolver(config)

  const identityState = deps.identityState ?? resolver.resolve()
  const status = evaluateStatus(identityState, config)

  const statsContext = buildStatsContext(config)
  ctx.effect(() => () => { void closeStatsWorker(statsContext.dbPath) })

  // ── ① 上报运行时 ──────────────────────────────────────────────────
  //
  // ★ 与旧实现的关键差别：上报后端不再由配置**一次性**钉死。
  //   设置页保存完连接后调 `runtime.refresh()`，运行时就地换一个「投递单元」
  //   （新 endpoint / 新 appKey / 新间隔），用户不必重启 DSH。
  //   合规底线那一步仍然只在 `runtime.applyState()` 里（同一个 `evaluateStatus`）。
  const runtime = new ReportRuntime<TokenReportBackend>(
    {
      logger: {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
      },
      // ⚠️ 传**原始**配置而不是 merged：运行时自己每次现读磁盘上的已保存连接，
      //   否则保存完再 refresh 会拿着旧快照覆盖新值。
      raw: rawConfig,
      resolver,
      createBackend: (refs: BackendRefs) => new TokenReportBackend(ctx, refs),
    },
    config,
  )

  let backend: TokenReportBackend | null = null
  if (status.reportingEnabled && identityState.ready) {
    backend = runtime.start(config, identityState.identity)
    if (backend !== null && backend.reporterStats.outbox.droppedBatches > 0) {
      ctx.logger.warn(
        `token-report: outbox 超过上限，已丢弃 ${backend.reporterStats.outbox.droppedBatches} 批最旧数据`,
      )
    }
  } else {
    // ★ 未署名 / 未配凭证 → 不注册上报后端，只提示一次。
    //   这是「未填写前不采集」约定的落点。
    resolver.warnOnce((message) => ctx.logger.warn(message))
  }

  // ── ② 统计工具 ────────────────────────────────────────────────────
  if (config.features.tools) {
    status.toolsRegistered = registerTools(ctx, statsContext, runtime)
  }

  // ── ③ 统计服务 ────────────────────────────────────────────────────
  if (config.features.service) {
    status.serviceRegistered = registerService(ctx, config, statsContext)
  }

  // ── ④ UI 数据通道（浏览器半的取数口）──────────────────────────────
  //
  // ★ 与工具/服务一样是**纯本地读取**，所以不受 `reportingEnabled` 影响：
  //   没署名、没 appKey 的同事照样能在界面上看自己的用量。
  //   宿主没有 `connection`（headless / 非 web profile）时安静跳过。
  if (config.features.ui) {
    status.uiRoute = installUiRoute(ctx, statsContext, {
      // ★ 位置只能这样交给页面：客户端插件条目拿不到插件 config。
      //   传**取值函数** —— 设置页改完位置后，同一个进程里再打开页面就是新位置。
      position: () => runtime.config().ui.position,
      // ★ 数据代次 = 本进程已采集的计费记录数。
      //
      //   面板上的数字来自本机日志的聚合，而「本进程又采到用量」正是它变化的主因；
      //   浏览器半拿这个计数做探针（`?gen=N`），代次没变就一个字节都不回 ——
      //   于是它可以 3 秒看一次而几乎不花钱（见 client/store.ts）。
      //
      //   ⚠️ 这里必须是**纯内存读**：探针默认 3 秒一次，任何 IO 都等于把
      //     省下来的开销又加回去。`enqueued()` 只是读一个计数器。
      //   ⚠️ 上报未启用（未署名 / 没 appKey）时没有投递单元，代次恒为 0，
      //      此时浏览器半退回「按兜底周期全量取数」—— 与改动前一致，
      //      不会退化成「永远不刷新」。
      generation: () => runtime.enqueued(),
      // ★ 设置页的读与写：GET 反映**当前运行状态**（保存后立刻是新值），
      //   POST 落盘之后调 `runtime.refresh()` 让上报就地生效。
      settingsFetch: createSettingsHandler({
        state: () => ({
          config: runtime.config(),
          identity: runtime.identity(),
          saved: readConnection(runtime.config().dshHome),
          reporting: runtime.status(),
          // 身份由部署配置钉死时不允许在页面上改连接：那会造出
          // 「实名来自配置、凭证来自页面」这种自相矛盾的署名。
          locked: !!rawConfig.user,
        }),
        apply: () => runtime.refresh(),
      }),
      // ★ 上报调试面：让用户看见「到底发出去了什么」，而不只是「已启用」。
      reportsFetch: createReportsHandler(runtime),
    })
    if (status.uiRoute === 'unavailable') {
      ctx.logger.info(
        'token-report: 宿主不提供 connection 服务（非 web profile），界面用量面板不可用；' +
          '上报与 token_usage 工具不受影响。',
      )
    }
  }

  return { status, backend }
}

/** 统计上下文：两个路径 + 功能开关。 */
function buildStatsContext(config: EffectiveConfig): StatsContext {
  const paths = resolvePaths(config.dshHome)
  return {
    config,
    sessionsRoot: paths.sessionsRoot,
    dbPath: paths.dbPath,
    backgroundQueries: true,
  }
}

/**
 * 用生效配置构造身份解析器。
 *
 * 单独一个函数是为了让「生效配置 → 解析器」这层映射只有一处 ——
 * 之前它在 `apply` / `default.apply` / 服务里各写了一遍，
 * 三处只要有一处漏掉 `dshHome`，就会出现「同一个配置、两个不同身份文件」的怪事。
 */
function buildResolver(config: EffectiveConfig): IdentityResolver {
  return new IdentityResolver({
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.user ? { configIdentity: config.user } : {}),
  })
}

/** `apply()` 需要的宿主能力：后端能力 + cordis 的服务注册表。 */
export interface ApplyContext extends BackendContext, UiHostContext {
  /** cordis 的服务注册表。 */
  reflect: { provide(name: string, value: unknown): void }
}

/**
 * 注册给 Agent 的统计工具。
 *
 * ⚠️ 用 `ctx.reflect.provide` 而不是某个具体的 tools 服务：本插件**不应该**
 *   为了注册一个只读工具而新增一条对 `dsh-tools` 的编译期依赖 ——
 *   那会让插件在没装该服务的部署里直接起不来。宿主没有对应能力时静默跳过。
 *
 * @param backend - 已启用的上报后端；未启用时为 null，诊断工具据此说明原因。
 * @returns 是否真的注册成功。
 */
function registerTools(
  ctx: ApplyContext,
  statsContext: StatsContext,
  runtime: ReportRuntime<TokenReportBackend>,
): boolean {
  try {
    ctx.reflect.provide('tokenReportTools', {
      [TOOL_NAME]: {
        description:
          '统计本机 DSH token 用量（计费级，来自 provider 真实上报值）。' +
          '可按周期、维度、模型过滤；返回计费总量、缓存命中率与分组排行。' +
          '只读取本机会话日志，不产生任何上报。',
        parameters: {
          period: '具名周期：today | yesterday | week | lastweek | month | lastmonth | year | last7d | last30d（也接受中文：今天/本周/本月/最近7天）',
          by: `分组维度，逗号分隔：${TOOL_DIMENSIONS.join(' | ')}（默认 provider-model）`,
          top: '每个维度显示前 N 行（默认 30）',
          series: '趋势粒度：day | hour（不给则不出趋势）',
          provider: 'provider 子串过滤（如 dashscope）',
          model: 'model 子串过滤（如 deepseek-v4.1-flash）',
        },
        async run(raw: Record<string, unknown>): Promise<string> {
          return runTool(statsContext, raw)
        },
      },
      // 诊断入口：回答「我的数据发出去了没有」——没有它，采集链路的静默失败无法发现
      [`${TOOL_NAME}_diagnostics`]: {
        description: '查看 token 上报链路的运行状态（已入队 / 已投递 / 待投递 / 最近错误）。',
        parameters: {},
        async run(): Promise<string> {
          // ★ 读的是**运行时**而不是启动时那个后端实例：用户随时可以改连接，
          //   诊断必须回答「现在」的地址与计数，否则它回的是历史。
          return formatReporterDiagnostics(runtime)
        },
      },
    })
    return true
  } catch {
    // 宿主没有对应的注册点 → 不算错误，只是这个部署用不上工具
    return false
  }
}

/** 解析工具入参并执行查询。非法入参**返回提示文本**而不是抛错（工具不该把对话打断）。 */
async function runTool(statsContext: StatsContext, raw: Record<string, unknown>): Promise<string> {
  const query: UsageQuery = {}

  const period = typeof raw['period'] === 'string' ? raw['period'].trim() : ''
  if (period) query.period = period

  const by = typeof raw['by'] === 'string' ? raw['by'].split(',').map((s) => s.trim()).filter(Boolean) : []
  if (by.length > 0) {
    const invalid = by.filter((d) => !TOOL_DIMENSIONS.includes(d as never))
    if (invalid.length > 0) {
      return `未知维度 ${invalid.join(', ')}。可选：${TOOL_DIMENSIONS.join(' | ')}`
    }
    query.by = by as UsageQuery['by']
  }

  const top = typeof raw['top'] === 'number' ? raw['top'] : Number(raw['top'])
  if (Number.isFinite(top) && top > 0) query.top = top

  const series = typeof raw['series'] === 'string' ? raw['series'].trim() : ''
  if (series === 'day' || series === 'hour') query.series = series

  const provider = typeof raw['provider'] === 'string' ? raw['provider'].trim() : ''
  if (provider) query.provider = provider
  const model = typeof raw['model'] === 'string' ? raw['model'].trim() : ''
  if (model) query.model = model

  try {
    const result = await queryUsage(statsContext, query)
    return formatUsage(result)
  } catch (err) {
    // 统计失败（周期写错 / 目录不在）不该把对话打断，返回可读文本即可
    return `统计失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 上报链路诊断文本。
 *
 * ★ 必须如实回答「发出去了没有」：这个插件最大的失败模式不是报错，
 *   而是**静默地不上报**（凭证过期、地址改了、outbox 满）——
 *   看板上少了几个人的数据，没人会发现。
 */
function formatReporterDiagnostics(runtime: ReportRuntime<TokenReportBackend>): string {
  const lines: string[] = []
  const n = (v: number): string => v.toLocaleString('en-US')
  // ⚠️ 读**运行时当前**的配置：用户可能刚在设置页换了地址/间隔。
  const config = runtime.config()
  const status = runtime.status()

  lines.push('=== token 上报链路诊断 ===')
  lines.push(`  插件名      ${config.name}`)
  lines.push(`  上报地址    ${config.endpoint}`)
  lines.push(`  凭证        ${config.appKey ? '已配置（不回显）' : '★ 未配置 —— 上报不会启动'}`)
  lines.push(`  批量        最多 ${config.batch.maxRecords} 条 / 每 ${config.batch.flushIntervalMillis}ms`)
  lines.push(`  outbox      ${config.outbox.enabled ? config.outbox.dir ?? '默认位置' : '已关闭'}`)
  lines.push(`  运行状态    ${status.enabled ? '上报中' : `已停止（${status.reason ?? '原因未知'}）`}`)

  if (!status.enabled) {
    lines.push('')
    lines.push('★ 上报未启用（未署名或未配 appKey）。在完成配置之前，本插件不采集也不上报。')
    lines.push('  在插件设置页填好「服务端地址 + appKey」即可立即启用，无需重启 DSH。')
    return lines.join('\n')
  }

  const stats = runtime.stats()
  lines.push('')
  lines.push('=== 投递统计 ===')
  if (stats === null) {
    lines.push('  （本进程尚未创建投递单元）')
  } else {
    lines.push(`  已采集      ${n(stats.enqueued)} 条`)
    lines.push(`  已投递      ${n(stats.delivered)} 条（服务端判定重复 ${n(stats.duplicates)}，拒收 ${n(stats.rejected)}）`)
    lines.push(`  内存队列    ${n(stats.queueLength)} 条`)
    lines.push(`  磁盘待投递  ${n(stats.outbox.pendingRecords)} 条 / ${n(stats.outbox.pendingBatches)} 批`)
    lines.push(`  请求        ${n(stats.requests)} 次（失败 ${n(stats.failures)} 次）`)
    lines.push(`  最近成功    ${stats.lastSuccessAt ? new Date(stats.lastSuccessAt).toLocaleString() : '从未'}`)
    if (stats.outbox.droppedBatches > 0) {
      lines.push(`  ⚠ 因超出容量上限丢弃 ${n(stats.outbox.droppedBatches)} 批**最旧**数据`)
    }
    if (stats.lastError) {
      lines.push(`  最近错误    ${stats.lastError}`)
    }

    // 最近一次真实投递：回答「刚刚到底发了什么、服务端怎么回的」。
    // ⚠️ 只报条数与状态码 —— 请求体只在设置页的「上报调试」里展开，不进对话记录。
    const last = runtime.attempts()[0]
    if (last) {
      const verdict = last.error ?? `HTTP ${last.httpStatus ?? '无响应'}`
      lines.push(
        `  最近一次    ${new Date(last.at).toLocaleString()} → ${n(last.records)} 条，` +
          `${n(last.bytes)} 字节，${verdict}`,
      )
    }
  }

  const history = runtime.backfillStats()
  const labels: Record<BackfillStats['status'], string> = {
    idle: '等待扫描', running: '正在扫描补报', complete: '本轮已全部确认', retrying: '等待重试', stopped: '已停止',
  }
  lines.push('')
  lines.push('=== 全量历史补报 ===')
  lines.push(`  状态        ${labels[history.status]}`)
  lines.push(`  文件进度    ${n(history.filesProcessed)} / ${n(history.filesTotal)}`)
  lines.push(`  本进程确认  ${n(history.confirmed)} 条（新增 ${n(history.accepted)}，重复 ${n(history.duplicates)}）`)
  lines.push(`  最近完成    ${history.lastCompletedAt ? new Date(history.lastCompletedAt).toLocaleString() : '尚未完成'}`)
  if (history.lastError) lines.push(`  补报错误    ${history.lastError}`)
  lines.push('  扫描全部历史会话；服务器确认后保存进度，失败自动重试。')
  return lines.join('\n')
}

/**
 * 注册 `ctx.tokenReport` 服务，供其它插件取数。
 *
 * 返回值刻意是**不可变结果**而不是活的会话对象：调用方拿到的是某一刻的快照，
 * 不持有 SQLite 连接，也就不可能忘记 close（那是本仓踩过的坑，见 `db/stats.ts`）。
 */
function registerService(ctx: ApplyContext, config: EffectiveConfig, statsContext: StatsContext): boolean {
  try {
    ctx.reflect.provide(SERVICE_NAME, {
      /** 查询本机用量。 */
      query: (query: UsageQuery = {}): Promise<UsageResult> => queryUsage(statsContext, query),
      /** 查询并直接渲染成文本。 */
      format: async (query: UsageQuery = {}): Promise<string> => formatUsage(await queryUsage(statsContext, query)),
      /** 生效配置（**不含 appKey**）。 */
      config: {
        name: config.name,
        endpoint: config.endpoint,
        batch: config.batch,
        outbox: config.outbox,
        features: config.features,
      },
      /** 身份是否已就绪（不含 token）。 */
      signed: (): boolean => {
        const state = buildResolver(config).resolve()
        return state.ready
      },
    })
    return true
  } catch {
    return false
  }
}

/**
 * 插件入口对象的依赖声明。
 *
 * 🚨 **必须挂在 `default` 导出上，而不是 `TokenReportBackend` 类上。**
 *   cordis 读取的是**插件条目对象**的 `inject`，而 DSH 的 loader 加载的是
 *   本模块的 `default` 导出 —— 类根本不会被实例化（`apply()` 是被直接调用的）。
 *
 *   把 `inject` 写在类上会**静默失效**：插件照常被 import，`apply()` 也照常执行，
 *   但所有 `ctx.sessions` / `ctx.logger` 之类的依赖注入都失去了「先等依赖就绪」
 *   的保证。这是真实装载验证抓出来的问题
 *   （`verify/probe-activation.ts` 会打印 `inject = (无)` 暴露它）。
 *
 * 为什么仍然需要 `sessions`：`SessionTelemetryCoordinator` 在构造函数里会
 * `ctx.sessions.list()` 扫已经在跑的会话。依赖没就绪时那一步会抛错。
 */
export const inject = ['sessions'] as const

/** 导出给 DSH 加载的默认对象。 */
export default {
  name,
  /**
   * 依赖声明（见上方 `inject` 的注释 —— 这一行不能省）。
   *
   * ⚠️ 这里重复声明一次而不是直接引用 `inject` 常量：
   *   loader 拿到的必须是**可序列化/可枚举的数组**，`as const` 的只读元组
   *   在某些加载路径上会被判成非数组。显式写一份普通数组最稳。
   */
  inject: ['sessions'],
  /** DSH 会在 apply 阶段调用。 */
  apply(ctx: ApplyContext, config: Config = {}) {
    const { status } = apply(ctx, config)
    // 上报未启用的原因必须在启动时讲清楚，否则用户只会看到「看板上没我的数据」
    if (!status.reportingEnabled) {
      const resolver = buildResolver(resolveConfig(config))
      const text = describeDisabled(status, resolver)
      if (text) ctx.logger.warn(text)
    }
  },
}

export { IdentityResolver, type IdentityState } from './identity.js'
export type { EffectiveConfig, RawConfig } from './config.js'
export { resolveConfig, DEFAULT_ENDPOINT, ENV } from './config.js'
export { foldRecord, toWireRecord, toTokenUsage, type BillingRecord, type FoldIdentity } from './fold.js'
export { Outbox, type OutboxStats } from './outbox.js'
export { Reporter, resolveOutboxDir, type ReporterStats } from './reporter.js'
export { queryUsage, formatUsage, TOOL_DIMENSIONS, type UsageQuery, type UsageResult } from './stats.js'
export {
  installUiRoute,
  createUiStatsProvider,
  makeStatsFetch,
  makeConfigFetch,
  seriesFor,
  toUiPayload,
  type UiHostContext,
  type UiStatsProvider,
} from './ui-bridge.js'
export {
  UI_CONFIG_PATH,
  UI_STATS_PATH,
  UI_SETTINGS_PATH,
  UI_REPORTS_PATH,
  UI_PERIODS,
  UI_POSITIONS,
  UI_DEFAULT_POSITION,
  coercePeriod,
  parseUiPosition,
  readUiConfig,
  readUiResponse,
  readUiReporting,
  readUiSettings,
  readUiReports,
  readUiReportAction,
  type UiConfigPayload,
  type UiPayload,
  type UiPeriod,
  type UiPosition,
  type UiReportAction,
  type UiReportActionResult,
  type UiReportingStatus,
  type UiReportsPayload,
  type UiRouteInstall,
  type UiSettingsPayload,
  type UiSettingsSavePayload,
} from './client/protocol.js'
export {
  ReportRuntime,
  foldIdentityOf,
  unitKey,
  type BackendRefs,
  type ReportBackendLike,
  type ReportingStatus,
} from './runtime.js'
export { ReportLog, REPORT_LOG_LIMITS, type ReportAttempt } from './report-log.js'
export { createReportsHandler, toReportsPayload, type ReportsHost } from './reports.js'
export {
  createSettingsHandler,
  readConnection,
  parseFlushInterval,
  MIN_FLUSH_INTERVAL_MILLIS,
  MAX_FLUSH_INTERVAL_MILLIS,
  type SettingsHost,
  type SettingsState,
} from './settings.js'
export { isSigned } from '@ai-token-report/shared'
