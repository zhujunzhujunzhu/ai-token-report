/**
 * 插件配置页的宿主入口 —— 设置面有**四个字段**：
 * 服务端地址、appKey、上报间隔、面板位置。
 *
 * ## 为什么是这四项
 *
 * 员工手上真正拿到的东西只有两样：部门平台的地址，和管理员发的一串 appKey。
 * 其余全部是派生的：
 *
 * | 面板字段 | 从哪来 |
 * |---|---|
 * | 姓名 / 分组 | ★ **服务端校验结果**，不是用户填的（见下） |
 * | `/api/v1/identity/verify` | `baseUrl` + 固定路径 |
 * | `/api/v1/token-usage` | `baseUrl` + 固定路径 |
 * | 上报间隔 / 面板位置 | 纯本机偏好，只写本地文件 |
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
import { readIdentity, writeIdentity } from '@ai-token-report/core'
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
  baseUrl: string
  appKey: string
  /** 定时冲刷间隔（毫秒）。缺省表示没设过。 */
  flushIntervalMillis?: number
  /** 面板落点。缺省表示没设过（此时用部署配置/默认值）。 */
  position?: UiPosition
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
 * - **间隔 / 位置**：保存过就覆盖；它们只影响本机行为，与团队下发不冲突。
 * - **固定身份**仍由部署配置管理（`raw.user` 优先级最高，见 `resolveConfig`）。
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
  /** 已保存的连接偏好（用于回填地址 / 间隔 / 位置）。 */
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

      // ── 地址：新凭证必须自己带地址；只改偏好时地址必须原样不动 ─────────
      let baseUrl: string
      if (!appKey) {
        // ★「只改偏好」这条路：凭证已经在盘上了，用户只是改间隔/位置，
        //   不该被要求再粘一次密钥（那串东西往往已经不在手边）。
        if (!previous.appKey || !previous.baseUrl) {
          return json({ ok: false, reason: '请填写管理员发放的 appKey' })
        }
        const given = typeof raw['baseUrl'] === 'string' ? raw['baseUrl'].trim() : ''
        if (given) {
          let normalized: string
          try {
            normalized = normalizeBaseUrl(given)
          } catch {
            return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
          }
          if (normalized !== previous.baseUrl) {
            return json({ ok: false, reason: '修改服务端地址需要同时填写 appKey（要重新校验身份）' })
          }
        }
        baseUrl = previous.baseUrl
      } else {
        try {
          baseUrl = normalizeBaseUrl(typeof raw['baseUrl'] === 'string' ? raw['baseUrl'] : '')
        } catch {
          return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
        }
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

      const path = connectionPath(state.config)
      /** 这次要落盘的内容：**凭证来自本次输入，或原样沿用已保存的那一份**。 */
      const saved: SavedConnection = {
        baseUrl,
        appKey: appKey || previous.appKey!,
        ...(interval !== undefined ? { flushIntervalMillis: interval } : {}),
        ...(position !== undefined ? { position } : {}),
      }

      /**
       * 落盘 + 就地生效 —— 「只改偏好」与新凭证两条路共用同一段收尾。
       *
       * @param write - 新凭证那条路已经在写身份文件之前落过盘（失败要回退），
       *   所以这里不再重复写一次。
       */
      const commit = async (name: string, write = true): Promise<Response> => {
        if (write) atomicWrite(path, JSON.stringify(saved))
        // ── ★ 就地生效：保存完就能开始上报，不必重启 DSH ──────────────
        let reporting: UiReportingStatus = {
          enabled: false, endpoint: endpointOf(saved.baseUrl), reason: '宿主未提供热生效入口，需重启 DSH',
        }
        let applied = false
        if (host.apply) {
          try {
            reporting = await host.apply()
            applied = true
          } catch {
            // 文件已经写对了；只是这个进程没能换过来 —— 下次启动会读到它。
            reporting = { enabled: false, endpoint: endpointOf(saved.baseUrl), reason: '新配置未能就地生效，需重启 DSH' }
          }
        }
        return json({
          ok: true,
          name,
          position: saved.position ?? state.config.ui.position,
          flushIntervalMillis: saved.flushIntervalMillis ?? state.config.batch.flushIntervalMillis,
          reporting,
          applied,
          restartRequired: !applied,
        })
      }

      // ── 只改偏好：不重校验、不重写身份文件（凭证原样保留）────────────
      if (!appKey) return await commit(host.state().identity?.name ?? '')

      // ★ 校验用的是 appKey 自己：服务端按它解析出人员，姓名由此而来。
      let verified: { ok?: boolean; name?: unknown; group?: unknown; dept?: unknown; reason?: unknown }
      try {
        const response = await fetchImpl(baseUrl + VERIFY_PATH, {
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