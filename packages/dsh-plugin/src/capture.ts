/**
 * 捕获侧：把**宿主自己的会话事件流**折成账本记录，交给上报运行时。
 *
 * ## 为什么不再复用 `SessionTelemetryCoordinator`
 *
 * 0.8.x 及更早的实现照着官方 `dsh-session-telemetry-otel` 抄：
 *
 * ```
 * class TokenReportBackend extends SessionTelemetryBackend   // super(ctx, 'sessionTelemetry')
 *   └── new SessionTelemetryCoordinator(ctx, backend)       // 由它订阅 session/event 等
 * ```
 *
 * 这条路要求**独占 `sessionTelemetry` 服务**，于是与官方 OTel 后端互斥。
 * 三条实测结论决定它不可行（都在宿主源码里核过，2026-10-04）：
 *
 * 1. **服务名一个进程只能注册一次**：cordis `reflect.provide()` 重名即抛
 *    `service "sessionTelemetry" has been registered at <OpenTelemetrySessionBackend>`
 *    —— 而且抛在**构造期**。部署配置里带了 appKey 时，DSH 直接起不来，
 *    用户只能看到那一行；插件市场的一键安装也给不出「先手工停用官方 OTel」这一步。
 * 2. **官方后端永远占着它**：它的源码注释写着
 *    *"always registers the `sessionTelemetry` service (duplicate load throws)"*，
 *    `mode: DISABLED` 也一样占名 —— 所以「把 OTel 调成 disabled 模式」解决不了冲突，
 *    只有停用插件条目才行（README 排错表里记了这条）。
 * 3. **蹭它的记录流也不行**：官方后端的 coordinator 是 `capture: 'on-demand'`
 *    （只在用户提交反馈时按需回放），且它的 `emit(_record) {}` **直接丢弃**
 *    交给后端的记录 —— 挂在 `session-telemetry/record` 瀑布上，
 *    在官方 OTel 开启时一条实时记录都收不到。
 *
 * ## 于是：自己订阅宿主事件流
 *
 * ```
 * session/event（宿主同步热路径）
 *       ↓  ctx.on(...)     ← 只取 event.data 与事件的三个标量，不替宿主做任何判断
 * 账本记录（本文件拼形状）→ foldRecord() 决定「这条算不算计费」→ 入队
 * ```
 *
 * ★ 这条路的关键性质：**不碰** `@deepseek-ai/dsh-session-telemetry` 里那个
 *   **模块级共享**的 `handoffCursor`。官方后端的按需回放靠它决定「从哪一条开始补」，
 *   自建 coordinator 去投递会把游标一路推到最新，让用户提交反馈时官方那份**悄悄缺历史**。
 *   订阅事件流不会推进它 —— 所以两边可以同时工作，互不干扰。
 *
 * ## 已知的取舍（如实记录）
 *
 * coordinator 的 `includeHistory: true` 会在插件加载时回放**已经在跑的会话**。
 * 这里不做回放：历史由磁盘补报线程全量覆盖（`backfill-runner.ts`，服务端按
 * `event_id` 幂等，重复投递无害）。差别只是时序 —— 插件加载前就打开的那个会话，
 * 它的事件会在补报线程扫到日志时上报，而不是在加载瞬间。
 */

import type { TelemetryRecord } from './fold.js'

/** 宿主会话对象里本文件用到的字段（结构类型，刻意不 import 宿主类型）。 */
export interface HostSession {
  id?: unknown
  header?: { cwd?: unknown } | undefined
}

/** 宿主 `session/event` 的第二个参数（源事件）。 */
export interface HostSessionEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

/**
 * 捕获侧向宿主索要的三个能力。
 *
 * ⚠️ 收窄成这三个（而不是直接用 cordis 的 `Context`）有两个好处：
 *   「本插件到底依赖宿主什么」一眼可见，且测试能传一个几行的假 ctx。
 *   真实的 `Context` 结构上满足它。
 */
export interface CaptureHost {
  logger: { warn(message: string): void }
  effect(callback: () => (() => void) | void): void
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

/** 捕获到的记录往哪去（由 `ReportRuntime` 给的闭包，见 `BackendRefs`）。 */
export interface CaptureSink {
  /** 热路径：折叠 + 入队（**同步、无 IO**）。 */
  emit(record: TelemetryRecord): void
  /** turn 结束的冲刷提示（非必须，没有它只是延迟一个批次周期）。 */
  flush(): void
}

/**
 * 把一条宿主会话事件拼成账本记录；形状不合（拿不到会话 ID / 时间戳）时返回 `null`。
 *
 * ⚠️ **刻意不在这里判断「这条算不算计费」** —— 那是 `foldRecord()` 的唯一职责
 *   （本仓铁律：门槛与口径只在一处）。这里只做「事件 → 记录」的搬运，
 *   字段与官方 coordinator 的 `captureEvent()` 逐字对应：
 *   `channel`、`time`、`attributes`（会话级事实 + 事件信封）、`body`（源事件的 `data`）。
 *
 * 📌 **不填 `sourceEvent`**：官方 OTel 后端靠它把记录还原成「完整事件串」上传，
 *   本插件只取计费字段，用不上 —— 少拼一份 `structuredClone` 就是热路径上少一次分配。
 */
export function ledgerRecordOf(session: HostSession, event: HostSessionEvent): TelemetryRecord | null {
  const id = session?.id
  if (id === undefined || id === null) return null
  const time = event?.time
  // ⚠️ 拿不到事件时间就**整条跳过**，绝不退化成 0 / Date.now()：
  //   0 会把记录静默挪到 1970（时间窗之外，看板上表现为「少了一块」），
  //   Date.now() 则把统计挪到「插件看到它的那一刻」，两者都是伪造事实。
  if (typeof time !== 'number' || !Number.isFinite(time)) return null

  const cwd = session.header?.cwd
  return {
    channel: 'ledger',
    time,
    attributes: {
      'session.id': String(id),
      'event.type': event?.type,
      'event.seq': event?.seq,
      // 会话级事实在 attributes 里，不在 body 里（与官方 coordinator 同形）。
      ...(typeof cwd === 'string' && cwd !== '' ? { 'session.cwd': cwd } : {}),
    },
    body: event?.data,
  }
}

/** 把任意抛出物变成一行文案（错误里没有可用信息时也不能炸）。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 挂上捕获：订阅宿主会话事件流，直到 `ctx.effect` 的清理函数被调用。
 *
 * 🚨 **每条事件都必须就地吞掉异常**：cordis 的 `emit()` 是 stop-on-throw，
 *   从一条会话事件的监听器里抛出，会**饿死注册在后面的所有订阅者**
 *   （官方 OTel 的反馈回放也在同一条链上）。所以这里是全函数唯一的 try/catch 落点。
 */
export function installCapture(ctx: CaptureHost, sink: CaptureSink): void {
  ctx.effect(() => {
    const offEvent = ctx.on('session/event', ((session: HostSession, event: HostSessionEvent) => {
      try {
        const record = ledgerRecordOf(session, event)
        if (record !== null) sink.emit(record)
      } catch (error) {
        ctx.logger.warn(`token-report: 折叠会话事件失败（已跳过这一条）：${message(error)}`)
      }
    }) as never)

    // turn 结束即冲刷：长会话的投递延迟从「一个批次周期」降到「每轮」。
    const offFlush = ctx.on('session/flush', (() => {
      try {
        sink.flush()
      } catch (error) {
        ctx.logger.warn(`token-report: 冲刷上报队列失败（下一次周期会重试）：${message(error)}`)
      }
    }) as never)

    return () => {
      offEvent()
      offFlush()
    }
  })
}
