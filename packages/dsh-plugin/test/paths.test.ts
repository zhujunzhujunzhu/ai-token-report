/**
 * 插件路径解析测试 —— 「会话日志根」与「数据目录」的分工在插件侧的落点。
 *
 * 这一层是 DSH Desktop 与命令行版 DSH 共存的关键：Desktop 的 `DSH_HOME` 是
 * `%APPDATA%\dsh-desktop\harness`，命令行版是 `~/.dsh`。数据目录的缺省值
 * **刻意不跟随任何一个 home**（`~/.ai-token-report`），所以两套 DSH 天然共用
 * 一份身份与本地库；改 `dshHome` 只会换掉日志来源。这里把这条分工钉死。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { DATA_DIR_NAME } from '@ai-token-report/core'

import { ENV, resolveConfig } from '../src/config.js'
import { reportBackfillDir, reportOutboxDir, reportPaths } from '../src/paths.js'

/** 缺省数据目录：家目录下那个固定目录，与 `DSH_HOME` 无关。 */
const defaultDataDir = join(homedir(), DATA_DIR_NAME)

/**
 * 本机 DSH 进程自己带着这些变量，不清会让断言变成「跑在谁机器上就得改一遍」。
 *
 * ⚠️ 必须**逐项还原**（而不是只还原 `DSH_HOME`）：`DSH_TOKEN_REPORT_DATA_DIR`
 *   是 `bun test` 的 preload（`scripts/test-preload.ts`）用来把数据目录钉在
 *   临时目录里的那道隔离，删掉不还原就等于**给后续测试文件放开了使用者的真实数据**。
 */
const originalEnv = new Map<string, string | undefined>(
  ['DSH_HOME', ...Object.values(ENV)].map((key) => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of originalEnv.keys()) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('reportPaths', () => {
  test('没有配置时会话日志根跟 $DSH_HOME，数据目录落在 ~/.ai-token-report', () => {
    process.env['DSH_HOME'] = '/env/home'
    const paths = reportPaths({})
    expect(paths.dshHome).toBe(resolve('/env/home'))
    expect(paths.sessionsRoot).toBe(join(resolve('/env/home'), 'sessions'))
    expect(paths.dataDir).toBe(defaultDataDir)
  })

  test('★ dataDir 只换状态目录，会话日志根一动不动', () => {
    const paths = reportPaths({ dshHome: '/desktop-home', dataDir: '/shared/token-report' })
    expect(paths.sessionsRoot).toBe(join(resolve('/desktop-home'), 'sessions'))
    expect(paths.identityPath).toBe(join(resolve('/shared/token-report'), 'identity.json'))
    expect(paths.dbPath).toBe(join(resolve('/shared/token-report'), 'usage.sqlite'))
    expect(paths.outboxDir).toBe(join(resolve('/shared/token-report'), 'outbox'))
  })

  test('生效配置可以直接喂进来（不要求调用点手抄两个字段）', () => {
    const config = resolveConfig({ dshHome: '/h', dataDir: '~/shared/tr' })
    expect(reportPaths(config).dataDir).toBe(resolve(join(homedir(), 'shared/tr')))
  })

  test('字符串入参按老语义解释成 dshHome（但数据目录仍是缺省）', () => {
    expect(reportPaths('/h').dshHome).toBe(resolve('/h'))
    expect(reportPaths('/h').dataDir).toBe(defaultDataDir)
  })
})

describe('reportOutboxDir', () => {
  test('缺省与身份文件同级（同一个数据目录）', () => {
    const config = resolveConfig({ dshHome: '/h', dataDir: '/shared/tr' })
    expect(reportOutboxDir(config)).toBe(join(resolve('/shared/tr'), 'outbox'))
  })

  test('显式 outbox.dir 优先，并展开 ~、绝对化', () => {
    const explicit = resolveConfig({ outbox: { dir: '~/my-outbox' } })
    expect(reportOutboxDir(explicit)).toBe(resolve(join(homedir(), 'my-outbox')))
    const relative = resolveConfig({ outbox: { dir: 'relative-outbox' } })
    expect(reportOutboxDir(relative)).toBe(resolve('relative-outbox'))
  })

  test('空白 outbox.dir 视为没配（文档示例里的 ~ 路径必须真的能用）', () => {
    const blank = resolveConfig({ dataDir: '/shared/tr', outbox: { dir: '   ' } })
    expect(reportOutboxDir(blank)).toBe(join(resolve('/shared/tr'), 'outbox'))
  })
})

describe('reportBackfillDir', () => {
  test('水位目录落在数据目录下，且按 scope 分开', () => {
    const config = resolveConfig({ dataDir: '/shared/tr' })
    expect(reportBackfillDir(config, 'abc')).toBe(join(resolve('/shared/tr'), 'backfill', 'abc'))
    expect(reportBackfillDir(config, 'abc')).not.toBe(reportBackfillDir(config, 'def'))
  })

  test('换 dataDir（换一份身份/库）会换水位目录，不会把进度混在一起', () => {
    const a = reportBackfillDir(resolveConfig({ dataDir: '/a/tr' }), 'scope')
    const b = reportBackfillDir(resolveConfig({ dataDir: '/b/tr' }), 'scope')
    expect(a).not.toBe(b)
  })
})

describe('多个 DSH home', () => {
  test('★ 显式 dshHomes 给出多个会话日志根，数据目录仍只有一份', () => {
    const paths = reportPaths({ dshHomes: ['/a/dsh', '/b/dsh'], dataDir: '/shared/tr' })
    expect(paths.dshHomes).toEqual([resolve('/a/dsh'), resolve('/b/dsh')])
    expect(paths.sessionsRoots).toEqual([
      join(resolve('/a/dsh'), 'sessions'),
      join(resolve('/b/dsh'), 'sessions'),
    ])
    // 兼容字段恒等于第一个根
    expect(paths.sessionsRoot).toBe(paths.sessionsRoots[0]!)
    // ★ 四个状态路径**不随根分叉** —— 库只有一份，统计才可能是一份并集
    expect(paths.dbPath).toBe(join(resolve('/shared/tr'), 'usage.sqlite'))
    expect(paths.identityPath).toBe(join(resolve('/shared/tr'), 'identity.json'))
    expect(paths.outboxDir).toBe(join(resolve('/shared/tr'), 'outbox'))
  })

  test('★ 多根与单根指向同一个本地库（多根 ≠ 多库）', () => {
    const single = reportPaths({ dshHomes: ['/a'] })
    const multi = reportPaths({ dshHomes: ['/a', '/b'] })
    expect(single.dbPath).toBe(multi.dbPath)
    expect(single.identityPath).toBe(multi.identityPath)
  })

  test('dshHomes 非空即赢，不再看 dshHome（与非空数组即赢的语义一致）', () => {
    const paths = reportPaths({ dshHome: '/ignored', dshHomes: ['/win'] })
    expect(paths.dshHomes).toEqual([resolve('/win')])
  })

  test('情形不乐观时逐项报出：根不存在时 sessionsRootExists 为 false', () => {
    const missing = join(homedir(), 'no-such-home-for-atr-test')
    expect(reportPaths({ dshHomes: [missing] }).sessionsRootExists).toBe(false)
    expect(reportPaths({ dshHomes: [missing] }).sessionRoots[0]!.exists).toBe(false)
  })

  test('生效配置可以直接喂进来（dshHomes 也在 PathConfig 里）', () => {
    const config = resolveConfig({ dshHomes: ['~/a', '~/b'] })
    expect(reportPaths(config).sessionsRoots).toEqual([
      join(resolve(join(homedir(), 'a')), 'sessions'),
      join(resolve(join(homedir(), 'b')), 'sessions'),
    ])
  })
})