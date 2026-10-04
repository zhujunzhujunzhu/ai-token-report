/**
 * 上报库 **v13**：把 `cost:read` 授予内置 `member` 角色 —— **纯权限版本，没有任何 DDL**
 * （`portal-schema-v13.ts`）。
 *
 * ## 这一版要钉住的是「凭证能做什么」这条链，而不是结构
 *
 * `APP_KEY_SCOPES`（`shared/src/portal-identity.ts`）2026-10 起是三项
 * （`usage:write` + `stats:read` + `cost:read`），而一份凭证能做什么由两条约束的交集决定：
 *   1. 签发时 `grantScopes()`：本次授予 ⊆ **目标角色**权限；
 *   2. 解析时：`权限 = 角色权限 ∩ 凭证 scopes`。
 * 内置 `member` 角色缺 `cost:read` ⇒ **普通成员一条 appKey 都签不出来**
 * （第 1 条 403），而签得出来的也读不到价（第 2 条把它交掉）。
 * 所以本文件的第 ① 组断言是那条**真正的不变量**：
 * **`APP_KEY_SCOPES` 必须是内置 `member` 角色权限的子集** ——
 * 它把「以后往 appKey 范围里加一项」和「必须同时给基础角色授权」钉在一起。
 *
 * ## 为什么这个版本没有冻结的「v13 摘要输入」
 *
 * 权限是**数据**，`portalSchemaChecksum()` 刻意只覆盖 DDL 文本。于是：
 *   - `portalSchemaChecksum()` 的算式一个字不动；
 *   - 但 `portalSchemaChecksumV12()` 仍然冻结（= 本版发布那一刻的结构摘要），
 *     否则将来某一版真的加了 DDL，已经迁到 v12 的库会从「可迁移」变成 `unsupported`。
 *
 * ⚠️ MySQL 侧只在 `ATR_V4_TEST_MYSQL_URL` 存在时实跑（每个用例自己的随机隔离 schema）；
 *   没有连接时**如实跳过** ——「SQLite 上测过了」不构成 MySQL 的证据。
 *
 * ⚠️ 断言一律对着 `PORTAL_SCHEMA_VERSION` 与受控常量，**不写死当前版本号**
 *   （本文件只关心「member 有没有 `cost:read`、v12 库能不能升上来」，
 *   而后面还可能有 v14、v15……写死会让下一次加版本时这里误报）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP_KEY_SCOPES } from '@ai-token-report/shared'

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
  PORTAL_V13_PERMISSION_SQL,
  portalSchemaChecksum,
  portalSchemaChecksumV11,
  portalSchemaChecksumV12,
  portalSchemaChecksumV13,
  portalSchemaStatements,
  portalV13Statements,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v13-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/** 内置角色 / 权限的固定 ID（与 v4 的 seed、v13 的 SQL 同一份字面量）。 */
const MEMBER_ROLE_ID = '00000000-0000-4000-8000-000000000002'
const COST_READ_PERMISSION_ID = '00000000-0000-4000-8000-000000000114'

/** 每个用例一个随机隔离 schema（`ATR_V4_TEST_MYSQL_URL` 是管理连接，不是目标库）。 */
async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_portal_v13_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_portal_v13_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

/** 某个角色当前的权限码（升序）。 */
async function rolePermissionsOf(target: PortalTarget, roleId: string): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    const rows = await store.all<{ code: string }>(
      'SELECT p.code AS code FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.permission_id WHERE rp.role_id = $role ORDER BY p.code',
      { $role: roleId },
    )
    return rows.map(row => String(row.code))
  } finally {
    await store.close()
  }
}

/** 某条「角色 × 权限」关系的行数（用来断言幂等：永远只有一行）。 */
async function relationCount(target: PortalTarget, roleId: string, permissionId: string): Promise<number> {
  const store = await openRawPortalStore(target)
  try {
    const row = await store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = $role AND permission_id = $permission',
      { $role: roleId, $permission: permissionId },
    )
    return Number(row?.n ?? 0)
  } finally {
    await store.close()
  }
}

/**
 * 造一个**真 v12 库**：结构就是 v12（= 当前受控定义，本版没有 DDL），
 * 账本记 v12 + 冻结摘要，并且**把 v13 那条授权删掉** ——
 * v12 时代的内置 `member` 角色本来就没有 `cost:read`。
 *
 * ★ 不手抄 DDL：结构与「当版」逐字相同是这一版的性质（纯权限），
 *   而唯一要还原的历史事实是**那条权限关系当时不存在**。
 */
async function createV12(target: PortalTarget): Promise<void> {
  await preparePortalDatabase(target)
  const store = await openRawPortalStore(target)
  try {
    await store.run('DELETE FROM role_permissions WHERE role_id = $role AND permission_id = $permission', {
      $role: MEMBER_ROLE_ID,
      $permission: COST_READ_PERMISSION_ID,
    })
    // 账本改回 v12：**删掉所有 version > 12 的行**（只删当前那一行会让 `current`
    // 仍为真，库会被判成 unsupported 而不是 legacy —— 见 AGENTS.md 里那条实测记录）。
    await store.run('DELETE FROM portal_schema_migrations WHERE version > 12', {})
    await store.run(
      "INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,12,$hash,'completed',1,$checkpoint,1,1)",
      { $id: randomUUID(), $hash: portalSchemaChecksumV12(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) },
    )
    if (store.kind === 'sqlite') await store.exec('PRAGMA user_version=12')
    else await store.run('UPDATE portal_meta SET schema_version=12 WHERE id=1', {})
  } finally {
    await store.close()
  }
}

describe('v13：全新库的内置 member 角色就带 `cost:read`（普通成员签得出 appKey 的前提）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] member 角色权限 ⊇ APP_KEY_SCOPES，且这条关系只有一行`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const state = await inspectPortalDatabase(target)
        expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(state.status).toBe('current')

        const member = await rolePermissionsOf(target, MEMBER_ROLE_ID)
        // ★ 本文件的核心不变量：往 `APP_KEY_SCOPES` 里加一项就必须同时给基础角色授权，
        //   否则「普通成员一条 appKey 都签不出来」，而报错只说「不能授予超出本次身份权限的能力」。
        for (const code of APP_KEY_SCOPES) expect(member, `member 角色缺 ${code}`).toContain(code)
        // 内置管理员当然也有（v7 起就这样）。
        const admin = await rolePermissionsOf(target, '00000000-0000-4000-8000-000000000001')
        expect(admin).toContain('cost:read')
        expect(await relationCount(target, MEMBER_ROLE_ID, COST_READ_PERMISSION_ID)).toBe(1)
      })
    })
  }
})

describe('v13：v12 → 当前版本迁移（只补一条权限关系，结构一个字节都不动）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] v12 库被判成可迁移的 legacy，迁移后 member 拿到 cost:read`, async () => {
      await run(async (target) => {
        await createV12(target)
        const before = await inspectPortalDatabase(target)
        expect(before.version).toBe(12)
        // ★ 这一条是本文件的核心：冻结的 v12 摘要必须让它被认成「上一版、可迁移」
        //   —— 少了 `LEDGER_VERSIONS` 里的 12 或冻结摘要，它会变成 `unsupported`（拒绝启动）。
        expect(before.status, '冻结的 v12 摘要必须让它被认成「上一版、可迁移」').toBe('legacy')
        expect(await rolePermissionsOf(target, MEMBER_ROLE_ID)).not.toContain('cost:read')

        const migrated = await migratePortalDatabase(target, { confirmOffline: true })
        expect(migrated.status).toBe('current')
        expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(await rolePermissionsOf(target, MEMBER_ROLE_ID)).toContain('cost:read')
        expect(await relationCount(target, MEMBER_ROLE_ID, COST_READ_PERMISSION_ID)).toBe(1)

        const store = await openRawPortalStore(target)
        try {
          const ledger = await store.get<{ checksum: string }>(
            'SELECT checksum FROM portal_schema_migrations WHERE version=$version',
            { $version: PORTAL_SCHEMA_VERSION },
          )
          expect(ledger?.checksum).toBe(portalSchemaChecksum(store.kind))
        } finally {
          await store.close()
        }
      })
    })

    test(`[${label}] 迁移幂等：再跑一次仍是 current，权限关系不会翻倍`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const first = await migratePortalDatabase(target, { confirmOffline: true })
        expect(first.status).toBe('current')
        const second = await migratePortalDatabase(target, { confirmOffline: true })
        expect(second.status).toBe('current')
        // ★ 起手就是当前版本：`upgradeV12ToV13()` 必须靠 `WHERE NOT EXISTS` 幂等，
        //   否则重跑会撞 `role_permissions` 的主键（根因与迁移无关，极难定位）。
        expect(await relationCount(target, MEMBER_ROLE_ID, COST_READ_PERMISSION_ID)).toBe(1)
      })
    })
  }
})

describe('v13：受控定义与摘要的关系（静态护栏，不需要数据库）', () => {
  test('权限 SQL 在两种后端的受控语句清单里各出现一次（新库与升级库看到同一份）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statements = portalSchemaStatements(kind)
      for (const sql of PORTAL_V13_PERMISSION_SQL) {
        expect(statements.filter(candidate => candidate === sql)).toHaveLength(1)
      }
    }
    expect(portalV13Statements()).toEqual([...PORTAL_V13_PERMISSION_SQL])
  })

  test('权限 SQL 自身幂等，且只补角色关系（权限行由 v7 保证，不重复出现）', () => {
    expect(PORTAL_V13_PERMISSION_SQL).toHaveLength(1)
    const [sql] = PORTAL_V13_PERMISSION_SQL
    expect(sql).toContain('INSERT INTO role_permissions')
    expect(sql).toContain('WHERE NOT EXISTS')
    // ⚠️ 不许再补一条 `INSERT INTO permissions … cost:read …`：它与 v7 那条逐字相同，
    //   会让受控语句清单里出现两份（上一条测试正是钉这个）。
    expect(PORTAL_V13_PERMISSION_SQL.some(candidate => candidate.includes('INSERT INTO permissions'))).toBe(false)
  })

  test('★ 纯权限版本：v13 冻结摘要 === v12 摘要，且当前摘要已因 v14 而不同', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      // 冻结的 v11 摘要必须与 v12 不同（否则 v11 库会被误判成 current）。
      expect(portalSchemaChecksumV12(kind)).not.toBe(portalSchemaChecksumV11(kind))
      // 🚨 v13 没有任何 DDL ⇒ **它发布那一刻**的结构摘要就是 v12 那一份，
      //   这条断言正是「纯权限版本不留痕」的证据，且它**永不失效**：
      //   被比较的是两个**冻结**的函数，与当前版本号无关。
      //   （上一版这里写的是 `if (PORTAL_SCHEMA_VERSION === 13) expect(portalSchemaChecksum(kind))
      //     .toBe(portalSchemaChecksumV12(kind))` —— 那个写法在 v14 加了 DDL 之后
      //     立刻变成一个**类型层面的死分支**（`14` 与 `13` 无交集，tsc 报 TS2367），
      //     恰好在「需要改的那一刻」报了错。冻结摘要之间的比较不该依赖当前版本号。）
      expect(portalSchemaChecksumV13(kind)).toBe(portalSchemaChecksumV12(kind))
      // 而 v14 加了 DDL ⇒ 当前摘要必须**已经**与 v13 的不同，
      // 否则 v13 库（线上库升级后的形态）会被判成 current，
      // 而它的目录里没有 `idx_usage_event_source` ⇒ 闸门形同虚设。
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV13(kind))
    }
  })
})
