/**
 * **WorkBuddy 会话格式哨兵**（P0 级）：把「WorkBuddy 的计费日志长什么样」固化下来。
 *
 * ## 为什么需要这一层
 *
 * 适配器里那些「不会报错、只会数字悄悄不对」的口径，全部来自**对真实日志的观察**：
 *
 * | 观察 | 错了会怎样 |
 * |---|---|
 * | `prompt_tokens` **含**缓存命中 | 照抄「原样」写法 ⇒ 缓存读被算两遍（总量虚高） |
 * | 缓存字段要按 `prompt_cache_hit_tokens` > `cache_read_input_tokens` 取值 | 先读后者（实测恒为 0）⇒ 缓存与输入整块对调 |
 * | 用量挂在**响应的最后一行**，行类型不固定 | 只认 `message/assistant` ⇒ 漏掉 3/4 的工具轮次用量 |
 * | **老代际没有缓存字段** | 不报出来 ⇒ 「这一源缓存命中率被系统性低估」看不出来 |
 * | 迁移过来的老会话 `timestamp: 0` | 退化成 1970 ⇒ 用量落到时间窗之外（看起来「没有用量」） |
 * | 嵌套的 `subagents/<taskId>.jsonl` 是独立会话 | 只扫顶层 ⇒ 子代理用量整块消失 |
 *
 * 这些结论一旦上游改格式就会静默失效。所以这里做两件事：
 *
 * 1. **合成夹具**（默认运行）：把上面每一条变成一条可执行断言，格式漂移时**在这里炸**；
 * 2. `--real`：在**本机真实日志**上把适配器的输出与脚本内**独立实现的解析**
 *    逐条比对（独立实现是刻意的 —— 复用适配器等于自己验证自己），
 *    并把实测的失真统计打印出来。只读：不写库、不写数据目录、不改任何文件。
 *
 * 运行：
 * ```
 * bun run --filter '@ai-token-report/core' verify:workbuddy
 * bun run --filter '@ai-token-report/core' verify:workbuddy -- --real
 * ```
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  WORKBUDDY_CONFIG_DIR_ENV,
  WORKBUDDY_DATA_FOLDER_NAME_ENV,
  WORKBUDDY_DISABLED_ENV,
  WORKBUDDY_HOMES_ENV,
  WORKBUDDY_PROVIDER,
  defaultWorkBuddyHome,
  mapWorkBuddyUsage,
  parseWorkBuddyUsage,
  workbuddySessionIdOf,
  workbuddySource,
} from '../src/sources/workbuddy.js'
import { requireSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { scanAllSources } from '../src/scanner.js'
import { emptyDiagnostics, type UsageRecord } from '../src/types.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'
import { openStats } from '../src/db/stats.js'

let checks = 0
let failures = 0
let skips = 0
let observations = 0

function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`)
}

function skip(label: string, reason: string): void {
  skips++
  console.log(`  ⏭ ${label}：${reason}`)
}

function observe(label: string, detail: string): void {
  observations++
  console.log(`  ⚠ ${label}`)
  console.log(`      ${detail}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────`)
}

/** 千分位（日志与总量都是大数，裸数字读不出量级）。 */
function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ── 合成夹具 ────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'atr-verify-workbuddy-'))
const SESSION = 'd992a024-9766-414c-9847-185977f67f0b'
const PROJECT = 'c-Users-Administrator-WorkBuddy-2026-10-03-10-53-08'
const CWD = 'c:\\Users\\Administrator\\WorkBuddy\\2026-10-03-10-53-08'

/** 新代际一行（默认照抄本机真实样本：51937 = 48512 命中 + 3425 未命中，total 52463）。 */
function newLine(opts: {
  type?: string
  messageId?: string
  id?: string
  time?: number
  cwd?: string
  model?: string | null
  prompt?: number
  completion?: number
  hit?: number
  miss?: number
  write?: number
  total?: number
  noRaw?: boolean
  /**
   * 不带用量（`reasoning` / 普通 `message` 行就是这样）：实测一个响应里
   * **只有一行**带用量，其余同 `messageId` 的行一个字段都没有。
   */
  noUsage?: boolean
} = {}): string {
  const prompt = opts.prompt ?? 51937
  const completion = opts.completion ?? 526
  const hit = opts.hit ?? 48512
  const pd: Record<string, unknown> = {
    messageId: opts.messageId ?? 'm-1',
    model: opts.model === undefined ? 'deepseek-v4.1-flash' : opts.model,
  }
  if (opts.noUsage !== true) {
    pd['usage'] = {
      requests: 1,
      inputTokens: prompt,
      outputTokens: completion,
      totalTokens: opts.total ?? prompt + completion,
      inputTokensDetails: [{ cached_tokens: hit }],
      outputTokensDetails: [{ reasoning_tokens: 214 }],
    }
  }
  if (opts.noUsage !== true && opts.noRaw !== true) {
    pd['rawUsage'] = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: opts.total ?? prompt + completion,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: opts.miss ?? prompt - hit,
      prompt_cache_write_tokens: opts.write ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: hit },
      completion_tokens_details: { reasoning_tokens: 214 },
    }
  }
  return JSON.stringify({
    id: opts.id ?? '01a0ffae-7b61-7b0b-98c4-3e74718301c4',
    type: opts.type ?? 'function_call',
    timestamp: opts.time ?? 1790996024251,
    sessionId: SESSION,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    providerData: pd,
  })
}

/** 老代际一行（snake_case `usage`，没有缓存字段、没有 `rawUsage`、时间戳常为 0）。 */
function oldLine(opts: { id?: string; time?: number; prompt?: number; completion?: number; model?: string | null } = {}): string {
  const prompt = opts.prompt ?? 26219
  const completion = opts.completion ?? 17
  return JSON.stringify({
    id: opts.id ?? '845c177f4e204291b4112bc1a8cf7615',
    type: 'message',
    role: 'assistant',
    timestamp: opts.time ?? 1775534024502,
    sessionId: SESSION,
    providerData: {
      model: opts.model === undefined ? 'auto' : opts.model,
      usage: { input_tokens: prompt, output_tokens: completion, total_tokens: prompt + completion },
    },
  })
}

/** 一条与用量无关的行。 */
function noise(): string {
  return JSON.stringify({ id: 'deadbeefdeadbeefdeadbeefdeadbeef', type: 'function_call_result', timestamp: 1790996024251, sessionId: SESSION })
}

/** 造一个会话文件（`projects/<项目键>/<名字>.jsonl`），返回完整路径。 */
function writeSession(
  home: string,
  name: string,
  lines: readonly string[],
  options: { projectKey?: string; sidecar?: Record<string, unknown>; subdir?: string } = {},
): string {
  const target = join(home, 'projects', options.projectKey ?? PROJECT, options.subdir ?? '')
  mkdirSync(target, { recursive: true })
  const file = join(target, `${name}.jsonl`)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  if (options.sidecar !== undefined) writeFileSync(join(target, `${name}.meta.json`), JSON.stringify(options.sidecar), 'utf8')
  return file
}

async function synthetic(): Promise<void> {
  section('根解析：配置目录优先级与 projects 层')
  {
    const home = join('C:', 'Users', 'someone')
    check('缺省 = ~/.workbuddy（WorkBuddy 自己的缺省目录名）',
      defaultWorkBuddyHome({ env: {}, home }) === join(home, '.workbuddy'))
    check('`$WORKBUDDY_DATA_FOLDER_NAME` 换掉家目录下的目录名（定制版）',
      defaultWorkBuddyHome({ env: { [WORKBUDDY_DATA_FOLDER_NAME_ENV]: 'aima' }, home }) === join(home, 'aima'))
    check('`$WORKBUDDY_CONFIG_DIR` 优先级最高（私有化部署指到别处）',
      defaultWorkBuddyHome({ env: { [WORKBUDDY_CONFIG_DIR_ENV]: 'D:\\wb', [WORKBUDDY_DATA_FOLDER_NAME_ENV]: 'aima' }, home }) === 'D:\\wb')
    check('空白的环境变量当「没给」（否则会得到一个空路径的根：永远 0 条且不报错）',
      defaultWorkBuddyHome({ env: { [WORKBUDDY_CONFIG_DIR_ENV]: '   ' }, home }) === join(home, '.workbuddy'))
    check('根 = <配置目录>/projects（不是 logs/ —— 那下面一行用量都没有）',
      workbuddySource.roots(['/x'])[0]?.path === join('/x', 'projects')
      && workbuddySource.roots(['/x'])[0]?.source === 'workbuddy')
    check('开关与多根环境变量各自钉住',
      requireSource('workbuddy').disableEnv === WORKBUDDY_DISABLED_ENV
      && requireSource('workbuddy').encoding === 'plain-jsonl')

    const saved = process.env[WORKBUDDY_HOMES_ENV]
    process.env[WORKBUDDY_HOMES_ENV] = ['/a', '/b'].join(delimiter)
    try {
      const paths = workbuddySource.roots([]).map((root) => root.path)
      check('多根环境变量真的被读到（Codex / Claude 的同名开关此前是「只在帮助里存在」）',
        paths.length === 2 && paths[0] === join('/a', 'projects') && paths[1] === join('/b', 'projects'), paths.join(' + '))
    } finally {
      if (saved === undefined) delete process.env[WORKBUDDY_HOMES_ENV]
      else process.env[WORKBUDDY_HOMES_ENV] = saved
    }
  }

  section('列举：哪些文件算会话')
  {
    const home = join(dir, 'list')
    writeSession(home, SESSION, [newLine()], { sidecar: { createdAt: 1790995988745, cwd: CWD } })
    const projectDir = join(home, 'projects', PROJECT)
    // 真实存在过的邻居文件：任何一个被当成会话都会让「会话数 / 日志数」虚高
    writeFileSync(join(projectDir, `${SESSION}.file-rollback.ndjson`), '{"a":1}\n', 'utf8')
    writeFileSync(join(projectDir, `${SESSION}.quickask`), '', 'utf8')
    writeFileSync(join(projectDir, `${SESSION}.acp-session.json`), '{}', 'utf8')
    writeFileSync(join(projectDir, 'empty.jsonl'), '', 'utf8')

    const root = workbuddySource.roots([home])[0]!
    const metas = await workbuddySource.list(root)
    check('只认 `<sessionId>.jsonl`（回滚 / quickask / acp / 0 字节都不算）',
      metas.length === 1, metas.map((m) => m.filePath).join(', '))
    check('会话 id = 相对根路径（`<项目键>/<sessionId>`）',
      metas[0]?.sessionId === `${PROJECT}/${SESSION}`, metas[0]?.sessionId ?? '(无)')
    check('侧车 `.meta.json` 的 cwd / createdAt 被读到（迁移老会话在 JSONL 里没有 cwd）',
      metas[0]?.cwd === CWD && metas[0]?.createdAt === 1790995988745)

    const info = await workbuddySource.inspect(root)
    check('inspect 用 WorkBuddy 自己的形态数（拿 DSH 的三层结构去数这里会得到 0/0）',
      info.sessions === 1 && info.files === 1, `${info.sessions}/${info.files}`)
    check('inspect 报得出「最近写入」', (info.latestMs ?? 0) > 0)

    const emptyRoot = { path: join(dir, 'not-there'), source: 'workbuddy' as const }
    const empty = await workbuddySource.inspect(emptyRoot)
    check('不存在的根：0/0 且不抛错', empty.sessions === 0 && empty.files === 0 && empty.latestMs === null)

    const nestedHome = join(dir, 'nested')
    writeSession(nestedHome, SESSION, [newLine()])
    writeSession(nestedHome, 'task-1', [newLine({ messageId: 'child', id: 'child-1' })], { subdir: join(SESSION, 'subagents') })
    const nestedScan = await scanAllSources(workbuddySource.roots([nestedHome]))
    check('嵌套的子代理会话文件也算（`<sessionId>/subagents/<taskId>.jsonl`）',
      nestedScan.records.length === 2 && nestedScan.diagnostics.workbuddyNestedSessionFiles === 1,
      `${nestedScan.records.length} 条 / 嵌套文件 ${nestedScan.diagnostics.workbuddyNestedSessionFiles}`)

    const mirrorA = join(dir, 'mirror-a')
    const mirrorB = join(dir, 'mirror-b')
    const lines = [newLine({ messageId: 'm-1', id: 'i-1' }), newLine({ messageId: 'm-2', id: 'i-2' })]
    writeSession(mirrorA, SESSION, lines)
    writeSession(mirrorB, SESSION, lines)
    const mirrored = await scanAllSources([...workbuddySource.roots([mirrorA]), ...workbuddySource.roots([mirrorB])])
    check('镜像的两个根（相对路径相同 ⇒ event_id 相同）只算一次', mirrored.records.length === 2, String(mirrored.records.length))

    const missing = resolveSourceRoots({ sources: ['workbuddy'], homes: { workbuddy: [join(dir, 'missing-home')] } })
    check('「配了但不存在」与「本来就没有」分开报', missing.roots.length === 0 && missing.missing.length === 1)
    const disabled = resolveSourceRoots({ env: { [WORKBUDDY_DISABLED_ENV]: '0' }, homes: { workbuddy: [nestedHome] } })
    check('环境开关关闭时来源进 disabled（要能分辨「关掉了」与「没数据」）', disabled.disabled.includes('workbuddy'))
  }

  section('四列口径：含缓存的 prompt 必须减')
  {
    const fields = parseWorkBuddyUsage(
      { inputTokens: 51937, outputTokens: 526, totalTokens: 52463, outputTokensDetails: [{ reasoning_tokens: 214 }] },
      { prompt_tokens: 51937, completion_tokens: 526, total_tokens: 52463, prompt_cache_hit_tokens: 48512, prompt_cache_miss_tokens: 3425 },
    )!
    const mapped = mapWorkBuddyUsage(fields)
    check('★ input = prompt − 缓存命中（3425，不是 51937）', mapped.counts.input === 3425, String(mapped.counts.input))
    check('★ 四列之和 == 上游自报 total_tokens（52463）', mapped.counts.total === 52463 && mapped.identityOk)
    check('cacheRead = 48512 / output = 526 / reasoning = 214（reasoning 不进恒等式）',
      mapped.counts.cacheRead === 48512 && mapped.counts.output === 526 && mapped.counts.reasoning === 214)
    check('miss 字段与派生值一致 ⇒ 没有 missMismatch（这条前提的直接证据）', mapped.missMismatch === false)
    check('有缓存字段 ⇒ hasCacheInfo 为真', mapped.hasCacheInfo === true)

    const swapped = parseWorkBuddyUsage(
      { inputTokens: 51937, outputTokens: 526 },
      { prompt_tokens: 51937, completion_tokens: 526, prompt_cache_hit_tokens: 48512, cache_read_input_tokens: 0 },
    )!
    check('🚨 取值顺序：prompt_cache_hit_tokens 优先于恒为 0 的 cache_read_input_tokens',
      swapped.cacheReadTokens === 48512, String(swapped.cacheReadTokens))

    const legacy = parseWorkBuddyUsage({ input_tokens: 26219, output_tokens: 17, total_tokens: 26236 }, null)!
    const legacyMapped = mapWorkBuddyUsage(legacy)
    check('老代际：没有缓存字段 ⇒ cacheRead 记 0，但 hasCacheInfo 为假（不是「真的没有缓存」）',
      legacy.cacheReadTokens === null && legacyMapped.counts.cacheRead === 0 && legacyMapped.hasCacheInfo === false)
    check('老代际的 input 仍是整段上下文（这一源的命中率因此被低估）', legacyMapped.counts.input === 26219)

    const overlap = mapWorkBuddyUsage(parseWorkBuddyUsage({ inputTokens: 10, outputTokens: 1 }, { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 50 })!)
    check('缓存读 > prompt ⇒ input 夹 0 且报 overlap（「缓存含在输入内」被推翻）',
      overlap.counts.input === 0 && overlap.overlap)
    const drift = mapWorkBuddyUsage(parseWorkBuddyUsage({ inputTokens: 1000, outputTokens: 10 }, { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 999 })!)
    check('上游给了 miss 字段却对不上 ⇒ missMismatch（比恒等式更早发现语义翻转）', drift.missMismatch)
    check('数字全缺 ⇒ 解析不出（不用 0 兜底造出一笔假用量）',
      parseWorkBuddyUsage({ requests: 1 }, null) === null && parseWorkBuddyUsage(null, null) === null)
  }

  section('折叠：行类型 / 去重 / 时间戳 / 幂等键')
  {
    const home = join(dir, 'fold')
    writeSession(home, SESSION, [
      newLine({ type: 'reasoning', messageId: 'm-1', id: 'r-1', noUsage: true }),
      newLine({ type: 'function_call', messageId: 'm-1', id: 'f-1' }),
      noise(),
      newLine({ type: 'message', messageId: 'm-2', id: 'f-2', time: 1790996025000 }),
      newLine({ type: 'function_call', messageId: 'm-2', id: 'f-3', time: 1790996026000 }), // 同 messageId 重复写
      oldLine({ id: 'a-1' }),
    ])
    const scan = await scanAllSources(workbuddySource.roots([home]))
    check('★ 用量挂在 function_call 行上也要采到（实测 3/4 条是这种）', scan.records.length === 3, `${scan.records.length} 条`)
    check('同一条响应写两次 ⇒ 只入一条并计数', scan.diagnostics.workbuddyDuplicateResponses === 1,
      String(scan.diagnostics.workbuddyDuplicateResponses))
    check('幂等键 = workbuddy:<相对路径>:<文件内序号>',
      scan.records[0]?.eventId === `workbuddy:${PROJECT}/${SESSION}:0`
      && scan.records.map((r) => r.seq).join(',') === '0,1,2',
      scan.records.map((r) => r.eventId).join(' | '))
    check('诊断成对：文件数 / 认出的用量行数', scan.diagnostics.workbuddyFiles === 1 && scan.diagnostics.workbuddyUsageLines === 4,
      `${scan.diagnostics.workbuddyFiles} / ${scan.diagnostics.workbuddyUsageLines}`)
    check('provider 恒为 workbuddy（日志里没有 provider 字段，不许拿模型名猜厂商）',
      scan.records.every((r) => r.provider === WORKBUDDY_PROVIDER && r.source === 'workbuddy'))

    const zeroHome = join(dir, 'zero')
    writeSession(zeroHome, SESSION, [newLine({ prompt: 0, completion: 0, hit: 0, miss: 0, total: 0 })])
    const zero = await scanAllSources(workbuddySource.roots([zeroHome]))
    check('四类全 0 ⇒ 不入库但计数', zero.records.length === 0 && zero.diagnostics.workbuddyZeroUsage === 1)

    const timeHome = join(dir, 'time')
    writeSession(timeHome, SESSION, [oldLine({ id: 'z-1', time: 0 }), noise(), oldLine({ id: 'z-2', time: 1775534024502 })])
    const timeScan = await scanAllSources(workbuddySource.roots([timeHome]))
    check('🚨 timestamp = 0 ⇒ 跳过并计数，不退化成 1970',
      timeScan.records.length === 1 && timeScan.records[0]?.time === 1775534024502
      && timeScan.diagnostics.workbuddyInvalidTimestamps === 1)

    const badHome = join(dir, 'bad')
    writeSession(badHome, SESSION, [
      newLine({ messageId: 'm-1', id: 'i-1', prompt: 100, completion: 1, hit: 0, miss: 0, total: 999 }),
      oldLine({ id: 'a-1' }),
    ])
    const bad = await scanAllSources(workbuddySource.roots([badHome]))
    check('恒等式不符 ⇒ identityViolations（正常恒为 0）', bad.diagnostics.workbuddyIdentityViolations === 1)
    check('老代际缺缓存 ⇒ usageWithoutCache 计数（命中率被低估要能被看见）',
      bad.diagnostics.workbuddyUsageWithoutCache === 1)

    const meta = {
      source: 'workbuddy' as const,
      sessionId: `${PROJECT}/${SESSION}`,
      cwd: null,
      createdAt: null,
      projectDir: PROJECT,
      filePath: join(dir, 'nope.jsonl'),
    }
    const diagnostics = emptyDiagnostics()
    const records: UsageRecord[] = []
    const folder = workbuddySource.createFolder(meta, diagnostics, records)
    const text = [newLine({ messageId: 'm-1', id: 'i-1' }), newLine({ messageId: 'm-2', id: 'i-2' })].join('\n') + '\n'
    folder.push(text.slice(0, 160))
    folder.push(text.slice(160))
    folder.finish()
    check('增量喂入（从行中间切开）时不丢不重', records.length === 2 && diagnostics.workbuddyFiles === 1)
    check('会话 id 计算对镜像稳定（相对路径，去掉扩展名）',
      workbuddySessionIdOf('/x/projects', join('/x', 'projects', PROJECT, SESSION, 'subagents', 'task-1.jsonl'))
        === `${PROJECT}/${SESSION}/subagents/task-1`)
  }

  section('入库：库路径与直扫同数，四列分开落库')
  {
    const home = join(dir, 'db')
    writeSession(home, SESSION, [newLine({ messageId: 'm-1', id: 'i-1' }), oldLine({ id: 'a-1' })])
    const roots = workbuddySource.roots([home])
    const dbPath = join(dir, 'usage.sqlite')
    const first = await ingestPlainSources({ roots, dbPath })
    check('首次入库 2 条', first.inserted === 2 && first.duplicates === 0)
    const second = await ingestPlainSources({ roots, dbPath })
    check('第二轮（字节数未变）整份跳过', second.inserted === 0 && second.skippedUnchanged === 1)

    const scanned = await scanAllSources(roots)
    const session = await openStats({ sessionsRoot: [], sourceRoots: roots, dbPath })
    try {
      const scanTotal = scanned.records.reduce((sum, r) => sum + r.usage.total, 0)
      check('★ 库路径总量 == 直扫总量', session.totals().total === scanTotal, `${session.totals().total} vs ${scanTotal}`)
      const bySource = session.groups('source')
      check('★ 库按来源分组时只有 workbuddy', bySource.length === 1 && bySource[0]?.key === 'workbuddy',
        JSON.stringify(bySource.map((row) => row.key)))
    } finally {
      session.close()
    }
  }
}

// ── 本机真实日志（只读）────────────────────────────────────────────────────

function listSessions(root: string, depth: number, out: string[]): void {
  if (depth < 0) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) { listSessions(p, depth - 1, out); continue }
    if (entry.isFile() && /\.jsonl$/i.test(entry.name)) out.push(p)
  }
}

/**
 * 独立实现：不复用适配器，自己认字段、自己做减法、自己去重。
 *
 * ⚠️ JSON 解析这一层没法独立（`JSON.parse` 只有一种写法），独立的是**判定与算术**：
 *    字段取哪个、要不要减、按什么去重、什么时间戳算坏 —— 这些都在这里重写一遍。
 */
function independentRecords(projectRoot: string, files: readonly string[]): {
  rows: { sessionId: string; time: number; cols: string; total: number; naive: number }[]
  usageLines: number
  legacyRows: number
  withCacheRows: number
  badTime: number
  identityViolations: number
  duplicates: number
  models: Map<string, number>
} {
  const rows: { sessionId: string; time: number; cols: string; total: number; naive: number }[] = []
  const models = new Map<string, number>()
  let usageLines = 0
  let legacyRows = 0
  let withCacheRows = 0
  let badTime = 0
  let identityViolations = 0
  let duplicates = 0
  for (const file of files) {
    const seen = new Set<string>()
    const text = readFileSync(file, 'utf8')
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim()
      if (trimmed === '') continue
      let ev: Record<string, any>
      try { ev = JSON.parse(trimmed) } catch { continue }
      const pd = ev['providerData']
      if (pd === null || typeof pd !== 'object') continue
      const usage = pd['usage']
      const rawUsage = pd['rawUsage']
      if ((usage === null || typeof usage !== 'object') && (rawUsage === null || typeof rawUsage !== 'object')) continue
      usageLines++
      const prompt = typeof usage?.['inputTokens'] === 'number' ? usage['inputTokens']
        : typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens']
          : typeof rawUsage?.['prompt_tokens'] === 'number' ? rawUsage['prompt_tokens'] : null
      const completion = typeof usage?.['outputTokens'] === 'number' ? usage['outputTokens']
        : typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens']
          : typeof rawUsage?.['completion_tokens'] === 'number' ? rawUsage['completion_tokens'] : null
      if (prompt === null || completion === null) continue
      const reported = typeof usage?.['totalTokens'] === 'number' ? usage['totalTokens']
        : typeof usage?.['total_tokens'] === 'number' ? usage['total_tokens']
          : typeof rawUsage?.['total_tokens'] === 'number' ? rawUsage['total_tokens'] : null
      // 老代际：整条记录里一个 cache 字段都没有
      const hasCacheField = rawUsage !== null && typeof rawUsage === 'object'
        && ('prompt_cache_hit_tokens' in rawUsage || 'cache_read_input_tokens' in rawUsage)
      let hit: number
      if (hasCacheField) {
        hit = typeof rawUsage['prompt_cache_hit_tokens'] === 'number'
          ? rawUsage['prompt_cache_hit_tokens']
          : (typeof rawUsage['cache_read_input_tokens'] === 'number' ? rawUsage['cache_read_input_tokens'] : 0)
        withCacheRows++
      } else {
        const details = (rawUsage?.['prompt_tokens_details'] ?? usage?.['inputTokensDetails'])
        const first = Array.isArray(details) ? details[0] : details
        hit = first !== null && typeof first === 'object' && typeof first['cached_tokens'] === 'number' ? first['cached_tokens'] : 0
        if (hit === 0) legacyRows++
      }
      const time = typeof ev['timestamp'] === 'number' && ev['timestamp'] > 0 ? ev['timestamp'] : null
      if (time === null) { badTime++; continue }
      const key = typeof pd['messageId'] === 'string' && pd['messageId'] !== '' ? pd['messageId'] : String(ev['id'] ?? '')
      if (seen.has(key)) { duplicates++; continue }
      seen.add(key)
      const miss = Math.max(0, prompt - hit)
      if (reported !== null && miss + completion + hit !== reported) identityViolations++
      const modelName = typeof pd['model'] === 'string' ? pd['model'] : '(none)'
      models.set(modelName, (models.get(modelName) ?? 0) + 1)
      rows.push({
        sessionId: workbuddySessionIdOf(projectRoot, file),
        time,
        cols: `${miss}|${completion}|${hit}|0`,
        total: miss + completion + hit,
        naive: prompt + completion + hit,
      })
    }
  }
  return { rows, usageLines, legacyRows, withCacheRows, badTime, identityViolations, duplicates, models }
}

async function real(): Promise<void> {
  section('本机真实日志（只读复验）')
  const configDir = defaultWorkBuddyHome()
  const projectRoot = join(configDir, 'projects')
  if (!existsSync(projectRoot)) {
    skip('本机真实 WorkBuddy 日志', `没找到 ${projectRoot}（这台机器上没装 WorkBuddy，或配置目录在别处）`)
    return
  }
  console.log(`  配置目录: ${configDir}`)

  const files: string[] = []
  listSessions(projectRoot, 3, files)
  console.log(`  会话文件: ${files.length}`)

  const independent = independentRecords(projectRoot, files)
  const independentTotal = independent.rows.reduce((sum, row) => sum + row.total, 0)
  const naiveTotal = independent.rows.reduce((sum, row) => sum + row.naive, 0)

  const roots = workbuddySource.roots([])
  const wholeScan = await scanAllSources(roots)
  const wholeTotal = wholeScan.records.reduce((sum, r) => sum + r.usage.total, 0)

  // 逐条比对：以 (会话, 时间, 四列) 为指纹（时间戳在同一文件内可能重复，所以按多重集比）
  const bag = new Map<string, number>()
  for (const row of independent.rows) {
    const key = `${row.sessionId}@${row.time}|${row.cols}`
    bag.set(key, (bag.get(key) ?? 0) + 1)
  }
  const mismatched: string[] = []
  for (const rec of wholeScan.records) {
    const cols = `${rec.usage.input}|${rec.usage.output}|${rec.usage.cacheRead}|${rec.usage.cacheWrite}`
    const key = `${rec.sessionId}@${rec.time}|${cols}`
    const left = bag.get(key) ?? 0
    if (left === 0) mismatched.push(`${rec.sessionId}@${rec.time} ⇒ 适配器 ${cols} / 独立实现里没有`)
    else bag.set(key, left - 1)
  }
  const leftover = [...bag.entries()].filter(([, count]) => count > 0)

  console.log('')
  console.log(`  独立解析: ${fmt(independent.rows.length)} 次调用 / ${fmt(independentTotal)} token`)
  console.log(`  适配器  : ${fmt(wholeScan.records.length)} 条记录 / ${fmt(wholeTotal)} token`)
  console.log(`  不拆缓存的朴素相加: ${fmt(naiveTotal)} token`)
  const d = wholeScan.diagnostics
  console.log(`  失真统计: 用量行 ${fmt(independent.usageLines)} / 无缓存字段 ${fmt(independent.legacyRows)}`
    + ` / 坏时间戳 ${fmt(independent.badTime)} / 恒等式不符 ${fmt(independent.identityViolations)} / 重复响应 ${fmt(independent.duplicates)}`)
  console.log(`  模型分布: ${[...independent.models.entries()].map(([name, count]) => `${name}×${count}`).join(' / ')}`)
  console.log(`  诊断: ${JSON.stringify({
    workbuddyFiles: d.workbuddyFiles,
    workbuddyNestedSessionFiles: d.workbuddyNestedSessionFiles,
    workbuddyUsageLines: d.workbuddyUsageLines,
    workbuddyMalformedUsage: d.workbuddyMalformedUsage,
    workbuddyDuplicateResponses: d.workbuddyDuplicateResponses,
    workbuddyInvalidTimestamps: d.workbuddyInvalidTimestamps,
    workbuddyZeroUsage: d.workbuddyZeroUsage,
    workbuddyIdentityViolations: d.workbuddyIdentityViolations,
    workbuddyOverlapAnomalies: d.workbuddyOverlapAnomalies,
    workbuddyMissMismatch: d.workbuddyMissMismatch,
    workbuddyUsageWithoutCache: d.workbuddyUsageWithoutCache,
    workbuddyMissingModel: d.workbuddyMissingModel,
    workbuddyMetaMismatch: d.workbuddyMetaMismatch,
  })}`)

  check('★ 逐条：适配器的每条记录在独立实现里都有同 (会话, 时间戳, 四列) 的一条',
    mismatched.length === 0, mismatched.length > 0 ? `例：${mismatched[0]}` : `${wholeScan.records.length} 条全部命中`)
  check('★ 独立实现没有多余的行（多重集恰好清空）', leftover.length === 0,
    leftover.length > 0 ? `例：${leftover[0]![0]}` : '无剩余')
  check('★ 适配器记录数 == 独立解析的条数', wholeScan.records.length === independent.rows.length,
    `${wholeScan.records.length} vs ${independent.rows.length}`)
  check('★ 适配器总量 == 独立解析的总量', wholeTotal === independentTotal, `${fmt(wholeTotal)} vs ${fmt(independentTotal)}`)
  check('🚨 减法确实生效：总量严格小于「不拆缓存」的朴素相加',
    wholeTotal < naiveTotal, `${fmt(wholeTotal)} < ${fmt(naiveTotal)}`)
  check('恒等式逐条成立（四列之和 == 上游自报 total_tokens）', wholeScan.diagnostics.workbuddyIdentityViolations === 0)
  check('缓存字段含在 prompt 内（无例外：cacheRead + cacheWrite ≤ prompt）', wholeScan.diagnostics.workbuddyOverlapAnomalies === 0)
  check('上游的 miss 字段与「prompt − 缓存」逐条相符', wholeScan.diagnostics.workbuddyMissMismatch === 0)
  check('provider 恒为 workbuddy、source 恒为 workbuddy',
    wholeScan.records.every((r) => r.source === 'workbuddy' && r.provider === WORKBUDDY_PROVIDER))
  check('诊断里没有畸形行 / 零用量', d.workbuddyMalformedUsage === 0 && d.workbuddyZeroUsage === 0)

  if (d.workbuddyUsageWithoutCache > 0) {
    observe('一部分用量记录**没有缓存字段**（老代际格式）⇒ 这一源的缓存命中率被系统性低估',
      `${d.workbuddyUsageWithoutCache}/${wholeScan.records.length} 条：它们的 input 是整段上下文（含命中部分），cacheRead 只能记 0 ——`
      + '这是上游老格式的缺口（迁移过来的会话每个用户轮次只落一次调用），不是采集漏项；看命中率时必须按这个数字打折扣')
  }
  if (wholeScan.records.some((r) => r.model === 'auto')) {
    observe('老代际的模型名是 `auto`（上游真实取值，不是缺失）⇒ 这些记录配不上任何单价',
      `${wholeScan.records.filter((r) => r.model === 'auto').length} 条 ⇒ 它们会在金额里落进 unpricedRate（这是正确表现，不要为了好看去动口径）`)
  }
  if (d.workbuddyNestedSessionFiles === 0) {
    observe('本机没有子代理（`<sessionId>/subagents/<taskId>.jsonl`）样本 ⇒ 那条路径只由合成夹具兜住',
      '第一次在真机上用到子代理时，要复验「子会话的用量**不会**同时出现在父会话文件里」（否则会双计）')
  }
  if (independent.badTime > 0) {
    observe('真实日志里存在 `timestamp: 0` 的用量记录（迁移产物）⇒ 已按「跳过并计数」处理',
      `${independent.badTime} 条 —— 退化成 1970 会把整段用量塞进时间窗之外，表现为「这段时间没有用量」而**不报错**`)
  }
  console.log('  ⚠️ 读的是本机真实日志（只读：不写库、不写 dataDir）—— 数字随使用情况变化。')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

try {
  await synthetic()
  if (process.argv.includes('--real')) await real()
  else console.log('\n（加 `-- --real` 可在本机真实日志上只读复验；数字随使用情况变化）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (skips > 0) console.log(`（跳过 ${skips} 项：本机构造不出该条件 —— 不是通过）`)
if (observations > 0) console.log(`（另有 ${observations} 处观察项：不计入失败，需要人判断是否要改）`)
console.log(`\n结果: ${checks - failures}/${checks} 通过${failures > 0 ? `（${failures} 项失败）` : ''}`)
// 与仓内其它 verify 脚本一致：失败一律非 0 退出，便于 CI / 脚本串联。
if (failures > 0) process.exit(1)
