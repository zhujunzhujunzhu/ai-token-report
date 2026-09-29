/**
 * 上报运行时 —— 让「配置保存」**就地生效**，不必重启 DSH。
 *
 * ## 为什么需要这一层
 *
 * 旧实现把上报后端的生命周期钉死在 `apply()` 上：
 *
 * ```
 * apply() → 读配置 + 读身份 → 建 Reporter + 补报线程 → 注册 sessionTelemetry
 * ```
 *
 * 于是设置页保存完连接只能提示「请重启 DSH 后启用新的上报连接」——
 * 而用户真正想做的事是「填完就能开始上报」。重启 DSH 意味着丢掉正在跑的会话，
 * 而这一步在旧实现里没有任何技术必要性：变的只是「往哪发、以谁的名义、多久发一次」。
 *
 * ## 结构：后端不变，投递单元可换
 *
 * ```
 * SessionTelemetryCoordinator（只装配一次，挂在 sessionTelemetry 服务上）
 *        │  emit / flush / shutdown
 *        ▼
 * TokenReportBackend（薄适配器，只读自有属性）
 *        │  转发到下面这组闭包
 *        ▼
 * ReportRuntime  ──►  Unit{ Reporter, Backfill, foldIdentity }   ← 可整体替换
 * ```
 *
 * ★ **后端只装一次**是刻意的：`SessionTelemetryCoordinator` 在构造时会把
 *   `session/created` / `session/event` / `session/disposed` 与 `agent/error`
 *   注册到宿主 fiber 上，而这些注册**不随服务注销而撤销**。
 *   每改一次配置就重建一个后端，等于让每个会话事件被折叠 N 次 ——
 *   服务端虽然按 `event_id` 去重（数字不会错），但宿主会白烧 CPU，
 *   而且这种「重了一倍」的症状在页面上完全看不出来。
 *
 * ★ **单元可换**是因为它只持有「往哪发、以谁的名义、多久发一次」：
 *   这些正是设置页会改的东西。换单元 = 起一个新的 Reporter + 补报线程，
 *   旧单元在**后台**排空（不阻塞保存响应）。
 *
 * ## 合规底线（不要放宽）
 *
 * `evaluateStatus()` 的判定仍然只在这里：**未署名 / 未配 appKey → 不建后端、
 * 不装 coordinator、一个字节都不采集**。就地启用同样先过这一关。
 */

import { resolvePaths } from '@ai-token-report/core'
import { toAssertion, type Identity } from '@ai-token-report/shared'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

import {
  claimedUserId,
  resolveConfig,
  type EffectiveConfig,
  type RawConfig,
} from './config.js'
import type { IdentityResolver, IdentityState } from './identity.js'
import { foldRecord, type FoldIdentity } from './fold.js'
import {
  createHistoryBackfill,
  type HistoryBackfill,
} from './backfill.js'
import { emptyBackfillStats, type BackfillStats } from './backfill-runner.js'
import {
  makeReporterStatsView,
  Reporter,
  type ReporterPreview,
  type ReporterStats,
} from './reporter.js'
import type { OutboxStats } from './outbox.js'
import { ReportLog, type ReportAttempt, type ReportLogOptions } from './report-log.js'
import { withSavedConnection } from './settings.js'
import type { UiReportingStatus, UiRouteInstall } from './client/protocol.js'

/** 上报是否在跑 + 为什么没跑。宿主半与浏览器半共用同一形状。 */
export type ReportingStatus = UiReportingStatus

/** 插件运行时状态 —— 暴露出来便于诊断。 */
export interface PluginStatus {
  identityReady: boolean
  identityReason?: string
  /** 上报是否已启用（需要「已署名」且「配了 appKey/endpoint」） */
  reportingEnabled: boolean
  /** 未启用上报的原因，用于给出可操作的提示 */
  disabledReason?: string
  /** 工具是否注册成功。 */
  toolsRegistered: boolean
  /** 服务是否注册成功。 */
  serviceRegistered: boolean
  /**
   * UI 数据通道（`/api/tokenReport.stats`）的落点。
   *
   * 由**宿主能力**决定（有没有 `connection` 服务），不是配置或身份决定的，
   * 所以不参与 `evaluateStatus()` 的判定，只在 `apply()` 里填。
   * `undefined` 表示 `features.ui` 被关掉了。
   */
  uiRoute?: UiRouteInstall
}

/**
 * 决定插件是否应该启动上报。
 *
 * 抽成纯函数便于测试 —— 这里的判断错了会导致
 * 「偷偷上报」（合规事故）或「永远不上报」（数据缺失）两种极端。
 */
export function evaluateStatus(identity: IdentityState, config: EffectiveConfig): PluginStatus {
  const base = { toolsRegistered: false, serviceRegistered: false }

  if (!config.features.reporting) {
    return {
      ...base,
      identityReady: identity.ready,
      reportingEnabled: false,
      disabledReason: '上报已在配置中关闭（features.reporting = false）',
    }
  }

  if (!identity.ready) {
    return {
      ...base,
      identityReady: false,
      identityReason: identity.reason,
      reportingEnabled: false,
      disabledReason: '尚未署名',
    }
  }

  if (!config.appKey) {
    return {
      ...base,
      identityReady: true,
      reportingEnabled: false,
      disabledReason: '未配置上报凭证（config.appKey）',
    }
  }

  if (!config.endpoint) {
    return {
      ...base,
      identityReady: true,
      reportingEnabled: false,
      disabledReason: '未配置上报地址（config.endpoint）',
    }
  }

  return { ...base, identityReady: true, reportingEnabled: true }
}

/** 由生效配置与身份派生折叠身份。三处调用点共用，避免各处漏字段。 */
export function foldIdentityOf(config: EffectiveConfig, identity: Identity): FoldIdentity {
  const assertion = toAssertion(identity)
  return {
    clientName: config.name,
    // ⚠️ 服务端会忽略这个自称值，身份以 appKey 解析结果为准
    claimedUserId: claimedUserId(config, identity),
    userName: assertion.name,
    // ⚠️ 分组走 `toAssertion()`：它已经处理了旧文件的 `dept` 兼容
    ...(assertion.group ? { group: assertion.group } : {}),
  }
}

/**
 * 后端需要向运行时索要的那几样东西。
 *
 * 🚨 全部是**闭包**，没有 `this`：后端实例会被 cordis 包成服务代理，
 *   私有字段与 `this` 都可能失效（见 `README.md` §8 与 `verify-cordis-load.ts`）。
 */
export interface BackendRefs {
  /** 热路径：折叠 + 入队（当前单元）。 */
  emit(record: SessionTelemetryRecord): void
  /** turn 结束的冲刷提示。 */
  flush(): void
  /** 插件卸载时排空当前单元。 */
  shutdown(): Promise<void>
  /** 可经服务代理安全读取的统计入口。 */
  reporterStats: (() => ReporterStats) & ReporterStats
  /** 历史补报统计（无单元时为零值）。 */
  backfillStats(): BackfillStats
}

/** 运行时要求后端提供的最小形状。 */
export interface ReportBackendLike {
  reporterStats: (() => ReporterStats) & ReporterStats
  backfillStats(): BackfillStats
  shutdown(): Promise<void>
}

/** 一个「投递单元」：往哪发、以谁的名义、多久发一次。 */
interface Unit {
  /** 连接指纹 —— 要素变了才值得重建。 */
  key: string
  config: EffectiveConfig
  foldIdentity: FoldIdentity
  reporter: Reporter
  backfill: HistoryBackfill
  stop(): Promise<void>
}

export interface ReportRuntimeOptions<B extends ReportBackendLike = ReportBackendLike> {
  logger: { info(message: string): void; warn(message: string): void }
  /** 插件原始配置（未经保存连接覆盖）。 */
  raw: RawConfig
  resolver: IdentityResolver
  /** 构造上报后端；由 `index.ts` 注入，避免与 cordis 服务定义形成循环依赖。 */
  createBackend(refs: BackendRefs): B
  /** 注入用，便于测试。 */
  fetchImpl?: typeof fetch
  /** 注入用：替换真实的后台补报线程。 */
  createBackfill?: typeof createHistoryBackfill
  /** 上报实录的上限（调试页用，见 `report-log.ts`）。 */
  reportLog?: ReportLogOptions
}

/**
 * 连接指纹。
 *
 * ★ 刻意把**所有会影响投递内容的要素**都放进来：
 *   漏掉任何一个都会让「改了配置但还在按旧值发」变成一个静默 bug。
 */
export function unitKey(config: EffectiveConfig, identity: Identity): string {
  const assertion = toAssertion(identity)
  return JSON.stringify([
    config.endpoint,
    config.appKey,
    config.name,
    config.dshHome ?? '',
    config.batch.maxRecords,
    config.batch.timeoutMillis,
    config.outbox.enabled,
    config.outbox.dir ?? '',
    config.outbox.maxBytes,
    assertion.name,
    assertion.group ?? '',
    identity.token,
  ])
}

/**
 * 上报运行时。
 *
 * 生命周期：构造 → `start()`（启动时若满足条件）→ `refresh()`（保存配置后）
 * → `shutdown()`（插件卸载）。
 */
export class ReportRuntime<B extends ReportBackendLike = ReportBackendLike> {
  readonly #logger: { info(message: string): void; warn(message: string): void }
  readonly #raw: RawConfig
  readonly #resolver: IdentityResolver
  readonly #createBackend: (refs: BackendRefs) => B
  readonly #fetchImpl: typeof fetch | undefined
  readonly #createBackfill: typeof createHistoryBackfill
  readonly #refs: BackendRefs
  /** 上报实录：投递出口留一份「刚刚发了什么」，调试页读它。 */
  readonly #log: ReportLog

  #backend: B | null = null
  #unit: Unit | null = null
  /**
   * 本进程折叠出的计费记录数 —— **单调递增，跨投递单元不重置**。
   *
   * ★ 这是浏览器半做「数据代次探针」用的计数（见 `client/store.ts`）：
   *   它每 3 秒问一次「代次变了没」，所以取它必须是**纯内存读**，
   *   不能顺带扫 outbox 目录（`reporter.stats` 的完整快照会扫）。
   *   换连接时也不能倒退 —— 那会让探针白跑一轮（虽然不会出错）。
   */
  #collected = 0
  /** 停机/停用后仍留给诊断的补报快照 —— 「已停止」本身就是用户要看到的事实。 */
  #stoppedBackfill: BackfillStats | null = null
  /**
   * 停机/停用后的**投递统计快照**。
   *
   * ★ 为什么不能直接归零：卸载与「停用」之后，调试页与诊断仍要回答
   *   「一共送出去多少条」—— 那是用户排查「部门看板上没有我的数」时唯一的线索。
   *   归零会把「已经成功投递 3 条」显示成「一条都没送出去」，
   *   正好把人引向相反的结论。
   */
  #stoppedStats: ReporterStats | null = null
  #config: EffectiveConfig
  #status: ReportingStatus

  constructor(options: ReportRuntimeOptions<B>, initial: EffectiveConfig) {
    this.#logger = options.logger
    this.#raw = options.raw
    this.#resolver = options.resolver
    this.#createBackend = options.createBackend
    this.#fetchImpl = options.fetchImpl
    this.#createBackfill = options.createBackfill ?? createHistoryBackfill
    this.#log = new ReportLog(options.reportLog ?? {})
    this.#config = initial
    this.#status = { enabled: false, endpoint: initial.endpoint, reason: '尚未启用' }

    // 闭包捕获真实的 this：后端经 cordis 代理调用时也不会碰到私有字段。
    this.#refs = {
      emit: (record) => {
        const unit = this.#unit
        // 🚨 热路径：只有一次纯函数折叠 + 一次数组 push，没有任何 IO。
        if (unit === null) return
        const billing = foldRecord(record, unit.foldIdentity)
        if (billing === null) return
        this.#collected += 1
        unit.reporter.enqueue(billing)
      },
      flush: () => { this.#unit?.reporter.hintFlush() },
      shutdown: () => this.shutdown(),
      reporterStats: makeReporterStatsView(() => this.#unit?.reporter.stats() ?? this.#stoppedStats),
      backfillStats: () => this.backfillStats(),
    }
  }

  /** 当前生效配置（含已保存的连接）。 */
  config(): EffectiveConfig {
    return this.#config
  }

  /** 后端实例（P1 起由运行时持有，只装一次）。 */
  get backend(): B | null {
    return this.#backend
  }

  /** 最近的上报实录，**新的在前**（调试页 / 诊断用）。 */
  attempts(): ReportAttempt[] {
    return this.#log.list()
  }

  /** 当前署名（服务端认下的那个），未签署为 `null`。 */
  identity(): { name: string; group?: string } | null {
    const state = this.#resolver.resolve()
    if (!state.ready) return null
    // ⚠️ 走 `toAssertion()` 而不是直接读 `dept`：新文件写的是 `group`，
    //   旧文件才是 `dept`，兼容规则只该有一处（在 shared 里）。
    return {
      name: state.assertion.name,
      ...(state.assertion.group ? { group: state.assertion.group } : {}),
    }
  }

  /** 上报此刻是否在跑。 */
  status(): ReportingStatus {
    return { ...this.#status }
  }

  /** 是否已装配后端（诊断用：说明 coordinator 有没有挂上）。 */
  get attached(): boolean {
    return this.#backend !== null
  }

  /**
   * 启动时装配。
   *
   * @returns 后端实例；**不满足上报条件时为 `null`**（那时连 coordinator 都不装）。
   */
  start(config: EffectiveConfig, identity: Identity): B | null {
    this.applyState(config, { ready: true, identity, assertion: toAssertion(identity) })
    return this.#backend
  }

  /**
   * 重新读取「已保存的连接 + 身份文件」并**就地生效**。
   *
   * 这是设置页保存后的入口：不再需要「请重启 DSH」。
   */
  async refresh(): Promise<ReportingStatus> {
    const merged = withSavedConnection(this.#raw)
    const config = resolveConfig(merged)
    return this.applyState(config, this.#resolver.resolve())
  }

  /**
   * 把一份「配置 + 身份」应用到运行时。
   *
   * 判定顺序与启动时完全一致（同一个 `evaluateStatus`）——
   * 就地启用不能绕过合规底线。
   */
  applyState(config: EffectiveConfig, state: IdentityState): ReportingStatus {
    this.#config = config
    const decision = evaluateStatus(state, config)

    if (!decision.reportingEnabled || !state.ready) {
      const reason = decision.disabledReason ?? '尚未署名'
      const current = this.#unit
      this.#unit = null
      if (current) {
        this.#stoppedBackfill = current.backfill.stats()
        this.#stoppedStats = current.reporter.stats()
        void current.stop().then(() => {
          this.#stoppedBackfill = current.backfill.stats()
          this.#stoppedStats = current.reporter.stats()
        }).catch(() => {})
        this.#logger.info(`token-report: 上报已停止（${reason}）`)
      }
      this.#status = { enabled: false, endpoint: config.endpoint, reason }
      return this.status()
    }

    // ★ 后端只装一次：coordinator 的监听器不随服务注销撤销（见文件头）。
    if (this.#backend === null) this.#backend = this.#createBackend(this.#refs)

    const key = unitKey(config, state.identity)
    const current = this.#unit
    if (current !== null && current.key === key) {
      // 连接没变 → 只可能是间隔变了；**不重建**，免得丢掉内存队列里还没落盘的记录
      if (current.reporter.setFlushInterval(config.batch.flushIntervalMillis)) {
        this.#logger.info(`token-report: 上报间隔已更新为 ${config.batch.flushIntervalMillis}ms`)
      }
      this.#status = { enabled: true, endpoint: config.endpoint }
      return this.status()
    }

    this.#unit = this.#install(config, state.identity, key)
    if (current !== null) {
      // ⚠️ 旧单元在**后台**排空：它的 endpoint 可能已经不可达，
      //   让用户在设置页上等一次网络超时是不可接受的。
      //   已经写进 outbox 的批次会由新单元按新地址重发（服务端按 event_id 幂等）。
      void current.stop().catch(() => {})
      this.#logger.info(`token-report: 上报连接已切换 → ${config.endpoint}（身份 ${state.identity.name}）`)
    } else {
      this.#logger.info(
        `token-report: 已启用实时上报 → ${config.endpoint}` +
          `（身份 ${state.identity.name}，插件名 ${config.name}）`,
      )
    }
    this.#status = { enabled: true, endpoint: config.endpoint }
    return this.status()
  }

  /** 数据代次（**纯内存读**，探针每 3 秒问一次，不能有 IO）。 */
  enqueued(): number {
    return this.#collected
  }

  stats(): ReporterStats | null {
    return this.#unit?.reporter.stats() ?? this.#stoppedStats
  }

  backfillStats(): BackfillStats {
    return this.#unit?.backfill.stats() ?? this.#stoppedBackfill ?? emptyBackfillStats()
  }

  /** 立即冲刷一次（设置页「立即上报」）。 */
  async flush(): Promise<void> {
    await this.#unit?.reporter.flush()
  }

  /** 预览下一批请求体（**不发送**）。 */
  preview(): ReporterPreview {
    const unit = this.#unit
    if (unit === null) {
      return { ok: false, reason: this.#status.reason ?? '上报未启用' }
    }
    return unit.reporter.preview()
  }

  /** 当前单元的 outbox 统计（停机后给最后一次快照，从未启用才给零值）。 */
  outbox(): OutboxStats {
    return this.#unit?.reporter.stats.outbox ?? this.#stoppedStats?.outbox ?? {
      pendingBatches: 0, pendingRecords: 0, pendingBytes: 0, droppedBatches: 0,
    }
  }

  /**
   * 排空并停止（插件卸载 / coordinator 注销时调用）。
   *
   * ⚠️ 与 `applyState` 的停用路径不同：这里**等待**排空，因为进程可能马上退出。
   */
  async shutdown(): Promise<void> {
    const unit = this.#unit
    this.#unit = null
    this.#status = { enabled: false, endpoint: this.#config.endpoint, reason: '已停机' }
    if (unit) {
      await unit.stop()
      // ★ 停机之后仍要能回答「补报停在哪一步」与「送出去多少条」：
      //   诊断面读的就是这两个快照。
      this.#stoppedBackfill = unit.backfill.stats()
      this.#stoppedStats = unit.reporter.stats()
    }
  }

  /** 建一个投递单元并启动它。 */
  #install(config: EffectiveConfig, identity: Identity, key: string): Unit {
    const foldIdentity = foldIdentityOf(config, identity)
    const log = (level: 'info' | 'warn', message: string): void => {
      if (level === 'warn') this.#logger.warn(message)
      else this.#logger.info(message)
    }
    const reporter = new Reporter({
      config,
      identity: foldIdentity,
      onLog: log,
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      // ★ 每一次投递尝试都留一份实录 —— 设置页的「上报调试」靠它回答
      //   「到底发出去了什么」，而不是只说「已启用」。
      onReport: (attempt) => this.#log.record(attempt),
    })
    const backfill = this.#createBackfill({
      config,
      identity: foldIdentity,
      sessionsRoot: resolvePaths(config.dshHome).sessionsRoot,
      onLog: log,
    })
    reporter.start()
    // ★ coordinator 的 includeHistory 只回放已打开会话；磁盘全部历史由独立线程补齐。
    backfill.start()
    return {
      key,
      config,
      foldIdentity,
      reporter,
      backfill,
      stop: async () => {
        await Promise.all([backfill.stop(), reporter.shutdown()])
      },
    }
  }
}