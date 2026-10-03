/**
 * **WorkBuddy 来源适配器**的计费语义测试（合成夹具，不碰真实 `~/.workbuddy`）。
 *
 * 这一组断言服务的命题有五条：
 *
 * > 1. **`prompt_tokens` 含缓存命中** ⇒ 必须减掉 `prompt_cache_hit_tokens`
 * >    （与 Codex / Trae 同、与 Claude Code 反）；
 * > 2. **缓存字段的取值顺序照抄上游**（`prompt_cache_hit_tokens` >
 * >    `cache_read_input_tokens` > `prompt_tokens_details.cached_tokens`）——
 * >    实测同一条记录里前者 48512、后者 0，顺序写反就把缓存读当成 0；
 * > 3. **用量挂在「响应的最后一行」上**，行类型不固定（实测 3/4 落在 `function_call`）
 * >    ⇒ 必须按字段认行、按 `messageId` 去重，写死 `message/assistant` 会漏 3/4；
 * > 4. **老代际没有缓存字段、并且只有时间戳为 0 的那一批**（迁移产物）⇒
 * >    `cacheRead` 记 0 但要计数，`timestamp = 0` 必须跳过而不是退化成 1970；
 * > 5. **幂等键 = `workbuddy:<相对路径>:<文件内序号>`**：镜像的两个根因此只算一次，
 * >    嵌套的子代理文件也天然各算各的。
 *
 * ⚠️ 所有夹具都写在临时目录里；`defaultWorkBuddyHome()` 的环境与家目录全部**注入**，
 *   所以断言不随跑测试的那台机器漂移（本机真的装了 WorkBuddy，
 *   忘掉隔离会让断言变成「随机器变化」而不是失败）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_WORKBUDDY_FOLDER,
  WORKBUDDY_CONFIG_DIR_ENV,
  WORKBUDDY_DATA_FOLDER_NAME_ENV,
  WORKBUDDY_DISABLED_ENV,
  WORKBUDDY_HOMES_ENV,
  WORKBUDDY_PROVIDER,
  defaultWorkBuddyHome,
  mapWorkBuddyUsage,
  parseWorkBuddyUsage,
  workbuddySessionIdOf,
  workbuddySource,
} from '../src/sources/workbuddy.js'
import { registeredSources, requireSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { scanAllSources } from '../src/scanner.js'
import { emptyDiagnostics, type UsageRecord } from '../src/types.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'
import { openDatabaseForIngest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-workbuddy-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const SESSION = 'd992a024-9766-414c-9847-185977f67f0b'
const PROJECT = 'c-Users-Administrator-WorkBuddy-2026-10-03-10-53-08'
const CWD = 'c:\\Users\\Administrator\\WorkBuddy\\2026-10-03-10-53-08'

/**
 * 新代际的一行（camelCase `usage` + `rawUsage`），默认值**照抄本机真实样本**
 * （prompt 51937 = 命中 48512 + 未命中 3425，total 52463）。
 */
function newGenLine(opts: {
  type?: string
  role?: string
  time?: number
  messageId?: string
  id?: string
  cwd?: string | null
  sessionId?: string
  model?: string | null
  prompt?: number
  completion?: number
  hit?: number
  miss?: number
  write?: number
  total?: number
  reasoning?: number
  /** 只写 camelCase 的 `usage`，不写 `rawUsage`（老宿主 / 另一种落盘形态）。 */
  noRaw?: boolean
} = {}): string {
  const prompt = opts.prompt ?? 51937
  const completion = opts.completion ?? 526
  const hit = opts.hit ?? 48512
  const miss = opts.miss ?? 3425
  const write = opts.write ?? 0
  const ev: Record<string, unknown> = {
    id: opts.id ?? '01a0ffae-7b61-7b0b-98c4-3e74718301c4',
    type: opts.type ?? 'function_call',
    timestamp: opts.time ?? 1790996024251,
    sessionId: opts.sessionId ?? SESSION,
    providerData: {
      messageId: opts.messageId ?? '01a0ffae7b617b0b98c43e73a1293b61',
      model: opts.model === undefined ? 'deepseek-v4.1-flash' : opts.model,
      usage: {
        requests: 1,
        inputTokens: prompt,
        outputTokens: completion,
        totalTokens: opts.total ?? prompt + completion,
        inputTokensDetails: [{ cached_tokens: hit }],
        outputTokensDetails: [{ reasoning_tokens: opts.reasoning ?? 214 }],
      },
    },
  }
  if (opts.role !== undefined) ev['role'] = opts.role
  if (opts.cwd !== undefined && opts.cwd !== null) ev['cwd'] = opts.cwd
  if (opts.noRaw !== true) {
    ;(ev['providerData'] as Record<string, unknown>)['rawUsage'] = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: opts.total ?? prompt + completion,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
      prompt_cache_write_tokens: write,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      prompt_tokens_details: { cached_tokens: hit },
      completion_tokens_details: { reasoning_tokens: opts.reasoning ?? 214 },
    }
  }
  return JSON.stringify(ev)
}

/** 老代际的一行（snake_case `usage`，没有缓存字段、没有 `rawUsage`）。 */
function oldGenLine(opts: {
  time?: number
  id?: string
  sessionId?: string
  model?: string | null
  prompt?: number
  completion?: number
  total?: number
} = {}): string {
  const prompt = opts.prompt ?? 26219
  const completion = opts.completion ?? 17
  return JSON.stringify({
    id: opts.id ?? '845c177f4e204291b4112bc1a8cf7615',
    type: 'message',
    role: 'assistant',
    timestamp: opts.time ?? 1775534024502,
    sessionId: opts.sessionId ?? SESSION,
    providerData: {
      model: opts.model === undefined ? 'auto' : opts.model,
      usage: { input_tokens: prompt, output_tokens: completion, total_tokens: opts.total ?? prompt + completion },
    },
  })
}

/** 一条与用量无关的行（真实日志里占绝大多数）。 */
function noiseLine(type = 'function_call_result'): string {
  return JSON.stringify({ id: 'deadbeefdeadbeefdeadbeefdeadbeef', type, timestamp: 1790996024251, sessionId: SESSION })
}

/** 造一个会话文件：`projects/<projectKey>/<name>.jsonl`，返回完整路径。 */
function writeSession(
  home: string,
  name: string,
  lines: readonly string[],
  options: { projectKey?: string; sidecar?: Record<string, unknown>; subdir?: string } = {},
): string {
  const target = join(home, 'projects', options.projectKey ?? PROJECT, options.subdir ?? '')
  mkdirSync(target, { recursive: true })
  const file = join(target, `${name}.jsonl`)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  if (options.sidecar !== undefined) {
    writeFileSync(join(target, `${name}.meta.json`), JSON.stringify(options.sidecar), 'utf8')
  }
  return file
}

describe('WorkBuddy：根解析与隔离开关', () => {
  test('缺省配置目录 = $WORKBUDDY_CONFIG_DIR > ~/$WORKBUDDY_DATA_FOLDER_NAME > ~/.workbuddy', () => {
    const home = join('C:', 'Users', 'someone')
    expect(defaultWorkBuddyHome({ env: {}, home })).toBe(join(home, DEFAULT_WORKBUDDY_FOLDER))
    expect(defaultWorkBuddyHome({ env: { [WORKBUDDY_DATA_FOLDER_NAME_ENV]: 'aima' }, home })).toBe(join(home, 'aima'))
    // 定制版 / 私有化部署会把配置目录指到别处（WorkBuddy 源码注释里明说），优先级最高
    expect(defaultWorkBuddyHome({
      env: { [WORKBUDDY_CONFIG_DIR_ENV]: 'D:\\wb', [WORKBUDDY_DATA_FOLDER_NAME_ENV]: 'aima' },
      home,
    })).toBe('D:\\wb')
    // 空白值必须当成「没给」，否则会得到一个空路径的根（永远 0 条，且不报错）
    expect(defaultWorkBuddyHome({ env: { [WORKBUDDY_CONFIG_DIR_ENV]: '  ' }, home })).toBe(join(home, DEFAULT_WORKBUDDY_FOLDER))
  })

  test('根 = <配置目录>/projects，且来源 id 是 workbuddy', () => {
    const roots = workbuddySource.roots(['/x'])
    expect(roots).toHaveLength(1)
    expect(roots[0]!.path).toBe(join('/x', 'projects'))
    expect(roots[0]!.source).toBe('workbuddy')
    // 计费日志在 projects/ 下；logs/ 是运行日志（一行用量都没有）
    expect(roots[0]!.path).not.toBe(join('/x', 'logs'))
  })

  test('多根环境变量真的被读到（不是「只在 --help 里存在」）', () => {
    const saved = process.env[WORKBUDDY_HOMES_ENV]
    process.env[WORKBUDDY_HOMES_ENV] = ['/a', '/b'].join(delimiter)
    try {
      expect(workbuddySource.roots([]).map((root) => root.path)).toEqual([join('/a', 'projects'), join('/b', 'projects')])
    } finally {
      if (saved === undefined) delete process.env[WORKBUDDY_HOMES_ENV]
      else process.env[WORKBUDDY_HOMES_ENV] = saved
    }
  })

  test('显式指定的根完全接管环境变量（`--workbuddy-home` 不该被环境变量叠加）', () => {
    const saved = process.env[WORKBUDDY_HOMES_ENV]
    process.env[WORKBUDDY_HOMES_ENV] = '/env'
    try {
      expect(workbuddySource.roots(['/explicit']).map((root) => root.path)).toEqual([join('/explicit', 'projects')])
    } finally {
      if (saved === undefined) delete process.env[WORKBUDDY_HOMES_ENV]
      else process.env[WORKBUDDY_HOMES_ENV] = saved
    }
  })

  test('开关关闭时来源进 disabled（要能说出「是关掉了」而不是「没数据」）', () => {
    const present = join(dir, 'home')
    mkdirSync(join(present, 'projects'), { recursive: true })
    const resolved = resolveSourceRoots({
      env: { [WORKBUDDY_DISABLED_ENV]: '0' },
      homes: { workbuddy: [present] },
    })
    expect(resolved.disabled).toContain('workbuddy')
    expect(requireSource('workbuddy').disableEnv).toBe(WORKBUDDY_DISABLED_ENV)
    expect(registeredSources().map((adapter) => adapter.id)).toContain('workbuddy')
  })

  test('存在的根与不存在的根分开报（「配了但不存在」与「本来就没有」是两件事）', () => {
    const present = join(dir, 'present')
    mkdirSync(join(present, 'projects'), { recursive: true })
    const resolved = resolveSourceRoots({ sources: ['workbuddy'], homes: { workbuddy: [present, join(dir, 'missing')] } })
    expect(resolved.roots.map((root) => root.path)).toEqual([join(present, 'projects')])
    expect(resolved.missing.map((root) => root.path)).toEqual([join(dir, 'missing', 'projects')])
  })
})

describe('WorkBuddy：列举（哪些文件算会话）', () => {
  test('只认 <sessionId>.jsonl：meta.json / file-rollback.ndjson / quickask / 0 字节都不算', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine()], {
      sidecar: { createdAt: 1790995988745, cwd: CWD },
    })
    // 这些都是真实存在过的邻居文件，任何一个被当成会话都会让「会话数」虚高
    const projectDir = join(home, 'projects', PROJECT)
    writeFileSync(join(projectDir, `${SESSION}.file-rollback.ndjson`), '{"a":1}\n', 'utf8')
    writeFileSync(join(projectDir, `${SESSION}.quickask`), '', 'utf8')
    writeFileSync(join(projectDir, 'empty.jsonl'), '', 'utf8')

    const metas = await workbuddySource.list(workbuddySource.roots([home])[0]!)
    expect(metas).toHaveLength(1)
    expect(metas[0]!.filePath.endsWith(`${SESSION}.jsonl`)).toBe(true)
  })

  test('会话 id = 相对根路径（镜像的两个根给出同一个 id ⇒ event_id 天然相同）', () => {
    const root = join('/x', 'projects')
    expect(workbuddySessionIdOf(root, join(root, PROJECT, `${SESSION}.jsonl`))).toBe(`${PROJECT}/${SESSION}`)
    // 嵌套（子代理）文件各算各的：路径里带着父会话 id
    expect(workbuddySessionIdOf(root, join(root, PROJECT, SESSION, 'subagents', 'task-1.jsonl')))
      .toBe(`${PROJECT}/${SESSION}/subagents/task-1`)
  })

  test('嵌套的子代理会话文件也要被列到（用量是独立的），并计入 workbuddyNestedSessionFiles', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine()])
    writeSession(home, 'task-1', [newGenLine({ messageId: 'child-1' })], { subdir: join(SESSION, 'subagents') })

    const metas = await workbuddySource.list(workbuddySource.roots([home])[0]!)
    expect(metas).toHaveLength(2)

    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(records).toHaveLength(2)
    expect(diagnostics.workbuddyFiles).toBe(2)
    expect(diagnostics.workbuddyNestedSessionFiles).toBe(1)
    expect(new Set(records.map((r) => r.sessionId)).size).toBe(2)
  })

  test('侧车 `.meta.json` 提供 cwd / createdAt（迁移过来的老会话在 JSONL 里一行 cwd 都没有）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [oldGenLine()], {
      sidecar: { createdAt: 1775533573048, cwd: 'c:\\Users\\Administrator\\WorkBuddy\\Claw' },
    })
    const meta = (await workbuddySource.list(workbuddySource.roots([home])[0]!))[0]!
    expect(meta.cwd).toBe('c:\\Users\\Administrator\\WorkBuddy\\Claw')
    expect(meta.createdAt).toBe(1775533573048)
  })

  test('没有侧车（新会话）也不该失败：归属退化成 null，由行里的顶层 cwd 接手', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine({ cwd: CWD })])
    const meta = (await workbuddySource.list(workbuddySource.roots([home])[0]!))[0]!
    expect(meta.cwd).toBeNull()
    const { records } = await scanAllSources(workbuddySource.roots([home]))
    expect(records[0]!.cwd).toBe(CWD)
  })
})

describe('WorkBuddy：四列映射（错了不会报错，只会数字悄悄不对）', () => {
  test('★ prompt_tokens 含缓存命中 ⇒ input 必须减掉，四列之和 == 上游 total_tokens', () => {
    const fields = parseWorkBuddyUsage(
      { inputTokens: 51937, outputTokens: 526, totalTokens: 52463, outputTokensDetails: [{ reasoning_tokens: 214 }] },
      { prompt_tokens: 51937, completion_tokens: 526, total_tokens: 52463, prompt_cache_hit_tokens: 48512, prompt_cache_miss_tokens: 3425 },
    )!
    const mapped = mapWorkBuddyUsage(fields)
    expect(mapped.counts.input).toBe(3425)          // = 51937 − 48512，**不是** 51937
    expect(mapped.counts.cacheRead).toBe(48512)
    expect(mapped.counts.output).toBe(526)
    expect(mapped.counts.total).toBe(52463)         // == 上游自报的 total_tokens
    expect(mapped.identityOk).toBe(true)
    expect(mapped.missMismatch).toBe(false)
    expect(mapped.hasCacheInfo).toBe(true)
    // reasoning 是 output 的子集，不进恒等式
    expect(mapped.counts.reasoning).toBe(214)
  })

  test('★ 缓存字段顺序：prompt_cache_hit_tokens 优先于恒为 0 的 cache_read_input_tokens', () => {
    const fields = parseWorkBuddyUsage(
      { inputTokens: 51937, outputTokens: 526 },
      {
        prompt_tokens: 51937,
        completion_tokens: 526,
        prompt_cache_hit_tokens: 48512,
        cache_read_input_tokens: 0,          // 实测这一项在新代际里恒为 0
        prompt_tokens_details: { cached_tokens: 48512 },
      },
    )!
    // 顺序写反 ⇒ cacheRead = 0、input = 51937：缓存与输入整块对调，页面上看着完全正常
    expect(fields.cacheReadTokens).toBe(48512)
    expect(mapWorkBuddyUsage(fields).counts.input).toBe(3425)
  })

  test('没有 rawUsage 时退到 camelCase 的 inputTokensDetails[0].cached_tokens', () => {
    const fields = parseWorkBuddyUsage(
      { inputTokens: 1000, outputTokens: 10, inputTokensDetails: [{ cached_tokens: 900 }] },
      null,
    )!
    expect(fields.cacheReadTokens).toBe(900)
    expect(mapWorkBuddyUsage(fields).counts.input).toBe(100)
  })

  test('★ 老代际没有缓存字段：cacheRead 记 0 但 hasCacheInfo 为假（命中率被低估要能被看见）', () => {
    const fields = parseWorkBuddyUsage({ input_tokens: 26219, output_tokens: 17, total_tokens: 26236 }, null)!
    expect(fields.cacheReadTokens).toBeNull()      // **null 而不是 0**：0 会假装「真的没有缓存」
    const mapped = mapWorkBuddyUsage(fields)
    expect(mapped.counts.cacheRead).toBe(0)
    expect(mapped.counts.input).toBe(26219)
    expect(mapped.hasCacheInfo).toBe(false)
    expect(mapped.identityOk).toBe(true)
  })

  test('缓存读 > prompt：夹 0（不出现负数）并报 overlap（这条前提被推翻）', () => {
    const fields = parseWorkBuddyUsage({ inputTokens: 10, outputTokens: 1 }, { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 50 })!
    const mapped = mapWorkBuddyUsage(fields)
    expect(mapped.counts.input).toBe(0)
    expect(mapped.overlap).toBe(true)
  })

  test('上游给了 miss 字段却对不上 ⇒ missMismatch（比恒等式更早发现语义翻转）', () => {
    const fields = parseWorkBuddyUsage(
      { inputTokens: 1000, outputTokens: 10 },
      { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 999 },
    )!
    expect(mapWorkBuddyUsage(fields).missMismatch).toBe(true)
  })

  test('上游没自报 total_tokens 时不做恒等式判定（不替上游编一个）', () => {
    const fields = parseWorkBuddyUsage({ inputTokens: 100, outputTokens: 5 }, null)!
    expect(fields.totalTokens).toBeNull()
    expect(mapWorkBuddyUsage(fields).identityOk).toBe(true)
  })

  test('数字全缺 ⇒ 解析不出（调用方计数，不用 0 兜底造出一笔假用量）', () => {
    expect(parseWorkBuddyUsage({ requests: 1 }, null)).toBeNull()
    expect(parseWorkBuddyUsage(null, null)).toBeNull()
  })
})

describe('WorkBuddy：折叠（谁带用量就认谁）', () => {
  test('★ 用量挂在 function_call 行上也要采到（实测 3/4 条是这种）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      JSON.stringify({ id: 'r1', type: 'reasoning', timestamp: 1790995997736, sessionId: SESSION, providerData: { messageId: 'm1', model: 'deepseek-v4.1-flash' } }),
      newGenLine({ type: 'function_call', messageId: 'm1', id: 'f1' }),
      noiseLine(),
      newGenLine({ type: 'message', role: 'assistant', messageId: 'm2', id: 'f2', time: 1790996024000 }),
    ])
    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.model)).toEqual(['deepseek-v4.1-flash', 'deepseek-v4.1-flash'])
    expect(diagnostics.workbuddyUsageLines).toBe(2)
    expect(diagnostics.workbuddyFiles).toBe(1)
    expect(diagnostics.usageEvents).toBe(2)
  })

  test('同一个 messageId 写了两次 ⇒ 只入一条并计数（去重到底有没有生效的唯一信号）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      newGenLine({ messageId: 'm1', id: 'f1' }),
      newGenLine({ messageId: 'm1', id: 'f2', time: 1790996025000 }),
    ])
    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(records).toHaveLength(1)
    expect(diagnostics.workbuddyDuplicateResponses).toBe(1)
  })

  test('★ timestamp = 0 / 缺失 ⇒ 跳过并计数，绝不退化成 1970', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      oldGenLine({ time: 0, id: 'z1' }),
      JSON.stringify({
        id: 'z2', type: 'message', role: 'assistant', sessionId: SESSION,
        providerData: { model: 'auto', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      }),
      oldGenLine({ time: 1775534024502, id: 'z3' }),
    ])
    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    // 两条坏时间戳被挡下；真实那一条照常入
    expect(records).toHaveLength(1)
    expect(records[0]!.time).toBe(1775534024502)
    expect(records[0]!.time).toBeGreaterThan(0)
    expect(diagnostics.workbuddyInvalidTimestamps).toBe(2)
  })

  test('零用量 ⇒ 不替上游入库，但计数', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine({ prompt: 0, completion: 0, hit: 0, miss: 0, total: 0 })])
    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(records).toHaveLength(0)
    expect(diagnostics.workbuddyZeroUsage).toBe(1)
    expect(diagnostics.usageEvents).toBe(0)
  })

  test('恒等式不符 / 老代际缺缓存 都要能被看见（正常为 0 / 6）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      newGenLine({ messageId: 'm1', id: 'f1', prompt: 100, completion: 1, hit: 0, miss: 0, total: 999 }),
      oldGenLine({ id: 'a1' }),
    ])
    const { diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(diagnostics.workbuddyIdentityViolations).toBe(1)
    expect(diagnostics.workbuddyOverlapAnomalies).toBe(0)
    expect(diagnostics.workbuddyUsageWithoutCache).toBe(1)
  })

  test('缺模型名 ⇒ 落 (unknown) 并计数；`auto` 是上游真实取值，照原样记', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      newGenLine({ messageId: 'm1', id: 'f1', model: null }),
      oldGenLine({ id: 'a1' }),
    ])
    const { records, diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(records.map((r) => r.model)).toEqual(['(unknown)', 'auto'])
    expect(diagnostics.workbuddyMissingModel).toBe(1)
    // 两代都记 workbuddy：日志里根本没有 provider 字段，不许拿模型名猜厂商
    expect(records.every((r) => r.provider === WORKBUDDY_PROVIDER)).toBe(true)
  })

  test('信封 sessionId 与文件名不符要能看见（顶层文件）；嵌套文件不判定', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine({ sessionId: 'another-session-id' })])
    writeSession(home, 'task-1', [newGenLine({ sessionId: 'whatever' })], { subdir: join(SESSION, 'subagents') })
    const { diagnostics } = await scanAllSources(workbuddySource.roots([home]))
    expect(diagnostics.workbuddyMetaMismatch).toBe(1)
  })

  test('行里的顶层 cwd 覆盖侧车并写回 meta（增量路径靠它跨轮继承）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine({ cwd: 'd:\\other' })], { sidecar: { cwd: 'c:\\from-sidecar' } })
    const roots = workbuddySource.roots([home])
    const { records, sessions } = await scanAllSources(roots)
    expect(records[0]!.cwd).toBe('d:\\other')
    expect(sessions[0]!.cwd).toBe('d:\\other')
  })

  test('增量喂入（按块 push、从行中间切开）时不丢不重，末尾半行由 finish 处理', () => {
    const meta = {
      source: 'workbuddy' as const,
      sessionId: `${PROJECT}/${SESSION}`,
      cwd: null,
      createdAt: null,
      projectDir: PROJECT,
      filePath: join(dir, 'nope.jsonl'),
    }
    const diagnostics = emptyDiagnostics()
    const records: UsageRecord[] = []
    const folder = workbuddySource.createFolder(meta, diagnostics, records)
    const text = [newGenLine({ messageId: 'm1', id: 'f1' }), newGenLine({ messageId: 'm2', id: 'f2' })].join('\n') + '\n'
    folder.push(text.slice(0, 140))
    folder.push(text.slice(140))
    folder.finish()
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.seq)).toEqual([0, 1])
    expect(diagnostics.workbuddyFiles).toBe(1)
  })

  test('幂等键 = workbuddy:<相对路径>:<文件内序号>（DSH 那条无前缀的规则一个字都不动）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine({ messageId: 'm1', id: 'f1' }), newGenLine({ messageId: 'm2', id: 'f2' })])
    const { records } = await scanAllSources(workbuddySource.roots([home]))
    expect(records.map((r) => r.eventId)).toEqual([
      `workbuddy:${PROJECT}/${SESSION}:0`,
      `workbuddy:${PROJECT}/${SESSION}:1`,
    ])
    expect(records.map((r) => r.source)).toEqual(['workbuddy', 'workbuddy'])
  })

  test('镜像的两个根（同一份日志复制两份）只算一次', async () => {
    const homeA = join(dir, 'home-a')
    const homeB = join(dir, 'home-b')
    const lines = [newGenLine({ messageId: 'm1', id: 'f1' }), newGenLine({ messageId: 'm2', id: 'f2' })]
    writeSession(homeA, SESSION, lines)
    writeSession(homeB, SESSION, lines)
    const { records } = await scanAllSources([...workbuddySource.roots([homeA]), ...workbuddySource.roots([homeB])])
    // 相对路径相同 ⇒ sessionId 相同 ⇒ event_id 相同 ⇒ 主键先到者胜
    expect(records).toHaveLength(2)
    expect(new Set(records.map((r) => r.eventId)).size).toBe(2)
  })

  test('巡检按自己的文件形态数（拿 DSH 的三层结构去数这里会得到 0/0）', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [newGenLine()])
    writeSession(home, 'other', [newGenLine({ messageId: 'x' })], { projectKey: 'C-Users-Administrator-WorkBuddy-Claw' })
    // `inspect` 在适配器接口上是**可选**的（将来的来源可以不提供巡检），
    // 所以调用点要自己断言它存在 —— 本来源实现了它，用 `!` 表达这一点。
    const info = await workbuddySource.inspect!(workbuddySource.roots([home])[0]!)
    expect(info.sessions).toBe(2)
    expect(info.files).toBe(2)
    expect(info.latestMs).toBeGreaterThan(0)
    // 不存在的根：0/0 且不抛错
    expect(await workbuddySource.inspect!({ path: join(dir, 'nope'), source: 'workbuddy' })).toEqual({
      sessions: 0, files: 0, latestMs: null,
    })
  })
})

describe('WorkBuddy：入库（与其它纯文本来源共用幂等语义）', () => {
  test('★ 库路径与直扫路径给出同一个总量；四列分开落库；重复入库不涨数', async () => {
    const home = join(dir, 'home')
    writeSession(home, SESSION, [
      newGenLine({ messageId: 'm1', id: 'f1' }),
      oldGenLine({ id: 'a1' }),
    ])
    const roots = workbuddySource.roots([home])
    const scanned = await scanAllSources(roots)
    expect(scanned.records).toHaveLength(2)
    const scanTotal = scanned.records.reduce((sum, r) => sum + r.usage.total, 0)
    expect(scanTotal).toBe(52463 + 26236)

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
        source: 'workbuddy',
        provider: WORKBUDDY_PROVIDER,
        model: 'auto',
        input_tokens: 26219,
        output_tokens: 17,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      })
      expect(rows[1]).toMatchObject({
        model: 'deepseek-v4.1-flash',
        input_tokens: 3425,
        output_tokens: 526,
        cache_read_tokens: 48512,
        reasoning_tokens: 214,
      })
    } finally {
      db.close()
    }
  })
})
