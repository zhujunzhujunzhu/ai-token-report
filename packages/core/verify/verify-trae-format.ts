/**
 * **Trae 日志格式哨兵**（P0 级）：把「Trae 的计费日志长什么样」固化下来。
 *
 * ## 为什么需要这一层
 *
 * 适配器里那些「不会报错、只会数字悄悄不对」的口径，全部来自**对真实日志的观察**：
 *
 * | 观察 | 错了会怎样 |
 * |---|---|
 * | `prompt_tokens` **含** `cache_read` / `cache_creation` | 照抄 Claude Code 的「原样」写法 ⇒ 缓存读被算两遍 |
 * | `prompt_tokens_total` 是**累计值** | 采它 ⇒ 总量按平方级膨胀（第 3 条就已等于前 3 条之和） |
 * | 模型名**不在**用量事件里 | 按「最近一条前置的 `CurrentConfigInfo`」猜 ⇒ 用量记到别的模型上，而单价是按 `(provider, model)` 精确匹配的 |
 * | 一个日志文件会**跨多个工作区** | 按「最近一条前置的 `workspace_folder`」猜 ⇒ 用量记到别的项目上 |
 * | 国际版与国内版是**两个来源** | 合并采集 ⇒ 再也分不开「这个数字是谁的」（两套账号 / 模型族 / 计价） |
 *
 * 这些结论一旦上游改格式就会静默失效。所以这里做两件事：
 *
 * 1. **合成夹具**（默认运行）：把上面每一条变成一条可执行断言，格式漂移时**在这里炸**；
 * 2. `--real`：在**本机真实日志**上把适配器的输出与脚本内**独立实现的解析**
 *    逐条比对（独立实现是刻意的 —— 复用适配器等于自己验证自己），
 *    并把实测的失真统计打印出来。只读：不写库、不写数据目录、不改任何文件。
 *
 * 运行：
 * ```
 * bun run --filter '@ai-token-report/core' verify:trae
 * bun run --filter '@ai-token-report/core' verify:trae -- --real
 * ```
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import {
  TRAE_VARIANTS,
  defaultTraeUserDataDirs,
  mapTraeUsage,
  parseTraeUsageEvent,
  traeCnSource,
  traeSource,
} from '../src/sources/trae.js'
import { requireSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { scanAllSources } from '../src/scanner.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'
import { openStats } from '../src/db/stats.js'

let checks = 0
let failures = 0
let skips = 0
let observations = 0

function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `   ${detail}` : ''}`)
}

function skip(label: string, reason: string): void {
  skips++
  console.log(`  ⏭ ${label}：${reason}`)
}

function observe(label: string, detail: string): void {
  observations++
  console.log(`  ⚠ ${label}`)
  console.log(`      ${detail}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ─────────────────────────────────`)
}

/** 千分位（日志与总量都是大数，裸数字读不出量级）。 */
function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ── 合成夹具 ────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'atr-verify-trae-'))
const STAMP = '20251201T153127'
const AGENT = 'ai-agent_0_1764574287705_stdout.log'
const SESSION = `${STAMP}/Modular/ai-agent_0_1764574287705_stdout`

/** 一行日志（默认照抄本机真实样本：10527 / 826 / 9472 / 0 ⇒ total 11353）。 */
function line(opts: {
  time?: string
  name?: string
  prompt?: number
  completion?: number
  total?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number | null
  promptTotal?: number
  body?: string
} = {}): string {
  const some = (v: number | null): string => (v === null ? 'None' : `Some(${v})`)
  const body = opts.body ?? [
    `name: ${JSON.stringify(opts.name ?? '')}`,
    `prompt_tokens: ${opts.prompt ?? 10527}`,
    `completion_tokens: ${opts.completion ?? 826}`,
    `total_tokens: ${opts.total ?? (opts.prompt ?? 10527) + (opts.completion ?? 826)}`,
    `reasoning_tokens: ${some(opts.reasoning === undefined ? 768 : opts.reasoning)}`,
    `cache_creation_input_tokens: ${some(opts.cacheWrite ?? 0)}`,
    `cache_read_input_tokens: ${some(opts.cacheRead ?? 9472)}`,
    `prompt_tokens_total: ${some(opts.promptTotal ?? 0)}`,
    `completion_tokens_total: Some(0)`,
  ].join(', ')
  return `${opts.time ?? '2025-12-02T07:46:05.223268+08:00'}  INFO ai_agent::domain::model::llm_stream: token usage: TokenUsageEvent { ${body} }`
}

function noise(): string {
  return '2025-12-02T07:46:05.100000+08:00  INFO ai_agent::domain::model::model_mgr: synced model info'
}

function writeLog(home: string, name: string, lines: readonly string[]): string {
  const target = join(home, 'logs', STAMP, 'Modular')
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  return file
}

async function synthetic(): Promise<void> {
  section('根解析：国际 / 国内是两个来源，目录名各自钉住')
  {
    const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\Roaming' }, home: 'C:\\U' }
    check('国际版用户数据目录 = <APPDATA>/Trae',
      defaultTraeUserDataDirs('trae', win)[0] === join('C:\\Roaming', 'Trae'),
      defaultTraeUserDataDirs('trae', win)[0])
    check('国内版用户数据目录 = <APPDATA>/TraeCN（不是 .trae-cn、不是带空格的 "Trae CN"）',
      defaultTraeUserDataDirs('trae-cn', win)[0] === join('C:\\Roaming', 'TraeCN'),
      defaultTraeUserDataDirs('trae-cn', win)[0])
    check('根 = <用户数据目录>/logs（家目录下的 .trae / .trae-cn 只放扩展，不含日志）',
      traeSource.roots(['/x'])[0]?.path === join('/x', 'logs'))
    check('根自报的来源 id 不串（国内版的根不能说自己属于 trae）',
      traeCnSource.roots(['/x'])[0]?.source === 'trae-cn' && traeSource.roots(['/x'])[0]?.source === 'trae')
    check('两个发行版各自注册、各有自己的开关与多根环境变量',
      requireSource('trae').disableEnv === 'DSH_TOKEN_REPORT_TRAE'
      && requireSource('trae-cn').disableEnv === 'DSH_TOKEN_REPORT_TRAE_CN'
      && TRAE_VARIANTS['trae-cn'].homesEnv === 'DSH_TOKEN_REPORT_TRAE_CN_HOMES')

    const saved = process.env[TRAE_VARIANTS.trae.homesEnv]
    process.env[TRAE_VARIANTS.trae.homesEnv] = ['/a', '/b'].join(delimiter)
    try {
      const p = traeSource.roots([]).map((r) => r.path)
      check('多根环境变量真的被读到（Codex / Claude 的同名开关此前是「只在帮助里存在」）',
        p.length === 2 && p[0] === join('/a', 'logs') && p[1] === join('/b', 'logs'), p.join(' + '))
    } finally {
      if (saved === undefined) delete process.env[TRAE_VARIANTS.trae.homesEnv]
      else process.env[TRAE_VARIANTS.trae.homesEnv] = saved
    }

    // ⚠️ 路径用 `join()` 拼（Windows 上 '/yes/logs' 会被规范化成 '\yes\logs'，
    //   拿 POSIX 字面量做前缀判断会让两项都判成「不存在」）。
    const present = join(dir, 'present-cn')
    const absent = join(dir, 'absent-intl')
    const resolved = resolveSourceRoots({
      sources: ['trae', 'trae-cn'],
      homes: { trae: [absent], 'trae-cn': [present] },
      env: {},
      exists: (p) => p.startsWith(present),
    })
    check('两个来源独立解析：不存在的根逐项报出、存在的那一个照常统计',
      resolved.roots.length === 1 && resolved.roots[0]?.source === 'trae-cn'
      && resolved.missing.length === 1 && resolved.missing[0]?.source === 'trae')
    check('两个来源不会被合并成一个（合并 = 再也分不开谁是谁）',
      resolved.sources.join(',') === 'trae-cn')
  }

  section('四列映射：prompt 含缓存 ⇒ 必须减（与 Claude Code 相反）')
  {
    const fields = parseTraeUsageEvent(line())!
    const { counts, identityOk, overlap } = mapTraeUsage(fields)
    check('解析出真实样本的四个单次字段',
      fields.promptTokens === 10527 && fields.completionTokens === 826
      && fields.cacheReadTokens === 9472 && fields.cacheWriteTokens === 0
      && fields.reasoningTokens === 768,
      JSON.stringify(fields))
    check('input = prompt - cache_read - cache_write = 1055', counts.input === 1055, String(counts.input))
    check('★ 四列之和 == 上游自报的 total_tokens（11353）', counts.total === 11353 && identityOk)
    check('不做减法会多算（那是 Claude Code 的语义，照抄即错）', counts.total !== 10527 + 826 + 9472)
    check('无缓存重叠（cache_read + cache_write ≤ prompt）', overlap === false)
    check('恒等式逐列成立：total = input + output + cacheRead + cacheWrite',
      counts.total === counts.input + counts.output + counts.cacheRead + counts.cacheWrite)

    const withWrite = mapTraeUsage({
      name: '', promptTokens: 100, completionTokens: 5, totalTokens: 105,
      reasoningTokens: 0, cacheReadTokens: 40, cacheWriteTokens: 20,
    })
    check('cache_creation 也含在 prompt 内（一起减）', withWrite.counts.input === 40 && withWrite.counts.total === 105)

    const overlapFields = {
      name: '', promptTokens: 10, completionTokens: 1, totalTokens: null,
      reasoningTokens: null, cacheReadTokens: 50, cacheWriteTokens: 0,
    }
    check('cache_read > prompt ⇒ input 夹 0 且 overlap 置位（不产生负数）',
      mapTraeUsage(overlapFields).counts.input === 0 && mapTraeUsage(overlapFields).overlap === true)

    check('缺 total_tokens 时不做恒等式判定；自报不符时必须报 false',
      mapTraeUsage({ ...overlapFields, totalTokens: null }).identityOk === true
      && mapTraeUsage({ ...overlapFields, totalTokens: 1 }).identityOk === false)
  }

  section('行解析：累计字段绝不冒充单次字段')
  {
    const fields = parseTraeUsageEvent(line({ prompt: 11097, completion: 474, promptTotal: 36745 }))!
    check('prompt_tokens 取单次值（11097），不取累计值（36745）', fields.promptTokens === 11097, String(fields.promptTokens))
    check('累计字段再大也不影响总量', mapTraeUsage(fields).counts.total === 11097 + 474)

    check('与用量无关的行解析不出（真实日志 99.99% 是这种）', parseTraeUsageEvent(noise()) === null)
    check('缺单次必需字段 ⇒ 解析不出（绝不用 0 兜底编一笔）',
      parseTraeUsageEvent(line({ body: 'name: "", completion_tokens: 1, total_tokens: 1' })) === null)
    check('字段顺序变化不影响解析（上游重排不该让口径崩掉）',
      parseTraeUsageEvent(line({ body: 'cache_read_input_tokens: Some(7), total_tokens: 20, prompt_tokens: 15, completion_tokens: 5' }))
        ?.promptTokens === 15)
    check('`None` 与缺字段等价（reasoning 记 null）',
      parseTraeUsageEvent(line({ reasoning: null }))?.reasoningTokens === null)
    check('标记在、结构不在 ⇒ 不是用量行',
      parseTraeUsageEvent('token usage: TokenUsageEvent 没有结构体') === null)
  }

  section('折叠：一行一次调用，畸形 / 零用量 / 重复各有计数')
  {
    const home = join(dir, 'intl')
    writeLog(home, AGENT, [
      noise(),
      line({ time: '2025-12-02T07:46:05.223268+08:00' }),
      line({ time: '2025-12-02T07:46:11.529001+08:00', prompt: 16068, completion: 245, cacheRead: 11264, total: 16313 }),
    ])
    const scanned = await scanAllSources(traeSource.roots([home]))
    check('两条用量行 ⇒ 两条记录（噪声行不产生记录）', scanned.records.length === 2, String(scanned.records.length))
    check('幂等键 = trae:<相对路径>:<文件内序号>',
      scanned.records[0]?.eventId === `trae:${SESSION}:0` && scanned.records[1]?.eventId === `trae:${SESSION}:1`,
      String(scanned.records[0]?.eventId))
    check('seq 文件内单调从 0 起', scanned.records.map((r) => r.seq).join(',') === '0,1')
    check('provider 恒为与来源同名的常量', scanned.records.every((r) => r.provider === 'trae'))
    check('cwd 恒为 null（用量事件不带工作区归属，见文件头第 5 条）', scanned.records.every((r) => r.cwd === null))
    check('时间戳按 RFC3339（含 6 位小数与偏移）解析正确',
      scanned.records[0]?.time === Date.parse('2025-12-02T07:46:05.223268+08:00'))
    check('会话 id = 相对日志根的路径', scanned.records[0]?.sessionId === SESSION)

    const cnHome = join(dir, 'cn')
    writeLog(cnHome, AGENT, [line()])
    const cn = await scanAllSources(traeCnSource.roots([cnHome]))
    check('国内版写出 source/provider = trae-cn（两个来源不许混）',
      cn.records[0]?.source === 'trae-cn' && cn.records[0]?.provider === 'trae-cn')

    const malformedHome = join(dir, 'malformed')
    writeLog(malformedHome, AGENT, [
      line({ body: 'name: "", prompt_tokens: 10, completion_tokens: 1' }).replace(/^\S+/, '坏时间'),
      line({ body: 'name: "", completion_tokens: 1, total_tokens: 1' }),
      line({ prompt: 100, completion: 1, cacheRead: 0, total: 101 }),
    ])
    const malformed = await scanAllSources(traeSource.roots([malformedHome]))
    check('畸形行只计数、不入库（且不会被同时算成成功行）',
      malformed.records.length === 1 && malformed.diagnostics.traeMalformedLines === 2
      && malformed.diagnostics.traeUsageLines === 1,
      `records=${malformed.records.length} malformed=${malformed.diagnostics.traeMalformedLines} usage=${malformed.diagnostics.traeUsageLines}`)

    const zeroHome = join(dir, 'zero')
    writeLog(zeroHome, AGENT, [line({ prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 })])
    const zero = await scanAllSources(traeSource.roots([zeroHome]))
    check('四列全 0 的事件不入库（不替上游编一笔用量）',
      zero.records.length === 0 && zero.diagnostics.traeZeroUsage === 1)

    const dupHome = join(dir, 'dup')
    const dupLine = line()
    writeLog(dupHome, AGENT, [dupLine, noise(), dupLine])
    const dup = await scanAllSources(traeSource.roots([dupHome]))
    check('整行被写两遍 ⇒ 只入一条并计数', dup.records.length === 1 && dup.diagnostics.traeDuplicateEvents === 1)

    const nameHome = join(dir, 'name')
    writeLog(nameHome, AGENT, [line({ name: '' }), line({ name: 'x-model', time: '2025-12-02T07:47:00.000000+08:00' })])
    const named = await scanAllSources(traeSource.roots([nameHome]))
    check('模型名只取事件自带的 name；为空落 (unknown) 并计数',
      named.records[0]?.model === '(unknown)' && named.records[1]?.model === 'x-model'
      && named.diagnostics.traeUnnamedEvents === 1)

    const identityHome = join(dir, 'identity')
    writeLog(identityHome, AGENT, [
      line({ prompt: 100, completion: 1, cacheRead: 0, total: 999 }),
      line({ prompt: 10, completion: 1, cacheRead: 50, cacheWrite: 0, total: 51, time: '2025-12-02T07:47:00.000000+08:00' }),
    ])
    const identity = await scanAllSources(traeSource.roots([identityHome]))
    check('恒等式不符与缓存重叠都只计数、不抛错（它们是「上游语义变了」的信号）',
      identity.diagnostics.traeIdentityViolations === 1 && identity.diagnostics.traeOverlapAnomalies === 1)
  }

  section('列举：只认 ai-agent*_stdout.log；镜像只算一次')
  {
    const home = join(dir, 'list')
    writeLog(home, AGENT, [line()])
    writeLog(home, 'ai-agent_0_1764574287705_stderr.log', [line()])
    writeLog(home, 'ckg_0_1764574287705_stdout.log', [line()])
    writeLog(home, 'ai-agent_1_1764999999999_stdout.log', [])
    const root = traeSource.roots([home])[0]!
    const metas = await traeSource.list(root)
    check('stderr / ckg / 0 字节都不算会话，只有 stdout 那一份', metas.length === 1, metas.map((m) => m.filePath).join(', '))
    const info = await traeSource.inspect!(root)
    check('inspect 用 Trae 自己的形态数（拿 DSH 的三层结构会得到 0/0）', info.sessions === 1 && info.files === 1)
    check('inspect 报得出「最近写入」', (info.latestMs ?? 0) > 0)

    const asFile = await traeSource.list({ path: metas[0]!.filePath, source: 'trae' })
    check('根可以直接是一个日志文件（readdir 对文件抛 ENOTDIR 被吞 = 静默 0 条）', asFile.length === 1)

    const mirrorA = join(dir, 'mirror-a')
    const mirrorB = join(dir, 'mirror-b')
    const lines = [line(), line({ time: '2025-12-02T07:47:00.000000+08:00' })]
    writeLog(mirrorA, AGENT, lines)
    writeLog(mirrorB, AGENT, lines)
    const mirrored = await scanAllSources([...traeSource.roots([mirrorA]), ...traeSource.roots([mirrorB])])
    check('镜像的两个根（相对路径相同）只算一次', mirrored.records.length === 2, String(mirrored.records.length))
  }

  section('入库：库路径与直扫同数，四列分开落库')
  {
    const home = join(dir, 'db')
    writeLog(home, AGENT, [line()])
    const roots = traeSource.roots([home])
    const dbPath = join(dir, 'usage.sqlite')
    const first = await ingestPlainSources({ roots, dbPath })
    check('首次入库 1 条', first.inserted === 1 && first.duplicates === 0)
    const second = await ingestPlainSources({ roots, dbPath })
    check('第二轮（字节数未变）整份跳过', second.inserted === 0 && second.skippedUnchanged === 1)

    const scanned = await scanAllSources(roots)
    const session = await openStats({ sessionsRoot: [], sourceRoots: roots, dbPath })
    try {
      const scanTotal = scanned.records.reduce((sum, r) => sum + r.usage.total, 0)
      check('★ 库路径总量 == 直扫总量', session.totals().total === scanTotal, `${session.totals().total} vs ${scanTotal}`)
      const bySource = session.groups('source')
      check('★ 库按来源分组时只有 trae（trae 与 trae-cn 不混）',
        bySource.length === 1 && bySource[0]?.key === 'trae', JSON.stringify(bySource.map((r) => r.key)))
    } finally {
      session.close()
    }
  }
}

// ── 本机真实日志（只读）────────────────────────────────────────────────────

const USAGE_MARKER = 'token usage: TokenUsageEvent'

/** 从一行里取一个数值字段（`Some(123)` 或裸 `123`）。独立实现，不复用适配器。 */
function pick(body: string, key: string): number | null {
  const m = new RegExp(`${key}: (?:Some\\((\\d+)\\)|(\\d+))`).exec(body)
  if (m === null) return null
  return Number(m[1] ?? m[2])
}

/** 真实日志根：国际版与国内版都按平台约定目录找（不存在就跳过）。 */
function realBases(): { region: 'trae' | 'trae-cn'; base: string; logs: string }[] {
  const out: { region: 'trae' | 'trae-cn'; base: string; logs: string }[] = []
  for (const region of ['trae', 'trae-cn'] as const) {
    for (const base of defaultTraeUserDataDirs(region)) {
      const logs = join(base, 'logs')
      if (existsSync(logs)) out.push({ region, base, logs })
    }
  }
  return out
}

function listLogs(root: string, depth: number, out: string[]): void {
  if (depth < 0) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) { listLogs(p, depth - 1, out); continue }
    if (entry.isFile() && /^ai-agent.*_stdout\.log$/i.test(entry.name)) out.push(p)
  }
}

async function real(): Promise<void> {
  section('本机真实日志（只读复验）')
  const found = realBases()
  if (found.length === 0) {
    skip('本机真实 Trae 日志', '没找到 <用户数据目录>/logs（这台机器上没装 Trae）')
    return
  }
  for (const item of found) console.log(`  根 [${item.region}]: ${item.logs}`)

  const files: string[] = []
  for (const item of found) listLogs(item.logs, 3, files)
  console.log(`  计费日志文件: ${files.length}`)

  // ── 独立实现：单趟解析真实日志，自己做减法、自己拼四列 ──
  const independent: { stamp: string; cols: string; total: number }[] = []
  const byStamp = new Map<string, string[]>()
  let badLines = 0
  let identityViolations = 0
  let overlapAnomalies = 0
  let namedEvents = 0
  let naiveWithoutSubtraction = 0
  /** 真带缓存的用量行数：只有它 > 0 时「减法生效」才是一条可判定的断言（见下）。 */
  let cacheBearingLines = 0
  const stampAll = new Set<string>()
  const workspaceValues = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const raw of text.split('\n')) {
      const ws = /workspace_folder: Some\("([^"]*)"\)/.exec(raw)
      if (ws?.[1] !== undefined) workspaceValues.add(ws[1])
      const at = raw.indexOf(USAGE_MARKER)
      if (at < 0) continue
      const body = raw.slice(at + USAGE_MARKER.length)
      const prompt = pick(body, 'prompt_tokens')
      const completion = pick(body, 'completion_tokens')
      const total = pick(body, 'total_tokens')
      const cacheRead = pick(body, 'cache_read_input_tokens') ?? 0
      const cacheWrite = pick(body, 'cache_creation_input_tokens') ?? 0
      const name = /name: "((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? ''
      if (name !== '') namedEvents++
      if (prompt === null || completion === null) { badLines++; continue }
      if (total !== null && prompt + completion !== total) identityViolations++
      if (cacheRead + cacheWrite > prompt) overlapAnomalies++
      if (cacheRead + cacheWrite > 0) cacheBearingLines++
      const stamp = /^(\S+)/.exec(raw)?.[1]
      const time = stamp === undefined ? NaN : Date.parse(stamp)
      if (!Number.isFinite(time)) { badLines++; continue }
      naiveWithoutSubtraction += prompt + completion + cacheRead + cacheWrite
      const cols = `${Math.max(0, prompt - cacheRead - cacheWrite)}|${completion}|${cacheRead}|${cacheWrite}`
      independent.push({ stamp: String(time), cols, total: prompt + completion })
      const list = byStamp.get(String(time))
      if (list === undefined) byStamp.set(String(time), [cols])
      else list.push(cols)
      stampAll.add(stamp!)
    }
  }
  const independentTotal = independent.reduce((sum, row) => sum + row.total, 0)

  // ── 适配器侧：国际版 + 国内版两个来源各跑一遍（`roots()` 收的是**用户数据目录**，
  //    不是 logs 目录 —— 传错一层会得到一个「到处都找不到」的根，而它看起来只是 0 条）──
  const adapterRoots = [
    ...traeSource.roots(found.filter((i) => i.region === 'trae').map((i) => i.base)),
    ...traeCnSource.roots(found.filter((i) => i.region === 'trae-cn').map((i) => i.base)),
  ]
  const wholeScan = await scanAllSources(adapterRoots)
  const wholeTotal = wholeScan.records.reduce((sum, r) => sum + r.usage.total, 0)

  const mismatched: string[] = []
  for (const rec of wholeScan.records) {
    const cols = `${rec.usage.input}|${rec.usage.output}|${rec.usage.cacheRead}|${rec.usage.cacheWrite}`
    const list = byStamp.get(String(rec.time))
    if (list === undefined || !list.includes(cols)) {
      mismatched.push(`${rec.sessionId}@${rec.time} ⇒ 适配器 ${cols} / 独立 ${list?.join(' , ') ?? '(缺)'}`)
    }
  }

  console.log('')
  console.log(`  计费行: ${fmt(independent.length)} 行（不拆缓存的朴素相加 ${fmt(naiveWithoutSubtraction)} token）`)
  console.log(`  独立解析: ${fmt(independent.length)} 次调用 / ${fmt(independentTotal)} token`)
  console.log(`  适配器  : ${fmt(wholeScan.records.length)} 条记录 / ${fmt(wholeTotal)} token`)
  console.log(`  失真统计: 畸形行 ${badLines} / 恒等式不符 ${identityViolations} / 缓存重叠 ${overlapAnomalies} / 不同时间戳 ${fmt(stampAll.size)}`)
  console.log(`            name 非空 ${namedEvents} / 计费日志 ${wholeScan.diagnostics.traeFiles} 个 / 会话 ${new Set(wholeScan.records.map((r) => r.sessionId)).size} 个`)
  console.log(`  诊断: ${JSON.stringify({
    traeFiles: wholeScan.diagnostics.traeFiles,
    traeUsageLines: wholeScan.diagnostics.traeUsageLines,
    traeMalformedLines: wholeScan.diagnostics.traeMalformedLines,
    traeDuplicateEvents: wholeScan.diagnostics.traeDuplicateEvents,
    traeIdentityViolations: wholeScan.diagnostics.traeIdentityViolations,
    traeOverlapAnomalies: wholeScan.diagnostics.traeOverlapAnomalies,
    traeZeroUsage: wholeScan.diagnostics.traeZeroUsage,
    traeUnnamedEvents: wholeScan.diagnostics.traeUnnamedEvents,
  })}`)

  check('★ 逐条：适配器的每条记录在独立实现里都有同 (时间戳, 四列) 的一条',
    mismatched.length === 0, mismatched.length > 0 ? `例：${mismatched[0]}` : `${wholeScan.records.length} 条全部命中`)
  check('★ 适配器记录数 == 独立解析的条数', wholeScan.records.length === independent.length,
    `${wholeScan.records.length} vs ${independent.length}`)
  check('★ 适配器总量 == 独立解析的总量', wholeTotal === independentTotal,
    `${fmt(wholeTotal)} vs ${fmt(independentTotal)}`)
  // ★ 「减法确实生效」只有在**本机样本真的带缓存**时才可判定：
  //   样本为空（Trae 会自己清理旧日志 —— 本机 2026-10-03 实测：日志根下只剩当天新建的
  //   两个会话目录，用量行 0 条），或者样本的缓存字段全是 0 时，
  //   它退化成 `0 < 0` —— 那是**样本**的问题，不是适配器的问题。
  //   按仓内约定「本机构造不出的条件如实跳过、不假装通过」，这里跳过而不是判失败：
  //   一条会因为「今天没跑 Trae」而变红的哨兵，最后一定会被当成噪音删掉。
  if (independent.length === 0) {
    skip('🚨 减法确实生效：总量严格小于「不拆缓存」的朴素相加',
      '本机真实日志里没有用量行（Trae 会清理旧日志）—— 样本为空，如实跳过')
  } else if (cacheBearingLines === 0) {
    skip('🚨 减法确实生效：总量严格小于「不拆缓存」的朴素相加',
      `本机样本 ${independent.length} 条用量行的缓存字段全为 0 ⇒ 减法在数值上不可观察（样本问题，不是适配器问题）`)
  } else {
    check('🚨 减法确实生效：总量严格小于「不拆缓存」的朴素相加',
      wholeTotal < naiveWithoutSubtraction, `${fmt(wholeTotal)} < ${fmt(naiveWithoutSubtraction)}`)
  }
  check('恒等式逐条成立（prompt + completion == 上游自报 total_tokens）', identityViolations === 0)
  check('缓存字段含在 prompt 内（无例外：cache_read + cache_creation ≤ prompt）', overlapAnomalies === 0)
  check('provider 恒与来源同名，且两个发行版不混',
    wholeScan.records.every((r) => (r.source === 'trae' && r.provider === 'trae')
      || (r.source === 'trae-cn' && r.provider === 'trae-cn')))
  check('cwd 恒为 null（用量事件不带工作区归属）', wholeScan.records.every((r) => r.cwd === null))
  check('诊断里没有畸形行 / 重复行 / 零用量',
    wholeScan.diagnostics.traeMalformedLines === 0
    && wholeScan.diagnostics.traeDuplicateEvents === 0
    && wholeScan.diagnostics.traeZeroUsage === 0)

  if (independent.length === 0) {
    observe('本机真实 Trae 日志里没有用量行 ⇒ 这一节只验证了「跑不炸」',
      'Trae 会清理旧日志（本机 2026-10-03：日志根下只剩当天新建的会话目录）——'
      + '四列口径由合成夹具那一节兜住；真机上跑过 Trae 之后请重跑 `-- --real` 复核')
  }
  if (namedEvents === 0) {
    observe('用量事件自带的 `name` 全为空 ⇒ 模型名落成 (unknown)，这一源配不上单价',
      `${wholeScan.records.length} 条 —— 按「最近一条前置的 CurrentConfigInfo」猜会把用量记到别的模型上`
      + '（实测 4 个文件里分别有 7/2/10/24 条事件前面一条都没有，命中的距离最大到 1,939 行），所以宁可为 (unknown)')
  } else {
    observe('用量事件开始带 `name` 了',
      `${namedEvents} 条非空 —— 它们会被当作模型名采下（单价匹配粒度是 (provider, model)），语义需要复验`)
  }
  if (workspaceValues.size > 1) {
    observe('同一个日志文件里出现过多个工作区 ⇒ 「按项目归属」不能靠「最近一条前置」猜',
      `${workspaceValues.size} 个不同 workspace_folder：${[...workspaceValues].slice(0, 3).join(' / ')} …（所以 cwd 恒为 null）`)
  }
  if (stampAll.size !== independent.length) {
    observe('存在时间戳重复的用量事件（本机实测应为 0）',
      `${independent.length} 条事件只有 ${stampAll.size} 个不同时间戳 ——「一行一次调用」这条前提需要复验`)
  }
  console.log('  ⚠️ 读的是本机真实日志（只读：不写库、不写 dataDir）—— 数字随使用情况变化。')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

try {
  await synthetic()
  if (process.argv.includes('--real')) await real()
  else console.log('\n（加 `-- --real` 可在本机真实日志上只读复验；数字随使用情况变化）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (skips > 0) console.log(`（跳过 ${skips} 项：本机构造不出该条件 —— 不是通过）`)
if (observations > 0) console.log(`（另有 ${observations} 处观察项：不计入失败，需要人判断是否要改）`)
console.log(`\n结果: ${checks - failures}/${checks} 通过${failures > 0 ? `（${failures} 项失败）` : ''}`)
// 与仓内其它 verify 脚本一致：失败一律非 0 退出，便于 CI / 脚本串联。
process.exit(failures === 0 ? 0 : 1)
