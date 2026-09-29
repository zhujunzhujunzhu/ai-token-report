/**
 * 「上报调试」面板（浏览器半）—— 回答**「刚刚到底发出去了什么」**。
 *
 * ## 为什么这个面板值得存在
 *
 * 上报是无人值守的。用户能观察到的唯一现象是「部门看板上没有我的数」，
 * 而可能的原因有一长串：没署名、地址写错、appKey 过期、服务端 401、
 * outbox 积压、历史补报还没跑完。在此之前这些都只存在于进程日志里 ——
 * 而 DSH 的日志滚动很快，也不在用户面前。
 *
 * 于是这里把宿主保留的**最近若干次真实请求**原样摊开：请求体长什么样、
 * 服务端怎么回的、计数对不对。排查从「猜」变成「看」。
 *
 * ## 🚨 凭证边界
 *
 * 页面上能看到的一切都来自 `GET /api/tokenReport.reports`，而宿主侧
 * （`report-log.ts`）**只留请求体、不留请求头** —— appKey 走
 * `Authorization: Bearer`，所以它天然不在这里。
 * **不要**为了「方便排查」而把请求头也搬过来。
 *
 * ## 轮询策略
 *
 * 调试页打开时 3 秒拉一次（它是用户主动打开的面板，且只在设置页里可见），
 * 关闭即停。这与用量面板那个「省钱优先」的探针是两件事：这里要的是
 * 「我点完『立即上报』之后立刻能看到结果」。
 */
import { createElement as h, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  UI_REPORTS_PATH,
  readUiReports,
  readUiReportAction,
  type UiReportAttempt,
  type UiReportsPayload,
} from './protocol.js'

/** 调试页的轮询周期（毫秒）。 */
export const DEBUG_POLL_INTERVAL_MS = 3_000

/** 后端的补报状态 → 中文。未知值原样显示（不猜）。 */
const BACKFILL_LABELS: Record<string, string> = {
  idle: '等待扫描',
  running: '正在扫描补报',
  complete: '本轮已全部确认',
  retrying: '等待重试',
  stopped: '已停止',
}

function fmtInt(value: number): string {
  return value.toLocaleString('en-US')
}

function fmtBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function fmtTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

/** 「3 秒/10 秒」这类给人看的间隔。 */
function fmtInterval(millis: number): string {
  if (millis <= 0) return '—'
  if (millis % 60_000 === 0) return `${millis / 60_000} 分钟`
  if (millis % 1_000 === 0) return `${millis / 1_000} 秒`
  return `${millis} 毫秒`
}

/** 一次请求的结论：成功 / 服务端拒收 / 根本没发出去。 */
function verdict(attempt: UiReportAttempt): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (attempt.error !== null) return { text: attempt.error, tone: 'bad' }
  if (attempt.httpStatus === null) return { text: '请求未发出', tone: 'bad' }
  if (!attempt.ok) return { text: `HTTP ${attempt.httpStatus}`, tone: 'bad' }
  return { text: `HTTP ${attempt.httpStatus}`, tone: 'ok' }
}

function Stat(props: { label: string; value: string; hint?: string }): ReactNode {
  return h('div', { className: 'atr-dbg-stat' },
    h('span', { className: 'atr-dbg-stat-k' }, props.label),
    h('span', { className: 'atr-dbg-stat-v' }, props.value),
    props.hint ? h('span', { className: 'atr-dbg-stat-h' }, props.hint) : null)
}

export function ReportDebugPanel(props: { onConfigure(): void }): ReactNode {
  const [data, setData] = useState<UiReportsPayload | undefined>(undefined)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [preview, setPreview] = useState<string>('')
  // ★ 用 ref 而不是 state 记「还在不在」：卸载后迟到的响应不该再 setState
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let stopped = false
    const controller = new AbortController()

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${UI_REPORTS_PATH}?_=${Date.now()}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json().catch(() => undefined)
        if (stopped || !alive.current) return
        setData(readUiReports(body))
        setError('')
      } catch (err) {
        if (stopped || !alive.current) return
        // ⚠️ 读不到调试数据不等于上报坏了（旧宿主没有这条路由）。
        //    所以这里只说「读不到」，绝不说「上报失败」。
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    void load()
    const timer = setInterval(() => { void load() }, DEBUG_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      alive.current = false
      clearInterval(timer)
      controller.abort()
    }
  }, [])

  const act = async (action: 'flush' | 'preview'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(action === 'flush' ? '正在立即上报…' : '正在生成预览…')
    if (action === 'preview') setPreview('')
    try {
      const response = await fetch(UI_REPORTS_PATH, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = readUiReportAction(await response.json().catch(() => undefined))
      if (!result.ok) {
        setNote(result.reason ?? '操作失败')
      } else if (result.preview) {
        setPreview(result.preview.body)
        setNote(
          `预览：${fmtInt(result.preview.records)} 条来自${result.preview.source === 'outbox' ? '磁盘待投递队列' : '内存队列'}，` +
            `${fmtBytes(result.preview.bytes)}（没有真的发送）`,
        )
      } else {
        setNote(result.reason ?? '已触发一次上报，稍后刷新即可看到结果')
        // 立刻刷新一次，让「立即上报」的结果尽快可见（不必等下一轮轮询）
        setTimeout(() => { void fetch(UI_REPORTS_PATH).then(async (r) => {
          if (!r.ok || !alive.current) return
          setData(readUiReports(await r.json().catch(() => undefined)))
        }).catch(() => {}) }, 600)
      }
    } catch {
      setNote('无法连接宿主的上报调试通道，请确认插件已重新构建并加载。')
    } finally {
      setBusy(false)
    }
  }

  if (data === undefined) {
    return h('section', { className: 'atr-settings' },
      h('p', { role: 'status' }, error ? `读取上报调试信息失败（${error}）。` : '正在读取上报调试信息…'),
      error ? h('p', { className: 'atr-note' },
        '如果你刚升级插件，请注意这条调试通道由宿主半提供：旧版本宿主没有它。面板用量与上报本身不受影响。') : null,
      h('button', { type: 'button', className: 'atr-btn', onClick: props.onConfigure }, '去配置连接'))
  }

  const reporting = data.reporting
  const stats = data.stats
  const backfill = data.backfill

  return h('section', { className: 'atr-settings atr-dbg' },
    // ── 一、现在在不在上报 ──────────────────────────────────────────
    h('div', { className: `atr-dbg-status${reporting.enabled ? ' atr-dbg-on' : ' atr-dbg-off'}` },
      h('strong', null, reporting.enabled ? '上报中' : '未上报'),
      h('span', { className: 'atr-grow' }),
      h('span', { className: 'atr-dbg-endpoint', title: reporting.endpoint }, reporting.endpoint || '（未配置地址）')),
    reporting.enabled ? null : h('p', { role: 'status' }, `原因：${reporting.reason ?? '未启用'}`),
    data.identity
      ? h('p', { className: 'atr-note' },
          `当前署名：${data.identity.name}${data.identity.group ? ` · ${data.identity.group}` : ''}` +
            '（由服务端按 appKey 认定，客户端填不了）')
      : h('p', { className: 'atr-note' }, '尚未署名：在完成配置之前，本插件不采集、也不上报任何数据。'),

    // ── 二、发了多少 ────────────────────────────────────────────────
    h('div', { className: 'atr-dbg-stats' },
      Stat({ label: '已采集', value: stats ? fmtInt(stats.enqueued) : '0', hint: '本进程折叠出的计费记录' }),
      Stat({ label: '已投递', value: stats ? fmtInt(stats.delivered) : '0', hint: stats ? `重复 ${fmtInt(stats.duplicates)} · 拒收 ${fmtInt(stats.rejected)}` : '' }),
      Stat({ label: '内存队列', value: stats ? fmtInt(stats.queueLength) : '0', hint: `最多 ${fmtInt(data.maxRecords)} 条/批` }),
      Stat({
        label: '磁盘待投递',
        value: stats ? fmtInt(stats.outbox.pendingRecords) : '0',
        hint: stats ? `${fmtInt(stats.outbox.pendingBatches)} 批 · ${fmtBytes(stats.outbox.pendingBytes)}` : '',
      }),
      Stat({
        label: '请求',
        value: stats ? fmtInt(stats.requests) : '0',
        hint: stats ? `失败 ${fmtInt(stats.failures)} 次` : '',
      }),
      Stat({
        label: '最近成功',
        value: stats && stats.lastSuccessAt > 0 ? fmtTime(stats.lastSuccessAt) : '从未',
        hint: `间隔 ${fmtInterval(data.flushIntervalMillis)}`,
      }),
    ),
    stats?.lastError ? h('p', { className: 'atr-dbg-err' }, `最近错误：${stats.lastError}`) : null,
    stats && stats.outbox.droppedBatches > 0
      ? h('p', { className: 'atr-dbg-err' },
          `⚠ 磁盘队列超出容量上限，已丢弃 ${fmtInt(stats.outbox.droppedBatches)} 批**最旧**数据。`)
      : null,

    // ── 三、历史补报进度 ───────────────────────────────────────────
    backfill
      ? h('p', { className: 'atr-note' },
          `历史补报：${BACKFILL_LABELS[backfill.status] ?? backfill.status} · ` +
            `文件 ${fmtInt(backfill.filesProcessed)}/${fmtInt(backfill.filesTotal)} · ` +
            `服务端确认 ${fmtInt(backfill.confirmed)} 条（新增 ${fmtInt(backfill.accepted)}，重复 ${fmtInt(backfill.duplicates)}）` +
            (backfill.lastError ? ` · 上次错误：${backfill.lastError}` : ''))
      : null,
    h('p', { className: 'atr-note' },
      '扫描本机全部历史会话；服务端确认后才记账，失败会自动重试。只上报 token 数值与模型名，不采集对话内容。'),

    // ── 四、动手：立即上报 / 预览 ──────────────────────────────────
    h('div', { className: 'atr-dbg-actions' },
      h('button', { type: 'button', className: 'atr-btn atr-primary', disabled: busy || !reporting.enabled,
        onClick: () => { void act('flush') } }, busy ? '处理中…' : '立即上报一次'),
      h('button', { type: 'button', className: 'atr-btn', disabled: busy || !reporting.enabled,
        onClick: () => { void act('preview') } }, '预览下一批内容'),
      h('span', { className: 'atr-grow' }),
      h('button', { type: 'button', className: 'atr-btn', onClick: props.onConfigure }, '去配置连接')),
    note ? h('p', { role: 'status', className: 'atr-note' }, note) : null,
    preview ? h('pre', { className: 'atr-dbg-payload', 'aria-label': '下一批请求体预览' }, preview) : null,

    // ── 五、最近发了什么（这是本页的重点）──────────────────────────
    h('h3', { className: 'atr-dbg-h3' }, `最近上报（${data.recent.length} 次，最新在前）`),
    data.recent.length === 0
      ? h('p', { className: 'atr-empty' },
          reporting.enabled
            ? '还没有发出过请求。等一个上报周期，或点上面的「立即上报一次」。'
            : '上报未启用，因此没有任何请求记录。')
      : h('div', { className: 'atr-dbg-list' }, ...data.recent.map((attempt, index) => {
          const conclusion = verdict(attempt)
          const expanded = open === index
          return h('div', { key: `${attempt.at}-${index}`, className: 'atr-dbg-item' },
            h('button', {
              type: 'button',
              className: 'atr-dbg-row',
              'aria-expanded': expanded,
              onClick: () => setOpen(expanded ? null : index),
            },
              h('span', { className: 'atr-dbg-time' }, fmtTime(attempt.at)),
              h('span', { className: 'atr-dbg-count' }, `${fmtInt(attempt.records)} 条`),
              h('span', { className: 'atr-dbg-src' }, attempt.source === 'outbox' ? '磁盘队列' : '内存队列'),
              h('span', { className: `atr-dbg-verdict atr-dbg-${conclusion.tone}` }, conclusion.text),
              h('span', { className: 'atr-grow' }),
              h('span', { className: 'atr-dbg-bytes' }, fmtBytes(attempt.bytes)),
            ),
            expanded ? h('div', { className: 'atr-dbg-detail' },
              h('p', { className: 'atr-note' },
                `服务端回执：接收 ${fmtInt(attempt.accepted)} · 重复 ${fmtInt(attempt.duplicates)} · 拒收 ${fmtInt(attempt.rejected)}`),
              attempt.truncated
                ? h('p', { className: 'atr-dbg-err' }, '请求体过大，下面只显示开头部分。')
                : null,
              h('pre', { className: 'atr-dbg-payload' }, pretty(attempt.payload))) : null)
        })),
  )
}

/**
 * 尽量把请求体排版出来；不是 JSON 就原样显示。
 *
 * ⚠️ 绝不为了好看丢掉内容：用户要靠这段文字确认「到底发了什么」。
 */
function pretty(payload: string): string {
  if (!payload) return '（空）'
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}