/**
 * 输出格式化：终端表格、JSON、CSV。
 */

import type { GroupRow, SeriesPoint } from './aggregate.js'
import type { ScanDiagnostics, TokenCounts } from './types.js'
import { derive } from './types.js'

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 紧凑数字：12.3M / 1.2B，用于终端宽度受限时。 */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export function fmtPct(x: number, digits = 1): string {
  return (x * 100).toFixed(digits) + '%'
}

/** 计算字符串的显示宽度（CJK 字符占 2 列）。 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    // CJK 统一表意文字、全角标点等
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const w = displayWidth(s)
  const fill = Math.max(0, width - w)
  return align === 'left' ? s + ' '.repeat(fill) : ' '.repeat(fill) + s
}

export interface Column {
  title: string
  align?: 'left' | 'right'
  width?: number
}

/** 渲染等宽表格（对 CJK 宽度做对齐修正）。 */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) => {
    const maxCell = rows.reduce((m, r) => Math.max(m, displayWidth(r[i] ?? '')), 0)
    return col.width ?? Math.max(displayWidth(col.title), maxCell)
  })

  const header = columns
    .map((col, i) => pad(col.title, widths[i]!, col.align ?? 'left'))
    .join('  ')
  const sep = widths.map((w) => '─'.repeat(w)).join('  ')
  const body = rows
    .map((r) => columns.map((col, i) => pad(r[i] ?? '', widths[i]!, col.align ?? 'left')).join('  '))
    .join('\n')

  return `${header}\n${sep}\n${body}`
}

/** 分组结果 → 终端表格。 */
export function formatGroupTable(rows: GroupRow[], title: string): string {
  const out: string[] = []
  out.push(`\n=== ${title} ===`)

  const body = rows.map((r) => [
    r.key,
    fmtCompact(r.counts.total),
    fmtInt(r.counts.input),
    fmtInt(r.counts.output),
    fmtInt(r.counts.cacheRead),
    fmtPct(r.metrics.cacheHitRate),
    fmtInt(r.counts.calls),
    fmtInt(r.sessions),
  ])

  out.push(
    renderTable(
      [
        { title: '分组', align: 'left' },
        { title: '总量', align: 'right' },
        { title: '未缓存输入', align: 'right' },
        { title: '输出', align: 'right' },
        { title: '缓存读', align: 'right' },
        { title: '命中率', align: 'right' },
        { title: '调用数', align: 'right' },
        { title: '会话数', align: 'right' },
      ],
      body,
    ),
  )
  return out.join('\n')
}

/** 时间序列 → 终端折线（用块字符画简易柱状趋势）。 */
export function formatSeries(points: SeriesPoint[], title: string): string {
  const out: string[] = []
  out.push(`\n=== ${title} ===`)

  const max = points.reduce((m, p) => Math.max(m, p.counts.total), 0)
  const barWidth = 24

  const body = points.map((p) => {
    const ratio = max > 0 ? p.counts.total / max : 0
    const filled = Math.round(ratio * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    return [
      p.bucket,
      bar,
      fmtCompact(p.counts.total),
      fmtInt(p.counts.input),
      fmtInt(p.counts.output),
      fmtPct(p.metrics.cacheHitRate),
      fmtInt(p.counts.calls),
    ]
  })

  out.push(
    renderTable(
      [
        { title: '时间', align: 'left' },
        { title: '趋势', align: 'left' },
        { title: '总量', align: 'right' },
        { title: '未缓存输入', align: 'right' },
        { title: '输出', align: 'right' },
        { title: '命中率', align: 'right' },
        { title: '调用数', align: 'right' },
      ],
      body,
    ),
  )
  return out.join('\n')
}

/** 总计摘要块。 */
export function formatTotal(counts: TokenCounts, label = '总计'): string {
  const m = derive(counts)
  const lines = [
    '',
    `=== ${label} ===`,
    `  调用数            ${fmtInt(counts.calls)}`,
    `  计费总量          ${fmtInt(counts.total)}   (in+out+cacheRead+cacheWrite)`,
    `    未缓存输入      ${fmtInt(counts.input)}`,
    `    输出            ${fmtInt(counts.output)}`,
    `    缓存读          ${fmtInt(counts.cacheRead)}`,
    `    缓存写          ${fmtInt(counts.cacheWrite)}`,
    `    推理            ${fmtInt(counts.reasoning)}`,
    `  缓存命中率        ${fmtPct(m.cacheHitRate)}   = cacheRead/(cacheRead+input)`,
    `  缓存占总量比      ${fmtPct(m.cacheShareOfTotal)}`,
    `  缓存节省倍率      ${m.cacheLeverage.toFixed(1)}x  (若 cacheRead 按 input 计价)`,
    `  平均每次调用      ${fmtInt(m.avgTokensPerCall)} tokens`,
    `  平均每次输出      ${fmtInt(m.avgOutputPerCall)} tokens`,
  ]
  return lines.join('\n')
}

/** 诊断信息块——用于暴露口径问题而不是掩盖它们。 */
export function formatDiagnostics(d: ScanDiagnostics): string {
  const lines = [
    '',
    '=== 扫描诊断 ===',
    `  会话文件          ${fmtInt(d.filesScanned)} 个（失败 ${d.filesFailed}）`,
    `  zstd 帧           ${fmtInt(d.framesOk)} 成功 / ${fmtInt(d.framesFailed)} 失败(尾部半帧,正常)`,
    `  事件总数          ${fmtInt(d.totalEvents)}`,
    `  计费事件          ${fmtInt(d.usageEvents)}`,
    `  assistant/message 无 usage  ${fmtInt(d.assistantMessagesWithoutUsage)}`,
    `  totalTokens 恒等式不符      ${fmtInt(d.totalTokenMismatches)}  ${d.totalTokenMismatches === 0 ? '✓' : '⚠ 需检查'}`,
    `  未识别 provider   ${fmtInt(d.missingProvider)}`,
    `  重试事件          llm/retry-started=${d.retryStarted}, llm/retry=${d.retry}`,
    `  尝试事件          assistant/attempt=${d.attempts}（不含 usage，不重复计费）`,
    `  发现 provider     ${[...d.providersSeen].sort().join(', ') || '(无)'}`,
  ]
  return lines.join('\n')
}

/** CSV 转义。 */
function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

export function groupRowsToCsv(rows: GroupRow[], keyName: string): string {
  return toCsv(
    [
      keyName,
      'total_tokens',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'reasoning_tokens',
      'calls',
      'sessions',
      'cache_hit_rate',
      'first_time',
      'last_time',
    ],
    rows.map((r) => [
      r.key,
      r.counts.total,
      r.counts.input,
      r.counts.output,
      r.counts.cacheRead,
      r.counts.cacheWrite,
      r.counts.reasoning,
      r.counts.calls,
      r.sessions,
      r.metrics.cacheHitRate.toFixed(6),
      r.firstTime ? new Date(r.firstTime).toISOString() : '',
      r.lastTime ? new Date(r.lastTime).toISOString() : '',
    ]),
  )
}

export function seriesToCsv(points: SeriesPoint[]): string {
  return toCsv(
    ['bucket', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'calls', 'cache_hit_rate'],
    points.map((p) => [
      p.bucket,
      p.counts.total,
      p.counts.input,
      p.counts.output,
      p.counts.cacheRead,
      p.counts.calls,
      p.metrics.cacheHitRate.toFixed(6),
    ]),
  )
}