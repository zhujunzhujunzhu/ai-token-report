/** 正式运行走数据库认证；旧凭证适配只保留给历史独立处理器测试。 */
import type { CredentialStore } from '../credentials.js'
import { IdentityRepository } from '../identity/repository.js'
import { DatabasePortalAuth, type DatabaseAuthOptions } from '../identity/portal-auth.js'
import { LegacyPortalAuth } from '../identity/legacy-portal-auth.js'
import { createCaptchaImage } from './captcha.js'
export { viewerOf } from '../identity/legacy-portal-auth.js'
export const SESSION_SECONDS = 8 * 60 * 60
export const CAPTCHA_SECONDS = 120

export class PortalAuth {
  private readonly service: DatabasePortalAuth | LegacyPortalAuth
  constructor(repository: IdentityRepository, options?: DatabaseAuthOptions)
  constructor(credentials: CredentialStore, now?: () => number, makeImage?: typeof createCaptchaImage)
  constructor(source: IdentityRepository | CredentialStore, options?: DatabaseAuthOptions | (() => number), makeImage?: typeof createCaptchaImage) {
    this.service = source instanceof IdentityRepository
      ? new DatabasePortalAuth(source, typeof options === 'object' ? options : {})
      : new LegacyPortalAuth(source, typeof options === 'function' ? options : Date.now, makeImage ?? createCaptchaImage)
  }
  challenge(previousBinding?: string) { return this.service.challenge(previousBinding) }
  login(body: unknown, binding?: string) { return this.service.login(body, binding) }
  async resolve(secret?: string) { return this.service.resolve(secret) }
  async logout(secret?: string): Promise<void> { await this.service.logout(secret) }
}
