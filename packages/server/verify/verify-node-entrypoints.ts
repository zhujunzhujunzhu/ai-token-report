/** 对 build:node 的三个真实 Node 入口验收，所有迁移与身份数据只写本次临时库。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, ensureSchema, inspectPortalDatabase } from '@ai-token-report/core/db'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'
import { hashPassword } from '../src/auth/password.js'
import { IdentityRepository } from '../src/identity/index.js'

const node = resolveNodeBin()
if (!node) throw new Error('需要真实 Node；不会用 Bun 代替')
const dir = mkdtempSync(join(tmpdir(), 'atr-node-entrypoints-'))
const target = { sqlitePath: join(dir, 'portal.sqlite') }, file = join(dir, 'legacy-credentials.json')
const dist = resolve(import.meta.dir, '../dist')
const env = cleanChildEnv()
for (const key of Object.keys(env)) if (/^ATR_(MYSQL_URL|ADMIN_|CAPTCHA_HMAC_KEY)/.test(key)) delete env[key]
let checks = 0
function check(condition: unknown, label: string): void { assert(condition, label); checks++ }
function run(entry: string, args: string[]) {
  const result = spawnSync(node!, [join(dist, entry + '.mjs'), ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (result.error) throw new Error('Node 入口未在限定时间内结束')
  return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout }
}
try {
  const help = run('main', ['--help'])
  check(help.code === 0 && help.output.includes('数据库身份初始化'), 'main 真实 Node 帮助可运行')
  const db = openDb(target.sqlitePath)
  try {
    ensureSchema(db)
    db.exec("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,user_id,user_name,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES ('node-legacy:1','node-legacy',1,1,'fixture','model','旧管理员','旧管理员',2,3,5,7)")
  } finally { db.close() }
  const old = run('migrate-db', ['inspect', '--db', target.sqlitePath])
  check(old.code === 0 && old.output.includes('"status": "legacy"'), 'inspect 识别真实 v3 库')
  const gate = run('main', ['--db', target.sqlitePath, '--dsh-home', dir])
  check(gate.code !== 0 && gate.output.includes('显式'), 'Node 服务启动拒绝旧库隐式升级')
  check((await inspectPortalDatabase(target)).version === 3, '失败启动未修改旧版本')
  const encoded = await hashPassword('node-entrypoints-test-password-2026')
  const raw = JSON.stringify([{ name: '旧管理员', token: 'node-entrypoints-legacy-secret', role: 'admin', username: 'legacy-admin', passwordHash: encoded }])
  writeFileSync(file, raw)
  const importArgs = ['--db', target.sqlitePath, '--credentials', file, '--confirm-offline']
  check(run('import-credentials', importArgs).code === 1, 'Node 身份导入拒绝未升级 v3')
  check(run('migrate-db', ['migrate', '--db', target.sqlitePath]).code === 1, 'Node 迁移必须显式离线确认')
  const migrated = run('migrate-db', ['migrate', '--db', target.sqlitePath, '--confirm-offline'])
  check(migrated.code === 0 && migrated.output.includes('"status": "current"'), 'Node 完成一致性备份及 v3→v4 迁移')
  const current = run('migrate-db', ['inspect', '--db', target.sqlitePath])
  check(current.code === 0 && current.output.includes('"version": 4'), 'Node inspect 复核 v4')
  const imported = run('import-credentials', importArgs)
  check(imported.code === 0, 'Node 真实凭证导入成功')
  check(!imported.output.includes('node-entrypoints-legacy-secret') && !imported.output.includes(encoded), 'Node 导入输出不含凭证与密码哈希')
  const metadata = JSON.parse(imported.stdout)
  check(metadata.imported_entries === 1 && metadata.repeated === false, 'Node 首次导入数量正确')
  const repeated = run('import-credentials', importArgs)
  check(repeated.code === 0 && JSON.parse(repeated.stdout).repeated === true && JSON.parse(repeated.stdout).imported_entries === 0, 'Node 重复导入无重复写入')
  const repository = new IdentityRepository(target)
  check((await repository.verifyIdentity('node-entrypoints-legacy-secret')).name === '旧管理员', 'Node 导入凭证由正式鉴权解析')
  const account = await repository.read(tx => tx.get<{ password_hash: string }>('SELECT password_hash FROM login_accounts'))
  check(account?.password_hash === encoded, 'Node 迁移复用原合法密码哈希')
  const event = await repository.read(tx => tx.get<Record<string, unknown>>('SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,user_id,member_id FROM usage_event'))
  check(JSON.stringify(event) === JSON.stringify({ input_tokens: 2, output_tokens: 3, cache_read_tokens: 5, cache_write_tokens: 7, user_id: '旧管理员', member_id: null }), '旧历史四列不变且不凭同名自动归属')
  check(readFileSync(file, 'utf8') === raw, '源凭证文件逐字不变')
  console.log(`真实 Node 三入口验证通过（${checks} 项，独立 SQLite v3 副本→备份→v4→身份导入）`)
} finally {
  if (!resolve(dir).startsWith(join(resolve(tmpdir()), 'atr-node-entrypoints-'))) throw new Error('临时目录超出范围')
  rmSync(dir, { recursive: true, force: true })
}
