/**
 * **Trae 来源适配器**的计费语义测试（合成夹具，不碰真实 Trae 目录）。
 *
 * 这一组断言服务的命题有四条：
 *
 * > 1. **`prompt_tokens` 含缓存** ⇒ 必须减掉 `cache_read` / `cache_creation`（与 Codex 同、与 Claude Code 反）；
 * > 2. **国际版与国内版是两个来源**（`trae` / `trae-cn`），而目录名推不出对方
 * >    （家目录 `.trae` vs `.trae-cn`，用户数据目录 `Trae` vs `TraeCN`）；
 * > 3. **模型名与工作区都不许猜**（用量事件里没有它们，按「最近一条前置」归属会把
 * >    用量记到别的模型 / 项目上，而单价是按 `(provider, model)` 精确匹配的）；
 * > 4. **幂等键稳定**：`event_id = trae:<相对路径>:<文件内序号>`，镜像的两个根因此只算一次。
 *
 * ⚠️ 所有夹具都写在临时目录里；`defaultTraeUserDataDirs()` 的平台 / 环境 / 家目录
 *   全部**注入**，所以断言不随跑测试的那台机器漂移（本机真的装了 Trae，
 *   忘掉隔离会让断言变成「随机器变化」而不是失败）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TRAE_VARIANTS,
  defaultTraeUserDataDirs,
  mapTraeUsage,
  parseTraeUsageEvent,
  traeCnSource,
  traeSessionIdOf,
  traeSource,
  type TraeUsageFields,
} from '../src/sources/trae.js'
import { registeredSources, requireSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { scanAllSources } from '../src/scanner.js'
import { emptyDiagnostics, type UsageRecord } from '../src/types.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'
import { openDatabaseForIngest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-trae-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 一次调用的日志行（与真实日志逐字段同形，含 6 位小数时间戳与 Rust `Debug` 包装）。 */
function usageLine(opts: {
  time?: string
  name?: string
  prompt?: number
  completion?: number
  total?: number
  reasoning?: number | null
  cacheRead?: number
  cacheWrite?: number
  /** 累计字段：**必须被忽略**（求和即错），夹具里刻意写成非 0。 */
  promptTotal?: number
  completionTotal?: number
  /** 直接给整段结构体（用于畸形行）。 */
  body?: string
}): string {
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
    `completion_tokens_total: ${some(opts.completionTotal ?? 0)}`,
  ].join(', ')
  return `${opts.time ?? '2025-12-02T07:46:05.223268+08:00'}  INFO ai_agent::domain::model::llm_stream: token usage: TokenUsageEvent { ${body} }`
}

/** 一条与用量无关的日志行（真实日志里占 99.99%）。 */
function noiseLine(target = 'ai_agent::infrastructure::adapter::slardar::event'): string {
  return `2025-12-02T07:46:05.100000+08:00  INFO ${target}: [SlardarEvent] something happened`
}

/**
 * 造一个「一个 home + 一次启动」的夹具，返回日志文件的完整路径。
 *
 * 目录形状与真实日志一致：`<用户数据目录>/logs/<时间戳>/Modular/<文件>`。
 */
function writeLog(home: string, stamp: string, name: string, lines: readonly string[]): string {
  const target = join(home, 'logs', stamp, 'Modular')
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  return file
}

const STAMP = '20251201T153127'
const AGENT = 'ai-agent_0_1764574287705_stdout.log'
/** 相对日志根的会话 id（正斜杠、去掉扩展名）。 */
const SESSION = `${STAMP}/Modular/ai-agent_0_1764574287705_stdout`

describe('Trae：日志根解析（国际 / 国内分开）', () => {
  test('默认根 = <用户数据目录>/logs，目录名按平台与发行版各自解析', () => {
    // ⚠️ 期望值一律用 `join()` 拼：三个平台的分隔符由**跑测试的这台机器**决定
    //   （`defaultTraeUserDataDirs` 只可能在本机平台上被真的用到），写死 '/' 会在 Windows 上失败。
    const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, home: 'C:\\Users\\x' }
    expect(traeSource.roots([])).toHaveLength(1)
    expect(traeSource.roots([])[0]!.source).toBe('trae')
    expect(defaultTraeUserDataDirs('trae', win)).toEqual([join('C:\\Users\\x\\AppData\\Roaming', 'Trae')])
    expect(defaultTraeUserDataDirs('trae-cn', win)).toEqual([join('C:\\Users\\x\\AppData\\Roaming', 'TraeCN')])
    // 没给 %APPDATA% 时退化到家目录下的 AppData/Roaming（而不是给出一个字面量空路径）
    expect(defaultTraeUserDataDirs('trae', { platform: 'win32', env: {}, home: 'C:\\Users\\x' }))
      .toEqual([join('C:\\Users\\x', 'AppData', 'Roaming', 'Trae')])
    // macOS / Linux
    expect(defaultTraeUserDataDirs('trae', { platform: 'darwin', home: '/Users/x' }))
      .toEqual([join('/Users/x', 'Library', 'Application Support', 'Trae')])
    expect(defaultTraeUserDataDirs('trae-cn', { platform: 'darwin', home: '/Users/x' }))
      .toEqual([join('/Users/x', 'Library', 'Application Support', 'TraeCN')])
    expect(defaultTraeUserDataDirs('trae', { platform: 'linux', home: '/home/x', env: {} }))
      .toEqual([join('/home/x', '.config', 'Trae')])
    expect(defaultTraeUserDataDirs('trae-cn', { platform: 'linux', home: '/home/x', env: { XDG_CONFIG_HOME: '/cfg' } }))
      .toEqual([join('/cfg', 'TraeCN')])
  })

  test('🚨 国内版的用户数据目录是 TraeCN —— 既不是 .trae-cn 也不是带空格的 "Trae CN"', () => {
    const win = { platform: 'win32' as const, env: { APPDATA: 'A' }, home: 'H' }
    expect(defaultTraeUserDataDirs('trae-cn', win)).toEqual([join('A', 'TraeCN')])
    expect(TRAE_VARIANTS['trae-cn'].userDataDirName).toBe('TraeCN')
    // 国际版的家目录是 `.trae`、国内版是 `.trae-cn`：两者推不出用户名下的用户数据目录名
    expect(TRAE_VARIANTS['trae'].userDataDirName).toBe('Trae')
    expect(traeSource.roots(['/home-x'])[0]!.path).toBe(join('/home-x', 'logs'))
    expect(traeCnSource.roots(['/home-x'])[0]!.path).toBe(join('/home-x', 'logs'))
  })

  test('显式 home 完全接管（不再读环境变量 / 平台目录）', () => {
    const explicit = join(dir, 'explicit')
    expect(traeSource.roots([explicit]).map((r) => r.path)).toEqual([join(explicit, 'logs')])
    expect(traeCnSource.roots([explicit]).map((r) => r.path)).toEqual([join(explicit, 'logs')])
  })

  test('环境变量给出的多根生效（`path.delimiter` 分隔），且**完全接管**默认目录', () => {
    const key = TRAE_VARIANTS.trae.homesEnv
    const saved = process.env[key]
    process.env[key] = [join(dir, 'a'), join(dir, 'b')].join(delimiter)
    try {
      expect(traeSource.roots([]).map((r) => r.path)).toEqual([join(dir, 'a', 'logs'), join(dir, 'b', 'logs')])
    } finally {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
  })

  test('两个发行版都已注册、都是纯文本来源，且各有自己的关闭开关', () => {
    const ids = registeredSources().map((a) => a.id)
    expect(ids).toContain('trae')
    expect(ids).toContain('trae-cn')
    expect(requireSource('trae').encoding).toBe('plain-jsonl')
    expect(requireSource('trae-cn').encoding).toBe('plain-jsonl')
    expect(requireSource('trae').disableEnv).toBe('DSH_TOKEN_REPORT_TRAE')
    expect(requireSource('trae-cn').disableEnv).toBe('DSH_TOKEN_REPORT_TRAE_CN')
  })

  test('环境变量名是约定值（公告契约，不能悄悄改）', () => {
    expect(TRAE_VARIANTS.trae.homesEnv).toBe('DSH_TOKEN_REPORT_TRAE_HOMES')
    expect(TRAE_VARIANTS['trae-cn'].homesEnv).toBe('DSH_TOKEN_REPORT_TRAE_CN_HOMES')
    expect(TRAE_VARIANTS.trae.disableEnv).toBe('DSH_TOKEN_REPORT_TRAE')
    expect(TRAE_VARIANTS['trae-cn'].disableEnv).toBe('DSH_TOKEN_REPORT_TRAE_CN')
  })

  test('resolveSourceRoots：两个发行版各自解析、不存在的根逐项报出、来源不合并', () => {
    const present = join(dir, 'present-cn')
    mkdirSync(join(present, 'logs'), { recursive: true })
    const missing = join(dir, 'missing-intl')
    const resolved = resolveSourceRoots({
      sources: ['trae', 'trae-cn'],
      homes: { trae: [missing], 'trae-cn': [present] },
      env: {},
      exists: (p) => p.startsWith(present),
    })
    expect(resolved.roots.map((r) => [r.source, r.path])).toEqual([['trae-cn', join(present, 'logs')]])
    expect(resolved.missing.map((r) => [r.source, r.path])).toEqual([['trae', join(missing, 'logs')]])
    // 两个来源必须各自出现在清单里，不能被合成一个（合成 = 再也分不开谁是谁）
    expect(resolved.sources).toEqual(['trae-cn'])
  })

  test('环境开关关掉来源时进 disabled（而不是静默 0 条）', () => {
    const resolved = resolveSourceRoots({ env: { DSH_TOKEN_REPORT_TRAE_CN: '0' }, exists: () => false })
    expect(resolved.disabled).toContain('trae-cn')
    expect(resolved.disabled).not.toContain('trae')
  })
})

describe('Trae：行解析与四列映射', () => {
  test('真实样本行：prompt 含缓存 ⇒ input 必须减掉 cache_read / cache_creation', () => {
    const line = usageLine({ prompt: 10527, completion: 826, cacheRead: 9472, cacheWrite: 0, total: 11353 })
    const fields = parseTraeUsageEvent(line)!
    expect(fields.promptTokens).toBe(10527)
    expect(fields.completionTokens).toBe(826)
    expect(fields.cacheReadTokens).toBe(9472)
    expect(fields.cacheWriteTokens).toBe(0)
    expect(fields.reasoningTokens).toBe(768)
    expect(fields.name).toBe('')

    const { counts, identityOk, overlap } = mapTraeUsage(fields)
    expect(counts.input).toBe(1055)         // 10527 - 9472
    expect(counts.cacheRead).toBe(9472)
    expect(counts.output).toBe(826)
    expect(counts.total).toBe(11353)        // == 上游自报的 total_tokens
    expect(counts.calls).toBe(1)
    expect(identityOk).toBe(true)
    expect(overlap).toBe(false)
  })

  test('🚨 不做减法就会多算（这是本适配器唯一的口径差异点）', () => {
    const { counts } = mapTraeUsage(parseTraeUsageEvent(usageLine({ prompt: 10527, completion: 826, cacheRead: 9472 }))!)
    // 照抄 Claude Code 的「原样」写法会得到 10527 + 826 + 9472 = 20825（多算 9472）
    expect(counts.total).not.toBe(10527 + 826 + 9472)
    expect(counts.total).toBe(10527 + 826)
  })

  test('cache_creation 也含在 prompt 内（与 cache_read 一起减）', () => {
    const { counts } = mapTraeUsage({
      name: '', promptTokens: 1000, completionTokens: 10, totalTokens: 1010,
      reasoningTokens: 0, cacheReadTokens: 600, cacheWriteTokens: 300,
    })
    expect(counts.input).toBe(100)
    expect(counts.cacheWrite).toBe(300)
    expect(counts.total).toBe(1010)
  })

  test('cache_read + cache_write > prompt ⇒ input 夹 0，且 overlap 必须能被看见', () => {
    const mapped = mapTraeUsage({
      name: '', promptTokens: 100, completionTokens: 10, totalTokens: null,
      reasoningTokens: null, cacheReadTokens: 120, cacheWriteTokens: 0,
    })
    expect(mapped.counts.input).toBe(0)
    expect(mapped.overlap).toBe(true)
  })

  test('上游没自报 total_tokens 时不做恒等式判定（不替上游编一个）', () => {
    const fields: TraeUsageFields = {
      name: '', promptTokens: 10, completionTokens: 1, totalTokens: null,
      reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    expect(mapTraeUsage(fields).identityOk).toBe(true)
    // 自报了但对不上 ⇒ 必须报不一致
    expect(mapTraeUsage({ ...fields, totalTokens: 12 }).identityOk).toBe(false)
  })

  test('🚨 `prompt_tokens` 与累计字段 `prompt_tokens_total` 不会互相冒充（求和即错那一类）', () => {
    const fields = parseTraeUsageEvent(usageLine({ prompt: 11097, completion: 474, promptTotal: 36745, completionTotal: 2043 }))!
    expect(fields.promptTokens).toBe(11097)
    // 累计值只能出现在单次值之后；正则锚在 `prompt_tokens: ` 上，累计字段取不到
    expect(fields.promptTokens).not.toBe(36745)
    expect(mapTraeUsage(fields).counts.total).toBe(11097 + 474)
  })

  test('`None` / 缺字段按 0 处理；缺单次必需字段则整行解析不出（不用 0 兜底）', () => {
    const none = parseTraeUsageEvent(usageLine({ reasoning: null, cacheRead: 0, cacheWrite: 0 }))!
    expect(none.reasoningTokens).toBeNull()
    expect(mapTraeUsage(none).counts.reasoning).toBe(0)

    expect(parseTraeUsageEvent(usageLine({ body: 'name: "", prompt_tokens: 10, completion_tokens: 1' }))).not.toBeNull()
    expect(parseTraeUsageEvent(usageLine({ body: 'name: "", completion_tokens: 1, total_tokens: 1' }))).toBeNull()
    expect(parseTraeUsageEvent(usageLine({ body: 'name: "", prompt_tokens: 10, total_tokens: 10' }))).toBeNull()
  })

  test('字段顺序变了也能解析（上游重排字段不该让口径崩掉）', () => {
    const line = usageLine({
      body: 'cache_read_input_tokens: Some(7), total_tokens: 20, prompt_tokens: 15, completion_tokens: 5, name: "m"',
    })
    const fields = parseTraeUsageEvent(line)!
    expect(fields.promptTokens).toBe(15)
    expect(fields.completionTokens).toBe(5)
    expect(fields.cacheReadTokens).toBe(7)
    expect(fields.name).toBe('m')
    expect(mapTraeUsage(fields).counts.input).toBe(8)
  })

  test('与用量无关的行一律解析不出（真实日志里 99.99% 是这种）', () => {
    expect(parseTraeUsageEvent(noiseLine())).toBeNull()
    expect(parseTraeUsageEvent('')).toBeNull()
    expect(parseTraeUsageEvent('token usage: TokenUsageEvent 没有结构体')).toBeNull()
  })
})

describe('Trae：列举', () => {
  test('只认 Modular 下的 ai-agent*_stdout.log（stderr / ckg / 别处的 .log 都不含用量）', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [usageLine({})])
    writeLog(home, STAMP, 'ai-agent_0_1764574287705_stderr.log', [usageLine({})])
    writeLog(home, STAMP, 'ckg_0_1764574287705_stdout.log', [usageLine({})])
    mkdirSync(join(home, 'logs', 'aha_log'), { recursive: true })
    writeFileSync(join(home, 'logs', 'aha_log', 'aha_log.log'), usageLine({}) + '\n', 'utf8')

    const root = traeSource.roots([home])[0]!
    const metas = await traeSource.list(root)
    expect(metas).toHaveLength(1)
    expect(metas[0]!.sessionId).toBe(SESSION)
    expect(metas[0]!.source).toBe('trae')
    expect(metas[0]!.cwd).toBeNull()
    expect(metas[0]!.projectDir).toBe(`${STAMP}/Modular`)

    const info = await traeSource.inspect!(root)
    expect(info).toMatchObject({ sessions: 1, files: 1 })
    expect(info.latestMs).toBeGreaterThan(0)
  })

  test('0 字节日志（刚建还没写）不算会话', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [])
    const root = traeSource.roots([home])[0]!
    expect(await traeSource.list(root)).toHaveLength(0)
    expect(await traeSource.inspect!(root)).toMatchObject({ sessions: 0, files: 0 })
  })

  test('🚨 根也可以直接是**一个日志文件**（readdir 对文件抛 ENOTDIR 被吞 = 静默 0 条）', async () => {
    const home = join(dir, 'home')
    const file = writeLog(home, STAMP, AGENT, [usageLine({ prompt: 100, completion: 3, cacheRead: 0, total: 103 })])
    const metas = await traeSource.list({ path: file, source: 'trae' })
    expect(metas).toHaveLength(1)
    const { records } = await scanAllSources([{ path: file, source: 'trae' }])
    expect(records).toHaveLength(1)
    expect(records[0]!.usage.total).toBe(103)
  })

  test('会话 id = 相对日志根的路径（去掉扩展名、正斜杠）', () => {
    const root = join(dir, 'home', 'logs')
    expect(traeSessionIdOf(root, join(root, STAMP, 'Modular', AGENT))).toBe(SESSION)
    // 根就是一个文件时退回家目录无关的文件名
    expect(traeSessionIdOf(join(root, STAMP, 'Modular', AGENT), join(root, STAMP, 'Modular', AGENT)))
      .toBe(`ai-agent_0_1764574287705_stdout`)
  })
})

describe('Trae：折叠与计数', () => {
  test('一行一次调用：序号从 0 递增，非用量行不产生记录', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      noiseLine(),
      usageLine({ time: '2025-12-02T07:46:05.223268+08:00' }),
      noiseLine('ai_agent::domain::model::model_mgr'),
      usageLine({ time: '2025-12-02T07:46:11.529001+08:00', prompt: 16068, completion: 245, cacheRead: 11264, total: 16313 }),
    ])
    const { records, diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.eventId)).toEqual([`trae:${SESSION}:0`, `trae:${SESSION}:1`])
    expect(records.map((r) => r.seq)).toEqual([0, 1])
    expect(records.every((r) => r.source === 'trae')).toBe(true)
    expect(records.every((r) => r.provider === 'trae')).toBe(true)
    expect(records.every((r) => r.cwd === null)).toBe(true)
    expect(records[0]!.time).toBe(Date.parse('2025-12-02T07:46:05.223268+08:00'))
    expect(diagnostics.traeFiles).toBe(1)
    expect(diagnostics.traeUsageLines).toBe(2)
    expect(diagnostics.usageEvents).toBe(2)
  })

  test('🚨 模型名取事件自带的 `name`；为空落 (unknown) 并计数（不许按「最近一条前置」猜）', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      usageLine({ name: '' }),
      usageLine({ name: 'claude-3.7-sonnet', time: '2025-12-02T07:47:00.000000+08:00' }),
    ])
    const { records, diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(records[0]!.model).toBe('(unknown)')
    expect(records[1]!.model).toBe('claude-3.7-sonnet')
    expect(diagnostics.traeUnnamedEvents).toBe(1)
  })

  test('国内版适配器写出 source / provider = trae-cn（两个来源不许混）', async () => {
    const home = join(dir, 'home-cn')
    writeLog(home, STAMP, AGENT, [usageLine({})])
    const { records } = await scanAllSources(traeCnSource.roots([home]))
    expect(records[0]!.source).toBe('trae-cn')
    expect(records[0]!.provider).toBe('trae-cn')
  })

  test('缺时间戳 / 缺必需字段的行被计数并跳过，不编一个 1970 出来', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      usageLine({ body: 'name: "", prompt_tokens: 10, completion_tokens: 1' }).replace(/^\S+/, '不是时间戳'),
      usageLine({ body: 'name: "", completion_tokens: 1, total_tokens: 1' }),
      usageLine({ prompt: 100, completion: 1, cacheRead: 0, total: 101 }),
    ])
    const { records, diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(records).toHaveLength(1)
    expect(records[0]!.time).toBeGreaterThan(0)
    // 只有第三行是**可用**的用量行；前两行都进 malformed（而不是既算成功又算畸形）
    expect(diagnostics.traeMalformedLines).toBe(2)
    expect(diagnostics.traeUsageLines).toBe(1)
  })

  test('四列全 0 的事件不入库（不是用量，不替上游编一笔）', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      usageLine({ prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 }),
    ])
    const { records, diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(records).toHaveLength(0)
    expect(diagnostics.traeZeroUsage).toBe(1)
    expect(diagnostics.usageEvents).toBe(0)
  })

  test('恒等式不符 / 缓存重叠都要能被看见（正常恒为 0）', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      usageLine({ prompt: 100, completion: 1, cacheRead: 0, total: 999 }),
      // 缓存读 > 未命中输入：input 夹 0 ⇒ 四列之和 = 0 + 1 + 50 = 51（与自报 total 一致）
      usageLine({ prompt: 10, completion: 1, cacheRead: 50, cacheWrite: 0, total: 51, time: '2025-12-02T07:47:00.000000+08:00' }),
    ])
    const { diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(diagnostics.traeIdentityViolations).toBe(1)
    expect(diagnostics.traeOverlapAnomalies).toBe(1)
  })

  test('整行被写两遍 ⇒ 只入一条并计数（本机实测 0 条，但形态必须挡住）', async () => {
    const home = join(dir, 'home')
    const line = usageLine({})
    writeLog(home, STAMP, AGENT, [line, noiseLine(), line])
    const { records, diagnostics } = await scanAllSources(traeSource.roots([home]))
    expect(records).toHaveLength(1)
    expect(diagnostics.traeDuplicateEvents).toBe(1)
  })

  test('增量喂入（按块 push，且从行中间切开）时不丢不重', () => {
    const meta = {
      source: 'trae' as const,
      sessionId: SESSION,
      cwd: null,
      createdAt: null,
      projectDir: `${STAMP}/Modular`,
      filePath: join(dir, 'nope.log'),
    }
    const diagnostics = emptyDiagnostics()
    const records: UsageRecord[] = []
    const folder = traeSource.createFolder(meta, diagnostics, records)
    const text = [noiseLine(), usageLine({}), usageLine({ time: '2025-12-02T07:47:00.000000+08:00' })].join('\n') + '\n'
    // 从第一条用量行中间切开（那一块没有换行结尾 ⇒ 必须留到下一块）
    folder.push(text.slice(0, 120))
    folder.push(text.slice(120))
    folder.finish()
    expect(records).toHaveLength(2)
    expect(diagnostics.traeFiles).toBe(1)
  })

  test('镜像的两个根（同一份日志复制两份）只算一次', async () => {
    const homeA = join(dir, 'home-a')
    const homeB = join(dir, 'home-b')
    const lines = [usageLine({}), usageLine({ time: '2025-12-02T07:47:00.000000+08:00' })]
    writeLog(homeA, STAMP, AGENT, lines)
    writeLog(homeB, STAMP, AGENT, lines)
    const { records } = await scanAllSources([...traeSource.roots([homeA]), ...traeSource.roots([homeB])])
    // 相对路径相同 ⇒ sessionId 相同 ⇒ event_id 相同 ⇒ 主键先到者胜
    expect(records).toHaveLength(2)
    expect(new Set(records.map((r) => r.eventId)).size).toBe(2)
  })

  test('未注册的来源必须报错（静默 0 条会与「没跑过 Trae」混为一谈）', () => {
    // 只有适配器真的注册了，`--source trae` / `--source trae-cn` 才可能解析出根
    expect(registeredSources().filter((a) => a.id.startsWith('trae')).map((a) => a.id)).toEqual(['trae', 'trae-cn'])
  })
})

describe('Trae：入库（与纯文本路径共用幂等语义）', () => {
  test('★ 库路径与直扫路径给出同一个总量；四列分开落库；重复入库不涨数', async () => {
    const home = join(dir, 'home')
    writeLog(home, STAMP, AGENT, [
      usageLine({ prompt: 10527, completion: 826, cacheRead: 9472, cacheWrite: 0, total: 11353 }),
      usageLine({ time: '2025-12-02T07:47:00.000000+08:00', prompt: 100, completion: 5, cacheRead: 40, cacheWrite: 2, total: 105 }),
    ])
    const roots = traeSource.roots([home])
    const scanned = await scanAllSources(roots)
    expect(scanned.records).toHaveLength(2)
    const scanTotal = scanned.records.reduce((sum, r) => sum + r.usage.total, 0)
    expect(scanTotal).toBe(11353 + 105)

    const dbPath = join(dir, 'usage.sqlite')
    const first = await ingestPlainSources({ roots, dbPath })
    expect(first.inserted).toBe(2)
    expect(first.duplicates).toBe(0)

    // 第二轮（热态）：字节数未变 ⇒ L1 整份跳过
    const second = await ingestPlainSources({ roots, dbPath })
    expect(second.inserted).toBe(0)
    expect(second.skippedUnchanged).toBe(1)

    const session = await openStats({ sessionsRoot: [], sourceRoots: roots, dbPath })
    try {
      expect(session.totals().total).toBe(scanTotal)
    } finally {
      session.close()
    }

    const db = openDatabaseForIngest(dbPath)
    try {
      const rows = db.query<{
        source: string; provider: string; model: string; cwd: string | null
        input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number
        reasoning_tokens: number
      }>('SELECT source, provider, model, cwd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM usage_event ORDER BY ts').all()
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        source: 'trae',
        provider: 'trae',
        model: '(unknown)',
        cwd: null,
        input_tokens: 1055,
        output_tokens: 826,
        cache_read_tokens: 9472,
        cache_write_tokens: 0,
        reasoning_tokens: 768,
      })
      expect(rows[1]).toMatchObject({ input_tokens: 58, cache_read_tokens: 40, cache_write_tokens: 2 })
    } finally {
      db.close()
    }
  })
})
