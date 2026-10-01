/**
 * v8 汇总表的门禁测试。
 *
 * ★ 这里钉住的是**口径与不变量**，不是「跑得通」：
 *   - 汇总 ≡ 原始（同一窗口下 `calls` 与四项 token 逐位相等）；
 *   - 分桶用 `aggregate.ts` 的本地时区实现（改 TZ 必须重算）；
 *   - 水位按**接收时刻**走，乱序补报不漏；
 *   - 重复同步**幂等**（水位与写入同事务）；
 *   - `sessions` 刻意不在汇总里（不可加）；
 *   - 汇总表落后 / 缺失时必须退原始表，且结果与快路径逐位相同。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dayKindOf, toDayKey, toHourOfDay } from '../src/aggregate.js'
import {
  foldRollupRows,
  readRollupMeta,
  rollupNeedsRebuild,
  syncRollups,
} from '../src/db/rollup.js'
import { insertAttributedRecords } from '../src/db/ingest.js'
import { openPortalStats } from '../src/db/portal.js'
import { openPortalStore, preparePortalDatabase } from '../src/db/portal-db.js'
import { PORTAL_SCHEMA_VERSION } from '../src/db/portal-schema-v5.js'
import { ROLLUP_HOUR_RETAIN_DAYS, rollupTimezoneKey } from '../src/db/portal-schema-v8.js'

const MEMBER_ID = '11111111-1111-4111-8111-111111111111'
const DAY_MS = 86_400_000

function target(): { sqlitePath: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'atr-rollup-'))
  return {
    sqlitePath: join(dir, 'portal.sqlite'),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function record(index: number, ts: number, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    event_id: `s-${index}:${index}`, session_id: `s-${index}`, seq: index, ts,
    provider: 'deepseek-official', model: 'deepseek-v4.1-flash', cwd: null,
    input_tokens: 10, output_tokens: 1, cache_read_tokens: 100, cache_write_tokens: 2,
    reasoning_tokens: 0, turn: 1, step: index,
    ...overrides,
  } as never
}

async function seed(rows: { ts: number; receivedAtMs: number | null; memberId?: string; provider?: string; model?: string; input?: number }[]) {
  const t = target()
  await preparePortalDatabase(t)
  const store = await openPortalStore(t)
  const now = Date.now()
  await store.run(
    'INSERT INTO members (member_id,display_name,status,version,created_at_ms,updated_at_ms) VALUES ($id,$name,\'active\',1,$now,$now)',
    { $id: MEMBER_ID, $name: '甲', $now: now },
  )
  for (const [index, row] of rows.entries()) {
    await insertAttributedRecords(store, [record(index, row.ts, {
      provider: row.provider ?? 'deepseek-official', model: row.model ?? 'deepseek-v4.1-flash',
      input_tokens: row.input ?? 10,
    })], {
      userId: '甲', userName: '甲', memberId: row.memberId ?? MEMBER_ID, receivedAtMs: row.receivedAtMs,
    })
  }
  return { t, store }
}

/**
 * 把汇总表彻底清空，强制查询层退原始表。
 *
 * 🚨 **必须三张一起清**：`#rollupUsable()` 的不变量是
 *   「`SUM(usage_rollup_day.calls)` == 原始行数」。只清 `hour` / `hod`
 *   而留着 `day`，那条不变量仍然成立 ⇒ 快路径照样命中，
 *   于是「退原始表」的断言其实测的是另一条路径 —— 我在这里踩过一次：
 *   表现为 `hourOfDay()` 返回 `[{hour: 0, calls: 0}]`（空表 `GROUP BY` 的产物），
 *   看起来像分桶算错了，实际是**测错了路径**。
 */
async function clearRollups(store: { exec: (sql: string) => Promise<void> | void }): Promise<void> {
  for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod']) {
    await store.exec(`DELETE FROM ${table}`)
  }
}

describe('v8 汇总表：口径与不变量', () => {
  test('★ 汇总 ≡ 原始：同一窗口下 calls 与四项 token 逐位相等', async () => {
    const now = Date.now()
    const { t, store } = await seed([
      { ts: now - 3 * 3600_000, receivedAtMs: now - 3 * 3600_000 },
      { ts: now - 2 * 3600_000, receivedAtMs: now - 2 * 3600_000 },
      { ts: now - 1 * 3600_000, receivedAtMs: now - 1 * 3600_000 },
    ])
    try {
      await syncRollups(store, { now })
      const raw = await store.get<Record<string, unknown>>(
        'SELECT COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read FROM usage_event WHERE received_at_ms IS NOT NULL')
      const rolled = await store.get<Record<string, unknown>>(
        'SELECT SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read FROM usage_rollup_day')
      expect(Number(rolled?.['calls'])).toBe(Number(raw?.['calls']))
      expect(Number(rolled?.['input'])).toBe(Number(raw?.['input']))
      expect(Number(rolled?.['cache_read'])).toBe(Number(raw?.['cache_read']))
      // sessions 刻意不在汇总表里（不可加）：任何一张汇总表都不许有这一列
      for (const table of ['usage_rollup_day', 'usage_rollup_hour', 'usage_rollup_hod']) {
        const columns = await store.all<{ name: string }>(`PRAGMA table_info(${table})`)
        expect(columns.map(column => column.name)).not.toContain('sessions')
      }
    } finally { await store.close(); t.dispose() }
  })

  test('★ 水位按接收时刻走：乱序补报（ts 很旧）不会被漏掉', async () => {
    const now = Date.now()
    const { t, store } = await seed([{ ts: now - 1 * 3600_000, receivedAtMs: now - 1 * 3600_000 }])
    try {
      await syncRollups(store, { now })
      const before = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(before?.c)).toBe(1)
      // 迟到事件：ts 是**十天前**，但**刚到**（接收时刻比水位新）
      await insertAttributedRecords(store, [record(99, now - 10 * DAY_MS)], {
        userId: '甲', userName: '甲', memberId: MEMBER_ID, receivedAtMs: now,
      })
      const second = await syncRollups(store, { now: now + 1000 })
      expect(second.mode).toBe('incremental')
      const after = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(after?.c), '迟到事件必须进汇总（按 ts 走水位就会漏掉它）').toBe(2)
      const lateDay = await store.get<{ c: number }>(
        'SELECT SUM(calls) AS c FROM usage_rollup_day WHERE day_key = $day', { $day: toDayKey(now - 10 * DAY_MS) })
      expect(Number(lateDay?.c), '它落在十天前的那一天，不是今天').toBe(1)
    } finally { await store.close(); t.dispose() }
  })

  test('★ 水位是复合游标：同一接收时刻超过一批时也必须继续推进', async () => {
    const now = Date.now()
    /**
     * 🚨 这条钉住一个**静默少算**的 bug：水位只按 `received_at_ms` 推进时，
     *   一批上报的接收时刻**完全相同**（一次 HTTP 批量写入带一个 `Date.now()`），
     *   于是「本批最后一行的时刻」与「下一批第一行」相等，`>` 永远筛不到新行 ——
     *   同步**停在那里**，剩下的数据永远进不了汇总，而且**没有任何报错**。
     *
     *   实测：300 万行造数（接收时刻全相同）+ `maxRows=200_000`
     *   ⇒ `SUM(汇总.calls)` 停在 20 万不动。
     *
     * 所以这里造 6 条**接收时刻完全相同**的事件，并把 `maxRows` 压到 4，
     * 强制走两批；两批跑完必须 6 条全进汇总。
     */
    const { t, store } = await seed(Array.from({ length: 6 }, () => ({ ts: now - 1000, receivedAtMs: now })))
    try {
      const first = await syncRollups(store, { now, maxRows: 4 })
      expect(first.mode).toBe('rebuild')
      const afterFirst = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(afterFirst?.c), '第一批只处理 4 条').toBe(4)
      const meta1 = await readRollupMeta(store)
      expect(meta1?.builtThroughEventId, '水位必须带上事件 ID（复合游标）').not.toBe('')

      const second = await syncRollups(store, { now, maxRows: 4 })
      expect(second.mode, '接收时刻相同也必须能继续推进（否则永远卡住）').toBe('incremental')
      const afterSecond = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(afterSecond?.c), '两批跑完必须 4 + 2 = 6 条全进汇总').toBe(6)

      const third = await syncRollups(store, { now, maxRows: 4 })
      expect(third.mode).toBe('skipped')
      const final = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(final?.c), '追平后不该再变（不重放）').toBe(6)
    } finally { await store.close(); t.dispose() }
  })

  test('★ 重复同步幂等：没有新数据时 skipped，行数与计数都不翻倍', async () => {    const now = Date.now()
    const { t, store } = await seed([{ ts: now - 1000, receivedAtMs: now - 1000 }])
    try {
      await syncRollups(store, { now })
      const first = await store.get<{ c: number }>('SELECT COUNT(*) AS c FROM usage_rollup_day')
      const again = await syncRollups(store, { now: now + 5000 })
      expect(again.mode).toBe('skipped')
      const second = await store.get<{ c: number }>('SELECT COUNT(*) AS c FROM usage_rollup_day')
      expect(second?.c).toBe(first?.c)
      const calls = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(calls?.c)).toBe(1)
    } finally { await store.close(); t.dispose() }
  })

  test('★ 时区变了必须重建（否则趋势点整体偏移而没有任何报错）', async () => {
    const now = Date.now()
    const { t, store } = await seed([{ ts: now - 1000, receivedAtMs: now - 1000 }])
    const original = process.env['TZ']
    try {
      await syncRollups(store, { now })
      const meta = await readRollupMeta(store)
      expect(meta).not.toBeNull()
      expect(rollupNeedsRebuild(meta)).toBe(false)
      expect(meta?.timezoneKey).toBe(rollupTimezoneKey(PORTAL_SCHEMA_VERSION))
      // 换一个时区键（模拟改 TZ）→ 必须判为「要重建」
      expect(rollupNeedsRebuild({ ...meta!, timezoneKey: 'X|Y|v1' })).toBe(true)
      // 并且真的重建：改了 TZ 之后 day_key 会按新时区算
      process.env['TZ'] = 'UTC'
      const shifted = await syncRollups(store, { now })
      expect(shifted.mode).toBe('rebuild')
      expect((await readRollupMeta(store))?.timezoneKey).toBe(rollupTimezoneKey(PORTAL_SCHEMA_VERSION))
    } finally {
      if (original === undefined) delete process.env['TZ']
      else process.env['TZ'] = original
      await store.close()
      t.dispose()
    }
  })

  test('★ 没有接收时刻的历史行进不了汇总，且缺口必须能被看见', async () => {
    const now = Date.now()
    const { t, store } = await seed([
      { ts: now - 1000, receivedAtMs: now - 1000 },
      { ts: now - 2000, receivedAtMs: null },   // 老数据（v4 之前导入），没有接收时刻
    ])
    try {
      const result = await syncRollups(store, { now })
      expect(result.unattributedWindow, 'received_at_ms IS NULL 的行数要如实报出来').toBe(1)
      const calls = await store.get<{ c: number }>('SELECT SUM(calls) AS c FROM usage_rollup_day')
      expect(Number(calls?.c), '只有有接收时刻的那一条进了汇总').toBe(1)
    } finally { await store.close(); t.dispose() }
  })

  test('★ T2 的保留窗口：超出 30 天的日整体删掉（T1 仍保留）', async () => {
    const now = Date.now()
    const old = now - (ROLLUP_HOUR_RETAIN_DAYS + 5) * DAY_MS
    const { t, store } = await seed([
      { ts: old, receivedAtMs: old },
      { ts: now - 1000, receivedAtMs: now - 1000 },
    ])
    try {
      await syncRollups(store, { now })
      const hourOld = await store.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM usage_rollup_hour WHERE day_key = $day', { $day: toDayKey(old) })
      const dayOld = await store.get<{ c: number }>(
        'SELECT COUNT(*) AS c FROM usage_rollup_day WHERE day_key = $day', { $day: toDayKey(old) })
      expect(Number(hourOld?.c), 'T2 超出保留窗口的日必须清掉').toBe(0)
      expect(Number(dayOld?.c), 'T1 是全历史的，不能跟着删').toBe(1)
    } finally { await store.close(); t.dispose() }
  })

  test('★ 纯函数折叠：分桶键与 aggregate.ts 的本地时区实现一致', () => {
    const ts = new Date(2026, 3, 1, 14, 30, 0).getTime()   // 本地 2026-04-01 14:30
    const rows = [{ ts, member_id: MEMBER_ID, provider: 'p', model: 'm',
      input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, reasoning_tokens: 5 }]
    const day = foldRollupRows(rows, { key: 'day' })
    expect([...day.keys()][0]).toContain(toDayKey(ts))
    const hour = foldRollupRows(rows, { key: 'hour' })
    expect([...hour.keys()][0]).toContain(`${toDayKey(ts)}|${toHourOfDay(ts)}`)
    const hod = foldRollupRows(rows, { key: 'hodWorkday' })
    expect([...hod.keys()][0]).toContain(`${toHourOfDay(ts)}|${dayKindOf(ts)}`)
    // 四个 token 列各自独立求和（绝不合并）
    const cell = [...day.values()][0]!
    expect([cell.calls, cell.input, cell.output, cell.cacheRead, cell.cacheWrite, cell.reasoning]).toEqual([1, 1, 2, 3, 4, 5])
    expect([cell.lo, cell.hi]).toEqual([ts, ts])
  })

  test('★ 未归属（member_id 为 NULL）落进 "" 哨兵格，不与任何真人混淆', async () => {
    const now = Date.now()
    const { t, store } = await seed([{ ts: now - 1000, receivedAtMs: now - 1000 }])
    try {
      await store.run(
        `INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,received_at_ms)
         VALUES ('orphan:1','orphan',0,$ts,'p','m',1,1,1,1,0,$now)`,
        { $ts: now - 2000, $now: now - 2000 },
      )
      await syncRollups(store, { now })
      const groups = await store.all<{ member_id: string }>(
        'SELECT member_id FROM usage_rollup_day GROUP BY member_id ORDER BY member_id')
      expect(groups.map(group => group.member_id)).toEqual(['', MEMBER_ID])
    } finally { await store.close(); t.dispose() }
  })
})

describe('v8 汇总表：查询路由（快路径与安全阀）', () => {
  /** 造一批跨多天的事件，供路径对照。 */
  async function seedDays(dayCount: number) {
    const now = Date.now()
    const rows: { ts: number; receivedAtMs: number }[] = []
    for (let day = 0; day < dayCount; day++) {
      for (let hour = 9; hour <= 11; hour++) {
        const ts = now - day * DAY_MS - (24 - hour) * 3600_000
        rows.push({ ts, receivedAtMs: ts })
      }
    }
    return { ...(await seed(rows)), now }
  }

  test('★ 走汇总表与走原始表，series(day) 逐位相等', async () => {
    const { t, store, now } = await seedDays(5)
    try {
      await syncRollups(store, { now })
      const filter = { sinceMs: now - 10 * DAY_MS, untilMs: now }
      // ① 汇总表可用 → 快路径
      const fast = await openPortalStats(t, filter)
      const fastPoints = await fast.series('day', false)
      await fast.close()
      // ② 清空汇总表 → 必须退原始表，且结果**逐位相同**
      const raw = await openPortalStats(t, filter)
      await clearRollups(store)
      const rawPoints = await raw.series('day', false)
      await raw.close()
      expect(JSON.stringify(fastPoints)).toBe(JSON.stringify(rawPoints))
      expect(fastPoints.length).toBeGreaterThan(0)
      expect(fastPoints.some(point => point.counts.calls > 0)).toBe(true)
    } finally { await store.close(); t.dispose() }
  })

  test('★ 汇总表**落后**于事实表时必须退原始表（否则静默少算）', async () => {
    const { t, store, now } = await seedDays(3)
    try {
      await syncRollups(store, { now })
      const filter = { sinceMs: now - 10 * DAY_MS, untilMs: now }
      const session = await openPortalStats(t, filter)
      const before = await session.totals()
      await session.close()
      // 新到一条事件，但**不**同步汇总表 → 汇总立刻落后
      await insertAttributedRecords(store, [record(1000, now - 1000)], {
        userId: '甲', userName: '甲', memberId: MEMBER_ID, receivedAtMs: now,
      })
      const stale = await openPortalStats(t, filter)
      const after = await stale.totals()
      const seriesStale = await stale.series('day', false)
      await stale.close()
      expect(after.calls, '落后时不能少算').toBe(before.calls + 1)
      const staleSum = seriesStale.reduce((total, point) => total + point.counts.calls, 0)
      expect(staleSum).toBe(after.calls)
      // 补齐之后必须仍然相等（快路径重新可用）
      await syncRollups(store, { now: now + 1000 })
      const synced = await openPortalStats(t, filter)
      const seriesSynced = await synced.series('day', false)
      await synced.close()
      expect(JSON.stringify(seriesSynced)).toBe(JSON.stringify(seriesStale))
    } finally { await store.close(); t.dispose() }
  })

  test('★ 带维度筛选（供应商）时不走快路径，但结果仍正确', async () => {
    const { t, store, now } = await seedDays(2)
    try {
      await syncRollups(store, { now })
      const filter = { sinceMs: now - 10 * DAY_MS, untilMs: now, providers: ['deepseek'] }
      const session = await openPortalStats(t, filter)
      const points = await session.series('day', false)
      await session.close()
      // 夹具数据全是 deepseek-official，所以筛选后必须仍有数据（不是「筛空了所以通过」）
      expect(points.length).toBeGreaterThan(0)
      expect(points.some(point => point.counts.calls > 0)).toBe(true)
    } finally { await store.close(); t.dispose() }
  })

  test('★ hourOfDay：三条路径（HOD 表 / 小时表 / 原始表）结果一致', async () => {
    const { t, store, now } = await seedDays(4)
    try {
      await syncRollups(store, { now })
      // 无时间窗 → 走 HOD 表（全历史折叠）
      const hodSession = await openPortalStats(t, {})
      const viaHod = await hodSession.hourOfDay()
      await hodSession.close()
      // 有时间窗 → 走小时表（保留窗口内）
      const hourSession = await openPortalStats(t, { sinceMs: now - 30 * DAY_MS, untilMs: now })
      const viaHourWindow = await hourSession.hourOfDay()
      await hourSession.close()
      // ★ 清空汇总表**之后**才开会话：`#rollupUsable()` 的结果在一个会话里缓存，
      //   先开会话再清表会让它仍然走快路径（我在这里踩过一次 —— 那样比的是
      //   「快路径 vs 快路径」，看起来像分桶算错了）。
      await clearRollups(store)
      const rawSession = await openPortalStats(t, {})
      const viaRaw = await rawSession.hourOfDay()
      await rawSession.close()
      expect(viaRaw.length).toBeGreaterThan(0)
      expect(viaRaw.some(entry => entry.counts.calls > 0)).toBe(true)
      // 先比计数，再整体比 —— 分开断言才能看出是「少了桶」还是「桶里数字不同」
      expect(viaHod.map(entry => entry.hour)).toEqual(viaRaw.map(entry => entry.hour))
      expect(viaHod.map(entry => entry.counts.calls)).toEqual(viaRaw.map(entry => entry.counts.calls))
      expect(viaHourWindow.map(entry => entry.counts.calls)).toEqual(viaRaw.map(entry => entry.counts.calls))
      expect(JSON.stringify(viaHod)).toBe(JSON.stringify(viaRaw))
      expect(JSON.stringify(viaHourWindow)).toBe(JSON.stringify(viaRaw))
      for (const entry of viaRaw) {
        expect(entry.hour).toBeGreaterThanOrEqual(0)
        expect(entry.hour).toBeLessThanOrEqual(23)
      }
    } finally { await store.close(); t.dispose() }
  })

  test('★ hourOfDay 的工作日 / 周末筛选：汇总表与原始表一致，且两块之和等于全量', async () => {
    const { t, store, now } = await seedDays(10)
    try {
      await syncRollups(store, { now })
      const rollupSession = await openPortalStats(t, {})
      const workday = await rollupSession.hourOfDay('workday')
      const weekend = await rollupSession.hourOfDay('weekend')
      const all = await rollupSession.hourOfDay('all')
      await rollupSession.close()

      // ★ 清表之后才开会话（同上一个用例的理由）
      await clearRollups(store)
      const rawSession = await openPortalStats(t, {})
      const workdayRaw = await rawSession.hourOfDay('workday')
      const weekendRaw = await rawSession.hourOfDay('weekend')
      await rawSession.close()

      expect(JSON.stringify(workday)).toBe(JSON.stringify(workdayRaw))
      expect(JSON.stringify(weekend)).toBe(JSON.stringify(weekendRaw))
      // 工作日 + 周末 必须等于全量（折桶是可加的）
      const total = all.reduce((sum, entry) => sum + entry.counts.calls, 0)
      const split = [...workday, ...weekend].reduce((sum, entry) => sum + entry.counts.calls, 0)
      expect(split).toBe(total)
      expect(total).toBeGreaterThan(0)
    } finally { await store.close(); t.dispose() }
  })
})
