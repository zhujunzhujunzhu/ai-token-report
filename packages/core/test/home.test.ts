/**
 * 路径解析测试 —— 钉死「会话日志根」与「token-report 数据目录」的分工。
 *
 * 这两个概念混在一起时的症状**不会报错**：DSH Desktop 与命令行版 DSH 各自
 * 一套 home，`dshHome` 一旦被当成「数据目录」用，身份文件就读到另一个目录去了，
 * 而页面只会显示「未署名」。所以这里逐项断言两者的归属。
 *
 * ★ 数据目录的缺省值刻意**不跟随 `dshHome`**（`~/.ai-token-report`）：
 *   一旦它跟着 home 走，装上 DSH Desktop 就会得到两份身份与两个库，
 *   而两边都不报错 —— 所以「Desktop 的 home 不影响数据目录」必须是断言，
 *   不能只是一种期望。
 *
 * 另外钉死 `~` 展开：不展开时 `join('~/.dsh', 'x')` 是一个**相对路径**，
 * 文件会被写进「工作目录下那个名叫 `~` 的目录」，而配置看起来完全正常。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import {
  DATA_DIR_NAME,
  DATA_DIR_ENV,
  DISCOVER_ENV,
  DSH_HOMES_ENV,
  DSH_HOME_ENV,
  appDataRoots,
  discoverDshHomesDetailed,
  expandHomePath,
  normalizeHomes,
  resolveDataDir,
  resolveDshHome,
  resolveDshHomes,
  resolvePaths,
  resolveSessionsRoot,
  resolveSessionsRoots,
  splitHomeList,
  type DiscoverOptions,
} from '../src/home.js'

/** 本进程自己就带着这些变量，测完必须逐个还原（新增一个漏还原 = 污染同进程的其它测试）。 */
const ENV_KEYS = [DSH_HOME_ENV, DSH_HOMES_ENV, DATA_DIR_ENV, DISCOVER_ENV] as const
const originals = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))

/** 缺省数据目录：家目录下那个固定目录，与 `DSH_HOME` 无关。 */
const defaultDataDir = join(homedir(), DATA_DIR_NAME)

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  // ★ 单测默认**关掉自动发现**：否则「什么都没配」会去读宿主机真实的家目录，
  //   测试结果就取决于跑测试那台机器上装过哪些 DSH（这个仓库里已经栽过一次同类问题）。
  //   发现逻辑本身由下面注入式（内存文件系统）的用例覆盖。
  process.env[DISCOVER_ENV] = '0'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originals.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('~ 展开', () => {
  test('~ / ~/x / ~\\x 都展开到操作系统 home', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/a/b')).toBe(join(homedir(), 'a/b'))
    expect(expandHomePath('~\\a\\b')).toBe(join(homedir(), 'a\\b'))
  })

  test('~alice 是别人的 home，原样保留（猜错比不猜更危险）', () => {
    expect(expandHomePath('~alice/x')).toBe('~alice/x')
  })

  test('普通路径与相对路径不动（绝对化由 resolveDshHome 负责）', () => {
    expect(expandHomePath('/tmp/x')).toBe('/tmp/x')
    expect(expandHomePath('relative/dir')).toBe('relative/dir')
  })

  test('空白字符串展开后是空字符串，调用方按「没给」处理', () => {
    expect(expandHomePath('   ')).toBe('')
  })
})

describe('DSH home', () => {
  test('显式参数 > 环境变量 > ~/.dsh', () => {
    process.env['DSH_HOME'] = '/env/home'
    expect(resolveDshHome('/explicit/home')).toBe(resolve('/explicit/home'))
    expect(resolveDshHome()).toBe(resolve('/env/home'))
    delete process.env['DSH_HOME']
    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'))
  })

  test('空白的环境变量视为没设（否则 home 会解析成当前工作目录）', () => {
    process.env['DSH_HOME'] = '   '
    expect(resolveDshHome()).toBe(join(homedir(), '.dsh'))
  })

  test('显式参数写成空白同样视为没给，回退环境变量', () => {
    process.env['DSH_HOME'] = '/env/home'
    expect(resolveDshHome('  ')).toBe(resolve('/env/home'))
  })

  test('展开 ~ 并绝对化', () => {
    expect(resolveDshHome('~/.dsh')).toBe(resolve(join(homedir(), '.dsh')))
    expect(resolveDshHome('relative')).toBe(resolve('relative'))
  })

  test('sessionsRoot 只跟 dshHome 走', () => {
    expect(resolveSessionsRoot('/h')).toBe(join('/h', 'sessions'))
  })
})

describe('token-report 数据目录', () => {
  test('★ 缺省是家目录下的 ~/.ai-token-report —— 与 dshHome 无关', () => {
    expect(resolveDataDir({ dshHome: '/h' })).toBe(defaultDataDir)
    expect(resolveDataDir({ dshHome: '/desktop-harness' })).toBe(defaultDataDir)
    expect(resolveDataDir()).toBe(defaultDataDir)
  })

  test('环境变量 DSH_TOKEN_REPORT_DATA_DIR 覆盖缺省', () => {
    process.env['DSH_TOKEN_REPORT_DATA_DIR'] = '/env/tr'
    expect(resolveDataDir()).toBe(resolve('/env/tr'))
    expect(resolveDataDir({ dshHome: '/h' })).toBe(resolve('/env/tr'))
  })

  test('显式 dataDir > 环境变量 > 缺省（优先级只有这一处）', () => {
    process.env['DSH_TOKEN_REPORT_DATA_DIR'] = '/env/tr'
    expect(resolveDataDir({ dataDir: '/explicit/tr' })).toBe(resolve('/explicit/tr'))
  })

  test('空白 dataDir（显式或环境变量）视为没配，回退缺省', () => {
    expect(resolveDataDir({ dshHome: '/h', dataDir: '   ' })).toBe(defaultDataDir)
    process.env['DSH_TOKEN_REPORT_DATA_DIR'] = '   '
    expect(resolveDataDir()).toBe(defaultDataDir)
  })

  test('dataDir 支持 ~ 展开', () => {
    expect(resolveDataDir({ dataDir: '~/shared/tr' })).toBe(resolve(join(homedir(), 'shared/tr')))
  })
})

describe('resolvePaths 把两者分开', () => {
  const dshHome = resolve('/tmp/desktop-home')
  const dataDir = resolve('/tmp/shared-token-report')

  test('会话日志根来自 dshHome，其余状态全部来自 dataDir', () => {
    const paths = resolvePaths({ dshHome, dataDir })
    expect(paths.dshHome).toBe(dshHome)
    expect(paths.dataDir).toBe(dataDir)
    expect(paths.sessionsRoot).toBe(join(dshHome, 'sessions'))
    expect(paths.identityPath).toBe(join(dataDir, 'identity.json'))
    expect(paths.dbPath).toBe(join(dataDir, 'usage.sqlite'))
    expect(paths.statePath).toBe(join(dataDir, 'state.json'))
    expect(paths.outboxDir).toBe(join(dataDir, 'outbox'))
  })

  test('★ 换 dataDir 不会碰 sessionsRoot（「各统计自己的会话却共用身份」的全部依据）', () => {
    const withDefault = resolvePaths({ dshHome })
    const shared = resolvePaths({ dshHome, dataDir })
    expect(shared.sessionsRoot).toBe(withDefault.sessionsRoot)
    expect(shared.identityPath).not.toBe(withDefault.identityPath)
  })

  test('老调用点：传字符串仍然按 dshHome 解释（但数据目录不再跟着它）', () => {
    const paths = resolvePaths(dshHome)
    expect(paths.dshHome).toBe(dshHome)
    expect(paths.dataDir).toBe(defaultDataDir)
    expect(paths.identityPath).toBe(join(defaultDataDir, 'identity.json'))
  })

  test('★ 只设 $DSH_HOME 不会挪动数据目录（Desktop 与 CLI 因此天然共用）', () => {
    process.env['DSH_HOME'] = '/env/home'
    expect(resolvePaths().dshHome).toBe(resolve('/env/home'))
    expect(resolvePaths().dataDir).toBe(defaultDataDir)
    expect(resolvePaths().identityPath).toBe(join(defaultDataDir, 'identity.json'))
  })

  test('~ 形式的配置最终落到绝对路径（不会建出字面的 `~` 目录）', () => {
    const paths = resolvePaths({ dshHome: '~/.dsh', dataDir: '~/shared/token-report' })
    expect(paths.dshHome).toBe(resolve(join(homedir(), '.dsh')))
    expect(paths.outboxDir).toBe(resolve(join(homedir(), 'shared', 'token-report', 'outbox')))
  })
})

/**
 * 多根（同一台机器上并存多套 DSH）。
 *
 * 这一组断言钉死三件事：
 *
 * 1. **数据目录不随 home 数量变化** —— 多根统计共用一份库，库只有一份才可能并集；
 * 2. **顺序确定**（去重 + 字典序）—— `event_id` 跨根重复时库里是「先到者胜」，
 *    顺序随书写方式变化会让同一批数据两次运行给出不同结果；
 * 3. **分隔符按平台**（`path.delimiter`）—— Windows 盘符含冒号，硬编码 `:` 必踩。
 */
describe('多个 DSH home', () => {
  /** 两个不同的绝对路径，避免与宿主机真实 home 撞车。 */
  const homeA = resolve('/tmp/atr-home-a')
  const homeB = resolve('/tmp/atr-home-b')

  test('显式数组 > 显式单值 > 环境变量（数组非空即赢，不与其它来源合并）', () => {
    process.env[DSH_HOMES_ENV] = [homeA, homeB].join(delimiter)
    process.env[DSH_HOME_ENV] = '/env/home'
    expect(resolveDshHomes({ dshHomes: [homeB], dshHome: '/explicit/home' })).toEqual([homeB])
    expect(resolveDshHomes({ dshHome: '/explicit/home' })).toEqual([resolve('/explicit/home')])
    expect(resolveDshHomes()).toEqual([homeA, homeB].sort())
  })

  test(`★ ${DSH_HOMES_ENV} 按 path.delimiter 切分，空白项丢弃`, () => {
    process.env[DSH_HOMES_ENV] = `${homeA}${delimiter}${delimiter}  ${delimiter}${homeB}`
    expect(resolveDshHomes()).toEqual([homeA, homeB].sort())
  })

  test('多值环境变量全是空白 ⇒ 当作没配，回退 $DSH_HOME', () => {
    process.env[DSH_HOMES_ENV] = `  ${delimiter}   `
    process.env[DSH_HOME_ENV] = '/env/home'
    expect(resolveDshHomes()).toEqual([resolve('/env/home')])
  })

  test('全都没配 ⇒ 缺省单个 ~/.dsh', () => {
    expect(resolveDshHomes()).toEqual([join(homedir(), '.dsh')])
    expect(splitHomeList(undefined)).toEqual([])
  })

  test('★ 去重 + 字典序：同一路径的不同写法只算一个根', () => {
    expect(normalizeHomes([homeB, homeA, homeB])).toEqual([homeA, homeB].sort())
    expect(resolveDshHomes({ dshHomes: ['~/.dsh', join(homedir(), '.dsh'), resolve(join(homedir(), '.dsh'))] }))
      .toEqual([resolve(join(homedir(), '.dsh'))])
  })

  test('★ 多个 home 共用同一个数据目录（多根 ≠ 多库）', () => {
    const paths = resolvePaths({ dshHomes: [homeA, homeB] })
    expect(paths.dataDir).toBe(defaultDataDir)
    expect(paths.dbPath).toBe(join(defaultDataDir, 'usage.sqlite'))
    expect(resolvePaths({ dshHomes: [homeA] }).dbPath).toBe(paths.dbPath)
  })

  test('sessionsRoots / sessionRoots 逐根给出，兼容字段等于第一个根', () => {
    const paths = resolvePaths({ dshHomes: [homeA, homeB] })
    expect(paths.dshHomes).toEqual([homeA, homeB].sort())
    expect(paths.sessionsRoots).toEqual(resolveSessionsRoots([homeA, homeB].sort()))
    expect(paths.sessionRoots.map((info) => info.home)).toEqual(paths.dshHomes)
    expect(paths.sessionsRoot).toBe(paths.sessionsRoots[0]!)
    expect(paths.dshHome).toBe(paths.dshHomes[0]!)
  })

  test('★ 只有一个根存在时就应当继续统计（缺失的根逐项报出，而不是整个失败）', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'atr-homes-'))
    try {
      const present = join(scratch, 'present')
      mkdirSync(join(present, 'sessions'), { recursive: true })
      const absent = join(scratch, 'absent')

      const paths = resolvePaths({ dshHomes: [absent, present], dataDir: join(scratch, 'data') })
      expect(paths.sessionsRootExists).toBe(true)
      const byHome = new Map(paths.sessionRoots.map((info) => [info.home, info.exists]))
      // 顺序是字典序：absent 在 present 之前
      expect(byHome.get(resolve(absent))).toBe(false)
      expect(byHome.get(resolve(present))).toBe(true)

      // 全都不存在时才是 false —— 这时调用方才该报错退出
      expect(resolvePaths({ dshHomes: [absent], dataDir: join(scratch, 'data') }).sessionsRootExists).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('老调用点 resolveDshHome 仍然只回答第一个根', () => {
    process.env[DSH_HOMES_ENV] = [homeB, homeA].join(delimiter)
    expect(resolveDshHome()).toBe([homeA, homeB].sort()[0]!)
    expect(resolveDshHome('/explicit')).toBe(resolve('/explicit'))
  })
})

/**
 * 自动发现。
 *
 * ★ 规则必须是**结构驱动**的（「有没有 `sessions` 目录」），而不是「已知路径清单」：
 *   本机实测装了一个第三方 `dsh-desktop`，home 在 `%APPDATA%\dsh-desktop\harness`。
 *   第三方客户端的目录名不可能穷举，硬编码清单必然过时，而过时的表现是
 *   「某个形态的用量静默不统计」—— 这正是本仓最怕的那类故障。
 *
 * 全部用例注入内存文件系统：断言不依赖跑测试那台机器上装了哪些 DSH。
 */
describe('自动发现 DSH home', () => {
  const homeDir = resolve('/tmp/atr-discover/home')
  const roaming = resolve('/tmp/atr-discover/roaming')
  const local = resolve('/tmp/atr-discover/local')

  /** 内存文件系统：只有显式登记过的目录才「存在」。 */
  function fakeFs(
    dirs: Record<string, string[]>,
    existing: string[],
    env: Record<string, string | undefined> = {},
  ): DiscoverOptions {
    const listing = new Map(Object.entries(dirs).map(([key, value]) => [resolve(key), value]))
    const present = new Set(existing.map((item) => resolve(item)))
    return {
      homeDir,
      platform: 'win32',
      env: { APPDATA: roaming, LOCALAPPDATA: local, ...env },
      listDirs: (dir) => listing.get(resolve(dir)) ?? [],
      exists: (path) => present.has(resolve(path)),
    }
  }

  test('家目录 .dsh* 家族：有 sessions 的收下，没有的排除（~/.dsh-vscode 就是这样被排除的）', () => {
    const report = discoverDshHomesDetailed(
      fakeFs(
        { [homeDir]: ['.dsh', '.dsh-vscode', '.dsh-dev', 'documents'], [roaming]: [], [local]: [] },
        [
          join(homeDir, '.dsh', 'sessions'),
          join(homeDir, '.dsh-dev', 'sessions'),
          join(homeDir, '.dsh-vscode', 'server'),
        ],
      ),
    )
    expect(report.homes).toEqual(normalizeHomes([join(homeDir, '.dsh'), join(homeDir, '.dsh-dev')]))
    expect(report.considered).toBeGreaterThan(0)
  })

  test('★ 应用数据目录里的第三方客户端（<userData>/harness/sessions）按结构被发现', () => {
    const report = discoverDshHomesDetailed(
      fakeFs(
        { [homeDir]: ['.dsh'], [roaming]: ['dsh-desktop', 'unrelated-app'], [local]: [] },
        [join(homeDir, '.dsh', 'sessions'), join(roaming, 'dsh-desktop', 'harness', 'sessions')],
      ),
    )
    expect(report.homes).toEqual(
      normalizeHomes([join(homeDir, '.dsh'), join(roaming, 'dsh-desktop', 'harness')]),
    )
  })

  test('客户端把 home 放在 userData 根（<userData>/sessions）同样被发现', () => {
    const report = discoverDshHomesDetailed(
      fakeFs(
        { [homeDir]: ['.dsh'], [roaming]: ['dsh-tui'], [local]: [] },
        [join(homeDir, '.dsh', 'sessions'), join(roaming, 'dsh-tui', 'sessions')],
      ),
    )
    expect(report.homes).toContain(resolve(join(roaming, 'dsh-tui')))
  })

  test('★ 名字不像 DSH 客户端、但结构像的目录只进 suspicious —— 绝不替使用者决定去统计它', () => {
    const report = discoverDshHomesDetailed(
      fakeFs(
        { [homeDir]: ['.dsh'], [roaming]: ['deepseek-desktop'], [local]: [] },
        [join(homeDir, '.dsh', 'sessions'), join(roaming, 'deepseek-desktop', 'harness', 'sessions')],
      ),
    )
    expect(report.homes).toEqual([resolve(join(homeDir, '.dsh'))])
    expect(report.suspicious).toEqual([resolve(join(roaming, 'deepseek-desktop', 'harness'))])
  })

  test('$DSH_HOME 始终是候选之一（它不会被发现结果挤掉）', () => {
    const custom = resolve('/tmp/atr-discover/custom-home')
    const report = discoverDshHomesDetailed(
      fakeFs(
        { [homeDir]: [], [roaming]: [], [local]: [] },
        [join(custom, 'sessions'), join(homeDir, '.dsh', 'sessions')],
        { [DSH_HOME_ENV]: custom },
      ),
    )
    expect(report.homes).toContain(custom)
  })

  test('appDataRoots 按平台给出；Windows 同时含 Roaming 与 Local', () => {
    expect(appDataRoots(homeDir, 'win32', { APPDATA: roaming, LOCALAPPDATA: local })).toEqual([roaming, local])
    expect(appDataRoots(homeDir, 'darwin', {})).toEqual([join(homeDir, 'Library', 'Application Support')])
    expect(appDataRoots(homeDir, 'linux', {})).toEqual([join(homeDir, '.config')])
    expect(appDataRoots(homeDir, 'linux', { XDG_CONFIG_HOME: '/xdg' })).toEqual(['/xdg'])
  })

  test('★ DISCOVER=0 时完全不读家目录，回退单个 $DSH_HOME / ~/.dsh', () => {
    process.env[DSH_HOME_ENV] = '/env/home'
    expect(resolveDshHomes()).toEqual([resolve('/env/home')])
    delete process.env[DSH_HOME_ENV]
    expect(resolveDshHomes()).toEqual([join(homedir(), '.dsh')])
  })
})