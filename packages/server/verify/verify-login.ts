/** Bun / Node 共用的真 HTTP 登录验收，所有凭证和数据均在临时目录生成。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../src/app.js'
import { DatabaseAdminRoute } from '../src/admin-route.js'
import { CredentialStore } from '../src/credentials.js'
import { seedDatabaseIdentity } from '../test/database-fixture.js'
import { IdentityRoute } from '../src/identity-route.js'
import { IngestRoute } from '../src/ingest-route.js'
import { StatsRoute } from '../src/stats-route.js'
import { hashPassword } from '../src/auth/password.js'
import { createCaptchaImage } from '../src/auth/captcha.js'
import { PortalAuth } from '../src/auth/portal-auth.js'
import { serveWithPortRetry } from '../src/runtime/listen.js'

const root = resolve(tmpdir())
const dir = mkdtempSync(join(root, 'atr-login-verify-'))
const path = join(dir, 'credentials.json')
const password = 'fixture-password-2026'
writeFileSync(
  path,
  JSON.stringify([
    {
      name: '验收管理员',
      role: 'admin',
      token: 'fixture-report-token',
      username: 'fixture-admin',
      passwordHash: await hashPassword(password),
    },
  ]),
)
const repository = await seedDatabaseIdentity({ sqlitePath: join(dir, 'portal.sqlite') }, [{
  name: '验收管理员', role: 'admin', token: 'fixture-report-token',
  username: 'fixture-admin', passwordHash: await hashPassword(password),
}])
const store = CredentialStore.empty()
let answer = ''
const auth = new PortalAuth(repository, { hmacKey: 'isolated-captcha-key-at-least-32-characters', makeImage: () => {
  const generated = createCaptchaImage()
  answer = generated.answer
  return generated
} })
const app = createApp({
  credentials: store,
  identityStore: repository,
  portalAuth: auth,
  databaseAdminRoute: new DatabaseAdminRoute(repository),
  identityRoute: new IdentityRoute({ dshHome: dir }),
  ingestRoute: new IngestRoute({
    identityStore: repository,
    dbPath: join(dir, 'portal.sqlite'),
  }),
  statsRoute: new StatsRoute({
    identityStore: repository,
    dbPath: join(dir, 'portal.sqlite'),
  }),
  localStats: null,
  enableLocalApi: false,
  requestLog: false,
})
const listener = await serveWithPortRetry('127.0.0.1', 0, (req) =>
  app.fetch(req),
)
const url = `http://127.0.0.1:${listener.port}/api/v1`
try {
  assert(listener.port > 0, '端口 0 必须回传系统分配的真实端口')
  assert.equal(listener.port, listener.handle.port)
  assert.equal(listener.shifted, false)
  const challenge = await fetch(url + '/auth/captcha')
  assert.equal(challenge.status, 200)
  const data = (await challenge.json()) as { captcha_id: string; image: string }
  assert(data.image.startsWith('data:image/png;base64,'))
  assert(!('answer' in data))
  const binding = challenge.headers.getSetCookie()[0]!.split(';')[0]!
  const login = await fetch(url + '/auth/login', {
    method: 'POST',
    headers: {
      Cookie: binding,
      'Content-Type': 'application/json',
      'X-Portal-Request': '1',
    },
    body: JSON.stringify({
      username: 'fixture-admin',
      password,
      captcha_id: data.captcha_id,
      captcha: answer,
    }),
  })
  assert.equal(login.status, 200)
  const cookieHeaders = login.headers.getSetCookie()
  assert.equal(
    cookieHeaders.length,
    2,
    '验证码删除和会话签发必须是两条独立 Set-Cookie',
  )
  const sessionHeader = cookieHeaders.find((value) =>
    value.startsWith('atr_portal_session='),
  )!
  assert(sessionHeader.includes('HttpOnly'))
  assert(sessionHeader.includes('SameSite=Strict'))
  const cookie = sessionHeader.split(';')[0]!
  const body = await login.text()
  assert(!body.includes('fixture-report-token'))
  assert(!body.includes('passwordHash'))
  assert.equal(
    (await fetch(url + '/admin/members', { headers: { Cookie: cookie } }))
      .status,
    200,
  )
  assert.equal(
    (await fetch(url + '/auth/session', { headers: { Cookie: cookie } }))
      .status,
    200,
  )
  assert.equal(
    (
      await fetch(url + '/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Portal-Request': '1' },
      })
    ).status,
    200,
  )
  assert.equal(
    (await fetch(url + '/auth/session', { headers: { Cookie: cookie } }))
      .status,
    401,
  )
  console.log(
    `${typeof Bun === 'undefined' ? 'Node' : 'Bun'} 真 HTTP 登录验证通过（17 项）`,
  )
} finally {
  await listener.handle.stop()
  if (resolve(dir).startsWith(join(root, 'atr-login-verify-')))
    rmSync(dir, { recursive: true, force: true })
}
