/**
 * DSH home（**可以有一组**）、会话日志目录与 token-report 数据目录的定位。
 *
 * 优先级：显式参数 > 环境变量（`DSH_TOKEN_REPORT_DSH_HOMES` / `DSH_HOME` /
 * `DSH_TOKEN_REPORT_DATA_DIR`）> 缺省（`~/.dsh` / `~/.ai-token-report`）。
 *
 * S1 阶段从 `dsh-token-stats/src/home.ts` 原样迁入；`dataDir` 与 `~` 展开见下。
 *
 * ## 🚨 「会话日志根」与「token-report 数据目录」是两个概念（别合并）
 *
 * DSH Desktop 的 home 是 `%APPDATA%\dsh-desktop\harness`，而命令行版 DSH 是
 * `~/.dsh`。同一个人、同一台机器上跑着两套 DSH 时，下面这两件事的**正确答案不同**：
 *
 * | 概念 | 默认 | 换掉它意味着 |
 * |---|---|---|
 * | `dshHomes` | `$DSH_TOKEN_REPORT_DSH_HOMES` 或 `$DSH_HOME` 或 `~/.dsh` | **会话日志从哪读** —— 界面统计与历史补报的唯一来源 |
 * | `dataDir` | `~/.ai-token-report` | 身份 / 连接偏好 / 本地库 / outbox / 补报水位放哪 |
 *
 * ⚠️ 只想「两套 DSH 共用一份身份和本地库」时，**什么配置都不用改**（数据目录
 *   本来就不跟随 home）；只想让统计**看见更多 home** 时，**只加 home**。
 *
 * ## 🚨 为什么 home 是一组而不是一个（多根统计）
 *
 * 同一台机器上并存多套 DSH 是常态（命令行版 + Desktop + 各自的 profile）。
 * 实测一台机器上 `~/.dsh` 有 244 个会话、Desktop 的 harness 有 234 个，其中
 * **224 个是同一批会话的镜像**（同名 sessionId，计费事件逐条一致），各自独有
 * 20 / 10 个。只读一个 home 时，统计与直扫都会**静默少掉另一个 home 的会话**。
 *
 * 因此：
 *
 * - **默认就是自动发现**：候选 = `$DSH_HOME` + `~/.dsh` + 家目录下所有 `.dsh*`
 *   + 各平台应用数据目录下名字以 `dsh` 开头的客户端（含第三方桌面客户端，
 *   实测 `%APPDATA%\dsh-desktop\harness`），**筛掉那些没有 `sessions` 目录的**
 *   （例如实测 `~/.dsh-vscode` 只有一个 `server`）。规则是**结构驱动**的，
 *   不依赖「已知路径清单」——第三方客户端换个目录名也照样被发现。
 *   零配置就把本机所有 DSH 形态统计进来；想关掉用 `DSH_TOKEN_REPORT_DISCOVER=0`。
 * - `DSH_TOKEN_REPORT_DSH_HOMES`（本项目扩展，DSH 本体不读它）用
 *   **`path.delimiter`** 分隔多个 home（Windows `;` / POSIX `:`），**完全接管**
 *   发现结果。
 *   ⚠️ 不能硬编码 `:` —— Windows 盘符本身就含冒号；也不能用逗号 —— 它在合法路径里出现。
 * - 多个根按 `resolve()` 后**去重**并按字典序**排序**。排序不是洁癖：
 *   `event_id = sessionId:seq` 在库里是主键，跨根重复时是「先到者胜」，
 *   根序不稳定会让同一批数据在两次运行中给出不同结果。
 * - `dataDir` **仍然只有一份**：多根只是「日志从哪读」变多，token-report 自己的
 *   状态（身份 / 本地库 / outbox / 水位）依旧集中在一个目录 —— 库只有一份，
 *   统计才可能是一份并集。把 `dataDir` 也按 home 拆开 = 事后无法合并的几份库。
 *
 * ## 为什么数据目录**不在**任何一个 DSH home 下
 *
 * 它曾经是 `<dshHome>/token-report`。那个默认值在单形态（只有命令行版）时没问题，
 * 一旦装上 DSH Desktop 就必然出错：Desktop 的 home 是另一个目录，于是同一个人的
 * 身份、连接、本地库、outbox 各存一份 —— 表现为「在命令行了署名，Desktop 面板
 * 还是未署名」「两台机器各看一半用量」，而且**四处都不报错**。
 *
 * 现在默认固定在家目录下（`~/.ai-token-report`），与 home 列表**无关**：
 * 两套 DSH 只要跑在同一个用户下就自动共用一份数据，各统计各自的会话
 * （会话日志根仍然来自各自的 `dshHome`）。想刻意分开，显式给 `dataDir`
 * 或 `DSH_TOKEN_REPORT_DATA_DIR`。
 *
 * ⚠️ 目录名带前导点（`.ai-token-report`）：家目录下不该多出一个显眼的业务目录。
 *   旧路径 `<dshHome>/token-report` 不会自动迁移 —— 一次性搬家脚本见
 *   `scripts/migrate-data-dir.ts`（数据目录是长期状态，移动必须是显式的）。
 *
 * ## `~` 展开（与 DSH 官方 `@deepseek-ai/dsh-home-paths` 同规则）
 *
 * 配置里写 `~/.dsh` 是运维的肌肉记忆，而 `node:path` 的 `join()` **不会**展开它 ——
 * 展开前 `join('~/.dsh', 'ai-token-report')` 会得到一个**相对路径**，
 * 于是文件被写进「当前工作目录下那个名叫 `~` 的目录」，而配置本身看起来完全正常。
 * 这里统一展开 `~` / `~/` / `~\` 并 `resolve()` 成绝对路径。
 * 刻意**不**处理 `~alice`（那是别的用户，猜错比不猜更危险）与环境变量。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/** 数据目录名（默认落在家目录下：`~/.ai-token-report`）。 */
export const DATA_DIR_NAME = '.ai-token-report'

/**
 * 多个 DSH home 的环境变量名。
 *
 * ★ 这是**本项目**的扩展，DSH 本体不读它（它只认 `DSH_HOME`）。
 *   命名刻意待在 `DSH_TOKEN_REPORT_` 家族里，避免与官方变量混淆。
 */
export const DSH_HOMES_ENV = 'DSH_TOKEN_REPORT_DSH_HOMES'

/** 单个 DSH home 的环境变量名（DSH 官方变量，单值）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** token-report 数据目录的环境变量名。 */
export const DATA_DIR_ENV = 'DSH_TOKEN_REPORT_DATA_DIR'

/** 缺省 DSH home（家目录下的 `.dsh`）。 */
export function defaultDshHome(): string {
  return join(homedir(), '.dsh')
}

/**
 * 展开路径开头的 `~`。
 *
 * 只认「当前用户」三种写法：`~`、`~/...`、`~\...`；`~alice/...` 原样返回。
 */
export function expandHomePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * 归一化一个「显式给的目录」：空白视为没给，`~` 展开，最后绝对化。
 *
 * 空白必须当成**没给**而不是「当前目录」：一份 `dshHome: ""` 的 YAML
 * （例如模板变量没填上）若被解析成 cwd，数据库会落在仓库里，
 * 而用户看到的是「它把我的数据放到项目目录了」。
 */
function explicitDir(input?: string): string | undefined {
  if (input === undefined) return undefined
  const trimmed = input.trim()
  return trimmed === '' ? undefined : resolve(expandHomePath(trimmed))
}

/**
 * 按 `path.delimiter` 切分多值环境变量，并丢掉空白项。
 *
 * 用 `path.delimiter` 而不是写死某个字符：Windows 是 `;`、POSIX 是 `:`，
 * 而 Windows 的盘符本身就含冒号（`C:\...`），硬编码必然把 `C:\Users\...`
 * 切成 `C` 与 `\Users\...` 两个都不存在的根。
 */
export function splitHomeList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Windows 路径大小写不敏感；去重键要按平台归一，否则 `C:\x` 与 `c:\x` 会各算一个根。 */
function dedupeKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath
}

/**
 * 去重 + 固定顺序。
 *
 * ★ 顺序必须**确定**：跨根出现同一条 `event_id` 时库里是「先到者胜」，
 *   根序随环境变量书写顺序变化，会让同一批数据在两次运行中给出不同结果。
 */
export function normalizeHomes(homes: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const home of homes) {
    const abs = resolve(home)
    const key = dedupeKey(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out.sort()
}

/**
 * 自动发现多根的开关。
 *
 * `0` / `false` / `no` / `off` 关闭发现（回退到「单个 `$DSH_HOME` 或 `~/.dsh`」）。
 *
 * 🚨 **为什么必须有这个开关**：仓库里有大量验证脚本靠「把 `DSH_HOME` 指到临时目录」
 *   来隔离。默认自动发现一旦生效，这些脚本会连带扫到使用者**真实的** `~/.dsh`
 *   与 Desktop harness —— 表现为隔离失效、脚本变慢或断言漂移，而且**不会报错**。
 *   所以：测试与验证脚本必须显式固定根（本开关或 `DSH_TOKEN_REPORT_DSH_HOMES`），
 *   这条约束与「spawn 子进程必须自己传 dataDir」同级。
 */
export const DISCOVER_ENV = 'DSH_TOKEN_REPORT_DISCOVER'

/** 发现开关是否打开（缺省打开）。 */
export function discoverEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[DISCOVER_ENV]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return true
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * 「应用数据根目录」——Electron / 桌面客户端把各自的 userData 放在这些目录下。
 *
 * 🚨 **这里刻意不写死任何客户端名字**。实测本机有一个第三方 `dsh-desktop`，
 *   它的 home 是 `%APPDATA%\dsh-desktop\harness`；但第三方客户端的目录名
 *   不可能穷举（换个客户端就叫别的名字），硬编码一份清单必然过时，
 *   而且过时的表现是「某个形态的用量静默不统计」。
 *
 *   所以这里只回答「该去哪些目录下找」，具体某个目录**是不是**一个 home
 *   由 {@link discoverDshHomesDetailed} 按**结构**判断（有没有 `sessions`）。
 *
 * Windows 同时给出 Roaming 与 Local：Electron 的 userData 默认在 Roaming
 * （实测 dsh-desktop 就在那儿），但把数据放 Local 的应用也不少，多扫一个目录
 * 只是一次 `readdir` 的代价。
 */
export function appDataRoots(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === 'win32') {
    const roaming = env['APPDATA']?.trim() || join(homeDir, 'AppData', 'Roaming')
    const local = env['LOCALAPPDATA']?.trim() || join(homeDir, 'AppData', 'Local')
    return [roaming, local]
  }
  if (platform === 'darwin') {
    return [join(homeDir, 'Library', 'Application Support')]
  }
  const xdg = env['XDG_CONFIG_HOME']?.trim() || join(homeDir, '.config')
  return [xdg]
}

/** 发现函数的可注入依赖 —— 让「发现」成为可断言的纯逻辑，而不是读真实文件系统的黑盒。 */
export interface DiscoverOptions {
  /** 家目录。缺省 `os.homedir()`。 */
  homeDir?: string
  /** 运行平台。缺省 `process.platform`。 */
  platform?: NodeJS.Platform
  /** 环境变量表。缺省 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 目录是否存在。缺省 `existsSync`。 */
  exists?: (path: string) => boolean
  /** 列某个目录下的**子目录**名。缺省读真实文件系统。 */
  listDirs?: (dir: string) => string[]
}

/** 列出目录下的子目录名（失败即当作没有 —— 权限问题不该让统计整个起不来）。 */
function readSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 自动发现的结果。 */
export interface DiscoverReport {
  /** 自动采用的 home —— 每一个都确实存在 `sessions` 目录。 */
  homes: string[]
  /**
   * 「名字不像 DSH 客户端、但结构形如 `<dir>/harness/sessions`」的目录。
   *
   * ★ **只提示，绝不自动采用**：`harness/sessions` 这个结构足以让人判断它是个
   *   客户端的数据目录，但不足以让工具**替使用者**决定去统计它 ——
   *   名字不匹配就自动收进来，等于把「猜错」的代价变成看板上一个没人说得清的多余来源。
   *   使用者确认后写进 `DSH_TOKEN_REPORT_DSH_HOMES` 即可。
   */
  suspicious: string[]
  /** 考察过的候选目录数（诊断用：想解释「为什么只发现了 2 个根」时需要它）。 */
  considered: number
}

/**
 * 自动发现本机上「值得统计」的 DSH home。
 *
 * ## 规则是**结构驱动**的，不是「已知路径清单」
 *
 * 候选分两层：
 *
 * 1. `$DSH_HOME`（若有）+ `~/.dsh` + 家目录下所有 `.dsh*` —— 这些目录**本身就是 home**
 *    （即 `<home>/sessions` 就是日志根）。
 * 2. 各平台「应用数据根目录」（见 {@link appDataRoots}）下、**名字以 `dsh` 开头**
 *    的目录，按两种已知结构各收一个候选：
 *    - `<userData>` 本身（有些客户端把 home 直接放在 userData 根）
 *    - `<userData>/harness`（实测第三方 `dsh-desktop` 就是这个形态：
 *      `%APPDATA%\dsh-desktop\harness\sessions`）
 *
 * ★ **筛选规则只有一条**：`<候选>/sessions` 目录**存在**才算一个根。
 *   - 实测 `~/.dsh-vscode` 下只有一个 `server` 目录、没有 `sessions` ⇒ 被正确排除，
 *     而不是变成一个「永远空着」的来源；
 *   - 同一条规则也让「硬编码清单」变得不必要：换个客户端、换个目录名，
 *     只要它按 DSH 的结构写日志，就会被发现。
 *   「存在这个目录」≠「它是统计来源」，这条区分就落在这里。
 *
 * 名字不匹配、但结构是 `<dir>/harness/sessions` 的目录进 `suspicious`，**只提示不采用**。
 *
 * 返回的 `homes` 已去重、已排序（见 {@link normalizeHomes}）；**可能为空**
 * （家目录下确实没有任何跑过会话的 DSH），由调用方决定回退策略。
 */
export function discoverDshHomesDetailed(options: DiscoverOptions = {}): DiscoverReport {
  const homeDir = options.homeDir ?? homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const listDirs = options.listDirs ?? readSubdirs

  const candidates: string[] = []
  const suspicious: string[] = []
  let considered = 0

  const envHome = explicitDir(env[DSH_HOME_ENV])
  if (envHome !== undefined) {
    candidates.push(envHome)
    considered++
  }
  candidates.push(join(homeDir, '.dsh'))
  considered++
  for (const name of listDirs(homeDir)) {
    // `.dsh` 已经加过；其余按 `.dsh*` 家族收（`.dsh-vscode` / `.dsh-dev` / ...）
    if (name === '.dsh' || !name.startsWith('.dsh')) continue
    candidates.push(join(homeDir, name))
    considered++
  }

  for (const base of appDataRoots(homeDir, platform, env)) {
    for (const name of listDirs(base)) {
      const dir = join(base, name)
      considered++
      if (/^dsh/i.test(name)) {
        candidates.push(dir)
        candidates.push(join(dir, 'harness'))
      } else if (exists(join(dir, 'harness', 'sessions'))) {
        suspicious.push(join(dir, 'harness'))
      }
    }
  }

  const homes = normalizeHomes(candidates).filter((home) => exists(resolveSessionsRoot(home)))
  const chosen = new Set(homes.map(dedupeKey))
  return {
    homes,
    suspicious: normalizeHomes(suspicious).filter((home) => !chosen.has(dedupeKey(home))),
    considered,
  }
}

/** 只取 home 列表（多数调用方用这个）。 */
export function discoverDshHomes(options: DiscoverOptions = {}): string[] {
  return discoverDshHomesDetailed(options).homes
}

/**
 * 解析生效的 DSH home **列表**。
 *
 * 优先级（高 → 低）：
 *
 * 1. 显式 `dshHomes` 数组（非空即赢，**不再与环境变量或发现结果合并** ——
 *    合并会让「我明明只配了这两个」变成谜题）
 * 2. 显式 `dshHome` 单值
 * 3. `DSH_TOKEN_REPORT_DSH_HOMES`（多值）
 * 4. 发现被关掉（`DSH_TOKEN_REPORT_DISCOVER=0`）⇒ `$DSH_HOME` > `~/.dsh`
 * 5. **自动发现**（`$DSH_HOME` + `~/.dsh` + `~/.dsh*` + 应用数据目录下结构像
 *    DSH home 的目录，见 {@link discoverDshHomesDetailed}）—— 零配置就把本机
 *    所有 DSH 形态统计进来（含第三方桌面客户端）
 * 6. 发现结果为空 ⇒ `$DSH_HOME` > `~/.dsh`（保证调用方仍能报出「找不到会话目录」，
 *    而不是拿到一个空数组后静默统计出 0）
 */
export function resolveDshHomes(input?: string | PathOptions): string[] {
  const options = optionsOf(input)

  const explicitList = (options.dshHomes ?? [])
    .map((item) => explicitDir(item))
    .filter((item): item is string => item !== undefined)
  if (explicitList.length > 0) return normalizeHomes(explicitList)

  const explicitOne = explicitDir(options.dshHome)
  if (explicitOne !== undefined) return [explicitOne]

  const envList = splitHomeList(process.env[DSH_HOMES_ENV])
    .map((item) => explicitDir(item))
    .filter((item): item is string => item !== undefined)
  if (envList.length > 0) return normalizeHomes(envList)

  const envOne = explicitDir(process.env[DSH_HOME_ENV])
  const fallback = envOne !== undefined ? [envOne] : [defaultDshHome()]

  if (!discoverEnabled()) return fallback

  const discovered = discoverDshHomes()
  return discovered.length > 0 ? discovered : fallback
}

/**
 * 单个 DSH home —— **兼容旧调用点**，取生效列表的第一个。
 *
 * ⚠️ 配了多个根时它只回答「第一个是谁」，拿它去扫日志就会漏掉其余根。
 *   新代码一律用 {@link resolveDshHomes}。
 */
export function resolveDshHome(explicit?: string): string {
  return resolveDshHomes(explicit === undefined ? {} : { dshHome: explicit })[0]!
}

export function resolveSessionsRoot(dshHome: string): string {
  return join(dshHome, 'sessions')
}

/** 一组会话日志根。 */
export function resolveSessionsRoots(dshHomes: readonly string[]): string[] {
  return dshHomes.map((home) => resolveSessionsRoot(home))
}

/**
 * 路径解析的输入。
 *
 * 与 `ResolvedPaths` 分开是为了让 `dsh-plugin` 能直接把生效配置传进来
 * （`EffectiveConfig` 结构上满足它），而不必在调用点手抄两个字段 ——
 * 手抄就是「同一个配置、两个不同身份文件」那类 bug 的来源。
 */
export interface PathOptions {
  /** DSH home（会话日志根）**单值**写法。缺省见 {@link resolveDshHomes}。 */
  dshHome?: string
  /** ★ DSH home **列表**。非空时完全覆盖 `dshHome` 与环境变量。 */
  dshHomes?: readonly string[]
  /** token-report 数据目录。缺省 `DSH_TOKEN_REPORT_DATA_DIR` 或 `~/.ai-token-report`（**与 home 列表无关**）。 */
  dataDir?: string
}

/** 兼容旧调用点：字符串 = `dshHome`。 */
function optionsOf(input?: string | PathOptions): PathOptions {
  if (input === undefined) return {}
  return typeof input === 'string' ? { dshHome: input } : input
}

/**
 * token-report 自己的数据目录。
 *
 * 缺省 `~/.ai-token-report`（可经 `DSH_TOKEN_REPORT_DATA_DIR` 覆盖）—— **刻意不跟随
 * 任何 home**：同一台机器上的两套 DSH
 * （Desktop 的 harness home 与命令行的 `~/.dsh`）必须共用同一份身份与本地库，
 * 理由见文件头。想要「各存各的」就显式给 `dataDir`。
 */
export function resolveDataDir(input?: string | PathOptions): string {
  const options = optionsOf(input)
  return (
    explicitDir(options.dataDir) ??
    explicitDir(process.env[DATA_DIR_ENV]) ??
    join(homedir(), DATA_DIR_NAME)
  )
}

/** 单个会话日志根的可用性（供 CLI / 页面 / 插件显示「这次统计读了哪几处」）。 */
export interface SessionRootInfo {
  /** 该根所属的 DSH home。 */
  home: string
  /** 会话日志根（`<home>/sessions`）。 */
  root: string
  /** 目录是否存在。**不存在不抛错，但必须能被报出来** —— 否则「我加了一个 home 数字没变」无法排查。 */
  exists: boolean
}

/** 逐个根检查存在性。缺失的根不会被静默吞掉，交给调用方展示。 */
export function sessionRootInfos(dshHomes: readonly string[]): SessionRootInfo[] {
  return dshHomes.map((home) => {
    const root = resolveSessionsRoot(home)
    return { home, root, exists: existsSync(root) }
  })
}

export interface ResolvedPaths {
  /** 生效列表里的**第一个** home（兼容字段；多根请用 `dshHomes`）。 */
  dshHome: string
  /** ★ 生效的全部 DSH home（已去重、已排序）。 */
  dshHomes: string[]
  /**
   * token-report 自己所有长期状态的目录。
   *
   * 缺省 `~/.ai-token-report`，可被显式 `dataDir` 换成别的目录
   * （见文件头「为什么数据目录不在任何一个 DSH home 下」）。
   * ⚠️ 它**不随 home 数量变化**：多根统计共用一份库。
   */
  dataDir: string
  /** 第一个根的会话日志根（兼容字段；多根请用 `sessionsRoots`）。 */
  sessionsRoot: string
  /** ★ 全部会话日志根（`<home>/sessions`），**与 `dataDir` 无关**。 */
  sessionsRoots: string[]
  /** 逐根的存在性，顺序与 `dshHomes` / `sessionsRoots` 一致。 */
  sessionRoots: SessionRootInfo[]
  /** 本地身份文件路径（`<dataDir>/identity.json`）。 */
  identityPath: string
  /** 本地 SQLite 增量库路径（`<dataDir>/usage.sqlite`）。 */
  dbPath: string
  /** 上报水位线状态文件（`<dataDir>/state.json`）。 */
  statePath: string
  /**
   * 插件磁盘 outbox 目录（`<dataDir>/outbox`）。
   *
   * CLI 的上报靠 `state.json` 里的 `pending` 保命，而 DSH 插件的上报走
   * **一批一个文件**的 outbox（见 `dsh-plugin/src/outbox.ts`）。
   * 两者刻意不共用目录：同名文件混在一起时，任何一方清理都会误删另一方。
   */
  outboxDir: string
  /**
   * **是否至少有一个根存在**。
   *
   * ⚠️ 语义与单根时代不同（那时等价于「唯一那个根存在」）：多根下只要有
   *   一个根可读就应当继续统计，缺失的根由 `sessionRoots` 逐项报出，
   *   不能因为用户多写了一个暂时不存在的 home 就整个命令失败。
   */
  sessionsRootExists: boolean
}

export function resolvePaths(home?: string | PathOptions): ResolvedPaths {
  const options = optionsOf(home)
  const dshHomes = resolveDshHomes(options)
  // ★ 走 resolveDataDir() 而不是在这里再写一遍缺省表达式：数据目录的缺省值
  //   必须只有一处实现，否则「档位文件」与「库文件」会分居两个目录且都不报错。
  const dataDir = resolveDataDir(options)
  const sessionsRoots = resolveSessionsRoots(dshHomes)
  const sessionRoots = sessionRootInfos(dshHomes)
  return {
    dshHome: dshHomes[0]!,
    dshHomes,
    dataDir,
    sessionsRoot: sessionsRoots[0]!,
    sessionsRoots,
    sessionRoots,
    identityPath: join(dataDir, 'identity.json'),
    // 与 state.json / identity.json 同目录：都是「本机 token-report 的长期状态」，
    // 用户清空 home 时应当一起被清掉，分散到别处会留下孤儿文件。
    //
    // ⚠️ 文件名**内联**而不 import `db/schema.ts` 的 `dbFileName()`：
    //   那个模块 import 了 `bun:sqlite`，而 home.ts 会被 web / 插件侧
    //   间接引用。为一行字符串在路径解析模块里拖进整个数据库依赖，
    //   是让「只想要 sessionsRoot」的调用方也背上 sqlite 的代价。
    dbPath: join(dataDir, 'usage.sqlite'),
    statePath: join(dataDir, 'state.json'),
    outboxDir: join(dataDir, 'outbox'),
    sessionsRootExists: sessionRoots.some((info) => info.exists),
  }
}