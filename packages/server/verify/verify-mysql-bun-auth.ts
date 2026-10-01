/**
 * Bun 侧 MySQL 认证的**活体验证** —— 需要可建临时用户的 MySQL，因此不进 `bun test`。
 *
 * ## 为什么必须有这个脚本
 *
 * Bun 1.4.2 的 `caching_sha2_password` 在**非 TLS** 连接下对口令 ≥ 20 **字节**会
 * `errno 1045`（oven-sh/bun#26195）。本仓的应对是在 `openMysqlBackend()` 里
 * **按需替使用者打开 TLS**（`planBunMysqlAuth()`），而这件事有两个特点：
 *
 * 1. **它是上游驱动的行为，不是我们的代码** —— Bun 升版可能修掉它、也可能改变触发条件。
 *    纯单测（`core/test/mysql-auth.test.ts`）只能钉住「我们怎么判」，
 *    钉不住「判了到底连不连得上」。
 * 2. **判错的代价是服务端起不来**，而且只在 Bun 上暴露 —— 本仓所有测试都跑在 Bun 上，
 *    于是一旦反过来（该开没开），**没有任何一条现有测试会红**。
 *
 * 所以这里用真库、真驱动、真口令长度跑一遍：**19 字节必须明文能连、20 字节必须靠自动 TLS 能连**，
 * 并且**把修复关掉必须能复现出缺陷本身**（否则「连上了」可能只是因为这台机器恰好不需要修）。
 *
 * ⚠️ 它只验 **Bun 那条路**，用 `bun` 跑（脚本是 TS，且按 workspace 相对路径 import）。
 *   Node 侧不受影响是**结构性**的：改动全部在 `openMysqlBackend()` 的 `if (isBun())` 分支内。
 *   Node 那条路由 `verify:mysql:node` 覆盖。
 *
 * ## 它抓到过的真 bug（留作教训）
 *
 * 第一版 `flag()` 把 `?ssl=` 的**空值**当成「使用者要求 TLS」，而 `?ssl-mode=` 的空值
 * 却当成「认不出来」—— 同一个语义两套规则。写这个脚本时先在真实判定上暴露了出来
 * （空值一律按「认不出来」处理：宁可让修复生效，也不要凭一个语义不明的空参数放弃它，
 * 因为猜错的代价是服务端起不来）。
 *
 * ## 用法
 *
 * ```bash
 * bun run --filter '@ai-token-report/server' verify:mysql:bun-auth
 * # 或指向别的环境（需要一个能 CREATE USER 的管理连接）
 * ATR_V4_TEST_MYSQL_URL='mysql://root:...@host:3306/information_schema' \
 *   bun run --filter '@ai-token-report/server' verify:mysql:bun-auth
 * ```
 *
 * 🚨 只创建 / 删除**本次自己的**临时用户（`atr_authfix*`），只跑 `SELECT 1`，
 *   不碰任何业务库与既有用户。构造不出的条件（没权限建用户 / 服务端没开 TLS）
 *   **如实跳过**并说明原因，不假装通过。
 */
import { Buffer } from 'node:buffer'

import { closeAllMysqlBackends, openMysqlBackend, planBunMysqlAuth } from '../../core/src/db/mysql.js'
import { resolveAdminMysqlUrl } from './mysql-isolation.js'

const USER_PREFIX = 'atr_authfix'
/** 三个口令的长度故意卡在边界两侧：16（明显安全）、19（边界内）、20（边界外）。 */
const CASES = [
  { tag: '16', password: 'abcdefghijklmnop' },
  { tag: '19', password: 'abcdefghijklmnopqrs' },
  { tag: '20', password: 'abcdefghijklmnopqrst' },
] as const

const bun = (globalThis as { Bun?: { version: string } }).Bun
if (!bun) {
  console.log('这个脚本验的是 Bun 那条路，请用 `bun run` 执行；Node 侧请跑 verify:mysql:node。')
  process.exit(0)
}
const runtime = `Bun ${bun.version}`

let failed = 0, passed = 0
const check = (label: string, condition: boolean, extra = ''): void => {
  if (condition) { passed++; console.log(`  ✅ ${label}`) }
  else { failed++; console.log(`  ❌ ${label} ${extra}`) }
}
const skip = (reason: string): void => { console.log(`  ⏭️  跳过：${reason}`) }

const adminUrl = resolveAdminMysqlUrl()
const admin = await openMysqlBackend(adminUrl)
const userUrl = (tag: string, query = ''): string => {
  const url = new URL(adminUrl)
  url.username = `${USER_PREFIX}${tag}`
  url.password = CASES.find(c => c.tag === tag)!.password
  return `${url.href}${query}`
}
const created: string[] = []
const dropUsers = async (): Promise<void> => {
  for (const name of created) await admin.exec(`DROP USER IF EXISTS '${name}'@'%'`)
}
let usersReady = false

console.log(`\n══ Bun/Node MySQL 认证边界（${runtime}）══`)
console.log(`   管理连接 ${adminUrl.replace(/:[^:@]+@/, ':***@')}`)

try {
  // ── 前置：服务端必须开着 TLS，否则这个修复本身无从生效 ──────────────────
  // ⚠️ 不要用 `have_ssl`：MySQL **8.4 已把它删掉**（8.0 还有），
  //   在本机 8.4 容器上会查到 0 行，于是整个脚本「静默跳过」而看起来一切正常。
  //   `ssl_cert` 两个版本都有，有值即表示服务端配好了证书。
  const cert = (await admin.get<{ Value: string }>("SHOW VARIABLES LIKE 'ssl_cert'"))?.Value ?? ''
  const tlsVersions = (await admin.get<{ Value: string }>("SHOW VARIABLES LIKE 'tls_version'"))?.Value ?? ''
  console.log(`   TLS：ssl_cert=${cert ? '已配置' : '（空）'} tls_version=${tlsVersions || '（空）'}`)
  if (!cert) {
    skip('测试 MySQL 没有配置 TLS 证书，无法验证自动 TLS 这条路径')
  } else {
    // ── 建临时用户；没权限就如实跳过（照 verify-multi-home 的规矩，不假装通过）──
    try {
      for (const item of CASES) {
        const name = `${USER_PREFIX}${item.tag}`
        await admin.exec(`CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED WITH caching_sha2_password BY '${item.password}'`)
        created.push(name)
      }
      usersReady = true
    } catch (error) {
      skip(`建临时用户失败（需要 CREATE USER 权限）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (usersReady) {
    console.log('\n[1] 判定：只有 20 字节那一档才需要本层插手')
    check('19 字节 → 不启用 TLS', planBunMysqlAuth(userUrl('19')).needsTls === false)
    check('20 字节 → 启用 TLS（边界）', planBunMysqlAuth(userUrl('20')).needsTls === true)
    check('16 字节 → 不启用 TLS', planBunMysqlAuth(userUrl('16')).needsTls === false)
    check('20 字节 + 显式 ssl-mode=DISABLED → 尊重使用者，不启用', planBunMysqlAuth(userUrl('20', '?ssl-mode=DISABLED')).needsTls === false)
    check('20 字节 + 显式 tls=true → 不重复指定', planBunMysqlAuth(userUrl('20', '?tls=true')).needsTls === false)

    /** 真连一次（`SELECT 1` 不需要任何库权限）。 */
    const connect = async (url: string): Promise<{ ok: boolean; name?: string; errno?: number; message?: string }> => {
      try {
        const backend = await openMysqlBackend(url)
        try { await backend.get('SELECT 1 AS ok') } finally { await backend.close() }
        return { ok: true }
      } catch (error) {
        const detail = error as { name?: string; errno?: number; message?: string }
        return { ok: false, name: detail.name, errno: detail.errno, message: detail.message }
      }
    }

    console.log('\n[2] 边界两侧的真实连接')
    const inner = await connect(userUrl('19'))
    check('19 字节：明文连接成功（边界内侧，不该被改动）', inner.ok, `${inner.name} ${inner.errno ?? ''} ${inner.message?.slice(0, 100) ?? ''}`)

    const outer = await connect(userUrl('20'))
    check('20 字节：URL 里没有任何 TLS 参数也能连上（= 本层的修复）', outer.ok, `${outer.name} ${outer.errno ?? ''} ${outer.message?.slice(0, 100) ?? ''}`)

    console.log('\n[3] 对照：把修复关掉，必须复现出缺陷本身')
    const disabled = await connect(userUrl('20', '?ssl-mode=DISABLED'))
    check('20 字节 + 禁用 TLS 仍然失败 → 证明上一条的成功确实来自修复', !disabled.ok, `竟然连上了（errno=${disabled.errno}）`)
    check('失败被归类为 BunMysqlAuthenticationCompatibilityError', disabled.name === 'BunMysqlAuthenticationCompatibilityError', String(disabled.name))
    check('文案指向「去掉显式选择」而不是「缩短口令」', (disabled.message ?? '').includes('去掉 URL 里'))
    check('文案没有误称「TLS 已启用」（那种情况才该按普通认证失败排查）', !(disabled.message ?? '').includes('已经'))

    // ── 短口令：非 TLS 路径本来就正常，修复不该插手 ────────────────────────
    console.log('\n[4] 短口令（16 字节）：明文连接应当直接成功')
    const short = await connect(userUrl('16'))
    check('16 字节：明文连接成功', short.ok, `${short.name} ${short.message?.slice(0, 100) ?? ''}`)
  }

  // ── 真实业务凭证的形态（若给了的话）──────────────────────────────────────
  const business = process.env.ATR_MYSQL_URL
  if (business) {
    console.log('\n[5] ATR_MYSQL_URL 指向的真实凭证')
    const url = new URL(business)
    const length = Buffer.byteLength(decodeURIComponent(url.password), 'utf8')
    console.log(`   口令长度 ${length} 字节，planBunMysqlAuth().needsTls = ${planBunMysqlAuth(business).needsTls}`)
    try {
      const backend = await openMysqlBackend(business)
      await backend.get('SELECT 1 AS ok')
      await backend.close()
      check('不带任何 TLS 参数即可连接', true)
    } catch (error) {
      const detail = error as { message?: string }
      check('不带任何 TLS 参数即可连接', false, String(detail.message).slice(0, 160))
    }
  } else {
    console.log('\n[5] 未提供 ATR_MYSQL_URL，跳过真实业务凭证那一条')
  }
} finally {
  await dropUsers().catch(() => { /* 清理失败不该覆盖断言结果 */ })
  await closeAllMysqlBackends()
  await admin.close()
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败（${runtime}）`)
if (failed) process.exitCode = 1
