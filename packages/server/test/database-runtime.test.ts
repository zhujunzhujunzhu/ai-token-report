import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, ensureSchema } from '@ai-token-report/core/db'
import { createHandlerFor } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'atr-server-runtime-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('部门启动拒绝旧库且不改历史；纯本地服务无需打开部门库', async () => {
  const dbPath = join(root, 'legacy.sqlite')
  const db = openDb(dbPath)
  ensureSchema(db)
  db.exec("INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,input_tokens) VALUES ('original:1','original',1,1,'','',11)")
  db.close()
  const before = readFileSync(dbPath)
  await expect(createHandlerFor({ dshHome: root, dbPath, mysqlUrl: '', requestLog: false })).rejects.toThrow('migrate-db.ts')
  expect(readFileSync(dbPath)).toEqual(before)
  const localRoot = join(root, 'local-only')
  const local = await createHandlerFor({ dshHome: localRoot, enableLocalApi: true, requestLog: false })
  expect(local.identityStore).toBeUndefined()
  expect(existsSync(join(localRoot, 'token-report', 'portal.sqlite'))).toBe(false)
  expect((await local.handler(new Request('http://localhost/api/local/identity'))).status).toBe(200)
})

test('旧凭证文件必须显式迁移，不能作为运行时身份源', async () => {
  const path = join(root, 'credentials.json')
  writeFileSync(path, JSON.stringify([{ name: '文件管理员', role: 'admin', token: 'file-secret' }]))
  await expect(createHandlerFor({ dshHome: root, credentialsPath: path, requestLog: false })).rejects.toThrow('显式数据库迁移')
  const app = await createHandlerFor({ dshHome: root, dbPath: join(root, 'fresh.sqlite'), mysqlUrl: '', adminToken: '', adminUsername: '', adminPassword: '', requestLog: false })
  const response = await app.handler(new Request('http://localhost/api/v1/admin/members', { headers: { Authorization: 'Bearer file-secret' } }))
  expect(response.status).toBe(503)
})
