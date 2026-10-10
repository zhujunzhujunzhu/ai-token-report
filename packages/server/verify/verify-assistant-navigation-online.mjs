/** 线上自然语言 appKey 导航验收入口；凭证仅留在远端内存，--check 不连接线上。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { host, runRemote } from './perf/runtime-ab/ssh-exec.mjs'
import { MYSQL, REMOTE_APPLY_SOURCE, wrapRemoteScript } from '../../../scripts/online-pricing-plan.mjs'

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('用法：bun packages/server/verify/verify-assistant-navigation-online.mjs [--check]')
const delimiter = "if (CONFIG.mode === 'stats')"
if (!REMOTE_APPLY_SOURCE.includes(delimiter)) throw new Error('线上登录流程已变化，请核对导航验收脚本')
// ★ 管理写入分支永不进入执行体；只复用已有验证码、登录和登出链路。
const login = REMOTE_APPLY_SOURCE.split(delimiter)[0]
const checksSource = readFileSync(new URL('./assistant-navigation-online-checks.mjs', import.meta.url), 'utf8')
const config = { mysql: MYSQL, baseUrl: `http://${host}/ai-token` }
const source = login.replace('__ATR_CONFIG_B64__', Buffer.from(JSON.stringify(config)).toString('base64')) + '\n' + checksSource
if (process.argv.includes('--check')) {
  if (typeof Bun === 'undefined') throw new Error('源码检查请使用 Bun 运行')
  new Bun.Transpiler({ loader: 'js', target: 'node' }).transformSync(source)
  const contractStart = checksSource.indexOf('function navigationContract('), contractEnd = checksSource.indexOf('async function navigationChat(')
  if (contractStart < 0 || contractEnd < contractStart) throw new Error('导航契约验证函数已变化')
  const contract = new Function(checksSource.slice(contractStart, contractEnd) + '\nreturn navigationContract;')()
  const fixedCall = '3c78c51a-7c1d-4b45-99eb-90f5c54d22d6'
  const sample = search => [
    { type: 'tool', tool: 'portal_navigate', query: '/appkeys', state: 'running', status: 202, call_id: fixedCall },
    { type: 'navigate', path: '/appkeys', ...(search !== undefined ? { search } : {}) },
    { type: 'tool', tool: 'portal_navigate', query: '/appkeys', state: 'completed', status: 202, call_id: fixedCall },
  ]
  if (contract(sample(), undefined) || contract(sample('固定验收词'), '固定验收词')) throw new Error('有效导航事件契约验证失败')
  const mutations = [
    events => { events[1].path = '/records' },
    events => { events[1].search = '错误搜索词' },
    events => { events[1].filters = { period: 'yesterday' } },
    events => { events[2].call_id = 'another-call' },
    events => { events[2].status = 200 },
    events => { events[2].state = 'failed'; events[2].status = 400 },
    events => { events[2].tool = 'stats_overview' },
    events => { events.push({ ...events[1] }) },
  ]
  for (const mutate of mutations) {
    const events = sample(); mutate(events)
    if (!contract(events, undefined)) throw new Error('无效导航事件没有被拦截')
  }
  console.log('ASSISTANT_NAVIGATION_ONLINE_READY ' + JSON.stringify({ status: 'PASS', mode: 'syntax-and-contract', invalid_contracts_rejected: mutations.length, remote_connected: false }))
} else {
  const remotePath = '/tmp/atr-assistant-navigation-online-' + Date.now() + '.mjs'
  const script = wrapRemoteScript(source, remotePath).replace('set -eu', `set -eu\ntrap 'rm -f "${remotePath}"' EXIT`)
  const started = performance.now()
  let result
  try { result = runRemote(script) }
  catch {
    console.error('ASSISTANT_NAVIGATION_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-execution', elapsed_ms: Math.round(performance.now() - started) }))
    process.exitCode = 1
  }
  if (result) {
    const lines = (result.stdout ?? '').split(/\r?\n/).filter(line => /^ASSISTANT_NAVIGATION_ONLINE_(?:STEP|OK|FAILED) /.test(line))
    for (const line of lines) console.log(line)
    const passed = result.status === 0 && lines.some(line => line.startsWith('ASSISTANT_NAVIGATION_ONLINE_OK '))
    const output = resolve('.artifacts/assistant-navigation-online'); mkdirSync(output, { recursive: true })
    writeFileSync(resolve(output, 'latest.json'), JSON.stringify({ created_at: new Date().toISOString(), endpoint: config.baseUrl, status: passed ? 'PASS' : 'FAIL', elapsed_ms: Math.round(performance.now() - started), exit_code: result.status, checks: lines }, null, 2))
    if (!passed) {
      console.error('ASSISTANT_NAVIGATION_ONLINE_FAILED ' + JSON.stringify({ status: 'FAIL', check: 'remote-or-login', elapsed_ms: Math.round(performance.now() - started) }))
      process.exitCode = 1
    }
  }
}
