/** 显式离线导入旧身份；不迁移 schema、不改原文件、不打印凭证或连接信息。 */
import { resolve } from 'node:path'
import { inspectPortalDatabase, closeAllMysqlBackends, type PortalTarget } from '@ai-token-report/core/db'
import { IdentityRepository, IdentityError, importCredentialFile, digest, type LegacyCredentialInput } from '../src/identity/index.js'
import { hashPassword } from '../src/auth/password.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法：bun run packages/server/scripts/import-credentials.ts --db <portal.sqlite> --credentials <credentials.json> --confirm-offline [--include-env-admin]\nMySQL：省略 --db，显式配置 ATR_MYSQL_URL。需先完成数据库 v4 结构迁移。\n--include-env-admin：同时导入 ATR_ADMIN_TOKEN 管理员；可配 ATR_ADMIN_USERNAME 与 ATR_ADMIN_PASSWORD 或 ATR_ADMIN_PASSWORD_HASH。')
    return
  }
  let dbPath: string | undefined, credentialsPath: string | undefined, offline = false, includeEnv = false
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--confirm-offline') { offline = true; continue }
    if (argument === '--include-env-admin') { includeEnv = true; continue }
    if (argument === '--db' || argument === '--credentials') {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new IdentityError(400, '参数缺少值')
      if (argument === '--db') { if (dbPath) throw new IdentityError(400, '--db 不能重复'); dbPath = resolve(value) }
      else { if (credentialsPath) throw new IdentityError(400, '--credentials 不能重复'); credentialsPath = resolve(value) }
      continue
    }
    throw new IdentityError(400, '未知参数，请使用 --help 查看用法')
  }
  if (!offline) throw new IdentityError(400, '请先停止旧服务，明确传入 --confirm-offline')
  if (!credentialsPath) throw new IdentityError(400, '需要显式传入 --credentials')
  const mysqlUrl = process.env.ATR_MYSQL_URL?.trim()
  if (!!dbPath === !!mysqlUrl) throw new IdentityError(400, '请只指定一个目标：--db 或 ATR_MYSQL_URL')
  const target: PortalTarget = { sqlitePath: dbPath ?? resolve('.unused-identity-import.sqlite'), ...(mysqlUrl ? { mysqlUrl } : {}) }
  const inspection = await inspectPortalDatabase(target)
  if (inspection.status !== 'current' || inspection.version !== 4) throw new IdentityError(409, '目标库尚未完成 v4 结构迁移；本命令不会初始化或迁移 schema')
  let envAdmin: LegacyCredentialInput | undefined
  let envSourceChecksum: string | undefined
  if (includeEnv) {
    const token = process.env.ATR_ADMIN_TOKEN?.trim()
    if (!token) throw new IdentityError(400, '--include-env-admin 需要原来的 ATR_ADMIN_TOKEN；不会生成不可恢复的替代凭证')
    const username = process.env.ATR_ADMIN_USERNAME
    const password = process.env.ATR_ADMIN_PASSWORD, encoded = process.env.ATR_ADMIN_PASSWORD_HASH
    if (password && encoded) throw new IdentityError(400, '管理员密码与密码哈希只能提供一种')
    if (!!username !== !!(password || encoded)) throw new IdentityError(400, '管理员账号与密码或哈希需要一起配置')
    if (encoded && !/^\$atr-scrypt\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(encoded)) throw new IdentityError(400, '管理员密码哈希格式无效')
    const name = process.env.ATR_ADMIN_NAME ?? '管理员'
    envSourceChecksum = digest(JSON.stringify({ token, name, username: username ?? null, password: password ?? null, passwordHash: encoded ?? null }))
    envAdmin = { token, name, role: 'admin', ...(username ? { username, passwordHash: encoded ?? await hashPassword(password!) } : {}) }
  }
  const repository = new IdentityRepository(target), repeated = await repository.isRegistered()
  const result = await importCredentialFile(repository, credentialsPath, { envAdmin, envSourceChecksum })
  console.log(JSON.stringify({ ok: true, source_checksum: result.source_import_ref, processed_entries: result.imported_entries, imported_entries: repeated ? 0 : result.imported_entries, repeated }))
}
try { await main() }
catch (error) {
  // 原始驱动/文件异常可能含敏感路径或连接串，只输出经过设计的业务文案。
  console.error(error instanceof IdentityError ? error.message : '凭证导入失败，请检查目标库连接、迁移状态与输入文件；未输出原始配置')
  process.exitCode = 1
} finally { await closeAllMysqlBackends() }
