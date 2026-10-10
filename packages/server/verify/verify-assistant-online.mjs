/** 部署后的公网 HTTP/SSE 验收；只读业务统计，创建的测试对话最终删除，不输出凭证或原始数据。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { host, runRemote } from './perf/runtime-ab/ssh-exec.mjs'
import { MYSQL, REMOTE_APPLY_SOURCE, wrapRemoteScript } from '../../../scripts/online-pricing-plan.mjs'

// ★ 复用已验证的管理员登录与验证码绑定；截取点必须在任何管理写入逻辑之前。
const delimiter = "if (CONFIG.mode === 'stats')"
if (!REMOTE_APPLY_SOURCE.includes(delimiter)) throw new Error('线上登录流程已变化，请核对验收脚本')
const login = REMOTE_APPLY_SOURCE.split(delimiter)[0]
const body = readFileSync(new URL('./assistant-online-checks.mjs', import.meta.url), 'utf8')
const config = { mysql: MYSQL, baseUrl: `http://${host}/ai-token` }
const source = login.replace('__ATR_CONFIG_B64__', Buffer.from(JSON.stringify(config)).toString('base64')) + '\n' + body
const result = runRemote(wrapRemoteScript(source, '/tmp/atr-assistant-online-' + Date.now() + '.mjs'))
const lines = (result.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith('ASSISTANT_ONLINE_'))
for (const line of lines) console.log(line)
const output = resolve('.artifacts/assistant-online'); mkdirSync(output, { recursive: true })
writeFileSync(resolve(output, 'latest.json'), JSON.stringify({ created_at: new Date().toISOString(), endpoint: config.baseUrl, exit_code: result.status, checks: lines }, null, 2))
if (result.status !== 0 || !lines.some(line => line.startsWith('ASSISTANT_ONLINE_OK'))) {
  console.error('线上助手验收失败；未打印登录响应、原始业务数据或模型请求。')
  process.exitCode = 1
}
