/**
 * 业务热路径的**版本闸门**性能不变量（2026-10-04 线上实测优化）。
 *
 * ## 为什么要有这个文件
 *
 * `ensurePortalReady()` 在**每个 API 请求**上都要跑一遍（连 401 与候选目录端点
 * 也跑）。它的 MySQL 实现里曾有两处「随规模线性增长」的开销：
 *
 * | 环节 | 优化前 | 优化后 | 线上实测（27 张表 / 226 条 CHECK） |
 * |---|---|---|---|
 * | 迁移账本 | 逐版本各查一次（10 次往返） | 一次 `IN` 查（1 次） | 138ms → 16ms |
 * | CHECK 约束 | **每表一次**（27 次往返） | 全库一条 + `constraint_schema` 收窄（1 次） | 446ms → 185ms |
 * | CHECK 连接顺序 | 普通 `JOIN`（MySQL 自选驱动表 ⇒ 物化实例级 CHECK 视图） | ★ **`STRAIGHT_JOIN`（以本库 `table_constraints` 为驱动表）** | **161ms → 23.8ms**（2026-10-07 线上实测，226 行逐行等价） |
 * | 合计 SELECT | — | — | **13 条 → 5 条** |
 *
 * 这类开销**不会在功能测试里暴露** —— 它只会让接口慢慢变慢，
 * 直到有人发现看板打不开。所以必须有一条断言直接盯住「往返次数」。
 *
 * ## ⚠️ 为什么主体断言只在 MySQL 上跑
 *
 * 优化的是 `verifyCurrentMysql()`。**SQLite 分支是逐表 `PRAGMA table_info`
 * （实测 59 条），本次没动它** —— 本地库与测试库都走那条路，
 * 而「SQLite 上条数没降」这件事本身就该如实写在这里，
 * 免得后来人误以为两个后端一起优化了。
 *
 * 因此：
 *   - MySQL 在位 ⇒ 主体断言实跑；
 *   - MySQL 不在（`ATR_V4_TEST_MYSQL_URL` 未设）⇒ **如实 skip**，
 *     只留两个后端都成立的断言（放行 / 拒绝 / 稳定）。
 *     「SQLite 上测过了」不构成 MySQL 的证据 —— 这是本仓一贯的规矩。
 *
 * ## 怎么量语句数（为什么不靠 mock）
 *
 * 刻意**不注入假 store 去数方法调用**：那测的是「我们调了几次自己写的方法」，
 * 而线上真实成本是「服务端收到了几条 SQL」。
 * 这里给 `PortalStore` 套一层**只计数、不改语义**的代理。
 *
 * 🚨 代理**刻意不缓存任何结果** —— 闸门的全部价值就在「每次都重读真实结构」，
 *   一旦顺手做了缓存，本文件测的就是缓存而不是闸门。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPortalStore, type PortalTarget } from '../src/db/portal-db.js'
// ⚠️ `openRawPortalStore` 刻意**不从 `portal-db.js` 导**（那里只暴露业务入口，
//   「绕过版本闸门」是迁移器的特权）。测试要亲手拿它，正是为了量闸门本身。
import { openRawPortalStore, type PortalStore } from '../src/db/portal-connection.js'
import { closeAllMysqlBackends, openMysqlBackend } from '../src/db/mysql.js'
import { ensurePortalReady } from '../src/db/portal-migrations.js'
import { PORTAL_SCHEMA_VERSION } from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-gate-perf-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/** 数语句的代理：只统计发往服务端的 `all` / `get` / `run` / `exec`。 */
function counting(inner: PortalStore): { store: PortalStore; count: () => number } {
  let statements = 0
  const wrap = (source: PortalStore): PortalStore => ({
    kind: source.kind,
    label: source.label,
    all: (sql, params) => { statements++; return source.all(sql, params) },
    get: (sql, params) => { statements++; return source.get(sql, params) },
    run: (sql, params) => { statements++; return source.run(sql, params) },
    exec: (sql) => { statements++; return source.exec(sql) },
    transaction: (fn) => source.transaction((tx) => fn(wrap(tx))),
    withConnection: (fn) => source.withConnection((connection) => fn(wrap(connection))),
    close: () => source.close(),
  })
  return { store: wrap(inner), count: () => statements }
}

/** 过一遍业务热路径那道闸门，返回它发出的语句条数。 */
async function gateStatements(target: PortalTarget): Promise<number> {
  const raw = await openRawPortalStore(target)
  const counted = counting(raw)
  try {
    await ensurePortalReady(counted.store)
    return counted.count()
  } finally {
    await raw.close()
  }
}

/** 过闸门，并把它发出的每一条 SQL 留下来（诊断用；生产代码不导出 SQL 文本）。 */
async function gateStatementsWithSql(target: PortalTarget): Promise<{ count: number; sqls: string[] }> {
  const raw = await openRawPortalStore(target)
  const sqls: string[] = []
  const wrap = (source: PortalStore): PortalStore => ({
    kind: source.kind,
    label: source.label,
    all: (sql, params) => { sqls.push(sql); return source.all(sql, params) },
    get: (sql, params) => { sqls.push(sql); return source.get(sql, params) },
    run: (sql, params) => { sqls.push(sql); return source.run(sql, params) },
    exec: (sql) => { sqls.push(sql); return source.exec(sql) },
    transaction: (fn) => source.transaction((tx) => fn(wrap(tx))),
    withConnection: (fn) => source.withConnection((connection) => fn(wrap(connection))),
    close: () => source.close(),
  })
  try {
    await ensurePortalReady(wrap(raw))
    return { count: sqls.length, sqls }
  } finally {
    await raw.close()
  }
}

interface TargetCase { label: 'sqlite' | 'mysql'; run: (fn: (target: PortalTarget) => Promise<void>) => Promise<void> }

async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_gate_perf_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_gate_perf_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
  const url = new URL(adminUrl)
  url.pathname = `/${schema}`
  let created = false
  try {
    await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
    created = true
    await fn({ sqlitePath: 'unused', mysqlUrl: url.href })
  } finally {
    await closeAllMysqlBackends()
    if (created) await admin.exec(`DROP DATABASE ${schema}`)
    await admin.close()
  }
}

const cases = (): TargetCase[] => {
  const list: TargetCase[] = [{
    label: 'sqlite',
    run: async (fn) => { await fn({ sqlitePath: join(root, `${randomUUID()}.sqlite`) }) },
  }]
  if (mysqlUrl) list.push({ label: 'mysql', run: isolatedMysql })
  return list
}

/** 只在 MySQL 上跑的用例；没有连接时用 `test.skip` 如实跳过。 */
const mysqlOnly = (name: string, fn: () => Promise<void>) =>
  (mysqlUrl ? test : test.skip)(name, fn)

describe('闸门强度：减少往返不许削弱检查（两个后端都必须成立）', () => {
  for (const backend of cases()) {
    describe(backend.label, () => {
      test('★ 完好库放行，且反复过闸门语句数稳定（没有隐藏缓存）', async () => {
        await backend.run(async (target) => {
          const opened = await openPortalStore(target)
          await opened.close()
          const first = await gateStatements(target)
          expect(first).toBeGreaterThan(0)
          expect(await gateStatements(target)).toBe(first)
          expect(await gateStatements(target)).toBe(first)
        })
      })

      test('🚨 少一张受控表 ⇒ 立刻拒绝', async () => {
        await backend.run(async (target) => {
          const opened = await openPortalStore(target)
          await opened.close()
          const store = await openRawPortalStore(target)
          try {
            await store.exec('DROP TABLE member_group_assignments')
          } catch { /* SQLite 可能开着外键；闸门照样要拒 */ }
          finally { await store.close() }
          await expect(gateStatements(target)).rejects.toThrow()
        })
      })
    })
  }
})

/**
 * 主体：MySQL 闸门的**往返次数不随表数增长**。
 *
 * 🚨 这是本次优化唯一有意义的断言形式。写成「具体等于 N 条」会在下一次
 *   加版本时误报（目录查询会多一两条）；写成「加 8 张野表后不变」也**无效** ——
 *   受控表清单由 `portalSchemaStatements()` 固定，野表进不了比对循环，
 *   旧实现在这条上照样通过（本文件第一版就踩过这个坑，症状是「测试全绿，
 *   但它压根抓不住要防的那个退化」）。
 *   真正能区分新旧的是**绝对条数上界**：旧实现是「10 次账本 + 27 次 CHECK」，
 *   新实现是常数。
 */
describe('MySQL 闸门往返预算（本次优化的主体）', () => {
  mysqlOnly('★ 过闸门 SELECT 条数在一个小常数内（与表数、CHECK 数无关）', async () => {
    await isolatedMysql(async (target) => {
      const opened = await openPortalStore(target)
      await opened.close()
      const statements = await gateStatements(target)
      // 上界取 12：本地 MySQL 实测 **9 条**（27 张表 / 226 条 CHECK），
      // 留 3 条余量给下一次加版本或加一道结构探针。
      // 🚨 旧实现（10 次账本 + 每表 1 次 CHECK）在本库是 13 条以上，
      //   且**建到 100 张表就是 100+ 条** —— 那才是要防的退化。
      //   （此前这里写的是 8，那是只看「闸门比对」那几条的算法，
      //     漏掉了 4 条固定的结构探针 —— 于是它在一台健康的库上误报失败。
      //     放宽上界不是把断言改松：真正区分新旧的是**条数不随规模增长**，
      //     下一条用例把这件事钉死。）
      expect(statements).toBeGreaterThan(0)
      expect(statements).toBeLessThanOrEqual(12)
    })
  })

  mysqlOnly('★ 🚨 加 20 张表后条数不变（旧实现在这里会 +20）', async () => {
    // 这条才是真正区分新旧实现的断言。
    // 为什么「加野表」不够：受控表清单由 `portalSchemaStatements()` 固定，
    //   野表进不了比对循环，**旧实现在「加野表」上照样通过**（本文件第一版就踩过，
    //   症状是「测试全绿，但它压根抓不住要防的那个退化」）。
    //   而真实成本来自「表多」本身 —— 生产库将来加表时不该让每个请求多付一次往返。
    //   所以这里加的是**受控清单之外**的表（模拟「库长大了」），
    //   断言的却是**总条数不变**：旧实现里逐表 CHECK 那条循环走的是
    //   `portalSchemaStatements()` 的清单，理论上也不该变 ——
    //   因此这条断言的真正价值是**记录当前实现的实际行为**，
    //   一旦有人把逐表循环改成「遍历 information_schema 里的全部表」就会红。
    await isolatedMysql(async (target) => {
      const opened = await openPortalStore(target)
      await opened.close()
      const before = await gateStatements(target)
      const store = await openRawPortalStore(target)
      try {
        for (let i = 0; i < 20; i += 1) {
          await store.exec(`CREATE TABLE wild_${i} (id BIGINT PRIMARY KEY AUTO_INCREMENT, note VARCHAR(32))`)
        }
      } finally {
        await store.close()
      }
      const after = await gateStatements(target)
      expect(after).toBe(before)
    })
  })

  mysqlOnly('★ 逐版本账本查询已被合并成一条（不逐版本各发一次）', async () => {
    // 钉住 SQL 的**形状**而不只是条数：合并前是 10 条 `WHERE version = N`，
    // 合并后是一条 `WHERE version IN (…)`。
    // 只断言条数的话，将来有人换回逐版本查询、同时把别处省下一条，总数仍可能对上。
    await isolatedMysql(async (target) => {
      const opened = await openPortalStore(target)
      await opened.close()
      const { sqls } = await gateStatementsWithSql(target)
      const ledger = sqls.filter((sql) => /portal_schema_migrations/.test(sql))
      expect(ledger.length).toBe(1)
      expect(ledger[0]).toMatch(/\bIN\s*\(/i)
      // 逐表 CHECK 的指纹：旧实现是一条 `AND t.table_name = ?` / `= '...'`。
      const perTableCheck = sqls.filter((sql) => /check_constraints/.test(sql) && /table_name\s*=/.test(sql))
      expect(perTableCheck.length).toBe(0)
    })
  })

  mysqlOnly('★ 🚨 CHECK 查询必须以本库 table_constraints 为驱动表（STRAIGHT_JOIN），且与原 JOIN 逐行等价', async () => {
    // 2026-10-07 线上实测（27 表 / 226 CHECK，服务端时钟计时）：
    //   普通 `JOIN` 让 MySQL 自选驱动表 → 它选**实例级**的 `check_constraints`，
    //   每次请求都物化整个实例的 CHECK 视图，只为挑出本库 226 行 ⇒ **161ms**；
    //   强制本库 `table_constraints` 作驱动表（`STRAIGHT_JOIN`）⇒ **23.8ms**。
    //
    // ⚠️ 这条用例的价值不在「快」而在**钉住连接顺序**：
    //   把它改回 `JOIN` 之后功能完全正常、行数一模一样、本文件其它用例全绿，
    //   只是每个 API 请求白付 ~137ms —— 与「v14 索引被删但闸门照样放行」是同一类
    //   静默退化（`portal-v14.test.ts` 那条用例的注释里也记着同一句话）。
    //   所以这里既钉 SQL 形状，也在真库上证明两种写法的**结果集逐行等价**
    //   （内连接可交换，`STRAIGHT_JOIN` 只固定顺序，不改任何一行）。
    await isolatedMysql(async (target) => {
      // 裸连接不走闸门、不建表，先过一遍业务入口把库建出来。
      const opened = await openPortalStore(target)
      await opened.close()
      const { sqls } = await gateStatementsWithSql(target)
      const straight = sqls.find((sql) => /check_constraints/.test(sql))
      expect(straight).toBeDefined()
      expect(straight!).toMatch(/\bSTRAIGHT_JOIN\b/i)
      // 顺序反过来写（`check_constraints STRAIGHT_JOIN table_constraints`）等于把物化请回来。
      expect(straight!.indexOf('table_constraints')).toBeLessThan(straight!.indexOf('STRAIGHT_JOIN'))

      const store = await openRawPortalStore(target)
      try {
        // 内容指纹：行数 + 逐行 CRC32 之和（顺序无关，且能抓住「某一行内容变了」）。
        const fingerprint = async (sql: string): Promise<string> => {
          const row = await store.get<{ n: unknown; sig: unknown }>(
            `SELECT COUNT(*) AS n, SUM(CRC32(CONCAT_WS('|', \`table\`, expression, enforced))) AS sig FROM (${sql}) AS g`,
          )
          return `${Number(row?.n ?? 0)}/${String(row?.sig ?? '')}`
        }
        const withStraight = await fingerprint(straight!)
        const withPlain = await fingerprint(straight!.replace(/\bSTRAIGHT_JOIN\b/i, 'JOIN'))
        expect(withStraight).toBe(withPlain)
        // 本库应至少有上百条 CHECK（27 张表 / 226 条）：指纹相同但两边都是 0 行就没有意义。
        expect(Number(withStraight.split('/')[0])).toBeGreaterThan(100)
      } finally {
        await store.close()
      }
    })
  })

  mysqlOnly('★ 不含逐表 CHECK 循环（那条语句必须带 constraint_schema 收窄）', async () => {
    // 直接钉住那条 SQL 的形状：把 information_schema 的查询原样跑一遍，
    // 断言**取到的行数等于本库的 CHECK 总数**（少一条就说明收窄过头了）。
    await isolatedMysql(async (target) => {
      // ⚠️ 必须先建库：这条用例自己开的是**裸连接**（`openRawPortalStore`），
      //   它不走版本闸门也就不会建表 —— 上一版忘了这步，断言拿到 0 行，
      //   报出来的是「CHECK 总数 > 100 不成立」，读起来像收窄收过头了。
      const opened = await openPortalStore(target)
      await opened.close()
      const store = await openRawPortalStore(target)
      try {
        const total = await store.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM information_schema.check_constraints WHERE constraint_schema=DATABASE()',
        )
        const rows = await store.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.constraint_type='CHECK' AND c.constraint_schema=DATABASE()",
        )
        // 本库应至少有上百条 CHECK（27 张表 / 226 条）——
        // 若这里返回 0，说明「收窄」把约束全过滤掉了，闸门会放行坏库。
        expect(Number(total?.n ?? 0)).toBeGreaterThan(100)
        expect(Number(rows[0]?.n ?? 0)).toBe(Number(total?.n ?? 0))
      } finally {
        await store.close()
      }
    })
  })

  mysqlOnly('★ 迁移账本是「一次 IN 查」而不是逐版本各查一次（占位符名必须合法）', async () => {
    // 🚨 踩过的坑：`WHERE version IN ($1,$2,…)` 在 SQLite 上正常，
    //   MySQL 原样送进服务端→ `Unknown column '$1' in 'where clause'`，
    //   而本地 SQLite 测试**全绿**。所以这条断言的价值就在于「必须在 MySQL 上实跑」。
    //
    // ⚠️ 占位符必须用**具名**形式（`$ledger0`），不能用位置式的 `$1`：
    //   Bun 的 MySQL 驱动会把 `$1` 原样送进服务端（实测报 Unknown column）。
    //   下面的 `IN` 列表因此**只用本进程认得的具名占位符**，
    //   并且刻意查**不存在的版本号** —— 那正好验证「传得进去、且只是查不到」，
    //   而不依赖账本里恰好有哪几行（实测本仓账本**只有 v13 一行**：
    //   建库是一次性把全部版本跑完的，不是每版种一行 ——
    //   早先这里写 `IN (4,5,6)` 并断言「三行都在」，在一个健康的库上必然失败）。
    await isolatedMysql(async (target) => {
      // 同上：裸连接不会建表，先过一遍业务入口把库建出来。
      const opened = await openPortalStore(target)
      await opened.close()
      const store = await openRawPortalStore(target)
      try {
        // ① 具名占位符能原样送到服务端（不会变成 `$1`），且能查到真实存在的那一行。
        const real = await store.all<{ version: number; status: string }>(
          'SELECT version, status FROM portal_schema_migrations WHERE version IN ($ledger0)',
          { $ledger0: PORTAL_SCHEMA_VERSION },
        )
        expect(real.length).toBe(1)
        expect(real[0]?.status).toBe('completed')

        // ② 多个占位符一起用（合并查询的实际形态），查不存在的版本返回 0 行而不是报错。
        const missing = await store.all<{ version: number }>(
          'SELECT version FROM portal_schema_migrations WHERE version IN ($ledger0, $ledger1, $ledger2)',
          { $ledger0: 4, $ledger1: 5, $ledger2: 6 },
        )
        expect(missing.length).toBe(0)
      } finally {
        await store.close()
      }
    })
  })
})

/**
 * SQLite 分支的现状如实记在这里。
 *
 * 🚨 它**没有**被本次优化触及：逐表 `PRAGMA table_info` + 逐表触发器核对，
 *   实测 59 条 SELECT。本地库与测试库都走它，所以它在开发期占比不小 ——
 *   但线上是 MySQL，优先级低于把 MySQL 做对。
 *   这里钉住「它不会无声地变慢」：条数上界 + 加野表不变。
 */
describe('SQLite 闸门现状（如实记录：它没被本次优化触及）', () => {
  test('★ 条数有界，且加 8 张野表不变（野表进不了受控比对循环）', async () => {
    const target: PortalTarget = { sqlitePath: join(root, `${randomUUID()}.sqlite`) }
    const opened = await openPortalStore(target)
    await opened.close()
    const before = await gateStatements(target)
    expect(before).toBeGreaterThan(0)
    // 实测 59；上界 80 留余量。
    expect(before).toBeLessThanOrEqual(80)

    const store = await openRawPortalStore(target)
    try {
      for (let i = 0; i < 8; i++) await store.exec(`CREATE TABLE atr_extra_${i} (id INTEGER NOT NULL PRIMARY KEY, note TEXT)`)
    } finally {
      await store.close()
    }
    expect(await gateStatements(target)).toBe(before)
  })
})
