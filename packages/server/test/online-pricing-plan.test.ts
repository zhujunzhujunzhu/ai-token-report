/**
 * 线上模型单价工具的单测（`scripts/online-pricing-plan.mjs`）。
 *
 * 这里钉的是**四条会真花钱、且不会报错的规则**：
 *
 * 1. **单位换算**：界面/官方价目是「货币单位 / 百万 token」，库里是「整数微元 / 千 token」，
 *    差 1000 倍。错一位就是 10 倍费用，而页面上只显示一个看起来很正常的数字。
 *    换算必须与 `web-portal/src/utils/unitPrice.ts` 同款（含第 4 位小数起的四舍五入）。
 * 2. **基础价（`*`）与同名的专属价可以共存**：这是「专享价优先、基础价兜底」两层匹配的
 *    直接后果，写进计划里若被误判成冲突，整个「给所有供应商兜一个官方价」的做法就废了。
 * 3. **区间重叠要在这里就拦下**：库里的 UNIQUE 只认「起点完全相同」，
 *    `[0, ∞)` 与 `[1000, 2000]` 它拦不住 —— 那种库会让同一段用量按哪条价算取决于读取顺序。
 * 4. **口令不以明文进远端脚本**：脚本会被写进目标机的 `/tmp`，明文即等于落盘一份口令。
 */
import { expect, test } from 'bun:test'

import {
  KTOK_PER_MTOK, MAX_MICRO_PER_KTOK, REMOTE_APPLY_SOURCE, catalogRowToApiBody, formatPlan,
  microToRateText, planAgainstExisting, rateToMicro, readCatalog, renderRemoteApplyScript,
  renderSqlProbe, wrapRemoteScript,
} from '../../../scripts/online-pricing-plan.mjs'

test('单位换算：官方价目（/百万）→ 整数微元（/千），与页面同款 × 1000', () => {
  expect(KTOK_PER_MTOK).toBe(1000)
  // ¥2 / 百万 = ¥0.002 / 千 = 2000 微元 —— 与库里 deepseek-flash 那行的值逐字一致。
  expect(rateToMicro(2).micro).toBe(2000)
  expect(rateToMicro(8).micro).toBe(8000)
  expect(rateToMicro(0.04).micro).toBe(40)
  expect(rateToMicro(0).micro).toBe(0)
  // 字符串与数字两种写法必须同值（JSON 里写 "0.075" 也是合法的）。
  expect(rateToMicro('0.075').micro).toBe(75)
  expect(rateToMicro(0.075).micro).toBe(75)
  // 官方表里的三档典型价：缓存读 $0.40、缓存写 $12.50、$0.02。
  expect(rateToMicro(0.4).micro).toBe(400)
  expect(rateToMicro(12.5).micro).toBe(12500)
  expect(rateToMicro(0.02).micro).toBe(20)
})

test('单位换算：尾随 0 不算「四舍五入」，第 4 位起才算（页面就是这么进位的）', () => {
  expect(rateToMicro('0.2000').rounded).toBe(false)
  expect(rateToMicro('0.2000').micro).toBe(200)
  // $0.0625 / 百万 = 62.5 微元 —— 库里只能存整数，页面 `rateTextToMicro()` 也是 round →
  // 这里必须落在同一个数上（63），否则同一份价目在页面与脚本里会得到两个数字。
  const rounded = rateToMicro('0.0625')
  expect(rounded.rounded).toBe(true)
  expect(rounded.micro).toBe(63)
})

test('单位换算：非法输入一律报错，绝不静默夹成 0（夹成 0 = 免费，最危险的静默错误）', () => {
  expect(() => rateToMicro(-1)).toThrow()
  expect(() => rateToMicro('1e3')).toThrow()
  expect(() => rateToMicro('1.1234567')).toThrow() // 7 位小数
  expect(() => rateToMicro('abc')).toThrow()
  expect(() => rateToMicro('')).toThrow()
  // 上限与 `shared/price.ts` 的 MAX_MICRO_PER_KTOK 同值：10000 货币单位 / 百万。
  expect(() => rateToMicro(MAX_MICRO_PER_KTOK / KTOK_PER_MTOK + 1)).toThrow()
  expect(rateToMicro(MAX_MICRO_PER_KTOK / KTOK_PER_MTOK).micro).toBe(MAX_MICRO_PER_KTOK)
})

test('价目表：缺省币种可被行覆盖，`*` 是保留的基础价，缺的四类价按 0（官方写「-」= 不收费）', () => {
  const catalog = readCatalog({
    currency: 'USD',
    rows: [
      { provider: '*', model: 'gpt-5.6-sol', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      { provider: 'deeprouter', model: 'gpt-5.6-sol', currency: 'CNY', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      { provider: '*', model: 'gpt-5.5', input: 5, output: 30, cacheRead: 0.5 },
    ],
  })
  expect(catalog.rows.length).toBe(3)
  expect(catalog.rows[0]!.provider).toBe('*')
  expect(catalog.rows[0]!.currency).toBe('USD')
  expect(catalog.rows[1]!.currency).toBe('CNY')
  // 第三个字段（缓存写）刻意没写：官网写「-」的那一档就是不单独计费。
  expect(catalog.rows[2]!.rates.cacheWrite).toBe(0)
  expect(catalog.warnings).toEqual([])
  // 不能被整数微元精确表示的价要留下告警（含模型名，使用者才知道去改哪一行）。
  const warned = readCatalog({ currency: 'USD', rows: [{ provider: '*', model: 'x', input: 0.0625, output: 1, cacheRead: 0, cacheWrite: 0 }] })
  expect(warned.warnings.length).toBe(1)
  expect(warned.warnings[0]).toContain('0.0625')
})

test('价目表：空 rows / 缺 model / 缺 provider / 币种不合法都必须抛（不许算出一个空计划当成功）', () => {
  expect(() => readCatalog({ rows: [] })).toThrow()
  // 币种必须显式给：多币种绝不相加，猜一个币种等于凭空造出一份假金额。
  expect(() => readCatalog({ rows: [{ provider: '*', model: 'm' }] })).toThrow()
  expect(() => readCatalog({ currency: 'usd', rows: [{ provider: '*', model: 'm' }] })).not.toThrow()
  expect(() => readCatalog({ rows: [{ provider: '', model: 'm' }] })).toThrow()
  expect(() => readCatalog({ rows: [{ provider: '*', model: '  ' }] })).toThrow()
  expect(() => readCatalog({ rows: [{ provider: '*', model: 'm', currency: '人民币' }] })).toThrow()
  expect(() => readCatalog('不是 JSON')).toThrow()
})

test('请求体：snake_case 与线上契约逐字对应，缺省 effective_from_ms = 0（自始有效）', () => {
  const catalog = readCatalog({ currency: 'USD', rows: [{ provider: '*', model: 'gpt-5.4', input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, note: '官方标准价' }] })
  const body = catalogRowToApiBody(catalog.rows[0]!)
  expect(Object.keys(body).sort()).toEqual([
    'cache_read_micro_per_ktok', 'cache_write_micro_per_ktok', 'currency', 'effective_from_ms',
    'effective_to_ms', 'input_micro_per_ktok', 'model', 'note', 'output_micro_per_ktok', 'provider',
  ])
  expect(body.input_micro_per_ktok).toBe(2500)
  expect(body.output_micro_per_ktok).toBe(15000)
  expect(body.cache_read_micro_per_ktok).toBe(250)
  // 🚨 起点必须是 0：给从没配过价的模型补价时若从「现在」起算，
  //   历史用量会永远停在「未计价」—— 而那正是补价要修的东西。
  expect(body.effective_from_ms).toBe(0)
  expect(body.effective_to_ms).toBe(null)
  expect(microToRateText(body.input_micro_per_ktok)).toBe('2.5')
})

/** 线上现有价目的夹具：一条基础价 + 一条同模型的专属价（真实的 deeprouter 情形）。 */
const existing = [
  { provider: '*', model: 'deepseek-flash', currency: 'CNY', input_micro_per_ktok: 2000, output_micro_per_ktok: 8000, cache_read_micro_per_ktok: 40, cache_write_micro_per_ktok: 0, effective_from_ms: 0, effective_to_ms: null },
  { provider: 'deeprouter', model: 'gpt-5.6-sol', currency: 'CNY', input_micro_per_ktok: 4000, output_micro_per_ktok: 20000, cache_read_micro_per_ktok: 400, cache_write_micro_per_ktok: 5000, effective_from_ms: 0, effective_to_ms: null },
]

test('计划：新建 / 覆盖 / 无变化 三态', () => {
  const create = catalogRowToApiBody({ provider: '*', model: 'gpt-5.5', currency: 'USD', rates: { input: 5000, output: 30000, cacheRead: 500, cacheWrite: 0 } })
  expect(planAgainstExisting(existing, [create])[0]!.action).toBe('create')

  // 同一个 (provider, model, effective_from_ms) = upsert（「把这条价改成 X」是一次设置，不是查了再改）。
  const same = catalogRowToApiBody({ provider: 'deeprouter', model: 'gpt-5.6-sol', currency: 'CNY', rates: { input: 4000, output: 20000, cacheRead: 400, cacheWrite: 5000 } })
  expect(planAgainstExisting(existing, [same])[0]!.action).toBe('same')

  const changed = catalogRowToApiBody({ provider: 'deeprouter', model: 'gpt-5.6-sol', currency: 'CNY', rates: { input: 4200, output: 20000, cacheRead: 400, cacheWrite: 5000 } })
  expect(planAgainstExisting(existing, [changed])[0]!.action).toBe('update')
})

test('★ 基础价与同名的专属价**不算冲突**（专享价优先、基础价兜底是两层匹配）', () => {
  const base = catalogRowToApiBody({ provider: '*', model: 'gpt-5.6-sol', currency: 'USD', rates: { input: 4000, output: 20000, cacheRead: 400, cacheWrite: 5000 } })
  const planned = planAgainstExisting(existing, [base])[0]!
  // 线上已有 deeprouter / gpt-5.6-sol，新增 * / gpt-5.6-sol 必须被判成「新建」。
  // 判成冲突的话，「给所有供应商兜一个官方价」这件事就做不成了。
  expect(planned.action).toBe('create')
})

test('🚨 同一槽位、不同起点的区间重叠必须报冲突（数据库那条 UNIQUE 拦不住它）', () => {
  const spanned = [
    { provider: '*', model: 'gpt-5.6-sol', currency: 'USD', input_micro_per_ktok: 4000, output_micro_per_ktok: 20000, cache_read_micro_per_ktok: 400, cache_write_micro_per_ktok: 5000, effective_from_ms: 1000, effective_to_ms: 2000 },
  ]
  const overlapping = catalogRowToApiBody({ provider: '*', model: 'gpt-5.6-sol', currency: 'USD', rates: { input: 4000, output: 20000, cacheRead: 400, cacheWrite: 5000 } }, 1500)
  const planned = planAgainstExisting(spanned, [overlapping])[0]!
  expect(planned.action).toBe('conflict')
  // 两端都含：起点正好落在既有终点的下一毫秒才算不重叠。
  const adjacent = catalogRowToApiBody({ provider: '*', model: 'gpt-5.6-sol', currency: 'USD', rates: { input: 4000, output: 20000, cacheRead: 400, cacheWrite: 5000 } }, 2001)
  expect(planAgainstExisting(spanned, [adjacent])[0]!.action).toBe('create')
  expect(formatPlan([planned])).toContain('★冲突')
})

test('只读闸门：非 SELECT 一律拒绝发往线上库', () => {
  expect(() => renderSqlProbe('DELETE FROM model_price')).toThrow()
  expect(() => renderSqlProbe('UPDATE model_price SET currency = "USD"')).toThrow()
  expect(() => renderSqlProbe('SELECT 1; DROP TABLE usage_event')).toThrow()
  const script = renderSqlProbe('SELECT COUNT(*) FROM model_price')
  expect(script).toContain('--defaults-extra-file')
  expect(script).toContain('/root/.atr/mysql8-credentials.txt')
  // 口令经由 `--defaults-extra-file` 递给客户端，命令行里不出现它。
  expect(script).not.toMatch(/--password[= ]/)
})

test('远端脚本：口令不以明文出现，且不残留 ${（模板串会被本机抢先求值）', () => {
  const password = 'SuperSecret-Pw-123-do-not-leak'
  const rendered = renderRemoteApplyScript({
    baseUrl: null, username: 'admin', password,
    mysql: { client: '/usr/local/mysql8/bin/mysql', credentials: '/root/.atr/mysql8-credentials.txt', user: 'atr_user', host: '127.0.0.1', port: 3308, schema: 'ai_token_report' },
    rows: [{ body: { provider: '*', model: 'gpt-5.5' } }],
  })
  expect(rendered).not.toContain(password)
  expect(rendered).not.toContain('${')
  // 配置走 base64 内联：解回来必须逐字相同（否则远端会拿不到待写行）。
  const match = /Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)/.exec(rendered)
  expect(match).not.toBe(null)
  const decoded = JSON.parse(Buffer.from(match![1]!, 'base64').toString('utf8'))
  expect(decoded.password).toBe(password)
  expect(decoded.rows.length).toBe(1)
  // 源码本身也不许含 `${`：它是包在模板串里的，写一个模板字面量就会被本机求值。
  expect(REMOTE_APPLY_SOURCE.includes('${')).toBe(false)
  // 🚨 一个反引号都不许有：模板串里出现成对反引号（哪怕在注释里）会把串**提前截断**，
  //    而报错位置指向模板串的开头 —— 排查方向整个跑偏。真踩过。
  expect(REMOTE_APPLY_SOURCE.includes(String.fromCharCode(96))).toBe(false)
  expect(rendered.includes(String.fromCharCode(96))).toBe(false)
})

test('远端包装：写文件 → 跑 → 删文件，退出码透传', () => {
  const wrapped = wrapRemoteScript('console.log(1)', '/tmp/atr-online-pricing-x.mjs')
  expect(wrapped).toContain("cat > '/tmp/atr-online-pricing-x.mjs' <<'ATR_APPLY_EOF'")
  expect(wrapped).toContain("rm -f '/tmp/atr-online-pricing-x.mjs'")
  expect(wrapped.trimEnd().endsWith('exit $STATUS')).toBe(true)
  // heredoc 定界符必须成对出现，否则整段脚本会被当成脚本文本吞掉。
  expect(wrapped.split('ATR_APPLY_EOF').length).toBe(3)
})
