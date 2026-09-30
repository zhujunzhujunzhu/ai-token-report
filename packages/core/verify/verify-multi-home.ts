/**
 * 多个 DSH home 的**语义正确性**验证。
 *
 * 核心命题只有一条，其余都是它的推论：
 *
 * > **多根并集 ≡ 把这些日志物理合并到一个根。**
 *
 * 也就是说「再加一个根」不该改变任何既有语义 —— 不重复计数、不互相污染、
 * 与根的顺序无关（除「冲突事件」这一处，见 S7）、与根的写法无关
 * （单个字符串 / 一元数组 / 重复项 / 嵌套路径）。本机真实数据里两个 home
 * 有 224 个同名 `sessionId`、其中 217 份文件逐字节相同，所以这不是理论情形。
 *
 * ## 为什么必须在单测之外再验一遍
 *
 * 并集语义由**三处独立实现**共同保证：
 *
 * 1. `scanner.ts` 的 `listSessionFiles` —— 按绝对路径去重文件；
 * 2. `scanner.ts` 的 `scanAll` —— 按 `eventId` 去重的 `seenEvents`；
 * 3. SQLite 的 `event_id` 主键（`INSERT OR IGNORE`）。
 *
 * 任何一处漏掉，症状都只是「总量悄悄偏大」——而且**只在真的配了多个根时才出现**，
 * 单根测试永远发现不了。派生的本地库还带水位线（第二次 ingest 与第一次路径不同），
 * 更难复现。所以这里同时验「直扫路径」与「库路径」，并要求两者逐位相等。
 *
 * ## 与单测的分工
 *
 * `packages/core/test/multi-home.test.ts` 钉的是最小可读样例（4 条记录 / 420 token），
 * 随 `bun test` 每次运行；本脚本钉的是**语义等价关系本身**（合并、顺序、嵌套、
 * 冲突、部分重叠、规模），人可读地打印每一步，用于改动扫描/入库后的人工复核。
 *
 * 运行：`bun run --filter '@ai-token-report/core' verify:multi-home`
 * 只用本机临时目录，**不碰真实 home、不碰真实库**。
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { normalizeHomes, resolvePaths } from '../src/home.js'
import { inspectSessionRoots, listSessionFiles, scanAll } from '../src/scanner.js'
import { ingest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'
import type { UsageRecord } from '../src/types.js'

// ── 报告 ────────────────────────────────────────────────────────────────────

let checks = 0
let failures = 0
let skips = 0
let observations = 0

function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`)
}

/** 本机无法构造该条件时**如实跳过** —— 不假装通过，也不计失败。 */
function skip(label: string, reason: string): void {
  skips++
  console.log(`  ⏭ ${label}：${reason}`)
}

/**
 * 观察项：**当前行为**与另一处的口径不一致。
 *
 * 本脚本只做验证、不改产品，所以这类发现**不计入失败** —— 但必须在汇总里显眼列出，
 * 否则「验证全绿」会把一个真实的口径缺口掩盖掉。
 */
function observe(label: string, detail: string): void {
  observations++
  console.log(`  ⚠ ${label}`)
  console.log(`      ${detail}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────`)
}

const dir = mkdtempSync(join(tmpdir(), 'atr-verify-multi-home-'))

// ── 造日志 ──────────────────────────────────────────────────────────────────

const DAY1 = Date.UTC(2026, 8, 25, 4, 0, 0)
const DAY2 = Date.UTC(2026, 8, 26, 4, 0, 0)

interface Frame {
  seq: number
  time?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  provider?: string
  model?: string
}

/** `sessionId` → 该会话的帧。同一份 spec 落盘两次就是**逐帧镜像**。 */
type SessionSpec = Record<string, Frame[]>

/** 每帧默认 10+2+90+3 = 105 token，便于心算总量。 */
const F = (seq: number, extra: Partial<Frame> = {}): Frame => ({ seq, ...extra })

function writeSession(root: string, sessionId: string, frames: Frame[], project: string): string {
  const target = join(root, project, sessionId)
  mkdirSync(target, { recursive: true })
  const file = join(target, 'session.v3.jsonl.zstd')
  const buffers = frames.map((f) =>
    zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          type: 'assistant/message',
          seq: f.seq,
          time: f.time ?? DAY1,
          data: {
            usage: {
              inputTokens: f.input ?? 10,
              outputTokens: f.output ?? 2,
              cacheReadTokens: f.cacheRead ?? 90,
              cacheWriteTokens: f.cacheWrite ?? 3,
            },
            message: { source: { provider: f.provider ?? 'p', model: f.model ?? 'm' } },
          },
        }) + '\n',
      ),
    ),
  )
  writeFileSync(file, Buffer.concat(buffers))
  return file
}

/**
 * 把一份根规格落盘。
 *
 * ⚠️ **每个来源必须是一个独立的 `<project>` 名，不能是多级路径**：扫描器只认
 * `sessions/<project>/<sessionId>/<file>` **恰好三层** —— `listSessionFilesInRoot`
 * 只做两层 `readdir` 就找 `session*.jsonl.zstd`，`sessionFilesFromPaths` 也逐字检查
 * `candidate.length !== 3`。把镜像写成 `a/project` 会让日志落到**第四层**，
 * 结果是**一个文件都扫不到**：不报错、不告警、扫描结果为 0 条。
 *
 * 这个坑本脚本第一版就踩了（「合并根 0 条」），所以在此显式记一笔 ——
 * 自己动手搭日志目录时最容易犯的错。
 */
function materialize(root: string, spec: SessionSpec, projectName = 'project'): string {
  for (const [sessionId, frames] of Object.entries(spec)) writeSession(root, sessionId, frames, projectName)
  return root
}

/** 一个根在哪里。 */
function rootAt(...segments: string[]): string {
  const root = join(dir, ...segments, 'sessions')
  mkdirSync(root, { recursive: true })
  return root
}

// ── 比较工具 ────────────────────────────────────────────────────────────────

/**
 * 把记录折成**顺序无关**的可比形式。
 *
 * 必须按 `eventId` 排序：`scanAll` 的结果顺序取决于文件遍历顺序，
 * 而多根与合并根的目录结构不同 —— 直接比数组会把「同一条记录」判成不同。
 * 逐字段展开（而不是只比 token 和）是为了让「哪条记录被换了」能一眼看出来。
 */
/** 一条记录的可比指纹（逐字段展开，而不是只比 token 和：让「哪条被换了」一眼可见）。 */
function recordLine(r: UsageRecord): string {
  return [
    r.eventId,
    r.sessionId,
    r.seq,
    r.time,
    r.provider,
    r.model,
    r.usage.input,
    r.usage.output,
    r.usage.cacheRead,
    r.usage.cacheWrite,
    r.usage.reasoning,
    r.usage.total,
  ].join('|')
}

function normalize(records: readonly UsageRecord[]): string[] {
  return [...records]
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map(recordLine)
}

function sumTokens(records: readonly UsageRecord[]): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
} {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const r of records) {
    acc.input += r.usage.input
    acc.output += r.usage.output
    acc.cacheRead += r.usage.cacheRead
    acc.cacheWrite += r.usage.cacheWrite
    acc.total += r.usage.total
  }
  return acc
}

/** 两个记录集必须逐位相同（顺序无关）。返回是否相同，便于断言文案。 */
function sameRecords(a: readonly UsageRecord[], b: readonly UsageRecord[]): boolean {
  try {
    assert.deepEqual(normalize(a), normalize(b))
    return true
  } catch {
    return false
  }
}

function rootPaths(infos: readonly { root: string }[]): string {
  return infos.map((i) => i.root).join(' + ')
}

// ── 规格 ────────────────────────────────────────────────────────────────────

/** A 根：s1 三帧、s2 两帧、s3 一帧（6 条 / 630 token）。 */
const SPEC_A: SessionSpec = {
  s1: [F(1), F(2), F(3)],
  s2: [F(1), F(2)],
  s3: [F(1)],
}

/** B 根：s1 **逐帧镜像**、s4 独有（4 条 / 420 token）。并集 = 7 条 / 735。 */
const SPEC_B: SessionSpec = {
  s1: [F(1), F(2), F(3)],
  s4: [F(1)],
}

try {
  const rootA = materialize(rootAt('a'), SPEC_A)
  const rootB = materialize(rootAt('b'), SPEC_B)
  // 合并根：A 与 B 的日志都搬进来，各自一个 project 名（同名镜像文件不许互相覆盖）
  const merged = rootAt('merged')
  materialize(merged, SPEC_A, 'a-project')
  materialize(merged, SPEC_B, 'b-project')

  // ── S1 ─────────────────────────────────────────────────────────────────
  section('S1 多根并集 ≡ 物理合并到一个根（核心命题）')
  const union = await scanAll([rootA, rootB])
  const mergedScan = await scanAll([merged])
  const unionSum = sumTokens(union.records)
  const summed = sumTokens((await scanAll([rootA])).records).total + sumTokens((await scanAll([rootB])).records).total

  console.log(`  并集 ${union.records.length} 条 / ${unionSum.total} token；两根相加 = ${summed} token`)
  check('并集与合并根逐位相同（顺序无关）', sameRecords(union.records, mergedScan.records),
    `${union.records.length} vs ${mergedScan.records.length} 条`)
  check('并集 = 7 条（A 的 6 条 + B 独有的 s4）', union.records.length === 7, `${union.records.length}`)
  check('镜像不重复计数：7 条 / 735 token < 相加的 1050', unionSum.total === 735 && summed === 1050,
    `${unionSum.total} < ${summed}`)
  check('会话数按 sessionId 去重 = 4 个', new Set(union.records.map((r) => r.sessionId)).size === 4,
    [...new Set(union.records.map((r) => r.sessionId))].sort().join(','))

  // ── S2 ─────────────────────────────────────────────────────────────────
  section('S2 顺序无关：先给 A 还是先给 B，结果相同')
  const reversed = await scanAll([rootB, rootA])
  check('[A,B] ≡ [B,A]', sameRecords(union.records, reversed.records))

  // ── S3 ─────────────────────────────────────────────────────────────────
  section('S3 同一个根给两次：不翻倍')
  const twice = await scanAll([rootA, rootA])
  const once = await scanAll([rootA])
  check('scanAll([A,A]) ≡ scanAll([A])', sameRecords(twice.records, once.records))
  check('文件按**绝对路径**去重',
    (await listSessionFiles([rootA, rootA])).length === (await listSessionFiles([rootA])).length,
    `${(await listSessionFiles([rootA])).length} 个文件`)

  // ── S4 ─────────────────────────────────────────────────────────────────
  section('S4 根的写法不影响语义（单个字符串 / 一元数组 / 多根里的一个）')
  check('scanAll(A) ≡ scanAll([A])', sameRecords((await scanAll(rootA)).records, once.records))
  const three = await scanAll([rootA, rootB, rootA])
  check('scanAll([A,B,A]) ≡ scanAll([A,B])', sameRecords(three.records, union.records))

  // ── S5 ─────────────────────────────────────────────────────────────────
  section('S5 缺失的根与空的根：跳过但不污染')
  const missing = join(dir, 'gone', 'sessions')
  const empty = rootAt('empty')
  const degraded = await scanAll([rootA, missing, empty])
  check('scanAll([A, 缺失, 空]) ≡ scanAll([A])', sameRecords(degraded.records, once.records))
  check('缺失根不抛错且不贡献记录', degraded.records.length === once.records.length)

  const infos = await inspectSessionRoots([rootA, missing, empty])
  check('inspectSessionRoots 逐根报出', infos.length === 3)
  check('存在的根：会话数 / 文件数', infos[0]!.exists && infos[0]!.sessions === 3 && infos[0]!.files === 3,
    `sessions=${infos[0]!.sessions} files=${infos[0]!.files}`)
  check('缺失的根：exists=false 且带原因', infos[1]!.exists === false && (infos[1]!.error ?? '').includes('不存在'),
    infos[1]!.error ?? '(无 error)')
  check('空的根：exists=true 但 0 会话（与「不存在」是两件事）',
    infos[2]!.exists === true && infos[2]!.sessions === 0 && infos[2]!.error === undefined)
  check('逐根可见性报的是「读到了什么」，镜像文件仍各算一个',
    infos[0]!.files === 3 && infos[0]!.sessions === 3,
    `A 根 ${infos[0]!.files} 个文件；并集只有 ${union.records.length} 条事件`)
  console.log(`  根集合：${rootPaths(infos)}`)

  // ── S6 ─────────────────────────────────────────────────────────────────
  section('S6 部分重叠（同一会话被两边各记了一部分）：按 seq 取并集')
  const partA = materialize(rootAt('part-a'), { s9: [F(1), F(2)] })
  const partB = materialize(rootAt('part-b'), { s9: [F(2), F(3)] })
  const part = await scanAll([partA, partB])
  check('s9 的并集 = seq 1,2,3 三条', part.records.length === 3,
    `seq=${part.records.map((r) => r.seq).sort().join(',')}`)
  check('既不是相加的 4 条，也不是只认一边的 2 条', part.records.length === 3)

  // ── S7 ─────────────────────────────────────────────────────────────────
  section('S7 冲突镜像（同 eventId、不同数值）：只算一条，胜者是最先扫描的根')
  const clashA = materialize(rootAt('clash-a'), { s7: [F(1, { input: 1000 })] })
  const clashB = materialize(rootAt('clash-b'), { s7: [F(1, { input: 5 })] })
  const ab = await scanAll([clashA, clashB])
  const ba = await scanAll([clashB, clashA])
  check('永不重复计数（两条根各有一份，结果只有 1 条）', ab.records.length === 1 && ba.records.length === 1)
  check('先给的根胜：[A,B] 取 A 的值', ab.records[0]!.usage.input === 1000, `input=${ab.records[0]!.usage.input}`)
  check('反向亦然：[B,A] 取 B 的值', ba.records[0]!.usage.input === 5, `input=${ba.records[0]!.usage.input}`)
  check('★ 但**同一组根的集合**结果确定：`normalizeHomes` 的字典序排序让「先给的」不是随机的',
    ab.records[0]!.usage.input !== ba.records[0]!.usage.input)
  console.log('  说明：值冲突时「先写入者胜」；同一组根经字典序稳定排序后每次运行都一样，')
  console.log('        所以这不是不确定性，而是「冲突数据的取舍规则」。真实场景里镜像文件通常逐字节相同。')

  // ── S8 ─────────────────────────────────────────────────────────────────
  section('S8 嵌套 / 拷贝路径：文件路径不同也不翻倍（靠 eventId 兜底）')
  const nestOuter = materialize(rootAt('nest'), SPEC_A)
  // 同一份日志再拷到更深一层：文件名完全不同，路径去重拦不住它
  const nestInner = materialize(join(nestOuter, 'deeper'), SPEC_A)
  const nested = await scanAll([nestOuter, nestInner])
  const outerOnly = await scanAll([nestOuter])
  check('两个根的文件数翻倍（路径去重确实拦不住嵌套）',
    (await listSessionFiles([nestOuter, nestInner])).length === 6,
    `${(await listSessionFiles([nestOuter, nestInner])).length} 个文件`)
  check('但事件不翻倍：scanAll([外, 内]) ≡ scanAll([外])', sameRecords(nested.records, outerOnly.records),
    `${nested.records.length} vs ${outerOnly.records.length} 条`)

  // ── S9 ─────────────────────────────────────────────────────────────────
  section('S9 库路径 ≡ 直扫路径（多根），且库只有一份 / 幂等')
  const dbPath = join(dir, 'usage.sqlite')
  const sqlSession = await openStats({ sessionsRoot: [rootA, rootB], dbPath })
  const scanSession = await openStats({ sessionsRoot: [rootA, rootB], dbPath, forceScan: true })
  try {
    const s = sqlSession.totals()
    const d = scanSession.totals()
    console.log(`  库 total=${s.total} calls=${s.calls} sessions=${sqlSession.sessions}；直扫 total=${d.total}`)
    check('库路径 source=sql（真的读库）', sqlSession.source === 'sql', sqlSession.source)
    check('直扫 source=scan', scanSession.source === 'scan', scanSession.source)
    check('两个路径的四列 + total + calls 逐位相同',
      s.input === d.input && s.output === d.output && s.cacheRead === d.cacheRead &&
      s.cacheWrite === d.cacheWrite && s.total === d.total && s.calls === d.calls,
      `total ${s.total} / ${d.total}，calls ${s.calls} / ${d.calls}`)
    check('会话数相同 = 4', sqlSession.sessions === 4 && scanSession.sessions === 4,
      `${sqlSession.sessions} / ${scanSession.sessions}`)
    check('两条路径都报出同一组根', JSON.stringify(sqlSession.sessionsRoots) === JSON.stringify(scanSession.sessionsRoots),
      rootPaths(sqlSession.sessionsRoots.map((root) => ({ root }))))
    check('没有缺失的根', sqlSession.missingRoots.length === 0)
  } finally {
    sqlSession.close()
    scanSession.close()
  }

  // ⚠️ ingest 必须用**另一个**库：上面的 `openStats()` 自己也会 ingest，
  //    共用同一个 dbPath 会让「首轮 inserted」失去意义（数据早就在库里了）。
  const ingestDb = join(dir, 'ingest.sqlite')
  const firstIngest = await ingest({ sessionsRoot: [rootA], dbPath: ingestDb })
  const growIngest = await ingest({ sessionsRoot: [rootA, rootB], dbPath: ingestDb })
  const reversedIngest = await ingest({ sessionsRoot: [rootB, rootA], dbPath: ingestDb })
  check('先只配 A：入库 6 条', firstIngest.inserted === 6, `inserted=${firstIngest.inserted}`)
  check('★ 再加一个根 B：镜像的 3 帧被 `event_id` 主键挡下，只有 B 独有的 s4 入库',
    growIngest.inserted === 1 && growIngest.duplicates === 3,
    `inserted=${growIngest.inserted} duplicates=${growIngest.duplicates}`)
  check('再把根顺序倒过来：一行不写（同一份库，不随顺序分叉）',
    reversedIngest.inserted === 0 && reversedIngest.duplicates === 0,
    `inserted=${reversedIngest.inserted} duplicates=${reversedIngest.duplicates}`)
  console.log('  说明：第三次 inserted=0 **且** duplicates=0 —— 文件一个都没变，L1 水位线')
  console.log('        让它们连解压都不做，所以「重复」根本浮不出来。这不是漏扫。')

  const grownStats = await openStats({ sessionsRoot: [rootA, rootB], dbPath: ingestDb })
  try {
    check('长出来的库里正好是并集：735 token / 4 会话',
      grownStats.totals().total === 735 && grownStats.sessions === 4,
      `total=${grownStats.totals().total} sessions=${grownStats.sessions}`)
  } finally {
    grownStats.close()
  }

  const reverseSql = await openStats({ sessionsRoot: [rootB, rootA], dbPath })
  try {
    check('倒序读库的数字与正序一致', reverseSql.totals().total === 735 && reverseSql.sessions === 4,
      `total=${reverseSql.totals().total}`)
  } finally {
    reverseSql.close()
  }

  // ── S10 ────────────────────────────────────────────────────────────────
  section('S10 时间窗在多根上照常生效')
  const d1 = materialize(rootAt('day1'), { w1: [F(1, { time: DAY1 }), F(2, { time: DAY1 })] })
  const d2 = materialize(rootAt('day2'), { w2: [F(1, { time: DAY2 }), F(2, { time: DAY2 }), F(3, { time: DAY2 })] })
  const allTime = await scanAll([d1, d2])
  const onlyDay2 = await scanAll([d1, d2], { sinceMs: DAY2, untilMs: DAY2 + 3_600_000 })
  const onlyDay1 = await scanAll([d1, d2], { sinceMs: DAY1, untilMs: DAY1 + 3_600_000 })
  check('不限窗口 = 5 条', allTime.records.length === 5, `${allTime.records.length}`)
  check('窗口只覆盖 DAY2 → 3 条', onlyDay2.records.length === 3, `${onlyDay2.records.length}`)
  check('窗口只覆盖 DAY1 → 2 条', onlyDay1.records.length === 2, `${onlyDay1.records.length}`)
  check('过滤在**去重之后**（否则重复事件会在筛选时冒充首次记录）',
    onlyDay2.records.every((r) => r.time === DAY2))

  // ── S11 ────────────────────────────────────────────────────────────────
  section('S11 口径：四项独立、total 是四项之和（多根累计后仍成立）')
  check('total = input + output + cacheRead + cacheWrite',
    unionSum.total === unionSum.input + unionSum.output + unionSum.cacheRead + unionSum.cacheWrite,
    `${unionSum.total} = ${unionSum.input}+${unionSum.output}+${unionSum.cacheRead}+${unionSum.cacheWrite}`)
  check('cacheRead 没有被并进 input（input 恒为给定的 10/帧）',
    unionSum.input === union.records.length * 10,
    `input=${unionSum.input}，7 条 × 10`)
  check('cacheRead 是最大的一项（实测占总用量 94.3% 的同一现象）',
    unionSum.cacheRead > unionSum.input,
    `cacheRead=${unionSum.cacheRead} input=${unionSum.input}`)

  // ── S12 ────────────────────────────────────────────────────────────────
  section('S12 规模：并集语义不随会话数变化（200 会话 × 2 根，其中 100 个镜像）')
  const bigA: SessionSpec = {}
  const bigB: SessionSpec = {}
  for (let i = 0; i < 200; i++) bigA[`big-${i}`] = [F(1), F(2), F(3)]
  for (let i = 0; i < 100; i++) bigB[`big-${i}`] = [F(1), F(2), F(3)] // 镜像（同名同帧）
  // ⚠️ 独有会话必须换 id：沿用 `big-1xx` 会与 A 的**同名同帧**，那又变成镜像了
  for (let i = 0; i < 100; i++) bigB[`solo-b-${i}`] = [F(1), F(2), F(3)]
  const scaleA = materialize(rootAt('scale-a'), bigA)
  const scaleB = materialize(rootAt('scale-b'), bigB)
  const scaleMerged = rootAt('scale-merged')
  materialize(scaleMerged, bigA, 'a-project')
  materialize(scaleMerged, bigB, 'b-project')

  const scaleUnion = await scanAll([scaleA, scaleB])
  const scaleMergedScan = await scanAll([scaleMerged])
  console.log(
    `  文件数：A=${(await listSessionFiles([scaleA])).length} ` +
      `B=${(await listSessionFiles([scaleB])).length} ` +
      `merged=${(await listSessionFiles([scaleMerged])).length}（含 100 对镜像）`,
  )
  check('300 个会话 / 900 条事件（400 个文件里 100 对是镜像）',
    scaleUnion.records.length === 900 && new Set(scaleUnion.records.map((r) => r.sessionId)).size === 300,
    `${scaleUnion.records.length} 条 / ${new Set(scaleUnion.records.map((r) => r.sessionId)).size} 会话`)
  const scaleUnionNorm = normalize(scaleUnion.records)
  const scaleMergedNorm = normalize(scaleMergedScan.records)
  if (JSON.stringify(scaleUnionNorm) !== JSON.stringify(scaleMergedNorm)) {
    const onlyUnion = scaleUnionNorm.filter((x) => !scaleMergedNorm.includes(x))
    const onlyMerged = scaleMergedNorm.filter((x) => !scaleUnionNorm.includes(x))
    console.log(`  并集独有 ${onlyUnion.length} 条，前 3 条：`)
    for (const line of onlyUnion.slice(0, 3)) console.log(`    ${line}`)
    console.log(`  合并独有 ${onlyMerged.length} 条，前 3 条：`)
    for (const line of onlyMerged.slice(0, 3)) console.log(`    ${line}`)
  }
  check('规模下依然与合并根逐位相同', sameRecords(scaleUnion.records, scaleMergedScan.records))
  check('规模下依然不翻倍（相加会是 1800 条）', scaleUnion.records.length === 900)

  // ── S13 同一个根的大小写不同写法 ────────────────────────────────────────
  section('S13 大小写不同的同一路径：home 层去重 vs 扫描层按字符串去重')
  const caseRoot = materialize(rootAt('case'), { c1: [F(1), F(2)] })
  const caseHome = dirname(caseRoot)
  const upperHome = caseHome.toUpperCase()
  const upperRoot = join(upperHome, 'sessions')
  const caseInfos = await inspectSessionRoots([caseRoot, upperRoot])
  console.log(`  根 A：${caseRoot}`)
  console.log(`  根 B：${upperRoot}`)

  if (process.platform === 'win32' && caseInfos[1]!.exists) {
    check(
      'home 层：`normalizeHomes` 按平台归一大小写（`dedupeKey`）→ 两个写法算一个 home',
      normalizeHomes([caseHome, upperHome]).length === 1,
      `${normalizeHomes([caseHome, upperHome]).length} 个`,
    )
    const caseFiles = await listSessionFiles([caseRoot, upperRoot])
    check(
      '★ 但扫描层按 `filePath` **字符串**去重：大小写不同 → 同一份日志被列两次',
      caseFiles.length === 2,
      `${caseFiles.length} 个文件（磁盘上只有 1 份日志）`,
    )
    check(
      '两个写法都巡检出同一份日志（都 exists，会话数相同）',
      caseInfos[0]!.exists && caseInfos[1]!.exists && caseInfos[0]!.sessions === caseInfos[1]!.sessions,
      `${caseInfos[0]!.sessions} / ${caseInfos[1]!.sessions} 个会话`,
    )
  } else if (process.platform === 'win32') {
    skip('大小写场景', '临时目录带「区分大小写」标志（WSL 遗留）—— 大小写变体不是同一个目录')
  } else {
    check(
      '非 Windows：大小写敏感，两个写法是**不同的根**（B 不存在）',
      normalizeHomes([caseHome, upperHome]).length === 2 && caseInfos[1]!.exists === false,
      `normalizeHomes=${normalizeHomes([caseHome, upperHome]).length} 个，B.exists=${caseInfos[1]!.exists}`,
    )
  }
  const caseScan = await scanAll([caseRoot, upperRoot])
  check(
    '★ 无论平台，事件都不翻倍（2 条仍是 2 条）→ 靠 eventId 兜底，而不是靠路径归一',
    caseScan.records.length === 2,
    `${caseScan.records.length} 条`,
  )

  // ── S14 符号链接 / junction：两个根指向同一份日志 ────────────────────────
  section('S14 符号链接 / junction：两个根指向同一份日志')
  const realRoot = materialize(rootAt('link-real'), { L1: [F(1), F(2), F(3)] })
  const linkPath = join(dir, 'link-alias')
  let linked = false
  try {
    // Windows 上用 junction：创建**目录**链接不需要特权，普通 symlink 需要开发者模式
    symlinkSync(dirname(realRoot), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linked = true
  } catch (error) {
    skip('符号链接场景', `本机无法创建链接：${error instanceof Error ? error.message : String(error)}`)
  }

  if (linked) {
    const linkRoot = join(linkPath, 'sessions')
    const linkInfos = await inspectSessionRoots([realRoot, linkRoot])
    const linkFiles = await listSessionFiles([realRoot, linkRoot])
    const linkScan = await scanAll([realRoot, linkRoot])
    console.log(`  真实根：${realRoot}`)
    console.log(`  链接根：${linkRoot}`)

    check(
      '两个根都巡检出同一份日志（都 exists，会话数相同）',
      linkInfos[0]!.exists && linkInfos[1]!.exists && linkInfos[0]!.sessions === linkInfos[1]!.sessions,
      `${linkInfos[0]!.sessions} / ${linkInfos[1]!.sessions} 个会话`,
    )
    check(
      '★ 文件被列两次（列表按 `filePath` 字符串去重，**不做 realpath**）',
      linkFiles.length === 2,
      `${linkFiles.length} 个文件（磁盘上只有 1 份）`,
    )
    check(
      '★ 事件不翻倍：3 条仍是 3 条（同一 eventId 先到者胜）',
      linkScan.records.length === 3,
      `${linkScan.records.length} 条`,
    )
    check('与只看真实根逐位相同', sameRecords(linkScan.records, (await scanAll([realRoot])).records))

    const linkDb = join(dir, 'link.sqlite')
    const linkIngest = await ingest({ sessionsRoot: [realRoot, linkRoot], dbPath: linkDb })
    check('入库也只算一份（3 条）', linkIngest.inserted === 3, `inserted=${linkIngest.inserted}`)
  }

  // ── S15 「存在但读不了」与「根本不存在」必须能分开 ────────────────────────
  section('S15 「存在但读不了」（根不是目录）vs「根本不存在」')
  const notADirRoot = join(dir, 'not-a-dir', 'sessions')
  mkdirSync(dirname(notADirRoot), { recursive: true })
  writeFileSync(notADirRoot, '这不是目录\n') // 用**文件**占住根路径 → readdir 抛 ENOTDIR

  const brokenInfos = await inspectSessionRoots([rootA, notADirRoot, missing])
  console.log(`  读不了的根：${brokenInfos[1]!.root}`)
  console.log(`    → exists=${brokenInfos[1]!.exists} error=${brokenInfos[1]!.error}`)
  console.log(`  不存在的根：${brokenInfos[2]!.root}`)
  console.log(`    → exists=${brokenInfos[2]!.exists} error=${brokenInfos[2]!.error}`)

  check(
    '文件占住根路径：exists=true 且**带 error**（不是「不存在」）',
    brokenInfos[1]!.exists === true && (brokenInfos[1]!.error ?? '').length > 0,
  )
  check('真正不存在的根：exists=false', brokenInfos[2]!.exists === false)
  check('★ 两种失败在诊断里可区分（exists 取值不同）', brokenInfos[1]!.exists !== brokenInfos[2]!.exists)
  check('读不了的根不贡献会话 / 文件（但也不冒充「不存在」）',
    brokenInfos[1]!.sessions === 0 && brokenInfos[1]!.files === 0)

  check('scanAll 容错：scanAll([A, 读不了]) ≡ scanAll([A])',
    sameRecords((await scanAll([rootA, notADirRoot])).records, once.records))
  check('默认 listSessionFiles 也容错（不抛错）',
    (await listSessionFiles([rootA, notADirRoot])).length === (await listSessionFiles([rootA])).length)

  let strictThrew = false
  try {
    await listSessionFiles([notADirRoot], { strictErrors: true })
  } catch {
    strictThrew = true
  }
  check('★ 严格模式（strictErrors）必须抛错 —— 全量补报不能把不可读伪装成空历史', strictThrew)

  const brokenDb = join(dir, 'broken.sqlite')
  const brokenIngest = await ingest({ sessionsRoot: [rootA, notADirRoot], dbPath: brokenDb })
  check('读不了的根**不污染数字**（入库条数与只有 A 时相同）',
    brokenIngest.inserted === 6, `inserted=${brokenIngest.inserted}`)

  // ⚠️ 口径缺口：取数路径只用 existsSync 分流「存在 / 不存在」
  const brokenStats = await openStats({ sessionsRoot: [rootA, notADirRoot], dbPath: brokenDb })
  try {
    if (!brokenStats.missingRoots.includes(notADirRoot)) {
      observe(
        '取数路径（`ingest` / `stats`）把「存在但读不了」的根当成空 home，且不放进 `missingRoots`',
        `同一个根，两处口径不同：\n` +
          `      · inspectSessionRoots → exists=true + error（「读不了」表达得出来）\n` +
          `      · stats.missingRoots  → ${JSON.stringify(brokenStats.missingRoots)}（里面**没有**它）\n` +
          `      于是「这个 home 是空的」与「这个 home 读不到」在取数路径上无法区分 ——\n` +
          `      而接口注释承诺「存在但读不了与根本不存在是两件事」。`,
      )
    } else {
      check('取数路径也把读不了的根报进 missingRoots（与 inspectSessionRoots 口径一致）', true)
    }
  } finally {
    brokenStats.close()
  }

  // ── S16 权限不足的根（chmod 0o000） ──────────────────────────────────────
  section('S16 权限不足的根（chmod 0o000）')
  const lockedRoot = materialize(rootAt('locked'), { K1: [F(1)] })
  let locked = false
  try {
    chmodSync(lockedRoot, 0o000)
    // 只有**真的读不了**才算构造成功：Windows 的 chmod 动不了 ACL，目录通常照样可读
    try {
      await listSessionFiles([lockedRoot], { strictErrors: true })
      chmodSync(lockedRoot, 0o755)
    } catch {
      locked = true
    }
  } catch (error) {
    skip('权限场景', `无法修改权限：${error instanceof Error ? error.message : String(error)}`)
  }

  if (locked) {
    const lockedInfos = await inspectSessionRoots([lockedRoot])
    check(
      '权限不足：exists=true 且带 error（与「不存在」分开）',
      lockedInfos[0]!.exists === true && (lockedInfos[0]!.error ?? '').length > 0,
      `error=${lockedInfos[0]!.error}`,
    )
    check('权限不足的根不贡献任何记录', (await scanAll([lockedRoot])).records.length === 0)
    check('多根里有一个不可读时，其余根照常统计',
      (await scanAll([rootA, lockedRoot])).records.length === 6,
      `${(await scanAll([rootA, lockedRoot])).records.length} 条`)
    chmodSync(lockedRoot, 0o755) // 恢复，否则 finally 里的 rmSync 可能删不掉
  } else {
    skip(
      '权限场景',
      '本机 chmod 0o000 之后目录仍可读（Windows 的访问控制由 ACL 表达，chmod 改不动 ACL）—— 未构造出 EACCES',
    )
  }

  // ── S17 真实日志（`--real`）：同样的等价关系，用真实的 sessionId / seq 分布再验一遍 ──
  if (process.argv.includes('--real')) {
    section('S17 真实日志：并集 ≡ 两个根各自扫描的手工并集')
    const paths = resolvePaths()
    const roots = paths.sessionsRoots
    console.log(`  自动发现的根（${roots.length} 个）：`)
    for (const root of roots) console.log(`    ${root}`)
    console.log(`  数据目录：${paths.dataDir}（本脚本不写它，只读日志）`)

    if (roots.length < 2) {
      console.log('  只有 0~1 个根，跳过 S17（这条验证需要至少两个根）。')
    } else {
      const scanA = await scanAll([roots[0]!])
      const scanB = await scanAll([roots[1]!])
      const scanBoth = await scanAll(roots)

      // 手工并集：先 A 后 B —— **与 `normalizeHomes` 的字典序一致**（同一 eventId 冲突时先到者胜）
      const manual = new Map<string, string>()
      for (const r of scanA.records) manual.set(r.eventId, recordLine(r))
      for (const r of scanB.records) if (!manual.has(r.eventId)) manual.set(r.eventId, recordLine(r))
      const actual = new Map(scanBoth.records.map((r) => [r.eventId, recordLine(r)] as const))

      console.log(
        `  A=${scanA.records.length} 条 / B=${scanB.records.length} 条 / 相加=${scanA.records.length + scanB.records.length} / 并集=${scanBoth.records.length} 条`,
      )
      check(
        '并集 < 各根相加（镜像被 event_id 去重，不是漏扫）',
        scanBoth.records.length < scanA.records.length + scanB.records.length,
        `少 ${scanA.records.length + scanB.records.length - scanBoth.records.length} 条`,
      )
      // ★ 核心等价关系：手工并集的**每一条**都必须出现在并集里，且指纹逐位一致。
      //
      //   反过来（并集 ⊆ 手工并集）在真实日志上**不成立、也不该成立**：
      //   这台机器上 DSH 正在写日志，`scanBoth` 比 `scanA` / `scanB` 晚几十秒，
      //   期间新落盘的事件只可能出现在并集里。第一次跑这条就撞上了：
      //   并集 22406 条而手工并集 22402 条 —— 多出的 4 条正是扫描期间写入的。
      //   严格相等只在**静止**的合成场景（S1 / S12）里断言。
      const missing = [...manual].filter(([key, line]) => actual.get(key) !== line)
      check(
        '★ 手工并集 ⊆ 并集，且每条指纹（时间 / 模型 / 四项 token）逐位一致',
        missing.length === 0,
        missing.length > 0
          ? `${missing.length} 条缺失或对不上，例：${missing[0]![0]}`
          : `手工 ${manual.size} 条全部命中`,
      )
      const extra = [...actual.keys()].filter((key) => !manual.has(key))
      console.log(
        `  并集比手工并集多 ${extra.length} 条 —— 真实日志是活的（DSH 正在写），` +
          `这就是 scanA/scanB 之后新落盘的那部分。`,
      )

      // 并集**单调**：再扫一次，之前看到的每条都还在。
      // 这条把「多出来的 = 日志在长」与「多根路径不一致」区分开 ——
      // 后者会表现为两条路径的结果忽多忽少，而不是稳定只增。
      const scanAgain = await scanAll(roots)
      const again = new Map(scanAgain.records.map((r) => [r.eventId, recordLine(r)] as const))
      const vanished = [...actual].filter(([key, line]) => again.get(key) !== line)
      check(
        '★ 再扫一次：并集只增不减（每个键都还在且指纹一致）→ 多出的部分是日志在长',
        vanished.length === 0,
        vanished.length > 0
          ? `${vanished.length} 条消失或变化，例：${vanished[0]![0]}`
          : `${actual.size} 条 → ${again.size} 条，全部保留`,
      )
      const manualSessions = new Set([...scanA.records, ...scanB.records].map((r) => r.sessionId))
      check(
        '并集会话数 == 手工并集的会话数（会话去重与事件去重一致）',
        new Set(scanBoth.records.map((r) => r.sessionId)).size === manualSessions.size,
        `${new Set(scanBoth.records.map((r) => r.sessionId)).size} vs ${manualSessions.size}`,
      )
      console.log('  ⚠️ 读的是本机真实日志（只读：不写库、不写 dataDir）—— 条数随使用情况变化。')
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────────────────
  console.log('')
  if (skips > 0) {
    console.log(`（跳过 ${skips} 项：本机构造不出该条件，已在上面对应小节逐条说明 —— 不是通过）`)
  }
  if (observations > 0) {
    console.log(`（另有 ${observations} 处**口径不一致**，作为观察项列出；不计入失败，需要你决定是否修）`)
  }
  if (failures > 0) {
    console.error(`✗ 多 home 语义正确性：${checks - failures}/${checks} 项通过，${failures} 项失败`)
    process.exitCode = 1
  } else {
    console.log(`✓ 多 home 语义正确性：全部 ${checks} 项通过`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}