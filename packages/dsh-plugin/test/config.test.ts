/**
 * 全局配置的测试。
 *
 * ★ 这里钉死的是**团队铺开时最容易出错的那一层**：优先级。
 *   环境变量与 config 打架时以谁为准、写错的数字会不会让 DSH 起不来、
 *   以及「凭证/地址缺一个就不该上报」。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  canReport,
  claimedUserId,
  DEFAULTS,
  DEFAULT_ENDPOINT,
  DEFAULT_NAME,
  ENV,
  resolveConfig,
  validateConfig,
} from '../src/config.js'

/** 本次用例里设过的环境变量，便于逐个还原。 */
const touched: string[] = []

function setEnv(key: string, value: string): void {
  process.env[key] = value
  touched.push(key)
}

beforeEach(() => {
  touched.length = 0
  // 起手清干净：本机 DSH 进程自己可能有这些变量，不清会让用例互相污染
  for (const key of Object.values(ENV)) delete process.env[key]
})

afterEach(() => {
  for (const key of touched) delete process.env[key]
})

describe('默认值', () => {
  test('空配置 → 名字与地址取默认，凭证为空（于是不上报）', () => {
    const c = resolveConfig({})
    expect(c.name).toBe(DEFAULT_NAME)
    expect(c.endpoint).toBe(DEFAULT_ENDPOINT)
    expect(c.appKey).toBe('')
    expect(canReport(c)).toBe(false)
  })

  test('批量与 outbox 的默认值来自 DEFAULTS，不是散落的字面量', () => {
    const c = resolveConfig({})
    expect(c.batch.maxRecords).toBe(DEFAULTS.batch.maxRecords)
    expect(c.batch.flushIntervalMillis).toBe(DEFAULTS.batch.flushIntervalMillis)
    expect(c.batch.timeoutMillis).toBe(DEFAULTS.batch.timeoutMillis)
    expect(c.outbox.enabled).toBe(true)
    expect(c.outbox.maxBytes).toBe(DEFAULTS.outbox.maxBytes)
  })

  test('★ 功能开关默认全开，但 localDb 默认关（宿主是 Node 时 bun:sqlite 不存在）', () => {
    const c = resolveConfig({})
    expect(c.features).toEqual({ reporting: true, tools: true, service: true })
    expect(c.localDb).toBe(false)
  })
})

describe('优先级：config > 环境变量 > 默认值', () => {
  test('config 覆盖环境变量', () => {
    setEnv(ENV.name, 'from-env')
    setEnv(ENV.endpoint, 'https://env.test/api')
    const c = resolveConfig({ name: 'from-config', endpoint: 'https://config.test/api' })
    expect(c.name).toBe('from-config')
    expect(c.endpoint).toBe('https://config.test/api')
  })

  test('环境变量覆盖默认值', () => {
    setEnv(ENV.name, 'from-env')
    setEnv(ENV.appKey, 'key-from-env')
    const c = resolveConfig({})
    expect(c.name).toBe('from-env')
    expect(c.appKey).toBe('key-from-env')
    expect(canReport(c)).toBe(true)
  })

  test('空白字符串视为「没配」，回退下一级（避免 YAML 里的空值把默认值顶掉）', () => {
    setEnv(ENV.name, '   ')
    const c = resolveConfig({ name: '   ' })
    expect(c.name).toBe(DEFAULT_NAME)
  })
})

describe('非法值不让 DSH 起不来', () => {
  test('★ 批量数字写成 0 / 负数 / NaN → 回退默认值，而不是抛错', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = resolveConfig({ batch: { maxRecords: bad, flushIntervalMillis: bad } })
      expect(c.batch.maxRecords).toBe(DEFAULTS.batch.maxRecords)
      expect(c.batch.flushIntervalMillis).toBe(DEFAULTS.batch.flushIntervalMillis)
    }
  })

  test('环境变量里的数字写错 → 同样回退默认值', () => {
    setEnv(ENV.maxRecords, '不是数字')
    expect(resolveConfig({}).batch.maxRecords).toBe(DEFAULTS.batch.maxRecords)
  })

  test('布尔环境变量认得 1/true/yes 与 0/false/no，其余忽略', () => {
    setEnv(ENV.outboxEnabled, 'false')
    expect(resolveConfig({}).outbox.enabled).toBe(false)

    setEnv(ENV.outboxEnabled, 'yes')
    expect(resolveConfig({}).outbox.enabled).toBe(true)

    setEnv(ENV.outboxEnabled, '随便写的')
    expect(resolveConfig({}).outbox.enabled).toBe(DEFAULTS.outbox.enabled)
  })
})

describe('身份', () => {
  test('config.user 两项齐全才生效', () => {
    const c = resolveConfig({ user: { name: '张三', token: 'tok', dept: '研发一部' } })
    expect(c.user).toEqual({ name: '张三', token: 'tok', dept: '研发一部' })
  })

  test('★ 半份身份（只有名字没 token）→ 视为这一级没配，回退到环境变量', () => {
    setEnv(ENV.userName, '环境里的李四')
    setEnv(ENV.userToken, 'env-token')
    const c = resolveConfig({ user: { name: '张三' } })
    expect(c.user?.name).toBe('环境里的李四')
  })

  test('两处都没有 → user 缺席（于是 evaluateStatus 会判成未署名）', () => {
    expect(resolveConfig({}).user).toBeUndefined()
  })

  test('claimedUserId 只是「自称」，取不到就报 unconfigured', () => {
    expect(claimedUserId(resolveConfig({}), null)).toBe('unconfigured')
    expect(claimedUserId(resolveConfig({}), { name: '张三', token: 't', createdAt: 0, updatedAt: 0 })).toBe('张三')
  })
})

describe('配置自检', () => {
  test('★ 缺 appKey 时给出的提示必须说明「怎么配」', () => {
    const problems = validateConfig(resolveConfig({}))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('appKey')
    expect(problems[0]).toContain(ENV.appKey)
  })

  test('地址不是 http(s) 会被指出来', () => {
    const problems = validateConfig(resolveConfig({ endpoint: 'ftp://portal/api' }))
    expect(problems.some((p) => p.includes('http(s)'))).toBe(true)
  })

  test('打开 localDb 时会警告宿主运行时限制', () => {
    const problems = validateConfig(resolveConfig({ appKey: 'k', localDb: true }))
    expect(problems.some((p) => p.includes('bun:sqlite'))).toBe(true)
  })

  test('配齐之后没有任何问题', () => {
    expect(validateConfig(resolveConfig({ appKey: 'atr-key' }))).toEqual([])
  })
})

describe('包含对话内容这件事没有开关', () => {
  test('★ 配置与类型里都不存在能把内容带出去的字段', () => {
    const c = resolveConfig({}) as unknown as Record<string, unknown>
    expect('includeContent' in c).toBe(false)
  })
})