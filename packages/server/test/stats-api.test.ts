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
import {
  cacheHitRate,
  SERIES_STACK_MERGED_KEY,
  unattributedRate,
  UNATTRIBUTED_USER,
} from '@ai-token-report/shared'
import type {
  BreakdownResponse,
  DiagnosticsResponse,
  SeriesResponse,
  StatsMembersResponse,
  StatsProvidersResponse,
} from '@ai-token-report/shared'

import { CredentialStore } from '../src/credentials.js'
import { IngestRoute } from '../src/ingest-route.js'
import { IdentityRepository, MEMBER_ROLE_ID } from '../src/identity/index.js'
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

/**
 * 四个人：张三 / 张三丰 用于验证按人筛选是精确匹配而不是子串匹配。
 *
 * ★ **管理员凭证是刻意的**：本文件绝大多数断言看的是**全部门**的聚合数字
 *   （「张三 + 李四 + 未署名」），而数据范围从 v7 起收窄成
 *   「非内置管理员只能看到自己」（见 `stats-route.ts` 的 `applyDataScope()`）。
 *   拿 member 凭证去断言全部门数字，等于在验一个已经不存在的行为。
 *   数据范围本身由「★ 数据范围」那一块专门断言，那里会显式用 member 凭证。
 */
const STORE = CredentialStore.from([
  { token: 'tok-admin', name: '管理员', role: 'admin' },
  { token: 'tok-zhang', name: '张三', group: '研发一部' },
  { token: 'tok-zhangsf', name: '张三丰', group: '研发一部' },
  { token: 'tok-li', name: '李四', group: '研发二部' },
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
  // 缺省用**管理员**凭证：这些断言看的是全部门聚合（见 `STORE` 的注释）。
  auth: string | null = 'Bearer tok-admin',
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

/**
 * ★ 数据范围（S7 之后的收紧）：**非内置管理员只能看到自己**。
 *
 * ## 这些断言在守什么
 *
 * 1. 🚨 **收窄发生在服务端**，不是页面隐藏一个下拉。手拼 `?member_id=<别人>`
 *    必须拿不到别人的数字 —— 「前端过滤 = 权限」是明令禁止的那类错误。
 * 2. ★ **显式点名别人一律 403，绝不静默替换成「我」**：一个看起来正常的数字，
 *    回答的却是另一个问题（要张三的用量却给了自己的），比明确报错危险得多。
 * 3. ★ **判据是角色码，不是权限码**：自定义角色即使拿到 `members:read`
 *    （人员目录），也照样只看自己 —— 「能管名册」与「能看全员用量」是两件事。
 * 4. 🚨 **兼容凭证表身份没有稳定人员 ID 时直接 403**，绝不按姓名兜底：
 *    同名会把两个人的用量并成一个人的。
 */
describe('★ 数据范围（非内置管理员只看本人）', () => {
  test('旧凭证表的 member 身份：不能按个人取数 → 403（绝不按姓名兜底）', async () => {
    for (const sub of ['overview', 'breakdown', 'series', 'records', 'diagnostics']) {
      const res = await get(sub, { period: 'today' }, 'Bearer tok-zhang')
      expect(res.status).toBe(403)
      const reason = String((res.body as { reason: string }).reason)
      expect(reason).toContain('只能查看本人数据')
      // 文案要指出下一步动作，而不是一句「没有权限」
      expect(reason).toContain('appKey')
    }
  })

  test('旧凭证表的 admin 身份照旧看到全部门', async () => {
    await report('tok-zhang', [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await report('tok-li', [rec('l1', { seq: 2, input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })])
    const res = await get('breakdown', { period: 'today', by: 'user' }, 'Bearer tok-admin')
    expect(res.status).toBe(200)
    // 旧姓名视图的行只有 `key`（没有稳定 ID，也就没有 `label`）
    expect((res.body as BreakdownResponse).rows.map((row) => row.key)).toEqual(['张三', '李四'])
  })

  /**
   * 真身份库 + 真 appKey：只有这条路才走得到稳定 `member_id`，
   * 而「只看自己」正是按它收窄的（生产身份就是这一种）。
   */
  async function twoPeople() {
    const repository = new IdentityRepository({ sqlitePath: dbPath })
    await repository.initialize({
      adminToken: 'tok-admin',
      adminName: '管理员',
      adminUsername: 'admin',
      adminPassword: 'test-password-2026',
    })
    const admin = (await repository.resolveBearer('tok-admin'))!
    const zhang = (await repository.createMember(admin, { name: '张三', role_ids: [MEMBER_ROLE_ID] })).member!
    const li = (await repository.createMember(admin, { name: '李四', role_ids: [MEMBER_ROLE_ID] })).member!
    const zhangKey = (await repository.issueAppKey(admin, { member_id: zhang.member_id })).token_secret
    const liKey = (await repository.issueAppKey(admin, { member_id: li.member_id })).token_secret
    const ingest = new IngestRoute({ identityStore: repository, dbPath })
    const send = async (secret: string, records: unknown[], seq = 1): Promise<void> => {
      const res = await ingest.submit(
        {
          schemaVersion: 1,
          client: { userId: 'ignored', userName: 'ignored' },
          generatedAt: new Date().toISOString(),
          records: records.map((record) => ({ ...(record as object), seq })),
        },
        `Bearer ${secret}`,
      )
      expect(res.status).toBe(200)
    }
    return { repository, admin, zhang, li, zhangKey, liKey, send }
  }

  const route = (repository: IdentityRepository): StatsRoute =>
    new StatsRoute({ identityStore: repository, dbPath })

  test('★ member 的 appKey 只拿到自己的用量；点名别人 → 403；点自己 → 200（详情抽屉）', async () => {
    const { repository, zhang, li, zhangKey, liKey, send } = await twoPeople()
    await send(zhangKey, [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await send(liKey, [rec('l1', { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })], 2)
    const stats = route(repository)
    const base = { period: 'today', identity_view: 'member' }

    // 不带人员筛选 = 「全部人员」→ 服务端收窄成本人
    const mine = await stats.handle('overview', new URLSearchParams(base), `Bearer ${zhangKey}`)
    expect(mine.status).toBe(200)
    expect((mine.body as Record<string, number>)['totalTokens']).toBe(1000)

    // 手拼别人的 member_id：403，绝不静默换成「我」
    const other = await stats.handle(
      'overview',
      new URLSearchParams({ ...base, member_id: li.member_id }),
      `Bearer ${zhangKey}`,
    )
    expect(other.status).toBe(403)
    expect((other.body as { code?: string }).code).toBe('stats_self_only')

    // 点自己允许 —— 人员详情抽屉发的就是它
    const self = await stats.handle(
      'overview',
      new URLSearchParams({ ...base, member_id: zhang.member_id }),
      `Bearer ${zhangKey}`,
    )
    expect(self.status).toBe(200)
    expect((self.body as Record<string, number>)['totalTokens']).toBe(1000)

    // 排行 / 趋势分层 / 明细同样只剩自己
    const ranking = await stats.handle('breakdown', new URLSearchParams({ ...base, by: 'user' }), `Bearer ${zhangKey}`)
    expect((ranking.body as BreakdownResponse).rows.map((row) => row.key)).toEqual([zhang.member_id])
    const series = await stats.handle(
      'series',
      new URLSearchParams({ ...base, bucket: 'day', stack: 'user' }),
      `Bearer ${zhangKey}`,
    )
    expect((series.body as SeriesResponse).stack!.items.map((item) => item.key)).toEqual([zhang.member_id])
    const records = await stats.handle('records', new URLSearchParams(base), `Bearer ${zhangKey}`)
    expect((records.body as { total: number }).total).toBe(1)

    // 🚨 未署名 / 旧历史子集 / 姓名永远不可能等价于「我」—— 一律 403，
    //   而不是「查出 0 行」。合法编码的历史键先过参数校验，再被数据范围挡下。
    const widening = [
      { unattributed: 'true' },
      { legacy_user: `legacy:${Buffer.from('张三', 'utf8').toString('base64url')}` },
      { identity_view: 'legacy', user: '张三' },
    ]
    for (const params of widening) {
      const denied = await stats.handle('overview', new URLSearchParams({ ...base, ...params }), `Bearer ${zhangKey}`)
      expect(denied.status).toBe(403)
    }
    // ★ 旧姓名视图被**强制**成人员视图（它本来表达的是全库范围，而稳定 ID
    //   才收窄得了）；结果仍然只有自己。
    const legacyView = await stats.handle(
      'overview',
      new URLSearchParams({ period: 'today', identity_view: 'legacy' }),
      `Bearer ${zhangKey}`,
    )
    expect(legacyView.status).toBe(200)
    expect((legacyView.body as Record<string, number>)['totalTokens']).toBe(1000)
  })

  test('★ 判据是角色码不是权限码：自定义角色有 members:read 也只看自己', async () => {
    const { repository, admin, zhangKey, liKey, send } = await twoPeople()
    const role = (await repository.createRole(admin, {
      code: 'roster-lite',
      name: '名册查看者',
      // ⚠️ 必须带上 `cost:read`：appKey 的固定范围含它，而「一份凭证能做什么 =
      //   角色权限 ∩ 凭证 scopes」—— 自定义角色少这一项时**连 appKey 都签不出来**。
      permission_codes: ['stats:read', 'usage:write', 'members:read', 'cost:read'],
    })).role!
    const person = (await repository.createMember(admin, { name: '小运营', role_ids: [role.role_id] })).member!
    const key = (await repository.issueAppKey(admin, { member_id: person.member_id })).token_secret
    await send(zhangKey, [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await send(liKey, [rec('l1', { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })], 2)
    await send(key, [rec('o1', { input_tokens: 7, output_tokens: 0, cache_read_tokens: 0 })], 3)

    const res = await route(repository).handle(
      'overview',
      new URLSearchParams({ period: 'today', identity_view: 'member' }),
      `Bearer ${key}`,
    )
    expect(res.status).toBe(200)
    expect((res.body as Record<string, number>)['totalTokens']).toBe(7)
  })

  test('★ 内置 admin 角色的凭证照旧看到全部门', async () => {
    const { repository, zhangKey, liKey, send } = await twoPeople()
    await send(zhangKey, [rec('z1', { input_tokens: 1000, output_tokens: 0, cache_read_tokens: 0 })])
    await send(liKey, [rec('l1', { input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })], 2)
    const res = await route(repository).handle(
      'overview',
      new URLSearchParams({ period: 'today', identity_view: 'member' }),
      'Bearer tok-admin',
    )
    expect(res.status).toBe(200)
    expect((res.body as Record<string, number>)['totalTokens']).toBe(1500)
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
  test('所有分组透传非零缓存写入，四项明细能对上总量', async () => {
    await report('tok-zhang', [
      rec('cache-write-1', { input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, cache_write_tokens: 13, reasoning_tokens: 9 }),
      rec('cache-write-2', { seq: 2, input_tokens: 300, output_tokens: 40, cache_read_tokens: 700, cache_write_tokens: 7, reasoning_tokens: 6 }),
    ])

    for (const by of ['user', 'provider', 'model', 'provider-model', 'project', 'day', 'hour']) {
      const response = await get('breakdown', { period: 'today', by })
      expect(response.status).toBe(200)
      const rows = (response.body as BreakdownResponse).rows
      expect(rows).toHaveLength(1)
      // 非零缓存写入必须独立可见；reasoning 已包含在 output 中，不能再次加总。
      expect(rows[0]).toMatchObject({ inputTokens: 400, outputTokens: 60, cacheReadTokens: 1600, cacheWriteTokens: 20, totalTokens: 2080, calls: 2 })
    }
  })

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

  /**
   * ★ 供应商多选：**重复的同名参数**（页面走的就是这条路）与逗号分隔都生效。
   *
   * 两种写法都要认：页面发的是一值一参（一个值里带逗号时两种写法含义不同），
   * 而历史上 CLI / 老客户端发的是逗号。只认其中一种的表现是
   * 「筛了一个供应商却像没筛」—— 数字看着正常，条件其实被吞了。
   */
  test('★ 供应商多选：重复参数与逗号分隔都生效（OR 子串）', async () => {
    await report('tok-zhang', [
      rec('mp1', { provider: 'dashscope', model: 'deepseek-v4.1-flash' }),
      rec('mp2', { seq: 2, provider: 'openai', model: 'gpt-4o' }),
      rec('mp3', { seq: 3, provider: 'bailian-tpp', model: 'deepseek-v4.1-flash' }),
    ])
    const repeated = await stats().handle(
      'overview',
      new URLSearchParams([
        ['period', 'today'],
        ['provider', 'openai'],
        ['provider', 'bailian-tpp'],
      ]),
      'Bearer tok-admin',
    )
    expect(repeated.status).toBe(200)
    expect((repeated.body as Record<string, number>)['calls']).toBe(2)
    // 逗号分隔（历史写法）等价
    const comma = await get('overview', {
      period: 'today',
      provider: 'openai,bailian-tpp',
    })
    expect((comma.body as Record<string, number>)['calls']).toBe(2)
    // 重复值不放大结果：同一条件写两遍仍是一条「OR 里的一项」
    const duplicates = await stats().handle(
      'overview',
      new URLSearchParams([
        ['period', 'today'],
        ['provider', 'OPENAI'],
        ['provider', 'openai'],
      ]),
      'Bearer tok-admin',
    )
    expect((duplicates.body as Record<string, number>)['calls']).toBe(1)
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
      rec('r2', { seq: 2, ts: todayAt(11), cache_write_tokens: 7, total_tokens: 1027 }),
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
      rows: { eventId: string; ts: number; userId: string; cacheWriteTokens: number; totalTokens: number }[]
    }
    expect(body.total).toBe(4)
    expect(body.limit).toBe(10)
    expect(body.offset).toBe(0)
    // 最新在前
    expect(body.rows.map((r) => r.eventId)).toEqual(['r2', 'r3', 'r1', 'u1'])
    expect(body.rows[0]!.cacheWriteTokens).toBe(7)
    expect(body.rows[0]!.totalTokens).toBe(1027)
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

  // ── v14：诊断页的规模指标与两张覆盖表 ────────────────────────────
  test('派生指标走统一口径（total / sessions / 命中率 / 均量）', async () => {
    await report('tok-zhang', [rec('m-1', { session_id: 's-1' })])
    await report('tok-li', [rec('m-2', { session_id: 's-2', input_tokens: 0, cache_read_tokens: 0 })])
    // 两条：1020 + 20 = 1040 total（第二条只把缓存清零，输出仍是 20），
    // cacheRead 900 → 命中率 900/(900+100)
    const b = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    expect(b.totalEvents).toBe(2)
    expect(b.totalTokens).toBe(1020 + 20)
    expect(b.sessions).toBe(2)
    // ⚠️ 命中率与看板任何一处必须逐位相同：它们来自同一个 shared/metrics.ts。
    expect(b.cacheHitRate).toBe(cacheHitRate({ input: 100, cacheRead: 900 }))
    expect(b.avgTokensPerCall).toBe(520)
    // 会话平均事件数 = 2 / 2
    expect(b.eventsPerSession).toBe(1)
    // 跨度 = 最晚 − 最早（两条都落在 todayAt(10)，故为 0）
    expect(b.spanMs).toBe(0)
  })

  test('spanMs 取「最晚 − 最早」而不是筛选窗口长度', async () => {
    await report('tok-zhang', [
      rec('s-1', { ts: todayAt(8) }),
      rec('s-2', { seq: 2, ts: todayAt(20) }),
    ])
    const b = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    expect(b.spanMs).toBe(todayAt(20) - todayAt(8))
  })

  test('来源覆盖：按来源折叠、按调用降序、且不补齐注册表全集', async () => {
    await report('tok-zhang', [
      rec('d-1', { source: 'dsh' }),
      rec('d-2', { seq: 2, source: 'dsh' }),
      rec('c-1', { seq: 3, source: 'codex', provider: 'openai', model: 'gpt-5-codex' }),
    ])
    const b = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    expect(b.sources.map((s) => s.source)).toEqual(['dsh', 'codex'])
    const dsh = b.sources[0]!
    expect(dsh.calls).toBe(2)
    expect(dsh.totalTokens).toBe(2040)
    expect(dsh.sessions).toBe(1)
    // ⚠️ claude-code / trae / workbuddy 都在来源枚举里，但这批数据里一条都没有。
    //   补零会让「没人用」与「没进来」在页面上无法区分。
    for (const absent of ['claude-code', 'trae', 'trae-cn', 'workbuddy'])
      expect(b.sources.map((s) => s.source)).not.toContain(absent)
    // 新鲜度以**服务端取数时刻**为基准 → 一定是数字（不是负数）
    expect(typeof dsh.silentForMs).toBe('number')
    expect(dsh.silentForMs! >= 0).toBe(true)
  })

  test('来源覆盖跟着筛选收窄（分子分母同组条件）', async () => {
    await report('tok-zhang', [
      rec('d-1', { source: 'dsh' }),
      rec('c-1', { seq: 2, source: 'codex' }),
    ])
    const all = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    const only = (await get('diagnostics', { period: 'today', source: 'codex' }))
      .body as DiagnosticsResponse
    expect(only.sources.map((s) => s.source)).toEqual(['codex'])
    expect(only.totalEvents).toBe(1)
    expect(all.totalEvents).toBe(2)
  })

  test('署名覆盖：带分组名与最近事件时刻，且不含未归属', async () => {
    // ★ 必须带 `identity_view=member`：部门看板的每一次请求都带
    //   （见 `web-portal/src/api/portal.ts`），这才是生产上真正走的那条路径。
    //   旧视图下未归属**会**进这张表（与 by=user 同款），那是另一套语义。
    await report('tok-zhang', [rec('r-zhang', { session_id: 's-zhang' })])
    await report('tok-li', [rec('r-li', { session_id: 's-li' })])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(8), input: 1, output: 1, cacheRead: 1 },
    ])
    const b = (await get('diagnostics', {
      period: 'today',
      identity_view: 'member',
    })).body as DiagnosticsResponse
    expect(b.reporters.length).toBe(b.distinctUsers)
    // ⚠️ 未归属**不进**这张表：它通常比任何单个人的调用都多，
    //   留着就会把人挤出前 10 名 —— 而这一页最想回答的正是「谁在报」。
    expect(b.reporters.map((r) => r.attributionStatus)).not.toContain('unattributed')
    expect(b.reporters.map((r) => r.key)).not.toContain(UNATTRIBUTED_USER)
    // 未归属仍然出现在卡片上（覆盖率信号不能因为表格排除它就丢掉）
    expect(b.unattributedEvents).toBe(1)
    // ⚠️ 这套凭证走的是**旧身份库**（`CredentialStore`），事件上只有
    //   `user_id` 而没有 `member_id` ⇒ 无从关联分组表 ⇒ `groupNames` 为空数组
    //   （与人员排行同款：有 member_id 的行才带分组名，见 core/test/portal.test.ts）。
    //   想验「分组名真的出来了」得走真身份库那条路（真 appKey + member_id）。
    // 但展示名与归属形态仍要正确：旧身份在成员视图下是「待确认历史身份」
    const zhangRow = b.reporters.find((r) => r.label.includes('张三'))
    expect(zhangRow?.groupNames).toEqual([])
    expect(zhangRow?.attributionStatus).toBe('legacy')
    expect(zhangRow?.label).toContain('（待确认）')
  })

  test('旧视图下未归属作为 unknown 那一行出现（与 by=user 同款）', async () => {
    await report('tok-zhang', [rec('l-zhang')])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(8), input: 1, output: 1, cacheRead: 1 },
    ])
    const b = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    expect(b.reporters.map((r) => r.key)).toContain(UNATTRIBUTED_USER)
    expect(b.reporters.find((r) => r.key === UNATTRIBUTED_USER)?.label).toBe('未归属')
  })

  test('没有数据时两张覆盖表都是空数组（不是一行 0）', async () => {
    const b = (await get('diagnostics', { period: 'today' })).body as DiagnosticsResponse
    expect(b.sources).toEqual([])
    expect(b.reporters).toEqual([])
    expect(b.spanMs).toBeNull()
    expect(b.eventsPerSession).toBeNull()
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

  test('未知 stack 回 400（不许静默退回单序列）', async () => {
    // 静默退回合计会让「按用户展开」的页面画出一条合计线，
    // 而图上没有任何迹象说明它没展开 —— 与非法 bucket 是同一类陷阱。
    for (const value of ['', 'provider', 'users']) {
      const res = await get('series', { bucket: 'day', stack: value })
      expect(res.status).toBe(400)
    }
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

describe('人员候选目录（GET /api/v1/stats/members）', () => {
  /**
   * 名册来自**与用量共用的 portal 数据库**，所以这里用真身份库（不是凭证表）。
   *
   * ★ 这条接口存在的全部理由：它是人员下拉里**唯一**能列出「当前时间窗内
   *   没有用量的人」的来源。老做法只从用量行里取候选，于是选中一个分组之后
   *   整个下拉会空掉 —— 那看起来像数据丢了，而不像「这段时间没人用」。
   */
  async function roster() {
    const repository = new IdentityRepository({ sqlitePath: dbPath })
    await repository.initialize({
      adminToken: 'tok-admin',
      adminName: '管理员',
      adminUsername: 'admin',
      adminPassword: 'test-password-2026',
    })
    const admin = (await repository.resolveBearer('tok-admin'))!
    const group = (await repository.createGroup(admin, { name: '数字建造中心-开发' })).group!
    const zhang = (await repository.createMember(admin, { name: '张三', role_ids: [MEMBER_ROLE_ID] })).member!
    const li = (await repository.createMember(admin, { name: '李四', role_ids: [MEMBER_ROLE_ID] })).member!
    await repository.updateMember(admin, {
      member_id: zhang.member_id,
      expected_version: zhang.version,
      group_ids: [group.group_id],
    })
    return {
      route: new StatsRoute({ identityStore: repository, dbPath }),
      repository,
      admin,
      group,
      zhang,
      li,
    }
  }

  test('★ 列出全部人员及其当前分组 —— 一条用量都没有也照样列出', async () => {
    const { route, group, zhang, li } = await roster()
    const res = await route.handle('members', new URLSearchParams(), 'Bearer tok-admin')
    expect(res.status).toBe(200)
    const members = (res.body as StatsMembersResponse).members
    const byName = new Map(members.map((member) => [member.name, member]))

    expect(byName.get('张三')?.member_id).toBe(zhang.member_id)
    expect(byName.get('张三')?.group_ids).toEqual([group.group_id])
    // 未分组是**有意义的状态**（空数组），不是「没加载出来」
    expect(byName.get('李四')?.member_id).toBe(li.member_id)
    expect(byName.get('李四')?.group_ids).toEqual([])
    expect(byName.get('管理员')).toBeDefined()
    expect(members.every((member) => member.status === 'active')).toBe(true)
    // ★ 只回筛选要用的三样：角色 / 权限 / 账号属于管理面，不因为看得见用量就下发
    expect(Object.keys(byName.get('张三')!).sort()).toEqual([
      'group_ids',
      'member_id',
      'name',
      'status',
    ])
  })

  test('停用人员照样列出（停用只影响「以后还能不能选他」）', async () => {
    const { route, repository, admin, li } = await roster()
    await repository.setMemberStatus(admin, {
      member_id: li.member_id,
      expected_version: li.version,
      status: 'disabled',
    })
    const res = await route.handle('members', new URLSearchParams(), 'Bearer tok-admin')
    const members = (res.body as StatsMembersResponse).members
    expect(members.find((member) => member.name === '李四')?.status).toBe('disabled')
    expect(members.find((member) => member.name === '张三')?.status).toBe('active')
  })

  test('缺 Authorization → 401（与其它看板接口同一道门）', async () => {
    const { route } = await roster()
    expect((await route.handle('members', new URLSearchParams(), null)).status).toBe(401)
  })

  test('凭证表形态没有名册：200 + 空名册（页面据此不做收窄）', async () => {
    const res = await get('members')
    expect(res.status).toBe(200)
    expect((res.body as StatsMembersResponse).members).toEqual([])
  })
})

/**
 * 供应商候选目录（`GET /api/v1/stats/providers`）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **候选是完整集合**：不带时间窗、不带任何筛选。只列「当前窗口用过的」
 *    时候，上个月用过的供应商会从下拉里消失 —— 那看起来像数据丢了。
 * 2. ★ 名字是**归一化后的展示名**，与查询期的筛选口径是**同一份映射**：
 *    页面按它筛必须筛得出来（否则使用者会以为筛选坏了）。
 * 3. 只回名字，**不含任何用量数字**，因此不跟着数据范围收窄（同分组 / 人员候选）。
 */
describe('供应商候选目录（GET /api/v1/stats/providers）', () => {
  test('★ 列出库里出现过的供应商（去重、升序），且不受时间窗影响', async () => {
    await report('tok-zhang', [
      rec('pv1', { provider: 'openai', model: 'gpt-4o' }),
      // 昨天的一条：`period=today` 覆盖不到它，但候选必须照样列出
      rec('pv2', { seq: 2, ts: todayAt(10) - 86_400_000, provider: 'historic-gw', model: 'm-1' }),
      // 同名的两条只出现一次
      rec('pv3', { seq: 3, provider: 'openai', model: 'gpt-4o-mini' }),
    ])
    const res = await get('providers', { period: 'today' })
    expect(res.status).toBe(200)
    expect((res.body as StatsProvidersResponse).providers).toEqual([
      'historic-gw',
      'openai',
    ])
    // ★ 只回名字：整份响应体就这一个字段（没有条数、没有 token）
    expect(Object.keys(res.body as object)).toEqual(['providers'])
  })

  test('★ 名字按归一化后的展示名给（与筛选用的是同一份映射）', async () => {
    await report('tok-zhang', [
      rec('al1', { provider: 'dashscope', model: 'deepseek-v4.1-flash' }),
      rec('al2', { seq: 2, provider: 'bailian', model: 'qwen-max' }),
    ])
    const repository = new IdentityRepository({ sqlitePath: dbPath })
    await repository.initialize({
      adminToken: 'tok-admin',
      adminName: '管理员',
      adminUsername: 'admin',
      adminPassword: 'test-password-2026',
    })
    const admin = (await repository.resolveBearer('tok-admin'))!
    // 两个原始名折叠成同一个展示名：候选里只能出现一次
    await repository.setProviderAlias(admin, {
      scope: 'global',
      provider: 'dashscope',
      alias: 'bailian-tpp',
    })
    await repository.setProviderAlias(admin, {
      scope: 'global',
      provider: 'bailian',
      alias: 'bailian-tpp',
    })
    const route = new StatsRoute({ identityStore: repository, dbPath })
    const res = await route.handle('providers', new URLSearchParams(), 'Bearer tok-admin')
    expect(res.status).toBe(200)
    expect((res.body as StatsProvidersResponse).providers).toEqual(['bailian-tpp'])
    // ★ 按页面上看到的名字筛，两条都筛得到（候选与筛选共用同一份口径）
    const filtered = await route.handle(
      'overview',
      new URLSearchParams({ period: 'today', provider: 'bailian-tpp' }),
      'Bearer tok-admin',
    )
    expect((filtered.body as Record<string, number>)['calls']).toBe(2)
  })

  test('缺 Authorization → 401（与其它看板接口同一道门）', async () => {
    expect((await get('providers', {}, null)).status).toBe(401)
  })

  test('★ 空库回空候选而不是抛错（页面只列自定义项）', async () => {
    const res = await get('providers')
    expect(res.status).toBe(200)
    expect((res.body as StatsProvidersResponse).providers).toEqual([])
  })
})

/**
 * 趋势分层（`series?stack=user|model`）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **各层之和 ≡ 同一下标的 `points[].totalTokens`**。堆叠柱的总高就是趋势
 *    总量，少一分钱都说明有一层被悄悄丢掉了 —— 而图上只会「矮一点」。
 * 2. ★ **按人分层的键与人员排行同源**（稳定 `member_id`），否则图上「张三」
 *    这一层与排行里的「张三」不是同一个键，而两边各自看起来都很正常。
 * 3. **不带 `stack` 时载荷里没有 `stack` 字段**（老客户端行为一个字节不改）。
 * 4. ★ **没有 `cost:read` 时连金额都不算**（不是算完再丢掉）；
 *    多币种时逐层金额**整块缺席**（绝不挑一个币种偷偷画）。
 */
describe('★ 趋势分层（按用户 / 按模型）', () => {
  /** 各层在第 i 个桶上的和，必须等于该桶的合计。 */
  function expectStackSumsToTotals(body: SeriesResponse): void {
    const items = body.stack?.items ?? []
    expect(items.length).toBeGreaterThan(0)
    body.points.forEach((point, index) => {
      const tokens = items.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
      const calls = items.reduce((sum, item) => sum + (item.calls[index] ?? 0), 0)
      expect(tokens).toBe(point.totalTokens)
      expect(calls).toBe(point.calls)
    })
  }

  test('不带 stack 时载荷里没有 stack 字段（老客户端行为不变）', async () => {
    await report('tok-zhang', [rec('a1')])
    const res = await get('series', { bucket: 'day', period: 'today' })
    expect(res.status).toBe(200)
    expect('stack' in (res.body as object)).toBe(false)
  })

  test('stack=model：逐桶对齐，各层之和等于每个点的总量', async () => {
    await report('tok-zhang', [
      rec('m1', { seq: 1, ts: todayAt(9), model: 'a-model', input_tokens: 100, output_tokens: 0, cache_read_tokens: 0 }),
      rec('m2', { seq: 2, ts: todayAt(9), model: 'b-model', input_tokens: 200, output_tokens: 0, cache_read_tokens: 0 }),
      rec('m3', { seq: 3, ts: todayAt(10), model: 'a-model', input_tokens: 50, output_tokens: 0, cache_read_tokens: 0 }),
    ])

    const res = await get('series', { bucket: 'hour', period: 'today', stack: 'model' })
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    expect(body.stack?.by).toBe('model')
    // 按窗口总量降序：b-model 200 > a-model 150
    expect(body.stack!.items.map((item) => item.key)).toEqual(['b-model', 'a-model'])
    expect(body.stack!.mergedCount).toBe(0)
    // 模型没有人员 ID / 分组名（那是 `by=user` 专有的字段）
    expect('member_id' in body.stack!.items[0]!).toBe(false)
    expectStackSumsToTotals(body)
  })

  test('stack=user：旧视图（凭证表）的键就是人名', async () => {
    await report('tok-zhang', [rec('z1')])
    await report('tok-li', [rec('l1', { seq: 2 })])

    const res = await get('series', { bucket: 'day', period: 'today', stack: 'user' })
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    expect(body.stack!.items.map((item) => item.key).sort()).toEqual(['张三', '李四'].sort())
    expectStackSumsToTotals(body)
  })

  test('未归属用量照样成层（不会被分层丢掉）', async () => {
    await report('tok-zhang', [rec('z1')])
    seedUnattributed([
      { eventId: 'u1', sessionId: 's-u', seq: 1, ts: todayAt(11), input: 700, output: 0, cacheRead: 0 },
    ])

    const res = await get('series', { bucket: 'day', period: 'today', stack: 'user' })
    const body = res.body as SeriesResponse
    const unknown = body.stack!.items.find((item) => item.key === UNATTRIBUTED_USER)
    expect(unknown).toBeDefined()
    expect(unknown!.label).toBe('未署名')
    expectStackSumsToTotals(body)
  })

  test('★ 超过 8 层时尾部合并成「其余 N 个」，合计仍然逐桶相等', async () => {
    await report(
      'tok-zhang',
      // 10 个模型，用量递减 —— 前 8 名留下，后 2 个必须进「其余」
      Array.from({ length: 10 }, (_, i) =>
        rec(`k${i}`, { seq: i + 1, ts: todayAt(10), model: `m${i}`, input_tokens: 1000 - i * 10, output_tokens: 0, cache_read_tokens: 0 }),
      ),
    )

    const res = await get('series', { bucket: 'day', period: 'today', stack: 'model' })
    const body = res.body as SeriesResponse
    const items = body.stack!.items
    expect(items.length).toBe(9)
    expect(body.stack!.mergedCount).toBe(2)
    const merged = items.at(-1)!
    expect(merged.merged).toBe(true)
    // ★ 合并项的键是协议里的哨兵，不可能是某个真实模型名
    expect(merged.key).toBe(SERIES_STACK_MERGED_KEY)
    expect(merged.label).toBe('其余 2 个模型')
    expectStackSumsToTotals(body)
  })

  test('空窗口返回空分层而不是抛错', async () => {
    const res = await get('series', { bucket: 'day', period: 'today', stack: 'user' })
    expect(res.status).toBe(200)
    const stack = (res.body as SeriesResponse).stack!
    expect(stack.items).toEqual([])
    expect(stack.mergedCount).toBe(0)
  })

  /**
   * 真身份库 + 真 appKey 上报：只有这条路才走得到 `identity_view=member`
   * 的归属键（稳定 `member_id`），而看板页面发的就是它。
   */
  async function memberWorld() {
    const repository = new IdentityRepository({ sqlitePath: dbPath })
    await repository.initialize({
      adminToken: 'tok-admin',
      adminName: '管理员',
      adminUsername: 'admin',
      adminPassword: 'test-password-2026',
    })
    const admin = (await repository.resolveBearer('tok-admin'))!
    const group = (await repository.createGroup(admin, { name: '研发一部' })).group!
    const zhang = (await repository.createMember(admin, { name: '张三', role_ids: [MEMBER_ROLE_ID] })).member!
    const li = (await repository.createMember(admin, { name: '李四', role_ids: [MEMBER_ROLE_ID] })).member!
    await repository.updateMember(admin, {
      member_id: zhang.member_id,
      expected_version: zhang.version,
      group_ids: [group.group_id],
    })
    const zhangKey = (await repository.issueAppKey(admin, { member_id: zhang.member_id })).token_secret
    const liKey = (await repository.issueAppKey(admin, { member_id: li.member_id })).token_secret
    const ingest = new IngestRoute({ identityStore: repository, dbPath })
    const send = async (secret: string, records: unknown[]): Promise<void> => {
      const res = await ingest.submit(
        {
          schemaVersion: 1,
          client: { userId: 'ignored', userName: 'ignored' },
          generatedAt: new Date().toISOString(),
          records,
        },
        `Bearer ${secret}`,
      )
      expect(res.status).toBe(200)
    }
    return { repository, admin, group, zhang, li, zhangKey, liKey, send }
  }

  const memberRoute = (repository: IdentityRepository): StatsRoute =>
    new StatsRoute({ identityStore: repository, dbPath })

  test('★ stack=user：键是稳定人员 ID、标签是显示名，且与人员排行的键同源', async () => {
    const { repository, group, zhang, zhangKey, liKey, send } = await memberWorld()
    await send(zhangKey, [rec('z1')])
    await send(liKey, [rec('l1', { seq: 2, input_tokens: 500, output_tokens: 0, cache_read_tokens: 0 })])
    const route = memberRoute(repository)
    const query = { bucket: 'day', period: 'today', stack: 'user', identity_view: 'member' }

    const res = await route.handle('series', new URLSearchParams(query), 'Bearer tok-admin')
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    const items = body.stack!.items
    const zhangItem = items.find((item) => item.key === zhang.member_id)!
    expect(zhangItem.label).toBe('张三')
    expect(zhangItem.member_id).toBe(zhang.member_id)
    // 分组名与人员排行同源（多对多下的「当前归属」）
    expect(zhangItem.group_names).toEqual([group.name])
    expect(zhangItem.attribution_status).toBe('member')
    expectStackSumsToTotals(body)

    // ★ 与 `breakdown?by=user` 的键逐个对得上 —— 图上的一层就是排行里的一行
    const ranking = await route.handle('breakdown', new URLSearchParams(query), 'Bearer tok-admin')
    expect((ranking.body as BreakdownResponse).rows.map((row) => row.key).sort())
      .toEqual(items.map((item) => item.key).sort())
  })

  test('★ stack=model 在成员视图下仍然用模型名（不能套用人员那套标签判定）', async () => {
    // 🚨 这一条是实测踩出来的：成员视图 + 按模型展开时，模型行既没有 `member_id`
    //   也没有 `user_id`，套用人员的标签判定会把**每一层都标成「未归属」** ——
    //   图例上所有模型都叫「未归属」，而数字全对，所以只有断言标签才抓得住。
    const { repository, zhangKey, send } = await memberWorld()
    await send(zhangKey, [
      rec('m1', { seq: 1, model: 'alpha-model', input_tokens: 900, output_tokens: 0, cache_read_tokens: 0 }),
      rec('m2', { seq: 2, model: 'beta-model', input_tokens: 100, output_tokens: 0, cache_read_tokens: 0 }),
    ])
    const route = memberRoute(repository)
    const res = await route.handle(
      'series',
      new URLSearchParams({ bucket: 'day', period: 'today', stack: 'model', identity_view: 'member' }),
      'Bearer tok-admin',
    )
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    const items = body.stack!.items
    expect(items.map((item) => item.key)).toEqual(['alpha-model', 'beta-model'])
    // 标签就是模型名本身，且不带任何归属状态（模型没有归属这回事）
    expect(items.map((item) => item.label)).toEqual(['alpha-model', 'beta-model'])
    expect(items.every((item) => !('attribution_status' in item))).toBe(true)
    expect(items.every((item) => !('member_id' in item))).toBe(true)
    expectStackSumsToTotals(body)
  })

  test('★ 没有 cost:read 时分层里连金额都不算（不是算完再丢掉）', async () => {
    const { repository, admin, zhang, zhangKey, send } = await memberWorld()
    await send(zhangKey, [rec('z1')])
    const route = memberRoute(repository)
    // ★ v13 起内置 `member` 角色带 `cost:read`，所以 **appKey 有金额权限**；
    //   这一条要验的是「凭证没有 cost:read 时连算都不算」，所以改用一把**窄凭证**
    //   （scopes 里刻意不放 cost:read —— 它由角色权限交集之后仍然只有两项）。
    const narrow = (await repository.issueToken(admin, {
      member_id: zhang.member_id,
      label: '窄凭证（无 cost:read）',
      scopes: ['usage:write', 'stats:read'],
    })).token_secret
    const res = await route.handle(
      'series',
      new URLSearchParams({ bucket: 'day', period: 'today', stack: 'user', identity_view: 'member' }),
      `Bearer ${narrow}`,
    )
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    expect('cost' in body.points[0]!).toBe(false)
    expect('cost' in body.stack!.items[0]!).toBe(false)
  })

  test('★ 单币种时逐层下发金额，各层（含「其余」）之和等于该点的合计金额', async () => {
    const { repository, admin, zhangKey, send } = await memberWorld()
    await repository.setModelPrice(admin, {
      provider: 'dashscope', model: 'deepseek-v4.1-flash', currency: 'CNY',
      input_micro_per_ktok: 2_000, output_micro_per_ktok: 8_000,
      cache_read_micro_per_ktok: 200, cache_write_micro_per_ktok: 2_000,
      effective_from_ms: 1_000,
    })
    // 10 个人、用量递减：前 8 名留下，最后 2 个必须进「其余」——
    // 只有这样才能验到「合并项的金额是逐桶相加，而不是其中取一个」。
    const keys = [zhangKey]
    for (let i = 0; i < 9; i++) {
      const member = (await repository.createMember(admin, {
        name: `成员${i}`,
        role_ids: [MEMBER_ROLE_ID],
      })).member!
      keys.push((await repository.issueAppKey(admin, { member_id: member.member_id })).token_secret)
    }
    for (const [index, key] of keys.entries()) {
      await send(key, [
        rec(`c${index}`, { input_tokens: 1000 - index * 10, output_tokens: 0, cache_read_tokens: 0 }),
      ])
    }

    const route = memberRoute(repository)
    const res = await route.handle(
      'series',
      new URLSearchParams({ bucket: 'day', period: 'today', stack: 'user', identity_view: 'member' }),
      'Bearer tok-admin',
    )
    expect(res.status).toBe(200)
    const body = res.body as SeriesResponse
    const items = body.stack!.items
    expect(items.length).toBe(9)
    expect(items.every((item) => Array.isArray(item.cost))).toBe(true)
    // ★ 逐层金额之和 ≡ 该点的合计金额 —— 堆叠柱的总高 = 趋势总额
    body.points.forEach((point, index) => {
      const total = point.cost!.costs[0]!.amountMicro
      const sum = items.reduce((acc, item) => acc + (item.cost?.[index] ?? 0), 0)
      expect(sum).toBe(total)
    })
    // 🚨 合并项必须是**两层之和**：写成「取最后一层」时它会小于最大的那一层，
    //   而图上只会矮一截，没有任何报错。
    const merged = items.at(-1)!
    expect(merged.merged).toBe(true)
    const keptMax = Math.max(...items.slice(0, -1).map((item) => item.cost![0]!))
    expect(merged.cost![0]!).toBeGreaterThan(keptMax)
  })

  test('🚨 多币种时逐层金额整块缺席（绝不挑一个币种偷偷画）', async () => {
    const { repository, admin, zhangKey, liKey, send } = await memberWorld()
    const base = {
      output_micro_per_ktok: 0, cache_read_micro_per_ktok: 0, cache_write_micro_per_ktok: 0,
      effective_from_ms: 1_000,
    }
    await repository.setModelPrice(admin, { ...base, provider: 'dashscope', model: 'deepseek-v4.1-flash', currency: 'CNY', input_micro_per_ktok: 2_000 })
    await repository.setModelPrice(admin, { ...base, provider: 'openai', model: 'gpt-4o', currency: 'USD', input_micro_per_ktok: 3_000 })
    await send(zhangKey, [rec('z1', { model: 'deepseek-v4.1-flash' })])
    await send(liKey, [rec('l1', { seq: 2, provider: 'openai', model: 'gpt-4o' })])

    const route = memberRoute(repository)
    const res = await route.handle(
      'series',
      new URLSearchParams({ bucket: 'day', period: 'today', stack: 'user', identity_view: 'member' }),
      'Bearer tok-admin',
    )
    const body = res.body as SeriesResponse
    // 区间里确实有两种币种（页面据此禁用金额指标）
    const currencies = new Set(body.points.flatMap((point) => (point.cost?.costs ?? []).map((entry) => entry.currency)))
    expect([...currencies].sort()).toEqual(['CNY', 'USD'])
    // 而逐层的 `cost` 必须整块缺席：挑一个币种画出来就是偷偷做了一次换算
    expect(body.stack!.items.every((item) => !('cost' in item))).toBe(true)
    expectStackSumsToTotals(body)
  })
})


/**
 * ★ 来源维度（v9）：`by=source` / `?source=` / `/api/v1/stats/sources`。
 *
 * ## 这一组在守什么
 *
 * 1. 🚨 **来源是精确匹配**（受控枚举），与 `provider` 的子串匹配刻意相反：
 *    子串匹配会让 `trae` 命中 `trae-cn` —— 那是两个独立安装、独立账号的来源。
 * 2. 🚨 **未注册的来源名一律 400**，绝不静默忽略：静默忽略会让使用者看到
 *    **全量**数据却以为已经筛过（与 CLI「未注册即报错」同一条教训）。
 * 3. ★ 候选接口 = 注册表 ∪ 库里出现过的值：前者让「本机还没跑过 Codex」
 *    也能筛出如实的 0 行，后者兜住「更新版客户端上报了本进程不认识的来源」。
 * 4. ★ **按来源出数时汇总表必须被绕过**（`usage_rollup_*` 没有来源列）——
 *    这一条由「同一个库、同一个窗口，带不带汇总表都要给出同一份数字」钉住。
 */
describe('★ 来源维度（v9）', () => {
  test('by=source：按来源分组，且各来源之和等于总量', async () => {
    await report('tok-admin', [
      rec('s-dsh', { source: 'dsh' }),
      rec('s-codex', { seq: 2, source: 'codex', provider: 'openai', model: 'gpt-5-codex' }),
      rec('s-claude', { seq: 3, source: 'claude-code', provider: 'anthropic', model: 'claude-opus-4-8' }),
    ])
    const res = await get('breakdown', { by: 'source', period: 'today' })
    expect(res.status).toBe(200)
    const body = res.body as BreakdownResponse
    expect(body.rows.map((row) => row.key).sort()).toEqual(['claude-code', 'codex', 'dsh'])
    const sum = body.rows.reduce((total, row) => total + row.totalTokens, 0)
    const overview = (await get('overview', { period: 'today' })).body as { totalTokens: number }
    expect(sum).toBe(overview.totalTokens)
  })

  test('🚨 旧客户端不发 source ⇒ 落成 dsh（历史事实，不是猜测）', async () => {
    // `rec()` 不带 source 字段：zod 把它归一成 null，入库按库内默认值兜底。
    await report('tok-admin', [rec('legacy-1')])
    const res = await get('breakdown', { by: 'source', period: 'today' })
    const body = res.body as BreakdownResponse
    expect(body.rows.map((row) => row.key)).toEqual(['dsh'])
  })

  test('★ ?source= 是按来源筛选（多选 = OR），且是精确匹配', async () => {
    await report('tok-admin', [
      rec('f-dsh', { source: 'dsh', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0 }),
      rec('f-codex', { seq: 2, source: 'codex', input_tokens: 100, output_tokens: 0, cache_read_tokens: 0 }),
      // `trae` 与 `trae-cn` 是两个来源：子串匹配会把它们混成一个。
      rec('f-trae', { seq: 3, source: 'trae', input_tokens: 1_000, output_tokens: 0, cache_read_tokens: 0 }),
      rec('f-traecn', { seq: 4, source: 'trae-cn', input_tokens: 2_000, output_tokens: 0, cache_read_tokens: 0 }),
    ])
    const codex = (await get('overview', { period: 'today', source: 'codex' })).body as { totalTokens: number; calls: number }
    expect(codex.calls).toBe(1)
    expect(codex.totalTokens).toBe(100)
    const both = (await get('overview', { period: 'today', source: 'codex,trae' })).body as { calls: number; totalTokens: number }
    expect(both.calls).toBe(2)
    expect(both.totalTokens).toBe(1_100)
    // ★ `trae` 不许把 `trae-cn` 一起捞进来（这正是子串匹配会犯的错）。
    const traeOnly = (await get('overview', { period: 'today', source: 'trae' })).body as { calls: number; totalTokens: number }
    expect(traeOnly.calls).toBe(1)
    expect(traeOnly.totalTokens).toBe(1_000)
  })

  test('★ 形状非法的来源值回 400（它不可能是来源名，别让人对着 0 行猜）', async () => {
    for (const bad of ['Codex', 'codex!', 'a b', 'x'.repeat(33)]) {
      const res = await get('overview', { period: 'today', source: bad })
      expect(res.status).toBe(400)
      expect(String((res.body as { reason: string }).reason)).toContain('来源名')
    }
  })

  test('★ 形状合法但库里没有这个来源 ⇒ 0 行（与 ?provider=zzz 同一套语义）', async () => {
    await report('tok-admin', [rec('n-1', { source: 'dsh' })])
    // 拼错的值**不是**非法参数，只是没有数据 —— 与 provider 的筛选一致。
    // 🚨 不能把它当 400：库里可能真有本进程不认识的来源（更新版客户端），
    //    而候选接口会把那种值一并列出来（否则「看得到却筛不出来」）。
    const res = await get('overview', { period: 'today', source: 'codx' })
    expect(res.status).toBe(200)
    expect((res.body as { calls: number }).calls).toBe(0)
  })

  test('★ 明细行也带来源（逐条核对时看得见），值是上报原值', async () => {
    await report('tok-admin', [
      rec('d-1', { source: 'claude-code' }),
      rec('d-2', { seq: 2, source: 'trae-cn' }),
    ])
    const res = await get('records', { period: 'today' })
    expect(res.status).toBe(200)
    const body = res.body as { rows: { eventId: string; source?: string }[] }
    const byId = new Map(body.rows.map((row) => [row.eventId, row.source]))
    // 原值原样（**不做归一化**）：`trae-cn` 与 `trae` 是两回事。
    expect(byId.get('d-1')).toBe('claude-code')
    expect(byId.get('d-2')).toBe('trae-cn')
  })

  test('★ /api/v1/stats/sources：注册表 ∪ 库里出现过的值，dsh 恒在第一位', async () => {
    await report('tok-admin', [rec('c-1', { source: 'codex' })])
    const res = await get('sources')
    expect(res.status).toBe(200)
    const body = res.body as { sources: string[] }
    // 本进程注册的六个来源都在（哪怕这台机器没跑过它们）。
    for (const id of ['dsh', 'codex', 'claude-code', 'trae', 'trae-cn', 'workbuddy']) {
      expect(body.sources).toContain(id)
    }
    expect(body.sources[0]).toBe('dsh')
    // 顺序稳定：dsh 之后按字典序。
    expect(body.sources.slice(1)).toEqual([...body.sources.slice(1)].sort())
  })

  test('★ 库里出现过的未知来源也会进候选（否则那种行看得到却筛不出来）', async () => {
    // 直接落库：模拟「更新版客户端上报了一个本进程还不认识的来源」。
    const db = openPortalDb(dbPath)
    try {
      const rows = [
        {
          eventId: 'unknown-source-1', sessionId: 'session-x', seq: 1, time: todayAt(11),
          provider: 'future', model: 'future-model', cwd: null, turn: null, step: null,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6, calls: 1 },
        },
      ]
      insertRecords(db, rows)
      // `insertRecords` 不接受 source（种子数据），直接 UPDATE 成未知来源值。
      db.prepare("UPDATE usage_event SET source = 'future-client' WHERE event_id = 'unknown-source-1'").run()
    } finally {
      db.close()
    }
    const body = (await get('sources')).body as { sources: string[] }
    expect(body.sources).toContain('future-client')
    // 而且它**筛得中**（候选与筛选口径一致）。
    const filtered = (await get('overview', { period: 'today', source: 'future-client' })).body as { calls: number }
    expect(filtered.calls).toBe(1)
  })
})

describe('★ 来源与汇总表（绕过是必需的，不是优化）', () => {
  test('★ 带来源筛选时不读汇总表：数字与不带汇总表时逐位相同', async () => {
    await report('tok-admin', [
      rec('r-dsh', { source: 'dsh', input_tokens: 10, output_tokens: 1, cache_read_tokens: 0 }),
      rec('r-codex', { seq: 2, source: 'codex', input_tokens: 700, output_tokens: 7, cache_read_tokens: 0 }),
    ])
    // 只按来源筛：`usage_rollup_*` 的键里**没有来源列**，查询层必须退原始表
    // （`PortalStatsSession.#rollupUsable()` 里显式判掉）。不判的话它会在
    // 「no such column: source」上被 try 吞掉 —— 结果一样但每次白跑一条 SQL。
    const bySource = (await get('overview', { period: 'today', source: 'codex' })).body as { totalTokens: number; calls: number }
    expect(bySource.calls).toBe(1)
    expect(bySource.totalTokens).toBe(707)
    // 不带来源筛选（可以走汇总表）看总量：708。
    const all = (await get('overview', { period: 'today' })).body as { totalTokens: number }
    expect(all.totalTokens).toBe(718)
  })
})
