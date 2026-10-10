/** 发布后的助手能力验收入口：凭证只留在远端内存；支持 --check 只校验源码，不连接线上。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { host, runRemote } from './perf/runtime-ab/ssh-exec.mjs'
import { MYSQL, REMOTE_APPLY_SOURCE, wrapRemoteScript } from '../../../scripts/online-pricing-plan.mjs'

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('用法：bun packages/server/verify/verify-assistant-capabilities-online.mjs [--check]')
const delimiter = "if (CONFIG.mode === 'stats')"
if (!REMOTE_APPLY_SOURCE.includes(delimiter)) throw new Error('线上登录流程已变化，请核对验收脚本')
// ★ 只截取验证码与登录流程。管理写入分支永远不会拼进本次验收执行体。
const login = REMOTE_APPLY_SOURCE.split(delimiter)[0]
const checksSource = readFileSync(new URL('./assistant-capabilities-online-checks.mjs', import.meta.url), 'utf8')
const config = { mysql: MYSQL, baseUrl: `http://${host}/ai-token` }
const source = login.replace('__ATR_CONFIG_B64__', Buffer.from(JSON.stringify(config)).toString('base64')) + '\n' + checksSource
if (process.argv.includes('--check')) {
  if (typeof Bun === 'undefined') throw new Error('源码检查请使用 Bun 运行')
  new Bun.Transpiler({ loader: 'js', target: 'node' }).transformSync(source)
  // ★ 只执行本文件维护的纯 URL 判断函数，验证三种前端引用形式；不执行远端登录或任何请求。
  const matcherStart = checksSource.indexOf('function capabilitySourceHref('), matcherEnd = checksSource.indexOf('async function capabilityChat(')
  if (matcherStart < 0 || matcherEnd < matcherStart) throw new Error('来源格式验证函数已变化')
  const sourceHref = new Function(checksSource.slice(matcherStart, matcherEnd) + '\nreturn capabilitySourceHref;')()
  for (const citation of ['[来源](https://example.com)', '<https://example.com/>', '来源：https://example.com。']) {
    if (sourceHref(citation) !== 'https://example.com/') throw new Error('来源引用格式验证失败')
  }
  for (const unsafe of ['https://user:password@example.com/', 'https://example.com@invalid.example/', 'javascript:alert(1)']) {
    if (sourceHref(unsafe)) throw new Error('来源 URL 安全验证失败')
  }
  console.log('ASSISTANT_CAPABILITIES_ONLINE_READY ' + JSON.stringify({ status: 'PASS', mode: 'syntax-only', source_format_contract: 'PASS', remote_connected: false }))
} else {
  const remotePath = '/tmp/atr-assistant-capabilities-online-' + Date.now() + '.mjs'
  // ★ 既有包装器 set -e 可能在 Node 失败时提前退出；EXIT trap 保证失败也删除远端执行体。
  const script = wrapRemoteScript(source, remotePath).replace('set -eu', `set -eu\ntrap 'rm -f "${remotePath}"' EXIT`)
  const started = performance.now()
  let result
  try { result = runRemote(script) }
  catch {
    console.error('ASSISTANT_CAPABILITIES_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-execution', elapsed_ms: Math.round(performance.now() - started) }))
    process.exitCode = 1
  }
  if (result) {
    const lines = (result.stdout ?? '').split(/\r?\n/).filter(line => /^ASSISTANT_CAPABILITIES_ONLINE_(?:STEP|OK|FAILED) /.test(line))
    for (const line of lines) console.log(line)
    const passed = result.status === 0 && lines.some(line => line.startsWith('ASSISTANT_CAPABILITIES_ONLINE_OK '))
    const output = resolve('.artifacts/assistant-capabilities-online'); mkdirSync(output, { recursive: true })
    writeFileSync(resolve(output, 'latest.json'), JSON.stringify({ created_at: new Date().toISOString(), endpoint: config.baseUrl, status: passed ? 'PASS' : 'FAIL', elapsed_ms: Math.round(performance.now() - started), exit_code: result.status, checks: lines }, null, 2))
    if (!passed) {
      console.error('ASSISTANT_CAPABILITIES_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-or-login', elapsed_ms: Math.round(performance.now() - started) }))
      process.exitCode = 1
    }
  }
}
