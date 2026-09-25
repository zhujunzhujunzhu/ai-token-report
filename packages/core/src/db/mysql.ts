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
 * ## 为什么 Node 端暂不支持
 *
 * Node 没有内建 MySQL 客户端，要靠 `mysql2`（7 个传递依赖）。
 * 而部门服务端的部署形态本来就是 **Bun**（见 `docs/server架构重构方案.md`），
 * npm 发布出去的那份 CLI 只跑本机库（SQLite），**永远用不到 MySQL**。
 * 为一条用不到的通路引依赖并把它塞进发布产物，是净负担。
 * 所以这里在 Node 上**明确报错并给出路**（而不是静默降级成 SQLite 让人以为连上了）。
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

/** 一个 MySQL 后端（内部是连接池，可长期复用）。 */
export interface MysqlBackend {
  readonly driver: 'bun:sql'
  all<Row>(sql: string, params?: SqlBindings): Promise<Row[]>
  get<Row>(sql: string, params?: SqlBindings): Promise<Row | null>
  run(sql: string, params?: SqlBindings): Promise<MysqlRunResult>
  exec(sql: string): Promise<void>
  /** 事务体收一个「同一个连接」的后端，保证事务内语句不跑偏到池里别的连接。 */
  transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T>
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
  close(options?: { timeout?: number }): Promise<void>
}

/**
 * 打开一个 MySQL 后端。
 *
 * ★ **连接池在进程内共享**（见 `sharedMysqlBackend`）：部门服务端的
 *   上报与看板是「每个请求开一次库」的写法，SQLite 下这很便宜（就是个文件句柄），
 *   MySQL 下却是 TCP + 认证握手 —— 每请求新建会把性能打没。
 */
export async function openMysqlBackend(url: string): Promise<MysqlBackend> {
  if (!isBun()) {
    throw new Error(
      'Node 端暂不支持 MySQL 上报库：Node 没有内建 MySQL 客户端。' +
        '请用 Bun 运行部门服务端（bun run --filter \'@ai-token-report/server\' start），' +
        '或改用 SQLite 退路（--db <路径>，不设 ATR_MYSQL_URL）。',
    )
  }

  const { SQL } = globalThis.Bun as unknown as {
    SQL: new (url: string, options?: Record<string, unknown>) => BunSql
  }

  const sql = new SQL(url, {
    // 🚨 必须显式允许取服务端公钥：MySQL 8.4 默认认证插件是
    //   `caching_sha2_password`，非 TLS 连接下驱动需要向服务端要公钥，
    //   否则报 "The server requested RSA public key retrieval ... which is
    //   not allowed over an insecure connection"。实测（probe）不带这个选项连不上。
    allowPublicKeyRetrieval: true,
    max: 10,
  })

  const wrap = (client: BunSql): MysqlBackend => ({
    driver: 'bun:sql',
    async all<Row>(query: string, params?: SqlBindings): Promise<Row[]> {
      const { text, values } = toPositional(query, params)
      return (await client.unsafe<Row>(text, values)) as Row[]
    },
    async get<Row>(query: string, params?: SqlBindings): Promise<Row | null> {
      const { text, values } = toPositional(query, params)
      const rows = (await client.unsafe<Row>(text, values)) as Row[]
      return rows[0] ?? null
    },
    async run(query: string, params?: SqlBindings): Promise<MysqlRunResult> {
      const { text, values } = toPositional(query, params)
      const result = (await client.unsafe(text, values)) as unknown as {
        affectedRows?: number
      }
      return { changes: Number(result?.affectedRows ?? 0) }
    },
    async exec(query: string): Promise<void> {
      await client.unsafe(query)
    },
    async transaction<T>(fn: (tx: MysqlBackend) => Promise<T>): Promise<T> {
      return client.begin(async (tx) => fn(wrap(tx)))
    },
    async close(): Promise<void> {
      await client.close({ timeout: 1 })
    },
  })

  return wrap(sql)
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