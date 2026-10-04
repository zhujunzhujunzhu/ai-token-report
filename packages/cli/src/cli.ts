#!/usr/bin/env bun
/**
 * ai-token-report —— AI token 用量统计 CLI。
 *
 * 数据源：`$DSH_HOME/sessions/**\/session*.jsonl.zstd` 中的 `assistant/message` 事件。
 * 只有该事件的 `data.usage` 是 provider 真实上报的计费级数据。
 */

import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ServerHandle } from '@ai-token-report/server'

import {
  aggregate,
  crossTabRanked,
  timeSeries,
  type GroupDimension,
  type GroupRow,
  type SeriesPoint,
} from '@ai-token-report/core'
import type { RunReportResult } from './report.js'
import { readIdentity, resetState, resolveStatePath } from '@ai-token-report/core'
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
import {
  discoverDshHomesDetailed,
  envFlagOff,
  inspectSessionRoots,
  registeredSources,
  resolvePaths,
  resolveSessionsRoots,
  resolveSourceRoots,
  splitHomeList,
  type ResolvedPaths,
  type SessionSource,
  type SourceRoot,
} from '@ai-token-report/core'
import {
  RangeError as RangeParseError,
  PERIOD_NAMES,
  describeRangeFull,
  resolvePeriod,
  resolveRange,
} from '@ai-token-report/core'
import { openStats, resetDb } from '@ai-token-report/core/db'
import {
  costByGroupOf,
  costTotalsOf,
  loadLocalPricing,
  priceResolver,
  unpricedTargetsOf,
  type CostTotals,
} from '@ai-token-report/core/db'
import { derive, emptyDiagnostics, type UsageRecord } from '@ai-token-report/core'
import {
  costCsvSections,
  costJsonPayload,
  renderCostSection,
  type CostView,
} from './cost-view.js'
import { PRICING_SYNC_USAGE, syncPricing } from './pricing-sync.js'
// 身份兼容归一（`group ?? dept`）只在 shared 里实现一次，这里只调用它。
import { toAssertion } from '@ai-token-report/shared'

const HELP = `
ai-token-report —— AI token 用量统计

用法:
  ai-token-report [选项]
  ai-token-report web [选项]          起本地页面（内嵌服务 + 自动开浏览器）
  ai-token-report report [选项]      增量上报（每 10 分钟由计划任务调用）
  ai-token-report pricing sync [选项]  拉取部门服务端的单价快照到本地

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

费用（估算，**默认关**）:
  --cost           把金额一并算出来。**默认关**：不开时输出里一位金额都没有。
                   金额是**估算，不是财务账单** —— 它按单价表逐条事件现算，
                   不含折扣 / 预付 / 赠送额度，因此不会等于财务对账的数字。
                   单价来自 <data-dir>/pricing.json 快照，用
                   'ai-token-report pricing sync' 从部门服务端拉。**没有快照时
                   一位金额都不显示**（如实标成「未计价」）—— 本仓没有内置价目表。
                   未配单价的用量一律计入「未计价」，绝不当作 0 元。
  --pricing-file <p>  指定单价快照文件（默认 <data-dir>/pricing.json）

数据源:
  默认读本地 SQLite 增量库（缺省 ~/.ai-token-report/usage.sqlite，
  可用 --data-dir 或 DSH_TOKEN_REPORT_DATA_DIR 覆盖），
  每次请求先做增量入库再查库 —— 热态约 10ms，冷态首次约 15 秒
  （需全量解析历史日志以建库）。
  --no-db          强制直扫日志，不走库（用于与库结果对照验证）
  --reset-db       删除本地库后退出；下次运行全量重建（不丢数据）

── 本地页面 web ────────────────────────────────────────
  起一个只监听 127.0.0.1 的本地服务并打开浏览器。数据来自**本地 SQLite
  增量库**（缺省 ~/.ai-token-report/usage.sqlite，
  可用 --data-dir 或 DSH_TOKEN_REPORT_DATA_DIR 覆盖），每次请求先增量入库再查，
  热态约 50ms；**不出网、不上报、断网可用**。

  首次启动会全量建库（约 15 秒，需解析历史日志），之后都是毫秒级。

  服务对象是「我自己」：页面上看到的数与你执行 ai-token-report --period X
  完全一致 —— 两者走同一个数据源与同一套口径公式。

  --port <n>       监听端口 (默认 8787，被占用自动 +1)
  --portal <url>   部门服务端**根地址**（如 http://host:8787）；作为页面「配置」弹框的缺省地址
                   （页面里填过的那份优先；两处都没有时页面会要求用户填）
  --no-open        不自动打开浏览器

── 增量上报 report ──────────────────────────────────────
  只上报自上次以来【新增】的计费记录, 靠状态文件里的三层水位线
  (文件大小 / zstd 帧数 / 事件 seq)。首次运行会全量重扫以建立基线。

  --dry-run        扫描并落盘 pending, 但不投递 (调试首选)
  --endpoint <url> 后台接收地址, 如 https://portal/api/v1/token-usage
  --token <t>      鉴权 token；默认读取 DSH_REPORT_TOKEN 或共享 identity.json
  --out-file <f>   不联网, 把记录追加到本地 JSONL (端到端演练)
  --no-save        只看不改: 不写状态文件 (纯观察增量)
  --state <p>      状态文件路径 (默认 <data-dir>/state.json)
  --reset          清空水位线后退出, 下次全量重扫
  --timeout <ms>   单次请求超时 (默认 15000)
  --user-id <id>   客户端标识（归属由服务端按 token 决定）
  --user-name <n>  显示名; 也可用 env DSH_REPORT_USER_NAME
  --group <g>      分组; 也可用 env DSH_REPORT_GROUP

  未署名时跳过采集和上报。可先在本地页面署名，或显式提供 token。
  --dry-run / --no-save / --out-file 是主动的本地演练，无需署名。

── 同步单价 pricing sync ───────────────────────────────
  从部门服务端拉一份**只读单价快照**落到本地数据目录；之后 CLI 的 --cost、
  本地页与插件宿主都按这份快照算金额（与看板同源）。

  ai-token-report pricing sync --portal <url> --token <token>

  --portal <url>   部门服务端**根地址**（如 http://host:8787），与 web 的 --portal 同一语义
  --token <t>      带 cost:read 的凭证：appKey（插件 / CLI 上报用的那把）也带这个范围，
                   或后台账号签发的专用只读凭证

  拉取 GET <portal>/api/v1/stats/pricing（门是 cost:read）。appKey 从 2026-10 起
  也带 cost:read（插件面板要按线上那份价算金额），所以它也能跑这条命令。
  失败分类: 缺参数 / 地址非法 → 退出码 2；401 / 403 / 网络或响应异常 → 1

其他:
  --dsh-home <p>   指定 DSH home（会话日志从哪读）;**可重复**以统计多套 DSH
  --dsh-homes <p>  一次给多个 home，用系统路径分隔符分隔 (Windows ';' / POSIX ':')
  --discover       只打印发现了哪些 home（含会话数 / 最新写入）后退出
  --data-dir <p>   指定数据目录: 身份 / 本地库 / 上报水位 (默认 ~/.ai-token-report)
  --list-providers 只列出发现的所有 provider/model 后退出
  -h, --help       显示帮助

其他客户端（Codex / Claude Code / Trae / WorkBuddy）:
  --source <id>    只统计这些来源（dsh / codex / claude-code / trae / trae-cn / workbuddy；
                   可重复或逗号分隔，all = 全部）。
                   **缺省统计全部已注册来源**（想只看 DSH 就 --source dsh；本机存在别的客户端时，
                   多出来的来源会逐项出现在输出与诊断里，绝不静默并进总量）
                   ⚠️ 环境开关（下面那几行）在**缺省**时才生效；显式给了 --source 就以它为准
  --codex-home <p> 指定 Codex home（默认 $CODEX_HOME > ~/.codex）;**可重复**
  --claude-home <p> 指定 Claude Code 配置目录（默认 $CLAUDE_CONFIG_DIR > ~/.claude）;**可重复**
  --trae-home <p>  指定 Trae 用户数据目录（国际版，默认 %APPDATA%/Trae 等）;**可重复**
  --trae-cn-home <p> 指定 Trae CN 用户数据目录（国内版，默认 %APPDATA%/TraeCN 等）;**可重复**
  --workbuddy-home <p> 指定 WorkBuddy 配置目录（默认 $WORKBUDDY_CONFIG_DIR > ~/.workbuddy）;**可重复**
  --no-codex       本次不统计 Codex（等价于把它从 --source all 里去掉）
  --no-claude-code 本次不统计 Claude Code
  --no-trae        本次不统计 Trae（国际版）
  --no-trae-cn     本次不统计 Trae CN（国内版）
  --no-workbuddy   本次不统计 WorkBuddy
  环境开关: DSH_TOKEN_REPORT_CODEX=0 / DSH_TOKEN_REPORT_CLAUDE=0
            / DSH_TOKEN_REPORT_TRAE=0 / DSH_TOKEN_REPORT_TRAE_CN=0
            / DSH_TOKEN_REPORT_WORKBUDDY=0
  多根: DSH_TOKEN_REPORT_CODEX_HOMES / DSH_TOKEN_REPORT_CLAUDE_HOMES
        / DSH_TOKEN_REPORT_TRAE_HOMES / DSH_TOKEN_REPORT_TRAE_CN_HOMES
        / DSH_TOKEN_REPORT_WORKBUDDY_HOMES

  ⚠️ Trae 的国际版与国内版是**两个来源**（两套安装 / 账号 / 模型族），
     目录名推不出对方（家目录 '.trae' vs '.trae-cn'，用户数据目录 Trae vs TraeCN），
     两个都按平台约定目录自动解析；合并统计请显式 --source trae --source trae-cn

  不给 --dsh-home 时**自动发现**本机所有 DSH：$DSH_HOME + ~/.dsh + ~/.dsh*
  + 各平台应用数据目录下的客户端目录（例如第三方 dsh-desktop 的 harness），
  只收有 sessions 的那个。关闭发现: DSH_TOKEN_REPORT_DISCOVER=0

示例:
  ai-token-report --period today                # 今天
  ai-token-report --period week --series day    # 本周 + 每日趋势
  ai-token-report --provider dashscope --period month   # 数字集团本月
  ai-token-report --by provider --cross         # 全量按厂商
  ai-token-report --list-providers              # 先摸清有哪些厂商
  ai-token-report --discover                    # 看本机有哪些 DSH home
  ai-token-report --dsh-home ~/.dsh --dsh-home "$env:APPDATA/dsh-desktop/harness"
  ai-token-report --format csv --out report.csv
  ai-token-report --period today --no-db        # 直扫日志（与库结果对照）

  ai-token-report --source all --by source      # 多客户端：DSH + Codex + Claude Code + Trae + WorkBuddy
  ai-token-report --source claude-code --by model   # 只看 Claude Code
  ai-token-report --source trae --source trae-cn --by source   # Trae 国际版 + 国内版
  ai-token-report --source workbuddy --by model      # 只看 WorkBuddy

  ai-token-report web                           # 本地页面（推荐入口）
  ai-token-report web --no-open --port 8899     # 指定端口、不开浏览器

  ai-token-report report --dry-run              # 看这一轮会发什么
  ai-token-report report --no-save --dry-run    # 只看不改
  ai-token-report report --out-file out.jsonl   # 落本地文件演练
  ai-token-report report --endpoint https://portal/api/v1/token-usage --token $env:DSH_REPORT_TOKEN
  ai-token-report report --reset                # 清空水位线

  ai-token-report pricing sync --portal http://portal:8787 --token $env:ATR_COST_TOKEN
  ai-token-report --period month --cost         # 本月用量 + 金额（估算）
`

interface CliOptions {
  by: GroupDimension[]
  /** `--by` 是否由使用者显式给出（决定多来源时要不要把 `provider-model` 升级成带来源的维度）。 */
  byExplicit?: boolean
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
  /**
   * `--cost`：把金额一并算出来。**默认关**。
   *
   * 关着的时候输出里一位金额都没有，而且**连金额都不算**（`core/db` 的计价函数
   * 一次都不调用）——「算了再丢掉」在输出上看起来完全一样，但它让一次普通统计
   * 白白物化全部记录。金额是估算，不是财务账单。
   */
  cost: boolean
  /** `--pricing-file`：单价快照路径（缺省 `<data-dir>/pricing.json`）。 */
  pricingFile?: string
  /**
   * 部门服务端**根地址**。
   *
   * `web` 与 `pricing sync` 共用同一个 `--portal`，语义也必须一致：
   * 都是「根地址」，路径由各自的调用方拼（`/api/v1/identity/verify`、`/api/v1/stats/pricing`）。
   */
  portal?: string
  /**
   * 凭证（裸 token 或 `Bearer xxx`）。
   *
   * `report` 与 `pricing sync` 共用：两处都是「拿它去服务端证明自己是谁」。
   * 刻意只留这一个字段，不让每条子命令各存一份 —— 那会出现「`--token` 只对其中
   * 一个子命令生效」这种要读代码才知道的行为。
   */
  token?: string
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
  /**
   * ★ DSH home 列表（会话日志从哪读）。
   *
   * `--dsh-home` 可重复，`--dsh-homes` 一次给多个（用系统路径分隔符）。
   * 都不给则**自动发现**：`$DSH_HOME` + `~/.dsh` + 家目录下 `.dsh*`
   * + 各平台应用数据目录里形如 DSH home 的客户端目录（筛掉没有 `sessions` 的）。
   * 关掉发现用 `DSH_TOKEN_REPORT_DISCOVER=0`。
   */
  dshHomes?: string[]
  /**
   * ★ 只启用这些**来源**（`dsh` / `codex` / `claude-code` / `workbuddy` / `trae` /
   * `trae-cn`）。
   *
   * 缺省 = 全部已注册且未被开关关闭的来源（Codex 用 `DSH_TOKEN_REPORT_CODEX=0` 关，
   * Claude Code 用 `DSH_TOKEN_REPORT_CLAUDE=0` 关，WorkBuddy 用
   * `DSH_TOKEN_REPORT_WORKBUDDY=0` 关）。
   * 给了未注册的来源会**明确报错**：安静地统计出 0 条，看起来与
   * 「这台机器没用过那个客户端」一模一样，而两者的处置完全不同。
   */
  sources?: string[]
  /**
   * 各来源的**显式 home 列表**（键是来源 id）。
   *
   * `--dsh-home` / `--codex-home` / `--claude-home` / `--trae-home` /
   * `--trae-cn-home` / `--workbuddy-home` 均可重复，`--*-homes`
   * 一次给多个（用系统路径分隔符）。缺某一个键 = 该来源按自己的默认规则解析
   * （环境变量 > 约定目录）。
   *
   * ★ 用**一张表**而不是每加一个来源就加一个字段：取值处若各写一遍，
   *   新增来源时必然漏掉某一处，而症状是「`--claude-home` 明明给了却没生效」——
   *   数字只是**沉默地**来自缺省目录。
   */
  sourceHomes: Partial<Record<SessionSource, string[]>>
  /** `--no-codex`：本次不统计 Codex（等价于把它从来源里去掉）。 */
  noCodex?: boolean
  /** `--no-claude-code`：本次不统计 Claude Code（等价于把它从来源里去掉）。 */
  noClaudeCode?: boolean
  /** `--no-trae`：本次不统计 Trae（国际版）。 */
  noTrae?: boolean
  /** `--no-trae-cn`：本次不统计 Trae CN（国内版）。 */
  noTraeCn?: boolean
  /** `--no-workbuddy`：本次不统计 WorkBuddy。 */
  noWorkbuddy?: boolean
  /** `--discover`：只打印发现了哪些 home（含会话数与最新写入）后退出。 */
  discover?: boolean
  /**
   * 数据目录：身份 / 本地库 / 上报水位都放这里。
   *
   * 缺省 `~/.ai-token-report`（**与 home 列表无关**）—— 所以同一台机器上的
   * DSH Desktop 与命令行版自动共用同一份身份与本地库，见 `core/src/home.ts`。
   * ⚠️ 多根统计共用**一份**库：库只有一份，统计才可能是一份并集。
   */
  dataDir?: string
  listProviders: boolean
  /** 子命令：`report` / `web` / `pricing` 时走各自流程而非统计。 */
  command?: 'report' | 'web' | 'pricing'
  report: ReportOptions
  web: WebOptions
}

interface WebOptions {
  /** 监听端口。默认 8787；被占用时自动 +1。 */
  port?: number
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
  /** 不联网，把记录追加到本地 JSONL（端到端演练）。 */
  outFile?: string
  timeoutMs: number
  userId?: string
  userName?: string
  /** 分组名（原 `dept`）：随上报体一起发，仅作服务端侧的文本快照。 */
  group?: string
  statePath?: string
}

/**
 * `--by` 的白名单 —— **刻意不含 `group`**。
 *
 * `shared` 的 `GroupBy`（上报库/看板用）新增了 `'group'` 维度，但那是**服务端**
 * 才有的归属维度：本机日志里根本没有归属字段，本机库 `usage.sqlite` 也不存分组。
 * 把它放进这里，用户会得到一个恒为「未分组」的选项 —— 那不是数据缺失的提示，
 * 而是一个看起来正常却毫无意义的排行。
 *
 * 维度集合的真源是 `core/aggregate.ts` 的 `GroupDimension`（直扫日志的内存聚合），
 * 所以这里不需要再手工维护白名单。
 */
const VALID_DIMS: GroupDimension[] = [
  'source',
  'provider',
  'model',
  'provider-model',
  'source-provider-model',
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
    cost: false,
    noDiag: false,
    quiet: false,
    noDb: false,
    resetDb: false,
    listProviders: false,
    sourceHomes: {},
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
  // 保持 `ai-token-report [选项]` 的既有用法完全不变。
  // 同时兼容 `--web` 这种历史写法（package.json 的 web 脚本就是这么调的）。
  if (argv[0] === 'report') {
    opts.command = 'report'
    argv = argv.slice(1)
  } else if (argv[0] === 'web') {
    opts.command = 'web'
    argv = argv.slice(1)
  } else if (argv[0] === 'pricing') {
    // `pricing` 后面**必须**跟子命令。目前只有 `sync`：多一个取值就得多一套语义，
    // 而「pricing 后面什么都不给」与「拼错了 sync」都只该得到一个用法提示。
    opts.command = 'pricing'
    argv = argv.slice(1)
    const sub = argv[0]
    // `-h` 与全局 `-h` 一致：打印帮助、退出码 0（不是「参数错误」）。
    if (sub === '-h' || sub === '--help') return null
    // 后面直接跟 flag（`pricing --data-dir x`）算「没给子命令」而不是「子命令叫 --data-dir」：
    // 后者会打出一句让人去找 `--data-dir` 是什么意思的报错。
    if (sub === undefined || sub.startsWith('-')) {
      throw new UsageError('`pricing` 需要一个子命令。\n\n' + PRICING_SYNC_USAGE)
    }
    if (sub !== 'sync') {
      throw new UsageError(`未知的 pricing 子命令 "${sub}"。目前只有 sync。\n\n` + PRICING_SYNC_USAGE)
    }
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
        opts.token = takeValue(i, arg)
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
      case '--group':
        opts.report.group = takeValue(i, arg)
        i++
        break
      case '--state':
        opts.report.statePath = takeValue(i, arg)
        i++
        break
      // ── web 子命令专用 ─────────────────────────────────────────────────
      // `--web` 等价于 `web` 子命令：package.json 的 web 脚本用的是这种写法，
      // 手工敲 `ai-token --web` 也很常见，两者都要认。
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
        opts.portal = takeValue(i, arg)
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
        opts.byExplicit = true
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
      // ── 费用（估算）─────────────────────────────────────────────────────
      case '--cost':
        opts.cost = true
        break
      case '--pricing-file':
        opts.pricingFile = takeValue(i, arg)
        i++
        break
      case '--dsh-home': {
        // ★ 可重复：多套 DSH 并存时逐个累加（`--dsh-home A --dsh-home B`）。
        //   刻意不做「最后一次覆盖」——那会让多根统计在命令行上无法表达。
        const value = takeValue(i, arg)
        opts.dshHomes = [...(opts.dshHomes ?? []), value]
        opts.sourceHomes.dsh = [...(opts.sourceHomes.dsh ?? []), value]
        i++
        break
      }
      case '--dsh-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--dsh-homes 没有给出任何有效路径')
        opts.dshHomes = [...(opts.dshHomes ?? []), ...parts]
        opts.sourceHomes.dsh = [...(opts.sourceHomes.dsh ?? []), ...parts]
        i++
        break
      }
      case '--discover':
        opts.discover = true
        break
      // ── 来源选择（多客户端：dsh / codex / …）──────────────────────────
      case '--source': {
        // 可重复，也接受逗号分隔：`--source codex --source dsh` / `--source codex,dsh`
        // `all` = 全部已注册来源。
        const parts = takeValue(i, arg).split(',').map((part) => part.trim()).filter((part) => part !== '')
        if (parts.length === 0) throw new UsageError('--source 没有给出任何来源')
        const known = registeredSources().map((adapter) => adapter.id)
        for (const part of parts) {
          // 未注册的来源必须在**参数层**就失败：安静地统计出 0 条，看起来与
          // 「这台机器没用过那个客户端」一模一样，而两者的处置完全不同。
          if (part !== 'all' && !known.includes(part as SessionSource)) {
            throw new UsageError(`未注册的来源：${part}（已支持：${known.join(' / ')}；用 all 表示全部）`)
          }
        }
        opts.sources = [...(opts.sources ?? []), ...parts]
        i++
        break
      }
      // ── 来源目录：`--<来源>-home`（可重复）/ `--<来源>-homes`（一次给多个）──
      case '--codex-home': {
        opts.sourceHomes.codex = [...(opts.sourceHomes.codex ?? []), takeValue(i, arg)]
        i++
        break
      }
      case '--codex-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--codex-homes 没有给出任何有效路径')
        opts.sourceHomes.codex = [...(opts.sourceHomes.codex ?? []), ...parts]
        i++
        break
      }
      case '--claude-home': {
        opts.sourceHomes['claude-code'] = [...(opts.sourceHomes['claude-code'] ?? []), takeValue(i, arg)]
        i++
        break
      }
      case '--claude-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--claude-homes 没有给出任何有效路径')
        opts.sourceHomes['claude-code'] = [...(opts.sourceHomes['claude-code'] ?? []), ...parts]
        i++
        break
      }
      case '--trae-home': {
        opts.sourceHomes.trae = [...(opts.sourceHomes.trae ?? []), takeValue(i, arg)]
        i++
        break
      }
      case '--trae-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--trae-homes 没有给出任何有效路径')
        opts.sourceHomes.trae = [...(opts.sourceHomes.trae ?? []), ...parts]
        i++
        break
      }
      case '--trae-cn-home': {
        opts.sourceHomes['trae-cn'] = [...(opts.sourceHomes['trae-cn'] ?? []), takeValue(i, arg)]
        i++
        break
      }
      case '--trae-cn-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--trae-cn-homes 没有给出任何有效路径')
        opts.sourceHomes['trae-cn'] = [...(opts.sourceHomes['trae-cn'] ?? []), ...parts]
        i++
        break
      }
      case '--workbuddy-home': {
        opts.sourceHomes.workbuddy = [...(opts.sourceHomes.workbuddy ?? []), takeValue(i, arg)]
        i++
        break
      }
      case '--workbuddy-homes': {
        const parts = splitHomeList(takeValue(i, arg))
        if (parts.length === 0) throw new UsageError('--workbuddy-homes 没有给出任何有效路径')
        opts.sourceHomes.workbuddy = [...(opts.sourceHomes.workbuddy ?? []), ...parts]
        i++
        break
      }
      case '--no-codex':
        opts.noCodex = true
        break
      case '--no-claude-code':
        opts.noClaudeCode = true
        break
      case '--no-trae':
        opts.noTrae = true
        break
      case '--no-trae-cn':
        opts.noTraeCn = true
        break
      case '--no-workbuddy':
        opts.noWorkbuddy = true
        break
      case '--data-dir':
        opts.dataDir = takeValue(i, arg)
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
function renderDimension(rows: GroupRow[], dim: GroupDimension, top: number): string {
  const shown = top > 0 ? rows.slice(0, top) : rows
  const suffix = top > 0 && rows.length > top ? `（共 ${rows.length} 组，显示前 ${top}）` : ''
  const label = dimLabel(dim)
  // 来源进分组键的维度 ⇒ 表格多一列「来源」（键的首段就是它，见 `groupKey()`）；
  // 既然来源已经单列，分组列就不再重复那个前缀。
  const sourceOf = dim === 'source' || dim === 'source-provider-model'
    ? (row: GroupRow) => row.key.split('/')[0]!
    : undefined
  const labelOf = dim === 'source-provider-model'
    ? (row: GroupRow) => row.key.split('/').slice(1).join('/')
    : undefined
  return formatGroupTable(shown, `${label}${suffix}`, sourceOf, labelOf)
}

function dimLabel(dim: GroupDimension): string {
  switch (dim) {
    case 'source':
      return '按来源 (source)'
    case 'provider':
      return '按厂商 (provider)'
    case 'model':
      return '按模型 (model)'
    case 'provider-model':
      return '按厂商 / 模型 (provider/model)'
    case 'source-provider-model':
      return '按来源 / 厂商 / 模型 (source/provider/model)'
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
 * 终端表格实际使用的维度。
 *
 * ★ 多来源（DSH + Codex + …）时把默认的 `provider-model` 换成
 *   `source-provider-model`：否则同一行会**混两个来源的数字**，
 *   而这一行里没有任何一列能说明「这个数字是谁的」——
 *   把两个来源并成一行是**信息被销毁**，不是「看得更简洁」。
 *
 * 单来源时保持 `provider-model` 不动：那时来源恒为同一个值，
 * 多一列只是噪音，而「命令行输出无谓变化」本身也是一种成本。
 */
function terminalDimensions(by: GroupDimension[], sources: readonly string[]): GroupDimension[] {
  if (sources.length <= 1) return by
  return by.map((dim) => (dim === 'provider-model' ? 'source-provider-model' : dim))
}

/**
 * `--discover`：打印本机发现了哪些 DSH home。
 *
 * 给两组信息，回答的是两个不同的问题：
 *
 * - **自动发现的结果**（含会话数 / 最新写入）——「本机有哪些 DSH」，
 *   用来把候选写进 `DSH_TOKEN_REPORT_DSH_HOMES` 固定下来；
 * - **本次配置实际生效的根** —— 「这次统计究竟读了哪几处」。
 *
 * 两者在多根场景下**可能不同**（例如显式配了单根、或关掉了发现），
 * 打在一起才不会让人把「配了什么」与「读了什么」混为一谈。
 */
async function printDiscover(paths: ResolvedPaths, opts: CliOptions): Promise<number> {
  const report = discoverDshHomesDetailed()
  const inspections = await inspectSessionRoots(resolveSessionsRoots(report.homes))

  const lines: string[] = ['', '=== 自动发现的 DSH home ===']
  if (inspections.length === 0) lines.push('  (没有发现含 sessions 目录的 home)')
  for (const info of inspections) {
    lines.push(
      `  [${info.exists ? '✓' : '✗'}] ${info.root}`,
      `        会话 ${fmtInt(info.sessions)} / 日志 ${fmtInt(info.files)} / 最新写入 ${
        info.latestMs === null ? '-' : fmtTime(info.latestMs)}`,
    )
    if (info.error) lines.push(`        ⚠ ${info.error}`)
  }
  lines.push(`  共考察 ${fmtInt(report.considered)} 个候选目录`)

  if (report.suspicious.length > 0) {
    lines.push('', '  名字不像 DSH 客户端、但结构像 home 的目录（**未自动采用**）:')
    for (const item of report.suspicious) lines.push(`    ${item}`)
  }

  lines.push('', '=== 本次配置实际生效 ===')
  for (const info of paths.sessionRoots) lines.push(`  [${info.exists ? '✓' : '✗'}] ${info.root}`)
  lines.push(
    `  数据目录（多根共用一份）  ${paths.dataDir}`,
    '',
    '  固定统计范围: --dsh-home <p>（可重复）或 DSH_TOKEN_REPORT_DSH_HOMES',
    '  关闭自动发现: DSH_TOKEN_REPORT_DISCOVER=0',
  )

  // ★ 其它来源（Codex / Claude Code 等）也要逐个根报出来：多来源下
  //   「我加了 --claude-home 数字没变」必须能分辨是「镜像去重」「目录不存在」
  //   还是「来源没被选中」—— 三者在这个命令的输出里必须长得不一样。
  lines.push('', '=== 其它来源 ===')
  const otherRoots = resolveSourceRoots({
    sources: registeredSources().map((adapter) => adapter.id).filter((id) => id !== 'dsh'),
    homes: opts.sourceHomes,
  })
  if (otherRoots.roots.length === 0 && otherRoots.missing.length === 0 && otherRoots.disabled.length === 0) {
    lines.push('  (没有发现其它来源的日志目录)')
  }
  for (const root of otherRoots.roots) {
    // ★ 巡检走这个来源**自己的**实现（拿 DSH 的巡检去数 Codex 的日期目录会报 0/0）。
    const adapter = registeredSources().find((item) => item.id === root.source)
    const info = adapter?.inspect === undefined ? null : await adapter.inspect(root)
    lines.push(
      `  [✓] [${root.source}] ${root.path}${root.secondary ? '（次要副本）' : ''}`,
      info === null
        ? '        会话 - / 日志 -（该来源未提供巡检）'
        : `        会话 ${fmtInt(info.sessions)} / 日志 ${fmtInt(info.files)} / 最新写入 ${
          info.latestMs === null ? '-' : fmtTime(info.latestMs)}`,
    )
    if (info?.error !== undefined) lines.push(`        ⚠ ${info.error}`)
  }
  for (const root of otherRoots.missing) lines.push(`  [✗] [${root.source}] ${root.path}（不存在）`)
  for (const id of otherRoots.disabled) lines.push(`  [关闭] ${id}（由环境开关关闭）`)
  lines.push(
    '',
    '  指定来源目录: --codex-home <p> / --claude-home <p> / --trae-home <p> / --trae-cn-home <p>',
    '                / --workbuddy-home <p>（均可重复）',
    '  对应环境变量: DSH_TOKEN_REPORT_CODEX_HOMES / DSH_TOKEN_REPORT_CLAUDE_HOMES',
    '                / DSH_TOKEN_REPORT_TRAE_HOMES / DSH_TOKEN_REPORT_TRAE_CN_HOMES',
    '                / DSH_TOKEN_REPORT_WORKBUDDY_HOMES',
    '',
  )
  process.stdout.write(lines.join('\n'))
  return 0
}

/**
 * 描述本次取数用的数据源，用于终端头部与诊断。
 *
 * 把「走了哪个源、库里有多少条」显式打出来，是为了让「SQL 化到底有没有生效」
 * 一眼可见 —— 否则降级发生时用户只会觉得「这次慢」，而不知道原因。
 */
/**
 * 描述一组会话日志根。
 *
 * 多套 DSH 并存时「读了哪几处」必须打印出来 —— 否则「我加了一个 home 数字没变」
 * 无法区分是**镜像去重**（正确）还是**那个根根本没读到**（错误）。
 */
function describeRoots(roots: readonly string[], dshOnly = true): string {
  if (roots.length === 0) return '(未配置)'
  if (roots.length === 1) return roots[0]!
  // 多来源时不能再说「N 个 DSH home」——那会把 Codex 的根也说成 DSH 的。
  return dshOnly
    ? `${roots.length} 个 DSH home: ${roots.join(' + ')}`
    : `${roots.length} 个会话日志根: ${roots.join(' + ')}`
}

function describeSource(
  source: 'sql' | 'scan',
  paths: ResolvedPaths,
  dbStats: { events: number; earliest: number | null; latest: number | null } | null,
  /** 本次**实际读取**的根（多来源时必须按来源报，不能报 DSH 的根当成全部）。 */
  roots: readonly string[],
  dshOnly = true,
): string {
  if (source === 'scan') return `直扫日志 ${describeRoots(roots, dshOnly)}`
  const count = dbStats?.events ?? 0
  return `本地库 ${paths.dbPath}（${fmtInt(count)} 条记录；来源 ${describeRoots(roots, dshOnly)}）`
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

  const paths = resolvePaths({ dshHomes: opts.dshHomes, dataDir: opts.dataDir })

  // ★ 来源根（多客户端）：`--source` 显式给出即**完全接管**；**不给 = 全部已注册来源**
  //   （逐个去掉用 `--no-<来源>`，或环境开关 `DSH_TOKEN_REPORT_<来源>=0`）。
  //   ⚠️ 缺省曾经是**纯 DSH**：那是在 Codex 的本地库与页面还没落地时定的，为的是
  //      「DSH 结果无回归」。四个来源（codex / claude-code / trae / trae-cn / workbuddy）
  //      各自都有适配器 + 格式哨兵之后，缺省的代价从「数字悄悄变」变成「数字可解释」，
  //      所以这里翻成全部来源 —— 与 `CliOptions.sources` 的注释、`--help` 一致。
  //   🚨 翻转的代价必须说清楚：`bun run stats --period today` 的数字会比以前**大**
  //      （本机实测 Codex 就有 5.5B 量级）。想回到旧口径：`--source dsh`。
  const explicitSources = opts.sources
  const knownSources = registeredSources().map((adapter) => adapter.id)
  const wantsAll = explicitSources?.includes('all') === true
  // ★ 缺省不是「**全部**已注册来源」，而是「**没被环境开关关掉**的那些」。
  //
  //   来源开关（`SessionSourceAdapter.disableEnv`，如 `DSH_TOKEN_REPORT_CODEX=0`）
  //   在 `resolveSourceRoots()` 里只在**没有显式 sources** 时才生效，因为
  //   「显式指定即接管」——否则 preload 把开关全设成 0 之后，
  //   `verify:*` 与单测里的 `resolveSourceRoots({ sources: ['codex'] })` 会一条也拿不到
  //   （那是它们唯一的数据来源）。
  //   而 CLI 这一层**永远**把清单显式传下去，于是开关在这里被整个跳过：
  //   实测 `DSH_TOKEN_REPORT_CODEX=0 bun run stats` 与不设时读的根**逐字相同**
  //   （2.8 GB 的 Codex 日志照扫）—— 使用者以为自己关掉了它，不报错，只是慢 + 数字里多了别的来源。
  //   所以缺省这一刻必须由这里读开关（判据与 `resolveSourceRoots` 同一份实现）。
  const enabledByEnv = registeredSources()
    .filter((adapter) => adapter.disableEnv === undefined || !envFlagOff(process.env[adapter.disableEnv]))
    .map((adapter) => adapter.id)
  const disabledByEnv = knownSources.filter((id) => !enabledByEnv.includes(id))
  // 先按 `--source` 定出这次**想**统计哪些来源，再让 `--no-*` 开关去减 ——
  // 冲突判定必须发生在「减掉」之前，否则 `--no-codex --source codex`
  // 会被减成一个空表，而「空表」在下面等同于「缺省 = 全部来源」，静默变成全来源统计。
  const requestedSources = (explicitSources !== undefined && explicitSources.length > 0
    ? (wantsAll ? knownSources : explicitSources.filter((id) => id !== 'all'))
    : enabledByEnv) as SessionSource[]
  if (opts.noCodex === true && !requestedSources.includes('dsh')) {
    // `--no-codex` 与「只选了 Codex」是自相矛盾的组合，明确拒绝而不是猜。
    throw new UsageError('--no-codex 与只选 Codex 的 --source 冲突')
  }
  if (opts.noClaudeCode === true && !requestedSources.includes('dsh')) {
    // `--no-claude-code` 同理：它只在「DSH 是其中之一」时才有意义。
    throw new UsageError('--no-claude-code 与只选别的来源的 --source 冲突')
  }
  // `--no-trae` / `--no-trae-cn` 同理，但这两个**分别**对应 Trae 的两个发行版：
  // 国际版与国内版是两个来源，所以必须是两个开关（见 `sources/trae.ts` 文件头）。
  if (opts.noTrae === true && !requestedSources.includes('dsh')) {
    throw new UsageError('--no-trae 与只选别的来源的 --source 冲突')
  }
  if (opts.noTraeCn === true && !requestedSources.includes('dsh')) {
    throw new UsageError('--no-trae-cn 与只选别的来源的 --source 冲突')
  }
  if (opts.noWorkbuddy === true && !requestedSources.includes('dsh')) {
    throw new UsageError('--no-workbuddy 与只选别的来源的 --source 冲突')
  }
  // `--no-codex` / `--no-claude-code` / … 表达的是「本次别并进这个来源」，不是「只要这一个」。
  // ⚠️ 这几个开关在早先版本里**收了却没人用**（症状：加了 `--no-codex`，数字一点没变）。
  // ★ 用一张表而不是继续堆三元表达式：每加一个来源只加一行，漏一行的症状正是上面那句话。
  const suppressed: ReadonlyArray<readonly [SessionSource, boolean]> = [
    ['codex', opts.noCodex === true],
    ['claude-code', opts.noClaudeCode === true],
    ['trae', opts.noTrae === true],
    ['trae-cn', opts.noTraeCn === true],
    ['workbuddy', opts.noWorkbuddy === true],
  ]
  const removed = new Set(suppressed.filter(([, on]) => on).map(([id]) => id))
  const chosenSources = requestedSources.filter((id) => !removed.has(id))
  if (chosenSources.length === 0) {
    // 全被 `--no-*` 减掉了。交给 `resolveSourceRoots` 会得到「没指定来源」⇒ 缺省全部来源，
    // 也就是**恰好相反**的结果，所以必须在这里明确拒绝。
    throw new UsageError('--no-* 开关把 --source 给的来源全都去掉了，没有来源可统计')
  }
  const sourceRoots = resolveSourceRoots({
    sources: chosenSources,
    homes: opts.sourceHomes,
  })
  // 纯 DSH 的一次运行保留改动前的**文案与根清单**（错误信息、`--discover`、走库的判定都不动）；
  // ⚠️ 但**数字**不再等价于「库里的全部来源」—— `openStats` 会显式收到 `sources: ['dsh']`，
  //    否则库里别的来源的行（CLI 缺省运行入进去的）会被算成 DSH 的（见下面 openStats 处的注释）。
  const pureDsh = sourceRoots.sources.length === 1 && sourceRoots.sources[0] === 'dsh'
  // 「本机有别的客户端日志、但这次没统计」必须说出来：否则「没看到 Codex / Claude Code」
  // 分不清是没跑过、还是没选来源 —— 两种情况的输出完全一样。
  // 逐个来源报（而不是只报 Codex）：多客户端之后，漏报一个来源就少一条线索。
  if (pureDsh && !opts.quiet) {
    for (const id of knownSources) {
      if (id === 'dsh') continue
      const other = resolveSourceRoots({ sources: [id], homes: opts.sourceHomes })
      if (other.roots.length > 0) {
        process.stderr.write(
          `ⓘ 检测到 ${id} 会话目录，本次未统计（加 --source ${id}，或 --source all 统计全部来源）\n`,
        )
      }
    }
  }

  // `--discover`：只回答「本机有哪些 DSH home」，不统计、不碰库。
  if (opts.discover) return printDiscover(paths, opts)

  // 🚨 `pricing sync` **不读会话日志**，所以必须在「有没有会话目录」这道检查之**前**分派：
  //   一台还没装 DSH、或 home 在别处的机器，正是最需要先把单价同步下来的情形，
  //   而放在检查之后会让它以「没有可用的会话目录」失败 —— 报错与真正的原因毫无关系。
  if (opts.command === 'pricing') return runPricingCommand(opts, paths)

  // ★ 多根：缺失的根**逐项报出但不失败**，全部缺失才算失败 ——
  //   多写了一个暂时不存在的 home（外接盘没插、客户端刚卸载）不该让整个命令挂掉，
  //   但也不能静默：`⚠` 那行是使用者分辨「镜像去重」与「根本没读到」的唯一线索。
  const missingRoots = paths.sessionRoots.filter((info) => !info.exists)
  if (!pureDsh) {
    // 多来源：根的存在性判定改用「带来源的根清单」，否则 `--source codex`
    // 在没装 DSH 的机器上会被 DSH 的那道检查拦下（报错与真正的原因毫无关系）。
    if (sourceRoots.roots.length === 0) {
      // 关掉的来源要一起报：否则「这台机器没有 Codex 目录」与
      // 「你自己把 Codex 关了」在输出上完全一样（都是空列表 + 报错）。
      // ⚠️ `sourceRoots.disabled` 只在「没显式给 sources」时才有值，而 CLI 永远显式给，
      //    所以这里必须并上本层读出来的 `disabledByEnv`（见上面那段注释）。
      const disabledAll = [...new Set([...sourceRoots.disabled, ...disabledByEnv])]
      process.stderr.write(
        `错误: 没有可用的会话目录。\n` +
          sourceRoots.missing.map((root) => `  [${root.source}] ${root.path}`).join('\n') +
          (disabledAll.length > 0 ? `\n被开关关闭的来源：${disabledAll.join(', ')}\n` : '') +
          `\n请用 --source 选择来源，--dsh-home / --codex-home / --claude-home / --trae-home / --trae-cn-home / --workbuddy-home 指定目录（均可重复）。\n` +
          `想看本机有哪些来源目录: --discover\n`,
      )
      return 1
    }
    if (sourceRoots.missing.length > 0) {
      process.stderr.write(
        `⚠ 以下来源目录不存在，已跳过（逐项列出，不静默）：\n` +
          sourceRoots.missing.map((root) => `    [${root.source}] ${root.path}`).join('\n') + '\n',
      )
    }
  } else if (!paths.sessionsRootExists) {
    process.stderr.write(
      `错误: 没有可用的会话目录。\n` +
        missingRoots.map((info) => `  ${info.root}`).join('\n') +
        `\n请用 --dsh-home 指定（可重复），或设置 DSH_HOME / DSH_TOKEN_REPORT_DSH_HOMES。\n` +
        `想看本机有哪些 DSH home: --discover\n`,
    )
    return 1
  }
  if (missingRoots.length > 0) {
    process.stderr.write(
      `⚠ 以下会话日志根不存在，已跳过: ${missingRoots.map((info) => info.root).join(' / ')}\n`,
    )
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
    // ★ 上报要带**全部已选来源**（不只是 DSH）：给 `runReport` 的是非 DSH 的那批根，
    //   DSH 走它自己的分帧水位线（`sessionsRoot`），两者共用同一份 state.json。
    return runReportCommand(opts, paths.sessionsRoots, sourceRoots.roots.filter((root) => root.source !== 'dsh'))
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
    // ★ 一组根：库路径与直扫路径吃的是同一个入参，两者必然给出同一个并集。
    //   多来源时改用带类型的根清单（非 DSH 来源在库路径落地之前会**明说**改走直扫）。
    sessionsRoot: pureDsh ? paths.sessionsRoots : sourceRoots.roots.map((root) => root.path),
    // 🚨 **来源筛选两条分支都必须给**（纯 DSH 也要）。
    //   本地库是四种形态**共用的一个文件**，只要这台机器上跑过一次缺省运行或
    //   `--source all`，库里就躺着别的来源的行；而 `sources` 的缺省语义是
    //   「库里的**全部**来源」——
    //   于是 `--source dsh`（文档里那句「想回到旧口径」）会静默返回并集。
    //   实测本机：先 `--source all` 再 `--source dsh`，两次总量**逐位相同**
    //   （326,041,147），`--by source` 里还挂着 workbuddy —— 这正是最危险的
    //   「看起来完全正常」的错数字。
    //   ⚠️ 代价：显式收窄来源会绕过汇总表（`usage_rollup_*` 的键里没有来源，
    //   见 `openStats` 的 `scoped`）—— 库很大时纯 DSH 查询会比以前慢一点，
    //   但「快而错」不是可选项。
    sources: pureDsh ? ['dsh'] : sourceRoots.sources,
    ...(pureDsh ? {} : {
      sourceRoots: sourceRoots.roots,
      // 缺失的来源根也要报出来（它们不在 `sessionsRoot` 那个路径数组里）。
      ...(sourceRoots.missing.length > 0 ? { missingRoots: sourceRoots.missing.map((root) => root.path) } : {}),
    }),
    dbPath: paths.dbPath,
    rollup: true,
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

  // 本次**实际读取**的根：纯 DSH 时与改动前逐字一致；多来源时按带类型的根清单报
  // （报 DSH 的根当全部 = 来源不可见，而「数字是谁的」正是多来源下第一个要回答的问题）。
  const effectiveRoots = pureDsh ? paths.sessionsRoots : sourceRoots.roots.map((root) => root.path)

  // ★ 多来源时把默认维度升级成带来源的组合维度（表格因此多一列「来源」）。
  //   使用者**显式**给了 `--by` 就尊重他的选择：那时他已经在指定要看的切面，
  //   替他改写等于把「我明明筛了 provider-model」变成一个谜题。
  if (opts.byExplicit !== true) opts.by = terminalDimensions(opts.by, sourceRoots.sources)

  // 普通统计直接复用压缩索引的分组，只有交叉表和 JSON 的 provider 趋势需要原始记录。
  // 百万记录不能为了打印前 30 行而全部搬到 CLI 内存重新聚合。
  // ★ `--cost` 也必须物化记录：单价带生效区间，**换价那一刻**两侧的用量适用不同的价，
  //   按「分组 token 总量 × 一个价」算必然把换价前后的用量全按其中一个价算 ——
  //   而它看起来完全正常。所以只能逐条事件按**它自己的时刻**取价（见 `core/db/cost.ts`）。
  //   `--list-providers` 是「只列出后退出」模式，不产生任何费用输出，故不必为它物化。
  const withCost = opts.cost && !opts.listProviders
  let records: UsageRecord[] = []
  const grouped = new Map<GroupDimension, GroupRow[]>()
  let series: SeriesPoint[] = []
  let total: ReturnType<typeof session.totals>
  let dbStats: ReturnType<typeof session.dbDiagnostics>
  try {
    total = session.totals()
    dbStats = session.dbDiagnostics()
    const dims = opts.listProviders ? ['provider', 'provider-model'] as const : opts.by
    for (const dim of dims) grouped.set(dim, session.groups(dim).map(r => ({ ...r, metrics: derive(r.counts) })))
    if ((opts.cross && opts.format === 'table') || (opts.series && opts.format === 'json') || withCost) {
      records = session.records()
    }
    if (opts.series) {
      series = opts.format === 'json' ? timeSeries(records, opts.series, false)
        : session.series(opts.series, opts.format === 'table').map(p => ({ ...p, metrics: derive(p.counts), byProvider: new Map() }))
    }
  } finally {
    session.close()
  }
  const elapsed = Date.now() - t0
  // SQL 路径没有「扫描诊断」（本轮的增量诊断在 session 里不含 eventTypes 等
  // 逐事件计数），用空诊断占位 —— 渲染层因此不必到处判空。
  const diagnostics = session.diagnostics ?? emptyDiagnostics()
  const degradedReason = session.degradedReason
  const source = session.source

  // ★ 只有 `--cost` 时才取价、才算金额。关着的时候一位金额都没有，也一次都不调用
  //   计价函数 —— 「算了再丢掉」在输出上看起来一样，但它让普通统计白白物化全部记录。
  const costView = withCost ? buildCostView(paths, opts, records) : null

  // --list-providers：只报告发现的口径边界
  if (opts.listProviders) {
    const provRows = grouped.get('provider')!
    process.stdout.write('\n=== 发现的所有 provider ===\n')
    for (const r of provRows) {
      process.stdout.write(
        `  ${r.key.padEnd(24)} 调用 ${fmtInt(r.counts.calls).padStart(8)}  总量 ${fmtCompact(r.counts.total).padStart(10)}\n`,
      )
    }
    const modelRows = grouped.get('provider-model')!
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
      groups[dim] = grouped.get(dim)!.map((r) => ({
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
      // ★ 多根：`dshHomes` 是全部生效的 home；`dshHome` 保留为兼容字段（= 第一个）。
      dshHomes: paths.dshHomes,
      dshHome: paths.dshHome,
      // 数据目录一并给出：身份 / 本地库都在那里，排查「读的是哪一份」时
      // 只看 home 会得到错误答案（两者现在是独立的）。
      dataDir: paths.dataDir,
      sessionsRoots: effectiveRoots,
      sessionsRoot: effectiveRoots[0] ?? paths.sessionsRoot,
      // 给了但不存在、因而被跳过的根（「加了 home 数字没变」要能分辨原因）
      ...(missingRoots.length > 0 ? { missingRoots: missingRoots.map((info) => info.root) } : {}),
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
      // ★ 只有 `--cost` 时才有这个键。字段**缺席**（不是空对象、更不是 0）是
      //   「这次没算金额」的完整表达 —— JSON 消费方靠它区分「没算」与「算了是 0」。
      ...(costView ? { cost: costJsonPayload(costView, opts.by, grouped) } : {}),
      series: opts.series
        ? series.map((p) => ({
            bucket: p.bucket,
            total: p.counts.total,
            input: p.counts.input,
            output: p.counts.output,
            cacheRead: p.counts.cacheRead,
            calls: p.counts.calls,
            cacheHitRate: p.metrics.cacheHitRate,
            // ⚠️ 供应商键**排序**后再输出：`byProvider` 的插入顺序取决于记录被并进
            //   桶里的先后（库路径按 `ts` 取、直扫按文件顺序），所以同一个桶在两条路径上
            //   会给出**同一个映射、不同的键序**。JSON 对象本身无序，数字不受影响；
            //   但「库 == 直扫」在本仓是被逐字对照的契约（本机 `--source all` 实测：
            //   133 个桶的数值全等，只有 8 个桶的键序不同 ⇒ 看着像不一致）。
            byProvider: Object.fromEntries(
              [...p.byProvider]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, v.total]),
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
      const rows = topSlice(grouped.get(dim)!, opts.top)
      if (opts.by.length > 1) chunks.push(`# dimension: ${dim}`)
      chunks.push(groupRowsToCsv(rows, dim))
    }
    if (opts.series) {
      if (opts.by.length > 1 || chunks.length) chunks.push('')
      chunks.push('# series')
      chunks.push(seriesToCsv(series))
    }
    if (costView) chunks.push(...costCsvSections(costView, opts.by, grouped, opts.top))
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
  out.push(`AI token 统计  |  ${describeRangeFull(range)}  |  数据源 ${describeSource(source, paths, dbStats, effectiveRoots, pureDsh)}`)
  if (source === 'scan' && !opts.noDb) {
    // 降级必须显式告警：用户会明显感觉变慢，不说清原因会被当成「库没生效」
    out.push(`⚠ ${degradedReason ?? '本次走直扫日志'}（用 --no-db 可显式指定）`)
  } else if (degradedReason) {
    // ★ SQL 路径也可能「这一轮没刷成」（库被别的写入者占用时**刻意不直扫**，
    //   见 core `openStats`）：此时数字来自上一次入库的结果。
    //   不说出来，「旧数据」与「日志里就是这些」在终端上完全一样。
    out.push(`⚠ ${degradedReason}`)
  }
  if (opts.providers.length) out.push(`provider 过滤: ${opts.providers.join(', ')}`)
  if (opts.models.length) out.push(`model 过滤: ${opts.models.join(', ')}`)
  out.push(`耗时 ${elapsed}ms`)

  if (total.calls === 0) {
    out.push('')
    out.push('未匹配到任何计费记录。')
    // 费用节在这里**刻意不打**：没有用量时「未计价 0%（0 Token）」是一句废话，
    // 而它会把真正的原因（这段时间没有记录）挤到后面。
    if (!opts.noDiag) {
      out.push(source === 'sql' ? formatDbDiagnostics(dbStats) : formatDiagnostics(diagnostics))
    }
    process.stdout.write(out.join('\n') + '\n')
    return 0
  }

  for (const dim of opts.by) {
    out.push(renderDimension(grouped.get(dim)!, dim, opts.top))
  }

  // 费用节紧跟排行表：键与排行表**逐字相同**（见 `cost-view.ts` 的 `orderedCostKeys()`），
  // 挨着看才好对照「哪个供应商贵」；交叉表与趋势不属于 `--by` 维度，所以排在后面。
  if (costView) out.push(renderCostSection(costView, opts.by, grouped, opts.top, dimLabel))

  if (opts.cross) {
    out.push(renderCross(records, opts.top))
  }

  if (opts.series) {
    out.push(formatSeries(series, `按${opts.series === 'day' ? '天' : '小时'}趋势`))
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
 * 把记录交给 `core/db` 的计价函数，得到一份可渲染的费用结果。
 *
 * ★ 取价、折叠、未计价比例**全部**在 `@ai-token-report/core/db` 的
 *   `priceResolver()` / `costTotalsOf()` / `costByGroupOf()` 里，本函数只负责
 *   「价从哪来」与「哪些维度要算」—— CLI 里**一处金额算术都没有**。
 *   `pricing.json` 缺失或坏掉时 `loadLocalPricing()` 会退回内置种子价并把原因写进
 *   `note`（展示层必须原样打出来，否则使用者会拿着与看板不一致的数去对账）。
 */
function buildCostView(
  paths: ResolvedPaths,
  opts: CliOptions,
  records: readonly UsageRecord[],
): CostView {
  const pricing = loadLocalPricing({
    dataDir: paths.dataDir,
    ...(opts.pricingFile ? { file: opts.pricingFile } : {}),
  })
  const resolve = priceResolver(pricing.prices)
  const groups = new Map<GroupDimension, Map<string, CostTotals>>()
  for (const dim of opts.by) {
    groups.set(dim, costByGroupOf(records, dim, resolve, pricing.provenance))
  }
  return {
    pricing,
    totals: {
      ...costTotalsOf(records, resolve, pricing.provenance),
      unpricedTargets: unpricedTargetsOf(records, resolve),
    },
    groups,
  }
}

/**
 * `pricing sync`：从部门服务端拉一份只读单价快照落到本地。
 *
 * 退出码：`0` 成功；`2` 参数错误（缺 `--portal` / `--token`，或地址非法）；`1` 运行期失败。
 * 失败**分类明确**是这块的关键：401（凭证无效）、403（这份凭证没有 `cost:read`，
 * 而 appKey 按设计拿不到它）、网络 / 响应异常各有各的处置办法，
 * 全都报成「同步失败」等于把三种不同的行动项合并成一个。
 */
async function runPricingCommand(opts: CliOptions, paths: ResolvedPaths): Promise<number> {
  if (!opts.portal || !opts.token) {
    const missing = [
      ...(opts.portal ? [] : ['--portal']),
      ...(opts.token ? [] : ['--token']),
    ]
    process.stderr.write(`错误: pricing sync 缺少必需参数: ${missing.join(' ')}\n\n${PRICING_SYNC_USAGE}\n`)
    return 2
  }

  const result = await syncPricing({
    portal: opts.portal,
    token: opts.token,
    dataDir: paths.dataDir,
    ...(opts.pricingFile ? { pricingFile: opts.pricingFile } : {}),
  })
  if (!result.ok) {
    process.stderr.write(`错误: ${result.message}\n`)
    // 参数错误附完整用法：只报「缺什么」而不给形状，使用者还得翻 --help。
    if (result.code === 2) process.stderr.write(`\n${PRICING_SYNC_USAGE}\n`)
    return result.code
  }

  process.stdout.write(
    `已写入单价快照: ${result.path}\n` +
      `  条数 ${result.count}  来源 ${result.endpoint}  同步于 ${fmtTime(result.syncedAtMs)}\n` +
      `  本地页 / CLI 的金额从此按这份快照算（与看板同源）。\n` +
      result.warnings.map((warning) => `⚠ ${warning}\n`).join(''),
  )
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

  // 普通统计和 --help 不应初始化 Web 路由、鉴权与上报依赖。
  const { createServer, DEFAULT_PORT } = await import('@ai-token-report/server')
  let handle: ServerHandle
  try {
    handle = await createServer({
      ...(opts.web.port !== undefined ? { port: opts.web.port } : {}),
      dshHomes: paths.dshHomes,
      dataDir: paths.dataDir,
      staticDir,
      enableLocalApi: true,
      ...(opts.portal ? { portalUrl: opts.portal } : {}),
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
  out.push(`  会话日志  ${describeRoots(paths.sessionsRoots)}`)
  out.push(`  本地库    ${paths.dbPath}`)
  out.push(`  页面资源  ${staticDir}`)
  out.push(
    `  署名校验  ${opts.portal ?? '未配置（--portal）—— 可在页面「配置」弹框里填服务端地址'}`,
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
 *   `ai-token-report web` 不需要用户再去 clone 仓库构建前端 ——
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
async function runReportCommand(opts: CliOptions, sessionsRoots: string[], plainRoots: SourceRoot[] = []): Promise<number> {
  const r = opts.report
  // ⚠️ 状态文件只由 dataDir 决定（多根共用同一份水位文件）：
  //   水位按**绝对路径**索引，多根并存天然不冲突，推进顺序也保持一致。
  const statePath = r.statePath ?? resolveStatePath(undefined, opts.dataDir)

  // --reset：清空水位线后立即退出
  if (r.reset) {
    resetState(statePath)
    process.stdout.write(
      `已重置上报状态: ${statePath}\n` +
        `下次运行会全量重扫全部会话（服务端按 event_id 幂等，重复投递无害）。\n`,
    )
    return 0
  }

  // ★ 与本地页 / DSH 插件共用身份；显式提供 token 也表示主动授权上报。
  // 没有身份时必须在扫描及写 pending 之前退出，不能先收集再等服务端 401。
  const identity = readIdentity(resolvePaths({ dshHomes: opts.dshHomes, dataDir: opts.dataDir }).identityPath)
  const token = (opts.token ?? process.env['DSH_REPORT_TOKEN'] ?? identity.identity?.token)?.trim()
  const localRehearsal = r.dryRun || r.noSave || !!r.outFile
  if (!localRehearsal && (!token || !token.replace(/^Bearer\s*/i, '').trim())) {
    process.stdout.write(
      (identity.error ? `身份文件无法使用：${identity.error}\n` : '') +
      '未署名，已跳过采集和上报；不会创建或修改待上报记录。\n' +
      '请先运行 ai-token-report web 在页面「配置」里填服务端地址与 appKey，或提供 --token / DSH_REPORT_TOKEN。\n',
    )
    return 0
  }
  const userId = r.userId ?? process.env['DSH_REPORT_USER_ID']
  const userName = r.userName ?? process.env['DSH_REPORT_USER_NAME'] ?? identity.identity?.name
  /**
   * 分组名（原 `dept`）的取值顺序：命令行 / 环境变量 → 本地 identity.json。
   *
   * ⚠️ 读本地文件时必须走 `toAssertion()` 而不是直接读某个字段：
   *   新文件写的是 `group`，旧文件才是 `dept`，而兼容规则（`group ?? dept`）
   *   只在 `shared` 里实现一次。在这里再写一遍 `??` 就等于第二处兼容口径 ——
   *   它不会报错，只会在某个旧文件上静默少一个分组。
   */
  const assertion = identity.identity ? toAssertion(identity.identity) : null
  const group = r.group ?? process.env['DSH_REPORT_GROUP'] ?? assertion?.group

  // 没有投递目标就等价于干跑：不会静默什么都不做
  const dryRun = r.dryRun || r.noSave || (!r.endpoint && !r.outFile)

  const { createFileDeliverer, createHttpDeliverer } = await import('./deliver.js')
  const { runReport } = await import('./report.js')
  let deliver
  if (!dryRun) {
    if (r.outFile) {
      deliver = createFileDeliverer(r.outFile)
    } else if (r.endpoint) {
      deliver = createHttpDeliverer({
        endpoint: r.endpoint,
        token,
        timeoutMs: r.timeoutMs,
        userId,
        userName,
        group,
      })
    }
  }

  const t0 = Date.now()
  let lastRender = 0
  let result: RunReportResult
  try {
    result = await runReport({
      sessionsRoot: sessionsRoots,
      dataDir: opts.dataDir,
      statePath,
      deliver,
      // ★ 非 DSH 来源一起上报：不传它们的话，看板上的来源列永远是 `dsh`
      //   （而「没上报」与「没跑过那个客户端」在页面上长得一模一样）。
      ...(plainRoots.length > 0 ? { plainRoots } : {}),
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
  out.push(`会话日志  ${describeRoots(sessionsRoots)}`)
  out.push(
    `会话文件  ${result.scan.files.length} 个（未变化跳过 ${result.scan.skippedUnchanged} 个，实际解压 ${result.scan.diagnostics.filesScanned} 个）`,
  )
  // ★ 非 DSH 来源本轮的情况：`plain` 缺席 = 这次根本没扫它们（老调用点），
  //   0 = 扫了但一个文件都没变。两者必须能分辨，否则「没扫」会被读成「没用量」。
  if (result.plain) {
    const bySource = new Map<string, number>()
    for (const root of plainRoots) bySource.set(root.source, (bySource.get(root.source) ?? 0) + 1)
    out.push(
      `其它来源  ${[...bySource.keys()].sort().join(' + ') || '(none)'}（根 ${plainRoots.length} 个，` +
        `解析 ${result.plain.filesScanned} 个文件、跳过 ${result.plain.skippedUnchanged} 个，` +
        `本轮 ${fmtInt(result.plain.records)} 条）`,
    )
    if (result.plain.missingRoots.length > 0) {
      out.push(`⚠ 以下来源目录不存在，已跳过：${result.plain.missingRoots.join(' / ')}`)
    }
  }
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
    out.push(`  缓存命中率  ${(derive(c).cacheHitRate * 100).toFixed(1)}%`)

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
