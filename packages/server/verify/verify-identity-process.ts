/** 两个独立服务进程的真实 HTTP 验收；仅验证码图像观察和 KDF 时序通过私有管道注入。 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import type { PortalTarget } from '@ai-token-report/core/db'
import type { PortalMember, PortalMemberResult, PortalTokenResult, PortalAuditResponse } from '@ai-token-report/shared'
import { closeAllMysqlBackends } from '../../core/src/db/mysql.js'
import { createApp } from '../src/app.js'
import { DatabaseAdminRoute } from '../src/admin-route.js'
import { CredentialStore } from '../src/credentials.js'
import { IdentityRoute } from '../src/identity-route.js'
import { IngestRoute } from '../src/ingest-route.js'
import { StatsRoute } from '../src/stats-route.js'
import { PortalAuth } from '../src/auth/portal-auth.js'
import { createCaptchaImage } from '../src/auth/captcha.js'
import { IdentityRepository, ADMIN_ROLE_ID, MEMBER_ROLE_ID, PERMISSIONS } from '../src/identity/index.js'
import { serveWithPortRetry } from '../src/runtime/listen.js'
import { createIsolatedMysql } from './mysql-isolation.js'

interface Configuration { target: PortalTarget; dir: string; hmacKey: string }
interface Event { event: string; url?: string; pid?: number; answer?: string }

async function worker(): Promise<void> {
  const config = JSON.parse(process.env.ATR_IDENTITY_PROCESS_CONFIG!) as Configuration
  let armed = false, release: (() => void) | undefined
  const emit = (event: Event) => process.stdout.write(JSON.stringify(event) + '\n')
  const repository = new IdentityRepository(config.target, { afterPasswordHash: async () => {
    if (!armed) return
    armed = false
    await new Promise<void>((resolve) => { release = resolve; emit({ event: 'kdf-ready' }) })
  } })
  const app = createApp({
    credentials: CredentialStore.empty(), identityStore: repository,
    portalAuth: new PortalAuth(repository, { hmacKey: config.hmacKey, makeImage: () => {
      const captcha = createCaptchaImage(); emit({ event: 'answer', answer: captcha.answer }); return captcha
    } }),
    databaseAdminRoute: new DatabaseAdminRoute(repository),
    identityRoute: new IdentityRoute({ dshHome: config.dir }),
    ingestRoute: new IngestRoute({ identityStore: repository, dbPath: config.target.sqlitePath, mysqlUrl: config.target.mysqlUrl }),
    statsRoute: new StatsRoute({ identityStore: repository, dbPath: config.target.sqlitePath, mysqlUrl: config.target.mysqlUrl }),
    localStats: null, enableLocalApi: false, requestLog: false,
  })
  const listener = await serveWithPortRetry('127.0.0.1', 0, (request) => app.fetch(request))
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line === 'arm') { armed = true; emit({ event: 'armed' }) }
    if (line === 'release') { release?.(); release = undefined }
    if (line === 'stop') void (async () => { await listener.handle.stop(); await closeAllMysqlBackends(); process.exit(0) })()
  })
  emit({ event: 'ready', url: `http://127.0.0.1:${listener.port}`, pid: process.pid })
}

class Worker {
  readonly process: ChildProcessWithoutNullStreams
  readonly events: Event[] = []
  private waiters: (() => void)[] = []
  private stderr = ''
  url = ''
  pid = 0
  constructor(config: Configuration) {
    this.process = spawn(process.execPath, [fileURLToPath(import.meta.url), '--identity-worker'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ATR_IDENTITY_PROCESS_CONFIG: JSON.stringify(config) },
    })
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      try { this.events.push(JSON.parse(line) as Event) } catch { /* 忽略非协议启动日志，不回显可能含配置的内容。 */ }
      this.waiters.splice(0).forEach((resolve) => resolve())
    })
    this.process.stderr.on('data', (chunk) => { this.stderr += String(chunk).replace(/mysql:\/\/[^\s]+/g, '[redacted-mysql]') })
    this.process.on('exit', () => this.waiters.splice(0).forEach((resolve) => resolve()))
  }
  async event(name: string): Promise<Event> {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      const index = this.events.findIndex((event) => event.event === name)
      if (index >= 0) return this.events.splice(index, 1)[0]!
      if (this.process.exitCode !== null) throw new Error(`子进程提前退出 ${this.process.exitCode}: ${this.stderr}`)
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), new Promise<void>((resolve) => setTimeout(resolve, 100))])
    }
    throw new Error(`等待子进程事件 ${name} 超时`)
  }
  async ready(): Promise<this> { const event = await this.event('ready'); this.url = event.url!; this.pid = event.pid!; return this }
  command(line: string): void { this.process.stdin.write(line + '\n') }
  async stop(): Promise<void> {
    if (this.process.exitCode !== null) return
    const exited = new Promise<void>((resolve) => this.process.once('exit', () => resolve()))
    this.command('stop')
    const timer = setTimeout(() => this.process.kill(), 10_000)
    try { await exited } finally { clearTimeout(timer) }
  }
}

async function verify(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'atr-process-auth-'))
  const mysql = process.argv.includes('--mysql') ? await createIsolatedMysql() : null
  const config: Configuration = { dir, hmacKey: randomBytes(32).toString('hex'), target: { sqlitePath: join(dir, 'portal.sqlite'), ...(mysql ? { mysqlUrl: mysql.url } : {}) } }
  const repository = new IdentityRepository(config.target), password = 'process-fixture-password-2026'
  const bootstrap = 'atr-' + randomBytes(32).toString('hex')
  const workers: Worker[] = []
  let checks = 0
  const check = (condition: unknown, message: string) => { assert(condition, message); checks++ }
  const start = async () => { const w = new Worker(config); workers.push(w); return w.ready() }
  const request = (w: Worker, path: string, token?: string, body?: unknown, cookie?: string) => fetch(w.url + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Portal-Request': '1' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const challenge = async (w: Worker) => {
    const response = await request(w, 'auth/captcha'); check(response.status === 200, '验证码成功')
    const data = await response.json() as { captcha_id: string; image: string }
    const answer = (await w.event('answer')).answer!
    check(!('answer' in data) && data.image.startsWith('data:image/png;base64,'), 'HTTP不泄露答案且返回真实PNG')
    return { captcha_id: data.captcha_id, captcha: answer, cookie: response.headers.getSetCookie()[0]!.split(';')[0]! }
  }
  const login = async (w: Worker, c: Awaited<ReturnType<typeof challenge>>, username = 'admin', value = password) => request(w, 'auth/login', undefined, { username, password: value, captcha_id: c.captcha_id, captcha: c.captcha }, c.cookie)
  const createMember = async (w: Worker, name: string, role: string) => {
    const response = await request(w, 'admin/members', bootstrap, { name, role_ids: [role] })
    check(response.status === 200, '真HTTP创建人员')
    return (await response.json() as PortalMemberResult).member!
  }
  const issue = async (w: Worker, member: PortalMember) => {
    const response = await request(w, 'admin/members/tokens', bootstrap, { member_id: member.member_id, label: '进程测试', scopes: PERMISSIONS })
    check(response.status === 200, '真HTTP签发管理范围凭证')
    return (await response.json() as PortalTokenResult).token_secret!
  }
  try {
    await repository.initialize({ adminToken: bootstrap, adminName: '初始管理员', adminUsername: 'admin', adminPassword: password })
    let a = await start(), b = await start()
    check(a.pid !== b.pid && a.pid !== process.pid, '两个独立服务进程')
    const first = await challenge(a), signed = await login(b, first)
    check(signed.status === 200, 'A验证码由B登录')
    const cookie = signed.headers.getSetCookie().find((value) => value.startsWith('atr_portal_session='))!.split(';')[0]!
    check((await request(a, 'auth/session', undefined, undefined, cookie)).status === 200, 'B会话在A有效')
    const pendingCaptcha = await challenge(a)
    await a.stop(); await b.stop(); a = await start(); b = await start()
    check((await request(a, 'auth/session', undefined, undefined, cookie)).status === 200, '所有服务重启后Session仍有效')
    check((await login(b, pendingCaptcha)).status === 200, '所有服务重启后验证码仍有效')
    check((await login(a, pendingCaptcha)).status === 400, '跨进程重放已消费验证码拒绝')
    for (let i = 0; i < 5; i++) {
      const source = i % 2 ? a : b, receiver = i % 2 ? b : a
      check((await login(receiver, await challenge(source), 'missing-user', 'wrong-password')).status === 401, '跨进程累计错误密码')
    }
    await b.stop(); b = await start()
    check((await login(b, await challenge(a), 'missing-user')).status === 429, '重启不能清零账号限流')

    const operator = await createMember(a, '待撤权管理员', ADMIN_ROLE_ID), victim = await createMember(b, '密码目标', MEMBER_ROLE_ID)
    const operatorToken = await issue(a, operator)
    a.command('arm'); await a.event('armed')
    const pending = request(a, 'admin/members/login', operatorToken, { member_id: victim.member_id, expected_version: victim.version, username: 'victim', password })
    await a.event('kdf-ready')
    const demotion = await request(b, 'admin/members/roles', bootstrap, { member_id: operator.member_id, expected_version: operator.version, role_ids: [MEMBER_ROLE_ID] })
    check(demotion.status === 200, 'B在A真实KDF结束后撤销操作者权限')
    a.command('release')
    check((await pending).status === 403, 'A提交时重验权限并拒绝旧授权')
    const members = await (await request(b, 'admin/members', bootstrap)).json() as { members: PortalMember[] }
    check(members.members.find((m) => m.member_id === victim.member_id)!.account === null, '被拒密码事务未创建账号')
    const audit = await (await request(b, 'admin/audit?target_type=member&target_id=' + victim.member_id + '&from=0&to=' + (Date.now() + 1000), bootstrap)).json() as PortalAuditResponse
    check(audit.total === 1 && audit.rows.length === 1 && audit.rows[0]!.action === 'member.create', '审计筛选准确且没有伪成功密码记录')

    const second = await createMember(b, '第二永久管理员', ADMIN_ROLE_ID), secondToken = await issue(a, second)
    const original = members.members.find((m) => m.name === '初始管理员')!
    const races = await Promise.all([
      request(a, 'admin/members/roles', bootstrap, { member_id: second.member_id, expected_version: second.version, role_ids: [MEMBER_ROLE_ID] }),
      request(b, 'admin/members/roles', secondToken, { member_id: original.member_id, expected_version: original.version, role_ids: [MEMBER_ROLE_ID] }),
    ])
    check(races.filter((r) => r.status === 200).length === 1, '两进程互降级最多一次成功')
    check(races.some((r) => r.status === 403 || r.status === 409), '另一事务明确拒绝')
    check((await repository.health()).admin_count === 1, '数据库仍保留一个永久管理员')
    const winnerToken = races[0]!.status === 200 ? bootstrap : secondToken
    const live = await (await request(a, 'admin/members', winnerToken)).json() as { members: PortalMember[] }
    const winner = live.members.find((m) => m.roles.some((role) => role.code === 'admin'))!
    const last = await request(b, 'admin/members/status', winnerToken, { member_id: winner.member_id, expected_version: winner.version, status: 'disabled' })
    check(last.status === 409, '真HTTP不能停用最后永久管理员')
    console.log(`${typeof Bun === 'undefined' ? 'Node' : 'Bun'} ${mysql ? 'MySQL' : 'SQLite'} 两个独立进程 HTTP 验证通过（${checks} 项）`)
  } finally {
    await Promise.allSettled(workers.map((w) => w.stop()))
    await closeAllMysqlBackends()
    if (mysql) await mysql.dispose()
    if (resolve(dir).startsWith(join(resolve(tmpdir()), 'atr-process-auth-'))) rmSync(dir, { recursive: true, force: true })
  }
}

// 必须在类声明初始化后再进入主流程，Node ESM 不会提升 class 初始化。
if (process.argv.includes('--identity-worker')) await worker()
else await verify()
