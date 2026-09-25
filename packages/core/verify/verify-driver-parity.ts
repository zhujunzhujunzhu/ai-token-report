/**
 * 双驱动对照验证 —— `core/db` 在 **Bun** 与 **Node** 下必须给出逐位相同的结果。
 *
 * ## 为什么需要它
 *
 * `core/db` 通过 `driver.ts` 在运行期挑驱动（Bun → `bun:sqlite`，Node → `node:sqlite`）。
 * 两个驱动的 API 不同（`query()` / `transaction()` / `finalize()` 三处缺失），
 * 适配层一旦抹平得不彻底，就会**只在其中一个运行时上错**。
 * 单元测试跑在 Bun 上，因此**永远发现不了 Node 那一侧的问题** ——
 * 这正是本脚本存在的理由。
 *
 * ## 怎么跑
 *
 * 它需要跨运行时执行，所以由同目录的 `run-driver-parity.ts` 调度：
 *
 * ```bash
 * bun run packages/core/verify/run-driver-parity.ts
 * ```
 *
 * 调度器会把这个文件 bundle 成 Node 产物，分别用 `node` 与 `bun` 跑一遍，
 * 再逐行比对两边的输出。**两边不一致就是失败。**
 *
 * ⚠️ 单独用 `bun run` 执行本文件只会验证 Bun 一侧，不具备对照意义。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  activeDriver,
  openDatabaseForIngest,
  insertRecords,
  countEvents,
  queryTotals,
  resetDb,
} from '@ai-token-report/core/db'
import type { UsageRecord } from '@ai-token-report/core'

const runtime =
  typeof globalThis.Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`

const lines: string[] = []
const say = (s: string): void => void lines.push(s)

say(`runtime=${runtime}`)
say(`driver=${activeDriver()}`)

const dir = mkdtempSync(join(tmpdir(), 'driver-parity-'))
const dbPath = join(dir, 'usage.sqlite')

/**
 * 造一条记录。
 *
 * 🚨 `cwd` / `turn` / `step` **故意留 `undefined`**：这三个字段在
 *   `UsageRecord` 里都是可选的，而 `insertRecords()` 会原样把它们绑进 SQL。
 *   `node:sqlite` 对 `undefined` 直接抛
 *   `Provided value cannot be bound to SQLite parameter`，
 *   所以这几行就是「适配层有没有把 undefined 归一成 null」的探针。
 */
function rec(sessionId: string, seq: number, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    eventId: `${sessionId}:${seq}`,
    sessionId,
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    cwd: undefined,
    turn: undefined,
    step: undefined,
    usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 5, reasoning: 7 },
    ...over,
  }
}

const failures: string[] = []
const check = (name: string, actual: unknown, expected: unknown): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  say(`check.${name}=${ok ? 'ok' : `FAIL(got ${a}, want ${e})`}`)
  if (!ok) failures.push(name)
}

// ── 1. 建库 + 写入（含 undefined 绑定）────────────────────────────────────
const db = openDatabaseForIngest(dbPath)
insertRecords(db, [rec('s1', 1), rec('s2', 1, { cwd: 'D:/proj/a' }), rec('s1', 2)])
check('insertedEvents', countEvents(db), 3)

// ── 2. 四项原始列之和（口径真源是 shared/metrics.ts，这里只验原始相加）────
//   `total` 由 queryTotals 用计费恒等式在 JS 侧重算，不是 SQL 算出来的。
check('totals', queryTotals(db, {}), {
  input: 300,
  output: 60,
  cacheRead: 2700,
  cacheWrite: 15,
  reasoning: 21,
  total: 3075,
  calls: 3,
})

// ── 3. 时间窗筛选（验证 WHERE 构造在两个驱动下一致）──────────────────────
//   三条记录的时间分别是 +1000 / +1000 / +2000，从 +1500 起只剩最后一条。
check('filteredBySince', queryTotals(db, { sinceMs: 1_700_000_001_500 }).calls, 1)

// ── 4. 事务嵌套：node 后端用 SAVEPOINT 模拟，bun 用原生实现 ────────────────
try {
  db.transaction(() => {
    insertRecords(db, [rec('s3', 1)])
    db.transaction(() => {
      insertRecords(db, [rec('s4', 1)])
    })
  })
  check('nestedTransaction', countEvents(db), 5)
} catch (err) {
  say(`nestedTransaction=FAIL(${err instanceof Error ? err.message : String(err)})`)
  failures.push('nestedTransaction')
}

// ── 5. 回滚：抛错后整批都不该落地 ─────────────────────────────────────────
try {
  db.transaction(() => {
    insertRecords(db, [rec('s5', 1)])
    throw new Error('boom')
  })
} catch {
  /* 预期抛错 */
}
check('rollbackKeptEvents', countEvents(db), 5)

db.close()

// ── 6. ★ --reset-db：close 之后必须能删掉库文件（含 wal/shm）─────────────
//   Bun 侧漏 finalize 会让这里抛 EBUSY —— 这是本脚本最想守住的一条。
const leftovers = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((f) => existsSync(f))
say(`leftoverFilesAfterClose=${leftovers.length}`)

try {
  await resetDb(dbPath)
  check('resetDb', existsSync(dbPath), false)
} catch (err) {
  const code = (err as { code?: string }).code ?? ''
  say(`resetDb=FAIL(${code} ${err instanceof Error ? err.message : String(err)})`)
  failures.push('resetDb')
}

rmSync(dir, { recursive: true, force: true })

process.stdout.write(lines.join('\n') + '\n')
if (failures.length > 0) {
  process.stderr.write(`❌ 失败项：${failures.join(', ')}\n`)
  process.exit(1)
}
