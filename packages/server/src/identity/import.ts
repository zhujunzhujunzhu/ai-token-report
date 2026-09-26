/** 显式离线凭证导入：原始文件保留，校验所有条目后才交给数据库事务。 */
import { readFileSync } from 'node:fs'
import type { CredentialInput } from '../credentials.js'
import { IdentityError } from './types.js'
import { digest, type IdentityRepository, type LegacyCredentialInput } from './repository.js'

export async function importCredentialFile(repository: IdentityRepository, path: string, options: { envAdmin?: CredentialInput | null; envSourceChecksum?: string } = {}): Promise<{ source_import_ref: string; imported_entries: number }> {
  const raw = readFileSync(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new IdentityError(400, '凭证文件不是合法 JSON，未修改数据库') }
  // 只解析本次读取的快照；不能再次读文件后把另一份内容与旧 checksum 绑定。
  const entries: LegacyCredentialInput[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new IdentityError(400, '凭证条目需要是对象')
      const r = item as Record<string, unknown>
      if (typeof r.token !== 'string' || !r.token.trim() || typeof r.name !== 'string' || !r.name.trim()) throw new IdentityError(400, '凭证姓名或 Token 缺失')
      if (r.role !== undefined && r.role !== 'admin' && r.role !== 'member') throw new IdentityError(400, '凭证文件包含未知角色，未修改数据库')
      for (const key of ['dept', 'username', 'passwordHash']) if (r[key] !== undefined && typeof r[key] !== 'string') throw new IdentityError(400, `凭证字段 ${key} 格式无效`)
      if (r.loginEnabled !== undefined && typeof r.loginEnabled !== 'boolean') throw new IdentityError(400, '凭证文件登录启用状态无效')
      if (r.createdAt !== undefined && (!Number.isSafeInteger(r.createdAt) || Number(r.createdAt) < 0)) throw new IdentityError(400, '凭证签发时间无效')
      entries.push({ token: r.token.trim(), name: r.name.trim(), ...(r.role !== undefined ? { role: r.role as 'admin' | 'member' } : {}), ...(r.dept !== undefined ? { dept: r.dept as string } : {}), ...(r.username !== undefined ? { username: r.username as string } : {}), ...(r.passwordHash !== undefined ? { passwordHash: r.passwordHash as string } : {}), ...(r.loginEnabled !== undefined ? { loginEnabled: r.loginEnabled as boolean } : {}), ...(r.createdAt !== undefined ? { createdAt: Number(r.createdAt) } : {}) })
    }
  } else if (value && typeof value === 'object') {
    for (const [name, token] of Object.entries(value)) {
      if (!name.trim() || typeof token !== 'string' || !token.trim()) throw new IdentityError(400, '姓名到 Token 映射格式无效')
      entries.push({ name: name.trim(), token: token.trim() })
    }
  } else throw new IdentityError(400, '凭证文件需要是数组或姓名到 Token 的映射')
  if (options.envAdmin) entries.push({ ...options.envAdmin, role: options.envAdmin.role ?? 'admin' })
  if (options.envSourceChecksum && !/^[a-f0-9]{64}$/.test(options.envSourceChecksum)) throw new IdentityError(400, '环境凭证来源校验和格式无效')
  // 明文密码每次 KDF 都有随机盐；来源标识使用稳定配置摘要，避免重复导入误判新来源。
  const sourceRef = 'sha256:' + digest(raw + '\0' + (options.envSourceChecksum ?? JSON.stringify(options.envAdmin ?? null)))
  await repository.importCredentials(entries, sourceRef)
  return { source_import_ref: sourceRef, imported_entries: entries.length }
}
