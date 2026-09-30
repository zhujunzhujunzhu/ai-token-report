/**
 * 本地启动自助配置的单测（`bun run server` 的那一步）。
 *
 * ## 这个文件在防什么
 *
 * 这段逻辑的两种错法**都不会报错**，只会让人「看起来一切正常」：
 *
 * | 写错的地方 | 看起来像 |
 * |---|---|
 * | 对外监听 / 共享 MySQL 也自动生成 | 多实例各自一把密钥 → 「验证码永远错」 |
 * | 覆盖外部已设的环境变量 | 部署里显式配的密钥被本地文件顶掉 |
 * | 生成值没有写盘 | 每次启动换一把密钥 → 验证码随机失效，且日志里看不出来 |
 * | 追加时重写整个文件 | 用户自己写进 `server.env` 的其它配置被抹掉 |
 *
 * 所以这里既断言返回值，也**直接读回文件**（返回值说生成了、文件里却没有 =
 * 下次启动又是另一把密钥）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOCAL_ADMIN_USERNAME,
  LOCAL_ENV_FILE,
  parseEnvText,
  prepareLocalEnv,
} from '../src/local/dev-env.js'

let dir = ''
const file = (): string => join(dir, LOCAL_ENV_FILE)
const text = (): string => readFileSync(file(), 'utf8')
const envOf = (): Record<string, string | undefined> => ({})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atr-dev-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('prepareLocalEnv：本机自用自动补齐', () => {
  test('空环境 + 默认回环 → 生成验证码密钥与管理员，并写盘', () => {
    const env = envOf()
    const result = prepareLocalEnv({ dataDir: dir, argv: [], env })

    expect(result.created.sort()).toEqual(['ATR_ADMIN_PASSWORD', 'ATR_ADMIN_USERNAME', 'ATR_CAPTCHA_HMAC_KEY'])
    expect(result.missing).toEqual([])
    expect(result.manualReason).toBeUndefined()

    // 密钥至少 32 字符是 portal-auth 的硬门槛（短于它等于没配）
    expect(env.ATR_CAPTCHA_HMAC_KEY!.length).toBeGreaterThanOrEqual(32)
    // 密码受登录密码策略约束：12~128
    expect(env.ATR_ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(12)
    expect(env.ATR_ADMIN_PASSWORD!.length).toBeLessThanOrEqual(128)
    expect(env.ATR_ADMIN_USERNAME).toBe(LOCAL_ADMIN_USERNAME)

    // ★ 必须真的落盘：只在内存里设一次 = 每次启动换一把密钥
    const written = parseEnvText(text())
    expect(written.ATR_CAPTCHA_HMAC_KEY).toBe(env.ATR_CAPTCHA_HMAC_KEY!)
    expect(written.ATR_ADMIN_PASSWORD).toBe(env.ATR_ADMIN_PASSWORD!)
    expect(written.ATR_ADMIN_USERNAME).toBe(LOCAL_ADMIN_USERNAME)
  })

  test('第二次启动复用同一份值（幂等，不再生成）', () => {
    const first = prepareLocalEnv({ dataDir: dir, argv: [], env: envOf() })
    const key = first.created.includes('ATR_CAPTCHA_HMAC_KEY')

    const env = envOf()
    const second = prepareLocalEnv({ dataDir: dir, argv: [], env })

    expect(key).toBe(true)
    expect(second.created).toEqual([])
    expect(second.loaded.sort()).toEqual(['ATR_ADMIN_PASSWORD', 'ATR_ADMIN_USERNAME', 'ATR_CAPTCHA_HMAC_KEY'])
    // 值必须与第一次一致：不一致就等于「每次启动作废上一把密钥」
    expect(env.ATR_CAPTCHA_HMAC_KEY).toBe(parseEnvText(text()).ATR_CAPTCHA_HMAC_KEY!)
  })

  test('文件里已有的键优先于「生成」，只补真正缺的', () => {
    writeFileSync(file(), 'ATR_CAPTCHA_HMAC_KEY=' + 'k'.repeat(40) + '\n', 'utf8')

    const env = envOf()
    const result = prepareLocalEnv({ dataDir: dir, argv: [], env })

    expect(result.loaded).toEqual(['ATR_CAPTCHA_HMAC_KEY'])
    expect(result.created.sort()).toEqual(['ATR_ADMIN_PASSWORD', 'ATR_ADMIN_USERNAME'])
    expect(env.ATR_CAPTCHA_HMAC_KEY).toBe('k'.repeat(40))
  })

  test('绝不覆盖外部显式设好的值，也不把它写进文件', () => {
    const env = { ATR_CAPTCHA_HMAC_KEY: 'external-key-that-is-long-enough-0001' }
    const result = prepareLocalEnv({ dataDir: dir, argv: [], env })

    expect(result.created.sort()).toEqual(['ATR_ADMIN_PASSWORD', 'ATR_ADMIN_USERNAME'])
    expect(env.ATR_CAPTCHA_HMAC_KEY).toBe('external-key-that-is-long-enough-0001')
    expect(text()).not.toContain('external-key-that-is-long-enough-0001')
  })

  test('追加时保留文件里其它行与注释（用户自己写的配置不能被抹掉）', () => {
    writeFileSync(
      file(),
      ['# 我自己的备注', 'ATR_ADMIN_NAME=本地管理员', 'ATR_PORTAL_ORIGIN=http://127.0.0.1:8787', ''].join('\n'),
      'utf8',
    )

    const result = prepareLocalEnv({ dataDir: dir, argv: [], env: envOf() })

    expect(result.created.length).toBe(3)
    const after = text()
    expect(after).toContain('# 我自己的备注')
    expect(after).toContain('ATR_ADMIN_NAME=本地管理员')
    expect(after).toContain('ATR_PORTAL_ORIGIN=http://127.0.0.1:8787')
    expect(after.endsWith('\n')).toBe(true)
  })
})

describe('prepareLocalEnv：不是「本机自用」就不生成', () => {
  const expectSkipped = (result: ReturnType<typeof prepareLocalEnv>): void => {
    expect(result.created).toEqual([])
    expect(result.manualReason).toBeTruthy()
    expect(result.missing.sort()).toEqual(['ATR_ADMIN_PASSWORD', 'ATR_ADMIN_USERNAME', 'ATR_CAPTCHA_HMAC_KEY'])
    // ★ 一个字节都不该落盘：对外部署拿到一把随机密钥比没有密钥更危险（多实例不一致）
    expect(existsSync(file())).toBe(false)
  }

  test('--host 不是回环地址 → 不生成并说明原因', () => {
    const result = prepareLocalEnv({ dataDir: dir, argv: ['--host', '0.0.0.0'], env: envOf() })
    expectSkipped(result)
    expect(result.manualReason).toContain('0.0.0.0')
  })

  test('--mysql / ATR_MYSQL_URL（共享库）→ 不生成', () => {
    expectSkipped(prepareLocalEnv({ dataDir: dir, argv: ['--mysql', 'mysql://u:p@h:3306/db'], env: envOf() }))
    rmSync(file(), { force: true })
    expectSkipped(prepareLocalEnv({ dataDir: dir, argv: [], env: { ATR_MYSQL_URL: 'mysql://u:p@h:3306/db' } }))
  })

  test('文件里指向 MySQL 也算共享库（先加载再判断）', () => {
    writeFileSync(file(), 'ATR_MYSQL_URL=mysql://u:p@h:3306/db\n', 'utf8')

    const env = envOf()
    const result = prepareLocalEnv({ dataDir: dir, argv: [], env })

    expect(env.ATR_MYSQL_URL).toBe('mysql://u:p@h:3306/db')
    expect(result.created).toEqual([])
    expect(result.manualReason).toBeTruthy()
    // 只补了它的判断，没有往文件里塞口令
    expect(text()).not.toContain('ATR_ADMIN_PASSWORD')
  })

  test('--help / -h 不生成（看一眼帮助不该产生副作用）', () => {
    expect(prepareLocalEnv({ dataDir: dir, argv: ['--help'], env: envOf() }).created).toEqual([])
    expect(existsSync(file())).toBe(false)
    expect(prepareLocalEnv({ dataDir: dir, argv: ['-h'], env: envOf() }).created).toEqual([])
    expect(existsSync(file())).toBe(false)
  })

  test('回环写法的几种都算本机（localhost / ::1）', () => {
    expect(prepareLocalEnv({ dataDir: dir, argv: ['--host', 'localhost'], env: envOf() }).created.length).toBe(3)
    rmSync(file(), { force: true })
    expect(prepareLocalEnv({ dataDir: dir, argv: ['--host', '::1'], env: envOf() }).created.length).toBe(3)
  })
})

describe('parseEnvText', () => {
  test('注释 / 空行 / 引号 / CRLF / 非法行都按约定处理', () => {
    const parsed = parseEnvText(
      [
        '# 注释被忽略',
        '',
        '  ATR_ADMIN_NAME=本地管理员  ',
        'ATR_ADMIN_PASSWORD="带引号的 口令"',
        "ATR_OTHER='单引号'",
        'BAH',            // 没有等号
        '=空键名',
        '1BAD=x',         // 键名非法
        'ATR_EMPTY=',
      ].join('\r\n'),
    )

    expect(parsed.ATR_ADMIN_NAME).toBe('本地管理员')
    expect(parsed.ATR_ADMIN_PASSWORD).toBe('带引号的 口令')
    expect(parsed.ATR_OTHER).toBe('单引号')
    expect(parsed.ATR_EMPTY).toBe('')
    expect(Object.keys(parsed).sort()).toEqual(['ATR_ADMIN_NAME', 'ATR_ADMIN_PASSWORD', 'ATR_EMPTY', 'ATR_OTHER'])
  })
})
