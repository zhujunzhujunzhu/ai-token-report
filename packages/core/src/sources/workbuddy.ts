/**
 * **WorkBuddy 来源适配器**（腾讯 WorkBuddy 桌面端 / 内置 CLI 的本地会话 JSONL）。
 *
 * ```
 * <配置目录>（`$WORKBUDDY_CONFIG_DIR` > `~/$WORKBUDDY_DATA_FOLDER_NAME` > `~/.workbuddy`）/
 * └── projects/
 *     └── <cwd 压缩名>/                        ← CWD 经**有损**压缩（`/` `\` `:` → `-`）
 *         ├── <sessionId>.jsonl                ← ★ 计费真源：一个会话一个文件
 *         ├── <sessionId>.meta.json            ← 可选：**迁移过来的老会话**才有（cwd / createdAt）
 *         ├── <sessionId>.file-rollback.ndjson ← 文件回滚记录（不含用量，不采）
 *         ├── <sessionId>.quickask             ← 划词临时会话的空标记文件（不采）
 *         └── <sessionId>/subagents/<taskId>.jsonl ← 子代理（团队）会话，用量独立落自己的文件
 * ```
 *
 * 目录形状与文件名不是猜的：WorkBuddy 自己的源码里写着这条布局
 * （`resolveLocalSessionJsonlPath()` = `join(homeDir, "projects", compressWorkspacePathName(cwd), id + ".jsonl")`，
 * `resolveHistoryPaths()` 里另有 `childDir = <projectDir>/<conversationId>/subagents`），
 * 本机实测也逐项吻合。
 *
 * ## 为什么用 `WORKBUDDY_CONFIG_DIR` 而不是家目录常量
 *
 * 它的源码里 `resolveConfigDir()` 就是 `$WORKBUDDY_CONFIG_DIR` > `~/$WORKBUDDY_DATA_FOLDER_NAME`
 * （缺省 `.workbuddy`）。写死 `~/.workbuddy` 会让**定制版 / 私有化部署**
 * （源码注释里明说会指到 `~/.aimea` 之类的目录）永远扫到 0 个文件 ——
 * 而「目录名不对」与「这台机器没用过 WorkBuddy」在输出上完全一样。
 *
 * ## 计费真源：`providerData.usage` / `providerData.rawUsage`
 *
 * 一行一个事件（`session-meta` / `message` / `reasoning` / `function_call` /
 * `function_call_result` / `ai-title` / `file-history-snapshot` …），只有**模型响应**
 * 那几行带用量，形状是：
 *
 * ```jsonc
 * // 新代际（实测：每个模型调用都写一条）
 * {"providerData":{"model":"deepseek-v4.1-flash","messageId":"01a0ffae12db…","usage":{
 *    "requests":1,"inputTokens":51937,"outputTokens":526,"totalTokens":52463,
 *    "inputTokensDetails":[{"cached_tokens":48512}],"outputTokensDetails":[{"reasoning_tokens":214}]},
 *  "rawUsage":{"prompt_tokens":51937,"completion_tokens":526,"total_tokens":52463,
 *    "prompt_cache_hit_tokens":48512,"prompt_cache_miss_tokens":3425,
 *    "prompt_cache_write_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,
 *    "prompt_tokens_details":{"cached_tokens":48512},"credit":0.09}}}
 *
 * // 老代际（实测：**一个用户轮次只有最后那一次调用**落盘，见第 4 条）
 * {"providerData":{"model":"auto","usage":{"input_tokens":26219,"output_tokens":17,"total_tokens":26236}}}
 * ```
 *
 * ## 五条实测口径（错了不会报错，只会数字悄悄不对）
 *
 * 1. 🚨 **`prompt_tokens` 含缓存命中**（与 Codex / Trae 相同，与 DSH / Claude Code 相反）。
 *    因此 `input`（未命中）必须**减掉** `cacheRead` / `cacheWrite`。
 *    证据（本机 4 条新代际样本）：
 *    - `prompt_cache_miss_tokens + prompt_cache_hit_tokens == prompt_tokens` **逐条精确成立**
 *      （3425 + 48512 = 51937 等，4/4）；
 *    - `total_tokens == prompt_tokens + completion_tokens` **逐条成立**（10/10，含老代际）
 *      —— 若 `prompt_tokens` 是「未命中部分」，上游自报的 `total_tokens` 就会漏掉全部缓存读；
 *    - WorkBuddy 自己的 `toolCallUpdate` 就是把 `prompt_tokens` 当 `promptTokens`、
 *      把 `prompt_cache_hit_tokens` 当缓存命中分开摆的（源码实测，见
 *      `cachedTokenCount()` 的字段优先级）。
 *    映射后本仓恒等式 `total = input + output + cacheRead + cacheWrite`
 *    逐条等于上游的 `total_tokens`（`workbuddyIdentityViolations` 正常恒为 0）。
 *
 * 2. 🚨 **缓存的字段取值顺序必须照抄上游**：`prompt_cache_hit_tokens` >
 *    `cache_read_input_tokens` > `prompt_tokens_details.cached_tokens`。
 *    实测同一条新代际记录里 `prompt_cache_hit_tokens = 48512` 而
 *    `cache_read_input_tokens = 0` —— **先读后者就会把缓存读当成 0**
 *    （输入与缓存整块对调，页面上数字看着完全正常）。`prompt_cache_write_tokens` >
 *    `cache_creation_input_tokens` 同理。
 *
 * 3. 🚨 **同一条模型响应会把用量挂在「该响应的最后一行」上**，而不是固定的行类型：
 *    实测 4 条里 3 条落在 `function_call`、1 条落在 `message/assistant`，
 *    而同一个 `messageId` 下的 `reasoning` / `message` 行**不带**用量。
 *    所以这里**按行认字段**（谁带 `usage` 就认谁），再用 `messageId` 去重 ——
 *    写死「只认 `message/assistant` 行」会漏掉工具轮次的全部用量（实测漏 3/4）。
 *
 * 4. ⚠️ **老代际（`migratedFrom: agent-history`）只记「每个用户轮次最后一次调用」**：
 *    本机 Claw 会话有 4 个用户轮次 / 39 条 assistant 行，但**只有 5 条用量记录**，
 *    且都紧跟在轮次的最后一条 assistant 消息上（中间的工具轮次一条都没有）。
 *    这是**上游的缺口，不是我们的漏采** —— 它不是靠改适配器能补回来的，
 *    所以只能如实采到多少算多少，并在 `workbuddyUsageWithoutCache` 里
 *    把「这一条没有缓存信息」这件事显式报出来（见第 5 条）。
 *
 * 5. ⚠️ **老代际没有缓存字段**（`usage` 只有 `input_tokens` / `output_tokens` /
 *    `total_tokens`，连 `rawUsage` 都没有）。于是 `cacheRead` 只能记 0，
 *    而它的 `input_tokens` 是**整段上下文**（含命中部分）—— 逐条计入
 *    `workbuddyUsageWithoutCache`，否则「这一源缓存命中率被系统性低估」这件事
 *    在页面上完全看不出来（本机实测 6/10 条属这一类）。
 *
 * ## 另外三条不猜的规则
 *
 * 6. 🚨 **`timestamp` 为 0 时必须跳过并计数**，绝不退化成 1970：
 *    实测迁移过来的老会话整文件 `timestamp: 0`（本机 `1a02ca59…` 16/16 行），
 *    只有末尾的 `custom-title` 用 `createdAt`。把它当成时间会把整段用量
 *    塞进 1970 —— 落在任何时间窗之外（页面显示「没有用量」）或污染「全部时间」，
 *    而两种表现都不会报错。
 *
 * 7. 🚨 **幂等键主体是「相对根路径」而不是信封里的 `sessionId`**：会话文件是
 *    `projects/<cwd 压缩名>/<sessionId>.jsonl`，而同一个会话 id 不可能出现在两个
 *    文件里（一个会话一个文件）；相对路径既稳定又天然覆盖**嵌套的子代理文件**
 *    （`<sessionId>/subagents/<taskId>.jsonl`，它的文件名是 taskId，不是会话 id）。
 *    信封里的 `sessionId` 只用来做一致性诊断（`workbuddyMetaMismatch`，本机 5/5 相符）。
 *    这与 Codex 那条「文件名是权威」（`codex.ts` 第 4 条）是同一条教训的两个方向：
 *    那边文件名的 uuid 与信封 id 会不一致，这边相对路径是唯一能覆盖全部文件形态的键。
 *
 * 8. **`provider` 只能记 `workbuddy`**：日志里**根本没有** provider 字段
 *    （`providerData` 的实测键只有 model / requestModelId / requestModelName /
 *    messageId / conversationRequestId / traceId / usage / rawUsage / agent …）。
 *    不拿模型名去猜厂商（`deepseek-v4.1-flash` 既可能是直连也可能是网关）——
 *    单价是按 `(provider, model)` 精确匹配的，猜错就是金额错且不报错。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { splitHomeList } from '../home.js'
import {
  addCounts, emptyCounts,
  type ScanDiagnostics, type SessionMeta, type TokenCounts, type UsageRecord,
} from '../types.js'
import type { SessionSourceAdapter, SourceFolder, SourceRoot } from './types.js'

/** WorkBuddy 自己的配置目录环境变量（源码 `resolveConfigDir()` 就认它）。 */
export const WORKBUDDY_CONFIG_DIR_ENV = 'WORKBUDDY_CONFIG_DIR'

/** 换掉家目录下那个目录名（缺省 `.workbuddy`）—— 与上一个变量是同一条解析链。 */
export const WORKBUDDY_DATA_FOLDER_NAME_ENV = 'WORKBUDDY_DATA_FOLDER_NAME'

/** 多个 WorkBuddy home（本项目扩展，`path.delimiter` 分隔）。 */
export const WORKBUDDY_HOMES_ENV = 'DSH_TOKEN_REPORT_WORKBUDDY_HOMES'

/** 关闭 WorkBuddy 采集的开关（测试与「只想看 DSH」时用）。 */
export const WORKBUDDY_DISABLED_ENV = 'DSH_TOKEN_REPORT_WORKBUDDY'

/**
 * 上报用的 provider 标签。
 *
 * ⚠️ 是**固定值**而不是从日志里读的（见文件头第 8 条：日志里没有 provider 字段）。
 * 拿模型名猜厂商会让 `(provider, model)` 的单价匹配落在一个约定上，
 * 而约定漂移时不会报错、只会金额错。
 */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** 缺省目录名（`$WORKBUDDY_DATA_FOLDER_NAME` 没给时）。 */
export const DEFAULT_WORKBUDDY_FOLDER = '.workbuddy'

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** 取出一个对象字段（数组与 null 都不算）。 */
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 取字段里的第一个**有限数字**；都没有返回 `null`。
 *
 * ⚠️ `null` 与 `0` 是两件事：`0` 是「上游明说这一项是 0」，`null` 是「上游没说」。
 * 缓存那几个字段正是靠这个区别才知道「老代际没有缓存信息」（见文件头第 5 条）。
 */
function firstNumber(record: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (record === null) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** 对象，或数组的第一个对象元素（`inputTokensDetails` 两代分别是对象与数组）。 */
function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.length > 0 ? obj(value[0]) : null
  return obj(value)
}

/** 缺省 home：`$WORKBUDDY_CONFIG_DIR` > `~/$WORKBUDDY_DATA_FOLDER_NAME` > `~/.workbuddy`。 */
export function defaultWorkBuddyHome(options: {
  env?: Record<string, string | undefined>
  home?: string
} = {}): string {
  const env = options.env ?? process.env
  const configured = (env[WORKBUDDY_CONFIG_DIR_ENV] ?? '').trim()
  if (configured !== '') return configured
  const folder = (env[WORKBUDDY_DATA_FOLDER_NAME_ENV] ?? '').trim() || DEFAULT_WORKBUDDY_FOLDER
  return join(options.home ?? homedir(), folder)
}

/** 会话 id：相对根目录的路径（正斜杠、去掉 `.jsonl`）。镜像的两个根因此给出同一个 id。 */
export function workbuddySessionIdOf(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath)
  const usable = rel === '' || rel.startsWith('..') ? basename(filePath) : rel
  return usable.split(/[\\/]/).join('/').replace(/\.jsonl$/i, '')
}

/** 会话文件的判据：`<sessionId>.jsonl`。`.ndjson`（回滚记录）/`.meta.json` 都不匹配。 */
const SESSION_FILE = /\.jsonl$/i

/**
 * 从一行的两个用量对象里抽出**单次调用**的字段（两代共用一个形状）。
 *
 * 解析不出（连 `prompt` / `completion` 都没有）返回 `null` —— 调用方计入
 * `workbuddyMalformedUsage`，**绝不**用 0 兜底（那会凭空多出一笔「零用量调用」，
 * 并且让「格式变了」这件事完全不可见）。
 *
 * ★ 这是**全仓唯一**允许出现「WorkBuddy 的 `prompt_tokens` 含缓存」这条语义的地方。
 */
export function parseWorkBuddyUsage(
  usage: Record<string, unknown> | null,
  raw: Record<string, unknown> | null,
): WorkBuddyUsageFields | null {
  // 新代际用 camelCase（`inputTokens`），老代际用 snake_case（`input_tokens`）；
  // `rawUsage` 是 provider 原样字段（OpenAI 风格），只有新代际才有。
  const promptTokens = firstNumber(usage, ['inputTokens', 'input_tokens'])
    ?? firstNumber(raw, ['prompt_tokens', 'input_tokens', 'inputTokens'])
  const completionTokens = firstNumber(usage, ['outputTokens', 'output_tokens'])
    ?? firstNumber(raw, ['completion_tokens', 'output_tokens', 'outputTokens'])
  if (promptTokens === null || completionTokens === null) return null

  // 见文件头第 2 条：这个顺序是照抄 WorkBuddy 自己的 `cachedTokenCount()` 的，
  // 换了顺序就会把 `prompt_cache_hit_tokens` 与恒为 0 的 `cache_read_input_tokens` 弄反。
  const cacheReadTokens = firstNumber(raw, [
    'prompt_cache_hit_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens',
  ]) ?? firstNumber(
    firstRecord(raw?.['prompt_tokens_details']) ?? firstRecord(usage?.['inputTokensDetails']),
    ['cached_tokens', 'cachedTokens'],
  )
  const cacheWriteTokens = firstNumber(raw, [
    'prompt_cache_write_tokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens',
  ])

  return {
    promptTokens,
    completionTokens,
    totalTokens: firstNumber(usage, ['totalTokens', 'total_tokens']) ?? firstNumber(raw, ['total_tokens']),
    cacheReadTokens,
    cacheWriteTokens,
    missTokens: firstNumber(raw, ['prompt_cache_miss_tokens', 'cache_miss_input_tokens', 'cacheMissInputTokens']),
    reasoningTokens: firstNumber(firstRecord(raw?.['completion_tokens_details']), ['reasoning_tokens'])
      ?? firstNumber(firstRecord(usage?.['outputTokensDetails']), ['reasoning_tokens']),
  }
}

/** 一次调用的原始字段（`null` = 上游没给这一项，**不是** 0）。 */
export interface WorkBuddyUsageFields {
  /** `prompt_tokens` / `inputTokens`：**含缓存命中**的总输入。 */
  promptTokens: number
  completionTokens: number
  /** 上游自报的 `total_tokens`（`null` = 没给 ⇒ 不做恒等式判定，不替上游编一个）。 */
  totalTokens: number | null
  /** 缓存读（命中）；`null` = 这一代**没有缓存信息**（老代际，见文件头第 5 条）。 */
  cacheReadTokens: number | null
  /** 缓存写；`null` = 这一代没有这个字段。 */
  cacheWriteTokens: number | null
  /** `prompt_cache_miss_tokens`：给了就用来交叉校验「缓存含在输入内」。 */
  missTokens: number | null
  reasoningTokens: number | null
}

/**
 * 把 WorkBuddy 的用量字段映射成本仓的四列。
 *
 * 导出它是为了让测试与验证脚本直接钉住这个映射，而不是各自再写一遍。
 *
 * - `identityOk`：四列之和 == 上游自报的 `total_tokens`（**没自报时恒 true**）。
 *   非 0 说明上游语义变了（例如缓存改成「不含在 prompt 内」）。
 * - `overlap`：`cacheRead + cacheWrite > promptTokens`（映射已夹 0，但必须能被看见）。
 * - `missMismatch`：上游给了 `prompt_cache_miss_tokens` 却与「prompt − 缓存」对不上
 *   —— 这条正是「缓存含在输入内」这个前提**直接**被推翻的信号（比恒等式更早发现）。
 * - `hasCacheInfo`：这一条到底有没有缓存字段（老代际没有 ⇒ 命中率会被低估）。
 */
export function mapWorkBuddyUsage(fields: WorkBuddyUsageFields): {
  counts: TokenCounts
  identityOk: boolean
  overlap: boolean
  missMismatch: boolean
  hasCacheInfo: boolean
} {
  const cacheRead = fields.cacheReadTokens ?? 0
  const cacheWrite = fields.cacheWriteTokens ?? 0
  // ⚠️ 必须减：`promptTokens` 是**含缓存**的总输入（见文件头第 1 条）。
  const input = Math.max(0, fields.promptTokens - cacheRead - cacheWrite)

  const counts = emptyCounts()
  addCounts(counts, {
    inputTokens: input,
    outputTokens: fields.completionTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: fields.reasoningTokens ?? 0,
  })
  return {
    counts,
    identityOk: fields.totalTokens === null || counts.total === fields.totalTokens,
    overlap: cacheRead + cacheWrite > fields.promptTokens,
    missMismatch: fields.missTokens !== null && fields.missTokens !== input,
    hasCacheInfo: fields.cacheReadTokens !== null || fields.cacheWriteTokens !== null,
  }
}

/**
 * 逐文件折叠（状态在闭包里，与 DSH / Codex / Claude Code / Trae 四侧同构）。
 *
 * ⚠️ 这里**逐行 `JSON.parse`**，不做子串预筛（Trae 那边必须预筛，是因为它的日志
 *   是 130 MB / 80 万行的 tracing 文本）。WorkBuddy 是**一个会话一个文件**，
 *   本机实测最大 200 KB —— 预筛省下的那点时间换不回「预筛条件写窄了就静默 0 条」
 *   这个风险。真到了单个文件几 MB 再谈优化。
 */
function createWorkBuddyFolder(
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
  records: UsageRecord[],
): SourceFolder {
  let pending = ''
  /** 文件内「第几条计费记录」—— 追加写不改变已写行，所以它是稳定的幂等序号。 */
  let seq = 0
  /** 已采的响应键（`messageId` / 行 `id`）：同一条响应只算一次（见文件头第 3 条）。 */
  const seenResponses = new Set<string>()
  // 起始 cwd 取自 `meta.cwd`（`list()` 从 `.meta.json` 读来的），行里出现顶层 `cwd` 时覆盖。
  let cwd: string | null = meta.cwd
  let createdAt: number | null = null
  /** 嵌套（子代理 / 团队）会话文件：用量是独立的，但要能被数出来（本机 0）。 */
  const nested = isNestedSession(meta.projectDir)
  diagnostics.workbuddyFiles++
  if (nested) diagnostics.workbuddyNestedSessionFiles++
  /** 顶层会话文件才做「文件名 == 信封 sessionId」的一致性判定（见文件头第 7 条）。 */
  const stem = basename(meta.filePath).replace(/\.jsonl$/i, '')

  function handleUsage(
    ev: Record<string, unknown>,
    pd: Record<string, unknown>,
    usage: Record<string, unknown> | null,
    raw: Record<string, unknown> | null,
  ): void {
    diagnostics.workbuddyUsageLines++
    const fields = parseWorkBuddyUsage(usage, raw)
    if (fields === null) { diagnostics.workbuddyMalformedUsage++; return }

    // 见文件头第 6 条：`0` / 缺字段 / 非数字一律跳过并计数，**不退化成 1970**。
    const rawTime = ev['timestamp']
    if (typeof rawTime !== 'number' || !Number.isFinite(rawTime) || rawTime <= 0) {
      diagnostics.workbuddyInvalidTimestamps++
      return
    }
    const time = rawTime
    if (createdAt === null || time < createdAt) createdAt = time

    // 响应键：新代际有 `messageId`，老代际用行 `id`（实测 10/10 至少有一个）。
    // 两个都没有时退化成行序号（无法去重，但那种上游形态下也不会有第二条同值记录）。
    const key = str(pd['messageId']) ?? str(ev['id']) ?? `#${diagnostics.workbuddyUsageLines}`
    if (seenResponses.has(key)) { diagnostics.workbuddyDuplicateResponses++; return }
    seenResponses.add(key)

    const { counts, identityOk, overlap, missMismatch, hasCacheInfo } = mapWorkBuddyUsage(fields)
    if (!identityOk) diagnostics.workbuddyIdentityViolations++
    if (overlap) diagnostics.workbuddyOverlapAnomalies++
    if (missMismatch) diagnostics.workbuddyMissMismatch++
    // 四类全 0：不是用量，不替上游入库（Codex / Claude Code / Trae 三侧同款）。
    if (counts.total === 0) { diagnostics.workbuddyZeroUsage++; return }

    const model = str(pd['model']) ?? str(pd['requestModelId'])
    // 老代际的 model 是 `auto`（上游的真实取值，不是缺失）：照原样记，
    // 它会配不上任何单价 ⇒ `unpricedRate` 显式变高，这正是要的效果。
    if (model === null) diagnostics.workbuddyMissingModel++
    // 见文件头第 5 条：没有缓存字段的那一代，命中率会被低估，必须能被看见。
    if (!hasCacheInfo) diagnostics.workbuddyUsageWithoutCache++

    diagnostics.usageEvents++
    const recordSeq = seq++
    records.push({
      // ★ 只有非 DSH 来源才带前缀：DSH 的 event_id 是上报库主键，改它等于让服务端
      //   把历史事件再插一遍（全量补报时数字翻倍，且不报错）。
      eventId: `workbuddy:${meta.sessionId}:${recordSeq}`,
      source: 'workbuddy',
      sessionId: meta.sessionId,
      seq: recordSeq,
      time,
      provider: WORKBUDDY_PROVIDER,
      model: model ?? '(unknown)',
      cwd: cwd ?? meta.cwd,
      turn: null,
      step: null,
      usage: counts,
    })
  }

  function handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // 追加写途中的半行 / 坏行：丢掉，下一轮从光标处重读（与其它纯文本来源同款）。
      return
    }
    const ev = obj(parsed)
    if (ev === null) return
    diagnostics.totalEvents++
    const type = str(ev['type']) ?? '(no-type)'
    diagnostics.eventTypes.set(type, (diagnostics.eventTypes.get(type) ?? 0) + 1)

    // 顶层 `cwd`：实测出现在 `file-history-snapshot` / `ai-title` 以及新代际的各类行上；
    // 迁移过来的老会话**一行都没有**，那时归属只能来自 `.meta.json`（见 `list()`）。
    const lineCwd = str(ev['cwd'])
    if (lineCwd !== null) cwd = lineCwd

    // 信封 id 只做诊断：文件名（相对路径）才是幂等键主体（见文件头第 7 条）。
    // ⚠️ 嵌套文件的文件名是 taskId，与信封 sessionId **本来就可以不同** ⇒ 不判定，
    //    否则每一台用了子代理的机器都会报出一堆「不一致」。
    if (!nested) {
      const envelopeId = str(ev['sessionId'])
      if (envelopeId !== null && envelopeId !== stem) diagnostics.workbuddyMetaMismatch++
    }

    const pd = obj(ev['providerData'])
    if (pd === null) return
    const usage = obj(pd['usage'])
    const raw = obj(pd['rawUsage'])
    if (usage === null && raw === null) return
    handleUsage(ev, pd, usage, raw)
  }

  return {
    push(chunk: string) {
      const text = pending + chunk
      const end = text.lastIndexOf('\n')
      if (end < 0) { pending = text; return }
      for (const line of text.slice(0, end).split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') handleLine(trimmed)
      }
      pending = text.slice(end + 1)
    },
    finish() {
      if (pending.trim() !== '') handleLine(pending.trim())
      pending = ''
      // 把解析出的项目归属写回 `meta`：增量路径要靠它跨轮继承（与 DSH / Codex 同款）。
      meta.cwd = cwd ?? meta.cwd
      if (meta.createdAt === null && createdAt !== null) meta.createdAt = createdAt
    },
  }
}

/**
 * 这个 `projectDir` 是不是「嵌套」会话（子代理 / 团队）。
 *
 * 顶层形态是 `<cwd 压缩名>`（一段），嵌套形态是 `<cwd 压缩名>/<sessionId>/subagents`。
 * 顶层文件才做文件名一致性判定（见文件头第 7 条）。
 */
function isNestedSession(projectDir: string): boolean {
  return projectDir.includes('/')
}

/** 递归列目录（`projects/<cwd>/` 与 `<sessionId>/subagents/` 两层足够，多留一层容错）。 */
async function listJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { await listJsonl(path, depth - 1, out); continue }
    // `.jsonl` 才是会话流：`.meta.json` / `.file-rollback.ndjson` / `.quickask` 都不匹配。
    if (entry.isFile() && SESSION_FILE.test(entry.name)) out.push(path)
  }
}

/**
 * 读可选的 `.meta.json` 侧车（**只有迁移过来的老会话才有**）。
 *
 * 为什么 `list()` 要读它：迁移过来的老会话在 JSONL 里**一行 `cwd` 都没有**
 * （实测 `59a10a52…` / `6daa428b…` 全文件为 0 条），项目归属只存在于这个侧车里；
 * 拿不到就只能让「按项目」整列落 `(未知)`。文件是几百字节，代价可以忽略。
 * 读不到 / 解析不了**不算错误**（新会话本来就没有这个文件），归属退化成 `null`。
 */
async function readSidecar(filePath: string): Promise<{ cwd: string | null; createdAt: number | null }> {
  const sidecar = filePath.replace(SESSION_FILE, '.meta.json')
  try {
    const parsed = obj(JSON.parse(await readFile(sidecar, 'utf8')))
    if (parsed === null) return { cwd: null, createdAt: null }
    return { cwd: str(parsed['cwd']), createdAt: num(parsed['createdAt']) || null }
  } catch {
    return { cwd: null, createdAt: null }
  }
}

export const workbuddySource: SessionSourceAdapter = {
  id: 'workbuddy',
  encoding: 'plain-jsonl',
  disableEnv: WORKBUDDY_DISABLED_ENV,

  roots(homes) {
    // 优先级：显式 homes > `DSH_TOKEN_REPORT_WORKBUDDY_HOMES`（本项目扩展的多根，
    // `path.delimiter` 分隔）> `$WORKBUDDY_CONFIG_DIR` > `~/$WORKBUDDY_DATA_FOLDER_NAME`
    // > `~/.workbuddy`。
    const envHomes = splitHomeList(process.env[WORKBUDDY_HOMES_ENV])
    const bases = homes.length > 0
      ? [...homes]
      : (envHomes.length > 0 ? envHomes : [defaultWorkBuddyHome()])
    // 计费日志在 `<配置目录>/projects`；`logs/` 下是运行日志（不含逐次调用的用量），
    // 扫它只会得到一个「看起来正常、实际永远 0 条」的根。
    return bases.map((home): SourceRoot => ({ path: join(home, 'projects'), source: 'workbuddy' }))
  },

  async list(root, options = {}) {
    // `projects/<cwd 压缩名>/<sessionId>.jsonl` 与 `<sessionId>/subagents/<taskId>.jsonl`
    // 最深四层，`depth = 3` 覆盖（每下一层减一）。
    const files: string[] = []
    await listJsonl(root.path, 3, files)
    const out: SessionMeta[] = []
    for (const filePath of files) {
      let size: number
      try { size = (await stat(filePath)).size } catch (error) {
        if (options.strictErrors) throw error
        continue
      }
      // 0 字节 = 会话刚建还没写入：当「无用量」跳过，不报错、也不计入会话数。
      if (size === 0) continue
      const sidecar = await readSidecar(filePath)
      out.push({
        source: 'workbuddy',
        sessionId: workbuddySessionIdOf(root.path, filePath),
        cwd: sidecar.cwd,
        createdAt: sidecar.createdAt,
        // 项目归属拿的是**目录名**（CWD 的有损压缩），只作为定位线索；
        // 真正的 cwd 来自侧车或行里的顶层 `cwd`（记录会带上它）。
        projectDir: relative(root.path, filePath).split(/[\\/]/).slice(0, -1).join('/'),
        filePath,
      })
    }
    return out
  },

  createFolder(meta, diagnostics, records) {
    return createWorkBuddyFolder(meta, diagnostics, records)
  },

  // ★ 巡检必须用 WorkBuddy 自己的文件形态：拿 DSH 的「<project>/<sessionId>/<file>」
  //   或 Codex 的「<YYYY>/<MM>/<DD>/rollout-*.jsonl」去数这里，只会得到 0/0 ——
  //   一个看起来完全正常的空目录。
  async inspect(root) {
    const metas = await workbuddySource.list(root)
    let latestMs: number | null = null
    for (const meta of metas) {
      try {
        const st = await stat(meta.filePath)
        if (latestMs === null || st.mtimeMs > latestMs) latestMs = st.mtimeMs
      } catch {
        // 单个文件 stat 失败只影响「最新写入」，不该让整个巡检失败
      }
    }
    // 一个会话一个文件（嵌套的子代理会话各有自己的文件），所以这里是 Set ——
    // 与 Codex 的「一个会话可能多个文件」用同一个形状，语义仍然成立。
    return { sessions: new Set(metas.map((meta) => meta.sessionId)).size, files: metas.length, latestMs }
  },
}
