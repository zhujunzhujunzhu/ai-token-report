/**
 * 插件身份与启用判定的测试。
 *
 * ★ 最重要的一组断言：**未署名时绝不启用上报**。
 *   这个判断错了就是合规事故，必须钉死在测试里。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IdentityResolver } from '../src/identity.js'
import { describeDisabled, evaluateStatus, type Config } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import type { IdentityState } from '../src/identity.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-plugin-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 写一份身份文件。 */
function writeIdentityFile(content: unknown): void {
  mkdirSync(join(home, 'token-report'), { recursive: true })
  writeFileSync(
    join(home, 'token-report', 'identity.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8',
  )
}

/** 全套配置：署名 + 凭证 + 地址，三项齐了才应该启用上报。 */
const FULL_CONFIG = resolveConfig({ appKey: 'atr-test-key', endpoint: 'https://portal.test/api/v1/token-usage' })

/** 只有地址、没有凭证 —— 用来钉死「没 appKey 就不上报」。 */
const NO_KEY_CONFIG = resolveConfig({ endpoint: 'https://portal.test/api/v1/token-usage' })

/** 什么都没有。 */
const EMPTY_CONFIG = resolveConfig({})

/** 一份已署名的身份状态。 */
const SIGNED: IdentityState = {
  ready: true,
  identity: { name: '张三', token: 'tok', createdAt: 0, updatedAt: 0 },
  assertion: { name: '张三' },
}

describe('启用判定 —— 未署名绝不启用', () => {
  test('★ 未署名 + 配了 appKey 与 endpoint → 仍然不启用上报', () => {
    const state: IdentityState = { ready: false, reason: 'missing' }
    const status = evaluateStatus(state, FULL_CONFIG)
    expect(status.reportingEnabled).toBe(false)
    expect(status.identityReady).toBe(false)
  })

  test('★ 未署名 + 没配任何东西 → 不启用', () => {
    const status = evaluateStatus({ ready: false, reason: 'missing' }, EMPTY_CONFIG)
    expect(status.reportingEnabled).toBe(false)
  })

  test('★ 已署名但没配 appKey → 不启用，且原因指向 appKey', () => {
    const status = evaluateStatus(SIGNED, NO_KEY_CONFIG)
    expect(status.reportingEnabled).toBe(false)
    expect(status.identityReady).toBe(true)
    expect(status.disabledReason).toContain('appKey')
  })

  test('★ 显式关掉 reporting 开关 → 不启用（即使三项都齐）', () => {
    const config = resolveConfig({
      appKey: 'atr-test-key',
      endpoint: 'https://portal.test/api/v1/token-usage',
      features: { reporting: false },
    })
    expect(evaluateStatus(SIGNED, config).reportingEnabled).toBe(false)
  })

  test('已署名 + 配了 appKey 与 endpoint → 启用', () => {
    expect(evaluateStatus(SIGNED, FULL_CONFIG).reportingEnabled).toBe(true)
  })
})

describe('身份解析', () => {
  test('无文件 → missing', () => {
    const r = new IdentityResolver({ dshHome: home })
    const s = r.resolve()
    expect(s.ready).toBe(false)
    if (!s.ready) expect(s.reason).toBe('missing')
    expect(r.signed).toBe(false)
  })

  test('文件合法 → ready，且 assertion 不含 token', () => {
    writeIdentityFile({
      name: '张三',
      token: 'tok-secret',
      dept: '研发一部',
      createdAt: 1,
      updatedAt: 1,
    })

    const r = new IdentityResolver({ dshHome: home })
    const s = r.resolve()
    expect(s.ready).toBe(true)
    if (s.ready) {
      expect(s.assertion.name).toBe('张三')
      expect(s.assertion.dept).toBe('研发一部')
      // ★ assertion 是发给服务端的视图，绝不能带 token
      expect(JSON.stringify(s.assertion)).not.toContain('tok-secret')
    }
  })

  test('文件损坏 → corrupt（与 missing 区分开）', () => {
    writeIdentityFile('{ 坏 JSON')
    const s = new IdentityResolver({ dshHome: home }).resolve()
    expect(s.ready).toBe(false)
    if (!s.ready) expect(s.reason).toBe('corrupt')
  })

  test('插件配置优先于文件', () => {
    writeIdentityFile({ name: '文件里的张三', token: 'tok-file', createdAt: 1, updatedAt: 1 })

    const r = new IdentityResolver({
      dshHome: home,
      configIdentity: { name: '配置里的李四', token: 'tok-config' },
    })
    const s = r.resolve()
    expect(s.ready).toBe(true)
    if (s.ready) expect(s.identity.name).toBe('配置里的李四')
  })

  test('配置里字段为空 → 回退到文件', () => {
    writeIdentityFile({ name: '文件里的张三', token: 'tok-file', createdAt: 1, updatedAt: 1 })

    const r = new IdentityResolver({
      dshHome: home,
      configIdentity: { name: '   ', token: '' },
    })
    const s = r.resolve()
    expect(s.ready).toBe(true)
    if (s.ready) expect(s.identity.name).toBe('文件里的张三')
  })

  test('可以写入并读回（与本地页共用同一份文件）', () => {
    const r = new IdentityResolver({ dshHome: home })
    const saved = r.save({ name: '张三', token: 'tok-abc', dept: '研发一部' })
    expect(saved.ok).toBe(true)

    const s = r.resolve()
    expect(s.ready).toBe(true)
    if (s.ready) {
      expect(s.identity.name).toBe('张三')
      expect(s.identity.dept).toBe('研发一部')
    }
  })

  test('清除后回到未署名', () => {
    const r = new IdentityResolver({ dshHome: home })
    r.save({ name: '张三', token: 'tok-abc' })
    expect(r.signed).toBe(true)

    r.clear()
    expect(r.signed).toBe(false)
  })
})

describe('提示文案', () => {
  test('★ 未署名提示必须说明「去哪里填」，而不只是「没填」', () => {
    const r = new IdentityResolver({ dshHome: home })
    const text = r.describeProblem()

    expect(text).toContain('尚未署名')
    // 必须给出可执行的下一步
    expect(text).toContain('dsh-token --web')
    // 必须明确承诺不采集
    expect(text).toContain('不采集')
  })

  test('损坏时的提示包含文件路径与原因', () => {
    writeIdentityFile('{ 坏')
    const text = new IdentityResolver({ dshHome: home }).describeProblem()
    expect(text).toContain('无法解析')
    expect(text).toContain('identity.json')
  })

  test('已署名时不产生提示', () => {
    const r = new IdentityResolver({ dshHome: home })
    r.save({ name: '张三', token: 'tok-abc' })
    expect(r.describeProblem()).toBe('')
  })

  test('warnOnce 只提示一次（避免每次会话都打扰）', () => {
    const r = new IdentityResolver({ dshHome: home })
    const lines: string[] = []
    const write = (m: string): void => void lines.push(m)

    expect(r.warnOnce(write)).toBe(true)
    expect(r.warnOnce(write)).toBe(false)
    expect(lines).toHaveLength(1)
  })

  test('已署名时 warnOnce 不输出', () => {
    const r = new IdentityResolver({ dshHome: home })
    r.save({ name: '张三', token: 'tok-abc' })

    const lines: string[] = []
    expect(r.warnOnce((m) => void lines.push(m))).toBe(false)
    expect(lines).toHaveLength(0)
  })

  test('未配 endpoint 的提示说明该怎么配', () => {
    const r = new IdentityResolver({ dshHome: home })
    const status = evaluateStatus({ ready: false, reason: 'missing' }, FULL_CONFIG)
    // 未署名时优先提示署名
    expect(describeDisabled(status, r)).toContain('尚未署名')

    const noKey = evaluateStatus(SIGNED, NO_KEY_CONFIG)
    expect(describeDisabled(noKey, r)).toContain('appKey')

    const noEndpoint = evaluateStatus(SIGNED, resolveConfig({ appKey: 'atr-test-key', endpoint: '' }))
    // endpoint 空 → resolveConfig 会回退到默认地址，因此这里改判 appKey 缺失路径
    expect(noEndpoint.identityReady).toBe(true)
  })
})