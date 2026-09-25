/** 后台登录领域：一次性验证码、限流及服务端会话，始终从同一凭证表重读权限。 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import type {
  PortalCaptchaResponse,
  PortalViewer,
} from '@ai-token-report/shared'
import type { Credential, CredentialStore } from '../credentials.js'
import { createCaptchaImage } from './captcha.js'
import { normalizeUsername, verifyPassword } from './password.js'

export const SESSION_SECONDS = 8 * 60 * 60
export const CAPTCHA_SECONDS = 120
interface Challenge {
  answer: string
  binding: string
  expires: number
}
interface Session {
  token: string
  passwordHash: string
  username: string
  expires: number
}
type Failed = { ok: false; status: 400 | 401 | 429 | 503; reason: string }

export class PortalAuth {
  private readonly challenges = new Map<string, Challenge>()
  private readonly sessions = new Map<string, Session>()
  private readonly challengeLimit = new RateLimiterMemory({
    points: 120,
    duration: 60,
  })
  private readonly loginLimit = new RateLimiterMemory({
    points: 60,
    duration: 60,
  })
  private readonly accountLimit = new RateLimiterMemory({
    points: 5,
    duration: 900,
  })
  private activeHashes = 0

  constructor(
    private readonly credentials: CredentialStore,
    private readonly now: () => number = Date.now,
    private readonly makeImage = createCaptchaImage,
  ) {}

  async challenge(
    previousBinding?: string,
  ): Promise<
    Failed | { ok: true; binding: string; data: PortalCaptchaResponse }
  > {
    try {
      await this.challengeLimit.consume('global')
    } catch {
      return {
        ok: false,
        status: 429,
        reason: '验证码请求过于频繁，请稍后重试',
      }
    }
    this.prune()
    for (const [id, value] of this.challenges)
      if (value.binding === previousBinding) this.challenges.delete(id)
    if (this.challenges.size >= 500)
      return { ok: false, status: 503, reason: '登录服务繁忙，请稍后重试' }
    const { answer, image } = this.makeImage()
    const id = secret(),
      binding = secret()
    this.challenges.set(id, {
      answer,
      binding,
      expires: this.now() + CAPTCHA_SECONDS * 1000,
    })
    return {
      ok: true,
      binding,
      data: { captcha_id: id, image, expires_in: CAPTCHA_SECONDS },
    }
  }

  async login(
    body: unknown,
    binding?: string,
  ): Promise<Failed | { ok: true; sessionId: string; viewer: PortalViewer }> {
    try {
      await this.loginLimit.consume('global')
    } catch {
      return { ok: false, status: 429, reason: '登录请求过于频繁，请稍后重试' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return invalid()
    const raw = body as Record<string, unknown>
    if (
      typeof raw.username !== 'string' ||
      typeof raw.password !== 'string' ||
      typeof raw.captcha !== 'string' ||
      typeof raw.captcha_id !== 'string' ||
      raw.username.length > 64 ||
      raw.password.length > 256
    )
      return invalid()
    const challenge = this.challenges.get(raw.captcha_id)
    // 只允许绑定浏览器消费；每次提交（包括错误答案）都会消耗本浏览器的验证码。
    if (challenge && challenge.binding === binding)
      this.challenges.delete(raw.captcha_id)
    const answer = raw.captcha.trim()
    if (
      !challenge ||
      challenge.binding !== binding ||
      challenge.expires <= this.now() ||
      !/^[0-9]{4}$/.test(answer) ||
      !timingSafeEqual(Buffer.from(answer), Buffer.from(challenge.answer))
    ) {
      return {
        ok: false,
        status: 400,
        reason: '验证码错误或已过期，请刷新后重试',
      }
    }
    if (!this.credentials.list().some((c) => c.username && c.passwordHash)) {
      return {
        ok: false,
        status: 503,
        reason: '服务端尚未配置登录账号，请联系管理员完成初始化',
      }
    }
    const username = normalizeUsername(raw.username)
    try {
      await this.accountLimit.consume(username)
    } catch {
      return {
        ok: false,
        status: 429,
        reason: '该账号尝试次数过多，请 15 分钟后重试',
      }
    }
    // 限制昂贵 KDF 并发；全局桶不依赖可伪造的 X-Forwarded-For。
    if (this.activeHashes >= 4)
      return { ok: false, status: 503, reason: '登录服务繁忙，请稍后重试' }
    const credential = this.credentials.findByUsername(username)
    this.activeHashes++
    let valid = false
    try {
      valid = await verifyPassword(raw.password, credential?.passwordHash)
    } finally {
      this.activeHashes--
    }
    const current = credential && this.credentials.findByToken(credential.token)
    if (
      !valid ||
      !current ||
      current.username !== username ||
      current.passwordHash !== credential?.passwordHash
    ) {
      return { ok: false, status: 401, reason: '用户名或密码错误' }
    }
    await this.accountLimit.delete(username)
    this.prune()
    if (this.sessions.size >= 5000)
      return { ok: false, status: 503, reason: '登录会话已满，请稍后重试' }
    const sessionId = secret()
    this.sessions.set(sessionId, {
      token: current.token,
      username,
      passwordHash: current.passwordHash!,
      expires: this.now() + SESSION_SECONDS * 1000,
    })
    return { ok: true, sessionId, viewer: viewerOf(current) }
  }

  resolve(sessionId?: string): Credential | null {
    if (!sessionId) return null
    const session = this.sessions.get(sessionId)
    const current = session && this.credentials.findByToken(session.token)
    if (
      !session ||
      session.expires <= this.now() ||
      !current ||
      current.passwordHash !== session.passwordHash ||
      current.username !== session.username
    ) {
      this.sessions.delete(sessionId)
      return null
    }
    return current
  }

  logout(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, value] of this.challenges)
      if (value.expires <= now) this.challenges.delete(key)
    for (const [key, value] of this.sessions)
      if (value.expires <= now) this.sessions.delete(key)
  }
}

export function viewerOf(c: Credential): PortalViewer {
  return {
    name: c.name,
    username: c.username!,
    role: c.role,
    ...(c.dept ? { dept: c.dept } : {}),
  }
}
function secret(): string {
  return randomBytes(32).toString('base64url')
}
function invalid(): Failed {
  return { ok: false, status: 400, reason: '请填写用户名、密码和验证码' }
}
