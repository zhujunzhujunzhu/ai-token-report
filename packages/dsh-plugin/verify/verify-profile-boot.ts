/**
 * 从真实 tarball 装入临时 profile：重现 0.3.0 重复 ID、修复、真 Loader 启动。
 * 最后启动完整 DSH Web 并访问 HTTP，避免把 import 成功误当成可用。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'
import { hostRequire } from '../scripts/repair-profile.js'

const node = resolveNodeBin()
assert.ok(node, '缺少真正的 Node，不能跳过启动验证')
const tarball = resolve(process.argv[2] ?? '')
assert.ok(tarball.endsWith('.tgz'), '请传入 bun pm pack 生成的 .tgz')
const home = mkdtempSync(join(tmpdir(), 'atr-profile-release-'))
const profile = join(home, 'profiles', 'web')
const modules = join(profile, 'node_modules')
const installed = join(modules, 'dsh-plugin-token-report')
mkdirSync(installed, { recursive: true })
const req = hostRequire(profile)
const bootUrl = pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href
const dshBin = join(dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
const env: Record<string, string> = { ...cleanChildEnv(), DSH_HOME: home }
for (const key of Object.keys(env)) {
  if (key.startsWith('DSH_TOKEN_REPORT_') || key === 'ATR_ADMIN_TOKEN') delete env[key]
}
let child: ReturnType<typeof Bun.spawn> | undefined
function run(args: string[], cwd = home, extra = {}) {
  const result = Bun.spawnSync(args, { cwd, env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout)
}
try {
  cpSync(tarball, join(home, 'candidate.tgz'))
  const listing = run(['tar', '-tzf', 'candidate.tgz']).trim().split(/\r?\n/)
  assert.ok(listing.every((p) => p.startsWith('package/') && !p.split('/').includes('..')), 'tarball 路径越界')
  const extracted = join(home, 'extracted')
  mkdirSync(extracted)
  run(['tar', '-xzf', 'candidate.tgz', '-C', 'extracted'])
  cpSync(join(extracted, 'package'), installed, { recursive: true })
  // 联接的是宿主解析出的实际模块目录；不在 tarball 里偷塞 workspace 依赖。
  const telemetryDir = dirname(req.resolve('@deepseek-ai/dsh-session-telemetry/package.json'))
  const hostScope = dirname(telemetryDir)
  symlinkSync(hostScope, join(modules, '@deepseek-ai'), 'junction')
  const repairUrl = pathToFileURL(join(installed, 'repair-profile.mjs')).href
  const probe = `
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { boot, composeEntries, loadOptionalPatches, loadProfile, healProfilesModuleFallback } from ${JSON.stringify(bootUrl)};
import { repairProfile } from ${JSON.stringify(repairUrl)};
assert.equal(typeof Bun, 'undefined');
const home = process.env.DSH_HOME;
const dir = join(home, 'profiles', 'web');
const pkg = join(dir, 'package.json');
const userPatch = join(dir, 'cordis.patch.yml');
const root = join(dir, 'cordis.yml');
writeFileSync(root, '[]');
const bundle = loadOptionalPatches('verify', join(dir, 'node_modules/dsh-plugin-token-report/cordis.patch.yml'));
const config = {features:{reporting:false,tools:false,ui:false},ui:{position:'both'}};
async function mount(patches) {
  const ctx = await boot('verify', root, patches, ctx => ctx.provide('sessions', {list:()=>[]}));
  assert.ok(ctx.get('tokenReport'), '真实 Loader 必须激活插件服务');
  await ctx.fiber.dispose();
}
await mount([...bundle, {id:'token-report',config}]);
console.log('PASS 干净安装：tarball → 真实 Loader');
let reproduced = false;
try { await mount([...bundle, {insert:[{id:'token-report',name:'dsh-plugin-token-report',config}]}]); }
catch(e) { let error=e; while(error) { if(error.message.includes('duplicate loader entry id: token-report')) reproduced=true; error=error.cause; } }
assert.ok(reproduced, '必须先复现截图中的重复 ID');
console.log('PASS 重现 0.3.0 duplicate loader entry id');
const legacy = '# 保留原配置备份\\n- insert:\\n    - id: token-report\\n      name: dsh-plugin-token-report\\n      config:\\n        features: { reporting: false, tools: false, ui: false }\\n        ui: { position: both }\\n- id: session-telemetry-otel\\n  disabled: true\\n';
writeFileSync(pkg, JSON.stringify({private:true,dependencies:{'dsh-plugin-token-report':'0.3.0','@ai-token-report/dsh-plugin':'file:old'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@ai-token-report/dsh-plugin','dsh-plugin-token-report','dsh-plugin-token-report']}}}));
writeFileSync(userPatch, legacy);
// 表达式只往返序列化，不执行；这里挂在已禁用的 OTel 条目上。
writeFileSync(userPatch, legacy + '  config:\\n    endpoint: !!js process.env.VERIFY_EXPRESSION\\n');
const legacyWithExpression = readFileSync(userPatch,'utf8');
const before = readFileSync(pkg,'utf8');
assert.equal((await repairProfile(dir,home,false)).changed,true);
assert.equal(readFileSync(pkg,'utf8'),before);
assert.equal(readFileSync(userPatch,'utf8'),legacyWithExpression);
const result = await repairProfile(dir,home,true);
assert.ok(result.backup && existsSync(join(result.backup,'package.json')));
assert.equal(readFileSync(join(result.backup,'cordis.patch.yml'),'utf8'),legacyWithExpression);
assert.equal((await repairProfile(dir,home,true)).changed,false);
const overrides = loadOptionalPatches('verify',userPatch);
assert.equal(overrides.find(p=>p.id==='session-telemetry-otel').config.endpoint.__jsExpr,'process.env.VERIFY_EXPRESSION');
assert.deepEqual(overrides.find(p=>p.id==='token-report').config,config);
await mount([...bundle,...overrides.filter(p=>p.id==='token-report')]);
console.log('PASS 升级修复：只读检查、原文备份、配置保留、幂等、Loader 再启动');
const globalPatch = join(home,'cordis.patch.yml');
writeFileSync(globalPatch, '- insert:\\n    - id: token-report\\n      name: dsh-plugin-token-report\\n');
const unchanged = readFileSync(userPatch,'utf8');
await assert.rejects(repairProfile(dir,home,true),/duplicate loader entry/);
assert.equal(readFileSync(userPatch,'utf8'),unchanged);
unlinkSync(globalPatch);
console.log('PASS 全局层仍冲突时拒绝写入，!!js 表达式往返保留');
// 开启 UI 后运行完整宿主；无身份且禁用上报，不访问员工凭证。
writeFileSync(userPatch, '- id: session-telemetry-otel\\n  disabled: true\\n- id: token-report\\n  config:\\n    features: { reporting: false }\\n');
const profile = loadProfile('verify','web',${JSON.stringify(req.resolve('@deepseek-ai/dsh/package.json'))},home);
await healProfilesModuleFallback({installAnchor:${JSON.stringify(req.resolve('@deepseek-ai/dsh/package.json'))},profile,home});
`
  const probeFile = join(home, 'probe.mjs')
  writeFileSync(probeFile, probe)
  process.stdout.write(run([node, probeFile]))
  process.stdout.write(run([node, join(installed, 'repair-profile.mjs'), '--profile', 'web']))
  // 同一份解包产物的浏览器信封、平台模块与挂载点也必须执行验证。
  process.stdout.write(run([process.execPath, join(import.meta.dir, 'verify-client-bundle.ts')], home, { ATR_PLUGIN_PACKAGE_DIR: installed }))
  let logs = ''
  child = Bun.spawn([node, dshBin, '--profile', 'web', '--no-open', '--port', '0'], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' })
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk)
  }
  const readers = [collect(child.stdout as ReadableStream<Uint8Array>), collect(child.stderr as ReadableStream<Uint8Array>)]
  const deadline = Date.now() + 60_000
  let ready = false
  let lastResponse = ''
  while (Date.now() < deadline && child.exitCode === null) {
    const address = logs.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\u001b]*/)?.[0]
    if (address) {
      try {
        const auth = await fetch(address, { signal: AbortSignal.timeout(2000), proxy: '', redirect: 'manual' })
        const cookie = auth.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
        await auth.body?.cancel()
        const page = await fetch(new URL('/', address), { headers: { cookie }, signal: AbortSignal.timeout(2000), proxy: '' })
        const html = await page.text()
        lastResponse = `HTTP ${page.status}, ${html.length} bytes, ${html.slice(0, 80)}`
        ready = page.ok && /<html/i.test(html)
        if (ready) {
          const config = await fetch(new URL('/api/tokenReport.config', address), { headers: { cookie }, proxy: '', signal: AbortSignal.timeout(2000) })
          ready = config.ok && (await config.text()).includes('dock')
          if (ready) break
        }
      } catch (error) { lastResponse = String(error) }
    }
    await Bun.sleep(150)
  }
  assert.ok(ready, `DSH Web 未就绪：${lastResponse}\n${logs.replace(/token=[^\s&]+/g, 'token=<redacted>').slice(-5000)}`)
  assert.ok(!/duplicate loader entry|plugin tree failed|ClientPackageCompositionError/.test(logs), '完整宿主启动日志出现装载错误')
  console.log('PASS 完整 DSH Web：真实 tarball、临时 profile、HTTP 200')
  child.kill()
  await child.exited
  await Promise.all(readers)
} finally {
  if (child && child.exitCode === null) { child.kill(); await child.exited }
  assert.ok(relative(tmpdir(), home).startsWith('atr-profile-release-'), '清理目录必须属于本次临时验证')
  rmSync(home, { recursive: true, force: true })
}
