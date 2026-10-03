/**
 * 上报库 **v11**：追加 `project_alias`（项目归一化规则）与权限码 `projects:*`
 * （`portal-schema-v11.ts`）。
 *
 * ## 这一版为什么需要单独的用例
 *
 * v11 与 v6 / v7 / v8 同形（**纯追加**：只建表 + 建索引 + 补权限行，
 * 既有表一个字节都不动），所以那几条相互牵制的约束一条不少：
 *
 * 1. **v5 / v6 / v7 的 DDL 文本一个字都不许改** —— `portalSchemaChecksumV6/V7/…`
 *    按它们的当前全文求摘要，改了会让已经迁到那些版本的库从「可迁移的起点」
 *    变成 `unsupported`（服务端拒绝启动、迁移脚本也拒绝接手）。
 *    所以 `project_alias` 走独立文件 + `portalSchemaStatements()` 追加。
 * 2. 🚨 **冻结的 v10 摘要必须让它被认成 `legacy`**：现网那些已经迁到 v10 的库
 *    账本里记的是 v10 摘要，而不冻结的话 `portalSchemaChecksum()` 返回 v11 摘要，
 *    永远对不上 —— 一条纯追加迁移却卡死在门口。这是本文件最重要的一条断言。
 * 3. **唯一索引必须在位**：`idx_project_alias_member` 是受控 DDL 里的独立
 *    `CREATE UNIQUE INDEX`，而 SQLite 分支的 `verifyCurrent` **从不比对索引**
 *    （`idx_provider_alias_member` 就这么漏过两个版本）。所以这里显式断言
 *    `PRAGMA index_list` 的结果 —— 否则「迁移做完了但索引没建」
 *    在本地全绿，只在真实 MySQL 上于最后一步判失败。
 * 4. **权限行只授给内置管理员角色**：项目口径对全平台统计口径都有影响，
 *    普通成员不该默认改得动它。
 *
 * ⚠️ MySQL 侧只在 `ATR_V4_TEST_MYSQL_URL` 存在时实跑（每个用例自己的随机隔离
 *   schema），没有连接时**如实跳过** —— 「SQLite 上测过了」不构成 MySQL 的证据。
 *
 * ⚠️ 断言一律对着 `PORTAL_SCHEMA_VERSION`，**不写死版本号**：本文件只关心
 *   「`project_alias` 在不在」，而它后面还可能有 v12、v13……（写死会让下一次
 *   加版本时这里误报，而误报的断言比没有断言更糟）。
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
  PORTAL_V11_PERMISSION_SQL,
  PROJECT_ALIAS_MAX_LENGTH,
  PROJECT_ALIAS_TABLE,
  PROJECT_PREFIX_MAX_LENGTH,
  portalSchemaChecksum,
  portalSchemaChecksumV10,
  portalSchemaStatements,
  portalV11Statements,
  portalV11TableStatement,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v11-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/** 每个用例一个随机隔离 schema（`ATR_V4_TEST_MYSQL_URL` 是管理连接，不是目标库）。 */
async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_portal_v11_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_portal_v11_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

const V11_PERMISSION_IDS = ['00000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-000000000117']

async function tablesOf(target: PortalTarget): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    return store.kind === 'sqlite'
      ? (await store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((row) => row.name)
      : (await store.all<{ name: string }>(
        'SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name',
      )).map((row) => row.name)
  } finally {
    await store.close()
  }
}

/** `project_alias` 上的**自有**索引（`origin='c'` = 由 CREATE INDEX 建的）。 */
async function indexesOf(target: PortalTarget): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    if (store.kind === 'sqlite') {
      const rows = await store.all<{ name: string; unique: number; origin: string }>(`PRAGMA index_list(${PROJECT_ALIAS_TABLE})`)
      return rows.filter(row => row.origin === 'c').map(row => `${row.name}:${row.unique}`).sort()
    }
    // ⚠️ MySQL 侧**必须给列起别名**：`information_schema` 的列名在 MySQL 8 里是
    //   **大写**（`INDEX_NAME` / `NON_UNIQUE`）。不别名的话 `row.index_name` 恒为
    //   undefined，`.startsWith` 当场抛错 —— 一个只在真 MySQL 上现形、
    //   在 SQLite 上永远绿的失败（同 `portal-v12.test.ts` 的 `indexNamesOf`）。
    const rows = await store.all<{ name: string; non_unique: number }>(
      'SELECT index_name AS name, non_unique AS non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table GROUP BY index_name, non_unique',
      { $table: PROJECT_ALIAS_TABLE },
    )
    // ⚠️ MySQL 的主键索引名恒为 `PRIMARY`；这里只看我们自己建的三个。
    return rows.filter(row => row.name.startsWith('idx_project_alias')).map(row => `${row.name}:${row.non_unique === 0 ? 1 : 0}`).sort()
  } finally {
    await store.close()
  }
}

/** 一个**真 v10 库**：结构与当版一致，只是还没有 `project_alias` 与那两条权限码。 */
async function createV10(target: PortalTarget): Promise<void> {
  await preparePortalDatabase(target)
  const store = await openRawPortalStore(target)
  try {
    // 先落一条带 cwd 的真实事件：纯追加迁移必须**连它一个字节都不动**。
    // 🚨 `cwd` 必须走**参数**，不能内联成 SQL 字面量：Windows 路径里的反斜线
    //   在 MySQL 的单引号字符串里是转义符（`\r` → 回车、`\p` → `p`、`\c` → `c`），
    //   内联会让 `D:\repo\packages\core` 落库变成 `D:` + CR + `epopackagescore`，
    //   于是这条「原值不变」的断言在 SQLite 上绿、在真 MySQL 上红。
    await store.run(
      "INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ('v10:1','会话',1,100,'dashscope','m',$cwd,11,22,33,44,2,1,1)",
      { $cwd: 'D:\\repo\\packages\\core' },
    )
    await store.exec(`DROP TABLE ${PROJECT_ALIAS_TABLE}`)
    await store.run(`DELETE FROM role_permissions WHERE permission_id IN ('${V11_PERMISSION_IDS[0]}','${V11_PERMISSION_IDS[1]}')`, {})
    await store.run(`DELETE FROM permissions WHERE permission_id IN ('${V11_PERMISSION_IDS[0]}','${V11_PERMISSION_IDS[1]}')`, {})
    // 账本改回 v10：**删掉所有 version > 10 的行**（只删当前那一行会让 `current`
    // 仍为真，库会被判成 unsupported 而不是 legacy —— 见 AGENTS.md 里那条实测记录）。
    await store.run('DELETE FROM portal_schema_migrations WHERE version > 10', {})
    await store.run(
      "INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,10,$hash,'completed',1,$checkpoint,1,1)",
      { $id: randomUUID(), $hash: portalSchemaChecksumV10(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) },
    )
    if (store.kind === 'sqlite') await store.exec('PRAGMA user_version=10')
    else await store.run('UPDATE portal_meta SET schema_version=10 WHERE id=1', {})
  } finally {
    await store.close()
  }
}

describe('v11：全新库直接带 project_alias（受控定义追加）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] 全新库 = 当前版本，表与三条索引都在，权限码只授给内置管理员`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const state = await inspectPortalDatabase(target)
        expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(state.status).toBe('current')
        expect(await tablesOf(target)).toContain(PROJECT_ALIAS_TABLE)
        // 🚨 索引必须逐条断言：SQLite 的 `verifyCurrent` **从不比对索引**，
        //   所以「迁移少建了一个索引」在这里只能靠这条断言暴露。
        expect(await indexesOf(target)).toEqual([
          'idx_project_alias_member:1',
          'idx_project_alias_prefix:0',
          'idx_project_alias_scope:0',
        ])

        const store = await openRawPortalStore(target)
        try {
          // 两条权限码补齐，且只授给内置管理员角色（普通成员不该默认改全局项目口径）。
          expect(await store.all<{ code: string }>("SELECT code FROM permissions WHERE code LIKE 'projects:%' ORDER BY code"))
            .toEqual([{ code: 'projects:manage' }, { code: 'projects:read' }])
          expect(await store.all<{ role_id: string }>(
            `SELECT role_id FROM role_permissions WHERE permission_id IN ('${V11_PERMISSION_IDS[0]}','${V11_PERMISSION_IDS[1]}') ORDER BY permission_id`,
          )).toEqual([{ role_id: '00000000-0000-4000-8000-000000000001' }, { role_id: '00000000-0000-4000-8000-000000000001' }])
          // 规则行可写入、且 `scope=member` 必须有归属人（CHECK 兜住）。
          await store.run(
            "INSERT INTO project_alias (alias_id,scope,member_id,prefix,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,'global',NULL,$prefix,$alias,1,1,1)",
            { $id: randomUUID(), $prefix: 'D:\\repo', $alias: '仓库' },
          )
          expect(Number((await store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PROJECT_ALIAS_TABLE}`))?.n)).toBe(1)
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v11：v10 → 当前版本迁移（纯追加、幂等、事实表逐位不变）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] v10 库被判成可迁移的 legacy，迁移后补出表与索引，历史事件一字不改`, async () => {
      await run(async (target) => {
        await createV10(target)
        const before = await inspectPortalDatabase(target)
        expect(before.version).toBe(10)
        // ★ 这一条是本文件的核心：冻结的 v10 摘要必须让它被认成「上一版、可迁移」。
        expect(before.status, '冻结的 v10 摘要必须让它被认成「上一版、可迁移」').toBe('legacy')
        expect(await tablesOf(target)).not.toContain(PROJECT_ALIAS_TABLE)

        const migrated = await migratePortalDatabase(target, { confirmOffline: true })
        expect(migrated.status).toBe('current')
        expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(await tablesOf(target)).toContain(PROJECT_ALIAS_TABLE)
        expect(await indexesOf(target)).toEqual([
          'idx_project_alias_member:1',
          'idx_project_alias_prefix:0',
          'idx_project_alias_scope:0',
        ])

        const store = await openRawPortalStore(target)
        try {
          const ledger = await store.get<{ checksum: string }>('SELECT checksum FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
          expect(ledger?.checksum).toBe(portalSchemaChecksum(store.kind))
          // ★ 纯追加：历史用量一个字节都没被动过 —— `cwd` 原值还在。
          const row = await store.get<{ cwd: string; input_tokens: number }>("SELECT cwd,input_tokens FROM usage_event WHERE event_id='v10:1'")
          expect(row?.cwd).toBe('D:\\repo\\packages\\core')
          expect(Number(row?.input_tokens)).toBe(11)
          // 权限码补齐（v10 库里被删掉了）。
          expect(await store.all<{ code: string }>("SELECT code FROM permissions WHERE code LIKE 'projects:%' ORDER BY code"))
            .toEqual([{ code: 'projects:manage' }, { code: 'projects:read' }])
        } finally {
          await store.close()
        }
      })
    })

    test(`[${label}] 迁移是幂等的：再跑一次仍是 current，表与权限行都不会重复`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const first = await migratePortalDatabase(target, { confirmOffline: true })
        expect(first.status).toBe('current')
        const second = await migratePortalDatabase(target, { confirmOffline: true })
        expect(second.status).toBe('current')
        expect((await tablesOf(target)).filter(name => name === PROJECT_ALIAS_TABLE)).toHaveLength(1)
        expect(await indexesOf(target)).toHaveLength(3)
        const store = await openRawPortalStore(target)
        try {
          expect(Number((await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM permissions WHERE code='projects:read'"))?.n)).toBe(1)
          expect(Number((await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM role_permissions WHERE permission_id='" + V11_PERMISSION_IDS[0] + "'"))?.n)).toBe(1)
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v11：受控定义与摘要的关系（静态护栏，不需要数据库）', () => {
  test('受控定义里有 project_alias，且两个后端逐列同名', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statement = portalSchemaStatements(kind).find((sql) => sql.startsWith(`CREATE TABLE ${PROJECT_ALIAS_TABLE} (`))
      expect(statement, `${kind} 缺少 ${PROJECT_ALIAS_TABLE} 定义`).toBeDefined()
      for (const column of ['alias_id', 'scope', 'member_id', 'prefix', 'alias', 'enabled', 'created_at_ms', 'updated_at_ms']) {
        expect(statement!, `${kind} 缺少列 ${column}`).toContain(`  ${column} `)
      }
      // 列宽必须一致：受控定义逐列核对时类型不同就是「结构不符」。
      expect(statement!).toContain(kind === 'mysql' ? `VARCHAR(${PROJECT_PREFIX_MAX_LENGTH})` : 'prefix TEXT')
      expect(statement!).toContain('BETWEEN 1 AND ' + PROJECT_PREFIX_MAX_LENGTH)
      // 归一化名在 DDL 里宽到 255，应用层收到 128 —— 这一层刻意宽松（同 provider_alias）。
      expect(statement!).toContain(kind === 'mysql'
        ? 'alias VARCHAR(255) NOT NULL CHECK (CHAR_LENGTH(alias) BETWEEN 1 AND 255)'
        : 'alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 255)')
      expect(PROJECT_ALIAS_MAX_LENGTH).toBe(128)
    }
  })

  test('三条受控索引都在 v11 语句清单里，且唯一索引**逐字相同**（不能用部分索引）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statements = portalV11Statements(kind)
      expect(statements).toContain(`CREATE UNIQUE INDEX idx_project_alias_member ON ${PROJECT_ALIAS_TABLE} (member_id, prefix)`)
      expect(statements).toContain(`CREATE INDEX idx_project_alias_prefix ON ${PROJECT_ALIAS_TABLE} (prefix)`)
      expect(statements).toContain(`CREATE INDEX idx_project_alias_scope ON ${PROJECT_ALIAS_TABLE} (scope, enabled)`)
      // 🚨 不用 SQLite 的部分索引（`CREATE UNIQUE INDEX … WHERE …`）：MySQL 没有这种写法，
      //   两套唯一约束会让 MySQL 分支的 verifyUniqueConstraints 判「迁移做完了却不算成功」。
      //   ⚠️ 只扫建索引语句：权限行是 `INSERT … WHERE NOT EXISTS`，那里的 `WHERE` 是幂等写法。
      for (const sql of statements.filter(statement => statement.startsWith('CREATE'))) {
        expect(sql, sql).not.toContain(' WHERE ')
      }
      // 权限行是幂等写法（`WHERE NOT EXISTS`）—— 这条上面那句 `not.toContain(' WHERE ')`
      // 只针对 CREATE 语句，这里单独确认权限行确实带幂等条件。
      for (const sql of PORTAL_V11_PERMISSION_SQL) expect(sql).toContain('WHERE NOT EXISTS')
      expect(portalV11TableStatement(kind, PROJECT_ALIAS_TABLE)).toContain(`CREATE TABLE ${PROJECT_ALIAS_TABLE} (`)
    }
  })

  test('★ 当前摘要 ≠ 冻结的 v10 摘要（否则已经迁到 v10 的库会被误判成 current）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV10(kind))
    }
  })
})
