/**
 * 服务端凭证表 —— 「这个 token 是谁的」的唯一权威来源。
 *
 * ## 为什么身份判定必须在服务端
 *
 * 用户在自己机器上填「姓名 + token」。如果服务端直接采信客户端声明的姓名，
 * 那么任何人改一下本地配置就能以他人名义上报，部门看板的数据立刻失去意义。
 *
 * 所以：**客户端只提交 token，姓名由服务端查表得出。**
 * 客户端提交的 name 仅用于「和凭证登记的姓名是否一致」的提示，
 * 不一致时以服务端为准并给出警告（多数情况是员工填错了字）。
 *
 * ## 凭证从哪来
 *
 * 管理员在服务端启动前放置凭证文件。两种格式都支持：
 *
 * ```jsonc
 * // credentials.json —— 推荐：一 token 一人
 * [
 *   { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" },
 *   { "token": "atr-lisi-a17b",     "name": "李四", "dept": "研发二部" }
 * ]
 * ```
 *
 * 也可用更简单的「姓名 → token」映射：
 *
 * ```jsonc
 * { "张三": "atr-zhangsan-9f3c" }
 * ```
 *
 * 路径：`ATR_CREDENTIALS` 环境变量，或 `<dbDir>/credentials.json`。
 *
 * ## 未配置凭证时
 *
 * 返回 `registered: false`，让本地服务能给出**准确**的提示
 * （「请让管理员先发放 token」）而不是含糊的「token 无效」——
 * 后者会让用户在完全正确的情况下反复重试。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 一条凭证。 */
export interface Credential {
  token: string
  name: string
  dept?: string
}

/** 校验结果。 */
export interface VerifyResult {
  ok: boolean
  /** token 对应的姓名。**由服务端决定，客户端不可覆盖**。 */
  name?: string
  dept?: string
  /** 服务端是否已配置任何凭证。 */
  registered: boolean
  /** 失败原因，可直接展示给用户。 */
  reason?: string
}

/**
 * 凭证表。
 *
 * 用 Map 做 O(1) 查找。注意：**明文比对 token**。
 * 内网部门工具不引入哈希，因为凭证明文必须能从文件恢复（管理员要发给员工），
 * 哈希带来的安全性提升有限，却让「补发 token」变得麻烦。
 * 若将来需要，可在这一层加哈希而不影响调用方。
 */
export class CredentialStore {
  #byToken = new Map<string, Credential>()

  private constructor(creds: Credential[]) {
    for (const c of creds) this.#byToken.set(c.token, c)
  }

  /** 已登记的凭证数量。 */
  get size(): number {
    return this.#byToken.size
  }

  /** 是否已配置任何凭证。 */
  get registered(): boolean {
    return this.#byToken.size > 0
  }

  /**
   * 校验一个 token。
   *
   * ★ 这是身份可信边界的落点：**通过即为该 token 绑定的那个人**，
   *   调用方不得用客户端提交的姓名覆盖返回值里的 `name`。
   */
  verify(token: string): VerifyResult {
    if (!this.registered) {
      return {
        ok: false,
        registered: false,
        reason: '服务端尚未配置任何凭证，请让管理员先发放 token',
      }
    }

    const t = token.trim()
    if (!t) {
      return { ok: false, registered: true, reason: 'token 不能为空' }
    }

    const cred = this.#byToken.get(t)
    if (!cred) {
      return { ok: false, registered: true, reason: 'token 无效，请向管理员确认' }
    }

    return {
      ok: true,
      registered: true,
      name: cred.name,
      ...(cred.dept ? { dept: cred.dept } : {}),
    }
  }

  /** 按姓名查凭证（仅用于排查，不参与身份判定）。 */
  findByName(name: string): Credential | undefined {
    for (const c of this.#byToken.values()) {
      if (c.name === name) return c
    }
    return undefined
  }

  /** 列出全部凭证（管理用途）。 */
  list(): Credential[] {
    return [...this.#byToken.values()]
  }

  /** 从数组构造。 */
  static from(creds: Credential[]): CredentialStore {
    return new CredentialStore(creds)
  }

  /** 空表。 */
  static empty(): CredentialStore {
    return new CredentialStore([])
  }

  /**
   * 从文件加载。
   *
   * ★ 解析失败**不抛错**，而是返回空表并附带原因。
   *   服务端不能因为一份凭证文件写错就起不来 —— 那会让已经署名的员工
   *   全部失效，故障面被放大。宁可以「未配置」状态启动并告警。
   */
  static load(path: string): { store: CredentialStore; error?: string } {
    if (!existsSync(path)) {
      return { store: CredentialStore.empty() }
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      return { store: CredentialStore.empty(), error: `读取凭证文件失败: ${msg(err)}` }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { store: CredentialStore.empty(), error: '凭证文件不是合法 JSON' }
    }

    const creds = parseCredentials(parsed)
    if (!creds) {
      return {
        store: CredentialStore.empty(),
        error: '凭证文件格式不对：应为 [{token,name,dept}] 数组，或 {姓名: token} 映射',
      }
    }

    return { store: CredentialStore.from(creds) }
  }
}

/** 解析两种支持的凭证格式，失败返回 null。 */
function parseCredentials(value: unknown): Credential[] | null {
  // 格式一：数组
  if (Array.isArray(value)) {
    const out: Credential[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const token = typeof o['token'] === 'string' ? o['token'].trim() : ''
      const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
      if (!token || !name) return null
      const dept = typeof o['dept'] === 'string' && o['dept'].trim() ? o['dept'].trim() : undefined
      out.push({ token, name, ...(dept ? { dept } : {}) })
    }
    return out
  }

  // 格式二：{ 姓名: token }
  if (value && typeof value === 'object') {
    const out: Credential[] = []
    for (const [name, token] of Object.entries(value as Record<string, unknown>)) {
      if (typeof token !== 'string' || !token.trim() || !name.trim()) return null
      out.push({ token: token.trim(), name: name.trim() })
    }
    return out
  }

  return null
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}