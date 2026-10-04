/**
 * 上报库 **v14** 的不变量：`usage_event(source)` 单列索引。
 *
 * ## 为什么这一版值得单开一个文件
 *
 * 因为它是**被线上实测数据逼出来**的一版，不是「预计会有用」：
 * 线上（19.7 万行）`SELECT DISTINCT source`（筛选栏那个下拉框，
 * `GET /api/v1/stats/sources`）是 `type=ALL / rows=224453 / Using temporary`，
 * 656 次调用累计 **120.1 秒**、单次最大 0.5 秒 —— 慢查询日志里的**第一名**，
 * 比所有聚合查询加起来还多。而它服务的是一个「打开看板必发」的候选列表。
 *
 * 本机隔离库实测（20 万行 / 来源基数 4）：13ms → **0~1ms**，
 * 执行计划变成 `type=range / rows=4 / Using index for group-by`
 * （MySQL 的 **loose index scan**：读 4 个索引项，**与表多大无关**）。
 *
 * ## 🚨 最容易犯的错是「顺手加第二列」
 *
 * 把索引写成 `(source, ts)` 是很自然的直觉（反正也要按时间筛），
 * 但它会让 loose index scan **完全失效** —— 实测退回 `Using temporary`、
 * 20 万行仍是 13ms，**零收益**。所以下面有一条断言专门钉住「只有一列」。
 *
 * 断言一律对着 `PORTAL_SCHEMA_VERSION` / 常量，**不写死 14**：
 * 下一版加 DDL 时这里不该误报（v13 测试就因为写死版本号而误报过一次）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openPortalStore,
  type PortalTarget,
} from '../src/db/portal-db.js'
import { openRawPortalStore, type PortalStore } from '../src/db/portal-connection.js'
import { closeAllMysqlBackends, openMysqlBackend } from '../src/db/mysql.js'
import {
  inspectPortalDatabase,
  migratePortalDatabase,
  preparePortalDatabase,
} from '../src/db/portal-db.js'
import { ensurePortalReady } from '../src/db/portal-migrations.js'
import {
  PORTAL_SCHEMA_VERSION,
  PORTAL_SOURCE_INDEX,
  PORTAL_SOURCE_INDEX_COLUMNS,
  portalSchemaChecksum,
  portalSchemaChecksumV13,
  portalSchemaStatements,
  portalSourceIndex,
  portalV14ChecksumInput,
  portalV14Statements,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v14-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

interface TargetCase { label: 'sqlite' | 'mysql'; run: (fn: (target: PortalTarget) => Promise<void>) => Promise<void> }

async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_v14_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_v14_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

const mysqlOnly = (name: string, fn: () => Promise<void>) => (mysqlUrl ? test : test.skip)(name, fn)

/**
 * 某个索引当前的列组合（`index_info` 语义：按 `seq_in_index` 拼）。
 *
 * ⚠️ 两个后端**列名的 key 不一样**（`name` vs `col`），而 `PortalStore` 的
 *   行类型在两个驱动上都是宽松的记录 —— 写成 `row.kind === 'sqlite' ? row.name : row.col`
 *   在 SQLite 上能过、在 MySQL 上也对，唯独**一旦 store 是事务包装**（`PortalStore`
 *   的 `transaction` 会回传另一个 `PortalStore`）就可能拿到没有 `kind` 的行，
 *   于是 `row.name` 恒 `undefined`、断言报「Expected "source", Received "undefined"」——
 *   从报错里完全看不出是取错了字段。显式按后端分派更省事也更诚实。
 */
async function indexColumns(store: PortalStore, table: string, index: string): Promise<string[]> {
  if (store.kind === 'sqlite') {
    const rows = await store.all<{ name: string | null }>(`PRAGMA index_info(${index})`)
    return rows.map(row => String(row.name ?? '').toLowerCase()).filter(Boolean)
  }
  const rows = await store.all<{ col: string }>(
    'SELECT column_name AS col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND index_name=$index ORDER BY seq_in_index',
    { $table: table, $index: index },
  )
  return rows.map(row => String(row.col ?? '').toLowerCase()).filter(Boolean)
}

describe('v14：受控定义（纯逻辑，不碰库）', () => {
  test('★ 索引只有 source 一列（加第二列会让 loose index scan 失效）', () => {
    // 🚨 这条是本文件的核心。它防的是「顺手写成 (source, ts)」——
    //   那个组合在功能上完全正常、DDL 也能建出来，但 `SELECT DISTINCT source`
    //   会退回 `Using temporary` + 全表扫描，**收益精确地归零而无任何报错**。
    //   （实测：20 万行 13ms，`EXPLAIN` 里没有 `Using index for group-by`。）
    expect(PORTAL_SOURCE_INDEX_COLUMNS).toBe('source')
    const sql = portalSourceIndex()
    const columns = /\(([^)]+)\)/.exec(sql)?.[1]?.split(',').map(part => part.trim()) ?? []
    expect(columns).toEqual(['source'])
    expect(sql).toContain(PORTAL_SOURCE_INDEX)
  })

  test('★ 两种后端的索引语句逐字相同（没有方言差异可写）', () => {
    // 这是本版本**没有** `kind` 参数的原因。两个后端如果哪天真的需要分开写，
    // 那条测试会红，提示要把 `kind` 加回签名 —— 而不是悄悄在某处写死一个后端。
    expect(portalV14ChecksumInput('sqlite')).toBe(portalV14ChecksumInput('mysql'))
    expect(portalV14Statements()).toEqual([portalSourceIndex()])
  })

  test('★ 受控语句清单里它恰好出现一次，且不是唯一索引', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statements = portalSchemaStatements(kind)
      expect(statements.filter(sql => sql === portalSourceIndex())).toHaveLength(1)
      // ⚠️ 必须是**普通**索引：`verifyMysqlUniqueConstraints()` 会把受控语句里
      //   所有 `CREATE UNIQUE INDEX` 收进「期望的唯一约束」集合，
      //   一个普通索引混进去会让真实 MySQL 上的闸门永远判「唯一约束不一致」。
      expect(portalSourceIndex().startsWith('CREATE INDEX ')).toBe(true)
    }
  })

  test('★ 当前摘要已含 v14，且与冻结的 v13 摘要不同（否则 v13 库会被误判成 current）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV13(kind))
    }
  })
})

describe('v14：两个后端都必须成立', () => {
  for (const backend of cases()) {
    describe(backend.label, () => {
      test('★ 新建的库自带这个索引，且列组合受控', async () => {
        await backend.run(async (target) => {
          const opened = await openPortalStore(target)
          try {
            const columns = await indexColumns(opened, 'usage_event', PORTAL_SOURCE_INDEX)
            expect(columns.join(',')).toBe(PORTAL_SOURCE_INDEX_COLUMNS)
          } finally {
            await opened.close()
          }
        })
      })

      test('★ 反复过闸门不会漂移（幂等：没有隐藏自愈、也没有每次重建）', async () => {
        await backend.run(async (target) => {
          // ⚠️ 每一轮的 store 都必须 `close()`：Windows 上 `close()` 之后文件句柄
          //   不会立即释放（见 `stats.ts` 的 `resetDb()` 注释），漏关任何一个都会让
          //   本文件末尾的 `rmSync(root)` 报 EBUSY —— 而那是一条**与被测行为无关**的
          //   失败，读起来却像「索引测试没过」，把排查方向带偏。
          for (let round = 0; round < 3; round += 1) {
            const once = await openPortalStore(target)
            try { await ensurePortalReady(once) } finally { await once.close() }
          }
          const opened = await openPortalStore(target)
          try {
            const columns = await indexColumns(opened, 'usage_event', PORTAL_SOURCE_INDEX)
            expect(columns.join(',')).toBe(PORTAL_SOURCE_INDEX_COLUMNS)
          } finally {
            await opened.close()
          }
        })
      })

      test('★ 迁移到当前版本后，索引在且受控', async () => {
        await backend.run(async (target) => {
          await migratePortalDatabase(target, { confirmOffline: true })
          const state = await inspectPortalDatabase(target)
          expect(state.status).toBe('current')
          expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
          const opened = await openPortalStore(target)
          try {
            const columns = await indexColumns(opened, 'usage_event', PORTAL_SOURCE_INDEX)
            expect(columns.join(',')).toBe(PORTAL_SOURCE_INDEX_COLUMNS)
          } finally {
            await opened.close()
          }
        })
      })
    })
  }
})

describe('v14：MySQL 专属（SQLite 上测过了不构成证据）', () => {
  mysqlOnly('★ 🚨 索引被删 ⇒ 闸门必须拒绝（不是「慢一点」，是部署没生效却报成功）', async () => {
    // 这是本版本最需要被钉住的一条：索引缺失时 `SELECT DISTINCT source`
    // 退化成全表扫描（线上 13ms → 0ms 的收益归零），而闸门若照样放行，
    // 运维看到的是「迁移成功」—— 于是这个优化**悄无声息地不存在**。
    await isolatedMysql(async (target) => {
      await preparePortalDatabase(target)
      const store = await openRawPortalStore(target)
      try {
        await store.exec(`DROP INDEX ${PORTAL_SOURCE_INDEX} ON usage_event`)
      } finally {
        await store.close()
      }
      let rejected: unknown = null
      try {
        const opened = await openPortalStore(target)
        await opened.close()
      } catch (error) {
        rejected = error
      }
      expect(rejected).not.toBeNull()
      expect(String((rejected as Error)?.message ?? '')).toContain(PORTAL_SOURCE_INDEX)
    })
  })

  mysqlOnly('★ 同名但列不同（(source, ts)）⇒ 闸门必须拒绝', async () => {
    // 承上：那个「顺手加第二列」的写法在功能上完全正常，只有闸门能抓住它 ——
    //   而抓不住的后果恰好是本版本要治的那个病复发。
    await isolatedMysql(async (target) => {
      await preparePortalDatabase(target)
      const store = await openRawPortalStore(target)
      try {
        await store.exec(`DROP INDEX ${PORTAL_SOURCE_INDEX} ON usage_event`)
        await store.exec(`CREATE INDEX ${PORTAL_SOURCE_INDEX} ON usage_event (source, ts)`)
      } finally {
        await store.close()
      }
      let rejected: unknown = null
      try {
        const opened = await openPortalStore(target)
        await opened.close()
      } catch (error) {
        rejected = error
      }
      expect(rejected).not.toBeNull()
      expect(String((rejected as Error)?.message ?? '')).toContain(PORTAL_SOURCE_INDEX)
    })
  })

  mysqlOnly('★ 🚨 `DISTINCT source` 走 loose index scan（`Using index for group-by`）', async () => {
    // 这条是**收益**的证据，而不只是「索引存在」。
    // 只断言索引存在是不够的：索引建上了但优化器不用它（统计信息陈旧、
    // 或列基数估算失真）时，功能全对而收益为零。
    //
    // 🚨 造数用「seq 表 + 笛卡尔放大」而不是递归 CTE：
    //   `cte_max_recursion_depth` 默认 1000，`WITH RECURSIVE … n < 10000`
    //   直接 errno 3636（本文件第一版就这么写，实测报错）。
    await isolatedMysql(async (target) => {
      // ⚠️ 必须先建库：这条用例开的是**裸连接**（`openRawPortalStore`），
      //   它不走版本闸门也就不会建表 —— 少了这步第一条 `information_schema` 查询
      //   就报「表不存在」，而报错完全不提「是库还没建」。
      await preparePortalDatabase(target)
      const store = await openRawPortalStore(target)
      try {
        const columns = await store.all<{ name: string }>(
          "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event'",
        )
        const required = ['event_id', 'session_id', 'seq', 'ts', 'provider', 'model', 'source', 'input_tokens', 'output_tokens', 'received_at_ms']
        const present = new Set(columns.map(row => row.name))
        for (const name of required) {
          if (!present.has(name)) { await store.exec(`ALTER TABLE usage_event ADD COLUMN ${name} VARCHAR(64) NULL`); }
        }
        await store.exec('CREATE TABLE IF NOT EXISTS atr_v14_seed (n INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
        await store.exec('DELETE FROM atr_v14_seed')
        await store.exec('INSERT INTO atr_v14_seed (n) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 1000) SELECT n FROM s')
        const before = Number((await store.get<{ c: number }>('SELECT COUNT(*) AS c FROM usage_event'))?.c ?? 0)
        // 造 2 万行（1000 × 20），来源基数 4 —— 足以让 loose scan 与全表扫描拉开数量级
        if (before < 20000) {
          await store.exec(`INSERT INTO usage_event (event_id, session_id, seq, ts, provider, model, source, input_tokens, output_tokens, received_at_ms)
            SELECT CONCAT('v14-', LPAD(k.i * 1000 + s.n, 12, '0')), CONCAT('vs', (k.i * 1000 + s.n) % 300), (k.i * 1000 + s.n),
                   1775534024500 + (k.i * 1000 + s.n) * 1000, 'p', 'm', ELT(1 + (k.i + s.n) % 4, 'dsh','codex','claude-code','workbuddy'),
                   100, 50, 1775534024500
              FROM atr_v14_seed s CROSS JOIN (SELECT a.n + b.n*10 + c.n*100 AS i
                                                FROM atr_v14_seed a, atr_v14_seed b, atr_v14_seed c
                                               WHERE a.n < 2 AND b.n < 2 AND c.n < 10) k`)
        }
        await store.exec('DROP TABLE atr_v14_seed')
        await store.exec('ANALYZE TABLE usage_event')

        const plans = await store.all<{ type: string; rows: number; Extra: string }>(
          'EXPLAIN SELECT DISTINCT source FROM usage_event ORDER BY source',
        )
        expect(plans.length).toBeGreaterThan(0)
        const plan = plans[0]!
        // `Using index for group-by` = loose index scan：读「来源个数」个索引项，
        // 与表多大无关。这正是本版本存在的全部理由。
        expect(String(plan.Extra)).toContain('Using index for group-by')
        // 它必须是索引扫描而不是全表：基数 4 ⇒ 读的行数应是**个位/十位**，
        // 而线上 22 万行时旧计划读的是 224453 行。
        expect(Number(plan.rows)).toBeLessThan(1000)

        // 终态自检：走索引之后拿到的来源集合必须与全表扫描**逐字相同**。
        //（索引只改「怎么读」，不改「读到什么」—— 但这条断言要在真 MySQL 上钉住它。）
        const viaIndex = (await store.all<{ source: string }>('SELECT DISTINCT source FROM usage_event ORDER BY source')).map(row => String(row.source))
        await store.exec(`DROP INDEX ${PORTAL_SOURCE_INDEX} ON usage_event`)
        const viaScan = (await store.all<{ source: string }>('SELECT DISTINCT source FROM usage_event ORDER BY source')).map(row => String(row.source))
        await store.exec(portalSourceIndex())
        expect(viaIndex).toEqual(viaScan)
        expect(viaIndex.length).toBeGreaterThan(0)
      } finally {
        await store.close()
      }
    })
  })
})
