/**
 * **面板的「其它来源」白名单**（`extraSources`）。
 *
 * 这一组断言服务的命题只有一条：
 *
 * > **默认关**（不配 = 面板只统计 DSH，与改动前逐字一致），而配了之后
 * > 白名单里**真的**那几处会被交给 `openStats`；拼错的 id 一律**当场报错/告警**。
 *
 * 为什么这条值得单独钉住：白名单拼错的**下游信号为零** ——
 * 面板数字不变，而它与「那个客户端本来就没用量」长得一模一样。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ALL_SOURCES, planExtraSources, resolveStatsSourceRoots, statsSourceIds } from '../src/extra-sources.js'
import { parseExtraSources } from '../src/settings.js'
import type { EffectiveConfig } from '../src/config.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-extra-sources-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 造一份「只有 extraSources 有用」的生效配置。 */
function config(extraSources?: string[]): EffectiveConfig {
  return {
    name: 'ai-token-report',
    appKey: '',
    endpoint: 'http://127.0.0.1:8787/api/v1/token-usage',
    batch: { maxRecords: 50, flushIntervalMillis: 10_000, timeoutMillis: 15_000 },
    outbox: { enabled: true, maxBytes: 1 },
    features: { reporting: true, tools: true, service: true, ui: true },
    localDb: true,
    ui: { position: 'dock' },
    ...(extraSources !== undefined ? { extraSources } : {}),
  }
}

describe('白名单解析：默认关', () => {
  test('不配 / 空数组 ⇒ 一个来源都不并（面板只统计 DSH，与改动前一致）', () => {
    expect(planExtraSources(config()).sources).toEqual([])
    expect(planExtraSources(config([])).sources).toEqual([])
    expect(resolveStatsSourceRoots(config(), [])).toBeUndefined()
  })

  test('`dsh` 写不写都一样（面板主体永远是 DSH），且重复项只留一个', () => {
    expect(planExtraSources(config(['dsh', 'trae', 'trae', 'dsh'])).sources).toEqual(['trae'])
  })

  test('`all` = 全部已注册来源（不含 dsh）', () => {
    const plan = planExtraSources(config([ALL_SOURCES]))
    expect(plan.sources).toContain('trae')
    expect(plan.sources).toContain('trae-cn')
    expect(plan.sources).toContain('workbuddy')
    expect(plan.sources).not.toContain('dsh')
  })

  test('🚨 拼错的 id 进 unknown（绝不静默丢弃 —— 那与「没用量」无法分辨）', () => {
    const plan = planExtraSources(config(['trae', 'trae-cn', 'trea']))
    expect(plan.sources).toEqual(['trae', 'trae-cn'])
    expect(plan.unknown).toEqual(['trea'])
  })

  test('★ 查询期来源清单：缺省 = **只有 dsh**（白名单为空也不例外）', () => {
    // 🚨 这一条与 `sourceRoots` 那条是**两件事**：根决定「本次 ingest 谁」，
    //   清单决定「本次只算谁」。本地库是几个形态共用的一个文件，库里天然有
    //   别的来源的行（CLI 跑过一次缺省运行就会有）—— 清单缺省要是「全部来源」，
    //   面板就会把 Codex 的行当 DSH 显示，数字看起来完全正常。
    expect(statsSourceIds(config())).toEqual(['dsh'])
    expect(statsSourceIds(config([]))).toEqual(['dsh'])
    expect(statsSourceIds(config(['trae']))).toEqual(['dsh', 'trae'])
    expect(statsSourceIds(config(['trae', 'trae-cn']))).toEqual(['dsh', 'trae', 'trae-cn'])
    expect(statsSourceIds(config([ALL_SOURCES]))).toContain('codex')
  })

  test('`all` 与逐个列出可以混写（并起来仍是全部）', () => {
    const plan = planExtraSources(config([ALL_SOURCES, 'trae']))
    expect(new Set(plan.sources).size).toBe(plan.sources.length)
    expect(plan.sources).toContain('trae')
    expect(plan.unknown).toEqual([])
  })
})

describe('带来源的根：白名单非空时才交给 openStats', () => {
  test('★ 白名单非空 ⇒ 根里既有 DSH 也有那个来源，且 DSH 用的是**生效配置里的那一组**', () => {
    // Trae 的根由它自己的环境变量给出（指向临时目录），不依赖本机装没装 Trae
    const traeHome = join(dir, 'trae-home')
    mkdirSync(join(traeHome, 'logs'), { recursive: true })
    const dshHome = join(dir, 'dsh-home')
    mkdirSync(join(dshHome, 'sessions'), { recursive: true })
    const saved = process.env['DSH_TOKEN_REPORT_TRAE_HOMES']
    process.env['DSH_TOKEN_REPORT_TRAE_HOMES'] = traeHome
    try {
      const resolved = resolveStatsSourceRoots(config(['trae']), [dshHome])
      expect(resolved).toBeDefined()
      const bySource = new Map(resolved!.roots.map((root) => [root.source, root.path]))
      expect(bySource.get('dsh')).toBe(join(dshHome, 'sessions'))
      expect(bySource.get('trae')).toBe(join(traeHome, 'logs'))
      // 白名单之外的来源一个都不许进来（否则「默认关」就白做了）
      expect([...bySource.keys()].sort()).toEqual(['dsh', 'trae'])
    } finally {
      if (saved === undefined) delete process.env['DSH_TOKEN_REPORT_TRAE_HOMES']
      else process.env['DSH_TOKEN_REPORT_TRAE_HOMES'] = saved
    }
  })
})

describe('面板提交的白名单：拼错必须当场报错', () => {
  test('合法值收下（小写归一、去重、去掉 dsh）', () => {
    expect(parseExtraSources([' Trae ', 'trae-cn', 'dsh', 'trae'])).toEqual({ ok: true, value: ['trae', 'trae-cn'] })
    expect(parseExtraSources([])).toEqual({ ok: true, value: [] })
  })

  test('🚨 不认识的来源名回 ok:false + 原因（可用值一并给出）', () => {
    const parsed = parseExtraSources(['trea'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.reason).toContain('trea')
      expect(parsed.reason).toContain('trae')
    }
  })

  test('`all` 合法；非字符串 / 非数组明确报错', () => {
    expect(parseExtraSources(['all'])).toEqual({ ok: true, value: ['all'] })
    expect(parseExtraSources(['trae', 1]).ok).toBe(false)
    expect(parseExtraSources('trae').ok).toBe(false)
  })
})
