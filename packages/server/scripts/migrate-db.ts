/** 显式上报库迁移入口；默认 inspect，不触碰本地 usage.sqlite。 */
import { resolve } from 'node:path'
import { inspectPortalDatabase, migratePortalDatabase, describePortalTarget, closeAllMysqlBackends, type PortalMigrationOptions } from '@ai-token-report/core/db'

const args = process.argv.slice(2)
const command = args.shift() ?? 'inspect'
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`)
  return value
}
async function main(): Promise<void> {
  if (!['inspect','migrate','resume'].includes(command)) throw new Error('用法：migrate-db.ts inspect|migrate|resume --db <portal.sqlite>；MySQL 使用 ATR_MYSQL_URL。旧库迁移必须 --confirm-offline。')
  const db = option('--db')
  const mysqlUrl = process.env.ATR_MYSQL_URL
  if (!db && !mysqlUrl) throw new Error('必须显式指定 --db 或 ATR_MYSQL_URL，防止误迁移默认库。')
  const target = { sqlitePath: resolve(db ?? 'portal.sqlite'), ...(mysqlUrl ? { mysqlUrl } : {}) }
  const options: PortalMigrationOptions = { resume: command === 'resume', confirmOffline: args.includes('--confirm-offline') }
  const backup = option('--backup')
  if (mysqlUrl && command !== 'inspect') {
    const sha256 = option('--backup-sha256')
    const confirmedTarget = option('--backup-target')
    if (backup && sha256 && confirmedTarget) options.mysqlBackupProof = { path: backup, sha256, target: confirmedTarget }
  } else if (backup) options.sqliteBackupPath = backup
  const result = command === 'inspect' ? await inspectPortalDatabase(target) : await migratePortalDatabase(target, options)
  console.log(JSON.stringify(result, null, 2))
  if (command === 'inspect' && result.status === 'legacy') {
    console.log(`停止旧服务后运行 migrate --confirm-offline。目标：${describePortalTarget(target)}`)
    console.log(mysqlUrl ? 'MySQL 必须提供真实备份文件 --backup、--backup-sha256 和与上方完全一致的 --backup-target。' : 'SQLite 会先生成 VACUUM INTO 一致性备份与 SHA256 清单；可用 --backup 指定新路径。')
  }
}
try { await main() }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally { await closeAllMysqlBackends() }
