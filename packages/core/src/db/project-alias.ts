/**
 * 项目（project）归一化 —— 把上报里五花八门的 `cwd` 折叠成**一个项目口径**。
 *
 * ## 它解决什么问题
 *
 * 看板的「项目」维度今天取的是 `cwd` 的**最后一段路径**
 * （`aggregate.ts` 的 `projectName()`：`D:\a\proj\packages\core` → `core`）。
 * 这个规则在两个方向上都会出错：
 *
 * - **一个项目散成好几行**：仓库根、`packages/core`、`packages/web-local`
 *   各占一行，「这个项目一共用了多少」没有地方能看出来；
 * - **不同项目被并成一行**：两个不相干的 `core` 目录共用一个名字，
 *   而它们的用量本来该分开看。
 *
 * ## ★ 四条设计约束
 *
 * 1. **查询时归一化，事件原值一个字节都不改。**
 *    规则的载体是 `project_alias` 表，`usage_event.cwd` 永远是上报当时的原值。
 *    改一条规则立刻对历史生效、随时可以改回去，也不需要任何回填脚本。
 * 2. **未配置的 cwd 保持自身**：没有命中任何规则时**回落 `projectName()` 的旧口径**
 *    （最后一段路径），不是空串、也不是 `other`。漏配一条规则的后果是
 *    「它单独占一行」，不是一个静默的错误名字。
 *    ⚠️ 这条回落是刻意的：把默认值改成「完整路径」会让所有没配规则的行
 *    变成一长串 `D:\…`，表格直接不可读，而那是**给所有人**的行为变化。
 * 3. **匹配是前缀，不是精确**（与 `provider_alias` 刻意的不同）。
 *    `cwd` 是目录路径，一个项目天然覆盖它下面的所有子目录。
 *    边界判定按**路径分隔符**：`D:\a\proj` 命中 `D:\a\proj` 与 `D:\a\proj\src`，
 *    但**不**命中 `D:\a\proj-other`（少了这一步，一条规则会悄悄吃掉邻居的用量）。
 * 4. **最长前缀优先，同长时人员规则覆盖全局规则**。
 *    「越具体的目录越优先」是前缀规则唯一说得通的语义；而同一条目录上
 *    我自己的名字覆盖部门的，与 `provider_alias` 的「人员规则逐条覆盖全局」同源。
 *
 * ## 🚨 归一化只在**上报库**这条路径上生效
 *
 * 本机库（`usage.sqlite`）没有 `project_alias` 表，也没有 `resolve` ——
 * 本地页面 / CLI / 插件面板的项目维度仍然是 `projectName()` 的旧口径。
 * 「本地页面看到的项目」与「看板上看到的项目」因此可能不同名，
 * 这是**刻意的**：项目别名规则是部门口径，不是本机口径（同 `provider-alias.ts`）。
 *
 * ## 为什么没有 SQL 片段
 *
 * 供应商归一化要生成 `CASE WHEN provider = ? THEN ?`（因为分组在 SQL 里做），
 * 而项目维度的分组**本来就在 JS 侧**（`query.ts` 的 `groupRowsFromProject()`：
 * 目录切分规则只有 `aggregate.ts` 一份实现，塞进 SQL 就是第二条实现）。
 * 所以这里只把规则读进内存后逐行套用：**不 JOIN、不生成 SQL、没有注入面**，
 * 也不存在「JOIN 让事件行复制、`SUM()` 放大」那一类风险。
 */

import type { PortalStore } from './portal-connection.js'
import { projectName } from '../aggregate.js'
// ★ 两个长度上限从**受控 DDL** 取，不在这里再写一遍字面量：
//   表上的 CHECK 与这里的应用层校验必须是同一个数，各写一份的结果是
//   「页面允许 300 字符、数据库拒收」，而错误信息只会是驱动原文。
import { PROJECT_ALIAS_MAX_LENGTH, PROJECT_PREFIX_MAX_LENGTH } from './portal-schema-v11.js'

/** `project_alias.scope`：规则作用于全局，还是只作用于某一个人。 */
export type ProjectAliasScope = 'global' | 'member'

/** 一条项目归一化规则（只读形状，与 `project_alias` 表同构）。 */
export interface ProjectAliasRule {
  scope: ProjectAliasScope
  /** `scope === 'member'` 时规则归属的人员 ID；全局规则为 `null`。 */
  memberId: string | null
  /** 匹配的**原始 cwd 前缀**（区分大小写，尾部路径分隔符已归一化）。 */
  prefix: string
  /** 归一化后的项目名。 */
  alias: string
}

/**
 * 一个「已按人员解析完毕」的映射表：原始 cwd 前缀 → 项目名。
 *
 * ★ 解析（人员规则覆盖同前缀的全局规则）在**服务端**做一次，然后把结果传进查询层。
 *   绝不在 SQL 里 JOIN `project_alias` 表 —— JOIN 会让每个事件行按命中规则数
 *   复制成多行，`SUM()` 随之放大（`provider-alias.ts` 的同一条纪律）。
 */
export type ProjectAliasMap = ReadonlyMap<string, string>

/** 归一化的执行体：映射表 + 前缀匹配。 */
export interface ProjectNormalizer {
  /** 原始前缀 → 项目名的映射表。键已归一化（尾部路径分隔符去掉）。 */
  readonly map: ProjectAliasMap
  /**
   * 规则列表，按「前缀由长到短、同长按字符序」的**稳定顺序**。
   *
   * ★ 保留它而不是只留一个 Map：这个顺序就是**匹配优先级**，
   *   也是页面上「哪条规则压住了哪条」的唯一依据。顺序只取决于规则**集合**，
   *   与数据库返回行的顺序无关 —— 同一个库、同一套规则，两次解析必然一致。
   */
  readonly pairs: readonly (readonly [string, string])[]
  /** 规则条数。0 表示没有配置，所有调用点都应退回纯 `projectName()`。 */
  readonly rules: number
  /** 原始 cwd → 归一化项目名。未命中返回 `undefined`（= 保持旧口径）。 */
  apply(cwd: string | null): string | undefined
  /** 原始 cwd → 归一化项目名；未命中回落 {@link projectName}。 */
  resolve(cwd: string | null): string
}

/** 路径分隔符：Windows 用 `\`，POSIX 用 `/`。两种都出现过的上报是常态。 */
const SEPARATORS = new Set(['/', '\\'])

/**
 * 去掉**尾部**的路径分隔符。
 *
 * ★ 规则前缀与要匹配的 cwd **必须用同一个函数归一化**：只归一化一侧的结果是
 *   「`D:\a\proj\` 这条规则永远不命中」，而页面上它看起来完全正确。
 *
 * ⚠️ 单独一个 `/` 要保留（`while (end > 1)`）：它归一化成空串之后会变成
 *   「匹配一切」的前缀，而那条规则的本意只是「根目录下的东西」。
 */
export function normalizeProjectPrefix(value: string): string {
  let end = value.length
  while (end > 1 && SEPARATORS.has(value[end - 1]!)) end -= 1
  return value.slice(0, end)
}

/**
 * 前缀匹配（**按路径分隔符边界**）。
 *
 * 🚨 边界判定不能省：`cwd.startsWith(prefix)` 会让 `D:\a\proj` 命中
 *   `D:\a\proj-other`，于是一条规则悄悄吃掉邻居项目的用量 ——
 *   页面上只是「那个项目的数字偏大」，没有任何报错。
 *
 * ⚠️ 前缀自带尾分隔符时（只有根 `/` 会走到这里，见
 *   {@link normalizeProjectPrefix}）直接判命中：`/` 必须能匹配 `/home/x`。
 */
export function projectPrefixMatches(prefix: string, cwd: string): boolean {
  if (!cwd.startsWith(prefix)) return false
  if (cwd.length === prefix.length) return true
  if (SEPARATORS.has(prefix[prefix.length - 1]!)) return true
  return SEPARATORS.has(cwd[prefix.length]!)
}

/**
 * 把一批规则解析成「原始前缀 → 项目名」。
 *
 * ★ 优先级分两层，顺序不能反：
 *   1. **同前缀**：人员规则覆盖全局规则（`Map.set` 的覆盖语义）；
 *   2. **不同前缀**：匹配时最长前缀优先（见 {@link projectNormalizer} 的 `pairs`）。
 *
 * ⚠️ 同一作用范围内的重复前缀只保留**最早**的一条（`??=`）：
 *   唯一索引 `(member_id, prefix)` 拦不住含 `NULL` 的行（两个后端都一样，
 *   实测见 `verify-database-design.ts`），所以「同一前缀只有一条全局规则」
 *   是应用层查重在保证。真出现重复行时，取最早的一条至少让结果是**确定的**，
 *   而不是取决于数据库的返回顺序（同 `providerAliasesToMap` 的取舍）。
 */
export function projectAliasesToMap(rules: readonly ProjectAliasRule[]): ProjectAliasMap {
  const map = new Map<string, string>()
  for (const rule of rules) {
    if (rule.scope !== 'global') continue
    const key = normalizeProjectPrefix(rule.prefix)
    if (!map.has(key)) map.set(key, rule.alias)
  }
  for (const rule of rules) {
    if (rule.scope !== 'member') continue
    map.set(normalizeProjectPrefix(rule.prefix), rule.alias)
  }
  return map
}

/**
 * 构造归一化执行体。
 *
 * ⚠️ 空映射表由调用方折叠成 `undefined`（见 `portal.ts` 的构造函数）：
 *   传一个「有对象但零条规则」的 normalizer 进来并不是错误，只是白跑一遍扫描；
 *   折叠掉可以让「没配规则」这条路径与迁移前**逐字节相同**。
 */
export function projectNormalizer(map: ProjectAliasMap): ProjectNormalizer {
  // ⚠️ 顺序固定成「长度降序、同长按字符序」而不是 Map 的插入序：
  //   它既是匹配优先级，也是排查时逐字比对的依据 —— 插入序取决于数据库的
  //   `ORDER BY`，让「同一个库两次解析给出不同项目名」成为可能。
  const pairs = [...map.entries()].sort(([a], [b]) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0))
  const apply = (cwd: string | null): string | undefined => {
    if (cwd === null || cwd === '') return undefined
    const value = normalizeProjectPrefix(cwd)
    for (const [prefix, alias] of pairs) {
      if (projectPrefixMatches(prefix, value)) return alias
    }
    return undefined
  }
  return {
    map,
    pairs,
    rules: pairs.length,
    apply,
    // ★ 未命中的 cwd 回落 `projectName()` —— 「没配规则的保持自身」这条约束的落点。
    //   绝不用空串或 other 兜底：那会把「漏配了一条规则」变成一个看起来正常的名字。
    resolve: (cwd: string | null) => apply(cwd) ?? projectName(cwd),
  }
}

/**
 * 读出一批规则并解析成映射表。
 *
 * ## ★ 为什么在这里读，而不是让查询层 JOIN
 *
 * 见文件头：项目分组在 JS 侧，JOIN 只会带来「事件行复制、`SUM()` 放大」的风险。
 *
 * ## 只取 `enabled=1`
 *
 * 停用一条规则 = 它不再参与归一化（**该 cwd 回落到 `projectName()`**），
 * 而不是「映射到一个别的名字」。
 *
 * ## 返回什么
 *
 * `memberId` 给了就同时取「全局规则 + 该人员的规则」，优先级在
 * {@link projectAliasesToMap} 里解决。`memberId` 缺省（未署名 / 匿名查看）
 * 只有全局规则 —— 给不出身份就套不上个人规则，这是**刻意的**。
 *
 * ## 排序
 *
 * 按 `prefix, scope, created_at_ms, alias_id` 升序：解析只依赖**规则集合**，
 * 而顺序决定了「重复前缀谁生效」（取最早一条，见 `projectAliasesToMap`）。
 */
export async function loadProjectAliases(
  store: PortalStore,
  memberId: string | null | undefined,
): Promise<ProjectAliasMap> {
  let rows: ProjectAliasRow[]
  try {
    // ⚠️ 与 `loadProviderAliases` 同款：两条查询必须分开写。
    //   SQLite 与 MySQL 上 `member_id = NULL` 都不成立，把「匿名」也塞进
    //   同一条 `OR member_id = $member` 里会让匿名查看读到**全零条规则**。
    rows = memberId
      ? await store.all<ProjectAliasRow>(
        `SELECT scope, member_id, prefix, alias FROM project_alias
          WHERE enabled = 1 AND (scope = 'global' OR member_id = $member)
          ORDER BY prefix, scope, created_at_ms, alias_id`,
        { $member: memberId })
      : await store.all<ProjectAliasRow>(
        `SELECT scope, member_id, prefix, alias FROM project_alias
          WHERE enabled = 1 AND member_id IS NULL
          ORDER BY prefix, created_at_ms, alias_id`)
  } catch (error) {
    // ★ **表不存在**（而不是「库坏了」）时退化成「没有规则」。
    //   上报库由版本闸门管着，正常不可能缺这张表；但一个手工改过、或
    //   半迁移状态的库不该让**整个看板**变成 503 —— 项目归一化只是一层展示口径，
    //   少了它页面上的数字仍然正确（只是项目名回到旧口径）。
    //   ⚠️ 只吞「表不存在」这一类错误（同 `provider-alias.ts`）。
    if (!isMissingTable(error)) throw error
    return new Map()
  }
  const rules: ProjectAliasRule[] = rows.map((row) => ({
    scope: row.scope === 'member' ? 'member' : 'global',
    memberId: row.member_id,
    prefix: String(row.prefix),
    alias: String(row.alias),
  }))
  return projectAliasesToMap(rules)
}

/** 「表不存在」的两种后端表述：SQLite `no such table` / MySQL errno 1146。 */
function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table/i.test(message) || /1146/.test(message) || /doesn't exist/i.test(message)
}

/** `project_alias` 的原始行（数值/可空列在两种后端上形状不同，一律当 unknown 收）。 */
interface ProjectAliasRow {
  scope: string
  member_id: string | null
  prefix: string
  alias: string
}

// ─────────────────────────────────────────────────────────────
// 规则的使用者输入校验
// ─────────────────────────────────────────────────────────────

/** 控制字符、零宽字符与各种 Unicode 空白（**不含**普通空格 —— 目录名里可以有）。 */
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/

/** 与 `portal-schema-v11.ts` 的 `PROJECT_PREFIX_MAX_LENGTH` 同一个数（DDL 的 CHECK）。 */
const PREFIX_MAX_LENGTH = PROJECT_PREFIX_MAX_LENGTH
/** 与 `portal-schema-v11.ts` 的 `PROJECT_ALIAS_MAX_LENGTH` 同一个数（应用层上限）。 */
const ALIAS_MAX_LENGTH = PROJECT_ALIAS_MAX_LENGTH

/**
 * 校验一个**原始 cwd 前缀**。
 *
 * 返回 `null` 表示合法，否则返回给使用者看的原因 —— 与 `providerNameError()`
 * 同一风格：抛错由调用方决定（这里是仓储，会抛 `IdentityError`）。
 *
 * ⚠️ 大小写**不做归一化、也不提示**：`D:\a` 与 `d:\a` 在 `=`/`startsWith`
 *   比较里是两个前缀。Windows 上它们指向同一个目录，但把「大小写不敏感」
 *   做进匹配会在区分大小写的文件系统上把两个不同目录悄悄并起来 ——
 *   那个方向的错误没有页面能看出来。所以这里只做**尾部分隔符**归一化
 *   （那一处两种解释都指向同一个目录），并在页面上把「逐字一致」说清楚。
 *
 * ⚠️ 也不做全角 / Unicode 归一化：路径就是路径，用户是从目录选择器或
 *   明细页复制的。任何「看起来一样、字节不同」的改写都会让规则静默不命中。
 */
export function projectPrefixError(value: unknown): string | null {
  if (typeof value !== 'string') return '目录前缀需要是字符串'
  if (!value) return '目录前缀不能为空'
  if (value.length > PREFIX_MAX_LENGTH) return `目录前缀不能超过 ${PREFIX_MAX_LENGTH} 个字符`
  if (INVISIBLE_CHARACTERS.test(value)) return '目录前缀不能包含空格以外的空白或不可见字符'
  if (/^ | $/.test(value)) return '目录前缀首尾不能是空格'
  // ★ 拒绝**文件系统根**：`/`（以及 `///` 这类等价写法）会命中**所有** POSIX 路径，
  //   把所有项目折成一行 —— 它必然是误配，而不是使用者的本意。
  //   ⚠️ 用归一化之后的形态判断：`///` 与 `/` 是同一个前缀，只判字面量会漏掉前者。
  //   ⚠️ `D:\`（→ `D:`）刻意**放行**：那是「D 盘下的东西」，是一个真实的边界，
  //      虽然不常用，但它不像根那样会把整个世界折成一个项目。
  const normalized = normalizeProjectPrefix(value)
  if (normalized === '/' || normalized === '\\') {
    return '目录前缀不能是文件系统根目录（它会匹配所有路径）'
  }
  return null
}

/**
 * 校验**归一化名**（项目展示名）。
 *
 * ★ 与原始前缀刻意**不同**：展示名是给人看的，所以允许中文
 *   （`D:\Coding_agent\ai-token-report` → `AI Token 用量平台` 显然比
 *   `ai-token-report` 更好读，而这正是本功能的目的）。
 *   与 `provider_alias` 的展示名也**不同**：这里允许 `/` 与 `\`
 *   （项目名写成 `客户A/前端` 是自然的），因为没有哪个维度用 `/` 拼接项目名
 *   —— `provider-model` 那条约束在这里不成立。
 */
export function projectAliasNameError(value: unknown): string | null {
  if (typeof value !== 'string') return '归一化名需要是字符串'
  if (!value) return '归一化名不能为空'
  if (value.length > ALIAS_MAX_LENGTH) return `归一化名不能超过 ${ALIAS_MAX_LENGTH} 个字符`
  if (INVISIBLE_CHARACTERS.test(value)) return '归一化名不能包含空格以外的空白或不可见字符'
  if (/^ | $/.test(value)) return '归一化名首尾不能是空格'
  return null
}

/**
 * 一条规则在**仓储/接口层**的形状。
 *
 * ⚠️ 与 `ProjectAliasRule`（查询层用的最小形状）刻意分开：查询层只需要
 *   `scope / memberId / prefix / alias` 四个值，而管理接口还要给出
 *   `alias_id` 与归属人姓名。把两者合成一个类型会让查询层被迫认识
 *   「这条规则是谁配的」这种它根本不用管的东西（同 `PortalProviderAlias`）。
 */
export interface PortalProjectAlias {
  alias_id: string
  scope: ProjectAliasScope
  /** `scope === 'member'` 时归属的人员；全局规则为 `null`。 */
  member_id: string | null
  /** 人员显示名（全局规则为 `null`）。列表页直接展示，不再回查人员表。 */
  member_name: string | null
  /** 匹配的原始 cwd 前缀（尾部路径分隔符已归一化后存库）。 */
  prefix: string
  /** 归一化后的项目名。 */
  alias: string
  enabled: boolean
  created_at_ms: number
  updated_at_ms: number
}
