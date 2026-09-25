/**
 * SQLite 驱动适配层 —— 让 `core/db` 的**同一份 SQL 与同一套口径**同时跑在 Bun 与 Node 上。
 *
 * ## 为什么需要这一层
 *
 * `core/db` 原本直接 `import { Database } from 'bun:sqlite'`。这带来两个后果：
 *
 * 1. 发布到 npm 后 **Node 用户装得上但跑不起来**：`bun:sqlite` 是 Bun 专有内建模块，
 *    Node 解析它直接报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 * 2. 打包器会把它提到产物顶层。实测 `bun build --target=node` 的产物里
 *    仍然是 `import { Database } from "bun:sqlite"` ——
 *    所以**不能**静态 import，必须用构建期不可静态分析的加载方式。
 *
 * ## 两个后端的能力差异（均为本机实测，不是文档推断）
 *
 * | 能力 | `bun:sqlite` | `node:sqlite` |
 * |---|---|---|
 * | 可用运行时 | 仅 Bun | Node ≥ 22.5（22.x 会打 ExperimentalWarning，无需 flag） |
 * | `db.query(sql)` | 有（内部缓存） | **无** → 用 `prepare()` 顶替 |
 * | `db.transaction(fn)` | 有（返回函数，需再调用一次） | **无** → 手动 BEGIN/COMMIT |
 * | `stmt.finalize()` | 有，**且必须调用** | **无**（GC 负责） |
 * | 绑定 `undefined` | 容忍 | **抛错** `Provided value cannot be bound` |
 *
 * ★ 后两行是本层存在的**真正理由**，也是两个最容易踩的坑：
 *
 * - 🚨 **Bun 下 `close()` 不会释放未 finalize 的 `prepare()` 语句**，句柄不释放会让
 *   之后的 `rmSync` 抛 `EBUSY: resource busy or locked` —— 表现就是 `--reset-db`
 *   永远失败，而错误信息完全不提 prepared statement。
 *   实测（`probe4`）：全部 finalize 后 `rm` 成功；漏掉任意一个 `prepare()` 就失败。
 *   因此 `finalize()` 在 Bun 后端**必须真的调用**，在 Node 后端则是空操作。
 *
 * - 🚨 **`undefined` 绑不进 SQLite**：Node 直接抛
 *   `Provided value cannot be bound to SQLite parameter N`。
 *   而 `UsageRecord` 的 `cwd` / `turn` / `step` 都是可选字段，随时可能是 `undefined`
 *   （`insertRecords()` 里的 `$cwd: rec.cwd` 就是活例子）。
 *   所以本层在**绑定的唯一入口**把 `undefined` 一律归一成 `null`。
 *
 * ## 为什么不能「统一走 node:sqlite」
 *
 * 实测过（`probe2`）：`node:sqlite` 在 **Bun 1.4.2** 下 `close()` 之后句柄不释放，
 * `-wal` 残留 4 MB、`-shm` 残留，`rmSync` 抛 EBUSY ——
 * 而 `node:sqlite` 根本没有 `finalize()` 可以用来补救。所以 Bun 上必须用
 * `bun:sqlite`，两个后端都得留着。
 *
 * ## 本层只抹平「驱动调用方式」，绝不碰 SQL 与口径
 *
 * 🚨 这里**不允许**出现任何 token 口径公式（铁律 1）。它只负责把
 * `query` / `prepare` / `exec` / `transaction` / `close` 这五个动作
 * 转成目标驱动认得的写法。SQL 文本仍由 `query.ts` / `ingest.ts` 原样提供，
 * 因此「只用 `bun:sqlite`」与「只用 `node:sqlite`」跑出来的数字必然一致 ——
 * 这一点由 `test/db.test.ts` 的 `assertSameTotals()` 与
 * `verify/verify-db-parity.ts` 双向兜住。
 */

import { createRequire } from 'node:module'

/** 单个绑定值。与 `bun:sqlite` 的 `SQLQueryBindings` 取值域保持一致。 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array

/**
 * 一组绑定值：具名参数用对象（键带 `$` 前缀），位置参数用数组。
 *
 * 显式允许 `undefined`：调用方（如 `UsageRecord.cwd`）确实会传进来，
 * 归一化由本层负责，而不是把「值可能是 undefined」这个事实藏起来。
 */
export type SqlBindings = Record<string, SqlValue | undefined> | (SqlValue | undefined)[]

/** 兼容 `bun:sqlite` 的旧名字，让 `query.ts` 等文件的签名无需改写。 */
export type SQLQueryBindings = SqlBindings

/** 一条已准备好的语句。 */
export interface SqlStatement<Row = unknown> {
  /** 执行写操作。返回受影响行数。 */
  run(params?: SqlBindings): { changes: number; lastInsertRowid: number | bigint }
  /** 取一行；无结果返回 `null`/`undefined`（两个后端返回值不同，按需判空）。 */
  get(params?: SqlBindings): Row | null | undefined
  /** 取全部行。 */
  all(params?: SqlBindings): Row[]
  /**
   * 释放语句句柄。
   *
   * 🚨 Bun 下**必须**对每个 `prepare()` 出来的语句调用它，否则 `--reset-db`
   *   会因句柄未释放而失败。Node 下是空操作。
   */
  finalize(): void
}

/**
 * 数据库连接。
 *
 * 泛型形状刻意与 `bun:sqlite` 的 `Database` 对齐（含 `query<Row, P>` 两个类型参数），
 * 这样 `schema.ts` / `ingest.ts` / `query.ts` / `stats.ts` 只需换掉 import 来源，
 * 不必逐个改写调用点 —— 改动越小，SQL 行为越不可能被无意改掉。
 */
export interface Database {
  query<Row = unknown, P = SqlBindings>(sql: string): SqlStatement<Row>
  prepare<Row = unknown, P = SqlBindings>(sql: string): SqlStatement<Row>
  exec(sql: string): void
  /** 在一个事务里执行 `fn`；抛错则回滚。支持嵌套（内层用 savepoint）。 */
  transaction<T>(fn: () => T): T
  close(): void
}

/** 实际生效的驱动，用于诊断输出与测试断言。 */
export type DriverKind = 'bun:sqlite' | 'node:sqlite'

// ── 原始驱动的最小形状（两个后端都能满足）────────────────────────────────

interface RawStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  finalize?(): void
}

interface RawDatabase {
  query?(sql: string): RawStatement
  prepare(sql: string): RawStatement
  exec(sql: string): void
  transaction?<T>(fn: () => T): () => T
  close(): void
}

// ── 运行期判定与加载 ──────────────────────────────────────────────────────

/** 是否跑在 Bun 上。用 `globalThis.Bun` 而不是 `process.versions.bun`，前者更直白。 */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/**
 * 同步加载一个内建模块。
 *
 * ⚠️ 说明符必须**构建期不可静态分析**：一旦写成字面量，`bun build` 会把
 *   `bun:sqlite` 提到产物顶层，Node 用户 import 就炸。
 *   这里把说明符作为**函数参数**传入，打包器无法把它折叠成常量。
 */
function loadBuiltin(specifier: string): unknown {
  const req = createRequire(import.meta.url)
  return req(specifier)
}

/**
 * 静默 `node:sqlite` 的 ExperimentalWarning。
 *
 * 理由：本 CLI 的**终端表格就是产品本身**，每次运行都在 stderr 多打一行
 * `ExperimentalWarning: SQLite is an experimental feature` 会污染输出，
 * 甚至干扰把 stdout 重定向到文件的脚本。
 *
 * ⚠️ 只在加载 `node:sqlite` 的那一瞬间屏蔽，加载完立刻还原 ——
 *   绝不能把全局的 `process.emitWarning` 长期替换掉，那会吞掉别的依赖的告警。
 */
function loadNodeSqlite(): { DatabaseSync: new (path: string) => unknown } {
  const original = process.emitWarning
  process.emitWarning = function filtered(
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const text = typeof warning === 'string' ? warning : warning.message
    if (text.includes('SQLite is an experimental feature')) return
    ;(original as (...args: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    return loadBuiltin('node:sqlite') as { DatabaseSync: new (path: string) => unknown }
  } finally {
    process.emitWarning = original
  }
}

// ── 绑定值归一化 ──────────────────────────────────────────────────────────

/**
 * 把 `undefined` 归一成 `null`，并把数组/对象两种形状分别摊平成驱动认得的调用形式。
 *
 * 🚨 这是**绑定的唯一入口**。绕过它直接调驱动，Node 下会因 `undefined` 抛错。
 */
function normalizeBindings(params: SqlBindings | undefined): {
  /** 位置参数：需要展开成 `run(a, b, c)`。 */
  spread: SqlValue[] | null
  /** 具名参数：整个对象直接传。 */
  named: Record<string, SqlValue> | null
} {
  if (params === undefined) return { spread: null, named: null }
  if (Array.isArray(params)) {
    return { spread: params.map((v) => (v === undefined ? null : v)), named: null }
  }
  const named: Record<string, SqlValue> = {}
  for (const [key, value] of Object.entries(params)) {
    named[key] = value === undefined ? null : value
  }
  return { spread: null, named }
}

/** 把归一化后的绑定值按驱动要求的调用形式投出去。 */
function applyParams(stmt: RawStatement, method: 'run', params: SqlBindings | undefined): unknown
function applyParams(stmt: RawStatement, method: 'get', params: SqlBindings | undefined): unknown
function applyParams(stmt: RawStatement, method: 'all', params: SqlBindings | undefined): unknown[]
function applyParams(
  stmt: RawStatement,
  method: 'run' | 'get' | 'all',
  params: SqlBindings | undefined,
): unknown {
  const { spread, named } = normalizeBindings(params)
  if (spread !== null) return stmt[method](...spread)
  if (named !== null) return stmt[method](named)
  return stmt[method]()
}

/** 包装一条语句；`needsFinalize` 为 false 时 `finalize()` 是空操作（Node 后端）。 */
function wrapStatement<Row>(raw: RawStatement, needsFinalize: boolean): SqlStatement<Row> {
  return {
    run(params) {
      return applyParams(raw, 'run', params) as { changes: number; lastInsertRowid: number | bigint }
    },
    get(params) {
      return applyParams(raw, 'get', params) as Row | null | undefined
    },
    all(params) {
      return applyParams(raw, 'all', params) as Row[]
    },
    finalize() {
      // 🚨 Bun 后端必须真的调用：漏掉会让 `rmSync` 库文件抛 EBUSY。
      //   Node 后端没有这个方法，按空操作处理（句柄由 GC 释放）。
      if (needsFinalize) raw.finalize?.()
    },
  }
}

// ── 对外入口 ──────────────────────────────────────────────────────────────

/** 已加载的驱动缓存：驱动选择在进程生命周期内是固定的，不必反复判定。 */
let cachedKind: DriverKind | null = null

/** 当前生效的驱动名。用于诊断输出与双后端测试。 */
export function activeDriver(): DriverKind {
  if (cachedKind === null) {
    cachedKind = isBun() ? 'bun:sqlite' : 'node:sqlite'
  }
  return cachedKind
}

/**
 * 打开一个 SQLite 连接。
 *
 * 只负责**打开与适配**：建目录、PRAGMA、建表都由 `schema.ts` 的 `openDb()` 负责，
 * 这样「驱动怎么调」与「库怎么配」两件事不会互相纠缠。
 */
export function createSqliteDatabase(dbPath: string): Database {
  const kind = activeDriver()

  if (kind === 'bun:sqlite') {
    const { Database } = loadBuiltin('bun:sqlite') as {
      Database: new (path: string, opts?: { create?: boolean }) => RawDatabase
    }
    return wrapDatabase(new Database(dbPath, { create: true }), true)
  }

  const { DatabaseSync } = loadNodeSqlite()
  return wrapDatabase(new DatabaseSync(dbPath) as RawDatabase, false)
}

/** 包一层，抹平 `query` / `transaction` / `finalize` 三处能力差异。 */
function wrapDatabase(raw: RawDatabase, needsFinalize: boolean): Database {
  let closed = false
  /**
   * 事务嵌套深度。
   *
   * `node:sqlite` 没有 `transaction()`，只能用 SQL 手动表达：
   * 最外层 `BEGIN/COMMIT`，内层 `SAVEPOINT/RELEASE`。
   * 用深度计数而不是简单地一律 BEGIN —— SQLite **不支持嵌套 BEGIN**，
   * 内层直接 BEGIN 会抛 "cannot start a transaction within a transaction"。
   */
  let depth = 0

  return {
    query<Row, P>(sql: string) {
      // bun 的 `query()` 内部缓存语句、由驱动自己管理，因此**不需要** finalize；
      // node 没有这个方法，用 `prepare()` 顶替（实测不 finalize 也能正常删库）。
      const stmt = raw.query ? raw.query(sql) : raw.prepare(sql)
      return wrapStatement<Row>(stmt, needsFinalize)
    },
    prepare<Row, P>(sql: string) {
      return wrapStatement<Row>(raw.prepare(sql), needsFinalize)
    },
    exec(sql: string) {
      raw.exec(sql)
    },
    transaction<T>(fn: () => T): T {
      // Bun 后端直接用原生实现（它是自动的 savepoint 语义，比手写更可靠）。
      // ⚠️ bun 的 `transaction()` 返回的是**函数**，必须再调用一次才真正执行。
      if (needsFinalize && raw.transaction) {
        return raw.transaction(fn)()
      }

      const outer = depth === 0
      const savepoint = `atr_sp_${depth}`
      raw.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      depth++
      try {
        const result = fn()
        depth--
        raw.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (err) {
        depth--
        // 回滚本身失败时**不要**覆盖原始错误 —— 原始错误才是排障线索。
        try {
          raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`)
        } catch {
          /* 回滚失败不改变抛出的错误 */
        }
        throw err
      }
    },
    close() {
      // 幂等：上层多处 finally 里都会 close，重复关闭不应抛错。
      if (closed) return
      closed = true
      raw.close()
    },
  } as Database
}
