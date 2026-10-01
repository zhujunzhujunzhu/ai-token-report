/**
 * 启动横幅「上报库」那一行的单元测试。
 *
 * ## 守的是什么
 *
 * 核心层会替「长口令 + 非 TLS」的 Bun 连接**自动打开 TLS**
 * （`core/src/db/mysql.ts` 的 `planBunMysqlAuth()`）。横幅**必须把这件事说出来** ——
 * 否则运维看到「MySQL xxx @ host:port」会以为连接还是明文的，而传输方式已经被换掉了。
 * 这类「静默改变了行为却不告知」的缺陷不会报错、也没有别的信号。
 *
 * 另一条同样重要：**只能加后缀**。`describePortalTarget()` 的输出还被迁移的
 * 备份证明当成等值键逐字比对（`portal-migrations.ts` 的
 * `proof.target !== describePortalTarget(target)`），改它会静默废掉历史备份证明。
 */

import { describe, expect, test } from 'bun:test'

import { portalTargetLabelFor } from '../src/index.js'

const LONG = 'a'.repeat(32)
const SHORT = 'a'.repeat(8)
const url = (password: string, query = ''): string => `mysql://atr_user:${password}@127.0.0.1:3308/ai_token_report${query}`

describe('portalTargetLabelFor', () => {
  test('🚨 Bun + 长口令：横幅必须点明「已自动启用 TLS」', () => {
    const label = portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(LONG) }, true)
    expect(label).toContain('已自动启用 TLS')
    // 原有信息一个都不能少，否则运维反而看不出连的是哪个库。
    expect(label).toContain('MySQL')
    expect(label).toContain('ai_token_report')
    expect(label).toContain('127.0.0.1:3308')
  })

  test('🚨 绝不能把口令带进横幅', () => {
    expect(portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(LONG) }, true)).not.toContain(LONG)
  })

  test('Node 上不加后缀 —— 那边根本不需要这件事（不制造噪声）', () => {
    const label = portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(LONG) }, false)
    expect(label).not.toContain('TLS')
    expect(label).toBe('MySQL ai_token_report @ 127.0.0.1:3308')
  })

  test('短口令不加后缀 —— 非 TLS 路径本来就正常，没什么可说', () => {
    expect(portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(SHORT) }, true)).not.toContain('TLS')
  })

  test('URL 自己已经要求 TLS 时不加后缀（我们没有替他做任何事）', () => {
    expect(portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(LONG, '?ssl-mode=REQUIRED') }, true)).not.toContain('TLS')
  })

  test('SQLite 目标原样返回', () => {
    expect(portalTargetLabelFor({ sqlitePath: '/data/portal.sqlite' }, true)).toBe('/data/portal.sqlite')
  })

  test('🚨 加后缀时前缀必须与原函数**逐字**相同（备份证明比对的就是它）', () => {
    const long = portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(LONG) }, true)
    const short = portalTargetLabelFor({ sqlitePath: '', mysqlUrl: url(SHORT) }, true)
    expect(long.startsWith(short)).toBe(true)
  })
})
