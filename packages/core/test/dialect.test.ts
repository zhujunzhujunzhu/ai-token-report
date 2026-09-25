/**
 * 方言单元测试 —— `core/db/dialect.ts` 的四处语法差异 + `mysql.ts` 的
 * `toPositional()` 参数翻译。
 *
 * ## 为什么必须**不连库**也能跑
 *
 * 这四处差异里有两处的猜错方式是「不报错、只是数字变错」：
 * `a || b` 在 MySQL 是逻辑或（分组键静默变成 `0`/`1`）、`SUM(BIGINT)` 返回字符串。
 * 它们需要真库才能**证明**（见 `packages/core/verify/verify-mysql-dialect.ts`
 * 与 `packages/server/verify/verify-mysql-portal.ts`），但「我们到底生成了哪句 SQL」
 * 是纯函数就能钉住的 —— 这一层必须在 `bun test` 里跑，因为它是回归的第一道网。
 *
 * ## 守的是什么
 *
 * 1. 🚨 `concat()` 在 MySQL 下必须是 `CONCAT(...)` 且**绝不出现 `||`** ——
 *    这一条直接决定看板「模型分布」是人话还是 `0`/`1`。
 * 2. 🚨 分组别名必须是 `grp_key`（`key` 是 MySQL 保留字，`AS key` 直接语法错误），
 *    且 `GROUP BY` 跟着改名。
 * 3. 🚨 `toPositional()` 查参数表要用**带 `$` 的原始键**（本仓 `buildWhere()`
 *    产出的就是 `params['$since']`）；同名参数出现多次要各补一个值，
 *    缺参数必须抛错而不是静默绑 NULL。
 * 4. 两条会报错的差异（`INSERT OR IGNORE` / `ON CONFLICT` / `MAX`）产出形状正确。
 */

import { describe, expect, test } from 'bun:test'

import {
  MYSQL_DIALECT,
  SQLITE_DIALECT,
  portalDialect,
  type PortalDialect,
} from '../src/db/dialect.js'
import { toPositional } from '../src/db/mysql.js'
import { groupsQuery, buildWhere } from '../src/db/query.js'

describe('方言：幂等插入前缀', () => {
  test('SQLite 是 INSERT OR IGNORE，MySQL 是 INSERT IGNORE', () => {
    expect(SQLITE_DIALECT.insertIgnore('usage_event')).toBe('INSERT OR IGNORE INTO usage_event')
    expect(MYSQL_DIALECT.insertIgnore('usage_event')).toBe('INSERT IGNORE INTO usage_event')
  })

  test('SQLite 的前缀本身不是合法的 MySQL、反过来也一样', () => {
    // 这条断言的意义：两个方言对象不是「同一个模板 + 空白差异」，
    // 任何一处偷懒复用都会在这里露出来。
    expect(SQLITE_DIALECT.insertIgnore('t')).toContain('OR IGNORE')
    expect(MYSQL_DIALECT.insertIgnore('t')).not.toContain('OR IGNORE')
  })
})

describe('方言：upsert 模板', () => {
  test('SQLite 走 ON CONFLICT … excluded，MySQL 走 AS new ON DUPLICATE KEY UPDATE', () => {
    const assignments = ['last_ingest_ms = {in}.last_ingest_ms']

    expect(SQLITE_DIALECT.upsertTail('id', ['x = excluded.x'])).toBe(
      'ON CONFLICT(id) DO UPDATE SET x = excluded.x',
    )
    expect(MYSQL_DIALECT.upsertTail('id', ['x = new.x'])).toBe(
      'AS new ON DUPLICATE KEY UPDATE x = new.x',
    )
    // incoming 别名：模板里代表「将要写入的那一行」
    expect(SQLITE_DIALECT.incoming).toBe('excluded')
    expect(MYSQL_DIALECT.incoming).toBe('new')
    expect(assignments.length).toBe(1)
  })

  test('render() 拼出的语句两边都能一眼看出是哪种后端', () => {
    const input = {
      table: 'ingest_run',
      columns: ['id', 'last_ingest_ms'],
      values: '1, $now',
      keyColumn: 'id',
      assignments: [`last_ingest_ms = ${MYSQL_DIALECT.incoming}.last_ingest_ms`],
    }

    const my = MYSQL_DIALECT.render(input)
    expect(my).toBe(
      'INSERT INTO ingest_run (id, last_ingest_ms) VALUES (1, $now) ' +
        'AS new ON DUPLICATE KEY UPDATE last_ingest_ms = new.last_ingest_ms',
    )

    const lite = SQLITE_DIALECT.render({
      ...input,
      assignments: [`last_ingest_ms = ${SQLITE_DIALECT.incoming}.last_ingest_ms`],
    })
    expect(lite).toContain('ON CONFLICT(id) DO UPDATE SET last_ingest_ms = excluded.last_ingest_ms')
    expect(lite).not.toContain('ON DUPLICATE KEY')
  })
})

describe('方言：标量最大值', () => {
  test('SQLite 是 MAX(a, b)，MySQL 是 GREATEST(a, b)', () => {
    expect(SQLITE_DIALECT.scalarMax('a', 'b')).toBe('MAX(a, b)')
    expect(MYSQL_DIALECT.scalarMax('a', 'b')).toBe('GREATEST(a, b)')
    // 🚨 MySQL 的 MAX() 是**聚合函数**：写进 SET 子句是语法错误，
    //   写进子查询则会静默给出全表最大值 —— 所以绝不能让它出现在 MySQL 侧。
    expect(MYSQL_DIALECT.scalarMax('a', 'b')).not.toContain('MAX(')
  })
})

describe('方言：字符串拼接（本仓最危险的一处）', () => {
  test('SQLite 用 ||，MySQL 用 CONCAT 且绝不出现 ||', () => {
    expect(SQLITE_DIALECT.concat(['provider', "'/'", 'model'])).toBe("provider || '/' || model")
    expect(MYSQL_DIALECT.concat(['provider', "'/'", 'model'])).toBe(
      "CONCAT(provider, '/', model)",
    )
    // 🚨🚨 MySQL 把 `||` 当**逻辑或**：`provider || '/' || model` 返回 0/1，
    //   分组键会静默变成 "0"/"1"（看板上模型分布变成两行垃圾数据）。
    expect(MYSQL_DIALECT.concat(['provider', "'/'", 'model'])).not.toContain('||')
  })

  test('拼接表达式进到 SQL 里也不含 ||（provider-model 维度）', () => {
    const my = groupsQuery('provider-model', {}, MYSQL_DIALECT)
    expect(my).not.toBeNull()
    expect(my!.sql).toContain("CONCAT(provider, '/', model) AS grp_key")
    expect(my!.sql).not.toContain('||')

    const lite = groupsQuery('provider-model', {}, SQLITE_DIALECT)
    expect(lite!.sql).toContain("provider || '/' || model AS grp_key")
  })
})

describe('方言：分组别名 grp_key（key 是 MySQL 保留字）', () => {
  test('别名与 GROUP BY 都用 grp_key，SQL 里不出现 `AS key`', () => {
    for (const dialect of [SQLITE_DIALECT, MYSQL_DIALECT]) {
      const q = groupsQuery('user', {}, dialect)
      expect(q).not.toBeNull()
      expect(q!.sql).toContain('AS grp_key')
      expect(q!.sql).toContain('GROUP BY grp_key')
      // 🚨 `SELECT ... AS key` 在 MySQL 上是语法错误（SQLite 允许）——
      //   别名统一成 grp_key 之后，两种后端才共用同一份文本。
      expect(q!.sql).not.toMatch(/AS\s+key\b/)
      expect(q!.sql).not.toMatch(/GROUP BY\s+key\b/)
    }
  })

  test('day / hour / project 没有 SQL 分组版本（返回 null，交给 JS 侧）', () => {
    expect(groupsQuery('day', {}, MYSQL_DIALECT)).toBeNull()
    expect(groupsQuery('hour', {}, MYSQL_DIALECT)).toBeNull()
    expect(groupsQuery('project', {}, MYSQL_DIALECT)).toBeNull()
  })
})

describe('portalDialect：方言与后端一一对应', () => {
  test('kind 与描述符自洽，且取到的是同一份常量', () => {
    const cases: [('sqlite' | 'mysql'), PortalDialect][] = [
      ['sqlite', SQLITE_DIALECT],
      ['mysql', MYSQL_DIALECT],
    ]
    for (const [kind, expected] of cases) {
      const dialect = portalDialect(kind)
      expect(dialect).toBe(expected)
      expect(dialect.kind).toBe(kind)
    }
  })
})

describe('toPositional：$name → ? 位置参数', () => {
  test('同名参数出现多次 → 各补一个值（顺序与出现顺序一致）', () => {
    const out = toPositional('SELECT * FROM t WHERE a = $a AND b = $a AND c = $b', {
      $a: 1,
      $b: 2,
    })
    expect(out.text).toBe('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?')
    expect(out.values).toEqual([1, 1, 2])
  })

  test('🚨 查表用的是带 `$` 的原始键：参数缺失时抛错且文案里带 `$` 前缀', () => {
    // 这条是活体脚本抓到的真 bug 的固化：曾经用剥掉 `$` 的名字去查表，
    // 结果是**每一句真实 SQL 都抛参数缺失**。
    expect(() => toPositional('SELECT $a', { a: 1 })).toThrow(/\$a/)
    expect(() => toPositional('SELECT $eventId', { $sessionId: 'x' })).toThrow(
      /MySQL 绑定参数缺失：\$eventId/,
    )
  })

  test('缺参数绝不静默绑 NULL（否则筛选失效看起来像「数据本来就没有」）', () => {
    expect(() => toPositional('SELECT * FROM t WHERE ts >= $since', {})).toThrow(
      /MySQL 绑定参数缺失/,
    )
  })

  test('未定义值绑 NULL；位置参数（数组）原样透传', () => {
    expect(toPositional('SELECT $a', { $a: undefined }).values).toEqual([null])
    expect(toPositional('SELECT ?, ?', [1, 'x'])).toEqual({ text: 'SELECT ?, ?', values: [1, 'x'] })
    expect(toPositional('SELECT 1', undefined)).toEqual({ text: 'SELECT 1', values: [] })
  })

  test('数字 / 字符串 / null 都原样进入 values（不做类型改写）', () => {
    const out = toPositional('WHERE a = $a AND b = $b AND c = $c', {
      $a: 0,
      $b: 'unknown',
      $c: null,
    })
    expect(out.values).toEqual([0, 'unknown', null])
  })

  test('★ 真实构建器的产出可直接翻译：翻译后不残留 `$`，且参数个数与 `?` 对齐', () => {
    // 用**真实**的 `buildWhere()` 产出（键带 `$`）—— 与活体脚本同源。
    // 这里刻意不自己构造参数对象：自己造的键名很容易与约定不一致，
    // 而那种不一致会让整个 MySQL 通路在第一句 SQL 上就抛错。
    const where = buildWhere({ sinceMs: 0, untilMs: 9_999, providers: ['dash'], userIds: ['张三'] })
    const q = groupsQuery('provider-model', { sinceMs: 0, untilMs: 9_999, providers: ['dash'], userIds: ['张三'] }, MYSQL_DIALECT)
    expect(q).not.toBeNull()

    const out = toPositional(q!.sql, q!.params)
    expect(out.text).not.toContain('$')
    expect(out.text.match(/\?/g)?.length ?? 0).toBe(out.values.length)
    expect(out.values.length).toBe(Object.keys(q!.params).length)
    // 构建器的参数与 buildWhere 是同一组（构建器不能自己造第二套键名）
    expect(q!.params).toEqual(where.params)
  })
})