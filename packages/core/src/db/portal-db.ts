/**
 * 上报库门面 —— **部门服务端唯一的取数/落库入口**，同时支持 SQLite 与 MySQL。
 *
 * ## 为什么需要这一层（而不是让上层自己判断用哪个库）
 *
 * 两个后端的**能力差异**只有三处（DDL、幂等插入语法、`MAX`/`GREATEST`），
 * 而 SQL 文本与口径完全共用（由 `query.ts` 的构建器产出）。
 * 把差异收在这一个文件里，上层（`ingest-route` / `stats-route` / `portal.ts`）
 * 就完全看不到「今天连的是哪种库」—— 否则每个查询点都会长出 `if (mysql)`，
 * 而这类分支必然漂移且不会报错。
 *
 * ## ★ 与本地库的边界（类型上就隔开了）
 *
 * | 入口 | 收什么 | 谁在用 |
 * |---|---|---|
 * | `openPortalSqlite()` / `openPortalStore()` | 上报库 | 部门服务端、看板 |
 * | `openDatabaseForIngest()`（`ingest.ts`） | **同步 SQLite `Database`** | 本机 CLI / 本地页 |
 *
 * 🚨 `ingest()` / `readWatermarks()` 这些本地路径的函数签名收的是同步
 *   `Database`，**够不到 MySQL** —— 「员工机器上跑 CLI 要有 MySQL」这件事
 *   因此不是靠自觉，而是**类型上不可能**。
 *
 * ## 🚨 MySQL 的 `close()` 是空操作，SQLite 的不是
 *
 * 上层是「每个请求开一次库、finally 里关掉」的写法（SQLite 下很便宜）。
 * MySQL 下连接来自**进程内共享的连接池**（`mysql.ts` 的 `sharedMysqlBackend`），
 * 若每次请求都真的关池，下一个请求就要重新 TCP + 认证握手 —— 性能会被打没。
 * 所以 MySQL 后端的 `close()` **只是把连接还回池**（即什么都不做），
 * 真正的关闭在进程退出时由 `closeAllMysqlBackends()` 负责。
 *
 * ## 🚨 上报库的 schema 绝不自愈
 *
 * 与本地库（日志的派生物，坏了重建）相反：上报库是全员数据的**唯一副本**
 * （客户端投递成功后已清掉自己的 pending），版本不符时**抛错**。
 * 两种后端都遵守这一条，错误文案里带动作指引。
 */

import type { Database } from './driver.js'
import { type PortalBackendKind } from './dialect.js'
import { sharedMysqlBackend, type MysqlBackend } from './mysql.js'
import { DB_SCHEMA_VERSION, EVENT_TABLE, ensureSchema, needsRebuild, openDb } from './schema.js'

/**
 * 上报库的目标（**配置的唯一形状**）。
 *
 * ★ `mysqlUrl` 存在时优先于 SQLite 路径 —— 一个部署里只该有一种真值，
 *   两个都配是配置错误，`resolvePortalTarget()` 会明确拒绝而不是猜。
 */
export interface PortalTarget {
  sqlitePath: string
  mysqlUrl?: string
}

/** 从服务端选项里解析出目标；两个都配时直接抛错（不猜）。 */
export function resolvePortalTarget(input: {
  sqlitePath: string
  mysqlUrl?: string | undefined
}): PortalTarget {
  return {
    sqlitePath: input.sqlitePath,
    ...(input.mysqlUrl ? { mysqlUrl: input.mysqlUrl } : {}),
  }
}

/**
 * 上报库的异步门面。
 *
 * ★ 之所以是异步的：MySQL 驱动（`Bun.sql`）只有异步 API，而 SQLite 驱动是同步的。
 *   统一成异步之后上层只有一套写法；SQLite 那侧只是把同步调用包成已解决的 Promise，
 *   代价可以忽略（本地库路径根本不走这里）。
 */
export interface PortalStore {
  readonly kind: PortalBackendKind
  /** 诊断/启动横幅用的描述。🚨 **必须已脱敏**（绝不能带密码）。 */
  readonly label: string
  all<Row = unknown>(sql: string, params?: Record<string, unknown>): Promise<Row[]>
  get<Row = unknown>(sql: string, params?: Record<string, unknown>): Promise<Row | null>
  run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }>
  exec(sql: string): Promise<void>
  /** 事务。回调收到的是**同一个连接**上的门面。 */
  transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T>
  /** SQLite：真的关闭；MySQL：**空操作**（还回共享池），理由见文件头。 */
  close(): Promise<void>
}

// ─────────────────────────────────────────────────────────────
// 方言：见 `dialect.ts`（四处语法差异，其中两处会「静默语义变化」）
// ─────────────────────────────────────────────────────────────

// ★ 方言定义放在独立模块而不是这里：`query.ts`（本地 + 部门两条路径共用）
//   也需要它来构造 `provider-model` 的拼接表达式，若定义在本文件会形成
//   `query.ts → portal-db.ts → mysql.ts` 的假依赖，层次会乱。
export {
  MYSQL_DIALECT,
  SQLITE_DIALECT,
  portalDialect,
  type PortalBackendKind,
  type PortalDialect,
} from './dialect.js'

// ─────────────────────────────────────────────────────────────
// MySQL 侧的表结构
// ─────────────────────────────────────────────────────────────

/**
 * MySQL 侧只建 **portal 真正用到的两张表**。
 *
 * ⚠️ 与 SQLite 侧的四张表不同（那边还建 `file_watermark` / `session_state`）：
 *   那两张是**本机增量扫描**的水位线，部门服务端从不扫描日志，
 *   建了永远是空表。少两张表 = 少两处「看起来有数据通路其实没有」的误判。
 *
 * ⚠️ 类型选择的理由：
 *   - `ts` / `seq` / 四个 token 用 `BIGINT` —— epoch 毫秒必须精确，
 *     **绝不用 `DATETIME`**（那会把时区语义引进来，本仓在时间分桶上已经吃过
 *     一次「SQLite 按 OS 时区、JS 按进程 TZ」的亏）。
 *   - `event_id` / `session_id` / `provider` / `model` / `user_id` 用
 *     `VARCHAR(255)`：它们都建索引，utf8mb4 下 255*4 = 1020 字节，
 *     远小于 InnoDB 的 3072 字节索引上限。
 *   - `cwd` 用 `TEXT`：路径可能很长且不参与索引与分组。
 */
const MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS portal_meta (
  id             TINYINT NOT NULL PRIMARY KEY,
  schema_version INT     NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
  event_id            VARCHAR(255) NOT NULL,
  session_id          VARCHAR(255) NOT NULL,
  seq                 BIGINT       NOT NULL,
  ts                  BIGINT       NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  model               VARCHAR(255) NOT NULL,
  cwd                 TEXT         NULL,
  user_id             VARCHAR(255) NULL,
  user_name           VARCHAR(255) NULL,
  dept                VARCHAR(255) NULL,
  input_tokens        BIGINT       NOT NULL DEFAULT 0,
  output_tokens       BIGINT       NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT       NOT NULL DEFAULT 0,
  cache_write_tokens  BIGINT       NOT NULL DEFAULT 0,
  reasoning_tokens    BIGINT       NOT NULL DEFAULT 0,
  turn                INT          NULL,
  step                INT          NULL,
  PRIMARY KEY (event_id),
  KEY idx_usage_ts (ts),
  KEY idx_usage_provider (provider),
  KEY idx_usage_model (model),
  KEY idx_usage_session (session_id),
  KEY idx_usage_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ingest_run (
  id                      TINYINT NOT NULL PRIMARY KEY,
  last_ingest_ms          BIGINT  NOT NULL,
  last_scan_events        BIGINT  NOT NULL,
  total_events_ingested   BIGINT  NOT NULL,
  mismatch_count          BIGINT  NOT NULL,
  files_failed            BIGINT  NOT NULL,
  frames_failed           BIGINT  NOT NULL,
  frames_ok               BIGINT  NOT NULL DEFAULT 0,
  usage_events            BIGINT  NOT NULL DEFAULT 0,
  assistant_without_usage BIGINT  NOT NULL DEFAULT 0,
  retry_started           BIGINT  NOT NULL DEFAULT 0,
  retry                   BIGINT  NOT NULL DEFAULT 0,
  attempts                BIGINT  NOT NULL DEFAULT 0,
  missing_provider        BIGINT  NOT NULL DEFAULT 0,
  files_scanned           BIGINT  NOT NULL DEFAULT 0,
  event_types_json        TEXT    NOT NULL,
  providers_json          TEXT    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

/** 把 URL 里的密码抹掉，用于日志与启动横幅。 */
export function redactMysqlUrl(url: string): string {
  return url.replace(/\/\/([^:/?#]+):([^@]*)@/, '//$1:***@')
}

/** 从 URL 里取出「库名 @ 主机:端口」，横幅用。 */
function describeMysqlUrl(url: string): string {
  try {
    const u = new URL(url)
    const db = u.pathname.replace(/^\//, '') || '(未指定库)'
    return `MySQL ${db} @ ${u.hostname}:${u.port || '3306'}`
  } catch {
    return `MySQL ${redactMysqlUrl(url)}`
  }
}

// ─────────────────────────────────────────────────────────────
// SQLite 后端
// ─────────────────────────────────────────────────────────────

/**
 * 打开 SQLite 上报库：schema 版本不符时**抛错，绝不重建**。
 *
 * ## 为什么与 `openDatabaseForIngest` 不同
 *
 * 两者的差别不是风格，是**数据能不能再生**：
 *
 * | | 本机库（`usage.sqlite`） | 上报库（`portal.sqlite`） |
 * |---|---|---|
 * | 真值在哪 | 磁盘上的会话日志 | **只有这个库** |
 * | 重扫能恢复吗 | 能（全量 ingest） | **不能** |
 * | 版本不符时 | 重建，代价是重扫一次 | **必须停下来报错** |
 *
 * 上报库里的行来自各个客户端，而客户端投递成功后就清掉了自己的
 * `pending` / outbox —— 服务端是唯一副本。若沿用本地库那套「版本不符就重建」，
 * 一次 schema 升级会把全部门的历史用量静默清空，且无从恢复。
 *
 * ⚠️ 错误信息会被原样带进上报响应体（HTTP 500 的 `reason`），
 *   所以它写得能直接指着动作 —— 管理员看到的就是这条。
 */
export function openPortalSqlite(sqlitePath: string): Database {
  const db = openDb(sqlitePath)
  try {
    if (needsRebuild(db)) {
      throw new Error(
        `上报库 schema 版本不符合（本程序需要 ${DB_SCHEMA_VERSION}）。` +
          `服务端的上报数据是本平台唯一副本，不会自动重建 —— ` +
          `请先备份 ${sqlitePath}，再手工删掉它重新开始接收上报。`,
      )
    }
    ensureSchema(db)
    return db
  } catch (err) {
    // 关闭连接但不掩盖真实错误（catch 里再抛错会把原始原因吃掉）
    try {
      db.close()
    } catch {
      /* 关闭失败不影响抛出原因 */
    }
    throw err
  }
}

/** SQLite 后端的门面：把同步驱动包成异步形状。 */
class SqlitePortalStore implements PortalStore {
  readonly kind = 'sqlite' as const
  readonly label: string
  readonly #db: Database
  #closed = false

  constructor(db: Database, label: string) {
    this.#db = db
    this.label = label
  }

  async all<Row>(sql: string, params?: Record<string, unknown>): Promise<Row[]> {
    // 用 `query()`（驱动内部缓存语句）而不是 `prepare()`：
    // bun:sqlite 下未 finalize 的 prepare 会让 `close()` 不释放句柄（见 driver.ts）。
    return this.#db.query<Row>(sql).all(params as never) as Row[]
  }

  async get<Row>(sql: string, params?: Record<string, unknown>): Promise<Row | null> {
    return (this.#db.query<Row>(sql).get(params as never) as Row | undefined) ?? null
  }

  async run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }> {
    const res = this.#db.query(sql).run(params as never)
    return { changes: Number(res.changes ?? 0) }
  }

  async exec(sql: string): Promise<void> {
    this.#db.exec(sql)
  }

  /**
   * 事务：手动 `BEGIN` / `COMMIT` / `ROLLBACK`。
   *
   * ⚠️ 不能用驱动自带的 `db.transaction(fn)`：它要求回调**同步**执行完，
   *   而本门面的回调是异步的（MySQL 侧必须异步）—— 混用会让事务在
   *   `await` 之前就提交，写进去的东西不受回滚保护。手动 BEGIN 没有这个问题。
   */
  async transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    await this.exec('BEGIN')
    try {
      const result = await fn(this)
      await this.exec('COMMIT')
      return result
    } catch (err) {
      try {
        await this.exec('ROLLBACK')
      } catch {
        /* 回滚失败不覆盖原始错误 */
      }
      throw err
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

// ─────────────────────────────────────────────────────────────
// MySQL 后端
// ─────────────────────────────────────────────────────────────

/**
 * 保证 MySQL schema 就绪 —— 版本不符时**抛错，绝不重建**（与 SQLite 侧同一条铁律）。
 *
 * ⚠️ 版本写在 `portal_meta` 里而不是靠「表存在与否」判断：
 *   后者在「表被手工删了一张」时会表现为「悄悄重建半套 schema」。
 */
async function ensureMysqlSchema(backend: MysqlBackend, url: string): Promise<void> {
  await backend.exec(MYSQL_DDL)

  const row = await backend.get<{ schema_version: number }>(
    'SELECT schema_version FROM portal_meta WHERE id = 1',
  )
  if (!row) {
    // 全新库：写入当前版本。
    await backend.run(
      'INSERT IGNORE INTO portal_meta (id, schema_version) VALUES (1, $version)',
      { $version: DB_SCHEMA_VERSION },
    )
    return
  }

  if (Number(row.schema_version) !== DB_SCHEMA_VERSION) {
    throw new Error(
      `上报库 schema 版本不符合（库是 ${row.schema_version}，本程序需要 ${DB_SCHEMA_VERSION}）。` +
        `服务端的上报数据是本平台唯一副本，不会自动重建 —— ` +
        `请先备份 ${describeMysqlUrl(url)}，再手工处理版本差异。`,
    )
  }
}

/** MySQL 后端的门面。 */
class MysqlPortalStore implements PortalStore {
  readonly kind = 'mysql' as const
  readonly label: string
  readonly #backend: MysqlBackend

  constructor(backend: MysqlBackend, label: string) {
    this.#backend = backend
    this.label = label
  }

  async all<Row>(sql: string, params?: Record<string, unknown>): Promise<Row[]> {
    return this.#backend.all<Row>(sql, params as never)
  }

  async get<Row>(sql: string, params?: Record<string, unknown>): Promise<Row | null> {
    return this.#backend.get<Row>(sql, params as never)
  }

  async run(sql: string, params?: Record<string, unknown>): Promise<{ changes: number }> {
    return this.#backend.run(sql, params as never)
  }

  async exec(sql: string): Promise<void> {
    return this.#backend.exec(sql)
  }

  async transaction<T>(fn: (tx: PortalStore) => Promise<T>): Promise<T> {
    return this.#backend.transaction(async (txBackend) =>
      fn(new MysqlPortalStore(txBackend, this.label)),
    )
  }

  /**
   * ⚠️ **空操作**，见文件头：连接来自进程内共享的池，
   *   每个请求都真的关掉会让下一个请求重新握手。
   *   「用完必须 close()」这条约定对上层仍然成立（它两端都调），只是这里不做事。
   */
  async close(): Promise<void> {
    /* 见上 */
  }
}

// ─────────────────────────────────────────────────────────────
// 对外入口
// ─────────────────────────────────────────────────────────────

/**
 * 打开上报库（唯一入口）。
 *
 * 🚨 上层必须 `finally { await store.close() }`：SQLite 下这是真的关连接
 *   （不关会残留 WAL 与文件句柄），MySQL 下是空操作。两边的调用形状一致，
 *   所以上层不需要知道连的是哪种库。
 */
export async function openPortalStore(target: PortalTarget): Promise<PortalStore> {
  if (target.mysqlUrl) {
    const url = target.mysqlUrl
    const backend = await sharedMysqlBackend(url)
    await ensureMysqlSchema(backend, url)
    return new MysqlPortalStore(backend, describeMysqlUrl(url))
  }

  return new SqlitePortalStore(openPortalSqlite(target.sqlitePath), target.sqlitePath)
}

/** 目标的人类可读描述（启动横幅 / 诊断用）。🚨 绝不含密码。 */
export function describePortalTarget(target: PortalTarget): string {
  return target.mysqlUrl ? describeMysqlUrl(target.mysqlUrl) : target.sqlitePath
}