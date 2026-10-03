/**
 * HTTP 投递器：把一批计费记录 POST 到后台接收端。
 *
 * ## 设计取舍
 *
 * - **只做一次请求，不做内部重试**。重试的责任交给「下一轮 10 分钟周期」——
 *   状态文件里的 pending 就是重试队列。这样避免两层重试叠加
 *   （内层指数退避 + 外层周期）导致的长尾卡顿。
 * - **超时必须显式设置**。计划任务每 10 分钟拉起一次进程，调用方（任务计划程序）
 *   会把它当成前台进程；没有超时的 fetch 可能挂到天荒地老，把下一轮挤掉。
 * - **鉴权只是 Bearer**。内网 + HTTPS 起步足够；docs/插件方案.md §10.3 提到要区分机器时
 *   再演进为「每台一个 token，服务端绑定 user_id」。
 */

import type { DeliverOutcome, Deliverer } from './report.js'
import { emptyCounts, mergeCounts, type UsageRecord } from '@ai-token-report/core'

/** 上报 DTO —— 与 docs/插件方案.md §3.3 的字段口径一致。 */
export interface TokenUsagePayload {
  /** 上报协议版本，便于后台演进。 */
  schemaVersion: 1
  /**
   * 客户端标识，便于后台区分来源与排查。
   *
   * ⚠️ 这个字段**服务端不落库**（`ingest-route.ts` 只取 `client.group` 做文本快照），
   *   所以改它不会把历史数据切成两截。CLI 与插件现在报**同一个名字**。
   */
  client: {
    name: 'ai-token-report'
    /** 客户端诊断标识；真实归属只由服务端按 token 决定。 */
    userId: string
    userName?: string
    /**
     * 分组名快照（原 `dept`）。
     *
     * ⚠️ 这只是**上报当时客户端自己填的文本**，不参与归属 —— 权威归属由服务端
     *   按 token 解析出的 member 及其分组关联决定（见规范 §4.4）。
     *   服务端迁移期按 `client.group ?? client.dept` 取值，所以新客户端只发 `group`。
     */
    group?: string
  }
  generatedAt: string
  /** 扁平化的线上记录（下划线字段，对齐 docs/插件方案.md §10.4 的表结构）。 */
  records: Record<string, unknown>[]
}

export interface HttpDeliverOptions {
  endpoint: string
  /** 形如 `Bearer xxx`，或裸 token（会自动加前缀）。 */
  token?: string
  /** 单次请求超时（毫秒）。默认 15s。 */
  timeoutMs?: number
  userId?: string
  userName?: string
  /** 分组名（原 `dept`）；缺省表示本机没填过分组。 */
  group?: string
  /** 注入用，便于测试；默认用全局 fetch。 */
  fetchImpl?: typeof fetch
}

/** 把 UsageRecord 展开成服务端友好的扁平结构。 */
function toWireRecord(rec: UsageRecord): Record<string, unknown> {
  return {
    event_id: rec.eventId,
    session_id: rec.sessionId,
    seq: rec.seq,
    ts: rec.time,
    provider: rec.provider,
    model: rec.model,
    input_tokens: rec.usage.input,
    output_tokens: rec.usage.output,
    cache_read_tokens: rec.usage.cacheRead,
    cache_write_tokens: rec.usage.cacheWrite,
    reasoning_tokens: rec.usage.reasoning,
    total_tokens: rec.usage.total,
    cwd: rec.cwd,
    turn: rec.turn,
    step: rec.step,
    // ★ v9：来源随记录一起上报（`dsh` / `codex` / `claude-code` / `trae` /
    //   `trae-cn` / `workbuddy`）。**不发它就等于告诉服务端「这是 DSH 的」**：
    //   上报库的默认值是 `dsh`，而看板的来源筛选与来源排行正是按这一列出数的。
    source: rec.source,
  }
}

/**
 * 构造一个 HTTP 投递器。
 *
 * 网络错误、非 2xx、超时都**抛错**——`runReport` 会把 pending 原样保留，
 * 下一轮自然重试。这是 at-least-once 语义的落点。
 */
export function createHttpDeliverer(options: HttpDeliverOptions): Deliverer {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000

  const authHeader = ((): string | undefined => {
    if (!options.token) return undefined
    const t = options.token.trim()
    if (!t) return undefined
    return /^Bearer\s/i.test(t) ? t : `Bearer ${t}`
  })()

  return async (records: UsageRecord[]): Promise<DeliverOutcome> => {
    const payload: TokenUsagePayload = {
      schemaVersion: 1,
      client: {
        name: 'ai-token-report',
        userId: options.userId ?? 'unknown',
        ...(options.userName ? { userName: options.userName } : {}),
        ...(options.group ? { group: options.group } : {}),
      },
      generatedAt: new Date().toISOString(),
      // 线上结构用下划线字段（对齐 docs/插件方案.md §10.4 的表结构）
      records: records.map(toWireRecord),
    }

    const body = JSON.stringify(payload)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    let raw: string
    try {
      res = await doFetch(options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body,
        signal: controller.signal,
      })
      // 收到响应头不代表收到确认；超时必须覆盖 body，避免网关半响应永久卡住。
      raw = await res.text()
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError'
        ? `请求超时（${timeoutMs}ms）`
        : String(err)
      throw new Error(`上报失败: ${reason}`)
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      // ★ 503 是上报队列的**预期**过载信号（队列满 / 排队超时 / 正在停止），
      //   服务端会带 `Retry-After`。把它译成人能读懂的提示，而不是只丢一个状态码 ——
      //   「服务端让我等 1 秒」和「服务端坏了」在排障时是两件事。
      //   这里**只改提示文案**：失败仍然抛错，pending 仍然原样保留（at-least-once）。
      const retryAfter = res.status === 503 ? res.headers.get('retry-after') : null
      const hint = retryAfter ? `，服务端建议 ${retryAfter} 秒后重试` : ''
      throw new Error(`上报失败: HTTP ${res.status}${hint}${raw ? ` — ${raw.slice(0, 300)}` : ''}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('上报失败: 响应不是有效 JSON 确认，待发记录已保留')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('上报失败: 响应缺少确认计数，待发记录已保留')
    }
    const obj = parsed as Record<string, unknown>
    const counts = [obj['accepted'], obj['duplicates'], obj['rejected']]
    if (counts.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) {
      throw new Error('上报失败: 响应确认计数非法，待发记录已保留')
    }
    // HTML 登录页、代理空响应和不完整确认都不能证明服务端已经入库。
    if ((obj['accepted'] as number) + (obj['duplicates'] as number) + (obj['rejected'] as number) !== records.length) {
      throw new Error('上报失败: 响应确认计数与批次数不符，待发记录已保留')
    }
    return {
      accepted: obj['accepted'] as number,
      duplicates: obj['duplicates'] as number,
      rejected: obj['rejected'] as number,
    }
  }
}

/** 本地 JSONL 投递器：不联网，把记录追加到文件。用于端到端演练。 */
export function createFileDeliverer(filePath: string): Deliverer {
  return async (records: UsageRecord[]): Promise<DeliverOutcome> => {
    const { appendFile, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(filePath), { recursive: true })
    const text = records.map((r) => JSON.stringify(toWireRecord(r))).join('\n')
    if (text) await appendFile(filePath, text + '\n', 'utf8')
    return { accepted: records.length, duplicates: 0, rejected: 0 }
  }
}

/** 汇总一批记录的计费总量（供 CLI 展示）。 */
export function summarize(records: UsageRecord[]): ReturnType<typeof emptyCounts> {
  const total = emptyCounts()
  for (const r of records) mergeCounts(total, r.usage)
  return total
}
