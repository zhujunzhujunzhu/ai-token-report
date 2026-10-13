/**
 * 本机项目名称别名（`<数据目录>/project-aliases.txt`）测试。
 *
 * ## 这些断言在守什么
 *
 * 1. **解析器整份拒绝** —— 任何一行非法就一条都不生效（半份规则会让一部分项目名
 *    「看着正常」、另一部分没折，而页面上没有报错）；
 * 2. **匹配语义与看板同源** —— 仓库名 / 路径前缀双模、路径边界、未命中回落
 *    `projectName()`（这套语义只在 `project-alias.ts` 实现一次）；
 * 3. ★ **三条取数路径同源** —— SQL（含汇总表 `rollup`）与直扫对同一份日志必须
 *    给出**同一组项目名**。漏掉任何一条都会变成「页面上的项目名有时折、有时不折」；
 * 4. ★ **金额桶与 token 行对齐** —— 两边必须用同一个解析器（`session.projectNameOf`），
 *    否则页面上表现为费用列凭空缺几行；
 * 5. **只改显示** —— 别名不改变总量、不改变上报用的 `cwd`。
 *
 *   bun test packages/core
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  MAX_PROJECT_ALIAS_RULES,
  formatProjectAliasErrors,
  loadLocalProjectAliases,
  parseProjectAliasText,
  projectAliasFileIn,
  writeLocalProjectAliases,
  type LocalProjectAliasRule,
} from '../src/db/local-project-alias.js'
import { projectResolverFromRules } from '../src/db/project-alias.js'
import { aggregate, crossTabRanked, projectName } from '../src/aggregate.js'
import {
  costByGroupOf,
  ingest,
  openStats,
  priceResolver,
  queryGroups,
  openDatabaseForIngest,
} from '../src/db/index.js'
import type { UsageRecord } from '../src/types.js'

// ── 脚手架 ───────────────────────────────────────────────────────────────

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atr-local-alias-'))
})

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

/** 解析成功时的规则（失败时直接让测试炸掉，而不是 `{}` 静默通过）。 */
function rulesOf(text: string): LocalProjectAliasRule[] {
  const parsed = parseProjectAliasText(text)
  assert.equal(parsed.ok, true, `期望解析成功，实际：${JSON.stringify(parsed)}`)
  return parsed.ok ? parsed.rules : []
}

/** 解析失败时的原因列表。 */
function errorsOf(text: string): string[] {
  const parsed = parseProjectAliasText(text)
  assert.equal(parsed.ok, false, '期望解析失败，实际却成功了')
  return parsed.ok ? [] : parsed.errors.map((error) => error.reason)
}

// ── 文本解析 ─────────────────────────────────────────────────────────────

describe('parseProjectAliasText：格式与容错', () => {
  test('一行一条：项目名 = 匹配值, 匹配值（逗号可多个）', () => {
    const rules = rulesOf('presales-kb-parent = D:\\Coding\\my-project, presales-kb-parent\n')
    assert.deepEqual(rules, [
      { prefix: 'D:\\Coding\\my-project', alias: 'presales-kb-parent' },
      { prefix: 'presales-kb-parent', alias: 'presales-kb-parent' },
    ])
  })

  test('注释行与空行不是错误（人们需要在自己的配置里写说明）', () => {
    const rules = rulesOf('# 说明\n\nai-token-report = ai-token-report\n   \n')
    assert.deepEqual(rules, [{ prefix: 'ai-token-report', alias: 'ai-token-report' }])
  })

  test('容忍全角等号与全角逗号', () => {
    const rules = rulesOf('客户A＝D:\\a\\proj-a，proj-a\n')
    assert.deepEqual(rules, [
      { prefix: 'D:\\a\\proj-a', alias: '客户A' },
      { prefix: 'proj-a', alias: '客户A' },
    ])
  })

  test('方括号只是粘贴形态：`[ a, b ]` 与 `a, b` 同一件事', () => {
    const rules = rulesOf('presales-kb-parent = [ D:\\Coding\\my-project , presales-kb-parent ]\n')
    assert.deepEqual(rules.map((rule) => rule.prefix), ['D:\\Coding\\my-project', 'presales-kb-parent'])
  })

  test('尾部路径分隔符在解析时就归一化（否则这条规则永远不命中）', () => {
    assert.deepEqual(rulesOf('p = D:\\a\\proj\\\n'), [{ prefix: 'D:\\a\\proj', alias: 'p' }])
    // POSIX 的 `/` 是根：它必须保留，否则会变成「匹配一切」的空前缀
    assert.deepEqual(errorsOf('p = /\n'), ['匹配值不能是文件系统根目录（它会匹配所有路径）'])
  })
})

describe('parseProjectAliasText：整份拒绝', () => {
  test('同一份里的问题一次全报出来（只报第一处会让人来回改好几轮）', () => {
    const errors = errorsOf('a = D:\n这一行忘了等号\n')
    assert.equal(errors.length, 2)
    assert.match(errors[0]!, /仓库名不能是盘符/)
    assert.match(errors[1]!, /缺少 =/)
  })

  test('空显示名 / 空匹配值 / 未闭合的方括号都拒绝', () => {
    assert.match(errorsOf(' = D:\\a\\proj\n')[0]!, /归一化名不能为空/)
    assert.match(errorsOf('p = \n')[0]!, /至少要有一个路径或仓库名/)
    assert.match(errorsOf('p = [ D:\\a\\proj\n')[0]!, /方括号没有闭合/)
    assert.match(errorsOf('p = D:\\a\\proj ]\n')[0]!, /方括号没有闭合/)
  })

  test('裸盘符被拒（`D:` 会命中该盘下每一个目录）', () => {
    assert.match(errorsOf('p = D:\n')[0]!, /仓库名不能是盘符/)
    // `D:\\` 含分隔符 ⇒ 是真实的路径边界，放行
    assert.deepEqual(rulesOf('p = D:\\\n'), [{ prefix: 'D:', alias: 'p' }])
  })

  test('同一条匹配值出现两次 = 报错（哪条生效不可预期）', () => {
    const errors = errorsOf('a = D:\\x\\proj\nb = D:\\x\\proj\\\n')
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /匹配值与第 1 行重复/)
  })

  test('超过条数上限整份拒绝', () => {
    const text = Array.from({ length: MAX_PROJECT_ALIAS_RULES + 1 }, (_v, i) => `p${i} = repo-${i}`).join('\n')
    const parsed = parseProjectAliasText(text)
    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.errors[0]!.reason, /条数超过上限/)
  })

  test('formatProjectAliasErrors 带行号并截断', () => {
    const text = 'a = D:\nb = / \nc = \nd = \n'
    const parsed = parseProjectAliasText(text)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    const reason = formatProjectAliasErrors(parsed.errors)
    assert.match(reason, /第 1 行/)
    assert.match(reason, /等 \d+ 处问题/)
  })
})

// ── 匹配语义（与看板同源） ───────────────────────────────────────────────

describe('projectResolverFromRules：匹配语义', () => {
  test('零条规则 = projectName 本身（没配别名的行为与迁移前逐字节相同）', () => {
    const resolve = projectResolverFromRules([])
    assert.equal(resolve, projectName)
    assert.equal(resolve('D:\\Coding\\my-project\\packages\\core'), 'core')
  })

  test('仓库名模式：cwd 的任一段全等即命中（仓库根与子目录折成一个名字）', () => {
    const resolve = projectResolverFromRules([{ prefix: 'my-project', alias: 'presales-kb-parent' }])
    assert.equal(resolve('D:\\Coding\\my-project'), 'presales-kb-parent')
    assert.equal(resolve('D:\\Coding\\my-project\\packages\\core'), 'presales-kb-parent')
    // 段是全等不是前缀：兄弟仓库不能被吃掉
    assert.equal(resolve('D:\\Coding\\my-project-old'), 'my-project-old')
  })

  test('路径前缀模式：按分隔符边界，不吃邻居', () => {
    const resolve = projectResolverFromRules([{ prefix: 'D:\\Coding\\proj', alias: 'P' }])
    assert.equal(resolve('D:\\Coding\\proj'), 'P')
    assert.equal(resolve('D:\\Coding\\proj\\src'), 'P')
    assert.equal(resolve('D:\\Coding\\proj-other'), 'proj-other')
  })

  test('路径模式优先于仓库名模式（显式限定位置的那条压住「到处都叫这个名字」）', () => {
    const resolve = projectResolverFromRules([
      { prefix: 'proj', alias: '仓库名' },
      { prefix: 'D:\\Coding\\proj', alias: '限定位置' },
    ])
    assert.equal(resolve('D:\\Coding\\proj\\src'), '限定位置')
    assert.equal(resolve('F:\\other\\proj'), '仓库名')
  })

  test('同模式内最长前缀优先', () => {
    const resolve = projectResolverFromRules([
      { prefix: 'D:\\Coding', alias: '大盘' },
      { prefix: 'D:\\Coding\\proj', alias: '具体项目' },
    ])
    assert.equal(resolve('D:\\Coding\\proj\\src'), '具体项目')
    assert.equal(resolve('D:\\Coding\\其它'), '大盘')
  })

  test('大小写逐字比较（不折叠 —— 折叠会把两个不同目录悄悄并起来）', () => {
    const resolve = projectResolverFromRules([{ prefix: 'Proj', alias: 'P' }])
    assert.equal(resolve('D:\\Coding\\proj'), 'proj')
  })

  test('未命中回落 projectName()，无 cwd 回落 (unknown)', () => {
    const resolve = projectResolverFromRules([{ prefix: 'nothing', alias: 'X' }])
    assert.equal(resolve('D:\\Coding\\other'), 'other')
    assert.equal(resolve(null), '(unknown)')
  })
})

// ── 文件读写 ─────────────────────────────────────────────────────────────

describe('loadLocalProjectAliases / writeLocalProjectAliases', () => {
  test('文件不存在 / 空文件 = 没配过（不是错误）', () => {
    const dataDir = join(home, 'token-report')
    const absent = loadLocalProjectAliases({ dataDir })
    assert.deepEqual(absent.rules, [])
    assert.equal(absent.note, null)
    assert.equal(absent.resolver('D:\\a\\proj'), 'proj')

    mkdirSync(dataDir, { recursive: true })
    writeFileSync(projectAliasFileIn(dataDir), '\n\n')
    const empty = loadLocalProjectAliases({ dataDir })
    assert.deepEqual(empty.rules, [])
    assert.equal(empty.note, null)
  })

  test('没有数据目录时按「没配过」处理（不抛错）', () => {
    const aliases = loadLocalProjectAliases({ dataDir: null })
    assert.deepEqual(aliases.rules, [])
    assert.equal(aliases.note, null)
    assert.equal(aliases.path, null)
  })

  test('坏配置整份不生效，并把原因带出去（绝不静默半份生效）', () => {
    const dataDir = join(home, 'token-report')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(projectAliasFileIn(dataDir), 'good = D:\\a\\proj\nbad line without equals\n')
    const aliases = loadLocalProjectAliases({ dataDir })
    assert.deepEqual(aliases.rules, [])
    assert.match(aliases.note!, /第 2 行/)
    assert.match(aliases.note!, /整份未生效/)
    // 原文要带出去：面板得让用户看见磁盘上那份坏配置并就地修
    assert.match(aliases.text, /bad line without equals/)
    assert.equal(aliases.resolver('D:\\a\\proj'), 'proj')
  })

  test('写入前整份校验：非法内容一个字节都不落盘', () => {
    const dataDir = join(home, 'token-report')
    const bad = writeLocalProjectAliases({ dataDir, text: 'p = D:\n' })
    assert.equal(bad.ok, false)
    assert.match(bad.reason!, /仓库名不能是盘符/)
    assert.equal(existsSync(projectAliasFileIn(dataDir)), false)
  })

  test('写入保原文（含注释），留空 = 删文件', () => {
    const dataDir = join(home, 'token-report')
    const text = '# 我的别名\np = D:\\a\\proj, proj\n'
    assert.equal(writeLocalProjectAliases({ dataDir, text }).ok, true)
    assert.equal(readFileSync(projectAliasFileIn(dataDir), 'utf8'), text)

    assert.equal(writeLocalProjectAliases({ dataDir, text: '   ' }).ok, true)
    assert.equal(existsSync(projectAliasFileIn(dataDir)), false)
  })

  test('装载出来的解析器来自文件里的规则', () => {
    const dataDir = join(home, 'token-report')
    writeLocalProjectAliases({ dataDir, text: 'presales = D:\\Coding\\my-project\n' })
    const aliases = loadLocalProjectAliases({ dataDir })
    assert.equal(aliases.note, null)
    assert.equal(aliases.resolver('D:\\Coding\\my-project\\src'), 'presales')
  })
})

// ── 与取数路径的集成 ────────────────────────────────────────────────────

let sessionsRoot: string
let dbPath: string
let dataDir: string

function usageLine(seq: number, input = 100): string {
  const usage = {
    inputTokens: input,
    outputTokens: 10,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    totalTokens: input + 10 + 1000,
  }
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { turn: 1, step: seq, message: { source: { kind: 'model', provider: 'dashscope', model: 'm-1' } }, usage },
  })
}

function sessionLine(sessionId: string, cwd: string): string {
  return JSON.stringify({ type: 'session', version: 3, id: sessionId, createdAt: Date.now(), cwd })
}

/** 建一个会话日志文件（cwd 由会话头给出，决定项目维度）。 */
function makeSession(sessionId: string, cwd: string): void {
  // ⚠️ 布局是 `<root>/<project>/<sessionId>/session*.jsonl.zstd`（见 scanner.ts）：
  //    少一层目录会让扫描器一个文件都找不到，而症状是「项目维度是空的」。
  const dir = join(sessionsRoot, `${sessionId}-dir`, sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(file, Buffer.alloc(0))
  appendFileSync(file, zstdCompressSync(Buffer.from([sessionLine(sessionId, cwd), usageLine(1)].join('\n') + '\n')))
}

describe('openStats：项目名称别名在三取数路径上同源', () => {
  beforeEach(() => {
    sessionsRoot = join(home, 'sessions')
    dbPath = join(home, 'token-report', 'usage.sqlite')
    dataDir = join(home, 'token-report')
    // 同一仓库的两个目录（仓库根 + 子目录）+ 一个不相干的项目
    makeSession('s-root', 'D:\\Coding\\my-project')
    makeSession('s-sub', 'D:\\Coding\\my-project\\packages\\core')
    makeSession('s-other', 'D:\\Coding\\other-project')
  })

  const RULES: LocalProjectAliasRule[] = [{ prefix: 'my-project', alias: 'presales-kb-parent' }]

  test('没配别名：项目名仍是 cwd 最后一段', async () => {
    const session = await openStats({ sessionsRoot, dbPath, rollup: true })
    try {
      assert.deepEqual(session.groups('project').map((row) => row.key).sort(), ['core', 'my-project', 'other-project'])
    } finally {
      session.close()
    }
  })

  test('SQL（含汇总表）与直扫得到同一组项目名，且会话按合并后的项目名去重', async () => {
    const sql = await openStats({ sessionsRoot, dbPath, projectAliases: RULES })
    const rollup = await openStats({ sessionsRoot, dbPath, rollup: true, projectAliases: RULES })
    const scan = await openStats({ sessionsRoot, dbPath, forceScan: true, projectAliases: RULES })
    try {
      for (const [label, session] of [['sql', sql], ['rollup', rollup], ['scan', scan]] as const) {
        const rows = session.groups('project')
        assert.deepEqual(rows.map((row) => row.key).sort(), ['other-project', 'presales-kb-parent'], `${label}: 项目名不一致`)
        const merged = rows.find((row) => row.key === 'presales-kb-parent')!
        // ★ 折进来的两个 cwd 各自有一个会话 —— 合并后的会话数必须是去重后的 2，不是相加后的别的数
        assert.equal(merged.sessions, 2, `${label}: 合并后会话数`)
      }
      // 只改显示：总量不因别名变化
      assert.equal(sql.totals().total, scan.totals().total)
      assert.equal(sql.totals().calls, 3)
    } finally {
      sql.close()
      rollup.close()
      scan.close()
    }
  })

  test('别名只影响 project 维度：provider / session 维度的键一个都不变', async () => {
    const session = await openStats({ sessionsRoot, dbPath, rollup: true, projectAliases: RULES })
    try {
      assert.deepEqual(session.groups('provider').map((row) => row.key), ['dashscope'])
      assert.deepEqual(session.groups('session').map((row) => row.key).sort(), ['s-other', 's-root', 's-sub'])
    } finally {
      session.close()
    }
  })

  test('★ 金额桶与 token 行用同一个解析器（否则费用列会凭空缺行）', async () => {
    const session = await openStats({ sessionsRoot, dbPath, rollup: true, projectAliases: RULES })
    try {
      const records = session.records()
      // 一条价都没配：金额表仍然有键（未计价 ≠ 缺行）
      const buckets = costByGroupOf(records, 'project', priceResolver([]), {
        pricingSource: 'none' as const,
        pricingSyncedAt: null,
        pricingOrigin: null,
      }, session.projectNameOf)
      assert.deepEqual(
        [...buckets.keys()].sort(),
        session.groups('project').map((row) => row.key).sort(),
      )
      assert.equal(buckets.get('presales-kb-parent')!.unpricedTokens > 0, true)
    } finally {
      session.close()
    }
  })

  test('汇总表路径与 SQL 路径的项目名逐字相同（漏掉 rollup 就是「面板有时折、有时不折」）', async () => {
    const plain = await openStats({ sessionsRoot, dbPath, projectAliases: RULES })
    const rollup = await openStats({ sessionsRoot, dbPath, rollup: true, projectAliases: RULES })
    try {
      assert.deepEqual(
        rollup.groups('project').map((row) => [row.key, row.counts.total]),
        plain.groups('project').map((row) => [row.key, row.counts.total]),
      )
    } finally {
      plain.close()
      rollup.close()
    }
  })

  test('queryGroups 也吃解析器（本地 SQL 路径的另一个入口）', async () => {
    // ⚠️ `openDatabaseForIngest()` 只开库、不 ingest：先跑一次 ingest，
    //    否则这条断言会在一个空表上「通过」不了（也会掩盖真正的接线问题）。
    await ingest({ sessionsRoot, dbPath })
    const db = openDatabaseForIngest(dbPath)
    try {
      const resolve = projectResolverFromRules(RULES)
      const rows = queryGroups(db, 'project', {}, undefined, undefined, resolve)
      assert.deepEqual(rows.map((row) => row.key).sort(), ['other-project', 'presales-kb-parent'])
    } finally {
      db.close()
    }
  })

  test('aggregate / crossTabRanked 与 openStats 共用同一个解析器', () => {
    const records = [
      { time: 1, sessionId: 'a', provider: 'p', model: 'm', cwd: 'D:\\Coding\\my-project', usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1 } },
      { time: 2, sessionId: 'b', provider: 'p', model: 'm', cwd: 'D:\\Coding\\my-project\\src', usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 } },
    ] as unknown as UsageRecord[]
    const resolve = projectResolverFromRules(RULES)
    assert.deepEqual(aggregate(records, 'project', resolve).map((row) => row.key), ['presales-kb-parent'])
    const table = crossTabRanked(records, 'project', 'provider', resolve)
    assert.deepEqual(table.primaryKeys, ['presales-kb-parent'])
  })
})