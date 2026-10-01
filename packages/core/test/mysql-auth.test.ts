/**
 * Bun 侧 MySQL 认证规划（`core/db/mysql.ts` 的 `planBunMysqlAuth()`）单元测试。
 *
 * ## 守的是什么
 *
 * Bun 1.4.2 的 `caching_sha2_password` 在**非 TLS** 连接下对口令 ≥ 20 字节会
 * `errno 1045`（oven-sh/bun#26195）。本仓的应对是在 `openMysqlBackend()` 里
 * **按需替使用者打开 TLS**，而这个决定完全由这个纯函数做出。
 *
 * 它判错的两个方向都是**静默**的：
 * - 该开而没开 → 服务端连不上（线上实测过：`atr_user` 32 字符口令直接 1045）；
 * - 不该开而开了 → 把一条本来能用的连接弄坏（服务端没开 TLS 时），而且只在**运行时**暴露。
 *
 * 所以边界必须在这里钉死。**这些用例不连库**，是 `bun test` 的第一道网；
 * 「真的能连上」由活体脚本证明（见 `docs/性能：Node22 与 Bun 对比实测.md` 与
 * `packages/server/verify/perf/runtime-ab/`）。
 */

import { describe, expect, test } from 'bun:test'

import { planBunMysqlAuth } from '../src/db/mysql.js'

/** 拼一个带口令的连接串（口令原样进 URL，便于逐字构造需要百分号转义的用例）。 */
const url = (password: string, query = ''): string =>
  `mysql://atr_user:${password}@127.0.0.1:3308/ai_token_report${query}`

describe('planBunMysqlAuth：口令长度边界（20 字节）', () => {
  test('19 字符不触发（非 TLS 路径本来就正常，不该替使用者改传输方式）', () => {
    const plan = planBunMysqlAuth(url('a'.repeat(19)))
    expect(plan.longPassword).toBe(false)
    expect(plan.needsTls).toBe(false)
  })

  test('20 字符触发 —— 边界正好是「装得下一个 scramble」', () => {
    const plan = planBunMysqlAuth(url('a'.repeat(20)))
    expect(plan.longPassword).toBe(true)
    expect(plan.needsTls).toBe(true)
  })

  test('线上真实形态：32 字符触发', () => {
    expect(planBunMysqlAuth(url('a'.repeat(32))).needsTls).toBe(true)
  })

  test('🚨 按 UTF-8 **字节**算，不是字符数：10 个汉字 = 30 字节 → 触发', () => {
    const plan = planBunMysqlAuth(url('口令口令口令口令口令'))
    expect(plan.longPassword).toBe(true)
    expect(plan.needsTls).toBe(true)
  })

  test('🚨 百分号转义要先解码再量：`%61` + 18 字符 = 19 字符 → 不触发', () => {
    // 不解码的话原文是 21 个字符，会被误判成长口令。
    const plan = planBunMysqlAuth(url(`%61${'a'.repeat(18)}`))
    expect(plan.longPassword).toBe(false)
    expect(plan.needsTls).toBe(false)
  })

  test('没有口令（或只有用户名）时不触发', () => {
    expect(planBunMysqlAuth('mysql://atr_user@127.0.0.1:3308/db').needsTls).toBe(false)
    expect(planBunMysqlAuth('mysql://atr_user:@127.0.0.1:3308/db').needsTls).toBe(false)
  })
})

describe('planBunMysqlAuth：尊重 URL 的显式选择', () => {
  test('URL 自己已经要求 TLS 时不重复指定', () => {
    for (const query of ['?tls=true', '?ssl=true', '?ssl-mode=REQUIRED', '?ssl-mode=VERIFY_IDENTITY']) {
      const plan = planBunMysqlAuth(url('a'.repeat(32), query))
      expect(plan.urlRequestsTls).toBe(true)
      expect(plan.needsTls).toBe(false)
    }
  })

  test('🚨 URL 显式要求**不要** TLS 时不覆盖（那是使用者的明确决定）', () => {
    for (const query of ['?tls=false', '?ssl=false', '?ssl-mode=DISABLED', '?ssl-mode=disabled']) {
      const plan = planBunMysqlAuth(url('a'.repeat(32), query))
      expect(plan.urlDisabledTls).toBe(true)
      expect(plan.needsTls).toBe(false)
    }
  })

  test('认不出来的取值一律不当作「要」也不当作「不要」—— 修复默认生效', () => {
    // ⚠️ 含**空值**（`?ssl-mode=` / `?tls=`）：语义不明的空参数不能成为
    //    「放弃修复」的理由，否则使用者的笔误会让服务端起不来。
    for (const query of ['?ssl-mode=PREFERRED', '?tls=maybe', '?ssl-mode=', '?tls=']) {
      const plan = planBunMysqlAuth(url('a'.repeat(32), query))
      expect(plan.urlRequestsTls).toBe(false)
      expect(plan.urlDisabledTls).toBe(false)
      expect(plan.needsTls).toBe(true)
    }
  })

  test('短口令 + URL 要求 TLS：照 URL 走，needsTls 仍是 false（不重复指定）', () => {
    const plan = planBunMysqlAuth(url('a'.repeat(8), '?tls=true'))
    expect(plan.longPassword).toBe(false)
    expect(plan.urlRequestsTls).toBe(true)
    expect(plan.needsTls).toBe(false)
  })
})

describe('planBunMysqlAuth：坏输入不抛错、不误判', () => {
  test('连接串语法错误时全 false（错误留给驱动去报）', () => {
    for (const bad of ['', 'not a url', 'mysql://', '://x']) {
      expect(planBunMysqlAuth(bad)).toEqual({
        longPassword: false, urlRequestsTls: false, urlDisabledTls: false, needsTls: false,
      })
    }
  })

  test('非法百分号转义按原文量长度，不抛错', () => {
    const plan = planBunMysqlAuth('mysql://u:%zzzzzzzzzzzzzzzzzzzzzzzz@h:3308/db')
    expect(plan.longPassword).toBe(true)
    expect(plan.needsTls).toBe(true)
  })
})
