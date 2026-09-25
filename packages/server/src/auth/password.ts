/** 登录密码：固定成本的 scrypt，随机盐；生成与校验共用输入归一规则。 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { scryptAsync } from '@noble/hashes/scrypt.js'

const PREFIX = '$atr-scrypt$1$'
const OPTIONS = { N: 32768, r: 8, p: 1, dkLen: 32 }
const DUMMY = PREFIX + '00'.repeat(16) + '$' + '00'.repeat(32)

export function normalizePassword(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r/g, '')
}

export function passwordError(value: string): string | null {
  const length = normalizePassword(value).length
  return length < 12 || length > 128 ? '密码长度需要为 12～128 个字符' : null
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function usernameError(value: string): string | null {
  return /^[a-z0-9][a-z0-9_.-]{2,63}$/.test(normalizeUsername(value))
    ? null
    : '用户名需要为 3～64 位字母、数字、点、下划线或连字符，以字母或数字开头'
}

export async function hashPassword(value: string): Promise<string> {
  const error = passwordError(value)
  if (error) throw new Error(error)
  const salt = randomBytes(16)
  const key = await scryptAsync(normalizePassword(value), salt, OPTIONS)
  return PREFIX + salt.toString('hex') + '$' + Buffer.from(key).toString('hex')
}

export async function verifyPassword(
  value: string,
  stored?: string,
): Promise<boolean> {
  const valid =
    typeof stored === 'string' &&
    /^\$atr-scrypt\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)
  const parts = (valid ? stored : DUMMY).split('$')
  const key = await scryptAsync(
    normalizePassword(value),
    Buffer.from(parts[3]!, 'hex'),
    OPTIONS,
  )
  return (
    timingSafeEqual(Buffer.from(key), Buffer.from(parts[4]!, 'hex')) && valid
  )
}
