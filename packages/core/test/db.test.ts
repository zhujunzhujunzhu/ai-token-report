/**
 * 本地 SQLite 增量库测试。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **口径一致** —— SQL 路径与直扫路径对同一份日志必须给出**逐位相等**的
 *    四项 token、calls、sessions。这是整个迁移的风险所在：一旦不一致，
 *    页面的数字会悄悄变掉而没有任何报错。`assertSameTotals` 就是这道防线。
 * 2. **四个独立列** —— 铁律 1：库里绝不允许合并存储。
 * 3. **幂等** —— 连跑两次 ingest，第二次必须插入 0 条。
 * 4. **增量** —— 日志追加后只处理新增帧，且 L1 让未变化的文件零解压跳过。
 * 5. **降级** —— 库不可用时必须回退直扫而不是抛错（否则本地页白屏）。
 * 6. **时区分桶一致** —— SQL 的 `strftime(..., 'localtime')` 必须与
 *    `toDayKey()` / `toHourKey()` 落在同一个桶，否则趋势图的点会错位。
 *
 *   bun test packages/core
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { Database } from 'bun:sqlite'

import { derive } from '../src/types.js'
import { toDayKey, toHourKey } from '../src/aggregate.js'
import {
  DB_SCHEMA_VERSION,
  EVENT_TABLE,
  ingest,
  insertAttributedRecords,
  insertRecords,
  openDatabaseForIngest,
  openDb,
  openPortalDb,
  openPortalStore,
  openStats,
  queryGroups,
  queryRecords,
  querySeries,
  queryTotals,
  readWatermarks,
  resetDb,
  countEvents,
} from '../src/db/index.js'
import type { IngestRecord } from '../src/db/index.js'
import type { UsageRecord } from '../src/types.js'

// ── 脚手架 ───────────────────────────────────────────────────────────────

let home: string
let sessionsRoot: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-db-'))
  sessionsRoot = join(home, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  dbPath = join(home, 'token-report', 'usage.sqlite')
})

afterEach(() => {
  // ⚠️ Windows 下若还有打开的连接（尤其是 WAL 的 -shm/-wal），
  //   `rmSync` 会抛 EBUSY。测试自身已在 finally 里 close，
  //   这里的 retry 只是为了兜住断言失败路径上没走到 close 的情况 ——
  //   否则一个断言失败会连带把清理阶段也弄红，掩盖真正的错误。
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 造一条 assistant/message 事件行。 */
function usageLine(
  seq: number,
  opts: {
    ts?: number
    provider?: string
    model?: string
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    /** 故意写坏 totalTokens，用于验证 mismatch 诊断。 */
    badTotal?: number
  } = {},
): string {
  const input = opts.input ?? 100
  const output = opts.output ?? 10
  const cacheRead = opts.cacheRead ?? 1000
  const cacheWrite = opts.cacheWrite ?? 0
  const usage: Record<string, number> = {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
  if (opts.reasoning !== undefined) usage['reasoningTokens'] = opts.reasoning
  usage['totalTokens'] = opts.badTotal ?? input + output + cacheRead + cacheWrite

  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: opts.ts ?? Date.now(),
    data: {
      turn: 1,
      step: seq,
      message: {
        source: { kind: 'model', provider: opts.provider ?? 'dashscope', model: opts.model ?? 'm-1' },
      },
      usage,
    },
  })
}

function sessionLine(sessionId: string, cwd: string, ts = Date.now()): string {
  return JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: ts, cwd })
}

/** 把若干行压成一帧追加（模拟 DSH 的分帧 append）。 */
function appendFrame(file: string, lines: string[]): void {
  const frame = zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
  appendFileSync(file, frame)
}

/** 建一个会话日志文件并写入首批帧。 */
function makeSession(project: string, sessionId: string, lines: string[]): string {
  const dir = join(sessionsRoot, project, sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(file, Buffer.alloc(0))
  if (lines.length > 0) appendFrame(file, lines)
  return file
}

/** 今天某个时刻。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/**
 * ★ 核心断言：两条路径的汇总必须逐位相等。
 *
 * 逐字段比对而不是只比 total —— 四个列分开存储的意义就在于任何一列
 * 出问题都能被发现；只比 total 会让「input 少了 100、cacheRead 多了 100」
 * 这类错误静默通过（total 恰好相等）。
 */
function assertSameTotals(
  sqlCounts: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number },
  scanCounts: { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number },
  label: string,
): void {
  assert.equal(sqlCounts.input, scanCounts.input, `${label}: input 不一致`)
  assert.equal(sqlCounts.output, scanCounts.output, `${label}: output 不一致`)
  assert.equal(sqlCounts.cacheRead, scanCounts.cacheRead, `${label}: cacheRead 不一致`)
  assert.equal(sqlCounts.cacheWrite, scanCounts.cacheWrite, `${label}: cacheWrite 不一致`)
  assert.equal(sqlCounts.calls, scanCounts.calls, `${label}: calls 不一致`)
}

/** 取一份日志的「直扫基准」与「SQL 结果」，并断言两者相等。 */
async function comparePaths(
  opts: { period?: string; providers?: string[]; models?: string[] } = {},
): Promise<{ sql: Awaited<ReturnType<typeof openStats>>; scan: Awaited<ReturnType<typeof openStats>> }> {
  const scan = await openStats({
    sessionsRoot,
    dbPath,
    forceScan: true,
    ...(opts.period ? { period: opts.period } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
    ...(opts.models ? { models: opts.models } : {}),
  })
  const sql = await openStats({
    sessionsRoot,
    dbPath,
    ...(opts.period ? { period: opts.period } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
    ...(opts.models ? { models: opts.models } : {}),
  })
  return { sql, scan }
}

// ── schema ───────────────────────────────────────────────────────────────

describe('db schema', () => {
  test('建表后 user_version 正确，且四个 token 是独立列', () => {
    const db = openDatabaseForIngest(dbPath)
    const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
    expect(version?.user_version).toBe(DB_SCHEMA_VERSION)

    // ★ 铁律 1：必须是四个独立列，不能只有 total
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(${EVENT_TABLE})`)
      .all()
      .map((c) => c.name)
    expect(cols).toContain('input_tokens')
    expect(cols).toContain('output_tokens')
    expect(cols).toContain('cache_read_tokens')
    expect(cols).toContain('cache_write_tokens')
    // ★ 铁律 2：库里不得存在口径列（total 由展示层相加）
    expect(cols).not.toContain('total_tokens')
    expect(cols).not.toContain('cache_hit_rate')
    db.close()
  })

  test('归属三列存在且可空（本机入库不写，服务端上报才写）', () => {
    const db = openDatabaseForIngest(dbPath)
    const cols = db
      .query<{ name: string; notnull: number }, []>(`PRAGMA table_info(${EVENT_TABLE})`)
      .all()
    const byName = new Map(cols.map((c) => [c.name, c]))

    // ★ 三列都必须存在，且**必须可空**：本机增量入库（ingest.ts）根本不写它们，
    //   若哪天被改成 NOT NULL，本地库会立刻写不进去（而服务端库才有值）。
    for (const name of ['user_id', 'user_name', 'dept']) {
      expect(byName.has(name)).toBe(true)
      expect(byName.get(name)?.notnull).toBe(0)
    }
    db.close()
  })

  test('openPortalDb：schema 版本不符时抛错，绝不重建（服务端数据是唯一副本）', () => {
    // 先造一个「旧版本」的上报库，里面有一行只存在于这个库的数据
    const db1 = openDatabaseForIngest(dbPath)
    insertRecords(db1, [makeRecord('s1', 1)])
    db1.exec('PRAGMA user_version = 999')
    db1.close()

    // ★ 与本地库相反：这里必须停下来报错。
    //   本地库的真值是磁盘日志，重建只是重扫一次；
    //   上报库里的行来自各个客户端，客户端投递成功后已清掉自己的 pending ——
    //   自动重建等于把全部门的历史用量静默清空且无从恢复。
    expect(() => openPortalDb(dbPath)).toThrow(/唯一副本/)

    // 数据必须**原样还在**（抛错路径不许顺手删表）。
    // ⚠️ 这里用 openDb 直接打开，**不能**用 openDatabaseForIngest ——
    //   后者会把版本不符的库当成「本地派生物」直接重建，正好抹掉要断言的数据。
    const db2 = openDb(dbPath)
    expect(countEvents(db2)).toBe(1)
    db2.close()
  })

  test('openPortalDb：全新库正常建表；已有正确版本的库可重复打开', () => {
    const db1 = openPortalDb(dbPath)
    expect(
      db1.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version,
    ).toBe(DB_SCHEMA_VERSION)
    db1.close()

    const db2 = openPortalDb(dbPath)
    db2.close()
  })

  test('WAL 模式已启用（本地页需要读写并发）', () => {
    const db = openDatabaseForIngest(dbPath)
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    expect(mode?.journal_mode).toBe('wal')
    db.close()
  })

  test('重复打开不会重建已有数据', () => {
    const db1 = openDatabaseForIngest(dbPath)
    insertRecords(db1, [makeRecord('s1', 1)])
    expect(countEvents(db1)).toBe(1)
    db1.close()

    const db2 = openDatabaseForIngest(dbPath)
    expect(countEvents(db2)).toBe(1, )
    db2.close()
  })

  test('schema 版本不符时自动重建而不是抛错', () => {
    const db1 = openDatabaseForIngest(dbPath)
    insertRecords(db1, [makeRecord('s1', 1)])
    // 模拟旧版本库
    db1.exec('PRAGMA user_version = 999')
    db1.close()

    // ★ 关键：必须自愈（数据可从日志重扫），而不是抛错让本地页白屏
    const db2 = openDatabaseForIngest(dbPath)
    expect(countEvents(db2)).toBe(0, )
    expect(db2.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
      DB_SCHEMA_VERSION,
    )
    db2.close()
  })

  test('resetDb 删除库文件（含 wal/shm），不存在时静默成功', async () => {
    const db = openDatabaseForIngest(dbPath)
    insertRecords(db, [makeRecord('s1', 1)])
    db.close()

    await resetDb(dbPath)
    expect(() => readFileSync(dbPath)).toThrow()
    // 再次调用不应抛错
    await resetDb(dbPath)
  })
})

// ── 入库与幂等 ───────────────────────────────────────────────────────────

function makeRecord(sessionId: string, seq: number, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    eventId: `${sessionId}:${seq}`,
    sessionId,
    seq,
    time: 1_700_000_000_000 + seq,
    provider: 'dashscope',
    model: 'm-1',
    cwd: 'D:\\proj',
    turn: 1,
    step: seq,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 100,
      cacheWrite: 0,
      reasoning: 0,
      total: 112,
      calls: 1,
    },
    ...over,
  }
}

describe('db 入库', () => {
  test('首轮 ingest 写入全部记录', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\proj'),
      usageLine(1),
      usageLine(2),
      usageLine(3),
    ])

    const r = await ingest({ sessionsRoot, dbPath })
    expect(r.inserted).toBe(3)
    expect(r.duplicates).toBe(0)
    expect(r.filesScanned).toBe(1)
  })

  test('★ 幂等：连跑两次 ingest，第二次插入 0 条（L1 零解压跳过）', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\proj'), usageLine(1), usageLine(2)])

    const first = await ingest({ sessionsRoot, dbPath })
    expect(first.inserted).toBe(2)

    const second = await ingest({ sessionsRoot, dbPath })
    expect(second.inserted).toBe(0, )
    expect(second.duplicates).toBe(0, )
    expect(second.skippedUnchanged).toBe(1, )
    // ★ 零解压：文件字节数没变，一个文件都不该被解压
    expect(second.filesScanned).toBe(0, )
  })

  test('追加帧后只入库新增记录', async () => {
    const file = makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])
    await ingest({ sessionsRoot, dbPath })

    appendFrame(file, [usageLine(2), usageLine(3)])

    const second = await ingest({ sessionsRoot, dbPath })
    expect(second.inserted).toBe(2)
    expect(second.skippedUnchanged).toBe(0)

    const db = openDatabaseForIngest(dbPath)
    expect(countEvents(db)).toBe(3)
    db.close()
  })

  test('文件被截断时全量重扫，靠 event_id 去重不产生重复行', async () => {
    const file = makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\proj'),
      usageLine(1),
      usageLine(2),
    ])
    await ingest({ sessionsRoot, dbPath })

    // 重建为更小的文件，只含 seq=1
    writeFileSync(file, Buffer.alloc(0))
    appendFrame(file, [sessionLine('sess-1', 'D:\\proj'), usageLine(1)])

    const second = await ingest({ sessionsRoot, dbPath })
    expect(second.filesScanned).toBe(1, )
    // 截断文件被全量重扫，但 L3（session_state.last_seq）仍挡住 seq=1，
    // 因此既没新插入、也没有产生主键冲突 —— 与 state.ts 的语义一致。
    expect(second.inserted).toBe(0, )
    expect(second.duplicates).toBe(0, )

    const db = openDatabaseForIngest(dbPath)
    expect(countEvents(db)).toBe(2, )
    db.close()
  })

  test('L3 水位线失效时（库被清空而日志未变）靠主键去重', async () => {
    const file = makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\proj'),
      usageLine(1),
      usageLine(2),
    ])
    await ingest({ sessionsRoot, dbPath })

    // 手工清掉水位线表，模拟「水印丢了但文件没变」——
    // 此时 scanner 会重扫全部帧，唯一挡住重复行的就是 event_id 主键。
    const db0 = openDatabaseForIngest(dbPath)
    db0.exec('DELETE FROM file_watermark')
    db0.close()

    const second = await ingest({ sessionsRoot, dbPath })
    // ⚠️ L3 仍在（session_state 未被清），所以先被 L3 挡住
    expect(second.inserted).toBe(0, )

    // 清掉全部水位线，才能真正走到「靠主键去重」这条路径。
    // ⚠️ 光清 file_watermark 不够：文件字节数没变会让 L1 直接跳过整个文件，
    //    根本不会解压出记录，也就验证不到主键去重。
    //    这里同时把 session_state 清掉，让 L1 失效、L3 也无从判断。
    const dbMid = openDatabaseForIngest(dbPath)
    dbMid.exec('DELETE FROM file_watermark')
    dbMid.exec('DELETE FROM session_state')
    dbMid.close()

    const third = await ingest({ sessionsRoot, dbPath })
    expect(third.filesScanned).toBe(1, )
    expect(third.inserted).toBe(0, )
    expect(third.duplicates).toBe(2, )

    const db = openDatabaseForIngest(dbPath)
    expect(countEvents(db)).toBe(2, )
    db.close()
  })

  test('cwd 跨轮次继承：增量帧没有 session 行也不丢项目归属', async () => {
    const file = makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\myproj'),
      usageLine(1),
    ])
    await ingest({ sessionsRoot, dbPath })

    // 新帧只有 usage，没有 session 行
    appendFrame(file, [usageLine(2)])
    await ingest({ sessionsRoot, dbPath })

    const db = openDatabaseForIngest(dbPath)
    const rows = queryRecords(db, {})
    const seq2 = rows.find((r) => r.seq === 2)
    expect(seq2?.cwd).toBe('D:\\myproj', )
    db.close()
  })

  test('水位线可从库读回，且 L3 按 sessionId 存', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\a'), usageLine(5)])
    await ingest({ sessionsRoot, dbPath })

    const db = openDatabaseForIngest(dbPath)
    const wm = readWatermarks(db)
    expect(wm.lastSeqOf('sess-1')).toBe(5)
    expect(wm.cwdOf('sess-1')).toBe('D:\\a')
    db.close()
  })

  test('恒等式不符的事件仍入库，但被诊断计入 mismatch', async () => {
    makeSession('proj-a', 'sess-bad', [
      sessionLine('sess-bad', 'D:\\p'),
      usageLine(1, { badTotal: 999_999 }),
    ])

    const r = await ingest({ sessionsRoot, dbPath })
    expect(r.inserted).toBe(1, )
    expect(r.diagnostics.totalTokenMismatches).toBe(1)
  })

  test('insertRecords 与 ingest 写出同样的行结构（去重语义一致）', () => {
    const db = openDatabaseForIngest(dbPath)
    const a = insertRecords(db, [makeRecord('s1', 1), makeRecord('s1', 2)])
    expect(a.inserted).toBe(2)
    // 再插一次同样的 event_id
    const b = insertRecords(db, [makeRecord('s1', 2), makeRecord('s1', 3)])
    expect(b.inserted).toBe(1)
    expect(b.duplicates).toBe(1)
    expect(countEvents(db)).toBe(3)
    db.close()
  })
})

// ── 服务端上报落库（POST /api/v1/token-usage 的下半段）──────────────────

/** 造一条线上格式的上报记录（下划线字段）。 */
function makeIngestRecord(eventId: string, over: Partial<IngestRecord> = {}): IngestRecord {
  return {
    event_id: eventId,
    session_id: 'sess-1',
    seq: 1,
    ts: 1_700_000_000_000,
    provider: 'dashscope',
    model: 'm-1',
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 100,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\proj',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** 读一行归属，用于断言「谁上报的」。 */
function ownerOf(db: ReturnType<typeof openDb>, eventId: string) {
  // ⚠️ 位置参数必须包成数组：驱动按「数组 = 位置参数 / 对象 = 具名参数」分流，
  //   直接传字符串会被当成具名参数对象（Object.entries('s:1') → 三个键），
  //   结果是 `?` 没被绑定、查不到任何行。
  return db
    .query<{ user_id: string | null; user_name: string | null; dept: string | null }, [string]>(
      `SELECT user_id, user_name, dept FROM ${EVENT_TABLE} WHERE event_id = ?`,
    )
    .get([eventId])
}

describe('上报落库（服务端）', () => {
  test('写入鉴权得到的归属，四项 token 分列落库', async () => {
    // ⚠️ 写入走**异步门面** `openPortalStore`（它才认 MySQL），
    //   读回断言仍可用同步的 `openPortalDb`（同一个库文件）。
    const store = await openPortalStore({ sqlitePath: dbPath })
    const r = await insertAttributedRecords(store, [makeIngestRecord('s:1')], {
      userId: '张三',
      userName: '张三',
      dept: '研发一部',
    })
    await store.close()

    expect(r.inserted).toBe(1)
    expect(r.duplicates).toBe(0)

    const db = openPortalDb(dbPath)
    expect(ownerOf(db, 's:1')).toEqual({
      user_id: '张三',
      user_name: '张三',
      dept: '研发一部',
    })

    // ★ 铁律 1：四个 token 是四个独立列
    const row = db
      .query<{ i: number; o: number; cr: number; cw: number }, []>(
        `SELECT input_tokens AS i, output_tokens AS o,
                cache_read_tokens AS cr, cache_write_tokens AS cw
         FROM ${EVENT_TABLE} WHERE event_id = 's:1'`,
      )
      .get()
    expect(row).toEqual({ i: 10, o: 2, cr: 100, cw: 0 })
    db.close()
  })

  test('幂等：同一批重发只入库一次，第二次全算 duplicates', async () => {
    const store = await openPortalStore({ sqlitePath: dbPath })
    const owner = { userId: '张三' }
    const batch = [makeIngestRecord('s:1'), makeIngestRecord('s:2')]

    expect(await insertAttributedRecords(store, batch, owner)).toEqual({ inserted: 2, duplicates: 0 })
    // 插件与 CLI 同时上报同一条记录时就是这个情形：不该报错，也不该重复计费
    expect(await insertAttributedRecords(store, batch, owner)).toEqual({ inserted: 0, duplicates: 2 })
    await store.close()

    const db = openPortalDb(dbPath)
    expect(countEvents(db)).toBe(2)
    db.close()
  })

  test('★ 归属以先到的为准：后到的上报不会改写已有归属', async () => {
    const store = await openPortalStore({ sqlitePath: dbPath })
    const rec = makeIngestRecord('s:1')

    await insertAttributedRecords(store, [rec], { userId: '张三', userName: '张三', dept: '研发一部' })
    // 同一条记录被另一个人重发（如换了 token 的同一台机器）
    await insertAttributedRecords(store, [rec], { userId: '李四', userName: '李四', dept: '研发二部' })
    await store.close()

    const db = openPortalDb(dbPath)
    expect(ownerOf(db, 's:1')?.user_id).toBe('张三')
    db.close()
  })

  test('userName 缺省时回落到 userId；无部门时 dept 为 NULL', async () => {
    const store = await openPortalStore({ sqlitePath: dbPath })
    await insertAttributedRecords(store, [makeIngestRecord('s:1')], { userId: '张三' })
    await store.close()

    const db = openPortalDb(dbPath)
    expect(ownerOf(db, 's:1')).toEqual({ user_id: '张三', user_name: '张三', dept: null })
    db.close()
  })

  test('★ 本机入库路径不写归属（三列保持 NULL）', () => {
    const db = openDatabaseForIngest(dbPath)
    insertRecords(db, [makeRecord('s1', 1)])
    // 本机数据只有我一个人，归属只对「上报道服务端」有意义 ——
    // 本地路径若哪天开始写归属，说明两条链路的边界被搞混了
    expect(ownerOf(db, 's1:1')).toEqual({ user_id: null, user_name: null, dept: null })
    db.close()
  })
})

// ── ★ 口径一致性（本次迁移最重要的断言）─────────────────────────────

describe('★ 口径一致：SQL 路径 == 直扫路径', () => {
  test('四项 token 与 calls 逐位相等', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\Coding\\proj-a'),
      usageLine(1, { input: 7772, output: 186, cacheRead: 1024 }),
      usageLine(2, { input: 120, output: 30, cacheRead: 98_976 }),
    ])
    makeSession('proj-b', 'sess-2', [
      sessionLine('sess-2', 'D:\\Coding\\proj-b'),
      usageLine(1, { provider: 'openai', model: 'gpt-4o', input: 500, output: 60, cacheRead: 3000 }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      expect(sql.source).toBe('sql')
      expect(scan.source).toBe('scan')
      assertSameTotals(sql.totals(), scan.totals(), '全量')

      // 显式核对绝对数值，确保不是「两边都算错了」
      const t = sql.totals()
      expect(t.input).toBe(7772 + 120 + 500)
      expect(t.output).toBe(186 + 30 + 60)
      expect(t.cacheRead).toBe(1024 + 98_976 + 3000)
      expect(t.calls).toBe(3)
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('cacheHitRate 逐位相等（派生指标同源）', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { input: 7777, cacheRead: 1024 }),
      usageLine(2, { input: 2223, cacheRead: 98_976 }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      // ★ 两条路径都调用同一个 derive()，因此结果必须完全相等
      const a = derive(sql.totals()).cacheHitRate
      const b = derive(scan.totals()).cacheHitRate
      expect(a).toBe(b)
      expect(a).toBeCloseTo(100_000 / 110_000, 10)
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('sessions 去重计数相等（不含「有文件无调用」的会话）', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\p'), usageLine(1)])
    // 只有 session 首行，没有任何 usage
    makeSession('proj-a', 'sess-empty', [sessionLine('sess-empty', 'D:\\p')])

    const { sql, scan } = await comparePaths()
    try {
      expect(sql.sessions).toBe(1)
      expect(scan.sessions).toBe(1, )
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('provider / model 子串过滤结果相等（且大小写不敏感）', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { provider: 'dashscope', model: 'deepseek-v4.1-flash' }),
      usageLine(2, { provider: 'openai', model: 'gpt-4o' }),
    ])

    for (const filters of [
      { providers: ['dash'] },
      { providers: ['DASHSCOPE'] },
      { models: ['gpt-4o'] },
      { providers: ['a'], models: ['m'] },
    ]) {
      const { sql, scan } = await comparePaths(filters)
      try {
        assertSameTotals(sql.totals(), scan.totals(), `过滤 ${JSON.stringify(filters)}`)
      } finally {
        sql.close()
        scan.close()
      }
    }
  })

  test('LIKE 通配符被转义：筛选 a_b 不匹配 axb', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { provider: 'a_b' }),
      usageLine(2, { provider: 'axb' }),
    ])

    const { sql, scan } = await comparePaths({ providers: ['a_b'] })
    try {
      // ★ 不转义的话 %a_b% 会同时匹配 axb，两条路径就会不一致
      assertSameTotals(sql.totals(), scan.totals(), '下划线转义')
      expect(sql.totals().calls).toBe(1)
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('时间窗（today / yesterday / 全部）结果相等', async () => {
    const day = 86_400_000
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { ts: todayAt(10) }),
      usageLine(2, { ts: Date.now() - 2 * day }),
      usageLine(3, { ts: Date.now() - 40 * day }),
    ])

    for (const period of ['today', 'yesterday', 'last7d', undefined]) {
      const { sql, scan } = await comparePaths(period ? { period } : {})
      try {
        assertSameTotals(sql.totals(), scan.totals(), `period=${period ?? '全部'}`)
      } finally {
        sql.close()
        scan.close()
      }
    }
  })

  test('★ 分组结果相等：key / 四项 / calls / sessions 全对齐', async () => {
    const day = 86_400_000
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\Coding\\alpha'),
      usageLine(1, { provider: 'dashscope', model: 'm-a', input: 10, output: 1, cacheRead: 100, ts: todayAt(9) }),
      usageLine(2, { provider: 'openai', model: 'gpt-4o', input: 20, output: 2, cacheRead: 200, ts: todayAt(10) }),
    ])
    makeSession('proj-b', 'sess-2', [
      sessionLine('sess-2', 'D:\\Coding\\beta'),
      usageLine(1, { provider: 'dashscope', model: 'm-a', input: 30, output: 3, cacheRead: 300, ts: todayAt(11) }),
      usageLine(2, { provider: 'dashscope', model: 'm-b', input: 40, output: 4, cacheRead: 400, ts: Date.now() - 3 * day }),
    ])

    for (const dim of ['provider', 'model', 'provider-model', 'project', 'session', 'day', 'hour'] as const) {
      const { sql, scan } = await comparePaths()
      try {
        const a = sql.groups(dim)
        const b = scan.groups(dim)
        expect(a.map((r) => r.key)).toEqual(b.map((r) => r.key))
        for (let i = 0; i < a.length; i++) {
          assertSameTotals(a[i]!.counts, b[i]!.counts, `${dim}[${i}] key=${a[i]!.key}`)
          expect(a[i]!.sessions).toBe(b[i]!.sessions, )
          expect(a[i]!.firstTime).toBe(b[i]!.firstTime, )
          expect(a[i]!.lastTime).toBe(b[i]!.lastTime, )
        }
      } finally {
        sql.close()
        scan.close()
      }
    }
  })

  test('★ project 维度：不同 cwd 前缀归到同一项目名（复用 projectName）', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\work\\same'),
      usageLine(1, { input: 10, output: 0, cacheRead: 0 }),
    ])
    makeSession('proj-b', 'sess-2', [
      sessionLine('sess-2', 'E:\\other\\same'),
      usageLine(1, { input: 20, output: 0, cacheRead: 0 }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      const a = sql.groups('project')
      const b = scan.groups('project')
      // 两个不同 cwd 但同名 → 必须合并成一行
      expect(a.length).toBe(1)
      expect(a[0]!.key).toBe('same')
      expect(a[0]!.counts.input).toBe(30)
      expect(a.map((r) => r.key)).toEqual(b.map((r) => r.key))
      assertSameTotals(a[0]!.counts, b[0]!.counts, 'project 合并')
      expect(a[0]!.sessions).toBe(b[0]!.sessions)
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('★ day / hour 分桶与 toDayKey / toHourKey 完全一致（时区不能错）', async () => {
    // 取本地时间的一个特定时刻，确保 strftime localtime 与 JS 本地时区同桶
    const t1 = todayAt(0, 0) // 边界：本地零点
    const t2 = todayAt(23, 59)
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { ts: t1 }),
      usageLine(2, { ts: t2 }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      const sqlDay = sql.groups('day').map((r) => r.key)
      const scanDay = scan.groups('day').map((r) => r.key)
      expect(sqlDay).toEqual(scanDay)
      // 同一天的两条必须落进同一个桶
      expect(sqlDay).toEqual([toDayKey(t1)])
      expect(toDayKey(t1)).toBe(toDayKey(t2))

      const sqlHour = sql.groups('hour').map((r) => r.key)
      const scanHour = scan.groups('hour').map((r) => r.key)
      expect(sqlHour).toEqual(scanHour)
      expect(sqlHour).toContain(toHourKey(t1))
      expect(sqlHour).toContain(toHourKey(t2))
      // ⚠️ 桶键格式必须是 YYYY-MM-DDTHH（T 分隔），不能是空格
      for (const k of sqlHour) expect(k).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('★ series 补零后与直扫的桶集合一致', async () => {
    const day = 86_400_000
    // 三天前与今天各一条，中间那天缺失 → 应被补零
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { ts: Date.now() - 2 * day }),
      usageLine(2, { ts: Date.now() }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      const a = sql.series('day', true)
      const b = scan.series('day', true)
      expect(a.map((p) => p.bucket)).toEqual(b.map((p) => p.bucket))
      expect(a.length).toBe(3)
      // 中间那天必须是补出来的 0
      expect(a.filter((p) => p.counts.total === 0).length).toBe(1)
      for (let i = 0; i < a.length; i++) {
        assertSameTotals(a[i]!.counts, b[i]!.counts, `series[${i}]`)
      }
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('records() 物化的记录与直扫逐条相等', async () => {
    makeSession('proj-a', 'sess-1', [
      sessionLine('sess-1', 'D:\\p'),
      usageLine(1, { input: 1, output: 2, cacheRead: 3 }),
      usageLine(2, { input: 4, output: 5, cacheRead: 6 }),
    ])

    const { sql, scan } = await comparePaths()
    try {
      const a = sql.records()
      const b = scan.records()
      expect(a.length).toBe(b.length)
      const key = (r: { sessionId: string; seq: number }) => `${r.sessionId}:${r.seq}`
      const sortedA = [...a].sort((x, y) => key(x).localeCompare(key(y)))
      const sortedB = [...b].sort((x, y) => key(x).localeCompare(key(y)))
      for (let i = 0; i < sortedA.length; i++) {
        expect(sortedA[i]!.eventId).toBe(sortedB[i]!.eventId)
        expect(sortedA[i]!.usage.input).toBe(sortedB[i]!.usage.input)
        expect(sortedA[i]!.usage.output).toBe(sortedB[i]!.usage.output)
        expect(sortedA[i]!.usage.cacheRead).toBe(sortedB[i]!.usage.cacheRead)
        expect(sortedA[i]!.provider).toBe(sortedB[i]!.provider)
        expect(sortedA[i]!.model).toBe(sortedB[i]!.model)
        expect(sortedA[i]!.time).toBe(sortedB[i]!.time)
      }
    } finally {
      sql.close()
      scan.close()
    }
  })

  test('空日志目录：两条路径都返回全 0，不抛错', async () => {
    const { sql, scan } = await comparePaths()
    try {
      const t = sql.totals()
      expect(t.total).toBe(0)
      expect(t.calls).toBe(0)
      expect(sql.sessions).toBe(0)
      // 派生指标不能是 NaN
      expect(derive(t).cacheHitRate).toBe(0)
      assertSameTotals(t, scan.totals(), '空数据')
      expect(sql.groups('provider').length).toBe(0)
      expect(sql.series('day')).toEqual([])
    } finally {
      sql.close()
      scan.close()
    }
  })
})

// ── 降级 ─────────────────────────────────────────────────────────────────

describe('db 降级', () => {
  test('库路径不可写时降级为直扫，且结果仍正确', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\p'), usageLine(1)])

    // 用一个「父路径是文件」的库路径，制造必然的建库失败
    const blocker = join(home, 'blocker')
    writeFileSync(blocker, 'not a dir')
    const badDbPath = join(blocker, 'nested', 'usage.sqlite')

    const s = await openStats({ sessionsRoot, dbPath: badDbPath })
    try {
      // ★ 必须降级而不是抛错 —— 抛错会让本地页白屏
      expect(s.source).toBe('scan')
      expect(s.degradedReason).toBeTruthy()
      expect(String(s.degradedReason)).toContain('降级')
      // 降级路径的结果仍必须正确
      expect(s.totals().calls).toBe(1)
      expect(s.totals().input).toBe(100)
    } finally {
      s.close()
    }
  })

  test('库文件内容损坏时降级或自愈，绝不抛错', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\p'), usageLine(1)])

    // 写一个不是 SQLite 的文件到库路径
    mkdirSync(join(home, 'token-report'), { recursive: true })
    writeFileSync(dbPath, 'this is definitely not a sqlite database')

    const s = await openStats({ sessionsRoot, dbPath })
    try {
      // 要么自愈成 sql，要么降级成 scan —— 但绝不能抛错
      expect(['sql', 'scan']).toContain(s.source)
      expect(s.totals().calls).toBe(1)
    } finally {
      s.close()
    }
  })

  test('forceScan 强制直扫，不创建库文件', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\p'), usageLine(1)])

    const s = await openStats({ sessionsRoot, dbPath, forceScan: true })
    try {
      expect(s.source).toBe('scan')
      expect(s.diagnostics).not.toBeNull()
      expect(() => readFileSync(dbPath)).toThrow()
    } finally {
      s.close()
    }
  })

  test('readOnly 跳过 ingest（供验证脚本用）', async () => {
    makeSession('proj-a', 'sess-1', [sessionLine('sess-1', 'D:\\p'), usageLine(1)])
    // 先建库
    const warm = await openStats({ sessionsRoot, dbPath })
    warm.close()

    const s = await openStats({ sessionsRoot, dbPath, readOnly: true })
    s.close()
  })
})

// ── SQL 层不写公式（静态约束）─────────────────────────────────────────

describe('★ SQL 层不定义口径公式', () => {
  test('queryTotals 返回原始四项，不做任何派生', () => {
    const db = openDatabaseForIngest(dbPath)
    insertRecords(db, [
      makeRecord('s1', 1, {
        usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, reasoning: 5, total: 1010, calls: 1 },
      }),
    ])

    const t = queryTotals(db, {})
    // 四项必须原样返回
    expect(t.input).toBe(100)
    expect(t.output).toBe(10)
    expect(t.cacheRead).toBe(900)
    expect(t.cacheWrite).toBe(0)
    // total 由恒等式相加得到，不是 SQL 里算的
    expect(t.total).toBe(1010)
    // ★ cacheRead 绝不能被并进 input
    expect(t.input).not.toBe(1000)
    db.close()
  })

  test('querySeries / queryGroups 同样只返回原始四项', () => {
    const db = openDatabaseForIngest(dbPath)
    insertRecords(db, [makeRecord('s1', 1, { time: todayAt(10) })])

    const pts = querySeries(db, 'day', {})
    expect(pts.length).toBe(1)
    expect(Object.keys(pts[0]!.counts).sort()).toEqual(
      ['cacheRead', 'cacheWrite', 'calls', 'input', 'output', 'reasoning', 'total'].sort(),
    )

    const rows = queryGroups(db, 'provider', {})
    expect(rows.length).toBe(1)
    expect(rows[0]!.counts.input).toBe(10)
    db.close()
  })
})