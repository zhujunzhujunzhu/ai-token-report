/**
 * 上报库 **v12**：给 `provider_alias` 补一列 `model`，并把它的唯一索引从
 * `(member_id, provider)` 换成 `(member_id, provider, model)`
 * （`portal-schema-v12.ts`）。
 *
 * ## 这一版与 v6~v11 的「纯追加」不是同一类改动
 *
 * v6 / v7 / v8 / v11 只建表，v9 只往 `usage_event` 加列，v10 只往 `model_price`
 * 加列 —— 它们的风险集中在「受控定义文本不许改」与「摘要必须冻结」。v12 是第一次
 * **动既有表的结构**（`provider_alias` 加列 **并且** 换唯一索引），于是多出三件
 * 必须被钉住的事：
 *
 * 1. **老行语义逐字不变**：`model IS NULL` 就是「这是一条**供应商**规则」
 *    （v6 起的原语义）。v11 库里那些供应商规则迁移后必须一条不少、语义不变 ——
 *    不需要任何回填，也不许把 `NULL` 折成空串（那会变成一条永远不命中的幽灵规则）。
 * 2. 🚨 **MySQL 上换索引不能先 DROP**：`provider_alias.member_id` 上有指向 `members`
 *    的外键，而 InnoDB 要求外键列上存在**以它为最左前缀**的索引 —— 当前唯一覆盖
 *    `member_id` 最左前缀的恰恰是待删的那个索引，先删会被 errno 1553
 *    （`Cannot drop index …: needed in a foreign key constraint`）当场挡住。
 *    所以迁移走「以临时名建新 → 删旧 → 临时名改回」三步，本文件在**真 MySQL** 上
 *    验证终态，也验证「半状态（临时索引在、旧索引也在）」能 resume。
 * 3. **三列索引才是这一版的目的**：不换的话「`dashscope` 供应商规则」与
 *    「`dashscope` + `qwen-max` 模型规则」在旧索引下是**同一个键**，
 *    第二条根本写不进去（MySQL 直接 1062）。
 *
 * ⚠️ MySQL 侧只在 `ATR_V4_TEST_MYSQL_URL` 存在时实跑（每个用例自己的随机隔离
 *   schema）；没有连接时**如实跳过** ——「SQLite 上测过了」不构成 MySQL 的证据。
 *
 * ⚠️ 断言一律对着 `PORTAL_SCHEMA_VERSION` 与受控常量，**不写死版本号**：
 *   本文件只关心「`model` 列与三列索引在不在」，而它后面还可能有 v13、v14……
 *   （写死会让下一次加版本时这里误报，而误报的断言比没有断言更糟）。
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
  PORTAL_ANY_PROVIDER,
  PORTAL_MODEL_COLUMN,
  PORTAL_MODEL_MAX_LENGTH,
  PORTAL_PROVIDER_ALIAS_TEMP_INDEX,
  PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS,
  PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX,
  PORTAL_SCHEMA_VERSION,
  portalProviderAliasUniqueIndex,
  portalSchemaChecksum,
  portalSchemaChecksumV11,
  portalSchemaStatements,
  portalV12AddColumnStatement,
  portalV6Statements,
} from '../src/db/portal-schema-v5.js'

const root = mkdtempSync(join(tmpdir(), 'atr-portal-v12-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mysqlUrl = process.env['ATR_V4_TEST_MYSQL_URL']

/** 每个用例一个随机隔离 schema（`ATR_V4_TEST_MYSQL_URL` 是管理连接，不是目标库）。 */
async function isolatedMysql(fn: (target: PortalTarget) => Promise<void>): Promise<void> {
  const adminUrl = mysqlUrl!
  const admin = await openMysqlBackend(adminUrl)
  const schema = `atr_portal_v12_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_portal_v12_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名不合法')
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

// ── 结构探针（两种后端各一套方言，断言只看归一化后的结果） ──────────
async function columnsOf(target: PortalTarget, table: string): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    const rows = store.kind === 'sqlite'
      ? await store.all<{ name: string }>(`PRAGMA table_info(${table})`)
      : await store.all<{ name: string }>(
        'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=$table ORDER BY ordinal_position',
        { $table: table },
      )
    return rows.map(row => String(row.name).toLowerCase())
  } finally {
    await store.close()
  }
}

/** 某个索引当前的列组合（逗号 + 空格连接，与受控常量同形）；不存在返回 `null`。 */
async function indexColumnsOf(target: PortalTarget, table: string, index: string): Promise<string | null> {
  const store = await openRawPortalStore(target)
  try {
    const rows = store.kind === 'sqlite'
      ? await store.all<{ name: string | null }>(`PRAGMA index_info(${index})`)
      : await store.all<{ name: string | null }>(
        'SELECT column_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=$table AND index_name=$name ORDER BY seq_in_index',
        { $table: table, $name: index },
      )
    const columns = rows.map(row => String(row.name ?? '').toLowerCase()).filter(Boolean)
    return columns.length ? columns.join(', ') : null
  } finally {
    await store.close()
  }
}

/** `provider_alias` 上的索引名清单。 */
async function indexNamesOf(target: PortalTarget): Promise<string[]> {
  const store = await openRawPortalStore(target)
  try {
    // ⚠️ MySQL 侧**必须给列起别名**：`information_schema` 的列名在 MySQL 8 里是
    //   **大写**（`INDEX_NAME`），不别名的话 `row.index_name` 恒为 undefined ——
    //   一个只在真 MySQL 上现形、在 SQLite 上永远绿的失败。
    //   同理不要写 `'name' in row ? row.name : row.index_name`：MySQL 后端返回的行
    //   对 `in` 的判断并不可靠（实测 `'name' in row` 为真而 `row.name` 是 undefined）。
    const names = store.kind === 'sqlite'
      ? (await store.all<{ name: string }>('PRAGMA index_list(provider_alias)')).map(row => String(row.name))
      : (await store.all<{ name: string }>(
        "SELECT index_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='provider_alias' GROUP BY index_name",
      )).map(row => String(row.name))
    return names.filter(name => name.startsWith('idx_provider_alias')).sort()
  } finally {
    await store.close()
  }
}

/** 一条 v11 时代的供应商规则（`model` 为 NULL —— 这就是它的语义）。 */
const LEGACY_RULE = {
  aliasId: '00000000-0000-4000-8000-00000000a111',
  provider: 'dashscope',
  alias: 'bailian-tpp',
}
/** 一条 v11 时代的真实用量（`provider` / `model` 都要在迁移后逐位不变）。 */
const LEGACY_EVENT = { eventId: 'v11:1', provider: 'dashscope', model: 'qwen-max', input: 11, output: 22 }

/**
 * 造一个**真 v11 库**：结构与 v11 完全一致（`provider_alias` 没有 `model` 列，
 * 唯一索引是两列），账本记 v11 + 冻结摘要。
 *
 * ★ 做法是「先把**当版（v12）**建成，再把 `provider_alias` 换成**冻结的 v6 文本**」——
 *   而不是手抄一份 v11 的 DDL。两者看起来等价，但手抄的那份会在以后改列宽 /
 *   加约束时静默漂移，于是「迁移在真库上判失败、在测试里全绿」。冻结文本
 *   （`portalV6Statements()`）不可能漂移：它就是当年发布出去的那一份。
 */
async function createV11(target: PortalTarget): Promise<void> {
  await preparePortalDatabase(target)
  const store = await openRawPortalStore(target)
  try {
    await store.exec('DROP TABLE provider_alias')
    for (const sql of portalV6Statements(store.kind).filter(statement => statement.includes('provider_alias'))) {
      await store.exec(sql)
    }
    await store.run(
      "INSERT INTO provider_alias (alias_id,scope,member_id,provider,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,'global',NULL,$provider,$alias,1,1,1)",
      { $id: LEGACY_RULE.aliasId, $provider: LEGACY_RULE.provider, $alias: LEGACY_RULE.alias },
    )
    await store.run(
      "INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,turn,step) VALUES ($id,'会话',1,100,$provider,$model,NULL,$input,$output,0,0,0,1,1)",
      { $id: LEGACY_EVENT.eventId, $provider: LEGACY_EVENT.provider, $model: LEGACY_EVENT.model, $input: LEGACY_EVENT.input, $output: LEGACY_EVENT.output },
    )
    // 账本改回 v11：**删掉所有 version > 11 的行**（只删当前那一行会让 `current`
    // 仍为真，库会被判成 unsupported 而不是 legacy —— 见 AGENTS.md 里那条实测记录）。
    await store.run('DELETE FROM portal_schema_migrations WHERE version > 11', {})
    await store.run(
      "INSERT INTO portal_schema_migrations (migration_id,version,checksum,status,last_completed_step,checkpoint_json,started_at_ms,completed_at_ms) VALUES ($id,11,$hash,'completed',1,$checkpoint,1,1)",
      { $id: randomUUID(), $hash: portalSchemaChecksumV11(store.kind), $checkpoint: JSON.stringify({ sourceVersion: 0, historyHash: '', historyCount: 0 }) },
    )
    if (store.kind === 'sqlite') await store.exec('PRAGMA user_version=11')
    else await store.run('UPDATE portal_meta SET schema_version=11 WHERE id=1', {})
  } finally {
    await store.close()
  }
}

describe('v12：全新库直接带 `model` 列与三列唯一索引', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] 结构就位，且「供应商规则 + 模型规则」能同时落在同一个原始供应商上`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const state = await inspectPortalDatabase(target)
        expect(state.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(state.status).toBe('current')
        expect(await columnsOf(target, 'provider_alias')).toContain(PORTAL_MODEL_COLUMN)
        // 🚨 索引必须**逐列**断言：SQLite 的 `verifyCurrent` 只比表定义、从不比对索引，
        //   所以「列加了但索引没换」在这里只能靠这条断言暴露。
        expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX))
          .toBe(PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS)
        expect(await indexNamesOf(target)).toEqual([
          'idx_provider_alias_alias',
          PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX,
          'idx_provider_alias_scope',
        ])

        const store = await openRawPortalStore(target)
        try {
          const insert = (id: string, model: string | null) => store.run(
            `INSERT INTO provider_alias (alias_id,scope,member_id,provider,${PORTAL_MODEL_COLUMN},alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,'global',NULL,'dashscope',$model,$alias,1,1,1)`,
            { $id: id, $model: model, $alias: model === null ? 'bailian-tpp' : '通义千问-Max' },
          )
          await insert(LEGACY_RULE.aliasId, null)
          // ★ 同一个原始供应商名下再插一条**模型**规则 —— 旧的两列索引下这正是
          //   「同一个键」：MySQL 会直接 1062 拒绝，第二条根本写不进去。
          await insert('00000000-0000-4000-8000-00000000a222', 'qwen-max')
          expect(Number((await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_alias'))?.n)).toBe(2)
          // 两条规则各折叠一个维度：一条 `model IS NULL`（供应商规则），一条有值（模型规则）。
          expect(await store.all<{ model: string | null }>('SELECT model FROM provider_alias ORDER BY model'))
            .toEqual([{ model: null }, { model: 'qwen-max' }])
          // `*` 是「任意供应商」哨兵，且它与模型单价的常量是**同一个字面量**。
          expect(PORTAL_ANY_PROVIDER).toBe('*')
        } finally {
          await store.close()
        }
      })
    })
  }
})

describe('v12：v11 → 当前版本迁移（加列 + 换索引，事实表逐位不变）', () => {
  for (const { label, run } of cases()) {
    test(`[${label}] v11 库被判成可迁移的 legacy，迁移后补出 model 列与三列索引，老规则语义不变`, async () => {
      await run(async (target) => {
        await createV11(target)
        const before = await inspectPortalDatabase(target)
        expect(before.version).toBe(11)
        // ★ 这一条是本文件的核心：冻结的 v11 摘要必须让它被认成「上一版、可迁移」。
        expect(before.status, '冻结的 v11 摘要必须让它被认成「上一版、可迁移」').toBe('legacy')
        expect(await columnsOf(target, 'provider_alias')).not.toContain(PORTAL_MODEL_COLUMN)
        expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX))
          .toBe('member_id, provider')

        const migrated = await migratePortalDatabase(target, { confirmOffline: true })
        expect(migrated.status).toBe('current')
        expect(migrated.version).toBe(PORTAL_SCHEMA_VERSION)
        expect(await columnsOf(target, 'provider_alias')).toContain(PORTAL_MODEL_COLUMN)
        expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX))
          .toBe(PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS)
        // MySQL 的临时索引必须已经被改名（否则库里会留一个多余的唯一索引）。
        expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_TEMP_INDEX)).toBeNull()
        expect(await indexNamesOf(target)).toEqual([
          'idx_provider_alias_alias',
          PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX,
          'idx_provider_alias_scope',
        ])

        const store = await openRawPortalStore(target)
        try {
          const ledger = await store.get<{ checksum: string }>('SELECT checksum FROM portal_schema_migrations WHERE version=$version', { $version: PORTAL_SCHEMA_VERSION })
          expect(ledger?.checksum).toBe(portalSchemaChecksum(store.kind))
          // ★ 老行语义不变：`model` 仍是 NULL（不是空串），alias 与 provider 原样。
          expect(await store.all<{ provider: string; model: string | null; alias: string }>(
            'SELECT provider,model,alias FROM provider_alias ORDER BY alias_id',
          )).toEqual([{ provider: LEGACY_RULE.provider, model: null, alias: LEGACY_RULE.alias }])
          // ★ 事实表一个字节都没被动过。
          const event = await store.get<{ provider: string; model: string; input_tokens: number }>(
            `SELECT provider,model,input_tokens FROM usage_event WHERE event_id='${LEGACY_EVENT.eventId}'`,
          )
          expect(event?.provider).toBe(LEGACY_EVENT.provider)
          expect(event?.model).toBe(LEGACY_EVENT.model)
          expect(Number(event?.input_tokens)).toBe(LEGACY_EVENT.input)
          // ★ 换索引真的生效了：同一个原始供应商名下现在能再放一条**模型**规则。
          await store.run(
            `INSERT INTO provider_alias (alias_id,scope,member_id,provider,${PORTAL_MODEL_COLUMN},alias,enabled,created_at_ms,updated_at_ms) VALUES ('00000000-0000-4000-8000-00000000a333','global',NULL,'dashscope','qwen-max','通义千问-Max',1,1,1)`,
            {},
          )
          expect(Number((await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_alias'))?.n)).toBe(2)
        } finally {
          await store.close()
        }
      })
    })

    test(`[${label}] 迁移幂等：再跑一次仍是 current，列与索引都只有一份`, async () => {
      await run(async (target) => {
        await preparePortalDatabase(target)
        const first = await migratePortalDatabase(target, { confirmOffline: true })
        expect(first.status).toBe('current')
        const second = await migratePortalDatabase(target, { confirmOffline: true })
        expect(second.status).toBe('current')
        // ★ 起手就是当前版本：`upgradeV11ToV12()` 必须**先查列是否存在再 ALTER**，
        //   否则这一步会撞 `duplicate column name`（根因与迁移无关，极难定位）。
        expect((await columnsOf(target, 'provider_alias')).filter(name => name === PORTAL_MODEL_COLUMN)).toHaveLength(1)
        expect(await indexNamesOf(target)).toEqual([
          'idx_provider_alias_alias',
          PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX,
          'idx_provider_alias_scope',
        ])
      })
    })
  }
})

describe('v12：MySQL 换索引的中间态可以 resume', () => {
  test.skipIf(!mysqlUrl)('[mysql] 半状态（临时索引在、旧索引也在）能接着跑到终态，且不留多余额索引', async () => {
    await isolatedMysql(async (target) => {
      await createV11(target)
      const store = await openRawPortalStore(target)
      try {
        // 手工制造「上一次跑崩在删旧索引之前」的那一刻：列已加、临时三列索引已建、
        // 旧两列索引还在。MySQL 的 DDL 隐式提交，所以这个中间态在真实世界里会发生。
        await store.exec(portalV12AddColumnStatement(store.kind))
        await store.exec(`CREATE UNIQUE INDEX ${PORTAL_PROVIDER_ALIAS_TEMP_INDEX} ON provider_alias (${PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS})`)
      } finally {
        await store.close()
      }
      expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX)).toBe('member_id, provider')
      expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_TEMP_INDEX)).toBe(PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS)

      const migrated = await migratePortalDatabase(target, { confirmOffline: true })
      expect(migrated.status).toBe('current')
      // 旧索引被删、临时索引改回受控名 —— 终态与「一次跑完」逐字相同。
      expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX)).toBe(PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS)
      expect(await indexColumnsOf(target, 'provider_alias', PORTAL_PROVIDER_ALIAS_TEMP_INDEX)).toBeNull()
      expect(await indexNamesOf(target)).toEqual([
        'idx_provider_alias_alias',
        PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX,
        'idx_provider_alias_scope',
      ])
    })
  })
})

describe('v12：受控定义与摘要的关系（静态护栏，不需要数据库）', () => {
  test('受控定义里 `provider_alias` 有两后端同名的 `model` 列，且宽到 255', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statement = portalSchemaStatements(kind).find((sql) => sql.startsWith('CREATE TABLE provider_alias ('))
      expect(statement, `${kind} 缺少 provider_alias 定义`).toBeDefined()
      // 列定义必须**单独成行**：`expectedColumns()` 的逐行正则会取不到它，
      // 而取不到的表现是「迁移做完了却判列数不符」。
      expect(statement!.split('\n').filter(line => line.startsWith(`  ${PORTAL_MODEL_COLUMN} `))).toHaveLength(1)
      expect(statement!).toContain(kind === 'mysql'
        ? `${PORTAL_MODEL_COLUMN} VARCHAR(${PORTAL_MODEL_MAX_LENGTH}) NULL CHECK`
        : `${PORTAL_MODEL_COLUMN} TEXT NULL CHECK`)
      // 🚨 列的位置是被 SQLite 的 ADD COLUMN 改写规则钉住的：新列追加到
      //   「最后一个列定义之后、第一条表级约束之前」。位置不一致 ⇒ 迁移做完却判失败。
      expect(statement!).toContain(`  updated_at_ms${kind === 'mysql' ? ' BIGINT' : ' INTEGER'} NOT NULL CHECK ((`)
      expect(statement!.indexOf(`  ${PORTAL_MODEL_COLUMN} `)).toBeLessThan(statement!.indexOf('\n  CHECK ('))
    }
  })

  test('★ 受控语句清单里的唯一索引已是三列（`portalSchemaStatements()` 与迁移看到同一份）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const statements = portalSchemaStatements(kind)
      expect(statements).toContain(portalProviderAliasUniqueIndex())
      // 旧的两列索引文本必须一条都不剩 —— 剩一条就会在真实库里建出第二个唯一索引。
      expect(statements.some(sql => sql.includes('ON provider_alias (member_id, provider)'))).toBe(false)
    }
    expect(portalProviderAliasUniqueIndex()).toBe(`CREATE UNIQUE INDEX ${PORTAL_PROVIDER_ALIAS_UNIQUE_INDEX} ON provider_alias (${PORTAL_PROVIDER_ALIAS_UNIQUE_COLUMNS})`)
  })

  test('加列语句与受控定义的列文本同源（去掉末尾逗号后逐字相同）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      const definition = portalSchemaStatements(kind)
        .find((sql) => sql.startsWith('CREATE TABLE provider_alias ('))!
        .split('\n').find(line => line.startsWith(`  ${PORTAL_MODEL_COLUMN} `))!
        .trim().replace(/,$/, '')
      expect(portalV12AddColumnStatement(kind)).toBe(`ALTER TABLE provider_alias ADD COLUMN ${definition}`)
      // 不带 `AFTER`：两种后端默认都追加到末尾，而受控定义的拼接点也正是末尾。
      expect(portalV12AddColumnStatement(kind)).not.toContain(' AFTER ')
    }
  })

  test('★ 当前摘要 ≠ 冻结的 v11 摘要（否则已经迁到 v11 的库会被误判成 current）', () => {
    for (const kind of ['sqlite', 'mysql'] as const) {
      expect(portalSchemaChecksum(kind)).not.toBe(portalSchemaChecksumV11(kind))
    }
  })
})
