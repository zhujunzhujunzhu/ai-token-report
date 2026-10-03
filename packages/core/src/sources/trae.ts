/**
 * **Trae 来源适配器**（字节跳动的 AI IDE；国际版 Trae 与国内版 Trae CN 两个发行版）。
 *
 * ```
 * <用户数据目录>/logs/<YYYYMMDDTHHMMSS>/Modular/ai-agent_<n>_<启动ms>_stdout.log
 * ```
 *
 * 用户数据目录（Electron 的 `userData`，**不是**家目录下那个 `.trae` / `.trae-cn`）：
 *
 * | 发行版 | Windows | macOS | Linux |
 * |---|---|---|---|
 * | 国际版 `trae` | `%APPDATA%\Trae` | `~/Library/Application Support/Trae` | `~/.config/Trae` |
 * | 国内版 `trae-cn` | `%APPDATA%\TraeCN` | `~/Library/Application Support/TraeCN` | `~/.config/TraeCN` |
 *
 * 🚨 **两个发行版必须分开采**（这就是「国际与国内」那条约束的落点）：
 * 它们是**两个独立的安装与两个独立的账号体系**，模型族与计价各不相同
 * （国际版走 `api.trae.ai`，国内版走 `api.trae.com.cn`），而 `SessionSource`
 * 是「按来源拆分」的**唯一**维度 —— 合并采集之后再也分不开「这个数字是谁的」。
 * ⚠️ 目录名推不出对方：国际版的家目录是 `.trae`、用户数据目录是 `Trae`；
 * 国内版的家目录是 `.trae-cn`、用户数据目录却是 `TraeCN`（没有连字符）。
 * 靠猜会得到一个「永远不存在」的根 —— 而它看起来与「这台机器没装国内版」一样。
 * 实测依据：官方中文社区「Trae 与 Trae CN 的用户目录分别为 `.trae` 与 `.trae-cn`」
 * 与「`AppData\Roaming\TraeCN\logs` 太大」，国际版用户数据目录名由本机
 * `resources/app/product.json` 的 `nameShort: "Trae"` 直接确认。
 *
 * ## 计费数据在哪
 *
 * Rust 子进程 `ai-agent` 的 stdout 日志里，**一行一次调用**：
 *
 * ```
 * 2025-12-02T07:46:05.223268+08:00  INFO ai_agent::domain::model::llm_stream: token usage: \
 *   TokenUsageEvent { name: "", prompt_tokens: 10527, completion_tokens: 826, total_tokens: 11353, \
 *   reasoning_tokens: Some(768), cache_creation_input_tokens: Some(0), \
 *   cache_read_input_tokens: Some(9472), prompt_tokens_total: Some(0), completion_tokens_total: Some(0) }
 * ```
 *
 * ## 五条实测口径（错了不会报错，只会数字悄悄不对）
 *
 * 1. 🚨 **`prompt_tokens` 含 `cache_read` / `cache_creation`**（与 Codex 相同，
 *    与 DSH / Claude Code 相反）。因此 `input` 必须**减掉**这两列。
 *    证据（本机 9 个文件 / 211 条事件）：
 *    - `total_tokens == prompt_tokens + completion_tokens` **逐条成立**（211/211）；
 *      若 `prompt` 是「未命中部分」，Trae 自报的 `total_tokens` 就会漏掉全部缓存读，
 *      这个字段名与恒等式都不可能自洽；
 *    - `cache_read ≤ prompt` **无例外**（最大比值 0.9989）—— 含在里面才有的上界；
 *    - 上下文单调增长（21563 → 22143 → 23492 …）而 `cache_read` 紧跟上一次的
 *      `prompt`（21563 的下一次读到 21888）：前缀缓存的签名是「缓存读 ⊂ 本次输入」。
 *    映射后本仓恒等式 `total = input + output + cacheRead + cacheWrite`
 *    逐条等于上游的 `total_tokens`。
 *
 * 2. 🚨 **`prompt_tokens_total` / `completion_tokens_total` 是累计值，求和即错**：
 *    实测第 3 条事件的 `prompt_tokens_total` = 前 3 条 `prompt_tokens` 之和
 *    （11097 + 11681 + 13967 = 36745）。只采 `prompt_tokens` 那四个**单次**字段，
 *    累计字段一概不读（与 Codex 的累计快照同一条教训）。
 *
 * 3. ⚠️ **一次调用只写一行**：本机实测 62 条事件 / 60 次 `llm_raw_chat` 的
 *    `DONE`（差的 2 条是同一次会话标题生成的收尾），且**没有任何两条共享时间戳**
 *    （211/211 时间戳互不相同）。所以这里**不按累计快照去重**（那是 Codex 的形态），
 *    只保留一道「整行指纹完全相同 ⇒ 判为重复写入」的保险（见 `traeDuplicateEvents`，
 *    本机实测 0 条）。
 *
 * 4. 🚨 **模型名不在用量事件里，且**不能**按「最近一条前置的 `CurrentConfigInfo`」
 *    去猜**：日志里确实有 `CurrentConfigInfo { config_name: "gpt-5-medium", … }`
 *    （那是「这一轮用的哪个模型配置」），但它**不是**每个用量事件都有一条：
 *    实测 4 个文件里分别有 7/2/10/24 条事件**前面一条都没有**，命中的那些距离
 *    最大到 1,939 行。按最近一条归属 = 把用量记到别的模型上，而单价是按
 *    `(provider, model)` 精确匹配的 ⇒ 金额会**错**，且不报错。宁可为 `(unknown)`。
 *    唯一可用的是事件自带的 `name` 字段 —— 实测 3.2.2 / 3.3.0 **恒为空串**
 *    （211/211），所以正常落 `(unknown)`，并在 `traeUnnamedEvents` 里如实计数
 *    （哪天它被填上，这个计数会变 0，而不是悄悄改口径）。
 *
 * 5. ⚠️ **`cwd` 一律为空**：日志里能拿到工作区（`SnapshotFileListInfo` 的
 *    `workspace_folder: Some("d:\\Coding\\…")`），但**一个日志文件会跨多个工作区**
 *    （本机实测一个文件里出现过 7 个），而用量事件本身不带归属。
 *    与第 4 条同理：宁可为空，不可猜。代价是「按项目」这一维度下 Trae 全落 `(未知)`。
 *
 * ## 日志按「进程启动」切，不按会话切
 *
 * 一个 `ai-agent_*.log` 是一次 IDE 启动（文件名里的毫秒就是启动时刻，与
 * `logs/<时间戳>/` 目录名逐秒相符），一次启动里可能有多轮对话。
 * 会话 id 因此取**相对日志根的路径**（`<时间戳>/Modular/ai-agent_<n>_<启动ms>_stdout`）：
 * 它稳定、唯一、可读，而且**镜像的两个根会给出同一个 id** —— 同一份日志被复制到
 * 两个根时 `event_id` 相同，主键先到者胜，正好是要的语义。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { splitHomeList } from '../home.js'
import {
  addCounts, emptyCounts,
  type ScanDiagnostics, type SessionMeta, type SessionSource, type TokenCounts, type UsageRecord,
} from '../types.js'
import type { SessionSourceAdapter, SourceFolder, SourceRoot } from './types.js'

/** 两个发行版的 id（与 `SessionSource` 一致；分开是为了让单价与时序各自成立）。 */
export type TraeRegion = 'trae' | 'trae-cn'

/** 一个发行版的固定事实（目录名 / 环境变量名 / provider 标签）。 */
export interface TraeVariant {
  readonly id: TraeRegion
  /** 展示名（只影响文案）。 */
  readonly label: string
  /**
   * Electron `userData` 目录名。
   *
   * ⚠️ 就是 VSCode 系 `product.json` 的 `nameShort`（`%APPDATA%\<nameShort>`），
   * **不是** `dataFolderName`：国内版的 `dataFolderName` 是 `.trae-cn`，
   * 而用户数据目录名却是 `TraeCN`。两者推不出对方，只能各自钉住。
   */
  readonly userDataDirName: string
  /** 上报用的 provider 标签（`(provider, model)` 是单价的匹配粒度）。 */
  readonly provider: string
  /** 显式多根的环境变量（`path.delimiter` 分隔）；设了就**完全接管**默认目录。 */
  readonly homesEnv: string
  /** 关掉这个发行版的开关。 */
  readonly disableEnv: string
}

export const TRAE_VARIANTS: Readonly<Record<TraeRegion, TraeVariant>> = {
  trae: {
    id: 'trae',
    label: 'Trae（国际版）',
    userDataDirName: 'Trae',
    provider: 'trae',
    homesEnv: 'DSH_TOKEN_REPORT_TRAE_HOMES',
    disableEnv: 'DSH_TOKEN_REPORT_TRAE',
  },
  'trae-cn': {
    id: 'trae-cn',
    label: 'Trae CN（国内版）',
    userDataDirName: 'TraeCN',
    provider: 'trae-cn',
    homesEnv: 'DSH_TOKEN_REPORT_TRAE_CN_HOMES',
    disableEnv: 'DSH_TOKEN_REPORT_TRAE_CN',
  },
}

/**
 * `TokenUsageEvent` 的判别标记。
 *
 * ★ 只用这一个字符串做行级预筛（`indexOf`）：日志动辄 130 MB / 80 万行，
 *   逐行 `JSON.parse` 或逐行正则都不可接受，而这一条已经足够窄。
 */
const USAGE_MARKER = 'token usage: TokenUsageEvent'

/** 计费日志的文件名（`Modular/` 下只有它；`_stderr.log` 与 `ckg_*` 都不含用量）。 */
const USAGE_LOG_FILE = /^ai-agent.*_stdout\.log$/i

/**
 * 一次 `TokenUsageEvent` 的原始字段（**只含单次调用的字段**，累计字段刻意不解析）。
 *
 * `totalTokens` 为 `null` 表示上游没自报 —— 那时**不做**恒等式判定（不替上游编一个）。
 */
export interface TraeUsageFields {
  /** 事件自带的标签（实测恒为空串）。 */
  name: string
  promptTokens: number
  completionTokens: number
  /** 上游自报的 `total_tokens`（`null` = 没给）。 */
  totalTokens: number | null
  /** `None` / 缺字段时为 `null`。 */
  reasoningTokens: number | null
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** `key: 123` 或 `key: Some(123)`（`None` / `null` / 缺字段都取不到）。 */
function numField(body: string, key: string): number | null {
  // ⚠️ 必须锚在 `key: ` 上：`prompt_tokens` 是 `prompt_tokens_total` 的前缀，
  //    不带冒号的子串匹配会把累计值当成单次值（那是「求和即错」那一类错误）。
  const match = new RegExp(`(?:^|[, ])${key}: (?:Some\\((-?\\d+)\\)|(-?\\d+))`).exec(body)
  if (match === null) return null
  const raw = match[1] ?? match[2]
  return raw === undefined ? null : Number(raw)
}

/** `key: "文本"`（Rust 的 `Debug` 转义：`\"` / `\\` / `\n`）。 */
function strField(body: string, key: string): string | null {
  const match = new RegExp(`(?:^|[, ])${key}: "((?:[^"\\\\]|\\\\.)*)"`).exec(body)
  if (match === null || match[1] === undefined) return null
  return match[1].replace(/\\(.)/g, '$1')
}

/**
 * 从一整行日志里解析出一次调用的用量。
 *
 * 解析不出（缺 `prompt_tokens` / `completion_tokens`，或行里没有结构体）返回 `null` ——
 * 调用方会把它计进 `traeMalformedLines`，**绝不**用 0 兜底（那会凭空产生一笔「零用量调用」，
 * 并且让「格式变了」这件事完全不可见）。
 */
export function parseTraeUsageEvent(line: string): TraeUsageFields | null {
  const at = line.indexOf(USAGE_MARKER)
  if (at < 0) return null
  const body = /\{([^}]*)\}/.exec(line.slice(at + USAGE_MARKER.length))?.[1]
  if (body === undefined) return null
  // 必需字段只有这两个：它们是**单次**用量，且实测恒存在（不写成 `Some(..)` 包装）。
  const promptTokens = numField(body, 'prompt_tokens')
  const completionTokens = numField(body, 'completion_tokens')
  if (promptTokens === null || completionTokens === null) return null
  return {
    name: strField(body, 'name') ?? '',
    promptTokens,
    completionTokens,
    totalTokens: numField(body, 'total_tokens'),
    reasoningTokens: numField(body, 'reasoning_tokens'),
    cacheReadTokens: numField(body, 'cache_read_input_tokens') ?? 0,
    cacheWriteTokens: numField(body, 'cache_creation_input_tokens') ?? 0,
  }
}

/**
 * 把 Trae 的用量字段映射成本仓的四列。
 *
 * ★ 这是**全仓唯一**允许出现「Trae 的 `prompt_tokens` 含 cache」这条语义的地方。
 *   导出它是为了让测试与验证脚本直接钉住这个映射，而不是各自再写一遍。
 *
 * `overlap`：`cacheRead + cacheWrite > promptTokens`。实测 211/211 不成立；
 * 一旦成立，说明「缓存读含在输入内」这条前提被推翻（映射已夹 0，但必须能被看见）。
 */
export function mapTraeUsage(fields: TraeUsageFields): {
  counts: TokenCounts
  /** 四列之和是否等于上游自报的 `total_tokens`（**没自报时恒 true**）。 */
  identityOk: boolean
  overlap: boolean
} {
  const counts = emptyCounts()
  addCounts(counts, {
    // ⚠️ 必须减：`prompt_tokens` 是**含缓存**的总输入（见文件头第 1 条）。
    inputTokens: Math.max(0, fields.promptTokens - fields.cacheReadTokens - fields.cacheWriteTokens),
    outputTokens: fields.completionTokens,
    cacheReadTokens: fields.cacheReadTokens,
    cacheWriteTokens: fields.cacheWriteTokens,
    reasoningTokens: fields.reasoningTokens ?? 0,
  })
  return {
    counts,
    identityOk: fields.totalTokens === null || counts.total === fields.totalTokens,
    overlap: fields.cacheReadTokens + fields.cacheWriteTokens > fields.promptTokens,
  }
}

/**
 * 日志行的第一个空白分隔 token 就是 RFC3339 时间戳（含 6 位小数与偏移）。
 * 取不到返回 `NaN` —— 调用方据此跳过并计数（**不**退化成 1970，那会污染时间窗）。
 */
function lineTime(line: string): number {
  const raw = /^(\S+)/.exec(line)?.[1]
  return raw === undefined ? NaN : Date.parse(raw)
}

/**
 * 逐文件折叠（状态在闭包里，与 DSH / Codex / Claude Code 三侧同构）。
 *
 * ⚠️ **不走「逐行 split」**：真实日志单文件最大 130 MB / 约 80 万行，
 * 拆成 80 万个字符串的代价（时间与 GC）全都花在 99.99% 与用量无关的行上。
 * 这里用 `indexOf` 直接跳到候选行，只对候选行切片 —— 实测每 5,000 行才有 1 条。
 */
function createTraeFolder(
  variant: TraeVariant,
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
  records: UsageRecord[],
): SourceFolder {
  let pending = ''
  /** 文件内「第几次计费事件」——追加写不改变已写行，所以它是稳定的幂等序号。 */
  let ordinal = 0
  /** 整行指纹：同一行被写两遍时挡住（见文件头第 3 条）。 */
  const fingerprints = new Set<string>()
  diagnostics.traeFiles++

  function handleLine(line: string): void {
    const fields = parseTraeUsageEvent(line)
    if (fields === null) { diagnostics.traeMalformedLines++; return }
    const time = lineTime(line)
    // 时间戳取不到 ⇒ 跳过并计数。**不退化成 1970**：那会把一笔真实用量塞进时间窗之外，
    // 让「按天/按小时」的两端看起来都少了东西，而原因完全不可见。
    if (!Number.isFinite(time)) { diagnostics.traeMalformedLines++; return }
    diagnostics.traeUsageLines++

    const fingerprint = `${time}|${fields.name}|${fields.promptTokens}|${fields.completionTokens}|${fields.totalTokens ?? ''}|${fields.reasoningTokens ?? ''}|${fields.cacheReadTokens}|${fields.cacheWriteTokens}`
    if (fingerprints.has(fingerprint)) { diagnostics.traeDuplicateEvents++; return }
    fingerprints.add(fingerprint)

    const { counts, identityOk, overlap } = mapTraeUsage(fields)
    if (!identityOk) diagnostics.traeIdentityViolations++
    if (overlap) diagnostics.traeOverlapAnomalies++
    // 四类全 0：不是用量，不替上游入库（Codex / Claude Code 两侧同款）。
    if (counts.total === 0) { diagnostics.traeZeroUsage++; return }

    const name = fields.name.trim()
    if (name === '') diagnostics.traeUnnamedEvents++
    diagnostics.usageEvents++
    const seq = ordinal++
    records.push({
      // ★ 只有非 DSH 来源才带前缀：DSH 的 event_id 是上报库主键，改它等于让服务端
      //   把历史事件再插一遍（全量补报时数字翻倍，且不报错）。
      eventId: `trae:${meta.sessionId}:${seq}`,
      source: variant.id,
      sessionId: meta.sessionId,
      seq,
      time,
      provider: variant.provider,
      // 见文件头第 4 条：模型名不在用量事件里，也不许按「最近一条前置」猜。
      model: name === '' ? '(unknown)' : name,
      // 见文件头第 5 条：一个日志文件会跨多个工作区，用量事件不带归属 ⇒ 宁可空着。
      cwd: null,
      turn: null,
      step: null,
      usage: counts,
    })
  }

  /** 扫描**完整行**区域：只对命中标记的行切片。 */
  function scan(text: string): void {
    let from = 0
    for (;;) {
      const at = text.indexOf(USAGE_MARKER, from)
      if (at < 0) return
      from = at + USAGE_MARKER.length
      // 行首 = 上一个换行之后（时间戳在那里），行尾 = 下一个换行。
      // 传进来的文本一定以换行结尾，所以两端都存在。
      const start = text.lastIndexOf('\n', at) + 1
      const end = text.indexOf('\n', at)
      handleLine(text.slice(start, end < 0 ? undefined : end))
    }
  }

  return {
    push(chunk: string) {
      const text = pending + chunk
      const end = text.lastIndexOf('\n')
      if (end < 0) { pending = text; return }
      // 只扫「最后一个换行之前」的部分：追加写途中的半行留给下一轮，否则候选行会被截断。
      scan(text.slice(0, end))
      pending = text.slice(end + 1)
    },
    finish() {
      if (pending) { scan(pending); pending = '' }
    },
  }
}

/**
 * 列出根下的全部计费日志。
 *
 * 结构是 `logs/<时间戳>/Modular/<文件>`：`Modular` 那一层是子进程日志目录，
 * 名字与层级都可能在版本间变，所以**只按文件名筛**、不写死中间目录名 ——
 * 写死它一旦改名就是「静默 0 条」。
 */
async function listUsageLogs(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { await listUsageLogs(path, depth - 1, out); continue }
    if (entry.isFile() && USAGE_LOG_FILE.test(entry.name)) out.push(path)
  }
}

/**
 * 列举一个根下的会话文件。
 *
 * ★ 根既可以是**目录**（正常情形：`<用户数据目录>/logs`），也可以直接是**一个日志文件**。
 *   后者不是怪癖：验证脚本要按文件粒度与独立实现逐条比对，就得把范围收窄到一个文件；
 *   而 `readdir()` 对文件路径只会抛 `ENOTDIR`，被吞掉之后就是**一份空列举** ——
 *   「比对全绿」会变成「一条都没比」，正是本仓最忌讳的那种静默 0。
 */
async function listSessionLogs(rootPath: string, depth: number): Promise<string[]> {
  if (USAGE_LOG_FILE.test(basename(rootPath))) return [rootPath]
  const out: string[] = []
  await listUsageLogs(rootPath, depth, out)
  return out
}

/** 会话 id：相对根目录的路径（正斜杠、去掉扩展名）。镜像的两个根因此给出同一个 id。 */
export function traeSessionIdOf(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath)
  // 根就是一个文件时 `relative()` 给空串（或退化的 `..`），退回家目录无关的文件名。
  const usable = rel === '' || rel.startsWith('..') ? basename(filePath) : rel
  return usable.split(/[\\/]/).join('/').replace(/\.log$/i, '')
}

/**
 * 一个发行版的默认用户数据目录。
 *
 * 平台差异按 Electron 的 `userData` 规则来，**与 DSH / Codex 的 `~/.xxx` 不是一回事**：
 * 日志在家目录**之外**（Windows 在 `%APPDATA%`，macOS 在 `Application Support`，
 * Linux 在 `~/.config`）。参数可注入是为了让测试不依赖跑测试的那台机器。
 */
export function defaultTraeUserDataDirs(
  region: TraeRegion,
  options: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform; home?: string } = {},
): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const name = TRAE_VARIANTS[region].userDataDirName
  if (platform === 'win32') {
    const appData = (env['APPDATA'] ?? '').trim()
    return [join(appData === '' ? join(home, 'AppData', 'Roaming') : appData, name)]
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', name)]
  const xdg = (env['XDG_CONFIG_HOME'] ?? '').trim()
  return [join(xdg === '' ? join(home, '.config') : xdg, name)]
}

/**
 * 造一个发行版的适配器。
 *
 * 两个发行版**共用**全部解析逻辑（同一个二进制、同一份日志格式），
 * 差别只有三样：id / provider 标签 / 默认目录与环境变量名。刻意不复制两份代码 ——
 * 复制出来的第二份一旦漂移，症状是「国内版的数字和国外版不一样」而没有任何报错。
 */
function createTraeSource(region: TraeRegion): SessionSourceAdapter {
  const variant = TRAE_VARIANTS[region]
  const id: SessionSource = variant.id

  return {
    id,
    // 见 `sources/types.ts`：这个取值表达的是「纯文本逐行日志」，
    // 与 zstd 分帧相对；Trae 的日志是 Rust tracing 文本，不是 JSONL，但走同一条通路。
    encoding: 'plain-jsonl',
    disableEnv: variant.disableEnv,

    roots(homes) {
      // 优先级：显式 homes > 环境变量（`path.delimiter` 分隔）> 平台约定目录。
      // ⚠️ 环境变量**完全接管**默认目录（它是「一组根」的显式清单）：
      //    设了它还把默认目录并进来，会让 `--format json` 里的根清单与配置对不上。
      const envHomes = splitHomeList(process.env[variant.homesEnv])
      const bases = homes.length > 0
        ? [...homes]
        : (envHomes.length > 0 ? envHomes : defaultTraeUserDataDirs(region))
      // 日志在 `<用户数据目录>/logs`；家目录下的 `.trae` / `.trae-cn` **只放扩展与 skills**，
      // 扫它只会得到一个「看起来正常、实际永远 0 条」的根。
      return bases.map((home): SourceRoot => ({ path: join(home, 'logs'), source: id }))
    },

    async list(root, options = {}) {
      // `logs/<时间戳>/Modular/<文件>` 是三层，多留一层容错。
      const files = await listSessionLogs(root.path, 3)
      const out: SessionMeta[] = []
      for (const filePath of files) {
        let size: number
        try { size = (await stat(filePath)).size } catch (error) {
          if (options.strictErrors) throw error
          continue
        }
        // 0 字节 = 日志刚建还没写入：当「无用量」跳过，不报错、也不计入会话数。
        if (size === 0) continue
        out.push({
          source: id,
          sessionId: traeSessionIdOf(root.path, filePath),
          cwd: null,
          createdAt: null,
          // 项目归属拿不到（见文件头第 5 条）；这里放日志所处的启动目录，只作为定位线索。
          projectDir: relative(root.path, filePath).split(/[\\/]/).slice(0, -1).join('/'),
          filePath,
        })
      }
      return out
    },

    createFolder(meta, diagnostics, records) {
      return createTraeFolder(variant, meta, diagnostics, records)
    },

    // ★ 巡检必须用 Trae 自己的文件形态：拿 DSH 的「<project>/<sessionId>/<file>」
    //   或 Codex 的「<YYYY>/<MM>/<DD>/rollout-*.jsonl」去数这里，只会得到 0/0 ——
    //   一个看起来完全正常的空目录。
    async inspect(root) {
      const metas = await this.list(root)
      let latestMs: number | null = null
      for (const meta of metas) {
        try {
          const st = await stat(meta.filePath)
          if (latestMs === null || st.mtimeMs > latestMs) latestMs = st.mtimeMs
        } catch {
          // 单个文件 stat 失败只影响「最新写入」，不该让整个巡检失败
        }
      }
      return { sessions: metas.length, files: metas.length, latestMs }
    },
  }
}

/** 国际版 Trae。 */
export const traeSource: SessionSourceAdapter = createTraeSource('trae')

/** 国内版 Trae CN。 */
export const traeCnSource: SessionSourceAdapter = createTraeSource('trae-cn')
