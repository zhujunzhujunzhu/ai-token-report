/**
 * MySQL 方言层的**活体验证** —— 需要有本机可连的 MySQL，因此不进 `bun test`。
 *
 * ## 为什么必须有这个脚本
 *
 * MySQL 与 SQLite 之间有四处语法差异，其中**三处的猜错方式是「不报错、只是数字变错」**：
 *
 * | 差异 | 猜错的后果 |
 * |---|---|
 * | `\|\|` 是逻辑或 | 分组键变成 `0`/`1`，看板「模型分布」变成两行垃圾数据 |
 * | `SUM(BIGINT)` 返回字符串 | 派生指标算出 `NaN` 或字符串拼接 |
 * | `key` 是保留字 | 语法错误（这条会报错，好抓） |
 *
 * 单测覆盖不到它们：那是**驱动与数据库的真实行为**，只有连上真库才能证明。
 * 本脚本因此用**真实的方言层 + 真实的驱动层 + 真实的 SQL 形态**跑一遍，
 * 并在结束时清掉自己建的 `probe_*` 探测表。
 *
 * ## 它抓到过的真 bug（留作教训）
 *
 * `toPositional()` 曾用**剥掉 `$` 的名字**去查参数表，而本仓 `buildWhere()` 产出的键
 * 是**带 `$` 的**（`params['$since']`）—— 结果是每一句真实 SQL 都抛「参数缺失」。
 * 单元测试如果只喂自己构造的参数对象，很容易把「不带 `$`」当成约定而漏掉它；
 * 这里直接拿 `buildWhere()` 的真实产出喂进去，于是第一次跑就红了。
 *
 * ## 用法
 *
 * ```bash
 * # 连接串里必须带 allowPublicKeyRetrieval（MySQL 8.4 的 caching_sha2_password）
 * ATR_MYSQL_URL='mysql://user:pass@127.0.0.1:3306/ai_token_report' \
 *   bun run --filter '@ai-token-report/core' verify:mysql
 * ```
 *
 * 🚨 **只会在目标库里创建/删除 `probe_` 前缀的表**，不碰 `usage_event` 等业务表，
 *   更不会跨库操作。
 */

import { MYSQL_DIALECT } from '../src/db/dialect.js'
import { sharedMysqlBackend } from '../src/db/mysql.js'
import { buildWhere } from '../src/db/query.js'

/**
 * 默认连本机的开发用 MySQL（`local-database-review-mysql` 容器，宿主端口 3335）。
 *
 * ⚠️ 账号来自**开发机的 `.env`**（`MYSQL_USER` / `MYSQL_PASSWORD`）；**库名是本项目自己的**
 *   （`ai-token`，与 `.env` 里的 `MYSQL_DATABASE=local-mysql` 不同 ——
 *   那台实例是多个项目共用的，各项目各用一张库）。
 *   CI 或别人的机器上用 `ATR_MYSQL_URL` 覆盖。
 */
const URL =
  process.env.ATR_MYSQL_URL ?? 'mysql://mysql_user:mysql_password@127.0.0.1:3335/ai-token'
/** 探测表前缀：清理时按它删，绝不碰业务表。 */
const T = 'probe_portal_event'

let failed = 0
const check = (label: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`  ✅ ${label}`)
  else {
    failed++
    console.log(`  ❌ ${label} ${extra}`)
  }
}

const db = await sharedMysqlBackend(URL)

await db.exec(`DROP TABLE IF EXISTS ${T}`)
await db.exec(`CREATE TABLE ${T} (
  event_id VARCHAR(255) NOT NULL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  seq BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  provider VARCHAR(255) NOT NULL,
  model VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  KEY idx_ts (ts), KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

console.log('\n【1】幂等插入：INSERT IGNORE 前缀 + 位置参数翻译')
const cols = ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'user_id', 'input_tokens']
const values = '$eventId, $sessionId, $seq, $ts, $provider, $model, $userId, $input'
const insertSql = `${MYSQL_DIALECT.insertIgnore(T)} (${cols.join(', ')}) VALUES (${values})`
check('MySQL 前缀是 INSERT IGNORE INTO', insertSql.startsWith('INSERT IGNORE INTO'), insertSql.slice(0, 40))

const rows = [
  { id: 'probe:1', s: 'probe-sess-1', ts: 1000, p: 'dashscope', m: 'qwen-max', u: '张三', i: 10 },
  { id: 'probe:2', s: 'probe-sess-1', ts: 1001, p: 'dashscope', m: 'qwen-max', u: '张三', i: 20 },
  { id: 'probe:3', s: 'probe-sess-2', ts: 1002, p: 'deepseek', m: 'v4', u: null, i: 30 },
]
let inserted = 0
for (const r of rows) {
  const res = await db.run(insertSql, {
    $eventId: r.id,
    $sessionId: r.s,
    $seq: 1,
    $ts: r.ts,
    $provider: r.p,
    $model: r.m,
    $userId: r.u,
    $input: r.i,
  })
  if (res.changes > 0) inserted++
}
check('首次插入三行（changes 判据可用）', inserted === 3, `inserted=${inserted}`)
const again = await db.run(insertSql, {
  $eventId: 'probe:1',
  $sessionId: 'probe-sess-1',
  $seq: 1,
  $ts: 1000,
  $provider: 'dashscope',
  $model: 'qwen-max',
  $userId: '李四',
  $input: 999,
})
check('重复插入 changes=0（去重判据与 SQLite 一致）', again.changes === 0, `changes=${again.changes}`)
const kept = await db.get<{ user_id: string }>(`SELECT user_id FROM ${T} WHERE event_id = $id`, {
  $id: 'probe:1',
})
check('归属以先到的为准（未被李四覆盖）', kept?.user_id === '张三', JSON.stringify(kept))

console.log('\n【2】分组键拼接：provider-model 绝不能退化成逻辑或')
const concatExpr = MYSQL_DIALECT.concat(['provider', "'/'", 'model'])
check('拼接表达式用 CONCAT 且不含 ||', concatExpr.includes('CONCAT') && !concatExpr.includes('||'), concatExpr)
// ★ 直接用 buildWhere() 的**真实产出**喂进去 —— 它产出的键是带 `$` 的，
//   这正是上一版 toPositional 写错的地方（用剥掉 `$` 的名字查表 → 必然抛错）。
const { sql: where, params } = buildWhere({ sinceMs: 0, userIds: ['张三', 'unknown'] })
const groupRows = await db.all<{ grp_key: string; input: string; calls: number }>(
  `SELECT ${concatExpr} AS grp_key,
          SUM(input_tokens) AS input,
          COUNT(*) AS calls
   FROM ${T}${where}
   GROUP BY grp_key
   ORDER BY input DESC`,
  params,
)
const keys = groupRows.map((r) => r.grp_key).sort()
check(
  '分组键是真实拼接结果（不是 0/1）',
  keys.length === 2 && keys.includes('deepseek/v4') && keys.includes('dashscope/qwen-max'),
  JSON.stringify(keys),
)
check('未归属与已署名都按筛选条件取到', groupRows.length === 2, JSON.stringify(groupRows))

console.log('\n【3】SUM 返回字符串 → 必须 Number() 归一')
check('驱动确实返回字符串（这是坑本身）', typeof groupRows[0]!.input === 'string', typeof groupRows[0]!.input)
check(
  'Number() 归一后是正确的数字',
  Number(groupRows[0]!.input) > 0 && Number.isFinite(Number(groupRows[0]!.input)),
  String(groupRows[0]!.input),
)
const totals = await db.get<{ calls: number; input: string | null; cr: string | null }>(
  `SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cr FROM ${T}${where}`,
  params,
)
check('空列 SUM 归一后应是 0 而不是 NaN', Number(totals?.cr ?? 0) === 0, JSON.stringify(totals))

console.log('\n【4】upsert 模板：GREATEST + COALESCE + AS new')
const upsert = MYSQL_DIALECT.render({
  table: 'probe_portal_state',
  columns: ['session_id', 'last_seq', 'cwd'],
  values: '$sessionId, $lastSeq, $cwd',
  keyColumn: 'session_id',
  assignments: [
    `last_seq = ${MYSQL_DIALECT.scalarMax('probe_portal_state.last_seq', `${MYSQL_DIALECT.incoming}.last_seq`)}`,
    `cwd = COALESCE(${MYSQL_DIALECT.incoming}.cwd, probe_portal_state.cwd)`,
  ],
})
check('模板里用 GREATEST 而不是 MAX', upsert.includes('GREATEST') && !upsert.includes('MAX('), upsert.slice(-120))
check('模板里用 AS new 别名', upsert.includes('AS new ON DUPLICATE KEY UPDATE'), upsert.slice(-90))
await db.exec('DROP TABLE IF EXISTS probe_portal_state')
await db.exec(`CREATE TABLE probe_portal_state (
  session_id VARCHAR(255) NOT NULL PRIMARY KEY, last_seq BIGINT NOT NULL, cwd VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
const p = { $sessionId: 'probe-sess-1' }
await db.run(upsert, { ...p, $lastSeq: 5, $cwd: '/a' })
await db.run(upsert, { ...p, $lastSeq: 3, $cwd: null })
await db.run(upsert, { ...p, $lastSeq: 9, $cwd: '/b' })
const state = await db.get<{ last_seq: number; cwd: string }>(
  'SELECT last_seq, cwd FROM probe_portal_state WHERE session_id = $s',
  { $s: 'probe-sess-1' },
)
check('last_seq 取最大值（3 不会回退 5）', Number(state?.last_seq) === 9, JSON.stringify(state))
check('cwd 非空覆盖、null 不冲掉已知值', state?.cwd === '/b', JSON.stringify(state))

console.log('\n【5】清理')
await db.exec(`DROP TABLE IF EXISTS ${T}`)
await db.exec('DROP TABLE IF EXISTS probe_portal_state')
const left = await db.all<{ t: string }>(
  "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()",
)
check('探测表已清理干净', !left.some((r) => r.t.startsWith('probe_')), JSON.stringify(left.map((r) => r.t)))

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed > 0 ? 1 : 0)