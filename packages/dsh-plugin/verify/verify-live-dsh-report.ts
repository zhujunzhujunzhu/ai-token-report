/**
 * 真实 DSH + 真实模型 + 发布插件 + 已启动部门服务端的端到端验收。
 *
 * 显式设置 ATR_VERIFY_PORTAL_URL / ATR_VERIFY_TOKEN / ATR_VERIFY_NAME 后执行。
 * 只在临时 DSH_HOME 里复制模型配置；结束立即删除真实凭证副本，保留新会话
 * 与测试身份供 CLI 对同一 event_id 补报，验证两个上报入口共存时不会重复记账。
 */
import assert from 'node:assert/strict'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { scanAll } from '@ai-token-report/core'
import type { RecordsResponse } from '@ai-token-report/shared'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'

const portalUrl = process.env['ATR_VERIFY_PORTAL_URL']
const token = process.env['ATR_VERIFY_TOKEN']
const name = process.env['ATR_VERIFY_NAME']
// 新上报 Token 默认只有署名/写入权限；验收读数必须使用单独授权的只读或管理凭证。
const readToken = process.env['ATR_VERIFY_READ_TOKEN'] ?? token
assert.ok(portalUrl && token && name, '必须显式配置隔离验收服务端、测试 token 和测试姓名')
const node = resolveNodeBin()
assert.ok(node, '真实 DSH 验收需要真正的 Node')
const sourceHome = resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
const hostModules = process.env['ATR_DSH_MODULES'] ?? join(homedir(), '.bun/install/global/node_modules')
const req = createRequire(join(hostModules, '_atr-live-verify.cjs'))
const dshBin = join(dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const resumeHome = process.argv[2]
const home = resumeHome ? resolve(resumeHome) : mkdtempSync(join(tmpdir(), 'atr-live-dsh-'))
assert.ok(home.startsWith(resolve(tmpdir()) + '\\atr-live-dsh-') || home.startsWith(resolve(tmpdir()) + '/atr-live-dsh-'), '复查只接受本脚本创建的临时目录')
const profile = join(home, 'profiles/headless')
const modules = join(profile, 'node_modules')
const work = join(home, 'qa-workspace')
const secretCopies = ['settings.yaml', '.credentials.yaml'].map((file) => join(home, file))
const env: Record<string, string> = { ...cleanChildEnv(), DSH_HOME: home }
for (const key of Object.keys(env)) {
  if (key.startsWith('DSH_TOKEN_REPORT_') || key.startsWith('ATR_VERIFY_')) delete env[key]
}

let child: ReturnType<typeof Bun.spawn> | undefined
try {
  const started = Date.now()
  if (!resumeHome) {
  mkdirSync(modules, { recursive: true })
  mkdirSync(work)
  for (const file of ['settings.yaml', '.credentials.yaml']) {
    const source = join(sourceHome, file)
    assert.ok(existsSync(source), `真实模型配置缺少 ${file}`)
    copyFileSync(source, join(home, file))
  }
  cpSync(resolve(import.meta.dir, '../dist'), join(modules, 'dsh-plugin-token-report'), { recursive: true })
  symlinkSync(join(hostModules, '@deepseek-ai'), join(modules, '@deepseek-ai'), 'junction')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'atr-live-report-verification', private: true,
    dependencies: { 'dsh-plugin-token-report': JSON.parse(readFileSync(join(modules, 'dsh-plugin-token-report/package.json'), 'utf8')).version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-plugin-token-report'], patchReload: 'startup' } },
  }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  // JSON 是 YAML 的子集，测试凭证中的特殊字符无需手工拼接转义。
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'token-report', config: {
      appKey: token, endpoint: new URL('/api/v1/token-usage', portalUrl).href,
      batch: { maxRecords: 50, flushIntervalMillis: 250, timeoutMillis: 5000 },
      features: { reporting: true, tools: false, service: true, ui: false },
    } },
  ]))
  mkdirSync(join(home, 'token-report'))
  writeFileSync(join(home, 'token-report/identity.json'), JSON.stringify({ name, token, createdAt: Date.now(), updatedAt: Date.now() }), { mode: 0o600 })

  console.log(`真实 DSH 验收目录：${home}`)
  child = Bun.spawn([node, dshBin, '--profile', 'headless', 'Reply exactly OK. Do not call tools, read files, run commands, or perform any other work.'], {
    cwd: work, env, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child?.kill(), 120_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  // 原始日志可能包含宿主配置，仅输出验收结论；失败时也不把模型凭证写进工单。
  assert.equal(exitCode, 0, `真实 DSH 退出失败，exit=${exitCode}；未输出可能含凭证的原始日志`)
  assert.ok(stdout.includes('OK'), '真实模型未返回预期的 OK')
  assert.ok(!/plugin tree failed|ClientPackageCompositionError|duplicate loader entry/.test(stderr), '宿主插件装载失败')
  }
  const scanned = await scanAll(join(home, 'sessions'))
  assert.ok(scanned.records.length > 0, '真实会话必须产生计费事件')
  const evidence = { home, sessionsRoot: join(home, 'sessions'), elapsedMs: Date.now() - started, records: scanned.records }
  writeFileSync(join(home, 'billing-evidence.json'), JSON.stringify(evidence, null, 2))
  const url = new URL('/api/v1/stats/records', portalUrl)
  const verifyResponse = await fetch(new URL('/api/v1/identity/verify', portalUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
  const identity = await verifyResponse.json() as { ok: boolean; name?: string; member_id?: string }
  assert.equal(identity.ok, true, '本次上报凭证应能校验稳定身份')
  assert.equal(identity.name, name, '测试身份名称必须由服务端确认')
  assert.ok(identity.member_id, '新版数据库应提供稳定人员 ID')
  url.searchParams.set('identity_view', 'member')
  url.searchParams.set('member_id', identity.member_id)
  url.searchParams.set('period', 'today')
  url.searchParams.set('limit', '100')
  const response = await fetch(url, { headers: { Authorization: `Bearer ${readToken}` } })
  assert.equal(response.status, 200, '服务端看板明细应可读取')
  const page = await response.json() as RecordsResponse
  for (const record of scanned.records) {
    const row = page.rows.find((candidate) => candidate.eventId === record.eventId)
    assert.ok(row, `真实模型事件 ${record.eventId} 未进入服务端`)
    assert.equal(row.userId, name)
    assert.equal(row.member_id, identity.member_id)
    assert.equal(row.user_name_snapshot, name)
    assert.equal(row.inputTokens, record.usage.input)
    assert.equal(row.outputTokens, record.usage.output)
    assert.equal(row.cacheReadTokens, record.usage.cacheRead)
    assert.equal(row.cacheWriteTokens, record.usage.cacheWrite)
    assert.equal(row.totalTokens, record.usage.total)
  }
  console.log(JSON.stringify({ ...evidence, secretsRemoved: true }, null, 2))
} finally {
  if (child && child.exitCode === null) { child.kill(); await child.exited }
  // 只清理本次复制的两个文件；从不删除原始 DSH_HOME。
  for (const file of secretCopies) rmSync(file, { force: true })
  // 测试身份只含专用验收 token，可交给 CLI 补报；真实模型配置副本不可保留。
  assert.ok(secretCopies.every((file) => !existsSync(file)), '真实模型凭证副本未清理完成')
}
