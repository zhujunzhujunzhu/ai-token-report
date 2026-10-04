#!/usr/bin/env node
/**
 * 线上模型单价操作台 —— 查用量 / 查现价 / 算计划 / 真写入。
 *
 * ```bash
 * node scripts/online-pricing.mjs usage                      # 线上谁在用哪些模型、有没有价
 * node scripts/online-pricing.mjs prices                     # 线上现有价目（只读 SQL）
 * node scripts/online-pricing.mjs plan   --file <价目.json>  # 只算「会新建 / 会覆盖 / 会 409」
 * node scripts/online-pricing.mjs apply  --file <价目.json>  # 真写入（走线上管理接口）
 * ```
 *
 * ## 为什么写数据走 HTTP 管理接口而不是直接改库
 *
 * 单价的**区间重叠**只有应用层拦得住（`shared/price.ts` 的 `findPriceConflicts()`，
 * 回 409）：库里那条 UNIQUE 索引只认 `(provider, model, effective_from_ms)`
 * **完全相同**的一类。直接 `INSERT` 能绕过它，代价是两条重叠的价同时生效 ——
 * 同一段用量有时按这个价、有时按那个价，而两次查询都能自圆其说。
 * 走接口还顺带有审计行（`admin_audit_log`）与事务内的重鉴权。
 *
 * ## 三条安全约束（照抄 `deploy-server.mjs` / `online-probe.ts` 的规矩）
 *
 * 1. 生产 root 口令只从仓库 `.env` 读（或 `ATR_DEPLOY_PASSWORD`），**只走
 *    `plink -pwfile`**，绝不进命令行、绝不打印。
 * 2. 管理员口令与会话密钥**不离开目标机**：远端脚本自己从 `/root/.atr/portal.env`
 *    读，只回结果（见 `online-pricing-plan.mjs` 的 `REMOTE_APPLY_SOURCE`）。
 * 3. 读一律只读 SQL（`renderSqlProbe` 里有闸门）。
 *
 * 读通道复用 `verify/perf/runtime-ab/ssh-exec.mjs`（它已经踩平了 PuTTY 0.72
 * 的主机指纹与 `-pwfile` 两个坑）；⚠️ 该文件一旦搬家，这里要跟着改。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runRemote } from '../packages/server/verify/perf/runtime-ab/ssh-exec.mjs'
import {
  MYSQL, catalogRowToApiBody, formatPlan, planAgainstExisting, microToRateText,
  readCatalog, renderRemoteApplyScript, renderSqlProbe, remoteApplyPath, wrapRemoteScript,
} from './online-pricing-plan.mjs'

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

const USAGE = `线上模型单价操作台

  node scripts/online-pricing.mjs usage [--limit N]        线上用量按 来源/供应商/模型 汇总，标出有没有价
  node scripts/online-pricing.mjs prices                   线上现有价目（只读）
  node scripts/online-pricing.mjs plan  --file <价目.json>  算出写入计划（新建 / 覆盖 / 无变化 / 冲突），不写
  node scripts/online-pricing.mjs apply --file <价目.json>  真写入；--dry-run 只打印请求体
  node scripts/online-pricing.mjs verify [--period today]   读看板概览，核对真的算出了金额（缺省从 epoch 起）

  价目表单位是「货币单位 / 百万 token」（与官方价目表、与计价页输入框同款）。
  --from <epoch_ms>   生效起点，缺省 0 = 自始有效（给从没配过价的模型补价时必须用 0，
                      否则历史用量会永远停在「未计价」）
  --username/--password  覆盖目标机 /root/.atr/portal.env 里的管理员账号
  --base-url <url>    覆盖目标机上的服务地址（缺省 http://127.0.0.1:$ATR_PORT）
`

// ── 只读 SQL ────────────────────────────────────────────────────────────────
function runSql(sql) {
  const result = runRemote(renderSqlProbe(sql))
  if (result.status !== 0) throw new Error(`远程 SQL 失败：\n${result.stderr || result.stdout}`)
  return String(result.stdout ?? '').split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split('\t'))
}

/** `-N --batch` 下 NULL 打印成字面量 `NULL`；只有可空列需要还原。 */
const nullish = (value) => (value === 'NULL' ? null : value)
const num = (value) => Number(value ?? 0)

const USAGE_SQL = [
  'SELECT source, provider, model, COUNT(*),',
  '  SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens)',
  'FROM usage_event GROUP BY source, provider, model',
].join(' ')

const PRICE_SQL = [
  'SELECT provider, model, currency, input_micro_per_ktok, output_micro_per_ktok,',
  '  cache_read_micro_per_ktok, cache_write_micro_per_ktok, effective_from_ms, effective_to_ms, note',
  'FROM model_price ORDER BY provider, model, effective_from_ms',
].join(' ')

/** 线上现有价目（契约字段名与 `GET /api/v1/admin/pricing` 一致，只是走只读 SQL 省一次登录）。 */
function fetchPrices() {
  return runSql(PRICE_SQL).map(([provider, model, currency, input, output, cacheRead, cacheWrite, from, to, note]) => ({
    provider, model, currency: nullish(currency),
    input_micro_per_ktok: num(input), output_micro_per_ktok: num(output),
    cache_read_micro_per_ktok: num(cacheRead), cache_write_micro_per_ktok: num(cacheWrite),
    effective_from_ms: num(from), effective_to_ms: to === 'NULL' ? null : num(to),
    note: nullish(note),
  }))
}

/** 一行用量：按 (provider, model) 归并，来源只作为附带信息（价格键里没有来源）。 */
function fetchUsage() {
  const grouped = new Map()
  for (const [source, provider, model, events, input, output, cacheRead, cacheWrite] of runSql(USAGE_SQL)) {
    const key = `${provider}\u0000${model}`
    const row = grouped.get(key) ?? { provider, model, events: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sources: new Map() }
    row.events += num(events)
    row.input += num(input); row.output += num(output)
    row.cacheRead += num(cacheRead); row.cacheWrite += num(cacheWrite)
    row.sources.set(source, (row.sources.get(source) ?? 0) + num(events))
    grouped.set(key, row)
  }
  return [...grouped.values()]
    .map((row) => ({ ...row, total: row.input + row.output + row.cacheRead + row.cacheWrite }))
    .sort((a, b) => b.total - a.total)
}

const group = (value) => value.toLocaleString('en-US')

/** 这一行用量会被哪条价算到：专属价 > 基础价 > 没有。 */
function priceOf(prices, provider, model) {
  const now = Date.now()
  const live = (row) => row.effective_from_ms <= now && (row.effective_to_ms === null || now <= row.effective_to_ms)
  const specific = prices.find((row) => row.provider === provider && row.model === model && live(row))
  if (specific) return { kind: '专属', row: specific }
  const base = prices.find((row) => row.provider === '*' && row.model === model && live(row))
  if (base) return { kind: '基础价', row: base }
  return { kind: '★未计价', row: null }
}

function printUsage(limit) {
  const prices = fetchPrices()
  const rows = fetchUsage()
  console.log(`来源 / 供应商 / 模型 用量（共 ${rows.length} 组，按总 token 降序，只读）\n`)
  console.log(['供应商', '模型', '调用', '输入', '输出', '缓存读', '缓存写', '总 token', '计价', '币种', '来源'].join('\t'))
  for (const row of rows.slice(0, limit ?? rows.length)) {
    const hit = priceOf(prices, row.provider, row.model)
    const sources = [...row.sources.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name).join(',')
    console.log([
      row.provider, row.model, group(row.events), group(row.input), group(row.output),
      group(row.cacheRead), group(row.cacheWrite), group(row.total), hit.kind,
      hit.row ? hit.row.currency : '-', sources,
    ].join('\t'))
  }
  const unpriced = rows.filter((row) => priceOf(prices, row.provider, row.model).row === null)
  const unpricedTokens = unpriced.reduce((sum, row) => sum + row.total, 0)
  const allTokens = rows.reduce((sum, row) => sum + row.total, 0)
  console.log(`\n未计价：${unpriced.length} 组 / ${group(unpricedTokens)} token（占全部 ${(allTokens ? (unpricedTokens / allTokens) * 100 : 0).toFixed(1)}%）`)
  for (const row of unpriced.slice(0, 20)) console.log(`  ★ ${row.provider} / ${row.model}  ${group(row.total)} token，${group(row.events)} 次调用`)
  if (unpriced.length > 20) console.log(`  …另有 ${unpriced.length - 20} 组`)
}

function printPrices() {
  const prices = fetchPrices()
  console.log(`线上现价（${prices.length} 条，只读）\n`)
  console.log(['供应商', '模型', '币种', '输入', '输出', '缓存读', '缓存写', '生效', '备注'].join('\t'))
  for (const row of prices) {
    const rates = ['input_micro_per_ktok', 'output_micro_per_ktok', 'cache_read_micro_per_ktok', 'cache_write_micro_per_ktok']
      .map((key) => microToRateText(row[key])).join('\t')
    const span = `${row.effective_from_ms === 0 ? '自始' : new Date(row.effective_from_ms).toISOString()} → ${row.effective_to_ms === null ? '至今' : new Date(row.effective_to_ms).toISOString()}`
    console.log([row.provider, row.model, row.currency, rates, span, row.note ?? ''].join('\t'))
  }
}

// ── 计划 ────────────────────────────────────────────────────────────────────
function buildPlan(file, fromMs) {
  if (!file) throw new Error('缺 --file <价目.json>')
  const path = resolve(String(file))
  if (!existsSync(path)) throw new Error(`价目表不存在：${path}`)
  const catalog = readCatalog(readFileSync(path, 'utf8'))
  const candidates = catalog.rows.map((row) => catalogRowToApiBody(row, fromMs))
  const prices = fetchPrices()
  const items = planAgainstExisting(prices, candidates)
  return { catalog, candidates, items, prices, path }
}

function reportPlan(plan) {
  console.log(`价目表：${plan.path}`)
  if (plan.catalog.asOf) console.log(`数据日期：${plan.catalog.asOf}`)
  if (plan.catalog.source) console.log(`价目来源：${plan.catalog.source}`)
  console.log(`线上现有 ${plan.prices.length} 条价；本次计划 ${plan.items.length} 行\n`)
  console.log(formatPlan(plan.items))
  for (const warning of plan.catalog.warnings) console.log(`\n⚠️ ${warning}`)
  const conflicts = plan.items.filter((item) => item.action === 'conflict')
  if (conflicts.length > 0) console.log(`\n🚨 ${conflicts.length} 行与线上既有区间相交，服务端会回 409：先改掉那条的生效终点，或把这次的起点挪到它之后。`)
  return conflicts.length === 0
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 在目标机上跑一次带会话的远端脚本，返回它回的那行 JSON。
 *
 * 会话与口令都只在目标机上：本机送配置（base64 内联）与行数据，拿回结果。
 */
function runRemoteScript(config, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const remotePath = remoteApplyPath(stamp)
  console.log(`\n${label}（目标机 ${remotePath}）…`)
  const result = runRemote(wrapRemoteScript(renderRemoteApplyScript(config), remotePath))
  const stdout = String(result.stdout ?? '')
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('ATR_ERROR '))
  if (errorLine) throw new Error(JSON.parse(errorLine.slice('ATR_ERROR '.length)).reason)
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('ATR_RESULT '))
  if (!resultLine) throw new Error(`目标机没有回结果（远端脚本可能没跑起来）\n${stdout}\n${result.stderr ?? ''}`)
  return JSON.parse(resultLine.slice('ATR_RESULT '.length))
}

function applyPlan(plan, options) {
  const todo = plan.items.filter((item) => item.action === 'create' || item.action === 'update')
  const skipped = plan.items.filter((item) => item.action === 'same')
  if (skipped.length > 0) console.log(`\n跳过 ${skipped.length} 行（四类单价与币种与线上逐字相同，写入只是审计噪音）`)
  if (todo.length === 0) { console.log('\n没有需要写的行。'); return }
  const rows = todo.map((item) => ({ body: item.candidate }))
  if (options['dry-run']) {
    console.log(`\n--dry-run：以下 ${rows.length} 个请求体会被 POST 到 POST <base>/api/v1/admin/pricing\n`)
    for (const row of rows) console.log(JSON.stringify(row.body))
    return
  }
  const config = {
    mode: 'apply',
    baseUrl: options['base-url'] ?? null,
    username: options.username ?? null,
    password: options.password ?? null,
    mysql: MYSQL,
    rows,
  }
  const parsed = runRemoteScript(config, `写入 ${rows.length} 行`)
  console.log(`\n已登录 ${parsed.username} @ ${parsed.baseUrl}\n`)
  let failed = 0
  for (const row of parsed.results) {
    const mark = row.status === 200 ? '✅' : '❌'
    if (row.status !== 200) failed += 1
    console.log(`${mark} ${row.status}  ${row.provider} / ${row.model}${row.reason ? `  ${row.reason}` : ''}`)
  }
  console.log(`\n成功 ${parsed.results.length - failed} / ${parsed.results.length}`)
  if (failed > 0) process.exitCode = 1
}

// ── 核对 ────────────────────────────────────────────────────────────────────

/**
 * 写完价之后**看板真的按它算出了金额**吗？
 *
 * ★ 这一条是必须的：单价写进去了、看板却仍是「未计价」有好几种成因
 *   （币种 / 生效区间 / 供应商是上报原值而不是归一化后的名字 / 缺 `cost:read`），
 *   它们在页面上都表现为「金额没出现」，而 `prices` 那条命令会显示一切正常。
 *   所以这里读的是**看板自己的接口**（`/api/v1/stats/overview`，带 `cost:read` 的会话），
 *   看的是它自己算出来的 `cost.pricedRate` 与未计价清单。
 */
function verifyCoverage(options) {
  const query = options.period ? `period=${encodeURIComponent(String(options.period))}` : 'from=0'
  const parsed = runRemoteScript({
    mode: 'stats',
    baseUrl: options['base-url'] ?? null,
    username: options.username ?? null,
    password: options.password ?? null,
    mysql: MYSQL,
    rows: [],
    statsPath: `/api/v1/stats/overview?${query}`,
  }, `核对看板金额（${query}）`)
  const cost = parsed.stats?.cost
  console.log(`\n已登录 ${parsed.username} @ ${parsed.baseUrl}`)
  if (!cost) {
    console.log('\n🚨 概览里没有 `cost` 字段 —— 这个身份没有 `cost:read`（权限问题，不是没配价）。')
    process.exitCode = 1
    return
  }
  console.log(`\n计价覆盖率：${(cost.pricedRate * 100).toFixed(2)}%（已计价 ${group(cost.pricedTokens)} / 共 ${group(cost.totalTokens)} token）`)
  if (cost.costs.length === 0) {
    console.log('金额：无（一条价都没匹配上）')
  } else {
    // 🚨 多币种**各算各的、绝不相加**：这里逐币种列出来，不做任何合计。
    for (const entry of cost.costs) {
      console.log(`金额：${entry.currency} ${(entry.amountMicro / 1_000_000).toFixed(2)}（${group(entry.tokens)} token）`)
    }
  }
  console.log(`单价来源：${cost.pricing?.pricingSource ?? '未知'}`)
  if (cost.unpricedTargets?.length) {
    console.log(`未计价目标（${(cost.unpricedRate * 100).toFixed(2)}%）：${cost.unpricedTargets.join('、')}`)
  }
}


// ── 入口 ────────────────────────────────────────────────────────────────────
try {
  if (command === 'usage') printUsage(args.limit ? Number(args.limit) : undefined)
  else if (command === 'prices') printPrices()
  else if (command === 'plan') reportPlan(buildPlan(args.file, args.from ? Number(args.from) : 0))
  else if (command === 'verify') verifyCoverage(args)
  else if (command === 'apply') {
    const plan = buildPlan(args.file, args.from ? Number(args.from) : 0)
    if (!reportPlan(plan)) { console.error('\n有冲突行，已中止（一条都不写）。'); process.exitCode = 1 }
    else applyPlan(plan, args)
  } else {
    console.log(USAGE)
    if (command !== 'help') process.exitCode = 2
  }
} catch (error) {
  console.error(`错误：${error?.message ?? error}`)
  process.exitCode = 1
}
