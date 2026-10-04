/**
 * 线上**项目归一化规则**的纯逻辑：规则目录 → 平台契约，以及「这条规则落到线上会发生什么」。
 *
 * ★ 为什么单独一个文件（与 `online-pricing-plan.mjs` 同一个套路）：
 *   `online-project-rules.mjs` 要 SSH 到生产机才能干活，而这里面两件事最容易错：
 *   ① **前缀的归一化与匹配语义**（尾部分隔符、大小写、路径边界）；
 *   ② **计划判定**（新建 / 覆盖 / 无变化），判错了会写出重复行或静默改掉别人的口径。
 *   纯逻辑进 `*-plan.mjs` 被单测直接 import。
 *
 * ## 🚨 这里对「前缀 / 归一化名」的校验是**建议性**的，服务端才是权威
 *
 * `packages/core/src/db/project-alias.ts` 的 `projectPrefixError()` /
 * `projectAliasNameError()` 与 DDL 的 CHECK 是同一份口径；本文件为了能在
 * `node` 下跑（不 import TS）而复述了一份**最小**校验，只为在**写入前**
 * 把明显笔误（空前缀、首尾空格、超长）挡下来，让 `plan` 的输出可读。
 * 真正的门禁是服务端：它按原值校验、按归一化后的值落库。
 * ⚠️ 两边的上限数字必须一致 —— 见 `PROJECT_PREFIX_MAX_LENGTH` 的注释。
 *
 * ## 🚨 大小写**不**归一化（与 `project-alias.ts` 同一条纪律）
 *
 * `D:\a` 与 `d:\a` 在 `startsWith` 比较里是**两个前缀**。Windows 上它们指向同一个目录，
 * 但把「大小写不敏感」做进匹配会在区分大小写的文件系统上把两个不同目录悄悄并起来。
 * 所以路径模式里同一个项目的每个大小写变体都要**各写一条规则**，本文件不做任何合并。
 *
 * ★ 而**仓库名模式**（不含路径分隔符的裸目录名，如 `suit-g92-parent`）没有这个问题：
 *   盘符压根不参与比较，所以换盘 / 换父目录 / 换盘符大小写**一条规则全覆盖**。
 *   这是本工具推荐的写法，也是 31 条路径规则能收敛成 10 余条的原因。
 */

/** 与 `portal-schema-v11.ts` 的 `PROJECT_PREFIX_MAX_LENGTH` 同值（DDL 的 CHECK）。 */
export const PROJECT_PREFIX_MAX_LENGTH = 512

/** 与 `portal-schema-v11.ts` 的 `PROJECT_ALIAS_MAX_LENGTH` 同值（应用层上限）。 */
export const PROJECT_ALIAS_MAX_LENGTH = 128

/** 控制字符、零宽字符与各种 Unicode 空白（**不含**普通空格 —— 目录名里可以有）。 */
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/

/** 路径分隔符：Windows 用 `\`，POSIX 用 `/`。两种都出现过的上报是常态。 */
const SEPARATORS = new Set(['/', '\\'])

/**
 * 去掉**尾部**的路径分隔符（与 `project-alias.ts` 的 `normalizeProjectPrefix()` 同款）。
 *
 * ⚠️ 单独一个 `/` 要保留（`end > 1`）：它归一化成空串之后会变成「匹配一切」的前缀。
 */
export function normalizeProjectPrefix(value) {
  let end = String(value).length
  while (end > 1 && SEPARATORS.has(String(value)[end - 1])) end -= 1
  return String(value).slice(0, end)
}

/**
 * 规则是**路径前缀**（含分隔符）还是**仓库名**（裸目录名）？
 *
 * ⚠️ 判据与 `project-alias.ts` 的 `isProjectPathRule()` 必须逐字一致 ——
 *   `projectPrefixError()` 的裸盘符那条要靠它才知道「这条规则走的是仓库名模式」。
 */
export function isProjectPathRule(value) {
  const text = String(value)
  for (const char of text) if (SEPARATORS.has(char)) return true
  return false
}

/** 校验匹配值（建议性，见文件头）。返回 `null` 表示看起来没问题。 */
export function projectPrefixError(value) {
  if (typeof value !== 'string') return '匹配值需要是字符串'
  if (!value) return '匹配值不能为空'
  if (value.length > PROJECT_PREFIX_MAX_LENGTH) return `匹配值不能超过 ${PROJECT_PREFIX_MAX_LENGTH} 个字符`
  if (INVISIBLE_CHARACTERS.test(value)) return '匹配值不能包含空格以外的空白或不可见字符'
  if (/^ | $/.test(value)) return '匹配值首尾不能是空格'
  const normalized = normalizeProjectPrefix(value)
  if (normalized === '/' || normalized === '\\') return '匹配值不能是文件系统根目录（它会匹配所有路径）'
  // 🚨 裸盘符（不含分隔符 ⇒ 仓库名模式）会匹配该磁盘下的**每一个**目录：
  //   `D:` 本身就是 `D:\a\proj` 的第一段（`['D:', 'a', 'proj']`），
  //   与文件系统根同一种危险。⚠️ 判据必须与 `project-alias.ts` 逐字等价。
  if (!isProjectPathRule(value) && /^[A-Za-z]:$/.test(value)) {
    return '仓库名不能是盘符（如 D:），那会匹配该磁盘下的所有目录。请写仓库目录名（如 suit-g92-parent），它会匹配该仓库在任意磁盘、任意父目录下的所有子目录'
  }
  return null
}

/** 校验归一化名（建议性，见文件头）。中文是允许的 —— 这正是本功能的目的。 */
export function projectAliasNameError(value) {
  if (typeof value !== 'string') return '归一化名需要是字符串'
  if (!value) return '归一化名不能为空'
  if (value.length > PROJECT_ALIAS_MAX_LENGTH) return `归一化名不能超过 ${PROJECT_ALIAS_MAX_LENGTH} 个字符`
  if (INVISIBLE_CHARACTERS.test(value)) return '归一化名不能包含空格以外的空白或不可见字符'
  if (/^ | $/.test(value)) return '归一化名首尾不能是空格'
  return null
}

/**
 * 读一份规则目录（JSON 文本或对象）→ 已归一的行数组。
 *
 * 形如：
 * ```json
 * { "asOf": "2026-10-04", "source": "线上 cwd 实测分布",
 *   "rows": [{ "scope": "global", "prefix": "D:\\Coding\\suit-g92-parent", "alias": "甬舟G92项目" }] }
 * ```
 *
 * 🚨 空 `rows` 一律报错：一行规则都没有的写入计划是空操作，通常意味着文件写错了
 *   （与 `readCatalog` 对空价目表的态度一致）。
 * 🚨 同一个 `(scope, prefix)` 在文件里出现两次且**别名不同**时必须报错 ——
 *   后一条会覆盖前一条（服务端 upsert 用的是同一个槽位），静默覆盖等于
 *   「我改了这条」与「它还是原来那个名字」同时成立。
 */
export function readRules(raw) {
  const catalog = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('规则目录必须是一个 JSON 对象（含 rows 数组）')
  const list = catalog.rows
  if (!Array.isArray(list) || list.length === 0) throw new Error('规则目录里没有 rows（一条规则都没有的写入计划是空操作，通常意味着文件写错了）')
  const rows = []
  const warnings = []
  const seen = new Map()
  list.forEach((row, index) => {
    const at = `第 ${index + 1} 行`
    if (!row || typeof row !== 'object') throw new Error(`${at}：不是对象`)
    const scope = String(row.scope ?? 'global').trim()
    if (scope !== 'global' && scope !== 'member') throw new Error(`${at}：scope 只支持 global 或 member`)
    // ★ 本人规则（member）不在这里写：它要 member_id，而目录里刻意不放人员 ID
    //   （那是会变的东西）。要配个人规则请走管理页。
    if (scope === 'member') throw new Error(`${at}：本工具只写 global 规则；个人规则请走管理页`)
    const prefix = String(row.prefix ?? '')
    const prefixReason = projectPrefixError(prefix)
    if (prefixReason) throw new Error(`${at}：目录前缀无效 —— ${prefixReason}`)
    const alias = String(row.alias ?? '')
    const aliasReason = projectAliasNameError(alias)
    if (aliasReason) throw new Error(`${at}：归一化名无效 —— ${aliasReason}`)
    const normalized = normalizeProjectPrefix(prefix)
    if (normalized !== prefix) warnings.push(`${at}（${prefix}）尾部分隔符已归一化为 ${normalized}`)
    const previous = seen.get(normalized)
    if (previous !== undefined && previous !== alias) {
      throw new Error(`${at}：前缀 ${normalized} 已在本文件第 ${seen.get(`${normalized}\u0000line`)} 行出现过，且归一化名不同（${previous} → ${alias}）`)
    }
    seen.set(normalized, alias)
    seen.set(`${normalized}\u0000line`, index + 1)
    rows.push({ scope, prefix: normalized, alias })
  })
  return { asOf: catalog.asOf ?? null, source: catalog.source ?? null, note: catalog.note ?? null, rows, warnings }
}

/** 规则 → `POST /api/v1/admin/project-aliases` 的请求体（与线上契约逐字对应）。 */
export function ruleToApiBody(rule) {
  // 只送三个键：`enabled` 缺省即 true（服务端 `setProjectAlias` 的 `inputEnabled`），
  // 而 `member_id` 只在 scope=member 时有意义 —— 全局规则带上它是**多余**的，
  // 又因为 schema 是 strictObject，多一个键会直接 400。
  //
  // ★ 前缀在这里**再归一化一次**：`readRules` 已经做过，但这里是「→ 平台契约」的边界，
  //   让它对「尾部分隔符」保持幂等 —— 调用方给 `D:\a\` 还是 `D:\a`，
  //   送出去的和库里存下来的都是同一个形态（服务端也会自己归一化，两边一致）。
  return { scope: rule.scope, prefix: normalizeProjectPrefix(rule.prefix), alias: rule.alias }
}

/**
 * 逐行算出「这条规则落到线上会怎样」。
 *
 * 三种结局：
 * - `create`：线上没有同前缀的全局规则 → 新建；
 * - `update`：已有同前缀的全局规则但**归一化名不同、或它是停用的** → upsert（改这一条 / 重新启用）；
 * - `same`  ：已有同前缀的全局规则、名字逐字相同、且是启用的 → 写入是幂等的空操作。
 *
 * ⚠️ 只与**全局**规则比（`scope='global'` 且 `member_id IS NULL`）：个人规则各算各的，
 *   同一条目录上「我的名字」覆盖「部门的」是**两层**语义，不是冲突。
 * ⚠️ 键是 `normalizeProjectPrefix(prefix)`：库里存的就是归一化后的形态，
 *   不归一化会让「尾部分隔符」这一个字节的差别变成一条永远命不中的重复规则。
 */
export function planAgainstExisting(existing, candidates) {
  const globals = existing.filter((row) => row.scope === 'global' && !row.memberId)
  return candidates.map((candidate) => {
    const same = globals.find((row) => normalizeProjectPrefix(row.prefix) === candidate.prefix)
    if (!same) return { candidate, action: 'create', existing: null }
    if (normalizeProjectPrefix(same.prefix) === candidate.prefix && same.alias === candidate.alias && same.enabled) {
      return { candidate, action: 'same', existing: same }
    }
    return { candidate, action: 'update', existing: same }
  })
}

/** 计划 → 给人看的对齐文本（不做任何算术，只排版）。 */
export function formatPlan(items) {
  const actionText = { create: '新建', update: '覆盖', same: '无变化' }
  const width = Math.max(0, ...items.map((item) => item.candidate.prefix.length))
  const lines = []
  for (const item of items) {
    lines.push(`${actionText[item.action] ?? item.action}  ${item.candidate.prefix.padEnd(width)}  → ${item.candidate.alias}`)
    if (item.action === 'update' && item.existing) {
      const detail = []
      if (item.existing.alias !== item.candidate.alias) detail.push(`原名 ${item.existing.alias}`)
      if (!item.existing.enabled) detail.push('原来是停用的')
      lines.push(`${' '.repeat(6)}${' '.repeat(width)}  ${detail.join('，')}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 读线上现有规则
// ---------------------------------------------------------------------------

/**
 * 线上现有规则（**只读** SQL）。
 *
 * 🚨 `HEX()` 不是为了好看：`mysql --batch` 会把数据里的 `\` 转义成 `\\`（并把
 *   tab / 换行也转义），而这里的前缀**全是** Windows 路径 —— 直接 `SELECT prefix`
 *   拿回来的是 `D:\\Coding\\…`，与规则目录里的 `D:\Coding\…` 逐字不同，
 *   于是每一条都被判成「新建」，第二遍跑就写出一堆重复行。
 *   走 HEX 曲线避开整个转义层：解码出来的字节就是库里的原值。
 */
export const EXISTING_RULES_SQL = [
  'SELECT alias_id, scope, COALESCE(member_id, \'\') AS member_id, HEX(prefix) AS prefix_hex,',
  '  HEX(alias) AS alias_hex, enabled',
  'FROM project_alias ORDER BY prefix, scope, created_at_ms',
].join(' ')

/** HEX 列 → 原字符串（UTF-8）。空 HEX（`--batch` 下 NULL 会打成 `NULL`，这里是空串）→ 空串。 */
export function decodeHex(hex) {
  const text = String(hex ?? '')
  if (text === '' || text === 'NULL') return ''
  return Buffer.from(text, 'hex').toString('utf8')
}

/** `mysql -N --batch` 的行 → 现有规则数组（已解码、已归一化前缀形态）。 */
export function parseExistingRules(rows) {
  return rows.map(([aliasId, scope, memberId, prefixHex, aliasHex, enabled]) => ({
    // ★ alias_id 是**删除**唯一可用的句柄（业务主键是 (scope, member_id, prefix)，
    //   而删除端点收的是 alias_id）。没有它就只剩「停用」而不能真删。
    aliasId: String(aliasId),
    scope: scope === 'member' ? 'member' : 'global',
    memberId: memberId ? String(memberId) : null,
    prefix: decodeHex(prefixHex),
    alias: decodeHex(aliasHex),
    enabled: String(enabled) === '1',
  }))
}
