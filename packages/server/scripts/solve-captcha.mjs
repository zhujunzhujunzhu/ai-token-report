/**
 * 验证码反解 —— 仅用于**部署自测**，不是生产工具。
 *
 * ## 为什么能反解，以及为什么这不构成安全问题
 *
 * 服务端把验证码答案以 `HMAC-SHA256(secret, challenge_id + ':' + answer)` 存库
 * （见 `packages/server/src/identity/portal-auth.ts` 的 `hmac()`），
 * 而 `answer` 只有 4 位数字（10000 种可能）。
 *
 * 因此**谁能同时拿到 secret 和 challenge_id，谁就能穷举出答案**。
 * 生产环境里 secret 只存在于服务端进程内存与环境变量，
 * 攻击者拿不到它 —— 这条路径不成立，验证码本身是安全的。
 *
 * 本脚本要有 root 才能读 `/root/.atr/portal.env`，**只能在服务器本机跑**，
 * 用途是：自动化部署验收时绕开「图片验证码无法自动识别」这一环，
 * 让 Playwright 之类的端到端测试能走完登录。
 *
 * ## 用法
 *
 * ```bash
 * # 在服务器上（需已部署本项目）
 * curl -s http://127.0.0.1:8790/api/v1/auth/captcha     # 拿 captcha_id
 * /usr/local/node22/bin/node solve-captcha.mjs <captcha_id>
 * ```
 *
 * 输出 4 位答案；拿不到 challenge、或穷举无果时输出 `NO_ROW` / `NOT_FOUND`。
 *
 * ⚠️ 验证码**一次性**：同一 challenge 只能用于一次登录，
 *   且申请新验证码会作废同浏览器的旧 challenge。
 *   所以自动化测试必须「申请 → 反解 → 立即提交」，中间不能插别的验证码申请。
 */
import { createHmac, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const cid = process.argv[2]
if (!cid) {
  console.error('用法: node solve-captcha.mjs <captcha_id>')
  process.exit(2)
}

const envPath = process.env.ATR_ENV_FILE ?? '/root/.atr/portal.env'
const credPath = process.env.ATR_CRED_FILE ?? '/root/.atr/mysql8-credentials.txt'

const key = readFileSync(envPath, 'utf8').match(/^ATR_CAPTCHA_HMAC_KEY=(.*)$/m)?.[1]?.trim()
if (!key) { console.error('未找到 ATR_CAPTCHA_HMAC_KEY'); process.exit(2) }

const apw = readFileSync(credPath, 'utf8').match(/^password=(.*)$/m)?.[1]?.trim()
if (!apw) { console.error('未找到数据库密码'); process.exit(2) }

// challenge_hash = sha256(challenge_id)，库里存的是摘要不是明文 id
const hash = createHash('sha256').update(cid).digest('hex')
const sql = `SELECT answer_hmac FROM auth_challenges WHERE challenge_hash='${hash}';`
const out = execFileSync('/usr/local/mysql8/bin/mysql', [
  '-h127.0.0.1', '-P3308', '-uatr_user', '-p' + apw,
  '-N', '-B', 'ai_token_report', '-e', sql,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

if (!out) { console.log('NO_ROW'); process.exit(0) }
const target = out.split('\n')[0].trim()

for (let i = 0; i < 10000; i++) {
  const answer = String(i).padStart(4, '0')
  if (createHmac('sha256', key).update(`${cid}:${answer}`).digest('hex') === target) {
    console.log(answer)
    process.exit(0)
  }
}
console.log('NOT_FOUND')