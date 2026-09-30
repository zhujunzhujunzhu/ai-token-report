/**
 * 供应商归一化（v6）：规则映射、加载、以及**查询时的口径**。
 *
 * ## 这份测试要钉住的三件事
 *
 * 1. **未配置的 provider 保持原值**。这是使用者的明确要求，也是最容易做错的一条：
 *    一个「把没配规则的 provider 映射成空字符串 / `unknown`」的实现会让整张
 *    供应商分布图悄悄少掉一大块，而总量看起来仍然对得上（因为总量走的是另一条路）。
 * 2. **人员规则逐条覆盖全局，未命中回落全局**。不是「有人员规则就整套换掉」——
 *    后者会让「我给 dashscope 起个别名」意外地把别人的所有全局规则一并丢掉。
 * 3. **筛选、分组、明细三处口径必须一致**。归一化只改展示名，不该让
 *    某条数据在「按供应商筛选」时出现、在「按供应商分组」时消失。
 *
 * ⚠️ 事实表里的 `provider` 永远是原值 —— 迁移与查询都不许改写它，
 *   所以这里同时断言「库里那一列没被动过」。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLITE_DIALECT } from '../src/db/dialect.js'
import {
  aliasNameError,
  insertAttributedRecords,
  loadProviderAliases,
  openPortalStats,
  openPortalStore,
  preparePortalDatabase,
  providerAliasesToMap,
  providerCaseSql,
  providerNameError,
  providerNormalizer,
  type PortalTarget,
  type ProviderAliasRule,
} from '../src/db/index.js'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atr-provider-alias-'))
  roots.push(dir)
  const target: PortalTarget = { sqlitePath: join(dir, 'portal.sqlite') }
  await preparePortalDatabase(target)
  return target
}

/** 造一条已归属的上报记录（走真实写入路径，不手拼 SQL）。 */
const record = (id: string, provider: string, model = 'deepseek-v4.1-flash') => ({
  event_id: id,
  session_id: '归一化测试',
  seq: 1,
  ts: 1000,
  provider,
  model,
  cwd: null,
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 900,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  turn: 1,
  step: 1,
})

/** 造一个真实人员（`provider_alias.member_id` 有外键，指向不存在的人会被挡住）。 */
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
  rule: { scope: 'global' | 'member'; memberId?: string | null; provider: string; alias: string; enabled?: boolean },
): Promise<void> {
  const store = await openPortalStore(target)
  try {
    await store.run(
      'INSERT INTO provider_alias (alias_id,scope,member_id,provider,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,$scope,$member,$provider,$alias,$enabled,$now,$now)',
      {
        $id: randomUUID(),
        $scope: rule.scope,
        $member: rule.scope === 'member' ? rule.memberId ?? null : null,
        $provider: rule.provider,
        $alias: rule.alias,
        $enabled: rule.enabled === false ? 0 : 1,
        $now: Date.now(),
      },
    )
  } finally { await store.close() }
}

const rule = (provider: string, alias: string, memberId: string | null = null): ProviderAliasRule => ({
  scope: memberId ? 'member' : 'global',
  memberId,
  provider,
  alias,
})

describe('供应商归一化：规则映射', () => {
  test('未配置的 provider 原样保留（使用者明确要求）', () => {
    const map = providerAliasesToMap([rule('dashscope', 'bailian-tpp')])
    expect(map.get('dashscope')).toBe('bailian-tpp')
    // ★ 没有规则 ≠ 映射成空 / unknown：它压根不在映射里，查询层会回落到原值。
    expect(map.has('openai')).toBe(false)
    expect(map.has('')).toBe(false)
    expect(map.size).toBe(1)
  })

  test('★ 人员规则逐条覆盖全局，未命中回落全局', () => {
    const memberId = randomUUID()
    const map = providerAliasesToMap([
      rule('dashscope', '全局百炼'),
      rule('bailian', '全局百炼'),
      // 这个人只改 dashscope；bailian 必须继续沿用全局规则。
      rule('dashscope', '我的百炼', memberId),
    ])
    expect(map.get('dashscope')).toBe('我的百炼')
    expect(map.get('bailian')).toBe('全局百炼')
  })

  test('人员规则胜出与传入顺序无关（全局先铺、人员后盖）', () => {
    const memberId = randomUUID()
    const overrides = [rule('dashscope', '我的', memberId)]
    const globals = [rule('dashscope', '全局'), rule('other', '别的')]
    // 两种入参顺序都要落到同一个结果：实现里是按 scope 分两批铺的。
    expect(providerAliasesToMap([...globals, ...overrides]).get('dashscope')).toBe('我的')
    expect(providerAliasesToMap([...overrides, ...globals]).get('dashscope')).toBe('我的')
  })

  test('同一个 provider 命中多条全局规则时以最后一条为准（数据库已挡重复）', () => {
    // 唯一索引在两种后端上都不允许重复的 (member_id, provider)，
    // 所以这条只验证「万一读到了」时的确定性；顺序由 ORDER BY scope, provider 固定。
    const map = providerAliasesToMap([rule('dashscope', '先'), rule('dashscope', '后')])
    expect(map.get('dashscope')).toBe('后')
  })

  test('匹配是**大小写敏感**的精确比较：写错大小写就是静默不命中', () => {
    const map = providerAliasesToMap([rule('dashscope', '百炼')])
    expect(map.get('DashScope')).toBeUndefined()
  })
})

describe('供应商归一化：规则校验', () => {
  test('接受真实世界里出现过的名字形状', () => {
    for (const name of ['dashscope', 'bailian-tpp', 'azure-openai', 'bedrock/anthropic', 'openai compatible', 'gpt_4.1', 'x'.repeat(128), 'a b c', 'qwen-max-']) {
      expect(providerNameError(name)).toBeNull()
    }
  })

  test('拒绝会让规则静默不命中的写法（全角、首尾空格、控制字符）', () => {
    for (const name of ['', ' dashscope', 'dashscope ', 'ｄａｓｈｓｃｏｐｅ', 'dash\tscope', 'dash\nscope', 'dash\u200bscope', '-leading', 'x'.repeat(129), '中文供应商', '供应商 name', ' a ']) {
      expect(providerNameError(name)).not.toBeNull()
    }
  })

  test('非字符串输入被拒绝而不是被强转', () => {
    for (const value of [null, undefined, 42, {}, []]) expect(providerNameError(value)).not.toBeNull()
  })

  test('★ 归一化名（展示名）允许中文，但仍挡住会破坏分组的东西', () => {
    // 展示名是给人看的：`dashscope` → `阿里百炼` 显然比 `bailian-tpp` 更好读，
    // 而这正是这个功能的目的 —— 所以这里**不能**沿用原始名那套 ASCII 规则。
    for (const name of ['阿里百炼', '百炼（北京）', 'bailian-tpp', 'OpenAI Compatible', 'a b']) {
      expect(aliasNameError(name)).toBeNull()
    }
    // 仍然挡住三类：空的、不可见的、会让 `provider/model` 拼接歧义的 `/`。
    for (const name of ['', ' ', ' 阿里百炼', '阿里百炼 ', '阿里\u200b百炼', '阿里\t百炼', 'a/b', 'x'.repeat(129), null]) {
      expect(aliasNameError(name)).not.toBeNull()
    }
  })
})

describe('SQL 片段：CASE 与回落', () => {
  test('无规则时返回原表达式（SQL 与改动前逐字相同）', () => {
    const params: Record<string, string | number> = {}
    expect(providerCaseSql('provider', new Map(), params, 'x')).toBe('provider')
    expect(params).toEqual({})
  })

  test('★ CASE 没有 ELSE：未命中的行必须靠 COALESCE 回落', () => {
    const params: Record<string, string | number> = {}
    const sql = providerCaseSql('provider', providerAliasesToMap([rule('dashscope', '百炼')]), params, 'x')
    expect(sql).toBe('(CASE WHEN provider = $xk0 THEN $xv0 END)')
    // ⚠️ 没有 ELSE 是刻意的：漏掉 COALESCE 会让未命中的行变成 NULL，
    //   于是「按供应商分组」多出一行空名字、而总量还看得过去。
    expect(sql).not.toContain('ELSE')
    expect(params.$xk0).toBe('dashscope')
    expect(params.$xv0).toBe('百炼')
  })

  test('★ 参数名是生成的序号，绝不拿供应商名去拼参数名', () => {
    const params: Record<string, string | number> = {}
    const sql = providerCaseSql('provider', providerAliasesToMap([rule("o'brien", "a';DROP TABLE usage_event;--")]), params, 'rp')
    // 供应商名只出现在**绑定值**里。一旦被拼进 SQL 文本（哪怕是参数名），
    // 一个带引号或空格的 provider 就会让整条查询语法错误。
    expect(sql).not.toContain("o'brien")
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).toBe('(CASE WHEN provider = $rpk0 THEN $rpv0 END)')
    expect(params.$rpk0).toBe("o'brien")
    expect(params.$rpv0).toBe("a';DROP TABLE usage_event;--")
  })
})

describe('规则加载：全局 + 按人覆盖', () => {
  test('匿名（没有人员身份）只拿全局规则', async () => {
    const target = await fixture()
    const someone = await addMember(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    await addRule(target, { scope: 'member', memberId: someone, provider: 'dashscope', alias: '别人的别名' })

    const store = await openPortalStore(target)
    try {
      const map = await loadProviderAliases(store, undefined)
      expect(map.get('dashscope')).toBe('bailian-tpp')
      expect(map.size).toBe(1)
    } finally { await store.close() }
  })

  test('★ 给不出身份时不会读到「全零条规则」', async () => {
    // 这一条专门钉住「`member_id = NULL` 恒不成立」那个坑：
    // 把匿名也塞进同一条 `OR member_id = $member` 里就会一条规则都读不到。
    const target = await fixture()
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const store = await openPortalStore(target)
    try {
      expect((await loadProviderAliases(store, null)).get('dashscope')).toBe('bailian-tpp')
      expect((await loadProviderAliases(store, '')).get('dashscope')).toBe('bailian-tpp')
    } finally { await store.close() }
  })

  test('有身份时是该人员的规则覆盖全局（其余回落全局）', async () => {
    const target = await fixture()
    const me = await addMember(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: '全局百炼' })
    await addRule(target, { scope: 'global', provider: 'bailian', alias: '全局百炼' })
    await addRule(target, { scope: 'member', memberId: me, provider: 'dashscope', alias: '我的百炼' })

    const store = await openPortalStore(target)
    try {
      const map = await loadProviderAliases(store, me)
      expect(map.get('dashscope')).toBe('我的百炼')
      expect(map.get('bailian')).toBe('全局百炼')
    } finally { await store.close() }
  })

  test('停用的规则不参与归一化（该 provider 回到原值），规则行仍在', async () => {
    const target = await fixture()
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp', enabled: false })
    const store = await openPortalStore(target)
    try {
      expect((await loadProviderAliases(store, undefined)).size).toBe(0)
      expect(Number((await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_alias'))?.n)).toBe(1)
    } finally { await store.close() }
  })

  test('规则表缺失时退化成「没有规则」，不让整个看板 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atr-provider-alias-'))
    roots.push(dir)
    const store = await openPortalStore({ sqlitePath: join(dir, 'portal.sqlite') })
    try {
      await store.exec('DROP TABLE provider_alias')
      expect((await loadProviderAliases(store, randomUUID())).size).toBe(0)
    } finally { await store.close() }
  })
})

describe('查询口径：筛选 / 分组 / 明细三处一致', () => {
  /** 两个 provider 各两条记录。 */
  async function seed(target: PortalTarget, ownerId: string): Promise<void> {
    const store = await openPortalStore(target)
    try {
      await insertAttributedRecords(store, [
        record('a1', 'dashscope'),
        record('a2', 'dashscope'),
        record('b1', 'openai'),
        record('b2', 'openai', 'gpt-5'),
      ], { userId: '张三', memberId: ownerId })
    } finally { await store.close() }
  }

  /** 每个用例都要一个真实人员（归属外键 + 按人归一化都指向它）。 */
  const owner = async (target: PortalTarget): Promise<string> => {
    const id = await addMember(target)
    await seed(target, id)
    return id
  }

  test('未配置规则的 provider 保持原值（分布图不能少块）', async () => {
    const target = await fixture()
    await owner(target)
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 })
    try {
      const groups = await session.groups('provider')
      expect(groups.map((g) => g.key).sort()).toEqual(['dashscope', 'openai'])
    } finally { await session.close() }
  })

  test('★ 归一化把两个原始名折叠成一个分组（这正是使用者要的）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    await addRule(target, { scope: 'global', provider: 'openai', alias: 'bailian-tpp' })

    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('provider')
      expect(groups.map((g) => g.key)).toEqual(['bailian-tpp'])
      // ⚠️ 分组折叠了，但**总量不能变**：4 条记录一条都不能丢、也不能被重复计。
      const totals = await session.totals()
      const raw = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 })
      try { expect(totals).toEqual(await raw.totals()) } finally { await raw.close() }
    } finally { await session.close() }
  })

  test('按归一化后的名字筛选，命中全部原始名', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'openai', alias: 'bailian-tpp' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000, providers: ['bailian'] }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('provider')
      expect(groups.map((g) => g.key)).toEqual(['bailian-tpp'])
      expect(groups[0]!.counts.calls).toBe(2)
    } finally { await session.close() }
  })

  test('★ 归一化后按**原值**筛选不再命中（刻意的：口径只有一套）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000, providers: ['openai'] }, (store) => loadProviderAliases(store, undefined))
    try {
      // `openai` 没配规则 → 它仍是原值，还能按原值筛到它自己那两条。
      const groups = await session.groups('provider')
      expect(groups.map((g) => g.key)).toEqual(['openai'])
      expect(groups[0]!.counts.calls).toBe(2)
      // ★ 而 `dashscope` 已经被折叠成 `bailian-tpp`：拿原值再也筛不到它。
      //   这是「归一化后只有一套口径」的必然结果，也是**要写进文档**的一条 ——
      //   想找它就用归一化后的名字，或者去明细里看那一列原值。
      const byRaw = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000, providers: ['dashscope'] }, (store) => loadProviderAliases(store, undefined))
      try { expect(await byRaw.groups('provider')).toEqual([]) } finally { await byRaw.close() }
    } finally { await session.close() }
  })

  test('provider-model 组合维度：归一化只换 provider 那一段', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('provider-model')
      // `b1` 用的是默认模型，`b2` 是 gpt-5 —— 归一化只把 provider 那一段换掉。
      expect(groups.map((g) => g.key).sort()).toEqual(['bailian-tpp/deepseek-v4.1-flash', 'openai/deepseek-v4.1-flash', 'openai/gpt-5'])
    } finally { await session.close() }
  })

  test('★ 明细同时给出归一化名与原值（核对规则配得对不对的唯一地方）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const { rows } = await session.records(10, 0)
      const dash = rows.find((r) => r.eventId === 'a1')!
      expect(dash.provider).toBe('bailian-tpp')
      expect(dash.providerRaw).toBe('dashscope')
      const other = rows.find((r) => r.eventId === 'b1')
      // 没配规则时两者相同；server 层据此决定要不要把原值发到前端。
      expect(other?.provider).toBe('openai')
      expect(other?.providerRaw).toBe('openai')
    } finally { await session.close() }
  })

  test('🚨 事实表里的 provider 永远是原值，归一化不改写一个字节', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    await session.close()

    const store = await openPortalStore(target)
    try {
      const rows = await store.all<{ provider: string }>('SELECT DISTINCT provider FROM usage_event ORDER BY provider')
      expect(rows.map((r) => r.provider)).toEqual(['dashscope', 'openai'])
    } finally { await store.close() }
  })

  test('按人覆盖只影响这个人的视图：同一个库、不同查看者看到不同分组名', async () => {
    const target = await fixture()
    const me = await owner(target)
    const other = await addMember(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: '全局百炼' })
    await addRule(target, { scope: 'member', memberId: me, provider: 'dashscope', alias: '我的百炼' })

    const mine = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, me))
    const theirs = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, other))
    try {
      expect((await mine.groups('provider')).map((g) => g.key).sort()).toEqual(['openai', '我的百炼'])
      expect((await theirs.groups('provider')).map((g) => g.key).sort()).toEqual(['openai', '全局百炼'])
    } finally { await mine.close(); await theirs.close() }
  })
})

describe('providerNormalizer 契约', () => {
  test('规则数为 0 时 apply 一律未命中（查询层据此退回裸列名）', () => {
    const normalizer = providerNormalizer(new Map(), SQLITE_DIALECT)
    expect(normalizer.rules).toBe(0)
    // ⚠️ `apply` 的契约是「**查出**归一化名」：未命中返回 undefined，
    //   而不是把原值回传 ——「回落原值」在 SQL 侧由 COALESCE 表达、
    //   在拼串侧由 `applyProviderModel` 表达。两处各写一遍必然漂移。
    expect(normalizer.apply('provider')).toBeUndefined()
  })

  test('规则数就是映射表的大小（查询层据此决定是否改写 SQL）', () => {
    const normalizer = providerNormalizer(providerAliasesToMap([rule('a', 'b'), rule('c', 'd')]), SQLITE_DIALECT)
    expect(normalizer.rules).toBe(2)
    expect(normalizer.pairs.length).toBe(2)
  })
})