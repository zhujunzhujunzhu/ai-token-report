/**
 * 插件配置页的宿主入口 —— 设置面有**五个字段**：
 * 服务端地址、appKey、上报间隔、面板位置、**会话日志根**。
 *
 * ## 为什么是这几项
 *
 * 员工手上真正拿到的东西只有两样：部门平台的地址，和管理员发的一串 appKey。
 * 其余全部是派生的：
 *
 * | 面板字段 | 从哪来 |
 * |---|---|
 * | 姓名 / 分组 | ★ **服务端校验结果**，不是用户填的（见下） |
 * | `/api/v1/identity/verify` | `baseUrl` + 固定路径 |
 * | `/api/v1/token-usage` | `baseUrl` + 固定路径 |
 * | 上报间隔 / 面板位置 / 会话日志根 | 纯本机偏好，只写本地文件 |
 *
 * ## 会话日志根（`dshHomes`）为什么可以在这里改
 *
 * 面板上的数字来自**本机会话日志**，而一台机器上常常并存多套 DSH
 * （命令行版 `~/.dsh` + Desktop 的 harness + 第三方客户端）。缺省是
 * **自动发现**，但有两种情况必须能手填：
 *
 * 1. 某个客户端的目录名字不像 DSH（发现规则只提示、**绝不自动采用**），
 *    使用者确认后要能自己加进来；
 * 2. 想**只看其中几处**（例如只看工作机的 home，不算个人机器上的）。
 *
 * 面板里保存的值**覆盖部署配置**（与间隔 / 位置同一套优先级），
 * 输入框留空 = 把这条覆盖清掉，回落到部署配置 / 自动发现。
 *
 * ⚠️ **改的是「日志从哪读」，不是「身份与库放哪」**——面板刻意**不**提供
 *   `dataDir`：那个字段会同时换掉身份文件、本地库、outbox 与补报水位，
 *   在面板里改等于「填完就把自己变成另一个人」，只能在部署配置 / 环境变量里给。
 *
 * 旧版面板让用户分别填「姓名 / 身份 Key / 完整上报地址 / appKey」——
 * 四栏里有两栏是同一个意思（身份 Key 与 appKey 都只是凭证），
 * 还有一栏要求用户自己拼出 `/api/v1/token-usage` 这样的完整路径。
 * 实测（见提交记录里的界面截图）用户会把 API base URL 填进「姓名」，
 * 而真正该填的 appKey 栏空着 —— 面板的设计比凭证本身更容易出错。
 *
 * ## ★ 姓名以服务端为准（不变量，别改）
 *
 * 校验成功只取服务端返回的 `name` / `group` 落盘；客户端提交的姓名
 * **一律不使用**。否则改一下本地请求就能以他人名义署名。
 *
 * ## 保存是「先落连接、再落身份、最后就地生效」的三步
 *
 * 三步都可能失败，所以顺序与回退都要明确：先写 `plugin-connection.json`，
 * 再把 `identity.json` 写好（后者失败就把前者回退成原内容，免得留下
 * 「连接配好了但身份是旧的」这种自相矛盾的状态），最后调 `host.apply()`
 * 让**运行中的上报**立刻改用新连接 —— 用户不必重启 DSH。
 *
 * ⚠️ 就地生效失败**不回滚**文件：文件是对的，只是这个进程还没换过来；
 *   下次启动会读到它。响应里的 `restartRequired` 会如实说这一点。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DSH_HOME_ENV,
  DSH_HOMES_ENV,
  readIdentity,
  writeIdentity,
} from '@ai-token-report/core'
import {
  parseUiPosition,
  UI_POSITIONS,
  type UiPosition,
  type UiReportingStatus,
} from './client/protocol.js'
import type { EffectiveConfig, RawConfig } from './config.js'
import { reportPaths, type PathInput } from './paths.js'

/** 上报路径（`baseUrl` + 它 = `config.endpoint`）。 */
export const INGEST_PATH = '/api/v1/token-usage'
/** 身份校验路径（`baseUrl` + 它）。 */
export const VERIFY_PATH = '/api/v1/identity/verify'

/**
 * 定时冲刷间隔的允许范围。
 *
 * 下限 1 秒：更密的轮询对部门服务端是纯负担，而用量本来就不是秒级业务。
 * 上限 60 分钟：再长就等于「这个进程不再上报了」，那不该是一个间隔选项。
 */
export const MIN_FLUSH_INTERVAL_MILLIS = 1_000
export const MAX_FLUSH_INTERVAL_MILLIS = 60 * 60 * 1000

/**
 * 解析用户填的间隔。**毫秒**，不接受字符串以外的猜测。
 *
 * @returns 合法值，或 `undefined`（调用方必须把它当成「非法」而不是「没给」）。
 */
export function parseFlushInterval(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < MIN_FLUSH_INTERVAL_MILLIS || value > MAX_FLUSH_INTERVAL_MILLIS) return undefined
  return value
}

/** 落盘形状。`baseUrl` 是服务端根地址，不含任何 `/api/...` 后缀。 */
interface SavedConnection {
  /**
   * 服务端根地址。**与 `appKey` 成对**（见 `readConnection`）。
   *
   * ⚠️ 两项都可选：面板允许只保存**本机偏好**（间隔 / 位置 / 会话日志根）——
   *   一个还没配凭证、只想看本机用量的人，也该能固定自己的统计范围。
   *   半份连接（只有地址没密钥）仍然不会被认，所以「只存偏好」是安全的。
   */
  baseUrl?: string
  appKey?: string
  /** 定时冲刷间隔（毫秒）。缺省表示没设过。 */
  flushIntervalMillis?: number
  /** 面板落点。缺省表示没设过（此时用部署配置/默认值）。 */
  position?: UiPosition
  /**
   * ★ 会话日志根（面板里填的那一份）。缺省表示没设过 —— 跟随部署配置 / 自动发现。
   *
   * ⚠️ 它换的是**日志来源**（面板数字与历史补报都读它），不是数据目录。
   */
  dshHomes?: string[]
}

/**
 * 面板上一次最多接受多少个会话日志根。
 *
 * 不是洁癖：每个根都是一次目录扫描的来源，误把一整个盘符列表粘进来
 * 会让每次统计都去 `readdir` 一大堆不存在的位置。上限也顺带兜住
 * 「请求体里塞一万个根」这种畸形输入。
 */
export const MAX_DSH_HOMES = 32

/** 解析面板提交的会话日志根：合法的收下，非法的**说清原因**（不静默丢弃）。 */
export type DshHomesParse = { ok: true; value: string[] } | { ok: false; reason: string }

/**
 * 收下面板提交的「会话日志根」数组。
 *
 * 三条口径：
 * 1. **没给这个键** ≠ 给了空数组：前者是「这次不改这一项」，后者是
 *    「把覆盖清掉」（回落到部署配置 / 自动发现）。两者都不在这里表达 ——
 *    调用方据 `undefined` / `[]` 区分。
 * 2. 空白项按「没写」处理（粘贴多了一行空行是常事），与插件 config 的
 *    `toStringList()` 同口径；但**非字符串项直接报错**——
 *    那是手搓请求，不是用户手滑。
 * 3. 路径**不要求存在**：不存在/读不了的根会被如实报出（`effectiveRoots.exists`），
 *    与 CLI 的「缺失根逐项报出」是同一条规矩。拒绝不存在的路径会让
 *    「先配好、再插硬盘」这种正常顺序变得没法用。
 */
export function parseDshHomes(value: unknown): DshHomesParse {
  if (!Array.isArray(value)) return { ok: false, reason: '会话日志根必须是一个路径列表' }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: '会话日志根里有一项不是路径字符串' }
    const path = item.trim()
    if (path === '') continue
    if (path.includes('\0')) return { ok: false, reason: '会话日志根里不能包含空字符' }
    // 完全相同的两行只留一个：重复根不会多统计任何东西，只会让面板更难读
    if (!out.includes(path)) out.push(path)
  }
  if (out.length > MAX_DSH_HOMES) {
    return { ok: false, reason: `会话日志根最多 ${MAX_DSH_HOMES} 个（当前 ${out.length} 个）` }
  }
  return { ok: true, value: out }
}

/**
 * 生效的会话日志根**来自哪一级** —— 面板上那行小字，回答「我改的为什么没生效」。
 *
 * 与 `core/src/home.ts` 的 `resolveDshHomes()` 优先级逐级对应：
 * 面板保存的 > 部署配置（`dshHome` / `dshHomes`）> 环境变量 > 自动发现。
 * 这个标签只用于**展示**：路径的真值仍然只有一个来源（`resolvePaths()`）。
 */
export type DshHomesSource = 'panel' | 'config' | 'env' | 'auto'

/** 面板上「生效的根从哪来」的判据。 */
export function dshHomesSourceOf(input: {
  /** 面板保存过的那一份（空数组 = 没覆盖）。 */
  saved: Partial<SavedConnection>
  /** 生效配置里的两个字段（**已经含面板覆盖**）。 */
  effective: { dshHome?: string; dshHomes?: readonly string[] }
  env?: Record<string, string | undefined>
}): DshHomesSource {
  if (input.saved.dshHomes !== undefined && input.saved.dshHomes.length > 0) return 'panel'
  // 走到这里说明面板没覆盖（或被清掉了）——那生效值只可能来自部署配置。
  // ⚠️ 顺序必须与 core 的 `resolveDshHomes()` 一致：config > 环境变量 > 发现。
  if ((input.effective.dshHomes?.length ?? 0) > 0) return 'config'
  if (typeof input.effective.dshHome === 'string' && input.effective.dshHome.trim() !== '') return 'config'
  const env = input.env ?? process.env
  for (const key of [DSH_HOMES_ENV, DSH_HOME_ENV]) {
    const value = env[key]
    if (typeof value === 'string' && value.trim() !== '') return 'env'
  }
  return 'auto'
}

/**
 * 本机连接偏好的落盘路径。
 *
 * ⚠️ 与身份文件同目录（= token-report **数据目录**，不是 `dshHome`）：
 *   两者必须一起被共用或一起被隔离，否则会出现「实名来自 A 目录、
 *   凭证来自 B 目录」这种自相矛盾的署名（见 `paths.ts`）。
 */
function connectionPath(target?: PathInput): string {
  return join(reportPaths(target).dataDir, 'plugin-connection.json')
}

/**
 * 把用户填的地址归一成**服务端根地址**。
 *
 * 刻意宽容：容错比「格式不对，请重填」有用得多 ——
 * 用户从浏览器地址栏复制的是 `http://host:8787/`，从文档复制的是
 * `http://host:8787/api/v1/token-usage`，两者都该能用。
 * 唯一不能含糊的是**协议与凭证**：非 HTTP(S)、带账号密码、带查询串或片段
 * 一律拒绝（后者会让「上报地址」变成一个可被外部控制的跳转）。
 */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务端地址必须是不含账号、查询参数或片段的 HTTP(S) 地址')
  }
  // 贴心的反向做法：用户把完整上报地址粘进来时，替他把接口后缀去掉。
  // ⚠️ 只剥这几个**已知**后缀；其它路径前缀（反代挂在 /token-report 下）
  //    必须保留，否则会把合法部署改写成根路径。
  for (const suffix of [INGEST_PATH, '/api/v1', '/api']) {
    if (url.pathname === suffix || url.pathname === `${suffix}/`) {
      url.pathname = '/'
      break
    }
    if (url.pathname.endsWith(suffix)) {
      url.pathname = url.pathname.slice(0, -suffix.length) || '/'
      break
    }
  }
  return url.toString().replace(/\/+$/, '')
}

/** 根地址 → 上报地址（`config.endpoint` 的形状）。 */
export function endpointOf(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl) + INGEST_PATH
}

/** 上报地址 → 根地址（读旧版配置文件用）。坏值原样返回，由面板显示出来让用户改。 */
export function baseUrlOf(endpoint: string): string {
  try {
    return normalizeBaseUrl(endpoint)
  } catch {
    return endpoint
  }
}

/**
 * 读已保存的连接配置。
 *
 * ⚠️ 兼容旧版 `{ endpoint, appKey }`：升级后第一次打开面板时，
 *   用户不该看到「地址空了」而被要求重填一遍。
 *   损坏时沿用部署配置 —— 不让一份配置文件阻止宿主启动。
 *
 * ★ 间隔与位置**独立于凭证**：即使 appKey 还没填（或凭证被删了），
 *   用户选过的偏好也该被记住。凭证本身仍然要求「地址 + 密钥」成对才认。
 */
export function readConnection(target?: PathInput): Partial<SavedConnection> {
  try {
    const value = JSON.parse(readFileSync(connectionPath(target), 'utf8')) as Record<string, unknown>
    const out: Partial<SavedConnection> = {}
    const interval = parseFlushInterval(value['flushIntervalMillis'])
    if (interval !== undefined) out.flushIntervalMillis = interval
    const position = parseUiPosition(value['position'])
    if (position !== undefined) out.position = position

    if (typeof value['appKey'] === 'string' && value['appKey']) {
      if (typeof value['baseUrl'] === 'string' && value['baseUrl']) {
        out.baseUrl = normalizeBaseUrl(value['baseUrl'])
      } else if (typeof value['endpoint'] === 'string' && value['endpoint']) {
        out.baseUrl = baseUrlOf(value['endpoint'])
      }
      if (out.baseUrl) out.appKey = value['appKey']
    }

    // ★ 会话日志根是**纯本机偏好**：即使凭证还没配（或凭证不成对）也必须留下 ——
    //   它不依赖任何连接，与间隔 / 位置同一类（见 SavedConnection 的注释）。
    //   ⚠️ 写坏了（不是字符串数组 / 超过上限）时**整项丢掉并告警**，而不是
    //   悄悄用其中几个：那份列表决定「面板上的数是哪些 home 的」，
    //   半份生效会让人以为某个 home 已经加进来了，而它没有。
    if (value['dshHomes'] !== undefined) {
      const homes = parseDshHomes(value['dshHomes'])
      if (homes.ok) {
        if (homes.value.length > 0) out.dshHomes = homes.value
      } else {
        console.warn(`token-report: 本地配置里的 dshHomes 不可用（${homes.reason}），已忽略该项`)
      }
    }
    return out
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.warn('token-report: 本地连接配置损坏，已回退部署配置')
  }
  return {}
}

/**
 * 用户在配置页明确保存的偏好优先于部署默认值。
 *
 * - **连接**（地址 + appKey）：保存过就覆盖。
 * - **间隔 / 位置 / 会话日志根**：保存过就覆盖；它们只影响本机行为，
 *   与团队下发不冲突。
 * - **固定身份**仍由部署配置管理（`raw.user` 优先级最高，见 `resolveConfig`）。
 *
 * ⚠️ 会话日志根的**空数组 = 没有覆盖**（不是「一个根都不要」）：
 *   一个根都没有的统计没有意义，所以「清空输入框」的正确语义是
 *   「回落到部署配置 / 自动发现」，见 `parseDshHomes` 的口径 1。
 */
export function withSavedConnection(raw: RawConfig): RawConfig {
  const saved = readConnection({ ...(raw.dshHome ? { dshHome: raw.dshHome } : {}), ...(raw.dataDir ? { dataDir: raw.dataDir } : {}) })
  let next = raw
  if (saved.baseUrl && saved.appKey) {
    next = { ...next, endpoint: endpointOf(saved.baseUrl), appKey: saved.appKey }
  }
  if (saved.flushIntervalMillis !== undefined) {
    next = { ...next, batch: { ...next.batch, flushIntervalMillis: saved.flushIntervalMillis } }
  }
  if (saved.position !== undefined) {
    next = { ...next, ui: { ...next.ui, position: saved.position } }
  }
  if (saved.dshHomes !== undefined && saved.dshHomes.length > 0) {
    next = { ...next, dshHomes: [...saved.dshHomes] }
  }
  return next
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * 设置页需要的宿主状态。
 *
 * ★ 全部是**函数/每次请求现读**：保存成功后同一个 handler 必须立刻反映新值，
 *   否则用户会看到「刚保存完，页面还显示旧的间隔」。
 */
export interface SettingsState {
  /** 当前生效配置（含已保存连接的覆盖）。 */
  config: EffectiveConfig
  /** 当前署名（服务端认下的那个），未署名为 `null`。 */
  identity: { name: string; group?: string } | null
  /** 已保存的连接偏好（用于回填地址 / 间隔 / 位置 / 会话日志根）。 */
  saved: Partial<SavedConnection>
  /** 上报此刻是否在跑。 */
  reporting: UiReportingStatus
  /** 配置由部署文件或环境变量管理时为 `true`。 */
  locked: boolean
}

export interface SettingsHost {
  state(): SettingsState
  /**
   * 保存成功后让上报**就地生效**。
   *
   * 缺省（`undefined`）表示这个宿主不支持热生效 —— 响应里会回
   * `restartRequired: true`，与旧行为一致。测试与旧宿主都走这条路。
   */
  apply?(): Promise<UiReportingStatus>
}

export interface SettingsHandlerOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

/**
 * 从 `POST /api/v1/identity/verify` 的响应里取分组名。
 *
 * ⚠️ **必须容忍旧服务端**：迁移期的服务端会同时返回 `group` 与 `dept`（同值，
 *   `dept` 标为「已废弃，仅为兼容旧插件」），而**尚未升级**的服务端只返回 `dept`。
 *   只读 `group` 会让后者把分组静默丢掉 —— 不报错，只是那个字段空了。
 *   兼容期结束后把 `dept` 这一支删掉。
 */
function verifiedGroup(res: { group?: unknown; dept?: unknown }): string {
  const group = typeof res.group === 'string' ? res.group.trim() : ''
  if (group) return group
  return typeof res.dept === 'string' ? res.dept.trim() : ''
}

export function createSettingsHandler(
  host: SettingsHost,
  options: SettingsHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  /**
   * 这个宿主支不支持「保存即生效」。
   *
   * ★ GET 如实回答它，而不是回一个粘滞的状态位：用户在面板上要判断的是
   *   「我现在还会有一次重启要做吗」，而不是「上次保存时需不需要重启」。
   */
  const liveApply = typeof host.apply === 'function'
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
  let saving = false

  /**
   * 面板要显示的「会话日志根」三件套。
   *
   * - `dshHomes` —— **面板里存过的那一份**（空数组 = 没覆盖）→ 回填输入框；
   * - `effectiveRoots` —— **此刻真正在用的根**，逐项带「有没有 sessions 目录」
   *   → 用户改完能立刻看见生效的是哪几处，以及哪个根白写了；
   * - `rootsSource` —— 这份生效值来自哪一级（面板 / 部署配置 / 环境变量 / 自动发现）。
   *
   * ⚠️ 三者必须一起回：只给输入框的值，用户永远分不清「我存的」与
   *   「现在真的在读的」——而这两件事在本插件里恰好最容易不一致。
   */
  const rootsView = (state: SettingsState): {
    dshHomes: string[]
    effectiveRoots: { path: string; exists: boolean }[]
    rootsSource: DshHomesSource
  } => ({
    dshHomes: state.saved.dshHomes ?? [],
    // `path` 用 **home**（用户填的就是它），`exists` 是 `<home>/sessions` 在不在
    // ——与 CLI `--discover` 逐根报的是同一件事。
    effectiveRoots: reportPaths(state.config).sessionRoots.map((info) => ({ path: info.home, exists: info.exists })),
    rootsSource: dshHomesSourceOf({ saved: state.saved, effective: state.config }),
  })

  return async (request) => {
    const state = host.state()
    const paths = reportPaths(state.config)

    if (request.method === 'GET') {
      const identity = state.identity
      const saved = state.saved
      // ★ 只回「填没填」与「叫什么」，绝不回显 appKey（发回浏览器等于让它
      //   暴露在 devtools、磁盘缓存与任何 XSS 面前）。
      return json({
        signed: !!identity,
        name: identity?.name ?? '',
        group: identity?.group ?? '',
        baseUrl: saved.baseUrl ?? baseUrlOf(state.config.endpoint),
        locked: state.locked,
        hasAppKey: !!(saved.appKey ?? state.config.appKey),
        // 新宿主保存后立即生效；只有拿不到热生效入口时才说要重启
        restartRequired: !liveApply,
        flushIntervalMillis: saved.flushIntervalMillis ?? state.config.batch.flushIntervalMillis,
        position: saved.position ?? state.config.ui.position,
        reporting: state.reporting,
        ...rootsView(state),
      })
    }
    if (request.method !== 'POST') return json({ ok: false, reason: '不支持的请求方法' }, 405)
    if (state.locked) return json({ ok: false, reason: '配置由部署文件或环境变量管理，请联系管理员修改' })
    if (saving) return json({ ok: false, reason: '正在保存配置，请稍后重试' })
    saving = true
    try {
      const raw = await request.json() as Record<string, unknown>
      const appKey = typeof raw['appKey'] === 'string' ? raw['appKey'].trim() : ''
      const previous = readConnection(state.config)

      // ── 地址：换凭证必须自己带地址；只改偏好时地址必须原样不动 ─────────
      //
      // ★「只改偏好」这条路**不要求先有凭证**：会话日志根 / 间隔 / 位置都是纯本机
      //   偏好，一个还没配 appKey（只看本机用量、不上报）的人也该能固定统计范围。
      //   此时**一个地址字节都不落盘**——半份连接（有地址没密钥）仍然不会
      //   被 `readConnection` 认，所以不会留下「连接配好了但身份是旧的」这种状态。
      let baseUrl: string | undefined
      if (appKey) {
        try {
          baseUrl = normalizeBaseUrl(typeof raw['baseUrl'] === 'string' ? raw['baseUrl'] : '')
        } catch {
          return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
        }
      } else {
        // 没有新凭证时，能接受的地址只有两种：没给，或「就是现在生效的那个」。
        const current = previous.baseUrl ?? baseUrlOf(state.config.endpoint)
        const given = typeof raw['baseUrl'] === 'string' ? raw['baseUrl'].trim() : ''
        if (given) {
          let normalized: string
          try {
            normalized = normalizeBaseUrl(given)
          } catch {
            return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
          }
          if (normalized !== current) {
            return json({ ok: false, reason: '修改服务端地址需要同时填写 appKey（要重新校验身份）' })
          }
        }
        // 只有凭证**成对**存在时才沿用地址：否则这次保存与连接无关。
        if (previous.baseUrl && previous.appKey) baseUrl = previous.baseUrl
      }

      // ── 本机偏好：给了就必须合法（非法值不许静默当成没给）────────────
      let interval = previous.flushIntervalMillis
      if (raw['flushIntervalMillis'] !== undefined) {
        const parsed = parseFlushInterval(raw['flushIntervalMillis'])
        if (parsed === undefined) {
          return json({
            ok: false,
            reason:
              `上报间隔必须是 ${MIN_FLUSH_INTERVAL_MILLIS / 1000} 秒到 ` +
              `${MAX_FLUSH_INTERVAL_MILLIS / 60000} 分钟之间的整数毫秒值`,
          })
        }
        interval = parsed
      }
      let position = previous.position
      if (raw['position'] !== undefined) {
        const parsed = parseUiPosition(raw['position'])
        if (parsed === undefined) {
          return json({ ok: false, reason: `面板位置只能是 ${UI_POSITIONS.join(' / ')}` })
        }
        position = parsed
      }
      // 会话日志根：`undefined` = 这次不动它；`[]` = 把覆盖清掉（回落部署配置 / 自动发现）。
      let dshHomes = previous.dshHomes
      if (raw['dshHomes'] !== undefined) {
        const parsed = parseDshHomes(raw['dshHomes'])
        if (!parsed.ok) return json({ ok: false, reason: parsed.reason })
        dshHomes = parsed.value
      }

      const path = connectionPath(state.config)
      /** 这次要落盘的内容：**凭证来自本次输入，或原样沿用已保存的那一份**。 */
      const credential = appKey || previous.appKey
      const saved: SavedConnection = {
        // 地址与凭证**要么成对写、要么都不写**（见 SavedConnection 的注释）
        ...(baseUrl !== undefined && credential ? { baseUrl, appKey: credential } : {}),
        ...(interval !== undefined ? { flushIntervalMillis: interval } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(dshHomes !== undefined && dshHomes.length > 0 ? { dshHomes } : {}),
      }

      /**
       * 落盘 + 就地生效 —— 「只改偏好」与新凭证两条路共用同一段收尾。
       *
       * @param write - 新凭证那条路已经在写身份文件之前落过盘（失败要回退），
       *   所以这里不再重复写一次。
       */
      const commit = async (name: string, write = true): Promise<Response> => {
        if (write) atomicWrite(path, JSON.stringify(saved))
        const endpoint = saved.baseUrl !== undefined ? endpointOf(saved.baseUrl) : state.config.endpoint
        // ── ★ 就地生效：保存完就能开始上报，不必重启 DSH ──────────────
        let reporting: UiReportingStatus = {
          enabled: false, endpoint, reason: '宿主未提供热生效入口，需重启 DSH',
        }
        let applied = false
        if (host.apply) {
          try {
            reporting = await host.apply()
            applied = true
          } catch {
            // 文件已经写对了；只是这个进程没能换过来 —— 下次启动会读到它。
            reporting = { enabled: false, endpoint, reason: '新配置未能就地生效，需重启 DSH' }
          }
        }
        // ★ 生效的日志根在 `apply()` **之后**现读：这一刻宿主认的范围，才是
        //   页面接下来会看到的范围。回给页面，省掉一次「保存完再 GET」的往返。
        const after = host.state()
        return json({
          ok: true,
          name,
          position: saved.position ?? after.config.ui.position,
          flushIntervalMillis: saved.flushIntervalMillis ?? after.config.batch.flushIntervalMillis,
          ...rootsView(after),
          reporting,
          applied,
          restartRequired: !applied,
        })
      }

      // ── 只改偏好：不重校验、不重写身份文件（凭证原样保留）────────────
      if (!appKey) return await commit(host.state().identity?.name ?? '')

      // 走到这里 appKey 必非空，而「带 appKey」那条路一定归一出了地址
      // （非法地址在更上面就被拦掉了）—— 这一句只是让类型收窄。
      const verifyBase = baseUrl
      if (verifyBase === undefined) {
        return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
      }

      // ★ 校验用的是 appKey 自己：服务端按它解析出人员，姓名由此而来。
      let verified: { ok?: boolean; name?: unknown; group?: unknown; dept?: unknown; reason?: unknown }
      try {
        const response = await fetchImpl(verifyBase + VERIFY_PATH, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${appKey}` },
          body: JSON.stringify({ token: appKey }),
        })
        if (!response.ok) return json({ ok: false, reason: `appKey 校验失败（HTTP ${response.status}）` })
        verified = await response.json() as typeof verified
      } catch {
        return json({ ok: false, reason: '无法连接部门服务端校验 appKey，请检查地址与网络后重试' })
      }
      if (!verified || verified.ok !== true || typeof verified.name !== 'string' || !verified.name.trim()) {
        return json({ ok: false, reason: typeof verified?.reason === 'string' ? verified.reason : '服务端未返回有效署名，未保存配置' })
      }

      let previousText: string | undefined
      try { previousText = readFileSync(path, 'utf8') } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
      atomicWrite(path, JSON.stringify(saved))
      // ★ 身份文件里的 token 就是 appKey：本地页与 CLI 上报读的是同一份，
      //   于是「在插件里填一次」对三种形态都生效。
      const result = writeIdentity(paths.identityPath, {
        name: verified.name.trim(), token: appKey,
        // 写出侧只写 `group`（旧字段名不再落盘）；取值经 `verifiedGroup()` 兼容旧服务端。
        ...(verifiedGroup(verified) ? { group: verifiedGroup(verified) } : {}),
      })
      if (!result.ok) {
        if (previousText !== undefined) atomicWrite(path, previousText)
        else rmSync(path, { force: true })
        return json({ ok: false, reason: '署名保存失败，连接设置已回退，请检查目录权限' })
      }

      return await commit(verified.name.trim(), false)
    } catch {
      return json({ ok: false, reason: '配置格式或服务端地址无效，或本地文件无法写入；请检查后重试' })
    } finally { saving = false }
  }
}