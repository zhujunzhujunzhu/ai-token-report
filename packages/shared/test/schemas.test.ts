/**
 * 请求体 zod schema 的单元测试（纯函数，不连库、不起服务）。
 *
 * ★ 断言的重点**不是**「zod 工作正常」，而是两件事：
 *
 *   1. **提示语逐字一致** —— 这些字符串就是路由回给前端 / CLI 的 `reason`，
 *      `server/test/ingest.test.ts`、`e2e-ingest.ts`、`e2e-admin.ts`、
 *      `http-contract.test.ts` 都按它们断言。测试里把原话**写死**：
 *      改文案就会红，而不是等页面上多出一句没人认识的提示。
 *   2. **归一化行为与手写的 `stringOrEmpty` / `optionalInt` 等逐条一致** ——
 *      哪些字段缺失即 0、哪些非法降级成 null、哪些必须拒收整行，
 *      都对应 `schemas.ts` 里那张判定表。
 *
 * ⚠️ 唯一**刻意**的差异是安全整数收紧（`ts: 1e300`）：见下面那条 ★ 断言。
 */

import { describe, expect, test } from 'bun:test'

import { SCHEMA_VERSION } from '../src/protocol.js'
import {
  ingestRecordSchema,
  parseAdminIssueBody,
  parseAdminLoginBody,
  parseAdminTokenBody,
  parseAdminUpdateBody,
  parseIngestEnvelope,
  type ShapeResult,
} from '../src/schemas.js'

/** 取校验失败的原因；成功时抛错 —— 测试里出现「预期失败却通过」是 bug。 */
function reasonOf(result: ShapeResult<unknown>): string {
  if (result.ok) throw new Error('预期校验失败，但它通过了')
  return result.reason
}

/** 单行记录：与 `server/src/ingest-route.ts` 的 `parseIngestRecord` 同语义。 */
function parseRecord(value: unknown) {
  const parsed = ingestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 一条合法的最小记录（只带必需字段）+ 覆盖项。 */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 's:1',
    session_id: 's',
    seq: 1,
    ts: 1790245427069,
    input_tokens: 10_882,
    output_tokens: 186,
    cache_read_tokens: 9_845,
    cache_write_tokens: 0,
    ...overrides,
  }
}

/** 一批上报载荷 + 覆盖项。 */
function payload(records: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, client: { userName: '某某' }, generatedAt: 'x', records, ...overrides }
}

// ─────────────────────────────────────────────────────────────
describe('parseIngestEnvelope（整批：结构性失败 = 400）', () => {
  test('合法载荷通过，只交出 records（未声明的键一律丢掉）', () => {
    const parsed = parseIngestEnvelope(payload([record()]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.records).toHaveLength(1)
    // ★ 归属只信服务端：请求体里的 client / generatedAt 不进任何逻辑
    expect(Object.keys(parsed.value)).toEqual(['records'])
  })

  test('schemaVersion 缺省按当前版本处理（新旧客户端混跑不互相拒绝）', () => {
    const parsed = parseIngestEnvelope({ records: [] })
    expect(parsed.ok).toBe(true)
  })

  test('请求体不是对象 → 「请求体应为 JSON 对象」（文案逐字）', () => {
    for (const bad of [null, undefined, 5, 'x', true, [], [record()]]) {
      expect(reasonOf(parseIngestEnvelope(bad))).toBe('请求体应为 JSON 对象')
    }
  })

  test('schemaVersion 不是整数 → 「schemaVersion 应为整数」', () => {
    for (const bad of ['1', 1.5, null, true, Number.NaN, {}]) {
      expect(reasonOf(parseIngestEnvelope(payload([], { schemaVersion: bad })))).toBe(
        'schemaVersion 应为整数',
      )
    }
  })

  test('★ schemaVersion 高于本服务端 → 400，且原因里带具体版本号（e2e 断言含 99）', () => {
    const reason = reasonOf(parseIngestEnvelope(payload([], { schemaVersion: 99 })))
    expect(reason).toBe(`上报协议版本 99 高于本服务端支持的 ${SCHEMA_VERSION}，请升级服务端`)
    expect(reason).toContain('99')
  })

  test('★ 版本过高与缺 records 同时出现时，报的仍是版本号（顺序不变量）', () => {
    // 版本号是定位问题的关键信息，被一句无关的「records 应为数组」盖掉
    // 会让排障方向完全跑偏 —— 所以这条顺序被钉住
    const reason = reasonOf(parseIngestEnvelope({ schemaVersion: 99 }))
    expect(reason).toContain('上报协议版本 99')
    expect(reason).not.toContain('records')
  })

  test('records 不是数组 → 「records 应为数组」', () => {
    for (const bad of [undefined, null, 'x', 5, {}]) {
      expect(reasonOf(parseIngestEnvelope(payload([], { records: bad })))).toBe('records 应为数组')
    }
  })
})

// ─────────────────────────────────────────────────────────────
describe('ingestRecordSchema（单行：失败只计入 rejected）', () => {
  test('必需字段齐全时可归一化（trim + 缺失字段的兜底）', () => {
    const r = parseRecord(record({ event_id: '  s:1  ', provider: '  dashscope ', model: ' m ' }))
    expect(r?.event_id).toBe('s:1')
    expect(r?.session_id).toBe('s')
    expect(r?.input_tokens).toBe(10_882)
    expect(r?.cache_read_tokens).toBe(9_845)
    expect(r?.provider).toBe('dashscope')
    expect(r?.model).toBe('m')
    expect(r?.cwd).toBeNull()
    expect(r?.turn).toBeNull()
    expect(r?.step).toBeNull()
  })

  test('event_id / session_id 为空串、空白或非字符串 → 拒收', () => {
    expect(parseRecord(record({ event_id: '   ' }))).toBeNull()
    expect(parseRecord(record({ event_id: 123 }))).toBeNull()
    expect(parseRecord(record({ event_id: undefined }))).toBeNull()
    expect(parseRecord(record({ session_id: null }))).toBeNull()
    expect(parseRecord(record({ session_id: '  ' }))).toBeNull()
  })

  test('seq / ts 必须是非负整数（字符串数字、浮点、负数一律拒收）', () => {
    expect(parseRecord(record({ seq: 1.5 }))).toBeNull()
    expect(parseRecord(record({ seq: -1 }))).toBeNull()
    expect(parseRecord(record({ seq: '1' }))).toBeNull()
    expect(parseRecord(record({ ts: '1790245427069' }))).toBeNull()
    expect(parseRecord(record({ ts: -1 }))).toBeNull()
    // 0 是合法时间戳/序号：它必须能过
    expect(parseRecord(record({ ts: 0 }))?.ts).toBe(0)
    expect(parseRecord(record({ seq: 0 }))?.seq).toBe(0)
  })

  test('🚨 四个 token 缺失或非法一律拒收 —— 绝不兜底成 0', () => {
    // 兜底成 0 会把「客户端漏字段」变成一条看起来正常的记录：
    // 用量悄悄少掉、且没有任何东西会报错（铁律 2 的四个分列各自独立）
    for (const field of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
      expect(parseRecord(record({ [field]: undefined }))).toBeNull()
      expect(parseRecord(record({ [field]: -1 }))).toBeNull()
      expect(parseRecord(record({ [field]: 1.5 }))).toBeNull()
      expect(parseRecord(record({ [field]: '0' }))).toBeNull()
    }
    // 0 本身合法（没有缓存命中就是 0）
    expect(parseRecord(record({ cache_write_tokens: 0 }))?.cache_write_tokens).toBe(0)
  })

  test('reasoning_tokens 缺失即 0（它是 output 的子集，多数 provider 不下发）', () => {
    expect(parseRecord(record({ reasoning_tokens: undefined }))?.reasoning_tokens).toBe(0)
    expect(parseRecord(record({ reasoning_tokens: 'x' }))?.reasoning_tokens).toBe(0)
    expect(parseRecord(record({ reasoning_tokens: 42 }))?.reasoning_tokens).toBe(42)
  })

  test('provider / model 非法时降级成空串（只影响分组，不值得拒收整行）', () => {
    expect(parseRecord(record({ provider: 42 }))?.provider).toBe('')
    expect(parseRecord(record({ model: null }))?.model).toBe('')
    expect(parseRecord(record())?.provider).toBe('')
  })

  test('cwd / turn / step 非法时降级成 null，不影响其他字段', () => {
    const r = parseRecord(record({ turn: 'a', step: 2.5, cwd: 42 }))
    expect(r?.turn).toBeNull()
    expect(r?.step).toBeNull()
    expect(r?.cwd).toBeNull()
    expect(r?.input_tokens).toBe(10_882)
    expect(parseRecord(record({ cwd: '  ' }))?.cwd).toBeNull()
    expect(parseRecord(record({ cwd: ' D:\\proj ' }))?.cwd).toBe('D:\\proj')
    // ★ turn / step 允许负数（手写版 `optionalInt` 也允许）
    expect(parseRecord(record({ turn: -3 }))?.turn).toBe(-3)
  })

  test('🚨 total_tokens 不在落库类型里（铁律 2）：带进来也不落、不影响任何字段', () => {
    const r = parseRecord(record({ total_tokens: 999_999 }))
    expect(r).not.toBeNull()
    expect(r && 'total_tokens' in r).toBe(false)
    expect(r?.input_tokens).toBe(10_882)
  })

  test('数组 / null / 原始值一律拒收', () => {
    expect(parseRecord([])).toBeNull()
    expect(parseRecord(null)).toBeNull()
    expect(parseRecord('x')).toBeNull()
    expect(parseRecord(5)).toBeNull()
  })

  test('★ 安全整数收紧（刻意与手写 Number.isInteger 的差异）：2^53 以上的 ts 拒收', () => {
    // 手写版 `Number.isInteger(1e300) && v >= 0` 会放行它，而那样的 ts
    // 落库只会污染时间窗。zod 的 z.int() 顺带要求安全整数 —— 这条差异是刻意的
    expect(parseRecord(record({ ts: 2 ** 53 }))).toBeNull()
    expect(parseRecord(record({ ts: Number.MAX_SAFE_INTEGER }))).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// 人员管理：文案逐字（`admin-route.ts` 与前端都按它展示）
// ─────────────────────────────────────────────────────────────
describe('parseAdminIssueBody（签发）', () => {
  test('合法请求体通过，未声明的键被丢掉', () => {
    const r = parseAdminIssueBody({ name: '张三', dept: '研发一部', role: 'admin', extra: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ name: '张三', dept: '研发一部', role: 'admin' })
  })

  test('dept / role 是可选的', () => {
    const r = parseAdminIssueBody({ name: '张三' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.dept).toBeUndefined()
    expect(r.value.role).toBeUndefined()
  })

  test('非对象 → 「请求体需要是一个对象」', () => {
    for (const bad of [null, undefined, 5, 'x', [], ['a']]) {
      expect(reasonOf(parseAdminIssueBody(bad))).toBe('请求体需要是一个对象')
    }
  })

  test('缺 name / name 非字符串 → 「缺少 name（要发放 token 的姓名）」', () => {
    expect(reasonOf(parseAdminIssueBody({}))).toBe('缺少 name（要发放 token 的姓名）')
    expect(reasonOf(parseAdminIssueBody({ name: 1 }))).toBe('缺少 name（要发放 token 的姓名）')
    expect(reasonOf(parseAdminIssueBody({ name: null }))).toBe('缺少 name（要发放 token 的姓名）')
  })

  test('dept / role 非字符串 → 各自那句文案', () => {
    expect(reasonOf(parseAdminIssueBody({ name: 'a', dept: 1 }))).toBe('dept 需要是字符串')
    expect(reasonOf(parseAdminIssueBody({ name: 'a', role: 1 }))).toBe('role 需要是字符串')
    expect(reasonOf(parseAdminIssueBody({ name: 'a', dept: 'x', role: {} }))).toBe('role 需要是字符串')
  })

  test('★ 多处同时不合法时报第一条（顺序即优先级，与手写 if 链一致）', () => {
    expect(reasonOf(parseAdminIssueBody({ dept: 1, role: 1 }))).toBe('缺少 name（要发放 token 的姓名）')
    expect(reasonOf(parseAdminIssueBody({ name: 'a', dept: 1, role: 1 }))).toBe('dept 需要是字符串')
  })

  test('空姓名 / 未知角色是**业务**失败，形状层放行（回 200 + ok:false 的那一类）', () => {
    // 形状校验只查类型：把业务规则搬进来会让「改输入」和「换 token」
    // 两类错误在页面上混成同一句话
    expect(parseAdminIssueBody({ name: '' }).ok).toBe(true)
    expect(parseAdminIssueBody({ name: 'a', role: 'superadmin' }).ok).toBe(true)
  })
})

describe('parseAdminUpdateBody（改名 / 换部门 / 调角色）', () => {
  test('合法请求体通过；token 原样保留（不 trim）', () => {
    const r = parseAdminUpdateBody({ token: ' atr-x ', name: '李四', dept: '', role: 'member' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // ★ 只校验、不改值：下游 member-admin 拿到的仍是原始 token
    expect(r.value.token).toBe(' atr-x ')
    expect(r.value.dept).toBe('')
  })

  test('缺 token / token 空白 / token 非字符串 → 「缺少 token（要修改哪个人）」', () => {
    expect(reasonOf(parseAdminUpdateBody({}))).toBe('缺少 token（要修改哪个人）')
    expect(reasonOf(parseAdminUpdateBody({ token: '   ' }))).toBe('缺少 token（要修改哪个人）')
    expect(reasonOf(parseAdminUpdateBody({ token: 5 }))).toBe('缺少 token（要修改哪个人）')
    expect(reasonOf(parseAdminUpdateBody({ token: null }))).toBe('缺少 token（要修改哪个人）')
  })

  test('name / dept / role 非字符串 → 各自那句文案', () => {
    expect(reasonOf(parseAdminUpdateBody({ token: 't', name: 1 }))).toBe('name 需要是字符串')
    expect(reasonOf(parseAdminUpdateBody({ token: 't', dept: 1 }))).toBe('dept 需要是字符串')
    expect(reasonOf(parseAdminUpdateBody({ token: 't', role: 1 }))).toBe('role 需要是字符串')
  })

  test('非对象 → 「请求体需要是一个对象」（且优先于 token 那句）', () => {
    expect(reasonOf(parseAdminUpdateBody(null))).toBe('请求体需要是一个对象')
    expect(reasonOf(parseAdminUpdateBody([]))).toBe('请求体需要是一个对象')
  })
})

describe('parseAdminTokenBody（重置 / 吊销）', () => {
  test('合法请求体通过', () => {
    const r = parseAdminTokenBody({ token: 'atr-x' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.token).toBe('atr-x')
  })

  test('缺 token / 空白 / 非字符串 → 「缺少 token（要操作哪个人）」', () => {
    expect(reasonOf(parseAdminTokenBody({}))).toBe('缺少 token（要操作哪个人）')
    expect(reasonOf(parseAdminTokenBody({ token: '  ' }))).toBe('缺少 token（要操作哪个人）')
    expect(reasonOf(parseAdminTokenBody({ token: 5 }))).toBe('缺少 token（要操作哪个人）')
  })

  test('非对象 → 「请求体需要是一个对象」（空 body 走的是这条，不是 token 那句）', () => {
    // 人员管理的 body 是**宽松**读取（空 body → null），所以这句必须对
    expect(reasonOf(parseAdminTokenBody(null))).toBe('请求体需要是一个对象')
    expect(reasonOf(parseAdminTokenBody(undefined))).toBe('请求体需要是一个对象')
  })
})

describe('parseAdminLoginBody（开通后台账号）', () => {
  test('合法请求体通过', () => {
    const r = parseAdminLoginBody({ token: 't', username: 'u', password: 'p' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ token: 't', username: 'u', password: 'p' })
  })

  test('缺 username / password（或非字符串）→ 「username 与 password 需要是字符串」', () => {
    const message = 'username 与 password 需要是字符串'
    expect(reasonOf(parseAdminLoginBody({ token: 't' }))).toBe(message)
    expect(reasonOf(parseAdminLoginBody({ token: 't', username: 'u' }))).toBe(message)
    expect(reasonOf(parseAdminLoginBody({ token: 't', username: 1, password: 'p' }))).toBe(message)
    expect(reasonOf(parseAdminLoginBody({ token: 't', username: 'u', password: null }))).toBe(message)
  })

  test('★ 定位 token 缺失时先报 token（顺序即优先级）', () => {
    expect(reasonOf(parseAdminLoginBody({}))).toBe('缺少 token（要操作哪个人）')
    expect(reasonOf(parseAdminLoginBody(null))).toBe('请求体需要是一个对象')
  })
})