/** 真 DSH Web 冷启动和 HTTP 查询验收；默认合成日志，可显式传 --sessions-root 测本机副本。 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { hostRequire } from '../scripts/repair-profile.js'
import { cleanChildEnv, resolveNodeBin, scratchDataDir, scratchDshHomes } from '../../core/verify/lib/runtime.js'

const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const source = option('--sessions-root')
const plugin = resolve(option('--plugin-dir') ?? join(import.meta.dir, '../dist'))
const home = mkdtempSync(join(tmpdir(), 'atr-startup-'))
let child: ReturnType<typeof Bun.spawn> | undefined
let logs = ''
try {
  const profile = join(home, 'profiles/web')
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const req = hostRequire(profile)
  const node = resolveNodeBin()
  assert.ok(node, '需要真实 Node 运行 DSH')
  const dsh = join(dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
  symlinkSync(dirname(dirname(req.resolve('@deepseek-ai/dsh-session-telemetry/package.json'))), join(modules, '@deepseek-ai'), 'junction')
  cpSync(plugin, join(modules, 'dsh-plugin-token-report'), { recursive: true })
  if (source) cpSync(resolve(source), join(home, 'sessions'), { recursive: true })
  else {
    const dir = join(home, 'sessions/project/session-1')
    mkdirSync(dir, { recursive: true })
    const frames: Buffer[] = []
    for (let seq = 1; seq <= 5000; seq++) frames.push(zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', seq,
      time: Date.now(), data: { message: { source: { provider: 'verify', model: 'startup' } },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 80, cacheWriteTokens: 3 } } }) + '\n')))
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(frames))
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-token-report'],
  } } }))
  writeFileSync(join(profile, 'cordis.yml'), '[]')
  // ★ 刻意**不再**写 `- id: session-telemetry-otel / disabled: true`：
  //   0.9.0 起本插件不注册 `sessionTelemetry` 服务（改订阅宿主会话事件流），
  //   官方 OTel 留在组装里也能启动 —— 这里顺便当一条共存冒烟。
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: token-report\n  config:\n    features: { reporting: false }\n')
  const env = cleanChildEnv()
  for (const key of Object.keys(env)) if (key.startsWith('DSH_TOKEN_REPORT_') || key.startsWith('DSH_REPORT_')) delete env[key]
  env.DSH_HOME = home
  // ★ 数据目录**不跟随 `DSH_HOME`**（缺省是家目录下的 `~/.ai-token-report`）：
  //   不显式给这一项，插件的本地库 / outbox / 身份就会落到使用者真实的目录里。
  env.DSH_TOKEN_REPORT_DATA_DIR = scratchDataDir(home)
  // ★ 同理钉住日志根：默认自动发现会连带扫使用者真实的 home，
  //   于是下面「5000 条 / 475000」的固定期望值会与真实用量混在一起 ——
  //   在装了 DSH 的机器上必失败、在干净 CI 上反而通过。
  env.DSH_TOKEN_REPORT_DSH_HOMES = scratchDshHomes(home)
  // ★ 关掉「非 DSH 来源」（Codex / Claude Code / Trae / WorkBuddy）。0.8.0 起它们
  //   缺省就一起统计，而本脚本断言的是**绝对条数**（5000 次调用）—— 不关的话，
  //   本机真实用量会混进来（本机实测多出 635 次调用：装了别的客户端就必失败，
  //   干净 CI 上反而通过）。与 `scripts/test-preload.ts` 做的是同一件事。
  //   ⚠️ 必须写在上面那条 delete 循环**之后** —— 它会清掉所有 `DSH_TOKEN_REPORT_*`。
  for (const key of [
    'DSH_TOKEN_REPORT_DISCOVER',
    'DSH_TOKEN_REPORT_CODEX',
    'DSH_TOKEN_REPORT_CLAUDE',
    'DSH_TOKEN_REPORT_TRAE',
    'DSH_TOKEN_REPORT_TRAE_CN',
    'DSH_TOKEN_REPORT_WORKBUDDY',
  ]) env[key] = '0'
  const start = performance.now()
  // 直接运行 dsh 的 CLI 入口，绕开 Windows 包管理器 shim，确保 finally 只终止本次宿主。
  child = Bun.spawn([node, dsh, '--profile', 'web', '--no-open', '--port', '0'], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' })
  const collect = async (stream: ReadableStream<Uint8Array>) => { for await (const c of stream) logs += new TextDecoder().decode(c) }
  void collect(child.stdout as ReadableStream<Uint8Array>); void collect(child.stderr as ReadableStream<Uint8Array>)
  let address: string | undefined
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && child.exitCode === null) {
    address = logs.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\u001b]*/)?.[0]
    if (address) break
    await Bun.sleep(100)
  }
  assert.ok(address, 'DSH 未能启动')
  const auth = await fetch(address, { redirect: 'manual', proxy: '', signal: AbortSignal.timeout(5000) })
  const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  await auth.body?.cancel()
  console.log(JSON.stringify({ stage: 'dsh-ready', ms: Math.round(performance.now() - start) }))
  const get = async (path: string) => {
    const response = await fetch(new URL(path, address), { headers: { cookie }, proxy: '', signal: AbortSignal.timeout(60_000) })
    assert.equal(response.status, 200)
    return response.json() as Promise<any>
  }
  let totals: unknown
  for (const label of ['cold', 'hot', 'detail']) {
    const at = performance.now()
    const path = '/api/tokenReport.stats?period=month&' + (label === 'detail' ? 'view=detail&by=session&page=1' : 'view=summary') + (label === 'hot' ? '&refresh=1' : '')
    const request = get(path)
    const probe = performance.now()
    await get('/api/tokenReport.config')
    const configMs = Math.round(performance.now() - probe)
    const data = await request
    assert.equal(data.source, 'local-db', data.error ?? data.degradedReason)
    assert.ok(data.totals)
    if (!source) { assert.equal(data.totals.calls, 5000); assert.equal(data.totals.total, 475000) }
    if (totals) assert.deepEqual(data.totals, totals)
    totals = data.totals
    console.log(JSON.stringify({ label, ms: Math.round(performance.now() - at), configMs, calls: data.totals.calls }))
  }
  assert.ok(!/duplicate loader entry|plugin tree failed|ClientPackageCompositionError/.test(logs))
} catch (error) {
  console.error(logs.replace(/token=[^\s&]+/g, 'token=<redacted>').slice(-3000))
  throw error
} finally {
  if (child && child.exitCode === null) { child.kill(); await child.exited }
  const rel = relative(tmpdir(), home)
  assert.ok(rel.startsWith('atr-startup-') && !rel.includes('..'), '只能清理本次隔离验证目录')
  rmSync(home, { recursive: true, force: true })
}
