/**
 * 服务端凭证表 —— 「这个 token 是谁的、他是什么角色」的唯一权威来源。
 *
 * ## 为什么身份判定必须在服务端
 *
 * 用户在自己机器上填「姓名 + token」。如果服务端直接采信客户端声明的姓名，
 * 那么任何人改一下本地配置就能以他人名义上报，部门看板的数据立刻失去意义。
 *
 * 所以：**客户端只提交 token，姓名与角色由服务端查表得出。**
 * 客户端提交的 name 仅用于「和凭证登记的姓名是否一致」的提示，
 * 不一致时以服务端为准并给出警告（多数情况是员工填错了字）。
 *
 * ## 凭证从哪来
 *
 * 三个来源，优先级与用途各不相同：
 *
 * | 来源 | 谁写 | 用途 |
 * |---|---|---|
 * | `credentials.json` 手工维护 | 管理员手工编辑 | 首次铺开（含第一个管理员） |
 * | `credentials.json` 管理页签发 | 服务端（`member-admin.ts`） | 日常发放 / 重置 / 吊销 |
 * | `ATR_ADMIN_TOKEN` 环境变量 | 部署配置 | 兜底：文件为空或只读时也能进管理页 |
 *
 * 文件两种格式都支持：
 *
 * ```jsonc
 * // credentials.json —— 推荐：一 token 一人
 * [
 *   { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" },
 *   { "token": "atr-lisi-a17b", "name": "李四", "role": "admin" }
 * ]
 * ```
 *
 * 也可用更简单的「姓名 → token」映射（该格式下所有人都是普通成员）：
 *
 * ```jsonc
 * { "张三": "atr-zhangsan-9f3c" }
 * ```
 *
 * 路径由调用方决定（`ServerOptions.credentialsPath` / `--credentials` 旗标），
 * 默认 `<dshHome>/token-report/credentials.json`。
 *
 * ⚠️ **这里没有 `ATR_CREDENTIALS` 环境变量**（旧注释提过它，但代码从未读取）：
 *   本模块只负责「把一段 JSON 解析成凭证表」，路径与来源都不归它管。
 *   部署期唯一被读取的环境变量是冷启动用的 `ATR_ADMIN_TOKEN` / `ATR_ADMIN_NAME`
 *   （见 `member-admin.ts` 的 `envAdminFrom`）。
 *
 * ## 🚨 角色是权限的唯一来源
 *
 * `role` 缺省为 `member`。**绝不要**用姓名白名单判断管理员：
 * 姓名是可以随时改的显示值，而 `role` 只由管理员在管理页或文件里设置。
 *
 * ## 未配置凭证时
 *
 * 返回 `registered: false`，让本地服务能给出**准确**的提示
 * （「请让管理员先发放 token」）而不是含糊的「token 无效」——
 * 后者会让用户在完全正确的情况下反复重试。
 *
 * ## ★ 这个类只负责「读」与「查」
 *
 * 落盘、签发、吊销都在 `member-admin.ts`。凭证表本身保持**可随时整体替换**
 * （`replaceAll`）的纯内存结构，这样「文件是唯一真值、内存是它的镜像」
 * 这条关系不会被写成两套各改一半的代码。
 */

import { existsSync, readFileSync } from 'node:fs'

import {
  isUserRole,
  ROLE_MEMBER,
  type CredentialSource,
  type UserRole,
} from '@ai-token-report/shared'

/**
 * 一条凭证的**输入形态**。
 *
 * 所有可选字段都由 {@link CredentialStore} 归一化：调用方（包括测试与手工
 * 构造）不必关心 `role` / `source` 的缺省值，只在一个地方补齐。
 */
export interface CredentialInput {
  token: string
  name: string
  /** 后台登录账号与哈希；缺失时仍可上报，但不能密码登录。 */
  username?: string
  passwordHash?: string
  dept?: string
  /** 缺省 = {@link ROLE_MEMBER}。 */
  role?: UserRole
  /** token 发放时刻（epoch ms）。 */
  createdAt?: number
  /** 缺省 = `'file'`。 */
  source?: CredentialSource
}

/** 归一化之后的一条凭证（`role` / `source` 必填）。 */
export interface Credential {
  token: string
  name: string
  username?: string
  passwordHash?: string
  dept?: string
  role: UserRole
  createdAt?: number
  source: CredentialSource
}

/** 校验结果。 */
export interface VerifyResult {
  ok: boolean
  /** token 对应的姓名。**由服务端决定，客户端不可覆盖**。 */
  name?: string
  dept?: string
  /**
   * token 对应的角色。校验失败时不返回 —— 调用方据此判断「这个人能不能进管理页」。
   *
   * 🚨 消费方在字段缺失时必须按 `member` 处理，绝不能默认成管理员。
   */
  role?: UserRole
  /** 服务端是否已配置任何凭证。 */
  registered: boolean
  /** 失败原因，可直接展示给用户。 */
  reason?: string
}

/** 凭证文件的解析结果（读取与解析的全部出口）。 */
export interface ParsedCredentialFile {
  entries: CredentialInput[]
  /** 文件是否存在。 */
  exists: boolean
  /** 解析失败的原因。**服务端照常启动**，只是管理页不能写这个文件。 */
  error?: string
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

  private constructor(creds: CredentialInput[], defaultSource: CredentialSource) {
    for (const c of creds) {
      const cred = normalizeCredential(c, defaultSource)
      this.#byToken.set(cred.token, cred)
    }
  }

  /** 已登记的凭证数量。 */
  get size(): number {
    return this.#byToken.size
  }

  /** 是否已配置任何凭证。 */
  get registered(): boolean {
    return this.#byToken.size > 0
  }

  /** 管理员数量。用于「最后一个管理员不能删」与启动提示。 */
  get adminCount(): number {
    let n = 0
    for (const c of this.#byToken.values()) if (c.role === 'admin') n += 1
    return n
  }

  /**
   * 校验一个 token。
   *
   * ★ 这是身份可信边界的落点：**通过即为该 token 绑定的那个人**，
   *   调用方不得用客户端提交的姓名覆盖返回值里的 `name`，
   *   也不得用客户端提交的任何字段决定 `role`。
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
      role: cred.role,
      ...(cred.dept ? { dept: cred.dept } : {}),
    }
  }

  /** 按姓名查凭证（仅用于排查与重名检查，不参与身份判定）。 */
  findByName(name: string): Credential | undefined {
    const wanted = name.trim()
    for (const c of this.#byToken.values()) {
      if (c.name === wanted) return c
    }
    return undefined
  }

  /** 按 token 查凭证（管理页定位用）。 */
  findByToken(token: string): Credential | undefined {
    return this.#byToken.get(token.trim())
  }

  /** 账号必须唯一；手工配置重复时拒绝登录，不能任意认成其中一人。 */
  findByUsername(username: string): Credential | undefined {
    const matches = this.list().filter((c) => c.username === username.trim().toLowerCase())
    return matches.length === 1 ? matches[0] : undefined
  }

  /** 列出全部凭证（管理用途）。顺序 = 插入顺序。 */
  list(): Credential[] {
    return [...this.#byToken.values()]
  }

  /**
   * 用一份新的凭证集合**整体替换**内存镜像。
   *
   * ★ 管理页每次落盘成功后调它。之所以是「整体替换」而不是 add/remove：
   *   文件是唯一真值，内存只是镜像 —— 增量修改会让两者有分叉的可能，
   *   而分叉的表现是「重启后某个 token 突然不能用了」。
   */
  replaceAll(creds: CredentialInput[], defaultSource: CredentialSource = 'file'): void {
    const next = new Map<string, Credential>()
    for (const c of creds) {
      const cred = normalizeCredential(c, defaultSource)
      next.set(cred.token, cred)
    }
    this.#byToken = next
  }

  /** 从数组构造。 */
  static from(creds: CredentialInput[], defaultSource: CredentialSource = 'file'): CredentialStore {
    return new CredentialStore(creds, defaultSource)
  }

  /** 空表。 */
  static empty(): CredentialStore {
    return new CredentialStore([], 'file')
  }

  /**
   * 从文件加载。
   *
   * ★ 解析失败**不抛错**，而是返回空表并附带原因。
   *   服务端不能因为一份凭证文件写错就起不来 —— 那会让已经署名的员工
   *   全部失效，故障面被放大。宁可以「未配置」状态启动并告警。
   *
   * ⚠️ 只读，不落盘。需要「能写」的那一套请用 `loadMembers()`
   *   （`member-admin.ts`），它同时负责拒绝覆盖不可解析的文件。
   */
  static load(path: string): { store: CredentialStore; error?: string } {
    const parsed = parseCredentialFile(path)
    return {
      store: CredentialStore.from(parsed.entries),
      ...(parsed.error ? { error: parsed.error } : {}),
    }
  }
}

/** 归一化：补上 role / source，并丢弃字段不全的条目。 */
function normalizeCredential(input: CredentialInput, defaultSource: CredentialSource): Credential {
  const dept = input.dept?.trim()
  return {
    token: input.token.trim(),
    name: input.name.trim(),
    ...(input.username ? { username: input.username.trim().toLowerCase() } : {}),
    ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
    ...(dept ? { dept } : {}),
    role: isUserRole(input.role) ? input.role : ROLE_MEMBER,
    ...(typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
      ? { createdAt: input.createdAt }
      : {}),
    source: input.source ?? defaultSource,
  }
}

/**
 * 读取并解析凭证文件。
 *
 * ★ 这是**唯一**的解析实现：`CredentialStore.load()`（只读场景）与
 *   `MemberAdmin`（要写回文件）共用它。两份解析迟早会漂移，
 *   而漂移的表现是「管理页看到的人比实际上报能用的人少一个」。
 */
export function parseCredentialFile(path: string): ParsedCredentialFile {
  if (!existsSync(path)) {
    return { entries: [], exists: false }
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { entries: [], exists: true, error: `读取凭证文件失败: ${msg(err)}` }
  }

  // 空文件视为「还没配过」而不是损坏 —— 手工建空文件是常见的起手式
  if (!raw.trim()) {
    return { entries: [], exists: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], exists: true, error: '凭证文件不是合法 JSON' }
  }

  const entries = parseCredentials(parsed)
  if (!entries) {
    return {
      entries: [],
      exists: true,
      error: '凭证文件格式不对：应为 [{token,name,dept,role}] 数组，或 {姓名: token} 映射',
    }
  }

  return { entries, exists: true }
}

/** 解析两种支持的凭证格式，失败返回 null。 */
function parseCredentials(value: unknown): CredentialInput[] | null {
  // 格式一：数组
  if (Array.isArray(value)) {
    const out: CredentialInput[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const token = typeof o['token'] === 'string' ? o['token'].trim() : ''
      const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
      if (!token || !name) return null
      const dept = typeof o['dept'] === 'string' && o['dept'].trim() ? o['dept'].trim() : undefined
      // ⚠️ 非法角色值**降级为 member**而不是整份文件解析失败：
      //   一个人写错 role 不该让全部门的 token 集体失效。
      const role = isUserRole(o['role']) ? o['role'] : undefined
      const createdAt = typeof o['createdAt'] === 'number' ? o['createdAt'] : undefined
      out.push({
        token,
        name,
        ...(dept ? { dept } : {}),
        ...(role ? { role } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(typeof o['username'] === 'string' ? { username: o['username'].trim().toLowerCase() } : {}),
        ...(typeof o['passwordHash'] === 'string' ? { passwordHash: o['passwordHash'] } : {}),
      })
    }
    return out
  }

  // 格式二：{ 姓名: token }
  if (value && typeof value === 'object') {
    const out: CredentialInput[] = []
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
