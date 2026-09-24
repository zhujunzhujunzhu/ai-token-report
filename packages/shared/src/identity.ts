/**
 * 身份契约 —— 用户主动署名。
 *
 * ## 设计变更说明
 *
 * 早期方案（`PLAN.md` §9 方案 A）是「IT 安装时写入配置文件」的三级回退。
 * **现改为用户主动署名**：
 *
 * | | 旧方案（安装时写入） | 新方案（用户主动填写） |
 * |---|---|---|
 * | 谁填 | IT / 安装脚本 | **员工本人** |
 * | 何时 | 装机时 | **首次打开页面 / 首次启动插件** |
 * | 合规 | 需另行书面告知 | **员工知情且主动**，更干净 |
 * | 篡改风险 | 需服务端加固 | 由 token 凭证兜底（见下） |
 *
 * ## 为什么 token 是「身份凭证」而不是普通鉴权
 *
 * 用户填的是 `姓名 + token`。token **由服务端签发并绑定姓名**，因此：
 *
 * - 客户端「我填了张三」不算数 —— 服务端以 token 解析出的身份为准
 * - 即使有人改了本地配置文件，**也无法冒用他人身份**上报
 * - 这正好补上了旧方案 A「可被篡改」的短板
 *
 * 所以身份的可信边界在服务端，本地文件只是「我记得我填过什么」。
 *
 * ## 未署名 = 不采集
 *
 * ★ 已确认的行为：**用户没填之前，既不采集也不上报**。
 *   本地页面仍可查看本机总量（那是用户自己的数据），但不会写入任何归属信息，
 *   更不会向服务端发送任何东西。
 */

/** 本地身份文件的内容。 */
export interface Identity {
  /** 用户填写的显示名，如「张三」。 */
  name: string
  /**
   * 服务端签发的身份凭证。
   *
   * ⚠️ 这是**凭证**，不是普通密码：它决定了服务端认定你是谁。
   * 不要记录到日志、不要随上报体明文回传（上报时只作为 Authorization 头）。
   */
  token: string
  /** 部门。可空 —— 不确定的员工可以先留空。 */
  dept?: string
  /** 首次署名时间（epoch 毫秒），用于审计。 */
  createdAt: number
  /** 最近一次更新署名的时间。 */
  updatedAt: number
}

/**
 * 上报时使用的身份视图 —— **不含 token**。
 *
 * ★ token 只走 `Authorization` 头，绝不出现在请求体里。
 *   否则它会落进服务端日志、数据库、错误堆栈。
 */
export interface IdentityAssertion {
  name: string
  dept?: string
}

/** 身份校验结果。 */
export interface IdentityValidation {
  ok: boolean
  /** 校验失败的原因，可直接展示给用户。 */
  reason?: string
}

/** 姓名长度上限 —— 防止误粘贴长文本。 */
export const NAME_MAX_LENGTH = 32
/** token 长度上限。 */
export const TOKEN_MAX_LENGTH = 256

/**
 * 校验用户填写的姓名。
 *
 * 刻意宽松（不限制中英文/空格），只拦住明显是误操作的情况：
 * 空、纯空白、超长、含换行。
 */
export function validateName(raw: string): IdentityValidation {
  const name = raw.trim()
  if (!name) return { ok: false, reason: '请填写你的姓名' }
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, reason: `姓名过长（最多 ${NAME_MAX_LENGTH} 个字符）` }
  }
  if (/[\r\n\t]/.test(raw)) {
    return { ok: false, reason: '姓名不能包含换行或制表符' }
  }
  return { ok: true }
}

/**
 * 校验 token 的**形式**。
 *
 * ⚠️ 这里只做形式校验 —— token 是否有效**只有服务端知道**。
 *   真正的校验发生在提交时由服务端完成（见 `POST /api/local/identity`）。
 *   本地不做「看起来对不对」的猜测，避免给出误导性的错误提示。
 */
export function validateToken(raw: string): IdentityValidation {
  const token = raw.trim()
  if (!token) return { ok: false, reason: '请填写管理员发放的 token' }
  if (token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: `token 过长（最多 ${TOKEN_MAX_LENGTH} 个字符）` }
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: 'token 不能包含空格' }
  }
  return { ok: true }
}

/** 校验完整的一份署名。 */
export function validateIdentity(name: string, token: string): IdentityValidation {
  return validateName(name).ok ? validateToken(token) : validateName(name)
}

/** 该身份数据是否已签名完毕（两个必填项都非空）。 */
export function isSigned(i: Pick<Identity, 'name' | 'token'> | null | undefined): boolean {
  return !!i && i.name.trim().length > 0 && i.token.trim().length > 0
}

/** 从完整身份中取出可安全上报的视图（剥离 token）。 */
export function toAssertion(i: Identity): IdentityAssertion {
  return i.dept ? { name: i.name, dept: i.dept } : { name: i.name }
}

/** 姓名脱敏，用于日志与看板展示（「张三」→「张*」）。 */
export function maskName(name: string): string {
  const s = name.trim()
  if (s.length <= 1) return s
  return s[0] + '*'.repeat(s.length - 1)
}