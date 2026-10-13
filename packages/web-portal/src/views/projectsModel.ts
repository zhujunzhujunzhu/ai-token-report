/**
 * 项目归一化页面的纯判断：把规则按**归一化后的项目**折叠成「一个项目一行」，
 * 并算出每一行关联的路径与人员（或全局）。
 *
 * ★ 抽出来是为了能被 `bun test` 直接断言。渲染层（`ProjectsView.vue`）在 SSR 下
 *   **不渲染 `el-table` 的列与行**（Element Plus 的表头与单元格由客户端渲染，
 *   服务端只输出空 `<tr>`），所以「这个项目下有几条路径、几条规则、哪些人配了规则」
 *   这类判断若写在模板里，就只能靠人手点一遍才能发现坏掉 ——
 *   而它们恰恰是这一页要回答的问题（列表上显示的就是这些摘要）。
 *
 * ## 为什么要按项目名折叠
 *
 * 同一个项目在线上通常是 3~6 条规则（换盘 / 换父目录 / 盘符大小写各一条，
 * `project-alias.ts` 的注释里有实测数据）。平铺时那 6 行看起来像 6 个不同的配置，
 * 而使用者真正想知道的是「这个项目一共关联了哪些路径、都配给了谁」——
 * 那正是这里的折叠结果。
 *
 * ⚠️ 分组键是项目名的**逐字取值**，不做 trim、不做大小写折叠、不合并空白：
 *   看板按 `project_alias.alias` 的原文折叠 `cwd`，所以「申迪项目」与「申迪项目 」
 *   在**看板上本来就是两个项目**。页面若替使用者把它们并成一组，他会以为
 *   「配了一条规则却看到两个项目」是页面的 bug，而真相是规则本身差了一个字符。
 *   这一页只呈现归一化的结果，不在这里纠正它。
 */
import type { PortalProjectAlias } from '@ai-token-report/shared'

/** 一个项目下、按人员聚合后的规则归属（全局规则不在其中）。 */
export interface ProjectGroupMember {
  member_id: string
  /** 人员姓名；服务端没给名字时回落成显式的占位（不显示空标签）。 */
  name: string
  ruleCount: number
  enabledCount: number
}

/**
 * 一个「归一化后的项目」= 一行。
 *
 * ★ 所有汇总字段（`ruleCount` / `pathCount` / `enabledRules`…）都是**现算的数字**，
 *   而不是让模板去数数组长度：`el-table` 的 `sortable` 需要一个可比较的 `prop`，
 *   而「排序按数组长度」在模板里表达不出来（排序键必须落在行对象上）。
 */
export interface ProjectRuleGroup {
  /**
   * 分组的稳定标识，用作 `el-table` 的 `row-key` 与展开状态。
   *
   * ⚠️ 带 `project:` 前缀是**刻意**的：`el-table` 把 row-key 值直接当成普通对象
   *   的键（`getKeysMap`），一个叫 `__proto__` 的项目名在那种写法下会静默取不到行，
   *   表现是「这一组点了没反应、也永远不会展开」。
   */
  key: string
  /** 归一化后的项目名（看板「项目」维度里的那个名字）。 */
  alias: string
  /** 该项目的全部规则（**已按展示顺序**排好：全局在前，再按人员，再按前缀）。 */
  rules: PortalProjectAlias[]
  ruleCount: number
  /** 去重后的匹配值（仓库名 / 目录前缀）数量；同一路径配了「全局 + 按人员」两条时只算一条。 */
  pathCount: number
  /** 去重后的匹配值，按字符序。 */
  prefixes: string[]
  globalRules: number
  memberRules: number
  enabledRules: number
  disabledRules: number
  members: ProjectGroupMember[]
  /** 最近一次改动时间（该组所有规则的最大值）。 */
  updatedAtMs: number
}

/** 列表的筛选条件。两个条件都是**规则级**收窄，之后才按项目折叠。 */
export interface ProjectRuleQuery {
  /** 关键字：项目名、匹配值、人员姓名都参与匹配（大小写无关）。 */
  search: string
  /** `''` = 全部；`global` / `member` = 只保留该作用范围的规则。 */
  scope: string
}

/** `el-table` 的 `row-key`：见 {@link ProjectRuleGroup.key} 上关于 `__proto__` 的说明。 */
export function projectGroupRowKey(group: ProjectRuleGroup): string {
  return group.key
}

/** 字符序比较：不用 `localeCompare`，免得两个环境的 ICU 给出不同的默认顺序。 */
function byText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function matchesKeyword(entry: PortalProjectAlias, keyword: string): boolean {
  return `${entry.alias} ${entry.prefix} ${entry.member_name ?? ''}`.toLowerCase().includes(keyword)
}

/**
 * 组内展示顺序：**全局规则在前**（它是这条路径的基线），按人员规则在后
 * （后者覆盖前者）；同一层里按匹配值字符序。
 *
 * ⚠️ 这里**不**复刻匹配优先级（路径模式 > 仓库名模式、最长前缀优先）：
 *   那个判据在 `core/src/db/project-alias.ts` 只有一份实现，页面再写一遍就是
 *   第二个口径 —— 一旦漂移，页面会指着一行说「它优先」，而看板上并不是。
 */
function orderRules(rules: PortalProjectAlias[]): PortalProjectAlias[] {
  return [...rules].sort((left, right) =>
    (left.scope === right.scope ? 0 : left.scope === 'global' ? -1 : 1) ||
    byText(left.member_name ?? '', right.member_name ?? '') ||
    byText(left.prefix, right.prefix) ||
    byText(left.alias_id, right.alias_id))
}

function summarize(alias: string, rules: PortalProjectAlias[]): ProjectRuleGroup {
  const members = new Map<string, ProjectGroupMember>()
  const prefixes = new Set<string>()
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
    prefixes.add(rule.prefix)
    updatedAtMs = Math.max(updatedAtMs, rule.updated_at_ms)
  }
  return {
    key: `project:${alias}`,
    alias,
    rules: orderRules(rules),
    ruleCount: rules.length,
    pathCount: prefixes.size,
    prefixes: [...prefixes].sort(byText),
    globalRules,
    memberRules,
    enabledRules,
    disabledRules: rules.length - enabledRules,
    members: [...members.values()].sort((left, right) => byText(left.name, right.name) || byText(left.member_id, right.member_id)),
    updatedAtMs,
  }
}

/**
 * 把规则折叠成项目行。
 *
 * ★ 关键字命中**任意一条**规则时，整个项目都会显示出来（该项目的**所有**规则，
 *   哪怕只有一条命中了关键字）。理由：这一页的主体是项目，不是规则 ——
 *   只显示命中的那一条，使用者看不出它和哪些路径是同一组，
 *   而那正是「这个仓库名到底折到哪个项目里去了」这个问题的答案。
 *
 * 作用范围筛选（`scope`）则**照旧只收窄规则本身**：它是一个明确的「只看全局
 * 或只看按人员规则」的筛选，扩大回整组等于无视它。所以两个条件的语义不同，
 * 顺序上也是先按作用范围收窄、再按项目关键字展开。
 */
export function groupProjectRules(aliases: readonly PortalProjectAlias[], query: ProjectRuleQuery): ProjectRuleGroup[] {
  const keyword = query.search.trim().toLowerCase()
  const scoped = aliases.filter((entry) => !query.scope || entry.scope === query.scope)
  const matchedAliases = new Set<string>()
  for (const entry of scoped) if (!keyword || matchesKeyword(entry, keyword)) matchedAliases.add(entry.alias)
  const buckets = new Map<string, PortalProjectAlias[]>()
  for (const entry of scoped) {
    if (!matchedAliases.has(entry.alias)) continue
    const bucket = buckets.get(entry.alias)
    // ⚠️ 不能用 `entry.alias` 直接当 `Map` 的键以外的标识：同一项目名的规则**必须**落进同一个桶，
    //   而桶的插入顺序就是「规则表返回顺序」—— 项目之间的顺序另有 {@link compareGroups}。
    if (bucket) bucket.push(entry)
    else buckets.set(entry.alias, [entry])
  }
  return [...buckets.entries()].map(([alias, rules]) => summarize(alias, rules)).sort(compareGroups)
}

/**
 * 项目之间的默认顺序：**关联路径多的在前**，其次项目名。
 *
 * ★ 与「按项目名排」相比，这个默认顺序直接回答「哪些项目被折成了很多条路径」——
 *   而路径最多的那几个正是需要人来核对规则写法的（漏配一条不会报错，
 *   只表现为某个变体没折进来）。想要别的顺序点列标题即可（列都开了 `sortable`）。
 */
function compareGroups(left: ProjectRuleGroup, right: ProjectRuleGroup): number {
  return right.pathCount - left.pathCount || byText(left.alias, right.alias)
}