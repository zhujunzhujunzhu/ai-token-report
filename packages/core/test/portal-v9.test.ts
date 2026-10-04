/**
 * 上报库 **v9**：`usage_event.source`（这条用量是哪个客户端写的）。
 *
 * ## 这一版为什么需要单独的用例（而 v6 / v7 / v8 只靠 v5 那一套就够）
 *
 * v6 / v7 / v8 都是「只加表」，而 **v9 是本仓第一次给既有表加列**，它同时压着三条
 * 相互牵制的约束（细节见 `portal-schema-v9.ts` 的文件头）：
 *
 * 1. **v5 的 DDL 文本一个字都不许改** —— `portalSchemaChecksumV6/V7` 按它的当前全文
 *    求摘要，改了会让已经迁到 v6 / v7 的库（包括线上库）从「可迁移的起点」变成
 *    `unsupported`（服务端拒绝启动）；
 * 2. 因此受控定义里的 `usage_event` 是**拼接**出来的，而插入点被 SQLite 的
 *    `ALTER TABLE ... ADD COLUMN` 改写规则钉住 —— `verifyTable()` 在 SQLite 上按
 *    表定义**全文**比对，位置不对就会「迁移做完了却判失败」；
 * 3. 迁移必须**幂等**：全新库与 v5 之前的老库走的是「受控定义本来就带 source」那条路，
 *    只有 v8 库才真的需要 ALTER。
 *
 * 三条都在本文件里被钉住：全新库的终态核验（含 `session-log-generations` 之外的
 * 受控校验）、v8→v9 的真实迁移、以及历史行按 `'dsh'` 兜底。
 *
 * ⚠️ MySQL 侧只跑 `ATR_V4_TEST_MYSQL_URL` 存在时的分支（与 `portal-v5.test.ts` 同一套夹具：
 *   管理连接 + **每个用例自己的随机隔离 schema**），没有连接时**如实跳过**，不假装通过。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  inspectPortalDatabase,
  migratePortalDatabase,
  preparePortalDatabase,
  type PortalTarget,
} from '../src/db/portal-db.js'
import { openRawPortalStore } from '../src/db/portal-connection.js'
import { closeAllMysqlBackends, openMysqlBackend } from '../src/db/mysql.js'
import {
  PORTAL_SCHEMA_VERSION,
  PORTAL_SOURCE_COLUMN,
  PORTAL_SOURCE_DEFAULT,
  portalSchemaChecksum,
  portalSchemaChecksumV8,
  portalSchemaStatements,
  portalSourceColumnLine,
  portalV9AddColumnStatement,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v9-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/**
 * 🚨 `ATR_V4_TEST_MYSQL_URL` 是**管理连接**（本机开发容器里指 `information_schema`），
 *   不是「拿来当上报库用」的目标库 —— 直接把 portal 表建在那个 schema 上，
 *   轻则 `unsupported, 版本 0`（本次实测就是这个），重则往一个共用的系统/业务库里
 *   写 portal 表。所以每个用例都在自己的**随机隔离 schema** 里跑，用完删掉
 *   （与 `portal-v5.test.ts` / `portal-batch-ingest.test.ts` 同一套夹具）。
 *
 * ⚠️ 这条只有**活体 MySQL** 才暴露：SQLite 分支完全没有「schema」这一层，
 *   单跑 `bun test`（无连接时整段 skip）永远看不见它。
 */
async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_portal_v9_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_portal_v9_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

/** 一个用例形态：SQLite 用一次性临时文件，MySQL 用一次性隔离 schema。 */
interface TargetCase {
  label: 'sqlite' | 'mysql'
  run: (fn: (target: PortalTarget) => Promise<void>) => Promise<void>
}

const cases = (): TargetCase[] => {
  const list: TargetCase[] = [{
    label: 'sqlite',
    run: async (fn) => { await fn({ sqlitePath: join(root, `${randomUUID()}.sqlite`) }) },
  }]
  if (mysqlUrl) list.push({ label: 'mysql', run: isolatedMysql })
  return list
}

/** 造一个**真 v8 库**：结构与当版一致，只是 `usage_event` 还没有 source 列。 */
async function createV8(target: PortalTarget, events: { eventId: string; provider: string }[]): Promise<void> {
  await preparePortalDatabase(target)
  const store = await openRawPortalStore(target)
  try {
    // 1) 先把当版的库建成，再**摘掉** v9 那一列 —— 这样得到的是一份
    //    结构与真实 v8 完全一致的库（列序、约束、索引都由同一条 DDL 产出），
    //    而不是手抄一份容易漂移的 v8 DDL。
    //
    // 🚨 **v14 起必须先删掉 `idx_usage_event_source`**（2026-10-04 踩到）：
    //   两个后端都拦「删掉仍有索引的列」，但**报错完全不同**：
    //     · SQLite：`error in index idx_usage_event_source after drop column:
    //       no such column: source`（errno 1）—— 它**不会**顺手清索引；
    //     · MySQL：errno 1091（Can't DROP 'source'; check that it exists）。
    //   而**两条 `DROP INDEX` 的语法本身也不一样**，这是本条用例真正的坑：
    //     · SQLite：`DROP INDEX IF EXISTS <名>`
    //     · MySQL：**没有** `IF EXISTS`，且必须带 `ON <表>`
    //       （`DROP INDEX IF EXISTS x` 直接 errno 1064 语法错 —— 实测踩过）。
    //   所以这里按 `store.kind` 分派，两边各自用本后端的合法写法。
    //   ⚠️ v9 迁移本身只**加**列、从不删列，这一步纯粹是为了「造出一份真 v8 库」。
    if (store.kind === 'sqlite') {
      await store.exec('DROP INDEX IF EXISTS idx_usage_event_source')
    } else {
      // MySQL 侧先查存在性（`DROP INDEX` 没有 IF EXISTS，索引不存在会 errno 1091）。
      const present = await store.all<{ name: string }>(
        'SELECT index_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=\'usage_event\' AND index_name=\'idx_usage_event_source\'',
      )
      if (present.length > 0) await store.exec('DROP INDEX idx_usage_event_source ON usage_event')
    }
    await store.exec(`ALTER TABLE usage_event DROP COLUMN ${PORTAL_SOURCE_COLUMN}`)
    for (const event of events) {
      await store.run(
        "INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ($id,'会话',1,100,$provider,'mod',NULL,11,22,33,44,2,-1,-2)",
        { $id: event.eventId, $provider: event.provider },
      )
    }
    // 2) 账本改回 v8：删掉当前版本的完成行，写入 v8 的完成行 + 冻结摘要。
    await store.run('DELETE FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
    await store.run(
      "INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,8,$hash,'completed',1,$checkpoint,1,1)",
      { $id: randomUUID(), $hash: portalSchemaChecksumV8(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) },
    )
    if (store.kind === 'sqlite') await store.exec('PRAGMA user_version=8')
    else await store.run('UPDATE portal_meta SET schema_version=8 WHERE id=1', {})
  } finally {
    await store.close()
  }
}

describe('v9：全新库直接带 source 列（受控定义拼接）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] 全新库 = 当前版本，usage_event.source 存在且默认 dsh`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const state = await inspectPortalDatabase(target)
        expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(state.status).toBe('current')
        const store = await openRawPortalStore(target)
        try {
          const columns = store.kind === 'sqlite'
            ? await store.all<{ name: string; dflt_value: string | null; notnull: number }>('PRAGMA table_info(usage_event)')
            : await store.all<{ name: string; dflt_value: string | null; notnull: number }>(
              // ⚠️ MySQL 必须显式 `ORDER BY ordinal_position`：`information_schema.columns`
              //   的返回顺序没有任何保证，而下面那条断言比的是「最后一列」。
              "SELECT column_name AS name,column_default AS dflt_value,(is_nullable='NO') AS notnull FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='usage_event' ORDER BY ordinal_position",
            )
          const source = columns.find(column => column.name === PORTAL_SOURCE_COLUMN)
          expect(source, 'usage_event 缺少 source 列').toBeDefined()
          expect(source!.notnull).toBe(1)
          expect(String(source!.dflt_value)).toContain(PORTAL_SOURCE_DEFAULT)
          // 列序：受控定义把它放在**最后一个事实列之后**（SQLite 的 ALTER 改写位置）。
          expect(columns[columns.length - 1]!.name).toBe(PORTAL_SOURCE_COLUMN)
          // 不写 source 的插入必须落成 dsh（老客户端的 shape 仍然可写）。
          await store.run(
            "INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ('新:1','会话',1,100,'p','m',NULL,1,2,3,4,0,NULL,NULL)",
            {},
          )
          const row = await store.get<{ source: string }>("SELECT source FROM usage_event WHERE event_id='新:1'")
          expect(row?.source).toBe(PORTAL_SOURCE_DEFAULT)
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v9：v8 → v9 迁移（补列、幂等、历史行兜底）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] v8 库被判成可迁移的 legacy，迁移后补出 source 且历史行 = dsh`, async () => {
      await run(async (target) => {
        await createV8(target, [{ eventId: '历史:1', provider: 'prov' }])
        const before = await inspectPortalDatabase(target)
        expect(before.version).toBe(8)
        expect(before.status, '冻结的 v8 摘要必须让它被认成「上一版、可迁移」').toBe('legacy')
        expect(before.eventCount).toBe(1)

        const migrated = await migratePortalDatabase(target, { confirmOffline: true })
        expect(migrated.status).toBe('current')
        expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)

        const store = await openRawPortalStore(target)
        try {
          const ledger = await store.get<{ checksum: string }>('SELECT checksum FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
          expect(ledger?.checksum).toBe(portalSchemaChecksum(store.kind))
          // 历史行按事实兜底：v9 之前只收过 DSH 上报。
          const row = await store.get<{ source: string }>("SELECT source FROM usage_event WHERE event_id='历史:1'")
          expect(row?.source).toBe(PORTAL_SOURCE_DEFAULT)
          // 事件原值一个字节都没被动过（迁移只加列）。
          const tokens = await store.get<{ input_tokens: number; cache_write_tokens: number }>(
            "SELECT input_tokens,cache_write_tokens FROM usage_event WHERE event_id='历史:1'",
          )
          expect(Number(tokens?.input_tokens)).toBe(11)
          expect(Number(tokens?.cache_write_tokens)).toBe(44)
          // 补出来的列要真的能用：写一条 codex 的用量并读回来。
          await store.run(
            "INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,source,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ('新:2','会话',1,100,'openai','gpt-5-codex',NULL,'codex',1,2,3,4,0,NULL,NULL)",
            {},
          )
          const codex = await store.get<{ source: string }>("SELECT source FROM usage_event WHERE event_id='新:2'")
          expect(codex?.source).toBe('codex')
        } finally {
          await store.close()
        }
      })
    })

    test(`[${label}] 迁移是幂等的：再跑一次仍是 current，列不会被重复添加`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const first = await migratePortalDatabase(target, { confirmOffline: true })
        expect(first.status).toBe('current')
        const second = await migratePortalDatabase(target, { confirmOffline: true })
        expect(second.status).toBe('current')
        const store = await openRawPortalStore(target)
        try {
          const columns = store.kind === 'sqlite'
            ? await store.all<{ name: string }>('PRAGMA table_info(usage_event)')
            : await store.all<{ name: string }>('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=\'usage_event\'')
          expect(columns.filter(column => column.name === PORTAL_SOURCE_COLUMN)).toHaveLength(1)
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v9：受控定义与摘要的关系（三条护栏）', () => {
  test('受控定义里 usage_event 带 source，而 v5 常量里没有（冻结摘要不被改动）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statement = portalSchemaStatements(kind).find(sql => sql.startsWith('CREATE TABLE usage_event ('))
      expect(statement, `${kind} 缺少 usage_event 定义`).toBeDefined()
      expect(statement!).toContain(`${PORTAL_SOURCE_COLUMN} `)
      // 插入点：在第一个表级约束之前（SQLite 的 ADD COLUMN 正是追加在那里）。
      const constraintAt = statement!.split('\n').findIndex(line => /^ {2}(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/.test(line))
      const sourceAt = statement!.split('\n').findIndex(line => line.startsWith(`  ${PORTAL_SOURCE_COLUMN} `))
      expect(sourceAt).toBeGreaterThan(0)
      expect(sourceAt).toBeLessThan(constraintAt)
    }
  })

  test('当前摘要 ≠ 冻结的 v8 摘要（否则已经迁到 v8 的库会被误判成 current）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV8(kind))
    }
  })

  /**
   * ★ 两种后端的**加列语句文本**单独钉住（这一组不需要活体数据库）。
   *
   * 🚨 为什么值得一条静态断言：MySQL 的 `TEXT` **不能有 DEFAULT**
   *   （8.0.13 起只有表达式默认值 `DEFAULT ('dsh')`，那是另一种方言形状），
   *   所以 MySQL 必须写 `VARCHAR(32)`。写错的后果是**迁移在真实 MySQL 上直接语法错**，
   *   而 SQLite 侧一切正常 —— 正是本仓反复强调的「SQLite 上测过了不构成证据」。
   *   静态文本断言不能替代活体 MySQL 实跑，但它能在 CI 里当场拦住这种手滑。
   */
  test('加列语句逐字正确：SQLite 用 TEXT、MySQL 用 VARCHAR(32)（TEXT 在 MySQL 不能有 DEFAULT）', () => {
    expect(portalSourceColumnLine('sqlite').trim()).toBe(`source TEXT NOT NULL DEFAULT 'dsh',`)
    expect(portalSourceColumnLine('mysql').trim()).toBe(`source VARCHAR(32) NOT NULL DEFAULT 'dsh',`)
    expect(portalV9AddColumnStatement('sqlite')).toBe("ALTER TABLE usage_event ADD COLUMN source TEXT NOT NULL DEFAULT 'dsh'")
    expect(portalV9AddColumnStatement('mysql')).toBe("ALTER TABLE usage_event ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'dsh'")
    // 列定义里**不带** CHECK：MySQL 的内联 CHECK 会被自动命名，而
    // `verifyCurrentMysql` 是按 CHECK 表达式核对的 —— 那又是一条只有活体 MySQL 才暴露的路径。
    // 值域的校验落在上报路由（形状 + 受控枚举）。
    expect(portalV9AddColumnStatement('mysql')).not.toContain('CHECK')
    expect(portalV9AddColumnStatement('sqlite')).not.toContain('CHECK')
  })
})
