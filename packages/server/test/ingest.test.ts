/**
 * 上报接收接口测试（`POST /api/v1/token-usage`）。
 *
 * ## 这些断言在守什么
 *
 * 1. ★ **归属只信服务端** —— 客户端在 `client.userName` 里自称的名字一律忽略，
 *    归属取 token 查凭证表的结果。这一条破了，部门看板的数据立刻失去意义。
 * 2. ★ **鉴权失败必须是非 2xx** —— 客户端把 2xx 当作「已投递」并清掉 pending，
 *    回 200 会让那批用量被永久丢掉。所以这里断言的是 `401` / `503`，
 *    而不是 `identity/verify` 那种 `200 + ok:false`。
 * 3. **幂等** —— `event_id` 是主键，重复上报计入 `duplicates` 而不是报错：
 *    插件与 CLI 可以同时上报而无需协调（上报只需 at-least-once）。
 * 4. **单行拒收不牵连整批** —— 坏行计入 `rejected`，同批的好行照常入库。
 * 5. **四个 token 分列落库**（铁律 1），且库里没有 total 列。
 * 6. 🚨 **上报库绝不自动重建** —— 它是全员数据的唯一副本，
 *    schema 版本不符时必须停下来报错（与本地库的「坏了就重建」相反）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EVENT_TABLE, openDb, openPortalDb } from '@ai-token-report/core/db'
import type { IngestResponse } from '@ai-token-report/shared'

import { CredentialStore } from '../src/credentials.js'
import { IngestRoute, parseIngestPayload, parseIngestRecord } from '../src/ingest-route.js'

let home: string
let dbPath: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-ingest-'))
  dbPath = join(home, 'token-report', 'portal.sqlite')
})

afterEach(() => {
  // Windows 下若有未关闭的连接，rmSync 会抛 EBUSY；测试自身都在 finally 里 close，
  // 这里只兜住断言失败路径，免得一个断言红了连带把清理也弄红。
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试结论 */
  }
})

/** 两个已登记的人：张三（研发一部）与李四（研发二部）。 */
const STORE = CredentialStore.from([
  { token: 'tok-zhang', name: '张三', dept: '研发一部' },
  { token: 'tok-li', name: '李四', dept: '研发二部' },
])

function route(store: CredentialStore = STORE): IngestRoute {
  return new IngestRoute({ credentials: store, dbPath })
}

/** 造一条线上记录（下划线字段，与 `toWireRecord` 逐字对齐）。 */
function rec(eventId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: eventId,
    session_id: 'session-1',
    seq: 1,
    ts: 1_790_245_427_069,
    provider: 'dashscope',
    model: 'deepseek-v4.1-flash',
    input_tokens: 10_882,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 10_883,
    cwd: 'D:\\Coding\\ai-token-report',
    turn: 1,
    step: 1,
    ...over,
  }
}

/** 造一整批载荷。`client` 里刻意带上自称的身份，用于验证它被忽略。 */
function payload(
  records: unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    client: { name: 'dsh-token-report', userId: '李四', userName: '李四', dept: '研发二部' },
    generatedAt: '2026-09-25T10:00:00Z',
    records,
    ...over,
  }
}

/** 读回一行（归属 + 四项 token），用于断言真正落库了什么。 */
function readRow(eventId: string) {
  const db = openPortalDb(dbPath)
  try {
    return db
      .query<
        {
          user_id: string | null
          user_name: string | null
          dept: string | null
          session_id: string
          input_tokens: number
          output_tokens: number
          cache_read_tokens: number
          cache_write_tokens: number
        },
        [string]
      >(
        `SELECT user_id, user_name, dept, session_id,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM ${EVENT_TABLE} WHERE event_id = ?`,
      )
      .get([eventId])
  } finally {
    db.close()
  }
}

/** 库里的总行数。 */
function rowCount(): number {
  const db = openPortalDb(dbPath)
  try {
    return db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`).get()?.c ?? 0
  } finally {
    db.close()
  }
}

// ── 正常路径 ────────────────────────────────────────────────────────────────

describe('上报接收：正常路径', () => {
  test('有效 token → 200，三个计数如实返回，记录带归属落库', async () => {
    const res = await route().submit(payload([rec('s:1'), rec('s:2')]), 'Bearer tok-zhang')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: 0 })

    // ★ 铁律 1：四个 token 分列落库，绝不合并
    expect(readRow('s:1')).toEqual({
      user_id: '张三',
      user_name: '张三',
      dept: '研发一部',
      session_id: 'session-1',
      input_tokens: 10_882,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
  })

  test('★ 客户端自称的姓名不生效，归属取凭证表', async () => {
    // body 的 client 里写的是「李四」，token 却是张三的
    const res = await route().submit(payload([rec('s:1')]), 'Bearer tok-zhang')

    expect(res.status).toBe(200)
    // 若这里变成「李四」，就等于任何人改一下本地配置都能冒用他人身份上报
    expect(readRow('s:1')?.user_name).toBe('张三')
    expect(readRow('s:1')?.user_id).toBe('张三')
    expect(readRow('s:1')?.dept).toBe('研发一部')
  })

  test('裸 token（无 Bearer 前缀）同样接受', async () => {
    const res = await route().submit(payload([rec('s:1')]), 'tok-zhang')
    expect(res.status).toBe(200)
    expect(readRow('s:1')?.user_name).toBe('张三')
  })

  test('空 records → 200 全 0，且不为此建库', async () => {
    const res = await route().submit(payload([]), 'Bearer tok-zhang')
    expect(res.body).toEqual({ accepted: 0, duplicates: 0, rejected: 0 })
    // 空批次连连接都不开：这是 #store 的短路，顺带保证「没数据就不产生文件」
    expect(existsSync(dbPath)).toBe(false)
  })

  test('凭证没登记部门时 dept 落成 NULL', async () => {
    const store = CredentialStore.from([{ token: 'tok-x', name: '王五' }])
    await route(store).submit(payload([rec('s:1')]), 'Bearer tok-x')
    expect(readRow('s:1')?.dept).toBeNull()
    expect(readRow('s:1')?.user_name).toBe('王五')
  })
})

// ── 鉴权失败：必须是非 2xx ──────────────────────────────────────────────────

describe('上报接收：鉴权失败必须是非 2xx', () => {
  test('★ token 无效 → 401，且一条都没落库', async () => {
    const res = await route().submit(payload([rec('s:1')]), 'Bearer tok-wrong')

    // 若这里回 200（哪怕 body 里写 ok:false），CLI 会当成已投递并清掉 pending
    expect(res.status).toBe(401)
    expect(String((res.body as { reason?: string }).reason)).toContain('无效')
    expect(existsSync(dbPath)).toBe(false)
  })

  test('★ 未带 Authorization → 401', async () => {
    const res = await route().submit(payload([rec('s:1')]), null)
    expect(res.status).toBe(401)
    expect(existsSync(dbPath)).toBe(false)
  })

  test('★ 服务端未配置凭证 → 503（重试有意义，与 401 区分开）', async () => {
    const res = await route(CredentialStore.empty()).submit(payload([rec('s:1')]), 'Bearer anything')
    expect(res.status).toBe(503)
    // 文案要让用户知道「做什么都没用，得等管理员发凭证」——
    // 与「token 抄错了」区分开，否则用户会在完全正确的情况下反复重试
    expect(String((res.body as { reason?: string }).reason)).toContain('凭证')
    expect(existsSync(dbPath)).toBe(false)
  })

  test('鉴权先于解析：body 是垃圾也仍回 401，而不是 400', async () => {
    // 顺序很重要 —— 未通过鉴权的请求体没有理由被解析，更没理由进库
    const res = await route().submit('这不是对象', 'Bearer tok-wrong')
    expect(res.status).toBe(401)
  })
})

// ── 幂等 ────────────────────────────────────────────────────────────────────

describe('上报接收：幂等', () => {
  test('同一批重发 → 第二次全算 duplicates，库里仍是原来那些行', async () => {
    const batch = payload([rec('s:1'), rec('s:2')])

    const first = await route().submit(batch, 'Bearer tok-zhang')
    const second = await route().submit(batch, 'Bearer tok-zhang')

    expect(first.body).toEqual({ accepted: 2, duplicates: 0, rejected: 0 })
    expect(second.body).toEqual({ accepted: 0, duplicates: 2, rejected: 0 })
    expect(rowCount()).toBe(2)
  })

  test('部分重复 → 各自计数正确（插件与 CLI 同时上报的真实情形）', async () => {
    await route().submit(payload([rec('s:1')]), 'Bearer tok-zhang')
    const res = await route().submit(payload([rec('s:1'), rec('s:2')]), 'Bearer tok-li')

    expect(res.body).toEqual({ accepted: 1, duplicates: 1, rejected: 0 })
    expect(rowCount()).toBe(2)
  })

  test('★ 归属以先到的为准：后到的上报不改写已有归属', async () => {
    await route().submit(payload([rec('s:1')]), 'Bearer tok-zhang')
    await route().submit(payload([rec('s:1')]), 'Bearer tok-li')

    // 同一台机器换了 token 后重发历史批次时，不能把已入库的归属改成别人
    expect(readRow('s:1')?.user_name).toBe('张三')
  })
})

// ── 载荷校验 ────────────────────────────────────────────────────────────────

describe('上报接收：载荷校验', () => {
  test('坏行计入 rejected，同批的好行照常入库', async () => {
    const res = await route().submit(
      payload([
        rec('s:1'),
        rec('s:2', { input_tokens: -1 }), // 负数
        rec('s:3', { input_tokens: '123' }), // 字符串
        { session_id: 'x', seq: 1, ts: 1 }, // 缺 event_id
        rec('s:5'),
      ]),
      'Bearer tok-zhang',
    )

    expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: 3 })
    expect(readRow('s:1')).toBeTruthy()
    expect(readRow('s:5')).toBeTruthy()
  })

  test('缺一个 token 列 → 拒收该行（绝不兜底成 0）', async () => {
    // 兜底成 0 会把「客户端漏字段」变成一条看起来正常的记录，用量悄悄少掉
    const res = await route().submit(payload([rec('s:1', { cache_read_tokens: undefined })]), 'Bearer tok-zhang')
    expect(res.body).toEqual({ accepted: 0, duplicates: 0, rejected: 1 })
    expect(existsSync(dbPath)).toBe(false)
  })

  test('body 不是对象 / records 不是数组 → 400 整批拒收', async () => {
    const bad1 = await route().submit('字符串', 'Bearer tok-zhang')
    const bad2 = await route().submit(null, 'Bearer tok-zhang')
    const bad3 = await route().submit(payload([] as unknown[], { records: 'nope' }), 'Bearer tok-zhang')

    for (const res of [bad1, bad2, bad3]) {
      expect(res.status).toBe(400)
      // 整批失败必须是非 2xx，否则客户端会把「没收到」当成「已投递」
      expect(String((res.body as { reason?: string }).reason)).toBeTruthy()
    }
  })

  test('schemaVersion 高于服务端支持 → 400（让老服务端能被识别出来）', async () => {
    const res = await route().submit(payload([rec('s:1')], { schemaVersion: 99 }), 'Bearer tok-zhang')
    expect(res.status).toBe(400)
    expect(String((res.body as { reason?: string }).reason)).toContain('99')
  })

  test('schemaVersion 缺省按当前版本处理（新旧客户端混跑不互相拒绝）', async () => {
    const body = payload([rec('s:1')])
    delete body['schemaVersion']
    const res = await route().submit(body, 'Bearer tok-zhang')
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
  })

  test('provider / model 缺失兜底成空串而不是拒收', async () => {
    // 它们只影响分组展示，不影响用量本身；为它拒收会让客户端永远重发这一行
    const res = await route().submit(
      payload([rec('s:1', { provider: undefined, model: null })]),
      'Bearer tok-zhang',
    )
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })
    expect(readRow('s:1')?.user_id).toBe('张三')
  })

  test('上报里的 total_tokens 不被采信，也不落库', async () => {
    // 库里没有 total 列（铁律 2）：错误的上报 total 不会污染任何数字
    const res = await route().submit(payload([rec('s:1', { total_tokens: 999_999 })]), 'Bearer tok-zhang')
    expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 0 })

    const db = openPortalDb(dbPath)
    try {
      const cols = db
        .query<{ name: string }, []>(`PRAGMA table_info(${EVENT_TABLE})`)
        .all()
        .map((c) => c.name)
      expect(cols).not.toContain('total_tokens')
    } finally {
      db.close()
    }
  })
})

// ── 上报库不可自动重建 ──────────────────────────────────────────────────────

describe('上报接收：库异常', () => {
  test('★ schema 版本不符 → 500 且不删数据（上报库是唯一副本）', async () => {
    // 先用正常路径建库写入
    await route().submit(payload([rec('s:1')]), 'Bearer tok-zhang')
    const db = openPortalDb(dbPath)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const res = await route().submit(payload([rec('s:2')]), 'Bearer tok-zhang')

    // 本地库遇到版本不符会「丢了重建」，上报库绝不能这样：
    // 客户端投递成功后就清掉了自己的 pending，服务端删掉 = 数据永久消失
    expect(res.status).toBe(500)
    expect(String((res.body as { reason?: string }).reason)).toContain('唯一副本')

    // ⚠️ 数据还在的断言必须用 openDb 直接读：openPortalDb 会因为版本不符抛错，
    //   而「抛错之后行还在不在」正是这条测试要守住的东西。
    const raw = openDb(dbPath)
    try {
      expect(raw.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${EVENT_TABLE}`).get()?.c).toBe(1)
    } finally {
      raw.close()
    }
  })
})

// ── 解析器（纯函数）──────────────────────────────────────────────────────────

describe('parseIngestRecord', () => {
  test('必填字段齐全时归一化成功', () => {
    const r = parseIngestRecord(rec('s:1'))
    expect(r?.event_id).toBe('s:1')
    expect(r?.input_tokens).toBe(10_882)
  })

  test('event_id / session_id 为空串或非法类型 → null', () => {
    expect(parseIngestRecord(rec('s:1', { event_id: '   ' }))).toBeNull()
    expect(parseIngestRecord(rec('s:1', { event_id: 123 }))).toBeNull()
    expect(parseIngestRecord(rec('s:1', { session_id: null }))).toBeNull()
  })

  test('seq / ts 必须是非负整数', () => {
    expect(parseIngestRecord(rec('s:1', { seq: 1.5 }))).toBeNull()
    expect(parseIngestRecord(rec('s:1', { seq: -1 }))).toBeNull()
    expect(parseIngestRecord(rec('s:1', { ts: '1790245427069' }))).toBeNull()
    expect(parseIngestRecord(rec('s:1', { ts: 0 }))?.ts).toBe(0)
  })

  test('reasoning 缺失即 0（它是 output 的子集，多数 provider 不下发）', () => {
    expect(parseIngestRecord(rec('s:1', { reasoning_tokens: undefined }))?.reasoning_tokens).toBe(0)
  })

  test('turn / step / cwd 非法时降级成 null，不影响其他字段', () => {
    const r = parseIngestRecord(rec('s:1', { turn: 'a', step: 2.5, cwd: 42 }))
    expect(r?.turn).toBeNull()
    expect(r?.step).toBeNull()
    expect(r?.cwd).toBeNull()
    expect(r?.input_tokens).toBe(10_882)
  })

  test('数组 / null / 原始值一律拒绝', () => {
    expect(parseIngestRecord([])).toBeNull()
    expect(parseIngestRecord(null)).toBeNull()
    expect(parseIngestRecord('x')).toBeNull()
  })
})

describe('parseIngestPayload', () => {
  test('混合批次：合法行进入 records，坏行只体现在 rejected', () => {
    const parsed = parseIngestPayload(payload([rec('s:1'), { nope: true }]))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.records).toHaveLength(1)
      expect(parsed.rejected).toBe(1)
    }
  })

  test('schemaVersion 非整数 → 400', () => {
    const parsed = parseIngestPayload(payload([rec('s:1')], { schemaVersion: '1' }))
    expect(parsed.ok).toBe(false)
  })

  test('响应形状与 shared 契约一致（CLI 会解析这三个计数）', async () => {
    const res = await route().submit(payload([rec('s:1')]), 'Bearer tok-zhang')
    const body = res.body as IngestResponse
    expect(Object.keys(body).sort()).toEqual(['accepted', 'duplicates', 'rejected'])
  })
})