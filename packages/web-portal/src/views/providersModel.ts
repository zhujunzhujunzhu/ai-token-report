/**
 * 供应商 / 模型归一化页面的纯判断：把规则按**归一化后的名字**折叠成「一个名字一行」，
 * 并算出每一行关联的原始值与人员（或全局）。
 *
 * ★ 与 `projectsModel.ts` 同构（那里折的是项目名），但多一个维度。这一页的规则分
 *   **供应商**与**模型**两类（`model === null` ⇒ 供应商规则），而两类的「原始值」
 *   含义不同：供应商规则的 `provider` 是待折叠的原始供应商名；模型规则里它是
 *   **限定供应商**（`'*'` = 任意供应商），真正待折叠的是 `model`。
 *
 * ⚠️ 所以分组键必须**带上维度**：同一个展示名可以同时出现在两个维度里
 *   （「阿里百炼」既当供应商名，也当模型名），那在库里是两组互不相干的规则，
 *   页面上也必须是两行 —— 合成一行会让人以为一条规则改了两个维度。
 *
 * ★ 抽出来是为了能被 `bun test` 直接断言。渲染层（`ProvidersView.vue`）在 SSR 下
 *   **不渲染 `el-table` 的列与行**，所以「这个展示名底下有几条原始值、几条规则、
 *   哪些人配了规则」若写在模板里，就只能靠人手点一遍才能发现坏掉 ——
 *   而它们恰恰是这一页要回答的问题（列表上显示的就是这些摘要）。
 */
import { ANY_PROVIDER, type PortalProviderAlias } from '@ai-token-report/shared'

/** 一条规则折叠哪个维度（由 `model` 是否有值决定，库里没有 `target` 列）。 */
export type ProviderRuleTarget = 'provider' | 'model'

/** 一个展示名下、按人员聚合后的规则归属（全局规则不在其中）。 */
export interface ProviderGroupMember {
  member_id: string
  /** 人员姓名；服务端没给名字时回落成显式的占位（不显示空标签）。 */
  name: string
  ruleCount: number
  enabledCount: number
}

/**
 * 一个「归一化后的名字」= 一行。
 *
 * ★ 所有汇总字段都是**现算的数字**，而不是让模板去数数组长度：`el-table` 的
 *   `sortable` 需要一个可比较的 `prop`，而「按数组长度排序」在模板里表达不出来
 *   （排序键必须落在行对象上）。
 */
export interface ProviderRuleGroup {
  /**
   * 分组的稳定标识，用作 `el-table` 的 `row-key` 与展开状态。
   *
   * ⚠️ 前缀（`provider:` / `model:`）是**刻意**的：`el-table` 把 row-key 值直接当成
   *   普通对象的键（`getKeysMap`），一个叫 `__proto__` 的展示名在那种写法下会静默
   *   取不到行，表现是「这一组点了没反应、也永远不会展开」。
   */
  key: string
  target: ProviderRuleTarget
  /** 归一化后的展示名（看板里的供应商名 / 模型名）。 */
  alias: string
  /** 该组的全部规则（**已按展示顺序**排好：全局在前，再按人员，再按原始值）。 */
  rules: PortalProviderAlias[]
  ruleCount: number
  /** 去重后的原始值数量；同一个原始值配了「全局 + 按人员」两条时只算一条。 */
  sourceCount: number
  /** 去重后的原始值（供应商名，或「限定供应商 · 模型」），按字符序。 */
  sources: string[]
  globalRules: number
  memberRules: number
  enabledRules: number
  disabledRules: number
  members: ProviderGroupMember[]
  /** 最近一次改动时间（该组所有规则的最大值）。 */
  updatedAtMs: number
}

/** 列表的筛选条件。三个条件都是**规则级**收窄，之后才按展示名折叠。 */
export interface ProviderRuleQuery {
  /** 关键字：展示名、原始值、人员姓名都参与匹配（大小写无关）。 */
  search: string
  /** `''` = 全部；`global` / `member` = 只保留该作用范围的规则。 */
  scope: string
  /** `''` = 全部；`provider` / `model` = 只保留该维度的规则。 */
  target: string
}

/** `el-table` 的 `row-key`：见 {@link ProviderRuleGroup.key} 上关于 `__proto__` 的说明。 */
export function providerGroupRowKey(group: ProviderRuleGroup): string {
  return group.key
}

/** 这条规则折叠哪个维度。 */
export function providerRuleTarget(entry: PortalProviderAlias): ProviderRuleTarget {
  return entry.model === null ? 'provider' : 'model'
}

/**
 * 规则匹配的**原始值**，拼成一行给列表看。
 *
 * ★ 模型规则要把「限定供应商」一并显示：只显示模型名的话，
 *   「`gpt-4o`（任意供应商）」与「`azure-openai` 下的 `gpt-4o`」在列表里长得一样，
 *   而这两条规则的射程完全不同。
 */
export function providerRuleSourceOf(entry: PortalProviderAlias): string {
  if (entry.model === null) return entry.provider
  return `${entry.provider === ANY_PROVIDER ? '任意供应商' : entry.provider} · ${entry.model}`
}

/**
 * 归一化后的名字与原始值**一模一样**（等于这条规则没改显示名）。
 *
 * ★ 页面上标出这件事：一条「阿里百炼 → 阿里百炼」的规则肉眼看不出来，而它很可能
 *   是当初照着候选列表填重复了 —— 列出来才有人会去删。
 */
export function providerRuleKeepsSourceName(entry: PortalProviderAlias): boolean {
  return entry.alias === (entry.model === null ? entry.provider : entry.model)
}

/** 字符序比较：不用 `localeCompare`，免得两个环境的 ICU 给出不同的默认顺序。 */
function byText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function matchesKeyword(entry: PortalProviderAlias, keyword: string): boolean {
  return `${entry.alias} ${entry.provider} ${entry.model ?? ''} ${entry.member_name ?? ''}`.toLowerCase().includes(keyword)
}

/**
 * 组内展示顺序：**全局规则在前**（它是这个维度的基线），按人员规则在后
 * （后者覆盖前者）；同一层里按原始值字符序。
 *
 * ⚠️ 这里**不**复刻匹配优先级（那是一句「按查看者逐条覆盖、未提到的回落全局」，
 *   唯一实现在 `core/src/db/provider-alias.ts`）：页面再写一遍就是第二个口径，
 *   一旦漂移，页面会指着一行说「它优先」，而看板上并不是。
 */
function orderRules(rules: PortalProviderAlias[]): PortalProviderAlias[] {
  return [...rules].sort((left, right) =>
    (left.scope === right.scope ? 0 : left.scope === 'global' ? -1 : 1) ||
    byText(left.member_name ?? '', right.member_name ?? '') ||
    byText(providerRuleSourceOf(left), providerRuleSourceOf(right)) ||
    byText(left.alias_id, right.alias_id))
}

function summarize(target: ProviderRuleTarget, alias: string, rules: PortalProviderAlias[]): ProviderRuleGroup {
  const members = new Map<string, ProviderGroupMember>()
  const sources = new Set<string>()
  let globalRules = 0
  let memberRules = 0
  let enabledRules = 0
  let updatedAtMs = 0
  for (const rule of rules) {
    if (rule.scope === 'global') globalRules += 1
    else memberRules += 1
    if (rule.enabled) enabledRules += 1
    // ⚠️ 人员规则缺 `member_id` 只可能来自坏数据（服务端有外键），这里不做兜底分组：
    //   凭空的「未知成员」会把一个数据问题伪装成一个正常的分组。
    if (rule.scope === 'member' && rule.member_id) {
      const member = members.get(rule.member_id) ?? {
        member_id: rule.member_id,
        name: rule.member_name ?? '（已删除的成员）',
        ruleCount: 0,
        enabledCount: 0,
      }
      member.ruleCount += 1
      if (rule.enabled) member.enabledCount += 1
      members.set(rule.member_id, member)
    }
    sources.add(providerRuleSourceOf(rule))
    updatedAtMs = Math.max(updatedAtMs, rule.updated_at_ms)
  }
  return {
    key: `${target}:${alias}`,
    target,
    alias,
    rules: orderRules(rules),
    ruleCount: rules.length,
    sourceCount: sources.size,
    sources: [...sources].sort(byText),
    globalRules,
    memberRules,
    enabledRules,
    disabledRules: rules.length - enabledRules,
    members: [...members.values()].sort((left, right) => byText(left.name, right.name) || byText(left.member_id, right.member_id)),
    updatedAtMs,
  }
}

/**
 * 把规则折叠成「归一化后的名字」行。
 *
 * ★ 关键字命中**任意一条**规则时，整个名字都会显示出来（该名字下的**所有**规则，
 *   哪怕只有一条命中了关键字）。理由与项目那一页相同：这一页的主体是**展示名**，
 *   不是规则 —— 只显示命中的那一条，使用者看不出还有哪些原始值折到了同一个名字，
 *   而那正是「这个原始名到底折到哪儿去了」这个问题的答案。
 *
 * 作用范围（`scope`）与作用对象（`target`）两个筛选则**照旧只收窄规则本身**：
 * 它们都是明确的「只看这一类规则」的筛选，扩大回整组等于无视它。
 * 所以三类条件的语义不同，顺序上也是先按两个筛选收窄、再按关键字展开。
 */
export function groupProviderRules(aliases: readonly PortalProviderAlias[], query: ProviderRuleQuery): ProviderRuleGroup[] {
  const keyword = query.search.trim().toLowerCase()
  const scoped = aliases.filter((entry) =>
    (!query.scope || entry.scope === query.scope) &&
    (!query.target || providerRuleTarget(entry) === query.target))
  const matched = new Set<string>()
  for (const entry of scoped) {
    // ⚠️ 这里的身份是「维度 + 展示名」：只按展示名收集，会把供应商组与模型组混成一个键。
    const identity = `${providerRuleTarget(entry)}:${entry.alias}`
    if (!keyword || matchesKeyword(entry, keyword)) matched.add(identity)
  }
  const buckets = new Map<string, { target: ProviderRuleTarget; alias: string; rules: PortalProviderAlias[] }>()
  for (const entry of scoped) {
    const target = providerRuleTarget(entry)
    const identity = `${target}:${entry.alias}`
    if (!matched.has(identity)) continue
    const bucket = buckets.get(identity)
    if (bucket) bucket.rules.push(entry)
    else buckets.set(identity, { target, alias: entry.alias, rules: [entry] })
  }
  return [...buckets.values()].map(({ target, alias, rules }) => summarize(target, alias, rules)).sort(compareGroups)
}

/**
 * 展示名之间的默认顺序：**供应商维度在前、模型维度在后**，各自内部「原始值多的在前」，
 * 再次按展示名。
 *
 * ★ 为什么先按维度分块、而不是全局都按原始值数排：供应商与模型是两套互不相干的
 *   折叠（一条规则只折叠一个维度），混排会让「同一个展示名出现在两组」看起来像重复；
 *   按维度分块还让「作用对象」筛选前后的行顺序完全一致（筛掉一类不会让另一类重排）。
 *
 * ★ 块内「原始值多的在前」直接回答「哪些名字被折进了很多个原始值」——那几个正是
 *   需要人来核对规则写法的（漏配一条不会报错，只表现为某个变体没折进来）。
 *   想要别的顺序点列标题即可（列都开了 `sortable`）。
 */
function compareGroups(left: ProviderRuleGroup, right: ProviderRuleGroup): number {
  const rank = (target: ProviderRuleTarget): number => (target === 'provider' ? 0 : 1)
  return rank(left.target) - rank(right.target) ||
    right.sourceCount - left.sourceCount ||
    byText(left.alias, right.alias)
}