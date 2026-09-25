/**
 * 本地身份路由 —— 引导页的读写落点。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | `GET` | `/api/local/identity` | 页面启动时问「填过没」 |
 * | `POST` | `/api/local/identity` | 提交署名（**会向部门服务端校验 token**） |
 * | `DELETE` | `/api/local/identity` | 退出署名 / 换人 |
 *
 * ## 安全约束
 *
 * 1. **GET 绝不返回 token**。页面只需要知道「填没填」和「叫什么」。
 *    把 token 发回浏览器等于让它暴露在 devtools、磁盘缓存与任何 XSS 面前。
 * 2. **POST 必须校验 token 才能落盘**。校验由部门服务端完成；
 *    本地服务不猜「看起来对不对」，避免给出误导性提示。
 * 3. **部门服务端不可达时不落盘**。宁可让用户重试，也不要存下一个
 *    看似成功、实则永不被承认的凭证 —— 那种失败会在几天后才暴露。
 *
 * ## 校验失败的三类提示
 *
 * 服务端返回的 `registered: false` 与「token 无效」必须区分开：
 * 前者是管理员还没发凭证（用户做什么都没用），后者是 token 抄错了（重试有用）。
 * 混为一谈会让用户在完全正确的情况下反复重试。
 */

import { identityPath, readIdentity, writeIdentity, clearIdentity } from '@ai-token-report/core'
import type {
  LocalIdentityResponse,
  LocalIdentitySubmit,
  LocalIdentitySubmitResponse,
  VerifyTokenResponse,
} from '@ai-token-report/shared'

export interface IdentityRouteOptions {
  /** DSH home，用于定位身份文件。 */
  dshHome: string
  /**
   * 部门服务端地址。用于校验 token。
   *
   * ⚠️ 未配置时**只允许本地使用**（页面可看本机统计，但不落盘署名），
   *   因为无法确认「你是谁」，存下来也没有意义。
   */
  portalUrl?: string
  /** 校验请求超时（毫秒）。默认 8 秒。 */
  verifyTimeoutMs?: number
  /** 注入用，便于测试。 */
  fetchImpl?: typeof fetch
}

/** 未署名时的引导文案。集中一处，便于统一措辞。 */
const UNSIGNED_HINT =
  '请填写你的姓名与管理员发放的 token，用于把你的用量归属到部门统计中。' +
  '未填写前不会采集也不会向服务端发送任何数据。'

export class IdentityRoute {
  readonly #dshHome: string
  readonly #portalUrl: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: IdentityRouteOptions) {
    this.#dshHome = options.dshHome
    this.#portalUrl = options.portalUrl
    this.#timeoutMs = options.verifyTimeoutMs ?? 8_000
    this.#fetch = options.fetchImpl ?? fetch
  }

  get #path(): string {
    return identityPath(this.#dshHome)
  }

  /** `GET /api/local/identity` —— 注意返回值里没有 token。 */
  get(): LocalIdentityResponse {
    const { identity } = readIdentity(this.#path)
    if (!identity) {
      return { signed: false, name: null, dept: null, createdAt: null, hint: UNSIGNED_HINT }
    }
    return {
      signed: true,
      name: identity.name,
      dept: identity.dept ?? null,
      createdAt: identity.createdAt,
      hint: null,
    }
  }

  /**
   * `POST /api/local/identity` —— 校验并落盘。
   *
   * 流程：形式校验 → 向部门服务端校验 token → 以**服务端返回的姓名**为准落盘。
   */
  async submit(input: LocalIdentitySubmit): Promise<LocalIdentitySubmitResponse> {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    const dept = typeof input?.dept === 'string' ? input.dept.trim() : ''

    // 形式校验先走一遍，能挡掉明显的误操作（省一次网络往返）
    if (!name) return { ok: false, reason: '请填写你的姓名' }
    if (!token) return { ok: false, reason: '请填写管理员发放的 token' }

    if (!this.#portalUrl) {
      return {
        ok: false,
        reason:
          '未配置部门服务端地址，无法校验 token。' +
          '请联系管理员确认服务端地址，或使用 --portal 参数指定。',
      }
    }

    // ★ 向服务端校验。这一步决定了「你是谁」。
    let verify: VerifyTokenResponse
    try {
      verify = await this.#verifyWithPortal(token)
    } catch (err) {
      // 网络失败 → 不落盘。宁可让用户重试，也不存一个永不被承认的凭证。
      return {
        ok: false,
        reason: `无法连接部门服务端校验 token：${msg(err, this.#timeoutMs)}。请稍后重试。`,
      }
    }

    if (!verify.ok) {
      return { ok: false, reason: verify.reason ?? 'token 校验未通过' }
    }

    // ★ 以服务端认定的姓名为准，不采信客户端提交的 name。
    //   name 不一致通常是员工打字差异（「张三 」vs「张三」），
    //   这里直接以服务端为准，不打断流程，但可以让用户看到最终生效的姓名。
    const finalName = verify.name ?? name
    const finalDept = verify.dept ?? (dept || undefined)

    const written = writeIdentity(this.#path, {
      name: finalName,
      token,
      ...(finalDept ? { dept: finalDept } : {}),
    })
    if (!written.ok) {
      return { ok: false, reason: written.reason }
    }

    return {
      ok: true,
      name: finalName,
      ...(finalDept ? { dept: finalDept } : {}),
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
  async #verifyWithPortal(token: string): Promise<VerifyTokenResponse> {
    const url = `${this.#portalUrl!.replace(/\/+$/, '')}/api/v1/identity/verify`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)

    try {
      const res = await this.#fetch(url, {
        method: 'POST',
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

function msg(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') {
    // ⚠️ 用真实的超时值：写死成 8s 会在 `verifyTimeoutMs` 被改过之后
    //    对用户说一个错的时间，而这类文案正是排障时被直接引用的东西。
    return `请求超时（${Math.round(timeoutMs / 1000)}s）`
  }
  return err instanceof Error ? err.message : String(err)
}