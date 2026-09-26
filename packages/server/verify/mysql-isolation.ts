/** 验证专用：仅创建和删除本次随机命名的 schema，不接触已有业务库。 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { openMysqlBackend, closeAllMysqlBackends } from '../../core/src/db/mysql.js'

export async function createIsolatedMysql() {
  let adminUrl = process.env.ATR_V4_TEST_MYSQL_URL
  if (!adminUrl) {
    const result = spawnSync('docker', ['inspect', 'local-database-review-mysql'], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error('未找到本地测试MySQL，请设置 ATR_V4_TEST_MYSQL_URL 管理连接')
    const containers = JSON.parse(result.stdout) as { Config: { Env: string[] } }[]
    const password = containers[0]?.Config.Env.find(value => value.startsWith('MYSQL_ROOT_PASSWORD='))?.slice('MYSQL_ROOT_PASSWORD='.length)
    if (!password) throw new Error('本地测试容器没有管理密码')
    const url = new URL('mysql://root@127.0.0.1:3335/information_schema')
    url.password = password
    adminUrl = url.href
  }
  const schema = `atr_http_v4_${Date.now()}_${randomUUID().slice(0, 8)}`
  if (!/^atr_http_v4_\d+_[a-f0-9]{8}$/.test(schema)) throw new Error('隔离库名无效')
  const admin = await openMysqlBackend(adminUrl)
  await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
  const url = new URL(adminUrl)
  url.pathname = '/' + schema
  return { url: url.href, async dispose() {
    await closeAllMysqlBackends()
    await admin.exec(`DROP DATABASE ${schema}`)
    await admin.close()
  } }
}
