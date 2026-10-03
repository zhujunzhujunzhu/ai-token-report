/**
 * **Claude Code 来源适配器**（Claude Code CLI / Desktop / 各 IDE 扩展共用的会话记录）。
 *
 * ```
 * $CLAUDE_CONFIG_DIR（缺省 ~/.claude）/projects/
 * ├── <项目目录名>/<session-uuid>.jsonl                 ← 一次会话一个文件
 * ├── <项目目录名>/subagents/agent-<hash>.jsonl         ← 子代理（与父会话同 sessionId）
 * ├── <项目目录名>/<session-uuid>/subagents/…           ← 另一种子代理布局
 * ├── <项目目录名>/memory/*.md                          ← 不是 jsonl，天然不会被列举
 * └── …/subagents/workflows/<wf-id>/journal.jsonl       ← 控制文件（不含用量）
 * ```
 *
 * 每行一个**带 `type` 的信封**：`assistant` / `user` / `attachment` / `system` /
 * `queue-operation` / `last-prompt` / `custom-title` / `ai-title` …… 计费信息
 * **只在 `type === "assistant"` 且 `message.usage` 存在**的那些行里。
 *
 * ## 五条实测口径（错了不会报错，只会数字悄悄不对）
 *
 * 1. ✅ **四列语义与 DSH 一致，不需要做减法**：Claude Code 的
 *    `message.usage.input_tokens` 本身**就是「未命中缓存」那部分**
 *    （与 Codex 的 `input_tokens` 相反 —— 那边把 cache 含在里面）。
 *    因此 `input = input_tokens`、`cacheRead = cache_read_input_tokens`、
 *    `cacheWrite = cache_creation_input_tokens`，恒等式
 *    `total = input + output + cacheRead + cacheWrite` 直接等于上游口径。
 *    ⚠️ **`cache_creation` 里的 `ephemeral_1h/5m_input_tokens` 不单独成列**：
 *    它们是缓存写入的**定价分档**（1 小时 / 5 分钟），不是另一类用量；
 *    拆成两列会让「缓存写」与本仓四列口径不再一致，而两家之和恒等于
 *    `cache_creation_input_tokens`（本机 1,114 行实测逐行相等）。
 *
 * 2. 🚨 **同一次调用会被写成多行，必须按 `message.id` 去重**：本机 9 个文件实测
 *    1,114 条计费行只对应 551 次调用（重复 563 条，**朴素逐行相加正好翻倍**）。
 *    重复行**不保证相邻**（实测最大间隔 21 行、241 处的间隔 > 1），
 *    所以「跳过连续重复」的写法在这里是错的。
 *
 * 3. 🚨 **幂等键是 `claude-code:<sessionId>:<message.id>`，行号不行也重复行不行**：
 *    `uuid` **每行都不同**（同一 `message.id` 的四行有四个 `uuid`），
 *    拿它当键等于不去重；行号在「整份重解析」的水位线语义下也不稳定
 *    （见 `db/ingest-plain.ts` 的 L1/L3）。`message.id` 才是那次 API 调用的身份，
 *    实测 1,114 行里**一行不缺**。
 *
 * 4. ✅ **四行重复的用量快照逐字节相同**（实测 0 处分歧），所以「首次出现即入库、
 *    后续重复只计数」与「最后一次覆盖」给出**同一个总量**
 *    （本机实测两侧都是 63,842,793）。这里选**首次获胜**：它与全仓
 *    `event_id` 主键「先到者胜」的语义一致，也不会让一条记录依赖同文件里
 *    后面还有没有别的东西。
 *
 * 5. ⚠️ **`message.usage.total_tokens` 字段不存在**（本机键集合里没有它），
 *    所以恒等式校验只能拿「四列之和」跟「上游有没有自报」比 —— 没有自报就**不校验**，
 *    绝不替上游编一个 total 出来。
 *
 * ## 子代理（subagents）：**不列举**，以及这条规则的风险
 *
 * 布局里有两处子代理转写（`<项目>/subagents/agent-<hash>.jsonl` 与
 * `<项目>/<session-uuid>/subagents/…`）。它们的**文件名不是 uuid**，
 * 因此与 `journal.jsonl`（工作流控制文件）一样被 {@link claudeSessionIdFromName}
 * 挡在列举之外 —— 规则只有一条：**只认「文件名就是 uuid」的那些**。
 * 这是刻意的（决策与理由见 `docs/ClaudeCode会话采集方案.md` 的坑 #6）：
 * 拿文件名硬凑一个 sessionId，会让这些行**混进某个真实会话**，
 * 而「凭空多出一个来源」同样不可接受。
 *
 * 🚨 但这条规则压着一个**尚未验证的前提**：那些文件里**没有**自己的 API 用量。
 *    上游 issue 明确提到子代理转写带 `message.usage`（例如 anthropics/claude-code#93620、
 *    #97763）——如果它们的用量只落在这些文件里，本适配器就**少算**这一块，
 *    而且不报错（与「这台机器没跑过子代理」表现完全一样）。
 *    本机 `~/.claude/projects` 下没有这类文件（9 个会话全是 `<uuid>.jsonl`），
 *    所以只能等真机上出现样本时复验：届时按 `workbuddy.ts` 的做法把它们当**独立会话**
 *    列举（sessionId 取相对路径，幂等键因此天然带上子代理文件），并确认父文件里
 *    没有同一批 `message.id`（否则就是双计）。结论要写回上面那份文档的 Q4。
 *
 * ⚠️ 另外，**同一个会话被 `/resume` 复制成两份文件**时，两份里的同 `message.id` 行会
 *    撞 `event_id` 主键、只入一次 —— 这正是我们要的语义（见下面第 3、4 条）。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import {
  addCounts, emptyCounts,
  type ScanDiagnostics, type SessionMeta, type TokenCounts, type UsageRecord,
} from '../types.js'
import { splitHomeList } from '../home.js'
import type { SessionSourceAdapter, SourceFolder, SourceRoot } from './types.js'

/**
 * Claude Code 的配置目录环境变量（**Claude Code 官方变量**，不是本项目扩展）。
 * 官方文档：`CLAUDE_CONFIG_DIR` 覆盖配置目录，缺省 `~/.claude`。
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** 多个 Claude Code 配置目录（本项目扩展，`path.delimiter` 分隔）。 */
export const CLAUDE_HOMES_ENV = 'DSH_TOKEN_REPORT_CLAUDE_HOMES'

/** 关闭 Claude Code 采集的开关（测试与「只想看 DSH」时用）。 */
export const CLAUDE_DISABLED_ENV = 'DSH_TOKEN_REPORT_CLAUDE'

/** Claude Code 缺省配置目录（家目录下的 `.claude`）。 */
export function defaultClaudeHome(): string {
  return join(homedir(), '.claude')
}

/**
 * 从文件名取会话 uuid（`<uuid>.jsonl`）。取不到返回 null。
 *
 * ⚠️ 只认**文件主体就是 uuid** 的那一种：`subagents/agent-<hash>.jsonl`
 * （子代理）与 `journal.jsonl`（工作流控制文件）都不是会话文件，
 * 它们的用量要么在别处、要么本来就没有，一律不列举 ——
 * 猜一个 id 出来只会让它们的行**混进某个真实会话**里去。
 * 🚨 「要么在别处、要么本来就没有」是**未验证的前提**：见文件头
 * 「子代理（subagents）：不列举，以及这条规则的风险」。
 */
export function claudeSessionIdFromName(name: string): string | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)
  return match ? match[1]!.toLowerCase() : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 取出一个对象字段（数组与 null 都不算）。 */
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 把 Claude Code 的 `message.usage` 映射成本仓的四列。
 *
 * ★ 这是**全仓唯一**允许出现「Claude Code 的 input 已经是未命中缓存那部分」这条
 *   语义的地方。导出它是为了让测试与验证脚本直接钉住这个映射，而不是各自再写一遍。
 *
 * `identityOk` 只在**上游真的自报了 total** 时才判定（实测该字段不存在，
 * 所以正常恒为 `true` —— 没有可对的东西就不假装对过了）。
 */
export function mapClaudeUsage(usage: Record<string, unknown>): {
  counts: TokenCounts
  /** 四列之和是否等于上游自报的 `total_tokens`（**没有自报时恒 true**）。 */
  identityOk: boolean
} {
  const cacheWrite = num(usage['cache_creation_input_tokens'])
  const counts = emptyCounts()
  addCounts(counts, {
    // ⚠️ 不做减法：Claude Code 的 input_tokens 已经是未命中缓存的部分（见文件头第 1 条）。
    inputTokens: num(usage['input_tokens']),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: num(usage['cache_read_input_tokens']),
    cacheWriteTokens: cacheWrite,
  })
  const reported = usage['total_tokens']
  return {
    counts,
    identityOk: typeof reported !== 'number' || counts.total === reported,
  }
}

/**
 * 逐文件折叠（状态在闭包里，与 DSH / Codex 两侧同构）。
 *
 * 文件是 append-only 的，折叠器只处理**新增的文本块**：会话首行时间、
 * 项目目录（`cwd`）、模型上下文都要留着，否则增量块里没有这些字段时
 * 记录会退化成 `(unknown)` 与「没有项目归属」。起始 `cwd` 从 `meta.cwd` 继承。
 */
function createClaudeFolder(
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
  records: UsageRecord[],
): SourceFolder {
  let pending = ''
  // 本文件的计费解析已经开始 ⇒ 计入「采到的文件数」（与 Codex 的 codexFiles 同义）。
  diagnostics.claudeFiles++
  // 起始 cwd 取自 `meta.cwd`（增量块里没有 `cwd` 时靠它继承项目归属）。
  let cwd: string | null = meta.cwd
  /** 已采过的 `message.id`（同一次调用的重复行在这里被吸收）。 */
  const seenMessages = new Set<string>()
  /** 会话首行时间：`/resume` 会把父会话的行重放到文件头部（时间早于首行）。 */
  let sessionStartMs: number | null = null

  function billable(time: number, usage: Record<string, unknown>, messageId: string, model: string | null): void {
    const { counts, identityOk } = mapClaudeUsage(usage)
    if (!identityOk) diagnostics.claudeIdentityViolations++
    // 四类全 0 的行（本机实测为 0 处，但形态存在）不是用量，不替上游入库。
    if (counts.total === 0) { diagnostics.claudeZeroUsage++; return }
    if (model === null) diagnostics.claudeMissingModel++
    diagnostics.usageEvents++
    records.push({
      // ★ 只有非 DSH 来源才带前缀：DSH 的 event_id 是上报库主键，改它等于让服务端
      //   把历史事件再插一遍（全量补报时数字翻倍，且不报错）。
      eventId: `claude-code:${meta.sessionId}:${messageId}`,
      source: 'claude-code',
      sessionId: meta.sessionId,
      // 序列号只用于「会话内单调」的诊断与水位线；真正的幂等身份在 messageId 里。
      seq: records.length,
      time,
      provider: CLAUDE_PROVIDER,
      model: model ?? '(unknown)',
      cwd,
      turn: null,
      step: null,
      usage: counts,
    })
  }

  function handle(ev: Record<string, unknown>): void {
    diagnostics.totalEvents++
    // `type` 是这一批日志里唯一的信封判别字段（没有它什么都不该做）。
    const type = str(ev['type']) ?? '(no-type)'
    diagnostics.eventTypes.set(type, (diagnostics.eventTypes.get(type) ?? 0) + 1)
    if (type !== 'assistant') return

    const message = obj(ev['message'])
    if (message === null) { diagnostics.claudeAssistantWithoutUsage++; return }
    const model = str(message['model'])
    // `<synthetic>` 是 Claude Code 自己造的消息（本机实测 3 条，无 usage）：
    // 它不是任何一次 API 调用，采它等于给一个本地标记编一笔用量。
    if (model === '<synthetic>') { diagnostics.claudeSyntheticRows++; return }
    const usage = obj(message['usage'])
    if (usage === null) { diagnostics.claudeAssistantWithoutUsage++; return }

    const time = typeof ev['timestamp'] === 'string' ? Date.parse(ev['timestamp']) : NaN
    if (sessionStartMs === null && Number.isFinite(time)) {
      sessionStartMs = time
      if (meta.createdAt === null) meta.createdAt = time
    }
    cwd = str(ev['cwd']) ?? cwd

    // ★ 幂等键主体：`message.id` 是那次 API 调用的身份，重复行的 `uuid` 各不相同
    //   （见文件头第 3 条）。缺失时退回行 `uuid` —— 那样这一轮不会去重，
    //   但至少不会把两行不同的调用合成一条（宁可多算一次可见的重复，不可少算）。
    const messageId = str(message['id']) ?? str(ev['uuid'])
    if (messageId === null) { diagnostics.claudeAssistantWithoutUsage++; return }
    if (seenMessages.has(messageId)) { diagnostics.claudeDuplicateWrites++; return }
    seenMessages.add(messageId)

    billable(Number.isFinite(time) ? time : 0, usage, messageId, model)
  }

  function consume(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const ev = obj(parsed)
        if (ev !== null) handle(ev)
      } catch {
        // 追加写途中的半行：丢掉，下一轮从光标处重读
      }
    }
  }

  return {
    push(chunk: string) {
      const text = pending + chunk
      const end = text.lastIndexOf('\n')
      if (end < 0) { pending = text; return }
      consume(text.slice(0, end))
      pending = text.slice(end + 1)
    },
    finish() {
      if (pending.trim()) consume(pending)
      pending = ''
      // 把解析出的项目归属写回 `meta`：增量路径要靠它跨轮继承（与 DSH / Codex 同款）。
      meta.cwd = cwd
    },
  }
}

/**
 * Claude Code 的 provider 标签。
 *
 * ★ 取一个**常量**而不是从日志里猜：Claude Code 的行里只有 `message.model`
 *   （`claude-opus-4-8` / `claude-sonnet-4-6` …），没有厂商字段。
 *   留空或写 `(none)` 会让「按厂商看金额」少掉整个来源，而单价是按
 *   `(provider, model)` 精确匹配的 —— 那等于这一源永远配不上价。
 */
export const CLAUDE_PROVIDER = 'anthropic'

/** 递归列 `.jsonl`（深度受限：子代理最多再多两层，多留几层容错）。 */
async function listJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    // 目录符号链接不跟随：家目录下出现一个环会让列举**永远转下去**。
    if (entry.isDirectory()) { await listJsonl(path, depth - 1, out); continue }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
}

/**
 * 列举一个根下的会话文件。
 *
 * ★ 根既可以是**目录**（正常情形：`<home>/projects`），也可以直接是**一个 jsonl 文件**。
 *   后者不是怪癖：验证脚本要按文件粒度与独立实现逐条比对，就得把范围收窄到一个文件；
 *   而 `readdir()` 对文件路径只会抛 `ENOTDIR`，被吞掉之后就是**一份空列举** ——
 *   「比对全绿」会变成「一条都没比」，正是本仓最忌讳的那种静默 0。
 */
async function listSessionJsonl(rootPath: string, depth: number): Promise<string[]> {
  if (rootPath.endsWith('.jsonl')) return [rootPath]
  const out: string[] = []
  await listJsonl(rootPath, depth, out)
  return out
}

export const claudeCodeSource: SessionSourceAdapter = {
  id: 'claude-code',
  encoding: 'plain-jsonl',
  disableEnv: CLAUDE_DISABLED_ENV,

  roots(homes) {
    // 优先级：显式 homes > `DSH_TOKEN_REPORT_CLAUDE_HOMES`（本项目扩展的多根，`path.delimiter`
    // 分隔）> `$CLAUDE_CONFIG_DIR`（官方变量，单根）> `~/.claude`。
    // ⚠️ 多根那一支此前**只声明、没人读**（而 `--help` 已经把它写成了可用开关）——
    //    症状是「按文档设了环境变量，数字一点没变」，且不报错。加第三个来源时一并接上。
    const envHomes = splitHomeList(process.env[CLAUDE_HOMES_ENV])
    const bases = homes.length > 0
      ? [...homes]
      : (envHomes.length > 0
          ? envHomes
          : [...new Set([(process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim(), defaultClaudeHome()].filter((h) => h !== ''))])
    return bases.map((home): SourceRoot => ({ path: join(home, 'projects'), source: 'claude-code' }))
  },

  async list(root, options = {}) {
    // `projects/<项目>/<uuid>.jsonl` 是两层，子代理再多两层；给 6 层容错。
    const files = await listSessionJsonl(root.path, 6)
    const out: SessionMeta[] = []
    for (const filePath of files) {
      const name = filePath.split(/[\\/]/).pop() ?? ''
      const sessionId = claudeSessionIdFromName(name)
      // 非会话文件（`subagents/agent-*.jsonl`、`journal.jsonl`、任何别的 jsonl）
      // 一律不列举：它们的行要么属于别处的调用，要么根本不是用量。
      if (sessionId === null) continue
      let size: number
      try { size = (await stat(filePath)).size } catch (error) {
        if (options.strictErrors) throw error
        continue
      }
      // 0 字节文件 = 会话刚创建还没写入：当「无用量」跳过，不报错、也不计入会话数。
      if (size === 0) continue
      // 项目归属用**目录名**（Claude Code 把项目路径编码成目录名，
      // 例如 `D--Coding-agent-foo`）；真实 cwd 在行里，折叠时优先用行里的。
      const projectDir = relative(root.path, filePath).split(/[\\/]/).slice(0, -1).join('/')
      out.push({
        source: 'claude-code',
        sessionId,
        cwd: null,
        createdAt: null,
        projectDir,
        filePath,
      })
    }
    return out
  },

  createFolder(meta, diagnostics, records) {
    return createClaudeFolder(meta, diagnostics, records)
  },

  // ★ 巡检必须用 Claude Code 自己的目录结构：拿 DSH 的「<project>/<sessionId>/<file>」
  //   去数这里的「<项目目录>/<uuid>.jsonl」只会得到 0/0 —— 一个看起来完全正常的空目录。
  async inspect(root) {
    const metas = await claudeCodeSource.list(root)
    let latestMs: number | null = null
    for (const meta of metas) {
      try {
        const st = await stat(meta.filePath)
        if (latestMs === null || st.mtimeMs > latestMs) latestMs = st.mtimeMs
      } catch {
        // 单个文件 stat 失败只影响「最新写入」，不该让整个巡检失败
      }
    }
    return { sessions: new Set(metas.map((meta) => meta.sessionId)).size, files: metas.length, latestMs }
  },
}
