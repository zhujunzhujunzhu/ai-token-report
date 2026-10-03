/**
 * 供应商 / 模型归一化（v6 供应商，v12 追加模型）：规则映射、加载、以及**查询时的口径**。
 *
 * ## 这份测试要钉住的五件事
 *
 * 1. **未配置的 provider / model 保持原值**。这是使用者的明确要求，也是最容易做错的一条：
 *    一个「把没配规则的 provider 映射成空字符串 / `unknown`」的实现会让整张
 *    供应商分布图悄悄少掉一大块，而总量看起来仍然对得上（因为总量走的是另一条路）。
 * 2. **人员规则逐条覆盖全局，未命中回落全局**。不是「有人员规则就整套换掉」——
 *    后者会让「我给 dashscope 起个别名」意外地把别人的所有全局规则一并丢掉。
 * 3. **模型规则的两档粒度**：限定供应商的分支必须排在「任意供应商」之前，
 *    且「任意供应商」**绝不能**生成 `provider = '*'`（永远不命中，功能静默失效）。
 * 4. **筛选、分组、明细三处口径必须一致**。归一化只改展示名，不该让
 *    某条数据在「按供应商（模型）筛选」时出现、在「分组」时消失。
 * 5. **费用永远按原值算**：明细必须同时给出归一化名与原值，且 `modelRaw` 是计价键。
 *
 * ⚠️ 事实表里的 `provider` / `model` 永远是原值 —— 迁移与查询都不许改写它，
 *   所以这里同时断言「库里那两列没被动过」。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SQLITE_DIALECT } from '../src/db/dialect.js'
import {
  aliasNameError,
  aliasRulesOf,
  ANY_PROVIDER,
  EMPTY_ALIAS_RULES,
  insertAttributedRecords,
  loadProviderAliases,
  modelCaseSql,
  modelNameError,
  openPortalStats,
  openPortalStore,
  preparePortalDatabase,
  providerCaseSql,
  providerNameError,
  providerNormalizer,
  applyProviderModel,
  type ModelAliasRule,
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

/**
 * 写一条规则。绕开仓储层（那是 server 的测试范围），但保持列与约束一致。
 *
 * ⚠️ `model` 缺省即 `null`（= 一条**供应商规则**）。模型规则必须显式给 `model`；
 *   「任意供应商」的模型规则还要求 `provider = ANY_PROVIDER`。
 */
async function addRule(
  target: PortalTarget,
  rule: { scope: 'global' | 'member'; memberId?: string | null; provider: string; model?: string | null; alias: string; enabled?: boolean },
): Promise<void> {
  const store = await openPortalStore(target)
  try {
    await store.run(
      'INSERT INTO provider_alias (alias_id,scope,member_id,provider,model,alias,enabled,created_at_ms,updated_at_ms) VALUES ($id,$scope,$member,$provider,$model,$alias,$enabled,$now,$now)',
      {
        $id: randomUUID(),
        $scope: rule.scope,
        $member: rule.scope === 'member' ? rule.memberId ?? null : null,
        $provider: rule.provider,
        $model: rule.model ?? null,
        $alias: rule.alias,
        $enabled: rule.enabled === false ? 0 : 1,
        $now: Date.now(),
      },
    )
  } finally { await store.close() }
}

/** 一条供应商规则（`model: null`）。 */
const pRule = (provider: string, alias: string, memberId: string | null = null): ProviderAliasRule => ({
  scope: memberId ? 'member' : 'global',
  memberId,
  provider,
  model: null,
  alias,
})

/** 一条模型规则。`provider` 传 `ANY_PROVIDER` 表示「任意供应商」。 */
const mRule = (provider: string, model: string, alias: string, memberId: string | null = null): ProviderAliasRule => ({
  scope: memberId ? 'member' : 'global',
  memberId,
  provider,
  model,
  alias,
})

describe('归一化规则映射：供应商', () => {
  test('未配置的 provider 原样保留（使用者明确要求）', () => {
    const { providers } = aliasRulesOf([pRule('dashscope', 'bailian-tpp')])
    expect(providers.get('dashscope')).toBe('bailian-tpp')
    // ★ 没有规则 ≠ 映射成空 / unknown：它压根不在映射里，查询层会回落到原值。
    expect(providers.has('openai')).toBe(false)
    expect(providers.has('')).toBe(false)
    expect(providers.size).toBe(1)
  })

  test('★ 人员规则逐条覆盖全局，未命中回落全局', () => {
    const memberId = randomUUID()
    const { providers } = aliasRulesOf([
      pRule('dashscope', '全局百炼'),
      pRule('bailian', '全局百炼'),
      // 这个人只改 dashscope；bailian 必须继续沿用全局规则。
      pRule('dashscope', '我的百炼', memberId),
    ])
    expect(providers.get('dashscope')).toBe('我的百炼')
    expect(providers.get('bailian')).toBe('全局百炼')
  })

  test('人员规则胜出与传入顺序无关（全局先铺、人员后盖）', () => {
    const memberId = randomUUID()
    const overrides = [pRule('dashscope', '我的', memberId)]
    const globals = [pRule('dashscope', '全局'), pRule('other', '别的')]
    // 两种入参顺序都要落到同一个结果：实现里是按 scope 分两批铺的。
    expect(aliasRulesOf([...globals, ...overrides]).providers.get('dashscope')).toBe('我的')
    expect(aliasRulesOf([...overrides, ...globals]).providers.get('dashscope')).toBe('我的')
  })

  test('同一个 provider 命中多条全局规则时以最后一条为准（数据库已挡重复）', () => {
    // 唯一索引在两种后端上都不允许重复的 (member_id, provider, model)，
    // 所以这条只验证「万一读到了」时的确定性；顺序由 ORDER BY scope, provider 固定。
    const { providers } = aliasRulesOf([pRule('dashscope', '先'), pRule('dashscope', '后')])
    expect(providers.get('dashscope')).toBe('后')
  })

  test('匹配是**大小写敏感**的精确比较：写错大小写就是静默不命中', () => {
    const { providers } = aliasRulesOf([pRule('dashscope', '百炼')])
    expect(providers.get('DashScope')).toBeUndefined()
  })

  test('🚨 `model === null` 的行是供应商规则，绝不能混进模型规则里', () => {
    // 把 `null` 当模型名会让 `model IS NULL` 的所有事件行命中一条「别名是某个供应商名」
    // 的规则，模型维度整列变成垃圾。
    const rules = aliasRulesOf([pRule('dashscope', '百炼')])
    expect(rules.models.length).toBe(0)
  })
})

describe('归一化规则映射：模型', () => {
  test('未配置的 model 原样保留（不在规则表里，查询层回落原值）', () => {
    const { models } = aliasRulesOf([mRule(ANY_PROVIDER, 'qwen-max', '通义千问-Max')])
    expect(models.map((r) => r.model)).toEqual(['qwen-max'])
    expect(models.map((r) => r.alias)).toEqual(['通义千问-Max'])
  })

  test('★ 限定供应商的规则排在「任意供应商」之前（CASE 分支顺序即语义）', () => {
    const rules = aliasRulesOf([
      mRule(ANY_PROVIDER, 'gpt-4o', '通配 GPT-4o'),
      mRule('azure-openai', 'gpt-4o', 'Azure GPT-4o'),
    ])
    // 使用者配 azure 那条限定规则，正是因为「azure 的 gpt-4o」与「别家的 gpt-4o」不是一回事。
    expect(rules.models.map((r) => [r.provider, r.alias])).toEqual([
      ['azure-openai', 'Azure GPT-4o'],
      [null, '通配 GPT-4o'],
    ])
  })

  test('★ 约束供应商 = ANY_PROVIDER 的规则被展开成 `provider: null`（不是字面量 `*`）', () => {
    const rules = aliasRulesOf([mRule(ANY_PROVIDER, 'qwen-max', '通义千问-Max')])
    expect(rules.models[0]!.provider).toBeNull()
  })

  test('人员级模型规则覆盖全局的同 (provider, model)，其余仍回落全局', () => {
    const memberId = randomUUID()
    const rules = aliasRulesOf([
      mRule(ANY_PROVIDER, 'qwen-max', '全局千问Max'),
      mRule(ANY_PROVIDER, 'qwen-plus', '全局千问Plus'),
      mRule(ANY_PROVIDER, 'qwen-max', '我的千问Max', memberId),
    ])
    const byModel = new Map(rules.models.map((r) => [r.model, r.alias]))
    expect(byModel.get('qwen-max')).toBe('我的千问Max')
    expect(byModel.get('qwen-plus')).toBe('全局千问Plus')
  })

  test('同一个 (provider, model) 有多条全局规则时以最后一条为准（确定性）', () => {
    const rules = aliasRulesOf([
      mRule('openai', 'gpt-4o', '先'),
      mRule('openai', 'gpt-4o', '后'),
    ])
    expect(rules.models).toEqual([{ provider: 'openai', model: 'gpt-4o', alias: '后' }])
  })

  test('排序稳定：同一套规则集合生成逐字相同的顺序（与插入序无关）', () => {
    const a = aliasRulesOf([
      mRule('zzz', 'm1', 'A'),
      mRule('aaa', 'm2', 'B'),
    ]).models
    const b = aliasRulesOf([
      mRule('aaa', 'm2', 'B'),
      mRule('zzz', 'm1', 'A'),
    ]).models
    expect(a).toEqual(b)
    expect(a.map((r) => r.provider)).toEqual(['aaa', 'zzz'])
  })
})

describe('规则校验：供应商名', () => {
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

  test('★ `*`（ANY_PROVIDER）不是合法供应商名 —— 因此不会与真实网关重名', () => {
    expect(providerNameError(ANY_PROVIDER)).not.toBeNull()
  })
})

describe('规则校验：模型名', () => {
  test('接受实测出现过的模型名形状（比供应商名宽：多了 @ ( ) [ ]）', () => {
    for (const name of [
      'gpt-4o',
      'qwen2.5-coder-32b-instruct',
      'doubao-1.5-pro-32k',
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      '@cf/meta/llama-3.1-8b-instruct',
      '(unknown)',
      'a b',
      'x'.repeat(255),
    ]) expect(modelNameError(name)).toBeNull()
  })

  test('拒绝会让规则静默不命中或超长的写法', () => {
    for (const name of ['', ' gpt-4o', 'gpt-4o ', 'ＧＰＴ', 'gpt\t4o', 'gpt\u200b4o', '-leading', 'x'.repeat(256), null, 42]) {
      expect(modelNameError(name)).not.toBeNull()
    }
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

describe('SQL 片段：provider CASE 与回落', () => {
  test('无规则时返回原表达式（SQL 与改动前逐字相同）', () => {
    const params: Record<string, string | number> = {}
    expect(providerCaseSql('provider', new Map(), params, 'x')).toBe('provider')
    expect(params).toEqual({})
  })

  test('★ CASE 没有 ELSE：未命中的行必须靠 COALESCE 回落', () => {
    const params: Record<string, string | number> = {}
    const sql = providerCaseSql('provider', aliasRulesOf([pRule('dashscope', '百炼')]).providers, params, 'x')
    expect(sql).toBe('(CASE WHEN provider = $xk0 THEN $xv0 END)')
    // ⚠️ 没有 ELSE 是刻意的：漏掉 COALESCE 会让未命中的行变成 NULL，
    //   于是「按供应商分组」多出一行空名字、而总量还看得过去。
    expect(sql).not.toContain('ELSE')
    expect(params.$xk0).toBe('dashscope')
    expect(params.$xv0).toBe('百炼')
  })

  test('★ 参数名是生成的序号，绝不拿供应商名去拼参数名', () => {
    const params: Record<string, string | number> = {}
    const sql = providerCaseSql('provider', aliasRulesOf([pRule("o'brien", "a';DROP TABLE usage_event;--")]).providers, params, 'rp')
    // 供应商名只出现在**绑定值**里。一旦被拼进 SQL 文本（哪怕是参数名），
    // 一个带引号或空格的 provider 就会让整条查询语法错误。
    expect(sql).not.toContain("o'brien")
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).toBe('(CASE WHEN provider = $rpk0 THEN $rpv0 END)')
    expect(params.$rpk0).toBe("o'brien")
    expect(params.$rpv0).toBe("a';DROP TABLE usage_event;--")
  })
})

describe('SQL 片段：model CASE（两档粒度）', () => {
  test('无模型规则时返回裸列名', () => {
    const params: Record<string, string | number> = {}
    expect(modelCaseSql('provider', [], params, 'x')).toBe('model')
    expect(params).toEqual({})
  })

  test('★ 限定供应商：每个分支都要带 `provider = … AND model = …`', () => {
    const params: Record<string, string | number> = {}
    const rules = aliasRulesOf([mRule('azure-openai', 'gpt-4o', 'Azure GPT-4o')]).models
    const sql = modelCaseSql('provider', rules, params, 'm')
    expect(sql).toBe('(CASE WHEN provider = $mp0 AND model = $mm0 THEN $mv0 END)')
    expect(params.$mp0).toBe('azure-openai')
    expect(params.$mm0).toBe('gpt-4o')
    expect(params.$mv0).toBe('Azure GPT-4o')
    expect(sql).not.toContain('ELSE')
  })

  test('🚨 任意供应商：**只有** model 条件，绝不生成「provider 等于星号」的分支', () => {
    const params: Record<string, string | number> = {}
    const rules = aliasRulesOf([mRule(ANY_PROVIDER, 'qwen-max', '通义千问-Max')]).models
    const sql = modelCaseSql('provider', rules, params, 'm')
    // 库里没有哪一行的 provider 是 '*'，写成 `provider = '*'` 会让规则**永远不命中**，
    // 而页面上它看起来完全正常（规则在、就是没效果）。
    expect(sql).toBe('(CASE WHEN model = $mm0 THEN $mv0 END)')
    expect(sql).not.toContain("'*'")
    expect(sql).not.toContain('$mp0')
    expect(params.$mm0).toBe('qwen-max')
    expect(params.$mv0).toBe('通义千问-Max')
  })

  test('★ 限定供应商的分支排在通配之前（第一个命中就返回）', () => {
    const params: Record<string, string | number> = {}
    const rules = aliasRulesOf([
      mRule(ANY_PROVIDER, 'gpt-4o', '通配 GPT-4o'),
      mRule('azure-openai', 'gpt-4o', 'Azure GPT-4o'),
    ]).models
    const sql = modelCaseSql('provider', rules, params, 'm')
    expect(sql.indexOf('$mp0')).toBeLessThan(sql.indexOf('$mm1'))
    expect(params.$mp0).toBe('azure-openai')
    expect(params.$mm0).toBe('gpt-4o')
    // 第二个分支是通配：只有 model 条件。
    expect(params.$mm1).toBe('gpt-4o')
    expect(params.$mp1).toBeUndefined()
  })

  test('★ 参数名是生成的序号，绝不拿模型名去拼参数名', () => {
    const params: Record<string, string | number> = {}
    const rules = aliasRulesOf([mRule(ANY_PROVIDER, "a';DROP TABLE usage_event;--", 'x')]).models
    const sql = modelCaseSql('provider', rules, params, 'mn')
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).toBe('(CASE WHEN model = $mnm0 THEN $mnv0 END)')
  })
})

describe('applyProviderModel：两半都折叠', () => {
  const rules = aliasRulesOf([
    pRule('dashscope', '阿里百炼'),
    mRule(ANY_PROVIDER, 'qwen-max', '通义千问-Max'),
    mRule('dashscope', 'qwen-plus', '百炼Plus'),
  ])
  const normalizer = providerNormalizer(rules, SQLITE_DIALECT)

  test('★ 供应商与模型两半**都**被折叠（只折一半看起来像规则没生效）', () => {
    expect(applyProviderModel(normalizer, 'dashscope/qwen-max')).toBe('阿里百炼/通义千问-Max')
  })

  test('未配规则的那一半保持原值', () => {
    expect(applyProviderModel(normalizer, 'openai/qwen-max')).toBe('openai/通义千问-Max')
    expect(applyProviderModel(normalizer, 'dashscope/gpt-5')).toBe('阿里百炼/gpt-5')
  })

  test('★ 模型规则按**原值 provider** 匹配：折叠了供应商名不影响模型规则', () => {
    // `dashscope + qwen-plus` 有专属规则（限定供应商）。若拿归一化后的
    // 「阿里百炼」去匹配，这条限定规则会失效 —— 表现只是「模型没折叠」。
    expect(normalizer.applyModel('dashscope', 'qwen-plus')).toBe('百炼Plus')
    expect(normalizer.applyModel('阿里百炼', 'qwen-plus')).toBeUndefined()
  })

  test('没有 `/` 的值只走供应商那一半', () => {
    expect(applyProviderModel(normalizer, 'dashscope')).toBe('阿里百炼')
    expect(applyProviderModel(normalizer, 'openai')).toBe('openai')
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
      const { providers } = await loadProviderAliases(store, undefined)
      expect(providers.get('dashscope')).toBe('bailian-tpp')
      expect(providers.size).toBe(1)
    } finally { await store.close() }
  })

  test('★ 给不出身份时不会读到「全零条规则」', async () => {
    // 这一条专门钉住「`member_id = NULL` 恒不成立」那个坑：
    // 把匿名也塞进同一条 `OR member_id = $member` 里就会一条规则都读不到。
    const target = await fixture()
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    const store = await openPortalStore(target)
    try {
      expect((await loadProviderAliases(store, null)).providers.get('dashscope')).toBe('bailian-tpp')
      expect((await loadProviderAliases(store, '')).providers.get('dashscope')).toBe('bailian-tpp')
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
      const { providers } = await loadProviderAliases(store, me)
      expect(providers.get('dashscope')).toBe('我的百炼')
      expect(providers.get('bailian')).toBe('全局百炼')
    } finally { await store.close() }
  })

  test('★ 模型规则读出来时 `model` 列被正确保留（供应商规则的 `model` 为 null）', async () => {
    const target = await fixture()
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: '百炼' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'qwen-max', alias: '千问Max' })
    const store = await openPortalStore(target)
    try {
      const rules = await loadProviderAliases(store, undefined)
      // 供应商规则：model 为 null，且没混进模型规则里。
      expect(rules.providers.get('dashscope')).toBe('百炼')
      expect(rules.models).toEqual([{ provider: null, model: 'qwen-max', alias: '千问Max' }])
    } finally { await store.close() }
  })

  test('停用的规则不参与归一化（该 provider 回到原值），规则行仍在', async () => {
    const target = await fixture()
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp', enabled: false })
    const store = await openPortalStore(target)
    try {
      expect((await loadProviderAliases(store, undefined)).providers.size).toBe(0)
      expect(Number((await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_alias'))?.n)).toBe(1)
    } finally { await store.close() }
  })

  test('规则表缺失时退化成「没有规则」，不让整个看板 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atr-provider-alias-'))
    roots.push(dir)
    const store = await openPortalStore({ sqlitePath: join(dir, 'portal.sqlite') })
    try {
      await store.exec('DROP TABLE provider_alias')
      const rules = await loadProviderAliases(store, randomUUID())
      expect(rules.providers.size).toBe(0)
      expect(rules.models.length).toBe(0)
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

  test('provider-model 组合维度：两段都折叠（v12 起）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: '阿里百炼' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'deepseek-v4.1-flash', alias: 'DS-V4-Flash' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('provider-model')
      // `b2` 是 gpt-5（没配模型规则，保持原值）；其余三条的默认模型被折叠成 DS-V4-Flash。
      expect(groups.map((g) => g.key).sort()).toEqual([
        'openai/DS-V4-Flash',
        'openai/gpt-5',
        '阿里百炼/DS-V4-Flash',
      ])
    } finally { await session.close() }
  })

  test('★ source-provider-model 组合维度：供应商与模型两段都折叠', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: '阿里百炼' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'deepseek-v4.1-flash', alias: 'DS-V4-Flash' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('source-provider-model')
      const keys = groups.map((g) => g.key).sort()
      // 三个维度用 `/` 拼接，前两段是 source / provider。
      expect(keys.some((k) => k.endsWith('/阿里百炼/DS-V4-Flash'))).toBe(true)
      expect(keys.some((k) => k.endsWith('/openai/gpt-5'))).toBe(true)
    } finally { await session.close() }
  })

  test('模型维度：把两个原始模型名折叠成一个分组', async () => {
    const target = await fixture()
    await owner(target)
    // `gpt-5`（b2）与默认模型（a1/a2/b1）本来各占一行；把 gpt-5 折成默认名就并成一行。
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'gpt-5', alias: 'deepseek-v4.1-flash' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('model')
      expect(groups.map((g) => g.key)).toEqual(['deepseek-v4.1-flash'])
      expect(groups[0]!.counts.calls).toBe(4)
    } finally { await session.close() }
  })

  test('★ 按归一化后的模型名筛选，命中全部原始模型名', async () => {
    const target = await fixture()
    await owner(target)
    // 两个原始模型名折叠成**同一个**归一化名：按这个名字筛选必须命中两者的全部记录
    //   （这正是「归一化后筛选与分组口径一致」的核心断言）。
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'deepseek-v4.1-flash', alias: '统一模型' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'gpt-5', alias: '统一模型' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000, models: ['统一模型'] }, (store) => loadProviderAliases(store, undefined))
    try {
      const groups = await session.groups('model')
      expect(groups.map((g) => g.key)).toEqual(['统一模型'])
      // 4 条记录：a1 / a2 / b1 走默认模型名，b2 走 gpt-5。
      expect(groups[0]!.counts.calls).toBe(4)
      // ★ 拿**原值**筛同一个模型名则只剩它自己那部分：口径只有一套。
      const byRaw = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000, models: ['gpt-5'] }, (store) => loadProviderAliases(store, undefined))
      try { expect(await byRaw.groups('model')).toEqual([]) } finally { await byRaw.close() }
    } finally { await session.close() }
  })

  test('★ 限定供应商的模型规则不会波及别家的同名模型', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'gpt-5', alias: '任意家的GPT5' })
    const anySession = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      // 通配规则：`openai` 下的 gpt-5 被折叠。
      expect((await anySession.groups('provider-model')).map((g) => g.key).sort()).toEqual([
        'openai/任意家的GPT5',
        'openai/deepseek-v4.1-flash',
        'dashscope/deepseek-v4.1-flash',
      ].sort())
    } finally { await anySession.close() }

    // 改成限定 `dashscope`：`openai` 下的 gpt-5 必须保持原值。
    const target2 = await fixture()
    await owner(target2)
    await addRule(target2, { scope: 'global', provider: 'dashscope', model: 'gpt-5', alias: '只折dashscope的GPT5' })
    const scoped = await openPortalStats(target2, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const keys = (await scoped.groups('provider-model')).map((g) => g.key)
      // openai 没有 gpt-5 命中（它属于 dashscope 限定规则的射程之外）。
      expect(keys).toContain('openai/gpt-5')
      expect(keys).not.toContain('openai/只折dashscope的GPT5')
    } finally { await scoped.close() }
  })

  test('★ 明细同时给出归一化名与原值（核对规则配得对不对的唯一地方）', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'gpt-5', alias: 'DS-V4-Flash' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    try {
      const { rows } = await session.records(10, 0)
      const dash = rows.find((r) => r.eventId === 'a1')!
      expect(dash.provider).toBe('bailian-tpp')
      expect(dash.providerRaw).toBe('dashscope')
      // 没配模型规则时两者相同。
      expect(dash.model).toBe('deepseek-v4.1-flash')
      expect(dash.modelRaw).toBe('deepseek-v4.1-flash')

      const gpt = rows.find((r) => r.eventId === 'b2')!
      expect(gpt.model).toBe('DS-V4-Flash')
      // ★ `modelRaw` 是**计价用的那一份**：它必须原样保留。
      expect(gpt.modelRaw).toBe('gpt-5')
      // 没配供应商规则时两者相同。
      expect(gpt.provider).toBe('openai')
      expect(gpt.providerRaw).toBe('openai')
    } finally { await session.close() }
  })

  test('🚨 事实表里的 provider / model 永远是原值，归一化不改写一个字节', async () => {
    const target = await fixture()
    await owner(target)
    await addRule(target, { scope: 'global', provider: 'dashscope', alias: 'bailian-tpp' })
    await addRule(target, { scope: 'global', provider: ANY_PROVIDER, model: 'gpt-5', alias: 'DS-V4-Flash' })
    const session = await openPortalStats(target, { sinceMs: 0, untilMs: 10_000 }, (store) => loadProviderAliases(store, undefined))
    await session.close()

    const store = await openPortalStore(target)
    try {
      const providers = await store.all<{ provider: string }>('SELECT DISTINCT provider FROM usage_event ORDER BY provider')
      expect(providers.map((r) => r.provider)).toEqual(['dashscope', 'openai'])
      const models = await store.all<{ model: string }>('SELECT DISTINCT model FROM usage_event ORDER BY model')
      expect(models.map((r) => r.model)).toEqual(['deepseek-v4.1-flash', 'gpt-5'])
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
    const normalizer = providerNormalizer(EMPTY_ALIAS_RULES, SQLITE_DIALECT)
    expect(normalizer.rules).toBe(0)
    expect(normalizer.modelRules).toBe(0)
    // ⚠️ `apply` 的契约是「**查出**归一化名」：未命中返回 undefined，
    //   而不是把原值回传 ——「回落原值」在 SQL 侧由 COALESCE 表达、
    //   在拼串侧由 `applyProviderModel` 表达。两处各写一遍必然漂移。
    expect(normalizer.apply('provider')).toBeUndefined()
    expect(normalizer.applyModel('openai', 'gpt-4o')).toBeUndefined()
  })

  test('规则数就是映射表的大小（查询层据此决定是否改写 SQL）', () => {
    const normalizer = providerNormalizer(aliasRulesOf([pRule('a', 'b'), pRule('c', 'd')]), SQLITE_DIALECT)
    expect(normalizer.rules).toBe(2)
    expect(normalizer.pairs.length).toBe(2)
  })

  test('★ 供应商规则数为 0、模型规则非 0 时，两者各自独立生效', () => {
    // ⚠️ 这是最容易搞错的一处：一个「有模型规则」的库不该让供应商表达式
    //   也生成 CASE（反之亦然）—— 空 CASE 在 MySQL 上是语法错误。
    const normalizer = providerNormalizer(aliasRulesOf([mRule(ANY_PROVIDER, 'gpt-4o', 'X')]), SQLITE_DIALECT)
    expect(normalizer.rules).toBe(0)
    expect(normalizer.modelRules).toBe(1)
    expect(normalizer.apply('dashscope')).toBeUndefined()
    expect(normalizer.applyModel('dashscope', 'gpt-4o')).toBe('X')
  })

  test('applyModel：限定供应商优先于通配（顺序即语义）', () => {
    const normalizer = providerNormalizer(aliasRulesOf([
      mRule(ANY_PROVIDER, 'gpt-4o', '通配'),
      mRule('azure-openai', 'gpt-4o', 'Azure'),
    ]), SQLITE_DIALECT)
    expect(normalizer.applyModel('azure-openai', 'gpt-4o')).toBe('Azure')
    expect(normalizer.applyModel('openai', 'gpt-4o')).toBe('通配')
    expect(normalizer.modelList as readonly ModelAliasRule[]).toEqual([
      { provider: 'azure-openai', model: 'gpt-4o', alias: 'Azure' },
      { provider: null, model: 'gpt-4o', alias: '通配' },
    ])
  })
})
