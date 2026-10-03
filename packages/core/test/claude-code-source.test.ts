/**
 * **Claude Code 来源适配器**的计费语义测试（合成夹具，不碰真实 `~/.claude`）。
 *
 * 这一组断言服务的命题只有一条：
 *
 * > **一次 API 调用只算一次**，而 Claude Code 的日志里同一次调用会被写成多行。
 *
 * 本机 9 个真实文件实测：1,114 条计费行只对应 551 次调用（重复 563 条），
 * 而**朴素逐行相加正好翻倍**（总量 63,842,793 会被算成 126,348,873）。
 * 重复行还不保证相邻（实测最大间隔 21 行）—— 所以「跳过连续重复」在这里是错的。
 * 本文件的夹具刻意复刻这个形态（重复行之间夹着别的行）。
 *
 * ⚠️ 所有夹具都写在临时目录里，`resolveSourceRoots` 的 `exists` 也按需注入：
 *   `~/.claude/projects` 在本机**真的有** 21 MB 真实会话，任何忘了隔离的断言
 *   都会变成「随机器漂移」而不是失败。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_DISABLED_ENV,
  CLAUDE_HOMES_ENV,
  CLAUDE_PROVIDER,
  claudeCodeSource,
  claudeSessionIdFromName,
  defaultClaudeHome,
  mapClaudeUsage,
} from '../src/sources/claude-code.js'
import { registeredSources, requireSource } from '../src/sources/registry.js'
import { resolveSourceRoots } from '../src/sources/roots.js'
import { scanAllSources } from '../src/scanner.js'
import { emptyDiagnostics, type UsageRecord } from '../src/types.js'
import { ingestPlainSources } from '../src/db/ingest-plain.js'
import { openDatabaseForIngest } from '../src/db/ingest.js'
import { openStats } from '../src/db/stats.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atr-claude-code-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 一个 assistant 行（字段与真实日志同形，只去掉与本测试无关的部分）。 */
function assistantRow(opts: {
  sessionId: string
  messageId: string
  uuid: string
  timestamp?: string
  model?: string | null
  cwd?: string
  usage?: Record<string, unknown> | null
  isSidechain?: boolean
}): string {
  const usage = opts.usage === undefined
    ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 3 }
    : opts.usage
  const message: Record<string, unknown> = {
    id: opts.messageId,
    type: 'message',
    role: 'assistant',
    model: opts.model === undefined ? 'claude-opus-4-8' : opts.model,
  }
  if (usage !== null) message['usage'] = usage
  return JSON.stringify({
    parentUuid: null,
    isSidechain: opts.isSidechain ?? false,
    type: 'assistant',
    message,
    uuid: opts.uuid,
    timestamp: opts.timestamp ?? '2026-06-12T15:45:54.454Z',
    sessionId: opts.sessionId,
    cwd: opts.cwd ?? 'D:\\Coding_agent\\demo',
    version: '2.1.187',
  })
}

/** 一个非计费行（真实日志里占比最大的就是这些：attachment / user / system / last-prompt）。 */
function noiseRow(type: string): string {
  return JSON.stringify({ type, uuid: `noise-${Math.random()}`, timestamp: '2026-06-12T15:45:54.000Z' })
}

/**
 * 造一个「一个 home + 若干会话文件」的夹具。
 *
 * 目录形状与真实日志一致：`<home>/projects/<项目目录名>/<uuid>.jsonl`。
 */
function writeProject(
  home: string,
  project: string,
  name: string,
  lines: readonly string[],
): string {
  const target = join(home, 'projects', project)
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
  return file
}

const SESSION_A = '1bbad279-2723-47f9-b98b-8f5ae2aed32f'
const SESSION_B = '55cccf67-3fd0-4d09-b1b3-cd3ea5d7b8b3'
const PROJECT = 'D--Coding-agent-demo'

/** 每行 105 token（10 + 2 + 90 + 3），与真实四列口径同形。 */
const PER_CALL = 105

describe('Claude Code：日志根解析', () => {
  test('默认根是 <home>/projects，home 取 $CLAUDE_CONFIG_DIR > ~/.claude', () => {
    const roots = claudeCodeSource.roots([])
    expect(roots).toHaveLength(1)
    expect(roots[0]!.source).toBe('claude-code')
    expect(roots[0]!.path).toBe(join(defaultClaudeHome(), 'projects'))
  })

  test('显式 home 完全接管（不再读环境变量）', () => {
    const explicit = join(dir, 'explicit')
    const roots = claudeCodeSource.roots([explicit])
    expect(roots.map((r) => r.path)).toEqual([join(explicit, 'projects')])
  })

  test('adapter 已注册，且是纯文本来源（走 ingest-plain 那条路）', () => {
    expect(registeredSources().map((a) => a.id)).toContain('claude-code')
    expect(requireSource('claude-code').encoding).toBe('plain-jsonl')
    expect(requireSource('claude-code').disableEnv).toBe(CLAUDE_DISABLED_ENV)
  })

  test('resolveSourceRoots：环境变量给出的 home 生效，且不存在的根逐项报出', () => {
    const present = join(dir, 'present')
    const missing = join(dir, 'missing')
    mkdirSync(join(present, 'projects'), { recursive: true })
    const resolved = resolveSourceRoots({
      sources: ['claude-code'],
      homes: { 'claude-code': [present, missing] },
      env: {},
      exists: (p) => p.startsWith(present),
    })
    expect(resolved.roots.map((r) => r.path)).toEqual([join(present, 'projects')])
    expect(resolved.missing.map((r) => r.path)).toEqual([join(missing, 'projects')])
    expect(resolved.disabled).toEqual([])
  })

  test('环境开关关掉来源时进 disabled（而不是静默 0 条）', () => {
    const resolved = resolveSourceRoots({
      env: { [CLAUDE_DISABLED_ENV]: '0' },
      exists: () => false,
    })
    expect(resolved.disabled).toContain('claude-code')
  })

  test('环境变量名与默认 home 是约定值（公告契约，不能悄悄改）', () => {
    expect(CLAUDE_CONFIG_DIR_ENV).toBe('CLAUDE_CONFIG_DIR')
    expect(CLAUDE_HOMES_ENV).toBe('DSH_TOKEN_REPORT_CLAUDE_HOMES')
    expect(CLAUDE_DISABLED_ENV).toBe('DSH_TOKEN_REPORT_CLAUDE')
  })
})

describe('Claude Code：会话文件名', () => {
  test('只认 <uuid>.jsonl', () => {
    expect(claudeSessionIdFromName(`${SESSION_A}.jsonl`)).toBe(SESSION_A)
    expect(claudeSessionIdFromName(`${SESSION_A.toUpperCase()}.jsonl`)).toBe(SESSION_A)
  })

  test('🚨 子代理转写与控制文件都不是会话文件（猜一个 id 会让它们混进真实会话）', () => {
    expect(claudeSessionIdFromName('agent-a1b2c3d4.jsonl')).toBeNull()
    expect(claudeSessionIdFromName('journal.jsonl')).toBeNull()
    expect(claudeSessionIdFromName(`${SESSION_A}.jsonl.bak`)).toBeNull()
    expect(claudeSessionIdFromName('not-a-uuid.jsonl')).toBeNull()
  })
})

describe('Claude Code：四列映射', () => {
  test('四列与上游字段一一对应，input 不做减法（Claude Code 的 input 已是未命中部分）', () => {
    const { counts, identityOk } = mapClaudeUsage({
      input_tokens: 16166,
      output_tokens: 301,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 26795,
    })
    expect(counts.input).toBe(16166)
    expect(counts.output).toBe(301)
    expect(counts.cacheRead).toBe(0)
    expect(counts.cacheWrite).toBe(26795)
    expect(counts.total).toBe(43262)
    expect(counts.calls).toBe(1)
    expect(identityOk).toBe(true)
  })

  test('缓存写入的 1h/5m 分档**不单独成列**（它们是定价分档，不是另一类用量）', () => {
    const { counts } = mapClaudeUsage({
      input_tokens: 2,
      output_tokens: 523,
      cache_read_input_tokens: 199527,
      cache_creation_input_tokens: 414,
      cache_creation: { ephemeral_1h_input_tokens: 414, ephemeral_5m_input_tokens: 0 },
    })
    // 分档之和 414 == cache_creation_input_tokens：四列口径不受它影响
    expect(counts.cacheWrite).toBe(414)
    expect(counts.total).toBe(2 + 523 + 199527 + 414)
  })

  test('缺字段按 0 处理，不抛错', () => {
    const { counts } = mapClaudeUsage({})
    expect(counts.total).toBe(0)
  })

  test('上游自报 total_tokens 且对不上时 identityOk=false（当前该字段不存在，故只在夹具里验）', () => {
    expect(mapClaudeUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }).identityOk).toBe(true)
    expect(mapClaudeUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 3 }).identityOk).toBe(false)
    // 没有自报 ⇒ 不假装对过了
    expect(mapClaudeUsage({ input_tokens: 1, output_tokens: 1 }).identityOk).toBe(true)
  })
})

describe('Claude Code：列举', () => {
  test('列出每个会话文件；子代理转写、控制文件、0 字节文件都不算', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [assistantRow({
      sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1',
    })])
    writeProject(home, PROJECT, `${SESSION_B}.jsonl`, [assistantRow({
      sessionId: SESSION_B, messageId: 'msg_b', uuid: 'u2',
    })])
    // 子代理：与父会话**共用 sessionId**，但文件名不是 uuid
    writeProject(home, PROJECT, 'agent-abc123.jsonl', [assistantRow({
      sessionId: SESSION_A, messageId: 'msg_sub', uuid: 'u3',
    })])
    // 工作流控制文件
    writeProject(home, PROJECT, 'journal.jsonl', [noiseRow('system')])
    // 0 字节（会话刚创建）
    writeProject(home, PROJECT, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl', [])
    // 非 jsonl（memory/*.md）
    mkdirSync(join(home, 'projects', PROJECT, 'memory'), { recursive: true })
    writeFileSync(join(home, 'projects', PROJECT, 'memory', 'MEMORY.md'), '# 记忆', 'utf8')

    const root = claudeCodeSource.roots([home])[0]!
    const metas = await claudeCodeSource.list(root)
    expect(metas.map((m) => m.sessionId).sort()).toEqual([SESSION_A, SESSION_B].sort())
    expect(metas.every((m) => m.source === 'claude-code')).toBe(true)
    expect(metas.every((m) => m.projectDir === PROJECT)).toBe(true)

    const info = await claudeCodeSource.inspect!(root)
    expect(info).toMatchObject({ sessions: 2, files: 2 })
    expect(info.latestMs).toBeGreaterThan(0)
  })

  test('🚨 根也可以直接是**一个 jsonl 文件**（readdir 对文件抛 ENOTDIR 被吞 = 静默 0 条）', async () => {
    const home = join(dir, 'home')
    const file = writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u2' }),
    ])
    const metas = await claudeCodeSource.list({ path: file, source: 'claude-code' })
    expect(metas).toHaveLength(1)
    expect(metas[0]!.sessionId).toBe(SESSION_A)

    const { records } = await scanAllSources([{ path: file, source: 'claude-code' }])
    expect(records).toHaveLength(1)
    expect(records[0]!.eventId).toBe(`claude-code:${SESSION_A}:msg_a`)
  })
})

describe('Claude Code：折叠与去重', () => {
  test('🚨 同一次调用的多行只算一次 —— 重复行之间夹着别的行也必须去重', async () => {
    const home = join(dir, 'home')
    // 真实的形态：msg_demo 的四行被别的行隔开（本机实测最大间隔 21 行）
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_demo', uuid: 'u1' }),
      noiseRow('attachment'),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_demo', uuid: 'u2' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_other', uuid: 'u3' }),
      noiseRow('user'),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_demo', uuid: 'u4' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_demo', uuid: 'u5' }),
    ])

    const { records, diagnostics } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records).toHaveLength(2)
    expect(records.reduce((sum, r) => sum + r.usage.total, 0)).toBe(2 * PER_CALL)
    expect(new Set(records.map((r) => r.eventId))).toEqual(new Set([
      `claude-code:${SESSION_A}:msg_demo`,
      `claude-code:${SESSION_A}:msg_other`,
    ]))
    expect(diagnostics.claudeDuplicateWrites).toBe(3)
    expect(diagnostics.claudeFiles).toBe(1)
    expect(diagnostics.usageEvents).toBe(2)
  })

  test('幂等键的主体是 message.id 而不是 uuid（同一次调用的 uuid 每行都不同）', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_x', uuid: 'uuid-one' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_x', uuid: 'uuid-two' }),
    ])
    const { records } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records).toHaveLength(1)
    // 用 uuid 做键会得到两条（= 双重计费），这里是唯一能抓住它的断言
    expect(records[0]!.eventId).toBe(`claude-code:${SESSION_A}:msg_x`)
    expect(records[0]!.seq).toBe(0)
  })

  test('同一会话出现在两个 home（镜像 / 备份）时，同 id 的调用只入一次（主键去重）', async () => {
    const homeA = join(dir, 'home-a')
    const homeB = join(dir, 'home-b')
    const line = assistantRow({ sessionId: SESSION_A, messageId: 'msg_shared', uuid: 'u1' })
    writeProject(homeA, PROJECT, `${SESSION_A}.jsonl`, [line])
    // B 是 A 的镜像，并且多出一次新的调用
    writeProject(homeB, PROJECT, `${SESSION_A}.jsonl`, [line, assistantRow({
      sessionId: SESSION_A, messageId: 'msg_only_b', uuid: 'u2',
    })])

    const { records } = await scanAllSources(claudeCodeSource.roots([homeA, homeB]))
    // 事件级去重：两处同 id 的那一次只算一次（会话内 event_id 相同 ⇒ 主键先到者胜）
    expect(records.map((r) => r.eventId).sort()).toEqual([
      `claude-code:${SESSION_A}:msg_only_b`,
      `claude-code:${SESSION_A}:msg_shared`,
    ])
    expect(records.reduce((sum, r) => sum + r.usage.total, 0)).toBe(2 * PER_CALL)
  })

  test('🚨 会话身份取自**文件名**：信封里的 sessionId 不一致时不静默合并（与 Codex 同一条教训）', async () => {
    const home = join(dir, 'home')
    // 文件名是 SESSION_A，但行里写的是 SESSION_B（续写 / 分叉会话的实测形态）
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_B, messageId: 'msg_a', uuid: 'u1' }),
    ])
    const { records } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records[0]!.sessionId).toBe(SESSION_A)
    expect(records[0]!.eventId).toBe(`claude-code:${SESSION_A}:msg_a`)
  })

  test('`<synthetic>` 与没有 usage 的 assistant 行不计费，但被计数', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_syn', uuid: 'u1', model: '<synthetic>', usage: null }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_nousage', uuid: 'u2', usage: null }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_ok', uuid: 'u3' }),
    ])
    const { records, diagnostics } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records).toHaveLength(1)
    expect(diagnostics.claudeSyntheticRows).toBe(1)
    expect(diagnostics.claudeAssistantWithoutUsage).toBe(1)
  })

  test('四列全 0 的行不入库（不是用量，不替上游编一笔）', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({
        sessionId: SESSION_A, messageId: 'msg_zero', uuid: 'u1',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    ])
    const { records, diagnostics } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records).toHaveLength(0)
    expect(diagnostics.claudeZeroUsage).toBe(1)
  })

  test('provider 恒为 anthropic（单价按 provider/model 精确匹配，留空等于这一源永远配不上价）', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1', model: 'claude-sonnet-4-6' }),
    ])
    const { records } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records[0]!.provider).toBe(CLAUDE_PROVIDER)
    expect(records[0]!.model).toBe('claude-sonnet-4-6')
  })

  test('cwd 从行里取，用于项目归属', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1', cwd: 'D:\\Coding_agent\\proj' }),
    ])
    const { records } = await scanAllSources(claudeCodeSource.roots([home]))
    expect(records[0]!.cwd).toBe('D:\\Coding_agent\\proj')
  })

  test('增量喂入（按块 push）时跨块的重复行同样被吸收', () => {
    const meta = {
      source: 'claude-code' as const,
      sessionId: SESSION_A,
      cwd: null,
      createdAt: null,
      projectDir: PROJECT,
      filePath: join(dir, 'nope.jsonl'),
    }
    const diagnostics = emptyDiagnostics()
    const records: UsageRecord[] = []
    const folder = claudeCodeSource.createFolder(meta, diagnostics, records)
    const lines = [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_c', uuid: 'u1' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_c', uuid: 'u2' }),
    ]
    const text = lines.join('\n') + '\n'
    // 从行中间切开：第一块以 half-line 结尾（没有换行）⇒ 必须留到下一块再解析。
    folder.push(text.slice(0, 60))
    folder.push(text.slice(60))
    folder.finish()
    expect(records).toHaveLength(1)
    expect(diagnostics.claudeDuplicateWrites).toBe(1)
  })
})

describe('Claude Code：入库（与纯文本路径共用幂等语义）', () => {
  test('★ 库路径与直扫路径给出同一个总量；重复入库不涨数', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u2' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_b', uuid: 'u3' }),
    ])
    const roots = claudeCodeSource.roots([home])
    const scanned = await scanAllSources(roots)
    expect(scanned.records).toHaveLength(2)

    const dbPath = join(dir, 'usage.sqlite')
    const first = await ingestPlainSources({ roots, dbPath })
    expect(first.inserted).toBe(2)
    expect(first.duplicates).toBe(0)

    // 第二轮（热态）：字节数未变 ⇒ L1 整份跳过
    const second = await ingestPlainSources({ roots, dbPath })
    expect(second.inserted).toBe(0)
    expect(second.skippedUnchanged).toBe(1)

    // 追加一次新调用 ⇒ 整份重解析，新记录入库、老记录被主键吸收
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u2' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_b', uuid: 'u3' }),
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_c', uuid: 'u4' }),
    ])
    const third = await ingestPlainSources({ roots, dbPath })
    expect(third.inserted).toBe(1)
    expect(third.duplicates).toBe(2)

    // 库里总量与直扫完全一致（这是「库是日志的派生物」的落点）
    const session = await openStats({ sessionsRoot: [], sourceRoots: roots, dbPath })
    try {
      const fresh = await scanAllSources(roots)
      expect(session.totals().total).toBe(fresh.records.reduce((sum, r) => sum + r.usage.total, 0))
      expect(session.totals().total).toBe(3 * PER_CALL)
    } finally {
      session.close()
    }
  })

  test('原始列按四列分别落库（采集端合并后再也拆不开）', async () => {
    const home = join(dir, 'home')
    writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1' }),
    ])
    const roots = claudeCodeSource.roots([home])
    const dbPath = join(dir, 'usage.sqlite')
    await ingestPlainSources({ roots, dbPath })

    const db = openDatabaseForIngest(dbPath)
    try {
      const row = db.query<{
        source: string; input_tokens: number; output_tokens: number
        cache_read_tokens: number; cache_write_tokens: number; provider: string; model: string
      }>('SELECT source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, provider, model FROM usage_event').get()
      expect(row).toMatchObject({
        source: 'claude-code',
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 90,
        cache_write_tokens: 3,
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      })
    } finally {
      db.close()
    }
  })
})

describe('Claude Code：与真实夹具的一致性（读文件本身）', () => {
  test('夹具行 JSON 可被解析（防止夹具本身写坏导致上面全绿而毫无意义）', () => {
    const home = join(dir, 'home')
    const file = writeProject(home, PROJECT, `${SESSION_A}.jsonl`, [
      assistantRow({ sessionId: SESSION_A, messageId: 'msg_a', uuid: 'u1' }),
    ])
    const parsed = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>
    expect(parsed['type']).toBe('assistant')
    expect((parsed['message'] as Record<string, unknown>)['usage']).toBeDefined()
  })
})
