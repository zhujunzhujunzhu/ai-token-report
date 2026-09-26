/** 数据库验证码、限流与会话。答案只存带部署密钥的 HMAC。 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PortalCaptchaResponse, PortalViewer } from '@ai-token-report/shared'
import { createCaptchaImage } from '../auth/captcha.js'
import { normalizeUsername, verifyPassword } from '../auth/password.js'
import { IdentityRepository, digest, randomSecret } from './repository.js'
import { num, str, type Row } from './types.js'

const SESSION_SECONDS = 8 * 60 * 60
const CAPTCHA_SECONDS = 120
type Failed = { ok: false; status: 400 | 401 | 429 | 503; reason: string }
export interface DatabaseAuthOptions { hmacKey?: string; now?: () => number; makeImage?: () => { answer: string; image: string } }

export class DatabasePortalAuth {
  private readonly now: () => number
  private readonly makeImage: () => { answer: string; image: string }
  private readonly key: string | undefined
  private activeHashes = 0
  constructor(readonly repository: IdentityRepository, options: DatabaseAuthOptions = {}) {
    this.now = options.now ?? repository.now
    this.makeImage = options.makeImage ?? createCaptchaImage
    this.key = options.hmacKey && options.hmacKey.length >= 32 ? options.hmacKey : undefined
  }
  private unavailable(): Failed { return { ok: false, status: 503, reason: '登录服务需要配置至少 32 字符的 ATR_CAPTCHA_HMAC_KEY，多个实例必须使用同一密钥' } }
  private hmac(id: string, answer: string): string { return createHmac('sha256', this.key!).update(id + ':' + answer).digest('hex') }
  private async consume(scope: string, subject: string, points: number, duration: number): Promise<boolean> {
    return this.repository.systemWrite(async (tx) => {
      const now = this.now(), hash = digest(subject)
      // 未知用户名也会产生桶；清理已过期窗口，避免长期运行时无界累积。
      await tx.run('DELETE FROM auth_rate_limit_buckets WHERE expires_at_ms <= $now', { $now: now })
      const row = await tx.get<Row>('SELECT * FROM auth_rate_limit_buckets WHERE scope = $scope AND subject_hash = $hash', { $scope: scope, $hash: hash })
      if (row && num(row, 'expires_at_ms') > now) {
        if (num(row, 'used_points') >= points) return false
        await tx.run('UPDATE auth_rate_limit_buckets SET used_points = used_points + 1 WHERE bucket_id = $id', { $id: row.bucket_id })
      } else if (row) {
        await tx.run('UPDATE auth_rate_limit_buckets SET window_started_at_ms = $now,expires_at_ms = $expires,used_points = 1,blocked_until_ms = NULL WHERE bucket_id = $id', { $now: now, $expires: now + duration, $id: row.bucket_id })
      } else {
        await tx.run('INSERT INTO auth_rate_limit_buckets (bucket_id,scope,subject_hash,window_started_at_ms,expires_at_ms,used_points) VALUES ($id,$scope,$hash,$now,$expires,1)', { $id: randomUUID(), $scope: scope, $hash: hash, $now: now, $expires: now + duration })
      }
      return true
    })
  }
  async challenge(previousBinding?: string): Promise<Failed | { ok: true; binding: string; data: PortalCaptchaResponse }> {
    if (!this.key) return this.unavailable()
    if (!await this.consume('challenge', 'global', 120, 60_000)) return { ok: false, status: 429, reason: '验证码请求过于频繁，请稍后重试' }
    const { answer, image } = this.makeImage(), id = randomSecret(), binding = randomSecret()
    const inserted = await this.repository.systemWrite(async (tx) => {
      const now = this.now()
      await tx.run('DELETE FROM auth_challenges WHERE expires_at_ms <= $now OR consumed_at_ms IS NOT NULL', { $now: now })
      if (previousBinding) await tx.run('DELETE FROM auth_challenges WHERE binding_hash = $hash', { $hash: digest(previousBinding) })
      if (num((await tx.get<Row>('SELECT COUNT(*) AS c FROM auth_challenges')) ?? {}, 'c') >= 500) return false
      await tx.run('INSERT INTO auth_challenges (challenge_id,challenge_hash,binding_hash,answer_hmac,hmac_key_id,created_at_ms,expires_at_ms) VALUES ($id,$hash,$binding,$answer,$key,$now,$expires)', { $id: randomUUID(), $hash: digest(id), $binding: digest(binding), $answer: this.hmac(id, answer), $key: digest(this.key!).slice(0, 16), $now: now, $expires: now + CAPTCHA_SECONDS * 1000 })
      return true
    })
    if (!inserted) return { ok: false, status: 503, reason: '登录服务繁忙，请稍后重试' }
    return { ok: true, binding, data: { captcha_id: id, image, expires_in: CAPTCHA_SECONDS } }
  }
  async login(body: unknown, binding?: string): Promise<Failed | { ok: true; sessionId: string; viewer: PortalViewer }> {
    if (!this.key) return this.unavailable()
    if (!await this.consume('login', 'global', 60, 60_000)) return { ok: false, status: 429, reason: '登录请求过于频繁，请稍后重试' }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
    const raw = body as Row
    if (typeof raw.username !== 'string' || typeof raw.password !== 'string' || typeof raw.captcha !== 'string' || typeof raw.captcha_id !== 'string' || raw.username.length > 64 || raw.password.length > 256) return invalid()
    const captchaId = raw.captcha_id, answer = raw.captcha.trim()
    const validChallenge = await this.repository.systemWrite(async (tx) => {
      const row = await tx.get<Row>('SELECT * FROM auth_challenges WHERE challenge_hash = $hash', { $hash: digest(captchaId) })
      if (!row || !binding || str(row, 'binding_hash') !== digest(binding) || row.consumed_at_ms != null) return false
      // 错误答案也消费本浏览器的验证码，跨浏览器不能替本人消费。
      const result = await tx.run('UPDATE auth_challenges SET consumed_at_ms = $now,attempt_count = attempt_count + 1 WHERE challenge_id = $id AND consumed_at_ms IS NULL', { $now: this.now(), $id: row.challenge_id })
      return result.changes === 1 && num(row, 'expires_at_ms') > this.now() && str(row, 'hmac_key_id') === digest(this.key!).slice(0, 16) && /^[0-9]{4}$/.test(answer) && timingSafeEqual(Buffer.from(str(row, 'answer_hmac'), 'hex'), Buffer.from(this.hmac(captchaId, answer), 'hex'))
    })
    if (!validChallenge) return { ok: false, status: 400, reason: '验证码错误或已过期，请刷新后重试' }
    const configured = await this.repository.read(async (tx) => num((await tx.get<Row>('SELECT COUNT(*) AS c FROM login_accounts')) ?? {}, 'c') > 0)
    if (!configured) return { ok: false, status: 503, reason: '服务端尚未配置登录账号，请联系管理员完成初始化' }
    const username = normalizeUsername(raw.username)
    if (!await this.consume('account', username, 5, 900_000)) return { ok: false, status: 429, reason: '该账号尝试次数过多，请 15 分钟后重试' }
    if (this.activeHashes >= 4) return { ok: false, status: 503, reason: '登录服务繁忙，请稍后重试' }
    // 在任何异步读取前占位，避免并发请求全部看到旧计数后一起进入 KDF。
    this.activeHashes++
    let account: Row | null = null
    let valid = false
    try {
      account = await this.repository.read((tx) => tx.get<Row>('SELECT * FROM login_accounts WHERE username_normalized = $username', { $username: username }))
      valid = await verifyPassword(raw.password, account ? str(account, 'password_hash') : undefined)
    } finally { this.activeHashes-- }
    if (!valid || !account) return badPassword()
    const sessionSecret = randomSecret()
    const result = await this.repository.systemWrite(async (tx) => {
      const current = await tx.get<Row>('SELECT a.*,m.status AS member_status FROM login_accounts a JOIN members m ON m.member_id = a.member_id WHERE a.account_id = $id', { $id: account.account_id })
      if (!current || num(current, 'enabled') !== 1 || current.member_status !== 'active' || current.password_hash !== account.password_hash || current.username_normalized !== username || num(current, 'password_version') !== num(account, 'password_version')) return 'invalid'
      const now = this.now()
      await tx.run('DELETE FROM auth_sessions WHERE expires_at_ms <= $now OR revoked_at_ms IS NOT NULL', { $now: now })
      if (num((await tx.get<Row>('SELECT COUNT(*) AS c FROM auth_sessions')) ?? {}, 'c') >= 5000) return 'full'
      await tx.run('INSERT INTO auth_sessions (session_id,session_hash,account_id,password_version,created_at_ms,expires_at_ms,last_seen_at_ms) VALUES ($id,$hash,$account,$version,$now,$expires,$now)', { $id: randomUUID(), $hash: digest(sessionSecret), $account: current.account_id, $version: num(current, 'password_version'), $now: now, $expires: now + SESSION_SECONDS * 1000 })
      await tx.run('DELETE FROM auth_rate_limit_buckets WHERE scope = $scope AND subject_hash = $hash', { $scope: 'account', $hash: digest(username) })
      return 'ok'
    })
    if (result === 'invalid') return badPassword()
    if (result === 'full') return { ok: false, status: 503, reason: '登录会话已满，请稍后重试' }
    const p = await this.repository.resolveSession(sessionSecret)
    if (!p) return badPassword()
    return { ok: true, sessionId: sessionSecret, viewer: await this.repository.getViewer(p) }
  }
  resolve(secret?: string) { return this.repository.resolveSession(secret) }
  async logout(secret?: string): Promise<void> {
    if (!secret) return
    await this.repository.systemWrite(async (tx) => { await tx.run('UPDATE auth_sessions SET revoked_at_ms = $now WHERE session_hash = $hash AND revoked_at_ms IS NULL', { $now: this.now(), $hash: digest(secret) }) })
  }
}
function invalid(): Failed { return { ok: false, status: 400, reason: '请填写用户名、密码和验证码' } }
function badPassword(): Failed { return { ok: false, status: 401, reason: '用户名或密码错误' } }
