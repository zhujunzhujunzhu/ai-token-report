/**
 * SQLite 表结构 —— 本地增量库的**唯一 schema 真源**。
 *
 * ## 为什么要有这个库
 *
 * 直扫日志的瓶颈**不是 IO，是 CPU**。本机实测（196 文件 / 80.8 MB）：
 *
 * | 阶段 | 耗时 | 占比 |
 * |---|---|---|
 * | 读文件 | 577 ms | 3.7% |
 * | **zstd 解压** | **12,102 ms** | **76.9%** |
 * | **JSON 解析** | **3,061 ms** | **19.5%** |
 *
 * 解压出 262.8 MB 文本、parse 9.6 万行 JSON，只为捞出 16,021 条计费记录 ——
 * 而且**每次查询都重来一遍**。落库后同一批数据的查询是毫秒级：
 * today 总计 0.26 ms、全量分组 20 ms（对比直扫 15.7 秒）。
 *
 * ## 三条设计铁律（对应 AGENTS.md）
 *
 * 1. 🚨 **四个 token 必须存四个独立列**（`input_tokens` / `output_tokens` /
 *    `cache_read_tokens` / `cache_write_tokens`）。采集端一旦合并，
 *    后续任何拆分都无法还原 —— 这是本仓最贵的一条教训。
 * 2. 🚨 **本文件不定义任何口径公式**。`total_tokens` 列**不存在**，
 *    展示时要相加就交给 `shared/src/metrics.ts`。SQL 里写公式 =
 *    制造第二个口径真源，两端不一致的 bug 极难排查。
 * 3. 🚨 **列名一律 `snake_case`**（DB 边界），TS 内存类型保持 `camelCase`。
 *    转换只发生在 `ingest.ts` / `query.ts` 这两个边界文件里。
 *
 * ## 为什么水位线也搬进库里
 *
 * `state.ts` 的 JSON 状态文件（`state.json`）与库必须**同生共死**：
 * 若水位线留在 JSON、数据留在库，两者在崩溃时可能不一致 ——
 * 水位线超前 → 丢数据（不可接受），水位线落后 → 重复入库（`event_id`
 * 主键幂等吸收，无害）。把两者放进**同一个 SQLite 事务**，
 * 就能让「数据入库」与「水位线推进」原子生效，彻底消灭这个不一致窗口。
 *
 * ⚠️ `state.json` 仍保留给「上报」（`report` 子命令）使用 ——
 * 那条链路的投递目标在远端，语义不同，不要混用。
 */

import { createSqliteDatabase, type Database } from './driver.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * schema 版本。
 *
 * 结构不兼容变更时 +1。`openDb()` 会比对 `user_version`：
 * 不一致时**不抛错**，而是走「重建」路径（见 `ingest.ts` 的全量重扫兜底）——
 * 抛错会让本地页白屏，而降级重建只多花一次全量扫描的时间。
 *
 * ⚠️ 上面这条只对**本机库**成立（它的真值是磁盘上的会话日志，重建 = 重扫）。
 *   服务端上报库是**唯一副本**，同一份 schema 在那边由 `openPortalDb()` 打开，
 *   版本不符时它**抛错而不是重建**。见该函数的注释。
 *
 * | 版本 | 变更 |
 * |---|---|
 * | 2 | `ingest_run` 补解析计数列 |
 * | 3 | `usage_event` 加归属三列 `user_id` / `user_name` / `dept`（服务端上报写入） |
 */
export const DB_SCHEMA_VERSION = 3

/** 单条计费事件表名。 */
export const EVENT_TABLE = 'usage_event'

/**
 * 建表语句。
 *
 * ⚠️ `event_id` 是 **PRIMARY KEY**，不是普通索引：它是 `sessionId:seq` 的
 *   幂等键（与上报协议一致）。`INSERT OR IGNORE` 因此天然去重，
 *   让「重扫、截断回退、并发 ingest」全部变成安全操作。
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
  -- 幂等键 sessionId:seq。与 WireTokenRecord.event_id 完全同义，
  -- 将来要支持「本机库直接导出上报」时无需任何转换。
  event_id            TEXT    PRIMARY KEY,
  session_id          TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  -- epoch 毫秒。所有时间窗筛选都打在这一列上，必须建索引。
  ts                  INTEGER NOT NULL,
  provider            TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  -- 项目归属：取自 session 首行 cwd。增量块里通常没有该行，
  -- 靠 session_state 表继承，否则「按项目统计」会退化成 (unknown)。
  cwd                 TEXT,
  -- ★ 归属：这条用量算谁的。**只由服务端按 Bearer token 查凭证表得出**
  --   （server/src/verify-route.ts 的 resolveIngestIdentity），
  --   客户端在请求体里自称的姓名一律忽略 —— 否则改一下本地配置就能冒用他人。
  --   本机增量入库（ingest.ts）不写这三列：本机数据只有我一个人，
  --   归属只对「上报道部门服务端」有意义。因此它们**必须可空**。
  --   ⚠️ SQL 里的注释不能写反引号 —— 会把外层模板字符串截断。
  user_id             TEXT,
  user_name           TEXT,
  dept                TEXT,
  -- ★ 四个独立列，绝不合并（铁律 1）
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  -- reasoning 是 output 的子集，**不在** total 恒等式里，单独一列仅为展示
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  turn                INTEGER,
  step                INTEGER
);

-- 时间窗查询（period=today/week/...）走这条。实测 today 总计从全表扫
-- 7 ms 降到 0.3 ms。
CREATE INDEX IF NOT EXISTS idx_usage_ts ON ${EVENT_TABLE}(ts);
-- 分组维度索引。provider / model 的组合查询很常见（breakdown by=provider-model）
CREATE INDEX IF NOT EXISTS idx_usage_provider ON ${EVENT_TABLE}(provider);
CREATE INDEX IF NOT EXISTS idx_usage_model ON ${EVENT_TABLE}(model);
-- 会话数统计（overview 的 sessions 字段）与 L3 水位线查表都要用
CREATE INDEX IF NOT EXISTS idx_usage_session ON ${EVENT_TABLE}(session_id);
-- 人员归属：部门页的「人员排行」（breakdown by=user）与「只看某人」筛选
-- 都打在这一列上，和 provider/model 同级的高频分组维度。
CREATE INDEX IF NOT EXISTS idx_usage_user ON ${EVENT_TABLE}(user_id);

-- ── 文件水位线（L1 字节数 / L2 帧数），对应 state.ts 的 FileWatermark ──
CREATE TABLE IF NOT EXISTS file_watermark (
  -- 会话日志文件的绝对路径
  file_path     TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  frame_count   INTEGER NOT NULL,
  -- 仅诊断用，不参与跳过判定（与 state.ts 的语义保持一致）
  mtime_ms      INTEGER NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- ── 会话状态（L3 的 seq 水位线 + cwd 继承）──────────────────────────
CREATE TABLE IF NOT EXISTS session_state (
  session_id     TEXT    PRIMARY KEY,
  -- L3：该会话已入库的最大 seq。必须按 sessionId 存而非按文件存 ——
  -- 一个会话可能被拆成多个 session*.jsonl.zstd，而 seq 是会话内单调的。
  last_seq       INTEGER NOT NULL,
  -- cwd 继承：增量块通常不含 session 首行，必须记住上一轮的值。
  -- 只在解析出非空 cwd 时覆盖，绝不用 null 冲掉已知值。
  cwd            TEXT,
  updated_at_ms  INTEGER NOT NULL
);

-- ── 诊断计数 ─────────────────────────────────────────────────────────
-- 每次 ingest 覆盖写入单行。失败不阻塞主流程。
--
-- ★ 为什么把这些「扫描期」的计数也持久化：数据源改成库之后，
--   /api/local/stats/diagnostics 若只报库里的行数，就会丢掉
--   「恒等式校验失败几条」「有多少 assistant/message 没有 usage」
--   这类**判断采集是否健康**的关键信号 —— 而它们只能在解析日志时观察到。
--   没有这组数字，「数据悄悄少了一部分」这种故障几乎无法发现。
CREATE TABLE IF NOT EXISTS ingest_run (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_ingest_ms        INTEGER NOT NULL,
  last_scan_events      INTEGER NOT NULL,
  total_events_ingested INTEGER NOT NULL,
  mismatch_count        INTEGER NOT NULL,
  files_failed          INTEGER NOT NULL,
  frames_failed         INTEGER NOT NULL,
  -- 最近一轮的解析计数（新增列；旧库由 rebuildSchema 兜底重建）
  frames_ok             INTEGER NOT NULL DEFAULT 0,
  usage_events          INTEGER NOT NULL DEFAULT 0,
  assistant_without_usage INTEGER NOT NULL DEFAULT 0,
  retry_started         INTEGER NOT NULL DEFAULT 0,
  retry                 INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 0,
  missing_provider      INTEGER NOT NULL DEFAULT 0,
  files_scanned         INTEGER NOT NULL DEFAULT 0,
  -- 事件类型分布与 provider 列表，JSON 编码存储。
  -- 用 JSON 而不是关联表：它们只用于展示、从不参与查询与聚合，
  -- 为它们建两张表会让 ingest 事务多两次写入而无任何收益。
  event_types_json      TEXT NOT NULL DEFAULT '{}',
  providers_json        TEXT NOT NULL DEFAULT '[]'
);
`

/**
 * 打开（必要时创建）数据库。
 *
 * ## PRAGMA 取舍
 *
 * - `journal_mode=WAL`：**必须**。本地页面会在写入（ingest）的同时读取，
 *   rollback journal 模式下读写会互相阻塞，表现为页面偶发卡顿。
 * - `synchronous=NORMAL`：WAL 下的推荐值。崩溃最多丢最后几个事务，
 *   而这些数据本来就能从日志重扫出来 —— 用不着 `FULL` 的额外 fsync 开销。
 * - `busy_timeout`：多进程（CLI 与本地服务可能同时开库）时的等待上限。
 *   **不设会让并发写入直接抛 SQLITE_BUSY**，而不是等一会儿。
 *
 * 返回的 Database 由调用方负责 `close()`。
 */
export function openDb(dbPath: string): Database {
  // ⚠️ SQLite **不会**自动创建父目录，父目录不存在时直接抛
  //   `SQLiteError: unable to open database file`。
  //   而默认路径 `$DSH_HOME/token-report/` 在「从未用过 token-report
  //   任何功能」的机器上是不存在的 —— 首次运行必然踩到。
  //   这里主动建目录，与 `state.ts` 的 `saveState()` 行为保持一致。
  mkdirSync(dirname(dbPath), { recursive: true })

  // ★ 驱动由 `driver.ts` 按运行期挑：Bun → `bun:sqlite`，Node → `node:sqlite`。
  //   本文件与上层看不到这个差异，SQL 与 PRAGMA 完全一致。
  const db = createSqliteDatabase(dbPath)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  // 5 秒：远大于任何一次增量 ingest 的写入时长（实测毫秒级）
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')

  return db
}

/**
 * 建表（幂等）。已存在则什么都不做。
 *
 * 刻意**不**在这里做版本迁移：本项目的数据全部可从日志重扫得到，
 * 迁移逻辑比「发现版本不符就重建」更容易出错且更难测试。
 * 版本判定交给 {@link needsRebuild}。
 */
export function ensureSchema(db: Database): void {
  db.exec(SCHEMA_SQL)
  db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`)
}

/**
 * 判断是否需要重建：`user_version` 与当前 schema 版本不符。
 *
 * 缺失（=0，全新库或空文件）视为**不需要**重建 —— 直接建表即可。
 */
export function needsRebuild(db: Database): boolean {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const version = row?.user_version ?? 0
  // 0 = 全新/空文件，建表就好；其他不符才算需要重建
  return version !== 0 && version !== DB_SCHEMA_VERSION
}

/**
 * 丢弃全部数据并重建（版本升级、或库损坏时的兜底）。
 *
 * 🚨 **这里删的只是「日志的派生物」**，真值始终是磁盘上的会话日志，
 *   所以重建的代价只是「下次 ingest 走全量」，不会丢任何数据。
 *   这也是本地库敢于「坏了就重建」而不是做复杂修复的原因。
 *
 * 🚨 **绝不可对服务端上报库调用本函数**：那边的数据是全员上报的
 *   **唯一副本**（客户端投递成功后就会清掉自己的 pending / outbox），
 *   删掉就永久没了。服务端库由 `openPortalDb()` 打开，版本不符时它抛错。
 */
export function rebuildSchema(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS ${EVENT_TABLE}`)
  db.exec('DROP TABLE IF EXISTS file_watermark')
  db.exec('DROP TABLE IF EXISTS session_state')
  db.exec('DROP TABLE IF EXISTS ingest_run')
  db.exec('PRAGMA user_version = 0')
  ensureSchema(db)
}

/** 本地库的默认路径：`$DSH_HOME/token-report/usage.sqlite`。 */
export function dbFileName(): string {
  return 'usage.sqlite'
}

/**
 * 服务端上报库的默认文件名：`$DSH_HOME/token-report/portal.sqlite`。
 *
 * ⚠️ **必须与本地库 `usage.sqlite` 分开**：本地库存的是「这台机器的日志派生数据」，
 *   服务端库存的是「全员上报数据」。两个文件一旦是同一个，全员数据与本机数据
 *   会互相污染，而且事后**没有任何办法拆开**（库里没有记录来源列）。
 */
export function portalDbFileName(): string {
  return 'portal.sqlite'
}