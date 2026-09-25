/**
 * SQL 方言 —— SQLite 与 MySQL 之间**仅有的四处**语法差异，收在一个文件里。
 *
 * ## ★ 为什么必须收在一处
 *
 * 本仓最怕的不是「语法写错」（那会报错），而是「语法在另一种后端上**语义变了**」——
 * 它不会报错，只会让某个数字悄悄不对。下面四处里有两处属于后者。
 *
 * ## 四处差异（全部本机实测）
 *
 * | # | 差异 | SQLite | MySQL | 猜错会怎样 |
 * |---|---|---|---|---|
 * | 1 | 幂等插入 | `INSERT OR IGNORE INTO` | `INSERT IGNORE INTO` | 语法错误（会报错，好抓） |
 * | 2 | upsert 冲突子句 | `ON CONFLICT(k) DO UPDATE SET x = excluded.x` | `AS new ON DUPLICATE KEY UPDATE x = new.x` | 语法错误（会报错） |
 * | 3 | 标量最大值 | `MAX(a, b)` | `GREATEST(a, b)` | 🚨 MySQL 的 `MAX()` 是**聚合函数**，用在 SET 里报错；但若写成子查询会**静默给出全表最大值** |
 * | 4 | 字符串拼接 | `a \|\| b` | `CONCAT(a, b)` | 🚨🚨 **MySQL 把 `\|\|` 当逻辑或**（除非开 `PIPES_AS_CONCAT`）。`provider \|\| '/' \|\| model` 会返回 0/1 —— 分组键静默变成 `"0"`/`"1"`，看板上的模型分布会变成两行，而**没有任何报错** |
 *
 * 第 4 条是本次迁移最危险的一处：`query.ts` 的 `provider-model` 维度正是这么写的。
 * 实测确认后改为走 `dialect.concat()`。
 *
 * ## 另外两条不是语法差异、但同样必须记住的
 *
 * - 🚨 **`key` 是 MySQL 保留字**：`SELECT ... AS key` 直接语法错误。
 *   因此分组别名统一叫 `grp_key`，在 TS 侧再映射回 `key`（对外契约不变）。
 * - ⚠️ **`SUM(BIGINT)` 经驱动返回的是字符串**（`"60"` 而不是 `60`），
 *   归一化在口径边界 `portal.ts` 做（见那里的 `num()`）。
 */

/** 上报库用哪种后端。 */
export type PortalBackendKind = 'sqlite' | 'mysql'

/**
 * 方言描述符。
 *
 * ★ 上层（`ingest.ts` / `portal.ts` / `query.ts`）只通过它拼 SQL，
 *   因此**不存在**「MySQL 版语句」与「SQLite 版语句」两份文本各自演化的问题。
 */
export interface PortalDialect {
  readonly kind: PortalBackendKind
  /** 幂等插入前缀（主键冲突即跳过）。 */
  insertIgnore(table: string): string
  /** upsert 尾部。 */
  upsertTail(keyColumn: string, assignments: readonly string[]): string
  /** 模板里代表「将要写入的那一行」的别名（SQLite `excluded` / MySQL `new`）。 */
  readonly incoming: string
  /** 标量最大值（差异 3）。 */
  scalarMax(a: string, b: string): string
  /** 字符串拼接（差异 4）。`parts` 里可以是列名或字面量（字面量请自带引号）。 */
  concat(parts: readonly string[]): string
  /**
   * 展开一条 upsert 语句。
   *
   * 模板里可用 `{t}`（表名）、`{in}`（incoming 别名）、`{key}`（主键列）。
   */
  render(input: {
    table: string
    columns: readonly string[]
    values: string
    keyColumn: string
    assignments: readonly string[]
  }): string
}

function makeDialect(kind: PortalBackendKind): PortalDialect {
  const incoming = kind === 'mysql' ? 'new' : 'excluded'
  return {
    kind,
    incoming,
    insertIgnore(table) {
      return kind === 'mysql' ? `INSERT IGNORE INTO ${table}` : `INSERT OR IGNORE INTO ${table}`
    },
    upsertTail(keyColumn, assignments) {
      const sets = assignments.join(', ')
      return kind === 'mysql'
        ? `AS ${incoming} ON DUPLICATE KEY UPDATE ${sets}`
        : `ON CONFLICT(${keyColumn}) DO UPDATE SET ${sets}`
    },
    scalarMax(a, b) {
      return kind === 'mysql' ? `GREATEST(${a}, ${b})` : `MAX(${a}, ${b})`
    },
    concat(parts) {
      // 🚨 见文件头差异 4：MySQL 的 `||` 是逻辑或，不是拼接。
      return kind === 'mysql' ? `CONCAT(${parts.join(', ')})` : parts.join(' || ')
    },
    render(input) {
      const cols = input.columns.join(', ')
      return (
        `INSERT INTO ${input.table} (${cols}) VALUES (${input.values}) ` +
        this.upsertTail(input.keyColumn, input.assignments)
      )
    },
  }
}

/** SQLite 方言（默认；本机库恒用它）。 */
export const SQLITE_DIALECT: PortalDialect = makeDialect('sqlite')

/** MySQL 方言。 */
export const MYSQL_DIALECT: PortalDialect = makeDialect('mysql')

/** 取某个后端的方言描述符。 */
export function portalDialect(kind: PortalBackendKind): PortalDialect {
  return kind === 'mysql' ? MYSQL_DIALECT : SQLITE_DIALECT
}