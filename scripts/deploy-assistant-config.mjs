/** 仅通过 SSH stdin 同步本地助手配置；备份并原子更新服务端环境，不输出凭证。 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assistantConfigFromEnv } from '../packages/server/src/assistant/config.ts'
import { host, password, user, hostkey } from '../packages/server/verify/perf/runtime-ab/ssh-exec.mjs'

const argumentsList = process.argv.slice(2)
if (argumentsList.some(arg => !['--apply', '--check'].includes(arg)) || argumentsList.length > 1) throw new Error('用法：bun --env-file=.env scripts/deploy-assistant-config.mjs --check|--apply')
const mode = argumentsList.includes('--apply') ? 'apply' : 'check'
const config = assistantConfigFromEnv(process.env)
if (!config) throw new Error('本地助手未启用；请检查根目录 .env')
const key = process.env[config.apiKeyEnv]
if (!key?.trim()) throw new Error('本地模型凭证未填写；未连接服务器')
const values = {
  ATR_ASSISTANT_ENABLED: '1', ATR_ASSISTANT_PROTOCOL: config.protocol,
  ATR_ASSISTANT_BASE_URL: config.baseUrl ?? '', ATR_ASSISTANT_MODEL: config.model,
  ATR_ASSISTANT_SUPPORTS_IMAGES: config.supportsImages === true ? '1' : '0',
  ...(config.maxTokens === undefined ? {} : { ATR_ASSISTANT_MAX_TOKENS: String(config.maxTokens) }),
  ...(config.reasoningEffort === undefined ? {} : { ATR_ASSISTANT_REASONING_EFFORT: config.reasoningEffort }),
  ATR_ASSISTANT_API_KEY_ENV: 'ATR_ASSISTANT_API_KEY', ATR_ASSISTANT_API_KEY: key,
}
const payload = Buffer.from(JSON.stringify(values)).toString('base64')
const script = `set -eu
umask 077
set -a
. /root/.atr/portal.env
set +a
/usr/local/node22/bin/node --input-type=module <<'ATR_CONFIG_JS'
import { execFileSync } from 'node:child_process'
import { readFileSync, copyFileSync, chmodSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, existsSync, unlinkSync } from 'node:fs'
const values = JSON.parse(Buffer.from('${payload}', 'base64').toString('utf8'))
const path = '/root/.atr/portal.env', old = readFileSync(path, 'utf8')
if ('${mode}' === 'check') {
  const matches = Object.entries(values).every(([key,value]) => process.env[key] === value)
  console.log('ASSISTANT_CONFIG_READY: local validated; remote_matches_local=' + matches)
  if (!matches) process.exit(2)
}
else {
  const backup = path + '.assistant-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(path, backup); chmodSync(backup, 0o600)
  const retained = old.split(/\\r?\\n/).filter(line => { const match = line.match(/^\\s*(?:export\\s+)?([A-Za-z_]\\w*)\\s*=/); return !match || !(match[1] in values) })
  const single = String.fromCharCode(39), double = String.fromCharCode(34)
  const quote = value => single + value.replaceAll(single, single + double + single + double + single) + single
  const text = retained.join('\\n') + '\\n# AI 助手：与本地已验证配置同步，凭证仅保存在服务端。\\n' + Object.entries(values).map(([k,v]) => k + '=' + quote(v)).join('\\n') + '\\n'
  const temporary = path + '.assistant-tmp-' + process.pid
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    execFileSync('/bin/bash', ['-n', temporary], { stdio: 'ignore' })
    renameSync(temporary, path)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  console.log('ASSISTANT_CONFIG_APPLIED: backup=' + backup)
}
ATR_CONFIG_JS
bash -n /root/.atr/portal.env
`
const scratch = mkdtempSync(join(tmpdir(), 'atr-assistant-config-'))
try {
  const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${host}`, 'true'], { encoding: 'utf8', windowsHide: true })
  let result
  if (probe.status === 0) result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', `${user}@${host}`, 'bash -s'], { input: script, encoding: 'utf8', windowsHide: true })
  else {
    const found = spawnSync('where', ['plink'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0]
    if (!found) throw new Error('没有可用 SSH 通道；未更新配置')
    const pwFile = join(scratch, 'password.txt')
    writeFileSync(pwFile, password, { mode: 0o600 })
    result = spawnSync(found, ['-ssh', '-batch', '-hostkey', hostkey(), '-pwfile', pwFile, `${user}@${host}`, 'bash -s'], { input: script, encoding: 'utf8', windowsHide: true })
  }
  // ★ 只提取固定确认行，SSH/解释器原始错误可能带入待写配置。
  const safe = result.stdout?.split(/\r?\n/).filter(line => /^ASSISTANT_CONFIG_(?:READY|APPLIED):/.test(line)).join('\n')
  if (safe) console.log(safe)
  if (result.status !== 0) {
    const category = result.stderr?.match(/SyntaxError|IndentationError|NameError|command not found|Network error|unknown option|invalid option|Access denied/)?.[0] ?? result.error?.code ?? 'remote-error'
    throw new Error('助手配置操作失败（' + category + '）；未输出远端原始信息，请核对服务端环境文件')
  }
} finally {
  if (!resolve(scratch).startsWith(join(resolve(tmpdir()), 'atr-assistant-config-'))) throw new Error('临时目录超出边界')
  rmSync(scratch, { recursive: true, force: true })
}
