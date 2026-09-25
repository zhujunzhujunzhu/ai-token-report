/**
 * 人员管理与 token 发放 —— 管理页背后的**唯一写入凭证文件的通路**。
 *
 * ## 为什么需要它
 *
 * 在此之前凭证文件只由管理员手工维护（ARCHITECTURE.md §7 待决项 6）。
 * 手工维护的代价随着人数增长迅速变大：新人入职要手写一行 JSON、
 * 有人 token 泄露要手工改一行、查「谁还没发」要人肉比对。
 * 这个模块把这三件事变成管理页上的三个按钮。
 *
 * ## ★ 一条铁律：**文件是唯一真值，内存只是它的镜像**
 *
 * 顺序永远是「先落盘，再整体替换内存镜像」（`CredentialStore.replaceAll`）：
 *
 * ```
 * 校验 → 组装 nextFile → 原子写文件 → 成功后才 replaceAll
 * ```
 *
 * 反过来（先改内存再写文件）会出现「页面里 token 能用、重启后消失」，
 * 而使用者只会认为「系统有时会抽风」。落盘失败时内存保持原样，
 * 页面拿到明确的失败原因 —— 这比一个会回滚的乐观更新诚实得多。
 *
 * ## 🚨 拒绝覆盖「读不懂」的凭证文件
 *
 * 文件存在但解析失败时（手写时漏了个逗号、被别的工具改坏），
 * **一切写入都拒绝**并给出原因。若按内存里的空表覆盖，
 * 结果是全员 token 被静默吊销 —— 这与「上报库绝不自动重建」
 * （AGENTS.md）是同一类事故：用一份空数据覆盖唯一真值。
 *
 * ## 三条业务护栏
 *
 * | 护栏 | 不加会怎样 |
 * |---|---|
 * | **姓名唯一** | 两个人同名 → 看板按姓名分组，用量被并成一个人（数据错误，且看不出来） |
 * | **最后一个管理员不可删/不可降级** | 一次误操作后所有人都无法再发放 token，只能改文件恢复 |
 * | **环境变量注入的管理员不可改** | 页面上的「删除」对它是无效的（重启就回来），会造成「删了还在」的困惑 |
 */

import { randomBytes } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  isUserRole,
  ROLE_ADMIN,
  ROLE_MEMBER,
  UNATTRIBUTED_USER,
  validateName,
  type AdminMember,
  type UserRole,
} from '@ai-token-report/shared'

import {
  CredentialStore,
  parseCredentialFile,
  type Credential,
  type CredentialInput,
} from './credentials.js'
import { hashPassword, normalizeUsername, usernameError, passwordError } from './auth/password.js'

/** token 前缀。与 README/skill 里的示例格式（`atr-zhangsan-9f3c`）一致，便于人眼识别。 */
const TOKEN_PREFIX = 'atr-'
/** 随机部分的字节数：8 字节 = 64 bit，内网工具足够（撞库无收益，且 token 离不开内网）。 */
const TOKEN_RANDOM_BYTES = 8
/** 生成 token 时允许的重试次数。撞上 20 次说明随机源坏了，不是运气问题。 */
const TOKEN_ATTEMPTS = 20
/** 部门名长度上限（比姓名宽松，但要拦住误粘贴整段文本）。 */
const DEPT_MAX_LENGTH = 64

/** 环境变量注入管理员用的变量名。 */
export const ENV_ADMIN_TOKEN = 'ATR_ADMIN_TOKEN'
export const ENV_ADMIN_NAME = 'ATR_ADMIN_NAME'

/**
 * 从环境变量读一个管理员凭证。
 *
 * ★ 这是**冷启动兜底**：凭证文件为空（全新部署）或只读（配置由编排系统挂载）时，
 *   没有它就没有任何人能进管理页，管理页的第一件事恰恰是「发放第一个 token」。
 *   一个死锁。
 *
 * ⚠️ 它注入的凭证**不落文件**：环境变量是部署期配置，
 *   写进文件等于把部署秘密复制到磁盘的另一处，删除时还会两处不一致。
 */
export function envAdminFrom(
  env: Record<string, string | undefined> = process.env,
): CredentialInput | null {
  const token = env[ENV_ADMIN_TOKEN]?.trim()
  if (!token) return null
  const name = env[ENV_ADMIN_NAME]?.trim()
  return {
    token,
    name: name || '管理员',
    role: ROLE_ADMIN,
    source: 'env',
  }
}

/** 人员管理操作的结果。业务失败（重名、最后一个管理员……）走 `ok:false`。 */
export interface MemberResult {
  ok: boolean
  reason?: string
  member?: AdminMember
}

/** 凭证文件状态（管理页据此显示「能不能改」）。 */
export interface StorageInfo {
  credentialsPath: string
  writable: boolean
  writeBlockedReason: string | null
}

/** 加载结果：一个已就绪的管理服务 + 它的凭证表（两者共享同一份数据）。 */
export interface LoadedMembers {
  admin: MemberAdmin
  /** ★ 与 `admin` 共享同一个实例：上报与看板立刻认新签发的 token。 */
  store: CredentialStore
  /** 凭证文件解析失败的原因（服务端照常启动，只是管理页拒绝写入）。 */
  fileError?: string
}

/**
 * 加载凭证文件 + 环境变量管理员，构造管理服务。
 *
 * ⚠️ **服务端只该有一个 `CredentialStore` 实例**：`IngestRoute` / `StatsRoute` /
 *   `AdminRoute` 都拿同一个引用。若各处各建一份，管理页签发的 token
 *   要等到重启才能上报 —— 而那时管理员已经把它发给员工了。
 */
export function loadMembers(options: {
  credentialsPath: string
  /** 环境变量注入的管理员。缺省不注入。 */
  envAdmin?: CredentialInput | null
}): LoadedMembers {
  const parsed = parseCredentialFile(options.credentialsPath)
  const envAdmins: CredentialInput[] = options.envAdmin
    ? [{ ...options.envAdmin, role: options.envAdmin.role ?? ROLE_ADMIN, source: 'env' }]
    : []

  const store = CredentialStore.from([...parsed.entries, ...envAdmins])
  const admin = new MemberAdmin({
    store,
    credentialsPath: options.credentialsPath,
    fileEntries: parsed.entries,
    ...(parsed.error ? { fileError: parsed.error } : {}),
  })

  return {
    admin,
    store,
    ...(parsed.error ? { fileError: parsed.error } : {}),
  }
}

export interface MemberAdminOptions {
  store: CredentialStore
  credentialsPath: string
  /** 文件里的条目（不含环境变量注入的那些）。 */
  fileEntries: CredentialInput[]
  /** 文件当前不可解析的原因。有值时拒绝一切写入。 */
  fileError?: string
}

export class MemberAdmin {
  readonly #store: CredentialStore
  readonly #credentialsPath: string
  /** ★ 只装**文件里**的条目：环境变量注入的管理员不在这里，因此永远不会被写回文件。 */
  #file: CredentialInput[]
  readonly #fileError: string | undefined

  constructor(options: MemberAdminOptions) {
    this.#store = options.store
    this.#credentialsPath = options.credentialsPath
    this.#file = options.fileEntries.map((e) => ({ ...e, source: 'file' }))
    this.#fileError = options.fileError
  }

  /** 凭证文件状态。 */
  storage(): StorageInfo {
    if (this.#fileError) {
      return {
        credentialsPath: this.#credentialsPath,
        writable: false,
        writeBlockedReason: `凭证文件无法解析（${this.#fileError}），已禁止写入以免覆盖已有凭证`,
      }
    }
    if (!canWrite(this.#credentialsPath)) {
      return {
        credentialsPath: this.#credentialsPath,
        writable: false,
        writeBlockedReason: '凭证文件所在目录不可写，请检查文件权限（或改用 ATR_ADMIN_TOKEN 部署）',
      }
    }
    return { credentialsPath: this.#credentialsPath, writable: true, writeBlockedReason: null }
  }

  /**
   * 人员列表。
   *
   * 排序：管理员在前，其余按姓名排。**管理员在前**是因为「谁能发 token」
   * 是这一页最需要一眼确认的信息。
   */
  list(): AdminMember[] {
    return this.#store
      .list()
      .map(toAdminMember)
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === ROLE_ADMIN ? -1 : 1
        return a.name.localeCompare(b.name, 'zh')
      })
  }

  /** 签发一个新 token。 */
  issue(input: { name: string; dept?: string; role?: UserRole }): MemberResult {
    const name = input.name.trim()
    const nameCheck = validateName(name)
    if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason }

    // `unknown` 是协议里的「未归属」键（UNATTRIBUTED_USER）。一个人真叫这个名字，
    // 看板上他的用量会与「未署名」那一组合并 —— 无法分辨，所以直接拒绝。
    if (name === UNATTRIBUTED_USER) {
      return { ok: false, reason: `姓名不能是「${UNATTRIBUTED_USER}」：它是看板上「未署名」的保留键` }
    }

    const conflict = this.#store.findByName(name)
    if (conflict) {
      return {
        ok: false,
        reason: `已存在同名人员「${name}」：同名会让看板把两个人的用量并成一个人，请加区分（如「${name}（研发）」）`,
      }
    }

    const dept = checkDept(input.dept)
    if ('error' in dept) return { ok: false, reason: dept.error }

    const role = normalizeRole(input.role)
    if ('error' in role) return { ok: false, reason: role.error }

    const token = this.#generateToken()
    if (!token) return { ok: false, reason: 'token 生成失败（随机源异常），请重试' }

    const entry: CredentialInput = {
      token,
      name,
      ...(dept.value ? { dept: dept.value } : {}),
      role: role.value,
      createdAt: Date.now(),
      source: 'file',
    }

    const saved = this.#persist([...this.#file, entry])
    if (!saved.ok) return { ok: false, reason: saved.reason }

    return { ok: true, member: toAdminMember(this.#store.findByToken(token)!) }
  }

  /** 修改姓名 / 部门 / 角色。token 不变（改姓名不该让本人重填 token）。 */
  update(input: {
    token: string
    name?: string
    dept?: string
    role?: UserRole
  }): MemberResult {
    const located = this.#locate(input.token)
    if ('error' in located) return { ok: false, reason: located.error }
    const { index, entry } = located

    let name = entry.name
    if (input.name !== undefined) {
      name = input.name.trim()
      const nameCheck = validateName(name)
      if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason }
      if (name === UNATTRIBUTED_USER) {
        return { ok: false, reason: `姓名不能是「${UNATTRIBUTED_USER}」：它是看板上「未署名」的保留键` }
      }
      // 排除自己：把「张三」改成「张三」（或只改大小写空白）不该报重名
      const conflict = this.#store.findByName(name)
      if (conflict && conflict.token !== entry.token) {
        return {
          ok: false,
          reason: `已存在同名人员「${name}」：同名会让看板把两个人的用量并成一个人`,
        }
      }
    }

    let dept = entry.dept
    if (input.dept !== undefined) {
      const checked = checkDept(input.dept)
      if ('error' in checked) return { ok: false, reason: checked.error }
      dept = checked.value
    }

    let role = entry.role ?? ROLE_MEMBER
    if (input.role !== undefined) {
      const checked = normalizeRole(input.role)
      if ('error' in checked) return { ok: false, reason: checked.error }
      role = checked.value
    }

    // ★ 最后一个管理员不能降级：否则没人能再进管理页发 token
    if (entry.role === ROLE_ADMIN && role !== ROLE_ADMIN && this.#store.adminCount <= 1) {
      return {
        ok: false,
        reason: '这是最后一个管理员，不能降级为普通成员：否则将没有人能再发放 token',
      }
    }

    const next = [...this.#file]
    next[index] = {
      ...entry,
      name,
      ...(dept ? { dept } : {}),
      role,
      source: 'file',
    }
    // dept 传空串 = 清除，必须显式删掉旧字段（展开 `...entry` 会把它带回来）
    if (!dept) delete (next[index] as { dept?: string }).dept

    const saved = this.#persist(next)
    if (!saved.ok) return { ok: false, reason: saved.reason }

    return { ok: true, member: toAdminMember(this.#store.findByToken(entry.token)!) }
  }

  /**
   * 重置 token：同一个人的新凭证，旧 token 立即失效。
   *
   * 用途是「token 可能泄露了」与「本人换机器重填失败」。
   * 姓名/部门/角色全部保留 —— 重置的是凭证，不是身份。
   */
  rotate(input: { token: string }): MemberResult {
    const located = this.#locate(input.token)
    if ('error' in located) return { ok: false, reason: located.error }
    const { index, entry } = located

    const token = this.#generateToken()
    if (!token) return { ok: false, reason: 'token 生成失败（随机源异常），请重试' }

    const next = [...this.#file]
    next[index] = { ...entry, token, createdAt: Date.now(), source: 'file' }

    const saved = this.#persist(next)
    if (!saved.ok) return { ok: false, reason: saved.reason }

    return { ok: true, member: toAdminMember(this.#store.findByToken(token)!) }
  }

  /** 密码哈希完成后重新定位最新镜像，避免异步期间的其他管理操作被覆盖。 */
  async setLogin(input: { token: string; username: string; password: string }): Promise<MemberResult> {
    const error = usernameError(input.username) ?? passwordError(input.password)
    if (error) return { ok: false, reason: error }
    const passwordHash = await hashPassword(input.password)
    const located = this.#locate(input.token)
    if ('error' in located) return { ok: false, reason: located.error }
    const username = normalizeUsername(input.username)
    if (this.#store.list().some((c) => c.username === username && c.token !== input.token)) {
      return { ok: false, reason: '该用户名已被使用，请换一个用户名' }
    }
    const next = [...this.#file]
    next[located.index] = { ...located.entry, username, passwordHash }
    const saved = this.#persist(next)
    if (!saved.ok) return saved
    return { ok: true, member: toAdminMember(this.#store.findByToken(input.token)!) }
  }

  /** 吊销：从凭证表里移除。他此后无法上报，也无法打开看板。 */
  revoke(input: { token: string }): MemberResult {
    const located = this.#locate(input.token)
    if ('error' in located) return { ok: false, reason: located.error }
    const { index, entry } = located

    if (entry.role === ROLE_ADMIN && this.#store.adminCount <= 1) {
      return {
        ok: false,
        reason: '这是最后一个管理员，不能删除：否则将没有人能再发放 token',
      }
    }

    const next = this.#file.filter((_, i) => i !== index)
    const saved = this.#persist(next)
    if (!saved.ok) return { ok: false, reason: saved.reason }

    // 已删除的人没有「member」可回显，但调用方需要知道被删的是谁
    return { ok: true, member: toAdminMember({ ...entry, role: entry.role ?? ROLE_MEMBER, source: 'file' }) }
  }

  /**
   * 定位一个**文件里**的条目。
   *
   * 环境变量注入的管理员走单独文案：对它执行「删除/重置」在页面上看起来
   * 什么都不会发生（重启就回来了），必须告诉管理员改哪里。
   */
  #locate(token: string): { index: number; entry: CredentialInput } | { error: string } {
    const t = token.trim()
    const index = this.#file.findIndex((e) => e.token === t)
    if (index >= 0) return { index, entry: this.#file[index]! }

    const inStore = this.#store.findByToken(t)
    if (inStore?.source === 'env') {
      return {
        error: `该 token 来自环境变量 ${ENV_ADMIN_TOKEN}，不在这里维护：请在部署配置里更换它`,
      }
    }
    if (inStore) {
      // 只可能出现在「文件被外部改动但服务未重启」时；提示重启而不是静默失败
      return { error: '该 token 不在当前凭证文件里（文件可能被手工改过），请重启服务端后再试' }
    }
    return { error: '未找到该 token 对应的人员' }
  }

  /**
   * 落盘并整体替换内存镜像。
   *
   * 🚨 顺序不可颠倒，理由见文件头「文件是唯一真值」。
   */
  #persist(next: CredentialInput[]): { ok: true } | { ok: false; reason: string } {
    if (this.#fileError) {
      return {
        ok: false,
        reason:
          `凭证文件当前无法解析（${this.#fileError}），已拒绝写入以免覆盖已有凭证。` +
          `请先修复或移走 ${this.#credentialsPath} 后重启服务端。`,
      }
    }

    try {
      mkdirSync(dirname(this.#credentialsPath), { recursive: true })

      // 原子写入：先写临时文件再 rename，避免写一半被杀死留下截断的 JSON
      const tmp = `${this.#credentialsPath}.tmp-${process.pid}`
      writeFileSync(tmp, serializeCredentials(next), 'utf8')

      // POSIX 权限收窄到仅本人可读写（文件含全员 token）。Windows 上 chmod 是 no-op。
      try {
        chmodSync(tmp, 0o600)
      } catch {
        /* Windows 无此语义，忽略 */
      }

      renameSync(tmp, this.#credentialsPath)
    } catch (err) {
      return { ok: false, reason: `写入凭证文件失败: ${msg(err)}` }
    }

    this.#file = next.map((e) => ({ ...e, source: 'file' as const }))
    // 内存镜像是「文件条目 + 环境变量管理员」的并集
    this.#store.replaceAll([
      ...this.#file,
      ...this.#store.list().filter((m) => m.source === 'env'),
    ])
    return { ok: true }
  }

  /** 生成一个不与现有 token 冲突的新 token。 */
  #generateToken(): string | null {
    const used = new Set(this.#store.list().map((c) => c.token))
    for (let i = 0; i < TOKEN_ATTEMPTS; i++) {
      const token = TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('hex')
      if (!used.has(token)) return token
    }
    return null
  }
}

/** 凭证 → 管理层展示形态。 */
function toAdminMember(c: Credential): AdminMember {
  return {
    username: c.username ?? null,
    login_enabled: !!(c.username && c.passwordHash),
    token: c.token,
    name: c.name,
    dept: c.dept ?? null,
    role: c.role,
    createdAt: c.createdAt ?? null,
    source: c.source,
  }
}

/** 校验部门名。返回 `{ value }`（空串表示清除）或 `{ error }`。 */
function checkDept(raw: string | undefined): { value: string } | { error: string } {
  const dept = raw?.trim() ?? ''
  if (dept.length > DEPT_MAX_LENGTH) {
    return { error: `部门名过长（最多 ${DEPT_MAX_LENGTH} 个字符）` }
  }
  if (/[\r\n\t]/.test(raw ?? '')) {
    return { error: '部门名不能包含换行或制表符' }
  }
  return { value: dept }
}

/** 校验角色。缺省 = 普通成员（**绝不能**缺省成管理员）。 */
function normalizeRole(raw: UserRole | undefined): { value: UserRole } | { error: string } {
  if (raw === undefined) return { value: ROLE_MEMBER }
  if (!isUserRole(raw)) return { error: `未知角色「${String(raw)}」，只支持 admin / member` }
  return { value: raw }
}

/**
 * 序列化成凭证文件内容（数组格式）。
 *
 * ⚠️ `member` 的 `role` 字段**不写进文件**：缺省就是普通成员，
 *   写出来只会让手工维护的文件更长，也更容易在手工编辑时写错。
 *   `source` 同理不写 —— 它是运行期概念，不是配置。
 */
function serializeCredentials(entries: CredentialInput[]): string {
  const out = entries.map((e) => {
    const token = e.token.trim()
    const name = e.name.trim()
    const dept = e.dept?.trim()
    return {
      token,
      name,
      ...(dept ? { dept } : {}),
      ...(e.role === ROLE_ADMIN ? { role: ROLE_ADMIN } : {}),
      ...(typeof e.createdAt === 'number' ? { createdAt: e.createdAt } : {}),
      ...(e.username ? { username: e.username } : {}),
      ...(e.passwordHash ? { passwordHash: e.passwordHash } : {}),
    }
  })
  return JSON.stringify(out, null, 2) + '\n'
}

/**
 * 凭证文件所在目录是否可写。
 *
 * 目录还不存在时向上找第一个存在的祖先 —— `#persist` 会 `mkdirSync` 建出来，
 * 因此「祖先可写」等价于「将来能写」。
 */
function canWrite(path: string): boolean {
  let dir = dirname(path)
  for (let i = 0; i < 16; i++) {
    if (existsSync(dir)) {
      try {
        accessSync(dir, constants.W_OK)
        return true
      } catch {
        return false
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
