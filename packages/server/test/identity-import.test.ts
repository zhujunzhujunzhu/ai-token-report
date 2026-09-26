/** 显式凭证导入命令的真实子进程验证；不把测试凭证写入输出。 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { preparePortalDatabase, openDb, ensureSchema, type PortalTarget } from '@ai-token-report/core/db'
import { IdentityRepository } from '../src/identity/index.js'
import { DatabasePortalAuth } from '../src/identity/portal-auth.js'
import { hashPassword } from '../src/auth/password.js'

const roots: string[] = []
const mysqlSchemas: string[] = []
const mysqlAdminUrl = process.env.ATR_IDENTITY_TEST_MYSQL_ADMIN_URL
const script = resolve(import.meta.dir, '../scripts/import-credentials.ts')
const password = 'offline-import-test-password-2026'
const envKeys = ['ATR_MYSQL_URL', 'ATR_ADMIN_TOKEN', 'ATR_ADMIN_NAME', 'ATR_ADMIN_USERNAME', 'ATR_ADMIN_PASSWORD', 'ATR_ADMIN_PASSWORD_HASH']
afterEach(async () => {
  if (mysqlAdminUrl && mysqlSchemas.length) {
    const connection = await (await import('mysql2/promise')).createConnection(mysqlAdminUrl)
    try {
      for (const schema of mysqlSchemas.splice(0)) {
        if (!/^atr_identity_import_[a-f0-9]+$/.test(schema)) throw new Error('隔离 schema 名称不合法')
        await connection.query('DROP DATABASE `' + schema + '`')
      }
    } finally { await connection.end() }
  }
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(join(resolve(tmpdir()), 'atr-identity-import-'))) throw new Error('临时目录不在测试边界内')
    rmSync(path, { force: true, recursive: true })
  }
})
async function fixture(initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'atr-identity-import-')); roots.push(dir)
  const target: PortalTarget = { sqlitePath: join(dir, 'portal.sqlite') }, file = join(dir, 'credentials.json')
  // 未初始化/旧 v3 两项刻意验证 SQLite 文件不变，其余可切到真实隔离 MySQL。
  if (initialize && mysqlAdminUrl) {
    const schema = 'atr_identity_import_' + randomUUID().replaceAll('-', '')
    const connection = await (await import('mysql2/promise')).createConnection(mysqlAdminUrl)
    try { await connection.query('CREATE DATABASE `' + schema + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'); mysqlSchemas.push(schema) } finally { await connection.end() }
    const url = new URL(mysqlAdminUrl); url.pathname = '/' + schema; target.mysqlUrl = url.href
  }
  writeFileSync(file, '[]')
  if (initialize) await preparePortalDatabase(target)
  return { dir, target, file, repository: new IdentityRepository(target) }
}
function run(target: PortalTarget, file: string, flags = ['--confirm-offline'], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env }
  for (const key of envKeys) delete env[key]
  const child = spawnSync(process.execPath, ['run', script, ...(target.mysqlUrl ? [] : ['--db', target.sqlitePath]), '--credentials', file, ...flags], { env: { ...env, ...extraEnv, ...(target.mysqlUrl ? { ATR_MYSQL_URL: target.mysqlUrl } : {}) }, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  const output = child.stdout + child.stderr
  expect(output).not.toContain(target.sqlitePath)
  expect(output).not.toContain(file)
  if (target.mysqlUrl) expect(output).not.toContain(target.mysqlUrl)
  for (const key of ['ATR_ADMIN_TOKEN', 'ATR_ADMIN_PASSWORD', 'ATR_ADMIN_PASSWORD_HASH']) if (extraEnv[key]) expect(output).not.toContain(extraEnv[key]!)
  return { status: child.status, output, stdout: child.stdout }
}

describe('显式凭证导入命令', () => {
  test('必须离线确认；不存在的目标不会被自动创建', async () => {
    const { target, file } = await fixture(false)
    expect(run(target, file, []).status).toBe(1)
    expect(existsSync(target.sqlitePath)).toBe(false)
    const result = run(target, file)
    expect(result.status).toBe(1)
    expect(result.output).toContain('不会初始化或迁移 schema')
    expect(existsSync(target.sqlitePath)).toBe(false)
  })
  test('真实 v3 库明确拒绝，不隐式迁移、不改历史', async () => {
    const { target, file } = await fixture(false)
    const db = openDb(target.sqlitePath)
    try { ensureSchema(db) } finally { db.close() }
    const before = readFileSync(target.sqlitePath)
    expect(run(target, file).status).toBe(1)
    expect(readFileSync(target.sqlitePath)).toEqual(before)
  })
  test('坏文件与未显式选择的环境管理员不能初始化身份', async () => {
    const { target, file, repository } = await fixture()
    writeFileSync(file, '{')
    expect(run(target, file).status).toBe(1)
    expect(await repository.isRegistered()).toBe(false)
    writeFileSync(file, '[]')
    expect(run(target, file, ['--confirm-offline'], { ATR_ADMIN_TOKEN: 'ignored-env-secret' }).status).toBe(1)
    expect(await repository.isRegistered()).toBe(false)
  })
  test('原数组与合法密码hash原样导入；禁用登录保留；重复命令无写入', async () => {
    const { target, file, repository } = await fixture()
    const encoded = await hashPassword(password)
    const raw = JSON.stringify([{ token: 'legacy-admin-secret', name: '旧管理员', role: 'admin', username: 'old-admin', passwordHash: encoded }, { token: 'legacy-member-secret', name: '禁用登录', username: 'disabled', passwordHash: encoded, loginEnabled: false }])
    writeFileSync(file, raw)
    const first = run(target, file)
    expect(first.status).toBe(0)
    expect(first.output).not.toContain('legacy-admin-secret')
    expect(first.output).not.toContain(encoded)
    const parsed = JSON.parse(first.stdout)
    expect(parsed).toMatchObject({ imported_entries: 2, processed_entries: 2, repeated: false })
    expect(parsed.source_checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    const second = run(target, file)
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ imported_entries: 0, repeated: true, source_checksum: parsed.source_checksum })
    const accounts = await repository.read(tx => tx.all<{ username: string; password_hash: string; enabled: number }>('SELECT username_normalized AS username,password_hash,enabled FROM login_accounts ORDER BY username_normalized'))
    expect(accounts).toEqual([{ username: 'disabled', password_hash: encoded, enabled: 0 }, { username: 'old-admin', password_hash: encoded, enabled: 1 }])
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })
  test('旧映射与显式环境明文密码支持稳定重复，真实登录可用且停用不复活', async () => {
    const { target, file, repository } = await fixture()
    writeFileSync(file, JSON.stringify({ '旧成员': 'legacy-mapping-secret' }))
    const env = { ATR_ADMIN_TOKEN: 'env-import-admin-secret', ATR_ADMIN_NAME: '部署管理员', ATR_ADMIN_USERNAME: 'bootstrap-admin', ATR_ADMIN_PASSWORD: password }
    const flags = ['--confirm-offline', '--include-env-admin']
    const first = run(target, file, flags, env)
    expect(first.status).toBe(0)
    const parsed = JSON.parse(first.stdout)
    const second = run(target, file, flags, env)
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ imported_entries: 0, repeated: true, source_checksum: parsed.source_checksum })
    const auth = new DatabasePortalAuth(repository, { hmacKey: 'identity-import-test-hmac-key-at-least-32', makeImage: () => ({ answer: '2468', image: 'data:image/png;base64,test' }) })
    const challenge = await auth.challenge(); if (!challenge.ok) throw new Error(challenge.reason)
    const signed = await auth.login({ username: 'bootstrap-admin', password, captcha_id: challenge.data.captcha_id, captcha: '2468' }, challenge.binding)
    expect(signed.ok).toBe(true)
    const actor = (await repository.resolveBearer(env.ATR_ADMIN_TOKEN))!
    const me = (await repository.listMembers(actor)).members.find(m => m.member_id === actor.memberId)!
    await repository.setLoginStatus(actor, { member_id: me.member_id, expected_version: me.version, enabled: false })
    expect(run(target, file, flags, env).status).toBe(0)
    expect((await repository.listMembers(actor)).members.find(m => m.member_id === actor.memberId)?.account?.enabled).toBe(false)
    expect((await repository.verifyIdentity('legacy-mapping-secret')).name).toBe('旧成员')
  })
  test('环境已有合法hash直接复用，冲突密码配置与不同来源均拒绝', async () => {
    const { target, file, repository } = await fixture()
    const encoded = await hashPassword(password), flags = ['--confirm-offline', '--include-env-admin']
    const env = { ATR_ADMIN_TOKEN: 'env-hash-admin-secret', ATR_ADMIN_USERNAME: 'hash-admin', ATR_ADMIN_PASSWORD_HASH: encoded }
    expect(run(target, file, flags, { ...env, ATR_ADMIN_PASSWORD: password }).status).toBe(1)
    expect(await repository.isRegistered()).toBe(false)
    expect(run(target, file, flags, env).status).toBe(0)
    expect((await repository.read(tx => tx.get<{ password_hash: string }>('SELECT password_hash FROM login_accounts')))?.password_hash).toBe(encoded)
    writeFileSync(file, '[{"name":"另一个来源","token":"another-source-secret"}]')
    expect(run(target, file, flags, env).status).toBe(1)
    expect((await repository.health()).member_count).toBe(1)
  })
})
