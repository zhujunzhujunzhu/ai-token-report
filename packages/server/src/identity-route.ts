/**
 * 本地身份路由 —— 「配置」弹框的读写落点。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | `GET` | `/api/local/identity` | 页面启动时问「填过没、连的是哪台」 |
 * | `POST` | `/api/local/identity` | 提交配置（**会向部门服务端校验 appKey**） |
 * | `DELETE` | `/api/local/identity` | 退出署名 / 换人 |
 *
 * ## ★ 只有两项输入：服务端地址 + appKey
 *
 * 员工手上真正拿到的只有这两样（与 DSH 插件的「连接配置」同一形态）。
 * 姓名与分组**由服务端按 appKey 解析**，客户端提交什么都不采信 ——
 * 否则改一下本地请求就能以他人名义署名。
 *
 * 地址的优先级：**本次提交的 > 本机存过的那份 > 部署参数 `--portal`**。
 * 与本机连接配置的其它项同一套优先级（`connection-store.ts`），
 * 也正因为共用那一份文件，在本地页填一次对插件同样生效。
 *
 * ## 安全约束
 *
 * 1. **GET 绝不返回 token**。页面只需要知道「填没填」「叫什么」「连哪台」。
 *    把 token 发回浏览器等于让它暴露在 devtools、磁盘缓存与任何 XSS 面前。
 * 2. **POST 必须校验 token 才能落盘**。校验由部门服务端完成；
 *    本地服务不猜「看起来对不对」，避免给出误导性提示。
 * 3. **部门服务端不可达时不落盘**。宁可让用户重试，也不要存下一个
 *    看似成功、实则永不被承认的凭证 —— 那种失败会在几天后才暴露。
 * 4. **不让服务端替浏览器改自己不知道的键**：写连接配置走
 *    `updateConnectionFile()`（合并写），插件的偏好原样保留。
 *
 * ## 校验失败的三类提示
 *
 * 服务端返回的 `registered: false` 与「token 无效」必须区分开：
 * 前者是管理员还没发凭证（用户做什么都没用），后者是 appKey 抄错了（重试有用）。
 * 混为一谈会让用户在完全正确的情况下反复重试。
 */

import {
  clearIdentity,
  connectionCredentialOf,
  connectionPath,
  identityPath,
  readConnectionFile,
  readConnectionText,
  readIdentity,
  updateConnectionFile,
  writeConnectionText,
  writeIdentity,
} from '@ai-token-report/core'
import {
  VERIFY_PATH,
  normalizeBaseUrl,
  type LocalIdentityResponse,
  type LocalIdentitySubmit,
  type LocalIdentitySubmitResponse,
  type VerifyTokenResponse,
} from '@ai-token-report/shared'

export interface IdentityRouteOptions {
  /** DSH home（会话日志根）。身份文件**不**在这里，见 `dataDir`。 */
  dshHome: string
  /**
   * token-report 数据目录。缺省 `~/.ai-token-report`（与 `dshHome` 无关）。
   *
   * 身份文件（`identity.json`）与连接配置（`plugin-connection.json`）都在这里
   * —— 与 CLI、DSH 插件共用。
   */
  dataDir?: string
  /**
   * 部门服务端地址（部署参数 `--portal`）。用于校验 token。
   *
   * ⚠️ 未配置时**页面里仍然可以填**（那正是「只需要一个 baseUrl + appKey」的意思）。
   *   两处都没有时才拒绝，并明确说清要填什么。
   */
  portalUrl?: string
  /** 校验请求超时（毫秒）。默认 8 秒。 */
  verifyTimeoutMs?: number
  /** 注入用，便于测试。 */
  fetchImpl?: typeof fetch
}

/** 未署名时的引导文案。集中一处，便于统一措辞。 */
const UNSIGNED_HINT =
  '请填写部门服务端的地址与管理员发放的 appKey，用于把你的用量归属到分组统计中。' +
  '未填写前不会采集也不会向服务端发送任何数据。'

/** 地址填错时的提示。与插件面板同一句话，用户在两处看到的说法一致。 */
const BAD_BASE_URL =
  '服务端地址无效：请填 http(s)://主机[:端口] 形式，例如 http://127.0.0.1:8787'

export class IdentityRoute {
  readonly #dshHome: string
  readonly #dataDir: string | undefined
  readonly #portalUrl: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: IdentityRouteOptions) {
    this.#dshHome = options.dshHome
    this.#dataDir = options.dataDir
    this.#portalUrl = options.portalUrl
    this.#timeoutMs = options.verifyTimeoutMs ?? 8_000
    this.#fetch = options.fetchImpl ?? fetch
  }

  get #path(): string {
    return identityPath(this.#dshHome, this.#dataDir)
  }

  /** 本机连接配置（与插件共用一份）。 */
  get #connectionPath(): string {
    return connectionPath(this.#dshHome, this.#dataDir)
  }

  /**
   * 本机连接配置里那份凭证（地址 + appKey）。
   *
   * 坏地址 / 坏文件一律降级成「没有」：它是**本机偏好**，坏了不该让页面白屏，
   * 而 `--portal` 与页面输入都还在（与插件 `readConnection()` 的取舍一致）。
   */
  #savedCredential(): { baseUrl: string; appKey: string } | undefined {
    const read = readConnectionFile(this.#connectionPath)
    if (read.value === null) return undefined
    try {
      return connectionCredentialOf(read.value)
    } catch {
      return undefined
    }
  }

  /**
   * 此刻生效的服务端根地址：本机存过的那份 > 部署参数 `--portal`。
   *
   * 部署参数也归一化一遍（`http://host:8787/` 与带 `/api/v1` 的写法都收下），
   * 但**归一化失败就原样返回** —— 那是运维写错的值，页面要能显示出来让它被看见，
   * 而不是显示一个空的输入框。
   */
  #effectiveBaseUrl(): string | null {
    const saved = this.#savedCredential()
    if (saved) return saved.baseUrl
    const portal = this.#portalUrl?.trim()
    if (!portal) return null
    try {
      return normalizeBaseUrl(portal)
    } catch {
      return portal
    }
  }

  /** `GET /api/local/identity` —— 注意返回值里没有 token。 */
  get(): LocalIdentityResponse {
    const { identity } = readIdentity(this.#path)
    const baseUrl = this.#effectiveBaseUrl()
    if (!identity) {
      return { signed: false, name: null, group: null, createdAt: null, hint: UNSIGNED_HINT, baseUrl }
    }
    return {
      signed: true,
      name: identity.name,
      // ⚠️ 旧 `identity.json` 里写的是 `dept`：按 `group ?? dept` 取值（同 shared/identity.ts 的 toAssertion）。
      group: identity.group ?? identity.dept ?? null,
      createdAt: identity.createdAt,
      hint: null,
      baseUrl,
    }
  }

  /**
   * `POST /api/local/identity` —— 校验并落盘。
   *
   * 流程：形式校验 → 定出服务端地址 → 向它校验 appKey → 以**服务端返回的姓名**
   * 为准落盘 → 记下这次用的地址与凭证。
   */
  async submit(input: LocalIdentitySubmit): Promise<LocalIdentitySubmitResponse> {
    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    const given = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''

    if (!token) return { ok: false, reason: '请填写管理员发放的 appKey' }

    // ── 地址：本次提交的 > 本机存过的 > 部署参数 ────────────────────────
    let baseUrl: string
    if (given) {
      try {
        baseUrl = normalizeBaseUrl(given)
      } catch {
        return { ok: false, reason: BAD_BASE_URL }
      }
    } else {
      const effective = this.#effectiveBaseUrl()
      if (effective === null) {
        return {
          ok: false,
          reason: '请填写部门服务端地址（形如 http://host:8787）—— 没有地址就无法确认你是谁。',
        }
      }
      // 归一化失败的那份（运维写错的 `--portal`）在这里也会真的去请求，
      // 于是用户看到的是「无法连接」而不是被静默改成别的地址。
      baseUrl = effective
    }

    // ★ 向服务端校验。这一步决定了「你是谁」。
    let verify: VerifyTokenResponse
    try {
      verify = await this.#verifyWithPortal(baseUrl, token)
    } catch (err) {
      // 网络失败 → 不落盘。宁可让用户重试，也不存一个永不被承认的凭证。
      return {
        ok: false,
        reason: `无法连接部门服务端校验 appKey：${msg(err, this.#timeoutMs)}。请检查地址与网络后重试。`,
      }
    }

    if (!verify.ok) {
      return { ok: false, reason: verify.reason ?? 'appKey 校验未通过' }
    }

    // ★ 姓名只认服务端返回的那个。**没有姓名 = 校验失败**，不是「那就用客户端填的」——
    //   采信客户端声明的姓名等于允许任何人以他人名义上报（见 identity-attribution 不变量）。
    const finalName = typeof verify.name === 'string' ? verify.name.trim() : ''
    if (!finalName) {
      return { ok: false, reason: '服务端未返回有效署名，未保存配置' }
    }
    const finalGroup = verifiedGroup(verify)

    // ── 落盘：先连接、再身份；身份写失败就把连接回滚 ────────────────────
    //   顺序与插件面板一致（`dsh-plugin/src/settings.ts`）：连接先落地，
    //   身份失败时能整个撤掉，不留「连接配好了但署名是旧的」这种自相矛盾的状态。
    const previous = readConnectionText(this.#connectionPath)
    const conn = updateConnectionFile(this.#connectionPath, { baseUrl, appKey: token })
    if (!conn.ok) {
      return { ok: false, reason: conn.reason ?? '本机连接配置写入失败' }
    }

    const written = writeIdentity(this.#path, {
      name: finalName,
      token,
      // ★ 只写 `group`：core 的 writeIdentity 读的时候两者都认、写的时候只写新字段
      //   （旧 `dept` 只在读旧文件时兼容）。
      ...(finalGroup ? { group: finalGroup } : {}),
    })
    if (!written.ok) {
      writeConnectionText(this.#connectionPath, previous.text ?? null)
      return { ok: false, reason: written.reason ?? '署名保存失败' }
    }

    return {
      ok: true,
      name: finalName,
      ...(finalGroup ? { group: finalGroup } : {}),
      baseUrl,
    }
  }

  /** `DELETE /api/local/identity` */
  clear(): { ok: boolean } {
    return { ok: clearIdentity(this.#path) }
  }

  /**
   * 读取当前署名，供上报流程使用。
   *
   * ★ 未署名返回 null —— **调用方必须据此停止上报**，
   *   这是「没填之前不采集」约定的落点。
   */
  current() {
    return readIdentity(this.#path).identity
  }

  /** 向部门服务端校验 token。 */
  async #verifyWithPortal(baseUrl: string, token: string): Promise<VerifyTokenResponse> {
    const url = `${baseUrl.replace(/\/+$/, '')}${VERIFY_PATH}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)

    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        // 与插件面板同一取舍：校验请求不允许被重定向到别处（地址是用户输入）。
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const parsed = (await res.json().catch(() => null)) as VerifyTokenResponse | null
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('服务端返回了非预期的响应')
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 从校验响应里取分组名。
 *
 * ⚠️ **必须容忍旧服务端**：迁移期的服务端会同时返回 `group` 与 `dept`（同值，
 *   `dept` 标为「已废弃，仅为兼容」），而**尚未升级**的服务端只返回 `dept`。
 *   只读 `group` 会让后者把分组静默丢掉 —— 不报错，只是那个字段空了。
 *   （与插件 `settings.ts` 的 `verifiedGroup()` 同一口径。）
 */
function verifiedGroup(res: { group?: unknown; dept?: unknown }): string {
  const group = typeof res.group === 'string' ? res.group.trim() : ''
  if (group) return group
  return typeof res.dept === 'string' ? res.dept.trim() : ''
}

function msg(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') {
    // ⚠️ 用真实的超时值：写死成 8s 会在 `verifyTimeoutMs` 被改过之后
    //    对用户说一个错的时间，而这类文案正是排障时被直接引用的东西。
    return `请求超时（${Math.round(timeoutMs / 1000)}s）`
  }
  return err instanceof Error ? err.message : String(err)
}
