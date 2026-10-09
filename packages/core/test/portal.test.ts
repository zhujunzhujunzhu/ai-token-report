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
      source: 'dsh',
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
        groupName: '研发一部',
      },
    )
    await insertAttributedRecords(store, [wireRecord('f:1', { input_tokens: 500, cache_read_tokens: 0 })], {
      userId: '张三丰',
      userName: '张三丰',
      groupName: '研发一部',
    })
    await insertAttributedRecords(store, [wireRecord('l:1', { input_tokens: 40, cache_read_tokens: 0 })], {
      userId: '李四',
      userName: '李四',
      groupName: '研发二部',
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
  test('概览合并扫描与原三条查询一致：会话去重、空窗、归属和来源筛选', async () => {
    await seed()
    for (const filter of [
      {}, { userIds: ['张三'] }, { userIds: [UNATTRIBUTED_USER] },
      { identityView: 'member' as const }, { sources: ['codex'] },
      { providers: ['dash'], models: ['flash'] },
      { sinceMs: todayAt(9), untilMs: todayAt(9, 30) },
      { sinceMs: todayAt(7), untilMs: todayAt(8) },
    ]) {
      await withSession(async (session) => {
        expect(await session.overviewCounts()).toEqual({
          total: await session.totals(), sessions: await session.sessions(),
          unattributed: await session.unattributedCalls(),
        })
      }, filter)
    }
  })

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

  test('★ 人员排行的行带上该人员当前所属的分组名（多对多）', async () => {
    await seed()

    // 造一个稳定人员，并把他**同时**放进两个分组 —— 多对多的最小证据。
    // ⚠️ 人员 / 分组 / 关联三张表都得先建好：上报库连接开了
    //   `PRAGMA foreign_keys=ON`（见 portal-connection.ts），
    //   `member_group_assignments` 与 `usage_event.member_id` 都是 RESTRICT 外键。
    const memberId = '10000000-0000-4000-8000-000000000011'
    const groupA = '10000000-0000-4000-8000-000000000021'
    const groupB = '10000000-0000-4000-8000-000000000022'
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await store.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,'研发一部',1,1)",
          { $id: groupA },
        )
        await tx.run(
          "INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,'研发二部',1,1)",
          { $id: groupB },
        )
        await tx.run(
          "INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,'王五',1,1)",
          { $id: memberId },
        )
        for (const groupId of [groupA, groupB]) {
          await tx.run(
            'INSERT INTO member_group_assignments (member_id,group_id,created_at_ms) VALUES ($member,$group,1)',
            { $member: memberId, $group: groupId },
          )
        }
      })
      await insertAttributedRecords(store, [wireRecord('g:1')], {
        userId: '王五',
        userName: '王五',
        groupName: '研发一部',
        memberId,
      })
    } finally {
      await store.close()
    }

    // ★ 只有稳定人员视图（`identityView='member'`）按 `member_id` 聚合，
    //   分组名也只挂在这一维度的行上：旧姓名视图没有稳定 ID，无从关联。
    const rows = await withSession((s) => s.groups('user'), { identityView: 'member' })
    const row = rows.find((r) => r.memberId === memberId)!
    expect(row.label).toBe('王五')
    // 一行带出他所属的**每个**分组名（顺序按分组名）
    expect(row.groupNames).toEqual(['研发一部', '研发二部'])
    // 其余没有稳定人员 ID 的行（legacy / 未归属）不属于任何分组 → 空数组而不是 undefined
    for (const other of rows.filter((r) => r.memberId !== memberId)) {
      expect(other.groupNames).toEqual([])
    }
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

/**
 * 诊断页的两张覆盖表（v14）。
 *
 * ★ 这两张表回答的是「哪台机器 / 哪个客户端掉线了」，所以「不补零」是它们
 *   最重要的性质：补一排 0 会让「没人用这个客户端」与「这个客户端的数据
 *   没进来」在页面上长得一模一样，而后者才是这一页要抓的东西。
 */
describe('上报库查询：诊断覆盖表', () => {
  /** 造一份跨来源、跨人员的素材。 */
  async function seedCoverage(): Promise<void> {
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await insertAttributedRecords(
        store,
        [
          wireRecord('d:1', { source: 'dsh', session_id: 's-d1', ts: todayAt(9) }),
          wireRecord('d:2', { source: 'dsh', session_id: 's-d2', ts: todayAt(11) }),
          // 另一台机器 / 另一个客户端：codex
          wireRecord('c:1', { source: 'codex', session_id: 's-c1', ts: todayAt(10), input_tokens: 500, cache_read_tokens: 0 }),
        ],
        { userId: '张三', userName: '张三' },
      )
      await insertAttributedRecords(
        store,
        [wireRecord('l:1', { source: 'dsh', session_id: 's-l1', ts: todayAt(8), input_tokens: 40, cache_read_tokens: 0 })],
        { userId: '李四', userName: '李四' },
      )
    } finally {
      await store.close()
    }
  }

  test('sourceCoverage 按来源折叠，四项之和为 totalTokens，且按调用数降序', async () => {
    await seedCoverage()
    const rows = await withSession((s) => s.sourceCoverage())

    // ⚠️ 只出现**真的有数据**的来源：注册表里其他来源不补零。
    expect(rows.map((r) => r.source).sort()).toEqual(['codex', 'dsh'])
    expect(rows.length).toBe(2)

    const dsh = rows.find((r) => r.source === 'dsh')!
    expect(dsh.calls).toBe(3)
    // 总量 = 四项之和（库里不存 total 列）：
    // d:1 = 100+20+900+0 = 1020，d:2 同，l:1 = 40+20+0+0 = 60
    expect(dsh.totalTokens).toBe(1020 + 1020 + 60)
    expect(dsh.sessions).toBe(3)
    expect(dsh.earliestEventTs).toBe(todayAt(8))
    expect(dsh.latestEventTs).toBe(todayAt(11))

    const codex = rows.find((r) => r.source === 'codex')!
    expect(codex.calls).toBe(1)
    expect(codex.totalTokens).toBe(500 + 20)

    // 按调用条数降序
    expect(rows[0]!.calls).toBeGreaterThanOrEqual(rows[1]!.calls)
  })

  test('★ sourceCoverage 不补零：窗口内没有数据的来源根本不出现', async () => {
    await seedCoverage()
    const rows = await withSession((s) => s.sourceCoverage())
    // claude-code / trae / workbuddy 都在来源枚举里，但这批数据里一条都没有。
    // 补零会让「没人用」与「没进来」无法区分。
    for (const absent of ['claude-code', 'trae', 'trae-cn', 'workbuddy'])
      expect(rows.map((r) => r.source)).not.toContain(absent)
  })

  test('sourceCoverage 跟着筛选收窄（分子分母同组条件）', async () => {
    await seedCoverage()
    const all = await withSession((s) => s.sourceCoverage())
    const dshOnly = await withSession((s) => s.sourceCoverage(), { sources: ['dsh'] })
    expect(dshOnly.length).toBe(1)
    expect(dshOnly[0]!.source).toBe('dsh')
    expect(dshOnly[0]!.calls).toBeLessThan(all.reduce((sum, r) => sum + r.calls, 0))
  })

  test('reporterCoverage 的分组口径与 distinctUsers **逐字一致**', async () => {
    // 🚨 卡片上的「署名键组数」与这张表的行数必须是同一个数。
    //   两者一旦分叉，页面上会出现两个看起来各自正确、却对不上的数字。
    // ★ 两边必须打**同一组筛选条件**（生产环境永远是 identityView='member'，
    //   见 `stats-route.ts` 的 parseWindow / applyDataScope）。
    await seed()
    const { rows, users } = await withSession(
      async (s) => ({
        rows: await s.reporterCoverage(100),
        users: await s.distinctUsers(),
      }),
      { identityView: 'member' },
    )
    expect(rows.length).toBe(users)
    expect(users).toBe(3)
  })

  test('reporterCoverage 按调用条数降序取前 N 名', async () => {
    await seed()
    const all = await withSession((s) => s.reporterCoverage(100), { identityView: 'member' })
    expect(all.length).toBeGreaterThan(1)
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.calls).toBeGreaterThanOrEqual(all[i]!.calls)

    const top1 = await withSession((s) => s.reporterCoverage(1), { identityView: 'member' })
    expect(top1.length).toBe(1)
    expect(top1[0]!.calls).toBe(all[0]!.calls)
  })

  test('reporterCoverage 的键形与 by=user 分组键同形', async () => {
    await seed()
    const { rows, byUser } = await withSession(
      async (s) => ({
        rows: await s.reporterCoverage(100),
        byUser: await s.groups('user'),
      }),
      { identityView: 'member' },
    )
    // 「已署名」的那部分键必须逐字相同 —— 两处「张三」必须指向同一个身份。
    expect(rows.map((r) => r.key).sort())
      .toEqual(byUser.map((r) => r.key).filter((k) => k !== UNATTRIBUTED_USER).sort())
    // ⚠️ 与人员排行的**有意差异**：那里必须留一行 `unknown`，
    //   否则「有多少数据没署名」在排行里就彻底看不见了；而这张表是「署名覆盖」，
    //   未归属不进（见下一条）。一处要包含、一处要排除，都是刻意的。
    expect(byUser.map((r) => r.key)).toContain(UNATTRIBUTED_USER)
  })

  // 🚨 这条是「署名覆盖表」最重要的性质：服务端按调用条数降序截断到前 10 名，
  //   而未归属通常比任何**单个人**的调用都多 —— 留着它会把真正的人挤出表外，
  //   于是这一页最想回答的「谁在报」反而看不见了。
  test('★ 成员视图下未归属**不进**这张表（否则它会占掉前 10 名、把人挤出去）', async () => {
    // 🚨 这条与 `distinctUsers` 成员分支的过滤条件逐字对应：
    //   「署名键组数」数的是「有署名的身份」，未归属**不计入**（见卡片说明）。
    //   两处口径一旦分叉，同一页面上就会出现两个对不上的数字。
    await seed()
    const rows = await withSession((s) => s.reporterCoverage(100), { identityView: 'member' })
    expect(rows.every((r) => r.attributionStatus !== 'unattributed')).toBe(true)
    expect(rows.map((r) => r.key)).not.toContain(UNATTRIBUTED_USER)
    // 三个人都在（张三两条事件合一行）
    expect(rows.length).toBe(3)
  })

  test('旧视图下未归属作为 unknown 那一行出现（与 by=user 同款）', async () => {
    await seed()
    const rows = await withSession((s) => s.reporterCoverage(100))
    // ⚠️ 旧视图没有 member_id，未归属若被过滤掉，
    //   「有多少数据没署名」在这张表里就彻底看不见了。
    expect(rows.map((r) => r.key)).toContain(UNATTRIBUTED_USER)
    expect(rows.find((r) => r.key === UNATTRIBUTED_USER)?.label).toBe('未归属')
  })

  test('reporterCoverage 带上展示名、归属形态与最近事件时刻', async () => {
    await seed()
    const rows = await withSession((s) => s.reporterCoverage(100), { identityView: 'member' })
    // ⚠️ 这批素材是用 `userId` 造的，**没有 member_id**，
    //   所以成员视图下它们是「待确认历史身份」，展示名带「历史人员：」前缀。
    const zhang = rows.find((r) => r.key === 'legacy:5byg5LiJ')!
    expect(zhang.label).toBe('历史人员：张三（待确认）')
    expect(zhang.attributionStatus).toBe('legacy')
    // 张三两条事件合一行
    expect(zhang.calls).toBe(2)
    expect(zhang.totalTokens).toBe(2040)
    // 没有 member_id → 无从关联分组（与人员排行的 `groupNames` 同款）
    expect(zhang.groupNames).toEqual([])
    expect(zhang.latestEventTs).toBe(todayAt(10))
  })

  test('有 member_id 的行显示名取自人员表、分组名来自关联表', async () => {
    // ★ 这条与上一条互补：真实上报里绝大多数行**有** member_id，
    //   那才是生产上看到的样子（显示名来自 `members.display_name`）。
    await seed()
    const memberId = '10000000-0000-4000-8000-000000000031'
    const groupId = '10000000-0000-4000-8000-000000000041'
    const store = await openPortalStore({ sqlitePath: dbPath })
    try {
      await store.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO member_groups (group_id,name,created_at_ms,updated_at_ms) VALUES ($id,'平台组',1,1)",
          { $id: groupId },
        )
        await tx.run(
          "INSERT INTO members (member_id,display_name,created_at_ms,updated_at_ms) VALUES ($id,'王五',1,1)",
          { $id: memberId },
        )
        await tx.run(
          'INSERT INTO member_group_assignments (member_id,group_id,created_at_ms) VALUES ($member,$group,1)',
          { $member: memberId, $group: groupId },
        )
      })
      await insertAttributedRecords(store, [wireRecord('g:9')], {
        userId: '王五',
        userName: '王五',
        groupName: '平台组',
        memberId,
      })
    } finally {
      await store.close()
    }

    const rows = await withSession((s) => s.reporterCoverage(100), { identityView: 'member' })
    const row = rows.find((r) => r.key === memberId)!
    expect(row.label).toBe('王五')
    expect(row.attributionStatus).toBe('member')
    expect(row.groupNames).toEqual(['平台组'])
    expect(row.calls).toBe(1)
  })

  test('窗口内一条数据都没有时两张表都是空数组（不是一行 0）', async () => {
    openPortalDb(dbPath).close()
    const { sources, reporters } = await withSession(async (s) => ({
      sources: await s.sourceCoverage(),
      reporters: await s.reporterCoverage(),
    }))
    expect(sources).toEqual([])
    expect(reporters).toEqual([])
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
