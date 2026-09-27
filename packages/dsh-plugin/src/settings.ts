/**
 * 插件配置页的宿主入口 —— 设置面只有**两个字段：baseUrl + appKey**。
 *
 * ## 为什么是这两个
 *
 * 员工手上真正拿到的东西只有两样：部门平台的地址，和管理员发的一串 appKey。
 * 其余全部是派生的：
 *
 * | 面板字段 | 从哪来 |
 * |---|---|
 * | 姓名 / 部门 | ★ **服务端校验结果**，不是用户填的（见下） |
 * | `/api/v1/identity/verify` | `baseUrl` + 固定路径 |
 * | `/api/v1/token-usage` | `baseUrl` + 固定路径 |
 *
 * 旧版面板让用户分别填「姓名 / 身份 Key / 完整上报地址 / appKey」——
 * 四栏里有两栏是同一个意思（身份 Key 与 appKey 都只是凭证），
 * 还有一栏要求用户自己拼出 `/api/v1/token-usage` 这样的完整路径。
 * 实测（见提交记录里的界面截图）用户会把 API base URL 填进「姓名」，
 * 而真正该填的 appKey 栏空着 —— 面板的设计比凭证本身更容易出错。
 *
 * ## ★ 姓名以服务端为准（不变量，别改）
 *
 * 校验成功只取服务端返回的 `name` / `dept` 落盘；客户端提交的姓名
 * **一律不使用**。否则改一下本地请求就能以他人名义署名。
 *
 * ## 保存是「先落连接、再落身份」的两步写
 *
 * 两步都可能失败，所以顺序与回退都要明确：先写 `plugin-connection.json`，
 * 再把 `identity.json` 写好；后者失败就把前者回退成原内容，
 * 免得留下「连接配好了但身份是旧的」这种自相矛盾的状态。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readIdentity, resolvePaths, writeIdentity } from '@ai-token-report/core'
import type { EffectiveConfig, RawConfig } from './config.js'

/** 上报路径（`baseUrl` + 它 = `config.endpoint`）。 */
export const INGEST_PATH = '/api/v1/token-usage'
/** 身份校验路径（`baseUrl` + 它）。 */
export const VERIFY_PATH = '/api/v1/identity/verify'

/** 落盘形状。`baseUrl` 是服务端根地址，不含任何 `/api/...` 后缀。 */
interface SavedConnection { baseUrl: string; appKey: string }

function connectionPath(home?: string): string {
  return join(resolvePaths(home).dshHome, 'token-report', 'plugin-connection.json')
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
 */
export function readConnection(home?: string): Partial<SavedConnection> {
  try {
    const value = JSON.parse(readFileSync(connectionPath(home), 'utf8'))
    if (typeof value.appKey !== 'string' || !value.appKey) return {}
    if (typeof value.baseUrl === 'string' && value.baseUrl) {
      return { baseUrl: normalizeBaseUrl(value.baseUrl), appKey: value.appKey }
    }
    if (typeof value.endpoint === 'string' && value.endpoint) {
      return { baseUrl: baseUrlOf(value.endpoint), appKey: value.appKey }
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') console.warn('token-report: 本地连接配置损坏，已回退部署配置')
  }
  return {}
}

/** 用户在配置页明确保存的连接优先于部署默认值。固定身份仍由部署配置管理。 */
export function withSavedConnection(raw: RawConfig): RawConfig {
  const saved = readConnection(raw.dshHome)
  if (!saved.baseUrl) return raw
  return { ...raw, endpoint: endpointOf(saved.baseUrl), appKey: saved.appKey }
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

export function createSettingsHandler(config: EffectiveConfig, options: {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  locked?: boolean
} = {}): (request: Request) => Promise<Response> {
  const paths = resolvePaths(config.dshHome)
  const fetchImpl = options.fetchImpl ?? fetch
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
  let saving = false
  let restartRequired = false
  return async (request) => {
    if (request.method === 'GET') {
      const identity = config.user ?? readIdentity(paths.identityPath).identity
      const saved = readConnection(config.dshHome)
      // ★ 只回「填没填」与「叫什么」，绝不回显 appKey（发回浏览器等于让它
      //   暴露在 devtools、磁盘缓存与任何 XSS 面前）。
      return json({ signed: !!identity, name: identity?.name ?? '', dept: identity?.dept ?? '',
        baseUrl: saved.baseUrl ?? baseUrlOf(config.endpoint), locked: !!options.locked,
        hasAppKey: !!(saved.appKey ?? config.appKey), restartRequired })
    }
    if (request.method !== 'POST') return json({ ok: false, reason: '不支持的请求方法' }, 405)
    if (options.locked) return json({ ok: false, reason: '配置由部署文件或环境变量管理，请联系管理员修改' })
    if (saving) return json({ ok: false, reason: '正在保存配置，请稍后重试' })
    saving = true
    try {
      const raw = await request.json() as Record<string, unknown>
      const appKey = typeof raw.appKey === 'string' ? raw.appKey.trim() : ''
      if (!appKey) return json({ ok: false, reason: '请填写管理员发放的 appKey' })
      let baseUrl: string
      try {
        baseUrl = normalizeBaseUrl(typeof raw.baseUrl === 'string' ? raw.baseUrl : '')
      } catch {
        return json({ ok: false, reason: '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787' })
      }
      // ★ 校验用的是 appKey 自己：服务端按它解析出人员，姓名由此而来。
      let verified: { ok?: boolean; name?: unknown; dept?: unknown; reason?: unknown }
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
      const path = connectionPath(config.dshHome)
      let previous: string | undefined
      try { previous = readFileSync(path, 'utf8') } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err
      }
      atomicWrite(path, JSON.stringify({ baseUrl, appKey }))
      // ★ 身份文件里的 token 就是 appKey：本地页与 CLI 上报读的是同一份，
      //   于是「在插件里填一次」对三种形态都生效。
      const result = writeIdentity(paths.identityPath, {
        name: verified.name.trim(), token: appKey,
        ...(typeof verified.dept === 'string' && verified.dept.trim() ? { dept: verified.dept.trim() } : {}),
      })
      if (!result.ok) {
        if (previous !== undefined) atomicWrite(path, previous)
        else rmSync(path, { force: true })
        return json({ ok: false, reason: '署名保存失败，连接设置已回退，请检查目录权限' })
      }
      restartRequired = true
      return json({ ok: true, name: verified.name.trim(), restartRequired: true })
    } catch {
      return json({ ok: false, reason: '配置格式或服务端地址无效，或本地文件无法写入；请检查后重试' })
    } finally { saving = false }
  }
}