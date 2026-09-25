/**
 * 部门看板查询接口测试（`GET /api/v1/stats/*`，S7）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **鉴权必须是非 2xx**（401 / 503）—— 这个响应体里装的是**数据**。
 *    回 `200 + ok:false` 会让前端把「token 不对」渲染成「这段时间没人用」，
 *    一个 0 值空看板比一个明确的 401 危险得多。
 * 2. ★ **口径不漂移** —— `cacheHitRate` / `unattributedRate` 必须与
 *    `shared/metrics.ts` 逐位相等。服务端一旦自己重写公式，这里立刻失败。
 * 3. **四项 token 分列**（铁律 3），`totalTokens` 必须等于四项之和。
 * 4. ★ **人员排行的两条硬要求**：未归属必须成组出现（`unknown`），
 *    按人筛选必须**精确匹配**（否则「张三」会把「张三丰」并进来，
 *    而这是数据错误，不是便利）。
 * 5. **参数校验** —— 非法 period / by / bucket / limit 必须 400，
 *    不许静默兜底成「全部时间」。兜底会让页面显示一个巨大的数，
 *    而用户以为自己在看「今天」。
 * 6. **明细分页稳定** —— 同一毫秒的多条记录靠 (ts, seq) 定序，
 *    否则翻页会重复上一页的最后一行。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { insertRecords, openPortalDb } from '@ai-token-report/core/db'
import { cacheHitRate, unattributedRate, UNATTRIBUTED_USER } from '@ai-token-report/shared'

import { CredentialStore } from '../src/credentials.js'
import { IngestRoute } from '../src/ingest-route.js'
import { StatsRoute, type StatsRouteResult } from '../src/stats-route.js'

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-stats-api-'))
  dbPath = join(home, 'token-report', 'portal.sqlite')
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 三个人：张三 / 张三丰 用于验证按人筛选是精确匹配而不是子串匹配。 */
const STORE = CredentialStore.from([
  { token: 'tok-zhang', name: '张三', dept: '研发一部' },
  { token: 'tok-zhangsf', name: '张三丰', dept: '研发一部' },
  { token: 'tok-li', name: '李四', dept: '研发二部' },
])

function stats(store: CredentialStore = STORE): StatsRoute {
  return new StatsRoute({ credentials: store, dbPath })
}

/** 造一条线上记录。 */
function rec(eventId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: eventId,
    session_id: 'session-1',
    seq: 1,
    ts: todayAt(10),
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 1020,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** 通过真实上报接口落库（顺带覆盖「归属只信服务端」这条链路）。 */
async function report(token: string, records: unknown[]): Promise<void> {
  const route = new IngestRoute({ credentials: STORE, dbPath })
  const res = await route.submit(
    {
      schemaVersion: 1,
      client: { userId: 'ignored', userName: 'ignored' },
      generatedAt: new Date().toISOString(),
      records,
    },
    `Bearer ${token}`,
  )
  expect(res.status).toBe(200)
}

/**
 * 直接写一批**没有归属**的行（`user_id IS NULL`）。
 *
 * 现实里这种行来自「本机库直接导出」或早期没有归属列的数据；
 * 看板必须能把它们显示成 `unknown` 而不是让它们从人员排行里消失。
 */
function seedUnattributed(
  rows: {
    eventId: string
    sessionId: string
    seq: number
    ts: number
    input: number
    output: number
    cacheRead: number
  }[],
): void {
  const db = openPortalDb(dbPath)
  try {
    insertRecords(
      db,
      rows.map((r) => ({
        eventId: r.eventId,
        sessionId: r.sessionId,
        seq: r.seq,
        time: r.ts,
        provider: 'dashscope',
        model: 'deepseek-v4.1-flash',
        cwd: null,
        turn: null,
        step: null,
        usage: {
          input: r.input,
          output: r.output,
          cacheRead: r.cacheRead,
          cacheWrite: 0,
          reasoning: 0,
          total: r.input + r.output + r.cacheRead,
          calls: 1,
        },
      })),
    )
  } finally {
    db.close()
  }
}

/** 今天某个时刻（保证落在 `period=today` 窗口内）。 */
function todayAt(hour: number, minute = 0): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

async function get(
  sub: string,
  params: Record<string, string> = {},
  auth: string | null = 'Bearer tok-zhang',
  store: CredentialStore = STORE,
): Promise<StatsRouteResult> {
  return stats(store).handle(sub, new URLSearchParams(params), auth)
}

describe('部门看板鉴权', () => {
  test('未配置凭证时回 503（等管理员发凭证才有用）', async () => {
    const res = await get('overview', {}, 'Bearer whatever', CredentialStore.empty())
    expect(res.status).toBe(503)
    expect(String((res.body as { reason: string }).reason)).toContain('凭证')
  })

  test('缺 Authorization 头回 401，且文案指着「去页面填 token」', async () => {
    const res = await get('overview', {}, null)
    expect(res.status).toBe(401)
    const reason = String((res.body as { reason: string }).reason)
    // 文案必须指着动作。写成「上报请求缺少 Authorization 头」会把运维引错方向。
    expect(reason).toContain('token')
    expect(reason).not.toContain('上报')
  })

  test('token 不对回 401', async () => {
    const res = await get('overview', {}, 'Bearer tok-nope')
    expect(res.status).toBe(401)
    expect(String((res.body as { reason: string }).reason)).toContain('无效')
  })

  test('★ 鉴权失败绝不能是 2xx（前端会把 2xx 当数据渲染）', async () => {
    for (const auth of [null, 'Bearer bad']) {
      const res = await get('overview', {}, auth)
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
  })

  test('未知子路径回 404（鉴权通过后）', async () => {
    const res = await get('nope')
    expect(res.status).toBe(404)
  })
})

describe('部门总览口径', () => {
  test('四项 token 分列，total 等于四项之和', async () => {
    await report('tok-zhang', [
      rec('e1', { seq: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 900 }),
      rec('e2', { seq: 2, input_tokens: 300, output_tokens: 40, cache_read_tokens: 700 }),
    ])

    const res = await get('overview', { period: 'today' })
    expect(res.status).toBe(200)
    const b = res.body as Record<string, number>

    expect(b['inputTokens']).toBe(400)
    expect(b['outputTokens']).toBe(60)
    expect(b['cacheReadTokens']).toBe(1600)
    expect(b['cacheWriteTokens']).toBe(0)
    expect(b['calls']).toBe(2)
    expect(b['totalTokens']).toBe(400 + 60 + 1600 + 0)
    // ★ cacheRead 绝不能被并进 input（那样会漏掉 94% 的用量）
    expect(b['inputTokens']).not.toBe(2000)
  })

  test('cacheHitRate / unattributedRate 与 shared 的公式逐位相等', async () => {
    await report('tok-zhang', [
      rec('e1', { seq: 1, input_tokens: 7777, output_tokens: 186, cache_read_tokens: 1024 }),
      rec('e2', { seq: 2, input_tokens: 2223, output_tokens: 14, cache_read_tokens: 98976 }),
    ])
    // 一条没有归属的行 —— 覆盖率分子
    seedUnattributed([{ eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(11), input: 1, output: 1, cacheRead: 1 }])

    const res = await get('overview', { period: 'today' })
    const b = res.body as Record<string, number>

    // 唯一真源：shared/src/metrics.ts
    // ⚠️ 那条未归属的行也计入总量（它同样是这次调用），分子分母必须包含它 ——
    //   这正是「按同一组筛选条件取数」的含义。
    const expectedHit = cacheHitRate({
      input: 7777 + 2223 + 1,
      cacheRead: 1024 + 98976 + 1,
    })
    expect(b['cacheHitRate']).toBe(expectedHit)
    expect(b['unattributedRate']).toBe(unattributedRate(1, 3))
    // 分母是 cacheRead + input，不是 input
    expect(b['cacheHitRate']).toBeCloseTo(100_001 / 110_002, 6)
  })

  test('range 带上服务端解析出的时间窗与口径标签', async () => {
    const res = await get('overview', { period: 'last7d' })
    const range = (res.body as { range: { from: number | null; to: number | null; label: string } })
      .range

    expect(range.from).toBeGreaterThan(0)
    expect(range.to).toBeNull()
    // ★ 标签由服务端给，前端不重算「最近 7 天」是哪 7 天
    expect(range.label).toBe('最近 7 天（自然日）')
  })

  test('空库返回全 0 而不是抛错（无调用时占比为 0 而非 NaN）', async () => {
    const res = await get('overview', { period: 'today' })
    const b = res.body as Record<string, number>
    expect(res.status).toBe(200)
    expect(b['totalTokens']).toBe(0)
    expect(b['cacheHitRate']).toBe(0)
    expect(b['unattributedRate']).toBe(0)
  })
})

describe('★ 人员排行（部门看板的核心诉求）', () => {
  test('按用量降序，未归属成组出现在 unknown 键上', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await report('tok-li', [rec('l1', { input_tokens: 400, output_tokens: 0, cache_read_tokens: 0 })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(9), input: 700, output: 0, cacheRead: 0 },
    ])

    const res = await get('breakdown', { period: 'today', by: 'user' })
    expect(res.status).toBe(200)
    const rows = (res.body as { rows: { key: string; totalTokens: number }[] }).rows

    expect(rows.map((r) => r.key)).toEqual(['张三', UNATTRIBUTED_USER, '李四'])
    expect(rows[0]!.totalTokens).toBe(1000)
    // ★ 未归属必须看得见：它没被 GROUP BY 丢进 NULL
    expect(rows[1]!.key).toBe(UNATTRIBUTED_USER)
    expect(rows[1]!.totalTokens).toBe(700)
  })

  test('★ 按人筛选是精确匹配（张三不并进张三丰）', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await report('tok-zhangsf', [rec('f1', { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })])

    const only = await get('overview', { period: 'today', user: '张三' })
    expect((only.body as Record<string, number>)['totalTokens']).toBe(1000)
    expect((only.body as Record<string, number>)['calls']).toBe(1)

    // 子串匹配会把两条都算进来（1500）—— 这正是我们要避免的
    const sf = await get('overview', { period: 'today', user: '张三丰' })
    expect((sf.body as Record<string, number>)['totalTokens']).toBe(500)
  })

  test('★ 多人筛选：逗号分隔（页面的人员筛选走的就是这条路）', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await report('tok-zhangsf', [rec('f1', { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })])
    await report('tok-li', [rec('l1', { input_tokens: 400, output_tokens: 0, cache_read_tokens: 0 })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(9), input: 700, output: 0, cacheRead: 0 },
    ])

    // 「张三」+「未署名」两个条件之间是 OR，且都是精确匹配
    const res = await get('overview', { period: 'today', user: `张三,${UNATTRIBUTED_USER}` })
    expect(res.status).toBe(200)
    const b = res.body as Record<string, number>
    expect(b['totalTokens']).toBe(1000 + 700)
    expect(b['calls']).toBe(2)
    // 未归属占比打的是同一组筛选（分子 700 / 分母 2 条…按 calls 算：1/2）
    expect(b['unattributedRate']).toBe(unattributedRate(1, 2))

    // 排行里也只剩这两行（多人筛选同样作用于 breakdown）
    const rank = await get('breakdown', { period: 'today', by: 'user', user: `张三,${UNATTRIBUTED_USER}` })
    expect((rank.body as { rows: { key: string }[] }).rows.map((r) => r.key)).toEqual([
      '张三',
      UNATTRIBUTED_USER,
    ])
  })

  test('user=unknown 筛出未归属的数据', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(9), input: 700, output: 0, cacheRead: 0 },
    ])

    const res = await get('overview', { period: 'today', user: UNATTRIBUTED_USER })
    expect((res.body as Record<string, number>)['totalTokens']).toBe(700)
    // 只看未归属时，未归属占比必然是 1
    expect((res.body as Record<string, number>)['unattributedRate']).toBe(1)
  })

  test('未归属筛选与定位到具体的人时占比为 0（分子分母同筛选条件）', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(9), input: 700, output: 0, cacheRead: 0 },
    ])

    const res = await get('overview', { period: 'today', user: '张三' })
    const b = res.body as Record<string, number>
    expect(b['calls']).toBe(1)
    // 若分子分母取自不同数据集，这里会得到 1/2 甚至 >1 的荒谬值
    expect(b['unattributedRate']).toBe(0)
  })

  test('provider / model 子串过滤与 CLI 语义一致', async () => {
    await report('tok-zhang', [
      rec('a1', { provider: 'dashscope', model: 'deepseek-v4.1-flash' }),
      rec('a2', { seq: 2, provider: 'openai', model: 'gpt-4o' }),
    ])

    const byProv = await get('overview', { period: 'today', provider: 'dash' })
    expect((byProv.body as Record<string, number>)['calls']).toBe(1)
    // 大小写不敏感
    const upper = await get('overview', { period: 'today', provider: 'DASHSCOPE' })
    expect((upper.body as Record<string, number>)['calls']).toBe(1)
    const byModel = await get('overview', { period: 'today', model: 'gpt-4o' })
    expect((byModel.body as Record<string, number>)['calls']).toBe(1)
  })
})

describe('部门趋势与明细', () => {
  test('series 补零让趋势连续', async () => {
    const day = 86_400_000
    await report('tok-zhang', [
      rec('d1', { seq: 1, ts: Date.now() - 3 * day }),
      rec('d2', { seq: 2, ts: Date.now() - 1 * day }),
    ])

    const res = await get('series', { bucket: 'day' })
    expect(res.status).toBe(200)
    const points = (res.body as { bucket: string; points: { totalTokens: number }[] }).points
    expect(points.length).toBe(3)
    expect(points.filter((p) => p.totalTokens === 0).length).toBe(1)
  })

  test('series 每个点都带命中率（前端不重算）', async () => {
    await report('tok-zhang', [rec('p1', { input_tokens: 100, output_tokens: 1, cache_read_tokens: 900 })])
    const res = await get('series', { bucket: 'hour' })
    const points = (res.body as { points: { cacheHitRate: number; totalTokens: number }[] }).points
    const nonEmpty = points.filter((p) => p.totalTokens > 0)
    expect(nonEmpty.length).toBe(1)
    expect(nonEmpty[0]!.cacheHitRate).toBeCloseTo(0.9, 6)
  })

  test('records 分页：总数、页大小、最新在前、未归属映射成 unknown', async () => {
    await report('tok-zhang', [
      rec('r1', { seq: 1, ts: todayAt(9) }),
      rec('r2', { seq: 2, ts: todayAt(11) }),
      rec('r3', { seq: 3, ts: todayAt(10) }),
    ])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(8), input: 1, output: 1, cacheRead: 1 },
    ])

    const all = await get('records', { period: 'today', limit: '10', offset: '0' })
    expect(all.status).toBe(200)
    const body = all.body as {
      total: number
      limit: number
      offset: number
      rows: { eventId: string; ts: number; userId: string }[]
    }
    expect(body.total).toBe(4)
    expect(body.limit).toBe(10)
    expect(body.offset).toBe(0)
    // 最新在前
    expect(body.rows.map((r) => r.eventId)).toEqual(['r2', 'r3', 'r1', 'u1'])
    // ★ 未归属统一成协议里的 unknown，而不是 null
    expect(body.rows[3]!.userId).toBe(UNATTRIBUTED_USER)

    const page2 = await get('records', { period: 'today', limit: '2', offset: '2' })
    const p2 = page2.body as { rows: { eventId: string }[] }
    expect(p2.rows.map((r) => r.eventId)).toEqual(['r1', 'u1'])
  })

  test('默认分页大小为 100，且 limit/offset 有区间校验', async () => {
    await report('tok-zhang', [rec('r1')])
    const def = await get('records', { period: 'today' })
    expect((def.body as { limit: number }).limit).toBe(100)

    for (const q of [{ limit: '0' }, { limit: '99999' }, { offset: '-1' }, { limit: 'abc' }]) {
      const res = await get('records', { period: 'today', ...q })
      expect(res.status).toBe(400)
    }
  })
})

describe('采集诊断', () => {
  test('人数、未归属、时间边界与最近落库时刻', async () => {
    await report('tok-zhang', [rec('z1', { ts: todayAt(9) })])
    await report('tok-li', [rec('l1', { ts: todayAt(10) })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(8), input: 1, output: 1, cacheRead: 1 },
    ])

    const res = await get('diagnostics', { period: 'today' })
    expect(res.status).toBe(200)
    const b = res.body as Record<string, number | null>

    expect(b['totalEvents']).toBe(3)
    expect(b['unattributedEvents']).toBe(1)
    expect(b['unattributedRate']).toBe(unattributedRate(1, 3))
    // ★ 库里不存 total 列，恒等式在写入时即成立 —— 这个 0 是结构性的
    expect(b['identityViolations']).toBe(0)
    expect(b['distinctUsers']).toBe(2)
    expect(b['earliestTs']).toBe(todayAt(8))
    expect(b['latestTs']).toBe(todayAt(10))
    // 上报接口写下的时刻必须读得回来（看板据此显示「数据多新」）
    expect(typeof b['lastIngestAt']).toBe('number')
    expect(b['lastIngestAt']! > 0).toBe(true)
  })
})

describe('参数校验（不许静默兜底）', () => {
  test('未知 period 回 400', async () => {
    const res = await get('overview', { period: 'bogus' })
    expect(res.status).toBe(400)
    expect(String((res.body as { reason: string }).reason)).toContain('bogus')
  })

  test('未知分组维度回 400', async () => {
    const res = await get('breakdown', { by: 'nope' })
    expect(res.status).toBe(400)
    expect(String((res.body as { reason: string }).reason)).toContain('nope')
  })

  test('未知 bucket 回 400', async () => {
    const res = await get('series', { bucket: 'week' })
    expect(res.status).toBe(400)
  })

  test('非法的 from / to 回 400（不能被当成「没给」）', async () => {
    const res = await get('overview', { from: 'abc' })
    expect(res.status).toBe(400)
    const res2 = await get('overview', { to: 'abc' })
    expect(res2.status).toBe(400)
  })

  test('from 晚于 to 回 400', async () => {
    const res = await get('overview', { from: String(Date.now()), to: String(Date.now() - 1000) })
    expect(res.status).toBe(400)
  })

  test('显式 from/to 优先于 period，且标签改成绝对区间', async () => {
    const from = todayAt(9)
    const to = todayAt(12)
    await report('tok-zhang', [
      rec('in', { seq: 1, ts: todayAt(10) }),
      rec('out', { seq: 2, ts: todayAt(14) }),
    ])

    const res = await get('overview', { period: 'today', from: String(from), to: String(to) })
    const body = res.body as {
      calls: number
      range: { from: number; to: number; label: string }
    }
    expect(body.calls).toBe(1)
    expect(body.range.from).toBe(from)
    expect(body.range.to).toBe(to)
    // 具名周期的标签此时已不准确，必须换成绝对区间描述
    expect(body.range.label).toContain('~')
  })
})

describe('上报库不可重建（S7 时期也不能破例）', () => {
  test('schema 版本不符时查询报 500 并说明原因，而不是返回空数据', async () => {
    const db = openPortalDb(dbPath)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const res = await get('overview', { period: 'today' })
    expect(res.status).toBe(500)
    const reason = String((res.body as { reason: string }).reason)
    expect(reason).toContain('上报库')
    // 明确告诉管理员该怎么办，而不是一句「内部错误」
    expect(reason).toContain('备份')
  })
})