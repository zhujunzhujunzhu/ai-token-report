#!/usr/bin/env bun
/**
 * dsh-token-report —— DSH token 用量统计 CLI。
 *
 * 数据源：`$DSH_HOME/sessions/**\/session*.jsonl.zstd` 中的 `assistant/message` 事件。
 * 只有该事件的 `data.usage` 是 provider 真实上报的计费级数据。
 */

import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, DEFAULT_PORT, type ServerHandle } from '@ai-token-report/server'

import {
  aggregate,
  crossTabRanked,
  timeSeries,
  type GroupDimension,
} from '@ai-token-report/core'
import { createFileDeliverer, createHttpDeliverer } from './deliver.js'
import { runReport, type RunReportResult } from './report.js'
import { resetState, resolveStatePath } from '@ai-token-report/core'
import {
  fmtCompact,
  fmtInt,
  fmtTime,
  formatDiagnostics,
  formatGroupTable,
  formatSeries,
  formatTotal,
  groupRowsToCsv,
  renderTable,
  seriesToCsv,
} from '@ai-token-report/core'
import { resolvePaths, type ResolvedPaths } from '@ai-token-report/core'
import {
  RangeError as RangeParseError,
  PERIOD_NAMES,
  describeRangeFull,
  resolvePeriod,
  resolveRange,
} from '@ai-token-report/core'
import { openStats, resetDb } from '@ai-token-report/core/db'
import { derive, emptyDiagnostics, type UsageRecord } from '@ai-token-report/core'

const HELP = `
dsh-token-report —— DSH token 用量统计

用法:
  dsh-token-report [选项]
  dsh-token-report web [选项]          起本地页面（内嵌服务 + 自动开浏览器）
  dsh-token-report report [选项]      增量上报（每 10 分钟由计划任务调用）

── 统计（默认）──────────────────────────────────────────
数据维度:
  --by <dim>       主分组维度, 逗号分隔 (默认 provider-model)
                   可选: provider | model | provider-model | project | session | day | hour
  --series <g>     输出时间序列: day | hour
  --cross          输出 provider × model 交叉表
  --top <n>        每张表只显示前 n 行 (默认 30)

筛选:
  --period <p>     具名周期(最常用): today | yesterday | week | lastweek |
                   month | lastmonth | year | last7d | last14d | last30d | last90d
                   也接受中文: 今天 | 昨天 | 本周 | 上周 | 本月 | 上月 | 今年 | 最近7天
  --provider <p>   provider 过滤, 逗号分隔, 子串匹配 (如 dashscope)
  --model <m>      model 过滤, 逗号分隔, 子串匹配 (如 deepseek-v4.1-flash)
  --since <t>      起始时间: 2026-09-18 | 2026-09-18T14:30 | today | 7d
  --until <t>      结束时间 (纯日期含当天 23:59:59)
  --last <t>       滚动窗口: 7d | 24h | 90m (从此刻往回, 非自然日)

时间口径说明:
  --period week     本周, 从周一 00:00 至今       (自然周期)
  --period month    本月, 从 1 号 00:00 至今       (自然周期)
  --period last7d   最近 7 个自然日, 含今天        (自然日)
  --last 7d         滚动 7×24 小时 = 168 小时      (滚动窗口)
  两者结果不同: 看板/报表口径请用 --period

输出:
  --format <f>     table | json | csv (默认 table)
  --out <file>     写入文件而不是 stdout
  --no-diag        不输出扫描诊断与总计
  --quiet          不输出扫描进度

数据源:
  默认读本地 SQLite 增量库（$DSH_HOME/token-report/usage.sqlite），
  每次请求先做增量入库再查库 —— 热态约 10ms，冷态首次约 15 秒
  （需全量解析历史日志以建库）。
  --no-db          强制直扫日志，不走库（用于与库结果对照验证）
  --reset-db       删除本地库后退出；下次运行全量重建（不丢数据）

── 本地页面 web ────────────────────────────────────────
  起一个只监听 127.0.0.1 的本地服务并打开浏览器。数据来自**本地 SQLite
  增量库**（$DSH_HOME/token-report/usage.sqlite），每次请求先增量入库再查，
  热态约 50ms；**不出网、不上报、断网可用**。

  首次启动会全量建库（约 15 秒，需解析历史日志），之后都是毫秒级。

  服务对象是「我自己」：页面上看到的数与你执行 dsh-token-report --period X
  完全一致 —— 两者走同一个数据源与同一套口径公式。

  --port <n>       监听端口 (默认 8787，被占用自动 +1)
  --portal <url>   部门服务端地址；配置后页面才能校验并保存署名
  --no-open        不自动打开浏览器

── 增量上报 report ──────────────────────────────────────
  只上报自上次以来【新增】的计费记录, 靠状态文件里的三层水位线
  (文件大小 / zstd 帧数 / 事件 seq)。首次运行会全量重扫以建立基线。

  --dry-run        扫描并落盘 pending, 但不投递 (调试首选)
  --endpoint <url> 后台接收地址, 如 https://portal/api/v1/token-usage
  --token <t>      鉴权 token (裸 token 或 'Bearer xxx')
  --out-file <f>   不联网, 把记录追加到本地 JSONL (端到端演练)
  --no-save        只看不改: 不写状态文件 (纯观察增量)
  --state <p>      状态文件路径 (默认 $DSH_HOME/token-report/state.json)
  --reset          清空水位线后退出, 下次全量重扫
  --timeout <ms>   单次请求超时 (默认 15000)
  --user-id <id>   身份署名 (方案 A); 也可用 env DSH_REPORT_USER_ID
  --user-name <n>  显示名; 也可用 env DSH_REPORT_USER_NAME
  --dept <d>       部门; 也可用 env DSH_REPORT_DEPT

其他:
  --dsh-home <p>   指定 DSH home (默认 $DSH_HOME 或 ~/.dsh)
  --list-providers 只列出发现的所有 provider/model 后退出
  -h, --help       显示帮助

示例:
  dsh-token-report --period today                # 今天
  dsh-token-report --period week --series day    # 本周 + 每日趋势
  dsh-token-report --provider dashscope --period month   # 数字集团本月
  dsh-token-report --by provider --cross         # 全量按厂商
  dsh-token-report --list-providers              # 先摸清有哪些厂商
  dsh-token-report --format csv --out report.csv
  dsh-token-report --period today --no-db        # 直扫日志（与库结果对照）

  dsh-token-report web                           # 本地页面（推荐入口）
  dsh-token-report web --no-open --port 8899     # 指定端口、不开浏览器

  dsh-token-report report --dry-run              # 看这一轮会发什么
  dsh-token-report report --no-save --dry-run    # 只看不改
  dsh-token-report report --out-file out.jsonl   # 落本地文件演练
  dsh-token-report report --endpoint https://portal/api/v1/token-usage --token $env:DSH_REPORT_TOKEN
  dsh-token-report report --reset                # 清空水位线
`

interface CliOptions {
  by: GroupDimension[]
  series?: 'day' | 'hour'
  cross: boolean
  top: number
  providers: string[]
  models: string[]
  since?: string
  until?: string
  last?: string
  period?: string
  format: 'table' | 'json' | 'csv'
  out?: string
  noDiag: boolean
  quiet: boolean
  /**
   * 强制走直扫日志，不用本地 SQLite 库。
   *
   * 用途是**对照验证**：同样的参数跑 `--no-db` 与默认模式，
   * 两者的数字必须完全一致（见 `packages/core/test/db.test.ts` 的口径一致断言）。
   */
  noDb: boolean
  /** 清空本地库后退出；下次运行会全量重建。 */
  resetDb: boolean
  dshHome?: string
  listProviders: boolean
  /** 子命令：`report` 时走增量上报流程而非统计。 */
  command?: 'report' | 'web'
  report: ReportOptions
  web: WebOptions
}

interface WebOptions {
  /** 监听端口。默认 8787；被占用时自动 +1。 */
  port?: number
  /**
   * 部门服务端地址。配置后本地页才能校验并保存署名。
   *
   * ⚠️ 未配置时页面**仍可看本机统计**，只是没法完成署名 ——
   *   因为本地服务无从确认「你是谁」，存下来也没有意义。
   */
  portal?: string
  /** 不自动打开浏览器。 */
  noOpen: boolean
}

interface ReportOptions {
  /** 干跑：扫描并落盘 pending，但不投递。 */
  dryRun: boolean
  /** 清空水位线后退出，下次将全量重扫。 */
  reset: boolean
  /** 只看不改：不写状态文件。 */
  noSave: boolean
  /** 投递目标；未提供时与 dry-run 等价。 */
  endpoint?: string
  token?: string
  /** 不联网，把记录追加到本地 JSONL（端到端演练）。 */
  outFile?: string
  timeoutMs: number
  userId?: string
  userName?: string
  dept?: string
  statePath?: string
}

const VALID_DIMS: GroupDimension[] = [
  'provider',
  'model',
  'provider-model',
  'project',
  'session',
  'day',
  'hour',
]

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions | null {
  const opts: CliOptions = {
    by: ['provider-model'],
    cross: false,
    top: 30,
    providers: [],
    models: [],
    format: 'table',
    noDiag: false,
    quiet: false,
    noDb: false,
    resetDb: false,
    listProviders: false,
    report: {
      dryRun: false,
      reset: false,
      noSave: false,
      timeoutMs: 15_000,
    },
    web: {
      noOpen: false,
    },
  }
  let byExplicit = false

  // 子命令：第一个非 flag 的 token 若是 `report` / `web`，后续按该子命令解析。
  // 保持 `dsh-token-report [选项]` 的既有用法完全不变。
  // 同时兼容 `--web` 这种历史写法（package.json 的 web 脚本就是这么调的）。
  if (argv[0] === 'report') {
    opts.command = 'report'
    argv = argv.slice(1)
  } else if (argv[0] === 'web') {
    opts.command = 'web'
    argv = argv.slice(1)
  }

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      throw new UsageError(`${flag} 需要一个值`)
    }
    return v
  }

  const splitList = (s: string): string[] =>
    s.split(',').map((x) => x.trim()).filter(Boolean)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '-h':
      case '--help':
        return null

      // ── report 子命令专用 ──────────────────────────────────────────────
      case '--dry-run':
        opts.report.dryRun = true
        break
      case '--reset':
        opts.report.reset = true
        break
      case '--no-save':
        opts.report.noSave = true
        break
      case '--endpoint':
        opts.report.endpoint = takeValue(i, arg)
        i++
        break
      case '--token':
        opts.report.token = takeValue(i, arg)
        i++
        break
      case '--out-file':
        opts.report.outFile = takeValue(i, arg)
        i++
        break
      case '--timeout':
        {
          const n = Number(takeValue(i, arg))
          if (!Number.isFinite(n) || n <= 0) throw new UsageError('--timeout 需要正数（毫秒）')
          opts.report.timeoutMs = n
          i++
        }
        break
      case '--user-id':
        opts.report.userId = takeValue(i, arg)
        i++
        break
      case '--user-name':
        opts.report.userName = takeValue(i, arg)
        i++
        break
      case '--dept':
        opts.report.dept = takeValue(i, arg)
        i++
        break
      case '--state':
        opts.report.statePath = takeValue(i, arg)
        i++
        break
      // ── web 子命令专用 ─────────────────────────────────────────────────
      // `--web` 等价于 `web` 子命令：package.json 的 web 脚本用的是这种写法，
      // 手工敲 `dsh-token --web` 也很常见，两者都要认。
      case '--web':
        opts.command = 'web'
        break
      case '--port': {
        const n = Number(takeValue(i, arg))
        if (!Number.isInteger(n) || n <= 0 || n > 65535) {
          throw new UsageError('--port 需要 1~65535 之间的整数')
        }
        opts.web.port = n
        i++
        break
      }
      case '--portal':
        opts.web.portal = takeValue(i, arg)
        i++
        break
      case '--no-open':
        opts.web.noOpen = true
        break

      case '--by': {
        const dims = splitList(takeValue(i, arg))
        for (const d of dims) {
          if (!VALID_DIMS.includes(d as GroupDimension)) {
            throw new UsageError(
              `未知维度 "${d}"。可选: ${VALID_DIMS.join(' | ')}`,
            )
          }
        }
        opts.by = byExplicit ? [...opts.by, ...(dims as GroupDimension[])] : (dims as GroupDimension[])
        byExplicit = true
        i++
        break
      }
      case '--series': {
        const g = takeValue(i, arg)
        if (g !== 'day' && g !== 'hour') {
          throw new UsageError(`--series 只支持 day 或 hour，收到 "${g}"`)
        }
        opts.series = g
        i++
        break
      }
      case '--cross':
        opts.cross = true
        break
      case '--top': {
        const n = Number(takeValue(i, arg))
        if (!Number.isInteger(n) || n < 0) throw new UsageError('--top 需要非负整数')
        opts.top = n
        i++
        break
      }
      case '--provider':
        opts.providers.push(...splitList(takeValue(i, arg)))
        i++
        break
      case '--model':
        opts.models.push(...splitList(takeValue(i, arg)))
        i++
        break
      case '--since':
        opts.since = takeValue(i, arg)
        i++
        break
      case '--until':
        opts.until = takeValue(i, arg)
        i++
        break
      case '--last':
        opts.last = takeValue(i, arg)
        i++
        break
      case '--period': {
        const p = takeValue(i, arg)
        // 提前校验，给出比「无匹配结果」更有用的报错
        if (!resolvePeriod(p)) {
          throw new UsageError(
            `未知周期 "${p}"。\n可选: ${PERIOD_NAMES.join(' / ')}\n` +
              `也接受中文: 今天 昨天 本周 上周 本月 上月 今年`,
          )
        }
        opts.period = p
        i++
        break
      }
      case '--format': {
        const f = takeValue(i, arg)
        if (f !== 'table' && f !== 'json' && f !== 'csv') {
          throw new UsageError(`--format 只支持 table | json | csv，收到 "${f}"`)
        }
        opts.format = f
        i++
        break
      }
      case '--out':
        opts.out = takeValue(i, arg)
        i++
        break
      case '--dsh-home':
        opts.dshHome = takeValue(i, arg)
        i++
        break
      case '--no-diag':
        opts.noDiag = true
        break
      // ── 数据源开关 ─────────────────────────────────────────────────────
      case '--no-db':
        opts.noDb = true
        break
      case '--reset-db':
        opts.resetDb = true
        break
      case '--quiet':
        opts.quiet = true
        break
      case '--list-providers':
        opts.listProviders = true
        break
      default:
        throw new UsageError(`未知参数 "${arg}"。用 --help 查看用法。`)
    }
  }
  return opts
}

/** 渲染单维度表格。 */
function renderDimension(records: UsageRecord[], dim: GroupDimension, top: number): string {
  const rows = aggregate(records, dim)
  const shown = top > 0 ? rows.slice(0, top) : rows
  const suffix = top > 0 && rows.length > top ? `（共 ${rows.length} 组，显示前 ${top}）` : ''
  const label = dimLabel(dim)
  return formatGroupTable(shown, `${label}${suffix}`)
}

function dimLabel(dim: GroupDimension): string {
  switch (dim) {
    case 'provider':
      return '按厂商 (provider)'
    case 'model':
      return '按模型 (model)'
    case 'provider-model':
      return '按厂商 / 模型 (provider/model)'
    case 'project':
      return '按项目 (cwd)'
    case 'session':
      return '按会话 (session)'
    case 'day':
      return '按天 (day)'
    case 'hour':
      return '按小时 (hour)'
  }
}

/**
 * 描述本次取数用的数据源，用于终端头部与诊断。
 *
 * 把「走了哪个源、库里有多少条」显式打出来，是为了让「SQL 化到底有没有生效」
 * 一眼可见 —— 否则降级发生时用户只会觉得「这次慢」，而不知道原因。
 */
function describeSource(
  source: 'sql' | 'scan',
  paths: ResolvedPaths,
  dbStats: { events: number; earliest: number | null; latest: number | null } | null,
): string {
  if (source === 'scan') return `直扫日志 ${paths.sessionsRoot}`
  const count = dbStats?.events ?? 0
  return `本地库 ${paths.dbPath}（${fmtInt(count)} 条记录）`
}

/**
 * SQL 路径的诊断块。
 *
 * 与 `formatDiagnostics`（逐事件扫描诊断）不同：读库时没有「解压了多少帧」
 * 这类信息，有的是「库里有多少条、覆盖哪段时间」。这两组诊断回答的是
 * 同一个问题（「数字是不是少了」），所以保留同样的输出位置与命名风格。
 */
function formatDbDiagnostics(
  dbStats: { events: number; earliest: number | null; latest: number | null; lastIngestMs: number | null } | null,
): string {
  const lines = ['', '=== 本地库诊断 ===']
  if (!dbStats) {
    lines.push('  (库诊断不可用 —— 本次走了直扫日志)')
    return lines.join('\n')
  }
  lines.push(`  库内记录        ${fmtInt(dbStats.events)}`)
  lines.push(`  最早事件        ${fmtTime(dbStats.earliest ?? undefined)}`)
  lines.push(`  最晚事件        ${fmtTime(dbStats.latest ?? undefined)}`)
  lines.push(`  最近入库        ${fmtTime(dbStats.lastIngestMs ?? undefined)}`)
  lines.push('  ⓘ 直扫日志的逐事件诊断请用 --no-db 查看')
  return lines.join('\n')
}

/** provider × model 交叉表。 */
function renderCross(records: UsageRecord[], top: number): string {
  const { primaryKeys, secondaryKeys, cells } = crossTabRanked(records, 'provider', 'model')

  const provTotals = primaryKeys.map((p) => ({
    p,
    total: secondaryKeys.reduce(
      (sum, m) => sum + (cells.get(`${p}\u0000${m}`)?.total ?? 0),
      0,
    ),
  }))

  const shownProv = top > 0 ? provTotals.slice(0, top) : provTotals
  const shownModels = top > 0 ? secondaryKeys.slice(0, top) : secondaryKeys

  // 每个 provider 的「主力模型」可能不在截断后的模型列里，
  // 单独提示一下，避免看不到时误以为该厂商没有用量。
  const hints: string[] = []
  if (top > 0 && secondaryKeys.length > top) {
    for (const { p } of shownProv) {
      const own = secondaryKeys
        .map((m) => ({ m, total: cells.get(`${p}\u0000${m}`)?.total ?? 0 }))
        .filter((x) => x.total > 0)
        .sort((a, b) => b.total - a.total)
      const top1 = own[0]
      if (top1 && !shownModels.includes(top1.m)) {
        hints.push(`  · ${p} 的主力模型是 ${top1.m}（${fmtCompact(top1.total)}），未在上表列中`)
      }
    }
  }

  const body = shownProv.map(({ p, total }) => {
    const row = [p]
    for (const m of shownModels) {
      const cell = cells.get(`${p}\u0000${m}`)
      row.push(cell && cell.total > 0 ? fmtCompact(cell.total) : '-')
    }
    row.push(fmtCompact(total))
    return row
  })

  // 底部合计行
  const footer = ['合计']
  for (const m of shownModels) {
    const sum = provTotals.reduce(
      (acc, { p }) => acc + (cells.get(`${p}\u0000${m}`)?.total ?? 0),
      0,
    )
    footer.push(sum > 0 ? fmtCompact(sum) : '-')
  }
  footer.push(fmtCompact(provTotals.reduce((a, b) => a + b.total, 0)))

  const columns = [
    { title: '厂商 \\ 模型', align: 'left' as const },
    ...shownModels.map((m) => ({
      title: m.length > 24 ? m.slice(0, 23) + '…' : m,
      align: 'right' as const,
    })),
    { title: '合计', align: 'right' as const },
  ]

  const lines = [
    '',
    '=== 厂商 × 模型 交叉表（计费总量，按用量降序）===',
    renderTable(columns, [...body, footer]),
  ]
  if (secondaryKeys.length > shownModels.length) {
    lines.push(`  注：模型列显示前 ${shownModels.length} / 共 ${secondaryKeys.length}，均为用量最大的模型`)
  }
  if (hints.length > 0) lines.push(...hints)

  return lines.join('\n')
}

async function main(): Promise<number> {
  let opts: CliOptions | null
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`错误: ${err.message}\n`)
      return 2
    }
    throw err
  }

  if (!opts) {
    process.stdout.write(HELP)
    return 0
  }

  const paths = resolvePaths(opts.dshHome)
  if (!paths.sessionsRootExists) {
    process.stderr.write(
      `错误: 找不到会话目录 ${paths.sessionsRoot}\n` +
        `请用 --dsh-home 指定，或设置 DSH_HOME 环境变量。\n`,
    )
    return 1
  }

  // --reset-db：清空本地库后立即退出。
  // 与 report 的 --reset 不同：这里删的是「日志的派生物」，
  // 真值仍在磁盘日志里，所以下次运行重建即可，不会丢任何数据。
  if (opts.resetDb) {
    try {
      await resetDb(paths.dbPath)
    } catch (err) {
      process.stderr.write(
        `错误: 删除本地库失败: ${err instanceof Error ? err.message : String(err)}\n` +
          `  库路径 ${paths.dbPath}\n` +
          `  若本地页面/服务仍在运行，请先停止它们再重试。\n`,
      )
      return 1
    }
    process.stdout.write(
      `已删除本地库: ${paths.dbPath}\n` +
        `下次运行会全量重建（数据来自会话日志，不会丢失）。\n`,
    )
    return 0
  }

  // 子命令分派：report 走增量上报，web 起本地服务，都不进入统计流程
  if (opts.command === 'report') {
    return runReportCommand(opts, paths.sessionsRoot)
  }
  if (opts.command === 'web') {
    return runWebCommand(opts, paths)
  }

  let range
  try {
    range = resolveRange({
      since: opts.since,
      until: opts.until,
      last: opts.last,
      period: opts.period,
    })
  } catch (err) {
    if (err instanceof RangeParseError) {
      process.stderr.write(`错误: ${err.message}\n`)
      return 2
    }
    throw err
  }

  const t0 = Date.now()
  let lastRender = 0
  // ★ 默认走本地 SQLite 增量库（`core/db`）：先 ingest 再查，量级从秒降到毫秒。
  //   `--no-db` 强制走直扫日志，用于与库结果做对照验证（两条路径必须给出同一个数）。
  const session = await openStats({
    sessionsRoot: paths.sessionsRoot,
    dbPath: paths.dbPath,
    ...(opts.period ? { period: opts.period } : {}),
    ...(range.sinceMs !== undefined ? { sinceMs: range.sinceMs } : {}),
    ...(range.untilMs !== undefined ? { untilMs: range.untilMs } : {}),
    providers: opts.providers,
    models: opts.models,
    ...(opts.noDb ? { forceScan: true } : {}),
    onProgress: opts.quiet
      ? undefined
      : (done, total) => {
          const now = Date.now()
          if (now - lastRender < 120 && done !== total) return
          lastRender = now
          process.stderr.write(`\r扫描中 ${done}/${total} ...`)
        },
  })
  if (!opts.quiet) process.stderr.write('\r' + ' '.repeat(40) + '\r')

  const elapsed = Date.now() - t0

  // 取数完成后立刻物化，之后统一释放库连接 —— 避免把连接生命周期
  // 拖到整个渲染流程（渲染里还有多轮 aggregate，早关早释放 WAL）
  const records = session.records()
  const total = session.totals()
  // SQL 路径没有「扫描诊断」（本轮的增量诊断在 session 里不含 eventTypes 等
  // 逐事件计数），用空诊断占位 —— 渲染层因此不必到处判空。
  const diagnostics = session.diagnostics ?? emptyDiagnostics()
  const degradedReason = session.degradedReason
  const source = session.source
  const dbStats = session.dbDiagnostics()
  session.close()

  // --list-providers：只报告发现的口径边界
  if (opts.listProviders) {
    const provRows = aggregate(records, 'provider')
    process.stdout.write('\n=== 发现的所有 provider ===\n')
    for (const r of provRows) {
      process.stdout.write(
        `  ${r.key.padEnd(24)} 调用 ${fmtInt(r.counts.calls).padStart(8)}  总量 ${fmtCompact(r.counts.total).padStart(10)}\n`,
      )
    }
    const modelRows = aggregate(records, 'provider-model')
    process.stdout.write('\n=== 发现的所有 provider/model ===\n')
    for (const r of modelRows) {
      process.stdout.write(
        `  ${r.key.padEnd(52)} 调用 ${fmtInt(r.counts.calls).padStart(8)}  总量 ${fmtCompact(r.counts.total).padStart(10)}\n`,
      )
    }
    return 0
  }

  // `total` 已由 session.totals() 取得（四项独立 + calls），此处不再重算

  // JSON 输出：结构化，便于二次处理
  if (opts.format === 'json') {
    const groups: Record<string, unknown> = {}
    for (const dim of opts.by) {
      groups[dim] = aggregate(records, dim).map((r) => ({
        key: r.key,
        total: r.counts.total,
        input: r.counts.input,
        output: r.counts.output,
        cacheRead: r.counts.cacheRead,
        cacheWrite: r.counts.cacheWrite,
        reasoning: r.counts.reasoning,
        calls: r.counts.calls,
        sessions: r.sessions,
        cacheHitRate: r.metrics.cacheHitRate,
        firstTime: r.firstTime,
        lastTime: r.lastTime,
      }))
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      dshHome: paths.dshHome,
      sessionsRoot: paths.sessionsRoot,
      // 数据源与是否降级：脚本消费方据此判断这次数字的可信度与新鲜度
      source,
      dbPath: source === 'sql' ? paths.dbPath : null,
      dbEvents: dbStats?.events ?? null,
      ...(degradedReason ? { degradedReason } : {}),
      range: {
        label: range.label,
        since: range.sinceMs ? new Date(range.sinceMs).toISOString() : null,
        until: range.untilMs ? new Date(range.untilMs).toISOString() : null,
        period: opts.period ?? null,
      },
      filters: { providers: opts.providers, models: opts.models },
      totals: {
        ...total,
        cacheHitRate: derive(total).cacheHitRate,
        cacheLeverage: derive(total).cacheLeverage,
        avgTokensPerCall: derive(total).avgTokensPerCall,
      },
      groups,
      series: opts.series
        ? timeSeries(records, opts.series, false).map((p) => ({
            bucket: p.bucket,
            total: p.counts.total,
            input: p.counts.input,
            output: p.counts.output,
            cacheRead: p.counts.cacheRead,
            calls: p.counts.calls,
            cacheHitRate: p.metrics.cacheHitRate,
            byProvider: Object.fromEntries(
              [...p.byProvider].map(([k, v]) => [k, v.total]),
            ),
          }))
        : undefined,
      diagnostics: {
        filesScanned: diagnostics.filesScanned,
        filesFailed: diagnostics.filesFailed,
        totalEvents: diagnostics.totalEvents,
        usageEvents: diagnostics.usageEvents,
        assistantMessagesWithoutUsage: diagnostics.assistantMessagesWithoutUsage,
        totalTokenMismatches: diagnostics.totalTokenMismatches,
        retryStarted: diagnostics.retryStarted,
        attempts: diagnostics.attempts,
        providersSeen: [...diagnostics.providersSeen].sort(),
        eventTypes: Object.fromEntries(
          [...diagnostics.eventTypes].sort((a, b) => b[1] - a[1]),
        ),
      },
      elapsedMs: elapsed,
    }
    const text = JSON.stringify(payload, null, 2)
    if (opts.out) {
      await writeFile(opts.out, text, 'utf8')
      process.stderr.write(`已写入 ${opts.out}\n`)
    } else {
      process.stdout.write(text + '\n')
    }
    return 0
  }

  // CSV 输出：多维度时用分节，单维度时是干净的表
  if (opts.format === 'csv') {
    const chunks: string[] = []
    for (const dim of opts.by) {
      const rows = topSlice(aggregate(records, dim), opts.top)
      if (opts.by.length > 1) chunks.push(`# dimension: ${dim}`)
      chunks.push(groupRowsToCsv(rows, dim))
    }
    if (opts.series) {
      if (opts.by.length > 1 || chunks.length) chunks.push('')
      chunks.push('# series')
      chunks.push(seriesToCsv(timeSeries(records, opts.series, false)))
    }
    const text = chunks.join('\n')
    if (opts.out) {
      await writeFile(opts.out, text, 'utf8')
      process.stderr.write(`已写入 ${opts.out}\n`)
    } else {
      process.stdout.write(text + '\n')
    }
    return 0
  }

  // 终端表格输出
  const out: string[] = []
  out.push(`DSH token 统计  |  ${describeRangeFull(range)}  |  数据源 ${describeSource(source, paths, dbStats)}`)
  if (source === 'scan' && !opts.noDb) {
    // 降级必须显式告警：用户会明显感觉变慢，不说清原因会被当成「库没生效」
    out.push(`⚠ ${degradedReason ?? '本次走直扫日志'}（用 --no-db 可显式指定）`)
  }
  if (opts.providers.length) out.push(`provider 过滤: ${opts.providers.join(', ')}`)
  if (opts.models.length) out.push(`model 过滤: ${opts.models.join(', ')}`)
  out.push(`耗时 ${elapsed}ms`)

  if (records.length === 0) {
    out.push('')
    out.push('未匹配到任何计费记录。')
    if (!opts.noDiag) {
      out.push(source === 'sql' ? formatDbDiagnostics(dbStats) : formatDiagnostics(diagnostics))
    }
    process.stdout.write(out.join('\n') + '\n')
    return 0
  }

  for (const dim of opts.by) {
    out.push(renderDimension(records, dim, opts.top))
  }

  if (opts.cross) {
    out.push(renderCross(records, opts.top))
  }

  if (opts.series) {
    out.push(formatSeries(timeSeries(records, opts.series, true), `按${opts.series === 'day' ? '天' : '小时'}趋势`))
  }

  if (!opts.noDiag) {
    out.push(formatTotal(total, '总计（当前过滤条件下）'))
    // ⚠️ SQL 路径没有「逐事件扫描诊断」（它读的是库，不是日志），
    //   此时若照常打印会得到一整屏的 0 —— 比不打印更糟：
    //   用户会以为「扫描坏了 / 数据是空的」。改为打印库侧诊断。
    if (source === 'sql') {
      out.push(formatDbDiagnostics(dbStats))
    } else {
      out.push(formatDiagnostics(diagnostics))
    }
  }

  process.stdout.write(out.join('\n') + '\n')
  return 0
}

/**
 * `web` 子命令：起本地页面（内嵌服务 + 自动开浏览器）。
 *
 * ## 为什么本地页要由 CLI 内嵌服务来托管
 *
 * 页面要读的是**本机数据**（会话日志 + 由它派生的本地库），
 * 而浏览器不能直接读文件系统。让 CLI 起一个只监听 `127.0.0.1` 的小服务，
 * 页面就能通过 `/api/local/*` 拿到数据 —— 不出网、不上报、断网可用。
 *
 * 数据源见 `packages/server/src/local-api.ts`：本地 SQLite 增量库，
 * 库不可用时自动降级直扫日志。
 *
 * ## 安全边界
 *
 * **只监听 `127.0.0.1`，不提供改 host 的参数。**
 * 本地接口不做鉴权，因为它只读本机日志、只返回本机数据；
 * 一旦监听在 `0.0.0.0`，同一内网的任何人都能读到你的全部用量与工作目录。
 * 要开放给全组请用部门服务端（`packages/server` 的 `main.ts`）。
 *
 * 退出码：`0` 正常停止；`1` 静态产物缺失或服务启动失败；`2` 参数错误。
 */
async function runWebCommand(opts: CliOptions, paths: ResolvedPaths): Promise<number> {
  // 静态产物缺失时给出可执行的指引，而不是起一个永远空白的页面。
  // 这是「本地页打不开」最常见的真实原因。
  const staticDir = resolveWebLocalDist()
  if (!staticDir) {
    process.stderr.write(
      `错误: 找不到本地页面构建产物。\n` +
        `  已查找: ${candidateDistDirs().join('\n          ')}\n\n` +
        `请先在仓库根目录执行:\n` +
        `  bun run build:local\n\n` +
        `（开发调试时也可以用 ${'`bun run dev:local`'} 起 Vite 开发服务器。）\n`,
    )
    return 1
  }

  let handle: ServerHandle
  try {
    handle = await createServer({
      ...(opts.web.port !== undefined ? { port: opts.web.port } : {}),
      dshHome: paths.dshHome,
      staticDir,
      enableLocalApi: true,
      ...(opts.web.portal ? { portalUrl: opts.web.portal } : {}),
    })
  } catch (err) {
    process.stderr.write(
      `错误: 本地服务启动失败: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const out: string[] = []
  out.push(`本地页面已启动  ${handle.url}`)
  if (handle.portShifted) {
    out.push(`  ⚠ 端口 ${opts.web.port ?? DEFAULT_PORT} 被占用，已改用 ${handle.port}`)
  }
  out.push(`  会话日志  ${paths.sessionsRoot}`)
  out.push(`  本地库    ${paths.dbPath}`)
  out.push(`  页面资源  ${staticDir}`)
  out.push(
    `  署名校验  ${opts.web.portal ?? '未配置（--portal）—— 可看本机统计，但无法保存署名'}`,
  )
  out.push('')
  out.push('  只监听 127.0.0.1，仅本机可访问；数据来自本地库（不联网上报）。')
  out.push('  首次启动需全量建库（约 15 秒），之后每次请求约 50 ms。')
  out.push('  Ctrl+C 停止')
  process.stdout.write(out.join('\n') + '\n')

  if (!opts.web.noOpen) {
    openBrowser(handle.url)
  }

  // 保持进程存活，直到收到中断信号 —— 与部门服务端 `main.ts` 同一形态，
  // 保证 Ctrl+C 时能优雅停机而不是把端口留在 TIME_WAIT 里。
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      process.stdout.write('\n正在停止本地服务...\n')
      await handle.stop()
      resolve()
    }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
  })

  return 0
}

/**
 * 候选的 web-local 构建产物目录。
 *
 * 需要同时覆盖两种布局，因为同一份代码有两种跑法：
 *
 * | 场景 | 本文件位置 | 页面资源位置 |
 * |---|---|---|
 * | 仓库内（源码/开发） | `packages/cli/src/cli.ts` | `packages/web-local/dist` |
 * | **npm 安装后**（发布形态） | `<pkg>/cli.js` | `<pkg>/web-local` |
 *
 * ★ 发布形态把页面资源**内嵌在包里**（`build-npm.ts` 会把
 *   `packages/web-local/dist` 整个拷进产物目录）。这样 `npm i -g` 之后
 *   `dsh-token-report web` 不需要用户再去 clone 仓库构建前端 ——
 *   否则「本地页面」这个子命令对 npm 用户就是不可用的。
 */
function candidateDistDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // npm 包内：<pkg>/cli.js → <pkg>/web-local
    resolve(here, 'web-local'),
    // 仓库内：packages/cli/src/ → packages/web-local/dist
    resolve(here, '..', '..', 'web-local', 'dist'),
    // 以 cwd 为仓库根时（手工在仓库根执行）
    resolve(process.cwd(), 'packages', 'web-local', 'dist'),
  ]
}

/** 找到第一个存在的构建产物目录；都没有则返回 null。 */
function resolveWebLocalDist(): string | null {
  for (const dir of candidateDistDirs()) {
    // 必须同时有 index.html —— 只有目录不足以证明构建成功
    if (existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

/**
 * 用系统默认浏览器打开 URL（best-effort）。
 *
 * 打不开不算错误：用户完全可以自己复制上面打印的地址。
 * 因此这里**只告警不返回失败**，也不 await（避免拖慢启动）。
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]

  try {
    const child = spawn(cmd[0] as string, cmd[1] as string[], {
      detached: true,
      stdio: 'ignore',
      // Windows 下 cmd 的 start 需要 shell 语义，但 detached 已足够隔离
      shell: process.platform === 'win32',
    })
    child.on('error', () => {
      process.stderr.write(`⚠ 无法自动打开浏览器，请手动访问 ${url}\n`)
    })
    child.unref()
  } catch {
    process.stderr.write(`⚠ 无法自动打开浏览器，请手动访问 ${url}\n`)
  }
}

function topSlice<T>(rows: T[], top: number): T[] {
  return top > 0 ? rows.slice(0, top) : rows
}

/**
 * `report` 子命令：一轮增量上报。
 *
 * 退出码约定（供计划任务判断）：
 * - `0` 成功（含 dry-run、以及本轮无新增）
 * - `2` 参数错误
 * - `3` 投递失败（pending 已保留，下一轮会重试）
 */
async function runReportCommand(opts: CliOptions, sessionsRoot: string): Promise<number> {
  const r = opts.report
  const statePath = r.statePath ?? resolveStatePath(opts.dshHome)

  // --reset：清空水位线后立即退出
  if (r.reset) {
    resetState(statePath)
    process.stdout.write(
      `已重置上报状态: ${statePath}\n` +
        `下次运行会全量重扫全部会话（服务端按 event_id 幂等，重复投递无害）。\n`,
    )
    return 0
  }

  // 身份三级回退（docs/插件方案.md §9 方案 A）：显式参数 > 环境变量。
  // 第三级（~/.dsh/token-report-user.json）留给安装脚本，此处只做前两级。
  const userId = r.userId ?? process.env['DSH_REPORT_USER_ID']
  const userName = r.userName ?? process.env['DSH_REPORT_USER_NAME']
  const dept = r.dept ?? process.env['DSH_REPORT_DEPT']

  // 没有投递目标就等价于干跑：不会静默什么都不做
  const dryRun = r.dryRun || r.noSave || (!r.endpoint && !r.outFile)

  let deliver
  if (!dryRun) {
    if (r.outFile) {
      deliver = createFileDeliverer(r.outFile)
    } else if (r.endpoint) {
      deliver = createHttpDeliverer({
        endpoint: r.endpoint,
        token: r.token ?? process.env['DSH_REPORT_TOKEN'],
        timeoutMs: r.timeoutMs,
        userId,
        userName,
        dept,
      })
    }
  }

  const t0 = Date.now()
  let lastRender = 0
  let result: RunReportResult
  try {
    result = await runReport({
      sessionsRoot,
      dshHome: opts.dshHome,
      statePath,
      deliver,
      dryRun: r.dryRun,
      noSave: r.noSave,
      onProgress: opts.quiet
        ? undefined
        : (done, total) => {
            const now = Date.now()
            if (now - lastRender < 120 && done !== total) return
            lastRender = now
            process.stderr.write(`\r扫描中 ${done}/${total} ...`)
          },
    })
  } catch (err) {
    process.stderr.write(`上报失败: ${err instanceof Error ? err.message : String(err)}\n`)
    return 3
  }
  if (!opts.quiet) process.stderr.write('\r' + ' '.repeat(40) + '\r')

  const elapsed = Date.now() - t0
  const out: string[] = []

  if (result.stateNote) out.push(`⚠ ${result.stateNote}`)
  if (dryRun) {
    out.push(
      r.noSave
        ? '【只看不改】未写入状态文件，本轮结果可重复复现'
        : '【干跑】已落盘 pending，未投递',
    )
  }

  out.push(`状态文件  ${result.statePath}`)
  out.push(
    `会话文件  ${result.scan.files.length} 个（未变化跳过 ${result.scan.skippedUnchanged} 个，实际解压 ${result.scan.diagnostics.filesScanned} 个）`,
  )
  if (result.scan.filteredBySeq > 0) {
    out.push(`⚠ 事件级水位线过滤 ${result.scan.filteredBySeq} 条（帧边界偏差时的兜底，通常为 0）`)
  }
  out.push(`耗时      ${elapsed}ms`)

  const c = result.counts
  out.push('')
  if (result.records.length === 0) {
    out.push('本轮无新增记录（水位线已是最新）。')
  } else {
    out.push(`本轮新增  ${fmtInt(c.calls)} 条记录`)
    out.push(`  未缓存输入  ${fmtInt(c.input)}`)
    out.push(`  输出        ${fmtInt(c.output)}`)
    out.push(`  缓存读      ${fmtInt(c.cacheRead)}`)
    out.push(`  计费总量    ${fmtInt(c.total)}`)
    const denom = c.cacheRead + c.input
    if (denom > 0) {
      out.push(`  缓存命中率  ${((c.cacheRead / denom) * 100).toFixed(1)}%`)
    }

    const byProv = aggregate(result.records, 'provider')
    out.push('')
    out.push('  按 provider：')
    for (const row of byProv.slice(0, 10)) {
      out.push(
        `    ${row.key.padEnd(24)} ${fmtInt(row.counts.calls).padStart(6)} 条  ${fmtCompact(row.counts.total).padStart(10)}`,
      )
    }
  }

  if (result.delivered) {
    const d = result.delivered
    out.push('')
    out.push(`投递结果  接受 ${d.accepted}，重复 ${d.duplicates}，拒收 ${d.rejected}`)
  }

  out.push('')
  out.push(
    `累计已投递 ${fmtInt(result.after.totalDelivered)} 条` +
      (result.pendingRemaining > 0 ? `，待投递 ${fmtInt(result.pendingRemaining)} 条` : ''),
  )

  process.stdout.write(out.join('\n') + '\n')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`未处理的错误: ${err instanceof Error ? err.stack : String(err)}\n`)
    process.exitCode = 1
  })