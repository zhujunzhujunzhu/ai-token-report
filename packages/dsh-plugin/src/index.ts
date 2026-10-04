/**
 * AI token 上报插件 —— 团队统一铺开的入口。
 *
 * ## 一句话职责
 *
 * 装在 DSH 里，**无人值守地**把本机产生的计费级 token 用量实时上报到部门服务端，
 * 同时给同事一个「问一句就能看到自己用量」的工具。
 *
 * ## 三种形态，一份内核
 *
 * ```
 * ① 实时上报   订阅宿主 session/event → 账本记录 → 入队   ← 会话进行中，秒级
 * ② 统计工具   token_usage（Agent 可调用）             ← "我今天用了多少 token"
 * ③ 统计服务   ctx.tokenReport（其它插件可调用）
 * ```
 *
 * ②③ 与 CLI `ai-token`、本地页面走的是**同一套聚合与同一套口径**，
 * 所以「工具报的数」与「页面上的数」必然一致（`ARCHITECTURE.md` §3）。
 *
 * ## 挂载点：宿主会话事件流（★ **不占 `sessionTelemetry` 服务**）
 *
 * ```
 * session/event（宿主同步热路径）
 *       ↓  ctx.on(...)                                   ← capture.ts
 * 账本记录（只搬形状）→ foldRecord() 决定这条算不算计费 → 入队
 *       ↓
 * 内存队列 → 批量 → 磁盘 outbox → HTTP POST → 部门服务端
 * ```
 *
 * ★ **刻意不注册 `sessionTelemetry`**：那个服务名一个进程只能注册一次，而官方
 *   `dsh-session-telemetry-otel` 永远占着它（连它的 `mode: DISABLED` 都照样占名）。
 *   0.8.x 及更早的实现把自己注册成第二个后端，于是**装了本插件就必须手工停用官方
 *   OTel** —— 否则部署配置里一带 appKey，DSH 启动即失败，日志只有一行
 *   `service "sessionTelemetry" has been registered at <…>`。
 *   现在两边可以同时开着、互不干扰：原因与三条实测证据见 `capture.ts` 的文件头。
 *
 * ## 三个硬约束（违反即事故）
 *
 * 1. 🚨 **`emit()` 在热路径同步执行，只能入队**。
 *    任何 `await fetch` 都会拖慢 agent loop —— 用户会直接感觉到卡顿。
 * 2. 🚨 **投递是 best-effort**：游标记的是「已交出」不是「已送达」
 *    → 必须自建磁盘 outbox（`outbox.ts`），否则崩溃会丢数据。
 * 3. 🚨 **「只取计费字段」是 `foldRecord()` 的责任**：宿主交过来的 `event.data`
 *    可能带文件内容与命令输出。本插件**不再改写宿主的脱敏瀑布**（改了就等于修改
 *    官方后端收到的内容），改为在折叠时按**白名单**取值 —— 落盘与外发的只有计费字段。
 *
 * ## 未署名 / 未配凭证 = 不采集也不上报
 *
 * ★ 这是合规底线。判定在 `evaluateStatus()` 这个纯函数里，测试钉死在
 *   `test/status.test.ts` —— 判错了就是「偷偷上报」或「永远不上报」。
 *   宁可数据缺失（看板上能看到缺口），也不要未授权采集。
 */

import { installCapture, type CaptureHost } from './capture.js'
import type { TelemetryRecord } from './fold.js'

import {
  canReport,
  resolveConfig,
  validateConfig,
  type EffectiveConfig,
  type RawConfig,
} from './config.js'
import { IdentityResolver, type IdentityState } from './identity.js'
import { reportPaths } from './paths.js'
import { resolveStatsSourceRoots, statsSourceIds } from './extra-sources.js'
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
 * 捕获侧对外的契约形状 —— `ReportRuntime` 与测试都只依赖这三个动作。
 */
export interface BackendPort {
  emit(record: TelemetryRecord): void
  flush(): void
  shutdown(): Promise<void>
}

/**
 * 本插件真正依赖的宿主能力（捕获用三条 + 装配期日志）。
 *
 * 刻意**收窄**而不是直接写 cordis 的 `Context`：这样「插件依赖了什么」
 * 在类型上一眼可见，而测试也能传一个几行的假 ctx 而不必搭起整个 cordis 运行时。
 * 真实的 cordis Context 结构上满足这个接口（见 `capture.ts` 的 `CaptureHost`）。
 */
export interface BackendContext extends CaptureHost {
  /**
   * 装配期还要 info 级日志（捕获侧只用得上 warn）。
   *
   * ⚠️ 必须与 `UiHostContext.logger` **逐字同型**，而不是「可赋值即可」：
   *   `ApplyContext` 同时 extends 这两个接口，TS 要求同名属性在多个基接口里
   *   **完全一致**；写成交叉类型（`{warn} & {info}`）会让整个接口无法继承
   *   （TS2320，报错文案只说「不是 identical」，不提是交叉类型惹的）。
   */
  logger: { info(message: string): void; warn(message: string): void }
}

/**
 * 上报捕获侧 —— **薄适配器**。
 *
 * 它只做两件事：把宿主会话事件流接到运行时给的闭包上（`installCapture`），
 * 以及暴露两个诊断入口。「往哪发、以谁的名义、多久发一次」全都在 `ReportRuntime` 里，
 * 可以被就地替换（设置页保存后立刻生效，不必重启 DSH）。
 *
 * ★ **它不是 cordis 服务**：不注册 `sessionTelemetry`，所以与官方 OTel 后端并存
 *   （理由与三条实测证据见 `capture.ts` 的文件头）。0.8.x 及更早的实现继承
 *   `SessionTelemetryBackend` —— 那既让它与官方后端互斥，又要求它整天提防
 *   「服务代理穿不过私有字段」那个坑；两条约束随这次改造一起消失。
 *
 * `emit()` 链路上只有一次纯函数折叠 + 一次数组 push —— 这是本类最重要的性质，
 * 任何改动都要重新确认它没有引入 IO。
 */
export class TokenReportCapture implements BackendPort {
  /**
   * 部署选定的共享模式，**不是**投递回执。
   *
   * `full` 表示「本部署全量共享会话遥测」—— 团队统一安装、员工已知情的前提下
   * 才应写这个值。合规评审会问到这里，改它之前先在内部文档里说清楚。
   */
  readonly sharing = 'full' as const

  /**
   * 诊断入口（浏览器半的 `GET /api/tokenReport.stats` 与 `token_usage_diagnostics` 都读它）。
   *
   * ⚠️ 0.8.x 时这里写着另一段话：本类当时是 cordis 服务，`ctx.get('sessionTelemetry')`
   *   返回**服务代理**，而 JS 私有字段穿不过 Proxy —— 代理上每一次会话事件都会抛
   *   `Cannot access invalid private field`，且单测全绿、只有真实装载才暴露。
   *   **那个坑随「不再注册服务」一起消失**；注释留在这里是为了让后来者知道
   *   「为什么以前必须这么写」，而不是以为这里仍有坑要绕。
   */
  readonly reporterStats: (() => ReporterStats) & ReporterStats

  /** 历史补报独立于实时队列（闭包入口，无 `this` 依赖）。 */
  readonly backfillStats: () => BackfillStats

  /**
   * 热路径接收器：由运行时给的闭包（折叠 + 入队到**当前**投递单元）。
   *
   * ★ 闭包实现没有任何 `this` 依赖 —— 它**顺带保证了热路径不做 IO**
   *   （闭包体只碰内存数组）。
   */
  readonly sink: BackendRefs

  /**
   * @param ctx - DSH 的插件上下文（结构上满足 `BackendContext`）。
   * @param refs - 运行时给的闭包组（热路径 + 诊断入口）。
   */
  constructor(ctx: BackendContext, refs: BackendRefs) {
    this.sink = refs
    this.reporterStats = refs.reporterStats
    this.backfillStats = refs.backfillStats
    // 捕获侧只调 `this.emit` / `this.flush` —— 与测试、诊断走**同一条**路径，
    // 不给「测试里走捷径、生产里走另一条」留空间。
    installCapture(ctx, this)
  }

  /**
   * 🚨 同步热路径：只做折叠 + 入队（宿主每一条会话事件都会走到这里）。
   *
   * 由 `installCapture()` 在宿主 `session/event` 上调用；测试与诊断也用同一个入口，
   * 所以「单测里绿」与「真实装载里绿」说的是同一件事。
   */
  emit(record: TelemetryRecord): void {
    this.sink.emit(record)
  }

  /** turn 结束的冲刷提示（fire-and-forget，不阻塞调用方）。 */
  flush(): void {
    this.sink.flush()
  }

  /** 排空并停止（插件卸载时调用；抛错只被捕获侧记一条 warning，不阻断退出）。 */
  async shutdown(): Promise<void> {
    await this.sink.shutdown()
  }
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
): { status: PluginStatus; backend: TokenReportCapture | null } {
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

  // ── ① 上报运行时 ──────────────────────────────────────────────────
  //
  // ★ 与旧实现的关键差别：上报后端不再由配置**一次性**钉死。
  //   设置页保存完连接后调 `runtime.refresh()`，运行时就地换一个「投递单元」
  //   （新 endpoint / 新 appKey / 新间隔），用户不必重启 DSH。
  //   合规底线那一步仍然只在 `runtime.applyState()` 里（同一个 `evaluateStatus`）。
  //
  // ⚠️ 顺序：运行时**先**建，统计上下文跟着它取值 —— 面板里可以把「会话日志根」
  //   改掉，改完必须在同一个进程里立刻按新根取数（见 `buildStatsContext`）。
  const runtime = new ReportRuntime<TokenReportCapture>(
    {
      logger: {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message),
      },
      // ⚠️ 传**原始**配置而不是 merged：运行时自己每次现读磁盘上的已保存连接，
      //   否则保存完再 refresh 会拿着旧快照覆盖新值。
      raw: rawConfig,
      resolver,
      createBackend: (refs: BackendRefs) => new TokenReportCapture(ctx, refs),
    },
    config,
  )

  const statsContext = buildStatsContext(() => runtime.config())
  ctx.effect(() => () => { void closeStatsWorker(statsContext.dbPath) })

  let backend: TokenReportCapture | null = null
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
          saved: readConnection(runtime.config()),
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

/**
 * 统计上下文：**活取值**的三个路径 + 功能开关。
 *
 * ⚠️ 会话日志根与数据目录都只经 `reportPaths()` 取（见 `paths.ts`）：
 *   在这里手抄 `config.dshHome` 会漏掉 `dataDir`，而漏掉不会报错 ——
 *   只会让「界面上的数」与「上报的数」来自两个不同的目录。
 *
 * ★ 三个路径刻意做成 **getter**（每次取用时现算），不是启动那一刻的快照：
 *   面板里改完「会话日志根」，同一个进程里的面板、`token_usage` 工具与
 *   `ctx.tokenReport` 服务都必须立刻按新根取数（上报侧的补报线程由
 *   `ReportRuntime` 重建，判据是 `unitKey` 里的 `dshHomes`）。
 *   写成快照的话，保存成功、日志也打了，但面板数字仍然是旧范围的 —— 且不报错。
 *
 * @param read - 取**当前**生效配置（组合根传 `() => runtime.config()`）。
 */
function buildStatsContext(read: () => EffectiveConfig): StatsContext {
  // 同一份配置对象在多次取用之间复用一次路径解析：`reportPaths()` 会做
  // 自动发现（若干次 readdir/existsSync），而一次查询要读三个字段。
  let cachedFor: EffectiveConfig | undefined
  let cachedPaths: ReturnType<typeof reportPaths> | undefined
  const paths = (): ReturnType<typeof reportPaths> => {
    const config = read()
    if (cachedPaths === undefined || cachedFor !== config) {
      cachedFor = config
      cachedPaths = reportPaths(config)
    }
    return cachedPaths
  }
  return {
    get config() { return { localDb: read().localDb } },
    get sessionsRoots() { return paths().sessionsRoots },
    get dbPath() { return paths().dbPath },
    // 单价快照（`pricing.json`）就在数据目录里：金额是**本机**的估算，
    // 所以「按哪份价算的」这件事必须跟着数据目录一起传下去。
    get dataDir() { return paths().dataDir },
    // ★ 多客户端来源：**全部已注册来源**，没有白名单可配（见 `extra-sources.ts`）。
    //   活取值 —— 会话日志根一改，下一次取数就按新的一组根走。
    get sourceRoots() { return resolveStatsSourceRoots(paths().dshHomes).roots },
    // ★ 与 `sourceRoots` 成对：根管「本次 ingest 谁」，这份清单管「本次算谁」。
    //   缺了它，库里别的来源的行（CLI 入的）会被当成面板自己的数字 —— 见 `extra-sources.ts`。
    get sources() { return statsSourceIds() },
    get missingRoots() {
      // 「那个客户端没装」与「路径写错了」必须能分辨，所以缺失的根单独报出来。
      return resolveStatsSourceRoots(paths().dshHomes).missing.map((root) => root.path)
    },
    backgroundQueries: true,
  }
}

/**
 * 用生效配置构造身份解析器。
 *
 * 单独一个函数是为了让「生效配置 → 解析器」这层映射只有一处 ——
 * 之前它在 `apply` / `default.apply` / 服务里各写了一遍，
 * 三处只要有一处漏掉 `dshHome`（今天是 `dataDir`），就会出现
 * 「同一个配置、两个不同身份文件」的怪事。
 */
function buildResolver(config: EffectiveConfig): IdentityResolver {
  return new IdentityResolver({
    ...(config.dshHome ? { dshHome: config.dshHome } : {}),
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
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
  runtime: ReportRuntime<TokenReportCapture>,
): boolean {
  try {
    ctx.reflect.provide('tokenReportTools', {
      [TOOL_NAME]: {
        description:
          '统计本机 AI token 用量（计费级，来自 provider 真实上报值）。' +
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
function formatReporterDiagnostics(runtime: ReportRuntime<TokenReportCapture>): string {
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
  // ★ 两个目录必须分开报：DSH Desktop 的 home 与命令行版 DSH 不同，
  //   「我的身份 / 本地库到底落在哪」只能靠这两行回答（见 `paths.ts`）。
  const paths = reportPaths(config)
  // ★ 多套 DSH 并存时日志根是**一组**：只报第一个根会让人以为「另一个 home 没被统计」，
  //   而这恰恰是本插件最需要说清的一件事（界面数字来自哪里）。
  if (paths.sessionsRoots.length > 1) {
    lines.push(`  会话日志根  ${paths.sessionsRoots.length} 个 DSH home：`)
    for (const root of paths.sessionsRoots) lines.push(`              ${root}`)
  } else {
    lines.push(`  会话日志根  ${paths.sessionsRoot}`)
  }
  lines.push(`  数据目录    ${paths.dataDir}${config.dataDir ? '（dataDir 显式配置）' : ''}`)
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
 * 🚨 **必须挂在 `default` 导出上，而不是 `TokenReportCapture` 类上。**
 *   cordis 读取的是**插件条目对象**的 `inject`，而 DSH 的 loader 加载的是
 *   本模块的 `default` 导出 —— 类根本不会被实例化（`apply()` 是被直接调用的）。
 *
 *   把 `inject` 写在类上会**静默失效**：插件照常被 import，`apply()` 也照常执行，
 *   但所有 `ctx.logger` 之类的依赖注入都失去了「先等依赖就绪」的保证。
 *   这是真实装载验证抓出来的问题
 *   （`verify/probe-activation.ts` 会打印 `inject = (无)` 暴露它）。
 *
 * 为什么仍然需要 `sessions`：本插件的输入**就是**会话事件流
 * （`session/event` / `session/flush`，见 `capture.ts`），而发出它们的是会话服务 ——
 * 声明它 = 让「会话服务就绪之后才开始捕获」成为 loader 的保证，而不是靠运气。
 *
 * ⚠️ 0.8.x 时这里的理由是另一件事：当时照抄官方写法，用 `SessionTelemetryCoordinator`
 *   在构造期 `ctx.sessions.list()` 回放**已经在跑的会话**。那段回放已经去掉
 *   （历史由磁盘补报线程全量覆盖），所以这条声明现在是**次序保证** ——
 *   如果哪一天确认连次序都不需要，应当连同这一行一起删，而不是留着当装饰。
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
export { foldRecord, toWireRecord, toTokenUsage, type BillingRecord, type FoldIdentity, type TelemetryRecord } from './fold.js'
export { installCapture, ledgerRecordOf, type CaptureHost, type HostSession, type HostSessionEvent } from './capture.js'
export { Outbox, type OutboxStats } from './outbox.js'
export { Reporter, resolveOutboxDir, type ReporterStats } from './reporter.js'
export {
  reportPaths,
  reportOutboxDir,
  reportBackfillDir,
  type PathConfig,
  type PathInput,
} from './paths.js'
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
  parseDshHomes,
  dshHomesSourceOf,
  MAX_DSH_HOMES,
  MIN_FLUSH_INTERVAL_MILLIS,
  MAX_FLUSH_INTERVAL_MILLIS,
  type DshHomesSource,
  type SettingsHost,
  type SettingsState,
} from './settings.js'
export { isSigned } from '@ai-token-report/shared'
