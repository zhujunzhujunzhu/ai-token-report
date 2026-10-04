#!/usr/bin/env node
/**
 * 线上**项目归一化规则**操作台 —— 查现有规则 / 算计划 / 真写入 / 核对看板。
 *
 * ```bash
 * bun scripts/online-project-rules.mjs rules                        # 线上现有规则（只读 SQL）
 * bun scripts/online-project-rules.mjs plan  --file <rules.json>    # 只算「会新建 / 会覆盖 / 无变化」
 * bun scripts/online-project-rules.mjs apply --file <rules.json>    # 真写入（走线上管理接口）
 * bun scripts/online-project-rules.mjs verify [--period today]      # 读看板 by=project，核对归一化生效
 * ```
 *
 * ## 为什么写数据走 HTTP 管理接口而不是直接改库
 *
 * 与 `online-pricing.mjs` 同一条理由，只是具体的那条不变量不同：
 * 库里那条 UNIQUE 索引是 `(member_id, prefix)`，而**含 `NULL` 的行它拦不住**
 * （两种后端都一样，实测见 `verify-database-design.ts`）—— 也就是说
 * 「同一个前缀只能有一条**全局**规则」这件事**只有应用层在保证**
 * （`repository.setProjectAlias()` 的 `findProjectAlias()` 查重）。
 * 直接 `INSERT` 能绕过它，代价是同一条目录上并存两条全局规则：
 * 归一化时取「最早的一条」（`projectAliasesToMap` 的 `??=`），结果是
 * 「页面上看着改了、实际还按旧名字走」，而且两条规则都自圆其说。
 * 走接口还顺带有审计行（`admin_audit_log`）与事务内的重鉴权。
 *
 * ## 三条安全约束（照抄 `deploy-server.mjs` / `online-probe.ts` / `online-pricing.mjs`）
 *
 * 1. 生产 root 口令只从仓库 `.env` 读（或 `ATR_DEPLOY_PASSWORD`），**只走
 *    `plink -pwfile`**，绝不进命令行、绝不打印。
 * 2. 管理员口令、验证码 HMAC 密钥与会话**不离开目标机**：远端脚本自己从
 *    `/root/.atr/portal.env` 读，只回结果（见 `online-pricing-plan.mjs` 的
 *    `REMOTE_APPLY_SOURCE`，本文件复用同一份机制，只是换了写入端点）。
 * 3. 读一律只读 SQL（`renderSqlProbe` 里有闸门）。
 *
 * ## 为什么 `rules` 读的是 HEX
 *
 * `mysql --batch` 会把数据里的 `\` 转义成 `\\`，而这里的前缀**全是** Windows 路径。
 * 走 `HEX()` 曲线避开整个转义层 —— 见 `online-project-rules-plan.mjs` 的
 * `EXISTING_RULES_SQL`。这不是洁癖：转义没处理干净的表现是「每条规则都被判成新建」，
 * 第二遍跑就写出一堆重复行。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runRemote } from '../packages/server/verify/perf/runtime-ab/ssh-exec.mjs'
import {
  MYSQL, renderRemoteApplyScript, renderSqlProbe, wrapRemoteScript,
} from './online-pricing-plan.mjs'
import {
  EXISTING_RULES_SQL, formatPlan, normalizeProjectPrefix, parseExistingRules, planAgainstExisting, readRules, ruleToApiBody,
} from './online-project-rules-plan.mjs'

// ── 入参 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const eq = token.indexOf('=')
    if (eq > 0) { out[token.slice(2, eq)] = token.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[token.slice(2)] = true; continue }
    out[token.slice(2)] = next
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'help'

const USAGE = `线上项目归一化规则操作台

  bun scripts/online-project-rules.mjs rules                      线上现有规则（只读）
  bun scripts/online-project-rules.mjs plan  --file <rules.json>   算出写入计划（新建 / 覆盖 / 无变化），不写
  bun scripts/online-project-rules.mjs apply --file <rules.json>   真写入；--dry-run 只打印请求体
  bun scripts/online-project-rules.mjs prune --file <rules.json>   删掉「不在目录里」的旧规则；默认演练，--yes 才真删
  bun scripts/online-project-rules.mjs verify [--period today]     读看板 by=project，核对归一化生效

  规则目录格式：{ "rows": [{ "scope": "global", "prefix": "suit-g92-parent", "alias": "项目名" }] }
  ★ prefix 填**仓库名**（不含路径分隔符）时匹配 cwd 的任一路径段逐字全等 ——
    一条规则覆盖该仓库在任意磁盘、任意父目录下的所有子目录（换盘不用再配第二条）。
    含路径分隔符（'D:\\\\Coding\\\\x'）时按路径前缀匹配，只在该位置生效。
  ⚠️ 路径模式**逐字区分大小写**：同一个项目的 D:\\ 与 d:\\ 变体要各写一条。
  --username/--password  覆盖目标机 /root/.atr/portal.env 里的管理员账号
  --base-url <url>       覆盖目标机上的服务地址（缺省 http://127.0.0.1:$ATR_PORT）
`

// ── 只读 SQL ────────────────────────────────────────────────────────────────
const nullish = (value) => (value === 'NULL' ? null : value)
const group = (value) => Number(value ?? 0).toLocaleString('en-US')

function runSql(sql) {
  const result = runRemote(renderSqlProbe(sql))
  if (result.status !== 0) throw new Error(`远程 SQL 失败：\n${result.stderr || result.stdout}`)
  return String(result.stdout ?? '').split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split('\t'))
}

/** 线上现有规则（只读）。HEX 解码见 `online-project-rules-plan.mjs`。 */
function fetchExistingRules() {
  return parseExistingRules(runSql(EXISTING_RULES_SQL))
}

// ── 计划 ────────────────────────────────────────────────────────────────────
function buildPlan(file) {
  if (!file) throw new Error('缺 --file <rules.json>')
  const path = resolve(String(file))
  if (!existsSync(path)) throw new Error(`规则目录不存在：${path}`)
  const catalog = readRules(readFileSync(path, 'utf8'))
  const candidates = catalog.rows.map(ruleToApiBody)
  const existing = fetchExistingRules()
  return { catalog, candidates, items: planAgainstExisting(existing, candidates), existing, path }
}

function reportPlan(plan) {
  console.log(`规则目录：${plan.path}`)
  if (plan.catalog.asOf) console.log(`数据日期：${plan.catalog.asOf}`)
  if (plan.catalog.source) console.log(`来源：${plan.catalog.source}`)
  console.log(`本次目录 ${plan.candidates.length} 条规则；线上现有 ${plan.existing.length} 条\n`)
  console.log(formatPlan(plan.items))
  for (const warning of plan.catalog.warnings) console.log(`\n⚠️ ${warning}`)
  const create = plan.items.filter((item) => item.action === 'create').length
  const update = plan.items.filter((item) => item.action === 'update').length
  const same = plan.items.filter((item) => item.action === 'same').length
  console.log(`\n新建 ${create} / 覆盖 ${update} / 无变化 ${same} —— 实际会写 ${create + update} 条`)
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 在目标机上跑一次带会话的远端脚本，返回它回的那行 JSON。
 *
 * 会话与口令都只在目标机上：本机送配置（base64 内联）与行数据，拿回结果。
 */
function runRemoteScript(config, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const remotePath = `/tmp/atr-online-project-rules-${stamp}.mjs`
  console.log(`\n${label}（目标机 ${remotePath}）…`)
  const result = runRemote(wrapRemoteScript(renderRemoteApplyScript(config), remotePath))
  const stdout = String(result.stdout ?? '')
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('ATR_ERROR '))
  if (errorLine) throw new Error(JSON.parse(errorLine.slice('ATR_ERROR '.length)).reason)
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('ATR_RESULT '))
  if (!resultLine) throw new Error(`目标机没有回结果（远端脚本可能没跑起来）\n${stdout}\n${result.stderr ?? ''}`)
  return JSON.parse(resultLine.slice('ATR_RESULT '.length))
}

/** 写入端点的覆盖值：本文件走项目规则，缺省（不传）就是模型单价。 */
const PROJECT_ALIASES_ENDPOINT = '/api/v1/admin/project-aliases'

function applyPlan(plan, options) {
  const todo = plan.items.filter((item) => item.action === 'create' || item.action === 'update')
  const skipped = plan.items.filter((item) => item.action === 'same')
  if (skipped.length > 0) console.log(`\n跳过 ${skipped.length} 条（前缀已存在且名字逐字相同、且是启用的，写入只是审计噪音）`)
  if (todo.length === 0) { console.log('\n没有需要写的规则。'); return }
  const rows = todo.map((item) => ({ label: `${item.candidate.prefix} → ${item.candidate.alias}`, body: item.candidate }))
  if (options['dry-run']) {
    console.log(`\n--dry-run：以下 ${rows.length} 个请求体会被 POST 到 <base>${PROJECT_ALIASES_ENDPOINT}\n`)
    for (const row of rows) console.log(JSON.stringify(row.body))
    return
  }
  const parsed = runRemoteScript({
    mode: 'apply',
    endpoint: PROJECT_ALIASES_ENDPOINT,
    baseUrl: options['base-url'] ?? null,
    username: options.username ?? null,
    password: options.password ?? null,
    mysql: MYSQL,
    rows,
  }, `写入 ${rows.length} 条规则`)
  console.log(`\n已登录 ${parsed.username} @ ${parsed.baseUrl}\n`)
  let failed = 0
  for (const row of parsed.results) {
    const mark = row.status === 200 ? '✅' : '❌'
    if (row.status !== 200) failed += 1
    console.log(`${mark} ${row.status}  ${row.label}${row.reason ? `  ${row.reason}` : ''}`)
  }
  console.log(`\n成功 ${parsed.results.length - failed} / ${parsed.results.length}`)
  if (failed > 0) process.exitCode = 1
}

// ── 清掉不在目录里的旧规则 ─────────────────────────────────────────────────

/**
 * 删掉「**不在本次目录里**」的线上规则。
 *
 * ## 为什么需要它
 *
 * 从路径前缀换成仓库名时，新旧规则的 prefix **完全不同**（`D:\Coding\suit-g92-parent`
 * → `suit-g92-parent`），而写入是 upsert —— 新规则不会自动顶掉旧的那批。
 * 不清就会**两批规则同时生效**，而它们的命中范围高度重叠：
 * 看板上的数字仍然对（两批指向同一个项目名），但「哪条规则压住了哪条」再也说不清，
 * 删改任意一条都会让口径在没人预期的时候变一次。
 *
 * ## 为什么默认是演练
 *
 * 这是本工具里**唯一会减少线上数据**的操作（其余是 upsert，重复跑无害）。
 * 目录文件写错一个字符 ⇒ 全部现有规则都会被判成「不在目录里」。
 * 所以默认只打印要删什么，`--yes` 才真删。
 *
 * ★ 逐条独立成败：一条被拒（已被别人删掉等）不连累其余条。
 */
function pruneRules(file, options) {
  if (!file) throw new Error('缺 --file <rules.json>')
  const path = resolve(String(file))
  if (!existsSync(path)) throw new Error(`规则目录不存在：${path}`)
  const catalog = readRules(readFileSync(path, 'utf8'))
  // 业务主键是 (scope, member_id, prefix) —— 少任何一个都会误判成「不在目录里」
  const keep = new Set(catalog.rows.map((r) => `${r.scope}|${r.memberId ?? ''}|${normalizeProjectPrefix(r.prefix)}`))
  const existing = fetchExistingRules()
  const doomed = existing.filter((rule) => !keep.has(`${rule.scope}|${rule.memberId ?? ''}|${normalizeProjectPrefix(rule.prefix)}`))

  console.log(`规则目录：${path}`)
  console.log(`目录里 ${catalog.rows.length} 条；线上 ${existing.length} 条；将删除 ${doomed.length} 条\n`)
  if (doomed.length === 0) {
    console.log('没有需要删除的规则（线上每一条都在目录里）。')
    return
  }
  for (const rule of doomed) {
    console.log(`  删除  ${rule.scope === 'member' ? `[${rule.memberId}] ` : ''}${rule.prefix} → ${rule.alias}${rule.enabled ? '' : '（已停用）'}`)
  }
  if (!options.yes) {
    console.log(`\n--dry-run（默认）：以上 ${doomed.length} 条**尚未删除**。确认无误后加 --yes 真删。`)
    return
  }
  const rows = doomed.map((rule) => ({ label: `${rule.prefix} → ${rule.alias}`, body: { alias_id: rule.aliasId }, method: 'DELETE' }))
  const parsed = runRemoteScript({
    mode: 'apply',
    endpoint: PROJECT_ALIASES_ENDPOINT,
    baseUrl: options['base-url'] ?? null,
    username: options.username ?? null,
    password: options.password ?? null,
    mysql: MYSQL,
    rows,
  }, `删除 ${rows.length} 条旧规则`)
  let failed = 0
  for (const row of parsed.results) {
    const ok = row.status === 200
    if (!ok) failed += 1
    console.log(`${ok ? '✅' : '❌'} ${row.status}  ${row.label}${row.reason ? '  ' + row.reason : ''}`)
  }
  console.log(`\n成功 ${parsed.results.length - failed} / ${parsed.results.length}`)
  if (failed > 0) process.exitCode = 1
}

// ── 现有规则 / 核对 ─────────────────────────────────────────────────────────

function printRules() {
  const rules = fetchExistingRules()
  console.log(`线上现有项目规则（${rules.length} 条，只读）\n`)
  if (rules.length === 0) { console.log('（没有任何规则 —— 看板的「项目」维度取 cwd 最后一段）'); return }
  console.log(['作用域', '归属', '目录前缀', '归一化名', '启用'].join('\t'))
  for (const rule of rules) console.log([rule.scope, rule.scope === 'member' ? (rule.memberId ?? '-') : '(全局)', rule.prefix, rule.alias, rule.enabled ? '是' : '否'].join('\t'))
}

/**
 * 写完规则之后**看板真的按它归好了组**吗？
 *
 * ★ 这一条是必须的：规则写进去了、看板却还是散着有好几种成因
 *   （服务端读的是**上报库**的规则表、而这里可能读的是另一个库；
 *    规则是 `enabled=0`；前缀与上报原值差一个字节 —— 大小写或尾部分隔符），
 *   它们在页面上都表现为「项目名没变」，而 `rules` 那条命令会显示一切正常。
 *   所以这里读的是**看板自己的接口**（`/api/v1/stats/breakdown?by=project`），
 *   看的是它自己算出来的分组键。
 */
function verifyBreakdown(options) {
  const query = options.from !== undefined
    ? `from=${encodeURIComponent(String(options.from))}`
    : `period=${encodeURIComponent(String(options.period ?? 'today'))}`
  const parsed = runRemoteScript({
    mode: 'stats',
    endpoint: PROJECT_ALIASES_ENDPOINT,
    baseUrl: options['base-url'] ?? null,
    username: options.username ?? null,
    password: options.password ?? null,
    mysql: MYSQL,
    rows: [],
    statsPath: `/api/v1/stats/breakdown?by=project&${query}`,
  }, `核对看板项目维度（${query}）`)
  const stats = parsed.stats
  console.log(`\n已登录 ${parsed.username} @ ${parsed.baseUrl}`)
  if (!stats || !Array.isArray(stats.rows)) {
    console.log(`\n🚨 看板没有回 rows —— 这个身份可能缺 stats:read（权限问题，不是没配规则）。\n${JSON.stringify(stats)?.slice(0, 300)}`)
    process.exitCode = 1
    return
  }
  console.log(`\n窗口 ${query}：项目维度共 ${stats.rows.length} 行（按总 token 降序）\n`)
  console.log(['项目名', '总 token', '输入', '输出', '缓存读', '缓存写', '次数'].join('\t'))
  for (const row of [...stats.rows].sort((a, b) => Number(b.totalTokens) - Number(a.totalTokens)).slice(0, 30)) {
    console.log([row.key, group(row.totalTokens), group(row.inputTokens), group(row.outputTokens), group(row.cacheReadTokens), group(row.cacheWriteTokens), group(row.calls)].join('\t'))
  }
  if (stats.rows.length > 30) console.log(`…另有 ${stats.rows.length - 30} 行`)
}

// ── 入口 ────────────────────────────────────────────────────────────────────
try {
  if (command === 'rules') printRules()
  else if (command === 'plan') reportPlan(buildPlan(args.file))
  else if (command === 'verify') verifyBreakdown(args)
  else if (command === 'prune') pruneRules(args.file, args)
  else if (command === 'apply') {
    const plan = buildPlan(args.file)
    reportPlan(plan)
    applyPlan(plan, args)
  } else {
    console.log(USAGE)
    if (command !== 'help') process.exitCode = 2
  }
} catch (error) {
  console.error(`错误：${error?.message ?? error}`)
  process.exitCode = 1
}
