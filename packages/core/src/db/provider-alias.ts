/**
 * 供应商（provider）归一化 —— 把上报里五花八门的供应商标识折叠成**一个口径**。
 *
 * ## 它解决什么问题
 *
 * 上报的 `provider` 是采集端自己填的字符串，同一个供应商会有多种写法
 * （实测同一条链路上出现过 `dashscope` 与 `bailian`）。按供应商看用量时，
 * 它们会各占一行，于是「这个供应商一共用了多少」根本没有地方能看出来。
 *
 * ## ★ 三条设计约束
 *
 * 1. **查询时归一化，事件原值一个字节都不改。**
 *    规则的载体是 `provider_alias` 表，`usage_event.provider` 永远是上报当时的原值。
 *    于是改一条规则立刻对历史生效、随时可以改回去，也不违反
 *    「迁移前后事件指纹必须逐位相同」这条硬约束。
 *    配置改完**不需要**任何回填脚本。
 * 2. **未配置的 provider 保持自身**（用户明确要求）：
 *    `CASE` 没有命中分支时返回原列值，不是空串、也不是 `other`。
 *    漏配一条规则的后果是「它单独占一行」，不是一个静默的错误名字。
 * 3. **规则逐条覆盖**：人员级规则只覆盖它自己命中的那些 provider，
 *    其余仍走全局规则。所以新增一条全局规则对所有人都生效，
 *    而某个人的特例不会让他的整张表脱离全局口径。
 *
 * ## 🚨 归一化只在**上报库**这条路径上生效
 *
 * 本机库（`usage.sqlite`）没有 `provider_alias` 表，也没有 `apply` ——
 * 没有规则时 {@link providerCaseSql} 直接返回裸列名，SQL 与迁移前逐字相同。
 * 「本地页面看到的 provider」与「看板上看到的 provider」因此可能不同名，
 * 这是**刻意的**：别名规则是部门口径，不是本机口径。
 */

import type { PortalDialect } from './dialect.js'
import type { PortalStore } from './portal-connection.js'

/** `provider_alias.scope`：规则作用于全局，还是只作用于某一个人。 */
export type ProviderAliasScope = 'global' | 'member'

/** 一条归一化规则（只读形状，与 `provider_alias` 表同构）。 */
export interface ProviderAliasRule {
  scope: ProviderAliasScope
  /** `scope === 'member'` 时规则归属的人员 ID；全局规则为 `null`。 */
  memberId: string | null
  /** 匹配的原始 provider 名（精确、区分大小写）。 */
  provider: string
  /** 归一化后的显示名。 */
  alias: string
}

/**
 * 一个「已按人员解析完毕」的映射表：原始 provider → 归一化名。
 *
 * ★ 解析（全局 + 人员规则逐条覆盖）在**服务端**做一次，然后把结果传进 SQL 构造器。
 *   绝不在 SQL 里 JOIN `provider_alias` 表 —— JOIN 会让每个事件行按命中规则数
 *   复制成多行，`SUM()` 随之放大，而页面上只是数字变大、没有任何报错
 *   （分组维度的多对多 JOIN 已经踩过一次同样的坑，见 `portal.ts` 的注释）。
 */
export type ProviderAliasMap = ReadonlyMap<string, string>

/** 归一化的执行体：映射表 + 针对 SQL 方言的取值表达式。 */
export interface ProviderNormalizer {
  /**
   * 原始名 → 归一化名的映射表。
   *
   * ★ 传 Map 而不是数组：SQL 构造器拿它生成 `CASE` 分支。
   *   用数组时 `forEach` 的回调签名恰好也能编译通过，但语义完全不同
   *   （见 `providerCaseSql` 的 🚨 注释）。
   */
  readonly map: ProviderAliasMap
  /**
   * 规则列表（按原始名唯一的稳定顺序），供需要顺序的调用点使用。
   *
   * ★ 保留它而不是只留一个 Map：`CASE` 的分支顺序会体现在生成的 SQL 文本里，
   *   一个稳定的顺序让「同一条规则集生成的 SQL 逐字相同」——
   *   排查「为什么这次查询和上次不一样」时这一点很值钱。
   */
  readonly pairs: readonly (readonly [string, string])[]
  /** 规则条数。0 表示没有配置，所有调用点都应退回裸列名（SQL 与迁移前一致）。 */
  readonly rules: number
  /** 供 `LIKE` 等 SQL 表达式用的方言。 */
  readonly dialect: PortalDialect
  /** 原始 → 归一化名。未命中返回 `undefined`（= 保持原值）。 */
  apply(value: string): string | undefined
}

/** provider 与 model 的组合分隔符，与 `aggregate.ts` 的 `groupKey()` 一致。 */
const PROVIDER_MODEL_SEPARATOR = '/'

/**
 * 把一批规则解析成「原始 → 归一化名」。
 *
 * ★ 优先级：**人员级规则覆盖同名的全局规则**，未命中的一条回落全局。
 *   实现上就是「先铺全局、再用人员规则覆盖同名键」——
 *   顺序反过来会让全局规则悄悄失效，而且没有任何报错。
 */
export function providerAliasesToMap(rules: readonly ProviderAliasRule[]): ProviderAliasMap {
  const map = new Map<string, string>()
  for (const rule of rules) if (rule.scope === 'global') map.set(rule.provider, rule.alias)
  for (const rule of rules) if (rule.scope === 'member') map.set(rule.provider, rule.alias)
  return map
}

/**
 * 构造归一化执行体。
 *
 * ⚠️ 空映射表由调用方折叠成 `undefined`（见 `buildWhere` 的注释）：
 *   传一个「有对象但没有规则」的 normalizer 进来，会让 SQL 里多出一个
 *   空 `CASE`，在 MySQL 上是语法错误。
 */
export function providerNormalizer(map: ProviderAliasMap, dialect: PortalDialect): ProviderNormalizer {
  // ⚠️ 顺序固定成「按原始名升序」而不是 Map 的插入序：`CASE` 的分支顺序会进 SQL 文本，
  //   而规则是从数据库读出来的，插入序取决于查询的 `ORDER BY` —— 让 SQL 文本
  //   只取决于规则**集合**，排查问题时才能逐字比对两次查询。
  const pairs = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    map,
    pairs,
    rules: pairs.length,
    dialect,
    apply: (value: string) => map.get(value),
  }
}

/** `provider/model` 组合键（与 `query.ts` 的 `provider-model` 维度同构）。 */
export function providerModelKey(provider: string, model: string): string {
  return `${provider}${PROVIDER_MODEL_SEPARATOR}${model}`
}

/**
 * 归一化「服务端自己拼接出来的 provider/model 字符串」。
 *
 * ⚠️ 拼接用 `/` 是**契约**（与 `aggregate.ts` 的 `groupKey()` 一致），
 *   规则里的 `provider` 只写供应商那一半 —— 让使用者去写
 *   `dashscope/qwen-max` 这种组合键，会把「换个模型就要重新配一条规则」
 *   变成常态，而它显然不该是常态。
 */
export function applyProviderModel(normalize: ProviderNormalizer, value: string): string {
  const cut = value.indexOf(PROVIDER_MODEL_SEPARATOR)
  if (cut < 0) return normalize.apply(value) ?? value
  return providerModelKey(normalize.apply(value.slice(0, cut)) ?? value.slice(0, cut), value.slice(cut + 1))
}

/**
 * 构造 `CASE WHEN <表达式> = $key THEN $value … END` 片段。
 *
 * ## 为什么用参数而不是把名字内联进 SQL
 *
 * 供应商名是使用者输入的字符串。内联要求这里必须做一遍完整转义，
 * 而**转义漏一个字符就是注入**。用具名参数之后这条风险整个消失，
 * 代价只是多几个绑定值。参数名一律是**生成的序号**（`$pfk0` / `$pfv0`），
 * 绝不拿供应商名去拼参数名 —— 那等于把注入搬到了参数名上：
 * 一个带引号或空格的 provider 会让整条 SQL 语法错误，
 * 而错误信息里只会说「near ... syntax error」。
 *
 * ⚠️ 键与目标**各自**一个参数：
 *   同一个目标名可能被多条规则指向（`dashscope` 与 `bailian` 都 → `bailian-tpp`），
 *   复用同一个名字并不会出错（`toPositional()` 支持同名多次出现，见 `mysql.ts`），
 *   但分开写让生成的 SQL 一眼能读懂。
 *
 * 🚨 入参要的是**映射表**而不是数组：数组在 `forEach` 下的回调签名是
 *   `(元素, 下标)`，而 `Map.forEach` 是 `(值, 键)` —— 两者都能被接受，
 *   于是「传错了」不会报错，只会生成一堆语法错误的参数名。
 *   收窄成 `ReadonlyMap` 之后，这个错误在类型层面就写不出来。
 *
 * @param expression 要参与比较与分组的 SQL 表达式（`provider` 列本身，
 *   或方言相关的拼接表达式）。**必须是受控文本**，不能来自外部输入。
 * @param map 原始名 → 归一化名。
 * @param params 参数表（就地追加，返回的 SQL 只能与这张表一起用）。
 */
export function providerCaseSql(
  expression: string,
  map: ProviderAliasMap,
  params: Record<string, string | number>,
  prefix = 'pa',
): string {
  if (map.size === 0) return expression
  const branches: string[] = []
  let index = 0
  for (const [from, to] of map) {
    const key = `$${prefix}k${index}`
    const value = `$${prefix}v${index}`
    params[key] = from
    params[value] = to
    // ★ 显式比较 `expression = $key`，未命中就落到下一个分支，最后落空（没有 ELSE）。
    branches.push(`WHEN ${expression} = ${key} THEN ${value}`)
    index += 1
  }
  // ★ 没有 ELSE —— 未命中的 provider 保持自身（见文件头第 2 条约束）。
  return `(CASE ${branches.join(' ')} END)`
}

/**
 * 构造 `COALESCE(归一化结果, 原值)`。
 *
 * ⚠️ `CASE` **没有 `ELSE`**，所以未命中时返回 NULL。
 *   直接用这个表达式做筛选会漏掉「没配规则的 provider」——
 *   表现是「筛某个供应商少了一部分数据」，而且没有任何报错。
 *   凡是拿它参与比较或分组，都必须套这一层 `COALESCE`。
 *
 * @param caseSql {@link providerCaseSql} 的产出（可能是裸表达式，此时本函数是恒等变换）。
 * @param originalExpr 未命中时要回落的原值表达式（单列是 `provider`，
 *   组合维度是方言拼接表达式）。
 */
export function coalesceOriginal(caseSql: string, originalExpr: string): string {
  return caseSql === originalExpr ? caseSql : `COALESCE(${caseSql}, ${originalExpr})`
}

/**
 * 读出一批规则并解析成映射表。
 *
 * ## ★ 为什么在这里读，而不是让查询层 JOIN
 *
 * 聚合 SQL 里 JOIN 这张表会让一个事件按命中规则数复制成多行，
 * `SUM()` 随之放大 —— 页面上只是数字变大，没有任何报错
 * （分组维度的多对多 JOIN 已经踩过一次同样的坑，见 `portal.ts` 的注释）。
 * 读成映射再内联成 `CASE` 之后，事件行的基数完全不变。
 *
 * ## 只取 `enabled=1`
 *
 * 停用一条规则 = 它不再参与归一化（**该 provider 回到原值**），
 * 而不是「映射到一个别的名字」。所以这里过滤掉停用行，
 * 而不是把它们当成 `provider → provider` 的恒等映射。
 *
 * ## 返回什么
 *
 * `memberId` 给了就同时取「全局规则 + 该人员的规则」，优先级在
 * {@link providerAliasesToMap} 里解决（人员规则逐条覆盖全局）。
 * `memberId` 缺省（未署名 / 匿名查看）只有全局规则 ——
 * 给不出身份就套不上个人规则，这是**刻意的**：那正是「按人归一化」的定义。
 *
 * ## ★ 排序是**语义**的一部分，不是为了让输出好看
 *
 * 唯一索引 `(member_id, provider)` 只对**整行非 NULL** 的组合去重 ——
 * 实测 SQLite 与 MySQL 都一样：`(NULL, 'dashscope')` 能插进两行。
 * 也就是说「同一原始名只有一条**全局**规则」**不由数据库保证**，
 * 只有 `repository.ts` 的 `findProviderAlias()` 那道应用层查重
 * （而它不在写事务里，并发下仍可能漏过）。
 *
 * 一旦真的出现两条 `enabled=1` 的全局规则，`Map.set` 就是「后写覆盖先写」，
 * 结果取决于数据库的返回顺序 —— 同一个库、同一条规则，两次查询可能给出
 * 不同的供应商名，而这**没有任何报错**。
 * 所以这里显式按 `created_at_ms, alias_id` 升序：重复时固定取**最早**的一条，
 * 让「配重了」这件事的表现是确定的、可复现的，而不是随机的。
 */
export async function loadProviderAliases(
  store: PortalStore,
  memberId: string | null | undefined,
): Promise<ProviderAliasMap> {
  let rows: AliasRow[]
  try {
    // ⚠️ 两条查询必须分开写：SQLite 与 MySQL 上 `member_id = NULL` 都不成立，
    //   把「匿名」也塞进同一条 `OR member_id = $member` 里会让匿名查看读到
    //   **全零条规则** —— 归一化静默失效，而页面上只是「供应商名字没改」。
    rows = memberId
      ? await store.all<AliasRow>(
        `SELECT scope, member_id, provider, alias FROM provider_alias
          WHERE enabled = 1 AND (scope = 'global' OR member_id = $member)
          ORDER BY provider, scope, created_at_ms, alias_id`,
        { $member: memberId })
      : await store.all<AliasRow>(
        `SELECT scope, member_id, provider, alias FROM provider_alias
          WHERE enabled = 1 AND member_id IS NULL
          ORDER BY provider, created_at_ms, alias_id`)
  } catch (error) {
    // ★ **表不存在**（而不是「库坏了」）时退化成「没有规则」。
    //   上报库由版本闸门管着，正常不可能缺这张表；但一个手工改过、或
    //   半迁移状态的库不该让**整个看板**变成 503 —— 归一化只是一层展示口径，
    //   少了它页面上的数字仍然是正确的（只是供应商名没折叠）。
    //   ⚠️ 只吞「表不存在」这一类错误：把它写成无差别 catch 会把
    //   「连接断了 / 权限不足」也变成静默降级，那才是真的危险。
    if (!isMissingTable(error)) throw error
    return new Map()
  }
  const rules: ProviderAliasRule[] = rows.map((row) => ({
    scope: row.scope === 'member' ? 'member' : 'global',
    memberId: row.member_id,
    provider: String(row.provider),
    alias: String(row.alias),
  }))
  return providerAliasesToMap(rules)
}

/** 「表不存在」的两种后端表述：SQLite `no such table` / MySQL errno 1146。 */
function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table/i.test(message) || /1146/.test(message) || /doesn't exist/i.test(message)
}

/** `provider_alias` 的原始行（数值/可空列在两种后端上形状不同，一律当 unknown 收）。 */
interface AliasRow {
  scope: string
  member_id: string | null
  provider: string
  alias: string
}

// ─────────────────────────────────────────────────────────────
// 规则的使用者输入校验
// ─────────────────────────────────────────────────────────────

/**
 * **原始** provider 名的字符集。
 *
 * ★ 字符集是**服务端的边界**，不是展示层的美化：这些字符串会进入
 *   `provider_alias` 表并参与 `=` 比较，任何「看起来一样、字节不同」的写法
 *   （全角、前后空格、大小写混用）都会让一条规则**静默不命中** ——
 *   页面上只是「归一化没生效」，没有任何报错。
 *   所以这里一律拒掉，而不是 trim 之后照收。
 *
 * ⚠️ 允许 `.` / `-` / `_` / `:` / `/` / `+` 与**中间**的空格，是因为真实的上报值里
 *   这些都出现过（`azure-openai`、`bedrock/anthropic`、`openai compatible`）。
 *   但**首尾不能是空格**：`'dashscope '` 与 `'dashscope'` 在 `=` 比较里是两个名字，
 *   而它们在页面上几乎看不出差别 —— 这正是那条最容易配错、又最难发现的规则。
 *
 * ⚠️ 这里**只给 ASCII**：这个值的来源是采集端自己的字符串（实测全是英文标识），
 *   允许全角字母会让 `ｄａｓｈｓｃｏｐｅ` 与 `dashscope` 看起来一模一样却互不匹配。
 */
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._:/+-]{0,126}[A-Za-z0-9._:/+-])?$/

/** 控制字符、零宽字符与各种 Unicode 空白（**不含**普通空格 —— 它是合法字符）。 */
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/

/**
 * 校验一个**原始** provider 名。
 *
 * 返回 `null` 表示合法，否则返回给使用者看的原因 —— 与 `identity/types.ts`
 * 的 `displayName()` 同一风格：抛错由调用方决定（这里是仓储，会抛 `IdentityError`）。
 */
export function providerNameError(value: unknown): string | null {
  if (typeof value !== 'string') return '供应商名需要是字符串'
  if (!value) return '供应商名不能为空'
  if (value.length > 128) return '供应商名不能超过 128 个字符'
  // ⚠️ 单独判一次**不可见字符**：它们能被复制粘贴带进来，而 ASCII 正则看不见它们。
  //   注意**不能**用 `\s` 排除 —— `\s` 包含普通空格，而 `openai compatible`
  //   这种名字是合法的（真实的上报值里出现过）。
  if (INVISIBLE_CHARACTERS.test(value)) return '供应商名不能包含空格以外的空白或不可见字符'
  if (!PROVIDER_NAME_PATTERN.test(value)) {
    return '供应商名需要以字母或数字开头和结尾，只能包含字母、数字与空格 . _ : / + -'
  }
  return null
}

/**
 * 校验**归一化名**（展示名）。
 *
 * ★ 与原始名刻意**不同**：展示名是给人看的，所以允许中文
 *   （`dashscope` → `阿里百炼` 显然比 `bailian-tpp` 更好读，而这正是本功能的目的）。
 *   仍然必须挡住的只有两类：**会破坏分组展示的不可见字符**，
 *   以及**会让拼接歧义的分隔符** —— `provider-model` 维度的键是
 *   `provider + '/' + model`，展示名里带 `/` 会让「两个字段」变成一个字段。
 */
export function aliasNameError(value: unknown): string | null {
  if (typeof value !== 'string') return '归一化名需要是字符串'
  if (!value) return '归一化名不能为空'
  if (value.length > 128) return '归一化名不能超过 128 个字符'
  if (INVISIBLE_CHARACTERS.test(value)) return '归一化名不能包含空格以外的空白或不可见字符'
  if (/^ | $/.test(value)) return '归一化名首尾不能是空格'
  if (value.includes('/')) return '归一化名不能包含 /（它是 provider 与 model 的分隔符）'
  return null
}

/**
 * 一条归一化规则在**仓储/接口层**的形状。
 *
 * ⚠️ 与 `ProviderAliasRule`（查询层用的最小形状）刻意分开：
 *   查询层只需要 `scope / memberId / provider / alias` 四个值，
 *   而管理接口还要给出 `alias_id` 与 `version`（乐观锁）。
 *   把两者合成一个类型会让查询层被迫认识「版本号」这种它根本不用管的东西。
 */
export interface PortalProviderAlias {
  alias_id: string
  scope: ProviderAliasScope
  /** `scope === 'member'` 时归属的人员；全局规则为 `null`。 */
  member_id: string | null
  /** 人员显示名（全局规则为 `null`）。列表页直接展示，不再回查人员表。 */
  member_name: string | null
  /** 匹配的原始 provider 名。 */
  provider: string
  /** 归一化后的展示名。 */
  alias: string
  enabled: boolean
  created_at_ms: number
  updated_at_ms: number
}