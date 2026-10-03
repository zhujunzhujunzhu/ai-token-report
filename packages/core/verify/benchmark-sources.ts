/**
 * 纯文本来源（Codex / Claude Code / Trae / WorkBuddy）的**性能**验证：
 * 成本随什么增长、热态要付多少、只改一个文件时会不会整根重扫。
 *
 * ## 要回答的四个问题
 *
 * 1. **成本随什么增长** —— 文件数？还是事件数（文件大小）？
 * 2. **热态要付多少** —— 四种形态（CLI / 本地页 / 插件 / report）**每次取数**都会先跑一轮
 *    增量 ingest，用户拿到的「一条命令 50ms」还剩不剩？
 * 3. **只改一个文件时会不会整根重扫** —— 追加写是这些客户端的常态。
 * 4. **镜像根贵在哪** —— 去重省不省 IO？
 *
 * ## 先说结论（脚本会把这些数字打出来核对）
 *
 * - **热态成本只与「文件数」有关，与文件大小（事件数）无关**：水位线是
 *   「字节数没变 ⇒ 整份跳过」，所以热态对每个文件只做一次 `stat`（并发 32），
 *   一条 JSON 都不解析。本机实测（Windows + Bun，1,528 个文件）：**约 67ms**。
 * - **冷态成本与「总字节数」成正比，而且是串行的**（阶段 2 刻意不并发：
 *   列举顺序决定 `event_id` 冲突时谁先入库）。本机真实 Codex 日志 2.8 GB
 *   ⇒ 纯文本侧**约 8 秒**（CLI 端到端 13 秒，还含 DSH 冷扫与进程启动）。
 *   这是**一次性**成本：之后只在文件真的变化时重解析那一个文件。
 * - **直扫（`--no-db`，或库不可用时的降级）每次都要全量解析**：本机 16 秒。
 *   它不是「更慢的库」，而是**没有水位线**的另一条路。
 * - **镜像根不省 IO**：去重发生在解析之后，两个根指向同一份日志时数字不涨、成本照付。
 *
 * ## 测量口径（别把它读成磁盘基准）
 *
 * 合成场景：每根 100 / 400 个 Codex rollout 文件，每个文件固定条数的调用；
 * 冷态取单次、热态取 3 次中位数（轮间显式 GC）。合成文件都在系统临时目录里、
 * 刚写完就被读，**量到的是热文件缓存下的解析成本**，不含冷磁盘 IO。
 *
 * ⚠️ 合成场景的断言只钉**结构性事实**（重解析了几个文件、入了多少条、并集是否相等），
 *    **不钉耗时阈值** —— 这台机器上还跑着别的东西时，几十毫秒级的数字会抖，
 *    而一条会随机变红的门槛最后一定会被人删掉。
 *
 * 真实场景（`--real`）：本机真实日志**只读**（库一律落临时目录）。
 * 真实规模随机器的使用情况变化，所以那里只打数字 + 只做确定性断言。
 *
 * 运行：
 *   bun run --filter '@ai-token-report/core' benchmark:sources
 *   bun run --filter '@ai-token-report/core' benchmark:sources -- --real
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanAllSources } from '../src/scanner.js'
import { ingestPlainSources, type PlainIngestResult } from '../src/db/ingest-plain.js'
import { openDatabaseForIngest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'
import { findSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import type { SourceRoot } from '../src/sources/types.js'

// ── 报告 ────────────────────────────────────────────────────────────────────

let checks = 0
let failures = 0
const failuresList: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) {
    failures++
    failuresList.push(label)
  }
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────`)
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

// ── 计时 ────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** 显式 GC：上一组留下的短命字符串/对象不许算进下一组（与 benchmark-multi-home 同款）。 */
function forceGc(): void {
  const bun = globalThis as { Bun?: { gc?: (force: boolean) => void } }
  bun.Bun?.gc?.(true)
}

async function timeMedian(rounds: number, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    if (i > 0) forceGc()
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

// ── 合成夹具（Codex rollout） ───────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'atr-bench-sources-'))

/** 一个确定性的 v4 形态 uuid（文件名里必须是 uuid，否则列举阶段就会漏掉）。 */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

/**
 * 一个 rollout 文件：`session_meta` + `turn_context` + N 条 `token_count`。
 *
 * ⚠️ `total_token_usage` 必须是**递进的累计快照**：适配器靠「快照没推进 ⇒
 *    同一次调用的第二次写入」去重，全部写成同一个快照会让后 N-1 条被当成重复丢掉 ——
 *    那样「冷态解析了多少」就不再是夹具声称的那个数，量出来的成本也没有意义。
 */
function codexRollout(calls: number, startMs: number): string {
  const iso = (ms: number): string => new Date(ms).toISOString()
  const lines: string[] = [
    JSON.stringify({ timestamp: iso(startMs), ordinal: 0, type: 'session_meta',
      payload: { session_id: uuidFor(0), timestamp: iso(startMs), cwd: '/work/bench', model_provider: 'openai' } }),
    JSON.stringify({ timestamp: iso(startMs + 1), ordinal: 1, type: 'turn_context',
      payload: { model: 'gpt-5-codex', cwd: '/work/bench' } }),
  ]
  const usage = (input: number) => ({ input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 10, reasoning_output_tokens: 0, total_tokens: input + 10 })
  let cumulative = 0
  for (let call = 1; call <= calls; call++) {
    cumulative += 100
    lines.push(JSON.stringify({ timestamp: iso(startMs + call * 1000), ordinal: 1 + call, type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: usage(100), total_token_usage: usage(cumulative) } } }))
  }
  return lines.join('\n') + '\n'
}

/**
 * 造一根 Codex 日志：`<name>/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`。
 *
 * 文件名与内容只由下标决定 ⇒ 两个不同 `name` 造出来的根**天然逐文件镜像**
 * （相对路径相同 ⇒ `file_path` 不同但 `event_id` 相同）。
 */
function buildCodexRoot(name: string, files: number, callsPerFile: number): SourceRoot {
  const rootPath = join(dir, name, 'sessions')
  const dayDir = join(rootPath, '2026', '09', '25')
  mkdirSync(dayDir, { recursive: true })
  const startMs = Date.UTC(2026, 8, 25, 4, 0, 0)
  for (let i = 0; i < files; i++) {
    writeFileSync(join(dayDir, `rollout-2026-09-25T04-00-00-${uuidFor(i)}.jsonl`), codexRollout(callsPerFile, startMs))
  }
  return { path: rootPath, source: 'codex' }
}

// ── 场景 ────────────────────────────────────────────────────────────────────

let dbSeq = 0

interface Row {
  label: string
  files: number
  bytes: number
  cold: PlainIngestResult
  hot: PlainIngestResult
  coldMs: number
  hotMs: number
  queryMs: number
}

/**
 * 一个场景的全部测量项：冷态（全新库）→ 热态（同库再跑，文件未变）
 * →「取数」（`openStats`：热态 ingest + 读库，四种形态每次走的就是这条）。
 */
async function measure(label: string, roots: readonly SourceRoot[], files: number, bytes: number): Promise<Row> {
  const dbPath = join(dir, `bench-${dbSeq++}.sqlite`)
  forceGc()
  const coldStart = performance.now()
  const cold = await ingestPlainSources({ roots, dbPath })
  const coldMs = performance.now() - coldStart
  // 先跑一轮拿到「重解析/跳过」的**结构事实**，再单独量耗时 —— 时长只作报告，不作门槛。
  const hot = await ingestPlainSources({ roots, dbPath })
  const hotMs = await timeMedian(3, async () => ingestPlainSources({ roots, dbPath }))
  const sessionsRoot = roots.map((root) => root.path)
  const sources = [...new Set(roots.map((root) => root.source))]
  const queryMs = await timeMedian(3, async () => {
    const session = await openStats({ sessionsRoot, sourceRoots: roots, sources, dbPath, rollup: true })
    try {
      return session.totals().total
    } finally {
      session.close()
    }
  })
  console.log(`  [${label}] 冷态 ${coldMs.toFixed(0)}ms（入库 ${cold.inserted} 条 / 解析 ${cold.filesScanned} 个文件）`
    + ` · 热态 ${hotMs.toFixed(0)}ms（重解析 ${hot.filesScanned} 个 / 跳过 ${hot.skippedUnchanged} 个）`
    + ` · 取数 ${queryMs.toFixed(0)}ms`)
  return { label, files, bytes, cold, hot, coldMs, hotMs, queryMs }
}

async function synthetic(): Promise<void> {
  section('S1 规模：100 文件 vs 400 文件（每文件 5 次调用）')
  const small = buildCodexRoot('small', 100, 5)
  const large = buildCodexRoot('large', 400, 5)
  const smallRow = await measure('100 文件', [small], 100, 100 * codexRollout(5, 0).length)
  const largeRow = await measure('400 文件', [large], 400, 400 * codexRollout(5, 0).length)
  check('冷态入库条数 == 文件数 × 每文件调用数（夹具与折叠口径一致）',
    smallRow.cold.inserted === 500 && largeRow.cold.inserted === 2000,
    `${smallRow.cold.inserted} / ${largeRow.cold.inserted}`)
  check('★ 热态：一个文件都不重解析（L1 按字节数整份跳过）',
    smallRow.hot.filesScanned === 0 && largeRow.hot.filesScanned === 0
      && largeRow.hot.skippedUnchanged === 400,
    `重解析 ${largeRow.hot.filesScanned} 个 / 跳过 ${largeRow.hot.skippedUnchanged} 个`)
  console.log(`  → 文件数 ×${(largeRow.files / smallRow.files).toFixed(1)}、体积 ×${(largeRow.bytes / smallRow.bytes).toFixed(1)}：`
    + `冷态 ×${(largeRow.coldMs / smallRow.coldMs).toFixed(2)}（跟体积走）、热态 ×${(largeRow.hotMs / smallRow.hotMs).toFixed(2)}（跟文件数走）`)

  section('S2 事件密度：同样 100 个文件，每文件 1 次 vs 50 次调用')
  const sparse = buildCodexRoot('sparse', 100, 1)
  const dense = buildCodexRoot('dense', 100, 50)
  const sparseRow = await measure('每文件 1 次', [sparse], 100, 100 * codexRollout(1, 0).length)
  const denseRow = await measure('每文件 50 次', [dense], 100, 100 * codexRollout(50, 0).length)
  check('★ 热态成本与事件数**无关**：体积差一个数量级，重解析仍是 0 个文件',
    sparseRow.hot.filesScanned === 0 && denseRow.hot.filesScanned === 0,
    `${fmtBytes(sparseRow.bytes)} 冷态 ${sparseRow.coldMs.toFixed(0)}ms / ${fmtBytes(denseRow.bytes)} 冷态 ${denseRow.coldMs.toFixed(0)}ms`)
  console.log(`  → 冷态 ×${(denseRow.coldMs / sparseRow.coldMs).toFixed(2)}（跟体积走），`
    + `热态 ×${(denseRow.hotMs / sparseRow.hotMs).toFixed(2)}（跟文件数走，与体积无关）`)

  section('S3 只改一个文件：追加写是这些客户端的常态')
  {
    const root = buildCodexRoot('append', 50, 5)
    const dbPath = join(dir, 'bench-append.sqlite')
    await ingestPlainSources({ roots: [root], dbPath })
    const dayDir = join(root.path, '2026', '09', '25')
    writeFileSync(join(dayDir, `rollout-2026-09-25T04-00-00-${uuidFor(999)}.jsonl`), codexRollout(5, Date.UTC(2026, 8, 25, 5)))
    const start = performance.now()
    const after = await ingestPlainSources({ roots: [root], dbPath })
    const ms = performance.now() - start
    check('★ 只有**变化的那一个**文件被重解析（不是整根重扫）',
      after.filesScanned === 1 && after.skippedUnchanged === 50,
      `重解析 ${after.filesScanned} 个 / 跳过 ${after.skippedUnchanged} 个 / 新增 ${after.inserted} 条`)
    console.log(`  → ${ms.toFixed(0)}ms（解析 1 个文件 + 50 次 stat）`)
  }

  section('S4 镜像根：去重省数字，不省 IO')
  {
    const primary = buildCodexRoot('mirror-primary', 50, 5)
    const mirror = buildCodexRoot('mirror-copy', 50, 5)
    const singleResult = await ingestPlainSources({ roots: [primary], dbPath: join(dir, 'bench-mirror-single.sqlite') })
    forceGc()
    const start = performance.now()
    const bothResult = await ingestPlainSources({ roots: [primary, mirror], dbPath: join(dir, 'bench-mirror-both.sqlite') })
    const bothMs = performance.now() - start
    const total = (path: string): number => {
      const db = openDatabaseForIngest(path)
      try {
        return db.query<{ total: number }>(
          'SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total FROM usage_event',
        ).get()?.total ?? 0
      } finally {
        db.close()
      }
    }
    const singleTotal = total(join(dir, 'bench-mirror-single.sqlite'))
    const bothTotal = total(join(dir, 'bench-mirror-both.sqlite'))
    check('★ 并集 == 单根（镜像按 event_id 去重 —— 这是正确结果，不是漏扫）',
      bothTotal === singleTotal && bothTotal > 0, `${bothTotal} vs ${singleTotal}`)
    check('★ 镜像照样被解析一遍（去重发生在**解析之后**）',
      bothResult.filesScanned === singleResult.filesScanned * 2,
      `解析 ${bothResult.filesScanned} 个 vs 单根 ${singleResult.filesScanned} 个`)
    console.log(`  → 两个镜像根 ${bothMs.toFixed(0)}ms：数字一条不涨、IO 成本照付`)
  }
}

// ── 真实日志（只读） ────────────────────────────────────────────────────────

async function real(): Promise<void> {
  section('R1 本机真实日志（只读：库一律落临时目录）')
  const resolved = resolveSourceRoots()
  const plain = resolved.roots.filter((root) => root.source !== 'dsh')
  for (const root of resolved.roots) {
    console.log(`  [${root.source}${root.secondary === true ? '/次要副本' : ''}] ${root.path}`)
  }
  if (resolved.missing.length > 0) {
    console.log(`  缺失的根（逐项报出，不静默）：${resolved.missing.map((root) => `${root.source}:${root.path}`).join(' / ')}`)
  }
  if (plain.length === 0) {
    console.log('  （本机没有 DSH 之外的来源根，跳过）')
    return
  }
  for (const root of plain) {
    const adapter = findSource(root.source)
    const metas = adapter === null ? [] : await adapter.list(root)
    console.log(`  [${root.source}] 会话文件 ${metas.length}`)
  }

  const dbPath = join(dir, 'bench-real.sqlite')
  forceGc()
  const coldStart = performance.now()
  const cold = await ingestPlainSources({ roots: plain, dbPath })
  const coldMs = performance.now() - coldStart
  const hot = await ingestPlainSources({ roots: plain, dbPath })
  const hotMs = await timeMedian(3, async () => ingestPlainSources({ roots: plain, dbPath }))

  // 直扫（`--no-db` / 库不可用时的降级）：每次都要全量解析，没有水位线
  forceGc()
  const scanStart = performance.now()
  const scan = await scanAllSources(plain)
  const scanMs = performance.now() - scanStart
  const scanTotal = scan.records.reduce((sum, record) => sum + record.usage.total, 0)

  // 库路径：`openStats` 内含热态 ingest，四种形态每次取数走的就是这条
  const sessionsRoot = plain.map((root) => root.path)
  const sources = [...new Set(plain.map((root) => root.source))]
  const queryStart = performance.now()
  const session = await openStats({ sessionsRoot, sourceRoots: plain, sources, dbPath, rollup: true })
  const dbTotal = session.totals().total
  session.close()
  const queryMs = performance.now() - queryStart

  console.log(`\n  冷态 ${coldMs.toFixed(0)}ms（解析 ${cold.filesScanned} 个文件 / 入库 ${cold.inserted} 条）`)
  console.log(`  热态 ${hotMs.toFixed(0)}ms（重解析 ${hot.filesScanned} 个 / 跳过 ${hot.skippedUnchanged} 个）`)
  console.log(`  直扫 ${scanMs.toFixed(0)}ms（${scan.records.length} 条记录，每次都要全量解析）`)
  console.log(`  取数 ${queryMs.toFixed(0)}ms（热态 ingest + 读库）`)
  console.log(`  各来源采到的文件数与用量事件：${JSON.stringify({
    codexFiles: cold.diagnostics.codexFiles, claudeFiles: cold.diagnostics.claudeFiles,
    traeFiles: cold.diagnostics.traeFiles, workbuddyFiles: cold.diagnostics.workbuddyFiles,
    usageEvents: cold.diagnostics.usageEvents,
  })}`)

  check('★ 热态一个文件都不重解析（四种形态每次取数走的都是这条路）',
    hot.filesScanned === 0 && hot.skippedUnchanged === cold.filesScanned,
    `重解析 ${hot.filesScanned} 个 / 跳过 ${hot.skippedUnchanged} 个`)
  check('★ 库路径总量 == 直扫总量（同一批日志，两条路必须逐位一致）',
    dbTotal === scanTotal && dbTotal > 0, `${dbTotal} vs ${scanTotal}`)
  console.log('  ⚠️ 真实规模随这台机器的使用情况变化，所以这里只作观察（合成场景的断言已经钉住结构性事实）：')
  console.log(`     ${cold.filesScanned} 个文件：冷态约 ${(coldMs / Math.max(1, cold.filesScanned)).toFixed(1)}ms 每文件（解析 + 入库），`
    + `热态 ${(hotMs / Math.max(1, cold.filesScanned)).toFixed(3)}ms 每文件（一次 stat）`)
  console.log('     直扫与冷态是同一量级，因为两者都要把每个文件读一遍、解析一遍 ——')
  console.log('     差别只在直扫**每次取数**都要付，而冷态只付一次、之后走热态。')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

try {
  await synthetic()
  if (process.argv.includes('--real')) await real()
  else console.log('\n（加 `-- --real` 可在本机真实日志上只读复测；数字随使用情况变化）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (failures > 0) {
  console.error(`✗ 多来源性能验证：${checks - failures}/${checks} 项通过，失败：${failuresList.join('、')}`)
  process.exitCode = 1
} else {
  console.log(`✓ 多来源性能验证：全部 ${checks} 项通过`)
}
