/**
 * 线上模型单价的**纯逻辑**：人写的价目表 → 平台契约，以及「这条价落到线上会发生什么」。
 *
 * ★ 为什么单独一个文件：`scripts/online-pricing.mjs` 要 SSH 到生产机才能干活，
 *   而这里面两件事**最容易错、也最该被钉住**：
 *   ① 单位换算（货币单位/百万 token ↔ 整数微元/千 token，差 1000 倍，
 *      错一位就是 10 倍费用，而页面上只显示一个看起来很正常的数字）；
 *   ② 写库前的冲突判定（重叠的区间数据库**拦不住**：那条 UNIQUE 索引只认
 *      `(provider, model, effective_from_ms)` 完全相同的一类）。
 *   与 `scripts/deploy-plan.mjs` 是同一个套路：纯逻辑进 `*-plan.mjs`，被单测直接 import。
 *
 * ## 🚨 单位换算必须与页面同款
 *
 * 界面按「货币单位 / 百万 token」录入（官方价目表的原生单位就是这个），
 * 库里存「整数微元 / 千 token」，两者相差 1000 且是整数倍。
 * 换算规则照抄 `web-portal/src/utils/unitPrice.ts` 的 `rateTextToMicro()`：
 * 第 7 位小数起无法表示（库里是整数），到此为止仍用**四舍五入**——
 * 两处若各写一套（这里拒绝、那里四舍五入），同一份价目会在页面与脚本之间
 * 得到两个数字，而它不会报错。差别是：这里会**显式告警**「这个数不能被
 * 整数微元精确表示」，页面只是悄悄进位。
 *
 * ## 货币绝不换算
 *
 * 官方价目是美元就用 `USD` 记美元原值。库里的多币种**各算各的、绝不相加**
 * （见 `docs/费用统计方案.md`），所以不需要、也不允许把美元按某个汇率改写成人民币。
 */

/** 界面单位（百万 token）→ 库单位（千 token）之间的倍数，见 `unitPrice.ts` 的同名常量。 */
export const KTOK_PER_MTOK = 1000

/** 与 `shared/price.ts` 的 `MAX_MICRO_PER_KTOK` 同值：10000 货币单位/百万 token。 */
export const MAX_MICRO_PER_KTOK = 10_000_000

/** 与页面输入框同款：最多 6 位小数，不接受负数与科学计数法。 */
const RATE_PATTERN = /^\d+(?:\.\d{1,6})?$/

/** 四类单价的字段名（camelCase 人读名 ↔ snake_case 线上字段）。 */
export const RATE_FIELDS = [
  { key: 'input', wire: 'input_micro_per_ktok', label: '输入' },
  { key: 'output', wire: 'output_micro_per_ktok', label: '输出' },
  { key: 'cacheRead', wire: 'cache_read_micro_per_ktok', label: '缓存读' },
  { key: 'cacheWrite', wire: 'cache_write_micro_per_ktok', label: '缓存写' },
]

/**
 * 十进制单价（货币单位 / 百万 token）→ 整数微元 / 千 token。
 *
 * 返回 `{ micro, rounded }`：`rounded` 为真表示这个数**不能被整数微元精确表示**
 * （小数位超过 3 位，如 `$0.0625 / 百万` = 62.5 微元），已按页面同款四舍五入。
 * 调用方必须把这件事说出来 —— 悄悄进位会让「我填了 0.0625」与「库里是 0.063」
 * 同时成立，而账目差异只有对账时才会浮现。
 */
export function rateToMicro(value) {
  let text = typeof value === 'number' ? String(value) : String(value ?? '').trim()
  if (!RATE_PATTERN.test(text)) {
    throw new Error(`单价必须是「货币单位 / 百万 token」的十进制数（非负、最多 6 位小数）：${JSON.stringify(value)}`)
  }
  // ⚠️ 先剥尾随 0 再数小数位：`0.2000` 是精确的 200 微元，不该被报成「四舍五入过」。
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  const decimals = text.includes('.') ? text.split('.')[1].length : 0
  const micro = Math.round(Number(text) * KTOK_PER_MTOK)
  if (!Number.isSafeInteger(micro) || micro > MAX_MICRO_PER_KTOK) {
    throw new Error(`单价超出上限（${MAX_MICRO_PER_KTOK} 微元/千 token = 10000 货币单位/百万 token）：${text}`)
  }
  return { micro, rounded: decimals > 3 }
}

/** 库里那个整数 → 给人看、也给官方价目表对照的十进制文本（元 / 百万 token）。 */
export function microToRateText(micro) {
  return String(micro / KTOK_PER_MTOK)
}

/**
 * 读一份价目表（JSON 文本或对象）→ 已归一的行数组。
 *
 * 形如：
 * ```json
 * { "asOf": "2026-10-04", "source": "https://…/pricing.md", "currency": "USD",
 *   "rows": [{ "provider": "*", "model": "gpt-5.6-sol", "input": 4, "output": 20,
 *              "cacheRead": 0.4, "cacheWrite": 5, "note": "官方标准价（≤272K）" }] }
 * ```
 * 顶层 `currency` 是缺省币种，行内可覆盖（同一个模型在不同供应商下币种不同是常态）。
 * 🚨 `provider: "*"` 是**保留值**：不限供应商的基础价，不是「某个叫 * 的供应商」。
 */
export function readCatalog(raw) {
  const catalog = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('价目表必须是一个 JSON 对象（含 rows 数组）')
  const rows = []
  const warnings = []
  const list = catalog.rows
  if (!Array.isArray(list) || list.length === 0) throw new Error('价目表里没有 rows（一行价都没有的写入计划是空操作，通常意味着文件写错了）')
  list.forEach((row, index) => {
    const at = `第 ${index + 1} 行`
    if (!row || typeof row !== 'object') throw new Error(`${at}：不是对象`)
    const provider = String(row.provider ?? '').trim()
    const model = String(row.model ?? '').trim()
    if (!provider) throw new Error(`${at}：缺 provider（不限供应商的基础价要显式写 "*"）`)
    if (!model) throw new Error(`${at}：缺 model`)
    const currency = String(row.currency ?? catalog.currency ?? '').trim().toUpperCase()
    // 🚨 币种**必须显式给**，不给就报错：多币种各算各的、绝不相加，所以它不是可以猜的字段
    //   —— 猜成人民币会把一条美元价目变成「看起来正常的数字」，而看板从此多出一份假金额。
    if (!currency) throw new Error(`${at}：缺币种 —— 顶层或行内必须显式写 "currency"（如 USD / CNY）`)
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${at}：币种需要是三位大写字母的 ISO 4217 代码（如 USD / CNY）`)
    const rates = {}
    for (const field of RATE_FIELDS) {
      // 缺省按 0：官网上写「-」的那一档（如 gpt-5.5 的 cache write）就是**不收费**，
      // 记 0 与「未填」在这里是同一件事 —— 记成 absent 会让写入被 schema 拒掉。
      const converted = rateToMicro(row[field.key] ?? 0)
      rates[field.key] = converted.micro
      if (converted.rounded) {
        warnings.push(`${at}（${provider} / ${model}）${field.label} ${row[field.key]} 不能被整数微元精确表示，已按页面同款四舍五入为 ${converted.micro} 微元/千 token（${microToRateText(converted.micro)} / 百万）`)
      }
    }
    rows.push({ provider, model, currency, rates, note: row.note == null ? null : String(row.note).slice(0, 255) })
  })
  return { asOf: catalog.asOf ?? null, source: catalog.source ?? null, note: catalog.note ?? null, rows, warnings }
}

/**
 * 价目行 → `POST /api/v1/admin/pricing` 的请求体（snake_case，与线上契约逐字对应）。
 *
 * `effectiveFromMs` 缺省 **0 = 自始有效**：这些模型过去从来没配过价，
 * 若从「现在」起算，历史用量会永远停在「未计价」——而那正是这次要修的东西。
 * 换价时（改价目、保历史）才需要显式给一个起点。
 */
export function catalogRowToApiBody(row, effectiveFromMs = 0) {
  return {
    provider: row.provider,
    model: row.model,
    currency: row.currency,
    input_micro_per_ktok: row.rates.input,
    output_micro_per_ktok: row.rates.output,
    cache_read_micro_per_ktok: row.rates.cacheRead,
    cache_write_micro_per_ktok: row.rates.cacheWrite,
    effective_from_ms: effectiveFromMs,
    effective_to_ms: null,
    note: row.note,
  }
}

/** 两个生效区间是否相交（两端都含，与 `shared/price.ts` 的 `priceRangesOverlap` 同口径）。 */
export function spansOverlap(a, b) {
  const aTo = a.effective_to_ms ?? Number.POSITIVE_INFINITY
  const bTo = b.effective_to_ms ?? Number.POSITIVE_INFINITY
  return a.effective_from_ms <= bTo && b.effective_from_ms <= aTo
}

function sameRates(existing, candidate) {
  if (existing.currency !== candidate.currency) return false
  return RATE_FIELDS.every((field) => Number(existing[field.wire]) === Number(candidate[field.wire]))
}

/**
 * 逐行算出「这条价落到线上会怎样」。
 *
 * 三种结局，与服务端的判定**同序**（`repository.setModelPrice`）：
 * - `conflict`：同一个 `(provider, model)` 上已有**别的起点**且区间相交 → 服务端回 409，先解决它；
 * - `update`  ：同一个 `(provider, model, effective_from_ms)` 已存在 → upsert（这是「改这一条价」）；
 * - `create`  ：新建；
 * - `same`    ：已存在且四类单价与币种逐字相同 → 写入是幂等的空操作（脚本据此跳过，避免无意义的审计行）。
 *
 * ⚠️ **基础价（`*`）与同名的专属价不算同一个槽**：专享价优先、基础价兜底是两层匹配
 *   （取数 SQL join 两次），所以「新增一条 `* / gpt-5.6-sol`」不会和已有的
 *   `deeprouter / gpt-5.6-sol` 冲突 —— 这是刻意的，别把这里改成「同模型即冲突」。
 */
export function planAgainstExisting(existing, candidates) {
  return candidates.map((candidate) => {
    const sameSlot = existing.filter((row) => String(row.provider) === candidate.provider && String(row.model) === candidate.model)
    const sameStart = sameSlot.find((row) => Number(row.effective_from_ms) === candidate.effective_from_ms)
    const overlap = sameSlot.filter((row) => Number(row.effective_from_ms) !== candidate.effective_from_ms && spansOverlap(row, candidate))
    if (overlap.length > 0) return { candidate, action: 'conflict', existing: overlap }
    if (sameStart) return { candidate, action: sameRates(sameStart, candidate) ? 'same' : 'update', existing: sameStart }
    return { candidate, action: 'create', existing: null }
  })
}

/** 计划 → 给人看的对齐文本（不做任何算术，只排版）。 */
export function formatPlan(items) {
  const actionText = { create: '新建', update: '覆盖', same: '无变化', conflict: '★冲突' }
  const lines = []
  for (const item of items) {
    const row = item.candidate
    const rates = RATE_FIELDS.map((field) => `${field.label} ${microToRateText(row[field.wire])}`).join('  ')
    lines.push(`${actionText[item.action] ?? item.action}  ${row.provider} / ${row.model}  ${row.currency}  ${rates}`)
    if (item.action === 'update' && item.existing) {
      const before = RATE_FIELDS.map((field) => microToRateText(Number(item.existing[field.wire]))).join(' / ')
      lines.push(`        原价：${item.existing.currency} ${before}`)
    }
    if (item.action === 'conflict') {
      for (const row2 of item.existing) {
        lines.push(`        与既有区间相交：${row2.provider} / ${row2.model} [${row2.effective_from_ms}, ${row2.effective_to_ms ?? '至今'}]`)
      }
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 远端脚本渲染
// ---------------------------------------------------------------------------

/** MySQL 客户端与凭证在目标机上的固定位置（与 `verify/perf/online-probe.ts` 同一份约定）。 */
export const MYSQL = {
  client: '/usr/local/mysql8/bin/mysql',
  credentials: '/root/.atr/mysql8-credentials.txt',
  user: 'atr_user',
  host: '127.0.0.1',
  port: 3308,
  schema: 'ai_token_report',
}

/**
 * 渲染「在目标机上跑一段只读 SQL」的 bash。
 *
 * 🚨 口令只从**服务器上的**凭证文件读，并且只经 `--defaults-extra-file` 递给 mysql
 *   —— 命令行里出现过的口令在 `ps` 里对全机可见（照抄 `online-probe.ts` 的规矩）。
 */
export function renderSqlProbe(sql) {
  const statements = String(sql).split(';').map((part) => part.trim()).filter(Boolean)
  for (const statement of statements) {
    if (!/^(SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|WITH)\b/i.test(statement)) {
      throw new Error(`拒绝把非只读语句送到线上库：${statement.slice(0, 60)}`)
    }
  }
  return [
    'set -eu',
    `CRED='${MYSQL.credentials}'`,
    '[ -r "$CRED" ] || { echo "ONLINE_PRICING_ERROR: 读不到 $CRED" >&2; exit 3; }',
    `APW=$(grep -A5 '^\\[${MYSQL.user}\\]' "$CRED" | grep '^password=' | cut -d= -f2-)`,
    '[ -n "$APW" ] || { echo "ONLINE_PRICING_ERROR: 凭证文件里没有口令" >&2; exit 3; }',
    'CNF=$(mktemp)',
    `trap 'rm -f "$CNF"' EXIT`,
    'chmod 600 "$CNF"',
    `printf '[client]\\nuser=${MYSQL.user}\\npassword=%s\\nhost=${MYSQL.host}\\nport=${MYSQL.port}\\n' "$APW" > "$CNF"`,
    `${MYSQL.client} --defaults-extra-file="$CNF" -N --batch ${MYSQL.schema} <<'ATR_SQL_EOF'`,
    String(sql),
    'ATR_SQL_EOF',
    '',
  ].join('\n')
}

/**
 * 远端执行体的源码（上传到目标机后用 `node` 跑）。
 *
 * ## 为什么整段逻辑放在远端，而不是本地 curl
 *
 * 1. **管理员口令与会话密钥一个字节都不离开那台机器**：本机只送一份 base64 配置
 *    （用户名 / 口令 / 待写行），远端只回最终结果，会话 cookie 只存在于远端内存。
 * 2. 目标机上写的是 `127.0.0.1:$ATR_PORT`，而线上的 Cookie `Path` 是
 *    `/ai-token/api/v1`（子路径部署）—— 本机若直连根路径，浏览器那套 Path 匹配
 *    会**静默不发送**这两个 Cookie。所以这里显式读 `set-cookie` 再显式回填，
 *    不依赖任何 Cookie 罐的路径语义。
 *
 * ## 写入端点由配置给（缺省 = 模型单价）
 *
 * `CONFIG.endpoint` 缺省是 `/api/v1/admin/pricing`；`online-project-rules.mjs`
 * 传 `/api/v1/admin/project-aliases` 复用同一份机制。**只把「端点」参数化** ——
 * 认证、解验证码、会话显式回填这些最容易错的环节仍然只有一份实现。
 *
 * ## 验证码为什么能算出来
 *
 * 后台登录的验证码是 4 位数字，库里存的是 `HMAC(ATR_CAPTCHA_HMAC_KEY, id + ':' + answer)`。
 * 运维本来就同时握着那把密钥与那台机器的 root（否则也读不到 `/root/.atr/portal.env`），
 * 所以这是**把人工看图的动作自动化**，不是绕过认证 —— 口令照样要过 KDF 校验。
 * 也正是因此，脚本里绝不打印密钥、口令或会话值。
 */
export const REMOTE_APPLY_SOURCE = String.raw`
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const CONFIG = JSON.parse(Buffer.from('__ATR_CONFIG_B64__', 'base64').toString('utf8'))

function die(reason, code) { console.log('ATR_ERROR ' + JSON.stringify({ reason: reason })); process.exit(code || 3) }

function readEnvFile(path) {
  const out = {}
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return out }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

const portalEnv = readEnvFile('/root/.atr/portal.env')
const baseUrl = String(CONFIG.baseUrl || ('http://127.0.0.1:' + (portalEnv.ATR_PORT || '8787'))).replace(/\/+$/, '')
const username = CONFIG.username || portalEnv.ATR_ADMIN_USERNAME || ''
const password = CONFIG.password || portalEnv.ATR_ADMIN_PASSWORD || ''
const hmacKey = portalEnv.ATR_CAPTCHA_HMAC_KEY || ''
if (!username || !password) die('目标机上拿不到管理员用户名 / 口令：请确认 /root/.atr/portal.env 里有 ATR_ADMIN_USERNAME / ATR_ADMIN_PASSWORD')
if (!hmacKey) die('目标机上没有 ATR_CAPTCHA_HMAC_KEY，后台登录不可用')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function setCookiesOf(response) {
  const jar = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || '']
  const out = {}
  for (const entry of jar) {
    const pair = String(entry).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

function mysqlQuery(sql) {
  const creds = readFileSync(CONFIG.mysql.credentials, 'utf8')
  const section = creds.split(/^\[/m).find((part) => part.startsWith(CONFIG.mysql.user + ']')) || ''
  const passwordLine = section.split(/\r?\n/).find((line) => line.startsWith('password='))
  if (!passwordLine) die('凭证文件里没有 ' + CONFIG.mysql.user + ' 的口令')
  const cnf = '/tmp/atr-online-pricing-' + process.pid + '.cnf'
  writeFileSync(cnf, '[client]\nuser=' + CONFIG.mysql.user + '\npassword=' + passwordLine.slice('password='.length) + '\nhost=' + CONFIG.mysql.host + '\nport=' + CONFIG.mysql.port + '\n', { mode: 0o600 })
  try {
    return execFileSync(CONFIG.mysql.client, ['--defaults-extra-file=' + cnf, '-N', '--batch', CONFIG.mysql.schema, '-e', sql], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } finally { try { unlinkSync(cnf) } catch {} }
}

function solveCaptcha(captchaId, answerHmac) {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = String(i).padStart(4, '0')
    if (createHmac('sha256', hmacKey).update(captchaId + ':' + candidate).digest('hex') === answerHmac) return candidate
  }
  return null
}

const jsonHeaders = { 'content-type': 'application/json', 'x-portal-request': '1' }

const captchaResponse = await fetch(baseUrl + '/api/v1/auth/captcha', { headers: { 'x-portal-request': '1' } })
if (!captchaResponse.ok) die('取验证码失败：HTTP ' + captchaResponse.status + ' ' + (await captchaResponse.text()).slice(0, 200))
const captcha = await captchaResponse.json()
const captchaBinding = setCookiesOf(captchaResponse).atr_portal_captcha
if (!captchaBinding) die('验证码响应里没有 atr_portal_captcha Cookie（登录会因绑定缺失而失败）')

const rows = mysqlQuery("SELECT answer_hmac FROM auth_challenges WHERE challenge_hash = '" + sha256(captcha.captcha_id) + "'").trim().split(/\r?\n/).filter(Boolean)
if (rows.length !== 1) die('库里查不到这次验证码（challenge 行数 = ' + rows.length + '）')
const answer = solveCaptcha(captcha.captcha_id, rows[0].trim())
if (!answer) die('验证码答案在 4 位数字里没有匹配：密钥与库不是同一套（多实例各自生成了密钥？）')

const loginResponse = await fetch(baseUrl + '/api/v1/auth/login', {
  method: 'POST',
  headers: { ...jsonHeaders, cookie: 'atr_portal_captcha=' + captchaBinding },
  body: JSON.stringify({ username: username, password: password, captcha: answer, captcha_id: captcha.captcha_id }),
})
const loginBody = await loginResponse.text()
if (!loginResponse.ok) die('管理员登录失败：HTTP ' + loginResponse.status + ' ' + loginBody.slice(0, 200) + '（口令来自 /root/.atr/portal.env，改过密码就用 --password 覆盖）', 4)
const session = setCookiesOf(loginResponse).atr_portal_session
if (!session) die('登录成功但响应里没有 atr_portal_session Cookie')

// ★ 模式「stats」：同一个会话去读一次看板概览。存在的意义是**证伪**——
//   「价写进去了」与「看板真的按它算出了金额」是两件事（币种、生效区间、
//   专属价/基础价两层匹配，任何一环错都表现为金额为 0 或未计价）。
//
// 🚨 这段源码整体是一个 JS 模板串，所以**里面一个反引号都不能有**
//   —— 注释里写一对反引号就会把模板串提前截断，报错还指向模板串的开头
//   （scripts/deploy-server.mjs 真踩过同一个坑，这里再踩了一次）。单测钉住了这一条。
if (CONFIG.mode === 'stats') {
  const statsResponse = await fetch(baseUrl + CONFIG.statsPath, { headers: { cookie: 'atr_portal_session=' + session } })
  const statsText = await statsResponse.text()
  if (!statsResponse.ok) die('读看板概览失败：HTTP ' + statsResponse.status + ' ' + statsText.slice(0, 300), 5)
  let stats = null
  try { stats = JSON.parse(statsText) } catch { die('看板概览不是 JSON：' + statsText.slice(0, 200), 5) }
  console.log('ATR_RESULT ' + JSON.stringify({ mode: 'stats', baseUrl: baseUrl, username: username, stats: stats }))
  process.exit(0)
}

// ★ 写入端点由配置给（缺省是模型单价）：同一套「登录 + 解验证码 + 会话显式回填」
//   机制被 online-project-rules.mjs 复用，去 POST /api/v1/admin/project-aliases。
//   每一行的成败**各自独立**（逐行 POST），所以一行被服务端拒掉不会连累其余行；
//   调用方据此把失败行列出来重试即可（写入本身是幂等的 upsert）。
// 🚨 上面这几行**不能出现反引号**：整段源码是包在一个模板串里的，写一对反引号
//   会把模板串提前截断（单测 online-pricing-plan.test.ts 钉住了这一条）。
const endpoint = CONFIG.endpoint || '/api/v1/admin/pricing'
const results = []
for (const row of CONFIG.rows) {
  // ★ method 由配置给（缺省 POST）：项目规则的「删掉旧规则」走 DELETE + {alias_id}。
  //   写成同一个循环而不是两份，是为了让「逐行独立成败」这个性质只有一处实现。
  const response = await fetch(baseUrl + endpoint, {
    method: row.method || 'POST',
    headers: { ...jsonHeaders, cookie: 'atr_portal_session=' + session },
    body: JSON.stringify(row.body),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  results.push({
    // label 是给使用者看的那一行（项目规则没有 provider/model 这种天然键）。
    label: row.label || (String(row.body.provider || '') + ' / ' + String(row.body.model || '')),
    provider: row.body.provider === undefined ? null : row.body.provider,
    model: row.body.model === undefined ? null : row.body.model,
    status: response.status,
    reason: parsed && parsed.reason ? String(parsed.reason) : (response.ok ? '' : text.slice(0, 200)),
  })
}
console.log('ATR_RESULT ' + JSON.stringify({ baseUrl: baseUrl, username: username, results: results }))
`

/**
 * 渲染远端执行体：把配置（含口令）**base64** 内联进去。
 *
 * 🚨 口令绝不拼进命令行 / 文件名 / 日志：本机 → 目标机的通道是 SSH 的 stdin
 *   （见 `ssh-exec.mjs` 的 `runRemote`），脚本本身落 `/tmp` 后立即执行并删除。
 * 🚨 渲染完必须断言**没有残留 `${`**：这份源码是包在 JS 模板串里的，
 *   里面若写了模板字面量会被本机抢先求值（`deploy-server.mjs` 真踩过这个坑）。
 */
export function renderRemoteApplyScript(config) {
  const b64 = Buffer.from(JSON.stringify(config), 'utf8').toString('base64')
  const rendered = REMOTE_APPLY_SOURCE.replace('__ATR_CONFIG_B64__', b64)
  if (rendered.includes('${')) throw new Error('远端脚本里残留了 ${ —— 模板串会被本机求值，请改用字符串拼接')
  return rendered
}

/** 远端执行体落盘的位置（`/tmp`，跑完即删）。 */
export function remoteApplyPath(stamp) {
  return `/tmp/atr-online-pricing-${stamp}.mjs`
}

/** 把渲染好的脚本包成一段「写文件 → 跑 → 删文件」的远端 bash。 */
export function wrapRemoteScript(script, remotePath) {
  return [
    'set -eu',
    `cat > '${remotePath}' <<'ATR_APPLY_EOF'`,
    script,
    'ATR_APPLY_EOF',
    // ⚠️ 用 bun 或 node 都能跑；线上两者都在（见 `deploy/atr-server-start.sh` 与 node22）。
    `ATR_NODE=$(command -v node || echo /usr/local/node22/bin/node)`,
    `"$ATR_NODE" '${remotePath}'; STATUS=$?`,
    `rm -f '${remotePath}'`,
    'exit $STATUS',
    '',
  ].join('\n')
}
