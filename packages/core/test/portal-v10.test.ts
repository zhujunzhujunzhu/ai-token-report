/**
 * 上报库 **v10**：给 `model_price` 补五列闲时（低谷）价（`portal-schema-v10.ts`）。
 *
 * ## 这一版为什么需要单独的用例
 *
 * v10 与 v9 同形（**动既有表**），所以 v9 那三条相互牵制的约束一条不少：
 *
 * 1. **v5 / v7 的 DDL 文本一个字都不许改** —— `portalSchemaChecksumV6/V7/V8/V9`
 *    按它们的当前全文求摘要，改了会让已经迁到那些版本的库从「可迁移的起点」
 *    变成 `unsupported`（服务端拒绝启动）。所以受控定义里的 `model_price`
 *    是在 `portalSchemaStatements()` 里**拼接**出来的，而且要拼在
 *    `portalV7Statements()` 合并**之后**（`model_price` 来自 v7 的追加常量，
 *    在 v5 的基础文本里根本找不到它 —— 在那儿找会静默不拼）。
 * 2. **插入点**必须与 SQLite `ALTER TABLE ... ADD COLUMN` 的改写位置一致
 *    （最后一个列定义之后、第一条表级约束之前）—— `verifyTable()` 在 SQLite 上
 *    按表定义**全文**比对。
 * 3. **幂等**：全新库由受控定义直接产出这五列，只有 v9 库才真的需要 ALTER。
 *
 * ⚠️ MySQL 侧只在 `ATR_V4_TEST_MYSQL_URL` 存在时实跑（每个用例自己的随机隔离
 *   schema），没有连接时**如实跳过** —— 「SQLite 上测过了」不构成 MySQL 的证据。
 *
 * ⚠️ 断言一律对着 `PORTAL_SCHEMA_VERSION`，**不写死版本号**：本文件只关心
 *   「v10 的五列在不在」，而它后面还可能有 v11、v12……（写死会让下一次加版本时
 *   这里误报，而误报的断言比没有断言更糟）。
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
  PORTAL_OFFPEAK_RATE_COLUMNS,
  PORTAL_OFFPEAK_SCHEDULE_COLUMN,
  PORTAL_SCHEMA_VERSION,
  portalSchemaChecksum,
  portalSchemaChecksumV9,
  portalSchemaStatements,
  portalV10AddColumnStatements,
  portalV7Statements as portalV7StatementsFor,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v10-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/** 每个用例一个随机隔离 schema（`ATR_V4_TEST_MYSQL_URL` 是管理连接，不是目标库）。 */
async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_portal_v10_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_portal_v10_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

const OFFPEAK_COLUMNS = [PORTAL_OFFPEAK_SCHEDULE_COLUMN, ...PORTAL_OFFPEAK_RATE_COLUMNS]

async function columnsOf(target: PortalTarget, table: string): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    return store.kind === 'sqlite'
      ? (await store.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name)
      : (await store.all<{ name: string }>(
        'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=$table',
        { $table: table },
      )).map((row) => row.name)
  } finally {
    await store.close()
  }
}

/** 造一个**真 v9 库**：结构与当版一致，只是 `model_price` 还没那五列。 */
async function createV9(target: PortalTarget): Promise<void> {
  await preparePortalDatabase(target)
  const store = await openRawPortalStore(target)
  try {
    for (const column of OFFPEAK_COLUMNS) {
      await store.exec(`ALTER TABLE model_price DROP COLUMN ${column}`)
    }
    await store.run(
      `INSERT INTO model_price (price_id, provider, model, currency,
         input_micro_per_ktok, output_micro_per_ktok, cache_read_micro_per_ktok, cache_write_micro_per_ktok,
         effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms)
       VALUES ($id, 'deepseek-official', 'deepseek-flash', 'CNY', 2000, 8000, 40, 0, 0, NULL, '历史价', 1, 1)`,
      { $id: randomUUID() },
    )
    // 账本改回 v9：**删掉所有 version > 9 的行**（只删一行会让 `current` 仍为真，
    // 库会被判成 unsupported 而不是 legacy —— 见 AGENTS.md 里那条实测记录）。
    await store.run('DELETE FROM portal_schema_migrations WHERE version > 9', {})
    await store.run(
      "INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,9,$hash,'completed',1,$checkpoint,1,1)",
      { $id: randomUUID(), $hash: portalSchemaChecksumV9(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) },
    )
    if (store.kind === 'sqlite') await store.exec('PRAGMA user_version=9')
    else await store.run('UPDATE portal_meta SET schema_version=9 WHERE id=1', {})
  } finally {
    await store.close()
  }
}

describe('v10：全新库直接带闲时五列（受控定义拼接）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] 全新库 = 当前版本，五列都在且可空`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const state = await inspectPortalDatabase(target)
        expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(state.status).toBe('current')
        const columns = await columnsOf(target, 'model_price')
        for (const column of OFFPEAK_COLUMNS) expect(columns, `model_price 缺少 ${column}`).toContain(column)
        // 五列都必须**可空**：老价行读出来就是「不分时段」，不是「闲时四类价 = 0 元」
        const store = await openRawPortalStore(target)
        try {
          await store.run(
            'INSERT INTO model_price (price_id,provider,model,currency,input_micro_per_ktok,output_micro_per_ktok,cache_read_micro_per_ktok,cache_write_micro_per_ktok,effective_from_ms,effective_to_ms,note,created_at_ms,updated_at_ms) VALUES ($id,$p,$m,$c,1,1,1,1,0,NULL,NULL,1,1)',
            { $id: randomUUID(), $p: 'p', $m: 'm', $c: 'CNY' },
          )
          const row = await store.get<Record<string, unknown>>('SELECT * FROM model_price WHERE provider=$p', { $p: 'p' })
          for (const column of OFFPEAK_COLUMNS) expect(row?.[column] ?? null, column).toBeNull()
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v10：v9 → 当前版本迁移（补列、幂等、历史价行不分时段）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] v9 库被判成可迁移的 legacy，迁移后补出五列且历史价行仍是不分时段`, async () => {
      await run(async (target) => {
        await createV9(target)
        const before = await inspectPortalDatabase(target)
        expect(before.version).toBe(9)
        expect(before.status, '冻结的 v9 摘要必须让它被认成「上一版、可迁移」').toBe('legacy')
        for (const column of OFFPEAK_COLUMNS) expect(await columnsOf(target, 'model_price')).not.toContain(column)

        const migrated = await migratePortalDatabase(target, { confirmOffline: true })
        expect(migrated.status).toBe('current')
        expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)

        const columns = await columnsOf(target, 'model_price')
        for (const column of OFFPEAK_COLUMNS) expect(columns, `缺列 ${column}`).toContain(column)

        const store = await openRawPortalStore(target)
        try {
          const ledger = await store.get<{ checksum: string }>('SELECT checksum FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
          expect(ledger?.checksum).toBe(portalSchemaChecksum(store.kind))
          // 历史价行一个字节都没被动过：迁到 v10 之后它仍然「不分时段」
          const row = await store.get<Record<string, unknown>>("SELECT * FROM model_price WHERE model='deepseek-flash'")
          expect(row?.provider).toBe('deepseek-official')
          expect(Number(row?.input_micro_per_ktok)).toBe(2_000)
          expect(row?.offpeak_schedule ?? null).toBeNull()
          expect(row?.offpeak_input_micro_per_ktok ?? null).toBeNull()
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
        const columns = await columnsOf(target, 'model_price')
        for (const column of OFFPEAK_COLUMNS) {
          expect(columns.filter((name) => name === column)).toHaveLength(1)
        }
      })
    })
  }
})

describe('v10：受控定义与摘要的关系（静态护栏，不需要数据库）', () => {
  test('受控定义里 model_price 带闲时五列，且插在第一条表级约束之前', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statement = portalSchemaStatements(kind).find((sql) => sql.startsWith('CREATE TABLE model_price ('))
      expect(statement, `${kind} 缺少 model_price 定义`).toBeDefined()
      for (const column of OFFPEAK_COLUMNS) expect(statement!).toContain(`  ${column} `)
      const lines = statement!.split('\n')
      const constraintAt = lines.findIndex((line) => /^ {2}(FOREIGN KEY|CHECK|UNIQUE|PRIMARY KEY)\b/.test(line))
      for (const column of OFFPEAK_COLUMNS) {
        const at = lines.findIndex((line) => line.startsWith(`  ${column} `))
        expect(at, `${column} 不在受控定义里`).toBeGreaterThan(0)
        expect(at, `${column} 必须在第一条表级约束之前（SQLite 的 ADD COLUMN 就追加在那里）`).toBeLessThan(constraintAt)
      }
      // 拼接必须发生在 v7 追加**之后**：v7 的原文里没有这五列（它已冻结），
      // 所以在 v5 的基础文本里找 `CREATE TABLE model_price (` 会**静默找不到**。
      const v7Only = portalV7StatementsFor(kind).find((sql) => sql.startsWith('CREATE TABLE model_price ('))!
      for (const column of OFFPEAK_COLUMNS) expect(v7Only, `v7 原文不该含 ${column}`).not.toContain(`  ${column} `)
    }
  })

  test('★ 当前摘要 ≠ 冻结的 v9 摘要（否则已经迁到 v9 的库会被误判成 current）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV9(kind))
    }
  })

  test('加列语句逐字正确：可空、带约束、一列一条 ALTER', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statements = portalV10AddColumnStatements(kind)
      expect(statements).toHaveLength(OFFPEAK_COLUMNS.length)
      for (const [index, statement] of statements.entries()) {
        expect(statement).toStartWith('ALTER TABLE model_price ADD COLUMN ')
        expect(statement).toContain(OFFPEAK_COLUMNS[index]!)
        // 🚨 绝不能带 NOT NULL：老价行没有值，加非空列会让整条迁移在真实库上失败
        expect(statement).not.toContain('NOT NULL')
      }
      // 四类单价要带值域 CHECK（与共享常量 MAX_MICRO_PER_KTOK 同值）
      for (const statement of statements.slice(1)) expect(statement).toContain('10000000')
      // 时段表那列是 VARCHAR(64)（SQLite 是 TEXT），并限制长度在 1–64
      expect(statements[0]).toContain(kind === 'mysql' ? 'VARCHAR(64)' : 'TEXT')
      expect(statements[0]).toContain('BETWEEN 1 AND 64')
    }
  })
})
