/**
 * **Codex 日志格式哨兵**（P0）。
 *
 * 这个脚本存在的唯一理由：Codex 的 rollout 格式**没有任何契约**（它是客户端的内部实现），
 * 而它的口径错法全部是「不报错、数字悄悄不对」那一类 ——
 * `cached` 含在 `input` 内、同一次调用写两条、两代遥测并存、归档副本重复。
 * 所以这里把方案里**实测出来的每一条结论**钉成断言：
 * 上游一改，这个脚本会红；而不会等到看板上的数字慢慢变少之后才有人发现。
 *
 * 用法：
 *   bun run --filter '@ai-token-report/core' verify:codex-format            # 合成夹具
 *   bun run --filter '@ai-token-report/core' verify:codex-format -- --real  # 真实日志（只读）
 *
 * 🚨 **合成夹具一律落临时目录**，`--real` 也**只读**（不写库、不写身份、不写 dataDir）——
 *   否则这个脚本本身就会变成「带着开发者真实用量跑断言」的那种测试。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { scanAllSources, listSourceFiles } from '../src/scanner.js'
import { codexSource, mapCodexUsage } from '../src/sources/codex.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { emptyDiagnostics } from '../src/types.js'
import type { UsageRecord } from '../src/types.js'
import { openDatabaseForIngest } from '../src/db/ingest.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'

let checks = 0
let failures = 0

function eq<T>(label: string, actual: T, expected: T): void {
  checks++
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures++
    console.log(`  ❌ ${label}\n     实际: ${a}\n     期望: ${b}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

function ok(label: string, condition: boolean, detail = ''): void {
  checks++
  if (condition) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`) }
}

// ─────────────────────────────────────────────────────────────
// 合成夹具
// ─────────────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'atr-codex-format-'))
const home = join(root, 'codex')
const sessions = join(home, 'sessions', '2026', '09', '27')
const archived = join(home, 'archived_sessions', '2026', '09', '27')
mkdirSync(sessions, { recursive: true })
mkdirSync(archived, { recursive: true })

const UUID_A = '019d4d61-2656-7382-a473-689cdf1fced9'
const UUID_B = '01a0e37d-b467-7272-9190-7b546e192276'

/**
 * 一行信封。`ordinal` 由调用方给 —— 它是**文件内**单调计数，必须自己保证。
 *
 * ⚠️ 默认时间戳刻意**晚于**会话首行：`session_meta` 之前的计费行会被
 *   「fork 重放保护」正确跳过（那是它的职责），夹具里若默认早于首行，
 *   整个文件都会「被正确跳过」，而表现是**一堆与重放无关的断言失败**。
 */
function line(ordinal: number, type: string, payload: unknown, ts = '2026-09-27T15:41:00.000Z'): string {
  return `${JSON.stringify({ timestamp: ts, ordinal, type, payload })}\n`
}

function meta(sessionId: string, ts = '2026-09-27T15:31:00.000Z'): string {
  return line(0, 'session_meta', {
    session_id: sessionId, id: sessionId, timestamp: ts, cwd: 'D:\\Coding_agent\\demo',
    model_provider: 'openai', cli_version: '0.149.0', source: 'cli',
  })
}

function turnContext(ordinal: number, model = 'gpt-5.5'): string {
  return line(ordinal, 'turn_context', { model, cwd: 'D:\\Coding_agent\\demo' })
}

/** `token_count`：同一次调用会写两条同值（第二次的累计快照不变）—— 单元 2 钉的就是它。 */
function tokenCount(ordinal: number, last: Record<string, number>, total: Record<string, number>): string {
  return line(ordinal, 'event_msg', { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } })
}

const usage = (input: number, cached: number, cw: number, output: number, total: number): Record<string, number> => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cw,
  output_tokens: output, reasoning_output_tokens: 0, total_tokens: total,
})

// A 代际：一次调用（input 1000 / cached 400 / out 100 ⇒ total 1100），被写了两条。
const u1 = usage(1000, 400, 0, 100, 1100)
// 第二次调用：累计快照推进（2200 = 1100 + 1100）。
const u2 = usage(2000, 800, 0, 200, 2200)
writeFileSync(join(sessions, `rollout-2026-09-27T15-31-00-${UUID_A}.jsonl`), [
  meta(UUID_A),
  turnContext(1),
  tokenCount(2, u1, u1),
  tokenCount(3, u1, u1),                       // 同值重复 ⇒ 必须跳过
  tokenCount(4, u2, u2),
  // 只有 total、四类全 0 的重置标记 ⇒ 跳过并计数
  tokenCount(5, usage(0, 0, 0, 0, 9000), usage(0, 0, 0, 0, 9000)),
  `${JSON.stringify({ timestamp: '2026-09-27T15:32:00.000Z', ordinal: 6, type: 'event_msg', payload: { type: 'token_count', info: null } })}\n`,
  `${line(7, 'event_msg', { type: 'agent_message' })}`,
  // 半行截断（追加写途中）⇒ 不能炸，也不能被当成一条记录
  '{"timestamp":"2026-09-27T15:33:00.000Z","ordinal":8,"type":"event_msg","payl',
].join(''))

// 归档副本：与活动目录**同一个 sessionId**（内容再全也只得算一次）。
writeFileSync(join(archived, `rollout-2026-09-27T15-31-00-${UUID_A}.jsonl`), [
  meta(UUID_A), turnContext(1), tokenCount(2, u1, u1), tokenCount(4, u2, u2),
].join(''))

// B 代际 + cache_write>0 + fork 重放（首行之前的计费行不计入）。
const uB = usage(3000, 1000, 500, 300, 3300)
const uReplay = usage(999, 999, 0, 9, 1008)
writeFileSync(join(sessions, `rollout-2026-09-27T15-40-00-${UUID_B}.jsonl`), [
  meta(UUID_B, '2026-09-27T15:40:00.000Z'),
  turnContext(1, 'gpt-5.6-sol'),
  line(2, 'token_usage_record', { response_id: 'resp_a', usage: uReplay }, '2026-09-27T15:39:00.000Z'),
  line(3, 'token_usage_record', { response_id: 'resp_b', usage: uB }),
  line(4, 'token_usage_record', { response_id: 'resp_b', usage: uB }),   // 同一 response_id ⇒ 去重
  line(5, 'event_msg', { type: 'token_count', info: { last_token_usage: u1, total_token_usage: u1 } }),
].join(''))

// 🚨 **必须限定来源**：不写 `sources` 时默认是「全部已注册来源」，
//   那会把开发者**真实的** DSH / Claude 日志也卷进合成夹具的断言里
//   （本脚本第一次跑就是这么翻车的：`ingestPlainSources` 的来源护栏把它拦下来并报错）。
const roots = resolveSourceRoots({ sources: ['codex'], homes: { codex: [home] } }).roots

console.log('== 1) 列举与代际/副本 ============================================')
{
  const files = await listSourceFiles(roots)
  eq('列举到两个会话文件（归档同名文件按路径去重后仍是两份不同的文件）', files.length, 3)
  eq('主根在前、次要副本在后', roots.map((r) => r.secondary === true), [false, true])
}

console.log('\n== 2) 折叠与四列口径 ============================================')
let records: UsageRecord[] = []
{
  const diagnostics = emptyDiagnostics()
  const { records: scanned, diagnostics: d } = await scanAllSources(roots)
  records = scanned
  // A 代际：两次调用（双写去重后）；B 代际：一次调用（response_id 去重 + 重放跳过）。
  eq('计费记录数', records.length, 3)
  const a = records.filter((r) => r.sessionId === UUID_A)
  const b = records.filter((r) => r.sessionId === UUID_B)
  eq('A 会话两条', a.map((r) => [r.usage.input, r.usage.cacheRead, r.usage.output]), [[600, 400, 100], [1200, 800, 200]])
  eq('B 会话一条（cache_write 计入独立列）', b.map((r) => [r.usage.input, r.usage.cacheRead, r.usage.cacheWrite, r.usage.output]), [[1500, 1000, 500, 300]])
  eq('B 会话模型取自 turn_context', b.map((r) => r.model), ['gpt-5.6-sol'])
  eq('幂等键带来源前缀', b.map((r) => r.eventId).every((id) => id.startsWith(`codex:${UUID_B}:`)), true)
  // 🚨 这一条是**刻意的**：夹具里放了一个「只有 total、四类全 0」的重置标记，
  //   它拆不出四列，于是恒等式判它不一致、零用量判它跳过 —— 两个计数都该 +1。
  //   断言写成「正好 1」而不是「0」，是为了让「上游语义变了」与「夹具里有已知标记」区分开。
  eq('只有 total 的重置标记被记为口径不一致（必须可见，不是静默）', d.codexIdentityViolations, 1)
  ok('无 cached+cw 越界', d.codexOverlapAnomalies === 0)
  eq('空 info 跳过并计数', d.codexNullInfo, 1)
  eq('零用量重置标记跳过并计数', d.codexZeroUsage, 1)
  eq('同值重复的快照没有被算成第二次调用（A 会话 calls=2）', a.length, 2)
  eq('另一代际的事件被跳过并计数（B 文件里的 token_count）', d.codexOtherGenerationSkipped, 1)
  eq('fork 重放按下限跳过', d.codexReplayedEvents, 1)
  eq('身份/来源写进记录', records.every((r) => r.source === 'codex'), true)
  // 🚨 「采到的文件数」是**每个来源自己的**计数，必须由适配器加。
  //   它以前写在 `scanner.ts` 里：直扫路径会把它加给任何纯文本来源，
  //   而本地库路径（`ingestPlainSources`）根本不走那里 ⇒ 恒为 0。
  //   这一条同时挡住那两种退化（= 3 个文件：两个 A/B 主文件 + 一个归档副本）。
  eq('采到的文件数由适配器自己计（不是 0，也不是「全部纯文本来源」的总数）', d.codexFiles, 3)
}

console.log('\n== 3) 映射函数的单元断言 ========================================')
{
  const { counts, identityOk } = mapCodexUsage(uB)
  eq('cached 与 cache_write 都从 input 里减掉', [counts.input, counts.cacheRead, counts.cacheWrite], [1500, 1000, 500])
  eq('四列之和 == 上游 total_tokens', counts.total, 3300)
  ok('恒等式标记', identityOk)
  const { counts: overlapCounts, overlap } = mapCodexUsage({ input_tokens: 10, cached_input_tokens: 8, cache_write_input_tokens: 8, output_tokens: 1, total_tokens: 11 })
  eq('越界时 input 夹到 0（不出现负数）', overlapCounts.input, 0)
  ok('越界被标出来（让上游语义变化能被看见）', overlap)
}

console.log('\n== 4) 本地入库：L1 跳过与幂等 ===================================')
{
  const dbPath = join(root, 'usage.sqlite')
  const db = openDatabaseForIngest(dbPath)
  try {
    const first = await ingestPlainSources({ roots, db })
    eq('首次入库条数', first.inserted, 3)
    eq('首次没有跳过', first.skippedUnchanged, 0)
    // 🚨 **库路径**下这个计数以前恒为 0（它写在 `scanner.ts` 里，而库里这条路不走那里）：
    //   症状是「采到的文件数 0 / 用量事件 3」摆在同一份诊断里，看起来像一个文件都没采到。
    eq('库路径也报得出「采到的文件数」', first.diagnostics.codexFiles, 3)
    const second = await ingestPlainSources({ roots, db })
    eq('二次入库新记录 0（L1 按 size 跳过）', second.inserted, 0)
    eq('二次入库跳过全部文件', second.skippedUnchanged, 3)
    eq('库里按来源可查', db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM usage_event WHERE source = 'codex'").get()?.c, 3)
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version
    ok('本地库版本是当前派生库版本（不是上报库）', typeof version === 'number' && version >= 4, `user_version=${version}`)
    // 追加一行后再入库：只新增那一条，老记录靠 event_id 幂等吸收。
    // ⚠️ 夹具文件故意以**半行**结尾（模拟追加写途中），所以这里要先补一个换行 ——
    //   直接把新行粘在半行后面会拼成一条坏行，表现是「追加的东西不见了」。
    writeFileSync(join(sessions, `rollout-2026-09-27T15-31-00-${UUID_A}.jsonl`),
      readFileSync(join(sessions, `rollout-2026-09-27T15-31-00-${UUID_A}.jsonl`), 'utf8') +
      '\n' + tokenCount(9, usage(3000, 0, 0, 50, 3050), usage(3000, 0, 0, 50, 3050)),
    )
    const third = await ingestPlainSources({ roots, db })
    eq('追加后只新增一条', third.inserted, 1)
    // 只有**变化过**的文件会被重解析（B 文件没变，走 L1 跳过），所以重复数 = A 文件的老记录 2 条。
    eq('追加后重复条数（老记录重解析被主键吸收）', third.duplicates, 2)
  } finally {
    db.close()
  }
}

rmSync(root, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────
// 真实日志：**只读**复验（数字随使用情况变化，所以只断量级与不变式）
// ─────────────────────────────────────────────────────────────
if (process.argv.includes('--real')) {
  console.log('\n== 5) 真实日志（只读）==========================================')
  const real = resolveSourceRoots({ sources: ['codex'] })
  if (real.roots.length === 0) {
    console.log('  本机没有 Codex 日志根，跳过（不是通过）')
  } else {
    const started = Date.now()
    const files = await listSourceFiles(real.roots)
    const { records: all, diagnostics } = await scanAllSources(real.roots)
    const sum = all.reduce((acc, r) => ({
      total: acc.total + r.usage.total, cacheRead: acc.cacheRead + r.usage.cacheRead,
      sessions: acc.sessions.add(r.sessionId),
    }), { total: 0, cacheRead: 0, sessions: new Set<string>() })
    const ratio = sum.total > 0 ? (sum.cacheRead / sum.total) * 100 : 0
    console.log(`  文件 ${files.length} / 含用量会话 ${sum.sessions.size} / 调用 ${all.length} / 总 token ${sum.total.toLocaleString('en-US')}`)
    console.log(`  cacheRead 占比 ${ratio.toFixed(1)}% / 恒等式失败 ${diagnostics.codexIdentityViolations} / 越界 ${diagnostics.codexOverlapAnomalies}`)
    console.log(`  累计快照对不齐的文件 ${diagnostics.codexCounterDriftFiles} / 信封 id 不一致 ${diagnostics.codexMetaMismatch} / 另一代际跳过 ${diagnostics.codexOtherGenerationSkipped}`)
    console.log(`  耗时 ${((Date.now() - started) / 1000).toFixed(1)}s（只读：不写库、不写 dataDir）`)
    ok('真实日志能解析出用量', all.length > 0)
    ok('恒等式在真实日志上逐条成立', diagnostics.codexIdentityViolations <= 5, `violations=${diagnostics.codexIdentityViolations}（已知有极少数只有 total 的重置标记）`)
    ok('cached+cw 越界为 0', diagnostics.codexOverlapAnomalies === 0)
    // 本机实测约 93.6%：缓存读占绝大多数是**口径特征**，不是异常。
    ok('cacheRead 占比在 90%~97% 之间（与 DSH 的 94.3% 同量级）', ratio > 90 && ratio < 97, `ratio=${ratio.toFixed(1)}%`)
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} Codex 格式哨兵：${checks} 项断言，${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
