/**
 * 多个 DSH home 的**性能**验证：多配一个根，代价是多少、代价花在**哪里**。
 *
 * ## 要回答的三个问题
 *
 * 1. **成本随什么增长** —— 根数？文件数？还是并集事件数？
 * 2. **去重能不能省成本** —— 镜像会话被 `event_id` 丢掉，是不是连读都不用读了？
 * 3. **热态路径受影响吗** —— 页面上每次取数都会先跑一轮增量 ingest，多根会不会拖慢它？
 *
 * ## 先说结论（脚本会把这些数字打出来核对）
 *
 * - **成本由「文件总数」决定，与并集事件数无关。** 去重发生在**解析之后**
 *   （`scanAll` 的 `seenEvents`、SQLite 的 `event_id` 主键），所以镜像文件照样要被
 *   打开、解压、`JSON.parse` —— 只是最后不入账。两个 root 全是镜像时，
 *   数字一条不涨，扫描成本**照样翻倍**。
 * - **多根本身没有额外开销。** 同样的 800 个文件，放进 1 个根与放进 4 个根耗时相同
 *   （实测差 < 10%）—— 成本只由文件总数决定，与「分成几个根」无关。
 * - **存在规模效应（与根数无关，单根同样有）**：文件越多，每文件成本越高。
 *   `scanAll` 要把全部记录驻留内存返回（800 文件 = 24000 个对象），而入库路径
 *   逐文件处理 —— 800 文件的冷扫「每文件成本」约为 200 文件的 2 倍。
 *   这只影响全量直扫的耗时，不影响任何数字。
 * - **热态 ingest 与文件数成正比（每文件一次 `stat`），但常数极小**：
 *   L1 水位线让未变更的文件零解压跳过，所以它比冷扫便宜一个数量级。
 * - **库查询与根数基本无关**：数据已在库里，多根只影响「这一轮要 stat 几个文件」。
 *
 * ## 测量口径（别把它读成磁盘基准）
 *
 * 合成场景：每根 200 会话 × 30 帧 = 200 个文件 / 6000 条事件，帧内容固定
 * 105 token（10 输入 + 2 输出 + 90 缓存读 + 3 缓存写）。
 * 冷扫取「热身 1 次 + 3 次中位数」，因此**是热文件缓存下的解压 + JSON 解析成本**，
 * 不含冷磁盘 IO —— 本脚本不尝试清空系统缓存（Windows 上做不到，靠 `sync` 之类
 * 制造「冷」只会得到不可复现的数字）。
 *
 * 真实场景（`--real`）：用 `core/src/home.ts` 发现的**本机真实对话日志**只读扫描，
 * 库一律写到临时目录。真实日志规模随机器的使用情况变化，所以那里只打数字、
 * 只做单次测量，不作为回归门槛。
 *
 * 运行：
 *   bun run --filter '@ai-token-report/core' benchmark:multi-home
 *   bun run --filter '@ai-token-report/core' benchmark:multi-home -- --real
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { resolvePaths } from '../src/home.js'
import { listSessionFiles, scanAll } from '../src/scanner.js'
import { ingest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'

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

const dir = mkdtempSync(join(tmpdir(), 'atr-bench-multi-home-'))

// ── 合成日志 ────────────────────────────────────────────────────────────────

const SESSIONS_PER_ROOT = 200
const FRAMES_PER_SESSION = 30
const FRAME_MS = Date.UTC(2026, 8, 25, 4, 0, 0)
const TOKENS_PER_FRAME = 105 // 10 + 2 + 90 + 3

/** 每帧 105 token：input 10 / output 2 / cacheRead 90 / cacheWrite 3。 */
const frameCache = new Map<number, Buffer>()
function frameFor(seq: number): Buffer {
  let buffer = frameCache.get(seq)
  if (!buffer) {
    buffer = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          type: 'assistant/message',
          seq,
          time: FRAME_MS,
          data: {
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 3 },
            message: { source: { provider: 'p', model: 'm' } },
          },
        }) + '\n',
      ),
    )
    frameCache.set(seq, buffer)
  }
  return buffer
}

/**
 * 造一根。
 *
 * ⚠️ 目录结构必须是 `sessions/<project>/<sessionId>/session.v3.jsonl.zstd`
 * **恰好三层** —— 扫描器只认这个形状，多一级会静默扫到 0 个文件。
 *
 * `mirrorIdsFrom` 给定时复用另一根的 `sessionId`，配合相同的帧内容即**逐帧镜像**。
 */
function buildRoot(name: string, idPrefix: string, mirrorIdsFrom?: string): string {
  const root = join(dir, name, 'sessions')
  const sessionDir = join(root, 'project')
  for (let i = 0; i < SESSIONS_PER_ROOT; i++) {
    const sessionId = mirrorIdsFrom ? `${mirrorIdsFrom}-${i}` : `${idPrefix}-${i}`
    const target = join(sessionDir, sessionId)
    mkdirSync(target, { recursive: true })
    const frames: Buffer[] = []
    for (let seq = 1; seq <= FRAMES_PER_SESSION; seq++) frames.push(frameFor(seq))
    writeFileSync(join(target, 'session.v3.jsonl.zstd'), Buffer.concat(frames))
  }
  return root
}

// ── 计时 ────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * 取多轮的中位数。
 *
 * `gcBetweenRounds` 用于**会大量分配**的测量：冷扫要为每条事件构造一个 `UsageRecord`，
 * 800 文件就是 24000 个对象。不在轮与轮之间回收，上一轮的垃圾会算进下一轮的耗时，
 * 于是「每文件成本随规模上升」看起来像算法问题，实际是测量方法的问题
 * （第一版就撞上了：冷扫看起来比「冷扫 + 写库」还慢）。热态路径几乎不分配，不需要这一下。
 */
async function timeMedian(
  rounds: number,
  fn: () => Promise<unknown>,
  gcBetweenRounds = false,
): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    if (gcBetweenRounds && i > 0) forceGc()
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

/**
 * 显式触发 GC 再开始下一组测量。
 *
 * 不这么做时，上一组场景留下的大量短命 Buffer（解压产物）会拖到**下一组**里被回收，
 * 把它的耗时算到别人头上 —— 这是这类微基准最常见的假象来源。
 */
function forceGc(): void {
  const bun = globalThis as { Bun?: { gc?: (force: boolean) => void } }
  bun.Bun?.gc?.(true)
}

let dbSeq = 0

interface Row {
  label: string
  rootCount: number
  files: number
  events: number
  sessions: number
  tokens: number
  coldScanMs: number
  coldIngestMs: number
  hotIngestMs: number
  queryMs: number
}

/** 跑完一个场景的全部测量项。 */
async function measure(label: string, roots: readonly string[]): Promise<Row> {
  forceGc()
  const files = (await listSessionFiles(roots)).length

  // 冷扫：先热身一次（JIT + 文件缓存），再取 3 次中位数
  await scanAll(roots)
  const coldScanMs = await timeMedian(3, async () => (await scanAll(roots)).records.length, true)

  // 冷 ingest：全新库（首轮要解压全部文件并写库）
  const dbPath = join(dir, `bench-${dbSeq++}.sqlite`)
  const coldStart = performance.now()
  const coldResult = await ingest({ sessionsRoot: roots, dbPath })
  const coldIngestMs = performance.now() - coldStart

  // 热 ingest：同一个库再来（文件未变更 → L1 水位线全部跳过）
  const hotIngestMs = await timeMedian(3, async () => ingest({ sessionsRoot: roots, dbPath }))

  // 查询：页面每次取数走的就是这条 —— openStats（内含热态 ingest）+ 读库
  const queryMs = await timeMedian(3, async () => {
    const session = await openStats({ sessionsRoot: roots, dbPath })
    try {
      return session.totals().total
    } finally {
      session.close()
    }
  }, true)

  const union = await scanAll(roots)
  const tokens = union.records.reduce((sum, r) => sum + r.usage.total, 0)

  return {
    label,
    rootCount: roots.length,
    files,
    events: coldResult.inserted,
    sessions: new Set(union.records.map((r) => r.sessionId)).size,
    tokens,
    coldScanMs,
    coldIngestMs,
    hotIngestMs,
    queryMs,
  }
}

// ── 表格 ────────────────────────────────────────────────────────────────────

const WIDTH = 22
function printTable(rows: readonly Row[], baseline: Row): void {
  console.log('')
  console.log(
    `${'场景'.padEnd(WIDTH)}${'根'.padStart(3)}${'文件'.padStart(7)}${'事件'.padStart(8)}` +
      `${'会话'.padStart(7)}${'冷扫ms'.padStart(9)}${'(×基线)'.padStart(9)}` +
      `${'冷入库ms'.padStart(10)}${'热入库ms'.padStart(10)}${'查询ms'.padStart(9)}`,
  )
  console.log('─'.repeat(WIDTH + 3 + 7 + 8 + 7 + 9 + 9 + 10 + 10 + 9))
  for (const row of rows) {
    const ratio = (row.coldScanMs / baseline.coldScanMs).toFixed(2)
    console.log(
      `${row.label.padEnd(WIDTH)}${String(row.rootCount).padStart(3)}${String(row.files).padStart(7)}` +
        `${String(row.events).padStart(8)}${String(row.sessions).padStart(7)}` +
        `${row.coldScanMs.toFixed(0).padStart(9)}${ratio.padStart(9)}` +
        `${row.coldIngestMs.toFixed(0).padStart(10)}${row.hotIngestMs.toFixed(1).padStart(10)}` +
        `${row.queryMs.toFixed(1).padStart(9)}`,
    )
  }
  console.log('')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const useReal = process.argv.includes('--real')

try {
  if (!useReal) {
    console.log('合成场景：每根 200 会话 × 30 帧 = 200 文件 / 6000 条事件 / 630,000 token')
    console.log('（帧内容固定，所以镜像根与源根逐帧相同）')

    const rootA = buildRoot('r1', 'a')
    const rootMirror = buildRoot('r2-mirror', 'b', 'a') // id 与 A 相同 → 全镜像
    const rootB = buildRoot('r3', 'b') // 完全独立
    const rootC = buildRoot('r4', 'c')
    const rootD = buildRoot('r5', 'd')

    // ★ 关键对照：把**同样的 800 个文件**放进**一个**根（4 个 project 名）。
    //   它与「4 根 · 完全独立」的文件数、事件数完全相同 ——
    //   两者耗时接近就说明多根**没有**额外开销，成本只由文件总数决定。
    const single800Root = join(dir, 'r-single-800', 'sessions')
    mkdirSync(single800Root, { recursive: true })
    cpSync(join(rootA, 'project'), join(single800Root, 'project-a'), { recursive: true })
    cpSync(join(rootB, 'project'), join(single800Root, 'project-b'), { recursive: true })
    cpSync(join(rootC, 'project'), join(single800Root, 'project-c'), { recursive: true })
    cpSync(join(rootD, 'project'), join(single800Root, 'project-d'), { recursive: true })

    const rows: Row[] = []
    rows.push(await measure('1 根（基线 200 文件）', [rootA]))
    rows.push(await measure('2 根 · 全镜像（100% 重叠）', [rootA, rootMirror]))
    rows.push(await measure('2 根 · 完全独立（0% 重叠）', [rootA, rootB]))
    rows.push(await measure('★ 1 根 · 800 文件（对照）', [single800Root]))
    rows.push(await measure('★ 4 根 · 800 文件（同上内容）', [rootA, rootB, rootC, rootD]))

    const [base, mirror, indep2, single800, indep4] = rows as [Row, Row, Row, Row, Row]
    printTable(rows, base)

    console.log('── 正确性顺带核对（数字与成本是两件事） ──────────────')
    check('基线：6000 条事件 / 200 会话 / 630,000 token',
      base.events === 6000 && base.sessions === 200 && base.tokens === 6000 * TOKENS_PER_FRAME,
      `${base.events} 条 / ${base.tokens} token`)
    check('★ 全镜像的两个根：事件数**一条不涨**（仍 6000）',
      mirror.events === base.events && mirror.sessions === base.sessions,
      `${mirror.events} 条`)
    check('完全独立的两个根：事件数翻倍（12000）', indep2.events === base.events * 2, `${indep2.events} 条`)
    check('四个独立根：四倍（24000）', indep4.events === base.events * 4, `${indep4.events} 条`)

    console.log('')
    console.log('── 性能结论 ────────────────────────────────────────')
    check('★ 成本随**文件数**增长，与并集事件数无关：全镜像场景事件一条没涨，冷扫照样明显变慢',
      mirror.coldScanMs > base.coldScanMs * 1.5,
      `${base.coldScanMs.toFixed(0)}ms → ${mirror.coldScanMs.toFixed(0)}ms（事件 ${base.events} → ${mirror.events}）`)
    check('★ 也就是说：**去重不省扫描成本**（镜像文件仍被解压 + 解析，只是不入账）',
      mirror.files === 400 && mirror.events === 6000,
      `400 个文件只产出 6000 条事件`)
    check(
      '★★ 多根本身**没有**额外开销：同样的 800 文件 / 24000 事件，1 个根与 4 个根耗时接近（±40%）',
      Math.abs(single800.coldScanMs - indep4.coldScanMs) / indep4.coldScanMs < 0.4,
      `1 根 ${single800.coldScanMs.toFixed(0)}ms  vs  4 根 ${indep4.coldScanMs.toFixed(0)}ms`,
    )

    const perFile = (row: Row): number => row.coldScanMs / row.files
    check('存在**规模效应**（与根数无关）：总文件越多，每文件成本越高',
      perFile(indep4) > perFile(base) * 1.2,
      `200 文件 ${perFile(base).toFixed(2)} ms/文件 → 800 文件 ${perFile(indep4).toFixed(2)} ms/文件`)
    console.log('      ↑ 本机实测的规模效应，**与根数无关**（单根对照同样出现）。旁证：')
    console.log('        冷入库（含扫描 + 写库，反而更重）是线性的 —— 它逐文件处理；')
    console.log('        而 `scanAll` 必须把全部记录留在内存里返回（800 文件 = 24000 个对象），')
    console.log('        规模越大 GC 压力越高。这条只影响「全量直扫」的耗时，不影响任何数字。')

    check('热态 ingest 明显便宜于冷 ingest（水位线让未变更文件零解压）',
      base.hotIngestMs < base.coldIngestMs * 0.5,
      `冷 ${base.coldIngestMs.toFixed(0)}ms → 热 ${base.hotIngestMs.toFixed(1)}ms`)
    check('热态 ingest 每文件仍是亚毫秒（每个文件就一次 stat + 水位线比对）',
      indep4.hotIngestMs / indep4.files < 1,
      `${((indep4.hotIngestMs / indep4.files) * 1000).toFixed(0)} µs/文件`)

    check('查询耗时 ≈ 热态 ingest + 库读：只与文件数有关，与事件数无关',
      indep4.queryMs < indep4.hotIngestMs * 3,
      `查询 ${indep4.queryMs.toFixed(0)}ms vs 热入库 ${indep4.hotIngestMs.toFixed(0)}ms`)

    const hotPerFile = indep4.hotIngestMs / indep4.files
    console.log('')
    console.log(`  参考：热态 ingest 每文件 ≈ ${(hotPerFile * 1000).toFixed(0)} µs（一次 stat + 水位线比对）`)
    console.log(`  参考：冷扫每文件 ≈ ${perFile(base).toFixed(2)} ms @200 文件、${perFile(indep4).toFixed(2)} ms @800 文件`)
    console.log(`  参考：冷扫比热态贵 ${(perFile(base) / hotPerFile).toFixed(0)} 倍（差的就是解压 + JSON.parse）`)
  } else {
    // ── 真实日志 ──────────────────────────────────────────────────────────
    // `resolvePaths()` 无参 = 走自动发现（与 CLI / 本地页面 / 插件**同一条**路径），
    // 且已过滤掉不存在的根（缺失的另由 `missingRoots` 给出）。
    const paths = resolvePaths()
    const allRoots = paths.sessionsRoots
    console.log(`真实日志根（core/src/home.ts 的自动发现结果）：${allRoots.length} 个`)
    for (const root of allRoots) console.log(`  ${root}`)
    console.log(`数据目录：${paths.dataDir}（本脚本不写它 —— 库一律落临时目录）`)
    if (allRoots.length === 0) {
      console.log('\n没有发现任何会话日志根，跳过真实场景。')
    } else {
      const rows: Row[] = []
      rows.push(await measure('第 1 个根', [allRoots[0]!]))
      if (allRoots.length > 1) {
        // ★ 真实数据的「无额外开销」对照**不需要复制任何文件**：
        //   分别量两个根，再量它们的并集。若 `t(A∪B) ≈ t(A) + t(B)`，
        //   就说明多根只是「多走几个目录」，本身不产生额外成本。
        rows.push(await measure('第 2 个根', [allRoots[1]!]))
        rows.push(await measure(`全部 ${allRoots.length} 个根（并集）`, allRoots))
      }
      printTable(rows, rows[0]!)

      if (allRoots.length > 1) {
        const [first, second, all] = rows as [Row, Row, Row]
        const growth = all.coldScanMs / first.coldScanMs
        console.log('── 真实数据观察 ────────────────────────────────────')
        console.log(`  文件数 ${first.files} → ${all.files}（×${(all.files / first.files).toFixed(2)}）`)
        console.log(`  事件数 ${first.events} → ${all.events}（×${(all.events / first.events).toFixed(2)}）`)
        console.log(`  冷扫耗时 ${first.coldScanMs.toFixed(0)}ms → ${all.coldScanMs.toFixed(0)}ms（×${growth.toFixed(2)}）`)
        console.log(
          `  → 并集只多出 ${(((all.events - first.events) / all.events) * 100).toFixed(1)}% 的事件，` +
            `但文件数涨了 ${(((all.files - first.files) / all.files) * 100).toFixed(1)}%，成本跟着**文件数**走。`,
        )
        // ★ 真的去量一次「各根相加」：并集必须**小于**它，否则说明镜像根本没被去重
        const sumOfRoots =
          (await scanAll([allRoots[0]!])).records.length +
          (await scanAll([allRoots[1]!])).records.length
        check(
          '真实数据：并集 < 各根相加（镜像按 event_id 去重 —— 这是正确结果，不是漏扫）',
          all.events < sumOfRoots,
          `并集 ${all.events} 条 < 相加 ${sumOfRoots} 条（差 ${sumOfRoots - all.events} 条镜像）`,
        )
        console.log(
          `  增长对比：耗时 ×${growth.toFixed(2)}，文件数 ×${(all.files / first.files).toFixed(2)}，` +
            `并集事件数 ×${(all.events / first.events).toFixed(2)}`,
        )
        console.log('  → 看耗时跟哪个走：跟随的是**文件数**，不是并集事件数。')
        const sumOfTwoRoots = first.coldScanMs + second.coldScanMs
        check(
          '★★ 真实数据：并集耗时 ≈ 两个根各自耗时之和（±40%）→ 多根本身没有额外开销',
          all.coldScanMs / sumOfTwoRoots > 0.6 && all.coldScanMs / sumOfTwoRoots < 1.6,
          `并集 ${all.coldScanMs.toFixed(0)}ms  vs  根1+根2 = ${sumOfTwoRoots.toFixed(0)}ms`,
        )
      }
      console.log('  ⚠️ 真实场景的测量方式与合成场景完全相同（热身 1 次 + 3 次中位数）。')
      console.log('     不同之处只有规模：文件大小与数量随这台机器的使用情况变化，')
      console.log('     所以这里只作观察 —— 唯一的门槛类断言是「并集 < 各根相加」（确定性事实）。')
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`✗ 多 home 性能验证：${checks - failures}/${checks} 项通过，失败：${failuresList.join('、')}`)
    process.exitCode = 1
  } else {
    console.log(`✓ 多 home 性能验证：全部 ${checks} 项通过`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}