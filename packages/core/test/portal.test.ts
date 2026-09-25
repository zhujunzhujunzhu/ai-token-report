/**
 * 上报库查询层测试（`core/db/portal.ts`）—— 部门看板的取数底座。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **`user` 维度必须能看见未归属** —— 未归属的行 `user_id IS NULL`，
 *    若 `GROUP BY user_id` 直接用它，那批数据会被丢进 NULL 组，
 *    而「有多少人没署名」这个最关键的运维信号就永远浮不上来。
 * 2. ★ **按人筛选是精确匹配** —— 子串匹配会把「张三」和「张三丰」
 *    并成一个人，那是数据错误而不是便利。
 * 3. **上报库只读且绝不重建** —— `openPortalStats` 走 `openPortalStore`，
 *    schema 版本不符时抛错（它是全员数据的唯一副本）。
 * 4. **补零与本地侧同一份实现** —— 部门趋势图与本机趋势图的桶集合一致。
 *
 * ⚠️ 本文件只跑 SQLite 后端（默认后端）。MySQL 的对照验证是**活体脚本**
 *   `packages/server/verify/verify-mysql-portal.ts`（需要真库，不进 `bun test`）。
 *   两边的**断言内容刻意相同**：后端换了，口径一个数字都不该变。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UNATTRIBUTED_USER } from '@ai-token-report/shared'

import {
  insertAttributedRecords,
  insertRecords,
  openPortalDb,
  openPortalStore,
  recordIngestMoment,
  type IngestRecord,
} from '../src/db/index.js'
import { openPortalStats, type PortalStatsSession } from '../src/db/portal.js'
import type { QueryFilter } from '../src/db/query.js'
import type { UsageRecord } from '../src/types.js'

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-portal-'))
  dbPath = join(home, 'token-report', 'portal.sqlite')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 今天某个时刻（保证落在 `period=today` 窗口内）。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

function wireRecord(eventId: string, over: Partial<IngestRecord> = {}): IngestRecord {
  return {
    event_id: eventId,
    session_id: 'sess-1',
    seq: 1,
    ts: todayAt(10),
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** 造数：三个人 + 若干未归属行。 */
async function seed(): Promise<void> {
  // 没有归属的行：现实里来自「本机库直接导出」或早期数据。
  // ★ 它走的是**本地路径的同步入口** `insertRecords`（不存在于 PortalStore 门面上），
  //   因此这里单独开一个同步 SQLite 句柄。
  const local: UsageRecord[] = [
    {
      eventId: 'u:1',
      sessionId: 'sess-u',
      seq: 1,
      time: todayAt(9),
      provider: 'dashscope',
      model: 'deepseek-v4.1-flash',
      cwd: null,
      turn: null,
      step: null,
      usage: {
        input: 7,
        output: 3,
        cacheRead: 90,
        cacheWrite: 0,
        reasoning: 0,
        total: 100,
        calls: 1,
      },
    },
  ]
  const raw = openPortalDb(dbPath)
  try {
    insertRecords(raw, local)
  } finally {
    raw.close()
  }

  const store = await openPortalStore({ sqlitePath: dbPath })
  try {
    await insertAttributedRecords(
      store,
      [wireRecord('z:1'), wireRecord('z:2', { session_id: 'sess-2' })],
      {
        userId: '张三',
        userName: '张三',
        dept: '研发一部',
      },
    )
    await insertAttributedRecords(store, [wireRecord('f:1', { input_tokens: 500, cache_read_tokens: 0 })], {
      userId: '张三丰',
      userName: '张三丰',
      dept: '研发一部',
    })
    await insertAttributedRecords(store, [wireRecord('l:1', { input_tokens: 40, cache_read_tokens: 0 })], {
      userId: '李四',
      userName: '李四',
      dept: '研发二部',
    })
    await recordIngestMoment(store, todayAt(12))
  } finally {
    await store.close()
  }
}

/** 在一个已打开/已关闭的会话上跑断言，省掉每处 try/finally。 */
async function withSession<T>(
  fn: (s: PortalStatsSession) => Promise<T> | T,
  filter: QueryFilter = {},
): Promise<T> {
  const session = await openPortalStats({ sqlitePath: dbPath }, filter)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

describe('上报库查询：总览与筛选', () => {
  test('四项 token 分列求和，sessions 按去重会话数', async () => {
    await seed()
    const totals = await withSession(async (s) => ({
      totals: await s.totals(),
      sessions: await s.sessions(),
    }))

    expect(totals.totals.input).toBe(100 + 100 + 500 + 40 + 7)
    expect(totals.totals.output).toBe(20 + 20 + 20 + 20 + 3)
    expect(totals.totals.cacheRead).toBe(900 + 900 + 0 + 0 + 90)
    expect(totals.totals.calls).toBe(5)
    // 去重会话数：sess-1（张三/张三丰/李四各一条）、sess-2（张三第二条）、
    // sess-u（未归属）—— 归属不同不影响会话去重，它数的是 session_id
    expect(totals.sessions).toBe(3)
  })

  test('时间窗筛选只统计窗口内的记录', async () => {
    await seed()
    // 早上 8 点前没有任何记录 → 窗口内为空
    const empty = await withSession((s) => s.totals(), { sinceMs: todayAt(7), untilMs: todayAt(8) })
    expect(empty.calls).toBe(0)

    // 9:00~9:30 只有那条未归属的记录
    const morning = await withSession((s) => s.totals(), {
      sinceMs: todayAt(9),
      untilMs: todayAt(9, 30),
    })
    expect(morning.calls).toBe(1)
    expect(morning.cacheRead).toBe(90)
  })

  test('★ 按人筛选是精确匹配（张三 ≠ 张三丰）', async () => {
    await seed()
    const zhang = await withSession((s) => s.totals(), { userIds: ['张三'] })
    expect(zhang.calls).toBe(2)
    expect(zhang.input).toBe(200)

    const zhangsf = await withSession((s) => s.totals(), { userIds: ['张三丰'] })
    expect(zhangsf.calls).toBe(1)
    expect(zhangsf.input).toBe(500)
  })

  test('userIds 支持多选（OR）', async () => {
    await seed()
    const two = await withSession((s) => s.totals(), { userIds: ['张三', '李四'] })
    expect(two.calls).toBe(3)
  })

  test('★ user=unknown 筛出未归属（user_id IS NULL）', async () => {
    await seed()
    const unknown = await withSession((s) => s.totals(), { userIds: [UNATTRIBUTED_USER] })
    expect(unknown.calls).toBe(1)
    expect(unknown.cacheRead).toBe(90)
  })
})

describe('上报库查询：人员排行', () => {
  test('★ 未归属成组出现且按用量降序', async () => {
    await seed()
    const rows = await withSession((s) => s.groups('user'))

    expect(rows.map((r) => r.key)).toEqual(['张三', '张三丰', UNATTRIBUTED_USER, '李四'])
    // 张三：两条各 1020 → 2040
    expect(rows[0]!.counts.total).toBe(2040)
    expect(rows[0]!.counts.calls).toBe(2)
    // 未归属那条：7 + 3 + 90 = 100
    const unknownRow = rows.find((r) => r.key === UNATTRIBUTED_USER)!
    expect(unknownRow.counts.total).toBe(100)
  })

  test('未归属组的键与筛选值、协议常量三者同值', async () => {
    await seed()
    const rows = await withSession((s) => s.groups('user'))
    expect(rows.some((r) => r.key === UNATTRIBUTED_USER)).toBe(true)
    // 用同一个字符串去筛选必须能命中那一组 —— 两个语义若不同值，
    // 「点开未归属」会得到 0 行，而页面上没有任何报错
    const filtered = await withSession((s) => s.groups('user'), { userIds: [UNATTRIBUTED_USER] })
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.counts.total).toBe(100)
  })

  test('其余维度照常工作（provider / day）', async () => {
    await seed()
    const byProvider = await withSession((s) => s.groups('provider'))
    expect(byProvider.length).toBe(1)
    expect(byProvider[0]!.key).toBe('dashscope')
    expect(byProvider[0]!.counts.calls).toBe(5)

    const byDay = await withSession((s) => s.groups('day'))
    expect(byDay.length).toBe(1)
    expect(byDay[0]!.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('上报库查询：趋势、明细与诊断', () => {
  test('series 只在有数据的桶之间有补零（与本地侧同一实现）', async () => {
    await seed()
    // 跨 3 天的数据 → 补零后 3 个点
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await insertAttributedRecords(
        store,
        [
          wireRecord('old:1', { ts: Date.now() - 3 * 86_400_000, session_id: 'sess-old' }),
          wireRecord('new:1', { ts: Date.now() - 1 * 86_400_000, session_id: 'sess-new' }),
        ],
        { userId: '张三' },
      )
    } finally {
      await store.close()
    }

    const points = await withSession((s) => s.series('day', true))
    expect(points.length).toBe(4)
    expect(points.filter((p) => p.counts.calls === 0).length).toBe(1)

    // 不补零时只有有数据的桶
    const raw = await withSession((s) => s.series('day', false))
    expect(raw.filter((p) => p.counts.calls === 0).length).toBe(0)
  })

  test('records 分页稳定：同一毫秒靠 (ts, seq) 定序', async () => {
    await seed()
    const ts = todayAt(15)
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await insertAttributedRecords(
        store,
        [
          wireRecord('t:1', { ts, seq: 1, session_id: 'sess-t' }),
          wireRecord('t:2', { ts, seq: 2, session_id: 'sess-t' }),
          wireRecord('t:3', { ts, seq: 3, session_id: 'sess-t' }),
        ],
        { userId: '王五' },
      )
    } finally {
      await store.close()
    }

    const page1 = await withSession((s) => s.records(2, 0))
    expect(page1.total).toBe(8)

    // 同一毫秒的三条按 seq 降序，翻页不会重复
    const page2 = await withSession((s) => s.records(2, 2))
    const firstIds = page1.rows.map((r) => r.eventId)
    const secondIds = page2.rows.map((r) => r.eventId)
    expect(firstIds).toEqual(['t:3', 't:2'])
    expect(secondIds).toEqual(['t:1', ...secondIds.slice(1)])
    // 两页没有交集 —— 这是 (ts, seq) 定序的意义
    for (const id of secondIds) expect(firstIds).not.toContain(id)
  })

  test('records 带回未归属的 user_id 为 null（不是字符串 unknown）', async () => {
    await seed()
    const page = await withSession((s) => s.records(50, 0))
    const unknown = page.rows.find((r) => r.eventId === 'u:1')!
    // 库里存的就是 NULL；「unknown」只是展示层与筛选层的表述
    expect(unknown.userId).toBeNull()
  })

  test('diagnostics 素材：未归属条数、人数、时间边界、最近落库时刻', async () => {
    await seed()
    const info = await withSession(async (s) => ({
      unattributed: await s.unattributedCalls(),
      users: await s.distinctUsers(),
      bounds: await s.timeBounds(),
      lastIngest: await s.lastIngestAt(),
    }))

    expect(info.unattributed).toBe(1)
    // 未归属不计入「已署名人数」
    expect(info.users).toBe(3)
    expect(info.bounds.earliest).toBe(todayAt(9))
    // 边界只看 usage_event；落库时刻是另一回事（下一条断言）
    expect(info.bounds.latest).toBe(todayAt(10))
    // 落库时刻来自 ingest_run，与「最新事件时间」是两个概念：
    // 客户端可以补报昨天的数据，那时事件时间早、落库时间却是刚刚
    expect(info.lastIngest).toBe(todayAt(12))
  })

  test('未归属条数与总数打的是同一组筛选条件', async () => {
    await seed()
    const scoped = await withSession(
      async (s) => ({ total: (await s.totals()).calls, unattributed: await s.unattributedCalls() }),
      { userIds: ['张三'] },
    )
    // 只看张三时，未归属必然是 0；若分子分母条件不一致，这里会出现
    // 「占比 1/2」这种荒谬值
    expect(scoped.total).toBe(2)
    expect(scoped.unattributed).toBe(0)
  })

  test('从未落库过时 lastIngestAt 返回 null（页面据此显示「暂无上报」）', async () => {
    // 只建表不写数据
    openPortalDb(dbPath).close()
    expect(await withSession((s) => s.lastIngestAt())).toBeNull()
  })
})

describe('上报库：绝不自动重建', () => {
  test('schema 版本不符时打开即抛错（不做降级）', async () => {
    const db = openPortalDb(dbPath)
    db.exec('PRAGMA user_version = 999')
    db.close()

    // ★ 上报库是全员数据的唯一副本。抛错而不是清空重建 ——
    //   与本地库「坏了就重建」的处理刻意相反。
    await expect(openPortalStats({ sqlitePath: dbPath })).rejects.toThrow(/唯一副本/)
  })
})

describe('session 生命周期', () => {
  test('close 可重复调用（上层多处 finally 会关它）', async () => {
    await seed()
    const session = await openPortalStats({ sqlitePath: dbPath })
    await session.close()
    await session.close()
  })
})