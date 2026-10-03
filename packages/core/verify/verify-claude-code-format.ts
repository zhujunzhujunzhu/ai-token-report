/**
 * **Claude Code 日志格式哨兵**（P0 级）：把「Claude Code 的日志长什么样」固化下来。
 *
 * ## 为什么需要这一层
 *
 * 适配器里那些「不会报错、只会数字悄悄不对」的口径，全部来自**对真实日志的观察**：
 *
 * | 观察 | 错了会怎样 |
 * |---|---|
 * | 同一次调用被写成多行（`message.id` 相同） | 朴素逐行相加 **正好翻倍** |
 * | `input_tokens` 已经是「未命中缓存」那部分 | 再做一次减法 ⇒ 输入变负 / 恒等式不成立 |
 * | `uuid` 每行都不同，只有 `message.id` 是调用身份 | 用 uuid 做幂等键 ⇒ 完全不去重 |
 * | `cache_creation` 的 1h/5m 是**定价分档**，不是另一类用量 | 拆成五列 ⇒ 与全仓四列口径分叉 |
 *
 * 这些结论一旦上游改格式就会静默失效。所以这里做两件事：
 *
 * 1. **合成夹具**（默认运行，随 `bun test` 的隔离环境无关）：把上面每一条
 *    变成一条可执行断言，格式漂移时**在这里炸**，而不是在看板上下次才发现；
 * 2. `--real`：在**本机真实日志**上把适配器的输出与脚本内**独立实现的解析**
 *    逐条比对（独立实现是刻意的 —— 复用适配器等于自己验证自己），
 *    并把实测的失真统计打印出来。只读：不写库、不写数据目录、不改任何文件。
 *
 * 运行：
 * ```
 * bun run --filter '@ai-token-report/core' verify:claude-code
 * bun run --filter '@ai-token-report/core' verify:claude-code -- --real
 * ```
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_PROVIDER,
  claudeCodeSource,
  claudeSessionIdFromName,
  defaultClaudeHome,
  mapClaudeUsage,
} from '../src/sources/claude-code.js'
import { requireSource } from '../src/sources/registry.js'
import { scanAllSources } from '../src/scanner.js'
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

// ── 合成夹具 ────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'atr-verify-claude-code-'))
const SESSION = '1bbad279-2723-47f9-b98b-8f5ae2aed32f'
const OTHER_SESSION = '55cccf67-3fd0-4d09-b1b3-cd3ea5d7b8b3'
const PROJECT = 'D--Coding-agent-demo'

/** 一行 assistant（四列：10 / 2 / 90 / 3 = 105 token）。 */
function row(opts: {
  sessionId?: string
  messageId: string
  uuid: string
  model?: string | null
  usage?: Record<string, unknown> | null
  time?: string
}): string {
  const message: Record<string, unknown> = {
    id: opts.messageId,
    model: opts.model === undefined ? 'claude-opus-4-8' : opts.model,
    type: 'message',
    role: 'assistant',
  }
  const usage = opts.usage === undefined
    ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 3 }
    : opts.usage
  if (usage !== null) message['usage'] = usage
  return JSON.stringify({
    type: 'assistant',
    message,
    uuid: opts.uuid,
    timestamp: opts.time ?? '2026-06-12T15:45:54.454Z',
    sessionId: opts.sessionId ?? SESSION,
    cwd: 'D:\\Coding_agent\\demo',
  })
}

function noise(type: string): string {
  return JSON.stringify({ type, uuid: `noise-${type}`, timestamp: '2026-06-12T15:45:54.000Z' })
}

function writeSession(home: string, name: string, lines: readonly string[], project = PROJECT): string {
  const target = join(home, 'projects', project)
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  return file
}

async function synthetic(): Promise<void> {
  section('S1 目录结构与列举')
  const home = join(dir, 'home')
  writeSession(home, `${SESSION}.jsonl`, [row({ messageId: 'msg_a', uuid: 'u1' })])
  writeSession(home, `${OTHER_SESSION}.jsonl`, [row({ sessionId: OTHER_SESSION, messageId: 'msg_b', uuid: 'u2' })])
  writeSession(home, 'agent-deadbeef.jsonl', [row({ messageId: 'msg_sub', uuid: 'u3' })])
  writeSession(home, 'journal.jsonl', [noise('system')])
  writeSession(home, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', [])
  mkdirSync(join(home, 'projects', PROJECT, 'memory'), { recursive: true })
  writeFileSync(join(home, 'projects', PROJECT, 'memory', 'MEMORY.md'), '# 记忆\n', 'utf8')

  const root = claudeCodeSource.roots([home])[0]!
  check('根 = <home>/projects 且来源是 claude-code', root.path === join(home, 'projects') && root.source === 'claude-code')
  const metas = await claudeCodeSource.list(root)
  check('只列举 <uuid>.jsonl（子代理 / 控制文件 / 0 字节 / md 都不算）',
    metas.length === 2 && metas.every((m) => claudeSessionIdFromName(m.filePath.split(/[\\/]/).pop()!) !== null),
    `列举 ${metas.length} 个`)
  const info = await claudeCodeSource.inspect!(root)
  check('巡检报出会话 2 / 日志 2 / 最新写入非空',
    info.sessions === 2 && info.files === 2 && info.latestMs !== null)
  check('adapter 是纯文本来源（走 ingest-plain）', requireSource('claude-code').encoding === 'plain-jsonl')

  section('S2 一次调用只算一次（本文件最核心的一条）')
  const home2 = join(dir, 'home2')
  // 真实形态：同一次调用的四行被别的行隔开（本机实测最大间隔 21 行）
  writeSession(home2, `${SESSION}.jsonl`, [
    row({ messageId: 'msg_demo', uuid: 'u1' }),
    noise('attachment'),
    row({ messageId: 'msg_demo', uuid: 'u2' }),
    row({ messageId: 'msg_other', uuid: 'u3' }),
    noise('user'),
    row({ messageId: 'msg_demo', uuid: 'u4' }),
    row({ messageId: 'msg_demo', uuid: 'u5' }),
  ])
  const roots2 = claudeCodeSource.roots([home2])
  const scan = await scanAllSources(roots2)
  const totals = scan.records.reduce((sum, r) => sum + r.usage.total, 0)
  check('5 条计费行 ⇒ 2 次调用 / 210 token（不去重会得到 525）',
    scan.records.length === 2 && totals === 210, `${scan.records.length} 条 / ${totals} token`)
  check('重复行被计数（可看见，而不是静默丢掉）', scan.diagnostics.claudeDuplicateWrites === 3,
    `claudeDuplicateWrites=${scan.diagnostics.claudeDuplicateWrites}`)
  check('幂等键主体是 message.id', scan.records.every((r) => r.eventId.startsWith(`claude-code:${SESSION}:msg_`)))

  section('S3 四列口径与恒等式')
  const { counts, identityOk } = mapClaudeUsage({
    input_tokens: 16166, output_tokens: 301, cache_read_input_tokens: 0, cache_creation_input_tokens: 26795,
  })
  check('input 不做减法（Claude Code 的 input 已是未命中部分）', counts.input === 16166)
  check('恒等式 total = input + output + cacheRead + cacheWrite',
    counts.total === 16166 + 301 + 0 + 26795 && identityOk)
  for (const rec of scan.records) {
    check(`恒等式逐条成立（${rec.eventId}）`,
      rec.usage.total === rec.usage.input + rec.usage.output + rec.usage.cacheRead + rec.usage.cacheWrite)
  }
  check('provider 恒为 anthropic', scan.records.every((r) => r.provider === CLAUDE_PROVIDER))

  section('S4 两条路径同一个数（库 vs 直扫）')
  const dbPath = join(dir, 'usage.sqlite')
  const first = await ingestPlainSources({ roots: roots2, dbPath })
  const second = await ingestPlainSources({ roots: roots2, dbPath })
  check('首次入库 2 条；第二轮 L1 整份跳过（0 条新记录）',
    first.inserted === 2 && second.inserted === 0 && second.skippedUnchanged === 1)
  const session = await openStats({ sessionsRoot: [], sourceRoots: roots2, dbPath })
  try {
    const fresh = await scanAllSources(roots2)
    check('库总量 == 直扫总量',
      session.totals().total === fresh.records.reduce((sum, r) => sum + r.usage.total, 0) && session.totals().total === 210,
      `${session.totals().total} token`)
  } finally {
    session.close()
  }

  section('S5 畸形行不替上游编数')
  const home3 = join(dir, 'home3')
  writeSession(home3, `${SESSION}.jsonl`, [
    row({ messageId: 'msg_syn', uuid: 'u1', model: '<synthetic>', usage: null }),
    row({ messageId: 'msg_none', uuid: 'u2', usage: null }),
    row({ messageId: 'msg_zero', uuid: 'u3', usage: { input_tokens: 0, output_tokens: 0 } }),
    row({ messageId: 'msg_ok', uuid: 'u4' }),
  ])
  const odd = await scanAllSources(claudeCodeSource.roots([home3]))
  check('只采到 1 条；synthetic / 无 usage / 全 0 各自被计数',
    odd.records.length === 1 &&
    odd.diagnostics.claudeSyntheticRows === 1 &&
    odd.diagnostics.claudeAssistantWithoutUsage === 1 &&
    odd.diagnostics.claudeZeroUsage === 1,
    JSON.stringify({
      synthetic: odd.diagnostics.claudeSyntheticRows,
      withoutUsage: odd.diagnostics.claudeAssistantWithoutUsage,
      zero: odd.diagnostics.claudeZeroUsage,
    }))
}

// ── 真实日志（只读）─────────────────────────────────────────────────────────

/** 脚本内**独立实现**的解析：只依赖「行是 JSON、type === assistant」这两条前提。 */
interface Independent {
  /** `message.id` → 首次出现的四列（重复行必须与首次一致）。 */
  calls: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  /** message.id 重复但四列不一致的次数（实测 0 ⇒ 「首次获胜」与「末次获胜」等价）。 */
  diverging: number
  /** 缺 message.id 的计费行数。 */
  noMessageId: number
  /** 没有 usage 的 assistant 行数。 */
  noUsage: number
  /** `<synthetic>` 行数。 */
  synthetic: number
  /** 自报 total_tokens 且与四列之和不等的行数（该字段当前不存在）。 */
  identityViolations: number
  /** 朴素逐行相加的总量（不去重时上游会给出的那个数字）。 */
  naiveTotal: number
  /** 逐行相加的计费行数。 */
  usageRows: number
  /** 缓存写入分档之和 ≠ cache_creation_input_tokens 的行数。 */
  cacheBreakdownMismatch: number
  /** 出现过的模型名。 */
  models: Set<string>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function parseIndependently(text: string): Independent {
  const out: Independent = {
    calls: new Map(), diverging: 0, noMessageId: 0, noUsage: 0, synthetic: 0,
    identityViolations: 0, naiveTotal: 0, usageRows: 0, cacheBreakdownMismatch: 0, models: new Set(),
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const row = parsed as Record<string, unknown>
    if (row['type'] !== 'assistant') continue
    const message = row['message']
    if (message === null || typeof message !== 'object' || Array.isArray(message)) { out.noUsage++; continue }
    const m = message as Record<string, unknown>
    if (m['model'] === '<synthetic>') { out.synthetic++; continue }
    const usage = m['usage']
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) { out.noUsage++; continue }
    const u = usage as Record<string, unknown>
    out.usageRows++
    if (typeof m['model'] === 'string') out.models.add(m['model'] as string)
    const input = num(u['input_tokens'])
    const output = num(u['output_tokens'])
    const cacheRead = num(u['cache_read_input_tokens'])
    const cacheWrite = num(u['cache_creation_input_tokens'])
    out.naiveTotal += input + output + cacheRead + cacheWrite
    const reported = u['total_tokens']
    if (typeof reported === 'number' && reported !== input + output + cacheRead + cacheWrite) out.identityViolations++
    const cc = u['cache_creation']
    if (cc !== null && typeof cc === 'object' && !Array.isArray(cc)) {
      const c = cc as Record<string, unknown>
      if (num(c['ephemeral_1h_input_tokens']) + num(c['ephemeral_5m_input_tokens']) !== cacheWrite) {
        out.cacheBreakdownMismatch++
      }
    }
    if (typeof m['id'] !== 'string' || m['id'] === '') { out.noMessageId++; continue }
    const id = m['id'] as string
    const sig = { input, output, cacheRead, cacheWrite }
    const first = out.calls.get(id)
    if (first === undefined) out.calls.set(id, sig)
    else if (first.input !== input || first.output !== output || first.cacheRead !== cacheRead || first.cacheWrite !== cacheWrite) {
      out.diverging++
    }
  }
  return out
}

/** 把一个文件按独立实现算成「调用指纹表」，用来与适配器的记录逐条比对。 */
function fingerprintsOf(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const row = parsed as Record<string, unknown>
    if (row['type'] !== 'assistant') continue
    const m = row['message']
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    if (msg['model'] === '<synthetic>') continue
    const u = msg['usage']
    if (u === null || typeof u !== 'object' || Array.isArray(u)) continue
    if (typeof msg['id'] !== 'string' || msg['id'] === '') continue
    const usage = u as Record<string, unknown>
    if (out.has(msg['id'] as string)) continue
    out.set(msg['id'] as string, [
      num(usage['input_tokens']), num(usage['output_tokens']),
      num(usage['cache_read_input_tokens']), num(usage['cache_creation_input_tokens']),
    ].join('/'))
  }
  return out
}

async function real(): Promise<void> {
  section('R1 本机真实 Claude Code 日志（只读）')
  const home = defaultClaudeHome()
  const root = claudeCodeSource.roots([home])[0]!
  const metas = await claudeCodeSource.list(root).catch(() => [])
  if (metas.length === 0) {
    skip('真实日志', `本机没有可读的 ${root.path}`)
    return
  }
  console.log(`  home: ${home}`)
  console.log(`  日志: ${metas.length} 个会话文件`)
  console.log(`  数据目录: 未使用（本脚本不写库、不写 dataDir）`)

  // 逐个文件跑独立实现，再与适配器在**同一份文本**上的输出比对。
  //
  // ⚠️ 夹具 / 真实日志都按「一个文件」粒度喂给 `scanAllSources`：适配器的列举会
  //   认出根下所有会话文件，按文件过滤只是为了把「这一次比对」限定到一个文件上。
  const roots = claudeCodeSource.roots([home])
  let independentCalls = 0
  let naiveTotal = 0
  let usageRows = 0
  let diverging = 0
  let noMessageId = 0
  let noUsage = 0
  let synthetic = 0
  let identityViolations = 0
  let cacheBreakdownMismatch = 0
  const models = new Set<string>()
  let independentTotal = 0
  const mismatched: string[] = []

  for (const meta of metas) {
    let text: string
    try { text = readFileSync(meta.filePath, 'utf8') } catch { continue }
    const ind = parseIndependently(text)
    independentCalls += ind.calls.size
    independentTotal += [...ind.calls.values()].reduce((sum, v) => sum + v.input + v.output + v.cacheRead + v.cacheWrite, 0)
    naiveTotal += ind.naiveTotal
    usageRows += ind.usageRows
    diverging += ind.diverging
    noMessageId += ind.noMessageId
    noUsage += ind.noUsage
    synthetic += ind.synthetic
    identityViolations += ind.identityViolations
    cacheBreakdownMismatch += ind.cacheBreakdownMismatch
    for (const m of ind.models) models.add(m)

    // 适配器：为了让「逐文件」真正成立，把根的列举结果收窄到这一个文件。
    const only: typeof roots = roots.map((r) => ({ ...r, path: meta.filePath }))
    const scanned = await scanAllSources(only)
    const mine = fingerprintsOf(text)
    const theirs = new Map<string, string>()
    for (const rec of scanned.records) {
      theirs.set(rec.eventId.slice(`claude-code:${meta.sessionId}:`.length), [
        rec.usage.input, rec.usage.output, rec.usage.cacheRead, rec.usage.cacheWrite,
      ].join('/'))
    }
    for (const [id, fp] of mine) {
      if (theirs.get(id) !== fp) mismatched.push(`${meta.sessionId}:${id} 独立=${fp} 适配器=${theirs.get(id) ?? '(缺)'}`)
    }
    for (const id of theirs.keys()) if (!mine.has(id)) mismatched.push(`${meta.sessionId}:${id} 适配器多出`)
  }

  // 适配器整源扫描的总量（列举全部会话文件、一次扫完）
  const wholeScan = await scanAllSources(roots)
  const wholeTotal = wholeScan.records.reduce((sum, r) => sum + r.usage.total, 0)

  console.log('')
  console.log(`  计费行: ${usageRows} 行（朴素相加 ${naiveTotal.toLocaleString('en-US')} token）`)
  console.log(`  独立解析: ${independentCalls.toLocaleString('en-US')} 次调用 / ${independentTotal.toLocaleString('en-US')} token`)
  console.log(`  适配器  : ${wholeScan.records.length.toLocaleString('en-US')} 条记录 / ${wholeTotal.toLocaleString('en-US')} token`)
  console.log(`  失真统计: 重复行 ${(usageRows - independentCalls).toLocaleString('en-US')} / 分档不符 ${cacheBreakdownMismatch} / 自报 total 不符 ${identityViolations}`)
  console.log(`            synthetic ${synthetic} / 无 usage ${noUsage} / 缺 message.id ${noMessageId}`)
  console.log(`  模型: ${[...models].sort().join(', ') || '(无)'}`)

  check('★ 逐文件、逐调用：适配器与独立实现完全一致（缺一条或多一条都算失败）',
    mismatched.length === 0, mismatched.length > 0 ? `例：${mismatched[0]}` : `${independentCalls} 次调用全部命中`)
  check('★ 适配器记录数 == 独立解析的去重后调用数', wholeScan.records.length === independentCalls,
    `${wholeScan.records.length} vs ${independentCalls}`)
  check('★ 适配器总量 == 独立解析的去重后总量', wholeTotal === independentTotal,
    `${wholeTotal} vs ${independentTotal}`)
  check('🚨 去重确实生效：去重后总量严格小于朴素逐行相加',
    wholeTotal < naiveTotal, `${wholeTotal.toLocaleString('en-US')} < ${naiveTotal.toLocaleString('en-US')}`)
  check('恒等式逐条成立（四列之和 == total）',
    wholeScan.records.every((r) => r.usage.total === r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite))
  check('provider 恒为 anthropic', wholeScan.records.every((r) => r.provider === CLAUDE_PROVIDER))
  check('每一行的 model 都不是 (unknown)', wholeScan.records.every((r) => r.model !== '(unknown)'),
    [...new Set(wholeScan.records.map((r) => r.model))].join(', '))

  if (diverging > 0) {
    observe('同一次调用的多行用量快照**并不一致**',
      `${diverging} 处 —— 当前实现是「首次获胜」，需要重新评估是否改成「末次获胜」`)
  } else {
    console.log('  ✓ 重复行的用量快照逐字节相同 ⇒ 「首次获胜」与「末次获胜」给出同一个总量')
  }
  if (noMessageId > 0) {
    observe('存在缺 message.id 的计费行', `${noMessageId} 行 —— 这些行退化成按行 uuid 做键，本轮不会被去重`)
  }
  if (identityViolations > 0) {
    observe('上游自报 total_tokens 与四列之和不符', `${identityViolations} 行 —— 上游语义可能变了`)
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
process.exit(failures === 0 ? 0 : 1)

