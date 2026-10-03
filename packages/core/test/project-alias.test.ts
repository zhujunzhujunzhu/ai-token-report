/**
 * 项目归一化（v11）：规则映射、**前缀匹配语义**、加载、以及查询时的口径。
 *
 * ## 这份测试要钉住的五件事
 *
 * 1. **未配置的 cwd 回落旧口径**（`projectName()` = 目录最后一段），
 *    不是空串、也不是 `other`。把默认值改成「完整路径」会让所有没配规则的行
 *    变成一长串 `D:\…`，而那是**给所有人**的行为变化。
 * 2. **前缀按路径分隔符边界判定**：`D:\a\proj` 命中 `D:\a\proj\src`，
 *    但**不**命中 `D:\a\proj-other`。少了这一条，一条规则会悄悄吃掉
 *    邻居项目的用量 —— 页面上只是「那个项目的数字偏大」，没有任何报错。
 * 3. **最长前缀优先，同长时人员规则覆盖全局规则**。这是「一条 `D:\work` 的
 *    部门规则 + 一条 `D:\work\proj` 的个人规则」能同时成立的前提。
 * 4. **分布表与金额列的项目键逐字相同**：两条路径各用一套解析器的话，
 *    金额列会出现取不到值的空行，而两边的数字各自都是「对的」。
 * 5. 🚨 **事实表里的 `cwd` 永远是原值** —— 归一化是查询期口径，
 *    迁移与查询都不许改写它一个字节。
 *
 * ⚠️ 与 `provider-alias.test.ts` 的关键差别：那边匹配是**精确**的，
 *   所以「未命中」只有一种原因；这边未命中与命中之间还有**边界**这一层，
 *   边界写错不会抛错、只会多算几个目录，所以边界用例是这份文件的主角。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectName } from '../src/aggregate.js'
import {
  distinctCwdsQuery,
  insertAttributedRecords,
  loadProjectAliases,
  normalizeProjectPrefix,
  openPortalStats,
  openPortalStore,
  preparePortalDatabase,
  projectAliasNameError,
  projectAliasesToMap,
  projectNormalizer,
  projectPrefixError,
  projectPrefixMatches,
  type IngestRecord,
  type PortalTarget,
  type ProjectAliasRule,
} from '../src/db/index.js'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atr-project-alias-'))
  roots.push(dir)
  const target: PortalTarget = { sqlitePath: join(dir, 'portal.sqlite') }
  await preparePortalDatabase(target)
  return target
}

/** 造一条已归属的上报记录（走真实写入路径，不手拼 SQL）。 */
const record = (id: string, cwd: string | null, over: Partial<IngestRecord> = {}): IngestRecord => ({
  event_id: id,
  session_id: '项目归一化测试',
  seq: 1,
  ts: 1000,
  provider: 'dashscope',
  model: 'deepseek-v4.1-flash',
  cwd,
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 900,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  turn: 1,
  step: 1,
  ...over,
})

/** 造一个真实人员（`project_alias.member_id` 有外键，指向不存在的人会被挡住）。 */
async function addMember(target: PortalTarget): Promise<string> {
  const id = randomUUID()
  const store = await openPortalStore(target)
  try {
    await store.run(
      'INSERT INTO members (member_id,display_name,status,created_at_ms,updated_at_ms) VALUES ($id,$name,\'active\',$now,$now)',
      { $id: id, $name: `人员${id.slice(0, 8)}`, $now: Date.now() },
    )
  } finally { await store.close() }
  return id
}

/** 写一条规则。绕开仓储层（那是 server 的测试范围），但保持列与约束一致。 */
async function addRule(
  target: PortalTarget,
  rule: { scope: 'global' | 'member'; memberId?: string | null; prefix: string; alias: string; enabled?: boolean },
): Promise<void> {
  const store = await openPortalStore(target)
  try {
    await store.run(
      'INSERT INTO project_alias (alias_id,scope,member_id,prefix,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,$scope,$member,$prefix,$alias,$enabled,$now,$now)',
      {
        $id: randomUUID(),
        $scope: rule.scope,
        $member: rule.scope === 'member' ? rule.memberId ?? null : null,
        $prefix: rule.prefix,
        $alias: rule.alias,
        $enabled: rule.enabled === false ? 0 : 1,
        $now: Date.now(),
      },
    )
  } finally { await store.close() }
}

const rule = (prefix: string, alias: string, memberId: string | null = null): ProjectAliasRule => ({
  scope: memberId ? 'member' : 'global',
  memberId,
  prefix,
  alias,
})

// ─────────────────────────────────────────────────────────────
// 纯函数：路径归一化与前缀边界
// ─────────────────────────────────────────────────────────────

describe('项目归一化：路径前缀的归一化与匹配', () => {
  test('尾部路径分隔符两侧都去掉（只归一化一侧就等于规则永远不命中）', () => {
    expect(normalizeProjectPrefix('D:\\a\\proj\\')).toBe('D:\\a\\proj')
    expect(normalizeProjectPrefix('D:\\a\\proj\\\\')).toBe('D:\\a\\proj')
    expect(normalizeProjectPrefix('/home/alice/proj/')).toBe('/home/alice/proj')
    expect(normalizeProjectPrefix('D:\\a\\proj')).toBe('D:\\a\\proj')
  })

  test('★ 单独的根分隔符必须保留：归一化成空串会变成「匹配一切」', () => {
    // 空串前缀 `''.startsWith` 恒真 —— 那会让一条「/」的规则命中**所有** cwd，
    // 包括 Windows 的 `D:\…`，而页面上完全看不出来。
    expect(normalizeProjectPrefix('/')).toBe('/')
    expect(normalizeProjectPrefix('\\')).toBe('\\')
    expect(normalizeProjectPrefix('')).toBe('')
  })

  test('Windows 盘符根归一化成 `D:`，但仍能命中 `D:\\…`（边界那一格是分隔符）', () => {
    expect(normalizeProjectPrefix('D:\\')).toBe('D:')
    expect(projectPrefixMatches('D:', 'D:\\a\\proj')).toBe(true)
    // ⚠️ 盘符**相对**路径（`D:foo`）不是「D 盘下的东西」，不该被这条规则吃掉。
    expect(projectPrefixMatches('D:', 'D:foo')).toBe(false)
  })

  test('前缀命中自身与子目录', () => {
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\proj')).toBe(true)
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\proj\\src')).toBe(true)
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\proj\\packages\\core')).toBe(true)
    // 正斜杠是同一个位置的分隔符：同一个仓库在两个客户端上可能报不同的写法。
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\proj/src')).toBe(true)
    expect(projectPrefixMatches('/home/alice/proj', '/home/alice/proj\\src')).toBe(true)
  })

  test('🚨 边界：`D:\\a\\proj` 绝不吃掉 `D:\\a\\proj-other`', () => {
    // 只写 `cwd.startsWith(prefix)` 的话这一条会通过 `proj-other` ——
    // 一条规则悄悄吃掉邻居项目的用量，而没有任何报错。
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\proj-other')).toBe(false)
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\a\\project')).toBe(false)
    expect(projectPrefixMatches('/home/alice/proj', '/home/alice/project')).toBe(false)
    expect(projectPrefixMatches('/home/alice/proj', '/home/alice/proj2/src')).toBe(false)
  })

  test('★ 根前缀 `/` 必须命中 `/home/x`（尾分隔符分支）', () => {
    // 归一化保留下来的那个尾分隔符就是为这一条存在的：
    // 若边界判定要求「下一个字符是分隔符」，`/` 会变成一条什么都不命中的规则。
    expect(projectPrefixMatches('/', '/home/alice')).toBe(true)
    expect(projectPrefixMatches('/', '/')).toBe(true)
    // 而它不该吃掉 Windows 路径（它们不以 `/` 开头）。
    expect(projectPrefixMatches('/', 'D:\\a')).toBe(false)
  })

  test('匹配区分大小写（大小写不敏感会在区分大小写的文件系统上并掉两个项目）', () => {
    expect(projectPrefixMatches('D:\\a\\proj', 'd:\\a\\proj\\src')).toBe(false)
    expect(projectPrefixMatches('D:\\a\\proj', 'D:\\A\\proj\\src')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// 纯函数：规则映射与优先级
// ─────────────────────────────────────────────────────────────

describe('项目归一化：规则映射与优先级', () => {
  test('未配置的 cwd 回落 `projectName()`（旧口径），绝不映射成空 / other', () => {
    const normalize = projectNormalizer(projectAliasesToMap([rule('D:\\a\\proj', '我的项目')]))
    expect(normalize.resolve('D:\\a\\proj\\src')).toBe('我的项目')
    // ★ 未命中 = 旧口径（最后一段），这是「没配规则的保持自身」的落点。
    expect(normalize.apply('D:\\b\\other\\src')).toBeUndefined()
    expect(normalize.resolve('D:\\b\\other\\src')).toBe('src')
    expect(normalize.resolve('D:\\b\\other')).toBe('other')
    // 没有 cwd 的那一类仍然是 `(unknown)`（`projectName(null)` 的既有语义）。
    expect(normalize.resolve(null)).toBe(projectName(null))
    expect(normalize.resolve(null)).toBe('(unknown)')
    expect(normalize.resolve('')).toBe('(unknown)')
  })

  test('★ 最长前缀优先：更具体的目录压住更宽的目录', () => {
    const normalize = projectNormalizer(projectAliasesToMap([
      rule('D:\\work', '工作'),
      rule('D:\\work\\proj', '我的项目'),
    ]))
    expect(normalize.resolve('D:\\work\\proj\\src')).toBe('我的项目')
    expect(normalize.resolve('D:\\work\\other')).toBe('工作')
    expect(normalize.resolve('D:\\work')).toBe('工作')
    // ⚠️ 顺序无关：规则是从数据库按 `prefix` 字典序读出来的，
    //    `D:\work` 恰好排在 `D:\work\proj` 前面 —— 靠插入序就会取错。
    expect(normalize.pairs.map(([prefix]) => prefix)).toEqual(['D:\\work\\proj', 'D:\\work'])
  })

  test('同长度前缀时人员规则覆盖全局规则（逐条覆盖，不是整套换掉）', () => {
    const normalize = projectNormalizer(projectAliasesToMap([
      rule('D:\\work', '部门口径'),
      rule('D:\\other', '全局另一个'),
      rule('D:\\work', '我的口径', 'member-1'),
    ]))
    expect(normalize.resolve('D:\\work\\a')).toBe('我的口径')
    // ★ 我没提到的那些目录仍然走全局规则 —— 个人规则不是「整套替换」。
    expect(normalize.resolve('D:\\other\\a')).toBe('全局另一个')
    expect(normalize.rules).toBe(2)
  })

  test('前缀尾部带分隔符的规则照样命中（两侧用同一个归一化函数）', () => {
    const normalize = projectNormalizer(projectAliasesToMap([rule('D:\\a\\proj\\', 'P')]))
    expect(normalize.resolve('D:\\a\\proj')).toBe('P')
    expect(normalize.resolve('D:\\a\\proj\\src')).toBe('P')
  })

  test('同一作用范围的重复前缀取**最早**的一条（结果确定，不依赖数据库返回顺序）', () => {
    // 唯一索引拦不住含 NULL 的行（两种后端都能插进两条全局规则），
    // 所以这里必须让「配重了」的表现是确定的、可复现的。
    const normalize = projectNormalizer(projectAliasesToMap([
      rule('D:\\a', '先'),
      rule('D:\\a', '后'),
    ]))
    expect(normalize.resolve('D:\\a\\x')).toBe('先')
  })

  test('零条规则时 pairs 为空，rules 为 0（调用方据此折成 undefined）', () => {
    const normalize = projectNormalizer(projectAliasesToMap([]))
    expect(normalize.rules).toBe(0)
    expect(normalize.pairs).toEqual([])
    expect(normalize.resolve('D:\\a\\b')).toBe('b')
  })
})

// ─────────────────────────────────────────────────────────────
// 使用者输入的校验
// ─────────────────────────────────────────────────────────────

describe('项目归一化：输入校验', () => {
  test('目录前缀：合法路径全部收下（含 `\\` / `:` / 中间空格）', () => {
    expect(projectPrefixError('D:\\Coding_agent\\ai-token-report')).toBeNull()
    expect(projectPrefixError('/home/alice/my proj')).toBeNull()
    expect(projectPrefixError('\\\\server\\share\\proj')).toBeNull()
    expect(projectPrefixError('D:\\a\\proj\\')).toBeNull()
  })

  test('目录前缀：空的、文件系统根、首尾空格、不可见字符、超长一律拒掉', () => {
    expect(projectPrefixError('')).toBe('目录前缀不能为空')
    expect(projectPrefixError(123)).toBe('目录前缀需要是字符串')
    // ★ 根目录会把**所有** POSIX 路径折成一个项目 —— 它必然是误配。
    //   ⚠️ `///` 与 `/` 归一化之后是同一个前缀，所以判据必须在归一化之后取。
    expect(projectPrefixError('/')).toBe('目录前缀不能是文件系统根目录（它会匹配所有路径）')
    expect(projectPrefixError('///')).toBe('目录前缀不能是文件系统根目录（它会匹配所有路径）')
    expect(projectPrefixError('\\')).toBe('目录前缀不能是文件系统根目录（它会匹配所有路径）')
    // 而盘符根（`D:\` → `D:`）刻意放行：那是「D 盘下的东西」，不是「一切」。
    expect(projectPrefixError('D:\\')).toBeNull()
    // 首尾空格：`'D:\a '` 与 `'D:\a'` 在 `startsWith` 里是两个前缀，页面上看不出差别。
    expect(projectPrefixError(' D:\\a')).toBe('目录前缀首尾不能是空格')
    expect(projectPrefixError('D:\\a ')).toBe('目录前缀首尾不能是空格')
    expect(projectPrefixError('D:\\a\u00a0')).toBe('目录前缀不能包含空格以外的空白或不可见字符')
    expect(projectPrefixError('D:\\a\u200b')).toBe('目录前缀不能包含空格以外的空白或不可见字符')
    expect(projectPrefixError('D:\\' + 'x'.repeat(600))).toBe('目录前缀不能超过 512 个字符')
  })

  test('归一化名：允许中文与 `/`（项目名里带斜杠不会与任何拼接键歧义）', () => {
    expect(projectAliasNameError('AI Token 用量平台')).toBeNull()
    expect(projectAliasNameError('客户A/前端')).toBeNull()
    expect(projectAliasNameError('')).toBe('归一化名不能为空')
    expect(projectAliasNameError(' 前')).toBe('归一化名首尾不能是空格')
    expect(projectAliasNameError('后 ')).toBe('归一化名首尾不能是空格')
    expect(projectAliasNameError('a\u0000b')).toBe('归一化名不能包含空格以外的空白或不可见字符')
    expect(projectAliasNameError('x'.repeat(129))).toBe('归一化名不能超过 128 个字符')
  })
})

// ─────────────────────────────────────────────────────────────
// 从库里读规则
// ─────────────────────────────────────────────────────────────

describe('项目归一化：从上报库读规则', () => {
  test('匿名查看只拿全局规则；给了人员 ID 才套上个人规则', async () => {
    const target = await fixture()
    const me = await addMember(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\work', alias: '工作' })
    await addRule(target, { scope: 'member', memberId: me, prefix: 'D:\\mine', alias: '我的' })

    const store = await openPortalStore(target)
    try {
      const anonymous = await loadProjectAliases(store, undefined)
      expect([...anonymous.keys()].sort()).toEqual(['D:\\work'])
      const mine = await loadProjectAliases(store, me)
      expect([...mine.keys()].sort()).toEqual(['D:\\mine', 'D:\\work'])
      // 别人配的规则不会漏过来。
      expect((await loadProjectAliases(store, randomUUID())).size).toBe(1)
    } finally { await store.close() }
  })

  test('停用的规则不参与归一化（那些目录回到旧口径，而不是映射到别的名字）', async () => {
    const target = await fixture()
    await addRule(target, { scope: 'global', prefix: 'D:\\work', alias: '工作', enabled: false })
    const store = await openPortalStore(target)
    try {
      expect((await loadProjectAliases(store, undefined)).size).toBe(0)
      // ★ 规则行本身还在（停用可逆）。
      expect(Number((await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM project_alias'))?.n)).toBe(1)
    } finally { await store.close() }
  })

  test('🚨 唯一索引拦不住含 NULL 的全局重复 —— 所以「同一前缀只有一条全局规则」由应用层保证', async () => {
    const target = await fixture()
    const store = await openPortalStore(target)
    try {
      // 两条 `scope='global'`（`member_id IS NULL`）的同前缀规则：两个后端的
      // `(member_id, prefix)` 唯一索引都只对**整行非 NULL** 的组合去重，
      // 所以数据库**会收下**这两行。这不是「索引写错了」，而是「不要把全局唯一
      // 寄托在索引上」这条设计取舍 —— 真正拦住它的是仓储层的 `findProjectAlias()`。
      // ⚠️ 这里绝不能断言「数据库会拒」：那是假承诺，会让这个缺口看起来已被堵上。
      for (const alias of ['先', '后']) {
        await store.run(
          'INSERT INTO project_alias (alias_id,scope,member_id,prefix,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,\'global\',NULL,$prefix,$alias,1,$now,$now)',
          { $id: randomUUID(), $prefix: 'D:\\dup', $alias: alias, $now: Date.now() },
        )
      }
      expect(Number((await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM project_alias WHERE prefix='D:\\dup'"))?.n)).toBe(2)
      // ★ 而读取侧仍然给出**确定**的答案（取最早的一条），不因为配重了而随机：
      //   解析结果只取决于规则集合，排查时两次查询能逐字对上。
      const map = await loadProjectAliases(store, undefined)
      expect(map.get('D:\\dup')).toBe('先')
    } finally { await store.close() }
  })

  test('表不存在时降级成「没有规则」，而不是让整个看板 503', async () => {
    const target = await fixture()
    const store = await openPortalStore(target)
    try {
      await store.exec('DROP TABLE project_alias')
      expect((await loadProjectAliases(store, undefined)).size).toBe(0)
    } finally { await store.close() }
  })
})

// ─────────────────────────────────────────────────────────────
// 查询期口径（真库）
// ─────────────────────────────────────────────────────────────

describe('项目归一化：查询口径', () => {
  /**
   * 一个仓库的根、两个子包，加上两个不相干的目录。
   *
   * | cwd | 调用条数 |
   * |---|---|
   * | `D:\repo` | 2 |
   * | `D:\repo\packages\core` | 3 |
   * | `D:\repo-other` | 1 |
   * | `C:\Users\alice\scratch` | 1 |
   */
  async function seed(target: PortalTarget, ownerId: string): Promise<void> {
    const store = await openPortalStore(target)
    try {
      await insertAttributedRecords(store, [
        record('r1', 'D:\\repo'),
        record('r2', 'D:\\repo'),
        record('c1', 'D:\\repo\\packages\\core'),
        record('c2', 'D:\\repo\\packages\\core'),
        record('c3', 'D:\\repo\\packages\\core'),
        record('o1', 'D:\\repo-other'),
        record('s1', 'C:\\Users\\alice\\scratch'),
      ], { userId: '张三', memberId: ownerId })
    } finally { await store.close() }
  }

  const owner = async (target: PortalTarget): Promise<string> => {
    const id = await addMember(target)
    await seed(target, id)
    return id
  }

  test('未配规则时就是旧口径：目录最后一段（各占一行）', async () => {
    const target = await fixture()
    await owner(target)
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 })
    try {
      const groups = await session.groups('project')
      expect(groups.map((g) => g.key).sort()).toEqual(['core', 'repo', 'repo-other', 'scratch'])
    } finally { await session.close() }
  })

  test('★ 一条仓库根的规则把根与子包折回一个项目，而总量一条不差', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: 'AI Token 用量平台' })

    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, undefined))
    try {
      const groups = await session.groups('project')
      const names = groups.map((g) => g.key).sort()
      // `D:\repo` 与 `D:\repo\packages\core` 折成一行；`D:\repo-other` 因为**边界**
      // 而留在外面（这正是「前缀不是 startsWith」的那条不变量）。
      expect(names).toEqual(['AI Token 用量平台', 'repo-other', 'scratch'])
      expect(groups.find((g) => g.key === 'AI Token 用量平台')!.counts.calls).toBe(5)
      expect(groups.find((g) => g.key === 'repo-other')!.counts.calls).toBe(1)

      // ★ 折叠只改分组，不改总量：7 条记录一条不丢、也不重复计。
      const folded = await session.totals()
      const raw = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 })
      try {
        expect(folded).toEqual(await raw.totals())
        expect(folded.calls).toBe(7)
      } finally { await raw.close() }
    } finally { await session.close() }
  })

  test('★ 最长前缀优先：子目录单独成项目，仓库根仍然是另一个', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '仓库' })
    await addRule(target, { scope: 'global', prefix: 'D:\\repo\\packages\\core', alias: '核心包' })

    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, undefined))
    try {
      const groups = await session.groups('project')
      expect(groups.find((g) => g.key === '核心包')!.counts.calls).toBe(3)
      expect(groups.find((g) => g.key === '仓库')!.counts.calls).toBe(2)
    } finally { await session.close() }
  })

  test('🚨 分布表与金额列的项目键逐字相同（否则金额列会整行落空）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '折叠后的项目' })
    // 只给这一组配价：未计价的那些行仍然要有行（未计价 ≠ 没这一行）。
    const store = await openPortalStore(target)
    try {
      await store.run(
        `INSERT INTO model_price (
           price_id, provider, model, currency,
           input_micro_per_ktok, output_micro_per_ktok,
           cache_read_micro_per_ktok, cache_write_micro_per_ktok,
           effective_from_ms, effective_to_ms, note, created_at_ms, updated_at_ms
         ) VALUES ($id,'dashscope','deepseek-v4.1-flash','CNY',1000,2000,100,0,0,NULL,NULL,$now,$now)`,
        { $id: randomUUID(), $now: Date.now() },
      )
    } finally { await store.close() }

    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, true, (store) => loadProjectAliases(store, undefined))
    try {
      const keys = (await session.groups('project')).map((row) => row.key)
      const costs = await session.costByGroup('project')
      // 每一个有数据的行都必须能取到金额；金额里也不许多出键。
      for (const key of keys) expect(costs.has(key)).toBe(true)
      expect([...costs.keys()].sort()).toEqual([...keys].sort())
      // `D:\repo` 与它的子包一起算进「折叠后的项目」：5 条 × (100×1 + 20×2 + 900×0.1) 微
      // = 5 × (100 + 40 + 90) = 5 × 230 = 1150 微。
      expect(costs.get('折叠后的项目')!.costs).toEqual([{ currency: 'CNY', amountMicro: 1150, tokens: 5100 }])
    } finally { await session.close() }
  })

  test('原始目录候选回的是**原始 cwd**（配置页要配的正是这个，不是归一化名）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '折叠后的项目' })

    // ★ 走 `distinctCwdsQuery()` + 裸连接（与 `/api/v1/stats/providers` 同款）：
    //   统计会话那一关（`assertLegacyIdentityView()`）是给**按人排行**用的，
    //   一份目录候选不该被归属形状挡住 —— 见 `stats-route.ts` 的 `#projects()`。
    const store = await openPortalStore(target)
    try {
      const q = distinctCwdsQuery({})
      const rows = await store.all<{ cwd: string }>(q.sql, q.params)
      expect(rows.map((row) => row.cwd)).toEqual([
        'C:\\Users\\alice\\scratch',
        'D:\\repo',
        'D:\\repo-other',
        'D:\\repo\\packages\\core',
      ])
    } finally { await store.close() }
  })

  test('按人覆盖只影响这个人的视图：同一个库、不同查看者看到不同项目名', async () => {
    const target = await fixture()
    const me = await owner(target)
    const other = await addMember(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '全局仓库' })
    await addRule(target, { scope: 'member', memberId: me, prefix: 'D:\\repo', alias: '我的仓库' })

    const mine = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, me))
    const theirs = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, other))
    try {
      expect((await mine.groups('project')).some((g) => g.key === '我的仓库')).toBe(true)
      expect((await mine.groups('project')).some((g) => g.key === '全局仓库')).toBe(false)
      expect((await theirs.groups('project')).some((g) => g.key === '全局仓库')).toBe(true)
    } finally { await mine.close(); await theirs.close() }
  })

  test('🚨 事实表里的 cwd 永远是原值，归一化不改写一个字节', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '折叠后的项目' })

    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, undefined))
    await session.close()

    const store = await openPortalStore(target)
    try {
      const rows = await store.all<{ cwd: string }>('SELECT DISTINCT cwd FROM usage_event ORDER BY cwd')
      expect(rows.map((r) => r.cwd)).toEqual([
        'C:\\Users\\alice\\scratch',
        'D:\\repo',
        'D:\\repo-other',
        'D:\\repo\\packages\\core',
      ])
    } finally { await store.close() }
  })

  test('明细分页里的 cwd 也是原值（归一化只作用于分组 / 排名，不改明细行）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', prefix: 'D:\\repo', alias: '折叠后的项目' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, undefined, false, (store) => loadProjectAliases(store, undefined))
    try {
      const { rows } = await session.records(10, 0)
      expect(rows.map((r) => r.cwd).sort()).toContain('D:\\repo\\packages\\core')
    } finally { await session.close() }
  })
})
