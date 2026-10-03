/**
 * **取数范围 = 本机全部已注册来源**（`extra-sources.ts`）。
 *
 * 这一组断言服务的命题只有一条：
 *
 * > 面板与历史补报的范围**不再是一项配置**：本机装了什么客户端就统计什么，
 * > 没有白名单、也没有「默认只统计 DSH」这个隐藏缺省。
 *
 * 为什么值得单独钉住：少统计一个来源**下游信号为零** ——
 * 面板数字看起来完全正常，而它与「那个客户端本来就没用量」长得一模一样。
 * 这条曾经就是 `extraSources` 缺省为空时的真实行为。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registeredSources } from '@ai-token-report/core'

import { resolveStatsSourceRoots, statsSourceIds } from '../src/extra-sources.js'
import { resolveConfig, validateConfig } from '../src/config.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-extra-sources-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 临时改一个环境变量，跑完还原（缺省时删除，别把 `undefined` 写成字符串）。 */
function withEnv(key: string, value: string | undefined, run: () => void): void {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try { run() } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

describe('取数范围：本机装了什么就统计什么', () => {
  test('★ DSH 的根用的是**生效配置里的那一组**（多 home 不被来源解析改掉）', () => {
    const dshHome = join(dir, 'dsh-home')
    mkdirSync(join(dshHome, 'sessions'), { recursive: true })
    const resolved = resolveStatsSourceRoots([dshHome])
    expect(resolved.roots.filter((root) => root.source === 'dsh').map((root) => root.path))
      .toEqual([join(dshHome, 'sessions')])
  })

  test('★ 本机装了的其它客户端**不需要任何配置**就会被解析出来', () => {
    const traeHome = join(dir, 'trae-home')
    mkdirSync(join(traeHome, 'logs'), { recursive: true })
    // ⚠️ 测试 preload 把所有非 DSH 来源都关了（`DSH_TOKEN_REPORT_*=0`，见 `scripts/test-preload.ts`），
    //    所以这里先把 trae 打开 —— 这正好也是「环境开关真的能开关一个来源」的验证。
    withEnv('DSH_TOKEN_REPORT_TRAE', undefined, () => {
      withEnv('DSH_TOKEN_REPORT_TRAE_HOMES', traeHome, () => {
        const resolved = resolveStatsSourceRoots([])
        expect(resolved.roots.some((root) => root.source === 'trae' && root.path === join(traeHome, 'logs'))).toBe(true)
        // `sources` 必须与「真的有根」的来源一一对应：没有根就不该出现在清单里。
        expect([...new Set(resolved.roots.map((root) => root.source))].sort()).toEqual([...resolved.sources].sort())
      })
    })
  })

  test('查询期来源清单 = 全部已注册来源，且 `dsh` 排第一', () => {
    const ids = statsSourceIds()
    expect(ids[0]).toBe('dsh')
    expect(new Set(ids)).toEqual(new Set(registeredSources().map((adapter) => adapter.id)))
    expect(ids).toContain('codex')
    expect(ids).toContain('workbuddy')
  })

  test('★ 来源自己的环境开关仍然能关掉它 —— 这是唯一还剩的收窄手段', () => {
    const traeHome = join(dir, 'trae-home')
    mkdirSync(join(traeHome, 'logs'), { recursive: true })
    withEnv('DSH_TOKEN_REPORT_TRAE_HOMES', traeHome, () => {
      // 打开：出现。关掉：消失。**两个方向都要断言**，否则「开关没接上」会伪装成通过。
      withEnv('DSH_TOKEN_REPORT_TRAE', undefined, () => {
        expect(resolveStatsSourceRoots([]).roots.some((root) => root.source === 'trae')).toBe(true)
      })
      withEnv('DSH_TOKEN_REPORT_TRAE', '0', () => {
        expect(resolveStatsSourceRoots([]).roots.some((root) => root.source === 'trae')).toBe(false)
      })
    })
  })
})

describe('extraSources 已废弃：写了必须报出来，绝不静默忽略', () => {
  test('`validateConfig` 把它列进启动告警（并指向环境开关）', () => {
    const problems = validateConfig(resolveConfig({}), { extraSources: ['trae'] })
    const hit = problems.find((line) => line.includes('extraSources'))
    expect(hit).toBeDefined()
    expect(hit).toContain('全部已注册来源')
  })

  test('没有写它的人不会看到这条告警', () => {
    expect(validateConfig(resolveConfig({})).some((line) => line.includes('extraSources'))).toBe(false)
  })

  test('★ 生效配置里不再有这个字段（写了也进不去 —— 范围不是配置项）', () => {
    expect('extraSources' in resolveConfig({ extraSources: ['trae'] })).toBe(false)
  })
})
