/** 显式上报库迁移入口；默认 inspect，不触碰本地 usage.sqlite。 */
import { resolve } from 'node:path'
import { inspectPortalDatabase, migratePortalDatabase, describePortalTarget, closeAllMysqlBackends, PORTAL_SCHEMA_VERSION, type PortalMigrationOptions } from '@ai-token-report/core/db'

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
  if (!['inspect','migrate','resume'].includes(command)) throw new Error(`用法：migrate-db.ts inspect|migrate|resume --db <portal.sqlite>；MySQL 使用 ATR_MYSQL_URL。旧库迁移必须 --confirm-offline。上报库当前版本是 v${PORTAL_SCHEMA_VERSION}：v4 是冻结基线，v3 库先迁到 v4，再依次走 v5→…→v${PORTAL_SCHEMA_VERSION}，任何一步都不改写事件原值。`)
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
    console.log(`上报库当前版本是 v${PORTAL_SCHEMA_VERSION}：库会从它所在的那一版逐步追平（v4 是冻结基线，v3 库先迁到 v4，再依次走 v5→…→v${PORTAL_SCHEMA_VERSION}），全程不改写任何事件原值。`)
    // 🚨 **不要把「要备份证明」写成无条件**：`upgradeV4ToV5` 只在事实表还是 v5 之前的形状
    //   **且确实有历史事件**时才索要外部备份证明。版本 ≥ 5 的库走的全是
    //   「只加表 / 只加列」的追加步骤（v6 / v7 / v8 / v9），没有会被改写的对象，
    //   迁移器自己也不会要证明 —— 写成无条件只会让每次追加迁移白跑一次手工备份，
    //   而真按它去准备备份的人会发现「不给也能过」，从此不信这段提示。
    console.log(result.version >= 5
      ? '这一步是纯追加（只加表 / 只加列），**不要求**外部备份证明；SQLite 与 MySQL 都只差一个 --confirm-offline。'
      : mysqlUrl ? 'MySQL 必须提供真实备份文件 --backup、--backup-sha256 和与上方完全一致的 --backup-target。' : 'SQLite 会先生成 VACUUM INTO 一致性备份与 SHA256 清单；可用 --backup 指定新路径。')
  }
}
try { await main() }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally { await closeAllMysqlBackends() }
