/**
 * 本机派生汇总索引的逐位对账。
 *
 * ★ 原始查询作为独立基线：逐项比较四类 token、reasoning、calls、精确会话去重、
 * 所有分组与小时/日趋势。只比 total 会掩盖缓存读和未缓存输入互相抵消的问题。
 * 文件数据库还用于模拟旧 CLI 独立连接写入，以及原始表重建后的辅助表失效。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import type { GroupDimension } from '../src/aggregate.js'
import { derive } from '../src/types.js'
import type { Database } from '../src/db/driver.js'
import { DB_SCHEMA_VERSION, ensureSchema, openDb, rebuildSchema } from '../src/db/schema.js'
import { queryGroups, querySeries, querySessionCount, queryTotals, type QueryFilter } from '../src/db/query.js'
import { readLocalRollup, readLocalRollupSummary } from '../src/db/local-rollup.js'

const DIMENSIONS: GroupDimension[] = ['provider', 'model', 'provider-model', 'project', 'session', 'day', 'hour']
let directory: string
let databasePath: string
let db: Database

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atr-local-rollup-'))
  databasePath = join(directory, 'usage.sqlite')
  db = openDb(databasePath)
  ensureSchema(db)
})

afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

interface Event {
  eventId: string; sessionId: string; seq: number; time: number; provider: string; model: string
  cwd: string | null; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number
}

function at(day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  return new Date(2026, 8, day, hour, minute, second, ms).getTime()
}

function event(seq: number, overrides: Partial<Event> = {}): Event {
  return {
    eventId: `shared:${seq}`, sessionId: 'shared', seq, time: at(24, 10, seq % 60),
    provider: 'Provider_A', model: 'model%one', cwd: 'D:/a/same-project',
    input: seq + 1, output: seq + 2, cacheRead: (seq + 1) * 101,
    cacheWrite: (seq % 3) + 2, reasoning: 1, ...overrides,
  }
}

function append(rows: Event[], database = db): number {
  const insert = database.prepare(`INSERT OR IGNORE INTO usage_event
    (event_id, session_id, seq, ts, provider, model, cwd, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  try {
    return database.transaction(() => rows.reduce((count, row) => count + insert.run([
      row.eventId, row.sessionId, row.seq, row.time, row.provider, row.model, row.cwd,
      row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning,
    ]).changes, 0))
  } finally { insert.finalize() }
}

function fixture(): Event[] {
  return [
    event(1, { time: at(24, 10, 0) }),
    event(2, { time: at(24, 10, 17) }),
    event(3, { time: at(24, 10, 35) }),
    event(4, { time: at(24, 10, 59, 59, 999) }),
    event(5, { time: at(24, 11, 5), model: 'other', cwd: 'E:/b/same-project' }),
    event(6, { time: at(25, 0, 0), provider: 'Other', model: 'other', cwd: 'E:/b/same-project' }),
    event(7, { time: at(25, 0, 0, 0, 1), sessionId: 'second', cwd: 'E:/b/same-project' }),
    event(8, { time: at(25, 14, 43), provider: 'ProviderXA', model: 'modelXone', cwd: null }),
    event(9, { time: at(25, 14, 59), sessionId: 'third', cwd: 'D:/unrelated/project' }),
    event(10, { time: at(25, 14, 17), sessionId: 'third', cwd: 'D:/unrelated/project' }),
    event(11, { time: at(25, 14, 42), sessionId: 'second', provider: 'Other', model: 'other' }),
    // 模型/服务商中的分隔符不能让复合 cell key 碰撞。
    event(12, { time: at(24, 10, 20), sessionId: 'separator', provider: 'a/b', model: 'c', cwd: '目录/工程' }),
    event(13, { time: at(24, 10, 21), sessionId: 'separator', provider: 'a', model: 'b/c', cwd: '目录/工程' }),
  ]
}

function byKey<T extends { key: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

function assertParity(filter: QueryFilter = {}, database = db): ReturnType<typeof readLocalRollup> {
  const expectedCounts = queryTotals(database, filter)
  const expectedSessions = querySessionCount(database, filter)
  expect(readLocalRollupSummary(database, filter)).toEqual({ counts: expectedCounts, sessions: expectedSessions })
  const snapshot = readLocalRollup(database, filter)
  expect(snapshot.counts).toEqual(expectedCounts)
  expect(snapshot.sessions).toBe(expectedSessions)
  for (const dim of DIMENSIONS) {
    const actual = snapshot.groups(dim)
    expect(byKey(actual.map(({ metrics: _metrics, ...row }) => row))).toEqual(byKey(queryGroups(database, dim, filter)))
    for (const row of actual) expect(row.metrics).toEqual(derive(row.counts))
  }
  for (const granularity of ['hour', 'day'] as const) {
    expect(snapshot.series(granularity)).toEqual(querySeries(database, granularity, filter))
  }
  return snapshot
}

describe('原始列、精确会话数、分组与序列', () => {
  test('空库与空结果都与原始查询一致，且不改变共享 schema 版本', () => {
    assertParity()
    append(fixture())
    assertParity({ providers: ['不存在'] })
    assertParity({ sinceMs: at(30), untilMs: at(31) })
    expect(db.query<{ user_version: number }>('PRAGMA user_version').get()!.user_version).toBe(DB_SCHEMA_VERSION)
  })

  test('跨小时、跨天、跨模型和同名 cwd 的同一会话只能计一次', () => {
    append(fixture())
    const snapshot = assertParity()
    expect(snapshot.sessions).toBe(4)
    expect(snapshot.groups('project').find(row => row.key === 'same-project')?.sessions).toBe(2)
    // 一个会话多天活动；每日会话数之和不能拿来当整个窗口的会话数。
    expect(snapshot.groups('day').reduce((n, row) => n + row.sessions, 0)).toBeGreaterThan(snapshot.sessions)
  })

  test('重复读取不重复累加，返回的旧快照不会被下一轮追加修改', () => {
    append(fixture())
    const first = assertParity()
    const before = structuredClone(first.counts)
    assertParity()
    append([event(100, { time: at(26, 8), sessionId: 'new-session' })])
    assertParity()
    expect(first.counts).toEqual(before)
  })

  test('provider/model 的组合筛选保留大小写、OR、字面百分号和下划线语义', () => {
    append(fixture())
    for (const filter of [
      { providers: ['provider_a'] },
      { providers: ['PROVIDER', 'a/b'], models: ['%one'] },
      { providers: ['Other'], models: ['OTHER', 'model'] },
      { models: ['Xone'] },
      { providers: [], models: [] },
    ]) assertParity(filter)
  })

  test('本地索引明确拒绝人员筛选，不能静默返回未筛选的全部用量', () => {
    append(fixture())
    expect(() => readLocalRollup(db, { userIds: ['someone'] })).toThrow('不支持人员筛选')
    assertParity({ userIds: [] })
  })

  test('超过一个索引写入批次时仍逐位一致，追加复用已有 cell 不丢最早/最晚时间', () => {
    append(Array.from({ length: 10_017 }, (_, i) => event(i, {
      time: at(24, 10, 0, 0, i), sessionId: `session-${i % 11}`, input: i % 17,
    })))
    assertParity()
    append([event(20_000, { time: at(24, 10, 59, 59, 999), sessionId: 'session-0' })])
    assertParity()
  })
})

describe('精确日期边界', () => {
  test('部分小时、自定义多日区间和只有单边的范围都只计入真实落在窗口内的记录', () => {
    append(fixture())
    for (const filter of [
      { sinceMs: at(24, 10, 17), untilMs: at(24, 10, 35) },
      { sinceMs: at(24, 10, 17), untilMs: at(25, 14, 43) },
      { sinceMs: at(24, 10, 17, 0, 1), untilMs: at(24, 10, 35, 0, 0) },
      { sinceMs: at(24, 10, 17), untilMs: at(24, 10, 17) },
      { sinceMs: at(24, 10, 17) },
      { untilMs: at(25, 14, 43) },
      { sinceMs: at(24, 10, 17), untilMs: at(25, 14, 43), providers: ['provider_a'] },
    ]) assertParity(filter)
  })

  test('恰好午夜和毫秒边界不会同时多算相邻两天', () => {
    append(fixture())
    assertParity({ sinceMs: at(24), untilMs: at(25) - 1 })
    assertParity({ sinceMs: at(25), untilMs: at(26) - 1 })
    assertParity({ sinceMs: at(25), untilMs: at(25) })
  })

  test('部分 cell 回查区间相互覆盖时不会重复计算同一事件', () => {
    append([
      event(1, { time: at(24, 10, 0) }), event(2, { time: at(24, 10, 30) }),
      event(3, { time: at(24, 10, 59) }), event(4, { time: at(24, 10, 5), sessionId: 'other' }),
      event(5, { time: at(24, 10, 30), sessionId: 'other' }),
      event(6, { time: at(24, 10, 55), sessionId: 'other' }),
      // 这一 cell 整体在范围内，原始回查不能把它再计一遍。
      event(7, { time: at(24, 10, 35), model: 'fully-inside' }),
    ])
    const snapshot = assertParity({ sinceMs: at(24, 10, 20), untilMs: at(24, 10, 40) })
    expect(snapshot.counts.calls).toBe(3)
  })

  test('ts=0 与正时间同处一个小时，时间分组边界遵守原始查询的无时间语义', () => {
    append([event(1, { time: 0 }), event(2, { time: 1000 })])
    assertParity()
  })
})

describe('旧写入端与重建后的索引失效', () => {
  test('独立连接 INSERT OR IGNORE 重复项不改变索引，追加新项则补齐', () => {
    append(fixture())
    assertParity()
    const writer = openDb(databasePath)
    try {
      expect(append(fixture(), writer)).toBe(0)
      assertParity()
      expect(append([event(100, { time: at(27), sessionId: 'external' })], writer)).toBe(1)
      assertParity()
    } finally { writer.close() }
  })

  test('独立连接更新原始列、时间与维度后，不能复用旧 cell', () => {
    append(fixture())
    assertParity()
    const writer = openDb(databasePath)
    try {
      writer.query(`UPDATE usage_event SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?,
        ts = ?, session_id = ?, cwd = ?, provider = ?, model = ? WHERE event_id = ?`)
        .run([500, 700, 800, 900, 400, at(29, 20), 'changed-session', 'D:/changed/project', 'changed', 'changed', 'shared:2'])
      assertParity()
    } finally { writer.close() }
  })

  test('独立连接 REPLACE 不启用递归触发器时，旧记录也不能重复汇总', () => {
    append(fixture())
    assertParity()
    const writer = openDb(databasePath)
    try {
      writer.exec('PRAGMA recursive_triggers = OFF')
      writer.query(`INSERT OR REPLACE INTO usage_event
        (event_id, session_id, seq, ts, provider, model, cwd, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(['shared:2', 'replacement', 2, at(29, 20), 'new-provider', 'new-model', null, 500, 700, 800, 900, 400])
      expect(assertParity().counts.calls).toBe(fixture().length)
      // OR IGNORE 仍不能向调用方误报已插入一行。
      expect(append([event(2)], writer)).toBe(0)
      assertParity()
    } finally { writer.close() }
  })

  test('删除最高 rowid 后追加和清空全表后重写，索引必须准确失效', () => {
    append(fixture())
    assertParity()
    db.query('DELETE FROM usage_event WHERE rowid = (SELECT MAX(rowid) FROM usage_event)').run()
    append([event(500, { time: at(30), sessionId: 'reused-rowid' })])
    assertParity()
    db.exec('DELETE FROM usage_event')
    assertParity()
    append([event(600, { time: at(30, 12) })])
    assertParity()
  })

  test('回滚原始数据更新不会使索引重复累加，也不会留下部分辅助更新', () => {
    append(fixture())
    const before = assertParity().counts
    expect(() => db.transaction(() => {
      db.exec('UPDATE usage_event SET cache_read_tokens = 0')
      readLocalRollup(db)
      throw new Error('模拟未提交事务失败')
    })).toThrow('模拟未提交事务失败')
    expect(assertParity().counts).toEqual(before)
  })

  test('原始表被旧 CLI 重建而辅助表残留时，不能拿旧游标跳过新记录', () => {
    append(fixture())
    assertParity()
    rebuildSchema(db)
    // 旧版重建函数只认识原始四张表，辅助表仍存在，新的 rowid 又从 1 开始。
    expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').get(['local_usage_cell'])).not.toBeNull()
    // 新表行数超过旧 cursor，不能仅靠 MAX(rowid) 变小发现重建。
    append(Array.from({ length: 20 }, (_, i) => event(900 + i, { time: at(30, 0, i), sessionId: 'after-rebuild' })))
    const snapshot = assertParity()
    expect(snapshot.sessions).toBe(1)
    expect(snapshot.counts.calls).toBe(20)
  })

  test('辅助索引版本失效只重建派生表，原始记录和共享 schema 版本不受影响', () => {
    append(fixture())
    const expected = assertParity().counts
    db.exec('UPDATE local_usage_cell_meta SET version = 0')
    expect(assertParity().counts).toEqual(expected)
    expect(queryTotals(db)).toEqual(expected)
    expect(db.query<{ user_version: number }>('PRAGMA user_version').get()!.user_version).toBe(DB_SCHEMA_VERSION)
  })

  test('同一数据库由不同时区进程读取时重新构建小时键，包含夏令时重复小时', () => {
    append([
      event(1, { time: Date.parse('2026-09-24T23:30:00Z') }),
      event(2, { time: Date.parse('2026-09-25T00:30:00Z') }),
      event(3, { time: Date.parse('2026-11-01T05:30:00Z') }),
      event(4, { time: Date.parse('2026-11-01T06:30:00Z') }),
    ])
    const code = `
      import { openDb } from ${JSON.stringify(import.meta.resolve('../src/db/schema.ts'))};
      import { readLocalRollup } from ${JSON.stringify(import.meta.resolve('../src/db/local-rollup.ts'))};
      import { queryGroups, querySeries, queryTotals } from ${JSON.stringify(import.meta.resolve('../src/db/query.ts'))};
      import assert from 'node:assert/strict';
      const db = openDb(${JSON.stringify(databasePath)});
      const normalize = rows => rows.map(({metrics, ...row}) => row).sort((a,b) => a.key.localeCompare(b.key));
      try {
        for (const filter of [{}, {sinceMs: Date.parse('2026-11-01T05:45:00Z'), untilMs: Date.parse('2026-11-01T06:45:00Z')}]) {
          const snapshot = readLocalRollup(db, filter);
          assert.deepEqual(snapshot.counts, queryTotals(db, filter));
          for (const dim of ['day', 'hour']) {
            assert.deepEqual(normalize(snapshot.groups(dim)), normalize(queryGroups(db, dim, filter)));
            assert.deepEqual(snapshot.series(dim), querySeries(db, dim, filter));
          }
        }
        console.log(JSON.stringify(readLocalRollup(db).series('hour').map(row => row.bucket)));
      } finally { db.close(); }
    `
    const results: string[][] = []
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'UTC']) {
      const child = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' })
      expect(child.stderr).toBe('')
      expect(child.status).toBe(0)
      results.push(JSON.parse(child.stdout) as string[])
    }
    expect(results[0]).not.toEqual(results[1])
    expect(results[0]).toEqual(results[3])
    expect(results[2]?.filter(bucket => bucket === '2026-11-01T01')).toHaveLength(1)
    assertParity()
  })
})
