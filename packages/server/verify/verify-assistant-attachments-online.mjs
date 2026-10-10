/** 发布后的上传链路验收：只输出固定检查名，凭证与合成附件仅留在远端内存。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { host, runRemote } from './perf/runtime-ab/ssh-exec.mjs'
import { MYSQL, REMOTE_APPLY_SOURCE, wrapRemoteScript } from '../../../scripts/online-pricing-plan.mjs'

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('用法：bun packages/server/verify/verify-assistant-attachments-online.mjs [--check]')
const delimiter = "if (CONFIG.mode === 'stats')"
if (!REMOTE_APPLY_SOURCE.includes(delimiter)) throw new Error('线上登录流程已变化，请核对验收脚本')
// ★ 不拼接管理写入分支；使用现有登录流程后，仅上传并删除本次自己的验收附件。
const login = REMOTE_APPLY_SOURCE.split(delimiter)[0]
const checks = readFileSync(new URL('./assistant-attachments-online-checks.mjs', import.meta.url), 'utf8')
const config = { mysql: MYSQL, baseUrl: `http://${host}/ai-token` }
const source = login.replace('__ATR_CONFIG_B64__', Buffer.from(JSON.stringify(config)).toString('base64')) + '\n' + checks
if (process.argv.includes('--check')) {
  if (typeof Bun === 'undefined') throw new Error('源码检查请使用 Bun 运行')
  new Bun.Transpiler({ loader: 'js', target: 'node' }).transformSync(source)
  console.log('ASSISTANT_ATTACHMENTS_ONLINE_READY ' + JSON.stringify({ status: 'PASS', mode: 'syntax-only', remote_connected: false }))
} else {
  const remotePath = '/tmp/atr-assistant-attachments-online-' + Date.now() + '.mjs'
  const script = wrapRemoteScript(source, remotePath).replace('set -eu', `set -eu\ntrap 'rm -f "${remotePath}"' EXIT`)
  const started = performance.now()
  let result
  try { result = runRemote(script) }
  catch {
    console.error('ASSISTANT_ATTACHMENTS_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-execution', elapsed_ms: Math.round(performance.now() - started) }))
    process.exitCode = 1
  }
  if (result) {
    const lines = (result.stdout ?? '').split(/\r?\n/).filter(line => /^ASSISTANT_ATTACHMENTS_ONLINE_(?:STEP|OK|FAILED) /.test(line))
    for (const line of lines) console.log(line)
    const passed = result.status === 0 && lines.some(line => line.startsWith('ASSISTANT_ATTACHMENTS_ONLINE_OK '))
    const output = resolve('.artifacts/assistant-attachments-online'); mkdirSync(output, { recursive: true })
    writeFileSync(resolve(output, 'latest.json'), JSON.stringify({ created_at: new Date().toISOString(), endpoint: config.baseUrl, status: passed ? 'PASS' : 'FAIL', elapsed_ms: Math.round(performance.now() - started), exit_code: result.status, checks: lines }, null, 2))
    if (!passed) {
      console.error('ASSISTANT_ATTACHMENTS_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-or-login', elapsed_ms: Math.round(performance.now() - started) }))
      process.exitCode = 1
    }
  }
}
