/**
 * **Codex 来源适配器**（Codex CLI / Codex Desktop / VSCode 扩展共用的 rollout 日志）。
 *
 * ```
 * $CODEX_HOME（缺省 ~/.codex）/
 * ├── sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl
 * └── archived_sessions/YYYY/MM/DD/rollout-*.jsonl        ← 次要副本
 * ```
 *
 * 每行一个信封：`{"timestamp": ISO8601, "ordinal": <文件内单调整数>, "type": T, "payload": {...}}`。
 *
 * ## 四条实测口径（错了不会报错，只会数字悄悄不对）
 *
 * 1. 🚨 **`cached_input_tokens` 与 `cache_write_input_tokens` 都含在 `input_tokens` 内**
 *    （与 DSH 相反：DSH 的 `inputTokens` 是**未命中缓存**那部分）。
 *    实测 `total_tokens == input_tokens + output_tokens` 恒成立 ⇒ 未命中部分
 *    `= input_tokens - cached - cache_write`。映射后本仓恒等式
 *    `total = input + output + cacheRead + cacheWrite` 逐条等于上游的 `total_tokens`。
 *
 * 2. 🚨 **同一次调用会写两条同值的 `token_count`**（一次调用事件 + 一次 `item_completed`）。
 *    逐行相加总量**正好翻倍**（本机实测 2.0×）。因此按 `total_token_usage` 的
 *    **累计快照是否推进**判定：快照没变 ⇒ 同一次调用的第二次写入 ⇒ 跳过。
 *
 * 3. 🚨 **两代遥测会同时出现在一个文件里**：新版本额外写 `token_usage_record`
 *    （带 `response_id`，`payload.usage` 才是本次调用；`turn_token_usage` /
 *    `thread_token_usage` 是累计值，**求和即错**）。规则：**先出现的代际说了算**，
 *    另一种只计数不采（`codexOtherGenerationSkipped`）—— 宁可少算一代，也不双计。
 *
 * 4. 🚨 **幂等键主体必须是文件名里的 uuid，不能是信封里的 `session_id`**：
 *    实测 51 个文件的信封 `session_id` 与文件名不一致，而且**多个文件共用同一个信封 id**
 *    （续写 / 分叉会话），而 `ordinal` 是**文件内**计数、每个文件都从 0 开始 ——
 *    用信封 id 做键会让这些文件互相撞主键，`INSERT OR IGNORE` 把真实用量**静默丢掉**。
 *    因此这里用文件名 uuid，并把不一致记进 `codexMetaMismatch`（要能看见）。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { addCounts, emptyCounts,
  type ScanDiagnostics, type SessionMeta, type TokenCounts, type UsageRecord,
} from '../types.js'
import { splitHomeList } from '../home.js'
import type { SessionSourceAdapter, SourceFolder, SourceRoot } from './types.js'

/** Codex 的 home 环境变量（Codex 官方变量）。 */
export const CODEX_HOME_ENV = 'CODEX_HOME'

/** 多个 Codex home（本项目扩展，`path.delimiter` 分隔）。 */
export const CODEX_HOMES_ENV = 'DSH_TOKEN_REPORT_CODEX_HOMES'

/** 关闭 Codex 采集的开关（测试与「只想看 DSH」时用）。 */
export const CODEX_DISABLED_ENV = 'DSH_TOKEN_REPORT_CODEX'

/** Codex 缺省 home（家目录下的 `.codex`）。 */
export function defaultCodexHome(): string {
  return join(homedir(), '.codex')
}

/** 从文件名取会话 uuid（`rollout-<ISO>-<uuid>.jsonl`）。取不到返回 null。 */
export function codexSessionIdFromName(name: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)
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
 * 把 Codex 的用量对象映射成本仓的四列。
 *
 * ★ 这是**全仓唯一**允许出现「Codex 的 cached 含在 input 内」这条语义的地方。
 *   导出它是为了让测试与验证脚本直接钉住这个映射，而不是各自再写一遍。
 */
export function mapCodexUsage(usage: Record<string, unknown>): {
  counts: TokenCounts
  /** 四列之和是否等于上游上报的 `total_tokens`（正常恒 true）。 */
  identityOk: boolean
  /** `cached + cache_write > input`：上游语义变了（映射会出负值，已夹 0），必须能被看见。 */
  overlap: boolean
} {
  const rawInput = num(usage['input_tokens'])
  const cacheRead = num(usage['cached_input_tokens'])
  const cacheWrite = num(usage['cache_write_input_tokens'])
  const reportedTotal = usage['total_tokens']

  const counts = emptyCounts()
  addCounts(counts, {
    inputTokens: Math.max(0, rawInput - cacheRead - cacheWrite),
    outputTokens: num(usage['output_tokens']),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: num(usage['reasoning_output_tokens']),
  })
  return {
    counts,
    identityOk: typeof reportedTotal === 'number' && counts.total === reportedTotal,
    overlap: cacheRead + cacheWrite > rawInput,
  }
}

/**
 * 逐文件折叠（状态在闭包里，与 DSH 侧 `eventCollector` 同构）。
 *
 * 文件是 append-only 的，折叠器只处理**新增的文本块**：跨块的累计快照、
 * 模型上下文、会话首行时间都要留着，否则增量块里没有 `turn_context`
 * 时模型会退化成 `(unknown)`。起始 `cwd` 从 `meta.cwd` 继承（既有约定）。
 */
function createCodexFolder(
  meta: SessionMeta,
  diagnostics: ScanDiagnostics,
  records: UsageRecord[],
): SourceFolder {
  let pending = ''
  // 本文件的折叠已经开始 ⇒ 计入「采到的文件数」（与 `claudeFiles` / `traeFiles` /
  // `workbuddyFiles` 同义）。
  // 🚨 这个计数**必须由适配器自己加**：它以前写在 `scanner.ts` 的 `scanSourceFile()`
  //   里，于是有两个后果 ——
  //   ① 直扫路径把它加给**任何**纯文本来源（选了 Claude Code 也会看到 codexFiles 涨）；
  //   ② 本地库路径（`ingestPlainSources`）根本不走那里 ⇒ `codexFiles` 恒为 0，
  //      与 58,858 条 `usageEvents` 摆在一起，看着就像「一个文件都没采到」。
  diagnostics.codexFiles++
  /** 会话首行时间：fork 会把父会话的行重放到文件头部（时间早于首行）—— 那些不计费。 */
  let sessionStartMs: number | null = null
  let provider: string | null = null
  let model: string | null = null
  // 起始 cwd 取自 `meta.cwd`（增量块里没有 `session_meta` 时靠它继承项目归属）。
  let cwd: string | null = meta.cwd
  /** 代际：先出现的说了算；`null` = 还没遇到任何计费事件。 */
  let generation: 'A' | 'B' | null = null
  /** A 代际：上一次的累计快照（判定「同一次调用被写了两遍」）。 */
  let prevSnapshot: string | null = null
  /** A 代际：逐条求和 + 文件末快照，收尾时比对（对不齐要能被看见）。 */
  const sumA = emptyCounts()
  let lastSnapshot: Record<string, unknown> | null = null
  /** B 代际：已采的 `response_id`（同一次调用可能被重放）。 */
  const seenResponses = new Set<string>()

  function billable(time: number, seq: number, usage: Record<string, unknown>): void {
    const { counts, identityOk, overlap } = mapCodexUsage(usage)
    if (!identityOk) diagnostics.codexIdentityViolations++
    if (overlap) diagnostics.codexOverlapAnomalies++
    // 实测有极少数事件只有 `total_tokens`、四类全 0（不可拆分的重置标记）：
    // 拆不出四列就不入库（否则等于替上游的一个标记编出一笔用量），但要计数。
    if (counts.total === 0) { diagnostics.codexZeroUsage++; return }
    diagnostics.usageEvents++
    records.push({
      // ★ 只有非 DSH 来源才带前缀：DSH 的 event_id 是上报库主键，改它等于让服务端
      //   把历史事件再插一遍（全量补报时数字翻倍，且不报错）。
      eventId: `codex:${meta.sessionId}:${seq}`,
      source: 'codex',
      sessionId: meta.sessionId,
      seq,
      time,
      provider: provider ?? '(none)',
      model: model ?? '(unknown)',
      cwd,
      turn: null,
      step: null,
      usage: counts,
    })
  }

  /** 分叉重放保护：首行之前的计费事件不计入（宁可少算重放，不可重复计费）。 */
  function replayed(time: number): boolean {
    if (sessionStartMs === null || !Number.isFinite(time) || time >= sessionStartMs) return false
    diagnostics.codexReplayedEvents++
    return true
  }

  function handle(ev: Record<string, unknown>): void {
    diagnostics.totalEvents++
    const type = str(ev['type']) ?? '(no-type)'
    diagnostics.eventTypes.set(type, (diagnostics.eventTypes.get(type) ?? 0) + 1)
    const payload = obj(ev['payload'])
    const time = typeof ev['timestamp'] === 'string' ? Date.parse(ev['timestamp'] as string) : NaN
    const ordinal = num(ev['ordinal'])

    if (type === 'session_meta') {
      const id = str(payload?.['session_id']) ?? str(payload?.['id'])
      // 文件名里的 uuid 才是**幂等键主体**（见文件头第 4 条）；不一致要能被看见，而不是猜。
      if (id !== null && id.toLowerCase() !== meta.sessionId) diagnostics.codexMetaMismatch++
      const startRaw = str(payload?.['timestamp'])
      sessionStartMs = startRaw !== null ? Date.parse(startRaw) : null
      if (Number.isFinite(sessionStartMs as number) && meta.createdAt === null) meta.createdAt = sessionStartMs
      provider = str(payload?.['model_provider']) ?? provider
      cwd = str(payload?.['cwd']) ?? cwd
      return
    }

    if (type === 'turn_context') {
      // ★ 模型名的唯一来源：实测 44,510 个 token_count 里只有 1 个没有模型上下文。
      model = str(payload?.['model']) ?? model
      cwd = str(payload?.['cwd']) ?? cwd
      return
    }

    if (type === 'token_usage_record') {
      if (generation === 'A') { diagnostics.codexOtherGenerationSkipped++; return }
      generation = 'B'
      const responseId = str(payload?.['response_id'])
      if (responseId !== null) {
        if (seenResponses.has(responseId)) return
        seenResponses.add(responseId)
      }
      if (replayed(time)) return
      const usage = obj(payload?.['usage'])
      // `usage` 缺失就当空 info 处理：跳过并计数，不猜。
      if (usage === null) { diagnostics.codexNullInfo++; return }
      billable(time, ordinal, usage)
      return
    }

    if (type !== 'event_msg' || payload?.['type'] !== 'token_count') return
    const info = obj(payload['info'])
    // 旧版会写 `info: null`；跳过并计数。
    if (info === null) { diagnostics.codexNullInfo++; return }
    const last = obj(info['last_token_usage'])
    const total = obj(info['total_token_usage'])
    if (last === null || total === null) { diagnostics.codexNullInfo++; return }

    if (generation === 'B') { diagnostics.codexOtherGenerationSkipped++; return }
    generation = 'A'

    const snapshot = JSON.stringify(total)
    if (snapshot === prevSnapshot) return            // 同一次调用的第二次写入 ⇒ 跳过
    prevSnapshot = snapshot
    lastSnapshot = total
    const { counts } = mapCodexUsage(last)
    // 逐条求和（收尾时与文件末累计快照比对，判断上游有没有漏发）
    sumA.input += counts.input
    sumA.output += counts.output
    sumA.cacheRead += counts.cacheRead
    sumA.cacheWrite += counts.cacheWrite
    sumA.reasoning += counts.reasoning
    sumA.total += counts.total
    sumA.calls += 1
    if (replayed(time)) return
    billable(time, ordinal, last)
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
      // 把解析出的项目归属写回 `meta`：增量路径要靠它跨轮继承（与 DSH 侧同款）。
      meta.cwd = cwd
      // 累计快照与逐条求和的比对：实测本机约 1% 的文件对不齐。
      // **允许非 0，但必须显示** —— 它是「上游漏发了 token_count」的唯一信号。
      if (lastSnapshot !== null && generation === 'A') {
        const cumulative = num(lastSnapshot['input_tokens']) + num(lastSnapshot['output_tokens'])
        if (cumulative !== sumA.total) diagnostics.codexCounterDriftFiles++
      }
    },
  }
}

/** 递归列目录（深度受限：`YYYY/MM/DD/` 三层足够，多留一层容错）。 */
async function listJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { await listJsonl(path, depth - 1, out); continue }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
}

export const codexSource: SessionSourceAdapter = {
  id: 'codex',
  encoding: 'plain-jsonl',
  disableEnv: CODEX_DISABLED_ENV,

  roots(homes) {
    // 优先级：显式 homes > `DSH_TOKEN_REPORT_CODEX_HOMES`（本项目扩展的多根，`path.delimiter`
    // 分隔）> `$CODEX_HOME`（Codex 官方变量，单根）> `~/.codex`。
    // ⚠️ 多根那一支此前**只声明、没人读**（而 `--help` 已经把它写成了可用开关）——
    //    症状是「按文档设了环境变量，数字一点没变」，且不报错。加第三个来源时一并接上。
    const envHomes = splitHomeList(process.env[CODEX_HOMES_ENV])
    const bases = homes.length > 0
      ? [...homes]
      : (envHomes.length > 0
          ? envHomes
          : [...new Set([(process.env[CODEX_HOME_ENV] ?? '').trim(), defaultCodexHome()].filter((h) => h !== ''))])
    const out: SourceRoot[] = []
    for (const home of bases) {
      out.push({ path: join(home, 'sessions'), source: 'codex' })
      // 次要副本：归档与活动目录都收，同一会话以**先列举者**为准（活动副本优先）。
      out.push({ path: join(home, 'archived_sessions'), source: 'codex', secondary: true })
    }
    return out
  },

  async list(root, options = {}) {
    const files: string[] = []
    await listJsonl(root.path, 3, files)
    const out: SessionMeta[] = []
    for (const filePath of files) {
      const name = filePath.split(/[\\/]/).pop() ?? ''
      if (!name.startsWith('rollout-')) continue
      const sessionId = codexSessionIdFromName(name)
      if (sessionId === null) continue
      // 🚨 这里**刻意不 stat**（`strictErrors` 因此不再用得上，保留参数是为了接口一致）。
      //
      // 列举是**每次取数都要走**的热路径（本机 1,500+ 文件），而每个文件的大小在下游
      // （入库的 L1 判定、折叠前的读文件）**必然还要读一次** —— 在这里再 stat 一遍，
      // 等于让每个文件被 stat 两遍：热态实测白花 ~100ms（1,500 文件 × ~0.07ms）。
      //
      // 0 字节文件（会话刚创建还没写入）在真正读它时自然产出 0 条记录，而「会话数」
      // 是从记录里数出来的（扫描路径数 `records` 的 sessionId，库路径走
      // `querySessionCount`），所以数字不受影响。
      out.push({
        source: 'codex',
        sessionId,
        cwd: null,
        createdAt: null,
        projectDir: filePath.slice(root.path.length + 1).split(/[\\/]/).slice(0, -1).join('/'),
        filePath,
      })
    }
    return out
  },

  createFolder(meta, diagnostics, records) {
    return createCodexFolder(meta, diagnostics, records)
  },

  // ★ 巡检必须用 Codex 自己的目录结构：拿 DSH 的「<project>/<sessionId>/<file>」
  //   去数这里的「<YYYY>/<MM>/<DD>/rollout-*.jsonl」只会得到 0/0 —— 一个
  //   看起来完全正常的空目录（「静默 0」最典型的形态）。
  async inspect(root) {
    const metas = await codexSource.list(root)
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
