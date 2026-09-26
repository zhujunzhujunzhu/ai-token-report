/**
 * MySQL 驱动适配层 —— 部门上报库（`portal`）的第二个后端。
 *
 * ## 为什么部门库可以换成 MySQL，而本地库不行
 *
 * | | 本机库 `usage.sqlite` | 部门上报库 |
 * |---|---|---|
 * | 谁在用 | 员工机器上的 `dsh-token --web` | 集中部署的部门服务端 |
 * | 能不能有外部依赖 | **不能** —— 单机自足、断网可用是这套 CLI 的前提 | 能，它本来就部署在一台服务器上 |
 * | 因此 | 恒为 SQLite（本文件与它无关） | 默认 SQLite，配了 `mysqlUrl` 就切 MySQL |
 *
 * 🚨 **本地库绝不允许切到 MySQL**：那会让「员工装完 CLI 就能用」变成
 *   「员工先要有一台 MySQL」。所以本层只被 `portal-db.ts` 使用，
 *   而 `ingest()` / `readWatermarks()` 这些本地路径的函数签名收的是
 *   **同步 SQLite `Database`**，从类型上就够不到这里。
 *
 * ## 三条实测结论（都是「猜错就静默出错」的那类）
 *
 * 1. 🚨 **`SUM(BIGINT)` 返回的是字符串**，不是数字：
 *    `{"calls":3,"input":"60"}` —— `COUNT(*)` 是数字，`SUM()` 是 `"60"`。
 *    MySQL 的 `SUM()` 结果是 DECIMAL，驱动按精度优先给字符串。
 *    若直接把 `"60"` 当 token 数用，`shared/metrics.ts` 的除法会得到
 *    `NaN` 或字符串拼接 —— **页面上的数字悄悄变成错的**。
 *    ⇒ 归一化放在**唯一的口径边界**（`portal.ts` 的行映射）里做，见那里的 `num()`。
 * 2. ⚠️ **MySQL 8.4 默认 `sql_mode` 含 `ONLY_FULL_GROUP_BY`**：
 *    分组查询的 SELECT 列表里只能出现聚合函数与 GROUP BY 表达式本身。
 *    ⇒ SQL 由 `query.ts` 的构建器产出，两种后端共用同一份文本，天然满足。
 * 3. 🚨 **`key` 是 MySQL 保留字**：`SELECT ... AS key` 直接语法错误
 *    （SQLite 允许）。⇒ 分组别名统一用 `grp_key`，在 TS 侧再映射回 `key`。
 *
 * ## Node 侧（mysql2）与 Bun 侧的五条实测差异
 *
 * 1. ⚠️ **不要传 `allowPublicKeyRetrieval`**：那是 `Bun.sql` 的选项。
 *    mysql2 3.24 不认它，传了会在 stderr 打
 *    `Ignoring invalid configuration option ...`，而它**并不需要** ——
 *    实测不带任何认证选项直连本机 MySQL 8.4.9（`caching_sha2_password`）成功。
 * 2. 🚨 **`exec()` 必须走 `query()`（文本协议）而不是 `execute()`**：
 *    `portal-db.ts` 的 DDL 是**多条语句拼成的一个字符串**，预处理协议一律拒绝
 *    多语句（实测 `ER_PARSE_ERROR`），要开 `multipleStatements: true`。
 *    `execute()` 即便开了这个开关也不接受多语句 —— 风险面因此被限制在
 *    我们自己的 DDL 常量上（`all/get/run` 三条路径仍走预处理协议）。
 * 3. ✅ `affectedRows` 的**去重判据那一半**与 Bun 一致：`INSERT IGNORE` 撞主键是 **0**、
 *    新插入是 **1**（都实测），所以「`changes > 0` 即新插入」这条判据两端通用，上层无需分支。
 *    ⚠️ 但**不是全部一致**：`UPDATE` / ODKU 在「匹配上但值没变」时 Bun 给 **0**、
 *    mysql2 给 **1**（它默认带 `CLIENT_FOUND_ROWS`）。本仓不消费这种语句的 `changes`，
 *    详见 `makeQueries()` 里那张实测表。
 * 4. ✅ 默认字符集就是 **utf8mb4**（实测 `@@character_set_client` = utf8mb4，
 *    4 字节字符往返无损），与 `Bun.sql` 一致 ⇒ **不显式传 charset**
 *    （`verify:mysql:node` 里有一条 4 字节往返断言钉着这个默认值）。
 * 5. ✅ mysql2 的 `Pool` **不发出 `error` 事件**（源码里一次 `emit()` 都没有），
 *    所以不需要挂监听器；掉线的连接由池内部移除并在下次请求时重建。
 *
 * ## Node 端为什么走**可选依赖 `mysql2`**（而不是也内建）
 *
 * Node 没有内建 MySQL 客户端，Node 上唯一的路就是 `mysql2`。它声明在
 * **`packages/server` 的 `dependencies`**（部门服务端是唯一的 Node 部署形态），
 * core 自己不声明它 —— 于是有两件事必须做对：
 *
 * - 🚨 **动态 import 且说明符构建期不可静态分析**（见 `loadMysql2`）：
 *   `packages/cli` 的 npm 产物会把 core 内联进 `cli.js`，写成静态 import 会把
 *   mysql2 连同它的传递依赖一起塞进发布产物，而 `verify:npm` 断言产出**零运行时依赖**。
 * - 解析不到 mysql2 时**报错并给出确切安装命令**，绝不静默降级成 SQLite ——
 *   降级会让人以为「连上了」，实际上数据写进了另一条通路。
 *
 * ⚠️ **它必须在「能解析到 mysql2 的位置」被加载**：裸说明符是按**导入它的那个
 *   文件**所在目录逐级向上找的。本仓 `bun install` 用的是隔离式布局
 *   （每个包各有一份 `node_modules`，`mysql2` 只在 `packages/server/node_modules`），
 *   所以 Node 侧要跑部门服务端（`packages/server`）自己的入口/产物；
 *   从 `packages/core` 的源码位置直接跑 Node 是找不到它的。
 *   Bun 侧不受影响（走内建 `Bun.sql`，根本不碰 mysql2）。
 */

import type { SqlBindings, SqlValue } from './driver.js'

/** 已解析好的一条 SQL：文本 + **位置参数**（MySQL 侧一律用 `?`）。 */
export interface PositionalQuery {
  text: string
  values: SqlValue[]
}

/**
 * 把 SQLite 习惯的 `$name` 具名参数翻译成 MySQL 的 `?` 位置参数。
 *
 * ★ 这是「一份 SQL、两种方言」的关键：`query.ts` 的构建器只产出 `$name`，
 *   两种后端各自翻译 —— SQL 文本因此**只有一处**，
 *   不存在「MySQL 版的查询和 SQLite 版的查询慢慢漂移」这种可能。
 *
 * ⚠️ 同一个 `$name` 可以出现多次（`CASE WHEN $didScan THEN ... ELSE ... END`
 *   与 `LIMIT $limit OFFSET $offset` 都是），每次出现都要各补一个值。
 */
export function toPositional(sql: string, params?: SqlBindings): PositionalQuery {
  if (params === undefined) return { text: sql, values: [] }

  // 位置参数原样透传（调用方自己数好顺序）
  if (Array.isArray(params)) {
    return { text: sql, values: params.map((v) => (v === undefined ? null : v)) }
  }

  const values: SqlValue[] = []
  const text = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    // ⚠️ 查表必须用**带 `$` 的原始键**：本仓约定（`query.ts` 的 `buildWhere`）
    //   产出的参数对象键就是 `'$since'` / `'$eventId'` 这种带前缀的形状。
    //   曾经写成用剥掉 `$` 的 `name` 去查 —— 那会让**每一句真实 SQL 都抛
    //   「参数缺失」**（正则剥了前缀，查表却没补回来）。由活体脚本抓到。
    const key = `$${name}`
    if (!(key in params)) {
      // 🚨 缺参数绝不放行：静默绑成 NULL 会让「筛选条件没生效」看起来像「数据本来就没有」
      throw new Error(`MySQL 绑定参数缺失：${key}`)
    }
    const value = params[key]
    values.push(value === undefined ? null : value)
    return '?'
  })

  return { text, values }
}

/** 写操作的结果。字段名与 SQLite 后端的 `changes` 对齐，上层无需分支。 */
export interface MysqlRunResult {
  /** 受影响行数。`INSERT IGNORE` 撞主键时是 **0** —— 这就是去重判据。 */
  changes: number
}

/** 实际生效的 MySQL 驱动，用于诊断输出与测试断言。 */
export type MysqlDriver = 'bun:sql' | 'mysql2'

/** 一个 MySQL 后端（内部是连接池，可长期复用）。 */
export interface MysqlBackend {
  readonly driver: MysqlDriver
  all<Row>(sql: string, params?: SqlBindings): Promise<Row[]>
  get<Row>(sql: string, params?: SqlBindings): Promise<Row | null>
  run(sql: string, params?: SqlBindings): Promise<MysqlRunResult>
  exec(sql: string): Promise<void>
  /** 事务体收一个「同一个连接」的后端，保证事务内语句不跑偏到池里别的连接。 */
  transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T>
  /** 保留一条连接，供跨 DDL 的迁移锁使用；回调结束才归还连接。 */
  withConnection<T>(fn: (connection: MysqlBackend) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** 是否跑在 Bun 上。 */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/** Bun 的 `Bun.SQL` 形状（只声明本层用到的那部分）。 */
interface BunSql {
  unsafe<Row = unknown>(query: string, values?: readonly SqlValue[]): Promise<Row[]>
  begin<T>(fn: (tx: BunSql) => Promise<T>): Promise<T>
  reserve(): Promise<BunSql & { release(): void }>
  close(options?: { timeout?: number }): Promise<void>
}

// ─────────────────────────────────────────────────────────────
// mysql2 的最小形状（Node 侧）
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ 这些接口是**手写的**，不是从 mysql2 里 import 的类型。
 *
 * 理由有两条，都不是洁癖：
 * 1. core **不声明** mysql2 依赖（它声明在 `packages/server`），静态 import
 *    `mysql2/promise` 的类型会让 `packages/core` 的 `tsc` 找不到模块而红；
 * 2. 静态 import 类型同样会让 `bun build` 知道这个包的存在 —— 与「产物里
 *    绝不出现 mysql2」这条硬约束背道而驰。
 */
interface Mysql2Module {
  createPool(config: Record<string, unknown>): Mysql2Pool
}

/** 能执行 SQL 的东西：连接池与池里借出的单条连接都满足。 */
interface Mysql2Queryable {
  /** 预处理协议（一句一条）。 */
  execute(sql: string, values?: readonly SqlValue[]): Promise<[unknown, unknown]>
  /** 文本协议（可以多条语句）。 */
  query(sql: string, values?: readonly SqlValue[]): Promise<[unknown, unknown]>
}

/** 连接池。 */
interface Mysql2Pool extends Mysql2Queryable {
  getConnection(): Promise<Mysql2Connection>
  /** 关掉整个池。只在进程退出时由 `closeAllMysqlBackends()` 调用。 */
  end(): Promise<void>
}

/** 池里借出的一条连接。 */
interface Mysql2Connection extends Mysql2Queryable {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  /** 把连接还回池（**不是**关闭）。 */
  release(): void
}

/** 认得出「模块没解析到」这一类错误（Node 与 Bun 的 code/文案都覆盖）。 */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const message = err instanceof Error ? err.message : String(err)
  return /Cannot find (package|module) 'mysql2/.test(message)
}

/**
 * 运行期加载**可选**的 mysql2（只有 Node 会走到这里）。
 *
 * 🚨 说明符必须**构建期不可静态分析** —— 下面用变量拼，**不要改回字面量**：
 *   `packages/cli` 的 npm 产物把 core 整个内联进 `cli.js`，写成字面量会让
 *   打包器把 mysql2 连同 7 个传递依赖塞进发布产物，而 `verify:npm` 断言
 *   「发布产物零运行时依赖」。这与 `driver.ts` 的 `loadBuiltin()` 是同一条理由
 *   （那里防的是 `bun:sqlite`）。
 */
async function loadMysql2(): Promise<Mysql2Module> {
  const specifier = 'mysql2/promise'
  let mod: unknown
  try {
    mod = await import(specifier)
  } catch (err) {
    if (!isModuleNotFound(err)) throw err
    // ★ 报错要把「怎么装」写清楚：只写「缺少依赖」会让人去翻 package.json，
    //   而这里给出的是可以从上往下照抄的一条命令。
    throw new Error(
      'Node 端连 MySQL 上报库需要可选的 mysql2 依赖，但当前进程解析不到它。\n' +
        '  本仓安装：cd packages/server && bun add mysql2\n' +
        '  已发布产物：在服务端所在目录执行 npm i mysql2（或 bun add mysql2）\n' +
        '  ⚠️ mysql2 声明在 packages/server —— 要在能解析到它的位置运行服务端；\n' +
        '     也可以改用 SQLite 退路（--db <路径>，不设 ATR_MYSQL_URL）。\n' +
        '  （Bun 上不需要 mysql2：走内建 Bun.sql。）\n' +
        `  原始错误：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // ⚠️ CJS 包经 ESM 动态 import 后，命名导出可能挂在 `default` 上，两处都取
  const module = (mod as { default?: Mysql2Module } | null)?.default ?? (mod as Mysql2Module | null)
  if (typeof module?.createPool !== 'function') {
    // 解析到了但形状不对（例如被替换成了同名占位包）：明确报错，别等 undefined 调用
    throw new Error('mysql2/promise 里找不到 createPool()，无法建立 MySQL 连接池')
  }
  return module
}

// ─────────────────────────────────────────────────────────────
// 执行通道：两个驱动的差异只在这里
// ─────────────────────────────────────────────────────────────

/**
 * 一条「能执行 SQL 的通道」。
 *
 * ★ 存在的理由：`Bun.sql` 的 `unsafe()` 直接返回结果，而 mysql2 的
 *   `execute()` / `query()` 返回 `[rows, fields]`。把这处差异收在一个适配器里，
 *   `all / get / run / exec` 就**只有一份实现** —— 于是 `$name`→`?` 的翻译与
 *   `affectedRows` → `changes` 的归并在两种后端上必然一致，不会各自演化。
 */
interface MysqlChannel {
  /** 带参数执行一句。`rows` 是 SELECT 的行数组，`header` 是写操作的结果头。 */
  exec(sql: string, values: readonly SqlValue[]): Promise<{ rows: unknown; header: unknown }>
  /** 执行不带参数的原始 SQL（**可能含多条语句** —— DDL 就是）。 */
  raw(sql: string): Promise<void>
}

/** 查询四件套（两种后端共用）。 */
function makeQueries(
  channel: MysqlChannel,
): Pick<MysqlBackend, 'all' | 'get' | 'run' | 'exec'> {
  return {
    async all<Row>(query: string, params?: SqlBindings): Promise<Row[]> {
      const { text, values } = toPositional(query, params)
      const { rows } = await channel.exec(text, values)
      return rows as Row[]
    },
    async get<Row>(query: string, params?: SqlBindings): Promise<Row | null> {
      const { text, values } = toPositional(query, params)
      const { rows } = await channel.exec(text, values)
      return (rows as Row[])[0] ?? null
    },
    async run(query: string, params?: SqlBindings): Promise<MysqlRunResult> {
      const { text, values } = toPositional(query, params)
      const { header } = await channel.exec(text, values)
      // ⚠️ 两个驱动都给 `affectedRows`，但语义**只有一半**一致（都在本机实测过，
      //   复现脚本见 `packages/server/verify/verify-mysql-node.ts`）：
      //
      //   | 语句 | Bun.sql | mysql2 |
      //   |---|---|---|
      //   | `INSERT IGNORE`：撞主键 / 新插入 | 0 / 1 | 0 / 1 | ← ★ 本仓**消费**这一行
      //   | `INSERT`                         | 1     | 1     |
      //   | ODKU：真的改了值                  | 2     | 2     |
      //   | ODKU：**匹配上但值没变**          | **0** | **1** |
      //   | `UPDATE`：匹配上但值没变          | **0** | **1** |
      //
      //   差在最后两行：mysql2 默认带 `CLIENT_FOUND_ROWS`（`connection_config.js`
      //   的 `getDefaultFlags` 里就有它），于是「匹配行数」顶替了「改动行数」。
      //   🚨 本仓**只**在 `INSERT IGNORE` 的 0/1 上判去重（`ingest.ts`），UPSERT 的
      //   返回值从不被消费，所以这个差异目前是**潜在**的而非现实的 —— 但将来谁要拿
      //   `changes` 判「有没有真的写进去」，必须先在两个驱动上分别实测。
      //
      //   `?? 0` 是兜底：拿不到结果头时按「没写进去」处理，绝不按「写成功」。
      return { changes: Number((header as { affectedRows?: number } | null)?.affectedRows ?? 0) }
    },
    async exec(query: string): Promise<void> {
      await channel.raw(query)
    },
  }
}

/** Bun 侧通道：`unsafe()` 的返回值**同时也是**结果头（`affectedRows` 就在上面）。 */
interface BunAuthenticationContext { longPassword: boolean; version: string }

/** 只在服务端实际拒绝认证后补充已实测的上游兼容信息，不改变凭证或驱动选择。 */
function explainBunAuthenticationError(error: unknown, context?: BunAuthenticationContext): unknown {
  const detail = error as { name?: string; errno?: number; code?: string; sqlState?: string } | null
  if (detail?.name === 'BunMysqlAuthenticationCompatibilityError') return error
  if (!context?.longPassword || detail?.errno !== 1045) return error
  const explained = new Error(
    `MySQL 认证失败（1045），当前为 Bun ${context.version} 原生 MySQL 驱动。` +
    '本机已验证 Bun 1.4.2 的 caching_sha2_password 在密码超过 19 个字符时可能认证失败（oven-sh/bun#26195），即使相同凭证在其他客户端有效。' +
    '建议使用真正的 Node + mysql2 复核并运行服务；保留强密码及原认证插件，不要为绕过此问题缩短密码。',
    { cause: error },
  )
  // 保留调用方已有的错误分类；不把连接串或密码放进诊断文案。
  return Object.assign(explained, { name: 'BunMysqlAuthenticationCompatibilityError', errno: detail.errno, code: detail.code, sqlState: detail.sqlState })
}

function bunChannel(client: BunSql, authentication?: BunAuthenticationContext): MysqlChannel {
  return {
    async exec(sql, values) {
      try {
        const result = await client.unsafe(sql, values)
        return { rows: result, header: result }
      } catch (error) { throw explainBunAuthenticationError(error, authentication) }
    },
    async raw(sql) {
      try { await client.unsafe(sql) }
      catch (error) { throw explainBunAuthenticationError(error, authentication) }
    },
  }
}

/** 把 Bun 的客户端或一条事务连接包成后端。 */
function wrapBun(client: BunSql, dedicated = false, inTransaction = false, authentication?: BunAuthenticationContext): MysqlBackend {
  const backend: MysqlBackend = {
    driver: 'bun:sql',
    ...makeQueries(bunChannel(client, authentication)),
    async transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(backend)
      try { return await client.begin(async (tx) => fn(wrapBun(tx, true, true, authentication))) }
      catch (error) { throw explainBunAuthenticationError(error, authentication) }
    },
    async withConnection<T>(fn: (connection: MysqlBackend) => Promise<T>): Promise<T> {
      if (dedicated) return fn(backend)
      try {
        const reserved = await client.reserve()
        try { return await fn(wrapBun(reserved, true, false, authentication)) }
        finally { reserved.release() }
      } catch (error) { throw explainBunAuthenticationError(error, authentication) }
    },
    async close(): Promise<void> {
      if (!dedicated) await client.close({ timeout: 1 })
    },
  }
  return backend
}

/** mysql2 侧通道。 */
function mysql2Channel(client: Mysql2Queryable): MysqlChannel {
  return {
    async exec(sql, values) {
      const [rows] = await client.execute(sql, values)
      return { rows, header: rows }
    },
    async raw(sql) {
      // 🚨 走 `query()`（文本协议）而不是 `execute()`：DDL 是多条语句拼成的一个
      //   字符串，预处理协议一律拒绝（实测 ER_PARSE_ERROR），见文件头差异 2。
      await client.query(sql)
    },
  }
}

/** mysql2 后端的收尾动作（池版与事务连接版不同，所以从外面传进来）。 */
interface Mysql2Hooks {
  transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T>
  withConnection<T>(fn: (connection: MysqlBackend) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function wrapMysql2(client: Mysql2Queryable, hooks: Mysql2Hooks): MysqlBackend {
  return {
    driver: 'mysql2',
    ...makeQueries(mysql2Channel(client)),
    transaction: (fn) => hooks.transaction(fn),
    withConnection: (fn) => hooks.withConnection(fn),
    close: () => hooks.close(),
  }
}

/**
 * 连接池版 mysql2 后端。
 *
 * ★ 事务用 `getConnection()` 借出**一条**连接，`beginTransaction` / `commit` /
 *   `rollback` 全在它上面做，回调里收到的门面也绑在同一条连接上 ——
 *   否则事务内的语句会跑到池里别的连接，回滚只回滚了一部分。
 */
function mysql2PoolBackend(pool: Mysql2Pool): MysqlBackend {
  return wrapMysql2(pool, {
    async withConnection<T>(fn: (connection: MysqlBackend) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection()
      try { return await fn(mysql2ReservedBackend(conn)) }
      finally { conn.release() }
    },
    async transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection()
      // ⚠️ 先声明后赋值：事务内的嵌套调用必须拿到**同一个** tx 后端
      let tx: MysqlBackend
      try {
        await conn.beginTransaction()
        tx = wrapMysql2(conn, {
          // 🚨 嵌套事务**不重发 `BEGIN`**：MySQL 的 `START TRANSACTION` 会**隐式提交**
          //   前一个事务 —— 那等于把外层已写的行提前落盘，之后再回滚也救不回来。
          //   这里选择「并入当前事务」（本仓没有任何嵌套用法；语义与 Bun 侧
          //   「不炸」对齐，且绝不静默丢数据）。
          transaction: (inner) => inner(tx),
          withConnection: (inner) => inner(tx),
          // 连接由外层 `finally` 统一 release，这里绝不能释放（会二次归还）
          close: async () => {},
        })
        const result = await fn(tx)
        await conn.commit()
        return result
      } catch (err) {
        try {
          await conn.rollback()
        } catch {
          /* 回滚失败不覆盖原始错误 */
        }
        throw err
      } finally {
        conn.release()
      }
    },
    async close(): Promise<void> {
      await pool.end()
    },
  })
}

/** 固定连接上的事务不能回到池里借另一条，否则迁移锁和写入不在同一连接。 */
function mysql2ReservedBackend(conn: Mysql2Connection): MysqlBackend {
  let reserved: MysqlBackend
  reserved = wrapMysql2(conn, {
    withConnection: (fn) => fn(reserved),
    async transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T> {
      await conn.beginTransaction()
      let tx: MysqlBackend
      tx = wrapMysql2(conn, {
        transaction: (inner) => inner(tx),
        withConnection: (inner) => inner(tx),
        close: async () => {},
      })
      try { const result = await fn(tx); await conn.commit(); return result }
      catch (error) { try { await conn.rollback() } catch {} throw error }
    },
    close: async () => {},
  })
  return reserved
}

/**
 * 打开一个 MySQL 后端。
 *
 * ★ **连接池在进程内共享**（见 `sharedMysqlBackend`）：部门服务端的
 *   上报与看板是「每个请求开一次库」的写法，SQLite 下这很便宜（就是个文件句柄），
 *   MySQL 下却是 TCP + 认证握手 —— 每请求新建会把性能打没。
 *
 * ★ 运行时二选一：Bun → 内建 `Bun.sql`；Node → 可选依赖 `mysql2`。
 *   两条路的**对外形状完全一致**（`driver` 是唯一能看出区别的地方）。
 */
export async function openMysqlBackend(url: string): Promise<MysqlBackend> {
  if (isBun()) {
    const { SQL } = globalThis.Bun as unknown as {
      SQL: new (url: string, options?: Record<string, unknown>) => BunSql
    }

    const sql = new SQL(url, {
      // 🚨 必须显式允许取服务端公钥：MySQL 8.4 默认认证插件是
      //   `caching_sha2_password`，非 TLS 连接下驱动需要向服务端要公钥，
      //   否则报 "The server requested RSA public key retrieval ... which is
      //   not allowed over an insecure connection"。实测（probe）不带这个选项连不上。
      //   ⚠️ 这是 **Bun.sql 专有**的选项：mysql2 不认它（见文件头差异 1）。
      allowPublicKeyRetrieval: true,
      max: 10,
    })

    let longPassword = false
    try { longPassword = decodeURIComponent(new URL(url).password).length > 19 }
    catch { /* URL 格式错误由驱动保留原错误处理。 */ }
    return wrapBun(sql, false, false, { longPassword, version: globalThis.Bun.version })
  }

  const mysql = await loadMysql2()
  return mysql2PoolBackend(
    mysql.createPool({
      // ★ 直接给连接串：mysql2 自己解析 username / password / host / port / database
      //   （实测 `{ uri }` 形式可用，且 `DATABASE()` 确实是串里那个库）
      uri: url,
      // 🚨 必须开多语句：`exec()` 拿到的是一整段含多条语句的 DDL（见文件头差异 2）
      multipleStatements: true,
      // 与 Bun 侧的 `max: 10` 对齐
      connectionLimit: 10,
      // ⚠️ 池满时**排队**而不是立刻抛错：上报与看板的并发不该被瞬时峰值打成 500
      waitForConnections: true,
      // ⚠️ 刻意**不传** allowPublicKeyRetrieval / charset：前者 mysql2 不认，
      //   后者默认已是 utf8mb4（都有实测，见文件头差异 1 与 4）。
    }),
  )
}

/**
 * 进程内共享的连接池缓存。
 *
 * ⚠️ 键是 URL 本身：`ATR_MYSQL_URL` 在进程生命周期内不会变，
 *   所以每个 URL 只需要一个池。**不要**在这里做「用完就关」的语义 ——
 *   `PortalStore.close()` 对 MySQL 是空操作，理由见 `portal-db.ts`。
 */
const pools = new Map<string, Promise<MysqlBackend>>()

/** 取（必要时创建）某个 URL 的共享后端。 */
export function sharedMysqlBackend(url: string): Promise<MysqlBackend> {
  let cached = pools.get(url)
  if (!cached) {
    cached = openMysqlBackend(url)
    pools.set(url, cached)
  }
  return cached
}

/**
 * 关闭全部共享后端（进程退出时用）。
 *
 * ⚠️ 只在真正要退出时调用：服务运行期间关掉池会让下一个请求重建连接。
 */
export async function closeAllMysqlBackends(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all(all.map(async (p) => (await p).close()))
}
